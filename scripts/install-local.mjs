// Build, pack, and install the workspace's plugins into local DSH profiles.
//
//   node scripts/install-local.mjs [profile ...]        (default: every profile
//                                                        any plugin targets)
//
// Why this exists instead of `dsh plugin add`:
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
// Every local plugin is verified afterwards by byte-comparing the installed
// artifacts against the freshly built ones: "installed" and "active" are
// different claims, and only the second one matters.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { PLUGINS, STAGE_DIR, isBuildable, readManifest, tarballName } from './local-plugins.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const requested = process.argv.slice(2)

/** Run a command through cmd on Windows so `.cmd` shims resolve like a shell's. */
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

// --- 1. pack every local plugin -------------------------------------------------
/** @type {{name: string, spec: string, repo: string, verify: string[]}[]} */
const installable = []

for (const plugin of PLUGINS) {
  const manifest = readManifest(plugin.repo)
  if (manifest === undefined) {
    console.log(`${plugin.name}: no local repo at ${plugin.repo} — will install from the registry`)
    installable.push({ name: plugin.name, spec: plugin.name, repo: '', verify: [] })
    continue
  }
  if (!isBuildable(plugin.repo)) {
    fail(
      `${plugin.repo} exists but has no node_modules, so it cannot be packed.\n` +
        `  Run "pnpm install" there first.\n` +
        `  (Refusing to fall back to the published package: you would install the unmodified\n` +
        `   copy while believing it is the local one.)`,
    )
  }
  console.log(`packing ${plugin.name}@${manifest.version} from ${plugin.repo}`)
  const packed = run('npm', ['pack', '--silent'], plugin.repo)
  if (packed.status !== 0) fail(`npm pack failed in ${plugin.repo}:\n${packed.output}`)

  const built = join(plugin.repo, tarballName(plugin.name, manifest.version))
  if (!existsSync(built)) fail(`npm pack produced no ${tarballName(plugin.name, manifest.version)}`)

  const staged = join(STAGE_DIR, tarballName(plugin.name, manifest.version))
  copyFileSync(built, staged)
  rmSync(built, { force: true })
  console.log(`  staged ${staged}`)
  installable.push({ name: plugin.name, spec: `file:${staged.replace(/\\/g, '/')}`, repo: plugin.repo, verify: plugin.verify })
}

// --- 2. install into each profile -----------------------------------------------
const profiles = requested.length > 0
  ? requested
  : [...new Set(PLUGINS.flatMap((plugin) => (readManifest(plugin.repo) === undefined ? [] : plugin.profiles)))]

let failed = false
for (const profile of profiles) {
  const dir = join(DSH_HOME, 'profiles', profile)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`\n${profile}: no profile at ${dir} — skipping`)
    continue
  }
  console.log(`\n${profile}:`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    console.error(`  ${manifestPath} has no dsh.profile.bundles — cannot activate anything`)
    failed = true
    continue
  }

  for (const entry of installable) {
    const plugin = PLUGINS.find((candidate) => candidate.name === entry.name)
    if (plugin !== undefined && !plugin.profiles.includes(profile)) {
      // Still remove it, so a profile that should not carry it does not keep a stale copy.
      run('pnpm', ['remove', entry.name], dir)
      continue
    }

    // Remove first: pnpm treats an unchanged `file:` path + version as already
    // satisfied and would otherwise reinstall the stored copy instead of the new build.
    run('pnpm', ['remove', entry.name], dir)
    const added = run('pnpm', ['add', entry.spec], dir)
    if (added.status !== 0) {
      console.error(`  ${entry.name}: pnpm add failed:\n${added.output}`)
      failed = true
      continue
    }
    console.log(`  installed ${entry.name}`)

    // Installed is not the same as active: without the bundle entry the plugin
    // contributes nothing to the session.
    const current = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const currentBundles = current?.dsh?.profile?.bundles
    if (!currentBundles.includes(entry.name)) {
      currentBundles.push(entry.name)
      writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`)
      console.log(`    added "${entry.name}" to dsh.profile.bundles`)
    }

    // Byte-compare what was installed against what was just built.
    if (entry.repo === '') continue
    const installed = join(dir, 'node_modules', entry.name)
    for (const relative of entry.verify) {
      const from = readFileSync(join(entry.repo, relative))
      const target = join(installed, relative)
      const to = existsSync(target) ? readFileSync(target) : null
      if (to === null) {
        console.error(`    ${relative}: missing from the installed copy`)
        failed = true
      } else if (!from.equals(to)) {
        console.error(`    ${relative}: installed copy differs from the build — the rebuild did not land`)
        failed = true
      }
    }
    console.log('    verified: installed artifacts match the build')
  }

  // A profile that should not carry a plugin must not keep its bundle row either.
  for (const plugin of PLUGINS) {
    if (plugin.profiles.includes(profile)) continue
    const current = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const currentBundles = current?.dsh?.profile?.bundles
    if (currentBundles.includes(plugin.name)) {
      current.dsh.profile.bundles = currentBundles.filter((name) => name !== plugin.name)
      writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`)
      console.log(`  removed "${plugin.name}" from dsh.profile.bundles (not for this profile)`)
    }
  }
}

console.log('')
if (failed) fail('one or more plugins did not install cleanly (see above)')
console.log(`done — profiles up to date: ${profiles.join(' ')}`)
