---
name: spreadjs
description: Create, inspect, edit, import, export and screenshot real Excel workbooks (.xlsx) through the sjs_* DSH tools, and look up any SpreadJS API in the authoritative reference bundled with this skill. Use proactively for any spreadsheet task — building or editing tables, cells, formulas, sheets, formatting; reading or writing .xlsx / .csv files; producing a .pdf or .png visual snapshot; or running SpreadJS JavaScript through sjs_execute for anything the narrow tools cannot express. Load it also to answer a SpreadJS API question from a reliable source rather than from memory.
---

# Spreadsheets (Excel .xlsx)

Do spreadsheet work with the bundled `sjs_*` tools — never hand-edit a binary
.xlsx, and never substitute openpyxl / python-pptx / pandas / JS zip writers for
SpreadJS. Complex or one-off operations go through `sjs_execute`, which runs
real SpreadJS code in the headless engine.

**The file the user cares about is the `.xlsx`.** Beside it the engine keeps a
`.ssjson` companion: its own lossless working format, meant to be read by the
program, not by people. Keep it out of the conversation — name, describe and
deliver the `.xlsx` (or `.pdf`). If the user asks what the `.ssjson` file is, say
in one line that it is the engine's working copy for the workbook and they can
ignore it; do not explain the format or make it part of the task.

## Mental model

- **Two files, one direction.** The `.ssjson` is the engine's working file and
  its source of truth; the `.xlsx` you hand over is always **exported from it**,
  never re-imported from a previous `.xlsx`. That one-way flow is what keeps the
  Excel file faithful — round-tripping `.xlsx` → engine → `.xlsx` on every edit
  would let small losses accumulate instead of staying bounded.
- **Read workbooks through the tools, not by parsing the file.** The `.ssjson`
  JSON is the engine's internal shape, not an interface: it can change between
  versions, and it does not look the way you would guess. To inspect values, or to
  prove a base file is untouched, go through `sjs_status` / `sjs_execute` (and
  compare file timestamps or hashes) rather than hand-parsing the JSON.
- **An `.xlsx` round trip keeps the workbook's features, but two of them come back
  in a different shape** — check the right place before calling anything lost. An
  image is added via `pictures` and comes back from an imported `.xlsx` as a
  **shape**, so look in *both* `s.pictures.all()` and `s.shapes.all()`. Data
  validation bounds come back as formula **strings** (`"=1"`, not `1`) — the rule
  still holds, the type just changed. Conditional formats, comments, defined names
  (`addCustomName`), merges, borders and number formats survive as they were.
- Every tool call spawns a fresh, one-shot engine that loads the working file,
  does the work, and saves it back. There is no live workbook handle between
  calls — state lives only on disk, so re-read with `sjs_status` after writing.
- Rows and columns are **zero-based** in code (`setValue(0, 0)` is cell A1).
  A used-range `row`/`col` is also zero-based; `rowCount`/`colCount` are counts.
- The sheet-name dictionary is not registered by headless `fromJSON()`, so
  `spread.getSheetByName("…")` may return undefined even for sheets that exist.
  Use the injected `sheet('name')` helper (it scans by index) instead.
- **The unlicensed engine marks its output; that is expected, and you leave it
  alone.** A `png` render carries an "Evaluation Version" stamp on the canvas, and
  an exported `.xlsx` carries an extra worksheet of that name (a `.pdf` and a
  `.csv` do not). Never remove or work around any of it: do not hand-edit the
  `.xlsx` — or any binary container — to drop the sheet, do not spend tool calls
  confirming it exists, and do not treat it as a defect to report. If such a sheet
  appears in `sjs_status` after importing a file that has it, ignore it and work
  on the real sheets.
- This phase has **no merge/discard approval**: `sjs_worktree` only creates and
  lists drafts. Draft edits never modify the committed base file.

## Tool map

| Stage | Tool | Use |
| --- | --- | --- |
| Start | `sjs_new` | Create the engine's working workbook for a new sheet (never overwrites). The user's copy comes later from `sjs_export`. |
| Start | `sjs_import` | Bring an existing `.xlsx` / `.csv` / `.ssjson` into a working workbook (target never overwrites). |
| Start | `sjs_worktree` | `create` an isolated draft snapshot of a committed workbook; `list` open drafts. |
| Inspect | `sjs_status` | List sheets, dimensions and used ranges of a workbook (metadata, not cell values). |
| Write | `sjs_execute` | Run SpreadJS JavaScript against one workbook; the file is saved afterwards. |
| Verify | `sjs_execute` | Return the cells you need, or call `snapshot()` for the sheet summary. |
| Verify | `sjs_screenshot` | Render a visual snapshot: `png` (pixel render of the active sheet) or `pdf`. A `png` result reports `clipped: true` when the sheet exceeded the raster ceiling (2600×2200) and the image is a crop. |
| Deliver | `sjs_export` | Produce the file the user opens: `.xlsx` (Excel), `.csv`, `.pdf`, or a `.ssjson` copy for another tool. Output never overwrites. |

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
5. **Deliver a `.xlsx`.** When the requested work is done — or the user asks to
   see/save the result — `sjs_export` to `.xlsx` (plus `.csv` / `.pdf` if asked)
   and confirm the file exists. Exporting is also what refreshes a `.xlsx` the
   user already had: an export always re-derives it from the working file, so it
   never drifts, but a `.xlsx` left over from an earlier export goes stale after
   further edits — re-export rather than assuming it is current. Tool success is
   not correctness evidence — verify task-specific assertions.

