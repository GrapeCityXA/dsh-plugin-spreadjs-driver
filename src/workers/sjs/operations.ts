/**
 * SpreadJS worker operations (new / status / execute). Runs inside the one-shot
 * worker process after `loadSpreadJS()` has booted the headless environment.
 *
 * Execution sandbox: user code runs in a `node:vm` context with only
 * spreadsheet handles and whitelisted helpers in scope — no `require`, `process`
 * or `fs`. This is hygiene, not a security boundary: the real isolation is the
 * one-shot OS process plus host-side workspace authorization.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { basenameWithoutExtension, errorMessage } from './util.ts'
import type { JsonValue, SjsWorkerRequest } from '../../shared/protocol.ts'
import { SjsWorkerError } from './errors.ts'
import { discoverPdfFonts, registerPdfFonts } from './fonts.ts'
import { loadSpreadJS } from './headless.ts'
import { renderWorkbookToPng } from './render-png.ts'

// SpreadJS types are not declared in this package; the headless environment is
// typed loosely at the worker boundary. Every GC/spread access below mirrors the
// phase-0 spike probes.
type Gc = any
type Workbook = any

/** Perform one worker request and return its structured JSON result. */
export async function runOperation(request: SjsWorkerRequest): Promise<JsonValue> {
  switch (request.op) {
    case 'new':
      return runNew(request.targetPath)
    case 'status':
      return runStatus(request.sourcePath)
    case 'execute':
      return runExecute(request)
    case 'import':
      return runImport(request)
    case 'export':
      return runExport(request)
    case 'screenshot':
      return runScreenshot(request)
    default: {
      const op = (request as { op?: string }).op ?? '?'
      throw new SjsWorkerError(`operation not implemented yet: ${op}`, 'SJS_OP_NOT_IMPLEMENTED')
    }
  }
}

async function runNew(targetPath: string): Promise<JsonValue> {
  const { GC } = loadSpreadJS()
  const spread: Workbook = new GC.Spread.Sheets.Workbook()
  const active = spread.getActiveSheet()
  if (active === null || active === undefined) spread.addSheet(0)
  await persistSpread(targetPath, spread)
  return { created: true, file: targetPath }
}

async function runStatus(sourcePath: string): Promise<JsonValue> {
  const { GC } = loadSpreadJS()
  const spread = await loadSpread(sourcePath, GC)
  try {
    return summarizeSpread(spread, GC) as unknown as JsonValue
  } finally {
    destroySpread(spread)
  }
}

async function runExecute(request: Extract<SjsWorkerRequest, { op: 'execute' }>): Promise<JsonValue> {
  const { GC } = loadSpreadJS()
  const spread = await loadSpread(request.sourcePath, GC)
  try {
    const returned = await runUserCode(request.code, spread, GC, request.workspaceRoot)
    await persistSpread(request.sourcePath, spread)
    const result = await materializeResult(returned, spread, GC)
    return result as unknown as JsonValue
  } catch (error) {
    if (error instanceof SjsWorkerError) throw error
    throw new SjsWorkerError(`script failed: ${errorMessage(error)}`, 'SJS_SCRIPT_ERROR')
  } finally {
    destroySpread(spread)
  }
}

/** File formats this worker accepts as an import source, by file extension. */
type ImportSourceFormat = 'excel' | 'csv' | 'ssjson'

/** Map an import source path's extension to the SpreadJS import format. */
function importFormatForPath(sourcePath: string): ImportSourceFormat | undefined {
  switch (extname(sourcePath).toLowerCase()) {
    case '.xlsx':
    case '.xlsm':
    case '.xltx':
    case '.xltm':
      return 'excel'
    case '.csv':
      return 'csv'
    case '.ssjson':
      return 'ssjson'
    default:
      return undefined
  }
}

/**
 * Import an external workbook file (xlsx / csv / ssjson) into a canonical
 * `.ssjson` target. ssjson is the plugin's lossless workspace format, so every
 * import converges on it. Classifies unknown source extensions up front.
 */
