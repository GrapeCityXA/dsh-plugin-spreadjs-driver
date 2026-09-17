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
  /**
   * Absolute path to the Chromium-based browser that hosts the spreadsheet
   * engine. Leave unset and the plugin finds Microsoft Edge or Google Chrome by
   * itself; set it only when the browser lives somewhere unusual.
   */
  browserPath?: string
}

/** Fully resolved configuration used by the implementation. */
export interface ResolvedConfig {
  readonly operationTimeoutMs: number
  readonly tools: boolean
  readonly skills: boolean
  readonly live: boolean
  readonly browserPath?: string
}

/** Cordis configuration schema. */
export const Config: z<Config> = z.object({
  operationTimeoutMs: z.natural().default(60_000),
  tools: z.boolean().default(true),
  skills: z.boolean().default(true),
  live: z.boolean().default(true),
  // No default on purpose: discovery is automatic (Edge, then Chrome), so an
  // unset value must stay unset rather than pin some hard-coded install path.
  browserPath: z.string(),
})

/** Apply defaults and reject configuration that cannot run. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const resolved: ResolvedConfig = {
    operationTimeoutMs: config.operationTimeoutMs ?? 60_000,
    tools: config.tools ?? true,
    skills: config.skills ?? true,
    live: config.live ?? true,
    ...(config.browserPath === undefined || config.browserPath.length === 0 ? {} : { browserPath: config.browserPath }),
  }
  if (!Number.isSafeInteger(resolved.operationTimeoutMs) || resolved.operationTimeoutMs < 1) {
    throw new Error('spreadjs: operationTimeoutMs must be a positive integer')
  }
  return resolved
}
