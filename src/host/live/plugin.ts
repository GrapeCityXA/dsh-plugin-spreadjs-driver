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
 * The services are reached through `ctx.inject` rather than `ctx.get`: this
 * mounts a route once, at apply time, and a profile whose web server comes up
 * later would be missed by a snapshot read. When there is no web server at all —
 * the headless profile — the callback simply never runs, the channel never
 * mounts, and the tool answers `SJS_LIVE_NO_CLIENT`, or `SJS_LIVE_NO_TRANSPORT`
 * once it knows why. That is the correct story for a session with no browser,
 * and it costs no special case.
 *
 * `connection` is read for one thing only: `requestRejection`, which is the
 * Host/Origin fence plus the signed browser cookie. Registering the route
 * through the connection service instead — `connection.rpc.handle` — is what
 * this used to do and it cannot work from a third-party plugin; see the note at
 * the top of `transport.ts`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.ts'
import { withSjsErrorContent } from '../tools/presentation.ts'
import { keepPresent } from '../activation.ts'
import { LiveChannel } from './channel.ts'
import { liveExecuteTool } from './tool.ts'
import { liveStatusTool } from './status-tool.ts'

export const inject = ['tools']
export const name = 'spreadjs-live'

/** Register the live channel (when a web server exists) and `sjs_live_execute`. */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const channel = new LiveChannel()
  ctx.effect(() => () => { channel.dispose() }, 'spreadjs-live: release pending jobs')

  // Both services are needed to mount: `webServer` owns the route, and
  // `connection` owns the check that decides who may reach it. A headless
  // profile has neither, so this callback never runs, the channel stays
  // unmounted, and the tool answers SJS_LIVE_NO_TRANSPORT — which is the true
  // state of affairs.
  //
  // Deliberately *not* `connection.rpc.handle`: that registers the route through
  // the connection service's own context, which does not inject `webServer`, so
  // it throws `cannot get property "webServer" without inject` no matter what we
  // inject on our side. That is how every browser poll came to be answered with
  // a 405 by the SPA fallback while the tool blamed the browser.
  ctx.inject(['connection', 'webServer'], (connected) => {
    connected.effect(() => {
      try {
        return channel.register({
          webServer: connected.get('webServer'),
          // Read per request rather than captured, and failing closed: a route
          // that outlived the service which vets callers must refuse everyone,
          // not admit everyone.
          authenticate: (request) => {
            const connection = connected.get('connection')
            if (connection === undefined) return 503
            return connection.requestRejection(request) as number | undefined
          },
        })
      } catch (error) {
        // Swallowing this is what made the last field report take ten tool calls:
        // the channel silently never mounted, every call answered
        // SJS_LIVE_NO_CLIENT, and the browser (which was polling correctly the
        // whole time) looked like the suspect. The channel now records the
        // reason and reports it, and it goes to the host log as well.
        console.error('[spreadjs-live] could not mount the workbook channel:', error)
        return () => {}
      }
    }, 'spreadjs-live: workbook channel')
  })

  // The live tools exist only while this plugin is the chosen bridge — the same
  // rule as the file tools, through the same helper, so the two rows cannot
  // disagree about whether this plugin is active. `activation.ts` carries the
  // reasoning, including why every way of not knowing resolves to "present".
  keepPresent(ctx, 'live tools', () => {
    const dropExecute = ctx.tools.register(
      withSjsErrorContent(liveExecuteTool(ctx, channel, config)),
    )
    const dropStatus = ctx.tools.register(
      withSjsErrorContent(liveStatusTool(ctx, channel)),
    )
    return () => {
      dropExecute()
      dropStatus()
    }
  })
}
