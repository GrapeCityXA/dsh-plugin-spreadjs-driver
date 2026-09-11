import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { extname } from 'node:path'
import { SjsError } from '../service/errors.ts'
import {
  resolveExistingWorkbookPath,
  resolveExistingWorkspacePath,
  resolveNewWorkbookPath,
  resolveNewWorkspacePath,
} from '../service/workspace.ts'

/** Resolve the calling agent's workspace or fail closed for detached calls. */
export function toolWorkspace(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new SjsError('SpreadJS tools require a calling agent with a workspace.', 'SESSION_SCOPE_UNAVAILABLE')
  }
  return cwd
}

/** Resolve an existing `.ssjson` workbook for one tool execution. */
export function existingToolWorkbook(exec: ToolRunContext, file: string) {
  return resolveExistingWorkbookPath(toolWorkspace(exec), file)
}

/** Resolve a new `.ssjson` target for one tool execution. */
export function newToolWorkbook(exec: ToolRunContext, file: string) {
  return resolveNewWorkbookPath(toolWorkspace(exec), file)
}

/** Resolve an existing non-workbook source for one tool execution. */
export function existingToolPath(exec: ToolRunContext, path: string) {
  return resolveExistingWorkspacePath(toolWorkspace(exec), path)
}

/** Resolve a new non-workbook output for one tool execution. */
export function newToolPath(exec: ToolRunContext, path: string) {
  return resolveNewWorkspacePath(toolWorkspace(exec), path)
}

/** File extensions accepted as an `sjs_import` source. */
const IMPORT_SOURCE_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm', '.csv', '.ssjson'])

/** Resolve the canonical workspace root of the calling agent. */
export function toolWorkspaceRoot(exec: ToolRunContext): Promise<string> {
  return existingToolPath(exec, '.').then((root) => root.path)
}

/** Resolve an existing import source (xlsx/csv/ssjson) inside one workspace. */
export function existingToolImportSource(exec: ToolRunContext, path: string) {
  const resolved = resolveExistingWorkspacePath(toolWorkspace(exec), path)
  return resolved.then((authorized) => {
    if (!IMPORT_SOURCE_EXTENSIONS.has(extname(authorized.path).toLowerCase())) {
      throw new SjsError(
        `import source must be .xlsx/.xlsm/.xltx/.xltm/.csv/.ssjson, got ${authorized.path}`,
        'INVALID_FILE_PATH',
      )
    }
    return authorized
  })
}

/** Expected output extension for each `sjs_screenshot` format. */
const SCREENSHOT_OUTPUT_EXTENSIONS: Record<string, string> = {
  png: '.png',
  pdf: '.pdf',
}

/** Resolve a new screenshot output whose extension matches the requested format. */
export function newToolScreenshotOutput(exec: ToolRunContext, path: string, format: string) {
  const resolved = resolveNewWorkspacePath(toolWorkspace(exec), path)
  const expected = SCREENSHOT_OUTPUT_EXTENSIONS[format]
  if (expected === undefined) {
    throw new SjsError(`unsupported screenshot format: ${format}`, 'INVALID_FILE_PATH')
  }
  return resolved.then((authorized) => {
    if (extname(authorized.path).toLowerCase() !== expected) {
      throw new SjsError(`screenshot output for ${format} must end in ${expected}, got ${authorized.path}`, 'INVALID_FILE_PATH')
    }
    return authorized
  })
}

/** Expected output extension for each `sjs_export` format. */
const EXPORT_OUTPUT_EXTENSIONS: Record<string, string> = {
  xlsx: '.xlsx',
  csv: '.csv',
  ssjson: '.ssjson',
  pdf: '.pdf',
}

/** Resolve a new export output whose extension matches the requested format. */
export function newToolExportOutput(exec: ToolRunContext, path: string, format: string) {
  const resolved = resolveNewWorkspacePath(toolWorkspace(exec), path)
  const expected = EXPORT_OUTPUT_EXTENSIONS[format]
  if (expected === undefined) {
    throw new SjsError(`unsupported export format: ${format}`, 'INVALID_FILE_PATH')
  }
  return resolved.then((authorized) => {
    if (extname(authorized.path).toLowerCase() !== expected) {
      throw new SjsError(`export output for ${format} must end in ${expected}, got ${authorized.path}`, 'INVALID_FILE_PATH')
    }
    return authorized
  })
}
