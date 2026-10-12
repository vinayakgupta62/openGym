import Capacitor
import HealthKit

/**
 * The iOS half of HealthConnectPlugin.java (#200): finished workouts and weigh-ins go into the
 * phone's own health store, so other apps can read them. Off until the user turns it on in
 * Settings — no permission is asked for before that. What to write is worked out in JS
 * (lib/health-connect.js); this side only turns those plain objects into HealthKit samples, and
 * the record shape is the same on both platforms, so the JS needs no branch beyond the plugin name.
 *
 * Rewriting is idempotent, the way clientRecordId makes it on Android, but through HealthKit's own
 * mechanism for it: every sample carries HKMetadataKeySyncIdentifier (openGym's record id) and
 * HKMetadataKeySyncVersion (the time of the write, in milliseconds). HealthKit replaces a sample
 * when a newer version arrives under the same identifier, so an edited workout updates in place
 * instead of appearing twice.
 *
 * Authorization is read *and* write, a deliberate difference from Android's write-only. "Turn it
 * off and remove what openGym wrote" has to find those samples again, and HealthKit can only delete
 * objects it hands you — a query, which needs read access. The read is used for nothing else, and
 * NSHealthShareUsageDescription says so. A user who grants write but not read still gets the
 * feature; only the removal is refused, and it comes back as a permission error so Settings can
 * say which.
 *
 * HealthKit is unavailable on iPad — HKHealthStore.isHealthDataAvailable() is false there — and
 * the whole plugin answers "unsupported", the same answer Android gives below its own floor.
 *
 * The payloads are decoded with Capacitor's Codable support rather than indexed by hand: a
 * Capacitor JSObject is [String: JSValue], and casting its members out one by one is exactly the
 * kind of thing that compiles and then fails on the phone.
 *
 * Usage from JS (lib/health-sync.js):
 *   const Health = registerPlugin('Health');
 *   await Health.status();              // { status: 'available' | 'unsupported', granted }
 *   await Health.requestPermissions();  // { granted }
 *   await Health.write({ sessions: [...], weights: [...] });
 *   await Health.remove({ sessions: [id], weights: [id] });
 *   await Health.openSettings();        // the Health app
 */
