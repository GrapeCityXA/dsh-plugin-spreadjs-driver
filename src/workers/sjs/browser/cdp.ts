/**
 * Minimal Chrome DevTools Protocol client over Node's global `WebSocket`
 * (Node 22+), plus browser launch/teardown. No npm dependency is involved.
 *
 * Two things here are load-bearing and were paid for by the spike:
 *
 *  1. `--user-data-dir` MUST be a fresh directory. Without it the browser
 *     attaches to the user's real profile, pops up their session, and does not
 *     exit cleanly.
 *  2. Deleting that profile directory races the exiting browser on Windows: a
 *     single `rmSync` right after `Browser.close()` throws EBUSY/EPERM on files
 *     the OS has not released yet, and a silent catch leaks ~26 MB PER LAUNCH
 *     (the spike leaked 566 MB over 22 launches before adding the retry loop).
 *     {@link removeProfileDir} retries with backoff, and {@link sweepStaleProfiles}
 *     cleans up after the runs the host had to KILL on timeout — those never get
 *     to run any cleanup at all.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

const PROFILE_PREFIX = 'spjs-browser-'

export interface LaunchBrowserOptions {
  /** Absolute path to msedge.exe / chrome.exe. */
  readonly exe: string
  readonly headless?: boolean
  readonly timeoutMs?: number
  /** Diagnostics sink (stderr); the retry below reports through it. */
  readonly log?: (message: string) => void
}

export interface LaunchedBrowser {
  readonly proc: ChildProcess
  readonly port: number
  readonly userDataDir: string
  readonly wsUrl: string
  /** Close the browser gracefully, then never leave an orphan or a profile dir behind. */
  close(): Promise<void>
  /** Everything the browser wrote to stderr (diagnostics for launch failures). */
  stderr(): string
}

/**
 * A writable parent directory for the throwaway profile.
 *
 * The worker runs with a whitelisted environment, so `os.tmpdir()` cannot be
 * trusted: with TMP/TEMP/USERPROFILE stripped it degrades to `SystemRoot\temp`,
 * and with SystemRoot stripped too it becomes the RELATIVE path `undefined\temp`
 * — which mkdtemp would happily create inside the user's workspace. Only an
 * absolute, already-existing candidate is accepted.
 */
function profileParent(): string {
  const candidates = [process.env['SJS_BROWSER_PROFILE_DIR'], tmpdir(), join(homedir(), '.cache')]
  for (const dir of candidates) {
    if (dir === undefined || dir.length === 0 || !isAbsolute(dir)) continue
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      // not writable — try the next candidate
    }
  }
  throw new Error(
    'no writable directory for the browser profile; set SJS_BROWSER_PROFILE_DIR (or TMPDIR) to a writable path',
  )
}

/** Remove profile directories left behind by workers the host killed on timeout. */
export function sweepStaleProfiles(parent: string, maxAgeMs = 3_600_000): void {
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    if (!entry.startsWith(PROFILE_PREFIX)) continue
    const dir = join(parent, entry)
    try {
      if (statSync(dir).mtimeMs > cutoff) continue
    } catch {
      continue
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
    } catch {
      // still locked by a live browser: it is either in use or will be swept later
    }
  }
}

/** Delete a browser profile directory, retrying while Windows releases the files. */
export async function removeProfileDir(dir: string, attempts = 12, delayMs = 250): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      if (!existsSync(dir)) return true
    } catch {
      // still locked — back off and retry
    }
    await sleep(delayMs)
  }
  return !existsSync(dir)
}

/**
 * Launch a browser with remote debugging on an ephemeral port.
 *
 * A browser that never exposes an endpoint is retried ONCE on a fresh profile:
 * browsers fail to come up for transient reasons (a just-closed instance still
 * releasing the debug port, another browser starting at the same moment), and the
 * alternative is failing a user's spreadsheet operation for no reason at all.
 * The retry is bounded and logged — never a silent loop.
 */
