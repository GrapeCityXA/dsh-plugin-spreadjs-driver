import z from '@deepseek-ai/schemastery'

/** Configuration accepted by the spreadjs plugin. */
export interface Config {
  /** Maximum lifetime of one one-shot sjs worker process (covers boot + operation). */
  operationTimeoutMs?: number
  /** Register model-facing `sjs_*` tools. */
  tools?: boolean
  /** Register the bundled `spreadjs` orchestration skill. */
  skills?: boolean
  /** Let the model edit the workbook open in a connected browser designer. */
  live?: boolean
}

/** Fully resolved configuration used by the implementation. */
export interface ResolvedConfig {
  readonly operationTimeoutMs: number
  readonly tools: boolean
  readonly skills: boolean
  readonly live: boolean
}

/** Cordis configuration schema. */
export const Config: z<Config> = z.object({
  operationTimeoutMs: z.natural().default(60_000),
  tools: z.boolean().default(true),
  skills: z.boolean().default(true),
  live: z.boolean().default(true),
})

/** Apply defaults and reject configuration that cannot run. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const resolved: ResolvedConfig = {
    operationTimeoutMs: config.operationTimeoutMs ?? 60_000,
    tools: config.tools ?? true,
    skills: config.skills ?? true,
    live: config.live ?? true,
  }
  if (!Number.isSafeInteger(resolved.operationTimeoutMs) || resolved.operationTimeoutMs < 1) {
    throw new Error('spreadjs: operationTimeoutMs must be a positive integer')
  }
  return resolved
}
