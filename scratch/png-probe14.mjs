/** Probe 14: FINAL worker pipeline, constructor-bound hosts only (no setHost).
 *  A) build json from host-less builder -> serialize (mirrors ssjson on disk)
 *  B) render A: 1400x900 constructor-host Workbook, fromJSON, measure used-range
 *     rect -> target host size = content + 18 scrollbar (+ pad)
 *  C) render B: exact-size constructor-host Workbook, fromJSON, force font, capture
 */
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
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

// --- targeted fonts ------------------------------------------------------------------
const fonts = []
for (const entry of readdirSync('C:/Windows/Fonts')) {
  const lower = entry.toLowerCase()
  if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) continue
  const base = lower.slice(0, -4)
  if (!base || base.startsWith('.')) continue
  fonts.push({ family: base, file: join('C:/Windows/Fonts', entry), cjk: /simhei|msyh|simsun|simfang|simkai|deng|notosanscjk|wqy/.test(base) })
}
const fallbackCjk = fonts.find((f) => f.cjk) ?? fonts[0]
const fallbackAny = fonts[0]
for (const f of [fallbackCjk, fallbackAny]) { if (f) try { CanvasPkg.registerFont(f.file, { family: f.family }) } catch {} }
const dispFam = fallbackCjk?.family ?? fallbackAny?.family
console.log('fonts:', dispFam, '/', fallbackAny?.family)

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- build source workbook, serialize to json (what the worker would read from disk) --
function buildSource() {
  const wb = new GC.Spread.Sheets.Workbook()
  wb.addSheet(0)
  const s = wb.getActiveSheet()
  s.name('工资表')
  for (let c = 0; c < 5; c++) s.setColumnWidth(c, 150)
  s.setValue(0, 0, '姓名'); s.setValue(0, 1, '部门'); s.setValue(0, 2, '基本工资'); s.setValue(0, 3, '奖金'); s.setValue(0, 4, '实发')
  const rows = [['张伟', '销售部', 8000, 1200], ['王芳', '技术部', 9500, 1500], ['李娜', '财务部', 7000, 800], ['刘洋', '市场部', 8600, 1100]]
  rows.forEach((r, ri) => { const rr = ri + 1; r.forEach((v, ci) => s.setValue(rr, ci, v)); s.setFormula(rr, 4, `=C${rr + 1}+D${rr + 1}`) })
  return wb
}
const srcJson = buildSource().toJSON()
console.log('serialized ssjson keys:', Object.keys(srcJson).slice(0, 12).join(','))

function makeHost(cw, ch) {
  const el = window.document.createElement('div')
  el.id = 'h' + Math.random().toString(36).slice(2)
  el.setAttribute('style', `width:${cw}px;height:${ch}px;`)
  window.document.body.appendChild(el)
  Object.defineProperties(el, {
    clientWidth: { configurable: true, get: () => cw }, clientHeight: { configurable: true, get: () => ch },
    offsetWidth: { configurable: true, get: () => cw }, offsetHeight: { configurable: true, get: () => ch },
  })
  return el
}

// --- render A: measure ---------------------------------------------------------------
const hostA = makeHost(1400, 900)
const wbA = new GC.Spread.Sheets.Workbook(hostA, { sheetCount: 0 })
wbA.fromJSON(srcJson)
const shA = wbA.getActiveSheet()
shA.refresh?.(); wbA.refresh(); await sleep(300)
const used = shA.getUsedRange(GC.Spread.Sheets.UsedRangeType.data | GC.Spread.Sheets.UsedRangeType.formula)
const lastRow = used ? used.row + used.rowCount - 1 : 0
const lastCol = used ? used.col + used.colCount - 1 : 0
const rect = shA.getCellRect(lastRow, lastCol)
console.log('used', JSON.stringify(used), 'rect(last)=', JSON.stringify(rect))
const SCROLL = 18, PAD = 8
const hostW = Math.max(200, Math.ceil(rect.x + rect.width + SCROLL + PAD))
const hostH = Math.max(120, Math.ceil(rect.y + rect.height + SCROLL + PAD))
console.log('target host', hostW + 'x' + hostH)
// free A
wbA.destroy?.(); hostA.remove()

// --- render B: capture ---------------------------------------------------------------
const hostB = makeHost(hostW, hostH)
const wbB = new GC.Spread.Sheets.Workbook(hostB, { sheetCount: 0 })
wbB.fromJSON(srcJson)
const shB = wbB.getActiveSheet()
const r0 = shB.getCellRect(0, 0) // header origin
const rb = shB.getCellRect(lastRow, lastCol)
console.log('renderB rect(0,0)=', JSON.stringify(r0), 'rect(last)=', JSON.stringify(rb))
const nRows = Math.min(lastRow + 1, shB.getRowCount())
const nCols = Math.min(lastCol + 1, shB.getColumnCount())
shB.getRange(0, 0, nRows, nCols).font(`14px ${dispFam}`)
shB.getRange(0, 0, nRows, nCols).foreColor('black')
shB.refresh?.(); wbB.refresh(); await sleep(400)

const canvases = [...hostB.querySelectorAll('canvas')].sort((a, b) => b.width - a.width)
console.log('canvases:', canvases.map((c) => `${c.width}x${c.height}`).join(', '))
const canvas = canvases[0]
const C = canvas.getContext('2d')
const buf = Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64')
writeFileSync(join(OUT, 'probe14.png'), buf)
console.log('probe14.png', buf.length, 'bytes; canvas', canvas.width + 'x' + canvas.height, 'ctx.font=', JSON.stringify(C.font))

// ASCII verify: header cell '姓名' region between row-headers (right of row-header col) top area
const d = C.getImageData(0, 0, canvas.width, canvas.height).data
const px = (x, y) => (y * canvas.width + x) * 4
const X0 = Math.max(1, Math.floor(r0.x) + 4), Y0 = Math.max(1, Math.floor(r0.y) + 4)
const X1 = Math.min(canvas.width, X0 + 160), Y1 = Math.min(canvas.height, Y0 + 40)
const B = 2, chars = ' .:-=+*#%@'
console.log('ascii region', X0, Y0, '->', X1, Y1)
for (let by = Y0; by < Y1; by += B) {
  let line = ''
  for (let bx = X0; bx < X1; bx += B) {
    let dark = 0, tot = 0
    for (let y = by; y < Math.min(by + B, Y1); y++) for (let x = bx; x < Math.min(bx + B, X1); x++) { const p = px(x, y); tot++; if (d[p + 3] > 200 && d[p] + d[p + 1] + d[p + 2] < 430) dark++ }
    line += chars[Math.min(chars.length - 1, Math.floor(dark * 10 / tot))]
  }
  console.log(line)
}
let text = 0
for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const p = (y * canvas.width + x) * 4; if (d[p + 3] > 200 && d[p] + d[p + 1] + d[p + 2] < 300) text++ }
console.log('dark text px total =', text)
process.exit(0)