`format: "png"` text is re-rendered in one readable CJK-capable font, so
per-cell font/weight variety is flattened in the image only; the png also shows
the engine's *Evaluation Version* watermark (see above); the workbook file is
never modified by a screenshot. A png snapshot attaches to the tool result as
an image you can see **only when the current model accepts image input**;
otherwise the tool returns the file path and the png is still written to the
workspace but you cannot see it: on a text-only route `read_image` refuses for
the same reason, so do not spend a call on it — verify the layout numerically
(the widths/values you read back) or export a `.pdf` snapshot instead.

## Screenshot geometry (predict the size, do not probe for it)

A `png` snapshot is sized from the model, so its dimensions can be computed
instead of discovered by taking test screenshots:

```
content width  = 40 (row header) + Σ visible column widths
content height = 20 (column header) + Σ visible row heights
canvas         = content + 8px padding
```

- Hidden rows and columns report `getRowHeight` / `getColumnWidth` as **0**, so
  they take no space in the image.
- Floating objects (charts, shapes, slicers, pictures) extend the box to their own
  coordinates when they reach past the cells.
- Floor **282 × 182** — a small or empty sheet is padded up to this, never smaller.
- Ceiling **2582 × 2182** — past it the image is a **crop** and the result carries
  `clipped: true`. Read that flag rather than assuming the picture is complete.
- **A snapshot costs time in proportion to the workbook's data, not the image.**
  It reloads the whole workbook to measure and again to render, so a large sheet
  is slow: roughly 19 s end-to-end at 100k rows, against ~6 s for `sjs_status` on
  the same file — and past ~400k rows it would run into the 60 s operation budget.
  On a big sheet prefer exporting `.xlsx` / `.csv` and reading values back, and
  treat a `clipped: true` snapshot as a thumbnail rather than a way to inspect it.

So a 20-row table with 90px columns renders 282 wide (floored) and
`20 + 20 × 20 + 8 = 428` tall.

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
- **A merge does not empty the cells it covers.** Content written before
  `addSpan` stays in the hidden cells and still counts in the used range — so a
  total row that fills every column and *then* merges its label across `A:C`
  leaves two live cells under the span. Either write only to the value columns
  from the start, or clear the covered cells deliberately (`removeSpan` →
  `clear` → `setFormula(…, null)` → `addSpan`).

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
  an escape throws `SJS_FILE_PERMISSION_DENIED`. **The reads are asynchronous and
  the writes return a promise too — always `await` them**; without it you get a
  `Promise` object and the next line fails with something unrelated (`… is not a
  function`, `Unexpected token`).

  ```js
  const csv = await io.readText('other.csv')   // ← without await this is a Promise
  ```

  That is also how a second file comes into the workbook you are editing: read it,
  parse it, write it in. There is no tool that merges two workbooks, so a
  combine-two-files request is answered by reading one and writing into the other.

  **Move data between workbooks through the engine, not by parsing the other
  file.** Run a script *on the source workbook* that reads its values normally and
  parks them in the workspace (`await io.writeText('rows.json', JSON.stringify(rows))`),
  then run a script *on the target workbook* that reads that JSON back and writes
  it in. Parsing the source's `.ssjson` to get at its cells also "works", but it
  couples you to an internal shape that gets your assumptions wrong (the sheet list
  is a keyed map, not an array) and buys nothing — the engine reads the same values
  correctly and the JSON file carries them across.
- `console`, and `snapshot()` — returns the sheet summary (`sheets` with
  `name`, `rowCount`, `columnCount`, `usedRange`, plus `activeSheet`).

Writing past a sheet's current row/column count **grows the sheet** — you do not
have to call `setRowCount` first, and data is never silently dropped. (A bare
engine would discard the write and report success, which is why the plugin
guards it.) The ceiling is the spreadsheet's own: 1,048,576 rows × 16,384
columns.

