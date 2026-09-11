/** Verify a REAL worker-produced screenshot PNG contains CJK glyph strokes.
 *  Spawns the built worker: execute a salary table (中文 + colors + formula),
 *  screenshot to scratch/check.png, then decode PNG in-process and ASCII-map a
 *  header cell region — proving text pixels landed (not just PNG magic). */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, '..', 'artifacts', 'sjs-worker.mjs')
const PNG = join(HERE, 'check.png')

function runWorker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdout = []; const stderr = []
    child.stdout.on('data', (c) => stdout.push(c))
    child.stderr.on('data', (c) => stderr.push(c))
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')) }, 90000)
    child.once('error', (e) => { clearTimeout(timer); reject(e) })
    child.once('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(stdout).toString('utf8').trim()
      try { resolve({ envelope: JSON.parse(text), code, stderr: Buffer.concat(stderr).toString('utf8') }) }
      catch { reject(new Error(`non-JSON stdout: ${text}\nstderr: ${Buffer.concat(stderr)}`)) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

const dir = await mkdtemp(join(tmpdir(), 'shotcheck-'))
const ssjson = join(dir, 'salary.ssjson')
try {
  const created = await runWorker({ op: 'new', targetPath: ssjson })
  if (!created.envelope.ok) throw new Error(`new failed: ${JSON.stringify(created.envelope)}`)
  const prep = [
    'const s = sheet()',
    "s.name('工资表')",
    'for (let c = 0; c < 5; c++) s.setColumnWidth(c, 140)',
    "const hdr = ['姓名','部门','基本工资','奖金','实发']",
    'hdr.forEach((v, c) => s.setValue(0, c, v))',
    "const rows = [['张伟','销售部',8000,1200],['王芳','技术部',9500,1500],['李娜','财务部',7000,800],['刘洋','市场部',8600,1100]]",
    'rows.forEach((r, ri) => { const rr = ri + 1; r.forEach((v, ci) => s.setValue(rr, ci, v)); s.setFormula(rr, 4, `=C${rr + 1}+D${rr + 1}`) })',
    'return { used: sheet().getUsedRange(GC.Spread.Sheets.UsedRangeType.data | GC.Spread.Sheets.UsedRangeType.formula) }',
  ].join('\n')
  const prepRun = await runWorker({ op: 'execute', sourcePath: ssjson, workspaceRoot: dir, code: prep })
  if (!prepRun.envelope.ok) throw new Error(`prep failed: ${JSON.stringify(prepRun.envelope)}`)

  const shot = await runWorker({ op: 'screenshot', sourcePath: ssjson, outputPath: PNG, format: 'png' })
  if (!shot.envelope.ok) throw new Error(`shot failed: ${JSON.stringify(shot.envelope)}`)
  console.log('screenshot result:', JSON.stringify({ ok: true, ...shot.envelope.result }, null, 0))

  const Canvas = require('canvas')
  const { loadImage } = Canvas
  const img = await loadImage(PNG)
  const w = img.width, h = img.height
  const c = Canvas.createCanvas(w, h)
  const C = c.getContext('2d')
  C.drawImage(img, 0, 0)
  const d = C.getImageData(0, 0, w, h).data
  const px = (x, y) => (y * w + x) * 4
  // header cell '姓名' sits at x≈40(row header)+pad … y≈20(col header)
  const X0 = 46, Y0 = 22, X1 = Math.min(w, 170), Y1 = Math.min(h, 40)
  const B = 1, chars = ' .:-=+*#%@'
  let textPx = 0
  console.log(`check.png ${w}x${h}`)
  for (let by = Y0; by < Y1; by += B) {
    let line = ''
    for (let bx = X0; bx < X1; bx += B) {
      let dark = 0, tot = 0
      for (let y = by; y < Math.min(by + B, Y1); y++) for (let x = bx; x < Math.min(bx + B, X1); x++) { const p = px(x, y); tot++; if (d[p + 3] > 200 && d[p] + d[p + 1] + d[p + 2] < 430) dark++ }
      textPx += dark
      line += chars[Math.min(chars.length - 1, Math.floor(dark * 10 / tot))]
    }
    console.log(line)
  }
  // whole-canvas text count excluding the pure-gridline rows is hard; the ASCII
  // is the evidence. Report total dark px in the sampled header strip.
  console.log('dark px in header strip (expect >0 glyph strokes):', textPx)
} finally {
  await rm(dir, { recursive: true, force: true })
}
