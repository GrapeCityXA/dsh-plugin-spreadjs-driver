// Browser-half smoke: load the REAL built client bundle (lib/client.js) the way
// the DSH client loader does, drive it with a fake context, connection and
// workbook, and assert that a job arriving from the host actually runs against
// the live workbook object.
//
// This is the half that cannot be reached from Node in production, so the point
// of the exercise is to shrink the part that only a browser can prove down to
// "the module loader and the real DOM are absent" — everything above that line
// (the loader contract, service publication, job routing, execution against the
// attached workbook, save semantics) is checked here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const PACKAGE_NAME = '@grapecity-software/dsh-spreadjs-driver'
// The plugin's own `name` export is deliberately the SHORT name, not the scoped
// package name — it is the cordis plugin identity, and it matches what the
// editor plugin does (`@grapecity-software/dsh-spreadjs-editor` exports
// `dsh-spreadjs-editor`). Only the client-module registration `id` is the
// package name. The two are separate claims and are asserted separately.
const PLUGIN_NAME = 'dsh-spreadjs-driver'
const BRIDGE_REGISTRY_SERVICE = 'spreadjsBridgeRegistry'

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Poll `predicate` until it holds, or fail loudly with what was awaited. */
async function until(predicate, what, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

/**
 * Evaluate the bundle exactly as the page does: install the registration facade
 * the loader provides, run the script, then materialize its factory. A require
 * call is an error — this bundle must need nothing at runtime.
 */
function loadClientBundle() {
  const source = readFileSync(BUNDLE, 'utf8')
  let registration
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(next) { registration = next },
    },
  }
  try {
    // eslint-disable-next-line no-new-func -- this is how the browser runs it
    new Function('module', 'exports', source)({ exports: {} }, {})
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert(registration !== undefined, 'the bundle registered no module factory')
  const exports = registration.factory((spec) => {
    throw new Error(`the client bundle required ${JSON.stringify(spec)} at runtime`)
  })
  return { registration, exports }
}

/** A workbook that records the paint discipline and answers the shape helpers. */
function fakeWorkbook() {
  const paint = []
  const sheet = { name: () => 'Sheet1', getValue: () => 'live' }
  return {
    paint,
    suspendPaint() { paint.push('suspend') },
    resumePaint() { paint.push('resume') },
    getSheetCount: () => 1,
    getSheet: () => sheet,
    getActiveSheet: () => sheet,
  }
}

/**
 * Stands in for the registry the EDITOR publishes. The driver registers an entry
 * into this; the editor (played by the test) decides when to hand over a
 * workbook.
 */
function fakeRegistry() {
  const entries = new Map()
  return {
    register(entry) {
      entries.set(entry.id, entry)
      return () => { entries.delete(entry.id) }
    },
    list() { return [...entries.values()] },
    subscribe() { return () => {} },
    selected() { return undefined },
    current() { return undefined },
    select() {},
    /** The entry this plugin registered — what the editor would be offered. */
    get entry() { return [...entries.values()][0] },
  }
}

/** A cordis client context reduced to the verbs the half uses. */
function fakeContext(connection, registry) {
  const disposers = []
  const pendingInjections = []
  const services = { connection, spreadjsBridgeRegistry: registry }
  return {
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject(names, callback) {
      pendingInjections.push({ names, callback })
      return { dispose() {} }
    },
    /** Fire the deferred injections, as cordis does once the services exist. */
    activate() {
      for (const { callback } of pendingInjections) {
        callback({
          get: (name) => services[name],
          effect: (cb) => { const d = cb(); if (typeof d === 'function') disposers.push(d) },
        })
      }
      pendingInjections.length = 0
    },
    get disposers() { return disposers },
  }
}

