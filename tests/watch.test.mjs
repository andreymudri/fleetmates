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
