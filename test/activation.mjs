// Whether this plugin's tools EXIST follows the bridge the user chose.
//
// The pure decision is small enough to read; what this exercises is the wiring
// around it — which service is read, which events are listened to, whether
// re-evaluating churns the tool catalog, and whether the two rows (file tools,
// live tools) ever disagree. Those are the parts that fail quietly: a
// mis-subscribed event means the tools never come back after someone else is
// chosen, and nothing anywhere reports it.
//
// Drives the real `apply()` from the built bundle with a fake context. Each row
// is mounted on its own rather than through the package entry, because the
// entry's other rows construct a cordis Service and cannot run without a real
// context — see the export note in `src/host/index.ts`.
import { livePlugin, skillsPlugin, toolsPlugin, resolveConfig } from '../lib/index.js'

const OURS = '@grapecity-software/dsh-spreadjs-driver'
const OTHER = '@acme/dsh-spreadjs-bridge'
const NAMESPACE = 'spreadjs-editor'

const FILE_TOOLS = [
  'sjs_execute',
  'sjs_export',
  'sjs_import',
  'sjs_new',
  'sjs_screenshot',
  'sjs_status',
  'sjs_worktree',
]
const LIVE_TOOLS = ['sjs_live_execute', 'sjs_live_status']
const ALL = [...FILE_TOOLS, ...LIVE_TOOLS].sort()

