/**
 * Headless PNG rasterizer — the pixel backend for `sjs_screenshot`.
 *
 * Proven by the phase-bound experiment (scratch/png-probe14.mjs): SpreadJS can
 * paint onto a node-canvas-backed jsdom <canvas> in plain Node, producing a real
 * PNG. Three hard-won constraints drive this implementation:
 *
 *   1. Constructor-time host binding. `new Workbook(host)` measures the host and
 *      builds layout; a later `setHost()` never does, leaving `getCellRect` at
 *      NaN and the canvas at its 300x150 default.
 *   2. Two renders. The capture host must be sized to the used content, but that
 *      size is only knowable after a host is bound — so render once at a generous
 *      size to measure `getCellRect` of the last used cell, then render again on
 *      a host sized so the canvas (= host − scrollbar) fits the content.
 *   3. Font forcing. jsdom+node-canvas draws NO CJK glyphs for SpreadJS's
 *      default family, so the used box gets a uniform, registered CJK-capable
 *      family. This flattens per-cell font/weight variety (a documented
 *      screenshot affordance, not an export) but keeps values, colors, borders,
 *      merges and layout faithful.
 *
 * The renderer mutates only in-memory workbooks that are destroyed before return;
 * the source .ssjson file is never written back.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { SjsWorkerError } from './errors.ts'
import { discoverPdfFonts } from './fonts.ts'
import { errorMessage } from './util.ts'

type Gc = any

/** Geometry/used-range result of the measure render. */
interface Measure {
  /** Content used range (data + formula) of the active sheet, or null when empty. */
  used: { row: number; rowCount: number; col: number; colCount: number } | null
  /** Right/bottom edges of the last used cell, in host px including headers. */
  contentWidth: number
  contentHeight: number
  sheetName: string
}

export interface PngRenderResult {
  png: Buffer
  width: number
  height: number
  /** True when content exceeded the max canvas and the image is clipped. */
  clipped: boolean
  sheet: string
  used: { row: number; rowCount: number; col: number; colCount: number } | null
  /** The font family the used box was forced to render with. */
  font: string
}

/** Max raster dimensions; beyond this the screenshot clips (reported as `clipped`). */
const MAX_WIDTH = 2600
const MAX_HEIGHT = 2200
/** Measure-render host size (generous; actual size comes from getCellRect). */
const MEASURE_WIDTH = 1400
const MEASURE_HEIGHT = 900
/** Canvas is host client size minus one scrollbar (18px) on each axis. */
const SCROLLBAR = 18
/** Comfort padding so the last column/row is not flush against the edge. */
const CONTENT_PAD = 8
/** Smallest content-driven host (a blank default sheet still shows ~2×2 cells). */
const MIN_WIDTH = 300
const MIN_HEIGHT = 200
/** Empty-sheet fallback viewport (canvas ≈ 900×400). */
const EMPTY_WIDTH = 918
const EMPTY_HEIGHT = 418
/** Size the screenshot renders cell text at. */
const FONT_SIZE = 14

const require = createRequire(import.meta.url)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Rasterize the active sheet of an .ssjson file to a PNG Buffer. Reads and parses
 * the file itself, classifying failures like the other operations.
 */
