// The status bar has to follow the app's theme on both phone shells. On Android 15 the page is
// drawn edge to edge and the icons stayed white on the light theme; on iOS the style falls back to
// the device's own light/dark setting, so a phone in Light Mode running the dark theme drew dark
// glyphs on #000000. The page tells the native side which theme it resolved to; nothing else may
// hear about it, and a shell without the plugin must not break the theme.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE', '1')
  return { platform: 'android', calls: [], fail: false }
})

const pluginProxy = () => new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'then') return () => new Promise(() => {})
    return async arg => {
      if (h.fail) throw new Error('"SystemBars" plugin is not implemented on android')
      h.calls.push([String(prop), arg])
    }
  },
})

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => h.platform },
  registerPlugin: () => pluginProxy(),
}))

beforeEach(() => {
  vi.resetModules()
  h.calls = []
  h.platform = 'android'
  h.fail = false
})

describe('system bars follow the theme on Android', () => {
  it('asks for dark icons on light and light icons on dark, once per change', async () => {
    const { setSystemBarsLight } = await import('./system-bars.js')
    await setSystemBarsLight(true)
    await setSystemBarsLight(true)
    await setSystemBarsLight(false)
    expect(h.calls).toEqual([['setStyle', { light: true }], ['setStyle', { light: false }]])
  })

  it('asks on iOS too, where the same theme has to reach the status bar', async () => {
    h.platform = 'ios'
    const { setSystemBarsLight } = await import('./system-bars.js')
    await setSystemBarsLight(true)
    await setSystemBarsLight(false)
    expect(h.calls).toEqual([['setStyle', { light: true }], ['setStyle', { light: false }]])
  })

  it('stays quiet on the web build', async () => {
    h.platform = 'web'
    const { setSystemBarsLight } = await import('./system-bars.js')
    await setSystemBarsLight(true)
    expect(h.calls).toEqual([])
  })

  it('an APK without the plugin is not an error', async () => {
    h.fail = true
    const { setSystemBarsLight } = await import('./system-bars.js')
    await expect(setSystemBarsLight(true)).resolves.toBeUndefined()
  })

  it('the app sends every resolved theme, and the activity registers the plugin', () => {
    const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
    expect(app).toMatch(/function applyPrefs[\s\S]*?setSystemBarsLight\(de\.dataset\.theme === 'light'\)/)
    const dir = '../../android/app/src/main/java/ch/duartesantos/opengym/'
    const activity = readFileSync(new URL(dir + 'MainActivity.java', import.meta.url), 'utf8')
    const plugin = readFileSync(new URL(dir + 'SystemBarsPlugin.java', import.meta.url), 'utf8')
    expect(activity).toMatch(/registerPlugin\(SystemBarsPlugin\.class\);[\s\S]*super\.onCreate/)
    expect(plugin).toContain('@CapacitorPlugin(name = "SystemBars")')
    expect(plugin).toMatch(/setAppearanceLightStatusBars\(light\)/)
  })

  // The iOS half answers the same jsName with the same argument, so the page needs no branch. A
  // Swift file that is not in the Xcode project is not compiled, though — Capacitor would find no
  // plugin, the call would reject, and the catch above would swallow it into silent no-op. Hence
  // the pbxproj assertion: it is the one failure here that looks exactly like success.
  it('iOS registers the same jsName, and the file is actually in the project', () => {
    const swift = readFileSync(new URL('../../ios/App/App/SystemBarsPlugin.swift', import.meta.url), 'utf8')
    expect(swift).toContain('public let jsName = "SystemBars"')
    expect(swift).toMatch(/pluginMethods: \[CAPPluginMethod\] = \[\s*CAPPluginMethod\(name: "setStyle"/)
    expect(swift).toMatch(/setStatusBarStyle\(light \? \.darkContent : \.lightContent\)/)
    const pbxproj = readFileSync(new URL('../../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8')
    expect(pbxproj).toContain('SystemBarsPlugin.swift in Sources')
  })
})
