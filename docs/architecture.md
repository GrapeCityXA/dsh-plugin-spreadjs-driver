# Architecture

editor (browser Workbook) → selected driver bridge → authenticated DSH RPC → host tool

The editor owns the licensed SpreadJS instance. The driver receives a provider containing a live reference in the same browser heap. The reference never crosses the wire: only JavaScript code, workbook descriptors and JSON results do. The host has no SpreadJS engine, worker, browser launcher or canonical workbook file.

The host exposes sjs_live_status and sjs_live_execute only while explicitly selected by the editor. Missing settings and foreign/empty selections leave the tools and skill unregistered. Missing transport/client/workbook returns a classified error, with no server fallback. Providers without a ready Workbook are not advertised. The executor checks again when a queued job arrives.

Editor getWorkbook is unavailable before a file loads, after load failure, during loading/saving, and after teardown. Successful loads expose the Designer's own instance. save: true delegates to editor write-back; errors remain errors even if the edit succeeded. Workbook lifetime and licensing belong to the editor's web origin.

src/host/live contains tools, authentication and the channel. src/client contains the browser bridge and executor. src/host/activation.ts reads the editor's selected bridge. src/host/service/workspace.ts confines codeFile reads to the session workspace. scripts/build.mjs builds host/client bundles only; package checks reject legacy artifacts.

The browser execution body shares page globals and is not a JavaScript security sandbox. A host timeout stops waiting, but cannot roll back edits or forcibly terminate browser JavaScript. API calls are not guaranteed to be undoable. Concurrent file navigation during an asynchronous script remains a caller consideration; keep edits short and verify results.
