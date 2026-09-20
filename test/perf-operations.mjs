// Per-operation wall time for the operations the plugin actually serves.
//
// Not part of `pnpm run ci`: it takes minutes (a PDF export registers ~136 font
// files per page) and it asserts nothing about correctness — worker-smoke and
// export-integrity do that. This exists to answer "did the runtime get faster,
// and where did the time go", which is a question that has to be re-answerable
// after any change to the engine, not a claim to be taken on faith.
//
//   node test/perf-operations.mjs [--mode=engine|oneshot] [--rounds=3] [--json]
//
// The two modes differ only in how the engine process is driven:
//
//   engine   one engine for the whole set — how the plugin runs it: the browser
//            is launched once and each operation gets a fresh page.
//   oneshot  a fresh engine process per request, which is the cost profile of
//            the previous (one-shot) runtime: process + browser + bundles every
//            time. Run against a build of the old code it reproduces that
//            release's numbers; run against this one it describes what the
//            design removes.
//
// Both modes share the fixture and the measurement loop, so the two columns are
// comparable by construction.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarness } from './lib/engine.mjs'

const argv = process.argv.slice(2)
const mode = (argv.find((a) => a.startsWith('--mode=')) ?? '--mode=engine').slice('--mode='.length)
const rounds = Number((argv.find((a) => a.startsWith('--rounds=')) ?? '--rounds=3').slice('--rounds='.length))
const asJson = argv.includes('--json')

if (mode !== 'engine' && mode !== 'oneshot') {
  console.error(`--mode must be engine or oneshot, got ${mode}`)
  process.exit(2)
}

/** Run one request: through the shared engine, or through a process of its own. */
async function send(harness, request, timeoutMs = 120_000) {
  if (mode === 'engine') return await harness.runWorker(request, { timeoutMs })
  const fresh = createHarness()
  try {
    return await fresh.runWorker(request, { timeoutMs })
  } finally {
    await fresh.close()
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const run = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sjs-perf-'))
  const book = join(dir, 'book.ssjson')
  const xlsx = join(dir, 'book.xlsx')
  const pdf = join(dir, 'book.pdf')
  const png = join(dir, 'book.png')
  const harness = createHarness()

  // A fixture of a realistic size: 62 rows x 8 columns of CJK text, numbers and
  // a formula column — the shape the design document measured with.
  const fill = [
    'const s = sheet()',
    "s.setColumnWidth(0, 150)",
    "const head = ['订单号','客户','地区','单价','数量','金额','日期','备注']",
    'for (let c = 0; c < head.length; c++) s.setValue(0, c, head[c])',
    'for (let r = 1; r <= 62; r++) {',
    "  s.setValue(r, 0, '订单-2026-' + String(r).padStart(3, '0'))",
    "  s.setValue(r, 1, '客户' + r)",
    "  s.setValue(r, 2, r % 2 ? '华东' : '华北')",
    '  s.setValue(r, 3, 100 + r)',
    '  s.setValue(r, 4, 1 + (r % 9))',
    '  s.setFormula(r, 5, "=D" + (r + 1) + "*E" + (r + 1))',
    "  s.setValue(r, 6, new Date(2026, 0, 1 + (r % 28)))",
    "  s.setValue(r, 7, '备注文本' + r)",
    '}',
    'return { rows: s.getRowCount() }',
  ].join('\n')

  const steps = [
    ['new', { op: 'new', targetPath: book }],
    ['execute', { op: 'execute', sourcePath: book, workspaceRoot: dir, code: fill }],
    ['export xlsx', { op: 'export', sourcePath: book, outputPath: xlsx, format: 'xlsx' }],
    ['import xlsx', { op: 'import', sourcePath: xlsx, targetPath: join(dir, 'roundtrip.ssjson') }],
    ['export xlsx (2)', { op: 'export', sourcePath: book, outputPath: xlsx, format: 'xlsx' }],
    ['screenshot png', { op: 'screenshot', sourcePath: book, outputPath: png, format: 'png' }],
    ['export pdf', { op: 'export', sourcePath: book, outputPath: pdf, format: 'pdf' }],
  ['screenshot pdf', { op: 'screenshot', sourcePath: book, outputPath: `${pdf}.shot.pdf`, format: 'pdf' }],
    ['status', { op: 'status', sourcePath: book }],
  ]

  // Warm-up round: it is what loads the bundles into the browser's cache, so
  // counting it would mix "first page ever" into the steady-state numbers.
  for (const [, request] of steps) await send(harness, request)
  await send(harness, { op: 'new', targetPath: book })

  const timings = new Map(steps.map(([label]) => [label, []]))
  for (let round = 0; round < rounds; round++) {
    for (const [label, request] of steps) {
      const started = performance.now()
      const envelope = await send(harness, request)
      const elapsed = performance.now() - started
      if (envelope.ok !== true) throw new Error(`${label} failed: ${JSON.stringify(envelope.error)}`)
      timings.get(label).push(elapsed)
    }
  }
  await harness.close()

  const summary = [...timings].map(([label, values]) => ({
    operation: label,
    medianMs: Math.round(median(values)),
    minMs: Math.round(Math.min(...values)),
    maxMs: Math.round(Math.max(...values)),
    runs: values.length,
  }))

  if (asJson) {
    console.log(JSON.stringify({ mode, rounds, operations: summary }, null, 2))
  } else {
    console.log(`spreadjs engine performance — mode=${mode} rounds=${rounds} (median of ${rounds})`)
    for (const row of summary) {
      console.log(`  ${row.operation.padEnd(18)} ${String(row.medianMs).padStart(6)} ms   (min ${String(row.minMs).padStart(6)} / max ${String(row.maxMs).padStart(6)})`)
    }
    const total = summary.reduce((sum, row) => sum + row.medianMs, 0)
    console.log(`  ${'total'.padEnd(18)} ${String(total).padStart(6)} ms`)
  }

  await rm(dir, { recursive: true, force: true })
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
