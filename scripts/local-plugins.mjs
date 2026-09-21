// Shared registry of the packages this workspace installs into local DSH profiles.
//
// Two kinds of entry:
//   - `repo`     built and packed from that sibling repo on every install.
//   - `registry` published package, pinned to a version, no local source.
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
    name: 'dsh-plugin-spreadjs-driver',
    // The repo directory keeps its original name: it is a local path, not the
    // package identity, and renaming it would break every script that reaches
    // for it (this file, the .bat wrappers, anyone's shell history).
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
  {
    // Not ours, and not optional in practice: this is what mounts the sidebar
    // that the editor registers its file viewer into. Without it the editor's
    // `ctx.inject(['betterSidebar'])` never fires, so there is no sidebar and no
    // way to open a workbook in the designer at all.
    //
    // Pinned, never floating. `@linxin666/dsh-web-all` raises its own
    // `dsh.engines.dsh` floor between releases — it moved to `>= 0.1.5-rc.1` at
    // 0.3.20 — so an unpinned install would one day pull a version this DSH
    // cannot run and silently break the web profile. The pin records the newest
    // release whose engine range the installed DSH actually satisfies.
    //
    // 0.3.23 is that release for DSH 0.1.5-rc.2 (every 0.3.20-0.3.23 requires
    // >= 0.1.5-rc.1). Raising this pin means re-checking the engine range first,
    // and raising DSH if the new floor demands it.
    name: '@linxin666/dsh-web-all',
    registry: '0.3.23',
    profiles: ['web'],
    verify: [],
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
