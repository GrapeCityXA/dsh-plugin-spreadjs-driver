// Host tool-chain smoke: boot the real cordis host bundle (lib/index.js) with a
// ToolRuntime, then drive sjs_new → sjs_execute → sjs_status → sjs_export →
// sjs_import through ctx.tools.execute deterministically — no agent/LLM. Every
// operation goes through the provider to a real engine process (started on the
// first call and reused after that), so this exercises provider path
// authorization + the tool definitions + the engine over the full protocol —
// including what happens when that engine dies mid-call.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as SpreadjsPlugin from '../lib/index.js'
import { findEnginePids } from './lib/engine.mjs'

const { resolveConfig } = SpreadjsPlugin

// --- config sanity ----------------------------------------------------------
const defaultConfig = resolveConfig()
if (defaultConfig.operationTimeoutMs !== 60_000 || defaultConfig.tools !== true) {
  throw new Error(`default config drifted: ${JSON.stringify(defaultConfig)}`)
}
try {
  resolveConfig({ operationTimeoutMs: 0 })
  throw new Error('zero operationTimeoutMs must be rejected')
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('operationTimeoutMs')) throw error
}

// --- workspace fixtures -----------------------------------------------------
const WORKSPACE = await mkdtemp(join(tmpdir(), 'sjs-tool-smoke-'))
const FILE = join(WORKSPACE, 'ledger.ssjson')
const XLSX = join(WORKSPACE, 'ledger.xlsx')
const ROUNDTRIP = join(WORKSPACE, 'roundtrip.ssjson')
const ROUNDTRIP_CSV = join(WORKSPACE, 'roundtrip.csv')
const BAD_SOURCE = join(WORKSPACE, 'notes.txt')
await writeFile(BAD_SOURCE, 'not a spreadsheet')
const OUTSIDE = join(tmpdir(), `sjs-outside-${process.pid}.ssjson`)
await writeFile(OUTSIDE, '{}')

// --- boot host bundle -------------------------------------------------------
const toolContext = new Context()
await toolContext.plugin(SystemPrompt)
await toolContext.plugin(ToolRuntime)
toolContext.provide('llm', {
  async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
})
await toolContext.plugin(SkillRegistry)
await toolContext.plugin(SpreadjsPlugin, { operationTimeoutMs: 90_000 })
const agent = {
  ctx: toolContext,
  options: { provider: 'tool-smoke', model: 'test' },
  session: {
    header: { cwd: WORKSPACE },
    requestHeader() { return { config: { provider: 'tool-smoke', model: 'test' } } },
  },
}

let failures = 0
const step = async (name, fn) => {
  try { await fn(); console.log(`  ok    ${name}`) }
  catch (error) { failures++; console.error(`  FAIL  ${name}: ${error.message}`) }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

async function callTool(name, args) {
  const result = await toolContext.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`tool-smoke-${name}`),
    name,
    arguments: args,
    agent,
  })
  return result
}
/** JSON text of a successful tool output (our tools render JSON.stringify(value)). */
function okJson(result, what) {
  assert(result.isError !== true, `${what}: tool errored: ${result.error?.message ?? JSON.stringify(result)}`)
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return JSON.parse(text)
}
function assertErrorCode(result, expectedCode, what) {
  assert(result.isError === true, `${what}: expected error, got ok: ${JSON.stringify(result.content ?? result)}`)
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('') + (result.error?.code ?? result.error?.message ?? '')
  assert(text.includes(expectedCode), `${what}: expected ${expectedCode} in ${JSON.stringify(text.slice(0, 200))}`)
}

console.log('host tool-chain smoke')
const sheetName = 'Sheet1'

await step('config defaults and validation', async () => { /* covered above */ })

