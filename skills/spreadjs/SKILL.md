---
name: spreadjs
description: Create, inspect, edit, import, export, and screenshot .ssjson SpreadJS workbooks through the sjs_* DSH tools. Use proactively for any spreadsheet task — building or editing tables, cells, formulas, sheets, formatting; reading or writing .xlsx / .csv files; producing a .pdf or .png visual snapshot; or running SpreadJS JavaScript through sjs_execute for anything the narrow tools cannot express.
---

# SpreadJS workbooks (.ssjson)

Do spreadsheet work with the bundled `sjs_*` tools — never hand-edit a binary
.xlsx, and never substitute openpyxl / python-pptx / pandas / JS zip writers for
SpreadJS. Complex or one-off operations go through `sjs_execute`, which runs
real SpreadJS code in the headless engine. New or existing workbooks live as
`.ssjson` files (canonical, JSON, human-inspectable) inside the session
workspace.

## Mental model

- **The .ssjson file is the source of truth.** Every tool call spawns a fresh,
  one-shot SpreadJS engine that loads the file, does the work, and saves it
  back. There is no live workbook handle that persists between calls — state
  lives only on disk, so re-read with `sjs_status` after writing.
- Rows and columns are **zero-based** in code (`setValue(0, 0)` is cell A1).
  A used-range `row`/`col` is also zero-based; `rowCount`/`colCount` are counts.
- The sheet-name dictionary is not registered by headless `fromJSON()`, so
  `spread.getSheetByName("…")` may return undefined even for sheets that exist.
  Use the injected `sheet('name')` helper (it scans by index) instead.
- `sjs_screenshot` png renders carry the SpreadJS **"Evaluation Version"
  watermark** — the unlicensed engine stamps the on-screen canvas it draws. PDF
  exports and the exported `.xlsx` / `.csv` / `.ssjson` files are **clean** (no
  watermark). That is expected behaviour of the embedded engine, not an error —
  the asymmetry between the png and the file formats is by design, so never spend
  tool calls verifying it.
- This phase has **no merge/discard approval**: `sjs_worktree` only creates and
  lists drafts. Draft edits never modify the committed base file.

## Tool map

| Stage | Tool | Use |
| --- | --- | --- |
| Start | `sjs_new` | Create an empty `.ssjson` workbook (never overwrites an existing file). |
| Start | `sjs_import` | Import Excel `.xlsx`, `.csv` or `.ssjson` into a `.ssjson` workbook (target never overwrites). |
| Start | `sjs_worktree` | `create` an isolated draft snapshot of a committed workbook; `list` open drafts. |
| Inspect | `sjs_status` | List sheets, dimensions and used ranges of a workbook (metadata, not cell values). |
| Write | `sjs_execute` | Run SpreadJS JavaScript against one workbook; the file is saved afterwards. |
| Verify | `sjs_execute` | Return the cells you need, or call `snapshot()` for the sheet summary. |
| Verify | `sjs_screenshot` | Render a visual snapshot: `png` (pixel render of the active sheet) or `pdf`. |
| Deliver | `sjs_export` | Export a workbook to `.xlsx`, `.csv`, `.ssjson` (canonical copy) or `.pdf`; output never overwrites. |

## Recommended flow

1. **Locate or create the workbook.** Existing file → `sjs_status` on it to see
   sheets and used ranges. Fresh table → `sjs_new`. Real `.xlsx`/`.csv` source →
   `sjs_import` it into `.ssjson` first.
2. **For anything but a one-line change, branch a draft first:** `sjs_worktree`
   with `action: "create"` and the base workbook. It returns a workspace-relative
   draft path (a snapshot under `.spreadjs/drafts/`). Run subsequent edits and
   exports against the *draft* so the committed base stays pristine. Reuse an
   existing draft from `sjs_status`/`sjs_worktree list` only after confirming
   its state.
3. **Build or edit with `sjs_execute`** in small verified steps: write a region,
   then return a few values to confirm. Prefer a short `code` for one-off logic;
   for multi-line logic write a workspace `.mjs`/`.js` body file and pass
   `codeFile` (exactly one of `code` / `codeFile`).
