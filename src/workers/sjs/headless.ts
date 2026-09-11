/**
 * Headless environment bootstrap (port of the phase-0 spike `headless.js` to ESM).
 *
 * Lets SpreadJS run under plain Node by installing a minimal DOM shim before the
 * @grapecity-software UMD bundles are loaded via createRequire:
 *   1. jsdom provides document/window/navigator/getComputedStyle and friends.
 *   2. Every jsdom `window` property is copied onto the Node global.
 *   3. `global.self` / `global.canvas` are injected (SpreadJS lazy modules
 *      reference both free variables — a missing canvas breaks `new Workbook()`).
 *   4. jsdom `FileReader.result` is patched so cross-realm ArrayBuffers are copied
 *      into the Node realm (spread-sheets-io / JSZip type-check `instanceof ArrayBuffer`).
 *
 * Only stdout is reserved for the worker envelope; every diagnostic here goes to
 * stderr via `console.warn`. The @grapecity-software and jsdom packages ship no
 * usable type declarations from this package's resolution, so this boundary stays
 * loosely typed (any) exactly like the phase-0 spike probes.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** GC namespace and DOM handles, all loosely typed at the worker boundary. */
export interface HeadlessEnvironment {
  readonly GC: any
  readonly dom: any
  readonly window: any
  readonly loadedOptional: readonly string[]
}

let cached: HeadlessEnvironment | undefined

/** Boot SpreadJS once per worker process and return the shared environment. */
export function loadSpreadJS(): HeadlessEnvironment {
  if (cached !== undefined) return cached

  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="host"></div></body></html>', {
    pretendToBeVisual: true, // requestAnimationFrame
    url: 'http://localhost/',
    runScripts: 'outside-only',
  })
  const window = dom.window as any

  // Copy window globals onto the Node global.
  const nodeGlobal = globalThis as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(window)) {
    if (!(key in nodeGlobal)) {
      nodeGlobal[key] = window[key]
    }
  }

  // Some globals (Node 24 `navigator` etc.) are read-only getters: override by
  // redefining the property instead of assignment.
  const setGlobal = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  setGlobal('self', window)
  setGlobal('window', window)
  setGlobal('document', window.document)
  setGlobal('navigator', window.navigator)
  setGlobal('HTMLElement', window.HTMLElement)
  setGlobal('Element', window.Element)
  setGlobal('Node', window.Node)
  for (const key of ['Event', 'KeyboardEvent', 'MouseEvent', 'TouchEvent', 'URL', 'getComputedStyle']) {
    const value = window[key]
    if (value !== undefined && !(key in globalThis)) setGlobal(key, value)
  }
  // Force jsdom's Blob/File/FileReader/TextEncoder over Node's (same-realm IO).
  for (const key of ['Blob', 'File', 'FileReader', 'TextEncoder', 'TextDecoder']) {
    const value = window[key]
    if (value !== undefined) setGlobal(key, value)
  }

  patchFileReaderRealm(window)

  // canvas is a native (node-gyp) module; only needed for pixel paths. Workbook
  // construction itself references the free variable, so a missing module is
  // fatal for us — but degrade with a clear stderr message rather than a crash.
  try {
    const canvasModule = require('canvas')
    setGlobal('canvas', canvasModule)
    // jsdom defines the canvas constructors on `window` only when IT can resolve
    // the optional `canvas` package; under an isolated/hoisted layout it usually
    // cannot, so the paint path that reads them throws
    // "CanvasRenderingContext2D is not defined" — spreadsheet number formatters
    // reach it through text measurement, which makes png/pdf rendering fail on
    // any sheet carrying a formatter. Fill those holes from the node-canvas
    // module we just loaded, on the Node global AND the jsdom window
    // (jsdom-realm code reads the window copy). Only missing keys are filled, so
    // a jsdom definition that does exist is never clobbered.
    for (const key of [
      'Canvas',
      'CanvasRenderingContext2D',
      'CanvasGradient',
      'CanvasPattern',
      'ImageData',
      'Image',
      'Path2D',
      'DOMMatrix',
      'DOMPoint',
    ]) {
      const value = canvasModule[key] ?? window[key]
      if (value === undefined) continue
      if (!(key in globalThis)) setGlobal(key, value)
      if (window[key] === undefined) {
        try {
          window[key] = value
        } catch {
          // a non-writable jsdom window property: the Node global suffices
        }
      }
    }
  } catch (error) {
    console.warn('[sjs] canvas module unavailable (pixel paths will fail):', (error as Error).message)
  }

  // SpreadJS core + IO. Optional feature packs are loaded best-effort.
  const GC = require('@grapecity-software/spread-sheets')
  require('@grapecity-software/spread-sheets-io')
  const optional: ReadonlyArray<[string, string]> = [
    ['spread-sheets-shapes', '@grapecity-software/spread-sheets-shapes'],
    ['spread-sheets-charts', '@grapecity-software/spread-sheets-charts'],
    // pdf must be loaded AFTER print.
    ['spread-sheets-print', '@grapecity-software/spread-sheets-print'],
    ['spread-sheets-pdf', '@grapecity-software/spread-sheets-pdf'],
    ['spread-sheets-pivot', '@grapecity-software/spread-sheets-pivot-addon'],
  ]
  const loadedOptional: string[] = []
  for (const [name, pkg] of optional) {
    try {
      require(pkg)
      loadedOptional.push(name)
    } catch {
      // Missing optional packs do not affect core data/calc/IO/PDF paths.
    }
  }

  cached = { GC, dom, window, loadedOptional }
  return cached
}

/** Copy jsdom-realm ArrayBuffers into the Node realm on FileReader reads. */
function patchFileReaderRealm(window: any): void {
  const fileReader = window.FileReader
  if (fileReader === undefined || fileReader.prototype === undefined) return
  const resultDescriptor = Object.getOwnPropertyDescriptor(fileReader.prototype, 'result')
  if (resultDescriptor === undefined || resultDescriptor.get === undefined) return
  const originalGet = resultDescriptor.get
  Object.defineProperty(fileReader.prototype, 'result', {
    get(this: unknown): string | ArrayBuffer | null {
      const value = originalGet.call(this) as unknown
      if (
        typeof value === 'object' && value !== null &&
        (value as { constructor: { name: string } }).constructor.name === 'ArrayBuffer' &&
        !(value instanceof ArrayBuffer)
      ) {
        const copy = new ArrayBuffer((value as ArrayBuffer).byteLength)
        new Uint8Array(copy).set(new Uint8Array(value as ArrayBuffer))
        return copy
      }
      return value as string | ArrayBuffer | null
    },
    configurable: resultDescriptor.configurable,
    enumerable: resultDescriptor.enumerable,
  })
}