export async function launchBrowser(options: LaunchBrowserOptions): Promise<LaunchedBrowser> {
  try {
    return await launchOnce(options)
  } catch (error) {
    if ((error as { retryable?: boolean }).retryable !== true) throw error
    options.log?.(`[sjs] browser did not come up (${errorMessage(error)}); retrying once on a fresh profile`)
    await sleep(500)
    return await launchOnce(options)
  }
}

/**
 * Take the browser's window out of the shell's window switcher.
 *
 * `--headless=new` still creates a REAL top-level window — measured: one per
 * browser, on Edge and Chrome alike, `IsWindowVisible = False`. The user then
 * sees `sjs-runtime` entries pile up in alt-Tab, and those entries outlive the
 * process: they are not in the window list, no process owns them, and only
 * restarting explorer clears them. Enough of them and the machine lags.
 *
 * No launch flag removes the window (tried: `--headless=old`, `--window-position`
 * off-screen, `--no-startup-window`, `--start-minimized`), and the shutdown path
 * is not the variable either (a direct kill and a graceful close were both clean).
 * What is left is to stop the shell listing it in the first place:
 * `WS_EX_TOOLWINDOW` is documented to keep a window out of both the taskbar and
 * the switcher, and it applies to the window however it later dies.
 *
 * Best effort by design: Windows only, shells out to PowerShell, and a browser
 * that works with a listed window beats one that fails to start. Failures are
 * logged, never thrown. The pid travels in the ENVIRONMENT — a pid interpolated
 * into PowerShell source is one quoting mistake away from silently doing nothing.
 */
function hideFromWindowSwitcher(pid: number, log?: (message: string) => void): number {
  if (process.platform !== 'win32') return 0
  const script = [
    '$sig = @"',
    'using System; using System.Runtime.InteropServices;',
    'public class ShellWin {',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
    '  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr64(IntPtr h, int i);',
    '  [DllImport("user32.dll", EntryPoint="GetWindowLong")] public static extern IntPtr GetWindowLongPtr32(IntPtr h, int i);',
    '  [DllImport("user32.dll", EntryPoint="SetWindowLongPtr")] public static extern IntPtr SetWindowLongPtr64(IntPtr h, int i, IntPtr v);',
    '  [DllImport("user32.dll", EntryPoint="SetWindowLong")] public static extern IntPtr SetWindowLongPtr32(IntPtr h, int i, IntPtr v);',
    '  public static IntPtr Get(IntPtr h, int i) { return IntPtr.Size == 8 ? GetWindowLongPtr64(h,i) : GetWindowLongPtr32(h,i); }',
    '  public static IntPtr Set(IntPtr h, int i, IntPtr v) { return IntPtr.Size == 8 ? SetWindowLongPtr64(h,i,v) : SetWindowLongPtr32(h,i,v); }',
    '  public delegate bool EnumProc(IntPtr h, IntPtr p);',
    '}',
    '"@',
    'Add-Type $sig',
    '$target = [int]$env:SJS_HIDE_PID',
    '$GWL_EXSTYLE = -20',
    '$WS_EX_TOOLWINDOW = 0x00000080',
    '$script:hidden = 0',
    '$cb = [ShellWin+EnumProc]{ param($h,$p)',
    '  $q = 0',
    '  [void][ShellWin]::GetWindowThreadProcessId($h, [ref]$q)',
    '  if ($q -eq $target -and [ShellWin]::GetWindowTextLength($h) -gt 0) {',
    '    $style = [int64]([ShellWin]::Get($h, $GWL_EXSTYLE))',
    '    [void][ShellWin]::Set($h, $GWL_EXSTYLE, [IntPtr]($style -bor $WS_EX_TOOLWINDOW))',
    '    $script:hidden++',
    '  }',
    '  return $true',
    '}',
    '[void][ShellWin]::EnumWindows($cb, [IntPtr]::Zero)',
    'Write-Output $script:hidden',
  ].join('\n')

  try {
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SJS_HIDE_PID: String(pid) },
    })
    const hidden = Number(String(result.stdout).trim())
    const count = Number.isFinite(hidden) ? hidden : 0
    log?.(`[sjs] window switcher: hid ${String(count)} window(s)`)
    return count
  } catch (error) {
    log?.(`[sjs] window switcher: could not apply WS_EX_TOOLWINDOW (${errorMessage(error)})`)
    return 0
  }
}

