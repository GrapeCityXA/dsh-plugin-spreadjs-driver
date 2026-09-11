/** Probe 11: force cell-range font to a registered family (simhei) and re-check
 *  whether SpreadJS then paints cell text under jsdom. */
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
const CanvasPkg = require('canvas')
setGlobal('canvas', CanvasPkg)
for (const fam of ['simhei', 'SimHei', 'sans-serif', 'Calibri', 'Arial', 'Microsoft YaHei']) {
  try { CanvasPkg.registerFont('C:/Windows/Fonts/simhei.ttf', { family: fam }) } catch {}
}

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')
const W = 900, H = 400
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
for (let c = 0; c < 4; c++) sheet.setColumnWidth(c, 180)
for (let r = 0; r < 3; r++) sheet.setRowHeight(r, 30)
const vals = [['姓名', '部门'], ['张伟', '销售部'], ['王芳', '技术部']]
vals.forEach((row, r) => row.forEach((v, c) => sheet.setValue(r, c, v)))
// Set explicit font on the whole used viewport range.
try {
  sheet.getRange(0, 0, 3, 2).font('16px simhei')
  sheet.getRange(0, 0, 3, 2).foreColor('black')
  console.log('range font applied')
} catch (e) { console.log('range.font threw', e.message) }
spread.refresh()
await new Promise((r) => setTimeout(r, 400))
const canvas = [...host.querySelectorAll('canvas')].sort((a, b) => b.width - a.width)[0]
const C = canvas.getContext('2d')
console.log('ctx.font after paint =', JSON.stringify(C.font))

const X0 = 46, Y0 = 8, X1 = 240, Y1 = 46, B = 2, chars = ' .:-=+*#%@'
const d = C.getImageData(0, 0, canvas.width, canvas.height).data
const px = (x, y) => (y * canvas.width + x) * 4
for (let by = Y0; by < Y1; by += B) {
  let line = ''
  for (let bx = X0; bx < X1; bx += B) {
    let dark = 0, tot = 0
    for (let y = by; y < Math.min(by + B, Y1); y++) for (let x = bx; x < Math.min(bx + B, X1); x++) { const p = px(x, y); tot++; if (d[p + 3] > 200 && d[p] + d[p + 1] + d[p + 2] < 430) dark++ }
    line += chars[Math.min(chars.length - 1, Math.floor(dark * 10 / tot))]
  }
  console.log(line)
}
const buf = Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64')
writeFileSync(join(OUT, 'probe11.png'), buf)
console.log('wrote probe11.png bytes', buf.length)
process.exit(0)
