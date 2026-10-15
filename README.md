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
| sjs_live_execute | Run an async JavaScript body against the editor's Workbook. |

Execution accepts exactly one of code or codeFile (a file inside the session workspace), an optional target, and save (default false). It provides spread/workbook, GC, sheet(name?), snapshot(), and console. Return a compact JSON-serializable value. Code runs in the editor page and shares its globals.

Example code: const s = sheet(); s.setValue(0, 0, 'Total'); return snapshot()

Changes remain in the editor until saved. Pass save: true only when the user requested writing the file; save errors are returned even if the preceding edit succeeded. Direct API calls are not guaranteed to enter SpreadJS's undo history.

## Migration

The server worker, CDP/hidden-browser runtime, SpreadJS runtime dependencies, and seven file tools (sjs_new, sjs_status, sjs_execute, sjs_import, sjs_export, sjs_screenshot, sjs_worktree) have been removed. browserPath and live configuration options are unsupported. There is no fallback to a server engine when the editor is absent. Import, export and new-workbook actions remain editor features.

The driver registers its tools and bundled skill only while explicitly selected in the editor. An unavailable/loading Workbook is not offered as a runnable target. A previously advertised target can remain visible briefly until the channel's heartbeat expires; execution checks the reference again.

## Development

Install dependencies, then run pnpm run ci. The build emits only lib/index.js and lib/client.js (plus the host source map). Tests cover selection, authenticated transport, browser execution and save failures; pack checks reject legacy engine artifacts. The bundled API reference is under skills/spreadjs/reference. See [architecture](docs/architecture.md).
