// The rest countdown on the iOS lock screen and in the Dynamic Island (#296 on iOS).
//
// A Live Activity is the only way iOS shows a persistently updating card: unlike Android's ongoing
// notification there is no way to post one from the page, and unlike a notification it keeps
// ticking while the app is suspended. This file owns that plugin and the shape it is handed;
// AppWidgets draws it (ios/App/AppWidgets/RestWidgetBundle.swift).
//
// Two calls, because the app already re-books the end of a rest on every change: rest-alert.js
// starts one where it arms the notification and ends it where it cancels, so nothing here has to
// follow the clock. A Live Activity's attributes are fixed for its life, so a re-book ends the old
// card and starts a new one rather than updating it.
//
// The card's buttons are the third thing this file is for (ios/App/App/RestIntents.swift). A tap is
// performed by the *app's* process, so it can move the card and the end notification with no page
// running at all — and can be handed to the page when there is one: `bindRestActivity` registers
// what `rest-alert.js` forwards, and every command the app queued while nobody was listening comes
// back through it, in the same shape Android's notification buttons already send (useUI).
import { MOBILE } from './mobile.js'
import { t } from './i18n-core.js'

// The one phase this version sends. The widget knows "paused" and "ready" too — the card's own
// buttons reach the first, and the stale date the second (RestActivityAttributes.swift) — but
// nothing here starts an activity in either.
const PHASE_REST = 'rest'

// Wrapped in an object as everywhere else: a Capacitor plugin proxy answers `then`, so a promise
// resolved with the bare proxy never settles.
let pluginP = null
const plugin = () => pluginP || (pluginP = (async () => {
  if (!MOBILE) return null
  const { Capacitor, registerPlugin } = await import('@capacitor/core')
  // Android has no ActivityKit; there the countdown card is RestAlert's own (RestTimerService).
  if (Capacitor.getPlatform() !== 'ios') return null
  return { RestActivity: registerPlugin('RestActivity') }
})().catch(() => null))

/** buildRestAlert carries the accent as ARGB for the Android notification; the widget wants hex. */
const hex = argb => '#' + ((Number(argb) >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0')

/**
 * Put the countdown on the lock screen for `alert` (lib/rest-alert.js buildRestAlert). Resolves
 * true when a card is really up: false on anything but iOS, below iOS 16.1, and where the user has
 * Live Activities switched off — none of which is worth surfacing, since the notification is the
 * thing that actually alerts.
 */
export async function startRestActivity(alert) {
  if (!MOBILE) return false
  try {
    const p = await plugin()
    if (!p) return false
    const res = await p.RestActivity.start({
      // The translated strings, as everywhere else: the widget never invents copy, and cannot
      // reach i18n at all. The four button labels and the notification's own words are here for the
      // same reason — the card's buttons are drawn by the widget and performed by a process where
      // no JavaScript is running to be asked what they should say (RestIntents.swift).
      countdownTitle: alert.countdownTitle,
      readyLabel: t('Ready'),
      pauseLabel: alert.pause,
      resumeLabel: alert.resume,
      minusLabel: alert.minus,
      plusLabel: alert.plus,
      skipLabel: alert.skip,
      notifyTitle: alert.title,
      // Verbatim, and not rebuilt on the Swift side when a button moves the end: the words of a
      // notification belong to the app's own i18n, and a rest given another 15 s keeps the length it
      // started with on a line nobody reads while the card is counting down anyway.
      notifyBody: alert.body,
      notifySound: !!alert.sound,
      accentHex: hex(alert.accent),
      inkHex: hex(alert.ink),
      state: {
        // The rest's own span, which is what both the system clock and the system progress view
        // count down across. buildRestAlert knows the end and how long the rest is; the rest began
        // that long before it, which stays true when the time is adjusted.
        startAt: alert.at - alert.totalMs,
        endsAt: alert.at,
        totalMs: alert.totalMs,
        phase: PHASE_REST,
        leftMs: Math.max(0, alert.at - Date.now()),
      },
    })
    return !!res?.started
  } catch { return false }
}

/** Keep the Live Activity visible on Pause, with a frozen clock and Resume control. */
export async function holdRestActivity(leftSec, totalSec) {
  if (!MOBILE) return false
  try {
    const p = await plugin()
    if (!p) return false
    const res = await p.RestActivity.hold({
      leftMs: Math.max(0, leftSec) * 1000,
      totalMs: Math.max(leftSec, totalSec) * 1000,
    })
    return !!res?.held
  } catch { return false }
}

/** Return useful runtime facts for an iPhone Live Activity test in Settings. */
export async function restActivityStatus() {
  if (!MOBILE) return { supported: false, reason: 'Not a mobile build' }
  try {
    const p = await plugin()
    if (!p) return { supported: false, reason: 'Not running in the iOS app' }
    const status = await p.RestActivity.status()
    return { ...status, native: true }
  } catch (e) {
    return { supported: false, native: false, reason: String(e?.message || e) }
  }
}

/** End the rest without destroying an active workout Live Activity. */
export async function endRestActivity() {
  if (!MOBILE) return
  try {
    const p = await plugin()
    if (p) await p.RestActivity.clearRest()
  } catch { /* nothing on screen to take down */ }
}

/** Update the single Live Activity for the full workout, rather than creating one per rest. */
export async function syncWorkoutActivity(snapshot) {
  try {
    const p = await plugin()
    if (!p) return false
    if (!snapshot) {
      await p.RestActivity.end()
      return true
    }
    const result = await p.RestActivity.syncWorkout({
      ...snapshot,
      countdownTitle: t('Rest'),
      readyLabel: t('Ready'),
      pauseLabel: t('Pause'),
      resumeLabel: t('Resume'),
      minusLabel: '− 15s',
      plusLabel: '+ 15s',
      skipLabel: t('Skip'),
      notifyTitle: t('Rest’s over. Next set!'),
    })
    return !!result?.synced
  } catch { return false }
}

// One listener and one `bind` for the life of the page. `cb` is useUI's own handler for a
// notification's buttons — the card's buttons are the same four, in the same shape, so they land in
// the same place.
let bound = false
export function bindRestActivity(cb) {
  if (!MOBILE || bound) return
  bound = true
  const p = plugin()
  // The listener first, and awaited, before bind() asks for anything: the plugin only hands a
  // command over when it knows there is somebody to receive it (RestActivityPlugin.handOverIfLive),
  // and this is how it knows.
  p.then(x => x && x.RestActivity.addListener('rest', ev => cb(ev)).then(() => x.RestActivity.bind()))
    .catch(() => { /* no such plugin in this shell: the card is simply read-only there */ })
  // Every return to the front asks again. A button pressed while the phone was locked was queued by
  // the app (RestBridge), and this is what brings it in — the app's own timer is out of date until
  // it does.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      p.then(x => x && x.RestActivity.bind()).catch(() => {})
    })
  }
}
