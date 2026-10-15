// Rest-over alert for the Capacitor app.
//
// The in-page countdown is a setInterval in the WebView. Android freezes that as soon as the
// screen locks, so the beep never runs and nothing is posted. Scheduling a real alarm at
// startRest() is what still fires with the screen off: the receiver posts the notification
// and plays the end tone. The card in the notification shade is the in-app shape: clock plus
// a shrinking bar. The lock screen shows it only when notifications are allowed and the
// system is set to show them there.
//
// iOS is the same problem with a smaller toolbox, and it is answered here rather than by a second
// native plugin. There is no ongoing notification to hold a countdown in and no foreground service
// to keep the WebView ticking, so all iOS can announce from the page is the *end* of the rest: one
// local notification, scheduled through @capacitor/local-notifications, which the system delivers
// while the app is suspended or killed. The countdown the page cannot post is an ActivityKit Live
// Activity instead (lib/rest-activity.js), and Pause/±15 s/Skip reach the page from *its* buttons,
// performed by the app's own process (ios/App/App/RestIntents.swift).
//
// The web build keeps Web Push (useUI). This file no-ops there; MOBILE is a build-time flag.
import { t } from './i18n-core.js'
import { argb } from './format.js'
import { accentPair } from './accent.js'
import { MOBILE } from './mobile.js'
import { REST_SOUNDS } from './rest-sounds.js'
import { bindRestActivity, endRestActivity, holdRestActivity, startRestActivity } from './rest-activity.js'

export const REST_ALERT_ID = 42
export const REST_CHANNEL_ID = 'rest-over'
// Settings → Vibrate off. A notification channel's vibration is the system's to keep once the
// channel exists, so the app cannot switch it off on 'rest-over': an end that must not buzz is
// posted on a second channel that never vibrates (RestAlert.java).
export const REST_QUIET_CHANNEL_ID = 'rest-over-quiet'

// One object the native side schedules. Public + high is what the notification shade can show.
// The lock screen follows the user's notification settings.
// `key` is a preset's key or the user's own colour as '#rrggbb' (lib/accent.js accentValue).
export function accentColors(key) {
  const { accent, ink } = accentPair(key)
  return { accent: argb(accent), ink: argb(ink) }
}

