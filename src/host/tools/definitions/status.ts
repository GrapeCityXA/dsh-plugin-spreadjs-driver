import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { operationOutput, operationTitle } from '../presentation.ts'
import { existingToolWorkbook } from '../workspace.ts'

/** Create the `sjs_status` tool definition. */
export function statusTool(ctx: Context, timeoutMs: number) {
  return defineTool({
    name: 'sjs_status',
    description: 'Read a model-readable summary of one .ssjson workbook: sheet names, dimensions and used ranges. Call this before deciding what to edit.',
    timeoutMs,
    parameters: {
      file: { type: 'string', required: true, description: 'Workspace-relative or absolute .ssjson path.' },
    },
    output: operationOutput,
    async execute(args, exec) {
      const target = await existingToolWorkbook(exec, args.file)
      return ctx.sjs.status({ workspace: target.workspace, filePath: target.path }, exec.signal)
    },
    presentCall: (args) => ({ card: 'generic', title: operationTitle('status', args.file), kind: 'read' }),
  })
}
