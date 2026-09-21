// Verify the BYTES an export produces, with readers that share no code with the
// code that wrote them.
//
// Why this exists as a separate suite, next to worker-smoke/tool-smoke:
//
//   worker-smoke validates an exported .xlsx by zip magic (`bytes[0] === 0x50 &&
//   bytes[1] === 0x4b`), a .pdf by `%PDF` plus "fonts were registered", and a .png
//   by `PNG` magic plus `bytes.length > 1000`. Every one of those passes on a file
//   that is structurally corrupt, content-wrong, or blank: a zipped file whose
//   entries do not inflate, a HOLLOW PDF (fonts named but no font file embedded, so
//   every CJK glyph was silently dropped — a failure this project actually hit), and
//   a uniform white frame all sail through.
//
//   So this suite re-reads the written bytes with readers that import NOTHING from
//   src/, lib/, artifacts/ or any @grapecity-software package. That independence is
//   the entire point, and it is the thing a future maintainer would otherwise delete
//   as duplication: a verifier that shares code with the writer cannot detect that
//   the writer is wrong, because the same misunderstanding sits on both sides. These
//   readers are dependency-free (node builtins only) and live in test/lib/, ported
//   from the browser spike's scratch readers when that directory was retired.
//
// The engine is driven exactly as worker-smoke drives it — start
// artifacts/sjs-worker.mjs once, then send newline-delimited `{id, request}`
// frames and read one `{id, ok, result|error}` envelope per request. DSH is
// never booted and the tool layer is never used: the bytes come from the
// engine, so the engine is the thing to test.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectXlsx } from './lib/xlsx.mjs'
import { decodePng, pngStats, inkRows } from './lib/png.mjs'
import { inspectPdf } from './lib/pdf.mjs'
import { createHarness } from './lib/engine.mjs'

const SHEET = '销售明细'
const CJK_HEADER = '订单号'
const NUM_FMT = '#,##0.000'
/** The rows written through `execute`; the formulas below are derived from them. */
const ROWS = [
  ['订单-2026-001', 499, 2],
  ['订单-2026-002', 1280, 3],
  ['订单-2026-003', 75.5, 12],
  ['订单-2026-004', 3200, 1],
  ['订单-2026-005', 640, 5],
  ['订单-2026-006', 98, 30],
  ['订单-2026-007', 1750, 2],
  ['订单-2026-008', 410, 7],
]
const LAST_DATA_ROW = ROWS.length + 1 // 1-based sheet row of the last data row (header is row 1)
const TOTAL_ROW = LAST_DATA_ROW + 1 // …and the 合计 row sits below it
const TOTAL_ROW0 = TOTAL_ROW - 1 // the same row, zero-based, as `execute` addresses cells
const TOTAL = ROWS.reduce((sum, [, price, qty]) => sum + price * qty, 0)
const FIRST_PRODUCT = ROWS[0][1] * ROWS[0][2]
/** What `#,##0.000` should render a value as — derived here, never read back. */
const rendered = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })

const engine = createHarness()
const runWorker = engine.runWorker

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

