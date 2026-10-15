import ActivityKit
import Capacitor
import Foundation
import UIKit

/**
 * Starts and ends the rest's Live Activity (#296 on iOS) — the lock-screen countdown and the Dynamic
 * Island card that AppWidgets draws — and carries its buttons back to the page.
 *
 * Why so little lives here: the app already re-books the end of a rest on every change
 * (`useUI.bookRestEnd` runs at the start, on resume and on every ±15 s), which is exactly when a
 * Live Activity's range has to move. So `rest-alert.js` starts one where it arms the notification
 * and ends it where it cancels, and nothing here has to follow the clock. The countdown is the
 * system's (`Text(timerInterval:)`), and the buttons belong to RestIntents.swift, which the system
 * performs in this same process.
 *
 * `bind` is the third method and the only interesting one. A button press is performed by the app
 * whether or not a WebView is running, so RestBridge queues it; this is the other end of that queue.
 * The page calls `bind` once its listener is registered (and again every time it comes back to the
 * front), and gets everything that piled up. A press that arrives while the page *is* listening and
 * the app *is* in front is handed over immediately instead — the queue is then only a safety net for
 * the presses nobody was there to hear.
 *
 * What this deliberately does not do: track the countdown, decide anything about the rest, or know
 * what a button means. It starts what it is told to start and forwards what it is handed.
 *
 * Usage from JS (lib/rest-activity.js):
 *   registerPlugin('RestActivity').start({ countdownTitle, readyLabel, …labels, notifyTitle, notifyBody, notifySound, accentHex, inkHex, state })
 *   registerPlugin('RestActivity').end()
 *   registerPlugin('RestActivity').bind()          // + addListener('rest', …) first
 */
