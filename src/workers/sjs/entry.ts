/**
 * sjs engine process entry — long-lived, many requests.
 *
 * Framing: newline-delimited JSON. Each stdin line is `{id, request}`; each
 * stdout line is `{id, ok, result|error}` with the same id. Requests are served
 * strictly one at a time, in arrival order — the engine owns exactly one browser
 * and one page per operation, and serializing here removes a whole class of
 * concurrency questions (and costs nothing: an operation is ~1 s while the
 * cold start it replaces was ~4 s).
 *
 * stdout discipline, which the one-shot process only had to keep until its
 * single envelope, now has to hold for the process's whole life: stdout carries
 * envelope lines and NOTHING else. Page console output, boot diagnostics and
 * the browser's own noise all go to stderr. The browser's stdout is not even
 * piped (see cdp.ts) so it cannot land here by accident.
 *
 * The engine exits by itself when it has been idle for `SJS_ENGINE_IDLE_MS`
 * (default 60 s) — a browser per DSH process that never closes is a leak — and
 * when stdin closes, which is what happens when the host exits or is killed.
 * Either way the browser is taken down first; it is a direct child of this
 * process, so it also cannot outlive a crash of this process.
 */
import { writeSync } from 'node:fs'
import type { JsonValue, SjsEngineEnvelope } from '../../shared/protocol.ts'
import { engineFrameId, parseSjsEngineFrame } from '../../shared/request.ts'
import { SjsWorkerError } from './errors.ts'
import { closeRuntime, runOperation } from './operations.ts'

/** Idle lifetime before the engine shuts its browser down and exits. */
const DEFAULT_IDLE_MS = 60_000

function idleMs(): number {
  const raw = process.env['SJS_ENGINE_IDLE_MS']
  const parsed = raw === undefined ? NaN : Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 100 ? parsed : DEFAULT_IDLE_MS
}

function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

let buffer = ''
const queue: string[] = []
let consuming = false
let ended = false
let shuttingDown = false
let idle: NodeJS.Timeout | undefined

function clearIdle(): void {
  if (idle !== undefined) {
    clearTimeout(idle)
    idle = undefined
  }
}

/** Arm the idle timer; when it fires nothing is in flight, so nothing is lost. */
function armIdle(): void {
  clearIdle()
  if (ended || shuttingDown) return
  idle = setTimeout(() => { void shutdown('idle') }, idleMs())
}

/**
 * Write one envelope line and wait for it to be handed to the pipe.
 *
 * Deliberately not `process.exit`-and-forget: the process stays alive for the
 * next request, so a truncated line would desynchronize a host that is still
 * waiting for this reply. Ordering is preserved because replies are produced by
 * a single sequential consumer.
 */
function reply(envelope: SjsEngineEnvelope): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(envelope)}\n`, () => { resolve() })
  })
}

/** Consume queued lines one at a time, then either idle-wait or shut down. */
async function consume(): Promise<void> {
  if (consuming) return
  consuming = true
  clearIdle()
  try {
    for (;;) {
      if (shuttingDown) return
      const line = queue.shift()
      if (line === undefined) break
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      await handleLine(trimmed)
    }
  } finally {
    consuming = false
    if (!shuttingDown) {
      if (ended) await shutdown('stdin-closed')
      else armIdle()
    }
  }
}

async function handleLine(line: string): Promise<void> {
  let id: number | null = null
  let result: JsonValue
  try {
    const value: unknown = JSON.parse(line)
    id = engineFrameId(value)
    const frame = parseSjsEngineFrame(value)
    result = await runOperation(frame.request)
  } catch (error) {
    // An operation classifies its own failures; anything else came from the
    // frame itself (unparseable JSON, missing id, an op no version implements)
    // and is the same condition the one-shot process called SJS_BAD_REQUEST.
    const code = error instanceof SjsWorkerError ? error.code : 'SJS_BAD_REQUEST'
    // One bad request is not fatal: the engine answers it with a classified
    // error and keeps serving. A malformed LINE has no id to answer with, so it
    // is reported with a null id rather than dropped — a silent drop would hang
    // whoever sent it.
    await reply({ id, ok: false, error: { code, message: messageOf(error) } })
    return
  }
  await reply({ id, ok: true, result })
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  clearIdle()
  log(`[sjs] engine shutting down (${reason})`)
  // Shutting down must be BOUNDED. The browser is closed first (that is the
  // part that matters — a browser left running is 15 processes and a window),
  // but the process must not be able to hang on the way out either: a wedged
  // engine holding a browser is exactly the failure this guards against.
  const backstop = setTimeout(() => {
    log('[sjs] engine shutdown is taking too long; exiting')
    process.exit(1)
  }, 15_000)
  try {
    await closeRuntime()
  } catch (error) {
    log(`[sjs] engine shutdown failed: ${messageOf(error)}`)
  }
  clearTimeout(backstop)
  // The stdin handle would otherwise keep the loop alive (the idle path exits
  // with stdin still open). Everything is closed by now, so an explicit exit is
  // not a race.
  process.exit(0)
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    queue.push(buffer.slice(0, index))
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
  }
  void consume()
})

process.stdin.on('end', () => {
  ended = true
  // A final line without a trailing newline still counts: the framing accepts
  // "one request, then EOF", which is how a one-shot caller drives the engine.
  if (buffer.trim().length > 0) queue.push(buffer)
  buffer = ''
  void consume()
})

// A closed stdout means the host is gone; there is nobody left to serve.
process.stdout.on('error', () => { void shutdown('stdout-closed') })
process.stdin.on('error', () => { ended = true; void consume() })

/**
 * Shut the browser down when asked to stop by signal.
 *
 * This is the difference between a browser that closes and one that is killed:
 * the handler gets to send `Browser.close`, so the browser destroys its own
 * window and deletes its profile directory. On Windows a `taskkill /F` cannot
 * be caught and an abrupt end is left to the browser's own parent monitoring —
 * which is a reason for the host to shut down through stdin (see dispose).
 */
process.on('SIGTERM', () => { void shutdown('sigterm') })
process.on('SIGINT', () => { void shutdown('sigint') })
process.on('SIGHUP', () => { void shutdown('sighup') })

process.on('uncaughtException', (error: unknown) => {
  log(`[sjs] engine failed: ${messageOf(error)}`)
  fatalExit()
})
process.on('unhandledRejection', (error: unknown) => {
  log(`[sjs] engine failed: ${messageOf(error)}`)
  fatalExit()
})

/**
 * Report an engine-level failure on stdout and exit.
 *
 * This is the one path that cannot use the async writer: the process is about
 * to die, and a queued write would be dropped — which would leave the host
 * waiting on a reply that will never come. The id is null because the failure
 * was never tied to one request; the host answers its in-flight request from
 * the process exit itself.
 */
function fatalExit(): void {
  const envelope: SjsEngineEnvelope = { id: null, ok: false, error: { code: 'SJS_ENGINE_FAILED', message: 'the SpreadJS engine failed and is shutting down' } }
  try {
    writeSync(process.stdout.fd, `${JSON.stringify(envelope)}\n`)
  } catch {
    // stdout is gone too; the exit code still tells the host
  }
  process.exit(1)
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = (error as { message: unknown }).message
    if (typeof value === 'string' && value.length > 0) return value
  }
  return String(error)
}

armIdle()
