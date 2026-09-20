// Watch for browsers that outlive the engines that started them.
//
// Why this is a separate process rather than an assertion inside a test: the
// failure it guards is only visible ACROSS test runs. The engine keeps a real
// browser alive for as long as it serves, so an engine that never shuts down
// leaves a browser — and a browser is a window: invisible in headless mode, but
// real in the shell's window list, ~15 processes, 150-250 MB. One per stuck
// engine, accumulating for as long as nobody looks.
//
//   node scripts/audit-browsers.mjs [--max-concurrent=4] -- <command> [args...]
//
// It samples the number of live engine browsers ("main" processes: the ones
// carrying --user-data-dir, not the --type= helpers) every two seconds while
// the command runs, and then for a grace period after it exits. It fails when
//
//   * a browser is still alive after the grace period (a survivor), or
//   * more browsers were alive at once than --max-concurrent allows (a climb).
//
// A single browser at a time is expected: the suites drive one engine per test
// process. The bound is deliberately loose — it is there to catch accumulation
// (the reported defect was thirteen), not to police the exact count.
//
// Recognising "ours": every engine browser is launched with a throwaway profile
// directory whose name starts with `spjs-browser-`, and the user's own browser
// has no such argument. That is the same key the smoke tests use.
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const PROFILE_PREFIX = 'spjs-browser-'
const SAMPLE_MS = 2_000
const GRACE_MS = 10_000

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const maxConcurrent = Number((argv.find((a) => a.startsWith('--max-concurrent=')) ?? '--max-concurrent=4').split('=')[1])
const command = separator >= 0 ? argv.slice(separator + 1) : argv

if (command.length === 0) {
  console.error('usage: node scripts/audit-browsers.mjs [--max-concurrent=4] -- <command> [args...]')
  process.exit(2)
}

/** PIDs of every live engine browser (the browser process, not its helpers). */
function liveBrowsers() {
  if (process.platform === 'win32') {
    const script = [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE_PREFIX}*' -and $_.CommandLine -notlike '*--type=*' }).ProcessId -join ','`,
    ]
    const out = spawnSync('powershell', script, { encoding: 'utf8', windowsHide: true })
    return numericIds(String(out.stdout))
  }
  // Linux/macOS: the command line of every process, straight from /proc where
  // it exists; `ps` otherwise.
  const found = []
  if (process.platform === 'linux') {
    for (const entry of readdirSafe('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
        if (cmdline.includes(PROFILE_PREFIX) && !cmdline.includes('--type=') && /(msedge|chrome)/.test(cmdline)) found.push(Number(entry))
      } catch {
        // the process exited between listing and reading — not a browser we can count
      }
    }
    return found
  }
  const out = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', windowsHide: true })
  return String(out.stdout)
    .split('\n')
    .filter((line) => line.includes(PROFILE_PREFIX) && !line.includes('--type=') && /(msedge|chrome)/.test(line))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter(Number.isFinite)
}

/**
 * Parse a "1,2,3" id list. Only digit runs count: an empty answer means NO
 * browsers, and mapping an empty string through `Number` yields 0 — a phantom
 * PID that reads as "one browser alive" and would make this whole audit lie.
 */
function numericIds(text) {
  return String(text)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
}

function readdirSafe(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

const started = Date.now()
const samples = []
let peak = 0
let peakAt = 0
let climbFailure = null

const report = (label, pids) => {
  const line = `[audit] t=${((Date.now() - started) / 1000).toFixed(0)}s ${label} live=${pids.length}${pids.length > 0 ? ` pids=${pids.join(',')}` : ''}`
  samples.push(line)
  console.log(line)
}

let sample = liveBrowsers()
report('before', sample)
const timer = setInterval(() => {
  sample = liveBrowsers()
  if (sample.length > peak) {
    peak = sample.length
    peakAt = Date.now() - started
  }
  if (sample.length > maxConcurrent && climbFailure === null) {
    climbFailure = `live browsers climbed to ${sample.length} (bound ${maxConcurrent}) at t=${((Date.now() - started) / 1000).toFixed(0)}s`
  }
  report('during', sample)
}, SAMPLE_MS)

const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' })
child.on('close', (code) => {
  clearInterval(timer)
  console.log(`[audit] command exited with ${String(code)}`)
  const deadline = Date.now() + GRACE_MS
  const waitForZero = () => {
    const pids = liveBrowsers()
    if (pids.length === 0) {
      report('after', pids)
      if (climbFailure !== null) {
        console.error(`[audit] FAIL: ${climbFailure}`)
        process.exit(1)
      }
      console.log(`[audit] OK: peak ${String(peak)} browser(s) at t=${(peakAt / 1000).toFixed(0)}s, none left after the run`)
      process.exit(code ?? 0)
    }
    if (Date.now() >= deadline) {
      console.error(`[audit] FAIL: ${String(pids.length)} browser(s) outlived the command (pids ${pids.join(',')})`)
      console.error(`[audit]       survivors keep a throwaway profile dir: look for ${PROFILE_PREFIX}* under the temp directory`)
      process.exit(1)
    }
    setTimeout(waitForZero, 500)
  }
  waitForZero()
})