async function runImport(request: Extract<SjsWorkerRequest, { op: 'import' }>): Promise<JsonValue> {
  const { GC } = loadSpreadJS()
  const format = importFormatForPath(request.sourcePath)
  if (format === undefined) {
    throw new SjsWorkerError(
      `unsupported import source: ${request.sourcePath} (expected .xlsx / .csv / .ssjson)`,
      'SJS_UNSUPPORTED_IMPORT_FORMAT',
    )
  }

  if (format === 'ssjson') {
    // Canonical → canonical: load + re-persist, which also validates the JSON.
    const spread = await loadSpread(request.sourcePath, GC)
    try {
      await persistSpread(request.targetPath, spread)
      return { format, file: request.targetPath, ...summarizeSpread(spread, GC) } as unknown as JsonValue
    } finally {
      destroySpread(spread)
    }
  }

  // xlsx / csv: read source bytes and hand them to the io module on a fresh
  // workbook. The headless FileReader realm patch makes blob imports reliable.
  let sourceBytes: Buffer
  try {
    sourceBytes = await readFile(request.sourcePath)
  } catch (error) {
    throw new SjsWorkerError(`cannot read import source: ${errorMessage(error)}`, 'SJS_FILE_READ_FAILED')
  }
  const spread: Workbook = new GC.Spread.Sheets.Workbook()
  try {
    // CSV import lands in the active sheet; make sure a fresh workbook has one
    // (a host-less Workbook may construct with no default sheet).
    if (spread.getActiveSheet() === null || spread.getActiveSheet() === undefined) spread.addSheet(0)
    const fileType = GC.Spread.Sheets.FileType[format]
    await importBlobInto(spread, sourceBytes, fileType)
    await persistSpread(request.targetPath, spread)
    return {
      format,
      file: request.targetPath,
      bytes: sourceBytes.length,
      ...summarizeSpread(spread, GC),
    } as unknown as JsonValue
  } finally {
    destroySpread(spread)
  }
}

/**
 * Export a canonical `.ssjson` workbook to an external file: xlsx, csv, ssjson,
 * or pdf (savePDF + registered fonts). The active sheet drives CSV width (a CSV
 * has no workbook dimension), and PDF export is guarded against producing an
 * empty shell when no embeddable font is available.
 */
async function runExport(request: Extract<SjsWorkerRequest, { op: 'export' }>): Promise<JsonValue> {
  const { GC } = loadSpreadJS()
  const fileType = GC.Spread.Sheets.FileType

  if (request.format === 'ssjson') {
    // Canonical → canonical: a byte copy is exact and cheapest.
    await copyFileAtomic(request.sourcePath, request.outputPath)
    const spread = await loadSpread(request.sourcePath, GC)
    try {
      return { format: request.format, file: request.outputPath, ...summarizeSpread(spread, GC) } as unknown as JsonValue
    } finally {
      destroySpread(spread)
    }
  }

  const spread = await loadSpread(request.sourcePath, GC)
  try {
    if (request.format === 'xlsx') {
      const bytes = await exportToBuffer(spread, { fileType: fileType.excel })
      await writeBytesAtomic(request.outputPath, bytes)
      return {
        format: 'xlsx',
        file: request.outputPath,
        bytes: bytes.length,
        ...summarizeSpread(spread, GC),
      } as unknown as JsonValue
    }

    if (request.format === 'csv') {
      const active = activeSheetOrThrow(spread)
      const used = usedRangeOf(active, GC)
      const options =
        used === undefined
          ? { fileType: fileType.csv, range: { sheetIndex: spread.getActiveSheetIndex(), row: 0, column: 0, rowCount: 1, columnCount: 1 } }
          : { fileType: fileType.csv, range: { ...used, sheetIndex: spread.getActiveSheetIndex() } }
      const bytes = await exportToBuffer(spread, options)
      await writeBytesAtomic(request.outputPath, bytes)
      return {
        format: 'csv',
        file: request.outputPath,
        bytes: bytes.length,
        sheet: active.name(),
        ...(used === undefined ? {} : { usedRange: used }),
      } as unknown as JsonValue
    }

    // pdf — register fonts first; the guard throws SJS_PDF_FONT_UNAVAILABLE
    // rather than let savePDF silently drop unregistered text.
    const fonts = registerPdfFonts(GC, discoverPdfFonts(), (message, code) => new SjsWorkerError(message, code))
    const bytes = await savePdfToBuffer(spread, { title: basenameWithoutExtension(request.outputPath) })
    await writeBytesAtomic(request.outputPath, bytes)
    return { format: 'pdf', file: request.outputPath, bytes: bytes.length, fonts } as unknown as JsonValue
  } finally {
    destroySpread(spread)
  }
}

