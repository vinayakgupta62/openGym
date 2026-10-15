// The Xcode project is edited by hand — PrintPlugin, SceneDelegate, SystemBarsPlugin and
// HealthPlugin all carry readable hand-assigned ids like AA0200000000000000000001 rather than
// Xcode's random ones — and a mistake there does not look like a mistake.
//
// A Swift file that is missing from the Sources phase is simply not compiled, so Capacitor finds no
// plugin, the JS call rejects, and every caller's try/catch turns that into a no-op: the feature is
// absent from a build that is green everywhere. A mistyped id is worse still, and fails in Xcode
// with something unrelated to the line that caused it. So this walks the references the way Xcode
// would, the same way android-system-bars.test.js reads the Android side.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

const read = p => readFileSync(new URL('../../' + p, import.meta.url), 'utf8')
const pbxproj = read('ios/App/App.xcodeproj/project.pbxproj')
const healthSync = read('src/lib/health-sync.js')

const ID = /\b[0-9A-F]{24}\b/g
const defined = new Set([...pbxproj.matchAll(/^\s*([0-9A-F]{24})\b[^\n=]*= *\{/gm)].map(m => m[1]))
const mentioned = new Set([...pbxproj.matchAll(ID)].map(m => m[0]))
const count = (s, c) => s.split(c).length - 1

describe('the Xcode project holds together', () => {
  it('registers local Swift plugins when Capacitor starts the iOS WebView', () => {
    const bridge = read('ios/App/App/OpenGymBridgeViewController.swift')
    const storyboard = read('ios/App/App/Base.lproj/Main.storyboard')
    expect(storyboard).toContain('customClass="OpenGymBridgeViewController" customModule="App"')
    expect(pbxproj).toContain('OpenGymBridgeViewController.swift in Sources')
    for (const nativePlugin of ['SystemBarsPlugin', 'HealthPlugin', 'HapticsPlugin', 'RestActivityPlugin']) {
      expect(bridge).toContain(`bridge?.registerPluginInstance(${nativePlugin}())`)
    }
  })

  it('every id it mentions is one it defines', () => {
    expect([...mentioned].filter(id => !defined.has(id))).toEqual([])
  })

  it('its braces and parens still balance', () => {
    expect(count(pbxproj, '{')).toBe(count(pbxproj, '}'))
    expect(count(pbxproj, '(')).toBe(count(pbxproj, ')'))
  })

  // The two halves of every entry: a PBXBuildFile that names the file, and the Sources phase that
  // lists that build file. Either one alone builds a project with a plugin in it that does nothing.
  it.each(['SystemBarsPlugin.swift', 'HealthPlugin.swift', 'HapticsPlugin.swift', 'RestActivityPlugin.swift'])('%s is compiled, and its file is where the group says', name => {
    expect(pbxproj).toContain(`${name} in Sources`)
    expect(pbxproj).toMatch(new RegExp(`isa = PBXSourcesBuildPhase[\\s\\S]*?${name} in Sources`))
    expect(pbxproj).toMatch(new RegExp(`path = ${name};`))
    expect(existsSync(new URL(`../../ios/App/App/${name}`, import.meta.url)), name).toBe(true)
  })

  // Capacitor discovers a plugin by its jsName, so the Swift side and the JS side have to agree on
  // the string, and the fallback in health-sync.js swallows a mismatch into "feature missing".
  it('the plugin names match what the JS registers', () => {
    const systemBars = read('ios/App/App/SystemBarsPlugin.swift')
    expect(systemBars).toContain('public let jsName = "SystemBars"')
    expect(read('src/lib/system-bars.js')).toContain("registerPlugin('SystemBars')")

    const health = read('ios/App/App/HealthPlugin.swift')
    expect(health).toContain('public let jsName = "Health"')
    // Android keeps Health Connect; iOS asks for Health. Same five methods, same record shapes.
    expect(healthSync).toMatch(/registerPlugin\(android \? 'HealthConnect' : 'Health'\)/)

    // #296 on iOS: the lock-screen countdown, and the buzz Settings → Vibrate promises an iPhone.
    expect(read('ios/App/App/RestActivityPlugin.swift')).toContain('public let jsName = "RestActivity"')
    expect(read('src/lib/rest-activity.js')).toContain("registerPlugin('RestActivity')")
    expect(read('ios/App/App/HapticsPlugin.swift')).toContain('public let jsName = "Haptics"')
    expect(read('src/lib/sound.js')).toContain("registerPlugin('Haptics')")
  })

  // The archive failed on this the first time it ever ran: CAPPlugin already declares
  // requestPermissions(_:) as the default hook of Capacitor 3's permission pattern (CAPPlugin.h),
  // so a plugin answering that name is an override — and without the keyword, swiftc stops with
  // "overriding declaration requires an 'override' keyword". Nothing here can compile Swift, but
  // Capacitor's own header can be read, which is the same question the compiler asks.
  it('a plugin method Capacitor already declares is marked override', () => {
    const header = read('node_modules/@capacitor/ios/Capacitor/Capacitor/CAPPlugin.h')
    // Both shapes: `- (void)load;` and `- (void)checkPermissions:(CAPPluginCall *)call;`.
    const inherited = new Set([...header.matchAll(/^-\s*\([^)]*\)\s*(\w+)\s*[;:]/gm)].map(m => m[1]))
    // If this parse ever stops finding the permission hooks and the lifecycle, the guard is worthless.
    expect([...inherited]).toEqual(expect.arrayContaining(['checkPermissions', 'requestPermissions', 'load']))

    for (const name of ['SystemBarsPlugin.swift', 'HealthPlugin.swift', 'HapticsPlugin.swift', 'RestActivityPlugin.swift']) {
      const swift = read(`ios/App/App/${name}`)
      const declared = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map(m => m[1])
      expect(declared.length, `${name} declares no methods`).toBeGreaterThan(0)
      for (const method of declared) {
        const line = swift.split('\n').find(l => l.includes(`func ${method}(`))
        expect(line, `${name}: ${method} is in pluginMethods but has no func`).toBeTruthy()
        if (!inherited.has(method)) continue
        expect(line, `${name}: ${method} overrides CAPPlugin, so it needs 'override'`).toContain('override')
      }
      // The same question for Capacitor's lifecycle, which is not listed in pluginMethods: a plugin
      // that observes something from load() answers a name CAPPlugin already declares.
      const lifecycle = swift.split('\n').find(l => l.includes('func load('))
      if (lifecycle) expect(lifecycle, `${name}: load() overrides CAPPlugin`).toContain('override')
    }
  })
})

