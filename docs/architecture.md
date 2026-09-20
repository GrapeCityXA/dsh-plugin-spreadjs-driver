# Architecture

`dsh-spreadjs-excel` embeds a [SpreadJS](https://www.grapecity.com/spreadjs)
engine in the DeepSeek Harness (DSH) runtime. Every `sjs_*` tool call operates on
a canonical `.ssjson` workbook through a short-lived worker process that loads
the file with the real SpreadJS engine, applies the requested change, and saves
it back.

The engine itself runs in a **real, hidden browser** (the system's Edge or
Chrome, driven over CDP) rather than in Node under a DOM shim. Nobody sees that
browser: it is headless, it exists only for the duration of one operation, and
the user never interacts with it.

## Runtime requirements

- Node.js ≥ 22.19 (ESM throughout; the worker uses `createRequire` for the CJS
  SpreadJS bundles and Node's global `fetch`/`WebSocket` for CDP — no npm
  dependency is added by the browser runtime).
- DSH `0.1.5-rc.2` (peer range: the single version this plugin is built and
  tested against — see the note on version claims in `README.md`).
- **Microsoft Edge or Google Chrome installed on the machine.** Discovery probes
  the standard Windows paths for Edge then Chrome (plus the macOS/Linux
  equivalents); set the `browserPath` plugin option only when the browser lives
  somewhere unusual. Nothing found → `SJS_BROWSER_UNAVAILABLE` with the probed
  paths in the message.
- A writable temp directory for the browser's throwaway profile (`TEMP`/`TMP`/
  `TMPDIR`/`SJS_BROWSER_PROFILE_DIR`).
- Fonts for PDF export containing CJK text (see below). PNG screenshots need
  nothing extra: the browser has real fonts.

## Layout

```
src/host/            DSH host bundle (compiled → lib/index.js)
  index.ts           plugin apply(): config → provider → tools
  config.ts          schema + resolveConfig (incl. browserPath)
  service/           SjsService abstract surface, SjsError codes, workspace
                     authorization, worktree registry
  provider/          sjs-provider: spawns the worker per request
  adapters/          worker.ts (spawn/timeout/abort/env whitelist), protocol typing
  tools/             sjs_new/status/execute/import/export/screenshot/worktree
                     tool definitions + presentation + workspace guards
src/workers/sjs/     worker (compiled → artifacts/sjs-worker.mjs)
  operations.ts      per-op implementations (paths, error codes, atomic writes)
  files.ts           Node-side file primitives (atomic write, copy)
  fonts.ts           system TTF discovery for PDF export
  browser/
    runtime.ts       boots server + browser + page, exposes per-op Node facade
    cdp.ts           CDP client, browser launch/teardown, profile hygiene
    discovery.ts     find Edge/Chrome (config → Edge → Chrome)
    server.ts        loopback HTTP: /ws (workspace-confined) and /fs (host-only)
    page.embed.js    page-side half: SpreadJS work, no filesystem access
  errors.ts          SjsWorkerError
skills/spreadjs/     orchestration skill shipped to the runtime
docs/                this document
```