// --- skills seam (task 6) ---------------------------------------------------
await step('spreadjs skill is registered and its body loads', async () => {
  const summaries = await toolContext.skills.list({ cwd: WORKSPACE })
  const skill = summaries.find((s) => s.name === 'spreadjs')
  assert(skill !== undefined, `spreadjs missing from catalog ${JSON.stringify(summaries.map((s) => s.name))}`)
  assert(typeof skill.description === 'string' && skill.description.length > 40, 'candidate has a real description')
  assert(skill.provider === 'spreadjs' && skill.source === 'bundled', `candidate metadata: ${JSON.stringify(skill)}`)
  const loaded = await toolContext.skills.get('spreadjs', { cwd: WORKSPACE })
  assert(loaded !== undefined && typeof loaded.content === 'string', 'skill body loads on demand')
  assert(!loaded.content.startsWith('---\n'), 'frontmatter is stripped from loaded content')
  assert(loaded.content.includes('Recommended flow') && loaded.content.includes('sjs_execute'), 'body content is intact')
})


await step('sjs_new creates a workbook', async () => {
  const result = await callTool('sjs_new', { file: 'ledger.ssjson' })
  const body = okJson(result, 'sjs_new')
  assert(body.ok === true && body.operation === 'new', `sjs_new body: ${JSON.stringify(body)}`)
  assert(body.result.created === true, 'new result.created')
})

await step('sjs_execute writes 中文 + formula and returns values', async () => {
  const code = [
    "const s = sheet()",
    "s.setValue(0,0,'产品')", "s.setValue(0,1,'数量')",
    "s.setValue(1,0,'苹果')", "s.setValue(1,1,10)",
    "s.setValue(2,0,'香蕉')", "s.setValue(2,1,20)",
    "s.setFormula(3,1,'=SUM(B2:B3)')",
    "spread.resumeCalcService()", // a formula read inside the batch returns null
    "return { a: s.getValue(0,0), sum: s.getValue(3,1) }",
  ].join('\n')
  const result = await callTool('sjs_execute', { file: 'ledger.ssjson', code })
  const body = okJson(result, 'sjs_execute')
  assert(body.result.a === '产品' && body.result.sum === 30, `execute result: ${JSON.stringify(body.result)}`)
})

await step('sjs_status reports the edited sheet', async () => {
  const result = await callTool('sjs_status', { file: 'ledger.ssjson' })
  const body = okJson(result, 'sjs_status')
  const sheet = body.result.sheets.find((s) => s.name === sheetName)
  assert(sheet !== undefined, `sheet ${sheetName} missing: ${JSON.stringify(body.result.sheets)}`)
  assert(sheet.usedRange?.rowCount >= 4 && sheet.usedRange?.colCount >= 2, `used range: ${JSON.stringify(sheet.usedRange)}`)
})

await step('sjs_export writes a valid xlsx', async () => {
  const result = await callTool('sjs_export', { file: 'ledger.ssjson', output: 'ledger.xlsx', format: 'xlsx' })
  const body = okJson(result, 'sjs_export xlsx')
  assert(body.result.bytes > 0, 'xlsx bytes')
  const bytes = await readFile(XLSX)
  assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'PK zip magic')
})

await step('sjs_import reads the xlsx back into ssjson', async () => {
  const result = await callTool('sjs_import', { file: 'ledger.xlsx', target: 'roundtrip.ssjson' })
  const body = okJson(result, 'sjs_import')
  assert(body.operation === 'import' && body.result.format === 'excel', `import: ${JSON.stringify(body)}`)
  assert(Array.isArray(body.result.sheets), 'import exposes sheets')
})

await step('sjs_status on the roundtrip shows content, not a single cell', async () => {
  const result = await callTool('sjs_status', { file: 'roundtrip.ssjson' })
  const body = okJson(result, 'sjs_status roundtrip')
  const sheet = body.result.sheets.find((s) => s.name === sheetName)
  assert(sheet !== undefined, `roundtrip sheet ${sheetName} missing: ${JSON.stringify(body.result.sheets.map((s) => s.name))}`)
  assert(sheet.usedRange !== undefined && sheet.usedRange.colCount >= 2, `roundtrip used range bounded: ${JSON.stringify(sheet.usedRange)}`)
})

