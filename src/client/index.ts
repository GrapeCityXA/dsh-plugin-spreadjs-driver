/**
 * dsh-spreadjs-driver — browser half.
 *
 * Registers an entry into the roster the *editor* publishes, and takes custody of
 * a workbook only when that editor hands one over:
 *
 *   editor (owner)  ──attach(provider)──▶  this entry  ──▶  live workbook
 *
 * It used to publish `spreadjsHostBridge` itself and be injected by name. That
 * allowed exactly one bridge — a second `provide` of a live name throws, and the
 * losing plugin never activates — so no user choice was possible. See `types.ts`
 * for the full reasoning and `docs/design-live-designer-bridge.md` for the
 * history.
 *
 * Design constraints this file exists to hold:
 *
 *  1. **The workbook is offered, never discovered.** The owner decides who may
 *     touch its document; there is no lookup that returns somebody else's.
 *  2. **`attach` and the title are the entire public surface.** The way to *act*
 *     on an attached workbook is not published — not on the entry, and not as an
 *     export of this bundle — so a third client plugin cannot edit a document it
 *     does not own.
 *  3. **No UI.** This half renders nothing; it holds references, offers them to
 *     the host, and runs what comes back.
 *
 * The transport lives in `./live.ts`: this page polls the host's
 * `{@link LIVE_CHANNEL}`, and the host answers with work addressed to a workbook
 * it knows this tab holds. See `docs/design-live-designer-bridge.md` §5.
 */

import { startLiveChannel } from './live.ts'
import {
  BRIDGE_ID,
  BRIDGE_REGISTRY_SERVICE,
  type ClientContextLike,
  type SpreadjsBridgeRegistry,
  type SpreadjsWorkbookProvider,
} from './types.ts'

export const name = 'dsh-spreadjs-driver'

/** Nothing is required: the bridge publishes its door and waits. */
export const inject: string[] = []

/** Attached providers, in attach order. */
const attached = new Map<string, SpreadjsWorkbookProvider>()

/** The attached providers, in attach order — what the channel offers to the host. */
function attachedProviders(): readonly SpreadjsWorkbookProvider[] {
  return [...attached.values()]
}

export function apply(ctx: ClientContextLike): void {
  const bridge = {
    id: BRIDGE_ID,
    title: (): string => 'SpreadJS Driver',
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
  }

  // Registered into the editor's roster rather than published as a service of
  // our own — see the note in types.ts. The callback simply never runs when no
  // editor is installed, which is the same state as before: nothing to drive.
  ctx.inject([BRIDGE_REGISTRY_SERVICE], (hosted) => {
    hosted.effect(() => {
      const registry = hosted.get(BRIDGE_REGISTRY_SERVICE) as SpreadjsBridgeRegistry | undefined
      if (registry === undefined || typeof registry.register !== 'function') return
      return registry.register(bridge)
    }, 'dsh-spreadjs-driver: bridge registration')
  })

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
