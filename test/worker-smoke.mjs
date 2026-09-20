// Smoke-test the built engine without booting DSH: start the engine artifact
// once, drive new/status/execute/import/export/screenshot over the framed
// protocol, and assert the classified error codes. Requires `node
// scripts/build.mjs` first.
//
// The engine is persistent now, so this file starts ONE engine for all of its
// steps (that is what makes the suite fast) and covers the lifecycle a
// long-lived process introduces at the end: idle shutdown, no orphaned browser.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserProcessCount, createHarness, pageWindowCount } from './lib/engine.mjs'

const engine = createHarness()
const runWorker = engine.runWorker

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

function assertOk(envelope, message) {
  assert(envelope.ok === true, `${message}: expected ok envelope, got ${JSON.stringify(envelope)}`)
}

function assertError(envelope, expectedCode, message) {
  assert(envelope.ok === false, `${message}: expected error envelope, got ${JSON.stringify(envelope)}`)
  assert(envelope.error?.code === expectedCode, `${message}: expected ${expectedCode}, got ${envelope.error?.code}`)
}

let failures = 0
const step = (name, fn) => async () => {
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL  ${name}: ${error.message}`)
  }
}

const run = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sjs-smoke-'))
  const workbook = join(dir, 'ledger.ssjson')
  // Baseline for the orphan check at the end: engines belonging to OTHER
  // sessions (a dev machine running DSH) must not be counted as ours.
  const browsersBefore = browserProcessCount()
  console.log('engine smoke')

  await step('new creates an empty workbook', async () => {
    const envelope = await runWorker({ op: 'new', targetPath: workbook })
    assertOk(envelope, 'new')
    assert(envelope.result.created === true, 'new result.created')
    const info = await stat(workbook)
    assert(info.size > 0, 'workbook file written')
  })()

  let sheetName = null
  await step('status reports sheet metadata', async () => {
    const envelope = await runWorker({ op: 'status', sourcePath: workbook })
    assertOk(envelope, 'status')
    assert(Array.isArray(envelope.result.sheets) && envelope.result.sheets.length >= 1, 'status has >=1 sheet')
    assert(typeof envelope.result.sheets[0].name === 'string' && envelope.result.sheets[0].name.length > 0, 'status exposes sheet name')
    sheetName = envelope.result.sheets[0].name
  })()

  await step('execute writes values to the active sheet and returns JSON', async () => {
    const code = [
      'const s = sheet()',
      's.setValue(0, 0, 5)',
      's.setValue(1, 0, 7)',
      'return { a1: s.getValue(0, 0), a2: s.getValue(1, 0), total: s.getValue(0, 0) + s.getValue(1, 0) }',
    ].join('\n')
    const envelope = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code })
    assertOk(envelope, 'execute')
    assert(envelope.result.a1 === 5 && envelope.result.a2 === 7 && envelope.result.total === 12, 'execute returned computed values')
  })()

  await step('execute addresses a sheet by its discovered name', async () => {
    const code = `const s = sheet(${JSON.stringify(sheetName)})\ns.setValue(0, 1, 'named ok')\nreturn { cell: s.getValue(0, 1) }`
    const envelope = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code })
    assertOk(envelope, 'execute by name')
    assert(envelope.result.cell === 'named ok', 'execute by name wrote the cell')
  })()

  await step('status reflects persisted edits', async () => {
    const envelope = await runWorker({ op: 'status', sourcePath: workbook })
    assertOk(envelope, 'status after execute')
    const sheet = envelope.result.sheets.find((s) => s.name === sheetName)
    assert(sheet !== undefined && sheet.usedRange?.rowCount >= 2, 'used range grew after execute')
  })()

  await step('execute survives a formula cell', async () => {
    const code = [
      'const s = sheet()',
      "s.setFormula(2, 0, '=A1+A2')",
      'return { a1: s.getValue(0, 0), a2: s.getValue(1, 0) }',
    ].join('\n')
    const envelope = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code })
    assertOk(envelope, 'execute with formula')
  })()

  await step('execute classifies a thrown script error', async () => {
    const envelope = await runWorker({
      op: 'execute', sourcePath: workbook, workspaceRoot: dir,
      code: 'throw new Error("boom")',
    })
    assertError(envelope, 'SJS_SCRIPT_ERROR', 'script error code')
  })()

  await step('execute rejects a non-serializable return', async () => {
    const envelope = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: 'return () => 1' })
    assertError(envelope, 'SJS_NON_SERIALIZABLE_RESULT', 'non-serializable code')
  })()

  await step('execute rejects io escape from the workspace', async () => {
    const envelope = await runWorker({
      op: 'execute', sourcePath: workbook, workspaceRoot: dir,
      code: "return await io.readText('../../outside.txt')",
    })
    assertError(envelope, 'SJS_FILE_PERMISSION_DENIED', 'workspace escape')
  })()

  await step('missing file classifies as read failure', async () => {
    const envelope = await runWorker({ op: 'status', sourcePath: join(dir, 'missing.ssjson') })
    assertError(envelope, 'SJS_FILE_READ_FAILED', 'missing file')
  })()

  await step('malformed request classifies as bad request', async () => {
    const envelope = await runWorker('this is not json')
    assertError(envelope, 'SJS_BAD_REQUEST', 'malformed request')
  })()

  // ---- import / export (task 3) ----
  const xlsxOut = join(dir, 'book.xlsx')
  const xlsxRoundtrip = join(dir, 'book-from-xlsx.ssjson')
  const csvOut = join(dir, 'book.csv')
  const csvRoundtrip = join(dir, 'book-from-csv.ssjson')
  const csvSource = join(dir, 'external.csv')
  const csvImported = join(dir, 'external.ssjson')
  const pdfOut = join(dir, 'book.pdf')

  await step('export writes a valid xlsx file', async () => {
    const envelope = await runWorker({ op: 'export', sourcePath: workbook, outputPath: xlsxOut, format: 'xlsx' })
    assertOk(envelope, 'export xlsx')
    assert(envelope.result.bytes > 0, 'export xlsx produced bytes')
    const bytes = await readFile(xlsxOut)
    assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'xlsx starts with PK zip magic')
  })()

  await step('import reads the xlsx back into a new ssjson', async () => {
    const envelope = await runWorker({ op: 'import', sourcePath: xlsxOut, targetPath: xlsxRoundtrip })
    assertOk(envelope, 'import xlsx')
    assert(Array.isArray(envelope.result.sheets) && envelope.result.sheets.length >= 1, 'import xlsx produced sheets')
  })()

  await step('xlsx round-trip preserves the edited cell', async () => {
    const envelope = await runWorker({ op: 'status', sourcePath: xlsxRoundtrip })
    assertOk(envelope, 'status after xlsx import')
    const names = envelope.result.sheets.map((s) => s.name)
    assert(names.some((n) => typeof n === 'string' && n.length > 0), 'xlsx import exposes sheet names')
    // The round-tripped workbook gains a trial watermark sheet; find the sheet
    // that actually carries our data by probing a known cell across sheets.
    const probe = (name) => `const s = sheet(${JSON.stringify(name)})\nreturn { v: s.getValue(0, 0) }`
    let found = false
    for (const name of names) {
      const foundEnvelope = await runWorker({
        op: 'execute', sourcePath: xlsxRoundtrip, workspaceRoot: dir, code: probe(name),
      })
      if (foundEnvelope.ok && foundEnvelope.result.v === 5) { found = true; break }
    }
    assert(found, 'a round-tripped sheet retains A1 = 5')
  })()

  await step('xlsx round-trip csv covers the content range incl. formula value', async () => {
    // Regression: an xlsx round-trip makes the `all` used range report
    // colCount -1; CSV export must bound by data+formula content, never
    // silently degrade to a single cell.
    const roundtripCsv = join(dir, 'roundtrip.csv')
    const envelope = await runWorker({ op: 'export', sourcePath: xlsxRoundtrip, outputPath: roundtripCsv, format: 'csv' })
    assertOk(envelope, 'export csv of roundtrip')
    assert(envelope.result.usedRange !== undefined, 'csv export reports a used range')
    assert(envelope.result.usedRange.rowCount >= 3 && envelope.result.usedRange.columnCount >= 2, `csv range spans content: ${JSON.stringify(envelope.result.usedRange)}`)
    const text = await readFile(roundtripCsv, 'utf8')
    assert(text.includes('named ok'), 'roundtrip csv keeps the B1 text')
    assert(text.includes('12'), 'roundtrip csv carries the formula result (A3 = A1+A2)')
  })()

  await step('export writes a utf-8 csv of the active sheet', async () => {
    const envelope = await runWorker({ op: 'export', sourcePath: workbook, outputPath: csvOut, format: 'csv' })
    assertOk(envelope, 'export csv')
    const text = await readFile(csvOut, 'utf8')
    assert(text.includes('named ok'), 'csv contains the edited cell text')
  })()

  await step('import reads the csv back into a new ssjson', async () => {
    const envelope = await runWorker({ op: 'import', sourcePath: csvOut, targetPath: csvRoundtrip })
    assertOk(envelope, 'import csv')
    assert(Array.isArray(envelope.result.sheets) && envelope.result.sheets.length >= 1, 'import csv produced sheets')
  })()

  await step('import rejects an unsupported source extension', async () => {
    const envelope = await runWorker({ op: 'import', sourcePath: join(dir, 'notes.txt'), targetPath: join(dir, 'nope.ssjson') })
    assertError(envelope, 'SJS_UNSUPPORTED_IMPORT_FORMAT', 'unsupported import format')
  })()

  await step('ssjson export is a byte copy', async () => {
    const ssjsonOut = join(dir, 'copy.ssjson')
    const envelope = await runWorker({ op: 'export', sourcePath: workbook, outputPath: ssjsonOut, format: 'ssjson' })
    assertOk(envelope, 'export ssjson')
    const original = await readFile(workbook)
    const copy = await readFile(ssjsonOut)
    assert(Buffer.compare(original, copy) === 0, 'ssjson export matches source bytes')
  })()

  await step('pdf export produces a PDF with registered fonts', async () => {
    const envelope = await runWorker({ op: 'export', sourcePath: workbook, outputPath: pdfOut, format: 'pdf' })
    // PDF font availability depends on host system fonts; when none exist the
    // worker must fail fast with a guard error instead of an empty shell.
    if (!envelope.ok) {
      assertError(envelope, 'SJS_PDF_FONT_UNAVAILABLE', 'pdf without system fonts guard')
    } else {
      assert(Array.isArray(envelope.result.fonts) && envelope.result.fonts.length >= 1, 'pdf export registered fonts')
      const bytes = await readFile(pdfOut)
      assert(bytes.length > 0, 'pdf has bytes')
      assert(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46, 'pdf starts with %PDF magic')
    }
  })()

  // ---- screenshot (task 5) ----
  const pngOut = join(dir, 'shot.png')
  const pdfSnapshot = join(dir, 'shot.pdf')

  await step('a Date written to a cell renders and survives the xlsx round trip', async () => {
    // The sandbox is a vm realm, so a Date built inside it is not `instanceof Date`
    // for the engine — it used to be stored as serial 0 and render as 1899/12/30,
    // a silently wrong date rather than an error. The engine's own realm Date is
    // injected into the sandbox to prevent that.
    const file = join(dir, 'dates.ssjson')
    const created = await runWorker({ op: 'new', targetPath: file })
    assertOk(created, 'dates workbook created')

    const written = await runWorker({
      op: 'execute',
      sourcePath: file,
      workspaceRoot: dir,
      code: [
        'const s = sheet()',
        'const st = new GC.Spread.Sheets.Style()',
        "st.formatter = 'yyyy/mm/dd'",
        's.setValue(0, 0, new Date(2026, 0, 15))',
        's.setStyle(0, 0, st)',
        'spread.resumeCalcService()',
        'return { isDate: s.getValue(0, 0) instanceof Date, text: s.getText(0, 0) }',
      ].join('\n'),
    })
    assertOk(written, 'date write')
    assert(written.result.isDate === true, 'the engine recognises the written value as a date')
    assert(written.result.text === '2026/01/15', `date renders as written (got ${written.result.text})`)

    const xlsx = join(dir, 'dates.xlsx')
    const exported = await runWorker({ op: 'export', sourcePath: file, outputPath: xlsx, format: 'xlsx' })
    assertOk(exported, 'date xlsx export')
    const back = join(dir, 'dates-back.ssjson')
    const imported = await runWorker({ op: 'import', sourcePath: xlsx, targetPath: back })
    assertOk(imported, 'date xlsx import')

    const readBack = await runWorker({
      op: 'execute',
      sourcePath: back,
      workspaceRoot: dir,
      code: 'const s = sheet(); spread.resumeCalcService(); return { text: s.getText(0, 0), fmt: s.getStyle(0, 0).formatter }',
    })
    assertOk(readBack, 'date read back')
    assert(readBack.result.text === '2026/01/15', `date survives the round trip (got ${readBack.result.text})`)
    assert(readBack.result.fmt === 'yyyy/mm/dd', 'date format survives the round trip')
  })()

  await step('screenshot png rasterizes a CJK active sheet', async () => {
    const prep = [
      'const s = sheet()',
      "s.setColumnWidth(0, 120)",
      "s.setValue(0, 0, '姓名')", "s.setValue(1, 0, '张伟')",
      "s.setValue(0, 1, '部门')", "s.setValue(1, 1, '销售部')",
      "s.setValue(2, 0, '李娜')", "s.setValue(2, 1, '财务部')",
    ].join('\n')
    const prepEnv = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: prep })
    assertOk(prepEnv, 'screenshot prep execute')
    const envelope = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: pngOut, format: 'png' })
    assertOk(envelope, 'screenshot png ok')
    assert(envelope.result.format === 'png', 'png result format')
    assert(typeof envelope.result.width === 'number' && envelope.result.width > 0, `png width ${envelope.result.width}`)
    assert(typeof envelope.result.height === 'number' && envelope.result.height > 0, `png height ${envelope.result.height}`)
    assert(typeof envelope.result.font === 'string' && envelope.result.font.length > 0, 'png reports forced font')
    const bytes = await readFile(pngOut)
    assert(bytes.length > 1000, `png has real pixels (${bytes.length} bytes)`)
    assert(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, 'png starts with PNG magic')
  })()

  await step('screenshot renders a formatted sheet (canvas-constructor regression)', async () => {
    // A number formatter drives SpreadJS text measurement through the canvas
    // constructor globals. When `CanvasRenderingContext2D` was missing, every
    // formatted sheet failed to rasterize — png AND pdf — which is a whole
    // workbook class, not an edge case.
    const prep = [
      'const s = sheet()',
      'for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) s.setValue(r, c, r * 100 + c)',
      'const st = new GC.Spread.Sheets.Style()',
      "st.formatter = '#,##0'",
      's.getRange(1, 0, 2, 3).setStyle(st)',
      'return s.getValue(1, 0)',
    ].join('\n')
    const prepEnv = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: prep })
    assertOk(prepEnv, 'formatter prep execute')

    const formattedPng = join(dir, 'shot-formatted.png')
    const envelope = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: formattedPng, format: 'png' })
    assertOk(envelope, 'png of a formatted sheet renders')
    const bytes = await readFile(formattedPng)
    assert(bytes.length > 1000, `formatted png has real pixels (${bytes.length} bytes)`)
    assert(bytes[0] === 0x89 && bytes[1] === 0x50, 'formatted png starts with PNG magic')

    const formattedPdf = join(dir, 'shot-formatted.pdf')
    const snapshot = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: formattedPdf, format: 'pdf' })
    if (!snapshot.ok) {
      assertError(snapshot, 'SJS_PDF_FONT_UNAVAILABLE', 'formatted pdf without system fonts guard')
    } else {
      const pdf = await readFile(formattedPdf)
      assert(pdf.length > 0 && pdf[0] === 0x25 && pdf[1] === 0x50, 'formatted pdf snapshot starts with %PDF')
    }
  })()

  await step('screenshot covers a chart placed outside the used range', async () => {
    // The shapes+charts packs are runtime dependencies; without them a chart
    // cannot be created at all. And a chart sits at its own coordinates, so a
    // canvas sized to the used cells alone would crop it out of the snapshot.
    const prep = [
      'const s = sheet()',
      "const rows = [['1月', 120], ['2月', 180], ['3月', 150]]",
      "s.setValue(0, 0, '月份'); s.setValue(0, 1, '销量')",
      'rows.forEach((r, i) => { s.setValue(i + 1, 0, r[0]); s.setValue(i + 1, 1, r[1]) })',
      "s.charts.add('c1', GC.Spread.Sheets.Charts.ChartType.columnClustered, 260, 20, 380, 240, 'A1:B4')",
      'return { charts: s.charts.all().length }',
    ].join('\n')
    const prepEnv = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: prep })
    assertOk(prepEnv, 'chart prep execute')
    assert(prepEnv.result.charts === 1, 'chart added to the sheet')

    const chartPng = join(dir, 'shot-chart.png')
    const envelope = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: chartPng, format: 'png' })
    assertOk(envelope, 'png of a sheet carrying a chart renders')
    assert(envelope.result.width >= 600, `png covers the chart's right edge (width ${envelope.result.width})`)
  })()

  await step('screenshot covers a pivot sheet whose slicer sits past the viewport', async () => {
    // The pivot add-on and slicers packs must both be present, and a pivot
    // layout sheet has no used cell range of its own — so the canvas has to
    // grow to the floating objects instead of falling back to a fixed viewport
    // that crops them.
    const prep = [
      'const d = sheet()',
      "d.name('DataSource')",
      "d.setArray(0, 0, [['地区', '金额'], ['华东', 100], ['华北', 200], ['华东', 150]])",
      "d.tables.add('tableSales', 0, 0, 4, 2)",
      "spread.addSheet(spread.getSheetCount(), new GC.Spread.Sheets.Worksheet('PivotLayout'))",
      'const layout = spread.getSheet(spread.getSheetCount() - 1)',
      "const pt = layout.pivotTables.add('pt1', 'tableSales', 1, 0, GC.Spread.Pivot.PivotTableLayoutType.outline, GC.Spread.Pivot.PivotTableThemes.medium8)",
      'pt.suspendLayout()',
      "pt.add('地区', '地区', GC.Spread.Pivot.PivotTableFieldType.rowField)",
      "pt.add('金额', '金额', GC.Spread.Pivot.PivotTableFieldType.valueField, GC.Pivot.SubtotalType.sum)",
      'pt.resumeLayout()',
      "const sl = layout.slicers.add('sl1', 'pt1', '地区', GC.Spread.Sheets.Slicers.SlicerStyles.light1(), GC.Spread.Sheets.Slicers.SlicerType.pivotTable)",
      'sl.position(new GC.Spread.Sheets.Point(1000, 10))',
      'spread.setActiveSheetIndex(spread.getSheetCount() - 1)',
      'return { pivots: layout.pivotTables.all().length, slicers: layout.slicers.all().length }',
    ].join('\n')
    const prepEnv = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: prep })
    assertOk(prepEnv, 'pivot + slicer prep execute')
    assert(prepEnv.result.pivots === 1, 'pivot table created')
    assert(prepEnv.result.slicers === 1, 'slicer created')

    const pivotPng = join(dir, 'shot-pivot.png')
    const envelope = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: pivotPng, format: 'png' })
    assertOk(envelope, 'png of a pivot sheet renders')
    assert(envelope.result.sheet === 'PivotLayout', 'png follows the active sheet')
    assert(envelope.result.width >= 1100, `png covers the slicer past the default viewport (width ${envelope.result.width})`)
  })()

  await step('a large auto-grown write stays inside the operation budget', async () => {
    // Growing by one row per written row made a 20k-row write take ~74s, past
    // the 60s operation budget. The bound is deliberately loose — it only has to
    // catch a return to per-row resizing, not to measure performance.
    const file = join(dir, 'bulk.ssjson')
    const created = await runWorker({ op: 'new', targetPath: file })
    assertOk(created, 'bulk workbook created')
    const started = Date.now()
    const envelope = await runWorker({
      op: 'execute',
      sourcePath: file,
      workspaceRoot: dir,
      code: [
        'const s = sheet()',
        'for (let i = 0; i < 20000; i++) { s.setValue(i, 0, i); s.setValue(i, 1, "名称" + i) }',
        's.setFormula(20000, 0, "=SUM(A1:A20000)")',
        // The engine batches the whole script (paint, events AND calculation), so
        // a formula read mid-batch returns null. Resuming first is the documented
        // way to verify inside a script, and this asserts the values really are
        // there rather than merely that the write did not throw.
        'spread.resumeCalcService()',
        'return { rows: s.getRowCount(), sum: s.getValue(20000, 0) }',
      ].join('\n'),
    })
    const elapsed = Date.now() - started
    assertOk(envelope, 'bulk write succeeds')
    assert(envelope.result.rows >= 20000, `sheet grew to hold the rows (${envelope.result.rows})`)
    assert(envelope.result.sum === (19999 * 20000) / 2, `a formula set in a batched script reads back correctly (${envelope.result.sum})`)
    assert(elapsed < 50_000, `20k-row write finished in ${elapsed}ms (budget 60000ms)`)
  })()

  await step('screenshot measures content exactly and clips past the raster ceiling', async () => {
    // Content size comes from the model (column widths / row heights + headers),
    // so a sheet larger than any probe viewport still measures. Past the ceiling
    // the shot clips with a flag instead of failing outright.
    const book = join(dir, 'measure.ssjson')
    const newEnv = await runWorker({ op: 'new', targetPath: book })
    assertOk(newEnv, 'measure workbook created')

    // Ask the engine for the width the model implies, then require the render to
    // agree — the two must not drift.
    const measure = [
      'const s = sheet()',
      'for (let c = 0; c < 10; c++) { s.setColumnWidth(c, 150); s.setValue(0, c, "列" + c) }',
      'const used = s.getUsedRange(GC.Spread.Sheets.UsedRangeType.data | GC.Spread.Sheets.UsedRangeType.formula)',
      'let w = 0',
      'for (let c = used.col; c < used.col + used.colCount; c++) w += s.getColumnWidth(c)',
      'return { content: s.getColumnWidth(0, GC.Spread.Sheets.SheetArea.rowHeader) + w }',
    ].join('\n')
    const measured = await runWorker({ op: 'execute', sourcePath: book, workspaceRoot: dir, code: measure })
    assertOk(measured, 'measure execute')

    const exact = await runWorker({ op: 'screenshot', sourcePath: book, outputPath: join(dir, 'exact.png'), format: 'png' })
    assertOk(exact, 'exact-size png renders')
    assert(exact.result.clipped === undefined, 'an in-budget sheet is not flagged clipped')
    // The fitted host adds the 8px pad; the canvas is the host minus a scrollbar.
    assert(
      exact.result.width === measured.result.content + 8,
      `render width ${exact.result.width} matches the measured ${measured.result.content}`,
    )

    const grow = [
      'const s = sheet()',
      'for (let c = 10; c < 40; c++) { s.setColumnWidth(c, 150); s.setValue(0, c, "宽" + c) }',
      'for (let r = 1; r < 300; r++) s.setValue(r, 0, "行" + r)',
      'return "ok"',
    ].join('\n')
    const grown = await runWorker({ op: 'execute', sourcePath: book, workspaceRoot: dir, code: grow })
    assertOk(grown, 'oversize prep execute')

    const clipped = await runWorker({ op: 'screenshot', sourcePath: book, outputPath: join(dir, 'clipped.png'), format: 'png' })
    assertOk(clipped, 'an oversize sheet still renders')
    assert(clipped.result.clipped === true, 'oversize sheet is flagged clipped')
    assert(clipped.result.width <= 2600, `clipped width stays in budget (${clipped.result.width})`)
    assert(clipped.result.height <= 2200, `clipped height stays in budget (${clipped.result.height})`)
  })()

  await step('screenshot pdf snapshot writes a %PDF file', async () => {
    const envelope = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: pdfSnapshot, format: 'pdf' })
    if (!envelope.ok) {
      assertError(envelope, 'SJS_PDF_FONT_UNAVAILABLE', 'pdf screenshot without fonts guard')
    } else {
      const bytes = await readFile(pdfSnapshot)
      assert(bytes.length > 0 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46, 'pdf snapshot starts with %PDF')
    }
  })()

  await step('screenshot of a missing file classifies as read failure', async () => {
    const envelope = await runWorker({ op: 'screenshot', sourcePath: join(dir, 'missing.ssjson'), outputPath: join(dir, 'x.png'), format: 'png' })
    assertError(envelope, 'SJS_FILE_READ_FAILED', 'screenshot missing file')
  })()

  // ---- engine lifecycle (stage 2) ----
  //
  // Everything above ran against ONE engine that survived ~30 operations,
  // including several classified failures. That is itself the assertion that a
  // bad operation does not poison the engine: nothing here would have reached
  // this point if a failed request had taken the browser down.
  await step('the engine still answers after every failure above', async () => {
    const envelope = await runWorker({ op: 'status', sourcePath: workbook })
    assertOk(envelope, 'status after the failure sequence')
    assert(Array.isArray(envelope.result.sheets), 'status still describes the workbook')
    assert(engine.violations().length === 0, `stdout carried non-envelope lines: ${JSON.stringify(engine.violations())}`)
  })()

  await step('an idle engine keeps no page loaded (no stray browser window)', async () => {
    // A page that outlives its operation is a window that outlives it: the page
    // is titled `sjs-runtime`, so a leaked page shows up in the shell's window
    // list (invisible, and unresponsive to a close click — it is not really
    // there to click). Asserted from OUTSIDE the engine, because that is how the
    // defect was reported.
    let windows = pageWindowCount()
    if (windows === null) {
      console.log('        (skipped: window enumeration is Windows-only)')
      return
    }
    // Polled briefly: window teardown is asynchronous, but a LEAKED page is
    // permanent, so a short grace period cannot turn a failure into a pass.
    for (let attempt = 0; attempt < 10 && windows > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      windows = pageWindowCount() ?? 0
    }
    assert(windows === 0, `${String(windows)} operation page(s) are still loaded while the engine is idle`)
  })()

  await step('an idle engine shuts its browser down and exits', async () => {
    // A warm browser left behind by a host that has stopped asking is a leak: a
    // browser is 14-15 processes and 150-250 MB, per DSH process, forever.
    const idle = createHarness({ idleMs: 1500 })
    const created = await idle.runWorker({ op: 'new', targetPath: join(dir, 'idle.ssjson') })
    assert(created.ok === true, `idle engine could not create a workbook: ${JSON.stringify(created)}`)
    const exited = await idle.engine.waitForExit(30_000)
    assert(exited !== 'timeout', 'the engine was still running 30s after its last request (idle timeout never fired)')
    assert(exited.code === 0, `the idle engine exited with code ${String(exited.code)} and stderr: ${idle.stderr().slice(-400)}`)
    assert(idle.stderr().includes('engine shutting down (idle)'), 'the engine did not report an idle shutdown')
  })()

  await step('no browser of ours outlives its engine', async () => {
    // Measured, not assumed: the browser is a direct child of the engine, so it
    // dies with it in every mode (killed, detached, crashed). This is the check
    // that would catch a regression to a detached or shell-launched browser.
    await engine.close()
    if (browsersBefore === null) {
      console.log('        (skipped: orphan detection is Windows-only)')
      return
    }
    // Killing the engine is the abrupt path — nothing gets to close the browser
    // politely — so this is the strongest form of the check. A moment's grace:
    // process teardown is asynchronous even when the chain is intact.
    let after = browserProcessCount() ?? 0
    for (let attempt = 0; attempt < 20 && after > browsersBefore; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      after = browserProcessCount() ?? 0
    }
    assert(
      after <= browsersBefore,
      `${String(after - browsersBefore)} browser process(es) with the throwaway profile prefix outlived their engine (was ${String(browsersBefore)} before the run, ${String(after)} after)`,
    )
  })()

  await rm(dir, { recursive: true, force: true })
  if (failures > 0) {
    console.error(`\nworker-smoke: ${failures} failing step(s)`)
    process.exitCode = 1
  } else {
    console.log('worker-smoke: all steps passed')
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
