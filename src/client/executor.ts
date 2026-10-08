/**
 * Run agent-supplied code against a *live* workbook, inside the page that owns
 * it — so a style, formula or sheet change is on screen the moment it lands.
 *
 * This mirrors the semantics of the host-side `sjs_execute` deliberately: same
 * injected names, same paint discipline, same error classification. The one
 * thing that cannot be mirrored is the isolation: the host runs user code in a
 * `node:vm` context, and a browser has no equivalent. `new Function` gives a
 * fresh scope but not a wall — code here can still reach the page's globals.
 * That is a documented limitation of the live path, not an oversight.
 */
import type { SpreadjsWorkbookProvider } from './types.ts'

/** Structured outcome, carrying the same codes the host-side tools use. */
export type LiveResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Names injected into user code, matching the host-side execute environment. */
const INJECTED = ['spread', 'workbook', 'GC', 'sheet', 'snapshot', 'console'] as const

/** Cap the serialized result the same way the host-side path does. */
const MAX_RESULT_CHARS = 200_000

interface WorkbookLike {
  suspendPaint?(): void
  resumePaint?(): void
  getActiveSheet?(): unknown
  getSheetCount?(): number
  getSheet?(index: number): unknown
}

interface SheetLike {
  name?(): string
}

/** Resolve a sheet by name, or the active one when no name is given. */
function resolveSheet(workbook: WorkbookLike, name?: string): unknown {
  if (name === undefined || name === '') {
    const active = workbook.getActiveSheet?.()
    if (active === undefined || active === null) throw liveError('SJS_SHEET_NOT_FOUND', 'workbook has no active sheet')
    return active
  }
  // Scan by index: the by-name dictionary is not reliable in every engine build.
  const count = workbook.getSheetCount?.() ?? 0
  for (let index = 0; index < count; index++) {
    const candidate = workbook.getSheet?.(index) as SheetLike | undefined
    if (candidate !== undefined && candidate !== null && typeof candidate.name === 'function' && candidate.name() === name) {
      return candidate
    }
  }
  throw liveError('SJS_SHEET_NOT_FOUND', `sheet not found: ${JSON.stringify(name)}`)
}

/** A workbook summary shaped like the host-side `snapshot()`. */
function summarize(workbook: WorkbookLike): unknown {
  const count = workbook.getSheetCount?.() ?? 0
  const sheets: unknown[] = []
  for (let index = 0; index < count; index++) {
    const sheet = workbook.getSheet?.(index) as SheetLike | undefined
    sheets.push({ name: sheet?.name?.() ?? `Sheet${String(index)}` })
  }
  return { sheets, sheetCount: count }
}

function liveError(code: string, message: string): Error {
  const error = new Error(message)
  ;(error as { code?: string }).code = code
  return error
}

/** A short, safe description of a thrown value. */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

/**
 * Which line of the caller's script a failure came from.
 *
 * The message alone is not enough to act on. A failure raised INSIDE SpreadJS
 * names an internal method the script never wrote — one real report read
 * `Cannot read properties of undefined (reading 'getRowCount')` while
 * `getRowCount` appeared in neither the submitted script nor this plugin, and the
 * model spent three retries guessing which statement did it.
 *
 * The code runs through `new Function`, so the engine's frames for it carry
 * `<anonymous>:LINE:COL`. Ahead of the caller's first line sit two things: the
 * wrapper the engine synthesizes around a `new Function` body, and this file's
 * own prelude. The prelude is known here; the wrapper is not ours — it is
 * whatever the engine emits — so it is MEASURED once (one throw, cached) rather
 * than assumed. It currently comes out as 2, on both this path and the worker's.
 *
 * If it cannot be measured the location is omitted and only the message is
 * reported: a line number that is off by the wrapper reads as fact and is worse
 * than no line at all.
 */
const PRELUDE_LINES = 1 // 'return (async () => {\n'

/** Cached wrapper measurement: a count, or -1 when it could not be measured. */
let wrapperLines: number | undefined

