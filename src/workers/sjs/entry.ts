/**
 * sjs worker process entry — one-shot per host request.
 *
 * Contract: the host spawns this process, writes exactly ONE JSON request on
 * stdin and ends the stream. The worker reads stdin to EOF, dispatches the
 * operation (starting the browser runtime lazily on first use), then writes
 * exactly ONE JSON envelope line on stdout and exits.
 *
 * stdout is reserved for the envelope; all diagnostics go to stderr (the page's
 * console output and uncaught errors are forwarded there too).
 */
import { writeSync } from 'node:fs'
import type { SjsWorkerRequest } from '../../shared/protocol.ts'
import { parseSjsWorkerRequest } from '../../shared/request.ts'
import { SjsWorkerError } from './errors.ts'
import { closeRuntime, runOperation } from './operations.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  let raw: string
  try {
    raw = await readStdin()
  } catch (error) {
    throw new SjsWorkerError(`failed to read request from stdin: ${messageOf(error)}`, 'SJS_BAD_REQUEST')
  }
  let request: SjsWorkerRequest
  try {
    request = parseSjsWorkerRequest(JSON.parse(raw))
  } catch (error) {
    throw new SjsWorkerError(
      `request is not a valid worker request: ${messageOf(error)}`,
      'SJS_BAD_REQUEST',
    )
  }
  let result: Awaited<ReturnType<typeof runOperation>>
  try {
    result = await runOperation(request)
  } finally {
    // The browser and the file server must never outlive this process — on the
    // failure path too, or a timed-out operation would leave a browser running
    // with its profile directory behind it.
    await closeRuntime()
  }
  flushAndExit(JSON.stringify({ ok: true, result }) + '\n', 0)
}

main().catch((error: unknown) => {
  const code = error instanceof SjsWorkerError ? error.code : 'SJS_WORKER_FAILED'
  const message = messageOf(error)
  flushAndExit(JSON.stringify({ ok: false, error: { code, message } }) + '\n', 1)
})

/**
 * Write the envelope synchronously to stdout and exit. A plain `process.exitCode`
 * would leave the process alive: the browser is a child process and, with a live
 * CDP socket open, Node would only reclaim us through the host's timeout kill.
 */
function flushAndExit(line: string, exitCode: number): void {
  try {
    writeSync(process.stdout.fd, line)
  } catch {
    // If stdout is already gone the host is gone too; fall through to exit.
  }
  process.exit(exitCode)
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = (error as { message: unknown }).message
    if (typeof value === 'string' && value.length > 0) return value
  }
  return String(error)
}
