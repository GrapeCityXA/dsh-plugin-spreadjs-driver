# Architecture

editor (browser Workbook) → selected driver bridge → authenticated DSH RPC → host tool

The editor owns the licensed SpreadJS instance. The driver receives a provider containing a live reference in the same browser heap. The reference never crosses the wire: only JavaScript code, workbook descriptors and JSON results do. The host has no SpreadJS engine, worker, browser launcher or canonical workbook file.

The host exposes sjs_live_status, sjs_live_open and sjs_live_execute only while explicitly selected by the editor. Missing settings and foreign/empty selections leave the tools and skill unregistered. Missing transport/client/workbook returns a classified error, with no server fallback. Providers without a ready Workbook are not advertised as execution targets. The executor checks again when a queued job arrives.

An editor also advertises the currently visible session, even without a Workbook. sjs_live_open confines destination/custom-template paths to the caller's workspace. With create:true it copies the package's templates/empty.xlsx; an optional workspace template supports same-extension creation in other formats. It checks destination parents, including symlinks/junctions, while creating missing directories, copies exclusively, and sends an opening job only to a tab showing that session. The editor uses the public sidebarRight.openResource API and waits for its own loaded provider. No Workbook data crosses the wire. A failed opening does not delete a file already copied. Packaging checks exercise creation from the installed bundle to verify its template is shipped and resolves correctly.

Editor getWorkbook is unavailable before a file loads, after load failure, during loading/saving, and after teardown. Successful loads expose the Designer's own instance. save: true delegates to editor write-back; errors remain errors even if the edit succeeded. Workbook lifetime and licensing belong to the editor's web origin.

src/host/live contains tools, authentication and the channel. src/client contains the browser bridge and executor. src/host/activation.ts reads the editor's selected bridge. src/host/service/workspace.ts confines codeFile reads to the session workspace. scripts/build.mjs builds host/client bundles only; package checks reject legacy artifacts.

Execution holds an exclusive lease issued by the editor and passes it back for save. Header actions and mouse/keyboard editing are blocked while it is held. On close/switch, the editor snapshots dirty or leased Workbooks before destruction into its existing page-local recovery cache; reopening restores that data using the existing baseline conflict checks. The Driver returns SJS_LIVE_INTERRUPTED on provider/instance/path replacement and releases the lease in finally. Lease saving and release remain bound to the original owner across navigation.

The browser execution body shares page globals and is not a JavaScript security sandbox. A host timeout stops waiting, but cannot roll back edits or forcibly terminate browser JavaScript. API calls are not guaranteed to be undoable. Recovery retains only the snapshot at close, not later work from an outstanding async script, and neither resumes JavaScript nor survives a page refresh. Snapshot failures are logged by the editor. Keep edits short and inspect partial results before continuing.
