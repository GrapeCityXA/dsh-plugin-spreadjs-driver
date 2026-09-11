import type { Context } from '@deepseek-ai/cordis'
import type { SjsWorkerRequest } from '../../shared/protocol.ts'
import { SjsWorker } from '../adapters/worker.ts'
import type { ResolvedConfig } from '../config.ts'
import { SjsService } from '../service/sjs-service.ts'
import type {
  ExecuteCodeRequest,
  ExportFileRequest,
  ImportFileRequest,
  NewFileRequest,
  ScreenshotRequest,
  SjsOperationResult,
  StatusFileRequest,
  WorktreeCreateRequest,
  WorktreeListRequest,
} from '../service/types.ts'
import {
  createWorktreeRecord,
  readWorktreeRegistry,
  worktreeBasePath,
} from '../service/worktrees.ts'
import { assertAuthorizedPath } from '../service/workspace.ts'

/**
 * Local Service Provider: owns the per-call worker process and re-authorizes
 * every request at the provider boundary before handing absolute paths to the
 * worker. Each call spawns a fresh one-shot process, so nothing stateful lives
 * here.
 */
export class SjsProvider extends SjsService {
  private readonly config: ResolvedConfig
  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx)
    this.config = config
    ctx.effect(() => async () => this.dispose(), 'spreadjs: worker lifecycle')
  }

  /** Create one empty .ssjson workbook file. */
  async newFile(request: NewFileRequest, signal?: AbortSignal): Promise<SjsOperationResult> {
    await assertAuthorizedPath(request.workspace, request.targetPath, false)
    const result = await this.request({ op: 'new', targetPath: request.targetPath }, signal)
    return { ok: true, operation: 'new', file: request.targetPath, result }
  }

  /** Read a model-readable summary of one .ssjson workbook file. */
  async status(request: StatusFileRequest, signal?: AbortSignal): Promise<SjsOperationResult> {
    await assertAuthorizedPath(request.workspace, request.filePath, true)
    const result = await this.request({ op: 'status', sourcePath: request.filePath }, signal)
    return { ok: true, operation: 'status', file: request.filePath, result }
  }

  /** Run model-provided JavaScript against one .ssjson workbook and persist it. */
  async execute(request: ExecuteCodeRequest, signal?: AbortSignal): Promise<SjsOperationResult> {
    await assertAuthorizedPath(request.workspace, request.filePath, true)
    const result = await this.request(
      {
        op: 'execute',
        sourcePath: request.filePath,
        workspaceRoot: request.workspace,
        code: request.code,
      },
      signal,
    )
    return { ok: true, operation: 'execute', file: request.filePath, result }
  }

  /** Convert an external spreadsheet file (xlsx/csv/ssjson) into a canonical .ssjson. */
  async importFile(request: ImportFileRequest, signal?: AbortSignal): Promise<SjsOperationResult> {
    await assertAuthorizedPath(request.workspace, request.sourcePath, true)
    await assertAuthorizedPath(request.workspace, request.targetPath, false)
    const result = await this.request(
      { op: 'import', sourcePath: request.sourcePath, targetPath: request.targetPath },
      signal,
    )
    return { ok: true, operation: 'import', file: request.sourcePath, result }
  }

  /** Export a canonical .ssjson workbook to xlsx/csv/ssjson/pdf. */
  async exportFile(request: ExportFileRequest, signal?: AbortSignal): Promise<SjsOperationResult> {
    await assertAuthorizedPath(request.workspace, request.filePath, true)
    await assertAuthorizedPath(request.workspace, request.outputPath, false)
    const result = await this.request(
      { op: 'export', sourcePath: request.filePath, outputPath: request.outputPath, format: request.format },
      signal,
    )
    return { ok: true, operation: 'export', file: request.outputPath, result }
  }

  /** Render a visual snapshot (png pixel render or pdf print layout) of a workbook. */
  async screenshot(request: ScreenshotRequest, signal?: AbortSignal): Promise<SjsOperationResult> {
    await assertAuthorizedPath(request.workspace, request.filePath, true)
    await assertAuthorizedPath(request.workspace, request.outputPath, false)
    const result = await this.request(
      { op: 'screenshot', sourcePath: request.filePath, outputPath: request.outputPath, format: request.format },
      signal,
    )
    return { ok: true, operation: 'screenshot', file: request.outputPath, result }
  }

  /** Branch an isolated draft snapshot off one committed workbook (host-only). */
  async worktreeCreate(request: WorktreeCreateRequest): Promise<SjsOperationResult> {
    await assertAuthorizedPath(request.workspace, request.basePath, true)
    const record = await createWorktreeRecord(request.workspace, request.basePath, request.worktreeId)
    const result = {
      action: 'create',
      worktreeId: record.worktreeId,
      base: record.base,
      draft: record.draft,
      status: record.status,
      createdAt: record.createdAt,
    } as const
    return {
      ok: true,
      operation: 'worktree',
      file: worktreeBasePath(request.workspace, record.draft),
      result,
    }
  }

  /** List drafts currently open in one workspace (host-only). */
  async worktreeList(request: WorktreeListRequest): Promise<SjsOperationResult> {
    const records = await readWorktreeRegistry(request.workspace)
    const result = {
      action: 'list',
      worktrees: records.map((record) => ({
        worktreeId: record.worktreeId,
        base: record.base,
        draft: record.draft,
        status: record.status,
        createdAt: record.createdAt,
      })),
    } as const
    return { ok: true, operation: 'worktree', file: request.workspace, result }
  }

  private async request(request: SjsWorkerRequest, signal?: AbortSignal) {
    return new SjsWorker(this.config.operationTimeoutMs).run(request, signal)
  }

  /** Dispose anything the provider owns (none today; workers are one-shot). */
  async dispose(): Promise<void> {
    // No-op placeholder: per-call workers are self-cleaning.
  }
}
