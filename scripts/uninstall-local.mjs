// Remove the plugin from one or more local DSH profiles.
//
//   node scripts/uninstall-local.mjs [profile ...]      (default: sjs web)
//
// The mirror of install-local.mjs, and it exists for the same two reasons:
//
//  * `dsh plugin remove` has been observed doing its work and then not exiting,
//    so a wrapper script can be stranded mid-removal. Driving pnpm directly
//    avoids that.
//  * pnpm alone does not touch `dsh.profile.bundles`. Leaving the package name
//    in that list after the package is gone makes the profile boot look for a
//    bundle that no longer exists — the removal has to own both places.
//
// Restore afterwards with `build.bat` (or `node scripts/install-local.mjs`).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const PACKAGE_NAME = 'dsh-spreadjs-excel'
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

let failed = false
for (const profile of PROFILES) {
  const dir = join(DSH_HOME, 'profiles', profile)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`\n${profile}: no profile at ${dir} — skipping`)
    continue
  }
  console.log(`\n${profile}:`)

  const removed = run('pnpm', ['remove', PACKAGE_NAME], dir)
  // "not found in dependencies" is a fine outcome for an uninstall.
  if (removed.status !== 0 && !/not.*(found|present)/i.test(removed.output)) {
    console.error(`  pnpm remove reported a problem:\n${removed.output}`)
    failed = true
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`  removed "${PACKAGE_NAME}" from dsh.profile.bundles`)
  }

  // Report what is actually left, rather than trusting the commands above.
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const stillDeclared = Object.prototype.hasOwnProperty.call(after.dependencies ?? {}, PACKAGE_NAME)
  const stillBundled = Array.isArray(after?.dsh?.profile?.bundles) && after.dsh.profile.bundles.includes(PACKAGE_NAME)
  const stillOnDisk = existsSync(join(dir, 'node_modules', PACKAGE_NAME))

  if (stillDeclared || stillBundled || stillOnDisk) {
    console.error(`  still present — dependencies:${stillDeclared} bundles:${stillBundled} node_modules:${stillOnDisk}`)
    failed = true
  } else {
    console.log('  verified: not in dependencies, not in bundles, not on disk')
    console.log(`  bundles now: ${(after?.dsh?.profile?.bundles ?? []).join(', ') || '(empty)'}`)
  }
}

console.log('')
if (failed) {
  console.error('uninstall-local: one or more profiles were not cleaned up (see above)')
  process.exit(1)
}
console.log(`done — plugin removed from: ${PROFILES.join(' ')}`)
console.log('restore it later with build.bat, or: node scripts/install-local.mjs')
