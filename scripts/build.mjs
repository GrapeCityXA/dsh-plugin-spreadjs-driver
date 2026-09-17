// Build the three runtime artifacts from TypeScript sources:
//   - host bundle  : src/host/index.ts   -> lib/index.js            (loaded by DSH)
//   - sjs worker   : src/workers/sjs/entry.ts -> artifacts/sjs-worker.mjs (spawned per call)
//   - client half  : src/client/index.ts -> lib/client.js           (loaded into the browser)
//
// The host bundle keeps the @deepseek-ai peers external so a second copy of
// Cordis is never inlined. The worker has no static package imports: the
// @grapecity-software UMD bundles it drives are located at runtime as files and
// served to the browser, and the page half ships as page.embed.js.
// The client half is wrapped as the module-table closure factory the DSH client
// loader expects (same artifact shape the spreadjs-editor client uses).
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const target = 'node22'
// Keep every @deepseek-ai peer external so a second copy of Cordis and friends
// is never inlined. Derived from peerDependencies so a new peer (e.g. dsh-skill)
// cannot silently drop out of the external set.
const { peerDependencies, name: packageName } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const peers = Object.keys(peerDependencies)

// Module-table specifiers the browser half resolves at runtime instead of
// inlining. Mirrors the spreadjs-editor client convention.
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis']

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
  // The browser half of the runtime ships as page script SOURCE, embedded into
  // the worker bundle as a string and served to the page over loopback HTTP. It
  // cannot be a normal module: it has to arrive at the page as a plain script
  // (see the note at the top of page.embed.js).
  loader: { '.embed.js': 'text' },
}

// The browser half is loaded by the DSH client-modules system, which expects a
// CommonJS closure factory registered on window.__ModuleLoader__. esbuild has no
// separate `intro` hook (tsdown does), so the module object the wrapper closes
// over is declared at the top of the banner.
const client = {
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: CLIENT_EXTERNALS,
  sourcemap: false,
  logLevel: 'info',
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
}

const onlyWorker = process.argv.includes('worker')
const entries = onlyWorker ? [worker] : [host, worker, client]
for (const options of entries) {
  await build(options)
}
console.log(`esbuild: ${onlyWorker ? 'worker' : 'host + worker + client'} bundle(s) written`)
