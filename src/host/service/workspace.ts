import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { SjsError } from './errors.ts'

/** One workspace-authorized path resolved for a service request. */
export interface AuthorizedPath {
  readonly workspace: string
  readonly path: string
}

/** Resolve an existing code file inside the caller's workspace. */
export function resolveExistingWorkspacePath(cwd: string, value: string): Promise<AuthorizedPath> {
  return resolveAuthorizedPath(cwd, value)
}

async function resolveAuthorizedPath(cwd: string, value: string): Promise<AuthorizedPath> {
  if (value.trim().length === 0) throw new SjsError('path is required', 'INVALID_FILE_PATH')
  let workspace: string
  try {
    workspace = await realpath(cwd)
  } catch (error) {
    if (isPermissionError(error)) {
      throw new SjsError('session workspace cannot be accessed because permission was denied', 'FILE_PERMISSION_DENIED', { cause: error })
    }
    const message = isMissingPathError(error) ? 'session workspace does not exist' : 'session workspace cannot be resolved'
    throw new SjsError(message, 'SESSION_SCOPE_UNAVAILABLE', { cause: error })
  }
  const candidate = isAbsolute(value) ? resolve(value) : resolve(workspace, value)
  let canonical: string
  try {
    canonical = await realpath(candidate)
  } catch (error) {
    if (isPermissionError(error)) {
      throw new SjsError('path cannot be accessed because permission was denied', 'FILE_PERMISSION_DENIED', { cause: error })
    }
    const message = isMissingPathError(error) ? 'path does not exist' : 'path cannot be resolved'
    throw new SjsError(message, 'INVALID_FILE_PATH', { cause: error })
  }
  const fromWorkspace = relative(workspace, canonical)
  if (fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
    throw new SjsError('path is outside the session workspace', 'SESSION_SCOPE_DENIED')
  }
  return { workspace, path: canonical }
}

function isMissingPathError(error: unknown): boolean {
  const code = nodeErrorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isPermissionError(error: unknown): boolean {
  const code = nodeErrorCode(error)
  return code === 'EACCES' || code === 'EPERM'
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