await step('sjs_export csv of the roundtrip carries the header and the SUM row', async () => {
  const result = await callTool('sjs_export', { file: 'roundtrip.ssjson', output: 'roundtrip.csv', format: 'csv' })
  const body = okJson(result, 'sjs_export csv')
  assert(body.result.usedRange !== undefined && body.result.usedRange.rowCount >= 4, `csv range: ${JSON.stringify(body.result.usedRange)}`)
  const text = await readFile(ROUNDTRIP_CSV, 'utf8')
  assert(text.includes('产品') && text.includes('30'), `roundtrip csv content: ${JSON.stringify(text.slice(0, 120))}`)
})

await step('sjs_export pdf produces a PDF with fonts', async () => {
  const result = await callTool('sjs_export', { file: 'ledger.ssjson', output: 'ledger.pdf', format: 'pdf' })
  if (result.isError) {
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    assert(text.includes('SJS_PDF_FONT_UNAVAILABLE'), `pdf without fonts must guard: ${text.slice(0, 120)}`)
  } else {
    const body = JSON.parse(result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    assert(Array.isArray(body.result.fonts) && body.result.fonts.length >= 1, 'pdf registered fonts')
    const bytes = await readFile(join(WORKSPACE, 'ledger.pdf'))
    assert(bytes[0] === 0x25 && bytes[1] === 0x50, '%PDF magic')
  }
})

// --- screenshot (task 5) ----------------------------------------------------
await step('sjs_screenshot png writes a real png of the 中文 workbook', async () => {
  const result = await callTool('sjs_screenshot', { file: 'ledger.ssjson', output: 'ledger.png', format: 'png' })
  const body = okJson(result, 'sjs_screenshot png')
  assert(body.operation === 'screenshot' && body.result.format === 'png', `screenshot body: ${JSON.stringify(body)}`)
  assert(typeof body.result.width === 'number' && body.result.width > 0, `png width ${body.result.width}`)
  assert(typeof body.result.height === 'number' && body.result.height > 0, `png height ${body.result.height}`)
  assert(typeof body.result.font === 'string' && body.result.font.length > 0, 'png reports forced font')
  const bytes = await readFile(join(WORKSPACE, 'ledger.png'))
  assert(bytes.length > 1000, `png has pixels (${bytes.length} bytes)`)
  assert(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e, 'PNG magic')
})

await step('sjs_screenshot pdf writes a %PDF snapshot', async () => {
  const result = await callTool('sjs_screenshot', { file: 'ledger.ssjson', output: 'ledger-snapshot.pdf', format: 'pdf' })
  if (result.isError) {
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    assert(text.includes('SJS_PDF_FONT_UNAVAILABLE'), `pdf snapshot without fonts must guard: ${text.slice(0, 120)}`)
  } else {
    const body = JSON.parse(result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    assert(Array.isArray(body.result.fonts) && body.result.fonts.length >= 1, 'pdf snapshot registered fonts')
    const bytes = await readFile(join(WORKSPACE, 'ledger-snapshot.pdf'))
    assert(bytes[0] === 0x25 && bytes[1] === 0x50, '%PDF magic')
  }
})

// --- image attachment (task 7): mounted store + image-capable route ----------
let savedPreview = null
toolContext.provide('attachments', {
  imageLimits: { mediaTypes: ['image/png', 'image/jpeg'] },
  async saveImage(input) {
    savedPreview = { name: input.name, bytes: input.data.byteLength }
    return {
      attachmentId: 'att-png-preview',
      mediaType: 'image/png',
      bytes: input.data.byteLength,
      width: 640,
      height: 400,
    }
  },
})

await step('sjs_screenshot png attaches an image block for an image-capable route', async () => {
  const result = await callTool('sjs_screenshot', { file: 'ledger.ssjson', output: 'ledger-preview.png', format: 'png' })
  assert(result.isError !== true, `tool errored: ${result.error?.message ?? JSON.stringify(result)}`)
  const blocks = result.content ?? []
  const image = blocks.find((b) => b.type === 'image')
  assert(image !== undefined, `expected an image block, got: ${JSON.stringify(blocks.map((b) => b.type))}`)
  assert(image.attachment?.attachmentId === 'att-png-preview', `attachment ref: ${JSON.stringify(image.attachment)}`)
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const body = JSON.parse(text)
  assert(body.result?.image?.attachmentId === 'att-png-preview', 'text envelope carries the ref under result.image')
  assert(savedPreview !== null && savedPreview.bytes > 1000, 'attachments.saveImage received real png bytes')
  assert(typeof savedPreview.name === 'string' && savedPreview.name.endsWith('.png'), `preview name: ${savedPreview?.name}`)
})

await step('sjs_screenshot rejects a format/extension mismatch', async () => {
  const result = await callTool('sjs_screenshot', { file: 'ledger.ssjson', output: 'ledger.png', format: 'pdf' })
  assertErrorCode(result, 'INVALID_FILE_PATH', 'pdf output must be .pdf')
})

await step('sjs_screenshot rejects a missing workbook', async () => {
  const result = await callTool('sjs_screenshot', { file: 'missing.ssjson', output: 'x.png', format: 'png' })
  assertErrorCode(result, 'INVALID_FILE_PATH', 'missing workbook')
})

// --- file-level worktrees ---------------------------------------------------
let baseBeforeCreate
await step('sjs_worktree list starts empty', async () => {
  const result = await callTool('sjs_worktree', { action: 'list' })
  const body = okJson(result, 'sjs_worktree list')
  assert(body.result.action === 'list' && Array.isArray(body.result.worktrees) && body.result.worktrees.length === 0,
    `empty worktrees: ${JSON.stringify(body.result)}`)
  baseBeforeCreate = await readFile(FILE, 'utf8')
})

let worktreeDraft
await step('sjs_worktree create branches an isolated draft', async () => {
  const result = await callTool('sjs_worktree', { action: 'create', file: 'ledger.ssjson', worktreeId: 'wt-demo' })
  const body = okJson(result, 'sjs_worktree create')
  assert(body.operation === 'worktree' && body.result.action === 'create', `create body: ${JSON.stringify(body)}`)
  assert(body.result.worktreeId === 'wt-demo' && body.result.status === 'editing', `record: ${JSON.stringify(body.result)}`)
  worktreeDraft = body.result.draft
  assert(worktreeDraft.endsWith('.ssjson'), `draft must be .ssjson: ${worktreeDraft}`)
  // Draft starts byte-identical to the committed base.
  const draftBytes = await readFile(join(WORKSPACE, ...worktreeDraft.split('/')), 'utf8')
  assert(draftBytes === baseBeforeCreate, 'draft must snapshot the base')
  const baseAfterCreate = await readFile(FILE, 'utf8')
  assert(baseAfterCreate === baseBeforeCreate, 'create must not modify the base')
})

await step('sjs_execute edits the draft only, leaving the base pristine', async () => {
  const code = [
    "const s = sheet()",
    "s.setValue(5, 0, 'draft-only')",
    "return { cell: s.getValue(5, 0) }",
  ].join('\n')
  const result = await callTool('sjs_execute', { file: worktreeDraft, code })
  const body = okJson(result, 'draft execute')
  assert(body.result.cell === 'draft-only', `draft execute: ${JSON.stringify(body.result)}`)
  const baseAfter = await readFile(FILE, 'utf8')
  assert(baseAfter === baseBeforeCreate, 'draft edits must not touch the committed base')
})

await step('sjs_status reads the draft and sees the draft-only edit', async () => {
  const result = await callTool('sjs_status', { file: worktreeDraft })
  const body = okJson(result, 'draft status')
  const sheet = body.result.sheets.find((s) => s.name === sheetName)
  assert(sheet !== undefined && sheet.usedRange?.rowCount >= 6, `draft used range: ${JSON.stringify(sheet?.usedRange)}`)
})

await step('sjs_worktree rejects a duplicate worktreeId', async () => {
  const result = await callTool('sjs_worktree', { action: 'create', file: 'ledger.ssjson', worktreeId: 'wt-demo' })
  assertErrorCode(result, 'INVALID_FILE_PATH', 'duplicate worktreeId')
})

await step('sjs_worktree create auto-uniquifies a generated id', async () => {
  const result = await callTool('sjs_worktree', { action: 'create', file: 'ledger.ssjson' })
  const body = okJson(result, 'auto id create')
  assert(body.result.worktreeId.startsWith('ledger.draft'), `auto id: ${JSON.stringify(body.result)}`)
})

await step('sjs_worktree list reports open drafts with their status', async () => {
  const result = await callTool('sjs_worktree', { action: 'list' })
  const body = okJson(result, 'worktree list')
  assert(body.result.action === 'list' && body.result.worktrees.length === 2, `two open drafts: ${JSON.stringify(body.result)}`)
  const demo = body.result.worktrees.find((w) => w.worktreeId === 'wt-demo')
  assert(demo !== undefined && demo.status === 'editing' && demo.draft === worktreeDraft,
    `demo draft listed: ${JSON.stringify(demo)}`)
})

await step('sjs_export renders the draft to a valid xlsx', async () => {
  const result = await callTool('sjs_export', { file: worktreeDraft, output: 'wt-demo.xlsx', format: 'xlsx' })
  const body = okJson(result, 'draft export')
  assert(body.result.bytes > 0, 'draft xlsx bytes')
  const bytes = await readFile(join(WORKSPACE, 'wt-demo.xlsx'))
  assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'draft xlsx PK magic')
})

// --- error-code paths -------------------------------------------------------
await step('sjs_execute rejects both code and codeFile', async () => {
  const result = await callTool('sjs_execute', { file: 'ledger.ssjson', code: 'return 1', codeFile: 'x.js' })
  assertErrorCode(result, 'INVALID_EXECUTION_SOURCE', 'both code and codeFile')
})

await step('sjs_execute classifies a thrown script error', async () => {
  const result = await callTool('sjs_execute', { file: 'ledger.ssjson', code: 'throw new Error("boom")' })
  assertErrorCode(result, 'SJS_SCRIPT_ERROR', 'thrown script error')
})

await step('a script error names the line of the caller\'s code that raised it', async () => {
  // The message alone is not actionable when the failure comes from inside
  // SpreadJS: it names a method the script never wrote. One real report read
  // `Cannot read properties of undefined (reading 'getRowCount')` with no
  // `getRowCount` anywhere in the script, and cost three retries.
  const code = 'const a = 1\nconst b = 2\nthrow new Error("kara")\nconst c = 3'
  const result = await callTool('sjs_execute', { file: 'ledger.ssjson', code })

  assertErrorCode(result, 'SJS_SCRIPT_ERROR', 'thrown script error')
  const message = JSON.stringify(result.content ?? result)
  assert(message.includes('kara'), `the cause was lost: ${message}`)
  assert(message.includes('from your line 3'),
    `the failing line was not reported (expected "from your line 3"): ${message}`)
  assert(message.includes('throw new Error('),
    `the offending source line was not quoted: ${message}`)
})

await step('concurrent edits to one workbook all survive', async () => {
  // Each edit is a whole read-modify-write in its own process, so overlapping
  // edits used to overwrite each other while every call still reported success.
  // A model parallelizing tool calls hits this immediately.
  const file = 'concurrent.ssjson'
  okJson(await callTool('sjs_new', { file }), 'sjs_new concurrent')

  const edits = Array.from({ length: 6 }, (_, i) =>
    toolContext.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`tool-smoke-concurrent-${i}`),
      name: 'sjs_execute',
      arguments: { file, code: `const s = sheet(); s.setValue(${i + 1}, 0, 'w${i}'); return 'w${i}'` },
      agent,
    }),
  )
  const results = await Promise.all(edits)
  results.forEach((result, i) => {
    assert(okJson(result, `concurrent edit ${i}`).ok === true, `concurrent edit ${i} reported ok`)
  })

  const read = okJson(
    await callTool('sjs_execute', {
      file,
      code: 'const s = sheet(); const out = []; for (let r = 1; r <= 6; r++) out.push(s.getValue(r, 0)); return out',
    }),
    'read back after concurrent edits',
  )
  const values = read.result
  assert(
    Array.isArray(values) && values.every((value, i) => value === `w${i}`),
    `every concurrent edit survived: ${JSON.stringify(values)}`,
  )
})

