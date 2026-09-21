// Remove this workspace's plugins from local DSH profiles.
//
//   node scripts/uninstall-local.mjs [profile ...]      (default: web)
//
// The mirror of install-local.mjs, and it exists for the same two reasons:
//
//  * `dsh plugin remove` has been observed doing its work and then not exiting,
//    so a wrapper script can be stranded mid-removal. Driving pnpm directly
//    avoids that.
//  * pnpm alone does not touch `dsh.profile.bundles`. Leaving a package name in
//    that list after the package is gone makes the profile boot look for a
//    bundle that no longer exists — the removal has to own both places.
//
// Restore afterwards with `build.bat` (or `node scripts/install-local.mjs`).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { PLUGINS } from './local-plugins.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const profiles = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['web']

function run(command, args, cwd) {
  const isWindows = process.platform === 'win32'
  const result = isWindows
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', command, ...args], { cwd, encoding: 'utf8' })
    : spawnSync(command, args, { cwd, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

let failed = false
for (const profile of profiles) {
  const dir = join(DSH_HOME, 'profiles', profile)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`\n${profile}: no profile at ${dir} — skipping`)
    continue
  }
  console.log(`\n${profile}:`)

  for (const plugin of PLUGINS) {
    const removed = run('pnpm', ['remove', plugin.name], dir)
    // "not found in dependencies" is a fine outcome for an uninstall.
    if (removed.status !== 0 && !/not.*(found|present)/i.test(removed.output)) {
      console.error(`  ${plugin.name}: pnpm remove reported a problem:\n${removed.output}`)
      failed = true
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(plugin.name)) {
      manifest.dsh.profile.bundles = bundles.filter((name) => name !== plugin.name)
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log(`  removed "${plugin.name}" from dsh.profile.bundles`)
    }

    // Report what is actually left, rather than trusting the commands above.
    const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const stillDeclared = Object.prototype.hasOwnProperty.call(after.dependencies ?? {}, plugin.name)
    const stillBundled = Array.isArray(after?.dsh?.profile?.bundles) && after.dsh.profile.bundles.includes(plugin.name)
    const stillOnDisk = existsSync(join(dir, 'node_modules', plugin.name))
    if (stillDeclared || stillBundled || stillOnDisk) {
      console.error(`  ${plugin.name}: still present — dependencies:${stillDeclared} bundles:${stillBundled} node_modules:${stillOnDisk}`)
      failed = true
    } else {
      console.log(`  ${plugin.name}: verified gone (dependencies / bundles / node_modules)`)
    }
  }

  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  console.log(`  bundles now: ${(after?.dsh?.profile?.bundles ?? []).join(', ') || '(empty)'}`)
}

console.log('')
if (failed) {
  console.error('uninstall-local: one or more plugins were not cleaned up (see above)')
  process.exit(1)
}
console.log(`done — plugins removed from: ${profiles.join(' ')}`)
console.log('restore them later with build.bat, or: node scripts/install-local.mjs')
