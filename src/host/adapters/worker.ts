import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'
import type { JsonValue, SjsWorkerRequest } from '../../shared/protocol.ts'
import { parseSjsWorkerEnvelope } from '../../shared/protocol.ts'
import { PLUGIN_NODE_MODULES, SJS_WORKER_ENTRY } from '../artifacts/paths.ts'
import { SjsError } from '../service/errors.ts'

/**
 * Invoke one isolated package-local SpreadJS operation. A fresh worker process
 * is spawned per request (one request on stdin, one JSON envelope on stdout),
 * killed on timeout or abort, and awaited through `close` so no orphan lingers.
 */
export class SjsWorker {
  private readonly timeoutMs: number
  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs
  }

  /** Run one request and return its JSON result. */
  async run(request: SjsWorkerRequest, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted()
    const child = spawn(process.execPath, [SJS_WORKER_ENTRY], {
      env: sjsWorkerEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    const completed = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () => resolve())
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, this.timeoutMs)
    const abort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin.end(JSON.stringify(request))
    try {
      await completed
      signal?.throwIfAborted()
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    if (timedOut) {
      throw new SjsError(`SpreadJS operation timed out after ${String(this.timeoutMs)}ms.`, 'SJS_WORKER_TIMEOUT')
    }

    let envelope: ReturnType<typeof parseSjsWorkerEnvelope>
    try {
      envelope = parseSjsWorkerEnvelope(JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown)
    } catch (error) {
      throw new SjsError(workerDiagnostic(stderr, 'SpreadJS worker returned invalid JSON.'), 'SJS_WORKER_INVALID_RESPONSE', { cause: error })
    }
    if (envelope === null) {
      throw new SjsError(workerDiagnostic(stderr, 'SpreadJS worker returned an invalid response.'), 'SJS_WORKER_INVALID_RESPONSE')
    }
    if (!envelope.ok) throw new SjsError(envelope.error.message, envelope.error.code)
    return envelope.result
  }
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

function sjsWorkerEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'].flatMap((key) => {
    const value = process.env[key]
    return value === undefined ? [] : [[key, value]]
  }))
  // The worker resolves its heavy dependencies (@grapecity-software/*, jsdom,
  // canvas) through this plugin's node_modules (pnpm isolates them there).
  env.NODE_PATH = [PLUGIN_NODE_MODULES, process.env.NODE_PATH].filter((value): value is string => value !== undefined && value.length > 0).join(delimiter)
  return env
}
