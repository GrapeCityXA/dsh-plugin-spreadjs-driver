import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Maximum wait for an operation on the editor's workbook. */
  operationTimeoutMs?: number
  /** Register model-facing live workbook tools. */
  tools?: boolean
  /** Register the bundled orchestration skill alongside the tools. */
  skills?: boolean
}

export interface ResolvedConfig {
  readonly operationTimeoutMs: number
  readonly tools: boolean
  readonly skills: boolean
}

export const Config: z<Config> = z.object({
  operationTimeoutMs: z.natural().default(60_000),
  tools: z.boolean().default(true),
  skills: z.boolean().default(true),
})

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const legacy = config as Config & { browserPath?: unknown; live?: unknown }
  if (legacy.browserPath !== undefined || legacy.live !== undefined) {
    throw new Error('spreadjs: browserPath and live were removed. This driver requires a workbook supplied by the web editor.')
  }
  const resolved = {
    operationTimeoutMs: config.operationTimeoutMs ?? 60_000,
    tools: config.tools ?? true,
    skills: config.skills ?? true,
  }
  if (!Number.isSafeInteger(resolved.operationTimeoutMs) || resolved.operationTimeoutMs < 1) {
    throw new Error('spreadjs: operationTimeoutMs must be a positive integer')
  }
  return resolved
}
