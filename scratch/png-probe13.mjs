/** Probe 13: FINAL worker algorithm. Two-phase host (provisional -> sized),
 *  targeted font registration, used-box font forcing, canvas capture via toDataURL. */
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

// --- targeted font registration (discover like fonts.ts, register subset) ------
function discover() {
  const out = []
  const dir = 'C:/Windows/Fonts'
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const lower = entry.toLowerCase()
    if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) continue
    const base = lower.slice(0, -4)
    if (!base || base.startsWith('.')) continue
    out.push({ family: base, file: join(dir, entry), cjk: /simhei|msyh|simsun|simfang|simkai|deng|notosanscjk|wqy/.test(base) })
  }
  return out
}
const fonts = discover()
const fallbackCjk = fonts.find((f) => f.cjk) ?? fonts[0]
const fallbackAny = fonts[0]
for (const f of [fallbackCjk, fallbackAny]) {
  if (f) try { CanvasPkg.registerFont(f.file, { family: f.family }) } catch {}
}
const dispFam = (fallbackCjk?.family ?? fallbackAny?.family)
console.log('targeted registered:', dispFam, fallbackAny?.family)

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')

// --- load workbook host-less ---------------------------------------------------
const spread = new GC.Spread.Sheets.Workbook()
spread.addSheet(0)
const sheet = spread.getActiveSheet()
sheet.name('工资表')
for (let c = 0; c < 5; c++) sheet.setColumnWidth(c, 150)
const hdr = ['姓名', '部门', '基本工资', '奖金', '实发']
hdr.forEach((v, c) => sheet.setValue(0, c, v))
const rows = [['张伟', '销售部', 8000, 1200, '=C2+D2'], ['王芳', '技术部', 9500, 1500, '=C3+D3'], ['李娜', '财务部', 7000, 800, '=C4+D4'], ['刘洋', '市场部', 8600, 1100, '=C5+D5']]
rows.forEach((r, ri) => r.forEach((v, ci) => (typeof v === 'string' && v.startsWith('=') ? sheet.setFormula(ri + 1, ci, v) : sheet.setValue(ri + 1, ci, v))))

function makeHost(cw, ch, id) {
  const el = window.document.createElement('div')
  el.id = id
  el.setAttribute('style', `width:${cw}px;height:${ch}px;`)
  window.document.body.appendChild(el)
  let w = cw, h = ch
  const setSize = (ww, hh) => { w = ww; h = hh; el.setAttribute('style', `width:${ww}px;height:${hh}px;`) }
  Object.defineProperties(el, {
    clientWidth: { configurable: true, get: () => w }, clientHeight: { configurable: true, get: () => h },
    offsetWidth: { configurable: true, get: () => w }, offsetHeight: { configurable: true, get: () => h },
  })
  return { el, setSize }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const sleep = wait

const usedBox = () => {
  const type = GC.Spread.Sheets.UsedRangeType
  const used = sheet.getUsedRange(type.data | type.formula)
  const lastRow = used && typeof used.row === 'number' ? used.row + used.rowCount - 1 : 0
  const lastCol = used && typeof used.col === 'number' ? used.col + used.colCount - 1 : 0
  return { used, lastRow, lastCol }
}

// --- phase 1: provisional host so getCellRect works ----------------------------
const p1 = makeHost(600, 400, 'sjs-p1')
spread.setHost(p1.el)
spread.refresh(); await sleep(250)
const { used, lastRow, lastCol } = usedBox()
const br = sheet.getCellRect(lastRow, lastCol)
const contentW = br.x + br.width
const contentH = br.y + br.height
const SCROLL = 18, PAD = 40
const clientW = Math.max(120, Math.ceil(contentW + SCROLL + PAD))
const clientH = Math.max(120, Math.ceil(contentH + SCROLL + PAD))
console.log('used', JSON.stringify(used), 'contentW/H', contentW, contentH, '-> client', clientW, clientH)

// --- phase 2: final sized host, force font, repaint, capture --------------------
const p2 = makeHost(clientW, clientH, 'sjs-p2')
spread.setHost(p2.el)
const rc = Math.min(lastRow + 1, sheet.getRowCount())
const cc = Math.min(lastCol + 1, sheet.getColumnCount())
try { sheet.getRange(0, 0, rc, cc).font(`14px ${dispFam}`) } catch (e) { console.log('font force threw', e.message) }
spread.refresh()
await sleep(350)

const canvases = [...p2.el.querySelectorAll('canvas')].sort((a, b) => b.width - a.width)
console.log('canvas sizes:', canvases.map((c) => c.width + 'x' + c.height).join(', '))
const canvas = canvases[0]
const buf = Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64')
writeFileSync(join(OUT, 'probe13.png'), buf)
const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
let text = 0
for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) { const p = (y * canvas.width + x) * 4; if (d[p + 3] > 200 && d[p] + d[p + 1] + d[p + 2] < 300) text++ }
console.log('probe13.png bytes', buf.length, 'canvas', canvas.width + 'x' + canvas.height, 'darkTextPx', text)
process.exit(0)