/**
 * Render a visual snapshot of a canonical .ssjson workbook.
 *
 * format 'png' rasterizes the active sheet through the headless node-canvas
 * backend (constructor-bound hosts, content-fitted canvas, forced CJK font — see
 * render-png.ts). format 'pdf' reuses the PDF/print backend, so a "visual"
 * snapshot is available even before the platform confirms it can present image
 * tool results (task 6). The source file is never written back; the fonts a PNG
 * forces exist only on the in-memory capture workbook.
 */
async function runScreenshot(request: Extract<SjsWorkerRequest, { op: 'screenshot' }>): Promise<JsonValue> {
  if (request.format === 'pdf') return runScreenshotPdf(request.sourcePath, request.outputPath)
  return runScreenshotPng(request.sourcePath, request.outputPath)
}

async function runScreenshotPng(sourcePath: string, outputPath: string): Promise<JsonValue> {
  const { GC, window } = loadSpreadJS()
  const shot = await renderWorkbookToPng({ GC, window }, sourcePath)
  await writeBytesAtomic(outputPath, shot.png)
  return {
    format: 'png',
    file: outputPath,
    bytes: shot.png.length,
    width: shot.width,
    height: shot.height,
    sheet: shot.sheet,
    ...(shot.used === null ? {} : { usedRange: shot.used }),
    font: shot.font,
    ...(shot.clipped ? { clipped: true } : {}),
  } as unknown as JsonValue
}

async function runScreenshotPdf(sourcePath: string, outputPath: string): Promise<JsonValue> {
  const { GC } = loadSpreadJS()
  const spread = await loadSpread(sourcePath, GC)
  try {
    const fonts = registerPdfFonts(GC, discoverPdfFonts(), (message, code) => new SjsWorkerError(message, code))
    const bytes = await savePdfToBuffer(spread, { title: basenameWithoutExtension(outputPath) })
    await writeBytesAtomic(outputPath, bytes)
    return { format: 'pdf', file: outputPath, bytes: bytes.length, fonts } as unknown as JsonValue
  } finally {
    destroySpread(spread)
  }
}

/** Import raw source bytes into a workbook through the io module (blob API). */
async function importBlobInto(spread: Workbook, sourceBytes: Buffer, fileType: unknown): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const blob = new Blob([sourceBytes])
      spread.import(
        blob,
        () => resolve(),
        (error: unknown) => reject(new SjsWorkerError(`spread.import failed: ${ioErrorMessage(error)}`, 'SJS_IMPORT_FAILED')),
        { fileType },
      )
    })
  } catch (error) {
    if (error instanceof SjsWorkerError) throw error
    throw new SjsWorkerError(`spread.import failed: ${errorMessage(error)}`, 'SJS_IMPORT_FAILED')
  }
}

/** Export a workbook to a Node Buffer through the io module (blob API). */
async function exportToBuffer(spread: Workbook, options: Record<string, unknown>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      spread.export(
        (blob: unknown) => {
          if (typeof (blob as { arrayBuffer?: unknown })?.arrayBuffer !== 'function') {
            reject(new SjsWorkerError(`export blob has no arrayBuffer(): ${describeValue(blob)}`, 'SJS_EXPORT_FAILED'))
            return
          }
          ;(blob as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer().then(
            (ab) => resolve(Buffer.from(ab)),
            (error: unknown) => reject(new SjsWorkerError(`export arrayBuffer failed: ${errorMessage(error)}`, 'SJS_EXPORT_FAILED')),
          )
        },
        (error: unknown) => reject(new SjsWorkerError(`spread.export failed: ${ioErrorMessage(error)}`, 'SJS_EXPORT_FAILED')),
        options,
      )
    } catch (error) {
      reject(new SjsWorkerError(`spread.export threw: ${errorMessage(error)}`, 'SJS_EXPORT_FAILED'))
    }
  })
}

/** Best-effort one-line description of a value (for diagnosing blob shapes). */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return `string(${value.length})`
  if (typeof value !== 'object' || value === null) return String(value)
  const ctor = (value as { constructor?: { name?: string } }).constructor
  const keys = Object.keys(value).slice(0, 8).join(',')
  return `${ctor?.name ?? 'object'}{${keys}}`
}

