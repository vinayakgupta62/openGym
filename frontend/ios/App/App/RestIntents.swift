import ActivityKit
import AppIntents
import Foundation
import UserNotifications

/**
 * The rest card's own buttons (#296 on iOS): Pause/Resume, −15 s, +15 s and Skip, on the lock
 * screen and in the expanded Dynamic Island.
 *
 * Why this file exists at all, when the countdown itself needed no Swift: a Live Activity's buttons
 * need **App Intents**, and Apple is specific about which ones — *"If you adopt the LiveActivityIntent
 * or AudioPlaybackIntent protocol, the system runs the app intent in the app's process. Make sure to
 * add your custom app intent to your app target."* (`Adding interactivity to widgets and Live
 * Activities`). That is the whole reason a tap can do something here: the intent runs **in the app**,
 * so it can update the activity (only the app may), move the local notification that announces the
 * end, and hand the same change to the WebView when there is one running.
 *
 * The file is compiled into **both** targets, like RestActivityAttributes.swift: the system performs
 * it in the app, but the widget extension is what names the types in its `Button(intent:)`s and
 * cannot call a type it cannot see. Between them, the app target is the one that matters at runtime.
 *
 * Two things are deliberately not shared between the two processes, because they do not need to be:
 *
 *  - **No App Group.** A `LiveActivityIntent` runs in the app, so the queue below is the app's own
 *    `UserDefaults` and the widget extension never reads it. An App Group would add an entitlement
 *    to both targets, and therefore a provisioning profile that carries it — for nothing.
 *  - **No copy of its own.** Every word on the card, and the notification's own title and body, came
 *    from JavaScript (lib/rest-activity.js → the attributes). The one thing this file decides is
 *    *arithmetic*: where the end moves to when a button is pressed.
 *
 * What each button does, in order, because the order is the point:
 *
 *  1. Move the Live Activity — that is the feedback the user is looking at.
 *  2. Move or cancel the local notification for the end (RestBridge.notify). Without this, a rest
 *     the user just gave another 15 seconds to would still ring at the old time, and one they paused
 *     would ring at all.
 *  3. Queue the same change for the app's own timer, which may be suspended or gone entirely.
 *
 * Nothing here runs on iOS 16.1–16.x: `Button(intent:)` is iOS 17, and `AppIntents` refuses to
 * compile below iOS 16 at all (which is why this app's deployment target had to move — see
 * IOS_HANDOFF.md). On an older iOS the card is exactly what it was before it had buttons.
 */

/// The queue, the notification and the arithmetic the four intents share. Everything the app needs
/// to know about a button press, in one place.
@available(iOS 17.0, *)
enum RestBridge {
    /// lib/rest-alert.js REST_ALERT_ID, and the identifier `@capacitor/local-notifications` files the
    /// request under (`"\(notification["id"])"` — LocalNotificationsPlugin.swift). Pinned by a test
    /// on the JS side, which reads this file.
    static let notificationID = "42"
    /// lib/rest-alert.js IOS_SOUND: a name nothing answers to, on purpose, so
    /// `UNNotificationSound(named:)` falls back to the system sound without shipping an audio file.
    /// Re-scheduling the notification from here has to name the same thing.
    static let soundName = "opengym-rest"
    /// Where a button press waits for a WebView that is not there to hear it.
    static let queueKey = "opengym_rest_commands"
    /// Posted by a button, observed by RestActivityPlugin. Only ever in the app's own process.
    static let changed = Notification.Name("openGymRestCommand")
    /// A phone left on the lock screen through a whole workout cannot grow this without bound. Ten
    /// rests' worth of taps is already far past what any of this is for.
    static let queueLimit = 20

    // MARK: - The activity

    /// The one rest this app has running (`useUI` keeps one timer, and the plugin ends anything a
    /// previous launch left behind).
    static func current() -> Activity<RestActivityAttributes>? {
        Activity<RestActivityAttributes>.activities.first
    }

