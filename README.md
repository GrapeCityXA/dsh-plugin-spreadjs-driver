# @grapecity-software/dsh-spreadjs-driver

> SpreadJS spreadsheets for DeepSeek Harness (DSH): create, inspect, edit, import, export and screenshot `.xlsx`/`.ssjson` workbooks through the bundled `sjs_*` tools.

English · [简体中文](README.zh-CN.md)

`@grapecity-software/dsh-spreadjs-driver` is the [SpreadJS](https://www.grapecity.com/spreadjs) plugin for DeepSeek Harness. It embeds the SpreadJS engine in the agent runtime, so the agent can build tables, write values and formulas, restructure sheets, and verify the result visually — then hand back a standard `.xlsx` (or `.csv` / `.pdf`) you can open in Excel, WPS Office, and other compatible applications. The engine runs in a hidden system browser the plugin keeps warm: it starts on your first spreadsheet operation, gives each operation a fresh page, and lives as long as the DSH process. Nobody sees it.

## Requirements

- **Node.js ≥ 22.19** and a **DeepSeek Harness** runtime (`@deepseek-ai/dsh` `0.1.5-rc.2`).
- **Google Chrome or Microsoft Edge installed.** The engine runs in a real browser process (no browser binary ships with the plugin, and no browser UI is ever shown). Chrome is preferred when both exist — Edge publishes its tabs into Windows shell surfaces, which litters Alt+Tab; set the `browserPath` plugin option to point at a specific executable either way. Nothing found → `SJS_BROWSER_UNAVAILABLE`, naming the paths that were probed.
- A writable temp directory for the browser's throwaway profile.
- **For `.pdf` export containing CJK text, the host must supply a CJK-capable font.** The plugin ships no fonts: it looks for `.ttf` / `.otf` files in the operating system's font directories (plus anything listed in `GC_SJS_PDF_FONT_DIRS`) and needs one. Windows and macOS always have one. **A default Linux install usually does not** — its CJK fonts are typically `.ttc`, which SpreadJS cannot embed — so plan on installing a `.ttf` or pointing `GC_SJS_PDF_FONT_DIRS` at one. With no usable font, `.pdf` export fails with `SJS_PDF_FONT_UNAVAILABLE` rather than handing back a PDF whose text is missing. PNG screenshots need none of this: the browser has real fonts and falls back per glyph.

**On the DSH version range.** `dsh.engines.dsh` and the `@deepseek-ai/*` peer
ranges name `0.1.5-rc.2` exactly — not a caret, and not a widened list. DSH is
pre-1.0 and ships breaking changes between release candidates, so the only
version this plugin can honestly claim is the one its CI actually ran against.
A caret on a prerelease would silently promise compatibility with the next rc;
a `>=` would promise it forever. When a new DSH is released and passes CI here,
this range is raised to name it — deliberately, one version at a time.

## Install

Requires DSH `0.1.5-rc.2` and Google Chrome or Microsoft Edge (the engine runs in the system browser; no browser binary ships with the plugin).

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

## Extending another SpreadJS plugin

The `sjs_*` tools are only half of what this plugin is. The other half is one client
service — `spreadjsHostBridge` — and it exists so that **any DSH plugin already
rendering a SpreadJS workbook can lend that workbook to the agent**, and get
natural-language editing of its own live document without writing any agent code.

What makes it work is that a DSH client plugin's browser half is not a sandbox.
Every plugin's client half is loaded into the same page, the same JS realm, the same
heap, so the workbook crosses as a **reference, not a copy**. Nothing is serialized,
nothing goes over HTTP, no file is involved. The owner keeps rendering the very
object the agent just wrote to, so the change is on screen the moment it lands — and
because it lands on the live document, it does not clobber edits the user has not
saved, which a file-based route cannot promise.

### The contract

```ts
// your-plugin/src/client/index.ts
const BRIDGE_SERVICE = 'spreadjsHostBridge'

interface SpreadjsHostBridge {
  attach(provider: SpreadjsWorkbookProvider): () => void
  list(): readonly string[]
}

interface SpreadjsWorkbookProvider {
  readonly id: string                   // how the agent addresses it
  getWorkbook(): unknown | undefined    // your live Workbook, or undefined when nothing is open
  getNamespace?(): unknown              // the SpreadJS namespace, injected into agent code as `GC`
  getActivePath?(): string | undefined  // reported back with each edit
  save?(): Promise<void>                // called ONLY when the agent asks for a save
}

export function apply(ctx: ClientContext): void {
  ctx.inject([BRIDGE_SERVICE], (child) => {
    child.effect(() => {
      const bridge = child.get(BRIDGE_SERVICE) as SpreadjsHostBridge | undefined
      if (bridge === undefined) return
      const release = bridge.attach({
        id: 'my-designer',
        getWorkbook: () => workbookRef.current,
        getNamespace: () => GC,
        getActivePath: () => pathRef.current,
        save: () => persistToDisk(),
      })
      return () => release()          // MUST run when your panel unmounts
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

### What this deliberately does not do

- **`attach` does not go both ways.** The bridge publishes a way to *offer* a workbook,
  never a way to *reach* one. A third plugin that obtains this service can only offer a
  document it already owns; it cannot see, find or edit yours.
- **The service exists only in the browser.** There is deliberately no host-side
  `spreadjsHostBridge`, so a Node-side plugin cannot borrow this engine to run SpreadJS
  on the server.
- **Nothing is required of you.** `ctx.inject` does not fire when this plugin is absent,
  so your plugin behaves exactly as before without it — and the disposer `attach`
  returns releases the reference on unmount, so a destroyed document is never kept alive.

`@grapecity-software/dsh-spreadjs-editor` **0.1.5 or later** is the reference consumer: its
`src/client/bridge.ts` is this contract in full, and `docs/design-live-designer-bridge.md`
records why the dependency runs this way round. The version floor matters — an earlier
editor predates the bridge and would leave the integration silently absent rather than
erroring, so `sjs_live_execute` would simply never find a designer.

> `subscribe` is declared on the provider interface but is not consulted by the bridge
> yet; implementing it currently has no effect.

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