await step('sjs_execute grows the sheet instead of dropping out-of-range writes', async () => {
  // A fresh worksheet is 200x20 and out-of-range writes vanish silently, so a
  // model writing 5000 rows would see success and lose the data.
  const file = 'grow.ssjson'
  okJson(await callTool('sjs_new', { file }), 'sjs_new grow')
  const write = okJson(
    await callTool('sjs_execute', {
      file,
      code: [
        'const s = sheet()',
        'for (let r = 0; r < 5000; r++) s.setValue(r, 0, r)',
        'for (let c = 0; c < 40; c++) s.setValue(0, c, c)',
        's.setFormula(5000, 0, "=SUM(A1:A5000)")',
        'spread.resumeCalcService()', // resume before reading a calculated value
        'return { v4999: s.getValue(4999, 0), last: s.getValue(0, 39), sum: s.getValue(5000, 0) }',
      ].join('\n'),
    }),
    'grow write',
  ).result
  assert(write.v4999 === 4999, `row 4999 survived: ${JSON.stringify(write)}`)
  assert(write.last === 39, `column 39 survived: ${JSON.stringify(write)}`)
  assert(write.sum === (4999 * 5000) / 2, `formula over the grown range evaluates: ${JSON.stringify(write)}`)
})

await step('sjs_execute reports an unusable sheet name with the offending characters', async () => {
  const result = await callTool('sjs_execute', {
    file: 'ledger.ssjson',
    code: "const s = sheet(); s.name('A/B'); return s.name()",
  })
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  assert(result.isError === true, 'an illegal sheet name is an error')
  assert(text.includes('SJS_SHEET_NAME_INVALID'), `error names the code: ${text.slice(0, 160)}`)
  assert(text.includes('/'), `error names the offending character: ${text.slice(0, 160)}`)
})

