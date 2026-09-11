import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.ts'
import { SjsProvider } from './sjs-provider.ts'

/** Mount the spreadjs Service Provider. */
export function apply(ctx: Context, config: ResolvedConfig): void {
  new SjsProvider(ctx, config)
}

export const name = 'spreadjs-provider'
