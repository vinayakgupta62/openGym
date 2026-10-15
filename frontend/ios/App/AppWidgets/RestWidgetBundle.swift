import ActivityKit
import SwiftUI
import WidgetKit

/**
 * The rest countdown on the lock screen and in the Dynamic Island (#296 on iOS).
 *
 * This is the widget extension's half: it draws `RestActivityAttributes` and never computes anything
 * the app did not tell it. The clock and the bar are the *system's* timers (`Text(timerInterval:)`,
 * `ProgressView(timerInterval:)`), which keep running while the app is suspended — an update per
 * second from JavaScript is neither possible nor wanted, and a Live Activity whose clock came from
 * the app would freeze the moment the phone locked.
 *
 * The buttons are the other half of that same problem, and they are why this file names the App
 * Intents in RestIntents.swift: a tap is performed by *the app's* process (that is what
 * `LiveActivityIntent` means), which is what lets it move the activity, the notification for the
 * end, and the app's own timer. They are only drawn on iOS 17 — `Button(intent:)` does not exist
 * before it — and only in the two presentations Apple allows them in: the lock-screen card and the
 * *expanded* Dynamic Island. The compact and minimal Island presentations are read-only, so they
 * keep showing the countdown and nothing else.
 *
 * Colours follow the surfaces rather than the app's own hexes: the lock-screen card is Apple's, and
 * a card that matches the system beside it reads better than one that matches Settings. The Dynamic
 * Island is always black with white text, as the spec says, whatever theme the app is in. The one
 * colour that is genuinely ours is the accent, on the bar, the mark and the main button.
 */
@main
struct RestWidgetBundle: WidgetBundle {
    var body: some Widget {
        RestLiveActivity()
    }
}

struct RestLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RestActivityAttributes.self) { context in
            LockScreenCard(context: context)
                .activityBackgroundTint(Color(uiColor: .secondarySystemBackground))
                .activitySystemActionForegroundColor(Accent.color(context.attributes.accentHex))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    if context.state.hasWorkout {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(context.state.exerciseName)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.white)
                                .lineLimit(2)
                                .minimumScaleFactor(0.75)
                            Text(context.state.nextSetLabel)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Color.white.opacity(0.65))
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Clock(context: context, size: 28, onDark: true)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 3) {
                        if context.state.hasWorkout && face(context) == RestActivityAttributes.Phase.workout {
                            Text(context.state.workoutStartedAt, style: .timer)
                                .font(.system(size: 22, weight: .semibold).monospacedDigit())
                                .foregroundStyle(Color.white)
                                .lineLimit(1)
                        } else {
                            Clock(context: context, size: 25, onDark: true)
                        }
                        if face(context) != RestActivityAttributes.Phase.workout {
                            Status(context: context, alignment: .trailing, onDark: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.center) {
                    if face(context) == RestActivityAttributes.Phase.workout {
                        SetProgress(context: context)
                    } else {
                        Bar(context: context, inset: 3)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if context.state.hasWorkout && !context.state.targetText.isEmpty {
                            Text(context.state.targetText)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.white.opacity(0.86))
                                .lineLimit(1)
                        }
                        if face(context) == RestActivityAttributes.Phase.workout
                            && context.state.canCompleteSet {
                            if #available(iOS 17.0, *) {
                                CompleteSetButton(context: context, onDark: true)
                            }
                        }
                        if face(context) != RestActivityAttributes.Phase.workout {
                            if #available(iOS 17.0, *) {
                                Buttons(context: context, onDark: true)
                                    .padding(.top, 2)
                            }
                        }
                    }
                }
            } compactLeading: {
                // The app draws its own 24×24 stroke icons and uses no SF Symbols or emoji. A
                // stroke drawing does not survive at this size, so this is the "solid where a
                // shape reads better filled" case its own conventions allow: the timer glyph's
                // circle and its button, filled.
                TimerMark(color: Accent.color(context.attributes.accentHex), size: 15)
            } compactTrailing: {
                CompactClock(context: context)
            } minimal: {
                MinimalClock(context: context)
            }
        }
    }
}

