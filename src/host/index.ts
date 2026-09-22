import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { Config as SpreadjsConfig } from './config.ts'
import * as live from './live/plugin.ts'
import * as provider from './provider/plugin.ts'
import * as tools from './tools/plugin.ts'
import * as skills from './skills/plugin.ts'

export { Config, resolveConfig } from './config.ts'
export type { SpreadjsConfig }
export { SjsProvider } from './provider/sjs-provider.ts'
export { SjsService } from './service/sjs-service.ts'
export { LiveChannel } from './live/channel.ts'
// Each row as a mountable module, so a test can apply exactly one — the whole
// entry cannot be mounted without a real cordis context, because the provider
// constructs a Service. Tests use these to check the two rows agree about
// presence, which is the property the helper exists to guarantee.
export * as livePlugin from './live/plugin.ts'
export * as toolsPlugin from './tools/plugin.ts'
export * as skillsPlugin from './skills/plugin.ts'

export const name = 'dsh-spreadjs-driver'

/** Compose the spreadjs Provider and its Tools Consumers. */
export function apply(ctx: Context, config: SpreadjsConfig = {}): void {
  const resolved = resolveConfig(config)
  ctx.plugin(provider, resolved)
  if (resolved.tools) ctx.plugin(tools, resolved)
  if (resolved.tools && resolved.live) ctx.plugin(live, resolved)
  if (resolved.skills) ctx.plugin(skills)
}
