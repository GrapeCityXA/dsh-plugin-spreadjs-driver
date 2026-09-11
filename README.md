# dsh-spreadjs-excel

> SpreadJS spreadsheets for DeepSeek Harness (DSH): create, inspect, edit, import, export and screenshot `.xlsx`/`.ssjson` workbooks through the bundled `sjs_*` tools.

English · [简体中文](README.zh-CN.md)

`dsh-spreadjs-excel` is the [SpreadJS](https://www.grapecity.com/spreadjs) plugin for DeepSeek Harness. It embeds a headless SpreadJS engine in the agent runtime, so the agent can build tables, write values and formulas, restructure sheets, and verify the result visually — then hand back a standard `.xlsx` (or `.csv` / `.pdf`) you can open in Excel, WPS Office, and other compatible applications.

## Requirements

- **Node.js ≥ 22.19** and a **DeepSeek Harness** runtime (`@deepseek-ai/dsh` `0.1.1-rc.2` or `0.1.2-rc.1`).
- For `.pdf` export and `png` screenshots that contain CJK text, at least one CJK-capable `.ttf`/`.otf` font must be discoverable on the host (system font directories are scanned automatically; add others via the `GC_SJS_PDF_FONT_DIRS` environment variable — `.ttc` files are not supported).

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
| `sjs_new` | Create an empty `.ssjson` workbook. |
| `sjs_import` | Import Excel `.xlsx`, `.csv` or `.ssjson` into a canonical `.ssjson`. |
| `sjs_status` | Inspect sheets, dimensions and used ranges. |
| `sjs_execute` | Run SpreadJS JavaScript against a workbook (complex edits the narrow tools cannot express); the file is saved afterwards. |
| `sjs_screenshot` | Visual snapshot: `png` pixel render of the active sheet, or a `pdf` print-layout snapshot. |
| `sjs_export` | Export to `.xlsx`, `.csv`, `.ssjson` or `.pdf`. |
| `sjs_worktree` | Branch an isolated draft snapshot of a committed workbook (`create`), or list open drafts. |

`.ssjson` is the plugin's canonical workspace format: lossless, JSON, and the only format the tools edit directly. Real files enter through `sjs_import` and leave through `sjs_export`.

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

See `skills/spreadjs/SKILL.md` for the full tool map, the environment contract, and the error-code recovery table, and `docs/architecture.md` for how the headless engine is embedded.

## Notes

- `sjs_screenshot` png renders carry the **"Evaluation Version" watermark** (the unlicensed engine stamps the canvas it draws). PDF exports and the exported `.xlsx` / `.csv` / `.ssjson` files are clean. That is expected behaviour of the engine and does not affect functionality.
- Screenshot `png` text is re-rendered in one readable CJK-capable font, so per-cell font/weight variety is flattened **in the image only**; the workbook file is never modified by a screenshot.
- Worktrees support `create`/`list` in this release; approval (`merge`/`discard`) is a later phase.
- `sjs_execute` can drive charts and shapes (the `shapes` + `charts` packs ship with the plugin); a `png` snapshot covers floating objects even when they sit outside the used cell range.

## Development

```
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # esbuild → lib/index.js + artifacts/sjs-worker.mjs
pnpm test:all          # typecheck + build + worker-smoke + tool-smoke
npm pack               # → dsh-spreadjs-excel-<version>.tgz
```

Install the tarball into a scratch profile and drive the tools from a real session to smoke-test end to end.

## License

MIT — see `LICENSE`. The bundled `@grapecity-software/*` SpreadJS packages are a separate product under their own licence terms; this plugin only wires them into DSH.