function assertOk(envelope, message) {
  assert(envelope.ok === true, `${message}: expected ok envelope, got ${JSON.stringify(envelope)}`)
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

/**
 * Pick a font family the PDF backend has actually registered, preferring a
 * CJK-capable one. The host decides which families exist (C:\Windows\Fonts here,
 * DejaVu on the CI runner), and the PDF writer embeds a font ONLY for a family
 * registered in PDFFontsManager — anything else is silently dropped. Naming a
 * family the host happens to have is what makes this test assert the same thing
 * on every platform.
 */
function pickFamily(fonts) {
  const cjkMarkers = ['simhei', 'simkai', 'simfang', 'msyh', 'simsun', 'notosanscjk', 'droidsansfallback', 'arphic', 'wqy']
  return fonts.find((f) => cjkMarkers.some((m) => f.toLowerCase().includes(m))) ?? fonts[0]
}

const run = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sjs-integrity-'))
  const workbook = join(dir, 'ledger.ssjson')
  const xlsxOut = join(dir, 'ledger.xlsx')
  const pdfOut = join(dir, 'ledger.pdf')
  const pngOut = join(dir, 'ledger.png')
  console.log('export integrity (independent byte-level verification)')

  // Every value asserted against the bytes is captured from the run that produced
  // them — a mismatch between what the worker SAID and what the bytes SAY is
  // exactly the class of bug this suite exists to catch.
  let xlsx = null
  let pdfShot = null
  let pngShot = null

  await step('new creates the workbook that is exported', async () => {
    const envelope = await runWorker({ op: 'new', targetPath: workbook })
    assertOk(envelope, 'new')
  })()

  await step('execute builds the data sheet (CJK, formulas, number format)', async () => {
    const code = [
      'const s = sheet()',
      `s.name(${JSON.stringify(SHEET)})`,
      `s.setValue(0, 0, ${JSON.stringify(CJK_HEADER)}); s.setValue(0, 1, '单价'); s.setValue(0, 2, '销量'); s.setValue(0, 3, '销售额')`,
      's.setColumnWidth(0, 150); s.setColumnWidth(3, 110)',
      `const rows = ${JSON.stringify(ROWS)}`,
      'for (let i = 0; i < rows.length; i++) {',
      '  s.setValue(i + 1, 0, rows[i][0])',
      '  s.setValue(i + 1, 1, rows[i][1])',
      '  s.setValue(i + 1, 2, rows[i][2])',
      '  s.setFormula(i + 1, 3, "=B" + (i + 2) + "*C" + (i + 2))',
      '}',
      `s.setValue(${TOTAL_ROW0}, 0, '合计')`,
      `s.setFormula(${TOTAL_ROW0}, 3, '=SUM(D2:D${LAST_DATA_ROW})')`,
      'const st = new GC.Spread.Sheets.Style()',
      `st.formatter = ${JSON.stringify(NUM_FMT)}`,
      `s.getRange(1, 3, ${ROWS.length}, 1).setStyle(st)`,
      // The engine batches a script (paint, events AND calculation), so a formula
      // read mid-batch returns null; resuming first is the documented way to read
      // values inside a script.
      'spread.resumeCalcService()',
      `return { sheet: s.name(), header: s.getValue(0, 0), first: s.getValue(1, 3), total: s.getValue(${TOTAL_ROW0}, 3),`,
      '         text: s.getText(1, 3), fmt: s.getStyle(1, 3).formatter }',
    ].join('\n')
    const envelope = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code })
    assertOk(envelope, 'build execute')
    const built = envelope.result
    assert(built.sheet === SHEET, `sheet renamed (got ${built.sheet})`)
    assert(built.header === CJK_HEADER, `CJK header written (got ${built.header})`)
    assert(built.first === FIRST_PRODUCT, `D2 = ${FIRST_PRODUCT} (got ${built.first})`)
    assert(built.total === TOTAL, `total = ${TOTAL} (got ${built.total})`)
    assert(built.text === rendered(FIRST_PRODUCT), `number format renders on write (got ${built.text})`)
    assert(built.fmt === NUM_FMT, `formatter set (got ${built.fmt})`)
  })()

  await step('export writes the .xlsx', async () => {
    const envelope = await runWorker({ op: 'export', sourcePath: workbook, outputPath: xlsxOut, format: 'xlsx' })
    assertOk(envelope, 'export xlsx')
    assert(envelope.result.bytes > 0, 'export reports bytes')
  })()

  await step('every zip entry inflates and matches its CRC-32 and size', async () => {
    xlsx = inspectXlsx(await readFile(xlsxOut))
    assert(xlsx.entryCount === xlsx.entries.length, `central directory count ${xlsx.entryCount} vs ${xlsx.entries.length} names`)
    assert(xlsx.crcFailures.length === 0, `entries failing inflate/CRC-32/size: ${JSON.stringify(xlsx.crcFailures)}`)
    assert(xlsx.totalUncompressed > 0, 'entries decompress to real content')
    console.log(`        ${xlsx.bytes} bytes, ${xlsx.entryCount} entries, ${xlsx.totalUncompressed} uncompressed`)
  })()

  await step('required parts are present and the data sheet resolves by name', async () => {
    assert(xlsx !== null, 'the xlsx could not be inspected (an earlier step failed)')
    assert(xlsx.missing.length === 0, `missing required parts: ${JSON.stringify(xlsx.missing)}`)
    assert(xlsx.sheetNames.includes(SHEET), `sheets ${JSON.stringify(xlsx.sheetNames)} do not include ${SHEET}`)
    // Not just present in workbook.xml: the name must resolve to a real worksheet
    // part through the relationship, which is what importing it back depends on.
    const sheet = xlsx.sheet(SHEET)
    assert(sheet !== null && sheet.count > 0, 'the named sheet resolved to a populated worksheet part')
    console.log(`        sheets: ${JSON.stringify(xlsx.sheetNames)} (${sheet.part}, ${sheet.count} cells)`)
  })()

  await step('the CJK string comes back byte-exact from the sheet XML', async () => {
    assert(xlsx !== null, 'the xlsx could not be inspected (an earlier step failed)')
    const a1 = xlsx.get('A1', SHEET)
    const a2 = xlsx.get('A2', SHEET)
    assert(a1?.value === CJK_HEADER, `A1 shared string (got ${JSON.stringify(a1)})`)
    assert(a2?.value === ROWS[0][0], `A2 shared string (got ${JSON.stringify(a2)})`)
    assert(xlsx.sharedStringCount >= ROWS.length, `shared string table holds the CJK values (${xlsx.sharedStringCount})`)
  })()

  await step('the formula and its cached computed value are both in the XML', async () => {
    assert(xlsx !== null, 'the xlsx could not be inspected (an earlier step failed)')
    const d2 = xlsx.get('D2', SHEET)
    const total = xlsx.get(`D${TOTAL_ROW}`, SHEET)
    const norm = (s) => (s ?? '').replace(/\s+/g, '').toUpperCase()
    assert(norm(d2?.formula) === 'B2*C2', `D2 formula (got ${JSON.stringify(d2?.formula)})`)
    assert(d2?.value === FIRST_PRODUCT, `D2 cached value ${FIRST_PRODUCT} (got ${JSON.stringify(d2?.raw)})`)
    assert(norm(total?.formula) === `SUM(D2:D${LAST_DATA_ROW})`, `total formula (got ${JSON.stringify(total?.formula)})`)
    // A formula cell with no cached value would make the file show 0 in Excel
    // until it recalculates; the value must be written, not merely computed here.
    assert(total?.value === TOTAL, `total cached value ${TOTAL} (got ${JSON.stringify(total?.raw)})`)
  })()

  await step('the number format survives into styles.xml and resolves for its cell', async () => {
    assert(xlsx !== null, 'the xlsx could not be inspected (an earlier step failed)')
    const d2 = xlsx.get('D2', SHEET)
    assert(d2?.styleId !== undefined, 'D2 carries a style index')
    // The format code is not on the cell: the cell points at a cellXfs entry,
    // which points at a numFmt. Assert the whole chain, not a substring of the file.
    assert(
      d2.numberFormat === NUM_FMT,
      `D2 resolves to ${JSON.stringify(NUM_FMT)} through cellXfs[${d2.styleId}] (got ${JSON.stringify(d2.numberFormat)})`,
    )
    assert(
      [...xlsx.customNumFmts.values()].includes(NUM_FMT),
      `a custom numFmt carries ${JSON.stringify(NUM_FMT)} (got ${JSON.stringify([...xlsx.customNumFmts])})`,
    )
  })()

  await step('export -> import back preserves the cell, the formula value and the format', async () => {
    const back = join(dir, 'back.ssjson')
    const imported = await runWorker({ op: 'import', sourcePath: xlsxOut, targetPath: back })
    assertOk(imported, 'import the exported xlsx back')
    const code = [
      `const s = sheet(${JSON.stringify(SHEET)})`,
      'spread.resumeCalcService()',
      `return { header: s.getValue(0, 0), first: s.getValue(1, 3), total: s.getValue(${TOTAL_ROW0}, 3),`,
      '         text: s.getText(1, 3), fmt: s.getStyle(1, 3).formatter }',
    ].join('\n')
    const envelope = await runWorker({ op: 'execute', sourcePath: back, workspaceRoot: dir, code })
    assertOk(envelope, 'read the round-tripped workbook')
    const value = envelope.result
    assert(value.header === CJK_HEADER, `edited CJK cell survived (got ${JSON.stringify(value.header)})`)
    assert(value.first === FIRST_PRODUCT, `formula value survived (got ${JSON.stringify(value.first)})`)
    assert(value.total === TOTAL, `total formula survived (got ${JSON.stringify(value.total)})`)
    assert(value.fmt === NUM_FMT, `number format survived (got ${JSON.stringify(value.fmt)})`)
    assert(value.text === rendered(FIRST_PRODUCT), `format still renders after the round trip (got ${JSON.stringify(value.text)})`)
  })()

  await step('the host has an embeddable font to verify the PDF against', async () => {
    // Pre-flight: learn which font families the PDF backend can embed, then point
    // the sheet at one of them. Without this the sheet's default family (Calibri)
    // is unregistered on a host that has no Calibri, the writer drops every glyph,
    // and the test would report a hollow PDF for a reason that is not the plugin's.
    const envelope = await runWorker({ op: 'export', sourcePath: workbook, outputPath: join(dir, 'preflight.pdf'), format: 'pdf' })
    if (envelope.ok !== true) {
      assert(
        envelope.error?.code !== 'SJS_PDF_FONT_UNAVAILABLE',
        'no embeddable .ttf/.otf on this host, so an embedded-font assertion cannot be made — install a CJK-capable .ttf (not .ttc) or point GC_SJS_PDF_FONT_DIRS at one',
      )
      assert(false, `pdf pre-flight failed: ${JSON.stringify(envelope.error)}`)
    }
    const fonts = envelope.result.fonts ?? []
    assert(fonts.length > 0, 'the PDF backend registered at least one family')
    const family = pickFamily(fonts)
    const code = [
      'const s = sheet()',
      `s.getRange(0, 0, ${TOTAL_ROW}, 4).fontFamily(${JSON.stringify(family)})`,
      `return s.getStyle(0, 0).fontFamily ?? ${JSON.stringify(family)}`,
    ].join('\n')
    const applied = await runWorker({ op: 'execute', sourcePath: workbook, workspaceRoot: dir, code })
    assertOk(applied, `set the sheet font to ${family}`)
    console.log(`        ${fonts.length} families registered; using ${JSON.stringify(family)}`)
  })()

  await step('pdf: a font file is EMBEDDED, not merely named', async () => {
    const envelope = await runWorker({ op: 'export', sourcePath: workbook, outputPath: pdfOut, format: 'pdf' }, { timeoutMs: 120_000 })
    assertOk(envelope, 'export pdf')
    pdfShot = envelope.result
    const pdf = inspectPdf(await readFile(pdfOut))
    console.log(`        ${pdf.bytes} bytes, BaseFont=${JSON.stringify(pdf.baseFonts)}, font programs=${JSON.stringify(pdf.fontFiles)}`)
    assert(pdf.header === '%PDF-', `PDF header (got ${JSON.stringify(pdf.header)})`)
    // A /BaseFont name proves nothing — /Times-Roman is a legal name with no file
    // behind it, and that is exactly what the hollow PDF carried. Note this is the
    // assertion that catches a hollow shell, NOT the glyph count below: the real
    // hollow export measured 493 text operators and 1315 glyph codes on an empty
    // page, so "the content stream has text operators" is satisfied by the frame
    // the writer draws around nothing.
    assert(pdf.embedded, 'the PDF carries a FontFile2/FontFile3 stream')
    assert(
      pdf.largestFontProgram > 1024,
      `the embedded font program is not a stub (largest ${pdf.largestFontProgram} bytes)`,
    )
    // An embedded font is written as a subset, named `ABCDEF+Family`; the `+` can
    // only appear when a real font program was embedded.
    assert(pdf.subsetPrefixed.length > 0, `a subset-prefixed BaseFont (got ${JSON.stringify(pdf.baseFonts)})`)
    assert(
      (pdfShot.fonts ?? []).length > 0,
      `the envelope reports registered families (got ${JSON.stringify(pdfShot.fonts)})`,
    )
  })()

  await step('pdf: the content stream carries real text, not an empty page skeleton', async () => {
    assert(pdfShot !== null, 'the pdf could not be inspected (an earlier step failed)')
    const pdf = inspectPdf(await readFile(pdfOut))
    console.log(`        ${pdf.textBlocks} BT blocks, ${pdf.textOperators} text operators, ${pdf.glyphCodes} glyph codes, ${pdf.contentStreamChars} content chars`)
    assert(pdf.textOperators > 0, `text-showing operators present (got ${pdf.textOperators})`)
    assert(pdf.glyphCodes > 100, `glyph codes present (got ${pdf.glyphCodes})`)
  })()

  await step('png: real ink, not a blank or uniform frame', async () => {
    const envelope = await runWorker({ op: 'screenshot', sourcePath: workbook, outputPath: pngOut, format: 'png' }, { timeoutMs: 120_000 })
    assertOk(envelope, 'screenshot png')
    pngShot = envelope.result
    const png = decodePng(await readFile(pngOut))
    const stats = pngStats(png)
    console.log(`        ${png.width}x${png.height}, distinctColors=${stats.distinctColors}, nonWhite=${stats.nonWhiteFraction}, meanLuminance=${stats.meanLuminance}`)
    console.log(`        ink per band: ${inkRows(png).join(',')}`)
    assert(!stats.uniform, `the image is not a uniform fill (${stats.distinctColors} distinct colours)`)
    assert(stats.nonWhiteFraction > 0.01, `a meaningful fraction of non-white pixels (got ${stats.nonWhiteFraction})`)
    assert(inkRows(png).some((dark) => dark > 0), 'at least one band has dark pixels (text or gridlines were rasterized)')
  })()

  await step('png: the image is the size the worker reported, at its render scale', async () => {
    assert(pngShot !== null, 'the png could not be inspected (an earlier step failed)')
    const png = decodePng(await readFile(pngOut))
    // The image carries the backing-store pixels (CSS size x scale) — that is the
    // resolution the screenshot is FOR. `width`/`height` are the CSS numbers the
    // caller measures columns against, so they are not the image's size any more,
    // and asserting the two are equal would now be asserting the image is soft.
    assert(
      png.width === pngShot.pixels.width && png.height === pngShot.pixels.height,
      `IHDR ${png.width}x${png.height} vs reported pixels ${pngShot.pixels.width}x${pngShot.pixels.height}`,
    )
    // And the two views of the same render must agree with each other.
    assert(pngShot.scale >= 2, `the render is at scale ${pngShot.scale}; 1 is the soft render this replaced`)
    assert(
      Math.round(png.width / pngShot.scale) === pngShot.width &&
        Math.round(png.height / pngShot.scale) === pngShot.height,
      `CSS size ${pngShot.width}x${pngShot.height} is not the pixel size divided by scale ${pngShot.scale}`,
    )
    assert(pngShot.sheet === SHEET, `the render is the data sheet (got ${pngShot.sheet})`)
  })()

  await engine.close()
  await rm(dir, { recursive: true, force: true })
  if (failures > 0) {
    console.error(`\nexport-integrity: ${failures} failing step(s)`)
    process.exitCode = 1
  } else {
    console.log('export-integrity: all steps passed')
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
