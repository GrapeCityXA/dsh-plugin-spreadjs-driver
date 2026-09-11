// Assert the packed tarball ships every runtime file a fresh install needs.
// Runs `npm pack --dry-run --json` and compares the file list against the
// required runtime set (host bundle, worker, skill, docs, patches).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
console.log(`verify-pack: tarball ships ${shipped.size} files, incl. all ${required.length} required (${first.unpackedSize ?? '?'} B unpacked)`)
