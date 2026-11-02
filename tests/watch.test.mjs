import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextAction, emptyHistory, WATCH_DEFAULTS } from '../scripts/watch.mjs'

const MIN = 60 * 1000
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0)
const stalled = { taskId: 'T1', state: 'stalled' }
const config = { ...WATCH_DEFAULTS }
const window = config.staleMinutes * MIN

test('first stall is a resume, attempt 1', () => {
  const d = nextAction(stalled, undefined, config, T0)
  assert.equal(d.action, 'resume')
  assert.equal(d.attempt, 1)
  assert.equal(d.history.resumes, 1)
  assert.equal(d.history.lastActionAt, T0)
})

test('a second stall after the window is a resume, attempt 2', () => {
  const first = nextAction(stalled, undefined, config, T0)
  const second = nextAction(stalled, first.history, config, T0 + window)
  assert.equal(second.action, 'resume')
  assert.equal(second.attempt, 2)
  assert.equal(second.history.resumes, 2)
})

test('a third stall is a respawn, attempt 1, and resets resumes to 0', () => {
  let h = emptyHistory()
  let t = T0
  for (let i = 0; i < 2; i++) { h = nextAction(stalled, h, config, t).history; t += window }
  const d = nextAction(stalled, h, config, t)
  assert.equal(d.action, 'respawn')
  assert.equal(d.attempt, 1)
  assert.equal(d.history.resumes, 0)
  assert.equal(d.history.respawns, 1)
})

test('after a respawn, two resumes then orphan', () => {
  let h = { resumes: 0, respawns: 1, lastActionAt: null, orphaned: false, notified: false }
  let t = T0
  const seen = []
  for (let i = 0; i < 3; i++) {
    const d = nextAction(stalled, h, config, t)
    seen.push(d.action)
    h = d.history
    t += window
  }
  assert.deepEqual(seen, ['resume', 'resume', 'orphan'])
})

test('an orphaned history is none forever', () => {
  const h = { ...emptyHistory(), orphaned: true, resumes: 2, respawns: 1, lastActionAt: T0 }
  for (const later of [T0, T0 + window, T0 + 100 * window]) {
    const d = nextAction(stalled, h, config, later)
    assert.equal(d.action, 'none')
    assert.equal(d.history.orphaned, true)
  }
})

test('a stall inside staleMinutes of lastActionAt is none', () => {
  const h = { ...emptyHistory(), resumes: 1, lastActionAt: T0 }
  const d = nextAction(stalled, h, config, T0 + window - MIN)
  assert.equal(d.action, 'none')
  assert.equal(d.history.resumes, 1)
})

test('working and not started rows are none with history unchanged', () => {
  const h = { ...emptyHistory(), resumes: 1, lastActionAt: T0 }
  for (const state of ['working', 'not started']) {
    const d = nextAction({ taskId: 'T1', state }, h, config, T0 + 10 * window)
    assert.equal(d.action, 'none')
    assert.deepEqual(d.history, h)
  }
})

test('unknown is unmeasured once carrying the reason, then none', () => {
  const row = { taskId: 'T1', state: 'unknown', unknownReason: 'no commit timestamp' }
  const first = nextAction(row, undefined, config, T0)
  assert.equal(first.action, 'unmeasured')
  assert.equal(first.reason, 'no commit timestamp')
  assert.equal(first.history.notified, true)
  const second = nextAction(row, first.history, config, T0 + window)
  assert.equal(second.action, 'none')
})

test('resumes 0 and respawns 0: the first stall is orphan', () => {
  const d = nextAction(stalled, undefined, { ...config, resumes: 0, respawns: 0 }, T0)
  assert.equal(d.action, 'orphan')
  assert.equal(d.history.orphaned, true)
})

test('resumes 0 and respawns 1: the first stall is respawn', () => {
  const d = nextAction(stalled, undefined, { ...config, resumes: 0, respawns: 1 }, T0)
  assert.equal(d.action, 'respawn')
  assert.equal(d.attempt, 1)
})

// Without the guard, a NaN clock makes `now - lastActionAt < window` false, so a just-nudged task
// would be resumed again on every tick. The guard refuses the clock instead.
test('nextAction refuses a non-finite clock instead of deciding', () => {
  const h = { ...emptyHistory(), resumes: 1, lastActionAt: T0 }
  for (const bad of [NaN, undefined, Infinity]) {
    assert.throws(() => nextAction(stalled, h, config, bad), /numeric clock/)
  }
})

test('the input history object is never mutated', () => {
  const h = { resumes: 1, respawns: 0, lastActionAt: null, orphaned: false, notified: false }
  const snapshot = JSON.stringify(h)
  nextAction(stalled, h, config, T0)
  nextAction({ taskId: 'T1', state: 'unknown' }, h, config, T0)
  nextAction(stalled, h, { ...config, resumes: 0, respawns: 0 }, T0)
  assert.equal(JSON.stringify(h), snapshot)
})

