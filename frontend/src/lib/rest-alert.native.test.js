// The Capacitor side of the rest alert (#296). The iOS app has no RestAlert plugin, and the
// listener this file adds at startup used to reject there with nothing to catch it. On Android
// the plugin is a Capacitor proxy that answers `then` with a native call that never settles, so
// it must never become the value of a promise (the Coach hang, #42): here that would hang every
// rest alert call.
//
// The Live Activity's *binding* half — the listener, `bind()`, and the re-bind on every return to
// the front — is lib/rest-activity.test.js, which is the module that owns it and needs a DOM for it.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE', '1')   // lib/mobile.js: MOBILE = import.meta.env.VITE_MOBILE === '1'
  const store = new Map()
  vi.stubGlobal('localStorage', { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), clear: () => store.clear() })
  return { platform: 'android', calls: [], registerPlugin: null, perm: 'granted', request: null, ln: [], activity: [], audio: [] }
})

// Shaped like the proxy registerPlugin() returns: every property is a native method, `then`
// included, and that one never calls back. Off Android every method rejects, as Capacitor's do
// for a plugin the platform does not have.
const pluginProxy = (name = 'RestAlert') => new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'then') return () => new Promise(() => {})
    return (...args) => {
      // The Live Activity plugin is iOS's (RestActivityPlugin.swift), so it answers there and is
      // recorded apart from h.calls — the rest of this file is about a plugin iOS does *not* have.
      if (name === 'RestActivity') {
        h.activity.push([String(prop), ...args])
        return Promise.resolve({ started: true, ended: true })
      }
      if (name === 'RestAudio') {
        h.audio.push([String(prop), ...args])
        return Promise.resolve(prop === 'play' ? { played: true } : { ready: true })
      }
      h.calls.push(String(prop))
      if (h.platform !== 'android') return Promise.reject(new Error(`"RestAlert.${String(prop)}()" is not implemented on ${h.platform}`))
      return Promise.resolve(prop === 'addListener' ? { remove: async () => {} } : undefined)
    }
  },
})

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => h.platform },
  registerPlugin: (...args) => h.registerPlugin(...args),
}))
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: h.perm }),
    requestPermissions: (...args) => (h.request ? h.request(...args) : Promise.resolve({ display: 'granted' })),
    // Kept apart from h.calls, which the plugin proxy fills: on iOS there is no plugin proxy at
    // all, and the two must not be confused for each other.
    schedule: async arg => { h.ln.push(['schedule', arg]) },
    cancel: async arg => { h.ln.push(['cancel', arg]) },
  },
}))

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) }

const unhandled = []
const onUnhandled = reason => unhandled.push(reason)

beforeEach(() => {
  vi.resetModules()
  h.calls = []
  h.registerPlugin = vi.fn(name => pluginProxy(name))
  h.perm = 'granted'
  h.request = null
  h.ln = []
  h.activity = []
  h.audio = []
  localStorage.clear()
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})
afterAll(() => {
  process.off('unhandledRejection', onUnhandled)
  vi.unstubAllEnvs()
})

