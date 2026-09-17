/**
 * The host end of the live-workbook channel.
 *
 * A browser tab that holds a workbook polls `{@link LIVE_POLL}`; this class
 * answers with a job it is able to run, or with null. The tab runs the job
 * against the live document and posts the outcome to `{@link LIVE_RESULT}`, which
 * settles the promise the caller has been sitting on.
 *
 * The asymmetry is deliberate. The host can never *push* into a page — a browser
 * that has not spoken is unreachable, and there is no address that names a tab
 * from the outside. What the host can do is accept an offer and answer it, so a
 * job is only ever handed to a tab that has just said "I am here, and these are
 * the workbooks I hold".
 *
 * That has one consequence worth stating plainly: **if no tab is polling, the
 * call fails immediately** rather than hanging until a timeout. The two failure
 * modes — nobody is there, and somebody is there but does not have the document
 * you named — are distinguished in the error code, because they need different
 * fixes.
 *
 * The connection service's own signature is declared structurally below rather
 * than imported: this bundle must not depend on another package's runtime module,
 * and the surface actually used is one method.
 */
import { randomUUID } from 'node:crypto'
import { SjsError } from '../service/errors.ts'
import {
  LIVE_CHANNEL,
  LIVE_POLL,
  LIVE_RESULT,
  isLiveJobResult,
  isLivePollRequest,
  type LiveJob,
  type LiveJobResult,
} from '../../shared/live.ts'

/**
 * How long a tab may stay silent before it stops counting as present. Well above
 * the client's poll interval, so an ordinary slow tick never looks like a
 * departure.
 */
const TAB_TTL_MS = 15_000

/**
 * Ceiling on jobs queued but not yet claimed. A browser that vanished between
 * polling and running would otherwise let the queue grow for as long as the
 * caller kept asking.
 */
const MAX_QUEUED_JOBS = 32

/** Carrier-neutral result the RPC handler must return. */
type RpcOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** The slice of the host connection service this channel uses. */
interface LiveRpcHost {
  rpc?: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcOutcome>,
    ): () => Promise<void>
  }
}

interface TrackedTab {
  readonly targets: readonly string[]
  readonly seenAt: number
}

interface PendingJob {
  settle(result: LiveJobResult): void
  readonly timer: ReturnType<typeof setTimeout>
}

/** A job can go to a tab only when that tab holds what the job asks for. */
function serves(targets: readonly string[], job: LiveJob): boolean {
  if (job.target !== undefined) return targets.includes(job.target)
  // Untargeted work goes to any tab with a workbook: the caller asked for
  // "whatever is open", and a tab with nothing open has nothing to run it on.
  return targets.length > 0
}

function failure(code: string, message: string): RpcOutcome {
  return { ok: false, error: { code, message, details: {} } }
}

/** A promise plus its settle functions, so the RPC handler can resolve a waiting job. */
interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/**
 * Written out rather than using `Promise.withResolvers`: that needs lib ES2024,
 * and widening the shared tsconfig for one call site would also widen it for the
 * browser half, which still targets es2022.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Options for one live execution. */
export interface LiveExecuteOptions {
  /** Attached workbook id to run against; omit to accept whichever tab answers. */
  readonly target?: string
  /** Write the workbook back to its file after the code runs. */
  readonly save?: boolean
  /** How long to wait for a browser to run the job. */
  readonly timeoutMs: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** What one completed live execution produced. */
export interface LiveExecution {
  /** Whatever the code returned, or the workbook summary when it returned nothing. */
  readonly value: unknown
  /** The file that was edited, when the browser could name it. */
  readonly file?: string
}

/** Routes work to browser tabs that hold a live SpreadJS workbook. */
export class LiveChannel {
  private readonly tabs = new Map<string, TrackedTab>()
  private readonly queue: LiveJob[] = []
  private readonly pending = new Map<string, PendingJob>()

  /**
   * Register the channel on the host connection service.
   * @param connection - the `connection` service, or anything else when the
   *                     running composition has none (the host half tolerates a
   *                     profile without a web server by never calling this).
   * @returns a disposer that removes the channel.
   */
  register(connection: unknown): () => Promise<void> {
    const host = connection as LiveRpcHost | undefined
    if (typeof host?.rpc?.handle !== 'function') {
      throw new SjsError('the connection service exposes no rpc.handle', 'SJS_LIVE_NO_TRANSPORT')
    }
    return host.rpc.handle(LIVE_CHANNEL, (endpoint, payload) => Promise.resolve(this.dispatch(endpoint, payload)))
  }

  /** Workbook ids currently offered by a live tab, in no particular order. */
  attached(): readonly string[] {
    return [...new Set(this.liveTabs().flatMap((tab) => [...tab.targets]))]
  }

  /** True when a tab has polled recently enough to be considered present. */
  get connected(): boolean {
    return this.liveTabs().length > 0
  }

