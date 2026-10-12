// The phone shells: the status bar draws on top of the page, and its glyphs have to follow the
// app's own theme rather than the device's.
//
// Android 15 draws the page edge to edge, so the clock, the battery and the three buttons sit on
// the page's background. The system draws them white unless told otherwise, and on the light theme
// (#f2f2f7) they all but vanished. SystemBarsPlugin.java flips them dark on light.
//
// iOS has the same problem from the other side: the style comes from the view controller, and
// Capacitor's default falls back to a UIStatusBarStyle key Info.plist does not set — so it follows
// the *device's* light/dark setting. A phone in Light Mode running this app's dark theme drew dark
// glyphs on #000000. SystemBarsPlugin.swift answers the same call with the same argument.
//
// A value pinned in Info.plist cannot do this: it is one value, and the app has two themes that the
// user switches between while it runs. So the page says which one it resolved to, at start and on
// every change (App.jsx applyPrefs).
import { isAndroid, isIOS } from './mobile.js'

// Registered once, and kept inside an object: a Capacitor plugin proxy answers `then` with a native
// call that never settles, so a promise resolved with the bare proxy would hang (the Coach hang, #42).
let pluginP = null
const barsPlugin = () => pluginP || (pluginP = (async () => {
  if (!(await isAndroid()) && !(await isIOS())) return null
  const { registerPlugin } = await import('@capacitor/core')
  return { SystemBars: registerPlugin('SystemBars') }
})().catch(() => null))

let last = null
export async function setSystemBarsLight(light) {
  light = !!light
  if (last === light) return
  last = light
  try {
    const p = await barsPlugin()
    if (p) await p.SystemBars.setStyle({ light })
  } catch {
    // An older APK, or an app built before the iOS plugin existed: the bars stay as they were.
  }
}
