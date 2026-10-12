# iOS target — status and Mac handoff

Working note for getting openGym's iOS (Capacitor) target working. **Not part of upstream
openGym** — upstream tracks this in `docs/MOBILE.md` and the roadmap. Delete this file before
opening a PR.

Repo: `DuarteSantos8/openGym` @ `464355ef` (Release v1.4.1), cloned to `D:\Repo\opengym`.

## The headline

**openGym is not being ported to iOS — the iOS app already exists.** `frontend/ios/` is a
committed Xcode project, `@capacitor/ios` is a dependency, `npm run build:mobile` syncs into it,
and `docs/MOBILE.md` documents `npx cap open ios`. What was missing was a way to build and
verify it, and a handful of genuine iOS-only gaps.

## What was verified on Windows (this machine)

The whole web layer of the iOS target builds and syncs here. Run in `frontend/`:

```powershell
$env:VITE_MOBILE='1'
npx vite build                                    # ✓ built in 2.19s
node ../scripts/catalogue/stage-media.mjs dist    # ✓ 6554 stills, 6554 animations (180 px, in-repo)
npx cap sync ios                                  # ✓ exit 0 (see the warnings below)
node scripts/check-mobile-bundle.mjs              # ✓ "Mobile bundle OK in dist, ios/App/App/public."
```

`check-mobile-bundle.mjs` is upstream's own guard for "is what went into the native shells the
phone build, whole?" — it checks the `opengym-flavor` meta, every script/stylesheet `index.html`
loads, and that `sw.js` is stamped. It passes for `ios/App/App/public`, so **the iOS shell now
carries a valid, current mobile bundle.**

### Two Windows boundaries, both harmless

1. **`npm run build:mobile` cannot run on Windows at all.** The script is
   `VITE_MOBILE=1 vite build && node … && cap sync && …` — POSIX `VAR=value cmd` syntax, which
   `cmd.exe` (what `npm run` uses on Windows) does not understand. It dies immediately with
   `'VITE_MOBILE' is not recognized as an internal or external command`. Run the four steps
   individually as above. On macOS the script itself is fine — use it there.

2. **`cap sync ios` succeeds but skips the native half**, by design:
   ```
   [warn] Skipping pod install because CocoaPods is not installed
   [warn] Unable to find "xcodebuild". Skipping xcodebuild clean step...
   ✓ Updating iOS native dependencies with pod install in 20.72ms
   [info] Found 6 Capacitor plugins for ios:
          @aparajita/capacitor-secure-storage@7.1.6   @capacitor-mlkit/barcode-scanning@7.5.0
          @capacitor/app@7.1.2                        @capacitor/filesystem@7.1.8
          @capacitor/local-notifications@7.0.7        @capacitor/share@7.0.4
   ```
   Those 6 match `ios/App/Podfile` exactly, so the plugin set is right. `Pods/` is not installed
   and cannot be here — that is the first thing to do on a Mac.

   Side effect worth knowing: `cap sync` rewrites `ios/App/Podfile` (it manages the plugin pod
   entries), and on Windows that leaves the file with **mixed CRLF/LF endings**. The content is
   byte-identical after normalization (verified: same blob hash `a858b83`, mode `100644`), but
   `git status` flags it as modified and `git diff` shows nothing. `git checkout -- frontend/ios/App/Podfile`
   clears it. Purely cosmetic, and only on Windows.

## Changes made

| File | Change |
|---|---|
| `frontend/ios/App/App/Info.plist` | **`NSAppTransportSecurity` → `NSAllowsArbitraryLoads`**, `NSLocalNetworkUsageDescription`, `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`, `NSHealthUpdate/ShareUsageDescription`. |
| `frontend/ios/App/App/SystemBarsPlugin.swift` | **New.** The iOS half of the status bar — follows the app's theme, not the device's. |
| `frontend/ios/App/App/HealthPlugin.swift` | **New.** HealthKit: writes finished workouts and weigh-ins, iOS's counterpart to Health Connect. |
| `frontend/ios/App/App/App.entitlements` | **New.** The HealthKit entitlement. |
| `frontend/ios/App/App.xcodeproj/project.pbxproj` | The three files above added by hand (`AA02…` ids), plus `CODE_SIGN_ENTITLEMENTS` in both configurations. |
| `.github/workflows/ios.yml` | **New.** Builds the unsigned `.ipa` on GitHub's macOS runners. |
| `frontend/src/lib/mobile.js` | Added `isIOS()`, the missing counterpart to `isAndroid()`. |
| `frontend/src/lib/system-bars.js` | Drives iOS as well as Android through the same `setStyle({ light })`. |
| `frontend/src/lib/health-sync.js` | Picks `Health` on iOS / `HealthConnect` on Android; same five methods, same record shapes. |
| `frontend/src/views/Settings.jsx` | The Health card shows on iOS, naming Apple Health and saying what iOS actually reads. |
| `frontend/src/views/CoachSetup.jsx` | The Android-only `http://` refusal no longer fires on iOS. |
| `frontend/src/lib/ios-plist.test.js` | **New.** 13 tests guarding the plist keys. |
| `frontend/src/lib/ios-app.test.js` | **New.** 7 tests guarding the Xcode project and the entitlement. |
| tests: `system-bars`, `CoachSetup.cleartext`, `CoachSetup.flow`, 9 × `Settings.*` | Mocks gained `isIOS`; iOS cases added. |

