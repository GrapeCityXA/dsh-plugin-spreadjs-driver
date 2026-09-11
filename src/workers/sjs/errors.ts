/**
 * Worker-internal classified failure, surfaced to the host as an error envelope.
 * Lives in its own module so operation handlers and the PNG renderer can throw
 * the same codes without a circular import.
 */
export class SjsWorkerError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
    this.name = 'SjsWorkerError'
  }
}
