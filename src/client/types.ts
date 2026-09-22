/**
 * Public surface of the browser-side bridge registry, plus the minimal
 * client-context shape it needs.
 *
 * The client context type is declared here rather than imported from
 * `@deepseek-ai/dsh-client-runtime`: this bundle must not depend on another
 * package's runtime module, and the only verbs used are `effect` and `inject`.
 *
 * WHY THIS IS A REGISTRY AND NOT A SERVICE THIS PLUGIN PUBLISHES
 *
 * It used to be: this plugin `provide`d `spreadjsHostBridge` and the editor
 * injected it by name. That allowed exactly one bridge, structurally — a second
 * `provide` of a live service name throws, and because the throw lands inside the
 * second plugin's `apply`, that plugin never activates at all. So "let the user
 * choose which plugin drives their workbook" could not be built that way.
 *
 * Now the EDITOR publishes the registry and this plugin registers an entry into
 * it. Two consequences worth knowing:
 *
 *  - The dependency runs provider → editor. That is the honest description of the
 *    relationship — a bridge is a consumer of the editor's workbooks — and it is
 *    still optional: nothing here fires when the editor is absent, and every
 *    other part of this plugin works exactly as before.
 *  - The roster is a list of CANDIDATES, not a broadcast. Exactly one entry is
 *    handed the live document, the one the user selected. The editor remains the
 *    gatekeeper.
 */

/** The child context handed to an `inject` callback. */
export interface ClientInjectionContext {
  /** Read a service the callback declared it depends on. */
  get(name: string): unknown
  /** Register a disposer that runs when the declaring fiber disposes. */
  effect(callback: () => (() => void) | void, label?: string): void
}

/** The slice of a cordis client Context this plugin uses. */
export interface ClientContextLike {
  /** Register a disposer that runs when the calling fiber disposes. */
  effect(callback: () => (() => void) | void, label?: string): void
  /**
   * Run `callback` once the named services exist. The callback may never run —
   * a composition without them is a valid one, and that is how this half stays
   * silent in a profile that has no editor.
   */
  inject(names: readonly string[], callback: (child: ClientInjectionContext) => void): { dispose(): void }
}

/**
 * A live workbook handed over by its owner, plus the few facts a bridge needs.
 *
 * The provider is handed over by the owner, never discovered: the owner decides
 * who may touch its document. The registry publishes no way to *reach* a
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
}

/** What this plugin registers into the editor's roster. */
export interface SpreadjsBridgeEntry {
  /** Unique within the registry; a second registration of the same id throws. */
  readonly id: string
  /** Name shown in the editor's settings list. */
  readonly title: () => string
  /**
   * Take custody of a live workbook.
   * @returns a disposer the caller MUST invoke when it unloads, so the bridge
   *          stops holding a reference to a destroyed document.
   */
  attach(provider: SpreadjsWorkbookProvider): () => void
}

/** The registry the editor publishes. */
export interface SpreadjsBridgeRegistry {
  register(entry: SpreadjsBridgeEntry): () => void
  list(): readonly SpreadjsBridgeEntry[]
  subscribe(listener: () => void): () => void
  /** The id the user chose, registered or not. */
  selected(): string | undefined
  /** The chosen entry, or undefined when nothing is chosen or it is absent. */
  current(): SpreadjsBridgeEntry | undefined
  select(id: string | undefined): void
}

/** The service name the editor publishes; both halves agree on it. */
export const BRIDGE_REGISTRY_SERVICE = 'spreadjsBridgeRegistry'

/**
 * The id this plugin registers under, and the editor's settings namespace it is
 * chosen in — both defined once in `shared/bridge.ts`, because the host half
 * reads the same two names to decide whether it should be present at all.
 */
export { BRIDGE_ID } from '../shared/bridge.ts'