4. **Verify before moving on.** Re-run `sjs_status` to confirm the used range
   grew as intended, and read back specific values with `sjs_execute`. Where the
   result must be *seen*, call `sjs_screenshot` with `format: "png"` on the file
   and inspect the image (layout, colors, borders, CJK text). If you cannot see
   images, verify **layout numerically** instead — return a few column widths /
   row heights and confirm nothing is left so narrow that values would clip
   (see "Build tables that read well" below). Treat the png as a flattened,
   watermarked spot-check, not a pixel-accurate preview.
5. **Export only when asked.** `sjs_export` from the verified file/draft to the
   requested `.xlsx` / `.csv` / `.ssjson` / `.pdf`, then confirm the file exists. Tool
   success is not correctness evidence — verify task-specific assertions.

`format: "png"` text is re-rendered in one readable CJK-capable font, so
per-cell font/weight variety is flattened in the image only; the png also shows
the engine's *Evaluation Version* watermark (see above); the workbook file is
never modified by a screenshot. A png snapshot attaches to the tool result as
an image you can see **only when the current model accepts image input**;
otherwise the tool returns the file path and the png is still written to the
workspace but you cannot see it: on a text-only route `read_image` refuses for
the same reason, so do not spend a call on it — verify the layout numerically
(the widths/values you read back) or export a `.pdf` snapshot instead.

## Build tables that read well (layout & style)

Correct formulas are not enough: a sheet whose columns are too narrow, or whose
numbers sit as left-aligned text, reads as broken in Excel/WPS. Make the file
presentable **by construction** — do not rely on a screenshot, because a
text-only model cannot see it and the png is a flattened, watermarked
approximation.

- **Widths and heights are pixels.** `setColumnWidth(c, w)` and
  `setRowHeight(r, h)` take **pixels**. Excel's "column width 8.5" is a
  *character* count — never feed those numbers straight in (width `8` means
  8px, too thin for any glyph). At 11pt, budget roughly **8px per ASCII
  character/digit** and **15px per CJK character**, plus a little padding for
  the cell's widest value; numeric columns are happy around 80–100px.
- **Or auto-fit what you filled.** `sheet.autoFitColumn(c)` /
  `sheet.autoFitRow(r)` size a row/column to its content; set
  `spread.options.autoFitType = GC.Spread.Sheets.AutoFitType.cellWithHeader`
  first to include header text. In this headless engine text measurement can
  come out *narrower* than a real CJK font, so after auto-fitting CJK-heavy
  columns, widen them by a few px or return the resulting widths and confirm
  nothing clips.
- **Format and align numbers; never leave them as raw left-aligned text.** Use
  one `Style` per distinct look — header / data / total — and reuse it. Set the
  numeric formatter (`#,##0`, `0.00`, `0%`, a date format) and `hAlign` right on
  amounts, center on headers. Thin borders around the used region make it read
  as a grid; a distinct backColor on the header row and on a total row reads
  instantly. Wrap a merged span only where a label truly spans cells.
- **Long tables: freeze the header** (`s.frozenRowCount(1)`) and put the
  `合计`/total in its own styled row, not inside the data.

```js
// fit each column to its widest value, CJK-aware (≈15px CJK / 8px ASCII + pad)
const cellPx = (t) => [...String(t ?? '')].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e7f ? 15 : 8), 0) + 12
headers.forEach((h, c) =>
  s.setColumnWidth(c, Math.max(40, ...[h, ...rows.map((r) => r[c])].map(cellPx))))
```

Confirm the result numerically: return a couple of `getColumnWidth(c)` values
alongside the used range, and treat a screenshot as a second opinion only.

## sjs_execute environment

Code runs as the body of an `async` function in an isolated `vm` context with in
scope:

- `spread` and `workbook` — the active `Spread.Sheets.Workbook`.
- `GC` — the `GC.Spread` namespace (enums, `GC.Spread.Sheets.UsedRangeType`, …).
- `sheet(name?)` — returns the active sheet when called with no argument, else
  finds the sheet by name. Throws `SJS_SHEET_NOT_FOUND` when absent.
- `io.readText(path)` / `io.writeText(path, text)` / `io.readBytes(path)` —
  workspace-only file access. Paths are resolved against the session workspace;
  an escape throws `SJS_FILE_PERMISSION_DENIED`.
- `console`, and `snapshot()` — returns the sheet summary (`sheets` with
  `name`, `rowCount`, `columnCount`, `usedRange`, plus `activeSheet`).