@objc(RestActivityPlugin)
public class RestActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RestActivityPlugin"
    public let jsName = "RestActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bind", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hold", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncWorkout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearRest", returnType: CAPPluginReturnPromise)
    ]

    /// `Any?` rather than `Activity<RestActivityAttributes>?`: naming that type in a stored property
    /// would make the property itself 16.1-only, and this class is compiled for the whole range the
    /// app supports.
    private var activity: Any?

    /// The page has a listener registered and may be handed a button press. False until it says so:
    /// a press delivered into a WebView that is still booting is a press nobody receives, and the
    /// queue in RestBridge is what makes that safe to wait out.
    private var jsListening = false
    private var observer: NSObjectProtocol?

    private struct StateIn: Decodable {
        let startAt: Double      // epoch milliseconds
        let endsAt: Double
        let totalMs: Double
        let phase: String        // "rest" | "paused" | "ready"
        let leftMs: Double
    }

    private struct StartIn: Decodable {
        let countdownTitle: String
        let readyLabel: String
        let pauseLabel: String
        let resumeLabel: String
        let minusLabel: String
        let plusLabel: String
        let skipLabel: String
        let notifyTitle: String
        let notifyBody: String
        let notifySound: Bool
        let accentHex: String
        let inkHex: String
        let state: StateIn
    }

    private struct WorkoutIn: Decodable {
        let workoutId: String
        let workoutName: String
        let workoutStartedAt: Double
        let exerciseName: String
        let nextSetLabel: String
        let targetText: String
        let completedSets: Int
        let totalSets: Int
        let accentHex: String
        let inkHex: String
        let countdownTitle: String
        let readyLabel: String
        let pauseLabel: String
        let resumeLabel: String
        let minusLabel: String
        let plusLabel: String
        let skipLabel: String
        let notifyTitle: String
    }

    @available(iOS 16.1, *)
    private func stateOf(_ activity: Activity<RestActivityAttributes>) -> RestActivityAttributes.ContentState {
        if #available(iOS 16.2, *) { return activity.content.state }
        return activity.contentState
    }

    @available(iOS 16.1, *)
    private func updateState(_ activity: Activity<RestActivityAttributes>,
                             _ state: RestActivityAttributes.ContentState) async {
        if #available(iOS 16.2, *) {
            await activity.update(ActivityContent(
                state: state,
                staleDate: state.phase == RestActivityAttributes.Phase.rest ? state.endsAt : nil))
        } else {
            await activity.update(using: state)
        }
    }

    public override func load() {
        // A button press, from RestIntents.swift, in this process. Only ever registered on the iOS
        // that has those buttons at all.
        if #available(iOS 17.0, *) {
            observer = NotificationCenter.default.addObserver(
                forName: RestBridge.changed, object: nil, queue: .main
            ) { [weak self] _ in
                self?.handOverIfLive()
            }
        }
    }

    deinit {
        if let observer = observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc public func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["started": false, "reason": "unsupported"])
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            // The user turned Live Activities off for openGym, or off everywhere. Not an error:
            // the notification is still doing the actual alerting.
            call.resolve(["started": false, "reason": "disabled"])
            return
        }
        guard let input = try? call.decode(StartIn.self) else {
            call.reject("could not read the activity to start", "failed")
            return
        }

        let attributes = RestActivityAttributes(
            countdownTitle: input.countdownTitle,
            readyLabel: input.readyLabel,
            pauseLabel: input.pauseLabel,
            resumeLabel: input.resumeLabel,
            minusLabel: input.minusLabel,
            plusLabel: input.plusLabel,
            skipLabel: input.skipLabel,
            notifyTitle: input.notifyTitle,
            notifyBody: input.notifyBody,
            notifySound: input.notifySound,
            accentHex: input.accentHex,
            inkHex: input.inkHex)
        let state = RestActivityAttributes.ContentState(
            startAt: Date(timeIntervalSince1970: input.state.startAt / 1000),
            endsAt: Date(timeIntervalSince1970: input.state.endsAt / 1000),
            totalMs: input.state.totalMs,
            phase: input.state.phase,
            leftMs: input.state.leftMs,
            notifyTitle: input.notifyTitle, notifyBody: input.notifyBody,
            notifySound: input.notifySound, restTitle: input.countdownTitle)
        // A running rest goes stale when it ends, which is how the card says "Ready" with the app
        // suspended; a held one has no end to go stale at (RestIntents.swift, RestBridge.staleDate).
        let stale = state.phase == RestActivityAttributes.Phase.rest ? state.endsAt : nil

        Task { @MainActor in
            // Update the rest inside the existing workout card so elapsed time and set
            // progress survive the rest phase.
            if let current = Activity<RestActivityAttributes>.activities.first {
                var next = self.stateOf(current)
                next.startAt = state.startAt
                next.endsAt = state.endsAt
                next.totalMs = state.totalMs
                next.phase = RestActivityAttributes.Phase.rest
                next.leftMs = state.leftMs
                next.notifyTitle = state.notifyTitle
                next.notifyBody = state.notifyBody
                next.notifySound = state.notifySound
                next.restTitle = state.restTitle
                await self.updateState(current, next)
                call.resolve(["started": true])
                return
            }
            do {
                if #available(iOS 16.2, *) {
                    activity = try Activity.request(
                        attributes: attributes,
                        content: ActivityContent(state: state, staleDate: stale),
                        pushType: nil)
                } else {
                    activity = try Activity.request(attributes: attributes, contentState: state, pushType: nil)
                }
                call.resolve(["started": true])
            } catch {
                call.reject(error.localizedDescription, "failed")
            }
        }
    }

    // The same ActivityKit card stays visible from workout start to workout finish.
    @objc public func syncWorkout(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { call.resolve(["synced": false]); return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.resolve(["synced": false, "reason": "disabled"]); return
        }
        guard let input = try? call.decode(WorkoutIn.self), !input.workoutId.isEmpty else {
            call.reject("invalid workout snapshot"); return
        }
        Task { @MainActor in
            if let current = Activity<RestActivityAttributes>.activities.first,
               self.stateOf(current).workoutId == input.workoutId {
                var state = self.stateOf(current)
                state.workoutName = input.workoutName
                state.workoutStartedAt = Date(timeIntervalSince1970: input.workoutStartedAt / 1000)
                state.exerciseName = input.exerciseName
                state.nextSetLabel = input.nextSetLabel
                state.targetText = input.targetText
                state.completedSets = input.completedSets
                state.totalSets = input.totalSets
                await self.updateState(current, state)
                call.resolve(["synced": true])
                return
            }
            await self.endAll()
            let attributes = RestActivityAttributes(
                countdownTitle: input.countdownTitle, readyLabel: input.readyLabel,
                pauseLabel: input.pauseLabel, resumeLabel: input.resumeLabel,
                minusLabel: input.minusLabel, plusLabel: input.plusLabel,
                skipLabel: input.skipLabel, notifyTitle: input.notifyTitle,
                notifyBody: "", notifySound: false,
                accentHex: input.accentHex, inkHex: input.inkHex)
            let now = Date()
            let state = RestActivityAttributes.ContentState(
                startAt: now, endsAt: now, totalMs: 0,
                phase: RestActivityAttributes.Phase.workout, leftMs: 0,
                workoutId: input.workoutId, workoutName: input.workoutName,
                workoutStartedAt: Date(timeIntervalSince1970: input.workoutStartedAt / 1000),
                exerciseName: input.exerciseName, nextSetLabel: input.nextSetLabel,
                targetText: input.targetText, completedSets: input.completedSets,
                totalSets: input.totalSets)
            do {
                if #available(iOS 16.2, *) {
                    activity = try Activity.request(attributes: attributes,
                        content: ActivityContent(state: state, staleDate: nil), pushType: nil)
                } else {
                    activity = try Activity.request(attributes: attributes, contentState: state, pushType: nil)
                }
                call.resolve(["synced": true])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // Cancel only rest; if a workout exists, it returns to the next-set view.
    @objc public func clearRest(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { call.resolve(["cleared": false]); return }
        Task { @MainActor in
            guard let current = Activity<RestActivityAttributes>.activities.first else {
                call.resolve(["cleared": true]); return
            }
            var state = self.stateOf(current)
            if state.workoutId.isEmpty {
                await self.endAll()
            } else {
                state.phase = RestActivityAttributes.Phase.workout
                state.leftMs = 0
                await self.updateState(current, state)
            }
            call.resolve(["cleared": true])
        }
    }

    // A diagnostics endpoint so the app can distinguish disabled Live Activities from
    // an unavailable bridge and from an extension that fails to render on-device.
    @objc public func status(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["supported": false, "enabled": false, "activeCount": 0])
            return
        }
        call.resolve([
            "supported": true,
            "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
            "activeCount": Activity<RestActivityAttributes>.activities.count,
        ])
    }

    // Pause from openGym's in-app rest bar: leave the card and Resume control visible.
    // The old implementation ended the entire Live Activity on every pause.
    @objc public func hold(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["held": false]); return
        }
        let leftMs = max(0, call.getDouble("leftMs") ?? 0)
        let totalMs = max(leftMs, call.getDouble("totalMs") ?? leftMs)
        Task { @MainActor in
            guard let current = Activity<RestActivityAttributes>.activities.first else {
                call.resolve(["held": false]); return
            }
            var state: RestActivityAttributes.ContentState
            if #available(iOS 16.2, *) {
                state = current.content.state
            } else {
                state = current.contentState
            }
            state.phase = RestActivityAttributes.Phase.paused
            state.leftMs = leftMs
            state.totalMs = totalMs
            if #available(iOS 16.2, *) {
                await current.update(ActivityContent(state: state, staleDate: nil))
            } else {
                await current.update(using: state)
            }
            call.resolve(["held": true])
        }
    }

    @objc public func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["ended": false])
            return
        }
        Task { @MainActor in
            await self.endAll()
            call.resolve(["ended": true])
        }
    }

    /**
     * "There is a page listening." Everything a button did while there was not one comes back from
     * here, oldest first, each in the shape the Android notification's own buttons already send
     * (useUI's bindNativeRest). Asked again on every return to the front: a press that happened while
     * the phone was locked arrives then.
     */
    @objc public func bind(_ call: CAPPluginCall) {
        guard #available(iOS 17.0, *) else {
            call.resolve(["bound": false])
            return
        }
        jsListening = true
        // Everything here was performed while there was no page to hear it — the app was locked,
        // suspended or not running yet — and on the way back up the page has just re-armed the rest
        // from the copy it saved before (restoreRest): the state the button was pressed to change.
        // `live: false` is what tells it to book the end again from the timer this leaves behind.
        handOver(live: false)
        call.resolve(["bound": true])
    }

    /// Only when it will really be received: a page listening *and* an app in front. Otherwise the
    /// press stays queued and the next `bind` brings it — the same command, a moment later, never
    /// twice (drain is the only reader, and it empties the queue).
    @available(iOS 17.0, *)
    private func handOverIfLive() {
        guard jsListening, UIApplication.shared.applicationState == .active else { return }
        // The app was in front, so the page is running and the button already moved the card *and*
        // the notification for the end in RestIntents. Nothing left for the page to book: `live`.
        handOver(live: true)
    }

    @available(iOS 17.0, *)
    private func handOver(live: Bool) {
        for var command in RestBridge.drain() {
            command["live"] = live
            notifyListeners("rest", data: command)
        }
    }

    @available(iOS 16.1, *)
    @MainActor
    private func endAll() async {
        if let mine = activity as? Activity<RestActivityAttributes> {
            await mine.end(using: nil, dismissalPolicy: .immediate)
            activity = nil
        }
        // Also anything a previous launch left behind — a card outliving its rest is worse than no
        // card, and openGym only ever has one.
        for other in Activity<RestActivityAttributes>.activities {
            await other.end(using: nil, dismissalPolicy: .immediate)
        }
    }
}
