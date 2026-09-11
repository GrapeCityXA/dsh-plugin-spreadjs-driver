# Architecture

`dsh-spreadjs-excel` embeds a headless [SpreadJS](https://www.grapecity.com/spreadjs)
engine in the DeepSeek Harness (DSH) runtime. The agent never opens a browser:
every `sjs_*` tool call operates on a canonical `.ssjson` workbook through a
short-lived worker process that loads the file with the real SpreadJS engine,
applies the requested change, and saves it back.

## Runtime requirements

- Node.js ≥ 22.19 (ESM throughout; the worker uses `createRequire` for the CJS
  SpreadJS/canvas bundles).
- DSH `0.1.1-rc.2 || 0.1.2-rc.1` (peer range, matching the current ecosystem).
- jsdom ≥ 30 (older jsdom `Blob` lacks `arrayBuffer`, which breaks xlsx import).
- Fonts for PDF export / PNG screenshots containing CJK text (see below).

## Layout

```
src/host/            DSH host bundle (compiled → lib/index.js)
  index.ts           plugin apply(): config → provider → tools
  config.ts          schema + resolveConfig
  service/           SjsService abstract surface, SjsError codes, workspace
                     authorization, worktree registry
  provider/          sjs-provider: spawns the worker per request
  adapters/          worker.ts (spawn/timeout/abort), protocol envelope typing
  tools/             sjs_new/status/execute/import/export/screenshot/worktree
                     tool definitions + presentation + workspace guards
src/workers/sjs/     headless worker (compiled → artifacts/sjs-worker.mjs)
  headless.ts        jsdom + node-canvas bootstrap, optional-pack loading
  operations.ts      per-op implementations (execute sandbox, import/export, …)
  render-png.ts      two-render PNG rasterizer (sjs_screenshot format: png)
  fonts.ts           system TTF discovery + SpreadJS PDF font registration
  errors.ts          SjsWorkerError
skills/spreadjs/     orchestration skill shipped to the runtime
docs/                this document
```

Two esbuild entry points keep the host bundle free of heavy/native imports:
`src/host/index.ts` → `lib/index.js` (DSH peers external, resolved from the
plugin's own `node_modules` at runtime) and `src/workers/sjs/entry.ts` →
`artifacts/sjs-worker.mjs`. The child process gets `NODE_PATH` set to the
plugin's `node_modules` so dependency resolution survives pnpm's isolated
layout.

## Process model

One request, one process. No daemon, no WebSocket:

1. The provider spawns `node artifacts/sjs-worker.mjs` with stdio pipes.
2. It writes a **single JSON request** on stdin and ends it.
3. The worker emits **exactly one JSON envelope** on stdout
   (`{ok:true,result}` | `{ok:false,error:{code,message}}`); logs go to stderr.
4. A hard `operationTimeoutMs` timer (default 60 s) plus the call's
   `AbortSignal` kill the child; cleanup happens in `finally`. Timeout waits for
   `close` (not `exit`) and reports `SJS_WORKER_TIMEOUT`.

Because worker state is one-shot, all state lives on disk in the `.ssjson`
file; a later call reloads it. Tool-level `file`/`output` paths are validated in
the host (realpath, workspace containment, never-overwrite) before the worker
sees them — the worker only ever receives already-authorized absolute paths.

## The .ssjson workspace

`.ssjson` is the plugin's canonical format: lossless and JSON. Tools edit only
`.ssjson`; external files enter via `sjs_import` (`.xlsx`/`.csv`/`.ssjson`) and
leave via `sjs_export` (`.xlsx`/`.csv`/`.ssjson`/`.pdf`). A file-level worktree
(`sjs_worktree`) snapshots a committed workbook into `.spreadjs/drafts/` so
multi-step agent edits stay isolated from the base file; this release supports
`create`/`list`, with approval (`merge`/`discard`) deferred to a later phase.

## Execute sandbox

`sjs_execute` runs user/agent code as the body of an `async` function inside a
fresh `node:vm` context each call. In scope: `spread`/`workbook`, `GC`, a
`sheet(name?)` resolver (the headless `fromJSON` does not register the by-name
dictionary, so resolution scans sheet indices), workspace-only `io`
(read/write/bytes, escape → `SJS_FILE_PERMISSION_DENIED`), `console`, and
`snapshot()` (sheet summary). There is no `require`, `process`, `fs`, or DOM.

`vm` is hygiene, not a security boundary. The real protections are process
isolation per call, host-side workspace whitelisting, the absent host globals,
and the hard timeout. After execution the workbook is always persisted, and the
return value must be JSON-serializable (oversized returns →
`SJS_RESULT_TOO_LARGE`).

## Headless engine bootstrap

The worker boots SpreadJS inside jsdom with `pretendToBeVisual: true` (rAF via
timer), copies the needed window globals into `global`, and installs
`global.canvas` / `global.self`. Known constraints baked into the code:

- `Blob`/`FileReader` need a realm patch for reliable xlsx import.
- `getUsedRange()` requires an explicit `UsedRangeType.data | formula`; the
  no-arg form can return `null` here.
- Optional packs load in dependency order (shapes → charts, print → pdf).

### PDF fonts

SpreadJS embeds fonts into PDFs through `PDFFontsManager`. Only `.ttf`/`.otf`
(not `.ttc`) register; the family name is the lowercase basename. System font
directories are scanned and `GC_SJS_PDF_FONT_DIRS` appends more. When no font
can be registered, PDF export/snapshot throws `SJS_PDF_FONT_UNAVAILABLE` rather
than silently emitting an empty-shell PDF. `png` screenshots fail with
`SJS_PNG_FONT_UNAVAILABLE` under the same condition.

### PNG rasterization (sjs_screenshot format: png)

SpreadJS paints onto a node-canvas-backed jsdom `<canvas>`. Three constraints
drive `render-png.ts`:

1. **Constructor-time host binding.** `new Workbook(host)` measures the host and
   builds layout; a later `setHost()` never does, leaving `getCellRect` NaN and
   the canvas at its 300×150 default.
2. **Two renders.** Content size is only knowable after a host binds, so the
   file renders once on a generous host to measure `getCellRect` of the last
   used cell, then again on a host sized so the canvas (= host − scrollbar) fits
   the content. A truly empty sheet falls back to a fixed viewport.
3. **Font forcing.** jsdom+node-canvas draws no CJK glyphs for SpreadJS's default
   family, so the used box gets a uniform, registered CJK-capable family. This
   flattens per-cell font/weight variety — a documented screenshot affordance,
   applied only to the in-memory capture workbook, never written back.

## Error codes

Errors travel as `Error [CODE]: message` and route recovery. Host-side:
`INVALID_FILE_PATH`, `SESSION_SCOPE_DENIED`, `FILE_PERMISSION_DENIED`,
`INVALID_EXECUTION_SOURCE`, `CODE_FILE_READ_FAILED`. Worker-side: `SJS_*` codes
covering script errors, missing sheets, IO, import/export/PDF/PNG backends, and
oversized results. The `spreadjs` skill ships the full recovery table.
