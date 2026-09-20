/**
 * SpreadJS engine operations (new / status / execute / import / export /
 * screenshot), driven against a real browser.
 *
 * This module is the Node-side half: it owns the request envelope's semantics —
 * which paths mean what, which failure is which code, which write must be atomic
 * — and delegates everything that has to happen inside a browser to
 * `browser/runtime.ts`.
 *
 * The runtime is booted once and kept for the engine process's life; every
 * operation gets a fresh page inside it (see runtime.ts). Nothing about an
 * operation's semantics depends on that: no workbook state is carried between
 * calls, because a call always starts by loading its file into its own page.
 *
 * Two properties survived both runtime swaps unchanged and are load-bearing:
 *
 *  - **Every path arriving here is already authorized by the host.** Nothing in
 *    this file re-derives or widens that decision, and the only paths the page
 *    ever receives are ones this file built a URL for.
 *  - **Every write is temp+rename.** A workbook file that is half written still
 *    parses as JSON, so an interrupted write must never replace the real file.
 *
 * The script sandbox also changed shape: user code now runs as a function inside
 * the page rather than in a `node:vm` context. That was never the security
 * boundary (the OS process plus host-side workspace authorization is), and the
 * workspace confinement of `io.*` is unchanged — it is re-checked Node side on
 * every request the sandbox makes.
 */
import { extname } from 'node:path'
import type { JsonValue, SjsWorkerRequest } from '../../shared/protocol.ts'
import { SjsWorkerError } from './errors.ts'
import { copyFileAtomic } from './files.ts'
import { loadRuntime, type BrowserRuntime } from './browser/runtime.ts'

/** Perform one request and return its structured JSON result. */
export async function runOperation(request: SjsWorkerRequest): Promise<JsonValue> {
  const runtime = await engine()
  try {
    return await dispatch(runtime, request)
  } catch (error) {
    // A failure that came from the browser or the CDP connection leaves the
    // runtime in an unknown state, and the NEXT request would inherit it — the
    // one thing a long-lived engine must never do. Tear it down here; the next
    // request boots a fresh browser. Failures the page classified (a script
    // error, a refused path, a missing file) leave the runtime usable and are
    // re-thrown untouched.
    if (runtimeIsSuspect(error)) await closeRuntime()
    throw error
  }
}

async function dispatch(runtime: BrowserRuntime, request: SjsWorkerRequest): Promise<JsonValue> {
  switch (request.op) {
    case 'new':
      return await runNew(runtime, request.targetPath)
    case 'status':
      return await runStatus(runtime, request.sourcePath)
    case 'execute':
      return await runExecute(runtime, request)
    case 'import':
      return await runImport(runtime, request)
    case 'export':
      return await runExport(runtime, request)
    case 'screenshot':
      return await runScreenshot(runtime, request)
    default: {
      const op = (request as { op?: string }).op ?? '?'
      throw new SjsWorkerError(`operation not implemented yet: ${op}`, 'SJS_OP_NOT_IMPLEMENTED')
    }
  }
}

/** Codes whose cause is the browser/CDP layer rather than the workbook. */
const RUNTIME_FATAL_CODES = new Set(['SJS_BROWSER_FAILED', 'SJS_BROWSER_UNAVAILABLE'])

function runtimeIsSuspect(error: unknown): boolean {
  if (error instanceof SjsWorkerError) return RUNTIME_FATAL_CODES.has(error.code)
  // An unclassified throw did not come from a page that classified it, so
  // assume the runtime is the problem rather than a workbook.
  return true
}

// ------------------------------------------------------------------ runtime

let pending: Promise<BrowserRuntime> | undefined
let running: BrowserRuntime | undefined

/**
 * Boot the browser runtime on first use, then keep it for the process's life.
 *
 * The browser is the only runtime: there is no fallback path, by decision. When
 * it cannot start, the failure is classified (`SJS_BROWSER_UNAVAILABLE` when no
 * Edge/Chrome exists, `SJS_BROWSER_FAILED` when one exists but will not run)
 * rather than surfacing as a stack trace the model cannot act on.
 *
 * A boot that fails must not be cached: the next request retries instead of
 * being served the same rejection forever.
 */
async function engine(): Promise<BrowserRuntime> {
  pending ??= loadRuntime({ log: (message) => { process.stderr.write(`${message}\n`) } }).then(
    (runtime) => {
      running = runtime
      return runtime
    },
    (error: unknown) => {
      pending = undefined
      running = undefined
      throw error
    },
  )
  return await pending
}

/**
 * Shut the runtime down: kill the browser and stop the file server.
 *
 * Called when the engine exits (idle timeout, stdin closed, host gone), after a
 * runtime-level failure, and on the process's fatal path. The browser is a
 * direct child of this process, so it cannot outlive an abrupt exit either —
 * but a cooperative close is what lets it delete its own profile directory.
 */