/** m:ss, for the one line an iOS notification has room for. */
const mmss = ms => {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function buildRestAlert({ at, title, countdownTitle, iosBody, totalSec, accent, sound = true, classic = false, tone = null, vibrate = true, alarmBuzz = false, now = Date.now() } = {}) {
  if (typeof at !== 'number' || !(at > now)) return null
  // Settings → Sound (#306): one of lib/sound.js REST_SOUNDS; without one, `classic` decides, as before.
  const kind = Object.hasOwn(REST_SOUNDS, tone) ? tone : classic === true ? 'classic' : 'chime'
  const totalMs = Math.max(1000, Math.round((totalSec > 0 ? totalSec : (at - now) / 1000) * 1000))
  const colors = accentColors(accent)
  const label = countdownTitle || t('Rest')
  return {
    id: REST_ALERT_ID,
    channelId: vibrate ? REST_CHANNEL_ID : REST_QUIET_CHANNEL_ID,
    title: title || t('Rest’s over. Next set!'),
    countdownTitle: label,
    // The line the notification itself carries. The card Android draws has a clock and a shrinking
    // bar to read the duration off; a notification has one line of text, so the rest's own length
    // goes there. Built here rather than at the two places that need it — iosNotification below, and
    // the Live Activity, whose own buttons re-book that notification from Swift with these words
    // (ios/App/App/RestIntents.swift).
    body: `${label} · ${mmss(totalMs)}`,
    // Native iOS notifications can use the next set's exercise and prescription.
    // Leave Android's ongoing timer card / payload untouched. Carry the exact
    // same text into ActivityKit so pause / ±15s from the Lock Screen preserve it.
    iosBody: typeof iosBody === 'string' ? iosBody.replace(/\s+/g, ' ').trim().slice(0, 180) : '',
    pause: t('Pause'),
    resume: t('Resume'),
    minus: '− 15s',
    plus: '+ 15s',
    skip: t('Skip'),
    accent: colors.accent,
    ink: colors.ink,
    totalMs,
    at,
    allowWhileIdle: true,
    sound: !!sound,
    // Settings → Sound: the native side plays the same end tone the page does (RestTone.java).
    // `tone` names it; `classic` stays for an app shell from before #306, which reads only that
    // and plays the chime for every other pick.
    tone: kind,
    classic: kind === 'classic',
    vibrate: !!vibrate,
    // Settings → "Vibrate when the phone is on silent" (#375): the end buzzes as an alarm, which
    // silent mode lets through, instead of through the notification channel, which it mutes.
    alarmBuzz: !!vibrate && !!alarmBuzz,
    localOnly: false,
    visibility: 'public',
    importance: 'high',
  }
}

// Serialises schedule/cancel. startRest() disarms the previous alarm and arms the next in
// the same turn; if those two bridge calls raced, a cancel finishing last would swallow the
// new alarm. `token` stops a slow schedule from adopting the beep after a later disarm.
let chain = Promise.resolve()
let token = 0

const enqueue = fn => {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

// The native plugin, registered once: registerPlugin() warns on every call after the first. It
// travels inside an object because a Capacitor plugin proxy answers `then` with a native call that
// never settles, so a promise resolved with the bare proxy hangs for good (the Coach hang, #42).
// Anything but the Android app gets null and registers nothing: iOS has no RestAlert plugin and
// needs none (see the header), and every call to a plugin a platform does not have rejects.
// Which phone shell this is, read once and kept. Every branch below asks this rather than calling
// mobile.js's isAndroid()/isIOS() again: each of those does its own dynamic import of
// @capacitor/core, and a rest arms, holds, adjusts and disarms within a second or two — one cached
// answer cannot disagree with itself halfway through a call.
let platformP = null
const platform = () => platformP || (platformP = (async () => {
  if (!MOBILE) return 'web'
  try {
    const { Capacitor } = await import('@capacitor/core')
    return Capacitor.getPlatform()
  } catch { return 'web' }
})())

let pluginP = null
const restPlugin = () => pluginP || (pluginP = (async () => {
  if ((await platform()) !== 'android') return null
  const { registerPlugin } = await import('@capacitor/core')
  return { RestAlert: registerPlugin('RestAlert') }
})().catch(() => null))

// ---------------------------------------------------------------- iOS
//
// One local notification at the end of the rest, and nothing else: no countdown card to keep in
// step, no labels to push into it, no plugin of our own.
// Files are bundled in the native iOS target, including all Settings tones.
const IOS_SOUND = 'opengym-rest-chime.wav'
const IOS_SOUNDS = Object.fromEntries(Object.keys(REST_SOUNDS).map(id => [id, `opengym-rest-${id}.wav`]))
let iosAudioP = null
const iosAudio = () => iosAudioP || (iosAudioP = (async () => {
  if (!MOBILE || (await platform()) !== 'ios') return null
  const { registerPlugin } = await import('@capacitor/core')
  return { RestAudio: registerPlugin('RestAudio') }
})().catch(() => null))
const prepareIosAudio = () => iosAudio().then(p => p && p.RestAudio.prepare()).catch(() => {})

// Whether an iOS notification is armed that will make a noise. `useUI.endTone` asks before it
// chimes: Capacitor presents a notification delivered to a foreground app *with* its sound
// (LocalNotificationsHandler.willPresent), so without this an iOS rest would ring twice — once from
// the system and once from the page's Web Audio. Android has the mirror of it in native code
// (RestAlertPlugin.appInFront, which keeps the alarm quiet while the page is on screen), and there
// the page's chime is meant to be the only one.
let iosArmed = false
export function nativeEndTone() { return iosArmed }

const iosNotification = alert => ({
  id: REST_ALERT_ID,
  title: alert.title,
  body: alert.body,
  // Bundled custom PCM WAV; the chosen tone plays when locked.
  ...(alert.sound ? { sound: IOS_SOUNDS[alert.tone] || IOS_SOUND } : {}),
  extra: { openGymRestTone: alert.tone },
  schedule: { at: new Date(alert.at) },
})

/** The iOS end of the rest: schedule it, and say whether the page must stay quiet for it. */
async function deliverIos(alert) {
  // The workout snapshot is captured when the rest is booked. The ActivityKit
  // buttons can re-book this notification while JavaScript is suspended, so both
  // the original local notification and Swift must get this exact same body.
  const notice = alert.iosBody ? { ...alert, body: alert.iosBody } : alert
  // Unlike Android, where the alarm sounds whether or not a notification may be posted, on iOS the
  // notification *is* the alert — so here the permission is worth waiting for. Asked once; the
  // dialog only appears on the first rest.
  // ActivityKit does not need notification authorization. Start it BEFORE prompting for
  // notification permission: waiting for a dialog or a failed notification schedule used to
  // prevent the Live Activity from ever being requested.
  await startRestActivity(notice)
  const granted = await askNotifPermissionOnce()
  if (!(alert.at > Date.now())) return 'expired'
  let scheduled = false
  if (granted) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      await LocalNotifications.schedule({ notifications: [iosNotification(notice)] })
      scheduled = true
      await prepareIosAudio() // wrap Capacitor delegate only after it is installed
    } catch { /* ActivityKit is independent of notification scheduling errors. */ }
  }
  // Only a granted, scheduled sound may silence the in-page chime.
  iosArmed = scheduled && !!alert.sound
  return 'ios'
}

