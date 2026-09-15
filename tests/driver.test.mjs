import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchPhase, fixedRefusal, DriverLockError } from '../scripts/driver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SUBAGENT_STOP = path.join(HERE, '..', 'scripts', 'subagent-stop.mjs')

const DONE = { status: 'done', branch: 'b', filesChanged: ['a'], summary: 's', blockers: [] }

// A fake child process: an EventEmitter that records the kill signals it receives. With no `pid`
// property, the driver's kill path falls straight to `child.kill`, which we can then assert on.
function makeChild({ exits = true } = {}) {
  const child = new EventEmitter()
  child.kills = []
  child.kill = (sig) => { child.kills.push(sig); return true }
  if (exits) setImmediate(() => child.emit('exit', 0))
  return child
}

// A plain-JS adapter with no real codex behind it. Records every call and returns scripted
// results/usage/enforcement codes so each driver path can be exercised deterministically.
function makeStubAdapter({ result = DONE, usage = null, enforcementCodes = [0], neverExit = false } = {}) {
  const calls = { makeSandbox: [], spawn: [], resume: [], collect: [], readResult: [], enforcement: [] }
  const children = []
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
      const child = makeChild({ exits: !neverExit })
      children.push(child)
      return { child, sessionId: Promise.resolve(`sid-${branchTask(opts.sandbox.meta.branch)}`) }
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
  return { adapter, calls, children, completeEnforcement }
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
