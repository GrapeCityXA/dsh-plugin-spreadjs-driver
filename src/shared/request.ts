/**
 * Runtime validation of the untrusted JSON the engine receives on stdin. The
 * host authorizes paths before sending, so this is defensive only — but a
 * misbehaving or corrupted request must fail fast with a clear message, never
 * crash mid-operation.
 */
import { isRecord } from './protocol.ts'
import type { SjsEngineFrame, SjsWorkerRequest } from './protocol.ts'

const OPS = new Set(['new', 'status', 'execute', 'import', 'export', 'screenshot'])
const EXPORT_FORMATS = new Set(['xlsx', 'csv', 'ssjson', 'pdf'])
const SCREENSHOT_FORMATS = new Set(['png', 'pdf'])

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`field "${field}" must be a non-empty string`)
  }
  return value
}

/** Validate an untrusted value as a worker request; throws on any mismatch. */
export function parseSjsWorkerRequest(value: unknown): SjsWorkerRequest {
  if (!isRecord(value)) throw new Error('request must be a JSON object')
  const op = stringField(value.op, 'op')
  if (!OPS.has(op)) throw new Error(`unknown op: ${JSON.stringify(op)}`)

  switch (op) {
    case 'new':
      stringField(value.targetPath, 'targetPath')
      break
    case 'status':
      stringField(value.sourcePath, 'sourcePath')
      break
    case 'execute':
      stringField(value.sourcePath, 'sourcePath')
      stringField(value.workspaceRoot, 'workspaceRoot')
      stringField(value.code, 'code')
      break
    case 'import':
      stringField(value.sourcePath, 'sourcePath')
      stringField(value.targetPath, 'targetPath')
      break
    case 'export':
      stringField(value.sourcePath, 'sourcePath')
      stringField(value.outputPath, 'outputPath')
      if (!EXPORT_FORMATS.has(stringField(value.format, 'format'))) {
        throw new Error(`unsupported export format: ${JSON.stringify(value.format)}`)
      }
      break
    case 'screenshot':
      stringField(value.sourcePath, 'sourcePath')
      stringField(value.outputPath, 'outputPath')
      if (value.format !== undefined && !SCREENSHOT_FORMATS.has(stringField(value.format, 'format'))) {
        throw new Error(`unsupported screenshot format: ${JSON.stringify(value.format)}`)
      }
      break
  }
  return value as SjsWorkerRequest
}

/**
 * The id a frame claims, or null when the frame cannot be attributed.
 *
 * Read BEFORE the request body is validated, so a request the engine rejects
 * still gets a correlatable reply rather than an anonymous one. It never throws:
 * a caller uses it to decide the `id` of the error it is about to report.
 */
export function engineFrameId(value: unknown): number | null {
  if (!isRecord(value)) return null
  const id = value.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null
  return id
}

/** Validate an untrusted `{id, request}` frame; throws on any mismatch. */
export function parseSjsEngineFrame(value: unknown): SjsEngineFrame {
  const id = engineFrameId(value)
  if (id === null) throw new Error('frame "id" must be a non-negative integer')
  return { id, request: parseSjsWorkerRequest((value as { request?: unknown }).request) }
}
