/** Probe 9: map getCellRect() px coordinates onto the painted canvas; locate the
 *  row-number header column width and column-letter header row height as painted. */
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'probe-out')
mkdirSync(OUT, { recursive: true })

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

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')
const W = 1400, H = 900
const host = window.document.createElement('div')
host.id = 'host'
host.setAttribute('style', `width:${W}px;height:${H}px;`)
window.document.body.appendChild(host)
Object.defineProperties(host, {
  clientWidth: { configurable: true, get: () => W }, clientHeight: { configurable: true, get: () => H },
  offsetWidth: { configurable: true, get: () => W }, offsetHeight: { configurable: true, get: () => H },
})
const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
const sheet = spread.getActiveSheet()
for (let c = 0; c < 5; c++) sheet.setColumnWidth(c, 150)
for (let r = 0; r < 5; r++) sheet.setRowHeight(r, 24)
sheet.setValue(0, 0, '姓名'); sheet.setValue(0, 1, '部门')
for (let r = 1; r <= 4; r++) { sheet.setValue(r, 0, '名字' + r); sheet.setValue(r, 1, '部门' + r) }
spread.refresh()
await new Promise((r) => setTimeout(r, 400))
const canvas = [...host.querySelectorAll('canvas')].sort((a, b) => b.width - a.width)[0]
const C = canvas.getContext('2d')
const d = C.getImageData(0, 0, canvas.width, canvas.height).data
const px = (x, y) => (y * canvas.width + x) * 4

// Locate painted content: first row with non-white at left (row-number header top? col letters row)
// Scan for the row-number header RIGHT edge (first strong vertical dark line after x=10)
function colIsDark(x) { let n = 0; for (let y = 40; y < canvas.height; y += 3) { const p = px(x, y); if (d[p + 3] > 220 && d[p] + d[p + 1] + d[p + 2] < 320) n++ } return n > (canvas.height / 3) }
function rowIsDark(y) { let n = 0; for (let x = 60; x < canvas.width; x += 3) { const p = px(x, y); if (d[p + 3] > 220 && d[p] + d[p + 1] + d[p + 2] < 320) n++ } return n > (canvas.width / 3) }
let headerRight = null
for (let x = 8; x < 200; x++) if (colIsDark(x)) { headerRight = x; break }
let headerBottom = null
for (let y = 4; y < 120; y++) if (rowIsDark(y)) { headerBottom = y; break }
console.log('canvas', canvas.width + 'x' + canvas.height, 'painted headerRight≈', headerRight, 'headerBottom≈', headerBottom)

for (const [r, c] of [[0, 0], [1, 0], [4, 4]]) {
  const rect = sheet.getCellRect(r, c)
  console.log(`getCellRect(${r},${c}) =`, JSON.stringify(rect))
}
console.log('sheet.zoom()=', sheet.zoom())
console.log('default col width check: getColumnWidth(9)=', sheet.getColumnWidth(9), 'getRowHeight(9)=', sheet.getRowHeight(9))

// Write PNG + a second one cropped by header origin + cellrect of bottom-right content
writeFileSync(join(OUT, 'probe9-full.png'), Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64'))
process.exit(0)
