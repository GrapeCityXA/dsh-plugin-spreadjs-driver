// Build the two runtime artifacts from TypeScript sources:
//   - host bundle  : src/host/index.ts   -> lib/index.js            (loaded by DSH)
//   - sjs worker   : src/workers/sjs/entry.ts -> artifacts/sjs-worker.mjs (spawned per call)
//
// The host bundle keeps the @deepseek-ai peers external so a second copy of
// Cordis is never inlined. The worker has no static package imports: its heavy
// deps (@grapecity-software/*, jsdom, canvas) are loaded at runtime through
// createRequire, which resolves them from this package's own node_modules.
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const target = 'node22'
// Keep every @deepseek-ai peer external so a second copy of Cordis and friends
// is never inlined. Derived from peerDependencies so a new peer (e.g. dsh-skill)
// cannot silently drop out of the external set.
const { peerDependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const peers = Object.keys(peerDependencies)

const host = {
  entryPoints: ['src/host/index.ts'],
  bundle: true,
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  target,
  external: peers,
  sourcemap: true,
  logLevel: 'info',
}

const worker = {
  entryPoints: ['src/workers/sjs/entry.ts'],
  bundle: true,
  outfile: 'artifacts/sjs-worker.mjs',
  format: 'esm',
  platform: 'node',
  target,
  external: peers,
  sourcemap: false,
  logLevel: 'info',
}

const onlyWorker = process.argv.includes('worker')
const entries = onlyWorker ? [worker] : [host, worker]
for (const options of entries) {
  await build(options)
}
console.log(`esbuild: ${entries.length === 1 ? 'worker' : 'host + worker'} bundle(s) written`)
