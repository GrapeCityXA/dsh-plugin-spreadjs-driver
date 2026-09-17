import { fileURLToPath } from 'node:url'

// The host bundle is emitted at <pkg>/lib/index.js and the worker at
// <pkg>/artifacts/sjs-worker.mjs. Both fileURLToPath calls below are relative to
// the compiled host entry (import.meta.url), so they resolve inside the package
// no matter where pnpm or npm placed that package under node_modules.

/** Bundled one-shot worker executed for new/status/execute (later import/export/screenshot). */
export const SJS_WORKER_ENTRY = fileURLToPath(new URL('../artifacts/sjs-worker.mjs', import.meta.url))

/**
 * This plugin's node_modules root — the NODE_PATH given to spawned worker
 * processes. The worker resolves its heavy runtime dependencies
 * (@grapecity-software/*, jsdom, canvas) through here.
 */
export const PLUGIN_NODE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url))
