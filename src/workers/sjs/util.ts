/** Small helpers shared across worker operation handlers and the PNG renderer. */

/** Extract a readable message from an arbitrary thrown value. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/** Basename of a path with the last extension stripped (e.g. a PDF document title). */
export function basenameWithoutExtension(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}
