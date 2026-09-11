// E2E fixture generator: produce the two realistic workbooks that the task-7
// acceptance runs against. Uses the real built worker artifact over the envelope
// protocol (exactly like worker-smoke), then exports .xlsx. The outputs double
// as the "real-file" side of the bidirectional-compat leg once an operator
// re-saves them from Excel/WPS.
//
// Usage: node scripts/make-fixtures.mjs [outDir]   (default: examples/fixtures)
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = process.argv[2] ?? fileURLToPath(new URL('../examples/fixtures', import.meta.url))
const WORKER = fileURLToPath(new URL('../artifacts/sjs-worker.mjs', import.meta.url))

function runWorker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdout = []
    child.stdout.on('data', (c) => stdout.push(c))
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker timed out')) }, 90_000)
    child.once('error', (e) => { clearTimeout(timer); reject(e) })
    child.once('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(stdout).toString('utf8').trim()
      try { resolve({ envelope: JSON.parse(text), exitCode: code }) }
      catch { reject(new Error(`worker returned non-JSON (exit ${code}): ${text}`)) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
async function execute(workspaceRoot, sourcePath, code) {
  const { envelope } = await runWorker({ op: 'execute', sourcePath, workspaceRoot, code })
  if (!envelope.ok) throw new Error(`execute failed: ${JSON.stringify(envelope.error)}`)
  return envelope.result
}

const dir = await mkdtemp(join(tmpdir(), 'sjs-fixtures-'))
const workbook = join(dir, 'book.ssjson')
const step = async (label, fn) => { await fn(); console.log(`  ok    ${label}`) }

await mkdir(OUT_DIR, { recursive: true })

// --- 1. 工资表 (payroll): 2026-05 — 15 employees, formula 实发工资 -----------
await step('payroll workbook', async () => {
  await runWorker({ op: 'new', targetPath: workbook })
  const payroll = [
    "const s = sheet()",
    "s.name('工资表2026-05')",
    "const headers = ['序号','姓名','部门','基本工资','绩效工资','社保扣款','实发工资']",
    "headers.forEach((h, c) => s.setValue(0, c, h))",
  ]
  const employees = [
    ['张伟', '销售部', 8000, 3200, 960], ['李娜', '销售部', 7500, 2800, 900],
    ['王芳', '市场部', 8200, 2600, 984], ['刘洋', '市场部', 7200, 2100, 864],
    ['陈静', '财务部', 9000, 2500, 1080], ['杨帆', '财务部', 7800, 2000, 936],
    ['赵磊', '技术部', 11000, 4600, 1320], ['孙悦', '技术部', 9800, 4200, 1176],
    ['周杰', '技术部', 10500, 4000, 1260], ['吴敏', '人事部', 7000, 1800, 840],
    ['徐强', '人事部', 6800, 1600, 816], ['朱丽', '行政部', 6500, 1500, 780],
    ['胡军', '行政部', 6200, 1400, 744], ['郭婷', '财务部', 8800, 2300, 1056],
    ['何平', '销售部', 7900, 3000, 948],
  ]
  employees.forEach((row, i) => {
    const r = i + 1
    payroll.push(`s.setValue(${r}, 0, ${i + 1})`)
    payroll.push(`s.setValue(${r}, 1, ${JSON.stringify(row[0])})`)
    payroll.push(`s.setValue(${r}, 2, ${JSON.stringify(row[1])})`)
    payroll.push(`s.setValue(${r}, 3, ${row[2]})`)
    payroll.push(`s.setValue(${r}, 4, ${row[3]})`)
    payroll.push(`s.setValue(${r}, 5, ${row[4]})`)
    payroll.push(`s.setFormula(${r}, 6, '=D${r + 1}+E${r + 1}-F${r + 1}')`)
  })
  const last = employees.length + 1
  payroll.push(`s.setValue(${last}, 2, '合计')`)
  payroll.push(`s.setFormula(${last}, 3, '=SUM(D2:D${last})')`)
  payroll.push(`s.setFormula(${last}, 4, '=SUM(E2:E${last})')`)
  payroll.push(`s.setFormula(${last}, 5, '=SUM(F2:F${last})')`)
  payroll.push(`s.setFormula(${last}, 6, '=SUM(G2:G${last})')`)
  payroll.push('return { rows: ' + (last + 1) + ', sheet: s.name() }')
  const result = await execute(dir, workbook, payroll.join('\n'))
  if (result.rows !== last + 1) throw new Error(`payroll rows: ${JSON.stringify(result)}`)
  await runWorker({ op: 'export', sourcePath: workbook, outputPath: join(OUT_DIR, '工资表2026-05.xlsx'), format: 'xlsx' })
})

// --- 2. Q2 销售明细 (sales): single wide sheet, formula-driven 销售额 ----------
await step('q2-sales workbook', async () => {
  await runWorker({ op: 'new', targetPath: workbook })
  const sales = [
    "const s = sheet()",
    "s.name('Q2销售明细')",
    "const headers = ['订单号','日期','区域','销售员','产品','单价','销量','销售额']",
    "headers.forEach((h, c) => s.setValue(0, c, h))",
  ]
  const regions = ['华东', '华北', '华南', '西南', '华中']
  const products = ['智能门锁', '智能摄像头', '可视门铃', '烟雾报警器', '智能猫眼']
  const people = ['张伟', '李娜', '王芳', '刘洋', '陈静', '杨帆']
  const rows = []
  let seq = 1
  for (let i = 0; i < 60; i++) {
    const m = 4 + (i % 3) // 4,5,6
    const day = (i * 7) % 28 + 1
    const region = regions[i % regions.length]
    const person = people[(i * 3) % people.length]
    const product = products[i % products.length]
    const price = [499, 299, 399, 189, 359][i % 5]
    const qty = (i % 9) + 2
    rows.push(`s.setValue(${seq}, 0, 'SO${String(1000 + i)}')`)
    rows.push(`s.setValue(${seq}, 1, ${JSON.stringify(`2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`)})`)
    rows.push(`s.setValue(${seq}, 2, ${JSON.stringify(region)})`)
    rows.push(`s.setValue(${seq}, 3, ${JSON.stringify(person)})`)
    rows.push(`s.setValue(${seq}, 4, ${JSON.stringify(product)})`)
    rows.push(`s.setValue(${seq}, 5, ${price})`)
    rows.push(`s.setValue(${seq}, 6, ${qty})`)
    rows.push(`s.setFormula(${seq}, 7, '=F${seq + 1}*G${seq + 1}')`)
    seq++
  }
  sales.push(...rows)
  sales.push(`s.setValue(${seq}, 0, '合计')`)
  sales.push(`s.setFormula(${seq}, 7, '=SUM(H2:H${seq})')`)
  sales.push('return { dataRows: ' + (seq - 1) + ', sheet: s.name() }')
  const result = await execute(dir, workbook, sales.join('\n'))
  if (result.dataRows !== 60) throw new Error(`sales rows: ${JSON.stringify(result)}`)
  await runWorker({ op: 'export', sourcePath: workbook, outputPath: join(OUT_DIR, 'q2-sales-2026.xlsx'), format: 'xlsx' })
})

await rm(dir, { recursive: true, force: true })
console.log(`\nfixtures written to ${OUT_DIR}:`)
console.log('  工资表2026-05.xlsx   — payroll, 15 employees, 实发工资 = 基本+绩效−社保 (formula)')
console.log('  q2-sales-2026.xlsx   — 60 order rows, 销售额 = 单价×销量 (formula)')
