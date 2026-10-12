// The iOS half of android-backup.test.js: keys this app cannot work without, and keys whose
// *presence* silently cancels another. Nothing else would notice one going missing — the iOS
// build has no runner in CI (the GitLab build:ios job waits on a registered Mac), and the failure
// mode is on a phone rather than in a test: a feature that quietly does nothing, or an app that is
// killed on launch. docs/MOBILE.md is the contract these keys hold up.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8')
const plist = read('ios/App/App/Info.plist')
const capacitor = JSON.parse(read('capacitor.config.json'))
const pbxproj = read('ios/App/App.xcodeproj/project.pbxproj')

// A key followed by any value: <true/>, <string>…</string>, a <dict> or an <array>.
const hasKey = k => new RegExp(`<key>${k}</key>\\s*<(true/|false/|string|dict|array)`).test(plist)
const stringValue = k => plist.match(new RegExp(`<key>${k}</key>\\s*<string>([\\s\\S]*?)</string>`))?.[1]

describe('iOS Info.plist: App Transport Security', () => {
  it('allows the user-typed http:// addresses the app exists to talk to', () => {
    expect(hasKey('NSAppTransportSecurity')).toBe(true)
    expect(plist).toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/)
  })

  // The trap this test exists for. From iOS 10 on, ANY of these three present makes ATS ignore
  // NSAllowsArbitraryLoads and fall back to its default of NO — which would re-block every
  // cleartext connection and undo the key above, while looking like a tightening. NSExceptionDomains
  // is not an alternative either: its keys must not be IP addresses, so it cannot name
  // http://192.168.1.20:8080. See docs/MOBILE.md and android/.../network_security_config.xml.
  it('does not carry a key that would cancel NSAllowsArbitraryLoads', () => {
    for (const k of ['NSAllowsLocalNetworking', 'NSAllowsArbitraryLoadsInWebContent', 'NSAllowsArbitraryLoadsForMedia']) {
      expect(hasKey(k), k + ' would make ATS ignore NSAllowsArbitraryLoads').toBe(false)
    }
  })
})

describe('iOS Info.plist: privacy strings iOS kills the app without', () => {
  // The barcode scanner (@capacitor-mlkit/barcode-scanning) and a photo or video of a custom
  // exercise. iOS terminates the process on the request, not on a denial, when the string is
  // missing — so this is a launch crash, not a permission prompt.
  it.each(['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'])('%s is a non-empty string', k => {
    expect(stringValue(k)?.trim().length, k).toBeGreaterThan(0)
  })

  // iOS 14+ gates reaching anything on the local network, which is where a self-hosted server
  // lives. Separate from ATS: this is the privacy prompt, not the transport rule.
  it('NSLocalNetworkUsageDescription is a non-empty string', () => {
    expect(stringValue('NSLocalNetworkUsageDescription')?.trim().length).toBeGreaterThan(0)
  })

  // Settings → Health (#200). Update is the write (finished workouts, weigh-ins); Share is the read
  // the iOS plugin asks for so it can find openGym's own records again and remove them. Asking for
  // either kind of data without its string is a launch crash, not a refusal.
  it.each(['NSHealthUpdateUsageDescription', 'NSHealthShareUsageDescription'])('%s is a non-empty string', k => {
    expect(stringValue(k)?.trim().length, k).toBeGreaterThan(0)
  })
})

describe('iOS Info.plist: the auto-backup folder is reachable', () => {
  // writeAutoBackup (lib/mobile.js) writes Documents/openGym/opengym-backup-YYYY-MM-DD.json, and
  // docs/MOBILE.md promises a folder "a file manager or a sync app (Syncthing, a cloud folder) can
  // reach". Without these two the app's Documents folder is private to the app: invisible in Files,
  // unable to be pointed at by a sync app, and — because Settings → Import backup goes through the
  // Files picker — its own copies could not be read back.
  it.each(['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace'])('%s is true', k => {
    expect(plist, k).toMatch(new RegExp(`<key>${k}</key>\\s*<true/>`))
  })

  // The media store is the other way round on purpose: photos and videos of custom exercises belong
  // in Library, which stays private even now that Documents is exposed. Moving them into Documents
  // to "make them reachable too" would put every clip a user added in Files — and, on the Android
  // side, in the cloud backup those two rule files exist to keep them out of (android-backup.test.js).
  it('the media store stays in Library, not Documents', () => {
    const media = read('src/lib/media-store-fs.js')
    expect(media).toMatch(/directory:\s*Directory\.Library/)
    expect(media).not.toMatch(/Directory\.Documents/)
  })
})

describe('iOS Info.plist: the identity matches the build', () => {
  // Xcode takes the identifier from the project, not from capacitor.config.json — but Capacitor
  // writes the config into the app bundle at cap sync, and a mismatch is how "the app installs but
  // every request goes to the wrong origin" happens.
  it('capacitor.config.json appId is the project bundle identifier', () => {
    const built = pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/)?.[1]
    expect(built).toBeTruthy()
    expect(capacitor.appId).toBe(built)
  })

  it('the plist defers to the project rather than hardcoding one', () => {
    expect(stringValue('CFBundleIdentifier')).toBe('$(PRODUCT_BUNDLE_IDENTIFIER)')
  })
})

describe('iOS Info.plist: the rest timer’s Live Activity', () => {
  // #296 on iOS: without this key `Activity.request` fails, lib/rest-activity.js reports "nothing
  // started" (its caller treats that as "no card", not as an error), and the lock-screen countdown
  // and the Dynamic Island simply never appear. A silent absence, so it is pinned here.
  it('Live Activities are declared', () => {
    expect(plist).toMatch(/<key>NSSupportsLiveActivities<\/key>\s*<true\/>/)
  })
})

describe('iOS Info.plist: comments are still valid XML', () => {
  // The same trap android-backup.test.js pins for the Android build (v1.3.6): a `--` inside a
  // comment ends it early and the file stops parsing. Xcode then fails with something unrelated.
  it('no comment carries a double dash', () => {
    for (const c of plist.match(/<!--([\s\S]*?)-->/g) || []) expect(c.slice(4, -3)).not.toContain('--')
  })
})