describe('the rest alert in the iOS app', () => {
  // #296 on iOS: no RestAlert plugin and no countdown card to keep in step, so a rest's end is one
  // local notification. @capacitor/local-notifications already schedules those on iOS, which is
  // why this half needs no native code of its own.
  it('books the end as one local notification, and reaches for no plugin', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    const at = Date.now() + 120_000
    await expect(alert.armRestAlert(at, { totalSec: 120, title: 'Rest’s over. Next set!', countdownTitle: 'Rest', sound: true, accent: 0xFF30D158, ink: 0xFF000000 })).resolves.toBe(true)
    // The Android plugin is never reached from iOS; the Live Activity plugin is (RestActivity),
    // and the notification goes through @capacitor/local-notifications.
    expect(h.calls).toEqual([])
    expect(h.registerPlugin.mock.calls.map(c => c[0])).toEqual(['RestActivity', 'RestAudio'])
    expect(h.audio.map(x => x[0])).toEqual(['prepare'])
    expect(h.ln).toHaveLength(1)
    const [what, arg] = h.ln[0]
    expect(what).toBe('schedule')
    expect(arg.notifications).toHaveLength(1)
    expect(arg.notifications[0].title).toBe('Rest’s over. Next set!')
    // The 2:00 has nowhere else to go: Android draws a clock and a shrinking bar, a notification
    // gets one line of text.
    expect(arg.notifications[0].body).toBe('Rest · 2:00')
    expect(arg.notifications[0].schedule.at.getTime()).toBe(at)
    expect(arg.notifications[0].sound).toBe('opengym-rest-chime.wav')
    expect(arg.notifications[0].extra.openGymRestTone).toBe('chime')
    expect(unhandled).toEqual([])
  })

  it('shows the next exercise and prescription on iOS while preserving Android timer copy', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    const iosBody = 'Barbell Incline Bench Press · 60 kg × 10'
    await alert.armRestAlert(Date.now() + 90_000, {
      totalSec: 90, countdownTitle: 'Rest', iosBody, sound: true,
    })
    expect(h.ln[0][1].notifications[0].body).toBe(iosBody)
    expect(h.activity[0][1].notifyBody).toBe(iosBody)

    // The native rest button re-books from ContentState without any WebView.
    const swift = readFileSync(new URL('../../ios/App/App/RestIntents.swift', import.meta.url), 'utf8')
    expect(swift).toContain('content.body = state.notifyBody.isEmpty ? attributes.notifyBody : state.notifyBody')

    h.platform = 'android'
    expect(alert.buildRestAlert({
      at: Date.now() + 90_000, totalSec: 90, countdownTitle: 'Rest',
      iosBody, now: Date.now(),
    }).body).toBe('Rest · 1:30')
  })

  it('uses the selected bundled tone and preserves it for the Lock Screen controls', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, tone: 'bell' })
    expect(h.ln[0][1].notifications[0].sound).toBe('opengym-rest-bell.wav')
    expect(h.ln[0][1].notifications[0].extra.openGymRestTone).toBe('bell')
    expect(h.activity[0][1].notifyTone).toBe('bell')
  })

  it('uses native ducked playback when the WebView is active without notifications', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    expect(await alert.toneNative('whistle')).toBe(true)
    expect(h.audio.at(-1)).toEqual(['play', { tone: 'whistle' }])
  })

  it('keeps the page quiet while it is armed, and hands the end back when the rest comes down', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    expect(alert.nativeEndTone()).toBe(false)
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, sound: true })
    // Capacitor presents a foreground notification with its sound, so the page must not also chime.
    expect(alert.nativeEndTone()).toBe(true)
    alert.disarmRestAlert()
    await settle()
    expect(alert.nativeEndTone()).toBe(false)
    expect(h.ln.at(-1)[0]).toBe('cancel')
  })

  it('leaves the page its own chime when notifications are not allowed', async () => {
    h.platform = 'ios'
    h.perm = 'denied'
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, sound: true })
    // Nothing will sound from the system, so the page has to be the one that rings.
    expect(alert.nativeEndTone()).toBe(false)
  })

  it('starts the Live Activity even if notification permission is denied', async () => {
    h.platform = 'ios'
    h.perm = 'denied'
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, sound: true })
    expect(h.activity[0]?.[0]).toBe('start')
    expect(h.ln).toHaveLength(0)
  })

  it('with Sounds off names no sound, and the notification is silent', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, sound: false })
    expect(h.ln[0][1].notifications[0]).not.toHaveProperty('sound')
    expect(alert.nativeEndTone()).toBe(false)
  })

  it('a rest that is paused loses the notification for its old end', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, sound: true })
    expect(alert.nativeEndTone()).toBe(true)
    alert.holdRestAlert(45, 60)
    await settle()
    expect(alert.nativeEndTone()).toBe(false)
    expect(h.ln.at(-1)[0]).toBe('cancel')
    expect(h.activity.at(-1)[0]).toBe('hold')
    expect(h.activity.at(-1)[1]).toEqual({ leftMs: 45000, totalMs: 60000 })
  })

  it('the calls iOS has no answer to are still quiet no-ops', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    alert.setRestAccent('red')
    alert.buzzAsAlarm([200, 100, 200])
    await settle()
    expect(h.registerPlugin).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
    expect(unhandled).toEqual([])
  })

  // #296 on iOS: the countdown itself, on the lock screen and in the Dynamic Island. The widget
  // (ios/App/AppWidgets/RestWidgetBundle.swift) draws what this hands over and computes nothing.
  it('puts the countdown on the lock screen over the rest’s own span', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    const at = Date.now() + 120_000
    await alert.armRestAlert(at, { totalSec: 120, title: 'Rest’s over. Next set!', countdownTitle: 'Rest', sound: true, accent: 0xFF30D158, ink: 0xFF000000 })
    expect(h.activity).toHaveLength(1)
    const [what, args] = h.activity[0]
    expect(what).toBe('start')
    // The translated strings travel with it: the widget has no i18n of its own to reach.
    expect(args.countdownTitle).toBe('Rest')
    // buildRestAlert carries the accent as ARGB for the Android notification; the widget parses hex.
    expect(args.accentHex).toBe('#30d158')
    // A range the system's own clock and progress view count down across, so the card keeps
    // ticking while the app is suspended.
    expect(args.state.endsAt).toBe(at)
    expect(args.state.startAt).toBe(at - 120_000)
    expect(args.state.totalMs).toBe(120_000)
    expect(args.state.phase).toBe('rest')
  })

  it('takes the card down with the notification when the rest is skipped', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, sound: true, accent: 0xFF30D158, ink: 0xFF000000 })
    expect(h.activity).toHaveLength(1)
    alert.disarmRestAlert()
    await settle()
    expect(h.activity.at(-1)[0]).toBe('clearRest')
  })

  // The card's own buttons (ios/App/App/RestIntents.swift) are drawn by the widget and performed by
  // the app's process, so neither of them can ask the page what a button says or what the
  // notification it has to re-book should read. Everything they need travels with the activity.
  it('hands the card the words its buttons and its notification need', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 120_000, { totalSec: 120, title: 'Rest’s over. Next set!', countdownTitle: 'Rest', sound: true, accent: 0xFF30D158, ink: 0xFF000000 })
    const args = h.activity[0][1]
    // The four buttons, from the same translations Android's notification actions use.
    expect(args.pauseLabel).toBe('Pause')
    expect(args.resumeLabel).toBe('Resume')
    expect(args.minusLabel).toBe('− 15s')
    expect(args.plusLabel).toBe('+ 15s')
    expect(args.skipLabel).toBe('Skip')
    // And the notification itself, verbatim — one line of text, the same one
    // @capacitor/local-notifications was handed above.
    expect(args.notifyTitle).toBe('Rest’s over. Next set!')
    expect(args.notifyBody).toBe('Rest · 2:00')
    expect(args.notifyBody).toBe(h.ln[0][1].notifications[0].body)
    expect(args.notifySound).toBe(true)
    // Settings → Sound off: an iOS notification with no sound named is silent, and a button that
    // re-books it must not put a sound back.
    h.activity = []
    h.ln = []
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, sound: false, accent: 0xFF30D158, ink: 0xFF000000 })
    expect(h.activity[0][1].notifySound).toBe(false)
  })
})

