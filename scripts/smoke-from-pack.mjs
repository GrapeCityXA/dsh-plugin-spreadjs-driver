import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKED_NAME = '@grapecity-software/dsh-spreadjs-driver'

function spawnNpm(args) {
  const options = { cwd: ROOT, encoding: 'utf8' }
  if (process.platform !== 'win32') return spawnSync('npm', args, options)
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return spawnSync(process.execPath, [cli, ...args], options)

  return spawnSync('npm', args, { ...options, shell: true })
}

const tmp = await mkdtemp(join(tmpdir(), 'sjs-pack-'))
const packDir = join(tmp, 'pack')
await mkdir(packDir, { recursive: true })
const packed = spawnNpm(['pack', '--pack-destination', packDir, '--silent'])
if (packed.error || packed.status !== 0) {
  console.error(packed.stderr || packed.stdout || `npm spawn failed: ${packed.error?.code ?? packed.error?.message}`)
  await rm(tmp, { recursive: true, force: true })
  process.exit(packed.status ?? 1)
}
const tarballs = (await readdir(packDir)).filter((f) => f.endsWith('.tgz'))
if (tarballs.length !== 1) {
  console.error(`expected exactly one tarball, got ${JSON.stringify(tarballs)}`)
  await rm(tmp, { recursive: true, force: true })
  process.exit(1)
}
const tgz = join(packDir, tarballs[0])
console.log(`smoke-from-pack: packed ${tgz}`)

const extractDir = join(tmp, 'x')
await mkdir(extractDir, { recursive: true })

const tarBin = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'
const tar = spawnSync(tarBin, ['-xzf', tgz, '-C', extractDir], { encoding: 'utf8' })
if (tar.status !== 0) {
  console.error(`tar failed: ${tar.stderr || tar.stdout}`)
  await rm(tmp, { recursive: true, force: true })
  process.exit(tar.status ?? 1)
}
const staged = join(extractDir, 'package')
const installed = await mkdtemp(join(ROOT, 'node_modules', '.spreadjs-pack-'))
await mkdir(join(ROOT, 'node_modules'), { recursive: true })
await cp(staged, installed, { recursive: true })

let failures = 0
let booted = false
const step = async (name, fn) => {
  try { await fn(); console.log(`  ok    ${name}`) }
  catch (error) { failures++; console.error(`  FAIL  ${name}: ${error.message}`) }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

try {
  const SpreadjsPlugin = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href)
  assert(typeof SpreadjsPlugin.resolveConfig === 'function', 'packed lib exports resolveConfig')
  assert(SpreadjsPlugin.name === 'dsh-spreadjs-driver', `packed plugin name: ${SpreadjsPlugin.name}`)

  const defaultConfig = SpreadjsPlugin.resolveConfig()
  if (defaultConfig.operationTimeoutMs !== 60_000 || defaultConfig.tools !== true || defaultConfig.skills !== true) {
    throw new Error(`packed default config drifted: ${JSON.stringify(defaultConfig)}`)
  }

  const WORKSPACE = await mkdtemp(join(tmpdir(), 'sjs-pack-ws-'))
  const ctx = new Context()
  ctx.provide('settings', { describe: () => [{ ns: 'spreadjs-editor', value: { bridge: PACKED_NAME } }] })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('llm', { async resolveModelInfo() { return { inputModalities: ['text'] } } })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SpreadjsPlugin, { operationTimeoutMs: 90_000 })
  booted = true
  const agent = {
    ctx,
    options: { provider: 'pack-smoke', model: 'test' },
    session: { header: { cwd: WORKSPACE }, requestHeader() { return { config: { provider: 'pack-smoke', model: 'test' } } } },
  }
  const callTool = async (name, args) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`pack-smoke-${name}`),
    name,
    arguments: args,
    agent,
  })
  const okJson = (result, what) => {
    assert(result.isError !== true, `${what}: tool errored: ${result.error?.message ?? JSON.stringify(result)}`)
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    return JSON.parse(text)
  }

  await step('packed bundle exposes resolveConfig and default config', async () => { /* asserted above */ })

  await step('spreadjs skill registers from the packed skills/ tree', async () => {
    const summaries = await ctx.skills.list({ cwd: WORKSPACE })
    const skill = summaries.find((s) => s.name === 'spreadjs')
    assert(skill !== undefined, `spreadjs missing from packed catalog ${JSON.stringify(summaries.map((s) => s.name))}`)
    assert(skill.provider === 'spreadjs' && skill.source === 'bundled', `packed candidate: ${JSON.stringify(skill)}`)
    const loaded = await ctx.skills.get('spreadjs', { cwd: WORKSPACE })
    assert(loaded !== undefined && typeof loaded.content === 'string' && loaded.content.includes('sjs_live_execute'),
      'packed skill body loads on demand')
  })

  await step('packed bundle offers editor tools and no server fallback', async () => {
    const result = await callTool('sjs_live_status', {})
    const body = okJson(result, 'sjs_live_status')
    assert(body.result.transport === 'unmounted' && body.result.workbooks.length === 0, JSON.stringify(body))
    const denied = await callTool('sjs_live_execute', { code: 'return 1' })
    assert(denied.isError === true, 'execution without editor transport must fail')
    const old = await callTool('sjs_execute', { file: 'unused.ssjson', code: 'return 1' })
    assert(old.isError === true, 'legacy server tool must not exist')
  })

  await rm(WORKSPACE, { recursive: true, force: true })
} catch (error) {
  failures++
  console.error(`FATAL  boot/run: ${error.stack ?? error.message}`)
} finally {
  await rm(installed, { recursive: true, force: true })
  await rm(tmp, { recursive: true, force: true })
}

if (!booted || failures > 0) {
  console.error(`\nsmoke-from-pack: ${failures} failing step(s)${booted ? '' : ' (never booted)'}`)
  process.exitCode = 1
} else {
  console.log('smoke-from-pack: all steps passed from packed files')
}
