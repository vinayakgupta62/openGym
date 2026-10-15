import Capacitor
import UIKit

// Swift plugins compiled into the App target are not automatically added to
// Capacitor's packageClassList. Register them before the WebView loads so
// registerPlugin('RestActivity'), registerPlugin('Haptics'), etc. can reach iOS.
class OpenGymBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(SystemBarsPlugin())
        bridge?.registerPluginInstance(HealthPlugin())
        bridge?.registerPluginInstance(HapticsPlugin())
        bridge?.registerPluginInstance(RestActivityPlugin())
        // PrintPlugin retains its legacy CAP_PLUGIN Objective-C registration.
    }
}