/** Export a workbook to a PDF Buffer via savePDF (fonts must be pre-registered). */
async function savePdfToBuffer(spread: Workbook, options: Record<string, unknown>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      spread.savePDF(
        (blob: { arrayBuffer: () => Promise<ArrayBuffer> }) => {
          blob.arrayBuffer().then((ab) => resolve(Buffer.from(ab)), (error: unknown) => reject(new SjsWorkerError(`pdf arrayBuffer failed: ${errorMessage(error)}`, 'SJS_PDF_EXPORT_FAILED')))
        },
        (error: unknown) => reject(new SjsWorkerError(`savePDF failed: ${ioErrorMessage(error)}`, 'SJS_PDF_EXPORT_FAILED')),
        options,
      )
    } catch (error) {
      reject(new SjsWorkerError(`savePDF threw: ${errorMessage(error)}`, 'SJS_PDF_EXPORT_FAILED'))
    }
  })
}

/** Resolve the active sheet or fail with a clear code. */
function activeSheetOrThrow(spread: Workbook): any {
  const active = spread.getActiveSheet()
  if (active === null || active === undefined) {
    throw new SjsWorkerError('workbook has no active sheet to export', 'SJS_SHEET_NOT_FOUND')
  }
  return active
}

/**
 * Read the content used range (data + formula) of a sheet, or undefined when
 * empty. CSV text comes only from cell values and formula results, so the union
 * of the `data` and `formula` used ranges is the precise bound — the `all`
 * bitmask instead reports colCount -1 on xlsx round-trips (it counts layout
 * extent), which would make a CSV export whole-width or, worse, silently drop
 * to a single cell.
 */
function usedRangeOf(sheet: any, GC: Gc): { row: number; rowCount: number; column: number; columnCount: number } | undefined {
  try {
    const type = GC.Spread.Sheets.UsedRangeType
    const range = sheet.getUsedRange(type.data | type.formula)
    if (range === null || range === undefined) return undefined
    // SpreadJS exposes the origin column as `.col` / `.colCount`, not `.column`.
    const { row, rowCount, col, colCount } = range
    if (typeof row !== 'number' || typeof col !== 'number') return undefined
    // A negative count is SpreadJS's "extends to the end of the sheet" sentinel.
    // Never treat it as an empty range (silent single-cell export); clamp.
    const bounded = (count: number | undefined | null, origin: number, sheetCount: number): number | undefined => {
      const n = typeof count === 'number' && Number.isFinite(count) ? count : NaN
      const span = Number.isNaN(n) || n < 1 ? sheetCount - origin : n
      return span >= 1 ? span : undefined
    }
    const rCount = bounded(rowCount, row, sheet.getRowCount())
    const cCount = bounded(colCount, col, sheet.getColumnCount())
    if (rCount === undefined || cCount === undefined) return undefined
    return { row, rowCount: rCount, column: col, columnCount: cCount }
  } catch {
    return undefined
  }
}

/** Copy a file atomically (temp + rename), classifying write failures. */
async function copyFileAtomic(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.tmp-${process.pid}`
  try {
    await copyFile(sourcePath, tempPath)
    await rename(tempPath, targetPath)
  } catch (error) {
    throw new SjsWorkerError(`cannot write file: ${errorMessage(error)}`, 'SJS_FILE_WRITE_FAILED')
  }
}

/** Write a binary buffer atomically (temp + rename). */
async function writeBytesAtomic(targetPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.tmp-${process.pid}`
  try {
    await writeFile(tempPath, bytes)
    await rename(tempPath, targetPath)
  } catch (error) {
    throw new SjsWorkerError(`cannot write file: ${errorMessage(error)}`, 'SJS_FILE_WRITE_FAILED')
  }
}

/** Extract a readable message from an io-module error argument. */
function ioErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { errorMessage?: unknown; message?: unknown }).errorMessage ?? (error as { message?: unknown }).message
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    const stack = (error as { stack?: unknown }).stack
    if (typeof stack === 'string' && stack.length > 0) return stack
  }
  return errorMessage(error)
}

/** Parse .ssjson text, classifying malformed JSON as SJS_INVALID_SSJSON. */
function parseWorkbookJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new SjsWorkerError(`workbook file is not valid .ssjson JSON: ${errorMessage(error)}`, 'SJS_INVALID_SSJSON')
  }
}

