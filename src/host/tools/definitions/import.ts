import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { operationOutput, operationTitle } from '../presentation.ts'
import { existingToolImportSource, newToolWorkbook } from '../workspace.ts'

/**
 * Create the `sjs_import` tool definition — import an external spreadsheet file
 * (xlsx/csv/ssjson) into a canonical .ssjson workbook. The .ssjson file is the
 * plugin's lossless workspace format; subsequent edits happen on it.
 */
export function importTool(ctx: Context, timeoutMs: number) {
  return defineTool({
    name: 'sjs_import',
    description:
      'Import an external spreadsheet file (Excel .xlsx/.xlsm/.xltx/.xltm, .csv, or .ssjson) into a canonical .ssjson ' +
      'workbook that never overwrites an existing file. After import, call sjs_status or sjs_execute on the .ssjson ' +
      'target to inspect and edit the workbook.',
    timeoutMs,
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Workspace-relative or absolute import source: .xlsx/.xlsm/.xltx/.xltm/.csv/.ssjson.',
      },
      target: {
        type: 'string',
        required: true,
        description: 'Workspace-relative or absolute output path ending in .ssjson (created; never overwrites).',
      },
    },
    output: operationOutput,
    async execute(args, exec) {
      const source = await existingToolImportSource(exec, args.file)
      const target = await newToolWorkbook(exec, args.target)
      return ctx.sjs.importFile(
        { workspace: source.workspace, sourcePath: source.path, targetPath: target.path },
        exec.signal,
      )
    },
    presentCall: (args) => ({ card: 'generic', title: operationTitle('import', args.file), kind: 'execute' }),
  })
}
