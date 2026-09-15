// Install the just-built plugin into one or more local DSH profiles.
//
//   node scripts/install-local.mjs [profile ...]      (default: sjs web)
//
// Why this exists instead of a batch file calling `dsh plugin`:
//
//  * `dsh plugin remove` has been observed doing its work and then not exiting,
//    which strands a wrapper script between `remove` and `add` — leaving the
//    profile with the plugin deleted and never reinstalled. Driving pnpm
//    directly removes that whole failure mode.
//  * pnpm alone does not maintain `dsh.profile.bundles`, and a package that is
//    installed but absent from `bundles` loads nothing at all: no tools, no
//    skill, and the agent silently improvises without them. This script owns
//    that list so the two can never disagree.
//
// Every profile is verified afterwards by byte-comparing the installed bundle
// and worker against the freshly built ones: "installed" and "active" are
// different claims, and only the second one matters.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_NAME = 'dsh-spreadjs-excel'
const STAGE_DIR = dirname(resolve(ROOT)) // the repo's parent, where the profile points
const PROFILES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['sjs', 'web']
const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')

/** Run a command through cmd on Windows so `.cmd` shims resolve like they do in a shell. */
function run(command, args, cwd) {
  const isWindows = process.platform === 'win32'
  const result = isWindows
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', command, ...args], { cwd, encoding: 'utf8' })
    : spawnSync(command, args, { cwd, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

function fail(message) {
  console.error(`install-local: ${message}`)
  process.exit(1)
}

// --- 1. pack and stage --------------------------------------------------------
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const tarballName = `${PACKAGE_NAME}-${version}.tgz`
console.log(`packing ${PACKAGE_NAME}@${version}`)
const packed = run('npm', ['pack', '--silent'], ROOT)
if (packed.status !== 0) fail(`npm pack failed:\n${packed.output}`)
const built = join(ROOT, tarballName)
if (!existsSync(built)) fail(`npm pack produced no ${tarballName}`)

const staged = join(STAGE_DIR, tarballName)
copyFileSync(built, staged)
unlinkSync(built)
console.log(`staged ${staged}`)

// --- 2. install into each profile --------------------------------------------
let failed = false
for (const profile of PROFILES) {
  const dir = join(DSH_HOME, 'profiles', profile)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`\n${profile}: no profile at ${dir} — skipping`)
    continue
  }
  console.log(`\n${profile}:`)

  // Remove first: pnpm treats an unchanged `file:` path + version as already
  // satisfied and would otherwise reinstall the stored copy instead of the new build.
  run('pnpm', ['remove', PACKAGE_NAME], dir)
  const added = run('pnpm', ['add', `file:${staged.replace(/\\/g, '/')}`], dir)
  if (added.status !== 0) {
    console.error(`  pnpm add failed:\n${added.output}`)
    failed = true
    continue
  }
  console.log(`  installed ${version}`)

  // Installed is not the same as active: without the bundle entry the plugin
  // contributes nothing to the session.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    console.error(`  ${manifestPath} has no dsh.profile.bundles — cannot activate the plugin`)
    failed = true
    continue
  }
  if (!bundles.includes(PACKAGE_NAME)) {
    bundles.push(PACKAGE_NAME)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`  added "${PACKAGE_NAME}" to dsh.profile.bundles`)
  } else {
    console.log('  bundle entry already present')
  }

  // Byte-compare what was installed against what was just built.
  const installed = join(dir, 'node_modules', PACKAGE_NAME)
  for (const relative of ['lib/index.js', 'artifacts/sjs-worker.mjs']) {
    const from = readFileSync(join(ROOT, relative))
    const to = existsSync(join(installed, relative)) ? readFileSync(join(installed, relative)) : null
    if (to === null) {
      console.error(`  ${relative}: missing from the installed copy`)
      failed = true
    } else if (!from.equals(to)) {
      console.error(`  ${relative}: installed copy differs from the build — the rebuild did not land`)
      failed = true
    }
  }
  if (existsSync(join(installed, 'lib/index.js'))) console.log('  verified: installed bundle matches the build')
}

console.log('')
if (failed) fail('one or more profiles did not install cleanly (see above)')
console.log(`done — profiles up to date: ${PROFILES.join(' ')}`)
