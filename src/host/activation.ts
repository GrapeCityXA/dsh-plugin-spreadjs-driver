/**
 * Whether this plugin's tools should exist right now, kept in step with the
 * bridge the user chose.
 *
 * WHY THIS EXISTS
 *
 * Two driver-like plugins can be installed at once. The bridge layer already
 * arbitrates that — only the chosen entry is handed the workbook — but the TOOL
 * layer does not: every installed plugin's tools sit in the model's catalog side
 * by side, and nothing tells the model which set goes with the choice it is
 * looking at. The result is two overlapping capabilities and a model picking
 * between them by guesswork.
 *
 * So this plugin lets go of its own tools when the user has chosen someone else.
 * Unilaterally: it reads a fact, it decides, it acts on itself. It needs to know
 * nothing about the other implementation — not its name, not whether it exists,
 * not whether it will reciprocate.
 *
 * THE STATE IS DERIVED, NOT REMEMBERED
 *
 * The obvious way to get this wrong is to treat "unregistered" as a state the
 * plugin enters and must later leave — because then something has to remember
 * when to come back, and whatever remembers it can be lost (a reload, a crash, an
 * unload). Here the presence of the tools is a pure function of the current
 * choice, re-evaluated on every event:
 *
 *     chosen is nothing  → present     (no choice means no opinion)
 *     chosen is us       → present
 *     chosen is another  → absent
 *
 * Which gives three properties worth naming:
 *
 *  - **Idempotent.** Evaluating twice changes nothing, so the two settings
 *    events that can fire for one change are harmless.
 *  - **Self-healing.** Any event re-derives the answer, so there is no state to
 *    desynchronise and nothing to restore after a reload.
 *  - **Stateless.** The plugin never records "I turned myself off", so there is
 *    no memory anywhere — in this plugin or another — that can be lost.
 *
 * FAIL-OPEN, DELIBERATELY
 *
 * Every way of not knowing lands on "present": no settings service, a namespace
 * the editor has not registered, a value that is not a string. The two failures
 * are not symmetrical — being absent when the user needed us costs them their
 * tools, while being present with nothing to do costs them a line in a catalog.
 * So every doubt resolves the same way.
 *
 * SCOPE — EVERYTHING THIS PLUGIN PUTS IN FRONT OF THE MODEL
 *
 * All three rows gate on the choice: the seven file tools, the two live ones,
 * and the bundled `spreadjs` skill. The reading is that the setting names the
 * plugin that owns spreadsheets in this deployment, not merely the one that
 * receives the live document. A driver that ships no file tools of its own
 * therefore leaves the user without them, which is the intended trade: one
 * implementation, one set of capabilities, nothing left for the model to guess
 * between.
 *
 * The skill is in scope for the same reason and not as an afterthought: it is
 * the document that teaches the model to use these tools by name. Leaving it
 * registered while its tools are gone would hand the model a manual for a
 * capability it does not have — which is precisely the confusion the gating
 * exists to remove, and worse than a merely redundant tool, because a skill
 * reads as authoritative.
 */
import type { Context } from '@deepseek-ai/cordis'
import { BRIDGE_FIELD, BRIDGE_ID, EDITOR_SETTINGS_NAMESPACE } from '../shared/bridge.ts'

/** What the decision depends on. */
export interface ActivationSource {
  /**
   * The chosen bridge id, or undefined when nothing is chosen or nothing could
   * be read. Both mean the same thing to this plugin — see the note on
   * fail-open above.
   */
  chosen(): string | undefined
}

export interface ActivationOptions {
  /** The id this plugin registers under in the roster. */
  readonly id: string
  readonly source: ActivationSource
  /**
   * Bring the tools into existence.
   * @returns how to take them away again.
   */
  readonly activate: () => () => void
}

export interface Activation {
  /** Bring the tools in line with the current choice. Idempotent. */
  sync(): void
  /** Whether the tools are registered right now. */
  active(): boolean
  /** Take them away whatever the choice says — for teardown. */
  release(): void
}

