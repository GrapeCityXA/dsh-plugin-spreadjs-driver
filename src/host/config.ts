import z from '@deepseek-ai/schemastery'
import { EDITOR_SETTINGS_NAMESPACE } from '../shared/bridge.ts'

export interface Config {
  /** Settings namespace of the compatible editor that owns the bridge choice. */
  editorSettingsNamespace?: string
  /** Maximum wait for an operation on the editor's workbook. */
  operationTimeoutMs?: number
  /** Register model-facing live workbook tools. */
  tools?: boolean
  /** Register the bundled orchestration skill alongside the tools. */
  skills?: boolean
}

export interface ResolvedConfig {
  readonly editorSettingsNamespace: string
  readonly operationTimeoutMs: number
  readonly tools: boolean
  readonly skills: boolean
}

export const Config: z<Config> = z.object({
  editorSettingsNamespace: z.string().default(EDITOR_SETTINGS_NAMESPACE),
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
    editorSettingsNamespace: config.editorSettingsNamespace ?? EDITOR_SETTINGS_NAMESPACE,
    operationTimeoutMs: config.operationTimeoutMs ?? 60_000,
    tools: config.tools ?? true,
    skills: config.skills ?? true,
  }
  if (!Number.isSafeInteger(resolved.operationTimeoutMs) || resolved.operationTimeoutMs < 1) {
    throw new Error('spreadjs: operationTimeoutMs must be a positive integer')
  }
  if (typeof resolved.editorSettingsNamespace !== 'string' || !/^[a-z][a-z0-9-]*$/.test(resolved.editorSettingsNamespace)) {
    throw new Error('spreadjs: editorSettingsNamespace must be a valid DSH settings namespace')
  }
  return resolved
}