export async function renderWorkbookToPng(
  env: { GC: Gc; window: any },
  sourcePath: string,
): Promise<PngRenderResult> {
  const { GC, window } = env

  let jsonText: string
  try {
    jsonText = await readFile(sourcePath, 'utf8')
  } catch (error) {
    throw new SjsWorkerError(`cannot read workbook file: ${errorMessage(error)}`, 'SJS_FILE_READ_FAILED')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    throw new SjsWorkerError(`workbook file is not valid .ssjson JSON: ${errorMessage(error)}`, 'SJS_INVALID_SSJSON')
  }
  // Parse fresh per render so the two workbooks never share a mutated object.
  const jsonFor = (): unknown => JSON.parse(JSON.stringify(parsed))

  const font = pickAndRegisterFont()
  if (font === null) {
    throw new SjsWorkerError(
      '找不到可渲染 PNG 的字体：需要至少一个 .ttf/.otf（不支持 .ttc）。可用环境变量 GC_SJS_PDF_FONT_DIRS 指向含 simhei.ttf / Deng.ttf 等的目录。',
      'SJS_PNG_FONT_UNAVAILABLE',
    )
  }

  // Render 1: measure the used content box in host pixel coordinates.
  const measure = await measureWorkbook(GC, window, jsonFor(), font)

  // Fit the host so its canvas (= host − scrollbar) holds the content exactly.
  // Only a truly empty sheet falls back to the fixed viewport; content uses its
  // own box (a large fallback floor would otherwise pad real sheets with blank).
  const contentW = measure.contentWidth
  const contentH = measure.contentHeight
  const clipped = contentW > MAX_WIDTH - SCROLLBAR - CONTENT_PAD || contentH > MAX_HEIGHT - SCROLLBAR - CONTENT_PAD
  let hostW: number
  let hostH: number
  if (measure.used === null) {
    hostW = EMPTY_WIDTH
    hostH = EMPTY_HEIGHT
  } else {
    hostW = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(contentW) + SCROLLBAR + CONTENT_PAD))
    hostH = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(contentH) + SCROLLBAR + CONTENT_PAD))
  }

  // Render 2: capture at the exact fitted size.
  const { png, canvasWidth, canvasHeight } = await captureWorkbook(GC, window, jsonFor(), hostW, hostH, font, measure)
  return {
    png,
    width: canvasWidth,
    height: canvasHeight,
    clipped,
    sheet: measure.sheetName,
    used: measure.used,
    font,
  }
}

/** Create a jsdom host div whose geometry reads as the requested CSS size. */
function makeHost(window: any, width: number, height: number): any {
  const el = window.document.createElement('div')
  el.id = `sjs-shot-${Math.random().toString(36).slice(2)}`
  el.setAttribute('style', `width:${width}px;height:${height}px;`)
  window.document.body.appendChild(el)
  // SpreadJS measures host size through clientWidth/clientHeight/offset*. jsdom
  // reports 0 for these, so host-LOCAL getters return the intended pixels.
  Object.defineProperties(el, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
    offsetWidth: { configurable: true, get: () => width },
    offsetHeight: { configurable: true, get: () => height },
  })
  return el
}

function usedRangeOf(sheet: any, GC: Gc): { row: number; rowCount: number; col: number; colCount: number } | null {
  try {
    const type = GC.Spread.Sheets.UsedRangeType
    const range = sheet.getUsedRange(type.data | type.formula)
    if (range === null || range === undefined) return null
    const { row, rowCount, col, colCount } = range
    if (typeof row !== 'number' || typeof col !== 'number') return null
    const bound = (count: unknown, origin: number, sheetCount: number): number | undefined => {
      const n = typeof count === 'number' && Number.isFinite(count) ? count : NaN
      const span = Number.isNaN(n) || n < 1 ? sheetCount - origin : n
      return span >= 1 ? span : undefined
    }
    const rCount = bound(rowCount, row, sheet.getRowCount())
    const cCount = bound(colCount, col, sheet.getColumnCount())
    if (rCount === undefined || cCount === undefined) return null
    return { row, rowCount: rCount, col, colCount: cCount }
  } catch {
    return null
  }
}

/** Render pass 1: fit content to a generous host, then read the used-box rect. */
async function measureWorkbook(
  GC: Gc,
  window: any,
  json: unknown,
  font: string,
): Promise<Measure> {
  const host = makeHost(window, MEASURE_WIDTH, MEASURE_HEIGHT)
  const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 0 })
  try {
    spread.fromJSON(json)
    const sheet = spread.getActiveSheet()
    const sheetName = typeof sheet?.name === 'function' ? String(sheet.name() ?? '') : ''
    const used = sheet === undefined || sheet === null ? null : usedRangeOf(sheet, GC)
    if (sheet !== undefined && sheet !== null && sheet.refresh !== undefined) sheet.refresh()
    spread.refresh()
    await sleep(160) // let the first paint settle so getCellRect is measurable
    if (used === null || sheet === undefined || sheet === null) {
      return { used: null, contentWidth: 0, contentHeight: 0, sheetName }
    }
    const lastRow = used.row + used.rowCount - 1
    const lastCol = used.col + used.colCount - 1
    const rect = sheet.getCellRect(lastRow, lastCol)
    if (rect === null || rect === undefined || typeof rect.x !== 'number' || Number.isNaN(rect.x)) {
      throw new SjsWorkerError('无法测量工作表内容范围（getCellRect 无效）', 'SJS_PNG_RENDER_FAILED')
    }
    return {
      used,
      contentWidth: rect.x + rect.width,
      contentHeight: rect.y + rect.height,
      sheetName,
    }
  } catch (error) {
    if (error instanceof SjsWorkerError) throw error
    throw new SjsWorkerError(`测量工作表失败: ${errorMessage(error)}`, 'SJS_PNG_RENDER_FAILED')
  } finally {
    try {
      spread.destroy()
    } catch {
      // best-effort cleanup inside a one-shot process
    }
    host.remove()
  }
}

