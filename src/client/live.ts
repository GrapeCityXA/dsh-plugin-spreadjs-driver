/**
 * The browser end of the live-workbook channel.
 *
 * This half owns both ends of the interesting property: it is the only thing in
 * the system that holds a reference to the workbook on screen, and it is the only
 * thing that can run code against it. So it does not wait to be told what to do —
 * it offers itself, repeatedly, and runs whatever comes back.
 *
 * The loop is a plain poll rather than a held connection. A held request would
 * cut latency and traffic, but it rests on an assumption this codebase has no
 * evidence for (that a `/api` bridge response survives being held open
 * indefinitely), and the thing it buys — a few hundred milliseconds — is not
 * worth an untested assumption in the path everything else depends on. The
 * numbers are small either way: one request every {@link POLL_DELAY_MS} against
 * loopback, and **nothing at all while no workbook is open**, which is most of
 * the time.
 */
import { LIVE_CHANNEL, LIVE_POLL, LIVE_RESULT, type LiveJob, type LiveJobResult } from '../shared/live.ts'
import { runAgainstProvider } from './executor.ts'
import type { SpreadjsWorkbookProvider } from './types.ts'

/** How often an idle tab asks for work while it has a workbook to serve. */
const POLL_DELAY_MS = 300

/**
 * How long to wait after a transport failure. A channel that is down — the host
 * restarting, the session ended — must not turn this loop into a hot one.
 */
const RETRY_DELAY_MS = 3_000

/** How often a tab with nothing open checks whether that has changed. */
const IDLE_DELAY_MS = 1_000

/** The slice of the client `connection` service this loop uses. */
interface ConnectionRpcClient {
  readonly rpc?: {
    call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }>
  }
}

const TAB_KEY = 'dsh-spreadjs-tab'

/**
 * This tab's identity. DSH exposes no client identity to client plugins, so the
 * tab names itself; `sessionStorage` is the right home because it is per-tab and
 * survives a reload, which is exactly the lifetime of the workbook reference.
 */
function tabId(): string {
  const mint = (): string => {
    // randomUUID needs a secure context. DSH serves loopback over http, which
    // counts, but a deployment behind a plain-http hostname would not — so fall
    // back rather than throwing on the first poll.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return `tab-${String(Date.now())}-${String(Math.random()).slice(2)}`
  }
  try {
    const existing = sessionStorage.getItem(TAB_KEY)
    if (existing !== null && existing !== '') return existing
    const fresh = mint()
    sessionStorage.setItem(TAB_KEY, fresh)
    return fresh
  } catch {
    // Storage blocked: a per-load id still tells tabs apart for this page's
    // lifetime, which is all the host uses it for.
    return mint()
  }
}

/** A sleep that ends early when the loop is being torn down. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/**
 * Run one job against the workbook it names.
 *
 * The file is written back **only when the job says so** (`save: true`), which
 * the host sets only when the user asked to save. Otherwise the edit lives in
 * the browser: visible, undoable, and not something the agent decided to
 * commit on the user's behalf.
 *
 * A save failure is reported as a failure even though the edit did land in the
 * browser: the caller's model of the world is the file, and reporting success
 * there would leave it believing a change was written that was not.
 */
async function runJob(
  providers: () => readonly SpreadjsWorkbookProvider[],
  job: LiveJob,
): Promise<LiveJobResult> {
  const available = providers()
  const provider = job.target === undefined
    ? available[0]
    : available.find((candidate) => candidate.id === job.target)

  if (provider === undefined) {
    return {
      jobId: job.jobId,
      ok: false,
      code: 'SJS_LIVE_NO_WORKBOOK',
      message: job.target === undefined
        ? 'The designer is connected but no spreadsheet is open in it. Ask the user to open the file in the Web UI sidebar, or do this work against a file with sjs_execute.'
        : `The designer is connected but does not have the workbook ${JSON.stringify(job.target)} open.`,
    }
  }

  const outcome = await runAgainstProvider(provider, job.code)
  if (!outcome.ok) return { jobId: job.jobId, ok: false, code: outcome.code, message: outcome.message }

  const file = provider.getActivePath?.()
  if (job.save === true && provider.save !== undefined) {
    try {
      await provider.save()
    } catch (error) {
      return {
        jobId: job.jobId,
        ok: false,
        code: 'SJS_LIVE_SAVE_FAILED',
        message: `the edit is in the browser but writing ${file ?? 'the workbook'} back failed: ${messageOf(error)}`,
      }
    }
  }

  return file === undefined
    ? { jobId: job.jobId, ok: true, value: outcome.value }
    : { jobId: job.jobId, ok: true, value: outcome.value, file }
}

/**
 * Offer this page's workbooks to the host until the returned function is called.
 *
 * Silently does nothing when the connection service is absent or shaped
 * differently than expected — the bridge is still useful without a transport
 * (a future editor-side caller could use it directly), so a missing channel must
 * not take the rest of the plugin down with it.
 */
export function startLiveChannel(
  connection: unknown,
  providers: () => readonly SpreadjsWorkbookProvider[],
): () => void {
  const rpc = (connection as ConnectionRpcClient | undefined)?.rpc
  if (rpc === undefined || typeof rpc.call !== 'function') return () => {}

  const controller = new AbortController()
  const id = tabId()

  void (async () => {
    while (!controller.signal.aborted) {
      const offered = providers()
      const targets = offered.map((provider) => provider.id)
      if (targets.length === 0) {
        await sleep(IDLE_DELAY_MS, controller.signal)
        continue
      }

      // Sent alongside `targets`, which is still what routing reads. This is how
      // `sjs_live_status` can answer "which file does the designer have open"
      // without a round trip — see LivePollRequest.workbooks.
      const workbooks = offered.map((provider) => {
        const file = provider.getActivePath?.()
        return file === undefined ? { id: provider.id } : { id: provider.id, file }
      })

      let job: LiveJob | null = null
      try {
        const response = await rpc.call(LIVE_CHANNEL, LIVE_POLL, { tabId: id, targets, workbooks }, controller.signal)
        if (!response.ok) {
          await sleep(RETRY_DELAY_MS, controller.signal)
          continue
        }
        job = (response.value ?? null) as LiveJob | null
      } catch {
        // Unreachable host: back off instead of spinning.
        await sleep(RETRY_DELAY_MS, controller.signal)
        continue
      }

      if (job === null) {
        await sleep(POLL_DELAY_MS, controller.signal)
        continue
      }

      const result = await runJob(providers, job)
      try {
        await rpc.call(LIVE_CHANNEL, LIVE_RESULT, result, controller.signal)
      } catch {
        // The host gave up on this job already; it has its own timeout and will
        // report SJS_LIVE_TIMEOUT. Retrying the post would only duplicate work.
      }
    }
  })()

  return () => { controller.abort() }
}