// MARK: - Lock screen

private struct LockScreenCard: View {
    let context: ActivityViewContext<RestActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if context.state.hasWorkout {
                HStack(alignment: .firstTextBaseline) {
                    Text(context.state.workoutName)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    Text(context.state.workoutStartedAt, style: .timer)
                        .font(.system(size: 12, weight: .semibold).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(context.state.exerciseName)
                        .font(.system(size: 17, weight: .semibold))
                        .lineLimit(2)
                    Text(context.state.nextSetLabel
                         + (context.state.targetText.isEmpty ? "" : "  ·  " + context.state.targetText))
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            if face(context) == RestActivityAttributes.Phase.workout {
                SetProgress(context: context)
                if context.state.canCompleteSet {
                    if #available(iOS 17.0, *) {
                        CompleteSetButton(context: context, onDark: false)
                    }
                }
            } else {
                Bar(context: context, inset: 0)
                HStack(alignment: .firstTextBaseline) {
                    Clock(context: context, size: 40, onDark: false)
                    Spacer(minLength: 8)
                    Status(context: context, alignment: .trailing, onDark: false)
                }
                if #available(iOS 17.0, *) {
                    Buttons(context: context, onDark: false)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

// The bar shows completed sets in the current workout, including the next-set phase.
private struct SetProgress: View {
    let context: ActivityViewContext<RestActivityAttributes>

    var body: some View {
        HStack(spacing: 8) {
            ProgressView(value: Double(context.state.completedSets),
                         total: Double(max(1, context.state.totalSets)))
                .tint(Accent.color(context.attributes.accentHex))
            Text("\(context.state.completedSets)/\(context.state.totalSets)")
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(.secondary)
                .fixedSize()
        }
    }
}

// The tap is durable, but WebView persistence happens on foreground if iOS has
// suspended the app. Show that truthful pending state rather than pretending that
// an unacknowledged set was already saved. Only iOS 17+ supports Button(intent:).
@available(iOS 17.0, *)
private struct CompleteSetButton: View {
    let context: ActivityViewContext<RestActivityAttributes>
    let onDark: Bool

    var body: some View {
        Button(intent: RestCompleteSetIntent()) {
            HStack(spacing: 7) {
                Text(context.state.setPending ? "Queued — open openGym to save" : "Complete Set")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 0)
                // No glyph or emoji: the wording is the action, consistent with
                // the rest of openGym's minimal, text-forward iOS surfaces.
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity)
            .foregroundStyle(onDark ? Color.white : Color.primary)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Accent.color(context.attributes.accentHex)
                        .opacity(context.state.setPending ? 0.13 : (onDark ? 0.42 : 0.22)))
            )
        }
        .buttonStyle(.plain)
        .disabled(context.state.setPending)
    }
}

// MARK: - Buttons

/**
 * Pause/Resume, −15 s, +15 s, Skip — the same four the Android notification's actions offer and
 * the app's own bar offers, in the same order, built from the same translated words (the attributes
 * carry them; nothing here invents copy).
 *
 * Each one is a `Button(intent:)`, so the tap is handed to the app rather than opening it: the
 * countdown on the card moves under the finger, and the app catches up when it is next in front.
 */
@available(iOS 17.0, *)
private struct Buttons: View {
    let context: ActivityViewContext<RestActivityAttributes>
    let onDark: Bool

    var body: some View {
        HStack(spacing: 8) {
            Button(intent: RestPauseIntent()) {
                face(context.state.isPaused ? context.attributes.resumeLabel : context.attributes.pauseLabel,
                     prominent: true)
            }
            Button(intent: RestMinusIntent()) { face(context.attributes.minusLabel) }
            Button(intent: RestPlusIntent()) { face(context.attributes.plusLabel) }
            Button(intent: RestSkipIntent()) { face(context.attributes.skipLabel) }
        }
        .buttonStyle(.plain)
    }

