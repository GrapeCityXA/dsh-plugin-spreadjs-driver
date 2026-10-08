# @grapecity-software/dsh-spreadjs-driver

> SpreadJS spreadsheets for DeepSeek Harness (DSH): create, inspect, edit, import, export and screenshot `.xlsx`/`.ssjson` workbooks through the bundled `sjs_*` tools.

English · [简体中文](README.zh-CN.md)

`@grapecity-software/dsh-spreadjs-driver` is the [SpreadJS](https://www.grapecity.com/spreadjs) plugin for DeepSeek Harness. It embeds the SpreadJS engine in the agent runtime, so the agent can build tables, write values and formulas, restructure sheets, and verify the result visually — then hand back a standard `.xlsx` (or `.csv` / `.pdf`) you can open in Excel, WPS Office, and other compatible applications. The engine runs in a hidden system browser the plugin keeps warm: it starts on your first spreadsheet operation, gives each operation a fresh page, and lives as long as the DSH process. Nobody sees it.

## Requirements

- **Node.js ≥ 22.19** and a **DeepSeek Harness** runtime (`@deepseek-ai/dsh` `0.1.7-alpha.1` or later).
- **Google Chrome or Microsoft Edge installed.** The engine runs in a real browser process (no browser binary ships with the plugin, and no browser UI is ever shown). Chrome is preferred when both exist — Edge publishes its tabs into Windows shell surfaces, which litters Alt+Tab; set the `browserPath` plugin option to point at a specific executable either way. Nothing found → `SJS_BROWSER_UNAVAILABLE`, naming the paths that were probed.
- A writable temp directory for the browser's throwaway profile.
- **For `.pdf` export containing CJK text, the host must supply a CJK-capable font.** The plugin ships no fonts: it looks for `.ttf` / `.otf` files in the operating system's font directories (plus anything listed in `GC_SJS_PDF_FONT_DIRS`) and needs one. Windows and macOS always have one. **A default Linux install usually does not** — its CJK fonts are typically `.ttc`, which SpreadJS cannot embed — so plan on installing a `.ttf` or pointing `GC_SJS_PDF_FONT_DIRS` at one. With no usable font, `.pdf` export fails with `SJS_PDF_FONT_UNAVAILABLE` rather than handing back a PDF whose text is missing. PNG screenshots need none of this: the browser has real fonts and falls back per glyph.

**On the DSH version range.** `dsh.engines.dsh` and the `@deepseek-ai/*` peer
ranges name `>=0.1.7-alpha.1`: this plugin uses settings APIs that only exist
from 0.1.7 (see *Being driven by a designer*), so an older host cannot run it.

Two things about that form are worth stating plainly, because the obvious reading
of a peer range is wrong here. DSH does **not** enforce one: `peerDependencies`
is read in exactly two places and both take only the *names*, and
`dsh-package-manifest` says outright that `engines.dsh` is "declarative until a
reader enforces it". So this range is documentation, not a gate — installing on
0.1.6 succeeds and the plugin then misbehaves quietly, which is why the floor is
written down rather than relied on. And the peers name only what the plugin
actually resolves at run time (`schemastery`, plus `react` in the browser half);
the `@deepseek-ai/dsh-*` packages are listed because the host composition must
supply them, not because the bundle imports them.

## Install

Requires DSH `0.1.7-alpha.1` or later, and Google Chrome or Microsoft Edge (the engine runs in the system browser; no browser binary ships with the plugin).

There is no build step. With the DSH CLI installed:

```sh
dsh plugin --profile web add @grapecity-software/dsh-spreadjs-driver
dsh --profile web
```

Then just ask the agent for a spreadsheet — "import `data/q2.xlsx`, add a totals column and export it", say.

The headless profile works too (this plugin only adds tools and does not need the Web UI):

```sh
dsh plugin --profile sjs add @grapecity-software/dsh-spreadjs-driver
dsh --profile sjs "create a new workbook in the working directory and export it as xlsx"
```

Alternatively, install and start through npx:

```sh
npx --yes @deepseek-ai/dsh@latest plugin --profile web add @grapecity-software/dsh-spreadjs-driver
npx --yes @deepseek-ai/dsh@latest --profile web
```

From a local tarball (development):

```sh
dsh plugin --profile web add ./grapecity-software-dsh-spreadjs-driver-<version>.tgz
```

## What you get

The plugin ships one orchestration skill (`spreadjs`) and these tools:

| Tool | Purpose |
| --- | --- |
| `sjs_new` | Create a workbook for a new sheet. |
| `sjs_import` | Bring an existing `.xlsx` / `.csv` / `.ssjson` in as a working workbook. |
| `sjs_status` | Inspect sheets, dimensions and used ranges. |
| `sjs_execute` | Run SpreadJS JavaScript against a workbook (complex edits the narrow tools cannot express); the file is saved afterwards. |
| `sjs_live_execute` | Run SpreadJS JavaScript against the workbook **open in the user's designer**, in their browser — the change is on screen at once, and the file is left alone unless `save: true` is passed. Web profile only, and only while a designer has a file actually open. |
| `sjs_screenshot` | Visual snapshot: `png` pixel render of the active sheet, or a `pdf` print-layout snapshot. |
| `sjs_export` | Produce the file you open: `.xlsx`, `.csv`, `.pdf` — or a `.ssjson` copy. |
| `sjs_worktree` | Branch an isolated draft snapshot of a committed workbook (`create`), or list open drafts. |

### About the two files

You work with **`.xlsx`**. Beside it the plugin keeps a **`.ssjson`** companion —
SpreadJS's own lossless format, which is what the engine actually reads and
writes on every call. It is a program-facing file; you never need to open it, and
the agent is told not to make it part of the conversation.

The flow is deliberately **one-way**:

```
your .xlsx  ──sjs_import──▶  .ssjson (working file)  ──sjs_export──▶  .xlsx you open
```

An exported `.xlsx` is always derived from the working file, never re-imported
from a previous `.xlsx`. Round-tripping through Excel on every edit would let the
small losses inherent in any `.xlsx` conversion accumulate; this way they stay
bounded to the one import and the one export.

Exporting is also what refreshes a `.xlsx` you already had: a file left over from
an earlier export goes stale after further edits, so ask for a fresh export rather
than assuming it is current.

## Typical flow

Describe what you want in natural language — the agent follows the skill's recommended flow: locate or create the workbook, branch a draft for anything non-trivial, edit with `sjs_execute` in small verified steps, read the result back, and `sjs_screenshot`/`sjs_export` the finished table.

For example, ask: *"Make a monthly sales sheet with a header row, four product rows, and a SUM column, then export it as Excel."*

To edit by hand, `sjs_execute` runs an async function body with `spread`/`workbook`, `GC`, `sheet(name?)`, workspace-only `io`, `console` and `snapshot()` in scope (no `require`, no `process`, no `fs`):

```js
const s = sheet()
s.setValue(0, 0, '产品'); s.setValue(0, 1, '数量')
for (let r = 1; r <= 4; r++) { s.setValue(r, 0, 'SKU-' + r); s.setValue(r, 1, r * 10) }
s.setFormula(5, 1, '=SUM(B2:B5)')
return { total: s.getValue(5, 1) }
```

See `skills/spreadjs/SKILL.md` for the full tool map, the environment contract, and the error-code recovery table, and `docs/architecture.md` for how the engine runtime is embedded.

## Being driven by a designer: the `spreadjsBridgeRegistry`

The `sjs_*` tools are only half of what this plugin is. The other half is what makes
it a *bridge*: the editor plugin publishes a roster of bridges, a plugin that can
drive a live workbook registers into it, and **the user picks which one to use in
Settings → Spreadsheet Editor**. This plugin is one entry on that roster.

What makes the arrangement work is that a DSH client plugin's browser half is not a
sandbox. Every plugin's client half is loaded into the same page, the same JS realm,
the same heap, so a workbook crosses as a **reference, not a copy**. Nothing is
serialized, nothing goes over HTTP, no file is involved. The owner keeps rendering the
very object the agent wrote to, so the change is on screen the moment it lands — and
because it lands on the live document, it does not clobber edits the user has not
saved, which a file-based route cannot promise.

### Why a registry, and not a service name

This was `spreadjsHostBridge`: a service this plugin published and the editor injected
by name. That works for exactly one bridge, structurally — a second `provide` of a
live service name **throws**, and because the throw lands inside the second plugin's
`apply`, that plugin never activates at all. There is no chain, no last-wins, no
fan-out: `get`/`inject` see one value. (Empirically: none of the 239 packages in a
shipped DSH tree shares a service name with another.) So "let the user choose" could
not be built that way.

It is built the way DSH builds every other many-contributors feature — `ctx.tools`,
`ctx.llm.registerAdapter`, `ctx.slots` — as one service that many plugins register
*into*. A registry has to be published by somebody, and the **editor** is the party
that owns the workbook, so it owns the list of who may be handed that workbook. The
dependency therefore runs provider → editor. That is the honest description of the
relationship: a bridge is a consumer of the editor's workbooks. It stays optional — a
profile without the editor simply never fires the injection.

### The contract

```ts
// your-plugin/src/client/index.ts
const REGISTRY = 'spreadjsBridgeRegistry'

interface SpreadjsBridgeEntry {
  readonly id: string                   // unique in the registry; shown as the entry key
  readonly title: () => string          // the name the Settings page lists
  attach(provider: SpreadjsWorkbookProvider): () => void
}

interface SpreadjsWorkbookProvider {
  readonly id: string                   // how the agent addresses it
  getWorkbook(): unknown | undefined    // your live Workbook, or undefined when nothing is open
  getNamespace?(): unknown              // the SpreadJS namespace, injected into agent code as `GC`
  getActivePath?(): string | undefined  // reported back with each edit
  save?(): Promise<void>                // called ONLY when the agent asks for a save
}

export function apply(ctx: ClientContext): void {
  ctx.inject([REGISTRY], (child) => {
    child.effect(() => {
      const registry = child.get(REGISTRY) as SpreadjsBridgeRegistry | undefined
      if (registry === undefined) return
      return registry.register({
        id: '@acme/dsh-spreadjs-bridge',
        title: () => 'Acme Bridge',
        attach(provider) {
          // the editor hands you a live workbook; keep the reference, and release
          // it when the function you return is called
          held = provider
          return () => { held = undefined }
        },
      })
    }, 'my-plugin: spreadjs bridge')
  })
}
```

`getNamespace` is not decoration. Agent code is injected with `GC`, and a script that
needs an enum — `GC.Spread.Sheets.UsedRangeType`, a chart type, an alignment constant —
cannot run without it. `save` is likewise optional and is reached only by an explicit
`save: true`, never as a side effect of an edit.

### What the agent gains

`sjs_live_execute`, addressed to your `id` through its `target` parameter. It offers
the same scope as `sjs_execute` — `spread`, `workbook`, `GC`, `sheet()`, `snapshot()`,
`console` — except `io`, which is served by the engine's own loopback server and so
does not exist in the user's browser.

**The file on disk is not touched.** An edit lives in the live workbook until the agent
explicitly asks for a save, which is the only thing that calls your `save()`. That
default is deliberate: the agent should be able to propose a change the user can see
and undo before anything is written.

**These tools are conditional.** Every tool this plugin registers — the seven file tools,
the two live ones, and its bundled skill — exists only while this plugin is the chosen
bridge. Choose someone else in Settings → Spreadsheet Editor and they all step aside, because the
setting names the plugin that *owns spreadsheets* here, not merely the one holding the
live document. The bridge layer is a hard constraint the editor enforces; the tool layer
is an agreement each driver keeps on its own — see *Writing your own driver* below.

### What this deliberately does not do

- **The roster is candidates, not a broadcast.** Exactly one entry is handed the live
  document — the one the user selected — and the editor remains the gatekeeper. There
  is no way for a plugin to *reach* a workbook it was not handed.
- **The registry exists only in the browser.** There is deliberately no host-side
  equivalent, so a Node-side plugin cannot borrow the SpreadJS engine to run it on the
  server.
- **Nothing is required of you.** `ctx.inject` does not fire when the editor is absent,
  so your plugin behaves exactly as before without it — and the disposer `register`
  returns releases the entry on unload, so a destroyed document is never kept alive.

`@grapecity-software/dsh-spreadjs-editor` **0.1.5 or later** is the reference consumer:
its `src/client/bridge-registry.ts` is this contract in full, and
`docs/design-live-designer-bridge.md` records why the dependency runs this way round.
The version floor matters — an earlier editor predates the roster and would leave the
integration silently absent rather than erroring, so `sjs_live_execute` would simply
never find a designer.

Both plugins also need **DSH 0.1.7-alpha.1 or later**, and that floor is a real one
rather than a formality: the chosen bridge is stored as a field in the editor's own
settings namespace, and 0.1.7 is where namespaces stopped being something a plugin
registers by name and became something derived from its Loader entry. On 0.1.5 the
editor's settings page never appeared and this plugin's read of the choice failed
closed-to-open — see the note on `readChosenBridge` in `src/host/activation.ts`.

> `subscribe` is declared on the provider interface but is not consulted by the bridge
> yet; implementing it currently has no effect.

## Writing your own driver

Registering a bridge entry buys you the workbook. It does not buy you the model's
attention — the tool catalog is a separate layer that nothing arbitrates. Two drivers
installed at once means two overlapping tool sets in front of the model with nothing
saying which one goes with the choice on screen. Closing that gap takes two things
from you.

### 1. Provide your own tools

`ctx.tools.register()` is per-plugin: the names you register are yours, and the catalog
the model sees is the **union** of every installed plugin's. A bridge entry with no
tools behind it hands the model a live workbook it has no way to touch.

| tool | | what it must do |
|---|---|---|
| `sjs_live_execute` | **required** | run agent-authored code against the workbook the editor handed you |
| `sjs_live_status` | strongly recommended | answer "is a designer connected right now" — without it, the model learns this by failing |
| `sjs_new` `sjs_import` `sjs_export` `sjs_status` `sjs_execute` `sjs_screenshot` `sjs_worktree` | only if you ship headless equivalents | operate over workspace files, with no browser involved |
| a `skill` describing those tools | if you ship one | tell the model how to use them — and withdraw it with them (see *Yield* below) |

Two rules about names:

- **Pick a prefix you own.** `ctx.tools.register` throws on a duplicate name, and the
  throw lands inside your `apply` — one collision and your plugin does not activate at
  all. This plugin owns `sjs_`; the fixture in `dsh-plugin-fake-driver` uses `fake_sjs_`
  for exactly this reason.
- **Do not re-register the set above under different names.** Ten tools describing the
  same workbook leave the model choosing between two catalogs, which is the problem the
  yield protocol exists to remove.

### 2. Yield when the user picks someone else

The editor stores the chosen id as a field in its own settings namespace. Read it, and
let it decide whether your tools exist:

```ts
// your-plugin/src/host/presence.ts
const EDITOR_NAMESPACE = 'spreadjs-editor'
const MINE = '@acme/dsh-spreadjs-bridge'

let release: (() => void) | undefined

/** Presence is a pure function of the choice — never a state you enter and must leave. */
function sync(ctx: Context, register: () => () => void): void {
  const chosen = read(ctx)                     // every failure → undefined
  const want = chosen === undefined || chosen === '' || chosen === MINE
  if (want === (release !== undefined)) return // already right; re-registering churns the catalog
  if (want) release = register()
  else { release?.(); release = undefined }
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const onDocument = ctx.on('settings/document-updated', (ns) => { if (ns === EDITOR_NAMESPACE) sync(ctx, register) })
    sync(ctx, register)
    return () => { onDocument(); release?.(); release = undefined }
  }, 'acme-bridge: tool presence follows the chosen bridge')

  // The settings service may come up after you; an entry becoming served emits no event.
  ctx.inject(['settings'], () => sync(ctx, register))
}
```

`src/host/activation.ts` in this repo is the same thing with the reasoning written out,
and `test/activation.mjs` is the behaviour it has to have.

The rules that matter:

- **Read the choice, don't guess it — and know which read works.** The field is
  `bridge`, in the settings namespace the editor's Loader entry id names
  (`spreadjs-editor`). On DSH 0.1.7 the only host-side way to read another entry's value
  is `ctx.settings.describe()`, which returns one descriptor per entry; find the one
  whose `ns` matches and read `value.bridge`. The per-namespace `settings.get(ns)` that
  earlier versions had is gone, and reaching for it fails in the worst possible way here:
  the throw is swallowed by the fail-open rule below, so presence answers "yes" forever
  and the yield protocol goes quiet with nothing in any log. Prefer
  `ctx.get('settings')` over injection so the read stays available from any callback.
- **Derive, never remember.** The tempting shape is "unregister while A is chosen, then
  re-register when A goes away" — which needs something to remember to put you back, and
  whatever remembers can be lost to a reload, a crash, or an unload. Make presence a pure
  function of the current value and re-derive it on every event, and there is no state
  left to desynchronise.
- **Gate every tool you ship, not just the live ones.** The setting names the plugin that
  **owns spreadsheets** in this deployment, not merely the one that receives the live
  document. Keeping file tools in the catalog while the user has chosen someone else puts
  the model back to guessing. This plugin gates all nine of its tools.
- **Gate anything else you put in front of the model.** This plugin also withdraws its
  bundled `spreadjs` skill, and that is not a detail: SKILL.md is the document that
  teaches the model to call `sjs_*` by name, so leaving it registered after the tools are
  gone hands the model a manual for a capability it does not have. A stale skill is worse
  than a redundant tool — it reads as authoritative.
- **Fail open — but do not let that hide a broken read.** No settings service, no
  descriptor for the editor's namespace, a value that is not a string — all of them mean
  *present*. The two failures are not symmetrical: being absent when the user needed you
  costs them their tools, while being present with nothing to do costs one line in a
  catalog. The cost is that a read which is simply *wrong* — a renamed method, a moved
  field — looks exactly like "no choice was made". If you migrate this to a new DSH,
  check the read against a real session rather than trusting that it compiled.
- **Listen to `settings/document-updated`, filtered by namespace.** It fires both when a
  value changes and when one is **cleared** back to its default, which is the case that
  matters here. 0.1.5 also emitted a `settings/updated`; 0.1.7 does not, so a subscription
  to it is a listener that never runs — harmless, but it reads like coverage it is not.
  The `inject(['settings'])` pass closes the remaining window, where the service comes up
  after you and the choice was already made.
- **Leave the roster entry alone.** Yield your *tools*, not your bridge entry. That entry
  is what the user needs on the settings page to switch back, so unregistering it makes
  the choice one-way.
- **Say nothing, and expect nothing back.** You read a fact, you decide, you act on
  yourself. You never need the other driver's name, its existence, or its cooperation.

### What you cannot rely on

**Reciprocity.** The bridge layer is a hard constraint — the editor hands the live
workbook to exactly one entry, and the editor enforces that. The tool layer is an
*agreement*, and nothing enforces it. A driver that ignores the setting keeps its tools
in the catalog, and the symptom is precisely the one this protocol removes: two
overlapping tool sets, and a model picking between them by guesswork. Yielding
unilaterally is still worth doing — it costs you nothing and removes half the problem on
your own — but the user only gets the correct outcome when both drivers do it.

`dsh-plugin-fake-driver` in this workspace exists to make that observable: it is a second
driver that yields like this one, and `build_fake.bat` installs it alongside. Install
both, pick one in Settings → Spreadsheet Editor, and watch which tools are left in the catalog.

## Notes

- The unlicensed engine marks its output, and that is expected: a `png` render carries an **"Evaluation Version"** stamp on the canvas, and an exported `.xlsx` carries an extra worksheet of that name (`.pdf` and `.csv` do not). It is left in place deliberately — the plugin does not strip it, and neither should the agent. It does not affect the data.
- A screenshot `png` is the engine's own rendering in a real browser: fonts, weights and colours are the real ones, and the workbook file is never modified by a screenshot.
- Worktrees support `create`/`list` in this release; approval (`merge`/`discard`) is a later phase.
- `sjs_execute` can drive charts, shapes, slicers and pivot tables (the `shapes` / `charts` / `slicers` / `pivot-addon` / `datacharts-addon` packs ship with the plugin); a `png` snapshot covers floating objects even when they sit outside the used cell range or on a sheet with no used cells (a pivot layout).
- Out-of-range writes grow the sheet instead of being dropped, and operations naming the same workbook run serially, so parallel tool calls cannot lose each other's edits.
- Each `sjs_execute` runs batched — repaint, change events and calculation are all suspended, which measured 3.6× faster on a 20k-row fill with formulas. A script that reads a computed value mid-way must `spread.resumeCalcService()` first; stored and exported values are always fully calculated.
- A `png` result carries `clipped: true` when the sheet is larger than the 2600×2200 raster ceiling; the image is then a crop rather than an error. Those numbers are **CSS pixels**, and the render is at **2×**, so a result reports its size twice: `width`/`height` in CSS pixels (the unit to compare against your own column arithmetic) and `pixels` for the file itself.

## Development

```
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # esbuild → lib/index.js + artifacts/sjs-worker.mjs
pnpm test:all          # typecheck + build + worker-smoke + export-integrity + tool-smoke
npm pack               # → grapecity-software-dsh-spreadjs-driver-<version>.tgz
```

Install the tarball into a scratch profile and drive the tools from a real session to smoke-test end to end.

## License

MIT — see `LICENSE`. The bundled `@grapecity-software/*` SpreadJS packages are a separate product under their own licence terms; this plugin only wires them into DSH.
