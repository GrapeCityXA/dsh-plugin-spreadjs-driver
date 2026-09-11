/** Probe 4: inspect host DOM structure, workbook API surface, sheet-view internals. */
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

const WP = 1000, HP = 700
for (const prop of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight', 'scrollWidth', 'scrollHeight']) {
  const dim = prop.endsWith('Width') ? WP : HP
  Object.defineProperty(window.Element.prototype, prop, { configurable: true, get() { return dim } })
}
window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: WP, bottom: HP, width: WP, height: HP }
}

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')
const host = window.document.getElementById('host')
const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
const sheet = spread.getActiveSheet()
for (let c = 0; c < 6; c++) sheet.setColumnWidth(c, 110)
sheet.setValue(0, 0, '产品'); sheet.setValue(0, 1, '数量'); sheet.setValue(0, 2, '单价'); sheet.setValue(0, 3, '类别')
for (let r = 1; r <= 8; r++) { sheet.setValue(r, 0, '苹果' + r); sheet.setValue(r, 1, r * 10); sheet.setValue(r, 2, r * 1.1); sheet.setValue(r, 3, r % 2 ? 'A' : 'B') }
try { spread.refresh() } catch {}
await new Promise((r) => setTimeout(r, 200))

// 1) host DOM structure with classes + canvas tags
const describe = (el, depth, acc) => {
  if (depth > 4 || !el) return
  for (const child of el.childNodes) {
    const tag = child.nodeName === '#text' ? '#text' : child.nodeName.toLowerCase()
    if (tag === '#text') continue
    acc.push(`${'  '.repeat(depth)}<${tag} class="${(child.className && String(child.className)) || ''}" style="${(child.getAttribute && child.getAttribute('style')) || ''}">` + (child.nodeName === 'CANVAS' ? ` canvas w=${child.width} h=${child.height}` : ''))
    if (child.nodeName === 'CANVAS') continue
    describe(child, depth + 1, acc)
  }
}
const acc = []
describe(host, 0, acc)
console.log('HOST TREE:\n' + acc.slice(0, 60).join('\n'))

// 2) workbook API surface (all own + proto, first-level)
const allNames = (obj) => { const s = new Set(); let o = obj; while (o) { for (const k of Object.getOwnPropertyNames(o)) s.add(k); o = Object.getPrototypeOf(o) } return [...s] }
const names = allNames(spread).filter((k) => !/^_/.test(k)).sort()
console.log('\nWORKBOOK PUBLIC-ish members:', names.join(', '))

// 3) reach the active sheet view / viewport internals
for (const getter of ['getActiveSheetView', 'getSheetView', '_getActiveSheetView', 'getActiveSheet']) {
  try { const v = spread[getter] && spread[getter](); if (v) {
    const vn = allNames(v).filter((k) => !/^_/.test(k)).sort()
    console.log(`\n${getter}() -> members:`, vn.join(', '))
    break
  } } catch {}
}
process.exit(0)
