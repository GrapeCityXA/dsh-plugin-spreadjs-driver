// Test harness for the persistent sjs engine.
//
// The engine is one long-lived process that serves many operations over
// newline-delimited JSON (`{id, request}` in, `{id, ok, result|error}` out), so
// a test file drives ONE engine for all of its steps instead of spawning a
// process per request. The request and envelope shapes are unchanged; only the
// framing carries an id now.
//
// The harness also keeps the invariants the assertions depend on honest:
//  - stdout carries envelope lines and nothing else (any other line is reported
//    as a protocol violation rather than silently ignored),
//  - a request that times out kills the engine (a wedged engine must not be
//    handed to the next step),
//  - every reply is matched to its request by id, so a stray line cannot be
//    mistaken for an answer.
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const WORKER = fileURLToPath(new URL('../../artifacts/sjs-worker.mjs', import.meta.url))

/** Profile-directory prefix the runtime gives every throwaway browser. */
export const PROFILE_PREFIX = 'spjs-browser-'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** One engine process, driven over the framed protocol. */
export class TestEngine {
  #child = null
  #buffer = ''
  #nextId = 0
  #pending = new Map()
  #stderr = ''
  #violations = []
  #exited = null
  #exitInfo = null
  #killed = null

  constructor({ idleMs, env = {} } = {}) {
    this.idleMs = idleMs
    this.env = env
  }

  get pid() {
    return this.#child?.pid
  }

  get exited() {
    return this.#exited !== null
  }

  get exitInfo() {
    return this.#exitInfo
  }

  /** Spawn the engine if it is not already running. */
  start() {
    if (this.#child !== null) return this
    const child = spawn(process.execPath, [WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(this.idleMs === undefined ? {} : { SJS_ENGINE_IDLE_MS: String(this.idleMs) }),
        ...this.env,
      },
    })
    // Unreferenced, like the plugin's own adapter does it: a test that finishes
    // must be able to END, and an engine holding the event loop open would hang
    // the suite (and, in CI, the whole run). The engine sees the closed pipe and
    // shuts its browser down.
    child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream !== null && typeof stream.unref === 'function') stream.unref()
    }
    this.#child = child
    this.#exited = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.#exitInfo = { code, signal }
        resolve(this.#exitInfo)
      })
    })
    child.stdout.on('data', (chunk) => this.#ingest(chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => { this.#stderr += chunk.toString('utf8') })
    child.stdin.on('error', () => undefined)
    return this
  }

  /**
   * Wait for the engine process to exit.
   *
   * Does NOT start one: an engine that was never started (or was already
   * stopped) has nothing to wait for, and spawning one here would leave a
   * stray engine — and a stray browser — behind the very check that exists to
   * prove there are none.
   */
  async waitForExit(timeoutMs = 15_000) {
    const exited = this.#exited
    if (exited === null) return null
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
    return await Promise.race([exited, timeout])
  }

  /**
   * Send one request and resolve with its envelope.
   *
   * A string argument is written verbatim as a LINE (for the malformed-input
   * steps, which are about the framing itself); anything else is framed.
   */
  async request(request, { timeoutMs = 60_000 } = {}) {
    this.start()
    const raw = typeof request === 'string'
    const id = raw ? null : ++this.#nextId
    const line = raw ? request : JSON.stringify({ id, request })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        const child = this.#child
        this.#child = null
        // A request that overran is a wedged engine, not a slow one: kill it
        // rather than wait for a shutdown it will not perform.
        child?.kill()
        reject(new Error(`engine did not answer within ${timeoutMs}ms (stdout discipline: ${JSON.stringify(this.#violations)})`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (envelope) => { clearTimeout(timer); resolve(envelope) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.#child.stdin.write(`${line}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.#pending.delete(id)
          clearTimeout(timer)
          reject(new Error(`cannot write to the engine: ${messageOf(error)}`))
        }
      })
    })
  }

  /**
   * Ask the engine to stop: close its stdin (its own shutdown signal) and give
   * it a moment to put the browser away, killing only if it does not.
   *
   * Killing first would be simpler and is what the harness used to do, but a
   * killed engine's browser dies without ever being asked to close, which is
   * how stray windows and leaked profile directories happen. Every path we
   * control shuts down gracefully; the kill stays as the backstop it is.
   */
  stop() {
    const child = this.#child
    if (child === null) return
    this.#child = null
    child.stdin.end()
    this.#killed = setTimeout(() => { child.kill() }, 8_000)
    // The backstop must not be a reason for the test process to stay alive: a
    // referenced 8s timer would outlive the assertion that just finished.
    this.#killed.unref?.()
  }

  async stopAndWait(timeoutMs = 15_000) {
    const exited = this.#exited
    if (this.#child === null && exited === null) return null
    this.stop()
    if (this.#killed !== null) {
      const kill = this.#killed
      void exited?.then(() => { clearTimeout(kill) })
    }
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
    return await Promise.race([exited ?? Promise.resolve(null), timeout])
  }

  stderr() {
    return this.#stderr
  }

  /** Lines the engine wrote to stdout that were not envelopes. */
  violations() {
    return [...this.#violations]
  }

  #ingest(text) {
    this.#buffer += text
    let index = this.#buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length > 0) this.#deliver(line)
      index = this.#buffer.indexOf('\n')
    }
  }

  #deliver(line) {
    let envelope = null
    try {
      envelope = JSON.parse(line)
    } catch {
      envelope = null
    }
    if (envelope === null || typeof envelope.ok !== 'boolean') {
      this.#violations.push(line.slice(0, 200))
      return
    }
    const id = envelope.id === undefined ? null : envelope.id
    const entry = this.#pending.get(id)
    if (entry === undefined) {
      this.#violations.push(`unmatched reply id=${String(id)}: ${line.slice(0, 200)}`)
      return
    }
    this.#pending.delete(id)
    entry.resolve(envelope)
  }
}

