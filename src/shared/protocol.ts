/** JSON values accepted across the model tool boundary and the worker process. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Workbook operations currently accepted by the one-shot sjs worker. */
export type SjsOperation =
  | 'new'
  | 'status'
  | 'execute'
  | 'import'
  | 'export'
  | 'screenshot'

/** One operation accepted by the package-local sjs worker (host-authorized paths). */
export type SjsWorkerRequest =
  | { readonly op: 'new'; readonly targetPath: string }
  | { readonly op: 'status'; readonly sourcePath: string }
  | {
      readonly op: 'execute'
      readonly sourcePath: string
      /** Session workspace root the sandboxed `io` helper may touch. */
      readonly workspaceRoot: string
      readonly code: string
    }
  | { readonly op: 'import'; readonly sourcePath: string; readonly targetPath: string }
  | {
      readonly op: 'export'
      readonly sourcePath: string
      readonly outputPath: string
      readonly format: 'xlsx' | 'csv' | 'ssjson' | 'pdf'
    }
  | {
      readonly op: 'screenshot'
      readonly sourcePath: string
      readonly outputPath: string
      readonly format: 'png' | 'pdf'
    }

/** Process response envelope emitted exactly once on stdout. */
export type SjsWorkerEnvelope =
  | { readonly ok: true; readonly result: JsonValue }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Validate the untrusted worker response before trusting it. */
export function parseSjsWorkerEnvelope(value: unknown): SjsWorkerEnvelope | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  if (value.ok === true && 'result' in value) return value as SjsWorkerEnvelope
  if (value.ok !== false || !isRecord(value.error)) return null
  if (typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return null
  return value as SjsWorkerEnvelope
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
