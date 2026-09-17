/**
 * `sjs_live_execute` — the tool that reaches the document on screen.
 *
 * Every other tool in this plugin works on a `.ssjson` file in the workspace:
 * a one-shot worker opens it, edits it, writes it back. This one works on the
 * workbook the user currently has open in the SpreadJS designer, and the change
 * is on screen the instant it lands. That difference is worth the extra tool
 * rather than a flag on `sjs_execute`, because it changes what the model has to
 * reason about — there is a person looking at this document, and the file on
 * disk is whatever the designer last saved.
 *
 * It fails fast and specifically when it cannot work: `SJS_LIVE_NO_CLIENT` when
 * no designer is connected at all, `SJS_LIVE_UNKNOWN_TARGET` when one is but
 * does not have the workbook asked for. Both are conditions the model can act
 * on, which a timeout would not be.
 */
import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.ts'
import { SjsError } from '../service/errors.ts'
import type { JsonValue } from '../service/types.ts'
import { operationOutput, operationTitle } from '../tools/presentation.ts'
import { existingToolPath } from '../tools/workspace.ts'
import type { LiveChannel } from './channel.ts'

/** Create the `sjs_live_execute` tool definition. */
export function liveExecuteTool(ctx: Context, channel: LiveChannel, config: ResolvedConfig) {
  return defineTool({
    name: 'sjs_live_execute',
    description:
      'Edit the spreadsheet the user has open right now in the SpreadJS designer, in their browser. '
      + 'The change appears on screen immediately, so prefer this over sjs_execute whenever a designer '
      + 'session is running and the user is looking at the workbook. '
      + 'Code runs as an async function body with in scope: spread (the live Spread.Sheets.Workbook), '
      + 'workbook (alias), GC, sheet(name?) returning a worksheet, snapshot(), and console. '
      + 'It may return a JSON-serializable value, which comes back to you. '
      + 'The edit stays in the browser: the user can see and undo it, and their file is NOT '
      + 'modified unless you explicitly ask for that with save: true. '
      + 'Provide exactly one of code or codeFile.',
    timeoutMs: config.operationTimeoutMs,
    parameters: {
      code: { type: 'string', description: 'SpreadJS JavaScript snippet. Mutually exclusive with codeFile.' },
      codeFile: { type: 'string', description: 'Workspace-relative or absolute JavaScript body file to execute. Preferred for multi-line code; mutually exclusive with code.' },
      target: { type: 'string', description: 'Which open workbook to edit, when more than one designer tab is connected. Omit to use whichever is connected.' },
      save: { type: 'boolean', description: 'Write the edit back to the file on disk. Defaults to false, leaving the change only in the designer. Set true ONLY when the user asked to save or overwrite the file.' },
    },
    output: operationOutput,
    async execute(args, exec) {
      const code = await resolveCode(exec, args.code, args.codeFile)
      const execution = await channel.execute(code, {
        ...(args.target === undefined ? {} : { target: args.target }),
        ...(args.save === undefined ? {} : { save: args.save }),
        timeoutMs: config.operationTimeoutMs,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
      // `value` is unknown to the host on purpose — it crossed the wire as JSON
      // and the browser half refuses anything it could not round-trip, so the
      // cast is recording a guarantee the other side already enforced.
      return {
        ok: true as const,
        operation: 'live' as const,
        file: execution.file ?? '',
        result: execution.value as JsonValue,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: operationTitle('live', args.target ?? 'the open workbook'),
      kind: 'execute',
    }),
  })
}

/** Read the code to run from exactly one of `code` / `codeFile`. */
async function resolveCode(
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
