/** Probe 12: END-TO-END worker algorithm — setHost on an already-loaded workbook,
 *  content-fit sizing from getCellRect, forced simhei font, canvas capture. This
 *  mirrors exactly what the sjs_screenshot PNG op will do. */
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
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

// Register discovered TTFs (mirror fonts.ts discovery, but for node-canvas).
const fontDir = 'C:/Windows/Fonts'
const registered = []
for (const entry of readdirSync(fontDir)) {
  const lower = entry.toLowerCase()
  if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) continue
  const base = lower.slice(0, -4)
  try { CanvasPkg.registerFont(join(fontDir, entry), { family: base }); registered.push(base) } catch {}
}
const cjkFam = registered.find((f) => /simhei|msyh|simsun|simfang|deng/.test(f)) ?? registered[0]
console.log('registered', registered.length, 'fonts; using family', cjkFam)

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')

// 1) load workbook host-less (as the real worker does).
const spread = new GC.Spread.Sheets.Workbook()
spread.addSheet(0)
const sheet = spread.getActiveSheet()
sheet.name('工资表')
for (let c = 0; c < 5; c++) sheet.setColumnWidth(c, 150)
const hdr = ['姓名', '部门', '基本工资', '奖金', '实发']
hdr.forEach((v, c) => sheet.setValue(0, c, v))
const rows = [['张伟', '销售部', 8000, 1200, '=C2+D2'], ['王芳', '技术部', 9500, 1500, '=C3+D3'], ['李娜', '财务部', 7000, 800, '=C4+D4'], ['刘洋', '市场部', 8600, 1100, '=C5+D5']]
rows.forEach((r, ri) => r.forEach((v, ci) => (typeof v === 'string' && v.startsWith('=') ? sheet.setFormula(ri + 1, ci, v) : sheet.setValue(ri + 1, ci, v))))

// 2) content-fit sizing from bounded used range.
const type = GC.Spread.Sheets.UsedRangeType
const used = sheet.getUsedRange(type.data | type.formula)
const lastRow = used ? used.row + used.rowCount - 1 : 0
const lastCol = used ? used.col + used.colCount - 1 : 0
console.log('used', JSON.stringify(used), 'lastRow', lastRow, 'lastCol', lastCol)
const br = sheet.getCellRect(lastRow, lastCol)
const contentW = br.x + br.width
const contentH = br.y + br.height
const clientW = contentW + 18 + 40   // scrollbar + right pad
const clientH = contentH + 18 + 40   // scrollbar + bottom pad
console.log('contentW/H', contentW, contentH, '-> clientW/H', clientW, clientH)

// 3) host + setHost.
const host = window.document.createElement('div')
host.id = 'sjs-shot'
host.setAttribute('style', `width:${clientW}px;height:${clientH}px;`)
window.document.body.appendChild(host)
Object.defineProperties(host, {
  clientWidth: { configurable: true, get: () => clientW }, clientHeight: { configurable: true, get: () => clientH },
  offsetWidth: { configurable: true, get: () => clientW }, offsetHeight: { configurable: true, get: () => clientH },
})
spread.setHost(host)
spread.refresh()
await new Promise((r) => setTimeout(r, 400))

// 4) force font on used box, repaint.
const rowsC = Math.min(lastRow + 1, sheet.getRowCount())
const colsC = Math.min(lastCol + 1, sheet.getColumnCount())
sheet.getRange(0, 0, rowsC, colsC).font(`14px ${cjkFam}`)
spread.refresh()
await new Promise((r) => setTimeout(r, 300))

const canvases = [...host.querySelectorAll('canvas')].sort((a, b) => b.width - a.width)
console.log('canvas sizes:', canvases.map((c) => `${c.width}x${c.height}`).join(', '))
const canvas = canvases[0]
const ctx = canvas.getContext('2d')
const url = canvas.toDataURL('image/png')
const buf = Buffer.from(url.split(',')[1], 'base64')
writeFileSync(join(OUT, 'probe12.png'), buf)
console.log('probe12.png bytes', buf.length)
// glyph proof: count dark text pixels in content region (exclude header sep area)
const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
let text = 0
for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const p = (y * canvas.width + x) * 4; if (d[p + 3] > 200 && d[p] + d[p + 1] + d[p + 2] < 300) text++ }
console.log('dark text px (whole canvas incl headers/grid) =', text)
process.exit(0)
