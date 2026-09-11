/** Probe 6: sentinel-value mapping of SpreadJS size reads. Each geometry surface
 *  returns a distinct sentinel; whichever appears in the wrapper style identifies
 *  the real source SpreadJS trusts for width and height. */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  pretendToBeVisual: true, url: 'http://localhost/', runScripts: 'outside-only',
})
const window = dom.window
for (const key of Object.getOwnPropertyNames(window)) if (!(key in globalThis)) globalThis[key] = window[key]
const setGlobal = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
setGlobal('self', window); setGlobal('window', window); setGlobal('document', window.document)
setGlobal('navigator', window.navigator); setGlobal('HTMLElement', window.HTMLElement)
setGlobal('Element', window.Element); setGlobal('Node', window.Node)
for (const key of ['Event', 'KeyboardEvent', 'MouseEvent', 'TouchEvent', 'URL', 'getComputedStyle'])
  if (window[key] !== undefined && !(key in globalThis)) setGlobal(key, window[key])
try { setGlobal('canvas', require('canvas')) } catch (e) { console.log('canvas unavailable', e.message) }

const tags = {}
const tag = (el) => { const t = el?.id ? '#' + el.id : el?.className ? '.' + String(el.className).slice(0, 20) : el?.nodeName || '?'; return t }
Object.defineProperty(window.Element.prototype, 'clientWidth', { configurable: true, get() { return 1111 } })
Object.defineProperty(window.Element.prototype, 'clientHeight', { configurable: true, get() { return 2222 } })
Object.defineProperty(window.Element.prototype, 'offsetWidth', { configurable: true, get() { return 3333 } })
Object.defineProperty(window.Element.prototype, 'offsetHeight', { configurable: true, get() { return 4444 } })
Object.defineProperty(window.Element.prototype, 'scrollWidth', { configurable: true, get() { return 5555 } })
Object.defineProperty(window.Element.prototype, 'scrollHeight', { configurable: true, get() { return 6666 } })
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 7777, bottom: 8888, width: 7777, height: 8888 }
}
const gcs = window.getComputedStyle.bind(window)
window.getComputedStyle = (el) => {
  const s = gcs(el)
  for (const [p, v] of [['width', '9999px'], ['height', '9998px']]) {
    Object.defineProperty(s, p, { configurable: true, get: () => v })
  }
  return s
}

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')
const host = window.document.createElement('div')
host.id = 'host'
host.setAttribute('style', 'width: 200px; height: 200px;')
window.document.body.appendChild(host)
const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
const sheet = spread.getActiveSheet()
sheet.setValue(0, 0, 'hello'); sheet.setValue(0, 1, 'world')
spread.refresh()
await new Promise((r) => setTimeout(r, 100))
const inner = host.firstElementChild
console.log('wrapper inline size =', JSON.stringify({ w: inner?.style?.width, h: inner?.style?.height }))
console.log('canvas sizes =', [...host.querySelectorAll('canvas')].map((c) => c.width + 'x' + c.height).join(', '))
console.log('reads by surface (sentinel -> count):', JSON.stringify(tags))
process.exit(0)
