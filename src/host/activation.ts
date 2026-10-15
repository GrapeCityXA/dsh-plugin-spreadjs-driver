/** Keep tools and skill registered only for an explicit editor selection. */
import type { Context } from '@deepseek-ai/cordis'
import { BRIDGE_FIELD, BRIDGE_ID, EDITOR_SETTINGS_NAMESPACE } from '../shared/bridge.ts'

export interface ActivationSource {
  chosen(): string | undefined
}

export interface ActivationOptions {
  readonly id: string
  readonly source: ActivationSource
  readonly activate: () => () => void
}

export interface Activation {
  sync(): void
  active(): boolean
  release(): void
}

export function createActivation(options: ActivationOptions): Activation {
  let release: (() => void) | undefined

  const wanted = (): boolean => {
    const chosen = options.source.chosen()
    return chosen === options.id
  }

  const releaseNow = (): void => {
    try {
      release?.()
    } catch (error) {
      console.error('[dsh-spreadjs-driver] dropping tools failed:', error)
    }
    release = undefined
  }

  return {
    sync(): void {
      const want = wanted()
      if (want === (release !== undefined)) return
      if (!want) {
        releaseNow()
        return
      }
      release = options.activate()
    },
    active(): boolean {
      return release !== undefined
    },
    release: releaseNow,
  }
}

interface SettingsLike {
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; value: unknown }>
}

export function readChosenBridge(ctx: Context, namespace = EDITOR_SETTINGS_NAMESPACE): string | undefined {
  try {
    const settings = (ctx as unknown as { get(name: string): unknown }).get('settings') as
      | SettingsLike
      | undefined
    if (settings === undefined || typeof settings.describe !== 'function') return undefined
    const entry = settings
      .describe()
      .find((descriptor) => descriptor.ns === namespace)
    if (entry === undefined) return undefined
    const section = entry.value
    if (typeof section !== 'object' || section === null) return undefined
    const value = (section as Record<string, unknown>)[BRIDGE_FIELD]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export function keepPresent(ctx: Context, row: string, activate: () => () => void, namespace = EDITOR_SETTINGS_NAMESPACE): void {
  const activation = createActivation({
    id: BRIDGE_ID,
    source: { chosen: () => readChosenBridge(ctx, namespace) },
    activate,
  })

  ctx.effect(() => {
    const onDocument = ctx.on('settings/document-updated', (ns: string) => {
      if (ns === namespace) activation.sync()
    })
    activation.sync()
    return () => {
      onDocument()
      activation.release()
    }
  }, `dsh-spreadjs-driver: ${row} presence follows the chosen bridge`)
  ctx.inject(['settings'], () => {
    activation.sync()
  })
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'settings/document-updated'(namespace: string, revision: number): void
  }
}
