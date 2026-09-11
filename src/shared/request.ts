/**
 * Runtime validation of the untrusted JSON request the worker receives on
 * stdin. The host authorizes paths before sending, so this is defensive only —
 * but a misbehaving or corrupted request must fail fast with a clear message,
 * never crash mid-operation.
 */
import { isRecord } from './protocol.ts'
import type { SjsWorkerRequest } from './protocol.ts'

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
