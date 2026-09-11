/** Probe 10: does CJK actually rasterize? Learn the font family SpreadJS paints
 *  with (read ctx.font post-paint) and test alias-registering simhei under common
 *  default family names so glyphs resolve. Fine-ASCII a header cell to confirm. */
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
const CanvasPkg = require('canvas')
setGlobal('canvas', CanvasPkg)

// Register simhei under its own name and a spread of default-family aliases.
const SIMHEI = 'C:/Windows/Fonts/simhei.ttf'
const aliases = ['simhei', 'SimHei', 'Calibri', 'Arial', 'sans-serif', 'Segoe UI', 'Microsoft YaHei', 'msyh']
for (const fam of aliases) { try { CanvasPkg.registerFont(SIMHEI, { family: fam }) } catch (e) { console.log('reg fail', fam, e.message) } }
console.log('registered simhei under:', aliases.join(', '))

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
spread.refresh()
await new Promise((r) => setTimeout(r, 400))
const canvas = [...host.querySelectorAll('canvas')].sort((a, b) => b.width - a.width)[0]
const C = canvas.getContext('2d')
console.log('ctx.font after paint =', JSON.stringify(C.font))

// fine ASCII of the '姓名' header cell region (x48..x230,y14..y44) at 2px blocks
const X0 = 46, Y0 = 12, X1 = 235, Y1 = 42, B = 2, chars = ' .:-=+*#%@'
const img = { w: canvas.width }
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
process.exit(0)