@objc(HealthPlugin)
public class HealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthPlugin"
    public let jsName = "Health"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    private let store = HKHealthStore()
    // One at a time, in order: a removal queued behind a write must not overtake it, which is what
    // the single-thread executor does on the Android side.
    private let queue = DispatchQueue(label: "ch.duartesantos.opengym.health")
    // HealthKit takes an array of samples; chunking keeps a first sync of a long history from
    // growing one call without bound, and matches the Android plugin's chunk size.
    private let chunkSize = 500

    // MARK: - shapes, as lib/health-connect.js builds them

    private struct SessionIn: Decodable {
        let id: String
        let start: Double      // epoch milliseconds
        let end: Double
        let type: String?
        let title: String?
        let notes: String?
    }
    private struct WeightIn: Decodable {
        let id: String
        let time: Double       // epoch milliseconds
        let kg: Double
    }
    private struct WriteIn: Decodable {
        let sessions: [SessionIn]?
        let weights: [WeightIn]?
    }
    private struct RemoveIn: Decodable {
        let sessions: [String]?
        let weights: [String]?
    }

    // MARK: - types

    private var bodyMass: HKQuantityType? { HKObjectType.quantityType(forIdentifier: .bodyMass) }

    private var shareTypes: Set<HKSampleType> {
        var s: Set<HKSampleType> = [HKObjectType.workoutType()]
        if let m = bodyMass { s.insert(m) }
        return s
    }
    private var readTypes: Set<HKObjectType> {
        var s: Set<HKObjectType> = [HKObjectType.workoutType()]
        if let m = bodyMass { s.insert(m) }
        return s
    }

    private var available: Bool { HKHealthStore.isHealthDataAvailable() }

    /** Whether openGym may write both kinds. Share status only: that is what "granted" means here. */
    private var canWrite: Bool {
        guard available, let mass = bodyMass else { return false }
        return store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized
            && store.authorizationStatus(for: mass) == .sharingAuthorized
    }

    // MARK: - status

    @objc public func status(_ call: CAPPluginCall) {
        guard available else {
            call.resolve(["status": "unsupported", "granted": false])
            return
        }
        // No 'update' and no 'missing' here, unlike Android: HealthKit ships with the OS, so there
        // is no separate app to install and no client version to be behind. Only there, or not.
        call.resolve(["status": "available", "granted": canWrite])
    }

    // MARK: - permissions

    @objc public func requestPermissions(_ call: CAPPluginCall) {
        guard available else {
            call.resolve(["granted": false])
            return
        }
        // The sheet is UI, and HealthKit wants to be asked on the main thread.
        DispatchQueue.main.async {
            self.store.requestAuthorization(toShare: self.shareTypes, read: self.readTypes) { _, _ in
                // Deliberately canWrite rather than the callback's success flag. That flag is also
                // true when the user grants nothing, and iOS never reports whether *read* was
                // granted — by design, since saying so would leak whether the user has any of that
                // data. canWrite is the honest answer to "may openGym write?".
                call.resolve(["granted": self.canWrite])
            }
        }
    }

    // MARK: - write

    @objc public func write(_ call: CAPPluginCall) {
        guard available else {
            call.reject("HealthKit is not available on this device", "unavailable")
            return
        }
        guard canWrite else {
            call.reject("openGym is not allowed to write to Health", "permission")
            return
        }
        let input: WriteIn
        do { input = try call.decode(WriteIn.self) } catch {
            call.reject("could not read the records to write", "failed")
            return
        }
        let sessions = input.sessions ?? []
        let weights = input.weights ?? []
        if sessions.isEmpty && weights.isEmpty {
            call.resolve()
            return
        }
        // The version is the time of the write, as it is on Android: HealthKit keeps a rewritten
        // sample only when this is higher than the one it holds. Milliseconds, because two edits
        // can land inside the same second and the later one still has to win.
        let version = NSNumber(value: Int(Date().timeIntervalSince1970 * 1000))
        var objects: [HKObject] = []

        for s in sessions {
            guard s.end > s.start else { continue }
            var meta: [String: Any] = [
                HKMetadataKeySyncIdentifier: s.id,
                HKMetadataKeySyncVersion: version,
                HKMetadataKeyWorkoutBrandName: "openGym"
            ]
            // HealthKit has no field for a workout's own name or notes: it shows the activity type
            // and the app it came from. They go in metadata rather than being dropped, so what was
            // actually done is still there for anything that reads it back.
            if let title = s.title, !title.isEmpty { meta["openGymTitle"] = title }
            if let notes = s.notes, !notes.isEmpty { meta["openGymNotes"] = notes }
            objects.append(HKWorkout(activityType: activityType(s.type),
                                     start: Date(timeIntervalSince1970: s.start / 1000),
                                     end: Date(timeIntervalSince1970: s.end / 1000),
                                     duration: 0, totalEnergyBurned: nil, totalDistance: nil,
                                     metadata: meta))
        }

        if let mass = bodyMass {
            for w in weights where w.kg > 0 {
                let date = Date(timeIntervalSince1970: w.time / 1000)
                objects.append(HKQuantitySample(
                    type: mass,
                    quantity: HKQuantity(unit: HKUnit.gramUnit(with: .kilo), doubleValue: w.kg),
                    start: date, end: date,
                    metadata: [HKMetadataKeySyncIdentifier: w.id,
                               HKMetadataKeySyncVersion: version]))
            }
        }

        save(objects, call)
    }

    private func save(_ objects: [HKObject], _ call: CAPPluginCall) {
        guard !objects.isEmpty else {
            call.resolve()
            return
        }
        queue.async {
            var index = 0
            while index < objects.count {
                let group = Array(objects[index..<min(index + self.chunkSize, objects.count)])
                index += self.chunkSize
                if let error = self.saveOne(group) {
                    call.reject(error.localizedDescription, self.code(for: error))
                    return
                }
            }
            call.resolve()
        }
    }

    /** Blocking on purpose: the serial queue is where the ordering guarantee lives. */
    private func saveOne(_ group: [HKObject]) -> Error? {
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        store.save(group) { ok, error in
            if !ok { failure = error }
            done.signal()
        }
        done.wait()
        return failure
    }

    // MARK: - remove

    @objc public func remove(_ call: CAPPluginCall) {
        guard available else {
            call.reject("HealthKit is not available on this device", "unavailable")
            return
        }
        let input: RemoveIn
        do { input = try call.decode(RemoveIn.self) } catch {
            call.reject("could not read the records to remove", "failed")
            return
        }
        let sessionIds = input.sessions ?? []
        let weightIds = input.weights ?? []
        if sessionIds.isEmpty && weightIds.isEmpty {
            call.resolve()
            return
        }
        var work: [(HKSampleType, [String])] = []
        if !sessionIds.isEmpty { work.append((HKObjectType.workoutType(), sessionIds)) }
        if let mass = bodyMass, !weightIds.isEmpty { work.append((mass, weightIds)) }

        queue.async {
            for (type, ids) in work {
                for id in ids {
                    if let error = self.removeOne(type: type, id: id) {
                        call.reject(error.localizedDescription, self.code(for: error))
                        return
                    }
                }
            }
            call.resolve()
        }
    }

    private func removeOne(type: HKSampleType, id: String) -> Error? {
        let predicate = HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeySyncIdentifier,
                                                    operatorType: .equalTo, value: id)
        let found = DispatchSemaphore(value: 0)
        var samples: [HKSample] = []
        var failure: Error?
        let query = HKSampleQuery(sampleType: type, predicate: predicate,
                                  limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, result, error in
            if let error = error { failure = error } else if let result = result { samples = result }
            found.signal()
        }
        store.execute(query)
        found.wait()
        if let error = failure { return error }
        // Nothing found is not a failure: a record openGym believes it wrote can already be gone
        // because the user deleted it in the Health app, and that is theirs to do.
        guard !samples.isEmpty else { return nil }

        let deleted = DispatchSemaphore(value: 0)
        store.delete(samples) { ok, error in
            if !ok { failure = error }
            deleted.signal()
        }
        deleted.wait()
        return failure
    }

    // MARK: - settings

    @objc public func openSettings(_ call: CAPPluginCall) {
        // There is no API that opens an app's own screen inside Health, and no supported URL scheme
        // for one; x-apple-health:// is the scheme the Health app registers and what apps use in
        // practice. canOpenURL is deliberately not consulted: it answers false for any scheme not
        // declared in LSApplicationQueriesSchemes, and declaring this one to ask a question whose
        // answer we ignore buys nothing. On a device without the Health app this does nothing.
        DispatchQueue.main.async {
            if let url = URL(string: "x-apple-health://") {
                UIApplication.shared.open(url, options: [:]) { _ in call.resolve() }
            } else {
                call.resolve()
            }
        }
    }

    // MARK: - helpers

    /** What lib/health-sync.js switches on: 'permission' and 'unavailable' mean something specific. */
    private func code(for error: Error) -> String {
        let ns = error as NSError
        if ns.domain == HKError.errorDomain && ns.code == HKError.Code.errorAuthorizationDenied.rawValue {
            return "permission"
        }
        return "failed"
    }

    /**
     * The names lib/health-connect.js computes (SESSION_TYPES) as HealthKit activity types. Android
     * maps the same list to ExerciseSessionRecord.EXERCISE_TYPE_*; keep the two in step. HealthKit
     * has no stationary-bike type, so a bike is plain cycling.
     */
    private func activityType(_ name: String?) -> HKWorkoutActivityType {
        switch name {
        case "strength_training": return .traditionalStrengthTraining
        case "walking": return .walking
        case "running": return .running
        case "biking_stationary": return .cycling
        case "elliptical": return .elliptical
        case "stair_climbing_machine": return .stairClimbing
        default: return .other
        }
    }
}
