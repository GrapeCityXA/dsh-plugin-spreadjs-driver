// Build the host dispatcher and the browser bridge. Neither bundles a spreadsheet engine.
import { build } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'

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

// Only remove the generated legacy worker, including its source map.
for (const file of ['lib/sjs-worker.mjs', 'lib/sjs-worker.mjs.map', 'lib/sjs-worker.js', 'lib/sjs-worker.js.map']) await rm(file, { force: true })
for (const options of [host, client]) await build(options)
console.log('esbuild: host + client bundles written')
