/**
 * Public surface of the browser-side bridge, plus the minimal client-context
 * shape it needs.
 *
 * The client context type is declared here rather than imported from
 * `@deepseek-ai/dsh-client-runtime`: this bundle must not depend on another
 * package's runtime module, and the only verb used is `provide`.
 */

/** The child context handed to an `inject` callback. */
export interface ClientInjectionContext {
  /** Read a service the callback declared it depends on. */
  get(name: string): unknown
  /** Register a disposer that runs when the declaring fiber disposes. */
  effect(callback: () => (() => void) | void, label?: string): void
}

/** The slice of a cordis client Context this bridge uses. */
export interface ClientContextLike {
  /** Publish a service under `name` for the lifetime of the calling fiber. */
  provide(name: string, value: unknown): void
  effect(callback: () => (() => void) | void, label?: string): void
  /**
   * Run `callback` once the named services exist. The callback may never run —
   * a composition without them is a valid one, and that is how this half stays
   * silent in a profile that has no web server.
   */
  inject(names: readonly string[], callback: (child: ClientInjectionContext) => void): { dispose(): void }
}

/**
 * A host plugin that owns a live SpreadJS workbook and is willing to let this
 * bridge operate on it.
 *
 * The provider is handed over by the owner, never discovered: the owner decides
 * who may touch its document. This bridge publishes no way to *reach* a
 * workbook — only a way to *offer* one.
 */
export interface SpreadjsWorkbookProvider {
  /** Stable identity, used to address one attached workbook among several. */
  readonly id: string
  /** The live workbook, or undefined when nothing is open. */
  getWorkbook(): unknown | undefined
  /**
   * The SpreadJS namespace the owner imported, injected into user code as `GC`
   * so enums (UsedRangeType, HorizontalAlign, chart types …) are reachable.
   * Without it, code that needs an enum cannot run.
   */
  getNamespace?(): unknown
  /** Absolute path of the open file, when there is one. */
  getActivePath?(): string | undefined
  /** Ask the owner to persist the live workbook to its file. */
  save?(): Promise<void>
  /** Owner-side lifecycle changes (opened/closed/saved). */
  subscribe?(listener: () => void): () => void
}

/** What this bridge publishes under `spreadjsHostBridge`. */
export interface SpreadjsHostBridge {
  /**
   * Take custody of a live workbook.
   * @returns a disposer the owner MUST call when it unloads, so the bridge
   *          stops holding a reference to a destroyed document.
   */
  attach(provider: SpreadjsWorkbookProvider): () => void
  /** Ids currently attached, in attach order. Read-only; useful for status. */
  list(): readonly string[]
}

/** The service name both halves agree on. */
export const BRIDGE_SERVICE = 'spreadjsHostBridge'
