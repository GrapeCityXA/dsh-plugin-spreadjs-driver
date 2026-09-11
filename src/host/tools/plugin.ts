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

export const inject = ['sjs', 'tools']
export const name = 'spreadjs-tools'

/** Register model-facing domain tools over `ctx.sjs`. */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const operationTimeoutMs = config.operationTimeoutMs
  ctx.tools.register(withSjsErrorContent(newTool(ctx, operationTimeoutMs)))
  ctx.tools.register(withSjsErrorContent(statusTool(ctx, operationTimeoutMs)))
  ctx.tools.register(withSjsErrorContent(executeTool(ctx, operationTimeoutMs)))
  ctx.tools.register(withSjsErrorContent(importTool(ctx, operationTimeoutMs)))
  ctx.tools.register(withSjsErrorContent(exportTool(ctx, operationTimeoutMs)))
  ctx.tools.register(withSjsErrorContent(screenshotTool(ctx, operationTimeoutMs)))
  ctx.tools.register(withSjsErrorContent(worktreeTool(ctx, operationTimeoutMs)))
}