/** Load an .ssjson workbook file into a fresh Workbook instance. */
async function loadSpread(sourcePath: string, GC: Gc): Promise<Workbook> {
  let text: string
  try {
    text = await readFile(sourcePath, 'utf8')
  } catch (error) {
    throw new SjsWorkerError(`cannot read workbook file: ${errorMessage(error)}`, 'SJS_FILE_READ_FAILED')
  }
  const json = parseWorkbookJson(text)
  const spread: Workbook = new GC.Spread.Sheets.Workbook()
  try {
    spread.fromJSON(json)
  } catch (error) {
    destroySpread(spread)
    throw new SjsWorkerError(`cannot parse workbook: ${errorMessage(error)}`, 'SJS_INVALID_SSJSON')
  }
  return spread
}

/** Persist a workbook as .ssjson, atomically (write temp then rename). */
async function persistSpread(targetPath: string, spread: Workbook): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const json = serializeSafe(spread.toJSON())
  const tempPath = `${targetPath}.tmp-${process.pid}`
  try {
    await writeFile(tempPath, JSON.stringify(json), 'utf8')
    await rename(tempPath, targetPath)
  } catch (error) {
    throw new SjsWorkerError(`cannot write workbook file: ${errorMessage(error)}`, 'SJS_FILE_WRITE_FAILED')
  }
}

/** Run user code as an async function body in an isolated vm context. */
/**
 * Guard the Worksheet class against SpreadJS's two silent-data-loss traps.
 *
 * 1. A fresh worksheet is 200 rows x 20 columns, and `setValue`/`setFormula`/
 *    `setArray` beyond those bounds are **silently dropped** — no throw, no
 *    warning, and a read-back of early rows still looks correct. Writing more
 *    rows than the default is ordinary usage, so the guards grow the sheet to
 *    fit the write instead (and throw loudly past the engine's own ceiling,
 *    which stays far better than dropping data).
 * 2. Excel and SpreadJS both reject `: \ / ? * [ ]` in a sheet name, but the
 *    engine reports only "Not supported exception", which a model cannot act
 *    on. The name setter validates up front and names the offending characters.
 *
 * Installed once per worker process, on the prototype, so code that reaches a
 * sheet through `spread.getSheet(i)` is covered as well as the `sheet()` helper.
 */
function installWorksheetGuards(GC: Gc): void {
  const prototype = GC?.Spread?.Sheets?.Worksheet?.prototype
  if (prototype === undefined || prototype === null) return
  if (prototype.__sjsGuardsInstalled === true) return
  try {
    Object.defineProperty(prototype, '__sjsGuardsInstalled', { value: true, enumerable: false })
  } catch {
    // a frozen prototype would defeat the guards entirely; let the write fail loudly
  }

  const MAX_ROWS = 1_048_576
  const MAX_COLUMNS = 16_384
  // Grow past the target so a loop that writes N rows does not call resize once
  // per row: a per-row bump measured ~15x slower than a single upsizing on a
  // 20k-row write, and pushed it past the 60s operation budget.
  const GROWTH_STEP_ROWS = 512
  const GROWTH_STEP_COLUMNS = 64

  const grow = (sheet: any, row: unknown, col: unknown): void => {
    if (typeof row === 'number' && Number.isFinite(row) && row >= 0) {
      const rows = sheet.getRowCount()
      if (row >= rows) {
        if (row >= MAX_ROWS) {
          throw new SjsWorkerError(
            `row ${String(row)} is past the spreadsheet limit of ${String(MAX_ROWS)} rows`,
            'SJS_SHEET_LIMIT_EXCEEDED',
          )
        }
        sheet.setRowCount(nextExtent(rows, row, MAX_ROWS, GROWTH_STEP_ROWS))
      }
    }
    if (typeof col === 'number' && Number.isFinite(col) && col >= 0) {
      const columns = sheet.getColumnCount()
      if (col >= columns) {
        if (col >= MAX_COLUMNS) {
          throw new SjsWorkerError(
            `column ${String(col)} is past the spreadsheet limit of ${String(MAX_COLUMNS)} columns`,
            'SJS_SHEET_LIMIT_EXCEEDED',
          )
        }
        sheet.setColumnCount(nextExtent(columns, col, MAX_COLUMNS, GROWTH_STEP_COLUMNS))
      }
    }
  }

  for (const method of ['setValue', 'setFormula'] as const) {
    const original = prototype[method]
    if (typeof original !== 'function') continue
    prototype[method] = function guarded(this: any, row: unknown, col: unknown, ...rest: unknown[]): unknown {
      grow(this, row, col)
      return original.call(this, row, col, ...rest)
    }
  }

  const originalSetArray = prototype.setArray
  if (typeof originalSetArray === 'function') {
    prototype.setArray = function guardedSetArray(this: any, row: unknown, col: unknown, values: unknown, ...rest: unknown[]): unknown {
      const height = Array.isArray(values) ? values.length : 0
      const width = Array.isArray(values) && Array.isArray(values[0]) ? (values[0] as unknown[]).length : 1
      if (height > 0 && width > 0) {
        grow(this, (typeof row === 'number' ? row : 0) + height - 1, (typeof col === 'number' ? col : 0) + width - 1)
      }
      return originalSetArray.call(this, row, col, values, ...rest)
    }
  }

  const originalName = prototype.name
  if (typeof originalName === 'function') {
    // `name()` is a getter and `name(value)` the setter, told apart by the
    // argument COUNT — so forward the real arguments verbatim. Calling
    // `original.call(this, undefined)` would look like a set-to-undefined and
    // the engine rejects it with "Not supported exception".
    prototype.name = function guardedName(this: any, ...args: unknown[]): unknown {
      if (args.length > 0) assertUsableSheetName(args[0])
      return originalName.apply(this, args)
    }
  }
}

