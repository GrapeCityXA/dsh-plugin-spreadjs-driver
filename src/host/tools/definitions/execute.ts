import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { SjsError } from '../../service/errors.ts'
import { operationOutput, operationTitle } from '../presentation.ts'
import { existingToolPath, existingToolWorkbook } from '../workspace.ts'

/**
 * Create the `sjs_execute` tool definition — the execution-fallback tool that
 * lets the model drive SpreadJS directly for anything the narrow tools cannot
 * express. Code runs as an async function with `spread`, `workbook`, `GC`,
 * `sheet(name?)`, `io`, `console` and `snapshot()` in scope and may `return` a
 * JSON value; the workbook is persisted automatically.
 */
export function executeTool(ctx: Context, timeoutMs: number) {
  return defineTool({
    name: 'sjs_execute',
    description:
      'Execute SpreadJS JavaScript against one .ssjson workbook and persist it. ' +
      'Code runs as an async function body with in scope: spread (active Spread.Sheets.Workbook), ' +
      'workbook (alias), GC, sheet(name?) returning a worksheet, io.readText/writeText/readBytes (workspace files only), ' +
      'console, and snapshot(). The code may return a JSON-serializable value (returned to you) and the ' +
      'workbook is always saved afterwards. Provide exactly one of code or codeFile.',
    timeoutMs,
    parameters: {
      file: { type: 'string', required: true, description: 'Workspace-relative or absolute .ssjson path.' },
      code: { type: 'string', description: 'SpreadJS JavaScript snippet. Mutually exclusive with codeFile.' },
      codeFile: { type: 'string', description: 'Workspace-relative or absolute JavaScript body file to execute. Preferred for multi-line code; mutually exclusive with code.' },
    },
    output: operationOutput,
    async execute(args, exec) {
      const target = await existingToolWorkbook(exec, args.file)
      const code = await resolveExecutionCode(exec, args.code, args.codeFile)
      return ctx.sjs.execute({ workspace: target.workspace, filePath: target.path, code }, exec.signal)
    },
    presentCall: (args) => ({ card: 'generic', title: operationTitle('execute', args.file), kind: 'execute' }),
  })
}

async function resolveExecutionCode(
  exec: Parameters<typeof existingToolPath>[0],
  code: string | undefined,
  codeFile: string | undefined,
): Promise<string> {
  if ((code === undefined) === (codeFile === undefined)) {
    throw new SjsError('Provide exactly one of code or codeFile.', 'INVALID_EXECUTION_SOURCE')
  }
  if (code !== undefined) return code
  if (codeFile === undefined) {
    throw new SjsError('codeFile is required when code is omitted.', 'INVALID_EXECUTION_SOURCE')
  }
  const source = await existingToolPath(exec, codeFile)
  try {
    return await readFile(source.path, 'utf8')
  } catch (error) {
    throw new SjsError(`Cannot read codeFile ${JSON.stringify(codeFile)}.`, 'CODE_FILE_READ_FAILED', { cause: error })
  }
}
