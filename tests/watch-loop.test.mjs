import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, LockHeldError, MAX_TICK_FAILURES, releaseLock, runWatch } from '../scripts/watch-loop.mjs'
import { emptyHistory, WATCH_DEFAULTS } from '../scripts/watch.mjs'

const BASE = Date.UTC(2026, 10, 1, 9, 0, 0)
const MINUTE = 60 * 1000

// A fake clock: `sleep` advances it, `now` reads it. Nothing here touches the real clock.
function fakeClock() {
  let clock = BASE
  return {
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  }
}

function memoryState(initial = {}) {
  let stored = structuredClone(initial)
  const saves = []
  return {
    state: {
      load: async () => structuredClone(stored),
      save: async (history) => {
        const copy = structuredClone(history)
        saves.push(copy)
        stored = copy
      },
    },
    saves,
  }
}

// `config` with the interval equal to the stale window, so ticks land exactly one window apart.
const spacedConfig = { ...WATCH_DEFAULTS, intervalMinutes: WATCH_DEFAULTS.staleMinutes }

test('a task stalled on every tick climbs resume, resume, respawn, resume, resume, orphan', async () => {
  const clock = fakeClock()
  const events = []
  const actions = []
  let ticks = 0
  const code = await runWatch({
    tick: async () => {
      ticks++
      if (ticks > 8) return { inFlight: false, rows: [] }
      return { inFlight: true, rows: [{ taskId: 't1', state: 'stalled' }] }
    },
    emit: (e) => events.push(e),
    state: memoryState().state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
    onAction: async (taskId, decision) => { actions.push([taskId, decision.action]) },
  })
  assert.equal(code, 0)
  const ladder = events.filter((e) => e.event !== 'exit')
  assert.deepEqual(
    ladder.map((e) => (e.attempt ? `${e.event} ${e.attempt}` : e.event)),
    ['resume 1', 'resume 2', 'respawn 1', 'resume 1', 'resume 2', 'orphan'],
  )
  // Each action lands one stale window after the previous one: 0, 20, 40, 60, 80, 100 minutes.
  assert.deepEqual(
    ladder.map((e) => e.at),
    [0, 20, 40, 60, 80, 100].map((m) => new Date(BASE + m * MINUTE).toISOString()),
  )
  assert.equal(events.at(-1).event, 'orphan', 'the phase going idle ends the loop without an event of its own')
  assert.equal(actions.length, 6, 'onAction runs once per non-none action and never for a silent tick')
  assert.deepEqual(actions.map(([id]) => id), ['t1', 't1', 't1', 't1', 't1', 't1'])
  assert.deepEqual(actions.map(([, action]) => action), ['resume', 'resume', 'respawn', 'resume', 'resume', 'orphan'])
})

test('a task orphaned earlier produces no further events', async () => {
  const clock = fakeClock()
  const events = []
  let ticks = 0
  const { state } = memoryState({ t1: { ...emptyHistory(), orphaned: true } })
  const code = await runWatch({
    tick: async () => {
      ticks++
      if (ticks > 3) return { inFlight: false, rows: [] }
      return { inFlight: true, rows: [{ taskId: 't1', state: 'stalled' }] }
    },
    emit: (e) => events.push(e),
    state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
  })
  assert.equal(code, 0)
  assert.deepEqual(events, [])
})

// Only actionable events are printed: the phase going idle wakes nobody, and the caller reads the
// exit code (docs/specs/2026-11-06-cost-cuts-design.md, section 3).
test('a tick that reports the phase is no longer in flight exits 0 without emitting an event', async () => {
  const clock = fakeClock()
  const events = []
  let tickCalls = 0
  const { state } = memoryState()
  const code = await runWatch({
    tick: async () => { tickCalls++; return { inFlight: false, rows: [{ taskId: 't1', state: 'stalled' }] } },
    emit: (e) => events.push(e),
    state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
  })
  assert.equal(code, 0)
  assert.equal(tickCalls, 1)
  assert.deepEqual(events, [])
})

test('three consecutive tick failures emit three watch-error events then exit errors with code 1', async () => {
  const clock = fakeClock()
  const events = []
  const { state } = memoryState()
  const code = await runWatch({
    tick: async () => { throw new Error('git went away') },
    emit: (e) => events.push(e),
    state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
  })
  assert.equal(code, 1)
  assert.equal(MAX_TICK_FAILURES, 3)
  assert.deepEqual(
    events.map((e) => e.event),
    ['watch-error', 'watch-error', 'watch-error', 'exit'],
  )
  assert.equal(events.at(-1).reason, 'errors')
  assert.match(events[0].message, /git went away/)
})

