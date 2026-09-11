/** Probe 5: does ANY SpreadJS geometry read fire over a full lifecycle? Try
 *  (a) inline CSS size on host, (b) window resize, (c) refresh, and watch the
 *  wrapper div width for change. */
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

const reads = {}
const count = (k) => { reads[k] = (reads[k] || 0) + 1 }
for (const prop of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight']) {
  Object.defineProperty(window.Element.prototype, prop, { configurable: true, get() { count(prop); return 1200 } })
}
window.Element.prototype.getBoundingClientRect = function () { count('rect'); return { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0 } }
const gcs = window.getComputedStyle.bind(window)
window.getComputedStyle = (el) => { count('getComputedStyle'); const s = gcs(el); try { Object.defineProperty(s, 'width', { configurable: true, get: () => '1200px' }); Object.defineProperty(s, 'height', { configurable: true, get: () => '800px' }) } catch {} return s }

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')
const host = window.document.createElement('div')
host.id = 'host'
host.setAttribute('style', 'width:1200px;height:800px;')
window.document.body.appendChild(host)

const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
const sheet = spread.getActiveSheet()
for (let c = 0; c < 8; c++) sheet.setColumnWidth(c, 120)
sheet.setValue(0, 0, '产品'); sheet.setValue(0, 1, '数量')
for (let r = 1; r <= 10; r++) { sheet.setValue(r, 0, '苹果' + r); sheet.setValue(r, 1, r * 10) }
spread.refresh()
await new Promise((r) => setTimeout(r, 150))
console.log('after construct+refresh reads:', JSON.stringify(reads))
console.log('host children count:', host.childElementCount, 'first child style:', host.firstElementChild?.getAttribute('style'))

const wrapper = host.firstElementChild
const wrapperW = () => (wrapper?.style?.width ?? '?') + 'x' + (wrapper?.style?.height ?? '?')
console.log('wrapper inline size:', wrapperW())

window.dispatchEvent(new window.Event('resize')); await new Promise((r) => setTimeout(r, 250))
console.log('after window resize:', wrapperW(), 'reads:', JSON.stringify(reads))

try { spread.refresh(); sheet.invalidateLayout(); } catch {}
await new Promise((r) => setTimeout(r, 250))
console.log('after refresh+invalidate:', wrapperW(), 'reads:', JSON.stringify(reads))

// Directly attempt to force SpreadJS's size by touching known resize entry points if present.
for (const m of ['setHost', 'refresh', 'repaint']) {
  const fn = spread[m]
  if (typeof fn === 'function') { try { fn.call(spread, m === 'setHost' ? host : undefined) } catch (e) { console.log(m, 'threw', e.message) } }
}
await new Promise((r) => setTimeout(r, 250))
console.log('after re-setHost/refresh:', wrapperW())

// Manual: size the host canvas elements to 1200x800 then repaint — does more content show?
for (const c of host.querySelectorAll('canvas')) { c.width = 1200; c.height = 800 }
try { spread.refresh() } catch {}
await new Promise((r) => setTimeout(r, 250))
console.log('canvas sizes now:', [...host.querySelectorAll('canvas')].map((c) => c.width + 'x' + c.height).join(', '))
const main = [...host.querySelectorAll('canvas')].find((c) => {
  try { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let p = 0; p < d.length; p += 40) if (d[p + 3] !== 0) return true } catch {}
  return false
})
if (main) {
  const d = main.getContext('2d').getImageData(0, 0, main.width, main.height).data
  let n = 0
  for (let p = 3; p < d.length; p += 4) if (d[p] !== 0) n++
  console.log('main canvas', main.width + 'x' + main.height, 'nonBlank', n)
}
process.exit(0)
