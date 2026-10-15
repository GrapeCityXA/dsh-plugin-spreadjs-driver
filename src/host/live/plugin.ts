/** The only execution path: dispatch to an editor-supplied workbook. */
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.ts'
import { withSjsErrorContent } from '../tools/presentation.ts'
import { keepPresent } from '../activation.ts'
import { LiveChannel } from './channel.ts'
import { liveExecuteTool } from './tool.ts'
import { liveStatusTool } from './status-tool.ts'
import { liveOpenTool } from './open-tool.ts'

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

  // Register only when the editor explicitly selects this bridge.
  keepPresent(ctx, 'live tools', () => {
    const dropExecute = ctx.tools.register(
      withSjsErrorContent(liveExecuteTool(ctx, channel, config)),
    )
    const dropStatus = ctx.tools.register(
      withSjsErrorContent(liveStatusTool(ctx, channel)),
    )
    const dropOpen = ctx.tools.register(withSjsErrorContent(liveOpenTool(channel, config)))
    return () => {
      dropExecute()
      dropStatus()
      dropOpen()
    }
  }, config.editorSettingsNamespace)
}