// #296 on iOS, part B: the countdown on the lock screen and in the Dynamic Island, and the buttons
// on it. None of this can be compiled here, and every failure mode it has is silent — a file in the
// wrong target is a type the other process cannot see, a missing plist key is a Live Activity that
// never starts, a renamed plugin is a card that never appears — so the project is read the way Xcode
// would read it, and the two languages are checked against each other where they have to agree.
describe('the Live Activity and its buttons', () => {
  const attributes = read('ios/App/App/RestActivityAttributes.swift')
  const intents = read('ios/App/App/RestIntents.swift')
  const widget = read('ios/App/AppWidgets/RestWidgetBundle.swift')
  const restActivity = read('src/lib/rest-activity.js')
  const restAlert = read('src/lib/rest-alert.js')

  it('the widget extension is a target of its own, embedded in the app', () => {
    expect(pbxproj).toContain('AppWidgets.appex in Embed Foundation Extensions')
    expect(pbxproj).toMatch(/dstSubfolderSpec = 13;/)                       // the PlugIns folder
    expect(pbxproj).toMatch(/productType = "com.apple.product-type.app-extension";/)
    expect(pbxproj).toMatch(/PBXTargetDependency;[\s\S]*?target = AA040000000000000000000A/)
    // A target the project does not list is a target Xcode never builds, however complete it looks.
    const listed = pbxproj.match(/targets = \(\r?\n([\s\S]*?)\r?\n\t\t\t\);/)?.[1] || ''
    expect(listed).toContain('504EC3031FED79650016851F /* App */')
    expect(listed).toContain('AA040000000000000000000A /* AppWidgets */')
    // A widget extension is a WidgetKit extension and nothing else: no home-screen widget here.
    expect(read('ios/App/AppWidgets/AppWidgetsInfo.plist')).toContain('com.apple.widgetkit-extension')
    expect(existsSync(new URL('../../ios/App/AppWidgets/RestWidgetBundle.swift', import.meta.url))).toBe(true)
  })

  // An extension's bundle identifier has to be the app's with something on the end, or the install
  // is refused — and nothing about the failure names the line that caused it.
  it('the extension’s bundle id hangs off the app’s', () => {
    const app = pbxproj.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/)?.[1]
    expect(app).toBe('ch.duartesantos.opengym')
    expect(pbxproj).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${app}.widgets;`)
  })

  // ActivityKit hands the same ContentState to both processes, and the widget extension is what
  // names the button intents in its Button(intent:)s. A file compiled into one target only is a
  // type the other cannot see — and the compiler says so only on a Mac.
  it.each(['RestActivityAttributes.swift', 'RestIntents.swift'])('%s is compiled into the app and the widget both', name => {
    const builds = [...pbxproj.matchAll(new RegExp(`([0-9A-F]{24}) /\\* ${name} in Sources \\*/ =`, 'g'))].map(m => m[1])
    expect(builds, `${name} has one build file, so one target compiles it`).toHaveLength(2)
    // A build file that no Sources phase lists compiles nothing, and nothing says so.
    for (const id of builds) expect(pbxproj).toContain(`${id} /* ${name} in Sources */,`)
    expect(existsSync(new URL(`../../ios/App/App/${name}`, import.meta.url)), name).toBe(true)
  })

  it('the lock-screen and expanded Island Complete Set intent is durable and guarded', () => {
    const plugin = read('ios/App/App/RestActivityPlugin.swift')
    const activity = read('src/lib/workout-activity.js')
    const view = read('src/views/Workout.jsx')
    expect(attributes).toContain('public var setToken: String')
    expect(attributes).toContain('public var setPending: Bool')
    expect(intents).toContain('struct RestCompleteSetIntent: LiveActivityIntent')
    expect(intents).toContain('static let setQueueKey = "opengym_set_commands"')
    expect(intents).toContain('!state.setPending')
    expect(intents).toContain('!queue.contains(where:')
    expect(intents).toContain('guard state.phase != RestActivityAttributes.Phase.workout, !state.setPending')
    expect(intents).toContain('UserDefaults.standard.set(queue, forKey: setQueueKey)')
    expect(widget.match(/CompleteSetButton\(context:/g) || []).toHaveLength(3)
    expect(widget).toContain('Button(intent: RestCompleteSetIntent())')
    expect(plugin).toContain('CAPPluginMethod(name: "ackSet"')
    expect(plugin).toContain('RestBridge.pendingSets()')
    expect(restActivity).toContain('ackSetCompletion')
    expect(activity).toContain('validNativeSetTarget')
    expect(view).toContain('registerNativeSetHandler')
    expect(view).toContain('flushNativeSet()')
  })

  it('the buttons are drawn only where they exist, and performed only in the app', () => {
    // Button(intent:) is iOS 17; the extension itself is built for 16.1, where the card is the
    // read-only countdown it was before. Every use of the button row needs its own availability
    // check — the expanded Island's closure is compiled for 16.1 like everything else, and calling
    // a 17-only view there is a build error, not a runtime surprise.
    const uses = (widget.match(/Buttons\(context:/g) || []).length
    const checks = (widget.match(/#available\(iOS 17\.0, \*\)/g) || []).length
    expect(uses).toBeGreaterThan(0)
    expect(checks).toBeGreaterThanOrEqual(uses)
    for (const name of ['RestPauseIntent', 'RestMinusIntent', 'RestPlusIntent', 'RestSkipIntent']) {
      expect(intents).toContain(`struct ${name}: LiveActivityIntent`)
    }
    // They are for openGym's own card, not for Shortcuts or Spotlight.
    expect(intents).toMatch(/static var isDiscoverable: Bool = false/)
    // And they are not offered in the two presentations Apple does not allow buttons in.
    expect(widget).not.toMatch(/compactLeading:[\s\S]{0,200}Button\(intent:/)
    expect(widget).not.toMatch(/minimal:[\s\S]{0,200}Button\(intent:/)
  })

  // The first CI run stopped on exactly this: `ActivityViewContext.isStale` is iOS 16.2 while the
  // extension is built for 16.1, so the Ready-at-0:00 check has to stay behind its own gate. One
  // read, one gate, and this pins both — the same shape as the plugin `override` guard.
  it('the staleness check is gated where the API is newer than the target', () => {
    expect(widget).toContain('if #available(iOS 16.2, *) { return context.isStale }')
    expect(widget.match(/context\.isStale/g) || []).toHaveLength(1)
  })

  // Every word on the card and on the notification comes from the app's own i18n: the widget cannot
  // reach it, and the button that re-books the notification runs where no JavaScript is running.
  it('the card is handed its words, and never invents any', () => {
    for (const label of ['pauseLabel', 'resumeLabel', 'minusLabel', 'plusLabel', 'skipLabel', 'notifyTitle', 'notifyBody', 'notifySound']) {
      expect(restActivity).toContain(`${label}:`)
      expect(attributes).toContain(`public var ${label}:`)
    }
    expect(widget).toMatch(/context\.attributes\.(pauseLabel|resumeLabel|minusLabel|plusLabel|skipLabel)/)
    expect(restActivity).toContain('notifyBody: alert.body')
  })

  // Three constants two languages have to agree on, because the Swift side uses them at a moment
  // when it cannot ask the page anything.
  it('the Swift side names the same notification, sound and queue the JS does', () => {
    const id = restAlert.match(/export const REST_ALERT_ID = (\d+)/)?.[1]
    const sound = restAlert.match(/const IOS_SOUND = '([^']+)'/)?.[1]
    expect(id).toBeTruthy()
    expect(sound).toBeTruthy()
    expect(intents).toContain(`static let notificationID = "${id}"`)
    expect(intents).toContain(`static let soundName = "${sound}"`)
    expect(intents).toMatch(/static let queueKey = "opengym_rest_commands"/)
  })

  // The card's buttons are queued when nobody is listening, and `live` is how the page knows whether
  // the end it has booked is still the truth (useUI's resyncAfterRestButton).
  it('a press says whether the app was there for it', () => {
    expect(read('ios/App/App/RestActivityPlugin.swift')).toMatch(/command\["live"\] = live/)
    expect(read('src/store/useUI.js')).toMatch(/ev\.live !== false/)
    // The same four actions Android's notification sends, in the same shape.
    expect(intents).toMatch(/enqueue\("pause", state, paused: (true|false)\)/)
    expect(intents).toMatch(/enqueue\("adjust", state, paused: (true|false)\)/)
    expect(intents).toMatch(/enqueue\("skip", nil, paused: false\)/)
  })

  // The whole reason a deployment target moved (IOS_HANDOFF.md): App Intents refuses to compile
  // below iOS 16, and the two numbers — the project's and the Podfile's — are one setting.
  it('the deployment target is the one App Intents needs, project and Podfile together', () => {
    const targets = [...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(m => m[1])
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.filter(t => Number(t) < 16.1)).toEqual([])
    expect(read('ios/App/Podfile')).toMatch(/platform :ios, '16\.1'/)
    expect(read('ios/App/Podfile')).toMatch(/IPHONEOS_DEPLOYMENT_TARGET'\] = '16\.1'/)
  })
})

describe('the HealthKit entitlement is wired up', () => {
  it('both build configurations point at the entitlements file, and it exists', () => {
    expect(pbxproj.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g) || []).toHaveLength(2)
    expect(pbxproj).toContain('App.entitlements')
    expect(existsSync(new URL('../../ios/App/App/App.entitlements', import.meta.url))).toBe(true)
  })

  it('it declares HealthKit, and only HealthKit', () => {
    const ent = read('ios/App/App/App.entitlements')
    expect(ent).toMatch(/<key>com\.apple\.developer\.healthkit<\/key>\s*<true\/>/)
    const keys = [...ent.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1])
    expect(keys).toEqual(['com.apple.developer.healthkit'])
    for (const c of ent.match(/<!--([\s\S]*?)-->/g) || []) expect(c.slice(4, -3)).not.toContain('--')
  })
})
