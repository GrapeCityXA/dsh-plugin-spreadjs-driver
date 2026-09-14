import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { operationOutput, operationTitle } from '../presentation.ts'
import { existingToolWorkbook, newToolExportOutput } from '../workspace.ts'

/**
 * Create the `sjs_export` tool definition — export a canonical .ssjson workbook
 * to an external file format (xlsx/csv/ssjson/pdf). CSV exports the active
 * sheet's used range (a CSV has no workbook dimension); PDF embeds registered
 * fonts so text actually renders (never an empty shell).
 */
export function exportTool(ctx: Context, timeoutMs: number) {
  return defineTool({
    name: 'sjs_export',
    description:
      'Produce the file the user opens, from the workbook: ' +
      'xlsx (a full Excel workbook — the usual deliverable), csv (active sheet as comma-delimited UTF-8), ' +
      'pdf (print layout with embedded fonts; Chinese text renders when a CJK .ttf such as simhei.ttf is available), ' +
      'or ssjson (a copy for another tool). Re-exporting also refreshes an .xlsx the user already has. ' +
      'The output path extension must match the requested format. Never overwrites an existing file.',
    timeoutMs,
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Workspace-relative or absolute .ssjson workbook path to export.',
      },
      output: {
        type: 'string',
        required: true,
        description: 'Workspace-relative or absolute output path: .xlsx, .csv, .ssjson or .pdf (created; never overwrites).',
      },
      format: {
        type: 'string',
        required: true,
        enum: ['xlsx', 'csv', 'ssjson', 'pdf'],
        description: 'Target file format. The output extension must match (e.g. .pdf for pdf).',
      },
    },
    output: operationOutput,
    async execute(args, exec) {
      const source = await existingToolWorkbook(exec, args.file)
      const output = await newToolExportOutput(exec, args.output, args.format)
      return ctx.sjs.exportFile(
        { workspace: source.workspace, filePath: source.path, outputPath: output.path, format: args.format },
        exec.signal,
      )
    },
    presentCall: (args) => ({ card: 'generic', title: operationTitle(`export-${args.format}`, args.file), kind: 'execute' }),
  })
}
