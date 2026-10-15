import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '../service/types.ts'
import { operationOutput } from '../tools/presentation.ts'
import type { LiveChannel } from './channel.ts'
import { SjsError } from '../service/errors.ts'

/** Report only workbooks the editor has actually made available. */
export function liveStatusTool(_ctx: Context, channel: LiveChannel) {
  return defineTool({
    name: 'sjs_live_status',
    description: 'Report editor-supplied Workbooks available in the calling chat, with opaque target ids. Call before editing and refresh after reloading. '
      + 'If none is available, open a spreadsheet in the editor and select this driver in Settings → Spreadsheet Editor. '
      + 'An unmounted transport requires a web profile. Spreadsheet operations require the editor.',
    timeoutMs: 5_000,
    parameters: {},
    output: operationOutput,
    async execute(_args, exec) {
      const sessionId = exec.agent?.session.header.id
      if (!sessionId) throw new SjsError('Status requires a calling session.', 'SESSION_SCOPE_UNAVAILABLE')
      const reachability = channel.reachability
      const workbooks = channel.offered(sessionId)
      const result: Record<string, JsonValue> = {
        transport: reachability.ok ? 'mounted' : 'unmounted',
        client: channel.hasSession(sessionId) ? 'connected' : 'none',
        workbooks: workbooks.map(workbook => ({ id: workbook.id, file: workbook.file ?? '', instanceId: workbook.instanceId ?? '' })),
      }
      if (!reachability.ok) result.reason = reachability.reason
      if (reachability.ok && workbooks.length === 0) {
        result.hint = 'Open a spreadsheet in the editor, wait for it to load, and select SpreadJS Driver in Settings → Spreadsheet Editor.'
      }
      return { ok: true as const, operation: 'live-status' as const, file: '', result }
    },
    presentCall: () => ({ card: 'generic', title: 'SpreadJS live status', kind: 'read' }),
  })
}
