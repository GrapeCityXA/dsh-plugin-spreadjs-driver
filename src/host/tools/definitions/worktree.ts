import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { SjsError } from '../../service/errors.ts'
import { operationOutput, operationTitle } from '../presentation.ts'
import { existingToolWorkbook, toolWorkspaceRoot } from '../workspace.ts'

/**
 * Create the `sjs_worktree` tool definition — branch an isolated draft snapshot
 * off one committed .ssjson workbook, or list the drafts already open in this
 * workspace. Editing happens on the returned draft path through sjs_execute /
 * sjs_status / sjs_export; the committed base file is never written this phase.
 */
export function worktreeTool(ctx: Context, timeoutMs: number) {
  return defineTool({
    name: 'sjs_worktree',
    description:
      'Manage isolated draft snapshots (worktrees) of committed .ssjson workbooks. ' +
      "action=create copies one existing workbook into a private draft under .spreadjs/drafts/ and records it, returning the draft's " +
      'workspace-relative path; edit that draft with sjs_execute, inspect it with sjs_status and export it with sjs_export — ' +
      'the committed base file is never modified by this phase. action=list returns every draft open in this workspace ' +
      'with its base, draft path and status. One action per call.',
    timeoutMs,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'list'],
        description: 'create branches a new draft from file; list reports open drafts.',
      },
      file: {
        type: 'string',
        description: 'create: workspace-relative or absolute committed .ssjson workbook to branch from.',
      },
      worktreeId: {
        type: 'string',
        description: 'create: optional stable label for the draft. Defaults to <base>.draft (uniquified).',
      },
    },
    output: operationOutput,
    async execute(args, exec) {
      if (args.action === 'list') {
        const workspace = await toolWorkspaceRoot(exec)
        return ctx.sjs.worktreeList({ workspace }, exec.signal)
      }
      if (args.file === undefined) {
        throw new SjsError('sjs_worktree create requires file (the workbook to branch from).', 'INVALID_FILE_PATH')
      }
      const base = await existingToolWorkbook(exec, args.file)
      return ctx.sjs.worktreeCreate(
        { workspace: base.workspace, basePath: base.path, worktreeId: args.worktreeId },
        exec.signal,
      )
    },
    presentCall: (args) => ({ card: 'generic', title: operationTitle(`worktree-${args.action}`, args.file ?? ''), kind: 'execute' }),
  })
}
