/**
 * SpreadJS worker operations (new / status / execute / import / export /
 * screenshot), driven against a real browser.
 *
 * This module is the Node-side half: it owns the request envelope's semantics —
 * which paths mean what, which failure is which code, which write must be atomic
 * — and delegates everything that has to happen inside a browser to
 * `browser/runtime.ts`.
 *
 * Two properties survived the runtime swap unchanged and are load-bearing:
 *
 *  - **Every path arriving here is already authorized by the host.** Nothing in
 *    this file re-derives or widens that decision, and the only paths the page
 *    ever receives are ones this file built a URL for.
 *  - **Every write is temp+rename.** A workbook file that is half written still
 *    parses as JSON, so an interrupted write must never replace the real file.
 *
 * The script sandbox also changed shape: user code now runs as a function inside
 * the page rather than in a `node:vm` context. That was never the security
 * boundary (the one-shot OS process plus host-side workspace authorization is),
 * and the workspace confinement of `io.*` is unchanged — it is re-checked Node
 * side on every request the sandbox makes.
 */
import { extname } from 'node:path'
import type { JsonValue, SjsWorkerRequest } from '../../shared/protocol.ts'
import { SjsWorkerError } from './errors.ts'
import { copyFileAtomic } from './files.ts'
import { loadRuntime, type BrowserRuntime } from './browser/runtime.ts'

/** Perform one worker request and return its structured JSON result. */
export async function runOperation(request: SjsWorkerRequest): Promise<JsonValue> {
  switch (request.op) {
    case 'new':
      return await runNew(request.targetPath)
    case 'status':
      return await runStatus(request.sourcePath)
    case 'execute':
      return await runExecute(request)
    case 'import':
      return await runImport(request)
    case 'export':
      return await runExport(request)
    case 'screenshot':
      return await runScreenshot(request)
    default: {
      const op = (request as { op?: string }).op ?? '?'
      throw new SjsWorkerError(`operation not implemented yet: ${op}`, 'SJS_OP_NOT_IMPLEMENTED')
    }
  }
}

// ------------------------------------------------------------------ runtime

let pending: Promise<BrowserRuntime> | undefined
let running: BrowserRuntime | undefined

/**
 * Boot the browser runtime on first use, once per worker process.
 *
 * The browser is the only runtime: there is no fallback path, by decision. When
 * it cannot start, the failure is classified (`SJS_BROWSER_UNAVAILABLE` when no
 * Edge/Chrome exists, `SJS_BROWSER_FAILED` when one exists but will not run)
 * rather than surfacing as a stack trace the model cannot act on.
 */
async function engine(): Promise<BrowserRuntime> {
  pending ??= loadRuntime({ log: (message) => { process.stderr.write(`${message}\n`) } }).then((runtime) => {
    running = runtime
    return runtime
  })
  return await pending
}

/**
 * Shut the runtime down: kill the browser and stop the file server.
 *
 * Called from the entry point on BOTH paths, including failure: the process is
 * one-shot, and a browser left running would outlive it (along with its profile
 * directory).
 */
export async function closeRuntime(): Promise<void> {
  const runtime = running
  running = undefined
  pending = undefined
  if (runtime !== undefined) await runtime.close()
}

// --------------------------------------------------------------- operations

async function runNew(targetPath: string): Promise<JsonValue> {
  await (await engine()).create(targetPath)
  return { created: true, file: targetPath }
}

async function runStatus(sourcePath: string): Promise<JsonValue> {
  const summary = await (await engine()).load(sourcePath)
  return summary as unknown as JsonValue
}

async function runExecute(request: Extract<SjsWorkerRequest, { op: 'execute' }>): Promise<JsonValue> {
  const value = await (await engine()).execute(request.sourcePath, request.workspaceRoot, request.code)
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
async function runImport(request: Extract<SjsWorkerRequest, { op: 'import' }>): Promise<JsonValue> {
  const format = importFormatForPath(request.sourcePath)
  if (format === undefined) {
    throw new SjsWorkerError(
      `unsupported import source: ${request.sourcePath} (expected .xlsx / .csv / .ssjson)`,
      'SJS_UNSUPPORTED_IMPORT_FORMAT',
    )
  }
  const runtime = await engine()

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
async function runExport(request: Extract<SjsWorkerRequest, { op: 'export' }>): Promise<JsonValue> {
  const runtime = await engine()

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
async function runScreenshot(request: Extract<SjsWorkerRequest, { op: 'screenshot' }>): Promise<JsonValue> {
  const runtime = await engine()
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
