import { describe, expect, it, vi } from 'vitest'
vi.mock('./mobile.js', () => ({ MOBILE: true }))
vi.mock('./exercises.js', () => ({ exOr: id => ({ n: id, id }) }))
vi.mock('./format.js', () => ({ exerciseNameText: e => e.n, fmtNum: n => String(n) }))
vi.mock('./i18n-core.js', () => ({ t: (s, n) => s.replace('{0}', String(n)) }))
vi.mock('./accent.js', () => ({ accentValue: () => 'green' }))
vi.mock('./rest-alert.js', () => ({ accentColors: () => ({ accent: 0xff30d158, ink: 0xff000000 }) }))
vi.mock('./history.js', () => ({
  doneUnits: s => s.sides ? Number(!!s.sides.L.done) + Number(!!s.sides.R.done) : (s.done ? 1 : 0),
  setUnits: s => s.sides ? 2 : 1,
  isBw: () => false,
  modeOf: c => c.mode || 'reps',
  setLabel: (_, s) => s.w + '×' + s.r,
}))
vi.mock('./workout-model.js', () => ({ isSideSet: s => !!s?.sides }))
vi.mock('./workout-keys.js', () => ({
  nextOpenSet: (entries, cur) => {
    if (!entries?.length) return null
    for (const idx of [...entries.keys()].map(i => (i + (cur || 0)) % entries.length)) {
      const i = entries[idx].sets.findIndex(s => !s.done)
      if (i >= 0) {
        const s = entries[idx].sets[i]
        return { idx, i, side: s.sides ? (s.sides.L.done ? 'R' : 'L') : undefined, current: idx === cur }
      }
    }
    return null
  },
}))
vi.mock('./speed.js', () => ({ speedUnitOf: () => 'km/h' }))
vi.mock('./rest-activity.js', () => ({
  syncWorkoutActivity: vi.fn(async () => true),
  ackSetCompletion: vi.fn(async () => true),
}))
import { workoutSnapshot, watchWorkoutActivity, validNativeSetTarget, receiveNativeSetCommand, registerNativeSetHandler } from './workout-activity.js'
import { syncWorkoutActivity, ackSetCompletion } from './rest-activity.js'

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

describe('Lock Screen Complete Set safety', () => {
  it('accepts only the exact workout, exercise, row, side and fingerprint', () => {
    const S = session()
    const target = workoutSnapshot(S)
    const command = {
      type: 'complete-set', id: 'command-1',
      workoutId: target.workoutId, entryIndex: target.setEntryIndex,
      exerciseId: target.setExerciseId, setIndex: target.setIndex,
      side: target.setSide, setToken: target.setToken,
    }
    expect(validNativeSetTarget(S, command)).toBe(true)
    expect(validNativeSetTarget(S, { ...command, setIndex: 0 })).toBe(false)
    expect(validNativeSetTarget(S, { ...command, workoutId: 'older-session' })).toBe(false)
    S.active.entries[0].sets[1].w = 62.5
    expect(validNativeSetTarget(S, command)).toBe(false)
  })

  it('knows which unilateral side is next, and counts sides independently', () => {
    const S = session()
    S.active.entries[0].sets = [{
      sides: { L: { w: 15, r: 8, done: true }, R: { w: 15, r: 8, done: false } },
      w: 15, r: 16, done: false,
    }]
    const snap = workoutSnapshot(S)
    expect(snap.setSide).toBe('R')
    expect(snap.nextSetLabel).toContain('Right')
    expect([snap.completedSets, snap.totalSets]).toEqual([1, 3])
  })

  it('does not permit direct completion of time-based and cardio sets', () => {
    const S = session()
    S.active.entries[0].target = { mode: 'time' }
    expect(workoutSnapshot(S).canCompleteSet).toBe(false)
    S.active.entries[0].target = { mode: 'cardio' }
    expect(workoutSnapshot(S).canCompleteSet).toBe(false)
  })

  it('ACKs a durable native command only AFTER the real completion handler returns', async () => {
    vi.mocked(ackSetCompletion).mockClear()
    let finish
    const complete = new Promise(resolve => { finish = resolve })
    const unbind = registerNativeSetHandler(() => complete)
    receiveNativeSetCommand({ type: 'complete-set', id: 'native-42' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ackSetCompletion).not.toHaveBeenCalled()
    finish(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ackSetCompletion).toHaveBeenCalledWith('native-42')
    unbind()
  })

  it('waits for boot before syncing a cached workout and syncs when ready flips', async () => {
    vi.mocked(syncWorkoutActivity).mockClear()
    const store = {
      value: { S: session(), ready: false }, fn: null,
      getState() { return this.value },
      subscribe(fn) { this.fn = fn; return () => { this.fn = null } },
    }
    const unsub = watchWorkoutActivity(store)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(syncWorkoutActivity).not.toHaveBeenCalled()
    const before = store.value
    store.value = { ...before, ready: true }
    store.fn(store.value, before)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(syncWorkoutActivity).toHaveBeenCalledTimes(1)
    unsub()
  })
})

describe('durable native set command retries', () => {
  it('does not call the set completion handler again if only the native ACK failed', async () => {
    vi.mocked(ackSetCompletion).mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    let count = 0
    const unbind = registerNativeSetHandler(async () => { count++; return true })
    const cmd = { type: 'complete-set', id: 'retry-55' }
    receiveNativeSetCommand(cmd)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(count).toBe(1)
    expect(ackSetCompletion).toHaveBeenCalledTimes(1)
    receiveNativeSetCommand(cmd) // a second native bind redelivers the same durable ID
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(count).toBe(1)
    expect(ackSetCompletion).toHaveBeenCalledTimes(2)
    vi.mocked(ackSetCompletion).mockResolvedValue(true)
    unbind()
  })
})
