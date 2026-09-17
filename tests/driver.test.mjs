import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, link } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dispatchPhase, fixedRefusal, DriverLockError,
  killProcess, waitForExit, releaseLock, runPool, acquireLock, pidAlive,
} from '../scripts/driver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SUBAGENT_STOP = path.join(HERE, '..', 'scripts', 'subagent-stop.mjs')

const DONE = { status: 'done', branch: 'b', filesChanged: ['a'], summary: 's', blockers: [] }

// A fake child process: an EventEmitter that records the kill signals it receives. With no `pid`
// property, the driver's kill path falls straight to `child.kill`, which we can then assert on.
// `exitDelayMs` lets a test hold a child in-flight so peak concurrency can be observed.
function makeChild({ exits = true, exitDelayMs = 0, onExit } = {}) {
  const child = new EventEmitter()
  child.kills = []
  child.kill = (sig) => { child.kills.push(sig); return true }
  if (exits) {
    const fire = () => { onExit?.(); child.emit('exit', 0) }
    if (exitDelayMs > 0) setTimeout(fire, exitDelayMs)
    else setImmediate(fire)
  }
  return child
}

// A plain-JS adapter with no real codex behind it. Records every call and returns scripted
// results/usage/enforcement codes so each driver path can be exercised deterministically.
function makeStubAdapter({
  result = DONE, usage = null, enforcementCodes = [0], neverExit = false,
  exitDelayForTask,
} = {}) {
  const calls = { makeSandbox: [], spawn: [], resume: [], collect: [], readResult: [], enforcement: [] }
  const children = []
  const concurrency = { inFlight: 0, peak: 0 }
  let ei = 0
  const branchTask = (branch) => branch.split('/').pop()
  const adapter = {
    name: 'stub',
    async makeSandbox(_git, opts) {
      calls.makeSandbox.push(opts)
      return { cwd: `/cwd/${opts.taskId}`, meta: { mode: opts.mode, gitdir: `/gd/${opts.taskId}`, branch: `fleetmates/${opts.runId}/${opts.taskId}` } }
    },
    async spawn(opts) {
      calls.spawn.push(opts)
      const taskId = branchTask(opts.sandbox.meta.branch)
      concurrency.inFlight += 1
      concurrency.peak = Math.max(concurrency.peak, concurrency.inFlight)
      const exitDelayMs = exitDelayForTask ? exitDelayForTask(taskId) : 0
      const child = makeChild({ exits: !neverExit, exitDelayMs, onExit: () => { concurrency.inFlight -= 1 } })
      children.push(child)
      return { child, sessionId: Promise.resolve(`sid-${taskId}`) }
    },
    async resume(opts) {
      calls.resume.push(opts)
      const child = makeChild({ exits: !neverExit })
      children.push(child)
      return { child, sessionId: Promise.resolve(opts.sessionId) }
    },
    async collect(_git, opts) { calls.collect.push(opts) },
    async cleanup() {},
    async readResult(opts) {
      calls.readResult.push(opts)
      return typeof result === 'function' ? result() : result
    },
    async readUsage() { return usage },
  }
  const completeEnforcement = async (taskId) => {
    calls.enforcement.push(taskId)
    const code = enforcementCodes[Math.min(ei, enforcementCodes.length - 1)]
    ei += 1
    return code
  }
  return { adapter, calls, children, completeEnforcement, concurrency }
}

function baseArgs(runDir, overrides = {}) {
  return {
    git: async () => ({ code: 0, stdout: '', stderr: '' }),
    runRepo: '/run/repo',
    runId: 'r',
    runBranch: 'run/r',
    phaseTasks: [{ id: 'T1' }],
    maxParallel: 2,
    sandboxMode: 'clone',
    network: false,
    timeoutMinutes: 5,
    tierModels: {},
    effortFor: () => undefined,
    composeBriefFor: (t) => `brief for ${t.id}`,
    personaFor: (role) => `persona ${role}`,
    runDir,
    ...overrides,
  }
}

async function tmpRunDir(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `driver-${name}-`))
  return dir
}

async function readSession(runDir, taskId) {
  const raw = await readFile(path.join(runDir, 'sessions', `${taskId}.json`), 'utf8')
  return JSON.parse(raw)
}

