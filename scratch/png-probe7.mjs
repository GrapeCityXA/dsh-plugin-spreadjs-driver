/** Probe 7: the clean headless screenshot recipe — inline host size + faked
 *  geometry + fonts registered into node-canvas. Verifies CJK glyphs actually
 *  paint (not tofu) and content spans the whole viewport, then writes PNG. */
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
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

// --- geometry fake: SpreadJS sizes its viewport canvas from clientWidth/Height,
// but only measures when the host has an explicit inline CSS size. -------------
const W = 1000, H = 620
Object.defineProperty(window.Element.prototype, 'clientWidth', { configurable: true, get() { return W } })
Object.defineProperty(window.Element.prototype, 'clientHeight', { configurable: true, get() { return H } })

// --- register system TTFs into node-canvas; pick a CJK family for text --------
const fontFiles = []
for (const entry of readdirSync('C:/Windows/Fonts')) {
  const lower = entry.toLowerCase()
  if ((lower.endsWith('.ttf') || lower.endsWith('.otf')) && !lower.startsWith('.')) fontFiles.push(join('C:/Windows/Fonts', entry))
}
const cjkFamilies = []
for (const file of fontFiles) {
  const base = file.toLowerCase().split(/[\\/]/).pop().replace(/\.(ttf|otf)$/, '')
  try {
    CanvasPkg.registerFont(file, { family: base })
    if (/simhei|msyh|simsun|simkai|simfang|deng/.test(base)) cjkFamilies.push(base)
  } catch {}
}
const bodyFont = cjkFamilies[0] ?? fontFiles[0]?.toLowerCase().split(/[\\/]/).pop().replace(/\.(ttf|otf)$/, '') ?? 'sans-serif'
console.log('registered fonts:', fontFiles.length, 'cjk candidates:', cjkFamilies.slice(0, 5).join(','))

const GC = require('@grapecity-software/spread-sheets')
require('@grapecity-software/spread-sheets-io')
const host = window.document.createElement('div')
host.id = 'host'
host.setAttribute('style', `width: ${W}px; height: ${H}px;`)
window.document.body.appendChild(host)

const spread = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 })
const sheet = spread.getActiveSheet()
sheet.name('工资表')
// Apply a CJK-capable font to the whole sheet default so glyphs are real.
try {
  const base = spread.getNamedStyle ? undefined : undefined
  sheet.defaultStyle.font = `14px ${bodyFont}`
  sheet.defaultStyle.backColor = 'white'
} catch (e) { console.log('defaultStyle set threw', e.message) }

for (let c = 0; c < 6; c++) sheet.setColumnWidth(c, 130)
sheet.setValue(0, 0, '姓名'); sheet.setValue(0, 1, '部门'); sheet.setValue(0, 2, '基本工资'); sheet.setValue(0, 3, '奖金'); sheet.setValue(0, 4, '实发')
const names = ['张伟', '王芳', '李娜', '刘洋', '陈静', '杨帆', '赵磊', '孙丽']
for (let r = 0; r < names.length; r++) {
  sheet.setValue(r + 1, 0, names[r])
  sheet.setValue(r + 1, 1, ['销售部', '技术部', '财务部', '市场部'][r % 4])
  sheet.setValue(r + 1, 2, 8000 + r * 500)
  sheet.setValue(r + 1, 3, 1000 + r * 100)
  sheet.setFormula(r + 1, 4, `=C${r + 2}+D${r + 2}`)
}
sheet.addSpan(0, 0, 1, 5)
// bold header
const header = sheet.getRange(0, 0, 1, 5)
try { header.font(`bold 14px ${bodyFont}`); header.backColor('lightgray') } catch (e) { console.log('header style threw', e.message) }

try { spread.refresh() } catch (e) { console.log('refresh threw', e.message) }
await new Promise((r) => setTimeout(r, 400))

const canvases = [...host.querySelectorAll('canvas')]
console.log('canvas sizes:', canvases.map((c) => `${c.width}x${c.height}`).join(', '))
for (let i = 0; i < canvases.length; i++) {
  const c = canvases[i]
  const ctx = c.getContext('2d')
  try {
    const url = c.toDataURL('image/png')
    if (url.startsWith('data:image/png')) {
      const buf = Buffer.from(url.split(',')[1], 'base64')
      writeFileSync(join(OUT, `recipe-${i}.png`), buf)
      const img = ctx.getImageData(0, 0, c.width, c.height)
      let nonBlank = 0, dark = 0
      let minX = c.width, maxX = 0, minY = c.height, maxY = 0
      const d = img.data
      for (let p = 0; p < d.length; p += 4) {
        if (d[p + 3] !== 0) {
          nonBlank++
          const x = (p / 4) % c.width, y = Math.floor((p / 4) / c.width)
          if (d[p] + d[p + 1] + d[p + 2] < 300) { dark++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
        }
      }
      console.log(`recipe-${i}.png: ${c.width}x${c.height} nonBlank=${nonBlank} darkTextPx=${dark} textBBox=(${minX},${minY})-(${maxX},${maxY})`)
    }
  } catch (e) { console.log(`canvas ${i} failed:`, e.message) }
}
process.exit(0)
