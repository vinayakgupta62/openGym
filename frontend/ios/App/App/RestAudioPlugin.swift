import AVFoundation
import Capacitor
import UIKit
import UserNotifications

/**
 * The locked-phone rest-end notification plays a bundled WAV. When openGym is
 * foregrounded, the SAME notification is presented without its system sound:
 * instead a native AVAudioPlayer uses .duckOthers for a second or two to make
 * the chime audible over music. Non-rest notifications are left alone.
 */
@MainActor
final class RestAudioPlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = RestAudioPlayer()
    static let tones: Set<String> = ["chime", "classic", "bell", "beep", "whistle", "soft"]
    private var player: AVAudioPlayer?
    private var prior: (category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                        options: AVAudioSession.CategoryOptions)?
    private var watchdog: DispatchWorkItem?

    @discardableResult
    func play(tone: String) -> Bool {
        guard UIApplication.shared.applicationState == .active else { return false }
        let selected = Self.tones.contains(tone) ? tone : "chime"
        guard let file = Bundle.main.url(forResource: "opengym-rest-\(selected)", withExtension: "wav") else { return false }
        finish()
        let session = AVAudioSession.sharedInstance()
        let old = (category: session.category, mode: session.mode, options: session.categoryOptions)
        do {
            try session.setCategory(.playback, mode: .default, options: [.duckOthers, .mixWithOthers])
            try session.setActive(true)
            let tonePlayer = try AVAudioPlayer(contentsOf: file)
            tonePlayer.delegate = self
            tonePlayer.volume = 0.9
            tonePlayer.prepareToPlay()
            guard tonePlayer.play() else { throw NSError(domain: "RestAudio", code: 1) }
            prior = old
            player = tonePlayer
            // A lost delegate callback must not leave Spotify ducked indefinitely.
            let timeout = DispatchWorkItem { [weak self] in self?.finish() }
            watchdog = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: timeout)
            return true
        } catch {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            try? session.setCategory(old.category, mode: old.mode, options: old.options)
            return false
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { finish() }

    private func finish() {
        watchdog?.cancel()
        watchdog = nil
        player?.stop()
        player = nil
        guard let old = prior else { return }
        prior = nil
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(old.category, mode: old.mode, options: old.options)
    }
}

/**
 * Forward all unrelated notifications and notification taps to Capacitor's
 * delegate. Only suppress sound for the foreground rest notification (ID 42).
 * UserNotificationCenter delegates are weak; retain the previous delegate.
 */
final class RestNotificationRouter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = RestNotificationRouter()
    private var previous: UNUserNotificationCenterDelegate?

    func install() {
        let center = UNUserNotificationCenter.current()
        guard center.delegate !== self else { return }
        previous = center.delegate
        center.delegate = self
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard notification.request.identifier == "42",
              UIApplication.shared.applicationState == .active else {
            if let previous {
                previous.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
            } else {
                completionHandler([.banner, .list, .sound])
            }
            return
        }
        if notification.request.content.sound != nil {
            let tone = notification.request.content.userInfo["openGymRestTone"] as? String ?? "chime"
            DispatchQueue.main.async { _ = RestAudioPlayer.shared.play(tone: tone) }
        }
        if let previous {
            previous.userNotificationCenter?(center, willPresent: notification) { options in
                completionHandler(options.subtracting(.sound))
            }
        } else {
            completionHandler([.banner, .list])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let previous {
            previous.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
        } else {
            completionHandler()
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                openSettingsFor notification: UNNotification?) {
        previous?.userNotificationCenter?(center, openSettingsFor: notification)
    }
}

@objc(RestAudioPlugin)
public class RestAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RestAudioPlugin"
    public let jsName = "RestAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise)
    ]

    @objc public func prepare(_ call: CAPPluginCall) {
        RestNotificationRouter.shared.install()
        call.resolve(["ready": true])
    }

    @objc public func play(_ call: CAPPluginCall) {
        let tone = call.getString("tone") ?? "chime"
        Task { @MainActor in
            let started = RestAudioPlayer.shared.play(tone: tone)
            call.resolve(["played": started])
        }
    }
}
