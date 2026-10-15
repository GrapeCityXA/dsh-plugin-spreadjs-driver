// Exercise model-facing session scope and job ownership through the real RPC route.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { LiveChannel, livePlugin, resolveConfig } from '../lib/index.js'

function harness() {
  const tools = new Map()
  const disposers = []
  let route
  let rpcId = 0
  const services = {
    settings: { describe: () => [{ ns: 'spreadjs-editor', value: { bridge: '@grapecity-software/dsh-spreadjs-driver' } }] },
    connection: { requestRejection() {} },
    webServer: { register(next) { route = next; return () => {} } },
  }
  const effect = fn => { const value = fn(); if (typeof value === 'function') disposers.push(value); return value }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    effect, get: name => services[name], on: () => () => {},
    inject(names, fn) { if (names.every(name => services[name] !== undefined)) fn(ctx); return { dispose() {} } },
  }
  livePlugin.apply(ctx, resolveConfig({ operationTimeoutMs: 1000 }))
  return {
    tools, dispose: () => disposers.splice(0).reverse().forEach(fn => fn()),
    async call(method, payload) {
      const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ type: 'client-request', rpcId: String(++rpcId), method, payload }))]), {
        method: 'POST', url: `/spreadjs-live/${method}`, headers: { 'content-type': 'application/json' },
      })
      let body
      await route.handler(request, { writeHead() {}, end(value) { body = value } })
      return JSON.parse(body).result
    },
  }
}
const exec = (id, signal) => ({ agent: { session: { header: { id, cwd: process.cwd() } } }, ...(signal ? { signal } : {}) })
const offer = (tabId, sessionId, instanceId = 'instance-1', name = 'sales.xlsx') => ({
  tabId, editorSessions: [sessionId], targets: ['spreadjs-designer'],
  workbooks: [{ id: 'spreadjs-designer', sessionId, instanceId, file: `dsh-resource://file/session/${sessionId}/${name}` }],
})
const h = harness()
try {
  const a = offer('browser-A', 'chat-A')
  const b = offer('browser-B', 'chat-B')
  await h.call('poll', a)
  await h.call('poll', b)
  const status = (id) => h.tools.get('sjs_live_status').execute({}, exec(id))
  const execute = (id, args = {}, signal) => h.tools.get('sjs_live_execute').execute({ code: 'return 42', ...args }, exec(id, signal))
  const statusA = await status('chat-A')
  const statusB = await status('chat-B')
  assert.equal(statusA.result.workbooks.length, 1)
  assert.equal(statusB.result.workbooks.length, 1)
  const targetA = statusA.result.workbooks[0].id
  const targetB = statusB.result.workbooks[0].id
  assert.notEqual(targetA, targetB)
  assert(statusA.result.workbooks[0].file.includes('chat-A'))
  assert.equal((await status('chat-C')).result.workbooks.length, 0)
  await assert.rejects(execute('chat-A', { target: targetB }), error => error.code === 'SJS_LIVE_UNKNOWN_TARGET')
  await assert.rejects(h.tools.get('sjs_live_execute').execute({ code: 'return 1' }, {}), error => error.code === 'SESSION_SCOPE_UNAVAILABLE')
  await assert.rejects(h.tools.get('sjs_live_status').execute({}, {}), error => error.code === 'SESSION_SCOPE_UNAVAILABLE')
  const pending = execute('chat-A', { target: targetA })
  await Promise.resolve()
  assert.equal((await h.call('poll', b)).value, null, 'another chat claimed the job')
  const job = (await h.call('poll', a)).value
  assert.equal(job.binding.sessionId, 'chat-A')
  assert.equal(job.binding.instanceId, 'instance-1')
  const wrongOwner = await h.call('result', { tabId: 'browser-B', jobId: job.jobId, ok: true, value: 0 })
  assert.equal(wrongOwner.error.code, 'SJS_LIVE_WRONG_OWNER')
  assert.equal((await h.call('check', { tabId: 'browser-B', jobId: job.jobId })).value.active, false)
  assert.equal((await h.call('check', { tabId: 'browser-A', jobId: job.jobId })).value.active, true)
  await h.call('result', { tabId: 'browser-A', jobId: job.jobId, ok: true, value: 42, file: job.binding.file })
  assert.equal((await pending).result, 42)
  console.log('session-lifecycle: session-scoped status/execution, unique targets and claim ownership passed')

  const second = offer('browser-A2', 'chat-A', 'second-instance')
  await h.call('poll', second)
  assert.equal((await status('chat-A')).result.workbooks.length, 2)
  await assert.rejects(execute('chat-A'), error => error.code === 'SJS_LIVE_AMBIGUOUS_TARGET')
  const queued = execute('chat-A', { target: targetA }).catch(error => error)
  await Promise.resolve()
  assert.equal((await h.call('poll', offer('browser-A', 'chat-A', 'replacement'))).value, null)
  assert.equal((await queued).code, 'SJS_LIVE_INTERRUPTED')
  console.log('session-lifecycle: ambiguous workbooks require a target; replacement invalidates queued work')

  const replacementTarget = (await status('chat-A')).result.workbooks.find(workbook => workbook.instanceId === 'replacement').id
  const abort = new AbortController()
  const cancelled = execute('chat-A', { target: replacementTarget, save: true }, abort.signal).catch(error => error)
  await Promise.resolve()
  const claimed = (await h.call('poll', offer('browser-A', 'chat-A', 'replacement'))).value
  abort.abort()
  assert.equal((await cancelled).code, 'SJS_LIVE_ABORTED')
  assert.equal((await h.call('check', { tabId: 'browser-A', jobId: claimed.jobId })).value.active, false)
  await h.call('result', { tabId: 'browser-A', jobId: claimed.jobId, ok: true, value: 'late' })
  const timedOut = execute('chat-B', { target: targetB }).catch(error => error)
  await Promise.resolve()
  const timedJob = (await h.call('poll', b)).value
  assert.equal((await timedOut).code, 'SJS_LIVE_TIMEOUT')
  assert.equal((await h.call('check', { tabId: 'browser-B', jobId: timedJob.jobId })).value.active, false)
  console.log('session-lifecycle: cancellation and timeout revoke further save permission; late results are harmless')

  const waiting = execute('chat-B', { target: targetB }).catch(error => error)
  await Promise.resolve()
  h.dispose()
  assert.equal((await waiting).code, 'SJS_LIVE_DISCONNECTED')
} finally { h.dispose() }

// Exercise both queued and claimed promises, including physical route teardown.
for (const claim of [false, true]) {
  const channel = new LiveChannel()
  let route
  const unregister = channel.register({ authenticate: () => undefined, webServer: { register(value) { route = value; return () => {} } } })
  const poll = async () => {
    let body
    await route.handler(Object.assign(Readable.from([Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'dispose', method: 'poll', payload: { tabId: 'tab', targets: ['id'] } }))]), { method: 'POST', url: '/spreadjs-live/poll', headers: { 'content-type': 'application/json' } }), { writeHead() {}, end(value) { body = value } })
    return JSON.parse(body).result.value
  }
  await poll()
  const pending = channel.execute('return 1', { timeoutMs: 500 }).catch(error => error)
  if (claim) assert((await poll()).jobId)
  unregister()
  assert.equal((await pending).code, 'SJS_LIVE_DISCONNECTED')
  assert.equal(channel.reachability.ok, false)
}
console.log('session-lifecycle: disposal settles queued/claimed promises and marks transport unavailable')