/** Create the presence controller. Pure: no cordis, no settings, no I/O. */
export function createActivation(options: ActivationOptions): Activation {
  let release: (() => void) | undefined

  const wanted = (): boolean => {
    const chosen = options.source.chosen()
    if (chosen === undefined || chosen === '') return true
    return chosen === options.id
  }

  const releaseNow = (): void => {
    try {
      release?.()
    } catch (error) {
      // A disposer that throws must not wedge the loop: the next sync would then
      // see `release` still set and skip re-registering forever.
      console.error('[dsh-spreadjs-driver] dropping tools failed:', error)
    }
    release = undefined
  }

  return {
    sync(): void {
      const want = wanted()
      // Compared against the CURRENT state rather than acted on unconditionally:
      // re-registering a live tool would remove and re-add it in the model's
      // catalog, which the loop reports as a change.
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

/**
 * The slice of the host settings service this plugin reads.
 *
 * Declared structurally rather than imported: `@deepseek-ai/dsh-settings` is not
 * a dependency, and the only thing needed from it is one method's shape.
 *
 * `describe` is not a convenience here, it is the only way in. DSH 0.1.7 models
 * settings as one namespace per Loader entry — the entry's id, resolved from
 * that entry's Config — so the per-namespace read this used to do
 * (`settings.get(ns)`) no longer exists. `describe()` returns one descriptor per
 * entry, and that is what makes a cross-plugin read possible at all.
 */
interface SettingsLike {
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; value: unknown }>
}

/**
 * The bridge id the user has chosen, or undefined when there is nothing to read.
 *
 * Every failure returns undefined, which the activation reads as "no choice" and
 * therefore as "present". Reached through `ctx.get` rather than injection so this
 * stays readable from any callback, and wrapped because a service that is present
 * but shaped unexpectedly must not take the tools down with it.
 *
 * That catch-all has one cost, and it has already been paid once: when 0.1.7
 * removed `settings.get`, this function kept returning undefined rather than
 * failing, so the plugin answered "present" forever and the yield protocol went
 * silent with nothing in any log. Only the method changed; the fail-open
 * contract is unchanged and still deliberate.
 *
 * `redactSecrets` is deliberately not requested — this is a host-local read, and
 * redaction can only remove fields. The bridge id is not a secret.
 */
export function readChosenBridge(ctx: Context): string | undefined {
  try {
    const settings = (ctx as unknown as { get(name: string): unknown }).get('settings') as
      | SettingsLike
      | undefined
    if (settings === undefined || typeof settings.describe !== 'function') return undefined
    const entry = settings
      .describe()
      .find((descriptor) => descriptor.ns === EDITOR_SETTINGS_NAMESPACE)
    if (entry === undefined) return undefined
    const section = entry.value
    if (typeof section !== 'object' || section === null) return undefined
    const value = (section as Record<string, unknown>)[BRIDGE_FIELD]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Keep one row's contribution present according to the choice.
 *
 * Each plugin row calls this with its own registration, so the rows stay
 * independent in their dependencies — the file tools need the engine, the live
 * tools need a channel, the skill needs the skill service — while agreeing on
 * the one question that decides whether any of them should be there at all.
 *
 * @param row - named in the effect label, so a host log says which row moved.
 */
export function keepPresent(ctx: Context, row: string, activate: () => () => void): void {
  const activation = createActivation({
    id: BRIDGE_ID,
    source: { chosen: () => readChosenBridge(ctx) },
    activate,
  })

  ctx.effect(() => {
    // One event, filtered by namespace so another plugin's settings do not wake
    // us. This used to subscribe to `settings/updated` as well; that event no
    // longer exists in 0.1.7 — and `document-updated` is the one that carries a
    // cleared-back-to-default change anyway, which is the case the second
    // subscription was guarding.
    const onDocument = ctx.on('settings/document-updated', (ns: string) => {
      if (ns === EDITOR_SETTINGS_NAMESPACE) activation.sync()
    })
    // The first evaluation lives here rather than in an injection, so the tools
    // exist from the start whatever the settings service does.
    activation.sync()
    return () => {
      onDocument()
      activation.release()
    }
  }, `dsh-spreadjs-driver: ${row} presence follows the chosen bridge`)

  // Settings may come up after this plugin. Re-evaluating once it does closes the
  // window where the choice was already "someone else" and nothing had changed
  // since to announce it — namespace registration emits no event.
  ctx.inject(['settings'], () => {
    activation.sync()
  })
}

/**
 * The settings event this plugin listens to, declared here rather than imported
 * from `@deepseek-ai/dsh-settings` — that package is not a dependency, and the
 * only thing needed from it is the augmentation its types carry. The shape is
 * the one its own declaration uses.
 *
 * It is the only settings event there is in 0.1.7: a companion `settings/updated`
 * that 0.1.5 also emitted is gone.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'settings/document-updated'(namespace: string, revision: number): void
  }
}
