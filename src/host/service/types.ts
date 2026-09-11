/** JSON values accepted across the model tool boundary and the worker process. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Workbook operations offered to the model (subset may change between tasks). */
export type SjsOperation =
  | 'new'
  | 'status'
  | 'execute'
  | 'import'
  | 'export'
  | 'worktree'
  | 'screenshot'

/** Structured operation result logged in the DSH session. */
export interface SjsOperationResult {
  readonly ok: true
  readonly operation: SjsOperation
  readonly file: string
  readonly result: JsonValue
}

/** Create an empty .ssjson workbook file in one authorized workspace. */
export interface NewFileRequest {
  readonly workspace: string
  readonly targetPath: string
}

/** Read a model-readable summary of one .ssjson workbook file. */
export interface StatusFileRequest {
  readonly workspace: string
  readonly filePath: string
}

/** Run model-provided JavaScript against one .ssjson workbook and persist it. */
export interface ExecuteCodeRequest {
  readonly workspace: string
  readonly filePath: string
  readonly code: string
}

/** Convert an external spreadsheet file (xlsx/csv/ssjson) into a canonical .ssjson. */
export interface ImportFileRequest {
  readonly workspace: string
  /** Source file already inside the authorized workspace (xlsx/csv/ssjson). */
  readonly sourcePath: string
  /** New .ssjson target inside the same workspace. */
  readonly targetPath: string
}

/** Export a canonical .ssjson workbook to an external file format. */
export interface ExportFileRequest {
  readonly workspace: string
  /** Existing .ssjson workbook to export. */
  readonly filePath: string
  /** Output file (extension conveys format to the model; worker uses `format`). */
  readonly outputPath: string
  readonly format: 'xlsx' | 'csv' | 'ssjson' | 'pdf'
}

/** Render a visual snapshot of one .ssjson workbook (png raster or pdf print). */
export interface ScreenshotRequest {
  readonly workspace: string
  /** Existing .ssjson workbook to snapshot. */
  readonly filePath: string
  /** Output file: .png (pixel render) or .pdf (print-layout snapshot). */
  readonly outputPath: string
  readonly format: 'png' | 'pdf'
}

/**
 * Lifecycle of one file-level worktree draft.
 *
 * Phase 1 produces `editing` drafts only. `ready` / `merged` / `discarded`
 * reserve the phase-2 approval surface: phase 1 never transitions drafts, so a
 * draft can never silently overwrite its base workbook.
 */
export type WorktreeStatus = 'editing' | 'ready' | 'merged' | 'discarded'

/** One open draft recorded in the workspace worktree registry. */
export interface WorktreeRecord {
  readonly worktreeId: string
  /** Workspace-relative .ssjson the draft was branched from. */
  readonly base: string
  /** Workspace-relative .ssjson snapshot the model edits. */
  readonly draft: string
  readonly status: WorktreeStatus
  /** sha256 of the base at branch time (lets phase-2 merge detect drift). */
  readonly baseSha256: string
  readonly createdAt: string
}

/** Branch an isolated draft snapshot off one existing .ssjson workbook. */
export interface WorktreeCreateRequest {
  readonly workspace: string
  /** Existing .ssjson base workbook (absolute, host-authorized). */
  readonly basePath: string
  /** Optional human label; defaults to a unique id derived from the base name. */
  readonly worktreeId?: string
}

/** List drafts currently open in one workspace. */
export interface WorktreeListRequest {
  readonly workspace: string
}

/** Stable methods offered by the spreadjs service. */
export interface SjsServiceMethods {
  newFile(request: NewFileRequest, signal?: AbortSignal): Promise<SjsOperationResult>
  status(request: StatusFileRequest, signal?: AbortSignal): Promise<SjsOperationResult>
  execute(request: ExecuteCodeRequest, signal?: AbortSignal): Promise<SjsOperationResult>
  importFile(request: ImportFileRequest, signal?: AbortSignal): Promise<SjsOperationResult>
  exportFile(request: ExportFileRequest, signal?: AbortSignal): Promise<SjsOperationResult>
  screenshot(request: ScreenshotRequest, signal?: AbortSignal): Promise<SjsOperationResult>
  worktreeCreate(request: WorktreeCreateRequest, signal?: AbortSignal): Promise<SjsOperationResult>
  worktreeList(request: WorktreeListRequest, signal?: AbortSignal): Promise<SjsOperationResult>
}