/**
 * Apply the tool-window style, retrying once.
 *
 * The browser's window may not exist the instant DevTools answers, and a single
 * miss would leave the whole point of this undone — so one retry after a short
 * pause, which is far cheaper than the PowerShell call it guards.
 */
async function hideWindowSwitcherWhenReady(pid: number | undefined, log?: (message: string) => void): Promise<void> {
  if (pid === undefined || process.platform !== 'win32') return
  if (hideFromWindowSwitcher(pid, log) > 0) return
  await sleep(400)
  hideFromWindowSwitcher(pid, log)
}

async function launchOnce(options: LaunchBrowserOptions): Promise<LaunchedBrowser> {
  const { exe, headless = true, timeoutMs = 30_000 } = options
  const parent = profileParent()
  sweepStaleProfiles(parent)
  const dir = mkdtempSync(join(parent, PROFILE_PREFIX))

  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    // Nothing may reach the worker's stdout: it carries exactly one JSON
    // envelope. stdout is therefore not piped at all — a full pipe nobody drains
    // would stall the browser mid-navigation.
    'about:blank',
  ]

  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  // CDP reports the endpoint it picked in `DevToolsActivePort` inside the
  // profile directory: line 1 the port, line 2 the browser websocket path.
  //
  // BOTH lines are required before the file is trusted. The browser creates the
  // file first and writes it after, so an early read sees either EBUSY (Windows
  // lock) or a TRUNCATED prefix — and a truncated `12345` reads as the perfectly
  // valid-looking port `1`, which then produces a 30s "websocket never came up"
  // failure that says nothing about the real cause.
  const portFile = join(dir, 'DevToolsActivePort')
  const startedAt = Date.now()
  let port: number | null = null
  let wsPath = ''
  while (Date.now() - startedAt < timeoutMs) {
    let text: string | null = null
    try {
      text = existsSync(portFile) ? readFileSync(portFile, 'utf8') : null
    } catch {
      text = null
    }
    if (text !== null) {
      const [first, second] = text.split(/\r?\n/)
      if (first !== undefined && /^\d+$/.test(first.trim()) && second !== undefined && second.startsWith('/devtools/')) {
        port = Number(first.trim())
        wsPath = second.trim()
        break
      }
    }
    if (proc.exitCode !== null) {
      await removeProfileDir(dir)
      throw new Error(`browser exited during startup (code ${String(proc.exitCode)}): ${tail(stderr)}`)
    }
    await sleep(50)
  }
  if (port === null) {
    proc.kill()
    await removeProfileDir(dir)
    throw new Error(`browser did not expose a DevTools endpoint within ${String(timeoutMs)}ms: ${tail(stderr)}`)
  }

  // The websocket connect IS the readiness gate: it is the only thing we actually
  // need, and it fails fast and specifically when the endpoint is not up yet.
  const wsUrl = `ws://127.0.0.1:${String(port)}${wsPath}`
  try {
    await waitForEndpoint(wsUrl, proc, () => tail(stderr), timeoutMs)
  } catch (error) {
    proc.kill()
    await removeProfileDir(dir)
    throw retryable(error)
  }

  // Before anything loads a page: the shell must never get the chance to list
  // this window in alt-Tab (see hideFromWindowSwitcher).
  await hideWindowSwitcherWhenReady(proc.pid, options.log)

  return {
    proc,
    port,
    userDataDir: dir,
    wsUrl,
    stderr: () => stderr,
    async close() {
      try {
        const cdp = await CDP.connect(wsUrl)
        await cdp.send('Browser.close').catch(() => undefined)
        cdp.dispose()
      } catch {
        // the browser is already gone
      }
      await Promise.race([new Promise<void>((resolve) => { proc.once('exit', () => { resolve() }) }), sleep(5000)])
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      await removeProfileDir(dir)
    },
  }
}