describe('the rest alert in the Android app', () => {
  it('reaches the plugin without ever waiting on the proxy, and registers it once', async () => {
    h.platform = 'android'
    const alert = await import('./rest-alert.js')
    await expect(alert.armRestAlert(Date.now() + 90_000, { totalSec: 90 })).resolves.toBe(true)
    alert.holdRestAlert(60, 90)
    alert.setRestAccent('red')
    alert.disarmRestAlert()
    await settle()
    expect(h.registerPlugin).toHaveBeenCalledTimes(1)
    expect(h.calls).toContain('addListener')
    expect(h.calls.filter(c => c !== 'addListener')).toEqual(['schedule', 'hold', 'setAccent', 'cancel'])
    expect(unhandled).toEqual([])
  })

  it('passes what the notification needs: the end, the whole rest, the labels and the accent', async () => {
    h.platform = 'android'
    const schedule = vi.fn(async () => {})
    h.registerPlugin = vi.fn(() => new Proxy({}, {
      get: (_, prop) => prop === 'then' ? () => new Promise(() => {}) : prop === 'schedule' ? schedule : async () => ({ remove: async () => {} }),
    }))
    const alert = await import('./rest-alert.js')
    const at = Date.now() + 90_000
    await alert.armRestAlert(at, { totalSec: 90, accent: 'red', sound: false })
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({
      at, totalMs: 90_000, sound: false, title: 'Rest’s over. Next set!', pause: 'Pause', resume: 'Resume', skip: 'Skip',
      accent: (0xff000000 | 0xff453a) >>> 0, ink: 0xffffffff,
    }))
  })

  // Settings → Vibrate off, with the phone locked: the notification still buzzed the whole
  // pattern, and so did the stand-in buzz where notifications are off, because neither was told.
  it('tells the plugin whether the end may buzz, on a channel that matches', async () => {
    h.platform = 'android'
    const schedule = vi.fn(async () => {})
    h.registerPlugin = vi.fn(() => new Proxy({}, {
      get: (_, prop) => prop === 'then' ? () => new Promise(() => {}) : prop === 'schedule' ? schedule : async () => ({ remove: async () => {} }),
    }))
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 90_000, { totalSec: 90 })
    expect(schedule).toHaveBeenLastCalledWith(expect.objectContaining({ vibrate: true, channelId: 'rest-over' }))
    await alert.armRestAlert(Date.now() + 90_000, { totalSec: 90, vibrate: false })
    expect(schedule).toHaveBeenLastCalledWith(expect.objectContaining({ vibrate: false, channelId: 'rest-over-quiet' }))
  })
})

