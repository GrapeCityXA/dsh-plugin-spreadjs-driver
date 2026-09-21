/**
 * The engine runtime: SpreadJS loaded in a REAL system browser, driven from Node
 * over CDP.
 *
 * Why bother, when jsdom worked: "run SpreadJS under Node" is a claim we do not
 * want to have to defend, and it cost us three separate defect classes that only
 * exist because jsdom is not a browser — cross-realm ArrayBuffer, a cross-realm
 * Date that silently wrote 1899/12/30 into cells, and a missing
 * CanvasRenderingContext2D that broke every sheet carrying a number formatter.
 * In a real browser those classes do not exist, and the pixels are the engine's
 * own.
 *
 * Process model (stage 2): the browser is launched ONCE per engine process and
 * serves every operation; each operation gets a NEW PAGE and that page is closed
 * when the operation ends. Pages are the isolation boundary: a fresh page means
 * fresh SpreadJS prototypes, so the guards this runtime installs on
 * `Worksheet.prototype` (auto-grow, sheet-name validation) are installed once
 * per page against a pristine prototype instead of being re-patched over an
 * already-patched one — which is a real hazard, not a theoretical one.
 *
 * What the page costs per operation is the bundle load: ~13.4 MB of UMD builds.
 * The browser's HTTP cache is what makes the second and later pages cheap (see
 * server.ts: the package bundles are the one cacheable route), and the file
 * server, the CDP connection and the browser process itself are all reused.
 *
 * Division of labour:
 *   Node  — path authorization, every byte of file IO, the browser process, CDP,
 *           error classification, atomic writes.
 *   page  — SpreadJS only. It has no filesystem and never sees a host path it was
 *           not handed already-authorized.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { CDP, Page, launchBrowser, type LaunchedBrowser } from './cdp.ts'
import { findBrowser } from './discovery.ts'
import { startFileServer, type FileServer } from './server.ts'
import { SjsWorkerError } from '../errors.ts'
import { basenameWithoutExtension, errorMessage } from '../util.ts'
import { discoverPdfFonts, type PdfFontFile } from '../fonts.ts'
import PAGE_SOURCE from './page.embed.js'

const require = createRequire(import.meta.url)

/**
 * The UMD build each package ships, in load order.
 *
 * Order is a real dependency chain, not taste: print must precede pdf, shapes
 * must precede slicers (and pivot slicers additionally need the pivot add-on).
 * Every file is verified to exist at boot, so a packaging change fails with a
 * named error instead of a silent `GC is undefined` in the page.
 */
const BUNDLES: readonly (readonly [packageName: string, file: string])[] = [
  ['spread-sheets', 'dist/gc.spread.sheets.all.min.js'],
  ['spread-sheets-io', 'dist/gc.spread.sheets.io.min.js'],
  ['spread-sheets-shapes', 'dist/gc.spread.sheets.shapes.min.js'],
  ['spread-sheets-charts', 'dist/gc.spread.sheets.charts.min.js'],
  ['spread-sheets-slicers', 'dist/gc.spread.sheets.slicers.min.js'],
  ['spread-sheets-print', 'dist/gc.spread.sheets.print.min.js'],
  ['spread-sheets-pdf', 'dist/gc.spread.sheets.pdf.min.js'],
  ['spread-sheets-pivot-addon', 'dist/gc.spread.pivot.pivottables.min.js'],
  ['spread-sheets-datacharts-addon', 'dist/gc.spread.sheets.datacharts.min.js'],
]

/**
 * The page document. The host is the box the engine measures and renders into.
 *
 * The inline script does two jobs, and both have to live HERE rather than in
 * runtime.js:
 *
 *  1. **An error trap.** If runtime.js fails to load, a trap inside it would
 *     never install, and the only symptom would be `__H is not defined` — with
 *     no way to tell a 404 from a connection reset.
 *  2. **A retry loop for runtime.js.** A browser that has just started
 *     occasionally fails the very first subresource request (its network service
 *     is still coming up); observed as `__H is not defined` on EVERY attempt,
 *     because re-navigating only re-issues the same doomed request at the same
 *     moment. Retrying from inside the page, with backoff, rides out the race —
 *     and `window.__runtimeLoaded` gives Node a promise to await, so the boot
 *     step knows the difference between "still loading" and "gave up".
 */