Two esbuild entry points keep the host bundle free of heavy imports:
`src/host/index.ts` → `lib/index.js` (DSH peers external, resolved from the
plugin's own `node_modules` at runtime) and `src/workers/sjs/entry.ts` →
`artifacts/sjs-worker.mjs`. The child process gets `NODE_PATH` set to the
plugin's `node_modules` so dependency resolution survives pnpm's isolated
layout. `page.embed.js` is inlined into the worker bundle as a string and served
to the browser verbatim (see "Engine runtime" below).

## Process model

One request, one process. No daemon, no long-lived browser:

1. The provider spawns `node artifacts/sjs-worker.mjs` with stdio pipes.
2. It writes a **single JSON request** on stdin and ends it.
3. The worker emits **exactly one JSON envelope** on stdout
   (`{ok:true,result}` | `{ok:false,error:{code,message}}`); logs go to stderr.
4. A hard `operationTimeoutMs` timer (default 60 s) plus the call's
   `AbortSignal` kill the child; cleanup happens in `finally`. Timeout waits for
   `close` (not `exit`) and reports `SJS_WORKER_TIMEOUT`.

The browser is a child of that worker and dies with it: the entry point closes
the runtime on the success AND failure paths, `Browser.close` is sent over CDP
first, and the throwaway profile directory is deleted with a retry loop (a
one-shot `rmSync` right after `Browser.close()` throws `EBUSY` on Windows and
leaks ~26 MB per launch). Profiles orphaned by a host timeout kill are swept by
the next launch once they are an hour old.

The cost of this model is cold start: every operation pays a browser launch plus
~14 MB of UMD bundle loading — measured ~2.5 s of page-ready work out of ~4.0 s
per operation, i.e. most of the bill. It is deliberately kept for this stage
because it is what makes `sjs_execute`'s isolation story true — a hostile script
dies with its process. A persistent browser is a later stage; see
`docs/design-real-browser-runtime.md`.

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

`sjs_execute` runs user/agent code as the body of an `async` function *inside the
engine page*. In scope: `spread`/`workbook`, `GC`, a `sheet(name?)` resolver
(resolution scans sheet indices rather than trusting the by-name dictionary),
workspace-only `io` (read/write/bytes, escape → `SJS_FILE_PERMISSION_DENIED`),
`console` (forwarded to the worker's stderr), and `snapshot()` (sheet summary).
There is no `require`, `process`, or `fs` — the page has none of them.

That sandbox is **hygiene, not a security boundary**; it was a `node:vm` context
before the runtime swap and it is a page function now. The real protections are
process isolation per call, host-side workspace whitelisting, and the hard
timeout — plus, since the page is a browser context, the fact that the only file
route it can reach on its own (`/ws`) re-authorizes every request against the
session workspace. The host-authorized `/fs` route additionally requires a
per-process capability token that is never stored in a page global. After
execution the workbook is always persisted (before the return value is
materialized), and the return value must be JSON-serializable (oversized →
`SJS_RESULT_TOO_LARGE`).

## Engine runtime

```
worker (Node)                        page (Edge/Chrome, headless)
  ├─ local HTTP server  ←──────────→  fetch/script tags
  │    /ws  workspace-confined          SpreadJS UMD bundles
  │    /fs  host paths + capability     <div id="host"> + canvases
  └─ CDP client (global WebSocket) ──→ Runtime.evaluate / Page.navigate
```

- **Bundles are served, not injected.** The page document pulls each
  `@grapecity-software` UMD build through a `<script src>` over loopback. Bundle
  source must never be handed to `Runtime.evaluate`: an evaluated bundle is
  wrapped in a function by the evaluate wrapper, which makes its top-level `var
  GC` function-local and leaves `typeof GC === 'undefined'` afterwards with no
  exception. `page.embed.js` is served the same way, for the same reason.
- **Bytes travel over HTTP, not CDP.** A browser has no filesystem, so Node owns
  every read and write; the page fetches what Node serves and POSTs what Node
  should write. Loopback HTTP measured ~15x faster than base64 through CDP for a
  10 MB payload, and it keeps big workbooks out of the protocol entirely.
- **Load order is a dependency chain:** core → io → shapes → charts → slicers →
  print → pdf → pivot → datacharts. Every file is verified to exist before the
  browser starts (`SJS_BROWSER_FAILED` otherwise), so a packaging change cannot
  degrade into a silent `GC is undefined`.
- **Content types matter.** Serving the page as `application/octet-stream` makes
  the browser *download* it, which surfaces as `net::ERR_ABORTED`, then "No
  target with given id found", then "Session with given id not found" — three
  CDP errors that never mention MIME.

### PDF fonts

SpreadJS embeds fonts into PDFs through `PDFFontsManager`, and this does not
change in a browser: `savePDF` is a pure-JS PDF writer that embeds only
registered fonts, so an unregistered CJK cell silently produces a hollow PDF
(`Times-Roman`, no `FontFile`). Only `.ttf`/`.otf` register (never `.ttc`); the
family name is the lowercase basename. Node scans the system font directories
(`GC_SJS_PDF_FONT_DIRS` appends more) and hands the page a URL per font, which
the page fetches and registers. When nothing can be registered, PDF
export/snapshot throws `SJS_PDF_FONT_UNAVAILABLE` instead of emitting an empty
shell.

### PNG rasterization (sjs_screenshot format: png)

The pixels are the engine's own: the sheet is rendered into a host in the page
and read back from **the content canvas** (`canvas.toBlob`), never from
`Page.captureScreenshot` (which captures browser chrome and overlays, not a clean
sheet). Two constraints carry over from the jsdom implementation and are still
load-bearing:

1. **Constructor-time host binding.** `new Workbook(host)` measures the host and
   builds layout; binding later never does.
2. **Model-based measurement.** Content size comes from the model — the used
   range's column widths and row heights plus the headers, unioned with the
   extent of floating objects (charts, shapes, pictures, **slicers**) — not from
   `getCellRect`. A rendered rect only answers inside the probe's own viewport,
   so content that outgrew it used to fail the whole screenshot. Past the raster
   ceiling (2600×2200) the image is a crop and the result says `clipped: true`.

The canvas is picked as **the largest one whose computed `z-index` is `auto`**:
there are ~11 canvases, and "largest alone" finds a zero-height overlay while
"darkest alone" finds the opaque background layer. The host is sized so the
canvas (host − the 18 px scrollbar the engine reserves) is exactly the measured
content plus an 8 px pad, which is what makes the reported width match the
model's own arithmetic.

Font forcing is gone: a real browser draws CJK with real fonts, so no family is
imposed and per-cell font/weight variety survives in the image.

## Error codes

Errors travel as `Error [CODE]: message` and route recovery. Host-side:
`INVALID_FILE_PATH`, `SESSION_SCOPE_DENIED`, `FILE_PERMISSION_DENIED`,
`INVALID_EXECUTION_SOURCE`, `CODE_FILE_READ_FAILED`. Worker-side: `SJS_*` codes
covering script errors, missing sheets, IO, import/export/PDF/PNG backends, and
oversized results. The `spreadjs` skill ships the full recovery table.
