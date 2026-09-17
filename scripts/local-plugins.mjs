// Shared registry of the plugins this workspace installs into local DSH profiles.
//
// Every entry names a sibling repo, and each is built and packed from that repo
// on every install. When a repo is absent entirely the package is installed from
// the registry by name instead.
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
    name: 'dsh-spreadjs-excel',
    repo: join(WORKSPACE, 'dsh-spreadjs-excel'),
    // Host-only plugin: useful in the headless profile too.
    profiles: ['sjs', 'web'],
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