    /// An even share of the row each, so the four sit on one line whatever language they are in —
    /// and shrink rather than wrap when a translation is longer than English's.
    @ViewBuilder
    private func face(_ text: String, prominent: Bool = false) -> some View {
        Text(text)
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity)
            .foregroundStyle(prominent ? Accent.color(context.attributes.accentHex)
                                       : (onDark ? Color.white : Color.primary))
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(onDark ? Color.white.opacity(0.14) : Color.primary.opacity(0.07))
            )
    }
}

// MARK: - Pieces

/**
 * Which face the card is showing. `isStale` is the system reporting that the content it holds is
 * past its stale date — for a running rest that date *is* the end of the rest (RestBridge.staleDate
 * in RestIntents.swift), so a countdown that reached 0:00 while the app was suspended draws Ready
 * without anything having to wake up and say so. The design spec's P0, answered by the system's own
 * clock rather than by an update the app is not allowed to send.
 */
private func face(_ context: ActivityViewContext<RestActivityAttributes>) -> String {
    let phase = context.state.phase
    if phase == RestActivityAttributes.Phase.rest && isStale(context) {
        return RestActivityAttributes.Phase.ready
    }
    return phase
}

/**
 * `ActivityViewContext.isStale` is **iOS 16.2**, while this extension is built for 16.1 — the
 * ActivityKit floor the app target and the Podfile share — so it is asked behind its own gate. The
 * first CI run stopped here with `'isStale' is only available in iOS 16.2 or newer`, in this exact
 * compile unit. That is why the check is a named function rather than a property read in the middle
 * of a view body: there is one place to gate, and a test reads it.
 *
 * On 16.1 the card counts down to 0:00 and stays there until the app is opened. There is no
 * supported way to tell a 16.1 render that its content has gone out of date.
 */
private func isStale(_ context: ActivityViewContext<RestActivityAttributes>) -> Bool {
    if #available(iOS 16.2, *) { return context.isStale }
    return false
}

/// The clock's three faces. Same size in all of them, so the row does not jump when the rest ends.
private struct Clock: View {
    let context: ActivityViewContext<RestActivityAttributes>
    let size: CGFloat
    let onDark: Bool

    var body: some View {
        Group {
            if face(context) == RestActivityAttributes.Phase.workout {
                Text(context.state.workoutStartedAt, style: .timer)
            } else if face(context) == RestActivityAttributes.Phase.ready {
                Text(context.attributes.readyLabel)
            } else if context.state.isPaused {
                Text(Self.clock(context.state.leftMs))
            } else if context.state.endsAt > context.state.startAt {
                // The system's own countdown: it keeps ticking while the app is not running.
                Text(timerInterval: context.state.startAt...context.state.endsAt, countsDown: true)
            } else {
                Text(Self.clock(context.state.leftMs))
            }
        }
        .font(.system(size: size, weight: .semibold).monospacedDigit())
        .foregroundStyle(onDark ? Color.white : Color.primary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }

    static func clock(_ ms: Double) -> String {
        let s = max(0, Int((ms / 1000).rounded()))
        return "\(s / 60):\(String(format: "%02d", s % 60))"
    }
}

/// The status word under, or beside, the clock.
private struct Status: View {
    let context: ActivityViewContext<RestActivityAttributes>
    let alignment: HorizontalAlignment
    let onDark: Bool

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(onDark ? Color.white.opacity(0.6) : Color.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
    }

    private var text: String {
        // The rest's own name — "Rest", "Switch sides" — and nothing once it is over: Ready says
        // itself on the clock, and the two together read like a label for each other.
        face(context) == RestActivityAttributes.Phase.ready ? "" : (context.state.restTitle.isEmpty ? context.attributes.countdownTitle : context.state.restTitle)
    }
}

/// The shrinking bar. The system's timed progress view while it runs (its look is Apple's, and its
/// rail cannot be restyled), a plain value while it is held, and an empty one when it is over.
private struct Bar: View {
    let context: ActivityViewContext<RestActivityAttributes>
    let inset: CGFloat

