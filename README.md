# @grapecity-software/dsh-spreadjs-driver

English · [简体中文](README.zh-CN.md)

Inspect and edit the Workbook open in the DSH SpreadJS editor. The editor creates and licenses SpreadJS in the user's browser; this driver uses the exact instance supplied by the editor. The host dispatches code and returns JSON results. It never starts a browser or creates a second Workbook.

## Setup

Install both the SpreadJS editor and driver into a DSH web profile. Open Settings → Spreadsheet Editor and select this driver, then open a workbook in the sidebar and wait for loading to finish. Configure the SpreadJS and Designer licenses in the editor for the domain serving the web UI.

Node.js 22.19 or later is required. DSH 0.2.0-rc.2 or later is required for the editor bridge picker. No browser installation on the DSH server is required. A CLI-only profile cannot edit spreadsheets through this driver.

## Tools

| Tool | Behavior |
| --- | --- |
| sjs_live_status | Report transport readiness and the open editor workbooks. |
| sjs_live_open | Open a workspace file and wait for the editor's Workbook; use create:true to create an .xlsx from the bundled blank template. |
| sjs_live_execute | Run an async JavaScript body against the editor's Workbook. |

Execution accepts exactly one of code or codeFile (a file inside the session workspace), an optional target, and save (default false). It provides spread/workbook, GC, sheet(name?), snapshot(), console, and signal (AbortSignal). Return a compact JSON-serializable value. Code runs in the editor page and shares its globals.

Status and execution are confined to the calling chat. Use the opaque `id` returned by status as `target`; do not construct it or reuse it after a reload/reopen. Several available workbooks require an explicit target, including the same file open in several browser tabs. Jobs bind to a browser, provider, chat, file and load instance, and reject a replacement instance. Both plugins need the updated identity protocol; an older editor is not an executable target.

Example code: const s = sheet(); s.setValue(0, 0, 'Total'); return snapshot()

For a new chat without an open workbook, call `sjs_live_open({ path: "test-output/report.xlsx", create: true })`, then execute against the loaded workbook. The plugin ships its own `templates/empty.xlsx` with one blank Sheet1 spanning 200 rows and 20 columns; users do not need to prepare a template or destination directories. Missing directories are created inside the calling session workspace, and an existing destination is never overwritten. Omit `create` and `template` to open an existing file. An optional `template` path inside the workspace creates a file of the same extension, including other supported formats; `create:false` cannot be combined with `template`. The bundled default supports `.xlsx` only. The calling chat must be visible in the web UI. Copying and opening are separate steps: if opening fails, a successfully copied file remains on disk.

Changes remain in the editor until saved. Pass save: true only when the user requested writing the file; save errors are returned even if the preceding edit succeeded. Direct API calls are not guaranteed to enter SpreadJS's undo history.

During execution the editor grants an exclusive lease, blocks mouse and keyboard editing, and disables conflicting save/new/export actions. Closing or switching the editor interrupts the job with `SJS_LIVE_INTERRUPTED`; before destroying the Workbook, the editor keeps a recovery snapshot in its existing page-local cache. Reopen the file to recover it and inspect partial changes before continuing. This does not resume JavaScript or preserve the cache across a page refresh; snapshot failures are logged by the editor.

## Migration

Cancellation and timeout revoke the job's permission to save. The browser checks permission during async work, after the script, and after export before write-back. Use `signal` for cooperative cancellation. A script that ignores it retains its lease until it settles or the editor destroys the instance. Partial edits remain; arbitrary JavaScript cannot be forcibly stopped, and a write already sent to the server may still complete. Recovery snapshots are keyed by the full chat resource address, so same-named files in different chats remain separate.

The server worker, CDP/hidden-browser runtime, SpreadJS runtime dependencies, and seven file tools (sjs_new, sjs_status, sjs_execute, sjs_import, sjs_export, sjs_screenshot, sjs_worktree) have been removed. browserPath and live configuration options are unsupported. There is no fallback to a server engine when the editor is absent. New files can be copied from templates through sjs_live_open; all Workbook initialization, import and export remain editor features.

The driver registers its tools and bundled skill only while explicitly selected in the editor. An unavailable/loading Workbook is not offered as a runnable target. A previously advertised target can remain visible briefly until the channel's heartbeat expires; execution checks the reference again.

## Development

Install dependencies, then run pnpm run ci. The build emits only lib/index.js and lib/client.js (plus the host source map). Tests cover selection, authenticated transport, browser execution and save failures; pack checks reject legacy engine artifacts. The bundled API reference is under skills/spreadjs/reference. See [architecture](docs/architecture.md).
