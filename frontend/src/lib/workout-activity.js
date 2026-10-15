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
import { syncWorkoutActivity } from './rest-activity.js'

const color = value => '#' + ((Number(value) >>> 0) & 0xffffff).toString(16).padStart(6, '0')

/** Pure projection of the live workout for the widget and test suite. */
export function workoutSnapshot(S) {
  const A = S?.active
  // Past/backfilled sessions should never open a live activity from yesterday.
  if (!A || A.backfill || A.editingWorkoutId) return null
  const entries = Array.isArray(A.entries) ? A.entries : []
  const start = Number(A.start)
  if (!A.id || !Number.isFinite(start) || start <= 0) return null
  const at = Math.max(0, Math.min(entries.length - 1, Number.isInteger(A.cur) ? A.cur : 0))
  // The selected exercise wins unless it is finished; then show the next unfinished
  // exercise so the Lock Screen never suggests repeating a completed set.
  const order = Array.from({ length: entries.length }, (_, i) => (at + i) % entries.length)
  const idx = order.find(i => (entries[i].sets || []).some(row => !row.done)) ?? at
  const entry = entries[idx]
  const sets = entry?.sets || []
  const nextIdx = sets.findIndex(row => !row.done)
  const selected = nextIdx >= 0 ? sets[nextIdx] : null
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
    nextSetLabel: selected ? t('Set {0}', nextIdx + 1) + ' / ' + sets.length : t('All sets done'),
    targetText: targetText.slice(0, 100),
    completedSets: done,
    totalSets: total,
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
    const snapshot = workoutSnapshot(store.getState().S)
    const key = JSON.stringify(snapshot)
    if (!force && key === last) return
    last = key
    // Serialize JS -> native updates. Finishing one workout and starting the next
    // must not race a slow ActivityKit request from the preceding workout.
    chain = chain.then(() => stopped ? null : syncWorkoutActivity(snapshot)).catch(() => {})
  }
  sync()
  const unStore = store.subscribe((next, prev) => {
    if (next.S !== prev.S) sync()
  })
  const onVisible = () => { if (!document.hidden) sync(true) }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  return () => {
    stopped = true
    unStore()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}