**Your whole script already runs batched.** The engine suspends repainting, change
events *and* calculation around it — a 20k-row fill with formulas measured 3412ms
unbatched against 959ms batched, and the gap widens with size — so do **not** call
`suspendPaint()` / `suspendCalcService()` yourself, and do not break the fill into
more tool calls than it needs.

The one consequence to design around: **a formula you set in this script reads
`null` until you resume** — values loaded from the file are unaffected (a formula
set by an earlier call reads back correctly), and plain values are always fine.
So fill first, then read, resuming before you verify anything this script
computed:

```js
const s = sheet()
for (let r = 0; r < 50000; r++) { s.setValue(r, 0, r); s.setFormula(r, 1, '=A' + (r + 1) + '*2') }
s.setFormula(50000, 0, '=SUM(A1:A50000)')

spread.resumeCalcService()        // one recalculation; cheap
return { sum: s.getValue(50000, 0) }   // without the resume above this is null
```

The workbook is persisted only after the batch ends, so stored and exported values
are always fully calculated — a later `sjs_status`/`sjs_export`, or a fresh read in
the *next* tool call, always sees the real numbers.

Operations that name the **same workbook run one at a time, in arrival order**;
different workbooks still run in parallel. Issue parallel `sjs_execute` calls
against one workbook freely — each sees the previous one's result.

There is **no `require`, no `process`, no `fs`, no DOM**. Common calls:
`sheet().setValue(r, c, v)`, `.getValue(r, c)`, `.setFormula(r, c, '=SUM(…)')`,
`.setColumnWidth(c, w)` and `.setRowHeight(r, h)` (both in **pixels** — see the
layout section below), `.name('…')` (both getter and setter),
`.getUsedRange(GC.Spread.Sheets.UsedRangeType.data | …formula)`. A bare
`getUsedRange()` with no argument can return `null` here — pass the enum
explicitly.

`.getValue(r, c)` is the raw value; **`.getText(r, c)`** is that value *as
displayed*, after formatting and rounding. Use `getText` when checking whether a
value fits its column — `#,##0` renders wider than the number behind it — and note
there is no `getDisplayText`.

**`clear()` does not remove a formula.** `s.clear(r, c, rowCount, colCount)`
empties values and formatting, but a formula written into that cell *survives* —
the cell still counts in the used range and still recalculates, which makes a
"cleared" cell quietly keep costing you. Remove a formula by assigning null
(`s.setFormula(r, c, null)`); do both when you want a cell genuinely blank:

```js
s.clear(r, c, 1, 1)
s.setFormula(r, c, null)   // clear() alone leaves the formula in place
```

**Charts, shapes, slicers and pivot tables are available.** The `shapes`,
`charts`, `slicers`, `pivot-addon` and `datacharts-addon` packs ship with the
plugin:

```js
// chart — the data range is an ARGUMENT of charts.add
const chart = s.charts.add('c1', GC.Spread.Sheets.Charts.ChartType.columnClustered, 260, 20, 380, 240, 'A1:B5')
const title = chart.title(); title.text = '季度销量'; chart.title(title)   // read → mutate → set back

// pivot — sourceData is a table name (or an absolute-range formula)
d.tables.add('tableSales', 0, 0, 5, 2)
spread.addSheet(spread.getSheetCount(), new GC.Spread.Sheets.Worksheet('PivotLayout'))
const layout = spread.getSheet(spread.getSheetCount() - 1)
const pt = layout.pivotTables.add('pt1', 'tableSales', 1, 0, GC.Spread.Pivot.PivotTableLayoutType.outline, GC.Spread.Pivot.PivotTableThemes.medium8)
pt.add('地区', '地区', GC.Spread.Pivot.PivotTableFieldType.rowField)
pt.add('金额', '金额', GC.Spread.Pivot.PivotTableFieldType.valueField, GC.Pivot.SubtotalType.sum)
layout.slicers.add('sl1', 'pt1', '地区', GC.Spread.Sheets.Slicers.SlicerStyles.light1(), GC.Spread.Sheets.Slicers.SlicerType.pivotTable)
```

There is no `series().add(name, range)` / `categoryNames` path — pass the range to
`charts.add`. `chart.x()/y()/width()/height()` report geometry, and
`spread.setActiveSheetIndex(i)` selects which sheet a snapshot renders. A png
snapshot covers floating objects — charts, shapes, slicers, pictures — even when
they sit outside the used cell range or on a sheet that has no used cells at all
(a pivot layout).

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

## Unknown SpreadJS API: look it up, never guess

**Your training memory of the SpreadJS API is not reliable** — guessing a name or
signature produces `SJS_SCRIPT_ERROR` and costs a round trip. The complete
official API reference ships with this skill, so checking a symbol is one local
file read — do it *before* writing a call whose name, parameters, enum members or
return shape you have not already confirmed in this session.

