// Shared registry of the packages this workspace installs into local DSH profiles.
//
// An entry names a sibling repo that is built and packed from source on every
// install.
//
// A repo that EXISTS but cannot be packed is a hard error, never a silent
// fallback to the registry: installing the published copy while believing it is
// the local one is exactly the failure this file exists to prevent.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKSPACE = 'D:/Work/ai'

/** Where a tarball is staged (the profiles reference this directory). */
export const STAGE_DIR = WORKSPACE

export const PLUGINS = [
  {
    name: '@grapecity-software/dsh-spreadjs-driver',
    // The repo directory keeps its original name: it is a local path, not the
    // package identity, and renaming it would break every script that reaches
    // for it (this file, the .bat wrappers, anyone's shell history).
    repo: join(WORKSPACE, 'dsh-spreadjs-excel'),
    // The web profile only. The plugin itself is host-only and would run fine in
    // a headless profile, but nothing here targets one any more: the workspace
    // keeps a single profile, so there is one place to look and one to keep
    // clean.
    profiles: ['web'],
    // Byte-compared against the repo after install.
    verify: ['lib/index.js', 'artifacts/sjs-worker.mjs'],
  },
  {
    name: '@grapecity-software/dsh-spreadjs-editor',
    repo: join(WORKSPACE, 'dsh-plugin-spreadjs-editor'),
    // Web-only: its patch row injects `webServer`, and its own cordis.patch.yml
    // says a headless profile must not mount it.
    profiles: ['web'],
    verify: ['lib/index.js', 'lib/client.js'],
  },
]

/** npm's tarball filename for a package: scope stripped, slash to dash. */
export function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`
}

/** Read a repo's package.json, or undefined when the repo is absent. */
export function readManifest(repo) {
  const path = join(repo, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** True when the repo exists and its dependencies are installed. */
export function isBuildable(repo) {
  return existsSync(join(repo, 'node_modules'))
}
