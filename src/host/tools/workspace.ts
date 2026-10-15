import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SjsError } from '../service/errors.ts'
import { resolveExistingWorkspacePath } from '../service/workspace.ts'

/** Authorize a JavaScript codeFile inside the caller's workspace. */
export function existingToolPath(exec: ToolRunContext, path: string) {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new SjsError('SpreadJS codeFile requires a calling agent with a workspace.', 'SESSION_SCOPE_UNAVAILABLE')
  }
  return resolveExistingWorkspacePath(cwd, path)
}
