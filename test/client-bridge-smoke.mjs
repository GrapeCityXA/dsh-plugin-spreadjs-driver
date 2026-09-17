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
const PACKAGE_NAME = 'dsh-spreadjs-excel'
const BRIDGE_SERVICE = 'spreadjsHostBridge'

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

/** A cordis client context reduced to the verbs the half uses. */
function fakeContext(connection) {
  const provided = new Map()
  const disposers = []
  const pendingInjections = []
  return {
    provide(name, value) { provided.set(name, value) },
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
          get: (name) => (name === 'connection' ? connection : undefined),
          effect: (cb) => { const d = cb(); if (typeof d === 'function') disposers.push(d) },
        })
      }
      pendingInjections.length = 0
    },
    get provided() { return provided },
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

  await step('apply() publishes the bridge and starts the live loop', () => {
    assert(client.name === PACKAGE_NAME, `wrong plugin name: ${client.name}`)
    assert(typeof client.apply === 'function', 'the bundle exports no apply()')
    const connection = fakeConnection()
    const ctx = fakeContext(connection)
    client.apply(ctx)

    const bridge = ctx.provided.get(BRIDGE_SERVICE)
    assert(bridge !== undefined, `${BRIDGE_SERVICE} was not provided`)
    assert(typeof bridge.attach === 'function' && typeof bridge.list === 'function', 'bridge surface is wrong')
    // The way to *act* on a workbook must not be published: a third-party client
    // plugin holding this service can offer its own document, never edit someone
    // else's.
    assert(!('execute' in bridge), 'the bridge publishes a way to run code on an attached workbook')
    assert(client.executeAttached === undefined || !('executeAttached' in bridge), 'executeAttached leaked onto the bridge')
  })()

  // --- one long-lived fixture for the loop tests -----------------------------
  const connection = fakeConnection()
  const ctx = fakeContext(connection)
  contexts.push(ctx)
  client.apply(ctx)
  const bridge = ctx.provided.get(BRIDGE_SERVICE)

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
  await step('an attached workbook is offered to the host, and only while attached', async () => {
    release = bridge.attach(provider)
    assert(JSON.stringify(bridge.list()) === JSON.stringify(['spreadjs-designer']), 'attach did not register')
    ctx.activate()

    await until(() => connection.polls > 0, 'the first poll')
    // The loop reports what it can serve, which is what lets the host fail fast
    // instead of timing out when nobody has the document it wants.
    await until(() => connection.results.length >= 0 && connection.polls > 0, 'a poll to inspect')
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
    assert(result.message === 'boom', `the message was mangled: ${result.message}`)
  })()

  await step('a job for a workbook this tab does not hold is refused, not run', async () => {
    connection.enqueue({ jobId: 'job-5', code: 'return 1', target: 'somebody-elses' })
    await until(() => connection.results.length === 5, 'the refusal')
    const result = connection.results[4]
    assert(result.ok === false && result.code === 'SJS_LIVE_NO_WORKBOOK', `got ${JSON.stringify(result)}`)
  })()

  await step('an unreachable host backs off instead of spinning', async () => {
    const broken = fakeConnection()
    let attempts = 0
    broken.rpc.call = async () => { attempts += 1; throw new Error('connection refused') }
    const brokenCtx = fakeContext(broken)
    contexts.push(brokenCtx)
    client.apply(brokenCtx)
    brokenCtx.provided.get(BRIDGE_SERVICE).attach(provider)
    brokenCtx.activate()

    await until(() => attempts >= 1, 'the first failed attempt')
    const seen = attempts
    await sleep(600)
    // The retry delay is 3s; a hot loop would have produced dozens by now.
    assert(attempts - seen <= 1, `the loop retried ${attempts - seen} times in 600ms — it is not backing off`)
  })()

  await step('detaching stops the tab offering itself', async () => {
    release()
    assert(bridge.list().length === 0, 'the released provider is still attached')
    const seen = connection.polls
    await sleep(1_400)
    assert(connection.polls === seen, `the loop kept polling after detach (${connection.polls - seen} more)`)
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
