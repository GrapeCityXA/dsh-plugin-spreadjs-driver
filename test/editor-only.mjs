import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/index.js'
import { readFile, readdir } from 'node:fs/promises'
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const host = await readFile(new URL('../src/host/index.ts', import.meta.url), 'utf8')
if (Object.keys(pkg.dependencies ?? {}).length !== 0) throw new Error('runtime dependencies must be empty')
if (/SjsProvider|SjsEngine|toolsPlugin/.test(host)) throw new Error('server engine reference remains')
if (pkg.exports?.['./client']?.default !== './lib/client.js') throw new Error('client export missing')
for (const dir of ['../src/workers', '../src/host/provider', '../src/host/adapters']) {
  try { if ((await readdir(new URL(dir, import.meta.url), { recursive: true, withFileTypes: true })).some(entry => entry.isFile())) throw new Error(`obsolete ${dir}`) } catch (e) { if (e.code !== 'ENOENT') throw e }
}
for (const config of [{ browserPath: 'chrome' }, { live: false }]) {
  assert.throws(() => resolveConfig(config), /requires a workbook supplied by the web editor/)
}
console.log('architecture: editor-only verified')