// #375: "Vibrate when the phone is on silent".
describe('the alarm buzz in the Android app', () => {
  const capture = () => {
    const calls = {}
    h.registerPlugin = vi.fn(() => new Proxy({}, {
      get: (_, prop) => {
        if (prop === 'then') return () => new Promise(() => {})
        return async (...args) => { (calls[prop] = calls[prop] || []).push(args[0]); return prop === 'addListener' ? { remove: async () => {} } : undefined }
      },
    }))
    return calls
  }

  it('tells the alarm to buzz as an alarm only with Vibrate on', async () => {
    h.platform = 'android'
    const calls = capture()
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 90_000, { totalSec: 90, alarmBuzz: true })
    expect(calls.schedule.at(-1)).toMatchObject({ vibrate: true, alarmBuzz: true })
    await alert.armRestAlert(Date.now() + 90_000, { totalSec: 90, vibrate: false, alarmBuzz: true })
    expect(calls.schedule.at(-1)).toMatchObject({ vibrate: false, alarmBuzz: false })
    await alert.armRestAlert(Date.now() + 90_000, { totalSec: 90 })
    expect(calls.schedule.at(-1)).toMatchObject({ alarmBuzz: false })
  })

  it('hands the plugin the end tone Settings → Sound picked', async () => {
    h.platform = 'android'
    const calls = capture()
    const alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 90_000, { totalSec: 90, sound: true })
    expect(calls.schedule.at(-1)).toMatchObject({ sound: true, classic: false })
    await alert.armRestAlert(Date.now() + 90_000, { totalSec: 90, sound: true, classic: true })
    expect(calls.schedule.at(-1)).toMatchObject({ sound: true, classic: true, tone: 'classic' })
    await alert.armRestAlert(Date.now() + 90_000, { totalSec: 90, sound: true, tone: 'whistle' })
    expect(calls.schedule.at(-1)).toMatchObject({ sound: true, classic: false, tone: 'whistle' })
  })

  it('buzzAsAlarm reaches the plugin with the pattern and answers true', async () => {
    h.platform = 'android'
    const calls = capture()
    const alert = await import('./rest-alert.js')
    await expect(alert.buzzAsAlarm([200, 100, 200])).resolves.toBe(true)
    expect(calls.buzz).toEqual([{ pattern: [200, 100, 200] }])
    await expect(alert.buzzAsAlarm([])).resolves.toBe(false)
    expect(calls.buzz).toHaveLength(1)
  })

  it('answers false in the iOS app without touching any plugin', async () => {
    h.platform = 'ios'
    const alert = await import('./rest-alert.js')
    await expect(alert.buzzAsAlarm([200, 100, 200])).resolves.toBe(false)
    expect(h.registerPlugin).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  })
})

