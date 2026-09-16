// Smoke-test the built one-shot worker without booting DSH: spawn the worker
// artifact directly, drive new/status/execute over the envelope protocol, and
// assert the classified error codes. Requires `node scripts/build.mjs` first.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = fileURLToPath(new URL('../artifacts/sjs-worker.mjs', import.meta.url))

/** Send one request and resolve with the parsed envelope. */
function runWorker(request, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`worker timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(stdout).toString('utf8').trim()
      try {
        const envelope = JSON.parse(text)
        resolve({ envelope, exitCode: code, stderr: Buffer.concat(stderr).toString('utf8') })
      } catch {
        reject(new Error(`worker returned non-JSON stdout (exit ${String(code)}): ${text || '(empty)'}\nstderr: ${Buffer.concat(stderr).toString('utf8')}`))
      }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

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
  console.log('spawn worker smoke')

  await step('new creates an empty workbook', async () => {
    const { envelope } = await runWorker({ op: 'new', targetPath: workbook })
    assertOk(envelope, 'new')
    assert(envelope.result.created === true, 'new result.created')
    const info = await stat(workbook)
    assert(info.size > 0, 'workbook file written')
  })()

  let sheetName = null
  await step('status reports sheet metadata', async () => {
    const { envelope } = await runWorker({ op: 'status', sourcePath: workbook })
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
    const { envelope } = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code })
    assertOk(envelope, 'execute')
    assert(envelope.result.a1 === 5 && envelope.result.a2 === 7 && envelope.result.total === 12, 'execute returned computed values')
  })()

  await step('execute addresses a sheet by its discovered name', async () => {
    const code = `const s = sheet(${JSON.stringify(sheetName)})\ns.setValue(0, 1, 'named ok')\nreturn { cell: s.getValue(0, 1) }`
    const { envelope } = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code })
    assertOk(envelope, 'execute by name')
    assert(envelope.result.cell === 'named ok', 'execute by name wrote the cell')
  })()

  await step('status reflects persisted edits', async () => {
    const { envelope } = await runWorker({ op: 'status', sourcePath: workbook })
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
    const { envelope } = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code })
    assertOk(envelope, 'execute with formula')
  })()

  await step('execute classifies a thrown script error', async () => {
    const { envelope } = await runWorker({
      op: 'execute', sourcePath: workbook, workspaceRoot: dir,
      code: 'throw new Error("boom")',
    })
    assertError(envelope, 'SJS_SCRIPT_ERROR', 'script error code')
  })()

  await step('execute rejects a non-serializable return', async () => {
    const { envelope } = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: 'return () => 1' })
    assertError(envelope, 'SJS_NON_SERIALIZABLE_RESULT', 'non-serializable code')
  })()

  await step('execute rejects io escape from the workspace', async () => {
    const { envelope } = await runWorker({
      op: 'execute', sourcePath: workbook, workspaceRoot: dir,
      code: "return await io.readText('../../outside.txt')",
    })
    assertError(envelope, 'SJS_FILE_PERMISSION_DENIED', 'workspace escape')
  })()

  await step('missing file classifies as read failure', async () => {
    const { envelope } = await runWorker({ op: 'status', sourcePath: join(dir, 'missing.ssjson') })
    assertError(envelope, 'SJS_FILE_READ_FAILED', 'missing file')
  })()

  await step('malformed request classifies as bad request', async () => {
    const { envelope } = await runWorker('this is not json')
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
    const { envelope } = await runWorker({ op: 'export', sourcePath: workbook, outputPath: xlsxOut, format: 'xlsx' })
    assertOk(envelope, 'export xlsx')
    assert(envelope.result.bytes > 0, 'export xlsx produced bytes')
    const bytes = await readFile(xlsxOut)
    assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'xlsx starts with PK zip magic')
  })()

  await step('import reads the xlsx back into a new ssjson', async () => {
    const { envelope } = await runWorker({ op: 'import', sourcePath: xlsxOut, targetPath: xlsxRoundtrip })
    assertOk(envelope, 'import xlsx')
    assert(Array.isArray(envelope.result.sheets) && envelope.result.sheets.length >= 1, 'import xlsx produced sheets')
  })()

  await step('xlsx round-trip preserves the edited cell', async () => {
    const { envelope } = await runWorker({ op: 'status', sourcePath: xlsxRoundtrip })
    assertOk(envelope, 'status after xlsx import')
    const names = envelope.result.sheets.map((s) => s.name)
    assert(names.some((n) => typeof n === 'string' && n.length > 0), 'xlsx import exposes sheet names')
    // The round-tripped workbook gains a trial watermark sheet; find the sheet
    // that actually carries our data by probing a known cell across sheets.
    const probe = (name) => `const s = sheet(${JSON.stringify(name)})\nreturn { v: s.getValue(0, 0) }`
    let found = false
    for (const name of names) {
      const { envelope: foundEnvelope } = await runWorker({
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
    const { envelope } = await runWorker({ op: 'export', sourcePath: xlsxRoundtrip, outputPath: roundtripCsv, format: 'csv' })
    assertOk(envelope, 'export csv of roundtrip')
    assert(envelope.result.usedRange !== undefined, 'csv export reports a used range')
    assert(envelope.result.usedRange.rowCount >= 3 && envelope.result.usedRange.columnCount >= 2, `csv range spans content: ${JSON.stringify(envelope.result.usedRange)}`)
    const text = await readFile(roundtripCsv, 'utf8')
    assert(text.includes('named ok'), 'roundtrip csv keeps the B1 text')
    assert(text.includes('12'), 'roundtrip csv carries the formula result (A3 = A1+A2)')
  })()

  await step('export writes a utf-8 csv of the active sheet', async () => {
    const { envelope } = await runWorker({ op: 'export', sourcePath: workbook, outputPath: csvOut, format: 'csv' })
    assertOk(envelope, 'export csv')
    const text = await readFile(csvOut, 'utf8')
    assert(text.includes('named ok'), 'csv contains the edited cell text')
  })()

  await step('import reads the csv back into a new ssjson', async () => {
    const { envelope } = await runWorker({ op: 'import', sourcePath: csvOut, targetPath: csvRoundtrip })
    assertOk(envelope, 'import csv')
    assert(Array.isArray(envelope.result.sheets) && envelope.result.sheets.length >= 1, 'import csv produced sheets')
  })()

  await step('import rejects an unsupported source extension', async () => {
    const { envelope } = await runWorker({ op: 'import', sourcePath: join(dir, 'notes.txt'), targetPath: join(dir, 'nope.ssjson') })
    assertError(envelope, 'SJS_UNSUPPORTED_IMPORT_FORMAT', 'unsupported import format')
  })()

  await step('ssjson export is a byte copy', async () => {
    const ssjsonOut = join(dir, 'copy.ssjson')
    const { envelope } = await runWorker({ op: 'export', sourcePath: workbook, outputPath: ssjsonOut, format: 'ssjson' })
    assertOk(envelope, 'export ssjson')
    const original = await readFile(workbook)
    const copy = await readFile(ssjsonOut)
    assert(Buffer.compare(original, copy) === 0, 'ssjson export matches source bytes')
  })()

  await step('pdf export produces a PDF with registered fonts', async () => {
    const { envelope } = await runWorker({ op: 'export', sourcePath: workbook, outputPath: pdfOut, format: 'pdf' })
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
    assertOk(created.envelope, 'dates workbook created')

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
    assertOk(written.envelope, 'date write')
    assert(written.envelope.result.isDate === true, 'the engine recognises the written value as a date')
    assert(written.envelope.result.text === '2026/01/15', `date renders as written (got ${written.envelope.result.text})`)

    const xlsx = join(dir, 'dates.xlsx')
    const exported = await runWorker({ op: 'export', sourcePath: file, outputPath: xlsx, format: 'xlsx' })
    assertOk(exported.envelope, 'date xlsx export')
    const back = join(dir, 'dates-back.ssjson')
    const imported = await runWorker({ op: 'import', sourcePath: xlsx, targetPath: back })
    assertOk(imported.envelope, 'date xlsx import')

    const readBack = await runWorker({
      op: 'execute',
      sourcePath: back,
      workspaceRoot: dir,
      code: 'const s = sheet(); spread.resumeCalcService(); return { text: s.getText(0, 0), fmt: s.getStyle(0, 0).formatter }',
    })
    assertOk(readBack.envelope, 'date read back')
    assert(readBack.envelope.result.text === '2026/01/15', `date survives the round trip (got ${readBack.envelope.result.text})`)
    assert(readBack.envelope.result.fmt === 'yyyy/mm/dd', 'date format survives the round trip')
  })()

  await step('screenshot png rasterizes a CJK active sheet', async () => {
    const prep = [
      'const s = sheet()',
      "s.setColumnWidth(0, 120)",
      "s.setValue(0, 0, '姓名')", "s.setValue(1, 0, '张伟')",
      "s.setValue(0, 1, '部门')", "s.setValue(1, 1, '销售部')",
      "s.setValue(2, 0, '李娜')", "s.setValue(2, 1, '财务部')",
    ].join('\n')
    const { envelope: prepEnv } = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: prep })
    assertOk(prepEnv, 'screenshot prep execute')
    const { envelope } = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: pngOut, format: 'png' })
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
    const { envelope: prepEnv } = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: prep })
    assertOk(prepEnv, 'formatter prep execute')

    const formattedPng = join(dir, 'shot-formatted.png')
    const { envelope } = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: formattedPng, format: 'png' })
    assertOk(envelope, 'png of a formatted sheet renders')
    const bytes = await readFile(formattedPng)
    assert(bytes.length > 1000, `formatted png has real pixels (${bytes.length} bytes)`)
    assert(bytes[0] === 0x89 && bytes[1] === 0x50, 'formatted png starts with PNG magic')

    const formattedPdf = join(dir, 'shot-formatted.pdf')
    const snapshot = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: formattedPdf, format: 'pdf' })
    if (!snapshot.envelope.ok) {
      assertError(snapshot.envelope, 'SJS_PDF_FONT_UNAVAILABLE', 'formatted pdf without system fonts guard')
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
    const { envelope: prepEnv } = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: prep })
    assertOk(prepEnv, 'chart prep execute')
    assert(prepEnv.result.charts === 1, 'chart added to the sheet')

    const chartPng = join(dir, 'shot-chart.png')
    const { envelope } = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: chartPng, format: 'png' })
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
    const { envelope: prepEnv } = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code: prep })
    assertOk(prepEnv, 'pivot + slicer prep execute')
    assert(prepEnv.result.pivots === 1, 'pivot table created')
    assert(prepEnv.result.slicers === 1, 'slicer created')

    const pivotPng = join(dir, 'shot-pivot.png')
    const { envelope } = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: pivotPng, format: 'png' })
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
    assertOk(created.envelope, 'bulk workbook created')
    const started = Date.now()
    const { envelope } = await runWorker({
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
    assertOk(newEnv.envelope, 'measure workbook created')

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
    assertOk(measured.envelope, 'measure execute')

    const exact = await runWorker({ op: 'screenshot', sourcePath: book, outputPath: join(dir, 'exact.png'), format: 'png' })
    assertOk(exact.envelope, 'exact-size png renders')
    assert(exact.envelope.result.clipped === undefined, 'an in-budget sheet is not flagged clipped')
    // The fitted host adds the 8px pad; the canvas is the host minus a scrollbar.
    assert(
      exact.envelope.result.width === measured.envelope.result.content + 8,
      `render width ${exact.envelope.result.width} matches the measured ${measured.envelope.result.content}`,
    )

    const grow = [
      'const s = sheet()',
      'for (let c = 10; c < 40; c++) { s.setColumnWidth(c, 150); s.setValue(0, c, "宽" + c) }',
      'for (let r = 1; r < 300; r++) s.setValue(r, 0, "行" + r)',
      'return "ok"',
    ].join('\n')
    const grown = await runWorker({ op: 'execute', sourcePath: book, workspaceRoot: dir, code: grow })
    assertOk(grown.envelope, 'oversize prep execute')

    const clipped = await runWorker({ op: 'screenshot', sourcePath: book, outputPath: join(dir, 'clipped.png'), format: 'png' })
    assertOk(clipped.envelope, 'an oversize sheet still renders')
    assert(clipped.envelope.result.clipped === true, 'oversize sheet is flagged clipped')
    assert(clipped.envelope.result.width <= 2600, `clipped width stays in budget (${clipped.envelope.result.width})`)
    assert(clipped.envelope.result.height <= 2200, `clipped height stays in budget (${clipped.envelope.result.height})`)
  })()

  await step('screenshot pdf snapshot writes a %PDF file', async () => {
    const { envelope } = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: pdfSnapshot, format: 'pdf' })
    if (!envelope.ok) {
      assertError(envelope, 'SJS_PDF_FONT_UNAVAILABLE', 'pdf screenshot without fonts guard')
    } else {
      const bytes = await readFile(pdfSnapshot)
      assert(bytes.length > 0 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46, 'pdf snapshot starts with %PDF')
    }
  })()

  await step('screenshot of a missing file classifies as read failure', async () => {
    const { envelope } = await runWorker({ op: 'screenshot', sourcePath: join(dir, 'missing.ssjson'), outputPath: join(dir, 'x.png'), format: 'png' })
    assertError(envelope, 'SJS_FILE_READ_FAILED', 'screenshot missing file')
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
