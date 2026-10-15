# SpreadJS editor / driver bridge contract

This is a structural browser interface for DSH plugins. Implementations do not import or depend on either GrapeCity plugin package. A compatible editor owns the licensed SpreadJS Workbook, its UI, loading, saving and recovery. A driver consumes the live reference offered by that editor. Using SpreadJS alone does not establish compatibility: both sides must implement this contract and use APIs supported by the owner's SpreadJS version and loaded modules.

## Registry and selection

The editor publishes the Cordis client service `spreadjsBridgeRegistry`. A driver injects that service and calls `register({ id, title, attach })`. Use the driver's own globally unique plugin/package id; neither the service nor its entries are restricted to GrapeCity package names. `attach(provider)` returns an idempotent disposer. The editor attaches only the entry explicitly selected by the user and detaches it on selection changes or teardown. The registry is owned by one editor or coordinator per DSH profile; installing two independent owners of the same Cordis service is not supported.

```ts
interface SpreadjsBridgeEntry {
  readonly id: string
  readonly title: () => string
  attach(provider: SpreadjsWorkbookProvider): () => void
}

interface SpreadjsBridgeRegistry {
  register(entry: SpreadjsBridgeEntry): () => void
  list(): readonly SpreadjsBridgeEntry[]
  subscribe(listener: () => void): () => void
  selected(): string | undefined
  current(): SpreadjsBridgeEntry | undefined
  select(id: string | undefined): void
}
```

Registration rejects duplicate ids. Registration and subscription return idempotent disposers; selection changes notify subscribers. `selected()` preserves the user's saved id even before its entry registers; `current()` returns that entry only when registered. An empty selection hands out no Workbook. Drivers must drop references when detached, stop advertising them, and revalidate before using them.

The editor persists its selected driver id in its DSH settings document's `bridge` field; `''` or an absent value means no driver. Browser registry selection mirrors that document. The bundled Driver's host reads only the explicitly configured `editorSettingsNamespace`, default `spreadjs-editor`, to register its tools and skill. A third-party editor uses its own namespace, declares a writable/volatile `bridge` field, and emits the normal DSH `settings/document-updated` event when changed. Set the Driver config to that namespace and restart DSH; do not impersonate another editor's settings document.

```yaml
# Driver Loader entry: the editor owns the acme-sheet-editor settings document.
id: spreadjs
name: '@grapecity-software/dsh-spreadjs-driver'
config:
  editorSettingsNamespace: acme-sheet-editor
```

## Workbook provider

The following is the complete interface. Optional methods preserve support for other drivers with smaller needs. The bundled Driver requires the capabilities in the table below; optional in TypeScript does not mean sufficient for every operation.

```ts
interface SpreadjsWorkbookProvider {
  readonly id: string
  getWorkbook(): unknown | undefined
  getNamespace?(): unknown
  getActivePath?(): string | undefined
  getWorkbookIdentity?(): {
    sessionId: string
    file: string
    instanceId: string
  } | undefined
  getSessionId?(): string | undefined
  openWorkbook?(address: string, timeoutMs: number): Promise<void>
  acquireDriverLease?(): string
  releaseDriverLease?(lease: string): void
  isDriverBusy?(): boolean
  getDriverLeaseSignal?(lease: string): AbortSignal | undefined
  save?(lease?: string, options?: {
    signal?: AbortSignal
    beforeWrite?: () => Promise<void>
  }): Promise<void>
}
```

| Capability | Owner's responsibility | Bundled Driver usage |
| --- | --- | --- |
| Ready Workbook | Return the actual live SpreadJS Workbook only when ready; return undefined during load/save, failure and teardown. | Required for status/execution. |
| Provider identity | `id` is stable and unique among providers in the page. It is not required to be `spreadjs-designer`. | Routes within the page; public targets also include browser/load identity. |
| Document identity | Return the calling chat id, full file resource address, and an instance id renewed after every successful load, including `fromJSON` on the same object. | Required for scoped execution; absent identity is not advertised as executable. |
| File address | `getActivePath()` and identity.file use the same full `dsh-resource://file/session/<id>/<encoded-path>` address. | Validates the document and reports results. |
| Namespace | Return the owner's actual `GC` namespace and loaded modules. | Required for scripts using `GC`; no separate engine/version is bundled by the driver. |
| Exclusive lease | Refuse acquisition while loading/saving/busy; finish pending cell input. Block concurrent user edits and conflicting owner operations until release. | Required for execution, including reads. Lease release must be idempotent and bound to its original owner. |
| Owner teardown signal | Provide a lease AbortSignal; preserve any recoverable partial state, then abort it before destroying the instance. | Required for prompt interruption when the owner closes during an awaiting script. |
| Save | Validate lease ownership; export, await `beforeWrite`, check `signal` before write-back and pass it to cancellable I/O. Reject failures and downloads that did not write the original file. | Required only for `save:true`; omitting it must not report a successful write. |
| Navigation | Advertise the visible chat via `getSessionId()` even without a Workbook. `openWorkbook` opens through the owner's navigation and resolves only when the requested resource is ready; reject session changes, timeout and load failure. | Required only for `sjs_live_open`; no browser-side Workbook creation by the driver. |

Navigation must not destroy a leased instance without preserving partial state and aborting its owner signal. Recovery data belongs to the editor and is keyed by the full chat resource address; a snapshot is not a resumable JavaScript execution. The bundled Editor retains snapshots only for the current page lifetime. Other editors may provide durable recovery, but drivers must not assume it.

## Execution and cancellation

The bundled Driver confines status and execution to the calling chat. Status targets are opaque and expire on reload/reopen. Several available instances require an explicit target, even for the same file in two browser tabs. A queued job captures browser, provider, chat, file and load identity; both dispatch and browser execution revalidate it. Only its claiming browser may settle it.

Execution acquires a lease, captures the original Workbook/file/signal, checks job permission, runs code, revalidates identity and permission, optionally calls the owner's save with the lease and permission options, then releases in finally. Do not reopen a successfully edited file merely to steal focus from the user's current tab.

Caller cancellation or timeout revokes permission to perform a later automatic save and aborts the script's injected `signal`. A script that ignores cancellation retains the lease until it settles or owner teardown interrupts it. Already applied edits are not rolled back, arbitrary page JavaScript cannot be forcibly terminated, and a write already sent to the server may complete. Code shares the owner page's globals; this bridge is not a JavaScript security sandbox.

## Dependencies and compatibility checks

Neither plugin should declare the other as a dependency or peer dependency. The editor bundles its browser SpreadJS/Designer runtime and owns its licenses. The driver declares only the DSH peers it uses; it has no SpreadJS, Designer, browser engine or editor-package dependency. DSH supplies host services and the authenticated connection. The bridge is currently documented as structural interfaces rather than a separately published protocol package; copy the interfaces or implement an adapter without loading another editor runtime.

A third-party adapter should verify: registration/selection/detachment; execution against its own provider id; missing/busy instances; chat/file/reload isolation; lease release after script/save failure; cancellation during asynchronous work/export; snapshot and interruption on close; and readiness/failure of navigation if provided. SpreadJS version and optional module support must be checked separately. GcExcel uses a different engine and is outside this Workbook-reference contract.