const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>sjs-runtime</title>
<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}#host{width:1400px;height:900px}</style>
<script>
window.__pageErrors = [];
addEventListener('error', function (event) {
  var target = event.target;
  if (target && target.tagName === 'SCRIPT') window.__pageErrors.push('script failed to load: ' + (target.src || '(inline)'));
  else window.__pageErrors.push('error: ' + event.message);
}, true);
addEventListener('unhandledrejection', function (event) { window.__pageErrors.push('unhandled rejection: ' + event.reason); });
window.__runtimeLoaded = new Promise(function (resolve, reject) {
  var attempt = 0;
  function load() {
    attempt++;
    var script = document.createElement('script');
    script.src = '/runtime.js?a=' + attempt;
    script.onload = function () { resolve(true); };
    script.onerror = function () {
      window.__pageErrors.push('runtime.js failed to load (attempt ' + attempt + ')');
      if (attempt < 5) setTimeout(load, 150 * attempt);
      else reject(new Error('runtime.js failed to load after ' + attempt + ' attempts'));
    };
    document.head.appendChild(script);
  }
  load();
});
</script>
</head><body><div id="host"></div></body></html>`

/** Geometry constants shared with the page (see page.embed.js). */
const HOST_WIDTH = 1400
const HOST_HEIGHT = 900
/** Device pixels per CSS pixel for screenshots; see setDeviceMetricsOverride. */
const SHOT_SCALE = 2
const MAX_SHOT_WIDTH = 2600
const MAX_SHOT_HEIGHT = 2200
/** Canvas is host client size minus one scrollbar (18px) on each axis. */
const SCROLLBAR = 18
/** Comfort padding so the last column/row is not flush against the edge. */
const CONTENT_PAD = 8
/** Empty-sheet fallback viewport (canvas ≈ 900×400). */
const EMPTY_WIDTH = 918
const EMPTY_HEIGHT = 418

export interface RuntimeOptions {
  /** Browser executable from the host config; discovery runs when omitted. */
  readonly browserPath?: string
  /** stderr sink for diagnostics (stdout carries envelopes and nothing else). */
  readonly log?: (message: string) => void
}

/** Structural workbook summary, mirroring the jsdom worker's `status`. */
export interface WorkbookSummary {
  sheets: { name: string; rowCount: number; columnCount: number; usedRange?: { row: number; rowCount: number; col: number; colCount: number } }[]
  activeSheet?: string
}

export interface PdfExportResult {
  bytes: number
  fonts: string[]
}

export interface PngShotResult {
  bytes: number
  /** Width in CSS pixels — the unit column widths are measured in. */
  width: number
  /** Height in CSS pixels. */
  height: number
  /** The image's own pixel size: `width`/`height` times {@link scale}. */
  pixels: { width: number; height: number }
  /** Device pixels per CSS pixel this render used. */
  scale: number
  clipped?: boolean
  sheet: string
  used: { row: number; rowCount: number; col: number; colCount: number } | null
  font: string
}

export interface BrowserRuntime {
  /** Blank workbook → .ssjson. */
  create(targetPath: string): Promise<{ bytes: number } & WorkbookSummary>
  /** Load an .ssjson file (validates it) and report its structure. */
  load(sourcePath: string): Promise<WorkbookSummary>
  /** Persist the workbook currently in the page to a target path, atomically. */
  saveAs(targetPath: string): Promise<{ bytes: number }>
  /** Import xlsx/csv bytes into a workbook and persist it as .ssjson. */
  importInto(sourcePath: string, targetPath: string, format: 'excel' | 'csv'): Promise<{ bytes: number } & WorkbookSummary>
  /** Export the loaded workbook; Node writes the bytes atomically. */
  exportWorkbook(sourcePath: string, outputPath: string, format: 'xlsx' | 'csv'): Promise<Record<string, unknown>>
  /** Export to PDF with fonts registered first (the hollow-PDF guard). */
  exportPdf(sourcePath: string, outputPath: string): Promise<PdfExportResult>
  /** Rasterize the active sheet through the browser's own canvas. */
  screenshotPng(sourcePath: string, outputPath: string): Promise<PngShotResult>
  /** PDF snapshot of the active sheet (same font guard as exportPdf). */
  screenshotPdf(sourcePath: string, outputPath: string): Promise<PdfExportResult>
  /** Load, run user code, persist, then materialize the return value. */
  execute(sourcePath: string, workspaceRoot: string, code: string): Promise<unknown>
  close(): Promise<void>
}

/** Resolve every bundle to an absolute path, failing loudly when one is missing. */
function bundleFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [packageName, relative] of BUNDLES) {
    let packageJson: string
    try {
      packageJson = require.resolve(`@grapecity-software/${packageName}/package.json`)
    } catch (error) {
      throw new SjsWorkerError(
        `cannot resolve @grapecity-software/${packageName} (${errorMessage(error)}); the plugin's dependencies are not installed`,
        'SJS_BROWSER_FAILED',
      )
    }
    const file = join(dirname(packageJson), relative)
    if (!existsSync(file)) {
      throw new SjsWorkerError(
        `the SpreadJS browser build is missing: ${file}. Expected ${packageName}@19.1.4 to ship ${basename(relative)}.`,
        'SJS_BROWSER_FAILED',
      )
    }
    files[`/${packageName}/${basename(relative)}`] = file
  }
  return files
}

