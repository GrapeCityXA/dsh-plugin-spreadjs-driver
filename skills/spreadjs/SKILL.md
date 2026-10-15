---
name: spreadjs
description: Open, inspect and edit workbooks through the DSH SpreadJS editor using sjs_live_open, sjs_live_status and sjs_live_execute. Look up SpreadJS APIs in the bundled reference.
---

# SpreadJS editor

Use sjs_live_status first to identify available workbooks and their file paths. Use sjs_live_open with path to open an existing workspace spreadsheet and wait for the editor to finish loading. To create an .xlsx, use create:true, for example sjs_live_open({path:"test-output/report.xlsx",create:true}). The plugin bundles empty.xlsx; do not ask the user to prepare a template or directory. Missing destination directories are created inside the workspace and existing files are never overwritten. For other formats, supply an optional same-extension workspace template; never rename XLSX bytes to .sjs. Supplying template implies creation and cannot be combined with create:false. The calling chat must be visible in the DSH web UI and this Driver selected under Settings → Spreadsheet Editor. If opening fails after copying, the newly copied file remains on disk. Never fall back to a hidden browser or create a separate Workbook.

Use sjs_live_execute for reads, cells, formulas, sheets, formatting, charts and other SpreadJS APIs on the open document. Pass exactly one of code or codeFile, and target when needed. Code files must be inside the DSH session workspace. The code is an async function body with spread/workbook (the same live instance), GC (the editor's namespace), sheet(name?), snapshot() and console. It has no io helper. Return compact JSON data rather than engine objects.

Rows/columns are zero-based. Prefer sheet('name') to resolve worksheets. Look up API signatures in reference/ before using unfamiliar methods; this is an offline reference and may describe a different SpreadJS version, so check the editor's namespace where needed. Do not remove evaluation marks or modify licensing behavior.

Example:

    const s = sheet()
    s.setValue(0, 0, 'Quantity')
    s.setValue(1, 0, 10)
    s.setFormula(2, 0, '=SUM(A2:A2)')
    return { value: s.getValue(2, 0) }

Edits appear immediately in the editor. Keep save false unless the user explicitly asked to save or overwrite the file. save: true calls the editor's save; a failed save does not roll back edits. Do not promise undo for arbitrary direct API changes. Re-read the affected cells to verify results. Keep scripts short: timeout is not cancellation or rollback of browser JavaScript.

Execution acquires an exclusive editor lease: the user can view the workbook but cannot edit it concurrently. If SJS_LIVE_INTERRUPTED is returned after the editor closes or switches files, reopen the same file using sjs_live_open and inspect recovered partial changes before continuing. Do not blindly replay the whole script. Recovery uses the editor's page-local snapshot cache, does not survive a page refresh, and does not resume JavaScript. Snapshotting can fail, so verify what was recovered.

After successful execution, report the result without reopening the workbook just to bring its tab to the front. Respect the user's tab selection. Use sjs_live_open when opening is needed for the next operation or the user asks to view the file.

There are no sjs_new/status/execute/import/export/screenshot/worktree file tools. sjs_live_open can copy a template, but Workbook loading/import/export belong to the editor. Do not claim edits were written unless saving succeeded.
