// Live-workbook channel smoke: drive the host end of the transport with a fake
// connection service — no browser, no DSH boot, no agent.
//
// This covers the rules that decide whether a live call fails fast, waits, or
// lands on the right tab. Those rules are the whole reason the transport is
// shaped the way it is, and every one of them is testable from here because
// none of them need a page: the browser only ever appears as "somebody polled".
import { LiveChannel } from '../lib/index.js'

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

/**
 * A stand-in for the host connection service: records the channel it is asked
 * to host, and lets the test play the part of a browser tab by calling in.
 */
function fakeConnection() {
  let channel
  let handler
  return {
    rpc: {
      handle(name, next) {
        channel = name
        handler = next
        return async () => { handler = undefined }
      },
    },
    get channel() {
      return channel
    },
    /** Act as a tab (or the host) calling one endpoint. */
    call(endpoint, payload) {
      if (handler === undefined) throw new Error('no channel is registered')
      return handler(endpoint, payload, new AbortController().signal)
    },
  }
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
  // --- registration ---------------------------------------------------------
  await step('register() claims one absolute channel that is not the API prefix', async () => {
    const connection = fakeConnection()
    new LiveChannel().register(connection)
    assert(typeof connection.channel === 'string', 'no channel was registered')
    assert(connection.channel.startsWith('/'), `channel must be absolute: ${connection.channel}`)
    assert(connection.channel !== '/api', 'the API prefix is reserved')
    // Sharing a prefix with the editor plugin's own /spreadjs routes would make
    // each plugin depend on the web server's match order. It must not.
    assert(!connection.channel.startsWith('/spreadjs/'), `channel shadows the editor's routes: ${connection.channel}`)
  })()

  await step('a channel-less connection is refused rather than half-registered', async () => {
    await rejects(async () => { new LiveChannel().register({}) }, 'SJS_LIVE_NO_TRANSPORT')
  })()

  // --- fail-fast ------------------------------------------------------------
  await step('with no tab connected the call fails immediately, not on timeout', async () => {
    const channel = new LiveChannel()
    const started = Date.now()
    await rejects(() => channel.execute('return 1', { timeoutMs: 30_000 }), 'SJS_LIVE_NO_CLIENT')
    const elapsed = Date.now() - started
    assert(elapsed < 500, `took ${elapsed}ms — it waited for the timeout instead of failing fast`)
  })()

  await step('a target no connected tab holds is refused, and the error names what is attached', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    await connection.call('poll', { tabId: 't1', targets: ['designer-a'] })

    const error = await rejects(
      () => channel.execute('return 1', { target: 'designer-b', timeoutMs: 5_000 }),
      'SJS_LIVE_UNKNOWN_TARGET',
    )
    assert(error.message.includes('designer-a'), `error should list attached ids: ${error.message}`)
  })()

  // --- the happy path -------------------------------------------------------
  await step('a job reaches a polling tab and its result settles the caller', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    await connection.call('poll', { tabId: 't1', targets: ['designer'] })

    const call = channel.execute('return 2 + 2', { timeoutMs: 5_000 })
    const polled = await connection.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(polled.ok === true, 'poll failed')
    assert(polled.value?.code === 'return 2 + 2', `wrong code delivered: ${JSON.stringify(polled.value)}`)

    await connection.call('result', {
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
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    const polled = await connection.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(polled.ok === true && polled.value === null, `expected null, got ${JSON.stringify(polled)}`)
  })()

  await step('a targeted job goes to the tab that holds it, not to the first tab to ask', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    await connection.call('poll', { tabId: 'a', targets: ['designer-a'] })
    await connection.call('poll', { tabId: 'b', targets: ['designer-b'] })

    const call = channel.execute('return "b"', { target: 'designer-b', timeoutMs: 5_000 })

    const first = await connection.call('poll', { tabId: 'a', targets: ['designer-a'] })
    assert(first.value === null, `tab A was handed a job for another tab's workbook: ${JSON.stringify(first.value)}`)

    const second = await connection.call('poll', { tabId: 'b', targets: ['designer-b'] })
    assert(second.value?.code === 'return "b"', `tab B did not receive its job: ${JSON.stringify(second.value)}`)

    await connection.call('result', { jobId: second.value.jobId, ok: true, value: 'b' })
    assert((await call).value === 'b', 'the caller did not receive the result')
  })()

  // --- failure paths --------------------------------------------------------
  await step('a job taken by a tab that never answers times out and leaves no backlog', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    await connection.call('poll', { tabId: 't1', targets: ['designer'] })

    const call = channel.execute('return 1', { timeoutMs: 60 })
    await connection.call('poll', { tabId: 't1', targets: ['designer'] }) // taken, then abandoned
    await rejects(() => call, 'SJS_LIVE_TIMEOUT')

    const after = await connection.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(after.value === null, `the timed-out job was left in the queue: ${JSON.stringify(after.value)}`)
  })()

  await step('a failure reported by the browser surfaces its own code', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    await connection.call('poll', { tabId: 't1', targets: ['designer'] })

    const call = channel.execute('throw new Error("boom")', { timeoutMs: 5_000 })
    const polled = await connection.call('poll', { tabId: 't1', targets: ['designer'] })
    await connection.call('result', {
      jobId: polled.value.jobId,
      ok: false,
      code: 'SJS_SCRIPT_ERROR',
      message: 'boom',
    })
    const error = await rejects(() => call, 'SJS_SCRIPT_ERROR')
    assert(error.message === 'boom', `message was mangled: ${error.message}`)
  })()

  await step('cancelling the caller stops the wait', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    await connection.call('poll', { tabId: 't1', targets: ['designer'] })

    const controller = new AbortController()
    const call = channel.execute('return 1', { timeoutMs: 30_000, signal: controller.signal })
    controller.abort()
    await rejects(() => call, 'SJS_LIVE_ABORTED')

    const after = await connection.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(after.value === null, `an aborted job was left in the queue: ${JSON.stringify(after.value)}`)
  })()

  // --- wire hygiene ---------------------------------------------------------
  await step('malformed payloads are refused without throwing', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)

    for (const payload of [undefined, null, {}, { tabId: '' }, { tabId: 't', targets: 'not-an-array' }, { tabId: 't', targets: [1] }]) {
      const answer = await connection.call('poll', payload)
      assert(answer.ok === false, `accepted a malformed poll: ${JSON.stringify(payload)}`)
      assert(answer.error.code === 'SJS_LIVE_BAD_REQUEST', `wrong code for ${JSON.stringify(payload)}: ${answer.error.code}`)
    }
    const bad = await connection.call('result', { jobId: 'x' })
    assert(bad.ok === false && bad.error.code === 'SJS_LIVE_BAD_REQUEST', 'accepted a malformed result')
  })()

  await step('a result for a job nobody is waiting on is accepted silently', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    // A late or duplicated post is ordinary: the host may already have timed the
    // job out. Answering with an error would only make noise in the browser log.
    const answer = await connection.call('result', { jobId: 'never-existed', ok: true, value: null })
    assert(answer.ok === true, `a stray result was rejected: ${JSON.stringify(answer)}`)
  })()

  await step('an unknown endpoint is reported rather than ignored', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    const answer = await connection.call('nonsense', {})
    assert(answer.ok === false && answer.error.code === 'SJS_LIVE_UNKNOWN_ENDPOINT', `got ${JSON.stringify(answer)}`)
  })()

  await step('save is forwarded when set and absent when not', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    await connection.call('poll', { tabId: 't1', targets: ['designer'] })

    const keep = channel.execute('return 1', { save: false, timeoutMs: 5_000 })
    const first = await connection.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(first.value.save === false, `save:false was lost: ${JSON.stringify(first.value)}`)
    await connection.call('result', { jobId: first.value.jobId, ok: true, value: 1 })
    await keep

    const save = channel.execute('return 1', { timeoutMs: 5_000 })
    const second = await connection.call('poll', { tabId: 't1', targets: ['designer'] })
    assert(!('save' in second.value), `save should be absent when unset: ${JSON.stringify(second.value)}`)
    await connection.call('result', { jobId: second.value.jobId, ok: true, value: 1 })
    await save
  })()

  await step('attached() reports the union of what live tabs offer', async () => {
    const connection = fakeConnection()
    const channel = new LiveChannel()
    channel.register(connection)
    assert(channel.connected === false, 'a fresh channel claims a connection')
    await connection.call('poll', { tabId: 'a', targets: ['one', 'two'] })
    await connection.call('poll', { tabId: 'b', targets: ['two', 'three'] })
    assert(channel.connected === true, 'a polling tab was not counted')
    const ids = [...channel.attached()].sort()
    assert(JSON.stringify(ids) === JSON.stringify(['one', 'three', 'two']), `got ${JSON.stringify(ids)}`)
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