/** One operation's page plus the listeners that must be dropped with it. */
interface PageSession {
  readonly page: Page
  dispose(): void
}

/** Where a page's boot time went (logged per operation; see openPage). */
interface PageBootTiming {
  readonly bundles: number
  readonly documentMs: number
  readonly runtimeMs: number
  readonly bootMs: number
}

/**
 * Boot the browser runtime: file server, browser process, CDP connection.
 *
 * The returned runtime opens and closes a page per operation — it holds no
 * workbook state between calls, which is what keeps `sjs_execute`'s isolation
 * story intact under a process that no longer dies between calls.
 */
export async function loadRuntime(options: RuntimeOptions = {}): Promise<BrowserRuntime> {
  const log = options.log ?? ((): void => undefined)
  const bundleMap = bundleFiles()

  let server: FileServer | undefined
  let browser: LaunchedBrowser | undefined
  let cdp: CDP | undefined
  try {
    server = await startFileServer({
      documents: { '/': APP_HTML, '/index.html': APP_HTML, '/runtime.js': `window.__BUNDLES = ${JSON.stringify(Object.keys(bundleMap))};\n${PAGE_SOURCE}` },
      files: bundleMap,
    })

    const browserPath = options.browserPath ?? process.env['SJS_BROWSER_PATH']
    const located = findBrowser(browserPath)
    log(`[sjs] browser: ${located.kind} at ${located.path}`)

    const startedAt = performance.now()
    browser = await launchBrowser({ exe: located.path, headless: true, log })
    cdp = await CDP.connect(browser.wsUrl)
    log(`[sjs] browser ready in ${(performance.now() - startedAt).toFixed(0)}ms`)

    // Bound for the closures below: `cdp` stays optional for the failure path.
    const client = cdp
    const origin = server.origin
    const registerBlob = server.registerBlob.bind(server)
    /**
     * Host-authorized URL for one file. The path is resolved HERE and never
     * appears in the URL the page fetches — only an opaque id does, so a URL
     * recovered from the page's resource timing grants nothing beyond the file
     * the host already chose to hand over.
     */
    const hostUrl = (absolutePath: string): string => registerBlob(resolve(absolutePath))

    /**
     * Pages this engine currently has open.
     *
     * A page that is open is a page that is RENDERING — and in a browser, a
     * page is a window. Because the engine keeps one browser alive for its whole
     * life, a page that outlives its operation is a window that outlives it too
     * (invisible in headless mode, but real: it shows up in the shell's window
     * list and keeps a renderer process alive). The set below is what makes
     * "exactly one page at a time, closed with its operation" an invariant that
     * is checked rather than hoped for.
     */
    const openPages = new Set<Page>()

    /** Close one page, retrying once: a page left open is a window left open. */
    const closePage = async (page: Page): Promise<void> => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await page.close()
          openPages.delete(page)
          return
        } catch (error) {
          if (attempt === 2) {
            log(`[sjs] could not close an operation page: ${errorMessage(error)}`)
            return
          }
          await new Promise((resolve) => { setTimeout(resolve, 250) })
        }
      }
    }

    /** Close every page still open — the sweep that keeps a lost close from accumulating. */
    const sweepPages = async (): Promise<void> => {
      for (const page of [...openPages]) await closePage(page)
    }

    /** Open a page, load the bundles into it, and hand it back with its listeners. */
    const openPage = async (): Promise<PageSession> => {
      const page = await client.newPage('about:blank')
      openPages.add(page)
      try {
        await page.send('Page.enable')
        await page.send('Runtime.enable')
        // Render at 2 device pixels per CSS pixel. SpreadJS sizes its canvas from
        // `window.devicePixelRatio`, so this is what decides the screenshot's real
        // resolution — and at 1 a sheet photographed 888x328 is simply soft on a
        // high-DPI display, which is every display people use now.
        //
        // The image gets 4x the pixels; what the tool REPORTS stays in CSS pixels
        // (the page divides by the same ratio), because the reported width is what
        // the model checks its column arithmetic against and columns are measured
        // in CSS pixels. Scaling the canvas up after the fact would only interpolate
        // a low-resolution render — the resolution has to be chosen here.
        await page.send('Emulation.setDeviceMetricsOverride', { width: HOST_WIDTH, height: HOST_HEIGHT + 100, deviceScaleFactor: SHOT_SCALE, mobile: false })
        const detachDiagnostics = forwardPageDiagnostics(page, log)
        const pageStartedAt = performance.now()
        const injected = await bootPage(page, origin, log)
        // The breakdown matters because this is the one step a persistent browser
        // does not remove: the page still loads ~13.4 MB of SpreadJS per
        // operation. `runtime` is the page's own loader, `boot` is where the nine
        // UMD bundles are fetched (cache hits after the first pages) and
        // evaluated.
        log(
          `[sjs] page ready in ${(performance.now() - pageStartedAt).toFixed(0)}ms ` +
            `(document ${injected.documentMs.toFixed(0)}ms, runtime ${injected.runtimeMs.toFixed(0)}ms, boot ${injected.bootMs.toFixed(0)}ms, ${String(injected.bundles)} bundles)`,
        )
        return { page, dispose: detachDiagnostics }
      } catch (error) {
        // This page never became an operation, and nothing above will close it:
        // a page that failed to boot must not be left loaded in the browser for
        // the engine's lifetime.
        await closePage(page)
        throw error
      }
    }

    /**
     * Run one operation on a page of its own.
     *
     * The blob registry is cleared here, before the operation mints anything:
     * a nonce authorizes one host-chosen file for the operation that asked for
     * it. In a one-shot process that was implied by the process ending; here it
     * has to be said, or the registry would grow for the engine's whole life and
     * keep paths valid long after the host decided they were.
     */
    const withPage = async <T,>(operation: (page: Page) => Promise<T>): Promise<T> => {
      server?.clearBlobs()
      await sweepPages()
      const session = await openPage()
      try {
        return await operation(session.page)
      } finally {
        session.dispose()
        await closePage(session.page)
      }
    }

    const summarize = async (page: Page): Promise<WorkbookSummary> => await callPage<WorkbookSummary>(page, '__H.summarize()')

    const read = async <T,>(page: Page, sourcePath: string, width = HOST_WIDTH, height = HOST_HEIGHT): Promise<{ bytes: number } & T> => {
      const loaded = await callPage<{ bytes: number }>(
        page,
        `__H.loadWorkbook(${JSON.stringify(hostUrl(sourcePath))}, ${String(width)}, ${String(height)})`,
        'SJS_FILE_READ_FAILED',
      )
      return loaded as { bytes: number } & T
    }

    const share = (summary: WorkbookSummary): WorkbookSummary => ({ sheets: summary.sheets, activeSheet: summary.activeSheet })

    const runtime: BrowserRuntime = {
      async create(targetPath) {
        return await withPage(async (page) => {
          const created = await callPage<{ bytes: number }>(
            page,
            `__H.createWorkbook(${JSON.stringify(hostUrl(targetPath))}, ${String(HOST_WIDTH)}, ${String(HOST_HEIGHT)})`,
          )
          return { bytes: created.bytes, ...share(await summarize(page)) }
        })
      },

      async load(sourcePath) {
        return await withPage(async (page) => {
          await read(page, sourcePath)
          return share(await summarize(page))
        })
      },

      async saveAs(targetPath) {
        return await withPage(async (page) => await callPage<{ bytes: number }>(page, `__H.persist(${JSON.stringify(hostUrl(targetPath))})`))
      },

      async importInto(sourcePath, targetPath, format) {
        return await withPage(async (page) => {
          const imported = await callPage<{ bytes: number }>(
            page,
            `__H.importFile(${JSON.stringify(hostUrl(sourcePath))}, ${JSON.stringify(resolve(sourcePath))}, ${JSON.stringify(format)})`,
            'SJS_IMPORT_FAILED',
          )
          await callPage(page, `__H.persist(${JSON.stringify(hostUrl(targetPath))})`)
          return { bytes: imported.bytes, ...share(await summarize(page)) }
        })
      },

      async exportWorkbook(sourcePath, outputPath, format) {
        return await withPage(async (page) => {
          await read(page, sourcePath)
          const exported = await callPage<{ bytes: number; sheet?: string; usedRange?: unknown }>(
            page,
            `__H.exportFile(${JSON.stringify(hostUrl(outputPath))}, ${JSON.stringify(format)})`,
            'SJS_EXPORT_FAILED',
          )
          const result: Record<string, unknown> = {
            format,
            file: outputPath,
            bytes: exported.bytes,
            ...(exported.sheet === undefined ? {} : { sheet: exported.sheet }),
            ...(exported.usedRange === undefined ? {} : { usedRange: exported.usedRange }),
          }
          if (format === 'csv') return result
          return { ...result, ...share(await summarize(page)) }
        })
      },

      async exportPdf(sourcePath, outputPath) {
        return await withPage(async (page) => {
          await read(page, sourcePath)
          return await callPage<PdfExportResult>(
            page,
            `__H.exportPdf(${JSON.stringify(hostUrl(outputPath))}, ${JSON.stringify(pdfFontRequests(hostUrl))}, ${JSON.stringify(basenameWithoutExtension(outputPath))})`,
            'SJS_PDF_EXPORT_FAILED',
          )
        })
      },

      async screenshotPdf(sourcePath, outputPath) {
        return await withPage(async (page) => {
          await read(page, sourcePath)
          return await callPage<PdfExportResult>(
            page,
            `__H.screenshotPdf(${JSON.stringify(hostUrl(outputPath))}, ${JSON.stringify(pdfFontRequests(hostUrl))}, ${JSON.stringify(basenameWithoutExtension(outputPath))})`,
            'SJS_PDF_EXPORT_FAILED',
          )
        })
      },

      async screenshotPng(sourcePath, outputPath) {
        return await withPage(async (page) =>
          await callPage<PngShotResult>(
            page,
            `__H.screenshotPng(${JSON.stringify(hostUrl(sourcePath))}, ${JSON.stringify(hostUrl(outputPath))}, ` +
              `${String(MAX_SHOT_WIDTH)}, ${String(MAX_SHOT_HEIGHT)}, ${String(CONTENT_PAD)}, ${String(SCROLLBAR)}, ${String(EMPTY_WIDTH)}, ${String(EMPTY_HEIGHT)})`,
            'SJS_FILE_READ_FAILED',
          ),
        )
      },

      async execute(sourcePath, workspaceRoot, code) {
        return await withPage(async (page) => {
          // The workspace root is set BEFORE any user code runs, and the confinement
          // decision stays on this side of the boundary (server.authorizeWorkspacePath).
          server?.setWorkspaceRoot(resolve(workspaceRoot))
          await read(page, sourcePath)
          const outcome = await callPage<{ json: string }>(
            page,
            `__H.runCode(${JSON.stringify(code)}, ${JSON.stringify(hostUrl(sourcePath))})`,
            'SJS_SCRIPT_ERROR',
          )
          return JSON.parse(outcome.json) as unknown
        })
      },

      async close() {
        await browser?.close()
        await server?.close()
      },
    }
    return runtime
  } catch (error) {
    // Never leak a half-started browser or server, even though the engine now
    // outlives this call: a failed boot must leave nothing behind for the next
    // request to trip over.
    await cdp?.send('Browser.close').catch(() => undefined)
    cdp?.dispose()
    await browser?.close().catch(() => undefined)
    await server?.close().catch(() => undefined)
    if (error instanceof SjsWorkerError) throw error
    const code = (error as { code?: string }).code ?? 'SJS_BROWSER_FAILED'
    throw new SjsWorkerError(`cannot start the SpreadJS browser runtime: ${errorMessage(error)}`, code)
  }
}

