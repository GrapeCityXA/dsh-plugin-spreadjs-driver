/**
 * Compose the live-workbook channel and the tool that uses it.
 *
 * Separate from the `sjs` provider on purpose. Everything under `ctx.sjs` runs a
 * one-shot worker over a workspace file, and works in every profile including
 * headless. This works only when a browser is connected, has a completely
 * different failure vocabulary, and is useless in a headless session. Folding it
 * into the same service would mean every caller of `ctx.sjs` has to know which
 * half it is talking to.
 *
 * The connection service is reached through `ctx.inject` rather than `ctx.get`:
 * this registers a channel once, at apply time, and a profile whose web server
 * mounts later would be missed by a snapshot read. When there is no connection
 * service at all — the headless profile — the callback simply never runs, the
 * channel never registers, and the tool answers `SJS_LIVE_NO_CLIENT`. That is
 * the correct story for a session with no browser, and it costs no special case.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.ts'
import { withSjsErrorContent } from '../tools/presentation.ts'
import { LiveChannel } from './channel.ts'
import { liveExecuteTool } from './tool.ts'

export const inject = ['tools']
export const name = 'spreadjs-live'

/** Register the live channel (when a web server exists) and `sjs_live_execute`. */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const channel = new LiveChannel()
  ctx.effect(() => () => { channel.dispose() }, 'spreadjs-live: release pending jobs')

  ctx.inject(['connection'], (connected) => {
    connected.effect(() => {
      const unregister = channel.register(connected.get('connection'))
      return () => { void unregister() }
    }, 'spreadjs-live: workbook channel')
  })

  ctx.tools.register(withSjsErrorContent(liveExecuteTool(ctx, channel, config)))
}