await step('sjs_import rejects an unsupported source extension', async () => {
  const result = await callTool('sjs_import', { file: 'notes.txt', target: 'nope.ssjson' })
  assertErrorCode(result, 'INVALID_FILE_PATH', 'unsupported import source')
})

await step('sjs_export rejects a format/extension mismatch', async () => {
  const result = await callTool('sjs_export', { file: 'ledger.ssjson', output: 'ledger.xlsx', format: 'csv' })
  assertErrorCode(result, 'INVALID_FILE_PATH', 'csv output must be .csv')
})

await step('sjs_status rejects an outside-workspace path', async () => {
  const result = await callTool('sjs_status', { file: OUTSIDE })
  assertErrorCode(result, 'SESSION_SCOPE_DENIED', 'outside workspace')
})

await step('sjs_status reports a missing workbook as invalid path', async () => {
  const result = await callTool('sjs_status', { file: 'missing.ssjson' })
  assertErrorCode(result, 'INVALID_FILE_PATH', 'missing workbook')
})

// --- engine lifecycle (stage 2) ---------------------------------------------
//
// The engine is a long-lived process now, so "the worker went away" is no longer
// the same thing as "this call failed": it can happen MID-call, and the host has
// to fail that call with a code the model can act on and start a fresh engine for
// the next one.
await step('a call fails with SJS_ENGINE_DIED when the engine dies mid-request', async () => {
  const pidsBefore = findEnginePids({ parentPid: process.pid })
  assert(pidsBefore.length > 0, 'no engine is running before the kill step, so there is nothing to test')
  // A script that parks in the page: the sandbox allows timers, so the request is
  // in flight for a known long time and the kill cannot race its arrival.
  const hanging = callTool('sjs_execute', {
    file: 'ledger.ssjson',
    code: 'await new Promise((resolve) => setTimeout(resolve, 60000)); return "never"',
  })
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const target = findEnginePids({ parentPid: process.pid })[0]
  assert(target !== undefined, 'the engine disappeared before it could be killed')
  process.kill(target)
  const result = await hanging
  assertErrorCode(result, 'SJS_ENGINE_DIED', 'the engine died while the call was running')
})

