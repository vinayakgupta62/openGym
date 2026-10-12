import Capacitor
import UIKit

/**
 * The iOS half of SystemBarsPlugin.java: the page tells this plugin which theme it resolved to
 * (lib/system-bars.js), and the status bar's glyphs follow — dark on the light theme, light on the
 * dark one.
 *
 * Why iOS needs it as much as Android does: the app's theme is an in-app setting, while iOS asks
 * the view controller for the status bar style, and Capacitor's own default comes from a
 * `UIStatusBarStyle` key in Info.plist that this app does not set. It therefore falls back to
 * `.default`, which follows the *device's* light/dark setting rather than the app's theme — so a
 * phone in Light Mode running openGym's dark theme drew dark glyphs on the app's #000000
 * background. Pinning a value in Info.plist only moves that to the other theme (light glyphs on
 * #f2f2f7), which is why this is a plugin and not a key: the theme has to be able to change while
 * the app runs.
 *
 * UIViewControllerBasedStatusBarAppearance is true in Info.plist, so the view controller's
 * preferredStatusBarStyle is what the system asks for, and CAPBridgeViewController already answers
 * it — setStatusBarStyle() stores the style and animates the appearance update. All this plugin has
 * to do is say which style.
 *
 * Usage from JS (lib/system-bars.js):
 *   registerPlugin('SystemBars').setStyle({ light: true })
 */
@objc(SystemBarsPlugin)
public class SystemBarsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SystemBarsPlugin"
    public let jsName = "SystemBars"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setStyle", returnType: CAPPluginReturnPromise)
    ]

    @objc public func setStyle(_ call: CAPPluginCall) {
        let light = call.getBool("light", false)
        // The status bar is UI, and setStatusBarStyle animates the change, so this has to land on
        // the main thread rather than the bridge's own queue.
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController as? CAPBridgeViewController else {
                // No Capacitor view controller to ask: nothing to set, and not an error — the bars
                // keep whatever they had.
                call.resolve()
                return
            }
            vc.setStatusBarStyle(light ? .darkContent : .lightContent)
            call.resolve()
        }
    }
}
