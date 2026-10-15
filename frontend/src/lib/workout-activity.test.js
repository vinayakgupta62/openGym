import { describe, expect, it, vi } from 'vitest'
vi.mock('./mobile.js', () => ({ MOBILE: true }))
vi.mock('./exercises.js', () => ({ exOr: id => ({ n: id, id }) }))
vi.mock('./format.js', () => ({ exerciseNameText: e => e.n, fmtNum: n => String(n) }))
vi.mock('./i18n-core.js', () => ({ t: (s, n) => s.replace('{0}', String(n)) }))
vi.mock('./accent.js', () => ({ accentValue: () => 'green' }))
vi.mock('./rest-alert.js', () => ({ accentColors: () => ({ accent: 0xff30d158, ink: 0xff000000 }) }))
vi.mock('./history.js', () => ({
  doneUnits: s => s.done ? 1 : 0,
  setUnits: () => 1,
  isBw: () => false,
  modeOf: () => 'reps',
  setLabel: (_, s) => s.w + '×' + s.r,
}))
vi.mock('./speed.js', () => ({ speedUnitOf: () => 'km/h' }))
vi.mock('./rest-activity.js', () => ({ syncWorkoutActivity: vi.fn(async () => true) }))
import { workoutSnapshot, watchWorkoutActivity } from './workout-activity.js'
import { syncWorkoutActivity } from './rest-activity.js'

const session = () => ({
  unit: 'kg', active: {
    id: 'w1', name: 'Upper Body', start: 1000000, cur: 0,
    entries: [
      { id: 'Bench Press', target: {}, sets: [{ w: 60, r: 8, done: true }, { w: 60, r: 8, done: false }] },
      { id: 'Incline Row', target: {}, sets: [{ w: 30, r: 10, done: false }] },
    ],
  },
})

describe('Live Activity during the entire workout', () => {
  it('shows the next set and target instead of only the rest countdown', () => {
    const live = workoutSnapshot(session())
    expect(live.workoutName).toBe('Upper Body')
    expect(live.exerciseName).toBe('Bench Press')
    expect(live.nextSetLabel).toBe('Set 2 / 2')
    expect(live.targetText).toBe('60 kg × 8')
    expect([live.completedSets, live.totalSets]).toEqual([1, 3])
  })
  it('moves to the next unfinished exercise when the selected one is done', () => {
    const S = session()
    S.active.entries[0].sets[1].done = true
    expect(workoutSnapshot(S).exerciseName).toBe('Incline Row')
  })
  it('does not create a Live Activity for an edited historical workout', () => {
    const S = session()
    S.active.editingWorkoutId = 'history-id'
    expect(workoutSnapshot(S)).toBeNull()
  })
  it('syncs state only when the displayed workout changes', async () => {
    const store = {
      value: { S: session() }, fn: null,
      getState() { return this.value },
      subscribe(fn) { this.fn = fn; return () => { this.fn = null } },
    }
    const stop = watchWorkoutActivity(store)
    await new Promise(resolve => setTimeout(resolve, 0))
    const initial = vi.mocked(syncWorkoutActivity).mock.calls.length
    store.value = { S: { ...store.value.S } }
    store.fn(store.value, { S: session() })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(syncWorkoutActivity).toHaveBeenCalledTimes(initial)
    stop()
  })
})
