import ActivityKit
import Foundation

/**
 * The rest countdown as a Live Activity (#296 on iOS): the lock-screen card and the Dynamic Island,
 * driven by the app and drawn by AppWidgets.
 *
 * This file belongs to **both** targets — the app requests and updates the activity, the widget
 * extension renders it, and ActivityKit hands the same `ContentState` across. So do `RestIntents`
 * (the card's buttons) for the same reason. That is why the two files sit here rather than in
 * either one: add both to both Sources phases in project.pbxproj, or one side will not know the
 * types.
 *
 * The split between the two halves is ActivityKit's, not ours:
 *
 *  - `RestActivityAttributes` is fixed for the life of one rest. The labels live here because they
 *    are the *translated* strings JavaScript passed in (docs/MOBILE.md's localization contract) —
 *    the widget must never invent copy of its own, and it cannot reach i18n anyway. The
 *    notification's own words are here for the same reason: a button on the card can move the end
 *    of the rest, and the local notification that announces it has to move with it, in a process
 *    where no JavaScript is running to be asked again (RestIntents.swift).
 *  - `ContentState` is what changes: when the rest ends, whether it is paused, whether it is over.
 *
 * The countdown itself is the system's. `Text(timerInterval:)` and `ProgressView(timerInterval:)`
 * keep ticking while the app is suspended, which is the whole point — an update per second is
 * neither possible nor wanted. It also means the progress bar's appearance is Apple's, not the
 * Android card's: it can be tinted with the accent, but not given a 6 pt rail or a chosen track
 * colour, and that is a difference to accept rather than fight.
 *
 * "Ready" while the app is suspended — the design spec's P0 — is the **stale date**: the content
 * goes stale at `endsAt`, the system redraws the card around then because its own countdown has run
 * out, and the widget draws the Ready face off `context.isStale`. Nothing has to wake up to make
 * it happen.
 */
@available(iOS 16.1, *)
public struct RestActivityAttributes: ActivityAttributes {
    /// The three faces the widget and the buttons agree on. Plain strings rather than an enum
    /// because the activity is *encoded* — by ActivityKit to restore it, and by JavaScript to start
    /// it — and a String is one less thing for the two to disagree about (lib/rest-activity.js).
    public enum Phase {
        public static let workout = "workout"
        public static let rest = "rest"
        public static let paused = "paused"
        public static let ready = "ready"
    }

    public struct ContentState: Codable, Hashable {
        public var startAt: Date
        public var endsAt: Date
        public var totalMs: Double
        public var phase: String
        public var leftMs: Double

        // These properties live in ContentState, since a workout changes exercises and sets
        // without creating a new ActivityKit activity each time.
        public var workoutId: String
        public var workoutName: String
        public var workoutStartedAt: Date
        public var exerciseName: String
        public var nextSetLabel: String
        public var targetText: String
        public var completedSets: Int
        public var totalSets: Int
        // These target fields identify the precise row presented to the user.
        // The WebView must acknowledge the native command AFTER persisting the set.
        public var setToken: String
        public var setEntryIndex: Int
        public var setIndex: Int
        public var setExerciseId: String
        public var setSide: String
        public var canCompleteSet: Bool
        public var setPending: Bool
        public var pendingSetId: String

        // The notification can be rebooked from the Lock Screen while JS is suspended.
        public var notifyTitle: String
        public var notifyBody: String
        public var notifySound: Bool
        public var restTitle: String

        public init(startAt: Date, endsAt: Date, totalMs: Double, phase: String, leftMs: Double,
                    workoutId: String = "", workoutName: String = "", workoutStartedAt: Date = Date(),
                    exerciseName: String = "", nextSetLabel: String = "", targetText: String = "",
                    completedSets: Int = 0, totalSets: Int = 0,
                    setToken: String = "", setEntryIndex: Int = -1, setIndex: Int = -1,
                    setExerciseId: String = "", setSide: String = "",
                    canCompleteSet: Bool = false, setPending: Bool = false,
                    pendingSetId: String = "",
                    notifyTitle: String = "", notifyBody: String = "",
                    notifySound: Bool = true, restTitle: String = "") {
            self.startAt = startAt
            self.endsAt = endsAt
            self.totalMs = totalMs
            self.phase = phase
            self.leftMs = leftMs
            self.workoutId = workoutId
            self.workoutName = workoutName
            self.workoutStartedAt = workoutStartedAt
            self.exerciseName = exerciseName
            self.nextSetLabel = nextSetLabel
            self.targetText = targetText
            self.completedSets = completedSets
            self.totalSets = totalSets
            self.setToken = setToken
            self.setEntryIndex = setEntryIndex
            self.setIndex = setIndex
            self.setExerciseId = setExerciseId
            self.setSide = setSide
            self.canCompleteSet = canCompleteSet
            self.setPending = setPending
            self.pendingSetId = pendingSetId
            self.notifyTitle = notifyTitle
            self.notifyBody = notifyBody
            self.notifySound = notifySound
            self.restTitle = restTitle
        }

        public var isPaused: Bool { phase == Phase.paused }
        public var isReady: Bool { phase == Phase.ready }
        public var hasWorkout: Bool { !workoutId.isEmpty }
    }

    /// The status word: "Rest" or "Switch sides" (lib/rest-alert.js countdownTitle).
    public var countdownTitle: String
    /// Shown on the clock's face once the rest is over — "Ready".
    public var readyLabel: String
    /// The buttons' words, in the user's language like everything else (lib/rest-alert.js builds
    /// them from the same translations the Android notification's own actions use).
    public var pauseLabel: String
    public var resumeLabel: String
    public var minusLabel: String
    public var plusLabel: String
    public var skipLabel: String
    /// The local notification's words, verbatim, for a button that has to move or cancel it while
    /// no JavaScript is running. They are not rebuilt here: the copy belongs to the app's own i18n,
    /// and a rest whose length is adjusted from the lock screen keeps the words it started with
    /// rather than gaining a second, half-translated copy of them in Swift.
    public var notifyTitle: String
    public var notifyBody: String
    /// Settings → Sound off means no sound is named, and an iOS notification with no sound is
    /// silent (lib/rest-alert.js).
    public var notifySound: Bool
    /// The user's accent as '#rrggbb', already resolved through lib/accent.js, and the colour that
    /// reads on it. Hex rather than a number: the widget parses it once, and nothing here has to
    /// know about ARGB the way the Android notification does.
    public var accentHex: String
    public var inkHex: String

    public init(countdownTitle: String, readyLabel: String, pauseLabel: String, resumeLabel: String,
                minusLabel: String, plusLabel: String, skipLabel: String,
                notifyTitle: String, notifyBody: String, notifySound: Bool,
                accentHex: String, inkHex: String) {
        self.countdownTitle = countdownTitle
        self.readyLabel = readyLabel
        self.pauseLabel = pauseLabel
        self.resumeLabel = resumeLabel
        self.minusLabel = minusLabel
        self.plusLabel = plusLabel
        self.skipLabel = skipLabel
        self.notifyTitle = notifyTitle
        self.notifyBody = notifyBody
        self.notifySound = notifySound
        self.accentHex = accentHex
        self.inkHex = inkHex
    }
}
