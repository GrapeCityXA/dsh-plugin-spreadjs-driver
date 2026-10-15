// Exercise actual plugin activation with mutable settings and late service arrival.
import assert from 'node:assert/strict'
import { apply as applyDriver, livePlugin, skillsPlugin, resolveConfig } from '../lib/index.js'
const OURS = '@grapecity-software/dsh-spreadjs-driver'
const OTHER = '@acme/dsh-spreadjs-bridge'
const NAMESPACE = 'spreadjs-editor'
function fakeHost({ bridge, withSettings = true, foreignOnly = false, namespace = NAMESPACE } = {}) {
  const tools = new Map()
  const listeners = new Map()
  const pending = []
  const skillProviders = new Set()
  let chosen = bridge

  // DSH 0.1.7's host settings service has no per-namespace read; `describe()`
  // returns one descriptor per Loader entry, and the editor's entry is always
  // there — with its Config default when nothing is chosen. Modelled that way
  // rather than as an absent section, because "no choice" and "no editor" are
  // different states and only the second one is a missing descriptor.
  const settings = {
    describe: () =>
      foreignOnly
        ? [{ ns: 'some-other-plugin', value: { bridge: chosen ?? '' } }]
        : [{ ns: namespace, value: { bridge: chosen ?? '' } }],
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
      announce(namespace)
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


const registered = host => [...host.tools.keys()].sort()
const LIVE_TOOLS = ['sjs_live_execute', 'sjs_live_open', 'sjs_live_status']
function mount(host, options = {}) {
  const config = resolveConfig(options)
  livePlugin.apply(host.ctx, config)
  skillsPlugin.apply(host.ctx, config)
}
function expectActive(host, active) {
  assert.deepEqual(registered(host), active ? LIVE_TOOLS : [])
  assert.equal(host.skillProviders.size, active ? 1 : 0)
}
for (const bridge of [undefined, '', OURS, OTHER]) {
  const host = fakeHost({ bridge }); mount(host); expectActive(host, bridge === OURS)
}
for (const options of [{ bridge: OURS, foreignOnly: true }, { withSettings: false }]) {
  const host = fakeHost(options); mount(host); expectActive(host, false)
}
{
  const host = fakeHost({ bridge: OTHER }); mount(host)
  for (const bridge of ['', OURS, OTHER, OURS, undefined]) {
    host.choose(bridge); expectActive(host, bridge === OURS)
  }
}
{
  const host = fakeHost({ bridge: OURS }); mount(host)
  const tool = host.tools.get('sjs_live_execute')
  const skill = [...host.skillProviders][0]
  host.choose(OURS); host.choose(OURS); host.announceForeign()
  assert.equal(host.tools.get('sjs_live_execute'), tool)
  assert.equal([...host.skillProviders][0], skill)
}
for (const bridge of [OURS, OTHER]) {
  const host = fakeHost({ withSettings: false }); mount(host); expectActive(host, false)
  host.lateSettings(bridge); expectActive(host, bridge === OURS)
}
{
  const host = fakeHost({ bridge: OURS, namespace: 'acme-sheet-editor' })
  mount(host, { editorSettingsNamespace: 'acme-sheet-editor' })
  expectActive(host, true)
  host.choose(OTHER); expectActive(host, false)
  host.choose(OURS); expectActive(host, true)
  host.announceForeign(); expectActive(host, true)
}
{
  const host = fakeHost({ bridge: OURS, namespace: 'acme-sheet-editor' })
  mount(host); expectActive(host, false)
}
{
  const host = fakeHost({ bridge: OURS, namespace: 'acme-sheet-editor' })
  host.ctx.plugin = (plugin, options) => plugin.apply(host.ctx, options)
  applyDriver(host.ctx, { editorSettingsNamespace: 'acme-sheet-editor' })
  expectActive(host, true)
  host.choose(OTHER); expectActive(host, false)
}
for (const namespace of ['', 'Invalid Namespace', '../editor', 1]) {
  assert.throws(() => resolveConfig({ editorSettingsNamespace: namespace }), /valid DSH settings namespace/)
}
console.log('activation: selection, third-party editor namespaces, switching, idempotence and late settings passed')
