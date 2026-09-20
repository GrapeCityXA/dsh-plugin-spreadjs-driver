import { spawn, type ChildProcess } from 'node:child_process'
import { delimiter } from 'node:path'
import type { JsonValue, SjsWorkerRequest } from '../../shared/protocol.ts'
import { parseSjsEngineEnvelope } from '../../shared/protocol.ts'
import { PLUGIN_NODE_MODULES, SJS_WORKER_ENTRY } from '../artifacts/paths.ts'
import { SjsError } from '../service/errors.ts'

/** Rolling tail of engine stderr kept for diagnostics (see `stderrTail`). */
const DIAGNOSTIC_LIMIT = 8_000

interface PendingRequest {
  resolve(value: JsonValue): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  abort?: () => void
}

/**
 * The host's handle on the persistent SpreadJS engine.
 *
 * One engine process serves every operation: it launches the browser once and
 * opens a fresh page per request (see src/workers/sjs/entry.ts). This class owns
 * that process — spawn on first use, newline-delimited JSON framing over
 * stdin/stdout, one request in flight at a time, and a restart on the call after
 * one dies.
 *
 * Two things it deliberately does NOT own:
 *  - **Which paths are authorized.** Every request arrives here already
 *    authorized by the provider; this class never widens that.
 *  - **Per-file ordering.** `queueOn` in the provider keeps a workbook's
 *    operations in arrival order; the serialization here is the coarser and
 *    firmer one — the engine serves one request at a time, whatever file it
 *    names.
 *
 * New failure mode this class exists to handle: the engine used to die with
 * every call, so "the worker went away" could only mean "this call failed". Now
 * it can go away mid-request, and the host has to (a) fail that request with a
 * code the model can act on and (b) make sure the next call starts a new engine
 * instead of writing into a corpse. Both are handled in `onExit`.
 */
export class SjsEngine {
  private readonly timeoutMs: number
  /** Explicit browser executable for the engine; discovery runs when omitted. */
  private readonly browserPath: string | undefined
  private child: ChildProcess | undefined
  private buffer = ''
  private nextId = 0
  private stderrChunks: Buffer[] = []
  private readonly pending = new Map<number, PendingRequest>()
  /** Tail of the request chain: keeps exactly one request in flight. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(timeoutMs: number, browserPath?: string) {
    this.timeoutMs = timeoutMs
    this.browserPath = browserPath
  }

  /** Run one request and return its JSON result. */
  async run(request: SjsWorkerRequest, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted()
    return await this.serialize(async () => {
      // Checked again: a call may have been aborted while it waited its turn.
      signal?.throwIfAborted()
      return await this.exchange(request, signal)
    })
  }

  /**
   * Stop the engine, and the browser with it.
   *
   * Closing stdin is the polite shutdown: the engine sees EOF, closes the
   * browser (which lets the browser delete its own profile directory) and exits.
   * The kill is the backstop for an engine that is wedged — it must never leave
   * a browser running behind it.
   */
  async dispose(): Promise<void> {
    const child = this.child
    this.settleAll(new SjsError('SpreadJS engine was shut down.', 'SJS_ENGINE_DIED'))
    if (child === undefined) return
    this.child = undefined
    const stopped = child.exitCode !== null || child.signalCode !== null
    const exited = new Promise<void>((resolve) => {
      if (stopped) resolve()
      else child.once('close', () => { resolve() })
    })
    child.stdin?.end()
    const kill = setTimeout(() => { child.kill() }, 6_000)
    try {
      await exited
    } finally {
      clearTimeout(kill)
    }
  }