/**
 * Next row/column count to resize to: enough for the requested index, then
 * rounded up to a doubling-or-step boundary so a loop that fills N rows
 * resizes O(log N) times instead of once per row.
 */
function nextExtent(current: number, requested: number, ceiling: number, step: number): number {
  return Math.min(ceiling, Math.max(requested + 1, current * 2, current + step))
}

/** Reject sheet names Excel itself refuses, with a message that says why. */
function assertUsableSheetName(value: unknown): void {
  if (typeof value !== 'string') {
    throw new SjsWorkerError(`sheet name must be a string, got ${typeof value}`, 'SJS_SHEET_NAME_INVALID')
  }
  const illegal = [...new Set([...value].filter((character) => ':\\/?*[]'.includes(character)))]
  if (illegal.length > 0) {
    throw new SjsWorkerError(
      `sheet name ${JSON.stringify(value)} contains character(s) Excel does not allow in a sheet name: ${illegal.join(' ')} (also avoid : \\ / ? * [ ])`,
      'SJS_SHEET_NAME_INVALID',
    )
  }
  if (value.length === 0) {
    throw new SjsWorkerError('sheet name must not be empty', 'SJS_SHEET_NAME_INVALID')
  }
  if (value.length > 31) {
    throw new SjsWorkerError(
      `sheet name ${JSON.stringify(value)} is ${String(value.length)} characters; Excel allows at most 31`,
      'SJS_SHEET_NAME_INVALID',
    )
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    throw new SjsWorkerError(
      `sheet name ${JSON.stringify(value)} must not start or end with an apostrophe`,
      'SJS_SHEET_NAME_INVALID',
    )
  }
}

async function runUserCode(code: string, spread: Workbook, GC: Gc, workspaceRoot: string): Promise<unknown> {
  installWorksheetGuards(GC)
  const sheet = (name?: string): unknown => {
    // Resolve by scanning indices: headless SpreadJS does not register the
    // by-name dictionary on fromJSON, so getSheet(name) returns undefined even
    // for sheets that exist. getActiveSheet() is reliable.
    if (name === undefined || name.length === 0) {
      const active = spread.getActiveSheet()
      if (active !== undefined && active !== null) return active
      throw new SjsWorkerError('workbook has no active sheet', 'SJS_SHEET_NOT_FOUND')
    }
    for (let i = 0; i < spread.getSheetCount(); i++) {
      const candidate = spread.getSheet(i)
      if (candidate !== undefined && candidate !== null && typeof candidate.name === 'function' && candidate.name() === name) {
        return candidate
      }
    }
    throw new SjsWorkerError(`sheet not found: ${JSON.stringify(name)}`, 'SJS_SHEET_NOT_FOUND')
  }
  const context = createContext({
    spread,
    workbook: spread,
    GC,
    sheet,
    io: makeIo(workspaceRoot),
    console: makeConsole(),
    snapshot: () => summarizeSpread(spread, GC),
  })
  const source = `(async () => {\n${code}\n})()`
  let promise: unknown
  try {
    promise = runInContext(source, context)
  } catch (error) {
    throw new SjsWorkerError(`syntax error: ${errorMessage(error)}`, 'SJS_SCRIPT_ERROR')
  }
  if (isPromiseLike(promise)) return await promise
  return promise
}

