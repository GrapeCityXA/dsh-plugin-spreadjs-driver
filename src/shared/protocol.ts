/** JSON values accepted across the model tool boundary and the engine process. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Workbook operations currently accepted by the sjs engine. */
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

/** Process response envelope: what one operation produced. */
export type SjsWorkerEnvelope =
  | { readonly ok: true; readonly result: JsonValue }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * Framing over stdio: newline-delimited JSON, one line per message, each reply
 * carrying the id of the request it answers.
 *
 * The engine process lives for many operations, so "everything on stdin is one
 * request and stdout yields one envelope" no longer holds. NDJSON is the framing
 * because it needs no dependency, survives a stream that is split mid-message
 * (a pipe chunk boundary has nothing to do with a message boundary), and matches
 * the diagnostics rule the worker already followed: stdout carries message
 * lines and nothing else, stderr carries everything a human reads.
 *
 * The alternative — length-prefixed frames — buys nothing here (no binary
 * payload crosses this pipe: bytes move over loopback HTTP) and would make the
 * stream unreadable in a terminal during a debugging session.
 */
export interface SjsEngineFrame {
  /** Correlation id minted by the host; the reply carries the same id back. */
  readonly id: number
  readonly request: SjsWorkerRequest
}

/**
 * One reply line. `id` is the id of the request it answers, or `null` for a line
 * the engine could not attribute to any request (an unparseable frame). A null-id
 * reply is a diagnostic only: the host never sends a frame it cannot parse.
 */
export type SjsEngineEnvelope = { readonly id: number | null } & SjsWorkerEnvelope

/** Validate the untrusted engine response before trusting it. */
export function parseSjsEngineEnvelope(value: unknown): SjsEngineEnvelope | null {
  if (!isRecord(value)) return null
  const id = value.id
  if (id !== null && (typeof id !== 'number' || !Number.isSafeInteger(id))) return null
  return parseSjsWorkerEnvelope(value) as SjsEngineEnvelope | null
}

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
