# Architecture

`dsh-plugin-spreadjs-driver` embeds a [SpreadJS](https://www.grapecity.com/spreadjs)
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
  provider/          sjs-provider: owns the engine, authorizes every path
  adapters/          worker.ts (start/frame/timeout/abort/env whitelist),
                     protocol typing
  tools/             sjs_new/status/execute/import/export/screenshot/worktree
                     tool definitions + presentation + workspace guards
src/workers/sjs/     engine process (compiled → artifacts/sjs-worker.mjs)
  entry.ts           the request loop: framing, idle shutdown, signals
  operations.ts      per-op implementations (paths, error codes, atomic writes)
  files.ts           Node-side file primitives (atomic write, copy)
  fonts.ts           system TTF discovery for PDF export
  browser/
    runtime.ts       boots server + browser once, page per operation
    cdp.ts           CDP client, browser launch/teardown, profile hygiene
    discovery.ts     find Edge/Chrome (config → Edge → Chrome)
    server.ts        loopback HTTP: /ws (workspace-confined) and /blob (host-only)
    page.embed.js    page-side half: SpreadJS work, no filesystem access
  errors.ts          SjsWorkerError
skills/spreadjs/     orchestration skill shipped to the runtime
docs/                this document
```

Two esbuild entry points keep the host bundle free of heavy imports:
`src/host/index.ts` → `lib/index.js` (DSH peers external, resolved from the
plugin's own `node_modules` at runtime) and `src/workers/sjs/entry.ts` →
`artifacts/sjs-worker.mjs`. The engine process gets `NODE_PATH` set to the
plugin's `node_modules` so dependency resolution survives pnpm's isolated
layout. `page.embed.js` is inlined into the engine bundle as a string and served
to the browser verbatim (see "Engine runtime" below).

## Process model

One engine process per host session, one browser per engine, one page per
operation:

1. The provider starts `node artifacts/sjs-worker.mjs` **on the first
   operation** and keeps it for the session.
2. Requests are newline-delimited JSON: `{id, request}` in,
   `{id, ok, result|error}` out, one line each, matched by id. The engine serves
   one request at a time, in arrival order.
3. The engine boots the browser on its first request and opens **a new page per
   operation**, closing it when the operation ends. Pages are the isolation
   boundary: fresh SpreadJS prototypes for every operation, so the guards
   installed on `Worksheet.prototype` are never re-patched over a used page.
4. A hard `operationTimeoutMs` timer (default 60 s) plus the call's
   `AbortSignal` KILL the engine, browser included, and report
   `SJS_WORKER_TIMEOUT`; the next call starts a new engine. An engine that dies
   on its own is reported as `SJS_ENGINE_DIED`.
5. The engine shuts itself down after `SJS_ENGINE_IDLE_MS` (default 60 s) with
   no requests, and immediately when its stdin closes — which is what happens
   when the host exits.

The browser is a **direct child** of the engine, never launched through a shell
or detached: that process chain is what makes the browser die with its starter
in every mode (killed, detached, crashed), so no watchdog is needed. Shutdown
is cooperative where it can be — `Browser.close` goes over CDP first, so the
browser destroys its own window and deletes its throwaway profile directory
with a retry loop (`rmSync` right after `Browser.close()` throws `EBUSY` on
Windows and leaks ~26 MB per launch). Profiles orphaned by a hard kill are swept
by the next launch once they are an hour old.

What the persistent browser buys is the cold start: the previous model paid a
browser launch plus ~14 MB of UMD loading on every operation (measured 3.3-3.9 s
per operation, `docs/design-real-browser-runtime.md` §4). Now the browser is
launched once, and each operation pays only its page: ~0.3 s once the browser's
cache holds the bundles (the first two pages of an engine are slower — they are
what fills the cache and V8's code cache). Measured: 3.3-3.9 s → 0.6-1.0 s for
every operation except PDF, which stays ~2.8 s because font registration is
per PAGE and is redone for every export.

Because engine state is per operation, all workbook state lives on disk in the
`.ssjson` file; a later call reloads it. Tool-level `file`/`output` paths are
validated in the host (realpath, workspace containment, never-overwrite) before
the engine sees them — the engine only ever receives already-authorized absolute
paths.

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
the OS process, host-side workspace whitelisting, the hard timeout, and the fact
that the page has no filesystem: the only file route it can reach on its own
(`/ws`) re-authorizes every request against the session workspace, and the
host-authorized route (`/blob/<nonce>`) names no path — a nonce is minted per
file per operation and the page can never point it at another one.

Since stage 2 the page is also the **isolation boundary between operations**:
each operation gets a fresh page, so nothing a script leaves behind (patched
prototypes, workbook globals, timers) can reach the next operation. That is why
a page is never reused to save milliseconds. After execution the workbook is
always persisted (before the return value is materialized), and the return value
must be JSON-serializable (oversized → `SJS_RESULT_TOO_LARGE`).

## Engine runtime

```
engine (Node)                        page (Edge/Chrome, headless)
  ├─ local HTTP server  ←──────────→  fetch/script tags
  │    /ws      workspace-confined      SpreadJS UMD bundles
  │    /blob/<nonce> host file          <div id="host"> + canvases
  └─ CDP client (global WebSocket) ──→ Runtime.evaluate / Page.navigate
```

One browser per engine; one page, one operation. The bundles are the only
cacheable route — every later page loads them out of the browser's HTTP cache
(~1.4 s of the first page's boot, ~0.3 s after), which is what makes the second
operation on an engine cheap.

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

**The manager belongs to the page, so registration is per operation** — the one
cost a persistent browser does not remove, and the reason PDF is the slowest
operation by a wide margin: ~345 fonts, measured ~1.6 s of every ~2.8 s PDF
operation, re-paid on each one (`[sjs:page] registered N PDF fonts in Xms` on
stderr). Making it cheaper means a shared manager across pages, i.e. not a fresh
page per operation — a trade this design does not make.

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
`INVALID_EXECUTION_SOURCE`, `CODE_FILE_READ_FAILED`. Engine-side: `SJS_*` codes
covering script errors, missing sheets, IO, import/export/PDF/PNG backends,
oversized results, and the engine's own lifetime (`SJS_ENGINE_DIED` when the
engine process goes away mid-call, `SJS_WORKER_TIMEOUT` when the call overruns
`operationTimeoutMs`). The `spreadjs` skill ships the full recovery table.
