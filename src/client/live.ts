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
import { LIVE_CHANNEL, LIVE_POLL, LIVE_RESULT, LIVE_CHECK, type LiveJob, type LiveJobResult } from '../shared/live.ts'
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
  if (signal.aborted) return Promise.resolve()
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
 * the browser: visible, and not something the agent decided to
 * commit on the user's behalf.
 *
 * A save failure is reported as a failure even though the edit did land in the
 * browser: the caller's model of the world is the file, and reporting success
 * there would leave it believing a change was written that was not.
 */
async function runJob(
  providers: () => readonly SpreadjsWorkbookProvider[],
  job: LiveJob,
  control: { signal: AbortSignal; checkActive: () => Promise<void> },
): Promise<LiveJobResult> {
  const available = providers()
  if (job.open !== undefined) {
    const request = job.open
    const editor = available.find(candidate => candidate.openWorkbook !== undefined && candidate.getSessionId?.() === request.sessionId)
    if (editor === undefined) return { jobId: job.jobId, ok: false, code: 'SJS_LIVE_NO_EDITOR', message: 'The requested chat is no longer visible in this editor.' }
    try {
      await editor.openWorkbook!(request.address, request.timeoutMs)
      if (!providers().includes(editor)) throw new Error('The editor bridge was disconnected while opening the workbook')
      return { jobId: job.jobId, ok: true, value: { ready: true }, file: request.address }
    } catch (error) {
      return { jobId: job.jobId, ok: false, code: 'SJS_LIVE_OPEN_FAILED', message: messageOf(error) }
    }
  }
  const target = job.binding?.providerId ?? job.target
  const provider = target === undefined
    ? available[0]
    : available.find((candidate) => candidate.id === target)

  if (provider === undefined) {
    return {
      jobId: job.jobId,
      ok: false,
      code: 'SJS_LIVE_NO_WORKBOOK',
      message: job.target === undefined
        ? 'The designer is connected but no spreadsheet is open in it. Ask the user to open the file in the Web UI sidebar and wait for it to load.'
        : `The designer is connected but does not have the workbook ${JSON.stringify(job.target)} open.`,
    }
  }

  const matchesBinding = (): boolean => {
    if (job.binding === undefined) return true
    try {
      const identity = provider.getWorkbookIdentity?.()
      return identity?.sessionId === job.binding.sessionId && identity?.file === job.binding.file && identity?.instanceId === job.binding.instanceId
    } catch { return false }
  }
  if (!matchesBinding()) return { jobId: job.jobId, ok: false, code: 'SJS_LIVE_INTERRUPTED', message: 'The requested workbook instance is no longer loaded.' }

  if (provider.acquireDriverLease === undefined || provider.releaseDriverLease === undefined) {
    return {
      jobId: job.jobId, ok: false, code: 'SJS_LIVE_LEASE_UNSUPPORTED',
      message: 'The editor does not support exclusive Driver leases; update the SpreadJS editor before running live work.',
    }
  }

  let lease: string
  try {
    lease = provider.acquireDriverLease()
  } catch (error) {
    return { jobId: job.jobId, ok: false, code: 'SJS_SESSION_BUSY', message: messageOf(error) }
  }

  let workbook: unknown
  let file: string | undefined
  let ownerSignal: AbortSignal | undefined
  function awaitOwner<T>(work: Promise<T>): Promise<T> {
    const signal = ownerSignal
    if (signal === undefined) return work
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => { reject(new Error('The editor destroyed this workbook')) }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      // Attach both handlers even if already aborted: outstanding JS may finish
      // later, but its eventual rejection must not become unhandled.
      work.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
        error => { signal.removeEventListener('abort', abort); reject(error) })
    })
  }
  const interrupted = (): boolean => {
    try {
      return ownerSignal?.aborted === true || !providers().includes(provider)
        || provider.getWorkbook() !== workbook || provider.getActivePath?.() !== file || !matchesBinding()
    } catch { return true }
  }
  const interruption = (): LiveJobResult => ({
    jobId: job.jobId, ok: false, code: 'SJS_LIVE_INTERRUPTED',
    message: 'The editor closed or changed workbooks during Driver work. Reopen the file to recover any snapshot kept by the editor. This job was interrupted; verify its changes before continuing.',
  })
  try {
    workbook = provider.getWorkbook()
    file = provider.getActivePath?.()
    ownerSignal = provider.getDriverLeaseSignal?.(lease)
    await control.checkActive()
    if (workbook === undefined || workbook === null) {
      return { jobId: job.jobId, ok: false, code: 'SJS_LIVE_NO_WORKBOOK', message: 'The editor has no loaded workbook.' }
    }
    if (interrupted()) return interruption()
    const outcome = await awaitOwner(runAgainstProvider(provider, job.code, control.signal))
    if (interrupted()) return interruption()
    await control.checkActive()
    if (interrupted()) return interruption()
    if (!outcome.ok) return { jobId: job.jobId, ok: false, code: outcome.code, message: outcome.message }

    if (job.save === true) {
      if (provider.save === undefined) {
        return {
          jobId: job.jobId,
          ok: false,
          code: 'SJS_LIVE_SAVE_FAILED',
          message: `the edit is in the browser, but the bridge holding ${file ?? 'the workbook'} `
            + 'cannot write it back (it provides no save), so the file was not written',
        }
      }
      try {
        await awaitOwner(provider.save(lease, { signal: control.signal, beforeWrite: control.checkActive }))
      } catch (error) {
        if (interrupted()) return interruption()
        if (control.signal.aborted) return { jobId: job.jobId, ok: false, code: 'SJS_LIVE_ABORTED', message: 'The caller stopped this job; no further automatic save is allowed.' }
        return {
          jobId: job.jobId,
          ok: false,
          code: 'SJS_LIVE_SAVE_FAILED',
          message: `the edit is in the browser but writing ${file ?? 'the workbook'} back failed: ${messageOf(error)}`,
        }
      }
    }
    if (interrupted()) return interruption()

    return file === undefined
      ? { jobId: job.jobId, ok: true, value: outcome.value }
      : { jobId: job.jobId, ok: true, value: outcome.value, file }
  } catch (error) {
    if (interrupted()) return interruption()
    if (control.signal.aborted) return { jobId: job.jobId, ok: false, code: 'SJS_LIVE_ABORTED', message: 'The caller stopped this job; verify partial edits before continuing.' }
    return { jobId: job.jobId, ok: false, code: 'SJS_SCRIPT_ERROR', message: messageOf(error) }
  } finally {
    provider.releaseDriverLease(lease)
  }
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
      // A bridge may be registered before the editor has created or finished
      // loading its workbook. Do not advertise such a provider: advertising it
      // makes the host believe a target is runnable and can race the load.
      const offered = providers().filter((provider) => {
        try { const workbook = provider.getWorkbook(); return workbook !== undefined && workbook !== null }
        catch { return false }
      })
      const targets = offered.map((provider) => provider.id)
      const editorSessions = providers().flatMap(provider => {
        const session = provider.openWorkbook === undefined ? undefined : provider.getSessionId?.()
        return session === undefined ? [] : [session]
      })
      if (targets.length === 0 && editorSessions.length === 0) {
        await sleep(IDLE_DELAY_MS, controller.signal)
        continue
      }

      // The host binds scoped jobs to these loaded-document identities and the
      // browser revalidates them before execution and saving.
      const workbooks = offered.map((provider) => {
        const file = provider.getActivePath?.()
        const identity = provider.getWorkbookIdentity?.()
        return { id: provider.id, ...(file === undefined ? {} : { file }), ...identity }
      })

      let job: LiveJob | null = null
      try {
        const response = await rpc.call(LIVE_CHANNEL, LIVE_POLL, { tabId: id, targets, workbooks, editorSessions }, controller.signal)
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

      if (controller.signal.aborted) break
      if (job === null) {
        await sleep(POLL_DELAY_MS, controller.signal)
        continue
      }

      const currentJob = job
      const jobController = new AbortController()
      const monitor = new AbortController()
      const stop = (): void => { jobController.abort(); monitor.abort() }
      controller.signal.addEventListener('abort', stop, { once: true })
      const checkActive = async (): Promise<void> => {
        jobController.signal.throwIfAborted()
        try {
          const response = await rpc.call(LIVE_CHANNEL, LIVE_CHECK, { jobId: currentJob.jobId, tabId: id }, monitor.signal)
          if (!response.ok || (response.value as { active?: boolean } | null)?.active !== true) throw new Error('The caller is no longer waiting for this job')
        } catch (error) {
          jobController.abort()
          throw error
        }
        jobController.signal.throwIfAborted()
      }
      // Keep cancellation and presence checks alive while arbitrary async code
      // is awaiting. Do not unlock a still-running script merely on cancellation.
      const monitoring = (async () => {
        while (!monitor.signal.aborted && !jobController.signal.aborted) {
          await sleep(250, monitor.signal)
          if (monitor.signal.aborted) break
          try { await checkActive() } catch { break }
        }
      })()
      let result: LiveJobResult
      try {
        result = await runJob(providers, job, { signal: jobController.signal, checkActive })
      } finally {
        monitor.abort()
        controller.signal.removeEventListener('abort', stop)
        await monitoring
      }
      try {
        await rpc.call(LIVE_CHANNEL, LIVE_RESULT, { ...result, tabId: id }, controller.signal)
      } catch {
        // The host gave up on this job already; it has its own timeout and will
        // report SJS_LIVE_TIMEOUT. Retrying the post would only duplicate work.
      }
    }
  })()

  return () => { controller.abort() }
}