/** Trim a browser stderr log down to its last lines (diagnostics only). */
function tail(text: string, lines = 4): string {
  return text.trim().split('\n').slice(-lines).join(' | ').slice(0, 600)
}

/** Mark a failure as worth one fresh retry (see launchBrowser). */
function retryable(error: unknown): Error {
  const message = errorMessage(error)
  const marked = new Error(message) as Error & { retryable: boolean }
  marked.retryable = true
  return marked
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Connect to the browser endpoint, retrying while it binds; fail if the process dies. */
async function waitForEndpoint(wsUrl: string, proc: ChildProcess, stderr: () => string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  let lastError = ''
  let attempts = 0
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`browser exited during startup (code ${String(proc.exitCode)}): ${stderr()}`)
    attempts++
    try {
      const client = await CDP.connect(wsUrl)
      client.dispose()
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error(
    `browser websocket endpoint never came up at ${wsUrl} after ${String(attempts)} attempts in ${String(Math.round(Date.now() - startedAt))}ms ` +
      `(last error: ${lastError}; process exitCode ${String(proc.exitCode)}): ${stderr()}`,
  )
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** One CDP websocket connection (browser-scoped; page sessions ride on top). */
export class CDP {
  static async connect(wsUrl: string): Promise<CDP> {
    const client = new CDP(wsUrl)
    await client.open()
    return client
  }

  private readonly wsUrl: string
  private socket: WebSocket | null = null
  private nextId = 0
  private readonly pending = new Map<number, PendingCall>()
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()

  private constructor(wsUrl: string) {
    this.wsUrl = wsUrl
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl)
      this.socket = socket
      socket.addEventListener('open', () => { resolve() })
      socket.addEventListener('error', () => { reject(new Error('CDP websocket error')) })
      socket.addEventListener('message', (event: MessageEvent) => { this.dispatch(event.data) })
      socket.addEventListener('close', () => {
        for (const call of this.pending.values()) call.reject(new Error('CDP socket closed'))
        this.pending.clear()
      })
    })
  }

  private dispatch(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : String(raw)
    const message = JSON.parse(text) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } }
    if (message.id !== undefined) {
      const call = this.pending.get(message.id)
      if (call === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) call.reject(new Error(`${message.error.message ?? 'CDP error'} (code ${String(message.error.code)})`))
      else call.resolve(message.result)
      return
    }
    if (message.method === undefined) return
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
  }

  /** Subscribe to a CDP event; returns the unsubscribe function. */
  on(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(listener)
    this.listeners.set(method, set)
    return () => { set.delete(listener) }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = ++this.nextId
    const socket = this.socket
    if (socket === null) return Promise.reject(new Error('CDP socket is not connected'))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
    })
  }

  /** Open a fresh page target and return a session-bound facade. */
  async newPage(url = 'about:blank'): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url }) as { targetId: string }
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string }
    return new Page(this, targetId, sessionId)
  }

  dispose(): void {
    try {
      this.socket?.close()
    } catch {
      // already closed
    }
  }
}

/** Page-scoped facade: every call carries this target's session id. */
export class Page {
  private readonly cdp: CDP
  readonly targetId: string
  readonly sessionId: string

  constructor(cdp: CDP, targetId: string, sessionId: string) {
    this.cdp = cdp
    this.targetId = targetId
    this.sessionId = sessionId
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.cdp.send(method, params ?? {}, this.sessionId)
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    return this.cdp.on(method, listener)
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    }) as { exceptionDetails?: { exception?: { description?: string }; text?: string }; result?: { value?: unknown } }
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page evaluate threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown'}`)
    }
    return result.result?.value
  }

  async goto(url: string, timeoutMs = 20_000): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.on('Page.loadEventFired', () => { off(); resolve() })
      setTimeout(() => { off(); resolve() }, timeoutMs)
    })
    await this.send('Page.navigate', { url })
    await loaded
  }

  close(): Promise<unknown> {
    return this.send('Target.closeTarget', { targetId: this.targetId })
  }
}
