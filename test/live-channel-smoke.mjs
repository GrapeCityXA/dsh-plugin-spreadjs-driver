// Live-workbook channel smoke: drive the host end of the transport through the
// route it actually mounts — no browser, no DSH boot, no agent.
//
// Every call below goes in as a real `client-request` envelope on a real request
// and comes back out as a real `server-response`, because that translation is
// where this channel was broken: it used to be produced by
// `connection.rpc.handle`, which cannot work from a third-party plugin, and the
// browser's polls were answered by the SPA fallback with 405 while every test
// here passed. A fake that calls the dispatcher directly would pass that way
// again. The envelopes are the point.
import { Readable } from 'node:stream'
import { LiveChannel } from '../lib/index.js'

const CHANNEL = '/spreadjs-live'

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/** One request, in the shape node's `http` server hands a route handler. */
function request({ method = 'POST', path, body, headers = {} }) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')])
  return Object.assign(stream, {
    method,
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** One response, capturing what the handler wrote. */
function response() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body ?? '' },
  }
}

/**
 * A stand-in for the host services the channel mounts on.
 *
 * `webServer` refuses a second route on the same prefix exactly as the real one
 * does, so "the route could not be registered" is reproducible from here rather
 * than only in the field.
 */
function fakeHost({ reject } = {}) {
  let route
  let rpcId = 0
  const host = {
    webServer: {
      register(next) {
        if (route !== undefined) throw new Error(`webserver: duplicate prefix route "${next.path}"`)
        route = next
        return () => { route = undefined }
      },
    },
    /** DSH's own Host/Origin fence plus browser cookie; `reject` plays a refusal. */
    authenticate: (req) => reject?.(req),
    get route() {
      return route
    },
    /** Act as a browser tab (or any caller) sending one RPC envelope. */
    async call(endpoint, payload) {
      if (route === undefined) throw new Error('no route is mounted')
      const id = `rpc-${++rpcId}`
      const res = response()
      await route.handler(
        request({
          path: `${CHANNEL}/${endpoint}`,
          body: { type: 'client-request', rpcId: id, method: endpoint, payload },
        }),
        res,
      )
      return { ...decode(res, id), status: res.status }
    },
    /** Send a request the protocol does not describe, and report what came back. */
    async raw(options) {
      if (route === undefined) throw new Error('no route is mounted')
      const res = response()
      await route.handler(request(options), res)
      return res
    },
  }
  return host
}

/** Decode a server-response the way the browser client does, raising on junk. */
function decode(res, expectedRpcId) {
  const body = JSON.parse(res.body)
  assert(res.status === 200, `expected 200, got ${res.status}: ${res.body}`)
  assert(body.type === 'server-response', `wrong envelope type: ${res.body}`)
  assert(body.rpcId === expectedRpcId, `rpcId was not echoed: sent ${expectedRpcId}, got ${body.rpcId}`)
  const result = body.result
  assert(typeof result === 'object' && result !== null, `no result in ${res.body}`)
  if (result.ok === true) return { ok: true, value: result.value }
  assert(typeof result.error?.code === 'string', `no error code in ${res.body}`)
  assert(typeof result.error?.message === 'string', `no error message in ${res.body}`)
  assert(typeof result.error?.details === 'object', `no error details in ${res.body}`)
  return { ok: false, error: result.error }
}

