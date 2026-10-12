// @vitest-environment happy-dom
// The Live Activity's binding half (#296 on iOS): the card's own buttons are performed by the app's
// process (ios/App/App/RestIntents.swift), which queues them when there is no page to hand them to.
// This is the other end of that queue, and the two rules it has to hold:
//
//  1. The listener is registered *before* `bind()` asks for anything — the plugin only hands a press
//     over when it knows somebody is listening (RestActivityPlugin.handOverIfLive), so a bind that
//     arrived first would collect the press and drop it into a page with no handler.
//  2. It asks again on every return to the front. That is the whole mechanism by which a press made
//     while the phone was locked ever reaches the app's own timer.
//
// Each module load gets its own plugin proxy, so a test reads only its own calls: happy-dom's
// `document` outlives vi.resetModules(), so the visibility listener an earlier test registered is
// still on it and fires too.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE', '1')
  return { platform: 'ios', instances: [], fail: false }
})

// Shaped like the Capacitor proxy: every property is a native method, and `then` is one of them
// (a promise resolved with the bare proxy never settles — the Coach hang, #42). `fail` is the shell
// whose native side predates the plugin: there every method rejects, as Capacitor's do for a plugin
// a platform does not have.
const proxyFor = calls => new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'then') return () => new Promise(() => {})
    return (...args) => {
      calls.push([String(prop), ...args])
      if (h.fail) return Promise.reject(new Error(`"RestActivity.${String(prop)}()" is not implemented`))
      return Promise.resolve(prop === 'addListener' ? { remove: async () => {} } : { bound: true })
    }
  },
})

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => h.platform },
  registerPlugin: () => {
    const calls = []
    h.instances.push(calls)
    return proxyFor(calls)
  },
}))

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) }
/** What this test's own module did, and nothing an earlier test's leftover listener did. */
const mine = () => h.instances.at(-1) || []
const names = () => mine().map(c => c[0])

beforeEach(() => {
  vi.resetModules()
  h.instances = []
  h.platform = 'ios'
  h.fail = false
})

afterAll(() => vi.unstubAllEnvs())

describe('the rest card’s buttons reaching the page', () => {
  it('listens first, then says it is listening', async () => {
    const { bindRestActivity } = await import('./rest-activity.js')
    bindRestActivity(() => {})
    await settle()
    const listener = mine().find(c => c[0] === 'addListener')
    expect(listener?.[1]).toBe('rest')
    expect(typeof listener?.[2]).toBe('function')
    expect(names().filter(m => m === 'addListener' || m === 'bind')).toEqual(['addListener', 'bind'])
  })

  it('hands every press to the handler, in the shape the app’s own timer reads', async () => {
    const { bindRestActivity } = await import('./rest-activity.js')
    const seen = []
    bindRestActivity(ev => seen.push(ev))
    await settle()
    const listener = mine().find(c => c[0] === 'addListener')
    const command = { type: 'pause', leftMs: 60_000, totalMs: 90_000, endsAt: 0, paused: true, live: false }
    listener[2](command)
    expect(seen).toEqual([command])
  })

  // A press made while the phone was locked waits in the app (RestBridge in RestIntents.swift) and
  // is collected on the way back up. One bind at startup is not enough: the app has been in the
  // background since, and the press is still sitting there.
  it('asks again whenever the app comes back to the front', async () => {
    const { bindRestActivity } = await import('./rest-activity.js')
    bindRestActivity(() => {})
    await settle()
    expect(names().filter(m => m === 'bind')).toHaveLength(1)
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(names().filter(m => m === 'bind')).toHaveLength(2)
  })

  it('registers one listener and one startup bind however many times it is called', async () => {
    const { bindRestActivity } = await import('./rest-activity.js')
    bindRestActivity(() => {})
    bindRestActivity(() => {})
    await settle()
    expect(names().filter(m => m === 'bind')).toHaveLength(1)
  })

  // Android has no ActivityKit: its countdown card is the RestAlert plugin's own, and its buttons
  // arrive through that plugin instead (lib/rest-alert.js).
  it('reaches for nothing at all off the iOS app', async () => {
    h.platform = 'android'
    const { bindRestActivity } = await import('./rest-activity.js')
    bindRestActivity(() => {})
    await settle()
    expect(h.instances).toEqual([])
  })

  // A shell whose native side predates the plugin: the card is read-only there, and the page must
  // not take the rejection for a broken rest timer — an older build simply keeps the notification.
  it('is quiet when the plugin is not in the shell at all', async () => {
    h.fail = true
    const { bindRestActivity, endRestActivity, startRestActivity } = await import('./rest-activity.js')
    bindRestActivity(() => {})
    await settle()
    await expect(endRestActivity()).resolves.toBeUndefined()
    await expect(startRestActivity({ accent: 0, ink: 0, at: Date.now() + 60_000, totalMs: 60_000 })).resolves.toBe(false)
  })
})