/** Materialize the code's return value or, when omitted, the workbook summary. */
async function materializeResult(returned: unknown, spread: Workbook, GC: Gc): Promise<unknown> {
  if (returned === undefined) return summarizeSpread(spread, GC)
  const json = serializeSafe(returned)
  const text = JSON.stringify(json)
  if (text.length > 200_000) {
    throw new SjsWorkerError(
      'script returned more than 200_000 characters; return a compact summary or call snapshot()',
      'SJS_RESULT_TOO_LARGE',
    )
  }
  return json
}

/**
 * Model-readable workbook summary (sheet metadata + used ranges). The no-arg
 * getUsedRange() returns null in this headless environment — the enum value must
 * be passed explicitly.
 */
export function summarizeSpread(spread: Workbook, GC: Gc): Record<string, unknown> {
  const sheets: unknown[] = []
  for (let i = 0; i < spread.getSheetCount(); i++) {
    const s = spread.getSheet(i)
    if (s === null || s === undefined) continue
    let used: unknown
    try {
      // Content bound (data + formula), matching what export/CSV treats as the
      // used extent — `all` reports colCount -1 after xlsx round-trips.
      const type = GC.Spread.Sheets.UsedRangeType
      const range = s.getUsedRange(type.data | type.formula)
      used = range !== null && range !== undefined && typeof range === 'object' &&
        typeof range.row === 'number' && typeof range.rowCount === 'number' &&
        typeof range.col === 'number' && typeof range.colCount === 'number'
        ? { row: range.row, rowCount: range.rowCount, col: range.col, colCount: range.colCount }
        : undefined
    } catch {
      used = undefined
    }
    sheets.push({
      name: s.name(),
      rowCount: s.getRowCount(),
      columnCount: s.getColumnCount(),
      ...used === undefined ? {} : { usedRange: used },
    })
  }
  return { sheets, activeSheet: spread.getActiveSheet()?.name() }
}

/** Sandboxed io helper bound to one authorized workspace root. */
function makeIo(workspaceRoot: string) {
  const authorize = (requested: string): string => {
    const candidate = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested)
    const fromRoot = relative(workspaceRoot, candidate)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new SjsWorkerError('file path is outside the session workspace', 'SJS_FILE_PERMISSION_DENIED')
    }
    return candidate
  }
  return {
    async readText(path: string): Promise<string> {
      // Authorization runs first so a workspace escape reports
      // SJS_FILE_PERMISSION_DENIED, not a generic read failure.
      const target = authorize(path)
      try {
        return await readFile(target, 'utf8')
      } catch (error) {
        throw new SjsWorkerError(`cannot read ${path}: ${errorMessage(error)}`, 'SJS_FILE_READ_FAILED')
      }
    },
    async writeText(path: string, text: string): Promise<void> {
      const target = authorize(path)
      try {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, text, 'utf8')
      } catch (error) {
        throw new SjsWorkerError(`cannot write ${path}: ${errorMessage(error)}`, 'SJS_FILE_WRITE_FAILED')
      }
    },
    async readBytes(path: string): Promise<unknown> {
      const target = authorize(path)
      try {
        const buffer = await readFile(target)
        return Array.from(buffer)
      } catch (error) {
        throw new SjsWorkerError(`cannot read ${path}: ${errorMessage(error)}`, 'SJS_FILE_READ_FAILED')
      }
    },
  }
}

/** Console that keeps worker stdout clean (diagnostics go to stderr). */
function makeConsole(): Record<string, (message?: unknown, ...args: unknown[]) => void> {
  const write = (messages: readonly unknown[]): void => {
    process.stderr.write(`${messages.map((m) => format(m)).join(' ')}\n`)
  }
  return {
    log: (message, ...rest) => write([message, ...rest]),
    info: (message, ...rest) => write([message, ...rest]),
    warn: (message, ...rest) => write([message, ...rest]),
    error: (message, ...rest) => write([message, ...rest]),
  }
}

function format(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function serializeSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new SjsWorkerError(
      'value is not JSON-serializable (cyclic or non-plain object); return plain data such as arrays of numbers/strings',
      'SJS_NON_SERIALIZABLE_RESULT',
    )
  }
}

function destroySpread(spread: Workbook): void {
  try {
    spread.destroy()
  } catch {
    // Destroy is best-effort inside a one-shot process.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then: unknown }).then === 'function'
}