// The native half cannot run here; what it must do with the flag is read off its source.
describe('the Android side of Vibrate off', () => {
  const src = name => readFileSync(new URL(`../../android/app/src/main/java/ch/duartesantos/opengym/${name}.java`, import.meta.url), 'utf8')
  const alert = src('RestAlert')

  it('reads the flag from the page, defaulting to on for an older page', () => {
    expect(src('RestAlertPlugin')).toMatch(/call\.getBoolean\("vibrate", Boolean\.TRUE\)/)
  })

  it('posts on a channel created without vibration, and only buzzes by hand when allowed to', () => {
    expect(alert).toMatch(/QUIET_CHANNEL_ID = "rest-over-quiet"/)
    expect(alert).toMatch(/if \(!vibrate\) return QUIET_CHANNEL_ID;/)
    expect(alert).toMatch(/channel\.enableVibration\(false\)/)
    expect(alert).toMatch(/if \(!shown && vibrate\) vibrateFallback\(ctx\);/)
    expect(alert).toMatch(/if \(vibrate\) b\.setVibrate\(VIBRATE\);/)
    expect(alert.match(/\.setVibrate\(/g)).toHaveLength(1)
  })

  it('keeps the flag for an end the countdown or a moved alarm fires', () => {
    // fireFromCountdown and updateAlarm build their own intents from the last schedule.
    expect(alert.match(/intent\.putExtra\("vibrate", lastVibrate\);/g)).toHaveLength(2)
    expect(alert).toMatch(/intent\.putExtra\("vibrate", vibrate\);/)
  })
})

describe('the Android side of the alarm buzz (#375)', () => {
  const src = name => readFileSync(new URL(`../../android/app/src/main/java/ch/duartesantos/opengym/${name}.java`, import.meta.url), 'utf8')
  const alert = src('RestAlert')
  const plugin = src('RestAlertPlugin')

  it('reads the flag from the page, off for an older page, and offers buzz()', () => {
    expect(plugin).toMatch(/call\.getBoolean\("alarmBuzz", Boolean\.FALSE\)/)
    expect(plugin).toMatch(/@PluginMethod\s+public void buzz\(PluginCall call\)/)
  })

  it('buzzes with the alarm usage, on every API level the app runs on', () => {
    expect(alert).toMatch(/VibrationAttributes\.createForUsage\(VibrationAttributes\.USAGE_ALARM\)/)
    expect(alert).toMatch(/setUsage\(AudioAttributes\.USAGE_ALARM\)/)
  })

  it('posts the notification on the quiet channel then, so the ringer-on phone buzzes once', () => {
    expect(alert).toMatch(/boolean vibrate = intent\.getBooleanExtra\("vibrate", true\) && !alarmBuzz;/)
    expect(alert).toMatch(/if \(alarmBuzz\) buzz\(ctx, VIBRATE\);/)
    expect(alert.match(/intent\.putExtra\("alarmBuzz", lastAlarmBuzz\);/g)).toHaveLength(2)
  })
})

// Fresh install, notifications not decided yet: the first rest pops the permission dialog. The
// QA left the app with the dialog open; the alarm waited behind the answer, so nothing rang, and
// once answered the schedule was refused ("at must be in the future") and blocked what followed.
describe('the notification permission never holds the rest alarm back', () => {
  const capture = () => {
    const calls = {}
    h.registerPlugin = vi.fn(() => new Proxy({}, {
      get: (_, prop) => {
        if (prop === 'then') return () => new Promise(() => {})
        return async (...args) => { (calls[prop] = calls[prop] || []).push(args[0]); return prop === 'addListener' ? { remove: async () => {} } : undefined }
      },
    }))
    return calls
  }

  it('schedules the alarm while the permission dialog is still open', async () => {
    h.platform = 'android'
    h.perm = 'prompt'
    h.request = vi.fn(() => new Promise(() => {}))   // the dialog nobody answers
    const calls = capture()
    const alert = await import('./rest-alert.js')
    await expect(alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, alarmBuzz: true })).resolves.toBe(true)
    expect(calls.schedule).toHaveLength(1)
    expect(calls.schedule[0]).toMatchObject({ alarmBuzz: true })
    alert.disarmRestAlert()
    await expect(alert.armRestAlert(Date.now() + 60_000, { totalSec: 60 })).resolves.toBe(true)
    await settle()
    expect(calls.cancel).toHaveLength(1)
    expect(calls.schedule).toHaveLength(2)
    expect(h.request).toHaveBeenCalledTimes(1)
  })

  it('skips an end that passed before its turn instead of failing and blocking the next one', async () => {
    h.platform = 'android'
    const schedule = vi.fn(async a => { if (!(a.at > Date.now())) throw new Error('at must be in the future') })
    let release
    const gate = new Promise(r => { release = r })
    h.registerPlugin = vi.fn(() => new Proxy({}, {
      get: (_, prop) => prop === 'then' ? () => new Promise(() => {})
        : prop === 'schedule' ? schedule
        : prop === 'hold' ? () => gate
        : async () => ({ remove: async () => {} }),
    }))
    const alert = await import('./rest-alert.js')
    alert.holdRestAlert(30, 60)                       // a slow bridge call ahead in the chain
    const late = alert.armRestAlert(Date.now() + 30, { totalSec: 1 })
    await new Promise(r => setTimeout(r, 60))
    release()
    await expect(late).resolves.toBe(false)
    expect(schedule).not.toHaveBeenCalled()
    await expect(alert.armRestAlert(Date.now() + 60_000, { totalSec: 60 })).resolves.toBe(true)
    expect(schedule).toHaveBeenCalledTimes(1)
  })

  it('asks once, and after a "Don\'t allow" never again, not even after a restart', async () => {
    h.platform = 'android'
    h.perm = 'prompt'
    h.request = vi.fn(async () => { h.perm = 'prompt-with-rationale'; return { display: 'denied' } })
    capture()
    let alert = await import('./rest-alert.js')
    for (let i = 0; i < 3; i++) await expect(alert.armRestAlert(Date.now() + 60_000, { totalSec: 60, alarmBuzz: true })).resolves.toBe(true)
    await settle()
    expect(h.request).toHaveBeenCalledTimes(1)
    vi.resetModules()                                 // the app is started again
    alert = await import('./rest-alert.js')
    await expect(alert.armRestAlert(Date.now() + 60_000, { totalSec: 60 })).resolves.toBe(true)
    await settle()
    expect(h.request).toHaveBeenCalledTimes(1)
  })

  // On the emulator: Home pressed with the dialog open closes it, requestPermissions answers
  // "denied", and the permission still reads 'prompt'. Nobody said no; the next launch asks.
  it('a dialog closed by leaving the app is not a "Don\'t allow": asked again next launch, not this session', async () => {
    h.platform = 'android'
    h.perm = 'prompt'
    h.request = vi.fn(async () => ({ display: 'denied' }))
    capture()
    let alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60 })
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60 })
    await settle()
    expect(h.request).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('gym_rest_notif_asked')).toBeNull()
    vi.resetModules()
    alert = await import('./rest-alert.js')
    await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60 })
    await settle()
    expect(h.request).toHaveBeenCalledTimes(2)
  })

  it('does not ask when notifications are already allowed or turned off', async () => {
    h.platform = 'android'
    h.request = vi.fn(async () => ({ display: 'granted' }))
    capture()
    for (const perm of ['granted', 'denied']) {
      vi.resetModules()
      h.perm = perm
      const alert = await import('./rest-alert.js')
      await alert.armRestAlert(Date.now() + 60_000, { totalSec: 60 })
      await settle()
    }
    expect(h.request).not.toHaveBeenCalled()
  })
})
