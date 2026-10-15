import { constants } from 'node:fs'
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from '../config.ts'
import { SjsError } from '../service/errors.ts'
import { resolveExistingWorkspacePath } from '../service/workspace.ts'
import { operationOutput } from '../tools/presentation.ts'
import type { LiveChannel } from './channel.ts'

const EXTENSIONS = new Set(['.xlsx', '.xlsm', '.sjs', '.ssjson', '.csv'])
const EMPTY_XLSX = new URL('../templates/empty.xlsx', import.meta.url)

function assertInside(workspace: string, path: string) {
  const inside = relative(workspace, path)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new SjsError('Destination is outside the session workspace.', 'SESSION_SCOPE_DENIED')
  }
}

/** Check each parent before creating children, including existing symlinks/junctions. */
async function resolveDestination(cwd: string, path: string) {
  const { workspace } = await resolveExistingWorkspacePath(cwd, '.')
  const candidate = resolve(workspace, path)
  assertInside(workspace, candidate)
  let parent = workspace
  for (const part of relative(workspace, dirname(candidate)).split(sep).filter(Boolean)) {
    const next = resolve(parent, part)
    try {
      await mkdir(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    parent = await realpath(next)
    assertInside(workspace, parent)
    if (!(await stat(parent)).isDirectory()) throw new SjsError('Destination parent must be a directory.', 'INVALID_FILE_PATH')
  }
  return { workspace, path: resolve(parent, basename(candidate)) }
}

/** Copy a bundled or custom template without an engine, then let the editor load it. */
export function liveOpenTool(channel: LiveChannel, config: ResolvedConfig) {
  return defineTool({
    name: 'sjs_live_open',
    description: 'Open a workspace spreadsheet in the DSH SpreadJS editor and wait until its Workbook is ready. '
      + 'The calling chat must be visible in the web UI and this Driver selected in Spreadsheet Editor settings. '
      + 'Use create:true to create an .xlsx from the plugin bundled blank workbook. Optionally supply a workspace template of the same extension for other formats. '
      + 'Missing destination directories are created; existing files are never overwritten. Use sjs_live_execute after this succeeds.',
    timeoutMs: config.operationTimeoutMs,
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace spreadsheet path to open or create.' },
      create: { type: 'boolean', description: 'Create a new .xlsx using the plugin bundled empty.xlsx. Defaults to opening an existing file.' },
      template: { type: 'string', description: 'Optional existing empty spreadsheet template inside the workspace. Same extension as path. Creates a new file exclusively.' },
    },
    output: operationOutput,
    async execute(args, exec) {
      const header = exec.agent?.session.header
      if (header?.cwd === undefined || header.cwd === '') throw new SjsError('Opening a workbook requires a session workspace.', 'SESSION_SCOPE_UNAVAILABLE')
      if (!EXTENSIONS.has(extname(args.path).toLowerCase())) throw new SjsError('Unsupported spreadsheet extension.', 'INVALID_FILE_PATH')
      if (exec.signal?.aborted) throw new SjsError('Opening was cancelled.', 'SJS_LIVE_ABORTED')
      if (args.create === false && args.template !== undefined) throw new SjsError('template creates a file and cannot be combined with create:false.', 'INVALID_ARGUMENT')
      const created = args.create === true || args.template !== undefined
      let file: { workspace: string; path: string }
      if (!created) {
        file = await resolveExistingWorkspacePath(header.cwd, args.path)
        if (!(await stat(file.path)).isFile()) throw new SjsError('The spreadsheet must be a file.', 'INVALID_FILE_PATH')
      } else {
        let templatePath: string | URL = EMPTY_XLSX
        if (args.template !== undefined) {
          if (extname(args.template).toLowerCase() !== extname(args.path).toLowerCase()) throw new SjsError('Template and destination must have the same extension.', 'INVALID_FILE_PATH')
          const template = await resolveExistingWorkspacePath(header.cwd, args.template)
          if (!(await stat(template.path)).isFile()) throw new SjsError('The template must be a file.', 'INVALID_FILE_PATH')
          templatePath = template.path
        } else if (extname(args.path).toLowerCase() !== '.xlsx') {
          throw new SjsError('The bundled blank template supports .xlsx only; supply a same-format workspace template for other extensions.', 'INVALID_FILE_PATH')
        }
        file = await resolveDestination(header.cwd, args.path)
        if (exec.signal?.aborted) throw new SjsError('Opening was cancelled.', 'SJS_LIVE_ABORTED')
        try {
          await copyFile(templatePath, file.path, constants.COPYFILE_EXCL)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          throw new SjsError(code === 'EEXIST' ? 'Destination already exists; choose another name.' : 'Could not copy the workbook template.', code === 'EEXIST' ? 'FILE_EXISTS' : 'FILE_COPY_FAILED', { cause: error })
        }
      }
      const path = relative(file.workspace, file.path).split(sep).join('/')
      const address = `dsh-resource://file/session/${encodeURIComponent(header.id)}/${path.split('/').map(encodeURIComponent).join('/')}`
      const result = await channel.execute('', {
        open: { sessionId: header.id, address, timeoutMs: Math.max(1, config.operationTimeoutMs - 1000) },
        timeoutMs: config.operationTimeoutMs,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
      return { ok: true as const, operation: 'live-open' as const, file: file.path, result: { ready: true, created, address: result.file ?? address } }
    },
    presentCall: args => ({ card: 'generic', title: `SpreadJS open: ${args.path}`, kind: 'execute' }),
  })
}
