import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
const { livePlugin, resolveConfig } = await import(process.env.SJS_OPEN_TEST_ENTRY ?? '../lib/index.js')

const tools = new Map()
let route
const services = {
  settings: { describe: () => [{ ns: 'spreadjs-editor', value: { bridge: '@grapecity-software/dsh-spreadjs-driver' } }] },
  connection: { requestRejection() {} },
  webServer: { register(next) { route = next; return () => {} } },
}
const effect = fn => { const value = fn(); return typeof value === 'function' ? value : () => {} }
const ctx = {
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  effect, get: name => services[name], on: () => () => {},
  inject(names, fn) { if (names.every(name => services[name] !== undefined)) fn(ctx); return { dispose() {} } },
}
livePlugin.apply(ctx, resolveConfig({ operationTimeoutMs: 5000 }))
const tool = tools.get('sjs_live_open')
assert(tool, 'open tool was not registered')
let rpcId = 0
async function call(method, payload) {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ type: 'client-request', rpcId: String(++rpcId), method, payload }))]), {
    method: 'POST', url: `/spreadjs-live/${method}`, headers: { 'content-type': 'application/json' },
  })
  let body
  await route.handler(request, { writeHead() {}, end(value) { body = value } })
  return JSON.parse(body).result
}
const poll = sessionId => call('poll', { tabId: sessionId, targets: [], editorSessions: [sessionId] })
const workspace = await mkdtemp(join(tmpdir(), 'sjs-open-'))
const outside = await mkdtemp(join(tmpdir(), 'sjs-open-outside-'))
const exec = { agent: { session: { header: { id: 'chat', cwd: workspace } } } }
try {
  const customTemplate = JSON.stringify({ version: '19.0.0', sheetCount: 1, sheets: { Sheet1: { name: 'Sheet1', rowCount: 200, columnCount: 20 } } })
  await writeFile(join(workspace, 'empty.ssjson'), customTemplate)
  await poll('chat')
  async function open(args) {
    const pending = tool.execute(args, exec)
    // Observe the real job through the transport; no Workbook exists in this fixture.
    let job
    for (let i = 0; i < 100; i++) {
      const response = await poll('chat')
      if (response.value !== null) { job = response.value; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert(job?.open, 'no editor open job was queued')
    assert.equal(job.open.sessionId, 'chat')
    assert.equal(job.code, '')
    const wrongOwner = await call('result', { tabId: 'another-browser', jobId: job.jobId, ok: true, value: { ready: true } })
    assert.equal(wrongOwner.error.code, 'SJS_LIVE_WRONG_OWNER')
    await call('result', { tabId: 'chat', jobId: job.jobId, ok: true, value: { ready: true }, file: job.open.address })
    return pending
  }
  const blank = await open({ path: 'test-output/nested/空白 book.xlsx', create: true })
  assert(blank.result.created && blank.result.ready)
  assert.deepEqual(await readFile(join(workspace, 'test-output/nested/空白 book.xlsx')), await readFile(new URL('../templates/empty.xlsx', import.meta.url)))
  assert(blank.result.address.endsWith('/test-output/nested/%E7%A9%BA%E7%99%BD%20book.xlsx'))
  const reopened = await open({ path: 'test-output/nested/空白 book.xlsx', create: false })
  assert.equal(reopened.result.created, false)
  await writeFile(join(workspace, 'test-output/nested/空白 book.xlsx'), 'do-not-overwrite')
  await assert.rejects(tool.execute({ path: 'test-output/nested/空白 book.xlsx', create: true }, exec), error => error.code === 'FILE_EXISTS')
  assert.equal(await readFile(join(workspace, 'test-output/nested/空白 book.xlsx'), 'utf8'), 'do-not-overwrite')
  await assert.rejects(tool.execute({ path: 'wrong.sjs', create: true }, exec), /supports .xlsx only/)
  await assert.rejects(access(join(workspace, 'wrong.sjs')))
  await assert.rejects(tool.execute({ path: 'missing.xlsx' }, exec), /path does not exist/)
  await assert.rejects(tool.execute({ path: 'wrong.ssjson', create: false, template: 'empty.ssjson' }, exec), /create:false/)
  await assert.rejects(tool.execute({ path: join(outside, 'uncreated/nested/book.xlsx'), create: true }, exec), error => error.code === 'SESSION_SCOPE_DENIED')
  await assert.rejects(access(join(outside, 'uncreated')))
  await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(tool.execute({ path: 'escape/uncreated/book.xlsx', create: true }, exec), error => error.code === 'SESSION_SCOPE_DENIED')
  await assert.rejects(access(join(outside, 'uncreated')))
  const created = await open({ path: 'custom/new book.ssjson', template: 'empty.ssjson' })
  assert(created.result.created && created.result.ready)
  assert.equal(await readFile(join(workspace, 'custom/new book.ssjson'), 'utf8'), customTemplate)
  assert(created.result.address.endsWith('/new%20book.ssjson'))
  const existing = await open({ path: 'custom/new book.ssjson' })
  assert.equal(existing.result.created, false)
  await assert.rejects(tool.execute({ path: 'custom/new book.ssjson', template: 'empty.ssjson' }, exec), error => error.code === 'FILE_EXISTS')
  await assert.rejects(tool.execute({ path: 'wrong.xlsx', template: 'empty.ssjson' }, exec), /same extension/)
  await assert.rejects(tool.execute({ path: join(workspace, '..', 'outside.ssjson'), template: 'empty.ssjson' }, exec), error => error.code === 'SESSION_SCOPE_DENIED')
  await assert.rejects(tool.execute({ path: 'empty.ssjson' }, { agent: undefined }), error => error.code === 'SESSION_SCOPE_UNAVAILABLE')
  console.log('open-workbook-smoke: bundled/custom templates, nested directories, existing files, readiness, escaping, no overwrite and workspace/junction scope passed')
} finally {
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