/**
 * Fonts to register for PDF export, as URLs the PAGE fetches.
 *
 * Discovery and the empty-set guard stay Node-side (see fonts.ts): `savePDF`
 * embeds only registered fonts, and an unregistered CJK cell silently produces a
 * hollow PDF, so this list must never be empty.
 *
 * Registration itself is per PAGE (SpreadJS's font manager lives in the page),
 * so a new page per operation re-registers every font: this list is built per
 * operation and the ~136 font files are re-fetched for each PDF export. The
 * browser's HTTP cache makes the transfer cheap after the first one, but the
 * parse/registration work is paid again — see docs/design-real-browser-runtime.md.
 */
function pdfFontRequests(hostUrl: (path: string) => string): { family: string; url: string; fallback?: boolean; cjk?: boolean }[] {
  const fonts: readonly PdfFontFile[] = discoverPdfFonts()
  if (fonts.length === 0) {
    throw new SjsWorkerError(
      '找不到可嵌入 PDF 的字体：需要至少一个 .ttf/.otf（不支持 .ttc）。' +
        '可用环境变量 GC_SJS_PDF_FONT_DIRS 指向含 simhei.ttf / arial.ttf 等的目录，避免导出空壳 PDF。',
      'SJS_PDF_FONT_UNAVAILABLE',
    )
  }
  // fallback 命中含中文的字体优先；否则退到首个已注册字体（与 jsdom 版一致）。
  const fallback = fonts.find((font) => font.cjk) ?? fonts[0]
  // `cjk` travels to the page because the page has to decide WHAT TO REGISTER,
  // and that decision is the whole ball game — see registerPdfFonts.
  return fonts.map((font) => ({
    family: font.family,
    url: hostUrl(font.file),
    ...(font.cjk ? { cjk: true } : {}),
    ...(fallback !== undefined && font.file === fallback.file ? { fallback: true } : {}),
  }))
}

