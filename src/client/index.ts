/**
 * dsh-spreadjs-driver — browser half.
 *
 * Publishes `spreadjsHostBridge`, the one door through which a host plugin that
 * owns a live SpreadJS workbook can hand it over:
 *
 *   editor (owner)  ──attach(provider)──▶  this bridge  ──▶  live workbook
 *
 * Design constraints this file exists to hold:
 *
 *  1. **The workbook is offered, never discovered.** The owner decides who may
 *     touch its document; there is no lookup that returns somebody else's.
 *  2. **`attach` and `list` are the entire public surface.** The way to *act* on
 *     an attached workbook is not published, so a third client plugin that gets
 *     this service still cannot edit a document it does not own.
 *  3. **No UI.** This half renders nothing; it holds references, offers them to
 *     the host, and runs what comes back.
 *
 * The transport lives in `./live.ts`: this page polls the host's
 * `{@link LIVE_CHANNEL}`, and the host answers with work addressed to a workbook
 * it knows this tab holds. See `docs/design-live-designer-bridge.md` §5.
 */
import { runAgainstProvider, type LiveResult } from './executor.ts'
import { startLiveChannel } from './live.ts'
import { BRIDGE_SERVICE, type ClientContextLike, type SpreadjsHostBridge, type SpreadjsWorkbookProvider } from './types.ts'

export const name = 'dsh-spreadjs-driver'

/** Nothing is required: the bridge publishes its door and waits. */
export const inject: string[] = []

/** Attached providers, in attach order. */
const attached = new Map<string, SpreadjsWorkbookProvider>()

/** The attached providers, in attach order — what the channel offers to the host. */
function attachedProviders(): readonly SpreadjsWorkbookProvider[] {
  return [...attached.values()]
}

/**
 * Run `code` against one attached workbook. Intentionally NOT published on the
 * bridge service: only this half (and any transport it grows) may call it.
 */
export function executeAttached(id: string, code: string): Promise<LiveResult> {
  const provider = attached.get(id)
  if (provider === undefined) {
    // Throwing here is a programming error in the transport; callers that can
    // legitimately race an unmount get the structured form below.
    throw new Error(`no provider attached under ${JSON.stringify(id)}`)
  }
  return runAgainstProvider(provider, code)
}

/** Ids currently attached. */
export function attachedIds(): readonly string[] {
  return [...attached.keys()]
}

export function apply(ctx: ClientContextLike): void {
  const bridge: SpreadjsHostBridge = {
    attach(provider: SpreadjsWorkbookProvider): () => void {
      attached.set(provider.id, provider)
      let released = false
      return () => {
        // Idempotent: an owner that unloads twice, or during a bridge teardown,
        // must not drop a newer provider that reused the same id.
        if (released) return
        released = true
        if (attached.get(provider.id) === provider) attached.delete(provider.id)
      }
    },
    list(): readonly string[] {
      return attachedIds()
    },
  }

  ctx.provide(BRIDGE_SERVICE, bridge)

  // The transport that carries instructions from the harness host into this page.
  // Optional on both ends: without a connection service nothing polls, and
  // without an attached workbook nothing is offered.
  ctx.inject(['connection'], (connected) => {
    connected.effect(
      () => startLiveChannel(connected.get('connection'), attachedProviders),
      'dsh-spreadjs-driver: live workbook channel',
    )
  })

  ctx.effect(() => () => {
    // The page is unloading or the fiber is disposing: drop every reference so a
    // destroyed workbook is not kept alive by this map.
    attached.clear()
  }, 'dsh-spreadjs-driver: release attached workbooks')
}
