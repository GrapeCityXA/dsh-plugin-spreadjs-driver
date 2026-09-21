/**
 * `sjs_live_status` — the tool that tells the model whether the live path
 * applies, before it has to bet on it.
 *
 * WHY THIS EXISTS
 *
 * Without it the live path is undiscoverable. The only other way to find out
 * whether a designer is waiting is to run an edit and see — and a model that has
 * to risk a failed edit to learn whether a route is open will take the route
 * that always works. That is exactly what happened in a field session: the model
 * ran `sjs_execute` five times and `sjs_live_execute` zero times, edited a file
 * in a headless engine, and the user's designer never moved — the edit was
 * correct and invisible.
 *
 * It reads host state only — no round trip to the browser, nothing queued — so
 * it is cheap enough to call first, every time, which is what it is for.
 *
 * The three answers it distinguishes are the three things a model would
 * otherwise conflate:
 *
 *  - `transport: unmounted` — this profile can never serve the live path. Stop
 *    reaching for it here.
 *  - `client: none` — no designer is open. The live path would work if one were;
 *    ask the user to open the file, or use the file tools.
 *  - `client: connected` with a workbook listed — that document is on screen, so
 *    an edit the user should see belongs in `sjs_live_execute`. With an empty
 *    list, a designer is open but has no file in it, which is the
 *    `SJS_LIVE_NO_WORKBOOK` case.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '../service/types.ts'
import { operationOutput } from '../tools/presentation.ts'
import type { LiveChannel } from './channel.ts'

/**
 * Reading host state cannot hang, so this is a fraction of an operation
 * timeout — a status call that made the model wait would defeat the point of
 * being cheap enough to try first.
 */
const STATUS_TIMEOUT_MS = 5_000

/** Create the `sjs_live_status` tool definition. */
export function liveStatusTool(ctx: Context, channel: LiveChannel) {
  return defineTool({
    name: 'sjs_live_status',
    description:
      'Report whether a SpreadJS designer is connected in the DSH web UI and which workbook it has open. '
      + 'Call this BEFORE choosing between the live and file paths, whenever the user might be looking at a '
      + 'spreadsheet ("this table", "the sheet I have open", "make the amount column red") — it costs '
      + 'nothing and it is the only reliable way to know whether sjs_live_execute will work. '
      + 'Reads: transport (mounted | unmounted), client (connected | none), and workbooks (each with the '
      + 'file it has open, when the owner knows). If a workbook is listed, edits the user should watch '
      + 'belong in sjs_live_execute. If client is none, use the file tools. If transport is unmounted, '
      + 'this profile cannot serve the live path at all.',
    timeoutMs: STATUS_TIMEOUT_MS,
    parameters: {},
    output: operationOutput,
    async execute() {
      const offered = channel.offered()
      const reachability = channel.reachability
      const result: Record<string, JsonValue> = {
        transport: reachability.ok ? 'mounted' : 'unmounted',
        client: channel.connected ? 'connected' : 'none',
        workbooks: offered.map((workbook) => ({
          id: workbook.id,
          ...(workbook.file === undefined ? {} : { file: workbook.file }),
        })) as unknown as JsonValue,
      }
      // Named separately from `client`: an unmounted channel explains every
      // other line, and leaving it out is how the last field report spent ten
      // tool calls suspecting the browser.
      if (!reachability.ok) result.reason = reachability.reason

      return {
        ok: true as const,
        operation: 'live-status' as const,
        file: '',
        result: result as JsonValue,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'SpreadJS live status', kind: 'read' }),
  })
}