/**
 * A file's view of "the worker": one engine, started on first use.
 *
 * `runWorker(request, {timeoutMs})` keeps the call shape the one-shot harness
 * had, so no step's meaning changed when the transport did.
 */
export function createHarness(options = {}) {
  const engine = new TestEngine(options)
  return {
    engine,
    async runWorker(request, options = {}) {
      // A bare number is accepted as the timeout: one of the suites was written
      // against a `runWorker(request, timeoutMs)` helper, and silently ignoring
      // that argument would turn a 120s budget into a 60s one.
      const timeoutMs = typeof options === 'number' ? options : (options.timeoutMs ?? 60_000)
      return await engine.request(request, { timeoutMs })
    },
    stderr: () => engine.stderr(),
    violations: () => engine.violations(),
    async close() {
      await engine.stopAndWait()
    },
  }
}

/**
 * PIDs of engine processes started from this package's artifact.
 *
 * `parentPid` narrows it to engines whose parent is a given process — the only
 * safe way to kill one in a test, since a developer's machine may be running
 * another session's engine, and killing that one would be both rude and a
 * confusing failure.
 */
export function findEnginePids({ parentPid } = {}) {
  if (process.platform === 'win32') {
    const filter = parentPid === undefined ? '' : ` -and $_.ParentProcessId -eq ${String(parentPid)}`
    const script = [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*sjs-worker.mjs*'${filter} }).ProcessId -join ','`,
    ]
    const out = spawnSync('powershell', script, { encoding: 'utf8', windowsHide: true })
    return parsePids(out.stdout)
  }
  const out = spawnSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8', windowsHide: true })
  return String(out.stdout)
    .split('\n')
    .filter((line) => line.includes('sjs-worker.mjs'))
    .map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid) }
    })
    .filter((entry) => Number.isFinite(entry.pid) && (parentPid === undefined || entry.ppid === parentPid))
    .map((entry) => entry.pid)
}

/**
 * Browsers this runtime started: their command line carries the throwaway
 * profile prefix, which is what tells them apart from the user's own browser.
 *
 * Windows-only, deliberately: the check it feeds is about orphaned msedge
 * children on the platform where a child is NOT killed with its parent.
 */
export function browserProcessCount() {
  if (process.platform !== 'win32') return null
  const script = [
    '-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${PROFILE_PREFIX}*' }).ProcessId -join ','`,
  ]
  const out = spawnSync('powershell', script, { encoding: 'utf8', windowsHide: true })
  return parsePids(out.stdout).length
}

/**
 * Windows titled `sjs-runtime` owned by a browser: i.e. engine PAGES that are
 * still loaded, each of which is a real (invisible) top-level window.
 *
 * This is the user-visible face of a leaked page. An engine between operations
 * must have none: one page per operation, closed with it. Measured on this
 * machine: a live page is exactly one such window, an idle engine parks none,
 * and the count goes to zero when the browser does.
 *
 * Windows-only (it enumerates Win32 windows); returns null elsewhere.
 */
export function pageWindowCount() {
  if (process.platform !== 'win32') return null
  const script = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SjsWinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Dump() {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      int len = GetWindowTextLength(h);
      var t = new StringBuilder(len + 1);
      GetWindowText(h, t, t.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      sb.Append(pid).Append(',').Append(t.ToString()).Append('\n');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
$browsers = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ForEach-Object { $_.ProcessId })
$count = 0
foreach ($row in ([SjsWinEnum]::Dump() -split "\n")) {
  if ($row -eq '') { continue }
  $parts = $row -split ',', 2
  if ($browsers -contains [int]$parts[0] -and $parts[1] -like '*sjs-runtime*') { $count++ }
}
Write-Output $count
`
  const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true })
  const text = String(out.stdout).trim()
  // Not a number means the enumeration itself broke; -1 fails the caller's
  // assertion rather than reading as a clean zero.
  return /^\d+$/.test(text) ? Number(text) : -1
}

/**
 * Parse a "1,2,3" PID list from PowerShell.
 *
 * Only digit runs count. An empty answer means NO processes, and `Number('')`
 * is 0 — a phantom PID that reads as "one browser still alive". That mistake
 * made the orphan check below pass against a browser that was really there, so
 * it is worth being pedantic about.
 */
function parsePids(text) {
  return String(text)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value))
    .map(Number)
}