test('one task spawns, its done result is recorded, and no resume happens', async () => {
  const runDir = await tmpRunDir('spawn')
  const { adapter, calls, completeEnforcement } = makeStubAdapter({ enforcementCodes: [0] })
  const out = await dispatchPhase(baseArgs(runDir, { runId: 'r1', adapter, completeEnforcement }))

  assert.deepEqual(out.orphaned, [])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].taskId, 'T1')
  assert.equal(out.results[0].status, 'done')
  assert.equal(calls.spawn.length, 1)
  assert.equal(calls.resume.length, 0)
  assert.equal(calls.enforcement.length, 1)

  const session = await readSession(runDir, 'T1')
  assert.equal(session.sessionId, 'sid-T1')
  assert.equal(session.state, 'done')
  assert.equal(session.result.status, 'done')
})

test('enforcement 3 then 0 resumes once with the fixed refusal and records done', async () => {
  const runDir = await tmpRunDir('enf-recover')
  const { adapter, calls, completeEnforcement } = makeStubAdapter({ enforcementCodes: [3, 0] })
  const out = await dispatchPhase(baseArgs(runDir, { runId: 'r2', adapter, completeEnforcement }))

  assert.deepEqual(out.orphaned, [])
  assert.equal(out.results[0].status, 'done')
  assert.equal(calls.resume.length, 1)
  assert.equal(calls.resume[0].message, fixedRefusal('T1', 'r2'))
  assert.equal(calls.enforcement.length, 2)
  assert.equal(calls.collect.length, 2)

  const session = await readSession(runDir, 'T1')
  assert.equal(session.state, 'done')
})

test('enforcement 3 twice fails the task and records the enforcement reason', async () => {
  const runDir = await tmpRunDir('enf-fail')
  const { adapter, calls, completeEnforcement } = makeStubAdapter({ enforcementCodes: [3, 3] })
  const out = await dispatchPhase(baseArgs(runDir, { runId: 'r3', adapter, completeEnforcement }))

  assert.deepEqual(out.orphaned, [])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].taskId, 'T1')
  assert.equal(out.results[0].status, 'failed')
  assert.ok(out.results[0].blockers.some((b) => /enforcement/.test(b)))
  assert.equal(calls.resume.length, 1)
  assert.equal(calls.enforcement.length, 2)

  const session = await readSession(runDir, 'T1')
  assert.equal(session.state, 'failed')
  assert.equal(session.exitReason, 'enforcement')
})

test('a null result orphans the task without collecting or enforcing', async () => {
  const runDir = await tmpRunDir('orphan-null')
  const { adapter, calls, completeEnforcement } = makeStubAdapter({ result: null })
  const out = await dispatchPhase(baseArgs(runDir, { runId: 'r4', adapter, completeEnforcement }))

  assert.deepEqual(out.results, [])
  assert.deepEqual(out.orphaned, ['T1'])
  assert.equal(calls.spawn.length, 1)
  assert.equal(calls.collect.length, 0)
  assert.equal(calls.enforcement.length, 0)

  const session = await readSession(runDir, 'T1')
  assert.equal(session.state, 'orphaned')
})

test('a timeout orphans the task, records the session id, and kills the child', async () => {
  const runDir = await tmpRunDir('orphan-timeout')
  const { adapter, calls, children, completeEnforcement } = makeStubAdapter({ neverExit: true })
  const out = await dispatchPhase(baseArgs(runDir, {
    runId: 'r5', adapter, completeEnforcement, timeoutMinutes: 0.002,
  }))

  assert.deepEqual(out.results, [])
  assert.deepEqual(out.orphaned, ['T1'])
  assert.equal(calls.enforcement.length, 0)

  const session = await readSession(runDir, 'T1')
  assert.equal(session.sessionId, 'sid-T1')
  assert.equal(session.state, 'orphaned')
  assert.equal(session.exitReason, 'timeout')
  assert.ok(children[0].kills.includes('SIGTERM'))
})

