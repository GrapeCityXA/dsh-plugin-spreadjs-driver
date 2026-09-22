import type { Context } from '@deepseek-ai/cordis'
import type {} from '../service/sjs-service.ts'
import type { ResolvedConfig } from '../config.ts'
import { executeTool } from './definitions/execute.ts'
import { exportTool } from './definitions/export.ts'
import { importTool } from './definitions/import.ts'
import { newTool } from './definitions/new.ts'
import { screenshotTool } from './definitions/screenshot.ts'
import { statusTool } from './definitions/status.ts'
import { worktreeTool } from './definitions/worktree.ts'
import { withSjsErrorContent } from './presentation.ts'
import { keepPresent } from '../activation.ts'

export const inject = ['sjs', 'tools']
export const name = 'spreadjs-tools'

/** Register model-facing domain tools over `ctx.sjs`. */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const operationTimeoutMs = config.operationTimeoutMs

  // Present only while this plugin is the chosen bridge — the setting names the
  // plugin that owns spreadsheets here, not merely whoever receives the live
  // document. `activation.ts` carries the reasoning, including why every way of
  // not knowing resolves to "present".
  keepPresent(ctx, 'file tools', () => {
    const tools = [
      newTool(ctx, operationTimeoutMs),
      statusTool(ctx, operationTimeoutMs),
      executeTool(ctx, operationTimeoutMs),
      importTool(ctx, operationTimeoutMs),
      exportTool(ctx, operationTimeoutMs),
      screenshotTool(ctx, operationTimeoutMs),
      worktreeTool(ctx, operationTimeoutMs),
    ]
    const drops = tools.map((tool) => ctx.tools.register(withSjsErrorContent(tool)))
    return () => {
      for (const drop of drops) drop()
    }
  })
}