let pass = 0
let fail = 0
function check(label, condition, detail = '') {
  if (condition) {
    pass++
    console.log(`  ok    ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

/**
 * A context with just enough cordis in it: a tool registry that records names, an
 * event bus the test can fire, and a settings service it can rewrite.
 */
function fakeHost({ bridge, withSettings = true } = {}) {
  const tools = new Map()
  const listeners = new Map()
  const pending = []
  const skillProviders = new Set()
  let chosen = bridge

  const settings = {
    get: (ns) => (ns === NAMESPACE ? (chosen === undefined ? {} : { bridge: chosen }) : undefined),
  }
  const services = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {
          tools.delete(definition.name)
        }
      },
    },
    skills: {
      // Mirrors the real service: `registerProvider` returns the disposer that
      // takes the provider back out.
      registerProvider(create) {
        const provider = create({})
        skillProviders.add(provider)
        return () => {
          skillProviders.delete(provider)
        }
      },
    },
    ...(withSettings ? { settings } : {}),
  }

  const child = () => ({
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  })

  const ctx = {
    tools: services.tools,
    skills: services.skills,
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, callback) {
      // Held rather than dropped when a dependency is missing, so a test can
      // bring the service up afterwards and see the callback run — which is how
      // cordis itself behaves, and the only way the late-arrival case below can
      // be exercised at all.
      if (names.every((name) => services[name] !== undefined)) {
        callback(child())
        return { dispose() {} }
      }
      pending.push({ names, callback })
      return { dispose() {} }
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {}
    },
    get: (name) => services[name],
  }

  const announce = (namespace) => {
    for (const listener of listeners.get('settings/document-updated') ?? []) listener(namespace, 2)
  }

  const satisfyPending = () => {
    for (const { names, callback } of pending.splice(0)) {
      if (names.every((name) => services[name] !== undefined)) callback(child())
      else pending.push({ names, callback })
    }
  }

  return {
    ctx,
    tools,
    skillProviders,
    /** Rewrite the chosen bridge, then announce it the way dsh-settings does. */
    choose(next) {
      chosen = next
      announce(NAMESPACE)
    },
    /** Announce a change to some OTHER plugin's namespace. */
    announceForeign() {
      announce('some-other-plugin')
    },
    /** Bring the settings service up after the fact, with a choice already made. */
    lateSettings(next) {
      chosen = next
      services.settings = settings
      satisfyPending()
    },
  }
}

const registered = (tools) => [...tools.keys()].sort()

/** Mount every row, the way the package entry does for a real session. */
function mountBoth(host) {
  const config = resolveConfig({})
  toolsPlugin.apply(host.ctx, config)
  livePlugin.apply(host.ctx, config)
  skillsPlugin.apply(host.ctx, config)
}

console.log('activation:')

// --- the four readings, on everything the plugin puts in front of the model ---
// The setting names the plugin that OWNS spreadsheets here, not merely whoever
// receives the live document, so every row reads it the same way. A driver that
// ships no file tools of its own therefore leaves the user without them — the
// intended trade, and the reason this asserts on all nine tools plus the skill
// rather than on the live pair alone.
{
  const host = fakeHost()
  mountBoth(host)
  check('nothing chosen → all nine present', same(registered(host.tools), ALL), registered(host.tools).join(','))
  check('nothing chosen → skill present', host.skillProviders.size === 1)
}
{
  const host = fakeHost({ bridge: '' })
  mountBoth(host)
  check('the empty string is "nothing chosen" → all nine present', same(registered(host.tools), ALL))
  check('the empty string is "nothing chosen" → skill present', host.skillProviders.size === 1)
}
{
  const host = fakeHost({ bridge: OURS })
  mountBoth(host)
  check('chosen us → all nine present', same(registered(host.tools), ALL))
  check('chosen us → skill present', host.skillProviders.size === 1)
}
{
  const host = fakeHost({ bridge: OTHER })
  mountBoth(host)
  // The whole point: two overlapping tool sets never sit side by side in the
  // model's catalog with nothing saying which goes with the choice on screen.
  check('chosen someone else → ALL NINE ABSENT', registered(host.tools).length === 0, registered(host.tools).join(','))
  // And the skill with them. It is the document that teaches the model to call
  // `sjs_*` by name; left registered, it is a manual for tools that are gone.
  check('chosen someone else → skill ABSENT', host.skillProviders.size === 0)
}

// --- the rows cannot disagree -------------------------------------------------
// Every row calls the same helper, so this is a property of the wiring rather
// than of any row's own logic — which is exactly why it is worth pinning: a row
// that stopped using the helper would still pass every check above on its own.
{
  const steps = [undefined, OURS, OTHER, '', OTHER, OURS, undefined]
  let agreed = true
  const seen = []
  for (const step of steps) {
    const host = fakeHost({ bridge: step })
    mountBoth(host)
    const names = registered(host.tools)
    // All of it or none of it — never a file tool without its live sibling, and
    // never a tool set without the skill that documents it.
    const whole = (names.length === ALL.length && host.skillProviders.size === 1) || (names.length === 0 && host.skillProviders.size === 0)
    if (!whole) agreed = false
    seen.push(`${step ?? 'none'}:${names.length}/${host.skillProviders.size}`)
  }
  check('tools and skill are always all present or all gone together', agreed, seen.join(' '))
}

// --- fail-open ----------------------------------------------------------------
{
  const host = fakeHost({ withSettings: false })
  mountBoth(host)
  // Every way of not knowing has to land here. Being absent when the user needed
  // us costs them the tools; being present with nothing to do costs a line in a
  // catalog. Registering from inside an `inject(['settings'])` callback would
  // have made this case take the tools away, which is the failure that matters.
  check('no settings service at all → all nine present', same(registered(host.tools), ALL))
  check('no settings service at all → skill present', host.skillProviders.size === 1)
}

// --- the way back -------------------------------------------------------------
{
  const host = fakeHost({ bridge: OTHER })
  mountBoth(host)
  const gone = registered(host.tools).length === 0

  host.choose('')
  const backOnEmpty = same(registered(host.tools), ALL)

  host.choose(OURS)
  const backOnUs = same(registered(host.tools), ALL)

  host.choose(OTHER)
  const offAgain = registered(host.tools).length === 0 && host.skillProviders.size === 0

  // There is no "remember to restore" step anywhere: presence is re-derived from
  // the current value on every event, so each way back works on its own.
  check('taken away, then restored by each way back', gone && backOnEmpty && backOnUs && offAgain)
}

// --- idempotence --------------------------------------------------------------
{
  const host = fakeHost({ bridge: OURS })
  mountBoth(host)
  const firstFile = host.tools.get('sjs_execute')
  const firstLive = host.tools.get('sjs_live_execute')

  // The same definition objects must survive: unregistering and re-registering
  // would remove and re-add the tools, which the agent loop reports to the model
  // as a catalog change.
  host.choose(OURS)
  host.choose(OURS)
  check(
    're-evaluating while already present touches nothing',
    host.tools.get('sjs_execute') === firstFile && host.tools.get('sjs_live_execute') === firstLive,
  )
}

// --- other plugins' settings --------------------------------------------------
{
  const host = fakeHost({ bridge: OURS })
  mountBoth(host)
  const firstFile = host.tools.get('sjs_execute')
  const firstLive = host.tools.get('sjs_live_execute')

  host.announceForeign()
  check(
    "another plugin's settings change does not disturb us",
    host.tools.get('sjs_execute') === firstFile && host.tools.get('sjs_live_execute') === firstLive,
  )
}

// --- settings arriving late ---------------------------------------------------
// A profile where the settings service comes up after this plugin must still
// honour a choice that was already made: namespace registration emits no event,
// so without the injection there is nothing to re-derive from.
{
  const host = fakeHost({ bridge: OTHER, withSettings: false })
  mountBoth(host)
  const startedPresent = same(registered(host.tools), ALL)

  host.lateSettings(OTHER)
  check(
    'a settings service that arrives late still applies the standing choice',
    startedPresent && registered(host.tools).length === 0,
    registered(host.tools).join(','),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
