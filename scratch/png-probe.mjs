/**
 * Task-5 bounded experiment (probe 2): force a fake viewport on EVERY element so
 * SpreadJS's inner-container measurement sees 800x600, then find a byte path off
 * the painted canvases.
 */
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'probe-out')
mkdirSync(OUT, { recursive: true })

const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true, url: 'http://localhost/', runScripts: 'outside-only',
})
const window = dom.window
for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globalThis)) globalThis[key] = window[key]
}
const setGlobal = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
setGlobal('self', window); setGlobal('window', window); setGlobal('document', window.document)
setGlobal('navigator', window.navigator); setGlobal('HTMLElement', window.HTMLElement)
setGlobal('Element', window.Element); setGlobal('Node', window.Node)
for (const key of ['Event', 'KeyboardEvent', 'MouseEvent', 'TouchEvent', 'URL', 'getComputedStyle']) {
  if (window[key] !== undefined && !(key in globalThis)) setGlobal(key, window[key])
}
try { setGlobal('canvas', require('canvas')) } catch (e) { console.log('canvas module unavailable:', e.message) }

// Fake a global 800x600 viewport for every element (and default to W×H for any
// canvas SpreadJS measures) — jsdom computes no layout at all.
const WP = 800, HP = 600
for (const prop of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight', 'scrollWidth', 'scrollHeight']) {
  const dim = prop.endsWith('Width') ? WP : HP
  Object.defineProperty(window.Element.prototype, prop, { configurable: true, get() { return dim } })
}
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: WP, bottom: HP, width: WP, height: HP }
}
const origGetComputedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = (elt, pseudo) => {
  const style = origGetComputedStyle(elt, pseudo)
  try {
    Object.defineProperty(style, 'width', { configurable: true, get: () => (elt === window.document.body || elt === window.document.documentElement ? '100%' : '800px') })
    Object.defineProperty(style, 'height', { configurable: true, get: () => '600px' })
    Object.defineProperty(style, 'font', { configurable: true, get: () => '14px sans-serif' })
  } catch {}
  return style
}

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')

const host = window.document.getElementById('host')
const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
const sheet = spread.getActiveSheet()
sheet.name('Probe')
for (let c = 0; c < 4; c++) sheet.setColumnWidth(c, 110)
sheet.setValue(0, 0, '产品'); sheet.setValue(0, 1, '数量'); sheet.setValue(0, 2, '单价')
sheet.setValue(1, 0, '苹果'); sheet.setValue(1, 1, 10); sheet.setValue(1, 2, 5.5)
sheet.setValue(2, 0, '香蕉'); sheet.setValue(2, 1, 20); sheet.setValue(2, 2, 3.2)
sheet.setValue(3, 0, '合计'); sheet.setFormula(3, 1, '=SUM(B2:B3)')

for (const fn of [() => spread.refresh(), () => sheet.invalidateLayout()]) { try { fn() } catch (e) { console.log('paint step threw', e.message) } }
await new Promise((r) => setTimeout(r, 400))

const canvases = [...host.querySelectorAll('canvas')]
console.log('canvas count:', canvases.length)

const extract = async (c, i) => {
  const out = { index: i, width: c.width, height: c.height }
  const ctx = c.getContext('2d')
  out.ctxCtor = ctx?.constructor?.name
  // 1) spec toDataURL
  if (typeof c.toDataURL === 'function') {
    try { const d = c.toDataURL('image/png'); out.toDataURL = d.length; out.toDataURLPrefix = d.slice(0, 22) } catch (e) { out.toDataURLError = e.message }
  }
  // 2) jsdom backing: the node-canvas Canvas is usually reachable via the 2d context's own canvas or internal slot
  const backingKeys = Object.getOwnPropertyNames(c).filter((k) => /canvas|back|node/i.test(k))
  out.elementKeys = backingKeys
  for (const k of backingKeys) {
    const v = c[k]
    if (v && typeof v.toBuffer === 'function') { try { out.backingBuffer = v.toBuffer('image/png').length } catch (e) { out.backingError = e.message } }
  }
  // 3) node-canvas registers its context; ctx.canvas may be the jsdom element, but the real
  //    node-canvas instance is often ctx.canvas's internal or the context itself has a backing.
  const reachable = [ctx?.canvas, ctx?.nodeCanvas, ctx?._canvas]
  reachable.forEach((v, ri) => {
    if (v && typeof v.toBuffer === 'function') {
      try { out[`reachable${ri}Buffer`] = v.toBuffer('image/png').length } catch (e) { out[`reachable${ri}Error`] = e.message }
    }
  })
  // 4) raw pixel access via getImageData
  try {
    const img = ctx.getImageData(0, 0, c.width, c.height)
    let nonBlank = 0
    for (let p = 3; p < img.data.length; p += 4) if (img.data[p] !== 0) nonBlank++
    out.getImageDataPixels = c.width * c.height
    out.nonBlankPixels = nonBlank
  } catch (e) { out.getImageDataError = e.message }
  return out
}

for (let i = 0; i < canvases.length; i++) {
  const info = await extract(canvases[i], i)
  console.log(`canvas ${i}:`, JSON.stringify(info))
}

// If any canvas has a real backing, dump a PNG for eyeballing.
for (let i = 0; i < canvases.length; i++) {
  const c = canvases[i]
  const ctx = c.getContext('2d')
  try {
    const dataUrl = c.toDataURL('image/png')
    if (dataUrl.startsWith('data:image/png')) {
      writeFileSync(join(OUT, `canvas-${i}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'))
      console.log(`wrote canvas-${i}.png from toDataURL`)
    }
  } catch {}
}
process.exit(0)
