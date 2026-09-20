# dsh-spreadjs-excel

> SpreadJS spreadsheets for DeepSeek Harness (DSH): create, inspect, edit, import, export and screenshot `.xlsx`/`.ssjson` workbooks through the bundled `sjs_*` tools.

English · [简体中文](README.zh-CN.md)

`dsh-spreadjs-excel` is the [SpreadJS](https://www.grapecity.com/spreadjs) plugin for DeepSeek Harness. It embeds the SpreadJS engine in the agent runtime, so the agent can build tables, write values and formulas, restructure sheets, and verify the result visually — then hand back a standard `.xlsx` (or `.csv` / `.pdf`) you can open in Excel, WPS Office, and other compatible applications. The engine runs in a hidden system browser that the plugin starts per operation; nobody sees it, and it exits with the operation.

## Requirements

- **Node.js ≥ 22.19** and a **DeepSeek Harness** runtime (`@deepseek-ai/dsh` `0.1.5-rc.2`).
- **Microsoft Edge or Google Chrome installed.** The engine runs in a real browser process (no browser binary ships with the plugin, and no browser UI is ever shown). Edge is preferred when both exist; set the `browserPath` plugin option to point at a specific executable. Nothing found → `SJS_BROWSER_UNAVAILABLE`, naming the paths that were probed.
- A writable temp directory for the browser's throwaway profile.
- For `.pdf` export containing CJK text, at least one CJK-capable `.ttf`/`.otf` font must be discoverable on the host (system font directories are scanned automatically; add others via the `GC_SJS_PDF_FONT_DIRS` environment variable — `.ttc` files are not supported). PNG screenshots need nothing extra: the browser has real fonts.

**On the DSH version range.** `dsh.engines.dsh` and the `@deepseek-ai/*` peer
ranges name `0.1.5-rc.2` exactly — not a caret, and not a widened list. DSH is
pre-1.0 and ships breaking changes between release candidates, so the only
version this plugin can honestly claim is the one its CI actually ran against.
A caret on a prerelease would silently promise compatibility with the next rc;
a `>=` would promise it forever. When a new DSH is released and passes CI here,
this range is raised to name it — deliberately, one version at a time.

## Install

From a tarball or the npm registry into the profile you run DSH under:

```
dsh plugin --profile <your-profile> add ./dsh-spreadjs-excel-<version>.tgz
# once published:
dsh plugin --profile <your-profile> add dsh-spreadjs-excel
```

Confirm the plugin is patched in:

```
dsh --profile <your-profile> --dump-config
```

## What you get

The plugin ships one orchestration skill (`spreadjs`) and these tools:

| Tool | Purpose |
| --- | --- |
| `sjs_new` | Create a workbook for a new sheet. |
| `sjs_import` | Bring an existing `.xlsx` / `.csv` / `.ssjson` in as a working workbook. |
| `sjs_status` | Inspect sheets, dimensions and used ranges. |
| `sjs_execute` | Run SpreadJS JavaScript against a workbook (complex edits the narrow tools cannot express); the file is saved afterwards. |
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

## Notes

- The unlicensed engine marks its output, and that is expected: a `png` render carries an **"Evaluation Version"** stamp on the canvas, and an exported `.xlsx` carries an extra worksheet of that name (`.pdf` and `.csv` do not). It is left in place deliberately — the plugin does not strip it, and neither should the agent. It does not affect the data.
- A screenshot `png` is the engine's own rendering in a real browser: fonts, weights and colours are the real ones, and the workbook file is never modified by a screenshot.
- Worktrees support `create`/`list` in this release; approval (`merge`/`discard`) is a later phase.
- `sjs_execute` can drive charts, shapes, slicers and pivot tables (the `shapes` / `charts` / `slicers` / `pivot-addon` / `datacharts-addon` packs ship with the plugin); a `png` snapshot covers floating objects even when they sit outside the used cell range or on a sheet with no used cells (a pivot layout).
- Out-of-range writes grow the sheet instead of being dropped, and operations naming the same workbook run serially, so parallel tool calls cannot lose each other's edits.
- Each `sjs_execute` runs batched — repaint, change events and calculation are all suspended, which measured 3.6× faster on a 20k-row fill with formulas. A script that reads a computed value mid-way must `spread.resumeCalcService()` first; stored and exported values are always fully calculated.
- A `png` result carries `clipped: true` when the sheet is larger than the 2600×2200 raster ceiling; the image is then a crop rather than an error.

## Development

```
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # esbuild → lib/index.js + artifacts/sjs-worker.mjs
pnpm test:all          # typecheck + build + worker-smoke + export-integrity + tool-smoke
npm pack               # → dsh-spreadjs-excel-<version>.tgz
```

Install the tarball into a scratch profile and drive the tools from a real session to smoke-test end to end.

## License

MIT — see `LICENSE`. The bundled `@grapecity-software/*` SpreadJS packages are a separate product under their own licence terms; this plugin only wires them into DSH.