await step('the next call starts a fresh engine instead of writing into a corpse', async () => {
  const result = await callTool('sjs_status', { file: 'ledger.ssjson' })
  const body = okJson(result, 'sjs_status after the engine was killed')
  assert(body.result.sheets.length >= 1, 'the restarted engine reports the workbook')
})

await step('an aborted call fails promptly and leaves a usable engine behind', async () => {
  // The other half of the same hazard: cancelling kills the engine, so the call
  // that was in flight has to be failed by the cancellation itself. Waiting for
  // the process to exit instead would leave it pending forever — the engine is
  // gone and nothing else will ever answer.
  const controller = new AbortController()
  const hanging = toolContext.tools.execute({
    signal: controller.signal,
    callId: ToolCallId('tool-smoke-abort'),
    name: 'sjs_execute',
    arguments: { file: 'ledger.ssjson', code: 'await new Promise((resolve) => setTimeout(resolve, 60000)); return 1' },
    agent,
  })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  controller.abort()
  const result = await hanging
  assert(result.isError === true, `an aborted call must not report success: ${JSON.stringify(result.content ?? result)}`)
  const after = await callTool('sjs_status', { file: 'ledger.ssjson' })
  assert(okJson(after, 'sjs_status after the abort').result.sheets.length >= 1, 'the engine still works after an abort')
})

