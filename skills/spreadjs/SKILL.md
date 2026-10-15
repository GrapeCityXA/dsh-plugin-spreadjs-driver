---
name: spreadjs
description: Inspect and edit the workbook open in the DSH SpreadJS editor using sjs_live_status and sjs_live_execute. Look up SpreadJS APIs in the bundled reference.
---

# SpreadJS editor

Use sjs_live_status first to identify available workbooks and their file paths. If there is no usable target, ask the user to open the file in the editor, select this driver under Settings → Spreadsheet Editor, and wait for loading to finish. Never fall back to a hidden browser or create a separate Workbook.

Use sjs_live_execute for reads, cells, formulas, sheets, formatting, charts and other SpreadJS APIs on the open document. Pass exactly one of code or codeFile, and target when needed. Code files must be inside the DSH session workspace. The code is an async function body with spread/workbook (the same live instance), GC (the editor's namespace), sheet(name?), snapshot() and console. It has no io helper. Return compact JSON data rather than engine objects.

Rows/columns are zero-based. Prefer sheet('name') to resolve worksheets. Look up API signatures in reference/ before using unfamiliar methods; this is an offline reference and may describe a different SpreadJS version, so check the editor's namespace where needed. Do not remove evaluation marks or modify licensing behavior.

Example:

    const s = sheet()
    s.setValue(0, 0, 'Quantity')
    s.setValue(1, 0, 10)
    s.setFormula(2, 0, '=SUM(A2:A2)')
    return { value: s.getValue(2, 0) }

Edits appear immediately in the editor. Keep save false unless the user explicitly asked to save or overwrite the file. save: true calls the editor's save; a failed save does not roll back edits. Do not promise undo for arbitrary direct API changes. Re-read the affected cells to verify results. Keep scripts short: timeout is not cancellation or rollback of browser JavaScript.

There are no sjs_new/status/execute/import/export/screenshot/worktree file tools. New/open/import/export actions belong to the editor. Do not claim a file was written unless saving succeeded.