export async function closeRuntime(): Promise<void> {
  const runtime = running
  running = undefined
  pending = undefined
  if (runtime !== undefined) await runtime.close()
}

// --------------------------------------------------------------- operations

async function runNew(runtime: BrowserRuntime, targetPath: string): Promise<JsonValue> {
  await runtime.create(targetPath)
  return { created: true, file: targetPath }
}

async function runStatus(runtime: BrowserRuntime, sourcePath: string): Promise<JsonValue> {
  const summary = await runtime.load(sourcePath)
  return summary as unknown as JsonValue
}

async function runExecute(runtime: BrowserRuntime, request: Extract<SjsWorkerRequest, { op: 'execute' }>): Promise<JsonValue> {
  const value = await runtime.execute(request.sourcePath, request.workspaceRoot, request.code)
  return value as JsonValue
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
async function runImport(runtime: BrowserRuntime, request: Extract<SjsWorkerRequest, { op: 'import' }>): Promise<JsonValue> {
  const format = importFormatForPath(request.sourcePath)
  if (format === undefined) {
    throw new SjsWorkerError(
      `unsupported import source: ${request.sourcePath} (expected .xlsx / .csv / .ssjson)`,
      'SJS_UNSUPPORTED_IMPORT_FORMAT',
    )
  }

  if (format === 'ssjson') {
    // Canonical → canonical: load + re-persist, which also validates the JSON.
    const summary = await runtime.load(request.sourcePath)
    await runtime.saveAs(request.targetPath)
    return { format, file: request.targetPath, ...summary } as unknown as JsonValue
  }

  const imported = await runtime.importInto(request.sourcePath, request.targetPath, format)
  return {
    format,
    file: request.targetPath,
    bytes: imported.bytes,
    sheets: imported.sheets,
    activeSheet: imported.activeSheet,
  } as unknown as JsonValue
}

/**
 * Export a canonical `.ssjson` workbook to an external file: xlsx, csv, ssjson,
 * or pdf (savePDF + registered fonts). The active sheet drives CSV width (a CSV
 * has no workbook dimension), and PDF export is guarded against producing an
 * empty shell when no embeddable font is available.
 */
async function runExport(runtime: BrowserRuntime, request: Extract<SjsWorkerRequest, { op: 'export' }>): Promise<JsonValue> {
  if (request.format === 'ssjson') {
    // Canonical → canonical: a byte copy is exact and cheapest.
    await copyFileAtomic(request.sourcePath, request.outputPath)
    const summary = await runtime.load(request.sourcePath)
    return { format: request.format, file: request.outputPath, ...summary } as unknown as JsonValue
  }

  if (request.format === 'pdf') {
    const pdf = await runtime.exportPdf(request.sourcePath, request.outputPath)
    return { format: 'pdf', file: request.outputPath, bytes: pdf.bytes, fonts: pdf.fonts } as unknown as JsonValue
  }

  return await runtime.exportWorkbook(request.sourcePath, request.outputPath, request.format) as unknown as JsonValue
}

/**
 * Render a visual snapshot of a canonical .ssjson workbook.
 *
 * format 'png' rasterizes the active sheet through the browser's own canvas:
 * the engine paints exactly as it does for a user, so no font is forced, no
 * constructor is injected, and the pixels are the real rendering. The evaluation
 * watermark is part of that rendering and is deliberately left in place.
 * format 'pdf' reuses the PDF backend, so a "visual" snapshot is available even
 * before the platform confirms it can present image tool results (task 6).
 * The source file is never written back.
 */
async function runScreenshot(runtime: BrowserRuntime, request: Extract<SjsWorkerRequest, { op: 'screenshot' }>): Promise<JsonValue> {
  if (request.format === 'pdf') {
    const pdf = await runtime.screenshotPdf(request.sourcePath, request.outputPath)
    return { format: 'pdf', file: request.outputPath, bytes: pdf.bytes, fonts: pdf.fonts } as unknown as JsonValue
  }
  const shot = await runtime.screenshotPng(request.sourcePath, request.outputPath)
  return {
    format: 'png',
    file: request.outputPath,
    bytes: shot.bytes,
    width: shot.width,
    height: shot.height,
    sheet: shot.sheet,
    ...(shot.used === null ? {} : { usedRange: { row: shot.used.row, rowCount: shot.used.rowCount, column: shot.used.col, columnCount: shot.used.colCount } }),
    font: shot.font,
    ...(shot.clipped === true ? { clipped: true } : {}),
  } as unknown as JsonValue
}