  /**
   * Run `code` against a live workbook, in the browser that holds it.
   *
   * @throws {SjsError} `SJS_LIVE_NO_CLIENT` when no tab is polling,
   *         `SJS_LIVE_UNKNOWN_TARGET` when tabs are polling but none holds the
   *         requested workbook, `SJS_LIVE_TIMEOUT` when a tab took the job and
   *         never answered, or whatever code the code itself raised.
   */
  async execute(code: string, options: LiveExecuteOptions): Promise<LiveExecution> {
    const target = options.target
    this.assertServable(target)

    if (this.queue.length >= MAX_QUEUED_JOBS) {
      throw new SjsError(
        `${this.queue.length} live jobs are already waiting for a browser; refusing to queue more`,
        'SJS_LIVE_BACKLOG',
      )
    }

    const job: LiveJob = {
      jobId: randomUUID(),
      code,
      ...(target === undefined ? {} : { target }),
      ...(options.save === undefined ? {} : { save: options.save }),
    }

    const settled = deferred<LiveJobResult>()
    const abort = (): void => {
      this.forget(job.jobId)
      settled.reject(new SjsError('the live execution was cancelled', 'SJS_LIVE_ABORTED'))
    }

    const timer = setTimeout(() => {
      this.forget(job.jobId)
      settled.reject(new SjsError(
        `no browser ran the job within ${String(options.timeoutMs)} ms`,
        'SJS_LIVE_TIMEOUT',
      ))
    }, options.timeoutMs)

    this.pending.set(job.jobId, { settle: settled.resolve, timer })
    if (options.signal?.aborted === true) {
      abort()
    } else {
      options.signal?.addEventListener('abort', abort, { once: true })
      this.queue.push(job)
    }

    try {
      const result = await settled.promise
      if (!result.ok) throw new SjsError(result.message, result.code)
      return result.file === undefined ? { value: result.value } : { value: result.value, file: result.file }
    } finally {
      options.signal?.removeEventListener('abort', abort)
      this.forget(job.jobId)
    }
  }

  /** Drop every queued and waiting job, and stop tracking tabs. */
  dispose(): void {
    for (const jobId of [...this.pending.keys()]) this.forget(jobId)
    this.queue.length = 0
    this.tabs.clear()
  }

  /** Remove a job from both the queue and the waiting set, clearing its timer. */
  private forget(jobId: string): void {
    const pending = this.pending.get(jobId)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pending.delete(jobId)
    }
    const index = this.queue.findIndex((job) => job.jobId === jobId)
    if (index >= 0) this.queue.splice(index, 1)
  }

  private liveTabs(): TrackedTab[] {
    const now = Date.now()
    return [...this.tabs.values()].filter((tab) => now - tab.seenAt <= TAB_TTL_MS)
  }

  /** Fail before queueing when no tab could possibly take the job. */
  private assertServable(target: string | undefined): void {
    const live = this.liveTabs()
    if (live.length === 0) {
      throw new SjsError(
        'No SpreadJS designer is connected, so there is no live workbook to edit. '
        + 'Open a workbook in the DSH web UI and try again.',
        'SJS_LIVE_NO_CLIENT',
      )
    }
    if (target !== undefined && !live.some((tab) => tab.targets.includes(target))) {
      const available = [...new Set(live.flatMap((tab) => [...tab.targets]))]
      throw new SjsError(
        `No open workbook with id ${JSON.stringify(target)}. `
        + `Attached right now: ${available.length > 0 ? available.map((id) => JSON.stringify(id)).join(', ') : '(none)'}.`,
        'SJS_LIVE_UNKNOWN_TARGET',
      )
    }
  }

  private dispatch(endpoint: string, payload: unknown): RpcOutcome {
    if (endpoint === LIVE_POLL) return this.onPoll(payload)
    if (endpoint === LIVE_RESULT) return this.onResult(payload)
    return failure('SJS_LIVE_UNKNOWN_ENDPOINT', `unknown live endpoint ${JSON.stringify(endpoint)}`)
  }

  private onPoll(payload: unknown): RpcOutcome {
    if (!isLivePollRequest(payload)) {
      return failure('SJS_LIVE_BAD_REQUEST', 'a poll payload must be { tabId: string, targets: string[] }')
    }
    this.tabs.set(payload.tabId, { targets: payload.targets, seenAt: Date.now() })

    const index = this.queue.findIndex((job) => serves(payload.targets, job))
    if (index < 0) return { ok: true, value: null }
    const [job] = this.queue.splice(index, 1)
    return { ok: true, value: job }
  }

  private onResult(payload: unknown): RpcOutcome {
    if (!isLiveJobResult(payload)) {
      return failure('SJS_LIVE_BAD_REQUEST', 'a result payload must be { jobId, ok, value | code+message }')
    }
    const pending = this.pending.get(payload.jobId)
    // A late or duplicate result is not an error: the tab may have retried, or
    // the host may already have given up on a job it timed out. Either way the
    // work is over, and answering with a failure would only make noise.
    if (pending === undefined) return { ok: true, value: null }

    clearTimeout(pending.timer)
    this.pending.delete(payload.jobId)
    pending.settle(payload)
    return { ok: true, value: null }
  }
}