/**
 * Navigate and load the bundles, retrying the whole navigation when it fails.
 *
 * A page occasionally commits the target before its subresource pipeline is
 * ready, and the bundle `<script>` tags then fail with a network error even
 * though the origin is up. Re-navigating is the fix (the same lesson the spike's
 * harness learned); giving up would fail an operation for a timing accident.
 */
async function bootPage(page: Page, origin: string, log: (message: string) => void): Promise<PageBootTiming> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let at = performance.now()
      await page.goto(`${origin}/`)
      const documentMs = performance.now() - at
      at = performance.now()
      // The document's own loader promise: it resolves once runtime.js has run,
      // and rejects when the page gave up on fetching it.
      await page.evaluate('window.__runtimeLoaded')
      const runtimeMs = performance.now() - at
      at = performance.now()
      const booted = await callPage<{ bundles: number }>(page, '__H.boot()')
      const bootMs = performance.now() - at
      return { bundles: booted.bundles, documentMs, runtimeMs, bootMs }
    } catch (error) {
      lastError = error
      log(`[sjs] page boot attempt ${String(attempt)} failed: ${errorMessage(error)} :: ${await pageState(page)}`)
      await new Promise((resolve) => { setTimeout(resolve, 400) })
    }
  }
  throw new SjsWorkerError(`cannot load SpreadJS into the browser page: ${errorMessage(lastError)}`, 'SJS_BROWSER_FAILED')
}