    /**
     * The paused face is not stale and must not be drawn as Ready: while it is held, `leftMs` is the
     * truth and there is no end to count down to. While it runs, the content goes stale exactly when
     * the rest ends — that is what turns the card into "Ready" without anything having to wake up.
     */
    static func staleDate(_ state: RestActivityAttributes.ContentState) -> Date? {
        state.phase == RestActivityAttributes.Phase.rest ? state.endsAt : nil
    }

    static func update(_ activity: Activity<RestActivityAttributes>,
                       _ state: RestActivityAttributes.ContentState) async {
        await activity.update(ActivityContent(state: state, staleDate: staleDate(state)))
    }

    // MARK: - The notification

    /// Re-book the end of the rest with the same words the app gave it (the attributes), at a new
    /// time. `@capacitor/local-notifications` schedules a one-shot with a time-interval trigger
    /// (LocalNotificationsPlugin.swift), which is what this mirrors; the identifier is the same, so
    /// this replaces the pending request rather than adding a second one.
    static func rescheduleNotification(_ attributes: RestActivityAttributes,
                                       state: RestActivityAttributes.ContentState, at date: Date) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [notificationID])
        let interval = date.timeIntervalSinceNow
        guard interval > 0 else { return }
        let content = UNMutableNotificationContent()
        content.title = state.notifyTitle.isEmpty ? attributes.notifyTitle : state.notifyTitle
        content.body = state.notifyBody.isEmpty ? attributes.notifyBody : state.notifyBody
        if state.notifySound {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: soundName))
        }
        center.add(UNNotificationRequest(
            identifier: notificationID,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, interval), repeats: false)))
    }

    /// A held rest has no end to announce, and a skipped one is over: both take the notification
    /// down, delivered ones included — the same pair of calls `@capacitor/local-notifications` makes
    /// for `LocalNotifications.cancel`.
    static func cancelNotification() {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [notificationID])
        center.removeDeliveredNotifications(withIdentifiers: [notificationID])
    }

    // MARK: - The app

    /**
     * What the app's own timer has to be told, in the shape the Android notification's buttons
     * already send it (RestAlertPlugin.emit / useUI's bindNativeRest): the same `type`, the same
     * millisecond fields, `paused` carrying both "Pause" and "Resume". So a button press from the
     * lock screen lands in the app through the same code path as one from the notification shade.
     */
    static func enqueue(_ type: String, _ state: RestActivityAttributes.ContentState?, paused: Bool) {
        let left = max(0, state?.leftMs ?? 0)
        let command: [String: Any] = [
            "type": type,
            "leftMs": left,
            "totalMs": max(state?.totalMs ?? 0, left),
            // When it is held, when it ends is not a thing that exists — and the app's own paused
            // path ignores this field, exactly as it does for Android's.
            "endsAt": paused ? 0.0 : (state.map { $0.endsAt.timeIntervalSince1970 * 1000 } ?? 0),
            "paused": paused,
            "at": Date().timeIntervalSince1970 * 1000,
        ]
        let defaults = UserDefaults.standard
        var queue = defaults.array(forKey: queueKey) as? [[String: Any]] ?? []
        queue.append(command)
        if queue.count > queueLimit { queue.removeFirst(queue.count - queueLimit) }
        defaults.set(queue, forKey: queueKey)
        NotificationCenter.default.post(name: changed, object: nil)
    }

    /// Everything queued since the last time a WebView was listening, oldest first, and forget it.
    /// Called by the plugin, which is the only reader.
    static func drain() -> [[String: Any]] {
        let defaults = UserDefaults.standard
        let queue = defaults.array(forKey: queueKey) as? [[String: Any]] ?? []
        defaults.removeObject(forKey: queueKey)
        return queue
    }

    // MARK: - What the buttons do

    /// Pause, or carry on from where the pause held it — one button, two faces, as on Android.
    static func togglePause() async {
        guard let activity = current() else { return }
        var state = activity.content.state
        if state.isPaused {
            let left = max(0, state.leftMs) / 1000
            let endsAt = Date().addingTimeInterval(left)
            state.phase = RestActivityAttributes.Phase.rest
            state.endsAt = endsAt
            state.startAt = endsAt.addingTimeInterval(-state.totalMs / 1000)
            await update(activity, state)
            rescheduleNotification(activity.attributes, state: state, at: endsAt)
            enqueue("pause", state, paused: false)
        } else {
            let left = state.endsAt.timeIntervalSinceNow * 1000
            // A rest that is already over has nothing to hold, and the app ignores a pause then too
            // (useUI.pauseRest returns early on a Ready timer), so the card does not move either.
            guard left > 0 else { return }
            state.leftMs = left
            state.phase = RestActivityAttributes.Phase.paused
            await update(activity, state)
            cancelNotification()
            enqueue("pause", state, paused: true)
        }
    }

    /**
     * ±15 s, which is `useUI.addRest`'s arithmetic and not a second version of it: what is left
     * moves by `seconds`, the whole rest grows if that is now longer than it was, and taking off
     * more than is left means "I'm ready now" — so that ends the rest rather than leaving a negative
     * countdown behind. A rest that has already run out is the same case with nothing left to take
     * off, so +15 s opens it again for fifteen seconds.
     *
     * While the rest is held there is no end to move and nothing scheduled: the time is simply held
     * at the new figure, and the resume that follows books the end.
     */
    static func adjust(by seconds: Double) async {
        guard let activity = current() else { return }
        var state = activity.content.state
        if state.isPaused {
            let left = state.leftMs + seconds * 1000
            if left <= 0 { await skip(); return }
            state.leftMs = left
            state.totalMs = max(state.totalMs, left)
            await update(activity, state)
            enqueue("adjust", state, paused: true)
            return
        }
        let left = max(0, state.endsAt.timeIntervalSinceNow) * 1000 + seconds * 1000
        if left <= 0 { await skip(); return }
        let endsAt = Date().addingTimeInterval(left / 1000)
        state.phase = RestActivityAttributes.Phase.rest
        state.endsAt = endsAt
        state.leftMs = left
        state.totalMs = max(state.totalMs, left)
        // The bar's range has to grow with the rest, or a rest given an extra 15 s spends its last
        // seconds with the bar already full.
        state.startAt = endsAt.addingTimeInterval(-state.totalMs / 1000)
        await update(activity, state)
        rescheduleNotification(activity.attributes, state: state, at: endsAt)
        enqueue("adjust", state, paused: false)
    }

    /// The rest is over — skipped, or ended by taking more time off than was left. The card goes
    /// immediately (not "dismissed after a while": the user just said they are done) and the app is
    /// told to drop the countdown and its push.
    static func skip() async {
        cancelNotification()
        if let activity = current() {
            var state = activity.content.state
            if state.workoutId.isEmpty {
                await activity.end(nil, dismissalPolicy: .immediate)
            } else {
                state.phase = RestActivityAttributes.Phase.workout
                state.leftMs = 0
                await update(activity, state)
            }
        }
        enqueue("skip", nil, paused: false)
    }
}

/// `isDiscoverable = false` on all four: they exist for a button on openGym's own rest card, not to
/// be offered in Shortcuts or Spotlight. Their `title`s never surface anywhere a user reads — the
/// words on the buttons come from the translated attributes — so they stay in English.
@available(iOS 17.0, *)
struct RestPauseIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Pause or resume the rest"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        await RestBridge.togglePause()
        return .result()
    }
}

@available(iOS 17.0, *)
struct RestMinusIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Take 15 seconds off the rest"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        await RestBridge.adjust(by: -15)
        return .result()
    }
}

@available(iOS 17.0, *)
struct RestPlusIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Add 15 seconds to the rest"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        await RestBridge.adjust(by: 15)
        return .result()
    }
}

@available(iOS 17.0, *)
struct RestSkipIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Skip the rest"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        await RestBridge.skip()
        return .result()
    }
}
