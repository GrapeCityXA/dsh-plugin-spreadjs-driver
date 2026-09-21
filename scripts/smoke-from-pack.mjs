// "从 pack 安装冒烟": pack the real tarball, unpack it into node_modules/
// exactly where an install would place it, then boot the packed host bundle
// (lib/index.js) through a real cordis Context + SkillRegistry and drive one
// worker round-trip + the skills seam — all from the packed files, not the
// source tree. Offline: heavy deps resolve up the repo's own node_modules.
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
const PACKED_NAME = 'dsh-plugin-spreadjs-driver'

// Run npm through a real process. On Windows, `.cmd` shims cannot be spawned
// directly (EINVAL) — instead spawn the current node binary on npm's cli.js
// (same interpreter, no shell). On POSIX, `npm` from PATH is a shell script.
function spawnNpm(args) {
  const options = { cwd: ROOT, encoding: 'utf8' }
  if (process.platform !== 'win32') return spawnSync('npm', args, options)
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return spawnSync(process.execPath, [cli, ...args], options)
  // Fallback: rely on shell resolution for non-standard installs.
  return spawnSync('npm', args, { ...options, shell: true })
}

// --- 1. pack the real tarball -------------------------------------------------
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

// --- 2. unpack into repo node_modules, as an install would ----------------------
const extractDir = join(tmp, 'x')
await mkdir(extractDir, { recursive: true })
// Windows System32 ships libarchive's bsdtar, which takes native paths; the GNU
// tar that Git Bash puts on PATH misreads `C:\…` as a remote host. On POSIX, `tar` from PATH.
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
const installed = join(ROOT, 'node_modules', PACKED_NAME)
await rm(installed, { recursive: true, force: true })
await mkdir(join(ROOT, 'node_modules'), { recursive: true })
await cp(staged, installed, { recursive: true })

// --- 3. boot the PACKED host bundle --------------------------------------------
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
  assert(SpreadjsPlugin.name === 'dsh-plugin-spreadjs-driver', `packed plugin name: ${SpreadjsPlugin.name}`)

  const defaultConfig = SpreadjsPlugin.resolveConfig()
  if (defaultConfig.operationTimeoutMs !== 60_000 || defaultConfig.tools !== true || defaultConfig.skills !== true) {
    throw new Error(`packed default config drifted: ${JSON.stringify(defaultConfig)}`)
  }

  const WORKSPACE = await mkdtemp(join(tmpdir(), 'sjs-pack-ws-'))
  const ctx = new Context()
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
    assert(loaded !== undefined && typeof loaded.content === 'string' && loaded.content.includes('sjs_execute'),
      'packed skill body loads on demand')
  })

  await step('sjs_new from the packed bundle creates a workbook', async () => {
    const result = await callTool('sjs_new', { file: 'packed.ssjson' })
    const body = okJson(result, 'sjs_new')
    assert(body.ok === true && body.operation === 'new' && body.result.created === true,
      `sjs_new body: ${JSON.stringify(body)}`)
  })

  await step('sjs_execute drives a worker spawned from the packed artifact', async () => {
    const code = [
      "const s = sheet()",
      "s.setValue(0,0,'产品')", "s.setValue(1,0,'苹果')", "s.setValue(1,1,10)",
      "s.setFormula(2,1,'=B2*2')",
      "spread.resumeCalcService()", // the engine batches calculation; read after resuming
      "return { a: s.getValue(0,0), doubled: s.getValue(2,1) }",
    ].join('\n')
    const result = await callTool('sjs_execute', { file: 'packed.ssjson', code })
    const body = okJson(result, 'sjs_execute')
    assert(body.result.a === '产品' && body.result.doubled === 20, `execute result: ${JSON.stringify(body.result)}`)
  })

  await step('sjs_status reports the workbook back', async () => {
    const result = await callTool('sjs_status', { file: 'packed.ssjson' })
    const body = okJson(result, 'sjs_status')
    assert(body.result.sheets?.some((s) => s.usedRange?.rowCount >= 3), `status range: ${JSON.stringify(body.result)}`)
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