/** Render pass 2: constructor-bind a host of the measured size and capture PNG. */
async function captureWorkbook(
  GC: Gc,
  window: any,
  json: unknown,
  hostWidth: number,
  hostHeight: number,
  font: string,
  measure: Measure,
): Promise<{ png: Buffer; canvasWidth: number; canvasHeight: number }> {
  const host = makeHost(window, hostWidth, hostHeight)
  const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 0 })
  try {
    spread.fromJSON(json)
    const sheet = spread.getActiveSheet()
    if (sheet !== undefined && sheet !== null) {
      // Uniform readable font so CJK actually rasterizes (see file header note).
      const used = measure.used
      const rows = used === null ? 1 : Math.min(used.row + used.rowCount, sheet.getRowCount())
      const cols = used === null ? 1 : Math.min(used.col + used.colCount, sheet.getColumnCount())
      try {
        sheet.getRange(0, 0, rows, cols).font(`${FONT_SIZE}px ${font}`)
        sheet.getRange(0, 0, rows, cols).foreColor('black')
      } catch {
        // Range styling is best-effort; layout/canvas capture still proceeds.
      }
      if (sheet.refresh !== undefined) sheet.refresh()
    }
    spread.refresh()
    await sleep(300) // settle the paint before reading canvas pixels

    const canvases: any[] = []
    for (const canvas of host.querySelectorAll('canvas')) canvases.push(canvas)
    canvases.sort((a, b) => b.width * b.height - a.width * a.height)
    const canvas = canvases[0]
    if (canvas === undefined) {
      throw new SjsWorkerError('渲染后找不到画布（canvas 模块可能未加载）', 'SJS_PNG_RENDER_FAILED')
    }
    let dataUrl: string
    try {
      dataUrl = canvas.toDataURL('image/png')
    } catch (error) {
      throw new SjsWorkerError(`canvas 编码 PNG 失败: ${errorMessage(error)}`, 'SJS_PNG_RENDER_FAILED')
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const png = Buffer.from(base64, 'base64')
    if (png.length === 0) throw new SjsWorkerError('canvas 输出为空 PNG', 'SJS_PNG_RENDER_FAILED')
    return { png, canvasWidth: canvas.width, canvasHeight: canvas.height }
  } catch (error) {
    if (error instanceof SjsWorkerError) throw error
    throw new SjsWorkerError(`截图渲染失败: ${errorMessage(error)}`, 'SJS_PNG_RENDER_FAILED')
  } finally {
    try {
      spread.destroy()
    } catch {
      // best-effort cleanup inside a one-shot process
    }
    host.remove()
  }
}

/**
 * Pick one registered-family candidate (CJK preferred, no whitespace so the CSS
 * `14px <family>` SpreadJS writes stays parseable) and register it into
 * node-canvas. Returns the family name, or null when nothing registered.
 */
function pickAndRegisterFont(): string | null {
  let canvasPkg: any
  try {
    canvasPkg = require('canvas')
  } catch {
    return null
  }
  const fonts = discoverPdfFonts()
  if (fonts.length === 0) return null
  const noSpace = fonts.filter((f) => /^[A-Za-z0-9_-]+$/.test(f.family))
  const pool = noSpace.length > 0 ? noSpace : fonts
  // Prefer a CJK/no-space candidate; register that family first so it wins,
  // plus one ASCII fallback so latin text has a partner if the CJK face is thin.
  const chosen = pool.find((f) => f.cjk) ?? pool[0]
  if (chosen === undefined) return null
  const candidates = [chosen]
  const anyFallback = pool.find((f) => f.family !== chosen.family)
  if (anyFallback !== undefined) candidates.push(anyFallback)
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    try {
      canvasPkg.registerFont(candidate.file, { family: candidate.family })
      if (candidate.family === chosen.family) return chosen.family
    } catch {
      // broken font file: try the next candidate
    }
  }
  return null
}
