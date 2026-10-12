import Capacitor
import AudioToolbox
import CoreHaptics

/**
 * The iOS half of Settings → Vibrate. iOS has no `navigator.vibrate` at all, so the WebView's buzz
 * — which is how every other platform does it — has no counterpart here, and the row in Settings
 * used to read "Not on iPhone". That is a WebView limitation rather than the phone's: an iPhone
 * can buzz, it just has to be asked from native code, which is what this plugin is.
 *
 * CoreHaptics wherever the hardware has it (iPhone 8 and later), so `navigator.vibrate`'s on/off
 * pattern is reproduced as it is meant: the end of a rest is [200, 100, 200], a set tick is one
 * short buzz, a swipe is a tap. Everywhere else — an iPad, older hardware, or an engine that will
 * not start in Low Power Mode — the old system vibrate: one fixed buzz, which is all there is.
 *
 * Only while the app is running. Haptics stop when iOS suspends the app, so a rest that ends with
 * the phone locked is the *notification's* job (lib/rest-alert.js) — and iOS is already buzzing
 * for that one, as the haptics the user set for notifications.
 *
 * Usage from JS (lib/sound.js):
 *   registerPlugin('Haptics').vibrate({ pattern: [200, 100, 200] })
 */
@objc(HapticsPlugin)
public class HapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HapticsPlugin"
    public let jsName = "Haptics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "vibrate", returnType: CAPPluginReturnPromise)
    ]

    private struct VibrateIn: Decodable {
        let pattern: [Double]?
    }

    private var engine: CHHapticEngine?

    @objc public func vibrate(_ call: CAPPluginCall) {
        let input = try? call.decode(VibrateIn.self)
        let pattern = (input?.pattern ?? []).filter { $0.isFinite && $0 >= 0 }
        buzz(pattern.isEmpty ? [200] : pattern)
        // Nothing to report. Nobody waits on a buzz, and a phone that cannot haptics is not a
        // failure worth putting in front of someone mid-set.
        call.resolve()
    }

    private func buzz(_ pattern: [Double]) {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            return
        }
        do {
            let events = hapticEvents(pattern)
            guard !events.isEmpty else {
                AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
                return
            }
            let haptics = try engineFor()
            let player = try haptics.makePlayer(with: CHHapticPattern(events: events, parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            // Low Power Mode, an engine that will not restart after a call, a pattern the hardware
            // refuses: the system vibrate is the floor, not an error.
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }
    }

    /**
     * `navigator.vibrate`'s array read the way a browser reads it: index 0 buzzes, index 1 pauses,
     * index 2 buzzes, and so on. Each buzz is a continuous haptic of its own length rather than a
     * transient tap, so a 200 ms segment feels like 200 ms.
     */
    private func hapticEvents(_ pattern: [Double]) -> [CHHapticEvent] {
        var events: [CHHapticEvent] = []
        var at: TimeInterval = 0
        for (i, ms) in pattern.enumerated() {
            let seconds = ms / 1000
            if i % 2 == 0 && seconds > 0 {
                events.append(CHHapticEvent(
                    eventType: .hapticContinuous,
                    parameters: [
                        CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5)
                    ],
                    relativeTime: at,
                    duration: seconds))
            }
            at += seconds
        }
        return events
    }

    /**
     * Started on first use and left to shut itself down when it goes idle — the right shape for
     * something that buzzes for a second between sets and then not again for a minute. A stop or a
     * reset drops it, so the next buzz builds a fresh one.
     */
    private func engineFor() throws -> CHHapticEngine {
        if let engine = engine { return engine }
        let made = try CHHapticEngine()
        made.playsHapticsOnly = true
        made.isAutoShutdownEnabled = true
        made.stoppedHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.engine = nil }
        }
        made.resetHandler = { [weak self] in
            // After a phone call or a media service reset the engine has to be started again, or
            // every buzz from here on quietly does nothing.
            try? self?.engine?.start()
        }
        try made.start()
        engine = made
        return made
    }
}
