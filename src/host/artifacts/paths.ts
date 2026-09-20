import { fileURLToPath } from 'node:url'

// The host bundle is emitted at <pkg>/lib/index.js and the worker at
// <pkg>/artifacts/sjs-worker.mjs. Both fileURLToPath calls below are relative to
// the compiled host entry (import.meta.url), so they resolve inside the package
// no matter where pnpm or npm placed that package under node_modules.

/**
 * Bundled engine process: started once per host session and left running, it
 * serves every new/status/execute/import/export/screenshot request over
 * newline-delimited JSON (see src/workers/sjs/entry.ts).
 */
export const SJS_WORKER_ENTRY = fileURLToPath(new URL('../artifacts/sjs-worker.mjs', import.meta.url))

/**
 * This plugin's node_modules root — the NODE_PATH given to the engine process
 * spawned. It resolves its heavy runtime dependencies (@grapecity-software/*,
 * whose UMD builds it serves to the browser) through here.
 */
export const PLUGIN_NODE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url))
