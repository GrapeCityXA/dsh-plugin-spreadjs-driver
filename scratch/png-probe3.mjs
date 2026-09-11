/** Probe 3: how does SpreadJS size its viewport canvases headlessly? */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="host"></div></body></html>', {
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

// Instrument element geometry reads during construction to see what SpreadJS asks for.
const reads = new Map()
const logRead = (prop, elt, val) => {
  const tag = elt && elt.id ? `#${elt.id}` : elt && elt.className ? `.${String(elt.className).slice(0, 30)}` : elt?.nodeName ?? '?'
  const k = `${prop}@${tag}`
  reads.set(k, (reads.get(k) || 0) + 1)
}
const WP = 800, HP = 600
for (const prop of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight', 'scrollWidth', 'scrollHeight']) {
  const dim = prop.endsWith('Width') ? WP : HP
  Object.defineProperty(window.Element.prototype, prop, {
    configurable: true, get() { logRead(prop, this, dim); return dim },
  })
}
window.Element.prototype.getBoundingClientRect = function () {
  logRead('rect', this, '800x600'); return { x: 0, y: 0, top: 0, left: 0, right: WP, bottom: HP, width: WP, height: HP }
}

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')
const host = window.document.getElementById('host')
const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
const sheet = spread.getActiveSheet()
for (let c = 0; c < 4; c++) sheet.setColumnWidth(c, 110)
sheet.setValue(0, 0, '产品'); sheet.setValue(0, 1, '数量'); sheet.setValue(0, 2, '单价')
sheet.setValue(1, 0, '苹果'); sheet.setValue(1, 1, 10); sheet.setValue(1, 2, 5.5)
sheet.setValue(2, 0, '香蕉'); sheet.setValue(2, 1, 20); sheet.setValue(2, 2, 3.2)
sheet.setValue(3, 0, '合计'); sheet.setFormula(3, 1, '=SUM(B2:B3)')

const sized = () => [...host.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height}`)
console.log('canvas sizes right after bind+paint:', sized().join(', '))
console.log('geometry reads during construction:', JSON.stringify([...reads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25), null, 0))

// Enumerate sizing-related members on the workbook + a sheet view.
const probeMember = (obj, label) => {
  const names = new Set()
  let o = obj
  while (o) { for (const k of Object.getOwnPropertyNames(o)) names.add(k); o = Object.getPrototypeOf(o) }
  const hits = [...names].filter((k) => /size|resize|viewport|repaint|refresh|paint|setHost|measure|panel/i.test(k))
  console.log(`${label} size/paint members:`, hits.slice(0, 40).join(', '))
}
probeMember(spread, 'workbook')
const view = spread.getSheetView ? undefined : undefined
try { probeMember(spread.getActiveSheetView?.() ?? {}, 'sheetView') } catch {}

// Try resize triggers one at a time, re-measuring after each.
const resizeTriggers = [
  ['window resize event', () => window.dispatchEvent(new window.Event('resize'))],
  ['refresh()', () => spread.refresh()],
  ['invalidateLayout', () => { sheet.invalidateLayout(); spread.refresh() }],
]
for (const [label, fn] of resizeTriggers) {
  try { fn() } catch (e) { console.log(`  ${label} threw ${e.message}`); continue }
  await new Promise((r) => setTimeout(r, 120))
  console.log(`after ${label}:`, sized().join(', '))
}
process.exit(0)