There is **no `require`, no `process`, no `fs`, no DOM**. Common calls:
`sheet().setValue(r, c, v)`, `.getValue(r, c)`, `.setFormula(r, c, '=SUM(…)')`,
`.setColumnWidth(c, w)` and `.setRowHeight(r, h)` (both in **pixels** — see the
layout section below), `.name('…')` (both getter and setter),
`.getUsedRange(GC.Spread.Sheets.UsedRangeType.data | …formula)`. A bare
`getUsedRange()` with no argument can return `null` here — pass the enum
explicitly.

The `return` value must be JSON-serializable and becomes the tool result; return
`undefined` to get the workbook summary. Returning more than ~200k characters of
JSON throws `SJS_RESULT_TOO_LARGE` — return a compact summary or call
`snapshot()` instead.

```js
const s = sheet()                       // active sheet
s.setValue(0, 0, '产品'); s.setValue(0, 1, '数量')
for (let r = 1; r <= 4; r++) {
  s.setValue(r, 0, 'SKU-' + r)
  s.setValue(r, 1, r * 10)
}
s.setFormula(5, 1, '=SUM(B2:B5)')
return { total: s.getValue(5, 1), lastRow: s.getRowCount(), sheet: s.name() }
```

## Unknown SpreadJS API: verify before writing code

The MCP/docs knowledge base for SpreadJS is the authoritative reference; your
training memory of its API is not reliable. When `sjs_execute` needs a SpreadJS
symbol, signature, enum, or return shape you have not confirmed, look it up in
the official SpreadJS documentation (SpreadJS MCP when available) **before**
writing the code — guessing produces `SJS_SCRIPT_ERROR`. After any formula or
cross-sheet change, read the affected cells back rather than trusting the write.

## Failure recovery

Tool failures surface as `Error [CODE]: message`. Route recovery by the code,
not free text.

| Code | Meaning | Remedy |
| --- | --- | --- |
| `INVALID_FILE_PATH` | Source missing / unsupported extension / output extension mismatched (e.g. `.png` with `format: "pdf"`) | Fix or choose a supported path/extension, then retry. |
| `INVALID_EXECUTION_SOURCE` | Both or neither of `code` / `codeFile` supplied | Provide exactly one. |
| `SESSION_SCOPE_DENIED`, `FILE_PERMISSION_DENIED` | Path outside the session workspace / not readable | Use an in-workspace path or ask the user to grant access; do not retry the same path. |
| `CODE_FILE_READ_FAILED` | `codeFile` unreadable | Fix the file path. |
| `SJS_SCRIPT_ERROR` | `sjs_execute` threw or had a syntax error | Read the message, fix the code, re-run. Often an API you guessed — verify it first. |
| `SJS_SHEET_NOT_FOUND` | Named sheet absent (also raised by `sheet(name)` with no match) | Confirm the real sheet name via `sjs_status`. |
| `SJS_RESULT_TOO_LARGE`, `SJS_NON_SERIALIZABLE_RESULT` | Return value too big or not JSON | Return a compact summary or call `snapshot()`. |
| `SJS_UNSUPPORTED_IMPORT_FORMAT` | The engine cannot convert this source extension (Excel family variants beyond `.xlsx` reach the worker without a converter) | Convert the source to `.xlsx`/`.csv` first, then import. |
| `SJS_FILE_READ_FAILED`, `SJS_INVALID_SSJSON`, `SJS_FILE_WRITE_FAILED` | File-level IO / not a valid workbook | Correct the path/input; regenerate the `.ssjson` if corrupt. |
| `SJS_PDF_UNAVAILABLE`, `SJS_PDF_FONT_UNAVAILABLE`, `SJS_PNG_FONT_UNAVAILABLE`, `SJS_PNG_RENDER_FAILED` | PDF/PNG backend missing a font or failing to render | Headless rendering needs at least one CJK-capable `.ttf`/`.otf` registered on the host (`.ttc` unsupported). If PDF is unusable, fall back to `sjs_screenshot` `format: "png"`. |
| `SJS_WORKER_TIMEOUT`, `SJS_WORKER_INVALID_RESPONSE`, `SJS_WORKER_FAILED`, `SJS_BAD_REQUEST` | Worker/transport failure | Retry once with simpler work; report if persistent. |

## Gaps this phase does not cover

There is no client/UI to open a workbook live in-session — `sjs_screenshot` is
the visual surface. Worktrees have no `ready`/`merge`/`discard` yet. If the task
needs one of these, say so explicitly instead of inventing a substitute.
