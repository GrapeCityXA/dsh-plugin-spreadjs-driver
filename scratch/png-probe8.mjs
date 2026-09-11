/** Probe 8: host-LOCAL geometry fake only (not global). Hypothesis: the global
 *  Element.prototype clientWidth/clientHeight fake in probe 7 polluted SpreadJS's
 *  internal layout divs; restricting the fake to the host element lets its own
 *  px-based column layout win while the viewport canvas still gets sized. */
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
try { setGlobal('canvas', require('canvas')) } catch (e) { console.log('canvas unavailable', e.message) }

// Register one CJK font for canvas text.
const CanvasPkg = require('canvas')
for (const f of ['C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/msyh.ttf', 'C:/Windows/Fonts/simfang.ttf', 'C:/Windows/Fonts/simsun.ttc']) {
  try { CanvasPkg.registerFont(f, { family: f.toLowerCase().includes('ttc') ? 'simsun' : 'cjk' }) } catch {}
}
const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')

const W = 1000, H = 620
const host = window.document.createElement('div')
host.id = 'host'
host.setAttribute('style', `width:${W}px;height:${H}px;`)
window.document.body.appendChild(host)
// HOST-LOCAL geometry fake only.
Object.defineProperties(host, {
  clientWidth: { configurable: true, get: () => W },
  clientHeight: { configurable: true, get: () => H },
  offsetWidth: { configurable: true, get: () => W },
  offsetHeight: { configurable: true, get: () => H },
})

const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
const sheet = spread.getActiveSheet()
sheet.name('工资表')
for (let c = 0; c < 5; c++) sheet.setColumnWidth(c, 150)
const rows = ['姓名', '部门', '基本工资', '奖金', '实发']
rows.forEach((v, c) => sheet.setValue(0, c, v))
const data = [
  ['张伟', '销售部', 8000, 1200, '=C2+D2'],
  ['王芳', '技术部', 9500, 1500, '=C3+D3'],
  ['李娜', '财务部', 7000, 800, '=C4+D4'],
  ['刘洋', '市场部', 8600, 1100, '=C5+D5'],
  ['陈静', '技术部', 12000, 2000, '=C6+D6'],
]
data.forEach((r, ri) => r.forEach((v, ci) => (typeof v === 'string' && v.startsWith('=') ? sheet.setFormula(ri + 1, ci, v) : sheet.setValue(ri + 1, ci, v))))

spread.refresh()
await new Promise((r) => setTimeout(r, 400))
const canvases = [...host.querySelectorAll('canvas')]
console.log('canvas sizes:', canvases.map((c) => c.width + 'x' + c.height).join(', '))

for (let i = 0; i < canvases.length; i++) {
  const c = canvases[i]
  try {
    const url = c.toDataURL('image/png')
    if (!url.startsWith('data:image/png')) continue
    const buf = Buffer.from(url.split(',')[1], 'base64')
    writeFileSync(join(OUT, `probe8-${i}.png`), buf)
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    // column-boundary detector: vertical lines of near-black in top area
    const colX = []
    for (let x = 0; x < c.width; x++) { let n = 0; for (let y = 60; y < 120; y++) { const p = (y * c.width + x) * 4; if (d[p + 3] > 230 && d[p] + d[p + 1] + d[p + 2] < 240) n++ } if (n > 40) colX.push(x) }
    console.log(`probe8-${i}.png ${c.width}x${c.height} bytes=${buf.length} dark-vertical-boundaries near x:`, colX.slice(0, 20).join(','))
    // text rows: horizontal dark bands
    const rowY = []
    for (let y = 0; y < c.height; y++) { let n = 0; for (let x = 0; x < c.width; x++) { const p = (y * c.width + x) * 4; if (d[p + 3] > 230 && d[p] + d[p + 1] + d[p + 2] < 200) n++ } if (n > 8) rowY.push(y) }
    const compressed = rowY.filter((y, idx) => idx === 0 || y - rowY[idx - 1] > 3)
    console.log(`  first dark row-band starts at y:`, compressed.slice(0, 30).join(','))
  } catch (e) { console.log('canvas', i, 'err', e.message) }
}
process.exit(0)