test('a recorded valid result is skipped and a session without a result is resumed', async () => {
  const runDir = await tmpRunDir('resume-run')
  const sessionsDir = path.join(runDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(path.join(sessionsDir, 'T1.json'),
    `${JSON.stringify({ taskId: 'T1', sessionId: 'sid-T1', state: 'done', result: DONE })}\n`)
  await writeFile(path.join(sessionsDir, 'T2.json'),
    `${JSON.stringify({ taskId: 'T2', sessionId: 'old-T2', sandbox: { cwd: '/cwd/T2', meta: { mode: 'clone', gitdir: '/gd/T2', branch: 'fleetmates/r6/T2' } } })}\n`)

  const { adapter, calls, completeEnforcement } = makeStubAdapter({ enforcementCodes: [0] })
  const out = await dispatchPhase(baseArgs(runDir, {
    runId: 'r6', adapter, completeEnforcement, phaseTasks: [{ id: 'T1' }, { id: 'T2' }],
  }))

  assert.deepEqual(out.orphaned, [])
  assert.deepEqual(out.results.map((r) => r.taskId).sort(), ['T1', 'T2'])
  // T1 was skipped: no spawn, no resume. T2 reused its recorded sandbox: no makeSandbox.
  assert.equal(calls.spawn.length, 0)
  assert.equal(calls.makeSandbox.length, 0)
  assert.equal(calls.resume.length, 1)
  assert.equal(calls.resume[0].sessionId, 'old-T2')
})

test('a live driver.lock refuses a second dispatch with exit code 1', async () => {
  const runDir = await tmpRunDir('lock-live')
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'driver.lock'), `${process.pid}\n`)

  const { adapter, calls, completeEnforcement } = makeStubAdapter()
  await assert.rejects(
    dispatchPhase(baseArgs(runDir, { runId: 'r7', adapter, completeEnforcement })),
    (err) => {
      assert.ok(err instanceof DriverLockError)
      assert.equal(err.exitCode, 1)
      return true
    },
  )
  // Refused before doing any work.
  assert.equal(calls.spawn.length, 0)
})

test('a stale driver.lock (dead pid) is taken over', async () => {
  const runDir = await tmpRunDir('lock-stale')
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'driver.lock'), '2147483646\n')

  const { adapter, calls, completeEnforcement } = makeStubAdapter({ enforcementCodes: [0] })
  const out = await dispatchPhase(baseArgs(runDir, { runId: 'r8', adapter, completeEnforcement }))

  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].status, 'done')
  assert.equal(calls.spawn.length, 1)
})

test('a task whose makeSandbox throws is orphaned without abandoning its siblings', async () => {
  const runDir = await tmpRunDir('worker-throw')
  const stub = makeStubAdapter({ enforcementCodes: [0] })
  const original = stub.adapter.makeSandbox
  stub.adapter.makeSandbox = async (git, opts) => {
    if (opts.taskId === 'TA') throw new Error('clone failed for TA')
    return original(git, opts)
  }
  const out = await dispatchPhase(baseArgs(runDir, {
    runId: 'rw', adapter: stub.adapter, completeEnforcement: stub.completeEnforcement,
    phaseTasks: [{ id: 'TA' }, { id: 'TB' }],
  }))

  // The pool resolved (did not reject); the throwing task is orphaned, the sibling completed.
  assert.deepEqual(out.orphaned, ['TA'])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].taskId, 'TB')
  assert.equal(out.results[0].status, 'done')

  const sessionA = await readSession(runDir, 'TA')
  assert.equal(sessionA.state, 'orphaned')
  assert.match(sessionA.exitReason, /clone failed for TA/)
})