// Resolves true only when something was really booked that will announce the end on its own: an
// Android alarm, or an iOS local notification. Callers use false as "fall back to the server push"
// — the web build, and any schedule that failed.
export function armRestAlert(at, opts = {}) {
  if (!MOBILE) return Promise.resolve(false)
  const mine = ++token
  const alert = buildRestAlert({ at, title: opts.title, countdownTitle: opts.countdownTitle, iosBody: opts.iosBody, totalSec: opts.totalSec, accent: opts.accent, sound: opts.sound, classic: opts.classic === true, tone: opts.tone, vibrate: opts.vibrate !== false, alarmBuzz: !!opts.alarmBuzz })
  if (!alert) return Promise.resolve(false)
  // Outside the chain and never awaited: on Android the alarm, its tone and the alarm buzz do not
  // need the notification permission, and a dialog left open while the phone is put away must not
  // hold the alarm back until the rest is long over. iOS is the other way round — its notification
  // *is* the alert — so deliverIos() waits for the answer instead.
  askNotifPermissionOnce()
  return enqueue(async () => {
    let kind = 'failed'
    try { kind = await deliver(alert) } catch { kind = 'failed' }
    if (mine !== token) return false
    return kind === 'android' || kind === 'ios'
  })
}

export function disarmRestAlert() {
  token++
  if (!MOBILE) return
  enqueue(async () => {
    try { await cancelDelivered() } catch { /* the next arm replaces this alarm */ }
  })
}

// The rest was paused in the app (#193): the notification stops its clock at the time held and
// offers Resume, and the alarm for the old end is called off. Resuming arms it again for the new
// end like any other rest; time added or taken while paused holds it again at the new figure.
export function holdRestAlert(leftSec, totalSec) {
  token++
  if (!MOBILE) return
  enqueue(async () => {
    if ((await platform()) === 'ios') {
      // Keep the Live Activity paused (with Resume and ±15 s controls). Only cancel
      // the old end notification; cancelDelivered would destroy the card too.
      iosArmed = false
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications')
        await LocalNotifications.cancel({ notifications: [{ id: REST_ALERT_ID }] })
      } catch { /* No pending alert to cancel on this device. */ }
      await holdRestActivity(leftSec, totalSec)
      return
    }
    const p = await restPlugin()
    if (p) await p.RestAlert.hold({ id: REST_ALERT_ID, leftMs: Math.max(1, leftSec) * 1000, totalMs: Math.max(1, totalSec) * 1000 })
  })
}

// What the notification's own buttons did (pause, ±15s, skip), for useUI to mirror in the bar.
let onNativeRest = null
export function bindNativeRest(cb) {
  onNativeRest = cb
  // iOS's buttons are not on the notification at all — a local notification only arrives at the end
  // of a rest, so there is no card for them to sit on (see the header). They are on the Live
  // Activity, and they reach the page through its own plugin, in this same shape (lib/rest-activity.js).
  bindRestActivity(ev => { if (onNativeRest) onNativeRest(ev) })
}

// Whether the rest alert this app books is the iOS pair — one local notification for the end, plus
// the Live Activity. Asked by useUI after a button press the app was not there for (rest-activity.js
// hands those over with `live: false`), which is the only case where the alert has to be re-booked
// from this side. Android's service owns its own card and was never out of step.
export const iosRestAlert = () => platform().then(p => p === 'ios')

// Caught, and only on Android: in the iOS app this listener used to reject at startup with
// nobody to catch it.
if (MOBILE) {
  restPlugin()
    .then(p => p && p.RestAlert.addListener('rest', ev => { if (onNativeRest) onNativeRest(ev) }))
    .catch(() => {})
}

// A buzz that silent mode lets through (#375): the native side vibrates as an alarm. Resolves true
// once it did, false anywhere it cannot (the web, iOS, a failed call) for the caller to buzz the
// ordinary way instead. Never resolves with the plugin itself — see restPlugin.
export function buzzAsAlarm(pattern) {
  if (!MOBILE) return Promise.resolve(false)
  const p = Array.isArray(pattern) ? pattern.filter(n => Number.isFinite(n) && n >= 0).map(Math.round) : (Number.isFinite(pattern) && pattern > 0 ? [Math.round(pattern)] : [])
  if (!p.length) return Promise.resolve(false)
  return restPlugin()
    .then(plugin => (plugin ? plugin.RestAlert.buzz({ pattern: p }).then(() => true) : false))
    .catch(() => false)
}