test('two failures then a success reset the failure count', async () => {
  const clock = fakeClock()
  const events = []
  const script = ['fail', 'fail', 'ok', 'fail', 'fail', 'idle']
  let call = 0
  const { state } = memoryState()
  const code = await runWatch({
    tick: async () => {
      const step = script[call++]
      if (step === 'fail') throw new Error('transient')
      if (step === 'idle') return { inFlight: false, rows: [] }
      return { inFlight: true, rows: [] }
    },
    emit: (e) => events.push(e),
    state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
  })
  assert.equal(code, 0)
  assert.deepEqual(
    events.map((e) => e.event),
    ['watch-error', 'watch-error', 'watch-error', 'watch-error'],
  )
})

test('state.save receives the history after every successful tick', async () => {
  const clock = fakeClock()
  let ticks = 0
  const { state, saves } = memoryState()
  await runWatch({
    tick: async () => {
      ticks++
      if (ticks > 2) return { inFlight: false, rows: [] }
      return { inFlight: true, rows: [{ taskId: 't1', state: 'stalled' }] }
    },
    emit: () => {},
    state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
  })
  assert.equal(saves.length, 2)
  assert.equal(saves[0].t1.resumes, 1)
  assert.equal(saves[1].t1.resumes, 2)
})

test('a loop started with a saved resumes:2 history makes the next stall a respawn', async () => {
  const clock = fakeClock()
  const events = []
  let ticks = 0
  const { state } = memoryState({ t1: { ...emptyHistory(), resumes: 2, lastActionAt: null } })
  await runWatch({
    tick: async () => {
      ticks++
      if (ticks > 1) return { inFlight: false, rows: [] }
      return { inFlight: true, rows: [{ taskId: 't1', state: 'stalled' }] }
    },
    emit: (e) => events.push(e),
    state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
  })
  assert.equal(events[0].event, 'respawn')
  assert.equal(events[0].attempt, 1)
})

test('onAction is awaited for each non-none action with the task id and decision', async () => {
  const clock = fakeClock()
  const log = []
  let ticks = 0
  const { state } = memoryState()
  await runWatch({
    tick: async () => {
      ticks++
      if (ticks > 1) return { inFlight: false, rows: [] }
      return { inFlight: true, rows: [{ taskId: 'a', state: 'stalled' }, { taskId: 'b', state: 'working' }] }
    },
    emit: (e) => log.push(`emit ${e.event} ${e.task}`),
    state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
    onAction: async (taskId, decision) => {
      await new Promise((resolve) => setImmediate(resolve))
      log.push(`action ${taskId} ${decision.action} ${decision.attempt}`)
    },
  })
  // `a` is stalled and `b` is working: only `a` produces an event and an action. The idle phase
  // that ends the loop emits nothing, so an unawaited action would be missing when it returns.
  assert.deepEqual(log, ['emit resume a', 'action a resume 1'])
})

test('a task id with a clear-screen CSI and a C1 CSI byte is emitted with neither raw byte', async () => {
  const clock = fakeClock()
  const events = []
  let ticks = 0
  const hostile = 'evil\u001b[2J\u009b31mname'
  const { state } = memoryState()
  await runWatch({
    tick: async () => {
      ticks++
      if (ticks > 1) return { inFlight: false, rows: [] }
      return { inFlight: true, rows: [{ taskId: hostile, state: 'stalled' }] }
    },
    emit: (e) => events.push(e),
    state,
    sleep: clock.sleep,
    now: clock.now,
    config: spacedConfig,
  })
  const row = events.find((e) => e.event === 'resume')
  assert.ok(row, 'the hostile task still produces its resume event')
  assert.equal(row.task.includes('\u001b'), false)
  assert.equal(row.task.includes('\u009b'), false)
  assert.equal(JSON.stringify(events).includes('\u001b'), false)
  assert.equal(JSON.stringify(events).includes('\u009b'), false)
})

test('acquireLock creates the file holding the pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wl-lock-'))
  try {
    const file = join(dir, 'watch.lock')
    await acquireLock(file, 1111, () => true)
    assert.equal(await readFile(file, 'utf8'), '1111\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a second acquireLock while the holder is alive throws LockHeldError naming the holder pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wl-lock-'))
  try {
    const file = join(dir, 'watch.lock')
    await acquireLock(file, 1111, () => true)
    await assert.rejects(
      acquireLock(file, 2222, (pid) => pid === 1111),
      (err) => err instanceof LockHeldError && /1111/.test(err.message),
    )
    assert.equal(await readFile(file, 'utf8'), '1111\n', 'a refused acquire leaves the holder in place')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('acquireLock takes over a stale lock whose holder is dead and rewrites the pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wl-lock-'))
  try {
    const file = join(dir, 'watch.lock')
    await writeFile(file, '1111\n')
    await acquireLock(file, 2222, () => false)
    assert.equal(await readFile(file, 'utf8'), '2222\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('releaseLock removes the file only when it still holds the given pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wl-lock-'))
  try {
    const file = join(dir, 'watch.lock')
    await acquireLock(file, 2222, () => false)
    await releaseLock(file, 9999)
    assert.equal(existsSync(file), true, 'a release by a pid that does not hold the lock leaves it')
    await releaseLock(file, 2222)
    assert.equal(existsSync(file), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
