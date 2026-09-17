/**
 * Wire contract between the host half and the browser half for the *live*
 * workbook — the one the user has open in the SpreadJS designer.
 *
 * Two endpoints, both carried by the DSH connection RPC channel below (see
 * `docs/design-live-designer-bridge.md` §5). The host never reaches into the
 * page: it queues a job, a browser tab that holds a workbook claims it, runs it
 * against the live document, and posts the outcome back.
 *
 * Two things this contract deliberately does not do:
 *
 *  - **It never carries a workbook.** Only code goes down and JSON comes back.
 *    The document stays in the page that owns it, which is the whole reason the
 *    live path exists at all.
 *  - **It gives the host no way to name a tab directly.** A tab offers itself
 *    and the workbooks it holds; the host picks among what is offered. There is
 *    no address that reaches a browser which has not spoken first.
 */

/**
 * Channel both halves register/call.
 *
 * Two constraints shape the name. Host-side `assertChannel` requires
 * `/^\/[A-Za-z0-9._~-]+$/` and reserves `/api`, so it cannot live under the API
 * prefix. And it is deliberately *not* `/spreadjs`: the editor plugin already
 * registers plain web-server routes at `/spreadjs/api/health` and
 * `/spreadjs/api/config` for its license handshake, and neither plugin should
 * have to reason about whether a prefix route shadows the other's exact ones.
 * Two plugins, two prefixes.
 */
export const LIVE_CHANNEL = '/spreadjs-live'

/** Endpoint: a tab offering to run work. Answers with a {@link LiveJob} or null. */
export const LIVE_POLL = 'poll'

/** Endpoint: a tab reporting the outcome of one job. */
export const LIVE_RESULT = 'result'

/** A browser tab offering to run jobs. */
export interface LivePollRequest {
  /**
   * Per-tab identity minted by the client and kept in `sessionStorage`, so it
   * survives a reload and differs between tabs. DSH exposes no client identity
   * to client plugins, so the tab has to name itself.
   */
  readonly tabId: string
  /**
   * Ids of the workbooks this tab currently holds. Empty means the tab has
   * nothing to serve and the host will not hand it work.
   */
  readonly targets: readonly string[]
}

/** One unit of work, handed to a tab that can run it. */
export interface LiveJob {
  readonly jobId: string
  /** JavaScript body, executed with the same injected names as `sjs_execute`. */
  readonly code: string
  /**
   * The workbook this job was addressed to. The host only hands a job to a tab
   * whose `targets` include it, so a tab can trust this names something it holds.
   * Absent when the caller did not care which workbook answered.
   */
  readonly target?: string
  /**
   * Write the workbook back to its file once the code has run. The owner is
   * asked to save through its own save path, so the file the user is editing is
   * the file that changes.
   */
  readonly save?: boolean
}

/** What a tab sends back after running a job. */
export type LiveJobResult =
  | {
    readonly jobId: string
    readonly ok: true
    readonly value: unknown
    /** Absolute path of the workbook that was edited, when the owner knows it. */
    readonly file?: string
  }
  | { readonly jobId: string; readonly ok: false; readonly code: string; readonly message: string }

/** True when `value` is a well-formed poll request. */
export function isLivePollRequest(value: unknown): value is LivePollRequest {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { tabId?: unknown; targets?: unknown }
  return typeof candidate.tabId === 'string'
    && candidate.tabId !== ''
    && Array.isArray(candidate.targets)
    && candidate.targets.every((target) => typeof target === 'string')
}

/** True when `value` is a well-formed job result. */
export function isLiveJobResult(value: unknown): value is LiveJobResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { jobId?: unknown; ok?: unknown; code?: unknown; message?: unknown }
  if (typeof candidate.jobId !== 'string' || candidate.jobId === '') return false
  if (candidate.ok === true) return true
  return candidate.ok === false && typeof candidate.code === 'string' && typeof candidate.message === 'string'
}