test('runPool tracks its cleanup promise so a throwing worker leaks no unhandled rejection', async () => {
  const seen = []
  const onUnhandled = (err) => seen.push(err)
  process.on('unhandledRejection', onUnhandled)
  let ran = 0
  try {
    await assert.rejects(runPool([1, 2, 3], 2, async (n) => {
      ran += 1
      if (n === 1) throw new Error('worker boom')
    }))
    // Give any detached rejected promise a full turn to surface as unhandled.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
  assert.equal(seen.length, 0, 'no unhandled rejection should escape runPool')
  assert.ok(ran >= 1)
})

test('two concurrent dispatches on one run: exactly one proceeds, the other is refused', async () => {
  const runDir = await tmpRunDir('concurrent-lock')
  const stubs = [makeStubAdapter({ enforcementCodes: [0] }), makeStubAdapter({ enforcementCodes: [0] })]
  const settled = await Promise.allSettled(stubs.map((s, i) => dispatchPhase(baseArgs(runDir, {
    runId: 'rc', adapter: s.adapter, completeEnforcement: s.completeEnforcement, phaseTasks: [{ id: `T${i}` }],
  }))))

  const fulfilled = settled.filter((r) => r.status === 'fulfilled')
  const rejected = settled.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok(rejected[0].reason instanceof DriverLockError)
  assert.equal(rejected[0].reason.exitCode, 1)
})

test('killProcess signals the process group (negative pid), not the child directly', () => {
  const original = process.kill
  const calls = []
  process.kill = (pid, sig) => { calls.push([pid, sig]) }
  try {
    const child = { pid: 424242, kill: () => calls.push(['child.kill']) }
    killProcess(child, 'SIGTERM')
  } finally {
    process.kill = original
  }
  assert.deepEqual(calls, [[-424242, 'SIGTERM']])
})

test('waitForExit escalates to SIGKILL after the grace when SIGTERM is ignored', async () => {
  const child = new EventEmitter()
  const signals = []
  child.kill = (sig) => { signals.push(sig) } // ignores the signal: never emits exit
  const reason = await waitForExit(child, 20, { killGraceMs: 40 })
  assert.equal(reason, 'timeout')
  assert.deepEqual(signals, ['SIGTERM'])
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('waitForExit settles immediately when the child has already exited', async () => {
  const child = new EventEmitter()
  child.exitCode = 0 // already exited: no further 'exit' event will ever fire
  const reason = await waitForExit(child, 100, { killGraceMs: 100 })
  assert.equal(reason, 'exit')
})

test('releaseLock leaves a lock naming a different pid intact', async () => {
  const runDir = await tmpRunDir('release-guard')
  const lockPath = path.join(runDir, 'driver.lock')
  await writeFile(lockPath, '2147483646\n')
  await releaseLock(lockPath)
  const still = await readFile(lockPath, 'utf8')
  assert.equal(still.trim(), '2147483646')
})

test('a stale-lock takeover racing a completed takeover refuses instead of clobbering it', async () => {
  // The documented interleaving, driven deterministically: actor B detects the dead holder and
  // pauses; actor A completes its takeover and holds a LIVE lock; B resumes and, because the
  // removal is re-validated under the takeover token, sees A's live lock and refuses rather than
  // deleting it. A destructive (rm/rename) takeover would delete A's lock and both would acquire.
  const runDir = await tmpRunDir('stale-race')
  const lockPath = path.join(runDir, 'driver.lock')
  const dead = 2147483646
  await writeFile(lockPath, `${dead}\n`)
  const isAlive = (p) => p === 1001 || p === 1002 // both actors alive; the seeded holder is dead

  let signalReached
  const bReachedSeam = new Promise((resolve) => { signalReached = resolve })
  let releaseB
  const bMayProceed = new Promise((resolve) => { releaseB = resolve })

  const bPromise = acquireLock(lockPath, {
    pid: 1002,
    isAlive,
    onDeadHolder: async () => { signalReached(); await bMayProceed },
  })
  await bReachedSeam

  // A takes over to completion while B is parked at the seam.
  await acquireLock(lockPath, { pid: 1001, isAlive })
  assert.equal((await readFile(lockPath, 'utf8')).trim(), '1001')

  releaseB()
  await assert.rejects(bPromise, (err) => {
    assert.ok(err instanceof DriverLockError)
    return true
  })
  // A's live lock survived untouched.
  assert.equal((await readFile(lockPath, 'utf8')).trim(), '1001')
})

test('a token-holder re-reading an empty slot never clobbers a competitor fresh live lock', async () => {
  // Drives the OS-level empty-slot window the seam-only test missed: a competitor removed the stale
  // lock (slot empty) and is between its rm and its non-token install; the token-holder must not
  // delete the competitor's fresh LIVE lock when it re-reads NaN under the token.
  const runDir = await tmpRunDir('empty-window')
  const lockPath = path.join(runDir, 'driver.lock')
  const dead = 2147483646
  await writeFile(lockPath, `${dead}\n`)
  const isAlive = (p) => p === 1001 || p === 1002
  const compTmp = path.join(runDir, 'comp.tmp')
  await writeFile(compTmp, '1002\n')

  const a = acquireLock(lockPath, {
    pid: 1001,
    isAlive,
    // competitor C removed the stale lock (slot now empty) before A claims the token
    onDeadHolder: async () => { await rm(lockPath, { force: true }) },
    // competitor C installs its fresh LIVE lock into the exact empty-slot window A re-reads
    onEmptyUnderToken: async () => { await link(compTmp, lockPath) },
  })
  await assert.rejects(a, (err) => err instanceof DriverLockError)
  // C's live lock is intact — A refused rather than deleting and replacing it.
  assert.equal((await readFile(lockPath, 'utf8')).trim(), '1002')
})

test('acquireLock throws DriverLockError when takeover attempts are exhausted', async () => {
  const runDir = await tmpRunDir('exhaust')
  const lockPath = path.join(runDir, 'driver.lock')
  const dead = 2147483646
  await writeFile(lockPath, `${dead}\n`)
  // A takeover token that never clears: every attempt sees EEXIST on the token and loops until the
  // bounded loop gives up, which must throw (never silently return without the lock).
  await writeFile(`${lockPath}.takeover`, 'held\n')
  await assert.rejects(
    acquireLock(lockPath, { pid: 1001, isAlive: (p) => p === 1001 }),
    (err) => err instanceof DriverLockError,
  )
})

test('pidAlive treats an EPERM (foreign, live) process as alive', () => {
  const original = process.kill
  process.kill = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e }
  try {
    assert.equal(pidAlive(4242), true)
  } finally {
    process.kill = original
  }
})

test('a lock held by an EPERM (foreign, live) pid is refused, not taken over', async () => {
  const runDir = await tmpRunDir('eperm-lock')
  const lockPath = path.join(runDir, 'driver.lock')
  await writeFile(lockPath, '4242\n')
  // Simulate a foreign live holder: kill(0) reports EPERM for its pid.
  const original = process.kill
  process.kill = (pid, sig) => {
    if (pid === 4242) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
    return original(pid, sig)
  }
  try {
    await assert.rejects(acquireLock(lockPath), (err) => err instanceof DriverLockError)
  } finally {
    process.kill = original
  }
  // The foreign holder's lock was not clobbered.
  assert.equal((await readFile(lockPath, 'utf8')).trim(), '4242')
})

test('dispatchPhase never runs more than maxParallel tasks at once', async () => {
  const runDir = await tmpRunDir('concurrency')
  const stub = makeStubAdapter({ enforcementCodes: [0], exitDelayForTask: () => 15 })
  const phaseTasks = Array.from({ length: 6 }, (_, i) => ({ id: `T${i}` }))
  const out = await dispatchPhase(baseArgs(runDir, {
    runId: 'rp', adapter: stub.adapter, completeEnforcement: stub.completeEnforcement,
    phaseTasks, maxParallel: 2,
  }))
  assert.equal(out.results.length, 6)
  assert.ok(stub.concurrency.peak <= 2, `peak concurrency ${stub.concurrency.peak} exceeded maxParallel 2`)
  assert.ok(stub.concurrency.peak >= 2, 'the pool should reach its bound with 6 tasks')
})

test('results come back in phaseTasks order even when tasks finish out of order', async () => {
  const runDir = await tmpRunDir('order')
  // T0 finishes last, T2 first: the reassembly must still yield T0, T1, T2.
  const delays = { T0: 30, T1: 15, T2: 0 }
  const stub = makeStubAdapter({ enforcementCodes: [0], exitDelayForTask: (id) => delays[id] ?? 0 })
  const out = await dispatchPhase(baseArgs(runDir, {
    runId: 'ro', adapter: stub.adapter, completeEnforcement: stub.completeEnforcement,
    phaseTasks: [{ id: 'T0' }, { id: 'T1' }, { id: 'T2' }], maxParallel: 3,
  }))
  assert.deepEqual(out.results.map((r) => r.taskId), ['T0', 'T1', 'T2'])
})

test('a failed session write during orphaning does not re-reject the pool', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('chmod is ignored as root')
  const runDir = await tmpRunDir('double-fault')
  const sessionsDir = path.join(runDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const stub = makeStubAdapter({ enforcementCodes: [0] })
  stub.adapter.makeSandbox = async () => { throw new Error('sandbox blew up') }
  await chmod(sessionsDir, 0o500) // read-only: the orphan session write will fail with EACCES
  try {
    const out = await dispatchPhase(baseArgs(runDir, {
      runId: 'rd', adapter: stub.adapter, completeEnforcement: stub.completeEnforcement,
      phaseTasks: [{ id: 'TA' }],
    }))
    // The double fault (sandbox throw + unwritable session) still resolves with the task orphaned.
    assert.deepEqual(out.orphaned, ['TA'])
    assert.deepEqual(out.results, [])
  } finally {
    await chmod(sessionsDir, 0o700)
  }
})

test('fixedRefusal is byte-identical to the enforcement refusal subagent-stop.mjs sends', async () => {
  const src = await readFile(SUBAGENT_STOP, 'utf8')
  const anchor = src.indexOf('did not pass the enforcement checks')
  assert.notEqual(anchor, -1, 'enforcement refusal not found in subagent-stop.mjs')
  const callStart = src.lastIndexOf('process.stderr.write(', anchor)
  const callEnd = src.indexOf('\n    )', callStart)
  const region = src.slice(callStart, callEnd)
  const fragments = [...region.matchAll(/`([^`]*)`/g)].map((m) => m[1])
  const reconstructed = fragments.join('')
    .replaceAll('${found.taskId}', 'TX')
    .replaceAll('${found.runId}', 'RX')
    .replaceAll('\\n', '\n')
  assert.equal(fixedRefusal('TX', 'RX'), reconstructed)
})

test('an adapter without effort support gets no effort and the session records effortIgnored', async () => {
  const runDir = await tmpRunDir('effort-ignored')
  const { adapter, calls, completeEnforcement } = makeStubAdapter()
  adapter.supportsEffort = false
  await dispatchPhase(baseArgs(runDir, { adapter, completeEnforcement, effortFor: () => 'high' }))
  assert.equal(calls.spawn[0].effort, undefined)
  assert.equal((await readSession(runDir, 'T1')).effortIgnored, true)
})

test('an adapter with default effort support receives effort and records no effortIgnored', async () => {
  const runDir = await tmpRunDir('effort-kept')
  const { adapter, calls, completeEnforcement } = makeStubAdapter()
  await dispatchPhase(baseArgs(runDir, { adapter, completeEnforcement, effortFor: () => 'high' }))
  assert.equal(calls.spawn[0].effort, 'high')
  assert.equal('effortIgnored' in (await readSession(runDir, 'T1')), false)
})

test('readResult receives the stream path and runs only after the handle has flushed', async () => {
  const runDir = await tmpRunDir('flushed')
  const { adapter, calls, completeEnforcement } = makeStubAdapter()
  let flushed = false
  const spawn = adapter.spawn
  adapter.spawn = async (opts) => {
    const handle = await spawn(opts)
    handle.flushed = new Promise((resolve) => setTimeout(() => { flushed = true; resolve() }, 30))
    return handle
  }
  const readResult = adapter.readResult
  adapter.readResult = async (opts) => {
    assert.equal(flushed, true, 'readResult ran before the stream flushed')
    return readResult(opts)
  }
  await dispatchPhase(baseArgs(runDir, { adapter, completeEnforcement }))
  assert.equal(calls.readResult[0].streamPath, path.join(runDir, 'sessions', 'T1.stream.jsonl'))
})

test('an adapter with cleanupOnResult removes a finished task\'s sandbox and records it; an orphan keeps its sandbox', async () => {
  const runDir = await tmpRunDir('cleanup-on-result')
  const { adapter, completeEnforcement } = makeStubAdapter()
  const cleaned = []
  adapter.cleanupOnResult = true
  adapter.cleanup = async ({ sandbox }) => { cleaned.push(sandbox.cwd) }
  await dispatchPhase(baseArgs(runDir, { adapter, completeEnforcement }))
  assert.deepEqual(cleaned, ['/cwd/T1'])
  assert.equal((await readSession(runDir, 'T1')).sandboxRemoved, true)

  const orphanDir = await tmpRunDir('cleanup-orphan')
  const stub = makeStubAdapter({ result: null })
  const kept = []
  stub.adapter.cleanupOnResult = true
  stub.adapter.cleanup = async ({ sandbox }) => { kept.push(sandbox.cwd) }
  await dispatchPhase(baseArgs(orphanDir, { adapter: stub.adapter, completeEnforcement: stub.completeEnforcement }))
  assert.deepEqual(kept, [])
  assert.equal('sandboxRemoved' in (await readSession(orphanDir, 'T1')), false)
})

test('a failing cleanup never changes a finished task\'s recorded result', async () => {
  const runDir = await tmpRunDir('cleanup-throws')
  const { adapter, completeEnforcement } = makeStubAdapter()
  adapter.cleanupOnResult = true
  adapter.cleanup = async () => { throw new Error('EBUSY') }
  const out = await dispatchPhase(baseArgs(runDir, { adapter, completeEnforcement }))
  assert.equal(out.results[0].status, 'done')
  const session = await readSession(runDir, 'T1')
  assert.equal(session.state, 'done')
  assert.equal('sandboxRemoved' in session, false)
})