/** One-line snapshot of the page, for diagnosing a boot failure. */
async function pageState(page: Page): Promise<string> {
  try {
    const state = await page.evaluate(
      'JSON.stringify({ href: location.href, ready: document.readyState, scripts: document.scripts.length, H: typeof window.__H, GC: typeof window.GC, errors: (window.__pageErrors || []).slice(0, 4) })',
    )
    return typeof state === 'string' ? state : '(no page state)'
  } catch (error) {
    return `(page unreachable: ${errorMessage(error)})`
  }
}

/**
 * Call one page helper and classify its failure.
 *
 * The page signals a specific worker error code by throwing a value carrying
 * `sjsCode`; anything else is a runtime failure of the browser side.
 */
async function callPage<T>(page: Page, expression: string, fallbackCode = 'SJS_WORKER_FAILED'): Promise<T> {
  const wrapped =
    `(async () => { try { return { ok: true, value: await (${expression}) } }` +
    ' catch (error) { return { ok: false, code: (error && error.sjsCode) || "", message: (error && error.message) || String(error) } } })()'
  let raw: unknown
  try {
    raw = await page.evaluate(wrapped)
  } catch (error) {
    throw new SjsWorkerError(`browser page failed: ${errorMessage(error)}`, 'SJS_BROWSER_FAILED')
  }
  const outcome = raw as { ok?: boolean; value?: unknown; code?: string; message?: string } | undefined
  if (outcome === undefined || outcome.ok !== true) {
    throw new SjsWorkerError(outcome?.message ?? 'browser page returned no result', outcome?.code !== undefined && outcome.code.length > 0 ? outcome.code : fallbackCode)
  }
  return outcome.value as T
}

/**
 * Forward page console output and uncaught errors to stderr.
 *
 * This is what keeps `console.log` inside `sjs_execute` code visible at all, and
 * it is the only channel: stdout carries envelopes and must stay clean. Returns
 * the unsubscribe: the CDP listener set is shared by every page of the engine's
 * life, so a page that is closed must take its listeners with it.
 */
function forwardPageDiagnostics(page: Page, log: (message: string) => void): () => void {
  const offConsole = page.on('Runtime.consoleAPICalled', (params) => {
    const event = params as { type?: string; args?: { value?: unknown; description?: string; preview?: unknown }[] }
    const text = (event.args ?? [])
      .map((argument) => {
        if (argument.value !== undefined) return typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value)
        if (argument.description !== undefined) return argument.description
        return '[object]'
      })
      .join(' ')
    if (text.length > 0) log(text)
  })
  const offException = page.on('Runtime.exceptionThrown', (params) => {
    const event = params as { exceptionDetails?: { exception?: { description?: string }; text?: string } }
    log(`[sjs:page] ${event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? 'uncaught page error'}`)
  })
  return () => {
    offConsole()
    offException()
  }
}