function measuredWrapperLines(): number | undefined {
  if (wrapperLines === undefined) {
    wrapperLines = -1
    try {
      // Runs and throws immediately; the frame it produces is the only thing wanted.
      new Function('throw new Error("probe")')()
    } catch (error) {
      const found = /<anonymous>:(\d+):\d+/.exec((error as { stack?: string }).stack ?? '')
      if (found !== null && found[1] !== undefined) wrapperLines = Number(found[1]) - 1
    }
  }
  return wrapperLines < 0 ? undefined : wrapperLines
}

/**
 * ` — from your line N: <source>` naming the deepest frame that is the caller's
 * own code, or `''` when it cannot be located.
 *
 * Empty rather than approximate on purpose: a line number that is off by the
 * wrapper count is worse than none, because it reads as fact.
 */
function locateInUserCode(error: unknown, code: string): string {
  const stack = (error as { stack?: unknown }).stack
  const wrapper = measuredWrapperLines()
  if (typeof stack !== 'string' || wrapper === undefined) return ''
  const lines = code.split('\n')
  for (const frame of stack.matchAll(/<anonymous>:(\d+):\d+/g)) {
    const line = Number(frame[1]) - wrapper - PRELUDE_LINES
    // A frame outside the caller's own range is the wrapper itself, not their code.
    if (line >= 1 && line <= lines.length) {
      return ` — from your line ${line}: ${(lines[line - 1] ?? '').trim()}`
    }
  }
  return ''
}

/**
 * JSON-round-trip the returned value, the way the host side does, so a
 * non-serializable result fails this call instead of poisoning the transcript.
 */
function serializeSafe(value: unknown): unknown {
  if (value === undefined) return null
  let text: string
  try {
    text = JSON.stringify(value) ?? 'null'
  } catch {
    throw liveError('SJS_NON_SERIALIZABLE_RESULT', 'return value is not JSON-serializable')
  }
  if (text.length > MAX_RESULT_CHARS) {
    throw liveError(
      'SJS_RESULT_TOO_LARGE',
      `script returned more than ${String(MAX_RESULT_CHARS)} characters; return a compact summary or call snapshot()`,
    )
  }
  return JSON.parse(text) as unknown
}

/**
 * Execute `code` against the workbook this provider owns.
 *
 * Paint is suspended for the duration and always resumed, exactly as the
 * host-side path does — without the matching resume the designer would sit on
 * a stale frame.
 */
export async function runAgainstProvider(
  provider: SpreadjsWorkbookProvider,
  code: string,
): Promise<LiveResult> {
  const workbook = provider.getWorkbook() as WorkbookLike | undefined
  if (workbook === undefined || workbook === null) {
    // The designer panel exists but nothing is open in it. Say what to DO: this
    // is a normal state (the panel is mounted before a file is picked), not a
    // fault, and the caller can fix it. Naming the internal provider id here
    // only cost the reader a turn.
    return {
      ok: false,
      code: 'SJS_LIVE_NO_WORKBOOK',
      message: 'The designer is connected but no spreadsheet is open in it. '
        + 'Ask the user to open the file in the Web UI sidebar, or do this work against a file with sjs_execute.',
    }
  }

  let fn: (...args: unknown[]) => unknown
  try {
    fn = new Function(...INJECTED, `return (async () => {\n${code}\n})()`) as (...args: unknown[]) => unknown
  } catch (error) {
    return { ok: false, code: 'SJS_SCRIPT_ERROR', message: `syntax error: ${messageOf(error)}` }
  }

  workbook.suspendPaint?.()
  try {
    const value = await fn(
      workbook,
      workbook,
      provider.getNamespace?.() ?? undefined,
      (name?: string) => resolveSheet(workbook, name),
      () => summarize(workbook),
      console,
    )
    if (value === undefined) return { ok: true, value: summarize(workbook) }
    return { ok: true, value: serializeSafe(value) }
  } catch (error) {
    const code2 = (error as { code?: unknown }).code
    return {
      ok: false,
      code: typeof code2 === 'string' ? code2 : 'SJS_SCRIPT_ERROR',
      // The location matters most when the failure came from inside SpreadJS:
      // the message then names a method the caller never wrote, and without the
      // line there is nothing to act on but a retry.
      message: messageOf(error) + locateInUserCode(error, code),
    }
  } finally {
    workbook.resumePaint?.()
  }
}