/** Assert that `run()` rejects with a specific SjsError code. */
async function rejects(run, code) {
  try {
    await run()
  } catch (error) {
    assert(
      error?.code === code,
      `expected ${code}, got ${error?.code ?? '(no code)'}: ${error?.message}`,
    )
    return error
  }
  throw new Error(`expected ${code}, but the call resolved`)
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
  // --- mounting -------------------------------------------------------------
  await step('register() mounts one absolute prefix route that is not the API prefix', async () => {
    const host = fakeHost()
    new LiveChannel().register(host)
    const route = host.route
    assert(route !== undefined, 'no route was registered')
    assert(route.kind === 'prefix', `expected a prefix route, got ${route.kind}`)
    assert(route.path.startsWith('/'), `route must be absolute: ${route.path}`)
    assert(route.path !== '/api', 'the API prefix is reserved')
    // Sharing a prefix with the editor plugin's own /spreadjs routes would make
    // each plugin depend on the web server's match order. It must not.
    assert(!route.path.startsWith('/spreadjs/'), `route shadows the editor's routes: ${route.path}`)
  })()

  await step('a host with no web server is refused rather than half-mounted', async () => {
    await rejects(async () => { new LiveChannel().register({}) }, 'SJS_LIVE_NO_TRANSPORT')
    await rejects(
      async () => { new LiveChannel().register({ webServer: {} }) },
      'SJS_LIVE_NO_TRANSPORT',
    )
  })()

  await step('a host that cannot authenticate the caller gets no route at all', async () => {
    // Serving without this check would let any local process drive the user's
    // open workbook, so it is a mount-time requirement rather than a runtime
    // hope: the channel must refuse to exist rather than exist unguarded.
    const host = fakeHost()
    delete host.authenticate
    const error = await rejects(async () => { new LiveChannel().register(host) }, 'SJS_LIVE_NO_TRANSPORT')
    assert(error.message.includes('authentication'), `the reason should name it: ${error.message}`)
    assert(host.route === undefined, 'a route was registered anyway')
  })()

  await step('a route the web server refuses is reported, not thrown away', async () => {
    const host = fakeHost()
    host.webServer.register = () => { throw new Error('webserver: duplicate prefix route "/spreadjs-live"') }
    const channel = new LiveChannel()
    const refused = await rejects(async () => { channel.register(host) }, 'SJS_LIVE_NO_TRANSPORT')
    assert(refused.cause !== undefined, 'the web server\'s own reason was dropped')

    const error = await rejects(() => channel.execute('return 1', { timeoutMs: 30_000 }), 'SJS_LIVE_NO_TRANSPORT')
    assert(error.message.includes('duplicate'), `the reason should be kept: ${error.message}`)
  })()

  // --- fail-fast ------------------------------------------------------------
  await step('a channel that never mounted says so, instead of blaming the browser', async () => {
    // These two states leave an identical trace — no tabs — and used to give an
    // identical answer. They need opposite fixes, so they must not be conflated:
    // a field report spent ten tool calls checking a browser that was polling
    // correctly the whole time, because the real fault was here.
    const channel = new LiveChannel()
    const error = await rejects(() => channel.execute('return 1', { timeoutMs: 30_000 }), 'SJS_LIVE_NO_TRANSPORT')
    assert(
      error.message.includes('could not be mounted'),
      `the reason should be stated: ${error.message}`,
    )
  })()

  await step('with a mounted route but no tab, the call fails immediately, not on timeout', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    const started = Date.now()
    await rejects(() => channel.execute('return 1', { timeoutMs: 30_000 }), 'SJS_LIVE_NO_CLIENT')
    const elapsed = Date.now() - started
    assert(elapsed < 500, `took ${elapsed}ms — it waited for the timeout instead of failing fast`)
  })()

  await step('a target no connected tab holds is refused, and the error names what is attached', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    await host.call('poll', { tabId: 't1', targets: ['designer-a'] })

    const error = await rejects(
      () => channel.execute('return 1', { target: 'designer-b', timeoutMs: 5_000 }),
      'SJS_LIVE_UNKNOWN_TARGET',
    )
    assert(error.message.includes('designer-a'), `error should list attached ids: ${error.message}`)
  })()

  // --- the happy path -------------------------------------------------------
  await step('a job reaches a polling tab and its result settles the caller', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    await host.call('poll', { tabId: 't1', targets: ['designer'] })

    const call = channel.execute('return 2 + 2', { timeoutMs: 5_000 })
    const polled = await host.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(polled.ok === true, 'poll failed')
    assert(polled.value?.code === 'return 2 + 2', `wrong code delivered: ${JSON.stringify(polled.value)}`)

    await host.call('result', {
      jobId: polled.value.jobId,
      ok: true,
      value: 4,
      file: 'C:/work/book.ssjson',
    })
    const execution = await call
    assert(execution.value === 4, `wrong value: ${JSON.stringify(execution)}`)
    assert(execution.file === 'C:/work/book.ssjson', `file was dropped: ${JSON.stringify(execution)}`)
  })()

  await step('a poll with nothing queued answers null rather than holding', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    const polled = await host.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(polled.ok === true && polled.value === null, `expected null, got ${JSON.stringify(polled)}`)
  })()

  await step('a targeted job goes to the tab that holds it, not to the first tab to ask', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    await host.call('poll', { tabId: 'a', targets: ['designer-a'] })
    await host.call('poll', { tabId: 'b', targets: ['designer-b'] })

    const call = channel.execute('return "b"', { target: 'designer-b', timeoutMs: 5_000 })

    const first = await host.call('poll', { tabId: 'a', targets: ['designer-a'] })
    assert(first.value === null, `tab A was handed a job for another tab's workbook: ${JSON.stringify(first.value)}`)

    const second = await host.call('poll', { tabId: 'b', targets: ['designer-b'] })
    assert(second.value?.code === 'return "b"', `tab B did not receive its job: ${JSON.stringify(second.value)}`)

    await host.call('result', { jobId: second.value.jobId, ok: true, value: 'b' })
    assert((await call).value === 'b', 'the caller did not receive the result')
  })()

  // --- failure paths --------------------------------------------------------
  await step('a job taken by a tab that never answers times out and leaves no backlog', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    await host.call('poll', { tabId: 't1', targets: ['designer'] })

    const call = channel.execute('return 1', { timeoutMs: 60 })
    await host.call('poll', { tabId: 't1', targets: ['designer'] }) // taken, then abandoned
    await rejects(() => call, 'SJS_LIVE_TIMEOUT')

    const after = await host.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(after.value === null, `the timed-out job was left in the queue: ${JSON.stringify(after.value)}`)
  })()

  await step('a failure reported by the browser surfaces its own code', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    await host.call('poll', { tabId: 't1', targets: ['designer'] })

    const call = channel.execute('throw new Error("boom")', { timeoutMs: 5_000 })
    const polled = await host.call('poll', { tabId: 't1', targets: ['designer'] })
    await host.call('result', {
      jobId: polled.value.jobId,
      ok: false,
      code: 'SJS_SCRIPT_ERROR',
      message: 'boom',
    })
    const error = await rejects(() => call, 'SJS_SCRIPT_ERROR')
    assert(error.message === 'boom', `message was mangled: ${error.message}`)
  })()

  await step('cancelling the caller stops the wait', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    await host.call('poll', { tabId: 't1', targets: ['designer'] })

    const controller = new AbortController()
    const call = channel.execute('return 1', { timeoutMs: 30_000, signal: controller.signal })
    controller.abort()
    await rejects(() => call, 'SJS_LIVE_ABORTED')

    const after = await host.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(after.value === null, `an aborted job was left in the queue: ${JSON.stringify(after.value)}`)
  })()

  // --- wire hygiene ---------------------------------------------------------
  await step('malformed payloads are refused without throwing', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)

    for (const payload of [undefined, null, {}, { tabId: '' }, { tabId: 't', targets: 'not-an-array' }, { tabId: 't', targets: [1] }]) {
      const answer = await host.call('poll', payload)
      assert(answer.ok === false, `accepted a malformed poll: ${JSON.stringify(payload)}`)
      assert(answer.error.code === 'SJS_LIVE_BAD_REQUEST', `wrong code for ${JSON.stringify(payload)}: ${answer.error.code}`)
    }
    const bad = await host.call('result', { jobId: 'x' })
    assert(bad.ok === false && bad.error.code === 'SJS_LIVE_BAD_REQUEST', 'accepted a malformed result')
  })()

  await step('a result for a job nobody is waiting on is accepted silently', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    // A late or duplicated post is ordinary: the host may already have timed the
    // job out. Answering with an error would only make noise in the browser log.
    const answer = await host.call('result', { jobId: 'never-existed', ok: true, value: null })
    assert(answer.ok === true, `a stray result was rejected: ${JSON.stringify(answer)}`)
  })()

  await step('an unknown endpoint is reported rather than ignored', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    const answer = await host.call('nonsense', {})
    assert(answer.ok === false && answer.error.code === 'SJS_LIVE_UNKNOWN_ENDPOINT', `got ${JSON.stringify(answer)}`)
  })()

  await step('save is forwarded when set and absent when not', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    await host.call('poll', { tabId: 't1', targets: ['designer'] })

    const keep = channel.execute('return 1', { save: false, timeoutMs: 5_000 })
    const first = await host.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(first.value.save === false, `save:false was lost: ${JSON.stringify(first.value)}`)
    await host.call('result', { jobId: first.value.jobId, ok: true, value: 1 })
    await keep

    const save = channel.execute('return 1', { timeoutMs: 5_000 })
    const second = await host.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(!('save' in second.value), `save should be absent when unset: ${JSON.stringify(second.value)}`)
    await host.call('result', { jobId: second.value.jobId, ok: true, value: 1 })
    await save
  })()

  await step('attached() reports the union of what live tabs offer', async () => {
    const host = fakeHost()
    const channel = new LiveChannel()
    channel.register(host)
    assert(channel.connected === false, 'a fresh channel claims a connection')
    await host.call('poll', { tabId: 'a', targets: ['one', 'two'] })
    await host.call('poll', { tabId: 'b', targets: ['two', 'three'] })
    assert(channel.connected === true, 'a polling tab was not counted')
    const ids = [...channel.attached()].sort()
    assert(JSON.stringify(ids) === JSON.stringify(['one', 'three', 'two']), `got ${JSON.stringify(ids)}`)
  })()

  // --- what the browser can reach ------------------------------------------
  await step('a request DSH would not serve is refused, and nothing runs', async () => {
    const host = fakeHost({ reject: () => 401 })
    const channel = new LiveChannel()
    channel.register(host)

    const res = await host.raw({
      path: `${CHANNEL}/poll`,
      body: { type: 'client-request', rpcId: 'r1', method: 'poll', payload: { tabId: 't', targets: ['designer'] } },
    })
    assert(res.status === 401, `expected 401, got ${res.status}`)
    assert(channel.connected === false, 'an unauthenticated poll was served')
  })()

  await step('a GET does not reach the handler', async () => {
    const host = fakeHost()
    new LiveChannel().register(host)
    const res = await host.raw({ method: 'GET', path: `${CHANNEL}/poll`, body: undefined })
    assert(res.status === 404, `expected 404, got ${res.status}`)
    assert(res.body === 'not found', `expected a not-found body, got ${JSON.stringify(res.body)}`)
  })()

  await step('only JSON is spoken, and only in the documented envelope', async () => {
    const host = fakeHost()
    new LiveChannel().register(host)

    const wrongType = await host.raw({
      path: `${CHANNEL}/poll`,
      body: { type: 'client-request', rpcId: 'r1', method: 'poll', payload: {} },
      headers: { 'content-type': 'text/plain' },
    })
    assert(wrongType.status === 415, `expected 415, got ${wrongType.status}`)

    const notJson = await host.raw({ path: `${CHANNEL}/poll`, body: undefined })
    assert(notJson.status === 400, `expected 400, got ${notJson.status}`)

    const wrongMethod = await host.raw({
      path: `${CHANNEL}/poll`,
      body: { type: 'client-request', rpcId: 'r7', method: 'result', payload: {} },
    })
    // 200 carrying a failed result, not an error status: the browser reads a
    // non-2xx as "the transport is down" and backs off, which would turn a
    // protocol mistake into a connection outage.
    assert(wrongMethod.status === 200, `expected 200, got ${wrongMethod.status}`)
    const result = decode(wrongMethod, 'r7')
    assert(result.ok === false && result.error.code === 'gateway/bad-request', `got ${wrongMethod.body}`)

    const malformed = await host.raw({ path: `${CHANNEL}/poll`, body: { nope: true } })
    assert(malformed.status === 200, `expected 200, got ${malformed.status}`)
    assert(decode(malformed, 'invalid-request').ok === false, 'a malformed envelope was accepted')

    // A path that names no endpoint is not an endpoint. `%2F` survives URL
    // parsing as a literal, so a segment wearing one is not a path segment.
    for (const path of [`${CHANNEL}/`, `${CHANNEL}/poll%2Fextra`]) {
      const res = await host.raw({ path, body: undefined })
      assert(res.status === 404, `${path} should be 404, got ${res.status}`)
    }
  })()

  if (failures > 0) {
    console.error(`\nlive-channel-smoke: ${failures} failing step(s)`)
    process.exitCode = 1
  } else {
    console.log('live-channel-smoke: all steps passed')
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
