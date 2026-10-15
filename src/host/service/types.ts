export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface SjsOperationResult {
  readonly ok: true
  readonly operation: 'live' | 'live-status'
  readonly file: string
  readonly result: JsonValue
}
