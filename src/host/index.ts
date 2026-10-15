import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { Config as SpreadjsConfig } from './config.ts'
import * as live from './live/plugin.ts'
import * as skills from './skills/plugin.ts'

export { Config, resolveConfig } from './config.ts'
export type { SpreadjsConfig }
export { LiveChannel } from './live/channel.ts'
export * as livePlugin from './live/plugin.ts'
export * as skillsPlugin from './skills/plugin.ts'

export const name = 'dsh-spreadjs-driver'

/** Dispatch to the editor's browser; the host owns no SpreadJS engine. */
export function apply(ctx: Context, config: SpreadjsConfig = {}): void {
  const resolved = resolveConfig(config)
  if (resolved.tools) ctx.plugin(live, resolved)
  if (resolved.tools && resolved.skills) ctx.plugin(skills, resolved)
}
