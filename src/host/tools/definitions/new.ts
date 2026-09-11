import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { operationOutput, operationTitle } from '../presentation.ts'
import { newToolWorkbook } from '../workspace.ts'

/** Create the `sjs_new` tool definition. */
export function newTool(ctx: Context, timeoutMs: number) {
  return defineTool({
    name: 'sjs_new',
    description: 'Create a new empty .ssjson workbook file in the current workspace. This never overwrites an existing file.',
    timeoutMs,
    parameters: {
      file: { type: 'string', required: true, description: 'Workspace-relative or absolute output path ending in .ssjson.' },
    },
    output: operationOutput,
    async execute(args, exec) {
      const target = await newToolWorkbook(exec, args.file)
      return ctx.sjs.newFile({ workspace: target.workspace, targetPath: target.path }, exec.signal)
    },
    presentCall: (args) => ({ card: 'generic', title: operationTitle('new', args.file), kind: 'execute' }),
  })
}