Android behaviour is deliberately **unchanged** throughout.

## The rest timer — status

Still the largest gap, and the design spec is in hand. Two mechanisms, not one:

- **A local notification at the rest's end** — reliable, fires even if the app is killed, works on
  iOS 15.5, no Widget Extension. This alone fixes *"the rest timer does not work on iOS."*
- **A Live Activity (ActivityKit)** — the lock-screen countdown that ticks with the app suspended,
  plus Dynamic Island. iOS 16.1+, and it needs a **new Widget Extension target** in the Xcode
  project.

**A correction to the spec worth acting on.** The spec says inline controls need iOS 17 (true for
Live Activities) and gives the plain-notification fallback "Actions: None". But a local
**notification** can carry up to four `UNNotificationAction` buttons from **iOS 15.5**, and
selecting one launches the app in the background to handle it — Apple's own documentation example
is a `TIMER_EXPIRED` category with Snooze/Stop. So Pause / −15s / +15s / Skip works on the current
deployment target with no Widget Extension at all. That is the cheap path, and it is the one to
build first.

**Also note the JS gate, not just the Swift.** `lib/rest-alert.js` returns `null` from `restPlugin()`
unless `isAndroid()`, and `deliver()` returns the literal string `'android'`. Adding a Swift
`RestAlert` is not enough — that gate and `system-bars`-style branch have to move too.

The spec's own P0 is the real open problem and it is right: a countdown reaching 0:00 does **not**
guarantee the Live Activity redraws as Ready while the app is suspended. A local notification
cannot update Live Activity content; that needs an ActivityKit push. Keep "the alert fires" and
"the interface says Ready" as two separate behaviours.

### Why the ATS change is the one that matters

`docs/MOBILE.md` scopes plain-`http://` self-hosted servers to *"(Android; #428)"*. That is the
gap: iOS could not pair with a LAN server over `http://` at all, because App Transport Security is
on by default and refuses every cleartext connection (`-1022`) — for the WebView's `fetch` (the
pairing call, `api.pairRedeem`) and for `CapacitorHttp`'s own `URLSession` (the Coach) alike.
Android has the mirror of this in `android/app/src/main/res/xml/network_security_config.xml`
(`cleartextTrafficPermitted="true"`, plus `allowMixedContent` in `capacitor.config.json`). iOS had
nothing.

**Two traps in the fix, both load-bearing:**

- Use **`NSAllowsArbitraryLoads` alone.** From iOS 10 on, if `NSAllowsLocalNetworking`,
  `NSAllowsArbitraryLoadsInWebContent` or `NSAllowsArbitraryLoadsForMedia` is *also* present, ATS
  **ignores `NSAllowsArbitraryLoads` entirely** and falls back to its default of `NO`. Adding the
  "safer-looking" sibling key would silently re-block `http://` and undo the fix.
- **`NSExceptionDomains` cannot be used here.** Its keys "must not be a numerical IP address", so
  it can never cover the `http://192.168.1.20:8080` the pairing screen actually asks for.
  `NSAllowsLocalNetworking` would only cover `.local` and unqualified names, not those addresses.

Apple sanctions this key for exactly this case: *"Enable this key for cases where your app allows
the user to specify connection to an arbitrary URL."* It triggers App Store review and needs
justification — irrelevant unless a store build happens (openGym deliberately has none;
`NOTICE.md` already carries the AGPL §7 app-store exception).

`NSLocalNetworkUsageDescription` is the separate iOS 14+ local-network privacy prompt, not an ATS
key.