await step('sjs_live_status explains an unreachable profile without the sidebar advice', async () => {
  const result = await callTool('sjs_live_status', {})
  const r = okJson(result, 'live status').result

  // This harness boots the host half with no web server, so the live channel
  // cannot mount — which is exactly the case the hint must NOT fire in. Telling
  // the model to have the user open a file in the sidebar would be wrong advice
  // for a profile that can never serve the live path; `reason` is the answer
  // there instead.
  assert(r.client === 'none', `expected no connected client, got ${JSON.stringify(r.client)}`)
  if (r.transport === 'unmounted') {
    assert(typeof r.reason === 'string' && r.reason.length > 0, 'an unmounted channel must explain itself')
    assert(r.hint === undefined,
      'the sidebar advice must not appear when the profile cannot serve the live path')
  }
})

await step('the pivot shape SKILL.md documents runs as written', async () => {
  // Pins the example the skill actually shows, not an equivalent one: the
  // documented call is what a model copies verbatim, and the version of it that
  // shipped before this test passed a subtotal ENUM the designer's page does not
  // expose — a failure only the live path could show (see the note below).
  const file = 'pivot-shape.ssjson'
  okJson(await callTool('sjs_new', { file }), 'sjs_new for the pivot shape')
  const code = [
    "const d = sheet()",
    "d.setArray(0, 0, [['地区', '金额'], ['华东', 100], ['华北', 200], ['华东', 150]])",
    "d.tables.add('tableSales', 0, 0, 4, 2)",
    "spread.addSheet(spread.getSheetCount(), new GC.Spread.Sheets.Worksheet('PivotLayout'))",
    'const layout = spread.getSheet(spread.getSheetCount() - 1)',
    "const pt = layout.pivotTables.add('pt1', 'tableSales', 1, 0, GC.Spread.Pivot.PivotTableLayoutType.outline, GC.Spread.Pivot.PivotTableThemes.medium8)",
    "pt.add('地区', '地区', GC.Spread.Pivot.PivotTableFieldType.rowField)",
    // The skill passes the VALUE (8 = sum) because the enum's `GC.Pivot` root is
    // absent from the designer's page. This engine has it, which is exactly why
    // this test cannot catch that divergence — the live half has no harness here.
    "pt.add('金额', '金额', GC.Spread.Pivot.PivotTableFieldType.valueField, 8)",
    'return { pivots: layout.pivotTables.all().length }',
  ].join('\n')
  const result = okJson(await callTool('sjs_execute', { file, code }), 'pivot shape')
  assert(result.result.pivots === 1, `the pivot was not created: ${JSON.stringify(result.result)}`)
})

await rm(WORKSPACE, { recursive: true, force: true })
await rm(OUTSIDE, { force: true })
if (failures > 0) {
  console.error(`\ntool-smoke: ${failures} failing step(s)`)
  process.exitCode = 1
} else {
  console.log('tool-smoke: all steps passed')
}