**Where it is.** Under this skill's resource directory (given to you with this
body) there is a `reference/<version>/` tree holding the whole reference as
markdown, split exactly the way the docs site is:

```
reference/<version>/classes/     one file per class      <Full.Name>.md
reference/<version>/enums/       one file per enum       <Full.Name>.md
reference/<version>/modules/     one file per namespace  <Full.Name>.md
reference/<version>/interfaces/  …plus designer/, excelio/, collaboration/
```

**The file name is the symbol's full name**, so you do not need to search — glob
for it. **Do not build the path by hand**: the `<version>` folder names the *doc
set*, not the engine, and the two differ (the docs here are `V19.0 API文档` while
the installed engine reports 19.1.4) — a path assembled from the engine's version
simply will not resolve. Glob for the file name and let the version folder be
whatever it is. The reference base is available to your file tools; for example:

```
glob  pattern "**/GC.Spread.Sheets.Charts.ChartCollection.md"
      → classes/GC.Spread.Sheets.Charts.ChartCollection.md
        (add, all, get, remove, zIndex…)
glob  pattern "**/GC.Spread.Sheets.AutoFitType.md"
      → enums/…        (cell, cellWithHeader)
glob  pattern "**/GC.Spread.Sheets.Commands.md"
      → modules/…      (autoFitColumn, autoFitRow…)
```

Sheet-level members live on the `Worksheet` file, workbook-level ones on
`Workbook` — that is where `getText`, `setArray`, `frozenRowCount`, `printInfo`
and friends are documented. **Some files are large** (the `Worksheet` one is
~150 KB): grep inside the file for the method name rather than reading the whole
thing.

**If the reference file is missing or silent**, the engine's own TypeScript
declarations are installed beside the plugin and are authoritative for the exact
version in use — grep the class name in
`node_modules/@grapecity-software/spread-sheets/dist/gc.spread.sheets.d.ts`
(and the matching `dist/*.d.ts` of the `-io` / `-pdf` / `-charts` … packages).
They carry every signature with its JSDoc, but no prose or examples.

**Only if your environment has working web tools**, the same reference is also
published online, with feature guides under `/spreadjs/help/docs/`. Do not rely on
this: web search is not configured in every deployment, and a failed search costs
a round trip.

```
https://demo.grapecity.com.cn/spreadjs/help/api/classes/<Full.Name>
https://demo.grapecity.com.cn/spreadjs/help/api/enums/<Full.Name>
https://demo.grapecity.com.cn/spreadjs/help/api/modules/<Full.Name>
```

After any formula or cross-sheet change, read the affected cells back rather than
trusting the write.

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
| `SJS_SHEET_NAME_INVALID` | The name has a character Excel forbids (`: \ / ? * [ ]`), is empty, is over 31 characters, or starts/ends with `'` | Pick a name made of the offending characters' absence — the message names them. |
| `SJS_SHEET_LIMIT_EXCEEDED` | A write targets a row past 1,048,576 or a column past 16,384 | That is the spreadsheet ceiling; write less, or split across sheets. |
| `SJS_RESULT_TOO_LARGE`, `SJS_NON_SERIALIZABLE_RESULT` | Return value too big or not JSON | Return a compact summary or call `snapshot()`. |
| `SJS_UNSUPPORTED_IMPORT_FORMAT` | The engine cannot convert this source extension (Excel family variants beyond `.xlsx` reach the worker without a converter) | Convert the source to `.xlsx`/`.csv` first, then import. |
| `SJS_FILE_READ_FAILED`, `SJS_INVALID_SSJSON`, `SJS_FILE_WRITE_FAILED` | File-level IO / not a valid workbook | Correct the path/input; regenerate the `.ssjson` if corrupt. |
| `SJS_PDF_UNAVAILABLE`, `SJS_PDF_FONT_UNAVAILABLE`, `SJS_PNG_FONT_UNAVAILABLE`, `SJS_PNG_RENDER_FAILED` | PDF/PNG backend missing a font or failing to render | Headless rendering needs at least one CJK-capable `.ttf`/`.otf` registered on the host (`.ttc` unsupported). If PDF is unusable, fall back to `sjs_screenshot` `format: "png"`. |
| `SJS_WORKER_TIMEOUT`, `SJS_WORKER_INVALID_RESPONSE`, `SJS_WORKER_FAILED`, `SJS_BAD_REQUEST` | Worker/transport failure | Retry once with simpler work; report if persistent. |

## Gaps this phase does not cover

There is no client/UI to open a workbook live in-session — `sjs_screenshot` is
the visual surface. Worktrees have no `ready`/`merge`/`discard` yet. If the task
needs one of these, say so explicitly instead of inventing a substitute.
