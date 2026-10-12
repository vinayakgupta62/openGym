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
  it('every id it mentions is one it defines', () => {
    expect([...mentioned].filter(id => !defined.has(id))).toEqual([])
  })

  it('its braces and parens still balance', () => {
    expect(count(pbxproj, '{')).toBe(count(pbxproj, '}'))
    expect(count(pbxproj, '(')).toBe(count(pbxproj, ')'))
  })

  // The two halves of every entry: a PBXBuildFile that names the file, and the Sources phase that
  // lists that build file. Either one alone builds a project with a plugin in it that does nothing.
  it.each(['SystemBarsPlugin.swift', 'HealthPlugin.swift'])('%s is compiled, and its file is where the group says', name => {
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
