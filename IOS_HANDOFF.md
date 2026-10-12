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
| `frontend/src/lib/rest-alert.js` | **The iOS branch**: books the end of a rest as one local notification via `@capacitor/local-notifications`, plus the single cached `platform()` read and the `nativeEndTone()` flag. Part B added `body` (the notification's one line, built once and handed to the Live Activity verbatim) and `bindNativeRest` also binding the card's buttons. |
| `frontend/src/store/useUI.js` | `endTone` stays quiet on iOS while that notification is armed, so a rest cannot ring twice. Part B: `resyncAfterRestButton` re-books the alert for a press the app was not in front for. |
| `frontend/src/lib/rest-activity.js` | **New.** The Live Activity's JS half: start it with the rest's span and its words, end it, and carry the card's button presses back to the page. |
| `frontend/ios/App/App/RestActivityAttributes.swift` | **New.** The shared attributes: what the card shows, what its buttons say, and the notification's own words for a button that has to move it. |
| `frontend/ios/App/App/RestIntents.swift` | **New.** The four buttons (Pause/Resume, −15 s, +15 s, Skip) as `LiveActivityIntent`s, which the system performs **in the app's process**; the queue a press waits in when no page is listening. |
| `frontend/ios/App/App/RestActivityPlugin.swift` | **New.** `start`/`end` the card, and `bind` — the handshake that hands a queued press to the page, with `live` saying whether the app was in front for it. |
| `frontend/ios/App/AppWidgets/` | **New target.** `RestWidgetBundle.swift` (the lock-screen card and the Dynamic Island, buttons included) + `AppWidgetsInfo.plist`. |
| `frontend/ios/App/App/HapticsPlugin.swift` | **New.** iOS's half of Settings → Vibrate: CoreHaptics where the hardware has it, the system vibrate behind it. |
| `frontend/src/lib/sound.js` | `vibrateSupported()` is true in the iPhone app (the WebView cannot buzz; the phone can), and `vibrate()` routes to that plugin there. |
| `frontend/ios/App/App.xcodeproj/project.pbxproj` | The files above, the new AppWidgets target and its embed phase — and `IPHONEOS_DEPLOYMENT_TARGET` **15.5 → 16.1** (see "The one product decision"). |
| `frontend/ios/App/Podfile` | The same 16.1, in the platform line and the post-install block. |
| `.github/workflows/ios.yml` | The packaging step now also asserts the appex is embedded and that both bundles carry App Intents metadata — the two failures that are silent on a phone. |
| `frontend/src/lib/ios-plist.test.js` | **New.** 14 tests guarding the plist keys (including `NSSupportsLiveActivities`). |
| `frontend/src/lib/ios-app.test.js` | **New.** 24 tests guarding the Xcode project, the widget target, the shared-file rule, the entitlement, the two numbers two languages agree on, and `override` on Capacitor's own methods. |
| `frontend/src/lib/rest-activity.test.js` | **New.** The card's binding half: listen before binding, hand every press over, ask again on every return to the front. |
| tests: `system-bars`, `rest-alert.native`, `useUI.native-rest`, `useUI.silent-buzz`, `sound`, `CoachSetup.cleartext`, `CoachSetup.flow`, 9 × `Settings.*` | Mocks gained `isIOS` / `nativeEndTone` / `iosRestAlert`; iOS cases added. |

Android behaviour is deliberately **unchanged** throughout.

## The rest timer — parts A and B

**A. The alert works on iOS.** No native plugin was needed: `@capacitor/local-notifications`
was already a dependency and already schedules on iOS, so `lib/rest-alert.js` gained an iOS branch
that books one local notification for the end of the rest. `armRestAlert` reports success on iOS,
`disarmRestAlert`/`holdRestAlert` cancel it, and the permission is asked once through the same
plugin the workout reminder already used.

Two details that are easy to get wrong, both handled:

- **The sound.** `@capacitor/local-notifications` sets a sound only when one is *named*
  (`LocalNotificationsPlugin.swift`), so omitting it means **silence** on iOS. The notification
  names a sound file the app does not bundle, on purpose — `UNNotificationSound(named:)` falls back
  to the system sound when it cannot find the file. With Settings → Sound off, nothing is named and
  the alert is silent. **The chosen tone (chime / bell / beep / whistle / soft) still cannot play
  while the app is suspended** — that needs those six rendered to audio files the app bundles, and
  it is the one item from part A's list still open.
- **A double ring.** Capacitor presents a notification delivered to a *foreground* app **with** its
  sound (`LocalNotificationsHandler.willPresent` returns `.sound, .alert`), while Android's native
  side deliberately stays quiet in front (`RestAlertPlugin.appInFront`) and lets the page's chime be
  the only sound. So on iOS the page must not also chime: `nativeEndTone()` reports whether a
  notification is armed that will really make a noise, and `useUI.endTone` returns early on it. It
  is false when permission was refused (nothing will sound, so the page's chime has to stand in)
  and false during a timed hold (`startWork` → `stopRest` → `disarmRestAlert`).

**B. The lock-screen countdown, the Dynamic Island, and the buttons — built.** An ActivityKit Live
Activity (iOS 16.1+) drawn by a new **AppWidgets** widget-extension target, with four interactive
buttons on it (iOS 17+).

What it is made of, and why each piece is where it is:

| Piece | What it does |
|---|---|
| `RestActivityAttributes.swift` (both targets) | The card's content and its fixed words. ActivityKit hands the same `ContentState` to the app and to the widget extension, so the file is compiled into **both** Sources phases — a file in one target only is a type the other cannot see. |
| `AppWidgets/RestWidgetBundle.swift` | The drawing. The clock and the bar are the system's own timers (`Text(timerInterval:)`, `ProgressView(timerInterval:)`), which keep running while the app is suspended. Buttons only in the two presentations Apple allows them in: the lock-screen card and the **expanded** Dynamic Island. |
| `RestIntents.swift` (both targets) | The four buttons as `LiveActivityIntent`s. Apple is explicit that these are performed **in the app's process** and must be in the **app target** — which is the whole reason a tap can move the card, move the notification and tell the page. |
| `RestActivityPlugin.swift` | `start`/`end`, and `bind`: the handshake that hands a press to the page when there is one, and leaves it queued when there is not. |

Four decisions worth knowing, because each one is a trap:

- **No App Group.** The obvious design shares the timer between the widget extension and the app
  through an App Group. It is not needed: a `LiveActivityIntent` runs *in the app*, so the queue is
  the app's own `UserDefaults` and the extension never reads it. An App Group would add an
  entitlement to both targets and therefore a provisioning profile that carries it — real risk on a
  free Apple ID — for nothing.
- **A press is queued, not delivered.** A button can be pressed with the app suspended, or not
  running at all. So the intent (1) moves the Live Activity, (2) moves or cancels the local
  notification for the end, (3) queues the same change, in the shape Android's notification buttons
  already send (`RestAlertPlugin.emit`). The page gets it through `bind()` — at startup and on every
  return to the front — or immediately if it is listening *and* the app is in front. One field
  Android never sends travels with it: `live`, which says whether the app was there for the press.
  A press it was not there for arrives after the app has re-armed the rest from its own saved copy
  (`restoreRest`) — the state the button was pressed to change — so the app books the end again from
  the timer the press left behind (`useUI.resyncAfterRestButton`). A press it *was* there for has
  already moved everything natively, and re-booking it would restart a card the user is looking at.
- **"Ready" while suspended — the spec's P0 — is the stale date, not an update.** Nothing can wake
  the app to redraw the card at 0:00, so the content is given `staleDate: endsAt` and the widget
  draws the Ready face off `context.isStale`. The system redraws around then anyway, because its own
  countdown has run out. This is the one behaviour here that no test can prove: it depends on
  WidgetKit re-rendering at the stale date, which it should and which only a phone can confirm.
- **The notification's words are not rebuilt in Swift.** A button that moves the end re-books the
  notification with the title and body the app gave it, verbatim, because the copy belongs to the
  app's i18n and Swift has no business re-deriving it. The visible consequence is small and honest:
  a rest given another 15 s from the lock screen keeps the length it started with in that one line
  of text. The card, which is what is actually counting down, is exact.

**On a locked phone the buttons need an unlock.** Apple's own wording: *"On a locked device, buttons
and toggles are inactive and the system doesn't perform actions unless a person authenticates and
unlocks their device."* That is iOS's rule, not a gap here. In the Dynamic Island, with the phone
already unlocked, a tap works directly.

### The one product decision part B forced

**The app's minimum iOS is now 16.1, not 15.5** (`IPHONEOS_DEPLOYMENT_TARGET` in the project and
`platform :ios` in the Podfile — one setting written twice, both changed together).

The reason is not the card, which is ActivityKit and 16.1 anyway. It is the **buttons**: they need
App Intents, and App Intents does not compile below iOS 16 at all — with a 15.5 target, `import
AppIntents` in the app target is a build error, and a silently missing `Metadata.appintents` is a
card whose buttons do nothing. There is no version of "buttons on the Live Activity" that keeps
iOS 15.

What that costs: iPhone 6s, iPhone 7 and the first SE, which can run iOS 15 but not 16, can no
longer install the app. Everything else in openGym — the web app, Android — is untouched. If that
trade is not wanted, the buttons are the thing to drop, not the deployment target: remove
`RestIntents.swift` from both targets, the `Button(intent:)` row in the widget, and put the two
numbers back to 15.5. The card itself would keep working on 16.1+.

### Vibrate now works on an iPhone

The second thing that was asked for, and a genuine bug rather than a platform limit: iOS has no
`navigator.vibrate`, so Settings → Vibrate read *"Not on iPhone"* and the switch could not be
turned on — in Settings and in the workout sheet's Timer alerts. An iPhone can buzz; it has to be
asked from native code. `HapticsPlugin.swift` is that (CoreHaptics for iPhone 8 and later, so
`navigator.vibrate`'s on/off pattern is reproduced as it means: `[200, 100, 200]` is buzz-pause-buzz;
`AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)` is the floor for older hardware, an iPad, or
an engine that will not start in Low Power Mode).

`vibrateSupported()` is true in the iPhone **app** and false in Safari on an iPhone, which is the
honest line: the WebView still cannot buzz, the app can. Android is unchanged, including the
separate "Vibrate on silent too" row, which stays Android-only.

Haptics stop when iOS suspends the app, so a rest that ends with the phone locked is still the
notification's job — and iOS buzzes for that one itself, as the user's own notification haptics.

### One trap for whoever does C.** `lib/rest-alert.js` used to call `mobile.js`'s `isAndroid()` /
`isIOS()` at every decision point. That is now a single cached `platform()` read, because several
`await import('@capacitor/core')` calls inside one arm/hold/disarm cycle produced a genuinely
reproducible wrong answer — an iOS arm resolving down the Android branch and returning `false`.
Whatever the exact interleaving, one read cannot disagree with itself. `iosRestAlert()` is the same
read, exposed for `useUI`.

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

**First CI run — done, and it failed usefully.** The workflow executed on 2026-10-12 on
`github.com/vinayakgupta62/openGym`. Everything up to and including Swift compilation worked:
`npm ci`, the `VITE_MOBILE=1` build, media staging, `cap sync` (CocoaPods 1.17.0 ran `pod install`
for real), the `check-mobile-bundle` guard, and `xcodebuild` reaching `SwiftCompile` for all five
app sources. It stopped on one error:

```
App/HealthPlugin.swift:121:23: error: overriding declaration requires an 'override' keyword
    @objc public func requestPermissions(_ call: CAPPluginCall)
Capacitor.CAPPlugin.requestPermissions: note: overridden declaration is here
```

`CAPPlugin` already declares `requestPermissions(_:)` as the default hook of Capacitor 3's
permission pattern (`CAPPlugin.h` line 33), so answering that name is an override. Fixed by adding
`override`, and `import UIKit` alongside it for `UIApplication` in `openSettings()` — a Swift module
does not inherit another module's imports, and only `import Capacitor`/`import HealthKit` were
there. Now guarded by a test that reads `CAPPlugin.h` and asserts any `pluginMethods` name Capacitor
already declares carries `override` — the compiler's question, asked from JS. Verified by removing
the keyword and watching the guard fail, then restoring.

Two things the failure confirmed for free: the hand-rolled `project.pbxproj` entries are correct
(both new Swift files were compiled, in the right target), and **the HealthKit entitlement did not
break the unsigned build** — the archive never reached a signing step, exactly as predicted.

## Remaining iOS gaps (ranked)

1. **The chosen end tone cannot play on iOS while the app is suspended.** The alert is audible — it
   uses the system notification sound — but a notification's sound has to be a bundled audio file,
   and the six tones in `lib/rest-sounds.js` exist only as Web Audio and `RestTone.java`. Rendering
   them to WAV (or CAF) for the app bundle, and naming the chosen one in the notification, would
   close it. This is the last item of part A's list, and the only one left.
2. **"Ready" on a suspended phone is a mechanism, not a verified behaviour.** The card goes stale at
   `endsAt` and the widget draws Ready off `context.isStale` (part B above). It rests on WidgetKit
   re-rendering at the stale date, which is what the system's own countdown does, but nothing here
   can prove it: start a rest, lock the phone, and watch whether the card says Ready at 0:00 or sits
   at 0:00 until the app is opened.
3. **Live Activities can be switched off**, per app, in iOS Settings. The app asks and then treats a
   refusal as "no card" (`RestActivityPlugin` resolves `started: false` and nothing is surfaced),
   which is right — the notification is still the alert — but no row in Settings says where to turn
   it on.
4. **HealthKit compiles, but has never run.** The first CI run got `HealthPlugin.swift` through
   `SwiftCompile` — the reported error was the only one in the file — so it is at least
   type-correct. Nothing has exercised HealthKit at runtime: authorization, the sync-identifier
   replacement, and the remove-by-query path are all unproven. The entitlement also has to be
   enabled on the App ID (Xcode → Signing & Capabilities → + Capability → HealthKit), and a
   **free Apple ID may not provision HealthKit** — if signing fails on it, remove the capability and
   the two `CODE_SIGN_ENTITLEMENTS` lines and the card hides itself, because the plugin then answers
   `unsupported`. The unsigned CI `.ipa` is unaffected either way (code signing is off there).
5. **Importing weight from Apple Health is still not implemented.** The iOS plugin asks for read
   access only to find openGym's own records so it can update or remove them. Reading body mass to
   *import* weigh-ins would cover the "Apple Health weight exports" flow openGym does via CSV today
   — and would make iOS go further than write-only Health Connect.
6. **`UIRequiredDeviceCapabilities` is still `armv7`** — the stock Capacitor template value, not
   something this port introduced. Worth confirming against a real `xcodebuild archive` on the Mac
   (modern builds are arm64-only) before any distribution.
7. **The app name is not localized**, though the app ships 19 languages. There is no
   `CFBundleLocalizations` or localized `InfoPlist.strings`, so iOS shows "openGym" everywhere.
   Cosmetic.
8. **No in-app updater on iOS**, by design — `Settings.jsx` gates the updater on `isAndroid()`
   (`android && …`), so iOS correctly hides the "check for updates" card.
9. **The `build:ios` GitLab job has never executed** (see above), so that unsigned-`.ipa` path is
   unproven — the GitHub one is the working route.
10. **The Health card's iOS wording is untranslated.** The ten new strings in `Settings.jsx` fall
   back to English (`lib/i18n.js` returns the source string for a key a pack lacks), so the card is
   English in the other 18 languages until the locale packs are updated. Android's strings were
   left byte-for-byte as they were, so nothing regressed there.

The four button labels on the card are *not* on that list: they come from the app's own translations
(`buildRestAlert`'s `pause`/`resume`/`minus`/`plus`/`skip`, the same words Android's notification
actions use), handed to the widget through the attributes. Only the `LiveActivityIntent` *titles* are
English, and `isDiscoverable = false` keeps them out of Shortcuts and Spotlight — nothing a user
reads.

## The honest test on the phone

Everything below is JavaScript-verified here; none of it has run on a device. In the order worth
trying:

1. **The countdown appears at all.** Start a rest → lock the phone. The card should be on the lock
   screen counting down, with the bar in the user's accent, and the Dynamic Island should show it
   with the app open.
2. **The alert still fires** (part A, unchanged): the notification at the end, with sound.
3. **It does not ring twice** with the app open. If it does, `nativeEndTone()` is not reporting what
   it thinks it is.
4. **Ready at 0:00** (gap 2 above): does the card flip to Ready on its own, or sit at 0:00?
5. **The buttons.** On the lock screen they need an unlock first (iOS's rule). In the Dynamic Island
   they are direct: Pause should hold the clock and flip to Resume, ±15 s should move it, Skip
   should take the card down.
6. **The buttons reach the app.** Tap +15 s on the lock screen, then open the app: the bar should be
   where the card said it was, not 15 seconds behind it. This is the queue + `bind()` path, and it
   is the piece with the most moving parts.
7. **Vibrate.** Settings → When a rest ends → Vibrate should now be switchable on an iPhone (it used
   to read "Not on iPhone"), and the end of a rest with the app open should buzz.

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
- **Vitest cannot start at all under the DSH file sandbox**: loading `vite.config.js` runs Vite's
  Windows network-drive check (`child_process.exec('net use')`), which the sandbox refuses with
  `spawn EPERM`. Not a repo problem; the suite needs the sandbox off.

Baseline and after, same two files failing: `Test Files 2 failed | 403 passed`, `Tests 9 failed |
5105 passed` — against part A's `402 passed` / `5069 passed` (and `400` / `5069` before it). The 36
new tests are the Live Activity and its buttons (`rest-activity.test.js`, the new cases in
`rest-alert.native.test.js` and `useUI.native-rest.test.js`), the haptics block in `sound.test.js`,
the `NSSupportsLiveActivities` guard, and the widget/intents half of `ios-app.test.js`. **No
regressions.**

One test earned its keep before the build ever ran: `ios-app.test.js` caught
`RestActivityPlugin.swift` missing from the app target's Sources phase — a plugin file that compiles
nothing, so the card's buttons would have been inert on the phone with every JS test still green.