    var body: some View {
        Group {
            if face(context) == RestActivityAttributes.Phase.ready {
                ProgressView(value: 0, total: max(1, context.state.totalMs))
            } else if context.state.isPaused {
                ProgressView(value: max(0, context.state.leftMs), total: max(1, context.state.totalMs))
            } else if context.state.endsAt > context.state.startAt {
                ProgressView(timerInterval: context.state.startAt...context.state.endsAt, countsDown: true)
            } else {
                ProgressView(value: 0, total: max(1, context.state.totalMs))
            }
        }
        .progressViewStyle(.linear)
        .tint(Accent.color(context.attributes.accentHex))
        .padding(.horizontal, inset)
    }
}

/// Compact trailing, and minimal: the countdown at the smallest sizes the system allows. A timer
/// that will not fit becomes the mark instead — sacrificing the digits rather than cropping them.
private struct CompactClock: View {
    let context: ActivityViewContext<RestActivityAttributes>

    var body: some View {
        Group {
            if face(context) == RestActivityAttributes.Phase.workout {
                Text(context.state.workoutStartedAt, style: .timer)
            } else if face(context) == RestActivityAttributes.Phase.ready {
                TimerMark(color: Accent.color(context.attributes.accentHex), size: 14)
            } else if context.state.isPaused {
                Text(Clock.clock(context.state.leftMs))
            } else if context.state.endsAt > context.state.startAt {
                Text(timerInterval: context.state.startAt...context.state.endsAt, countsDown: true)
            } else {
                Text(Clock.clock(context.state.leftMs))
            }
        }
        .font(.system(size: 14, weight: .semibold).monospacedDigit())
        .foregroundStyle(Color.white)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .padding(.trailing, 4)
    }
}

private struct MinimalClock: View {
    let context: ActivityViewContext<RestActivityAttributes>

    var body: some View {
        Group {
            if face(context) == RestActivityAttributes.Phase.workout {
                Text(context.state.workoutStartedAt, style: .timer)
            } else if face(context) == RestActivityAttributes.Phase.ready {
                TimerMark(color: Accent.color(context.attributes.accentHex), size: 13)
            } else if context.state.isPaused {
                Text(Clock.clock(context.state.leftMs))
            } else if context.state.endsAt > context.state.startAt {
                Text(timerInterval: context.state.startAt...context.state.endsAt, countsDown: true)
            } else {
                Text(Clock.clock(context.state.leftMs))
            }
        }
        .font(.system(size: 11, weight: .semibold).monospacedDigit())
        .foregroundStyle(Color.white)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }
}

/// openGym's `timer` glyph — a circle and the button above it — filled, for the sizes where the
/// app's stroke drawing would disappear.
private struct TimerMark: View {
    let color: Color
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(color)
                .frame(width: size * 0.76, height: size * 0.76)
                .offset(y: size * 0.09)
            Capsule()
                .fill(color)
                .frame(width: size * 0.34, height: size * 0.13)
                .offset(y: -size * 0.42)
        }
        .frame(width: size, height: size)
    }
}

/// The user's accent, as '#rrggbb' (lib/accent.js resolves the preset or their own colour before
/// it gets here). Falls back to openGym's default lime rather than to grey: an unreadable accent is
/// worse than the wrong one, and this is only ever decoration.
private enum Accent {
    static func color(_ hex: String) -> Color {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return Color(red: 0.19, green: 0.82, blue: 0.35) }
        return Color(red: Double((v >> 16) & 0xFF) / 255,
                     green: Double((v >> 8) & 0xFF) / 255,
                     blue: Double(v & 0xFF) / 255)
    }
}
