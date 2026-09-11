import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SjsOperationResult } from '../service/types.ts'

/** Output schema shared by all SpreadJS operation tools. */
export const operationOutput = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' as const, required: true, const: true },
      operation: {
        type: 'string' as const,
        required: true,
        enum: ['new', 'status', 'execute', 'import', 'export', 'worktree', 'screenshot'] as const,
      },
      file: { type: 'string' as const, required: true },
      result: { type: 'json' as const, required: true },
    },
  },
  render: (_args: unknown, value: SjsOperationResult) => [{ type: 'text' as const, text: renderSjsOperationResult(value) }],
} as const

/** Pure text projection of a structured SpreadJS operation result. */
export function renderSjsOperationResult(value: SjsOperationResult): string {
  return JSON.stringify(value)
}

/** Pure generic-card title for one SpreadJS operation. */
export function operationTitle(operation: string, file: string): string {
  return `SpreadJS ${operation}: ${file}`
}

/** Keep stable SpreadJS failure codes visible to the model while preserving DSH-owned result fields. */
export function withSjsErrorContent(definition: ToolDefinition): ToolDefinition {
  const finalizeContent = definition.finalizeContent?.bind(definition)
  return {
    ...definition,
    finalizeContent(exec, result) {
      if (result.isError && result.error.info?.name === 'SjsError') {
        return [{ type: 'text', text: `Error [${result.error.info.code}]: ${result.error.message}` }]
      }
      return finalizeContent?.(exec, result)
    },
  }
}