/** Stands in for the host: answers polls from a queue and records results. */
function fakeConnection() {
  const jobs = []
  const results = []
  let polls = 0
  return {
    jobs,
    results,
    get polls() { return polls },
    rpc: {
      async call(channel, endpoint, payload) {
        if (endpoint === 'poll') {
          polls += 1
          return { ok: true, value: jobs.shift() ?? null }
        }
        if (endpoint === 'result') {
          results.push(payload)
          return { ok: true, value: null }
        }
        return { ok: false, error: { code: 'UNKNOWN', message: endpoint, details: {} } }
      },
    },
    enqueue(job) { jobs.push(job) },
  }
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
  const { registration, exports: client } = loadClientBundle()

  // Every context this run creates. The live loop holds a timer open for as long
  // as it runs — correct in a page, but it also means a test that never disposes
  // one never exits. Disposing them is the last step, and asserting it works is
  // the point of that step.
  const contexts = []

  await step('the bundle registers under the package name, as the graph row requires', () => {
    assert(
      registration.id === PACKAGE_NAME,
      `ClientBundleRegistration.id must equal the package name; got ${JSON.stringify(registration.id)}`,
    )
    assert(typeof registration.factory === 'function', 'the registration carries no factory')
  })()

  await step('apply() registers an entry into the editor roster, and nothing else', () => {
    assert(client.name === PLUGIN_NAME, `wrong plugin name: ${client.name}`)
    assert(typeof client.apply === 'function', 'the bundle exports no apply()')
    const connection = fakeConnection()
    const registry = fakeRegistry()
    const ctx = fakeContext(connection, registry)
    // Registered for disposal: `activate()` also starts the live loop, and a
    // loop left running holds a timer open for the life of the process.
    contexts.push(ctx)
    client.apply(ctx)

    // Nothing happens until the editor actually exists: the entry is registered
    // when its registry arrives, which is what keeps this half optional.
    assert(registry.entry === undefined, 'the entry was registered before any roster existed')

    ctx.activate()

    const entry = registry.entry
    assert(entry !== undefined, 'no entry was registered into the roster')
    assert(entry.id === '@grapecity-software/dsh-spreadjs-driver', `wrong entry id: ${entry.id}`)
    assert(typeof entry.title === 'function' && typeof entry.title() === 'string', 'the entry has no title')
    assert(typeof entry.attach === 'function', 'the entry cannot accept a workbook')
    // The way to *act* on a workbook must not be offered to the roster: an entry
    // is an inbox, never a handle on somebody else's document.
    assert(!('execute' in entry), 'the entry publishes a way to run code on an attached workbook')
    assert(!('list' in entry), 'the entry exposes the attached roster it does not own')
    assert(client.executeAttached === undefined, 'executeAttached leaked out of the bundle')
  })()

  // --- one long-lived fixture for the loop tests -----------------------------
  const connection = fakeConnection()
  const registry = fakeRegistry()
  const ctx = fakeContext(connection, registry)
  contexts.push(ctx)
  client.apply(ctx)
  ctx.activate()
  const entry = registry.entry

  const workbook = fakeWorkbook()
  let saves = 0
  let saveShouldFail = false
  const provider = {
    id: 'spreadjs-designer',
    getWorkbook: () => workbook,
    getNamespace: () => ({ Spread: { Sheets: {} } }),
    getActivePath: () => 'C:/work/book.ssjson',
    save: async () => {
      saves += 1
      if (saveShouldFail) throw new Error('disk is full')
    },
  }

  let release
  await step('a workbook handed over by the editor makes the tab offer itself', async () => {
    // Before the editor hands anything over, the tab has nothing to offer and
    // does not poll at all — which is what keeps this half free in a page with
    // no designer open. The poll count is the observable; the driver publishes
    // no roster of what it holds.
    const idle = connection.polls

    release = entry.attach(provider)
    assert(typeof release === 'function', 'attach returned no way to release the workbook')

    await until(() => connection.polls > idle, 'the first poll')
  })()

  await step('a job runs against the LIVE workbook and its result goes back', async () => {
    connection.enqueue({ jobId: 'job-1', code: 'return sheet().name()' })
    await until(() => connection.results.length === 1, 'the first result')

    const result = connection.results[0]
    assert(result.jobId === 'job-1', `wrong job id: ${result.jobId}`)
    assert(result.ok === true, `expected success, got ${JSON.stringify(result)}`)
    assert(result.value === 'Sheet1', `the code did not run against the workbook: ${JSON.stringify(result.value)}`)
    assert(result.file === 'C:/work/book.ssjson', `the edited file was not reported: ${JSON.stringify(result)}`)
  })()

  await step('paint is suspended and always resumed around the code', () => {
    assert(
      JSON.stringify(workbook.paint) === JSON.stringify(['suspend', 'resume']),
      `paint discipline broke: ${JSON.stringify(workbook.paint)}`,
    )
  })()

  await step('the file is left untouched unless the job explicitly asks for a save', async () => {
    // The first job carried no `save`. That is the default an agent gets without
    // asking, and it is what keeps an unreviewed edit from overwriting the
    // user's file.
    assert(saves === 0, `an unattended edit wrote the file (saves=${saves})`)
    connection.enqueue({ jobId: 'job-2', code: 'return 1', save: true })
    await until(() => connection.results.length === 2, 'the saved result')
    assert(saves === 1, `save:true did not write the file (saves=${saves})`)
  })()

  await step('a save failure is reported, because the file did NOT change', async () => {
    saveShouldFail = true
    connection.enqueue({ jobId: 'job-3', code: 'return 1', save: true })
    await until(() => connection.results.length === 3, 'the failed-save result')
    const result = connection.results[2]
    assert(result.ok === false, `a failed save was reported as success: ${JSON.stringify(result)}`)
    assert(result.code === 'SJS_LIVE_SAVE_FAILED', `wrong code: ${result.code}`)
    assert(result.message.includes('disk is full'), `the cause was swallowed: ${result.message}`)
    saveShouldFail = false
  })()

  await step('code that throws comes back classified, not as a transport failure', async () => {
    connection.enqueue({ jobId: 'job-4', code: 'throw new Error("boom")' })
    await until(() => connection.results.length === 4, 'the thrown result')
    const result = connection.results[3]
    assert(result.ok === false && result.code === 'SJS_SCRIPT_ERROR', `got ${JSON.stringify(result)}`)
    // The message now carries the failing line as well; the cause must survive intact.
    assert(result.message.startsWith('boom'), `the message was mangled: ${result.message}`)
  })()

  await step('a script error names the line of the caller\'s code that raised it', async () => {
    // Without this the report can be unactionable: a failure raised inside
    // SpreadJS names a method the caller never wrote, and one real report of
    // exactly that shape cost three retries.
    const code = 'const a = 1\nconst b = 2\nthrow new Error("kara")\nconst c = 3'
    const before = connection.results.length
    connection.enqueue({ jobId: 'job-line', code })
    await until(() => connection.results.length > before, 'the located result')

    const result = connection.results[connection.results.length - 1]
    assert(result.code === 'SJS_SCRIPT_ERROR', `got ${JSON.stringify(result)}`)
    assert(result.message.includes('kara'), `the cause was lost: ${result.message}`)
    assert(result.message.includes('from your line 3'),
      `the failing line was not reported (expected "from your line 3"): ${result.message}`)
    assert(result.message.includes('throw new Error('),
      `the offending source line was not quoted: ${result.message}`)
  })()

  await step('a job for a workbook this tab does not hold is refused, not run', async () => {
    // Counted relative to the current length rather than pinned to an ordinal:
    // a step inserted above used to shift every index below it, and the failure
    // surfaced as this assertion reading someone else's result.
    const before = connection.results.length
    connection.enqueue({ jobId: 'job-5', code: 'return 1', target: 'somebody-elses' })
    await until(() => connection.results.length > before, 'the refusal')
    const result = connection.results[connection.results.length - 1]
    assert(result.ok === false && result.code === 'SJS_LIVE_NO_WORKBOOK', `got ${JSON.stringify(result)}`)
  })()

  await step('an unreachable host backs off instead of spinning', async () => {
    const broken = fakeConnection()
    let attempts = 0
    broken.rpc.call = async () => { attempts += 1; throw new Error('connection refused') }
    const brokenRegistry = fakeRegistry()
    const brokenCtx = fakeContext(broken, brokenRegistry)
    contexts.push(brokenCtx)
    client.apply(brokenCtx)
    brokenCtx.activate()
    // The editor hands a workbook over, so the loop has something to offer and
    // will actually attempt a poll.
    brokenRegistry.entry.attach(provider)

    await until(() => attempts >= 1, 'the first failed attempt')
    const seen = attempts
    await sleep(600)
    // The retry delay is 3s; a hot loop would have produced dozens by now.
    assert(attempts - seen <= 1, `the loop retried ${attempts - seen} times in 600ms — it is not backing off`)
  })()

  await step('a bridge that cannot save fails, instead of reporting a write it never made', async () => {
    // `save` is optional on the provider contract, and a third-party bridge is
    // free to omit it. Asking one for a save must then fail LOUDLY: a success
    // that wrote nothing cannot be told from a real write, which is how a field
    // report came back ok:true, "saving":true, and a file whose timestamp had
    // not moved — after which the model redid the whole task the other way.
    release()
    const cannotSave = { id: 'spreadjs-designer', getWorkbook: () => workbook, getActivePath: () => 'C:/work/book.ssjson' }
    const release2 = entry.attach(cannotSave)
    await until(() => connection.polls > 0, 'the reattached tab polling')

    const before = connection.results.length
    connection.enqueue({ jobId: 'job-no-save', code: 'return 1', save: true })
    await until(() => connection.results.length > before, 'the no-save result')

    const result = connection.results[connection.results.length - 1]
    assert(result.ok === false, `a bridge with no save reported success: ${JSON.stringify(result)}`)
    assert(result.code === 'SJS_LIVE_SAVE_FAILED', `wrong code: ${result.code}`)
    assert(/no save/.test(result.message), `the cause was not named: ${result.message}`)
    release2()
  })()

  await step('releasing the workbook stops the tab offering itself', async () => {
    const seen = connection.polls
    release()
    await sleep(1_400)
    assert(connection.polls === seen, `the loop kept polling after release (${connection.polls - seen} more)`)
  })()

  await step('disposing the plugin stops the loop and leaves nothing running', () => {
    const before = connection.polls
    for (const context of contexts) {
      for (const dispose of context.disposers) dispose()
    }
    assert(connection.polls === before, 'a poll ran while disposing')
  })()

  if (failures > 0) {
    console.error(`\nclient-bridge-smoke: ${failures} failing step(s)`)
    process.exitCode = 1
  } else {
    console.log('client-bridge-smoke: all steps passed')
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