  /** Queue `task` behind every request already running, and let nothing reject the tail. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private exchange(request: SjsWorkerRequest, signal?: AbortSignal): Promise<JsonValue> {
    let child: ChildProcess
    try {
      child = this.ensureChild()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = ++this.nextId
    this.stderrChunks = []
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The engine's state after an overrun is unknown — the operation may
        // still be running in its page. Restarting is the only honest recovery,
        // and it is what the one-shot process did by being killed.
        const message = `SpreadJS operation timed out after ${String(this.timeoutMs)}ms.`
        this.kill(message, new SjsError(message, 'SJS_WORKER_TIMEOUT'))
      }, this.timeoutMs)
      const abort = (): void => {
        // The caller cancelled: the engine is killed (it may be mid-operation)
        // and everything in flight fails, so nothing waits on a process that is
        // no longer being read.
        this.kill('SpreadJS operation was aborted.', new SjsError('SpreadJS operation was aborted.', 'SJS_ENGINE_DIED'))
      }
      const entry: PendingRequest = { resolve, reject, timer }
      if (signal !== undefined) {
        entry.signal = signal
        entry.abort = abort
        signal.addEventListener('abort', abort, { once: true })
      }
      this.pending.set(id, entry)
      child.stdin?.write(`${JSON.stringify({ id, request })}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.settle(id, new SjsError(`cannot send the request to the SpreadJS engine: ${error.message}`, 'SJS_ENGINE_DIED'))
        }
      })
    })
      .then((value) => {
        signal?.throwIfAborted()
        return value
      })
      .catch((error: unknown) => {
        // An aborted call reports the abort, not the kill it caused: the caller
        // cancelled, and that is the reason worth reporting.
        signal?.throwIfAborted()
        throw error
      })
  }

  /** Settle one request exactly once, releasing its timer and abort listener. */
  private settle(id: number, error?: SjsError, value?: JsonValue): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (entry.abort !== undefined && entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.abort)
    if (error === undefined) entry.resolve(value as JsonValue)
    else entry.reject(error)
  }

  /** Fail everything in flight (the engine is gone or is going). */
  private settleAll(error: SjsError): void {
    for (const id of [...this.pending.keys()]) this.settle(id, error)
  }

  /**
   * Kill the engine process, which takes the browser down with it, and fail
   * everything that was waiting on it.
   *
   * A kill is the recovery of last resort: it is used when the engine's state
   * can no longer be trusted (an overrun, an abort, a broken reply), never as a
   * tidy-up — `dispose` closes stdin and lets the engine put its browser away.
   *
   * Settling here rather than waiting for the process to exit is deliberate:
   * `this.child` is already cleared, so the exit handler will not treat the
   * death as news, and a request left pending would never be answered.
   */
  private kill(reason: string, error?: SjsError): void {
    const child = this.child
    if (child === undefined) {
      if (error !== undefined) this.settleAll(error)
      return
    }
    this.child = undefined
    this.diagnostic(`restarting the engine: ${reason}`)
    child.kill()
    if (error !== undefined) this.settleAll(error)
  }

  private ensureChild(): ChildProcess {
    const existing = this.child
    if (existing !== undefined && existing.exitCode === null && existing.signalCode === null) return existing

    const child = spawn(process.execPath, [SJS_WORKER_ENTRY], {
      env: sjsEngineEnvironment(this.browserPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // The engine must never be a reason for the HOST to stay alive. A live child
    // with open pipes holds the parent's event loop, so a host that has finished
    // its work would hang until the engine's idle timeout — measured: a test
    // process printed its last line and sat there for its engine's whole life.
    // Unreferencing the pipes (and the process) makes the engine the leaf it is:
    // when the host really has nothing left to do, it exits, the pipes close,
    // and the engine shuts its browser down. A request in flight keeps the host
    // alive on its own (its timeout timer is referenced), so nothing is lost.
    child.unref()
    unrefStream(child.stdin)
    unrefStream(child.stdout)
    unrefStream(child.stderr)
    this.child = child
    this.buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => { this.ingest(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { this.collectStderr(chunk) })
    // The engine may die between the write and the flush; EPIPE here is a
    // symptom of that, not a failure of its own — `onExit` reports the death.
    child.stdin?.on('error', () => undefined)
    child.once('error', (error: Error) => {
      this.onExit(child, new SjsError(`cannot start the SpreadJS engine: ${error.message}`, 'SJS_ENGINE_DIED'))
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const how = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      this.onExit(child, new SjsError(`the SpreadJS engine stopped while the operation was running (${how}).`, 'SJS_ENGINE_DIED'))
    })
    return child
  }

  /** Read whole envelope lines out of the stream; a chunk is not a message. */
  private ingest(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) this.deliver(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private deliver(line: string): void {
    let envelope: ReturnType<typeof parseSjsEngineEnvelope>
    try {
      envelope = parseSjsEngineEnvelope(JSON.parse(line) as unknown)
    } catch (error) {
      envelope = null
      this.diagnostic(`the SpreadJS engine wrote a line that is not JSON: ${messageOf(error)}`)
    }
    if (envelope === null) {
      // Unknown protocol means the framing itself is broken, and the state of
      // whatever request is in flight is not knowable. Fail it and restart.
      const diagnostic = this.workerDiagnostic('SpreadJS engine returned an invalid response.')
      this.kill('invalid response', new SjsError(diagnostic, 'SJS_WORKER_INVALID_RESPONSE'))
      return
    }
    if (envelope.id === null) {
      // A reply the engine could not attribute to a request: it answered a
      // frame it could not parse. Nothing is waiting on it by construction,
      // so it is diagnostics only.
      this.diagnostic(envelope.ok ? 'SpreadJS engine sent an unattributed reply' : `${envelope.error.code}: ${envelope.error.message}`)
      return
    }
    const entry = this.pending.get(envelope.id)
    if (entry === undefined) {
      this.diagnostic(`SpreadJS engine replied to unknown request ${String(envelope.id)}`)
      return
    }
    if (envelope.ok) this.settle(envelope.id, undefined, envelope.result)
    else this.settle(envelope.id, new SjsError(envelope.error.message, envelope.error.code))
  }

  /** The engine died: fail what was in flight and make the next call spawn again. */
  private onExit(child: ChildProcess, error: SjsError): void {
    if (this.child !== child) return
    this.child = undefined
    this.buffer = ''
    this.settleAll(error)
  }

  private collectStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk)
    let total = 0
    for (const entry of this.stderrChunks) total += entry.length
    while (this.stderrChunks.length > 1 && total > DIAGNOSTIC_LIMIT) {
      total -= this.stderrChunks[0]?.length ?? 0
      this.stderrChunks.shift()
    }
  }

  private diagnostic(message: string): void {
    process.stderr.write(`[sjs] ${message}\n`)
  }

  private workerDiagnostic(fallback: string): string {
    return workerDiagnostic(this.stderrChunks, fallback)
  }
}

/**
 * Drop a child stdio pipe's claim on the host's event loop.
 *
 * A piped child stdio IS a socket at runtime (`unref` works), but the stream
 * type does not say so, hence the structural shape rather than a cast to
 * NodeJS.ReadStream.
 */
function unrefStream(stream: unknown): void {
  const handle = stream as { unref?: () => void } | null | undefined
  handle?.unref?.()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function workerDiagnostic(stderr: readonly Buffer[], fallback: string): string {
  const diagnostic = Buffer.concat(stderr)
    .toString('utf8')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
  if (diagnostic.length === 0) return fallback
  const limit = 2_000
  return `${fallback} ${diagnostic.length <= limit ? diagnostic : `${diagnostic.slice(0, limit)}…`}`
}

function sjsEngineEnvironment(browserPath?: string): NodeJS.ProcessEnv {
  // TEMP/TMP/USERPROFILE are here for the BROWSER, not for us: the engine now
  // runs in a real Edge/Chrome process, which needs a writable temp directory
  // for its throwaway profile (and USERPROFILE as the fallback root for it).
  // With those stripped, `os.tmpdir()` degrades to `SystemRoot\temp` and then to
  // the RELATIVE path `undefined\temp`.
  const env = Object.fromEntries(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'USERPROFILE', 'SJS_ENGINE_IDLE_MS'].flatMap((key) => {
    const value = process.env[key]
    return value === undefined ? [] : [[key, value]]
  }))
  // The engine resolves its heavy dependencies (@grapecity-software/*, and the
  // browser executable it is told about) through this plugin's node_modules
  // (pnpm isolates them there).
  env.NODE_PATH = [PLUGIN_NODE_MODULES, process.env.NODE_PATH].filter((value): value is string => value !== undefined && value.length > 0).join(delimiter)
  if (browserPath !== undefined && browserPath.length > 0) env.SJS_BROWSER_PATH = browserPath
  return env
}