const spinning = { taskId: 'T1', state: 'spinning' }

test('a spinning row walks the same ladder as stalled, every non-none decision carrying reason spinning', () => {
  let hs = emptyHistory()
  let hp = emptyHistory()
  let t = T0
  const seen = []
  for (let i = 0; i < 5; i++) {
    const ds = nextAction(spinning, hs, config, t)
    const dp = nextAction(stalled, hp, config, t)
    assert.equal(ds.action, dp.action)
    assert.equal(ds.attempt, dp.attempt)
    assert.deepEqual(ds.history, dp.history)
    assert.equal(ds.reason, 'spinning', `${ds.action} attempt ${ds.attempt}`)
    seen.push(ds.action)
    hs = ds.history
    hp = dp.history
    t += window
  }
  assert.deepEqual(seen, ['resume', 'resume', 'respawn', 'resume', 'resume'])
  const last = nextAction(spinning, hs, config, t)
  assert.equal(last.action, 'orphan')
  assert.equal(last.reason, 'spinning')
  const inside = nextAction(spinning, { ...emptyHistory(), resumes: 1, lastActionAt: T0 }, config, T0 + MIN)
  assert.equal(inside.action, 'none')
  assert.equal('reason' in inside, false)
})

test('a stalled row\'s decisions carry no reason', () => {
  let h = emptyHistory()
  let t = T0
  for (let i = 0; i < 6; i++) {
    const d = nextAction(stalled, h, config, t)
    assert.notEqual(d.action, 'none')
    assert.equal('reason' in d, false, d.action)
    h = d.history
    t += window
  }
})

test('emptyHistory has maxQuietMs null and sampled false', () => {
  const h = emptyHistory()
  assert.equal(h.maxQuietMs, null)
  assert.equal(h.sampled, false)
})

test('maxQuietMs is the largest min(tipAgeMs, touchAgeMs) seen for working, stalled and spinning rows', () => {
  let h = emptyHistory()
  const steps = [
    [{ state: 'working', tipAgeMs: 5 * MIN, touchAgeMs: 2 * MIN }, 2 * MIN],
    [{ state: 'stalled', tipAgeMs: 30 * MIN, touchAgeMs: 25 * MIN }, 25 * MIN],
    [{ state: 'working', tipAgeMs: 1 * MIN, touchAgeMs: 1 * MIN }, 25 * MIN],
    [{ state: 'spinning', tipAgeMs: 40 * MIN, touchAgeMs: null }, 40 * MIN],
    [{ state: 'working', tipAgeMs: null, touchAgeMs: 50 * MIN }, 50 * MIN],
    [{ state: 'working', tipAgeMs: null, touchAgeMs: null }, 50 * MIN],
  ]
  let t = T0
  for (const [row, expected] of steps) {
    h = nextAction({ taskId: 'T1', ...row }, h, config, t).history
    assert.equal(h.maxQuietMs, expected, `after ${JSON.stringify(row)}`)
    t += window
  }
})

test('maxQuietMs is tracked even for an orphaned history', () => {
  const h = { ...emptyHistory(), orphaned: true }
  const d = nextAction({ taskId: 'T1', state: 'working', tipAgeMs: 7 * MIN, touchAgeMs: 9 * MIN }, h, config, T0)
  assert.equal(d.history.maxQuietMs, 7 * MIN)
})

test('maxQuietMs is untouched by unknown and not started rows', () => {
  const h = { ...emptyHistory(), maxQuietMs: 3 * MIN }
  for (const state of ['unknown', 'not started']) {
    const d = nextAction({ taskId: 'T1', state, tipAgeMs: 90 * MIN, touchAgeMs: 90 * MIN }, h, config, T0)
    assert.equal(d.history.maxQuietMs, 3 * MIN, state)
  }
  const fresh = nextAction({ taskId: 'T1', state: 'not started', tipAgeMs: 90 * MIN, touchAgeMs: 90 * MIN }, undefined, config, T0)
  assert.equal(fresh.history.maxQuietMs, null)
})

test('tracking maxQuietMs never mutates the input history', () => {
  const h = { ...emptyHistory(), maxQuietMs: MIN }
  const snapshot = JSON.stringify(h)
  for (const state of ['working', 'stalled', 'spinning']) {
    nextAction({ taskId: 'T1', state, tipAgeMs: 60 * MIN, touchAgeMs: 60 * MIN }, h, config, T0)
  }
  assert.equal(JSON.stringify(h), snapshot)
})