## What must happen on a Mac (cannot be done here)

Prerequisites, per `docs/MOBILE.md`: **Xcode 15+**, **CocoaPods** (`brew install cocoapods`), Node 20+.

```bash
git clone <your fork> && cd openGym/frontend
npm ci
npm run build:mobile     # the real script — works on macOS, runs `pod install` via cap sync
npx cap open ios         # opens Xcode
```

Then in Xcode:

1. Select the **App** target → **Signing & Capabilities** → set **Team** to your Apple ID.
   The bundle id is `ch.duartesantos.opengym`; change it to your own if it collides.
2. Pick your iPhone as the destination and Run.
3. **Free Apple ID signatures expire after 7 days** — re-run from Xcode to renew, or use
   **AltStore** to automate re-signing over Wi-Fi. There is no `.ipa` download that just installs.

Layout already verified as consistent: `IPHONEOS_DEPLOYMENT_TARGET = 15.5` (matches the Podfile's
`platform :ios, '15.5'`), `PRODUCT_BUNDLE_IDENTIFIER = ch.duartesantos.opengym` (matches
`capacitor.config.json`'s `appId`), `SWIFT_VERSION = 5.0`. `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`
are placeholders (`1.0`/`1`) that the CI job overrides.

### Sanity-check the plist first

`plutil -lint ios/App/App/Info.plist` — it is valid XML (checked here), but Xcode's own linter is
the authority.

### The CI route (optional, needs a Mac runner)

`.gitlab-ci.yml` has a `build:ios` job that produces an **unsigned** `.ipa` for AltStore/Sideloadly.
It is **dormant and has never run**: it is gated on the `IOS_RUNNER_TAG` CI variable, and no Mac
runner is registered. Register a Mac as a project runner (shell executor, Xcode + CocoaPods + Node,
tag it e.g. `macos`), set `IOS_RUNNER_TAG=macos`, and the job appears in the next `main`/tag
pipeline. Upstream's own comment: *"treat the script as the plan it is: it has not been through a
pipeline yet"* — expect a first round of fixes. A signed build (TestFlight/App Store) would
additionally need an Apple Developer Program membership, the distribution certificate and profile
as protected file variables, and an `-exportArchive` step; none of that exists.

## Building it on GitHub instead of owning a Mac

**Yes — and this beats upstream's own arrangement.** The reason `.gitlab-ci.yml`'s `build:ios`
has never run is that gitlab.com's hosted macOS runners are a Premium/Ultimate feature. GitHub's
billing docs say the opposite: *"GitHub Actions usage is **free** for self-hosted runners and for
**public repositories** that use standard GitHub-hosted runners."* A standard `macos-*` runner is
one of those, so on a **public** repo the macOS build costs nothing and needs no runner
registration. (On a *private* repo macOS minutes are billed at a multiplier against the plan's
included minutes — still possible, just not free.)

Added: **`.github/workflows/ios.yml`**. Triggers: the manual **Run workflow** button, `v*` tags,
and path-filtered pull requests (which build but do not keep the artifact). It produces the same
`openGym-<version>-unsigned.ipa` + `.sha256` the GitLab job intended, from the same two numbers
(`package.json` version, Android `versionCode`) — here `1.4.1` / `26`.

Verified against the runner image (`macos-15`, standard arm64, `actions/runner-images`):

| Needs | On the image |
|---|---|
| CocoaPods (for `cap sync` → `pod install`) | **1.17.0** preinstalled |
| Xcode | 16.4 default; 26.3/26.2/26.1.1/26.0.1 also installed |
| Node 22 | 22.23.2 cached |
| iOS SDKs | 18.0–18.5, 26.0–26.2 |

Also checked locally: the `versionCode` → build-number `sed` extracts `26` from
`android/app/build.gradle`, the `opengym-flavor` assertion matches the real `index.html`
(whitespace-tolerant, mirroring `check-mobile-bundle.mjs`'s own `\s+`), all action versions
(`checkout@v7`, `setup-node@v7`, `upload-artifact@v4`) are ones the repo already uses, and all six
workflows parse under the repo's own `js-yaml`.

Two things the workflow does **not** do:

- **It is unsigned.** `CODE_SIGNING_ALLOWED=NO` is what makes it buildable with no Apple account.
  AltStore/Sideloadly sign it with your Apple ID. A signed or TestFlight build needs an Apple
  Developer Program membership plus the certificate and profile as repository secrets — untestable
  from the source tree, so not guessed at here.
- **It ships the 180 px in-repo media.** The official APK is built with `APP_MEDIA_DIR` pointing
  at the maintainer's larger private copy; without it you get the size the Gym visual licence
  allows anywhere, which is legitimate but lower-resolution than the official release.

**Honest caveat:** this workflow has never executed either — I have no GitHub runner here. YAML,
action versions, runner toolchain and every local assumption are checked, but the first real run
is the first real test. Same disclaimer upstream puts on its GitLab job.

## Remaining iOS gaps (not addressed here, ranked)

1. **The rest-over alert does not fire on iOS with the screen locked.** `frontend/src/lib/rest-alert.js`
   is Android-only by construction — *"iOS has no RestAlert, and every call to it there, addListener
   included, rejects"* — and `toneNative()`/`buzzAsAlarm()` resolve `false` on iOS, so callers fall
   back to the page's own chime, which iOS never runs once the WebView is suspended. Android solves
   it with a `specialUse` foreground service + wake lock + exact alarms. See "The rest timer" above
   for the two mechanisms that replace it and which to build first.
2. **HealthKit is written, but has never been compiled or run.** `HealthPlugin.swift`,
   `App.entitlements`, the two usage strings and the `health-sync.js` branch are all in place;
   nothing on this machine can build Swift, so treat it as unverified. The entitlement also has to
   be enabled on the App ID (Xcode → Signing & Capabilities → + Capability → HealthKit), and a
   **free Apple ID may not provision HealthKit** — if signing fails on it, remove the capability and
   the two `CODE_SIGN_ENTITLEMENTS` lines and the card hides itself, because the plugin then answers
   `unsupported`. The unsigned CI `.ipa` is unaffected either way (code signing is off there).
3. **Importing weight from Apple Health is still not implemented.** The iOS plugin asks for read
   access only to find openGym's own records so it can update or remove them. Reading body mass to
   *import* weigh-ins would cover the "Apple Health weight exports" flow openGym does via CSV today
   — and would make iOS go further than write-only Health Connect.
4. **`UIRequiredDeviceCapabilities` is still `armv7`** — the stock Capacitor template value, not
   something this port introduced. Worth confirming against a real `xcodebuild archive` on the Mac
   (modern builds are arm64-only) before any distribution.
5. **The app name is not localized**, though the app ships 19 languages. There is no
   `CFBundleLocalizations` or localized `InfoPlist.strings`, so iOS shows "openGym" everywhere.
   Cosmetic.
6. **No in-app updater on iOS**, by design — `Settings.jsx` gates the updater on `isAndroid()`
   (`android && …`), so iOS correctly hides the "check for updates" card.
7. **The `build:ios` GitLab job has never executed** (see above), so that unsigned-`.ipa` path is
   unproven — the GitHub one is the working route.
8. **The Health card's iOS wording is untranslated.** The ten new strings in `Settings.jsx` fall
   back to English (`lib/i18n.js` returns the source string for a key a pack lacks), so the card is
   English in the other 18 languages until the locale packs are updated. Android's strings were
   left byte-for-byte as they were, so nothing regressed there.

## Environment caveats on this machine

Not caused by anything here — worth knowing so a red suite is not misread:

- **`src/lib/api-base.test.js` — 9 failures.** The test does `spawnSync('sh', ['…/05-check-base-path.sh'])`.
  There is no `sh` on Windows, so `status` is `null`. Environmental; green on Linux CI.
- **`scripts/check-mobile-bundle.test.mjs` — the suite fails to load** with
  `SyntaxError: Invalid or unexpected token`. Cause confirmed by bisection: the checker starts with
  a `#!/usr/bin/env node` shebang, and this checkout has `core.autocrlf=true` with no
  `.gitattributes`, so git writes it as `i/lf` → `w/crlf` (`git ls-files --eol`) and the first line
  becomes `#!/usr/bin/env node\r`, which the Vite 8 / rolldown transform rejects. A shebang-less
  copy imports fine. Linux CI checks out LF and is unaffected. **No change made** — editing the
  file would only paper over this machine's git config.

Baseline and after are identical: `Test Files 2 failed | 400 passed`, `Tests 9 failed` — against the
same two files failing now, `402 passed` / `5069 passed`. The added tests are the two iOS guards
(`ios-plist.test.js`, `ios-app.test.js`), the iOS cases in `system-bars`/`CoachSetup.cleartext`, and
`isIOS` stubs in the test mocks. **No regressions.**
