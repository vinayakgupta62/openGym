// One ActivityKit card spans an entire live session: exercise + next set between
// rests, and the same card becomes the countdown while the user is recovering.
// State is built from the existing persisted workout, not a parallel source of truth.
import { MOBILE } from './mobile.js'
import { exOr } from './exercises.js'
import { exerciseNameText, fmtNum } from './format.js'
import { t } from './i18n-core.js'
import { accentValue } from './accent.js'
import { accentColors } from './rest-alert.js'
import { doneUnits, isBw, modeOf, setLabel, setUnits } from './history.js'
import { speedUnitOf } from './speed.js'
import { nextOpenSet } from './workout-keys.js'
import { ackSetCompletion, syncWorkoutActivity } from './rest-activity.js'

const color = value => '#' + ((Number(value) >>> 0) & 0xffffff).toString(16).padStart(6, '0')

// A compact deterministic fingerprint of the actual row as shown. The native button carries
// this back unchanged, so a moved/edited/replaced row cannot become an accidental completion.
const targetToken = parts => {
  const raw = JSON.stringify(parts)
  let first = 2166136261, second = 3339675911
  for (let i = 0; i < raw.length; i++) {
    const n = raw.charCodeAt(i)
    first = Math.imul(first ^ n, 16777619)
    second = Math.imul(second ^ n, 2246822519)
  }
  return [first, second].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/** Pure projection of the live workout for the widget and test suite. */
export function workoutSnapshot(S) {
  const A = S?.active
  // Past/backfilled sessions should never open a live activity from yesterday.
  if (!A || A.backfill || A.editingWorkoutId) return null
  const entries = Array.isArray(A.entries) ? A.entries : []
  const start = Number(A.start)
  if (!A.id || !Number.isFinite(start) || start <= 0) return null
  const at = Math.max(0, Math.min(entries.length - 1, Number.isInteger(A.cur) ? A.cur : 0))
  // Use the same superset-aware ordering as the in-app Space/Enter set action,
  // rather than accidentally completing the wrong member of a superset.
  const next = nextOpenSet(entries, at)
  const idx = next?.idx ?? at
  const entry = entries[idx]
  const sets = entry?.sets || []
  const nextIdx = next?.i ?? -1
  const selected = nextIdx >= 0 ? sets[nextIdx] : null
  const side = next?.side || ''
  const done = entries.reduce((sum, e) => sum + (e.sets || []).reduce((n, s) => n + doneUnits(s), 0), 0)
  const total = entries.reduce((sum, e) => sum + (e.sets || []).reduce((n, s) => n + setUnits(s), 0), 0)
  const cfg = { ...(entry?.target || {}), id: entry?.id }
  let targetText = ''
  if (selected) {
    targetText = setLabel(entry.id, selected, cfg, speedUnitOf(S))
    const prefix = fmtNum(Number(selected.w || 0)) + '×'
    if (modeOf(cfg) === 'reps' && !isBw(cfg) && targetText.startsWith(prefix)) {
      targetText = fmtNum(Number(selected.w || 0)) + ' ' + (S.unit || 'kg') + ' × ' + targetText.slice(prefix.length)
    }
  }
  const { accent, ink } = accentColors(accentValue(S))
  return {
    workoutId: String(A.id),
    workoutName: String(A.name || t('Workout')).slice(0, 70),
    workoutStartedAt: start,
    exerciseName: entry ? exerciseNameText(exOr(entry.id)).slice(0, 80) : t('Add exercise'),
    nextSetLabel: selected
      ? t('Set {0}', nextIdx + 1) + ' / ' + sets.length + (side ? ' · ' + t(side === 'L' ? 'Left' : 'Right') : '')
      : t('All sets done'),
    targetText: targetText.slice(0, 100),
    completedSets: done,
    totalSets: total,
    // Only rep-based sets can be completed here; time/cardio sets need their in-app
    // stopwatch and measurement UI. Each side of a unilateral rep set is a separate tap.
    canCompleteSet: !!selected && modeOf(cfg) === 'reps',
    setEntryIndex: selected ? idx : -1,
    setIndex: nextIdx,
    setExerciseId: selected ? String(entry.id) : '',
    setSide: side,
    setToken: selected ? targetToken([A.id, A.start, idx, entry.id, nextIdx, side, selected]) : '',
    accentHex: color(accent),
    inkHex: color(ink),
  }
}

/** Subscribe only to persisted workout state: the UI rest timer ticks every second,
 * but SwiftUI handles the countdown and workout elapsed clock by date itself. */
export function watchWorkoutActivity(store) {
  if (!MOBILE) return () => {}
  let last = ''
  let chain = Promise.resolve()
  let stopped = false
  const sync = (force = false) => {
    if (stopped) return
    const current = store.getState()
    // A fresh WebView can hold a cached workout before boot restores the latest
    // native mirror. Ending or replacing its Live Activity here would erase a
    // command that the user just pressed on the Lock Screen.
    if (current.ready === false) return
    const snapshot = workoutSnapshot(current.S)
    // Clear old queued set taps after a workout was discarded or another one
    // started, without ever applying them to a different session.
    void acknowledgeOrphanedSets(store)
    const key = JSON.stringify(snapshot)
    if (!force && key === last) return
    last = key
    // Serialize JS -> native updates. Finishing one workout and starting the next
    // must not race a slow ActivityKit request from the preceding workout.
    chain = chain.then(() => stopped ? null : syncWorkoutActivity(snapshot)).catch(() => {})
  }
  trackedStore = store
  sync()
  const unStore = store.subscribe((next, prev) => {
    // finishBoot may flip ready without replacing S, so a restored workout
    // still needs its very first native Live Activity sync.
    if (next.S !== prev.S || (next.ready && !prev.ready)) sync()
  })
  const onVisible = () => { if (!document.hidden) sync(true) }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  return () => {
    stopped = true
    if (trackedStore === store) trackedStore = null
    unStore()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}


// Native set commands remain durable in iOS UserDefaults until an explicit ACK.
// WebView may be suspended when the intent runs, so only the existing Workout
// toggle handler is allowed to commit a set, after the screen mounts again.
const nativeCommands = new Map()
const pendingSubscribers = new Set()
const processedNativeIds = new Set()
let trackedStore = null
let completeHandler = null
let draining = false

async function acknowledgeOrphanedSets(store) {
  const state = store?.getState?.()
  if (!state?.ready || !nativeCommands.size || draining || completeHandler) return
  const current = workoutSnapshot(state.S)
  for (const [id, cmd] of nativeCommands) {
    if (current?.workoutId === cmd.workoutId) continue
    try {
      await store.getState().flushNativeSet()
      if (await ackSetCompletion(id)) {
        nativeCommands.delete(id)
        processedNativeIds.delete(id)
      }
    } catch { /* Keep UserDefaults action until a successful retry. */ }
  }
}

export function validNativeSetTarget(S, command) {
  const snapshot = workoutSnapshot(S)
  return !!(snapshot?.canCompleteSet
    && typeof command?.id === 'string' && command.id.length > 0
    && snapshot.workoutId === command.workoutId
    && snapshot.setEntryIndex === command.entryIndex
    && snapshot.setExerciseId === command.exerciseId
    && snapshot.setIndex === command.setIndex
    && snapshot.setSide === (command.side || '')
    && snapshot.setToken === command.setToken)
}

export function receiveNativeSetCommand(command) {
  if (!command || command.type !== 'complete-set'
    || typeof command.id !== 'string' || !command.id) return
  nativeCommands.set(command.id, command)
  for (const listener of pendingSubscribers) {
    try { listener() } catch { /* navigation can wait for the next visible pass */ }
  }
  void flushNativeSets()
  void acknowledgeOrphanedSets(trackedStore)
}

export const hasNativeSetPending = () => nativeCommands.size > 0

export function subscribeNativeSetPending(listener) {
  pendingSubscribers.add(listener)
  if (nativeCommands.size) queueMicrotask(() => {
    try { listener() } catch { /* navigation can be retried on visibilitychange */ }
  })
  return () => pendingSubscribers.delete(listener)
}

/** Register the SAME toggle used by in-app set rows. If not mounted, keep commands
 * queued and do not acknowledge them; native will redeliver on a later bind. */
export function registerNativeSetHandler(handler) {
  completeHandler = handler
  void flushNativeSets()
  return () => { if (completeHandler === handler) completeHandler = null }
}

async function flushNativeSets() {
  if (draining || !completeHandler) return
  draining = true
  try {
    for (const [id, command] of nativeCommands) {
      if (!completeHandler) break
      if (!processedNativeIds.has(id)) {
        let committed
        try { committed = await completeHandler(command) }
        catch { break }
        // undefined means the app has not finished restoring; no ACK, retry later.
        if (committed !== true && committed !== false) break
        // A later native ACK failure must never cause a second JS set toggle.
        processedNativeIds.add(id)
      }
      if (!(await ackSetCompletion(id))) break
      nativeCommands.delete(id)
      processedNativeIds.delete(id)
    }
  } finally { draining = false }
}
