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
  const manifest = plugin.repo === undefined ? undefined : readManifest(plugin.repo)
  if (manifest === undefined) {
    // Registry entry, or a local repo that is genuinely absent. A pinned version
    // is used verbatim — an unpinned name would resolve to latest, which for
    // some packages is a version this DSH cannot run.
    const spec = plugin.registry === undefined ? plugin.name : `${plugin.name}@${plugin.registry}`
    console.log(`${plugin.name}: no local source — installing ${spec} from the registry`)
    installable.push({ name: plugin.name, spec, repo: '', verify: [] })
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
  : [...new Set(PLUGINS.flatMap((plugin) => (plugin.repo === undefined || readManifest(plugin.repo) === undefined ? [] : plugin.profiles)))]

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

  // One pnpm invocation per operation, never one per plugin.
  //
  // Every pnpm call re-resolves the whole dependency graph — this profile
  // carries ~227 packages once dsh-web-all is in place — and the old
  // remove-one/add-one-per-plugin loop paid that cost once per plugin per
  // profile (10 invocations). A slow registry turns each of those resolutions
  // into a stall: metadata fetches retry with "Will retry in 1 minute", at 0%
  // CPU, and interrupting one leaves the profile half-installed.
  //
  // `--prefer-offline` takes the network out of that resolution by trusting
  // cached metadata. It is accepted by `add` and NOT by `remove` — pnpm's remove
  // exposes no offline option at all, and passing the bare flag is a hard error
  // ("Unknown option: 'prefer-offline'"). So it goes on the add, which is also
  // the expensive half: a measured remove re-resolved 11 packages, a measured
  // add re-resolved all 227.
  const PREFER_OFFLINE = '--prefer-offline'

  // Which entries this profile should carry, and which it should not. A plugin
  // that targets another profile is still removed here, so a profile that must
  // not carry it does not keep a stale copy behind.
  const wanted = []
  const unwanted = []
  for (const entry of installable) {
    const plugin = PLUGINS.find((candidate) => candidate.name === entry.name)
    const keep = plugin === undefined || plugin.profiles.includes(profile)
    ;(keep ? wanted : unwanted).push(entry)
  }

  // Remove first (all names at once): pnpm treats an unchanged `file:` path +
  // version as already satisfied and would otherwise reinstall the stored copy
  // instead of the new build.
  //
  // Only names this profile actually declares are passed. `pnpm remove` exits
  // non-zero on a dependency that is not there (ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS),
  // and a profile legitimately does not declare the plugins meant for the other
  // one — so an unfiltered batch would fail every profile that is not the union
  // of them. There is nothing to remove in that case anyway.
  const declared = new Set(Object.keys(manifest.dependencies ?? {}))
  const removing = [...unwanted, ...wanted]
    .map((entry) => entry.name)
    .filter((name) => declared.has(name))
  if (removing.length > 0) {
    const removed = run('pnpm', ['remove', ...removing], dir)
    if (removed.status !== 0) {
      console.error(`  pnpm remove failed:\n${removed.output}`)
      failed = true
      // The profile's dependency state is now unknown; adding on top of it would
      // only compound the damage.
      continue
    }
    console.log(`  removed: ${removing.join(', ')}`)
  }

  if (wanted.length > 0) {
    const added = run('pnpm', ['add', ...wanted.map((entry) => entry.spec), PREFER_OFFLINE], dir)
    if (added.status !== 0) {
      // A batched add either lands or does not; pnpm gives no per-package verdict.
      console.error(`  pnpm add failed for ${wanted.map((entry) => entry.name).join(', ')}:\n${added.output}`)
      failed = true
      continue
    }
    console.log(`  installed: ${wanted.map((entry) => entry.name).join(', ')}`)
  }

  // Installed is not the same as active: without the bundle row the plugin
  // contributes nothing to the session. Collected, then written once.
  const current = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const currentBundles = current?.dsh?.profile?.bundles
  let names = [...currentBundles]
  for (const entry of wanted) {
    if (!names.includes(entry.name)) {
      names.push(entry.name)
      console.log(`    added "${entry.name}" to dsh.profile.bundles`)
    }
  }
  // A profile that should not carry a plugin must not keep its bundle row either.
  for (const entry of unwanted) {
    if (!names.includes(entry.name)) continue
    names = names.filter((name) => name !== entry.name)
    console.log(`  removed "${entry.name}" from dsh.profile.bundles (not for this profile)`)
  }
  if (names.length !== currentBundles.length || names.some((name, index) => name !== currentBundles[index])) {
    current.dsh.profile.bundles = names
    writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`)
  }

  // Byte-compare what was installed against what was just built.
  for (const entry of wanted) {
    if (entry.repo === '') continue
    const installed = join(dir, 'node_modules', entry.name)
    let matches = true
    for (const relative of entry.verify) {
      const from = readFileSync(join(entry.repo, relative))
      const target = join(installed, relative)
      const to = existsSync(target) ? readFileSync(target) : null
      if (to === null) {
        console.error(`    ${relative}: missing from the installed copy`)
        matches = false
        failed = true
      } else if (!from.equals(to)) {
        console.error(`    ${relative}: installed copy differs from the build — the rebuild did not land`)
        matches = false
        failed = true
      }
    }
    if (matches) console.log(`    verified ${entry.name}: installed artifacts match the build`)
  }
}

console.log('')
if (failed) fail('one or more plugins did not install cleanly (see above)')
console.log(`done — profiles up to date: ${profiles.join(' ')}`)