// Foreground iOS playback uses AVAudioSession.duckOthers rather than
// interrupting Spotify. The same native sound works without notifications.
export async function toneNative(kind) {
  if (!MOBILE) return false
  const selected = Object.hasOwn(REST_SOUNDS, kind) ? kind : 'chime'
  if ((await platform()) === 'ios') {
    try {
      const p = await iosAudio()
      return p ? (await p.RestAudio.play({ tone: selected }))?.played === true : false
    } catch { return false }
  }
  return restPlugin()
    .then(p => p ? p.RestAlert.tone({ kind: selected }).then(() => true) : false)
    .catch(() => false)
}

// The running countdown repaints with this swatch. No-op when no rest is on screen, and always a
// no-op on iOS: there is no countdown card there to tint (restPlugin() is null off Android).
export function setRestAccent(key) {
  if (!MOBILE) return
  const { accent, ink } = accentColors(key)
  enqueue(async () => {
    const p = await restPlugin()
    if (p) await p.RestAlert.setAccent({ accent, ink })
  })
}

// The notification permission is asked once, the first time a rest starts. The answer is kept:
// Android lets an app ask again after a "Don't allow" and iOS does not, but asking anyway would
// pop the dialog between every set on Android. Settings → Notifications in the system is where it
// changes later. Both phone platforms go through @capacitor/local-notifications for this.
export const NOTIF_ASKED_KEY = 'gym_rest_notif_asked'
let askP = null
const readAsked = () => { try { return localStorage.getItem(NOTIF_ASKED_KEY) } catch { return null } }
const writeAsked = v => { try { localStorage.setItem(NOTIF_ASKED_KEY, v) } catch { /* asked again next launch */ } }

export function askNotifPermissionOnce() {
  if (askP) return askP
  askP = (async () => {
    try {
      const p = await platform()
      if (p !== 'android' && p !== 'ios') return false
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      const perm = await LocalNotifications.checkPermissions()
      if (perm.display === 'granted') return true
      if (perm.display === 'denied' || readAsked()) return false
      const got = await LocalNotifications.requestPermissions()
      // Kept only once really answered. Leaving the app closes the dialog and reports "denied",
      // but the permission still reads 'prompt' then: nobody chose, so the next launch asks again
      // (this one does not: askP holds the answer for the rest of the session).
      const after = got.display === 'granted' ? got : await LocalNotifications.checkPermissions().catch(() => got)
      if (after.display !== 'prompt') writeAsked(got.display === 'granted' ? 'granted' : 'denied')
      return got.display === 'granted'
    } catch {
      return false
    }
  })()
  return askP
}

// Test seam: a fresh launch.
export function _resetNotifAsk() { askP = null }

async function deliver(alert) {
  // The end passed while the call waited its turn (a slow bridge, a frozen WebView): nothing to
  // ring any more, and the plugin would refuse it ("at must be in the future").
  if (!(alert.at > Date.now())) return 'expired'
  if ((await platform()) === 'ios') return deliverIos(alert)
  const p = await restPlugin()
  if (!p) return 'skipped'
  const { RestAlert } = p
  if (!(alert.at > Date.now())) return 'expired'
  // Sound, the alarm buzz and the alarm itself need no notification permission; only the
  // countdown card does, and askNotifPermissionOnce() asks for it on the side.
  await RestAlert.schedule({
    id: alert.id,
    at: alert.at,
    title: alert.title,
    sound: alert.sound,
    classic: alert.classic,
    tone: alert.tone,
    // The end of a rest the app is not in front for: the notification, or the buzz standing in
    // for it where notifications are off. With the app in front the page buzzes (lib/sound.js).
    vibrate: alert.vibrate,
    alarmBuzz: alert.alarmBuzz,
    channelId: alert.channelId,
    visibility: alert.visibility,
    importance: alert.importance,
    localOnly: alert.localOnly,
    countdownTitle: alert.countdownTitle,
    totalMs: alert.totalMs,
    pause: alert.pause,
    resume: alert.resume,
    minus: alert.minus,
    plus: alert.plus,
    skip: alert.skip,
    accent: alert.accent,
    ink: alert.ink,
  })
  return 'android'
}

async function cancelDelivered() {
  if ((await platform()) === 'ios') {
    // Nothing is armed once this returns, so the page takes the end back over.
    iosArmed = false
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.cancel({ notifications: [{ id: REST_ALERT_ID }] })
    await endRestActivity()
    return
  }
  const p = await restPlugin()
  if (p) await p.RestAlert.cancel({ id: REST_ALERT_ID })
}
