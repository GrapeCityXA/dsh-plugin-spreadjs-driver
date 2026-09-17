// Sandbox confinement regression.
//
// `sjs_execute` runs model-authored code inside the page. The page holds a live
// HTTP channel back to Node, so the confinement of that channel is the only
// thing standing between a prompt injection and every file the worker process
// can reach.
//
// This guards a hole that was real and shipped: the host-authorized file route
// took the path in the URL (`/fs?p=<any path>`) and was gated by a per-process
// bearer token. Sandboxed code recovered that token with
// `performance.getEntriesByType('resource')` — no fetch hijacking, no race,
// readable at any moment — and then read and wrote arbitrary paths, bypassing
// the workspace confinement of `io.*` entirely.
//
// The fix removed the page's ability to NAME a path: host-authorized files are
// reached through an opaque per-file id. So the assertion is not "the token is
// absent" — that would pass on a half-fix. It is "no route lets page code read
// a file the host did not authorize", which is checked by attacking the routes.
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = fileURLToPath(new URL('../artifacts/sjs-worker.mjs', import.meta.url))

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

function runWorker(request, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    const timer = setTimeout(() => { child.kill(); reject(new Error(`worker timed out after ${timeoutMs}ms`)) }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(out).toString('utf8').trim()
      try { resolve(JSON.parse(text)) }
      catch { reject(new Error(`worker returned non-JSON stdout (exit ${code}): ${text || '(empty)'}\n${Buffer.concat(err).toString('utf8')}`)) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

let failures = 0
const step = (name, fn) => async () => {
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL  ${name}`)
    console.error(`        ${error.message}`)
  }
}

async function run() {
  const workspace = await mkdtemp(join(tmpdir(), 'sjs-confine-ws-'))
  const book = join(workspace, 'probe.ssjson')
  const outsideDir = await mkdtemp(join(tmpdir(), 'sjs-confine-outside-'))
  const outsidePath = join(outsideDir, 'outside.txt')
  const SECRET = 'OUTSIDE-THE-WORKSPACE-b41c72'
  await writeFile(outsidePath, SECRET, 'utf8')

  try {
    const created = await runWorker({ op: 'new', targetPath: book })
    assert(created.ok === true, `could not create the fixture workbook: ${JSON.stringify(created)}`)

    // One execute, run as the sandbox would: enumerate what the page knows,
    // then try every route that could turn that into an unauthorized read.
    const attack = `
      const enc = encodeURIComponent
      const urls = performance.getEntriesByType('resource').map((e) => e.name)
      const origin = new URL(urls[0]).origin
      const blob = urls.find((u) => u.includes('/blob/'))
      const outside = ${JSON.stringify(outsidePath)}
      const secret = ${JSON.stringify(SECRET)}

      const attempt = async (label, url, init) => {
        try {
          const response = await fetch(url, init)
          const body = await response.text()
          return { label, status: response.status, leaked: body.includes(secret) }
        } catch (error) {
          return { label, status: 'threw', leaked: false }
        }
      }

      const results = []
      results.push(await attempt('legacy path-addressed route', origin + '/fs?p=' + enc(outside) + '&k=x'))
      results.push(await attempt('workspace route pointed outside', origin + '/ws?p=' + enc(outside)))
      results.push(await attempt('blob id with an appended path', origin + '/blob/' + (blob ? blob.split('/blob/')[1] : 'x') + '?p=' + enc(outside)))
      results.push(await attempt('forged blob id', origin + '/blob/' + '0'.repeat(32)))
      if (blob) results.push(await attempt('blob id as issued', blob))
      return { urlCount: urls.length, blobSeen: Boolean(blob), results }
    `

    let probe
    await step('the engine boots and the page can be driven', async () => {
      const seen = await runWorker({ op: 'execute', sourcePath: book, workspaceRoot: workspace, code: attack })
      assert(seen.ok === true, `execute failed: ${JSON.stringify(seen)}`)
      probe = seen.result
      assert(probe.urlCount > 0, 'the page reported fetching nothing at all — the probe did not run')
    })()

    await step('sandboxed io.* still refuses a path outside the workspace', async () => {
      const seen = await runWorker({
        op: 'execute',
        sourcePath: book,
        workspaceRoot: workspace,
        code: `try { return { read: await io.readText(${JSON.stringify(outsidePath)}) } }
               catch (error) { return { refused: String((error && error.code) || (error && error.message) || error) } }`,
      })
      assert(seen.ok === true, `execute failed: ${JSON.stringify(seen)}`)
      assert(seen.result?.read === undefined, `io.* returned the outside file: ${JSON.stringify(seen.result)}`)
      assert(String(seen.result?.refused).includes('workspace'), `unexpected refusal: ${JSON.stringify(seen.result)}`)
    })()

    await step('no route lets page code read a file the host did not authorize', () => {
      const leaked = probe.results.filter((result) => result.leaked === true)
      assert(
        leaked.length === 0,
        `page code read an unauthorized file via: ${leaked.map((r) => `${r.label} (HTTP ${String(r.status)})`).join(', ')}`,
      )
    })()

    await step('the path-addressed host route no longer exists', () => {
      const legacy = probe.results.find((result) => result.label === 'legacy path-addressed route')
      assert(legacy !== undefined, 'the legacy route was not probed')
      assert(
        legacy.status === 404,
        `a path-addressed host route answered HTTP ${String(legacy.status)} — the page can name paths again`,
      )
    })()

    await step('a blob id is opaque: attaching a path to one changes nothing', () => {
      assert(probe.blobSeen, 'the page never saw a blob id — the injection path may have changed')
      const bent = probe.results.find((result) => result.label === 'blob id with an appended path')
      assert(bent?.leaked === false, 'appending a path to a blob id reached another file')
    })()

    await step('a blob id is not guessable', () => {
      const forged = probe.results.find((result) => result.label === 'forged blob id')
      assert(forged !== undefined, 'the forged id was not probed')
      assert(forged.leaked === false, 'a forged blob id read a file')
      assert(forged.status === 403, `a forged blob id should be refused, got HTTP ${String(forged.status)}`)
    })()
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    await rm(outsideDir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures > 0) {
    console.error(`\nsandbox-confinement: ${failures} failing step(s)`)
    process.exitCode = 1
  } else {
    console.log('sandbox-confinement: all steps passed')
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
