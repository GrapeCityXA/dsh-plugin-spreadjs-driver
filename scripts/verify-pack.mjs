// Assert the packed tarball ships every runtime file a fresh install needs.
// Runs `npm pack --dry-run --json` and compares the file list against the
// required runtime set (host bundle, worker, skill, docs, patches).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Run npm through a real process. On Windows, `.cmd` shims cannot be spawned
// directly (EINVAL) — instead spawn the current node binary on npm's cli.js
// (same interpreter, no shell). On POSIX, `npm` from PATH is a shell script.
function spawnNpm(args) {
  const options = { cwd: ROOT, encoding: 'utf8' }
  if (process.platform !== 'win32') return spawnSync('npm', args, options)
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(cli)) return spawnSync(process.execPath, [cli, ...args], options)
  // Fallback: rely on shell resolution for non-standard installs.
  return spawnSync('npm', args, { ...options, shell: true })
}
const run = spawnNpm(['pack', '--dry-run', '--json'])
if (run.error || run.status !== 0) {
  console.error(run.stderr || run.stdout || `npm spawn failed: ${run.error?.code ?? run.error?.message}`)
  process.exit(run.status ?? 1)
}
// The package's `prepack` script (the build) prints its own output ahead of the
// JSON array, so stdout is not pure JSON. Take the last parseable JSON array.
function parsePackJson(stdout) {
  const candidates = []
  if (stdout.trimStart().startsWith('[')) candidates.push(stdout.indexOf('['))
  for (let i = stdout.lastIndexOf('\n['); i !== -1; i = stdout.lastIndexOf('\n[', i - 1)) candidates.push(i + 1)
  for (const start of candidates) {
    try {
      return JSON.parse(stdout.slice(start))
    } catch {
      // an earlier candidate may still parse; keep looking
    }
  }
  return undefined
}

const listing = parsePackJson(run.stdout)
if (listing === undefined) {
  console.error(`npm pack --json output was not JSON.\n${run.stdout.slice(-600)}`)
  process.exit(1)
}
const first = Array.isArray(listing) ? listing[0] : listing
const shipped = new Set((first.files ?? []).map((entry) => entry.path))

const required = [
  'package.json',
  'LICENSE',
  'cordis.patch.yml',
  'README.md',
  'README.zh-CN.md',
  'lib/index.js',
  'artifacts/sjs-worker.mjs',
  'skills/spreadjs/SKILL.md',
  'docs/architecture.md',
]
const missing = required.filter((path) => !shipped.has(path))
if (missing.length > 0) {
  console.error(`tarball is missing required runtime file(s):\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

// --- what the manifest DECLARES must be what actually ships --------------------
//
// A package can ship every file it needs and still be unloadable. This check
// exists because that happened: the build produced lib/client.js, the tarball
// shipped it, the installed copy byte-matched the build — and `dsh web` still
// refused to boot, because DSH resolves a client half through
// `exports["./client"]` and the manifest had no such export. Nothing else in
// this repo looks at a declaration and its artifact together, and no test that
// drives artifacts can: composition happens in DSH, at boot.
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Every local path the manifest promises, tagged with where the promise is. */
const declared = []
const declare = (where, value) => {
  if (typeof value !== 'string' || !value.startsWith('./')) return
  declared.push({ where, path: value.slice(2) })
}
declare('main', manifest.main)
declare('dsh.bundle.patch', manifest.dsh?.bundle?.patch)
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  declare(`exports[${JSON.stringify(key)}]`, typeof target === 'string' ? target : target?.default)
}

// The one declaration with a companion requirement rather than just a target.
if (manifest.dsh?.client !== undefined && manifest.exports?.['./client'] === undefined) {
  console.error(
    'package.json declares dsh.client but has no exports["./client"].\n'
    + '  DSH resolves the client half through that export — not by any filename\n'
    + '  convention — so the plugin fails to compose and `dsh web` will not boot,\n'
    + '  even though lib/client.js is built and shipped. Mirror the shape used by\n'
    + '  @grapecity-software/dsh-spreadjs-editor.',
  )
  process.exit(1)
}

const undeclared = declared.filter(({ path }) => !shipped.has(path))
if (undeclared.length > 0) {
  console.error('tarball is missing file(s) the manifest declares:')
  for (const { where, path } of undeclared) console.error(`  ${where} -> ${path}`)
  process.exit(1)
}
// The bundled API reference is what makes "look it up, never guess" work offline.
// It is a large tree of small files, so a plain path check would only prove one
// file survived; count them instead. The floor is deliberately below the real
// count so adding or refreshing a version does not trip it.
const REFERENCE_PREFIX = 'skills/spreadjs/reference/'
const referenceFiles = [...shipped].filter((path) => path.startsWith(REFERENCE_PREFIX))
const REFERENCE_FLOOR = 800
if (referenceFiles.length < REFERENCE_FLOOR) {
  console.error(
    `the bundled API reference did not ship: ${referenceFiles.length} file(s) under ${REFERENCE_PREFIX} (expected at least ${REFERENCE_FLOOR}).\n` +
      'Check the package.json "files" list still includes "skills".',
  )
  process.exit(1)
}

const megabytes = ((first.unpackedSize ?? 0) / 1024 / 1024).toFixed(1)
console.log(
  `verify-pack: tarball ships ${shipped.size} files, incl. all ${required.length} required and ${referenceFiles.length} reference files (${megabytes} MB unpacked)`,
)
