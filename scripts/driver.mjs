// The headless driver loop. Owns the whole per-phase control flow so a harness adapter
// (`scripts/harnesses/*`) can stay declarative: the adapter knows a CLI's argv and sandbox,
// the driver knows the ordering, concurrency, timeout, session bookkeeping and the enforcement
// gate. It never writes `done` from a teammate's word — a returned status is the teammate's
// claim, and every `done` claim must survive `complete --enforcement-only` (the same check the
// phase gate recomputes) before it is recorded. Returns `{ results, orphaned }` in the shape the
// Workflow template returns (`templates/phase-workflow.js`), so the CLI post-processing, the
// gate and `finish` are identical on both dispatch paths.
import { mkdir, readFile, writeFile, rm, link, unlink, rename, realpath, lstat, open, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import { appendEvent, fingerprint } from './event-ledger.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { validateResult } from './result-schema.mjs'
import { strictExecutionIdentity } from './completion-obligations.mjs'
import { retainExecutionArtifact, readExecutionArtifact, RETENTION_LIMITS } from './execution-artifacts.mjs'
import { appendExecutionEvent, readExecutionEvents, strictExecutionAttempts } from './execution-journal.mjs'
import { reconcileExecutionAttempt } from './execution-recovery.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const unverified = { verifiedComplete: false, evidence: 'legacy-unverified' }
const completeLogs = observation => ['setup','baseline'].every(stage => Array.isArray(observation?.[stage]?.checks)
  && observation[stage].checks.length <= 1000 && observation[stage].checks.every(check => check.log?.complete === true))
function workerObservation(value) {
  if (!value) return null
  const observation = structuredClone(value)
  observation.durationMs ??= null
  for (const stage of ['setup','baseline']) if (observation[stage]) observation[stage].durationMs ??= null
  return observation
}

async function checkedGit(git, args, cwd) {
  const result = await git(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd })
  if (result.code !== 0) throw new Error('Required Git observation failed')
  return result.stdout.trim()
}
async function sandboxTip(git, sandbox, branch) {
  const args = sandbox.meta?.gitdir ? ['--git-dir=' + sandbox.meta.gitdir, '--work-tree=' + sandbox.cwd] : []
  const ref = await checkedGit(git, [...args, 'symbolic-ref', '--short', 'HEAD'], sandbox.cwd)
  if (ref !== branch) throw new Error('Worker branch changed')
  const tip = await checkedGit(git, [...args, 'rev-parse', '--verify', 'HEAD'], sandbox.cwd)
  if (!sha(tip)) throw new Error('Worker tip is unavailable')
  return tip
}
async function driverRuntime(git, sandbox, runRepo, branch, continuation, fallbackTip, allowUnverified = false) {
  let tip, verified = true
  try { tip = sandbox.meta?.mode === 'files' ? fallbackTip : await sandboxTip(git, sandbox, branch) }
  catch (error) {
    if (!allowUnverified || !sha(fallbackTip)) throw error
    tip = fallbackTip; verified = false
  }
  if (!sha(tip)) throw new Error('Current task source is unavailable')
  return { version: 1, root: runRepo, cwd: sandbox.cwd, gitdir: sandbox.meta?.gitdir ?? null,
    branch, tip, continuation, mode: sandbox.meta?.mode ?? 'full', verified }
}

async function outputBytes(file, limit) {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error('Required no-follow output reads unsupported')
  let handle
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || await realpath(file) !== file) throw new Error('Unsafe or oversized harness output')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!part.bytesRead) break
      offset += part.bytesRead
    }
    const after = await handle.stat(), current = await lstat(file)
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.ino !== after.ino || current.dev !== after.dev || current.nlink !== 1) throw new Error('Harness output changed during retention')
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}

function requiredExecution(execution, runId) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || Object.keys(execution).sort().join() !== ['version','common','runId','executionId','inputs','retention','maxAttempts','deadlineAt'].sort().join()
    || execution.version !== 1 || execution.runId !== runId || !label(execution.executionId)
    || typeof execution.common !== 'string' || !path.isAbsolute(execution.common)
    || !Number.isSafeInteger(execution.maxAttempts) || execution.maxAttempts < 1 || execution.maxAttempts > 10
    || !Number.isSafeInteger(execution.deadlineAt) || execution.deadlineAt <= Date.now()
    || execution.deadlineAt - Date.now() > 24 * 60 * 60 * 1000) throw new Error('Invalid required execution contract')
  strictExecutionIdentity(execution.inputs)
  const upper = RETENTION_LIMITS
  if (!execution.retention || Object.keys(execution.retention).sort().join() !== Object.keys(upper).sort().join()
    || Object.entries(upper).some(([key, bound]) => !Number.isSafeInteger(execution.retention[key]) || execution.retention[key] <= 0 || execution.retention[key] > bound)) throw new Error('Invalid required execution retention')
  return execution
}


// A driver already holds this run's lock. Thrown by `dispatchPhase` so the CLI can translate it
// into exit 1; `exitCode` carries that number without the CLI having to know the class.
export class DriverLockError extends Error {
  constructor(pid, lockPath) {
    super(`run already has a live driver (pid ${pid}) holding ${lockPath}`)
    this.name = 'DriverLockError'
    this.pid = pid
    this.lockPath = lockPath
    this.exitCode = 1
  }
}

// The message a teammate is resumed with when `complete --enforcement-only` rejects its work.
// It is copied verbatim from the enforcement-rejection branch of `scripts/subagent-stop.mjs`
// (the SubagentStop hook's fixed-form reply) so both dispatch paths tell a teammate the same
// thing when the same check rejects it. `tests/driver.test.mjs` reconstructs that hook's string
// and asserts it is byte-identical to this one, so the two cannot drift apart silently.
export function fixedRefusal(taskId, runId) {
  return `Task ${taskId} in run ${runId} did not pass the enforcement checks that the `
    + `phase gate will recompute. The reasons are deliberately not repeated here, because they `
    + `come from a file in the repository and would reach you as if this hook had said them. `
    + `Your brief names the verification command for this task: run it yourself, in the `
    + `foreground, and read its output directly. Fix what it reports, then finish.\n`
}

// process.kill(pid, 0) probes existence without signalling: no throw or EPERM means a live
// process (EPERM is alive-but-not-ours), ESRCH means it is gone. A driver whose pid is gone left
// a stale lock that must not block a resume.
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Sends `signal` to the child. Tries the child's process group first (`-pid`) so a detached
// child's own children go too, then the child directly. `-pid` targets the group whose id equals
// the child's pid; a non-detached child leads no such group, so this resolves to ESRCH and is
// caught — it can never reach the driver's own group, whose id is a different pid.
export function killProcess(child, signal) {
  if (!child) return
  if (typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch { /* not a group leader: fall through to a direct kill */ }
  }
  try {
    child.kill?.(signal)
  } catch { /* already gone */ }
}

// Resolves 'exit' when the child ends, or 'timeout' when `timeoutMs` elapses first. On timeout it
// SIGTERMs, schedules an unref'd SIGKILL `killGraceMs` later (so a wedged child that ignores
// SIGTERM is still reaped without the driver waiting on it), and resolves 'timeout' immediately so
// the caller can mark the task orphaned. `killGraceMs` is injectable only so tests can shorten the
// grace; production always uses the 10s default.
export function waitForExit(child, timeoutMs, { killGraceMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (reason) => {
      if (settled) return
      settled = true
      resolve(reason)
    }
    // A ChildProcess that already exited (its listeners would never fire again) reports a settled
    // exitCode/signalCode; treat that as an immediate exit rather than waiting out the timeout.
    if (child && (child.exitCode != null || child.signalCode != null)) {
      done('exit')
      return
    }
    const timer = setTimeout(() => {
      killProcess(child, 'SIGTERM')
      const kill9 = setTimeout(() => killProcess(child, 'SIGKILL'), killGraceMs)
      kill9.unref?.()
      done('timeout')
    }, timeoutMs)
    const onEnd = () => {
      clearTimeout(timer)
      done('exit')
    }
    if (typeof child?.once === 'function') {
      child.once('exit', onEnd)
      child.once('error', onEnd)
    } else if (typeof child?.on === 'function') {
      child.on('exit', onEnd)
      child.on('error', onEnd)
    } else {
      // No lifecycle to await: treat as already exited so the driver does not hang.
      clearTimeout(timer)
      done('exit')
    }
  })
}

async function readJson(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

async function stderrTail(errPath, bytes = 2000) {
  try {
    const raw = await readFile(errPath, 'utf8')
    return raw.slice(-bytes).trim()
  } catch {
    return ''
  }
}

async function safeUsage(adapter, streamPath) {
  try {
    return await adapter.readUsage({ streamPath })
  } catch {
    return null
  }
}

function appendBlocker(blockers, message) {
  return Array.isArray(blockers) ? [...blockers, message] : [message]
}

// Runs `worker` over `items` at most `limit` at a time, preserving no ordering itself (the caller
// re-assembles results in task order from the map the workers fill). The tracked promise is the
// SAME one that carries the settle-and-cleanup: an earlier version tracked a bare promise and did
// its cleanup on a detached `p.finally(...)`, whose rejection was never awaited and surfaced as an
// unhandled rejection (fatal under Node's default `--unhandled-rejections=throw`). Here a worker
// throw rejects only the awaited promise, so `Promise.race`/`Promise.all` handle it and nothing
// leaks.
export async function runPool(items, limit, worker) {
  const bound = Math.max(1, (limit | 0) || 1)
  const executing = new Set()
  for (const item of items) {
    const p = (async () => {
      try {
        return await worker(item)
      } finally {
        executing.delete(p)
      }
    })()
    executing.add(p)
    if (executing.size >= bound) await Promise.race(executing)
  }
  await Promise.all(executing)
}

// Acquires `lockPath` for this process. Refuses (throws DriverLockError, exit 1) when the lock
// holds a LIVE pid; takes over a lock whose pid is gone. Two properties make concurrent dispatches
// on one run safe:
//   1. The install is `link(tmp, lockPath)` — atomic and NON-clobbering (EEXIST if the lock is
//      already present), so exactly one of N racers installs into an empty slot. `writeFile(...,
//      {flag:'wx'})` gives the same O_EXCL guarantee, but link lets the same tmp seed both the lock
//      and the takeover token below without a second write.
//   2. A stale (dead-holder) lock is removed ONLY while holding an exclusive takeover TOKEN (itself
//      an atomic link) and ONLY after RE-READING the holder under that token and confirming it is
//      still dead. This is the load-bearing fix: a plain `rm`/`rename` takeover reads the dead pid,
//      then deletes whatever is at the path — which, if a competitor already took over, is that
//      competitor's LIVE lock, so both drivers proceed (measured: rm 2-7/1000, rename worse). The
//      re-read under the token turns that into a refusal, because no one can install over the stale
//      lock (link EEXISTs) or take it over (the token is held) between the re-read and the rm.
// A hard crash mid-takeover can strand the `<lock>.takeover` token. Because the token is claimed
// with the same non-clobbering `link` (EEXIST on an existing file), a stranded token is NOT
// auto-recovered — it is never overwritten and blocks future takeovers until `<lock>.takeover` is
// removed by hand. This is fail-safe (the bounded loop refuses with DriverLockError rather than
// spinning or double-acquiring) and is a known LOW limitation tracked as a follow-up.
export async function acquireLock(lockPath, {
  pid = process.pid, isAlive = pidAlive, onDeadHolder, onEmptyUnderToken,
} = {}) {
  const token = `${lockPath}.takeover`
  const tmp = `${lockPath}.tmp.${pid}.${process.hrtime.bigint()}`
  await writeFile(tmp, `${pid}\n`)
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await link(tmp, lockPath)
        return
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        const holder = await readPid(lockPath)
        if (Number.isInteger(holder) && isAlive(holder)) throw new DriverLockError(holder, lockPath)
        // A test-only seam to drive the takeover interleaving deterministically; unused in
        // production. Fired once, after detecting a dead holder and before claiming the token, so a
        // test can let a competitor finish its takeover here and prove the under-token re-read
        // refuses rather than clobbering the competitor's fresh LIVE lock.
        if (onDeadHolder) {
          const hook = onDeadHolder
          onDeadHolder = null
          await hook()
        }
        // Dead holder: serialize the removal behind the token. A competitor holding the token means
        // a takeover is in flight, so loop and re-check rather than race it.
        try {
          await link(tmp, token)
        } catch (terr) {
          if (terr.code === 'EEXIST') continue
          throw terr
        }
        try {
          const under = await readPid(lockPath)
          // A test-only seam, unused in production: fired only when the slot re-reads empty under
          // the token, so a test can install a competitor's fresh LIVE lock into that exact window
          // and prove this branch does not clobber it.
          if (onEmptyUnderToken && !Number.isInteger(under)) {
            const hook = onEmptyUnderToken
            onEmptyUnderToken = null
            await hook()
          }
          if (Number.isInteger(under) && isAlive(under)) throw new DriverLockError(under, lockPath)
          if (Number.isInteger(under)) {
            // Positively-confirmed DEAD integer holder: safe to remove. We hold the token and
            // `link` EEXISTs on the present stale lock, so no competitor can install until we clear
            // it. Removing on a NaN/empty read would be the bug the token exists to prevent — a
            // competitor between its own rm and its fresh non-token `link` install leaves the slot
            // momentarily empty, and an unconditional rm here would delete that fresh LIVE lock.
            await rm(lockPath, { force: true })
          }
          // else: slot is empty/contested (NaN) — do NOT remove; loop back to the atomic link,
          // which either wins the empty slot or sees the competitor's fresh live lock and refuses.
        } finally {
          await unlink(token).catch(() => {})
        }
        // Loop back to the atomic link, which gates the final winner.
      }
    }
    throw new DriverLockError(-1, lockPath)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

// The pid an existing lock names, or NaN when the file is gone or unreadable.
async function readPid(lockPath) {
  const raw = await readFile(lockPath, 'utf8').catch(() => null)
  return raw == null ? Number.NaN : Number.parseInt(raw.trim(), 10)
}

// Removes the lock only while it still names this process, so a concurrent take-over is not
// clobbered (a same-run second driver is refused, so in practice the lock is ours).
export async function releaseLock(lockPath) {
  const current = await readFile(lockPath, 'utf8').catch(() => null)
  if (current != null && Number.parseInt(current.trim(), 10) === process.pid) {
    await rm(lockPath, { force: true })
  }
}

// `completeEnforcement` answers `{ code, pendingOnly, pending }` (cli.mjs `enforcementAnswer`); a
// bare exit code is read as that code with nothing pending. `pendingOnly` counts only when it is
// literally `true` and `pending` names only agent or mcp kinds.
function enforcementAnswer(raw) {
  if (typeof raw === 'number') return { code: raw, pendingOnly: false, pending: [] }
  const code = raw?.code
  const pending = Array.isArray(raw?.pending) && raw.pending.every(kind => ['agent', 'mcp'].includes(kind)) ? [...raw.pending] : null
  return { code, pendingOnly: raw?.pendingOnly === true && pending !== null && pending.length > 0, pending: pending ?? [] }
}

// Runs one phase's implementer tasks on a harness, at most `maxParallel` at once. Returns
// `{ results, orphaned }` in the shape the Workflow path returns: `results` is `{ taskId, ... }`
// entries (the teammate's own result fields), `orphaned` is the ids of tasks that produced no
// usable result. Never writes `done` itself — a recorded status is the teammate's claim subjected
// to `completeEnforcement`, and the gate still decides landability.
//
// `fixRound: true` is the mode `dispatch --fix-round` uses: every task in `phaseTasks` is
// respawned, or resumed in its recorded sandbox, even when a done result is recorded, and its work
// starts from the task branch's current tip, not from the run branch. Without a required execution
// contract the attempt is journaled in the task's session record under `fixRounds`, and a collected
// tip that does not descend from the prior tip is refused and the prior tip put back. With one, a
// fix round over a collected result is a new journaled harness attempt whose binding carries
// `fixRound: true`, collected under the contract's existing ref checks.
export async function dispatchPhase({
  adapter, git, runRepo, runId, runBranch, phaseTasks,
  maxParallel, sandboxMode, network, timeoutMinutes, tierModels, effortFor,
  composeBriefFor, personaFor, runDir, completeEnforcement, execution, executionBoundary, fixRound = false,
}) {
  if (typeof fixRound !== 'boolean') throw new Error('fixRound must be a boolean')
  const contract = execution === undefined ? null : requiredExecution(execution, runId)
  await mkdir(path.join(runDir, 'sessions'), { recursive: true })
  // Canonical once, here: the strict output reads refuse a path whose realpath differs, which a
  // run directory reached through a symbolic link (macOS /var -> /private/var) always would.
  runDir = await realpath(runDir)
  const sessionsDir = path.join(runDir, 'sessions')
  const lockPath = path.join(runDir, 'driver.lock')
  await acquireLock(lockPath)

  const timeoutMs = (Number(timeoutMinutes) > 0 ? Number(timeoutMinutes) : 30) * 60_000

  const resolveModel = (task) => {
    if (task.model) return task.model
    if (task.tier && tierModels && tierModels[task.tier]) return tierModels[task.tier]
    return undefined
  }

  async function processStrictTask(task) {
    let expired = false, activeChild = null
    const checkDeadline = () => {
      if (expired || Date.now() >= contract.deadlineAt) {
        expired = true
        activeChild?.kill('SIGKILL')
        throw new Error('Required execution deadline exceeded')
      }
    }
    const bounded = async action => {
      checkDeadline()
      let timer
      try {
        const value = await Promise.race([
          Promise.resolve().then(action),
          new Promise((_, reject) => { timer = setTimeout(() => {
            expired = true; activeChild?.kill('SIGKILL')
            reject(new Error('Required execution deadline exceeded'))
          }, Math.max(1, contract.deadlineAt - Date.now())) }),
        ])
        checkDeadline()
        return value
      } finally { clearTimeout(timer) }
    }
    const guardedGit = (...args) => bounded(() => git(...args))
    if (!label(task.id)) throw new Error('Invalid strict task identity')
    const taskId = task.id, branch = `fleetmates/${runId}/${taskId}`
    const ref = 'refs/heads/' + branch, runRef = 'refs/heads/' + runBranch
    const common = await bounded(() => realpath(contract.common))
    const actualCommon = await checkedGit(guardedGit, ['rev-parse', '--path-format=absolute', '--git-common-dir'], runRepo)
    if (await bounded(() => realpath(actualCommon)) !== common) throw new Error('Required common Git storage mismatch')
    const runTip = await checkedGit(guardedGit, ['rev-parse', '--verify', runRef], runRepo)
    if (runTip !== contract.inputs.commit) throw new Error('Required source commit changed')
    const identity = strictExecutionIdentity(contract.inputs)
    const sessionFile = path.join(sessionsDir, `${taskId}.json`)
    let record = await bounded(() => readJson(sessionFile))
    const events = await bounded(() => readExecutionEvents(common, runId))
    const groups = strictExecutionAttempts(events)
    const current = groups.filter(g => g.start.executionId === contract.executionId && g.start.task === taskId)
    if (record && (!record.execution || record.execution.identity !== identity || record.execution.executionId !== contract.executionId)) {
      throw new Error('Legacy or changed session evidence is unverified; reconciliation required')
    }
    const branches = { [runRef]: runTip }
    let hostTip = null
    try { hostTip = await checkedGit(guardedGit, ['show-ref', '--verify', '--hash', ref], runRepo); branches[ref] = hostTip } catch {}
    const report = await bounded(() => reconcileExecutionAttempt({ common, runId, inputs: contract.inputs, branches,
      retention: contract.retention, checkouts: record?.sandbox ? { [taskId]: record.sandbox.cwd } : {} }))
    // An `agent-dispatch` effect is a controller's record of launching a dispatch, this one included:
    // the controller persists it, still open, before it spawns the dispatch that runs this driver.
    // The model effects behind it are this driver's own harness attempts, reconciled below, so an
    // open agent-dispatch never refuses here. Any other unknown external effect still does.
    if (report.attempts.some(a => a.state === 'historical-observation' || a.effects.some(e => e.outcome === 'unknown' && e.kind !== 'agent-dispatch'))) {
      throw new Error('Historical or unknown-effect evidence refuses execution')
    }
    const relevant = report.attempts.filter(a => a.executionId === contract.executionId && a.task === taskId)
    if (relevant.some(a => a.missingArtifacts.length > 0 || ['stale','missing-artifact','retention-exceeded'].includes(a.state))) throw new Error('Required retained execution evidence is stale or unavailable')
    if (current.some(g => g.start.identity !== identity)) throw new Error('Attempt input identity changed')
    if (current.length && !record?.sandbox) throw new Error('Required checkout identity record is missing')
    const sandbox = record?.sandbox ?? await bounded(() => adapter.makeSandbox(guardedGit, { runRepo, runBranch, runId, taskId, mode: sandboxMode }))
    if (!['clone','full'].includes(sandbox.meta?.mode)) throw new Error('Required recovery needs a Git checkout with observable task refs')
    const model = resolveModel(task) ?? null
    const effortRaw = effortFor ? effortFor(task) : undefined
    const effort = adapter.supportsEffort === false ? null : effortRaw ?? null
    const paths = {
      schemaPath: path.join(sessionsDir, `${taskId}.schema.json`), resultPath: path.join(sessionsDir, `${taskId}.result.json`),
      streamPath: path.join(sessionsDir, `${taskId}.stream.jsonl`), errPath: path.join(sessionsDir, `${taskId}.stderr.log`),
    }
    const storage = { common, runId, retention: contract.retention }
    const retain = async (kind, value) => (await bounded(() => retainExecutionArtifact({ ...storage, kind, bytes: Buffer.from(JSON.stringify(value)) }))).reference
    const read = async reference => JSON.parse(await bounded(() => readExecutionArtifact({ ...storage, reference })))
    let clock = Math.max(Date.now(), ...events.map(e => e.at + 1))
    const event = async (step, attempt, kind, artifacts, observed = branches) => {
      const value = await bounded(() => appendExecutionEvent(common, { version: 2, id: randomUUID(), runId, executionId: contract.executionId,
        task: taskId, step, attempt, kind, at: clock++, inputs: contract.inputs, branches: observed,
        checkout: taskId, artifacts }, { requireFreshStart: kind === 'step-started' }))
      return value
    }
    const boundary = async name => { if (executionBoundary) await bounded(() => executionBoundary(name, { taskId, executionId: contract.executionId })) }
    const persist = async () => { await bounded(() => writeJson(sessionFile, record)) }
    const observedHost = async () => {
      const tip = await checkedGit(guardedGit, ['rev-parse', '--verify', ref], runRepo)
      if (!sha(tip)) throw new Error('Collected task ref unavailable')
      return tip
    }
    let result, resultRef, sourceTip, attempt, binding, usage = null
    // A fix round over a result that was already collected starts a new harness attempt from the
    // collected tip; any other retained result is reused and collected as before.
    let fixOverCollected = false
    const harnesses = current.filter(g => g.start.step === 'harness')
    const latest = harnesses.at(-1)
    let invocations = harnesses.length
    if (latest) {
      if (!latest.end || latest.end.kind !== 'step-completed') throw new Error('Interrupted harness outcome is unknown; automatic model retry refused')
      const bindingRef = latest.start.artifacts.find(a => a.kind === 'driver-invocation')
      resultRef = latest.end.artifacts.find(a => a.kind === 'driver-result')
      if (!bindingRef || !resultRef) throw new Error('Required invocation/result artifact missing')
      binding = await read(bindingRef)
      const retained = await read(resultRef)
      if (binding.identity !== identity || binding.executionId !== contract.executionId || binding.task !== taskId
        || binding.model !== model || binding.effort !== effort || binding.network !== network
        || binding.adapter !== adapter.name || retained.invocation !== bindingRef.sha256
        || retained.identity !== identity || retained.branch !== branch || !sha(retained.sourceTip)
        || !validateResult(retained.result) || retained.result.branch !== branch) throw new Error('Retained result binding changed')
      sourceTip = retained.sourceTip; result = retained.result; usage = retained.usage ?? null; attempt = latest.start.attempt
      const completedCollection = current.filter(g => g.start.step === 'collection' && g.end?.kind === 'step-completed' && g.start.artifacts.some(a => a.kind === resultRef.kind && a.sha256 === resultRef.sha256)).at(-1)
      if (completedCollection && hostTip !== sourceTip) throw new Error('Collected task ref changed')
      let available = false
      try { available = (await sandboxTip(guardedGit, sandbox, branch)) === sourceTip } catch {}
      if (!available && hostTip !== sourceTip) throw new Error('Worker checkout/ref is lost or changed; model retry refused')
      const collections = current.filter(g => g.start.step === 'collection' && g.start.artifacts.some(a => a.sha256 === resultRef.sha256))
      if (hostTip !== binding.hostTip && !(collections.length && hostTip === sourceTip)) throw new Error('Host task ref changed before reconciliation')
      const runtime = { version: 1, root: runRepo, cwd: sandbox.cwd, gitdir: sandbox.meta?.gitdir ?? null,
        branch, tip: binding.sourceTip, continuation: binding.continuation, mode: sandbox.meta?.mode ?? 'full' }
      const expectedPrompt = binding.refusal ? fixedRefusal(taskId, runId)
        : `${personaFor(task.role || 'implementer')}\n\n${composeBriefFor({ ...task, runtime })}`
      fixOverCollected = fixRound && completedCollection != null && hostTip === sourceTip
      if (!fixOverCollected && binding.promptSha256 !== digest(expectedPrompt)) throw new Error('Current prompt identity changed')
    } else {
      if (record?.result) throw new Error('Result without journal evidence is unverified')
      if (hostTip) throw new Error('Existing task ref needs explicit retained reconciliation')
    }

    async function invoke(message, fix = false) {
      checkDeadline()
      if (invocations >= contract.maxAttempts) throw new Error('Required attempt bound exceeded')
      const runtime = await driverRuntime(guardedGit, sandbox, runRepo, branch, !!record?.sessionId, runTip)
      const prompt = message ?? `${personaFor(task.role || 'implementer')}\n\n${composeBriefFor({ ...task, runtime })}`
      const initial = workerObservation(sandbox.meta?.workerEnvironment)
      if (!initial || !completeLogs(initial) || initial.ready !== true || initial.baseline?.status !== 'pass'
        || initial.workspace === 'fresh' && initial.setup?.status !== 'pass') throw new Error('Required initial worker preparation failed')
      const initialRef = await retain('worker-setup', initial)
      attempt = randomUUID(); invocations++
      binding = { version: 1, executionId: contract.executionId, task: taskId, identity, adapter: adapter.name,
        model, effort, effortIgnored: adapter.supportsEffort === false && effortRaw !== undefined,
        network, promptSha256: digest(prompt), hostTip, sourceTip: runtime.tip, continuation: runtime.continuation, refusal: message != null, fixRound: fix }
      const bindingRef = await retain('driver-invocation', binding)
      await event('harness', attempt, 'step-started', [bindingRef, ...(initialRef ? [initialRef] : [])])
      record = { ...record, taskId, sandbox, prerequisites: sandbox.meta?.prerequisites,
        initialWorkerEnvironment: record?.initialWorkerEnvironment ?? initial,
        execution: { version: 1, executionId: contract.executionId, identity, attempt }, state: 'starting', result: null }
      await persist()
      await bounded(() => Promise.all([paths.resultPath, paths.streamPath, paths.errPath].map(file => rm(file, { force: true }))))
      checkDeadline()
      const options = { sandbox, model: model ?? undefined, effort: effort ?? undefined, network, ...paths }
      const handle = await bounded(async () => {
        const value = record.sessionId
          ? await adapter.resume({ ...options, sessionId: record.sessionId, message: prompt })
          : await adapter.spawn({ ...options, prompt })
        activeChild = value.child
        if (expired) activeChild?.kill('SIGKILL')
        return value
      })
      if (!Number.isSafeInteger(handle.child?.pid) || handle.child.pid <= 0) throw new Error('Required actual child process is missing')
      const closed = new Promise(resolve => {
        if (handle.child.exitCode != null && handle.child.stdio?.every(stream => !stream || stream.destroyed)) resolve()
        else handle.child.once('close', resolve)
      })
      const exited = waitForExit(handle.child, Math.max(1, Math.min(timeoutMs, contract.deadlineAt - Date.now())))
      record.sessionId = (await bounded(() => handle.sessionId)) ?? record.sessionId ?? null
      record.state = 'running'; await persist()
      await boundary('spawned')
      const reason = await exited
      if (reason === 'exit') {
        let timer
        try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Child close deadline exceeded')), Math.max(1, contract.deadlineAt - Date.now())) })]) }
        finally { clearTimeout(timer) }
      }
      await bounded(() => handle.flushed)
      if (reason !== 'exit' || handle.child?.exitCode != null && handle.child.exitCode !== 0 || handle.child?.signalCode != null) {
        await event('harness', attempt, 'step-failed', [])
        throw new Error('Harness did not complete successfully')
      }
      const outputs = []
      for (const [kind, file] of [['harness-result', paths.resultPath], ['harness-stream', paths.streamPath], ['harness-stderr', paths.errPath]]) {
        const bytes = await bounded(() => outputBytes(file, contract.retention.maxArtifactBytes))
        if (bytes !== null) outputs.push((await bounded(() => retainExecutionArtifact({ ...storage, kind, bytes }))).reference)
      }
      if (!outputs.some(reference => ['harness-result','harness-stream'].includes(reference.kind))) {
        await event('harness', attempt, 'step-failed', [])
        throw new Error('Required native result artifact missing')
      }
      const snapshot = await bounded(() => mkdtemp(path.join(common, 'fleetmates-driver-parse-')))
      const parserPaths = { resultPath: path.join(snapshot, 'result.json'), streamPath: path.join(snapshot, 'stream.jsonl') }
      try {
        for (const [kind, file] of [['harness-result', parserPaths.resultPath], ['harness-stream', parserPaths.streamPath]]) {
          const reference = outputs.find(a => a.kind === kind)
          if (reference) {
            const bytes = await bounded(() => readExecutionArtifact({ ...storage, reference }))
            await bounded(() => writeFile(file, bytes, { flag: 'wx', mode: 0o400 }))
          }
        }
        result = await bounded(() => adapter.readResult(parserPaths))
        if (!validateResult(result) || result.branch !== branch) {
          await event('harness', attempt, 'step-failed', [])
          throw new Error('No current schema-valid task result')
        }
        usage = await bounded(() => safeUsage(adapter, parserPaths.streamPath))
      } finally { await rm(snapshot, { recursive: true, force: true }) }
      sourceTip = await sandboxTip(guardedGit, sandbox, branch)
      resultRef = await retain('driver-result', { version: 1, identity, branch, sourceTip, invocation: bindingRef.sha256, result, usage })
      const continuation = workerObservation(sandbox.meta?.workerEnvironment)
      const continuationRef = continuation ? await retain('worker-continuation', continuation) : null
      if (!continuation || !completeLogs(continuation) || continuation.ready !== true || continuation.baseline?.status !== 'pass') {
        await event('harness', attempt, 'step-failed', continuationRef ? [continuationRef] : [])
        throw new Error('Current worker continuation verification failed')
      }
      await event('harness', attempt, 'step-completed', [resultRef, ...outputs, continuationRef])
      record.state = 'result-retained'; record.result = result; await persist()
      await boundary('result-retained')
    }

    async function collectAndVerify() {
      checkDeadline()
      const history = strictExecutionAttempts(await bounded(() => readExecutionEvents(common, runId)))
        .filter(g => g.start.executionId === contract.executionId && g.start.task === taskId && g.start.step === 'collection')
      const pending = history.find(g => !g.end && g.start.artifacts.some(a => a.kind === resultRef.kind && a.sha256 === resultRef.sha256))
      const collectionAttempt = pending?.start.attempt ?? randomUUID()
      if (!pending && history.length >= contract.maxAttempts) throw new Error('Required collection attempt bound exceeded')
      if (!pending) await event('collection', collectionAttempt, 'step-started', [resultRef])
      await boundary('collection-started')
      let tip = null
      try { tip = await observedHost() } catch {}
      if (tip !== null && tip !== sourceTip && tip !== hostTip) throw new Error('Host ref changed before collection')
      if (tip !== sourceTip) {
        const before = await sandboxTip(guardedGit, sandbox, branch)
        if (before !== sourceTip) throw new Error('Worker ref changed before collection')
        await bounded(() => adapter.collect(guardedGit, { runRepo, sandbox, branch }))
        tip = await observedHost()
      }
      if (tip !== sourceTip) throw new Error('Collection produced an unexpected ref')
      sourceTip = tip; hostTip = tip
      await boundary('collection-applied')
      const collectedRef = await retain('driver-collection', { identity, branch, tip, result: resultRef })
      await event('collection', collectionAttempt, 'step-completed', [collectedRef], { [runRef]: runTip, [ref]: tip })
      record.state = 'collected'; await persist()
      if (current.filter(g => g.start.step === 'verification').length >= contract.maxAttempts) throw new Error('Required verification attempt bound exceeded')
      const verificationAttempt = randomUUID()
      await event('verification', verificationAttempt, 'step-started', [collectedRef], { [runRef]: runTip, [ref]: tip })
      checkDeadline()
      const answer = enforcementAnswer(await bounded(() => completeEnforcement(taskId)))
      const { code } = answer
      if (await observedHost() !== tip || await checkedGit(guardedGit, ['rev-parse', runRef], runRepo) !== runTip) throw new Error('Refs changed during mandatory verification')
      // Accepted: a pass, or exit 4 whose only non-passing checks are pending agent or mcp checks
      // that no runner here can execute. Any other code, or a 4 beside a failed check, is refused.
      const pendingOnly = code === 4 && answer.pendingOnly
      const accepted = code === 0 || pendingOnly
      const scope = pendingOnly ? `enforcement-only-pending-${answer.pending.join('-') || 'unnamed'}` : 'enforcement-only'
      const receipt = await retain('driver-verification', { version: 1, identity, branch, tip, code, pendingOnly, scope, verifiedComplete: false })
      await event('verification', verificationAttempt, accepted ? 'step-completed' : 'step-failed', [receipt], { [runRef]: runTip, [ref]: tip })
      return { code, accepted }
    }

    if (!latest || fixOverCollected) await invoke(undefined, fixOverCollected)
    let verified = await collectAndVerify()
    if (verified.code === 3) {
      await invoke(fixedRefusal(taskId, runId))
      verified = await collectAndVerify()
    }
    if (!verified.accepted) throw new Error('Fresh mandatory enforcement did not pass')
    record = { ...record, state: result.status, result, exitReason: 'exit', usage,
      verifiedComplete: false, evidence: 'strict-execution-enforcement-only' }
    await persist()
    if (adapter.cleanupOnResult && result.status === 'done') {
      await bounded(() => adapter.cleanup({ sandbox }))
      record.sandboxRemoved = true; await persist()
    }
    checkDeadline()
    return { kind: 'result', result: { taskId, ...result, verifiedComplete: false, evidence: 'strict-execution-enforcement-only' } }
  }

  async function processTask(task) {
    if (contract) return processStrictTask(task)
    const taskId = task.id
    const observe = async (kind, result) => {
      try { await appendEvent(path.join(runDir, 'ledger', `${fingerprint(taskId)}.jsonl`), { kind, result, at: Date.now() }) }
      catch { /* Ledger availability never changes a git-derived enforcement verdict. */ }
    }
    const branch = `fleetmates/${runId}/${taskId}`
    const sessionFile = path.join(sessionsDir, `${taskId}.json`)
    let record = (await readJson(sessionFile)) || {}

    // Idempotent resume of a whole run: a recorded, well-formed result is final — re-record it
    // and never respawn the task. A fix round is the one caller that respawns it anyway.
    if (validateResult(record.result) && !fixRound) {
      return { kind: 'result', result: { taskId, ...record.result, ...unverified } }
    }

    // A fix round builds on the task branch as it stands: its tip is read before anything runs,
    // a task with no branch has nothing to repair, and the attempt is recorded before the spawn.
    let priorTip = null, fixEntry = null
    if (fixRound) {
      priorTip = await checkedGit(git, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`], runRepo)
      fixEntry = { attempt: randomUUID(), startedAt: Date.now(), priorTip, tip: null, outcome: null }
      const previous = Array.isArray(record.fixRounds) ? record.fixRounds.slice(-19) : []
      record = { ...record, result: null, state: 'fix-round', fixRounds: [...previous, fixEntry] }
      await writeJson(sessionFile, record)
    }
    await observe('task-started')

    // A fix round reuses the recorded sandbox only while it still exists; otherwise a new one is
    // cut from the task branch, so the round never starts over from the run branch.
    let recorded = null
    if (fixRound && record.sandbox && record.sandboxRemoved !== true) {
      try { await lstat(record.sandbox.cwd); recorded = record.sandbox } catch { recorded = null }
    }
    const resumePath = typeof record.sessionId === 'string' && record.sessionId.length > 0 && (!fixRound || recorded !== null)
    let sandbox = fixRound
      ? recorded ?? await adapter.makeSandbox(git, { runRepo, runBranch: branch, runId, taskId, mode: sandboxMode })
      : (resumePath && record.sandbox)
        ? record.sandbox
        : await adapter.makeSandbox(git, { runRepo, runBranch, runId, taskId, mode: sandboxMode })
    // The files adapters' collection commits a files checkout on top of `meta.runBranch` (as read
    // in scripts/harnesses/files-sandbox.mjs `commitFilesTree`); in a fix round that base is the
    // task branch, so the collected commit builds on the prior task tip.
    if (fixRound && sandbox.meta?.mode === 'files') sandbox = { ...sandbox, meta: { ...sandbox.meta, runBranch: branch } }
    if (fixRound) record = { ...record, sandboxRemoved: false }

    const role = task.role || 'implementer'
    const runtime = await driverRuntime(git, sandbox, runRepo, branch, resumePath,
      fixRound ? priorTip : await checkedGit(git, ['rev-parse', runBranch], runRepo), true)
    const prompt = `${personaFor(role)}\n\n${composeBriefFor(runtime ? { ...task, runtime } : task)}`
    const model = resolveModel(task)
    // A harness with no effort control (Cursor bakes effort into the model id) gets none, and the
    // session says so rather than dropping the configured value silently.
    const effortRaw = effortFor ? effortFor(task) : undefined
    const effortIgnored = adapter.supportsEffort === false && effortRaw !== undefined
    const effort = adapter.supportsEffort === false ? undefined : effortRaw
    const paths = {
      schemaPath: path.join(sessionsDir, `${taskId}.schema.json`),
      resultPath: path.join(sessionsDir, `${taskId}.result.json`),
      streamPath: path.join(sessionsDir, `${taskId}.stream.jsonl`),
      errPath: path.join(sessionsDir, `${taskId}.stderr.log`),
    }

    await Promise.all([paths.resultPath, paths.streamPath, paths.errPath].map(file => rm(file, { force: true })))
    const initialWorkerEnvironment = structuredClone(sandbox.meta?.workerEnvironment ?? null)
    const handle = resumePath
      ? await adapter.resume({ sandbox, sessionId: record.sessionId, message: prompt, model, effort, network, ...paths })
      : await adapter.spawn({ sandbox, prompt, model, effort, network, ...paths })

    // Subscribe to the child's exit synchronously, before awaiting anything else: a fast child can
    // exit between the spawn and the point we would otherwise start waiting, and that 'exit' would
    // fire with no listener and hang the driver.
    const exited = waitForExit(handle.child, timeoutMs)
    const sessionId = (await handle.sessionId) ?? record.sessionId ?? null
    record = { ...record, taskId, sessionId, sandbox, state: 'running', prerequisites: sandbox.meta?.prerequisites, initialWorkerEnvironment: record.initialWorkerEnvironment ?? initialWorkerEnvironment, ...(effortIgnored ? { effortIgnored } : {}) }
    await writeJson(sessionFile, record)

    // An adapter whose sandbox is a throwaway checkout (Cursor) removes it once a `done` result is
    // recorded and its work is on the task branch. The result is written first, so a cleanup that
    // fails can never change what was recorded. A blocked, failed or orphaned task keeps its sandbox:
    // `message` or a re-dispatch resumes it there.
    const finalize = async () => {
      if (!adapter.cleanupOnResult || record.state !== 'done') return
      try {
        await adapter.cleanup({ sandbox })
      } catch {
        return
      }
      record = { ...record, sandboxRemoved: true }
      await writeJson(sessionFile, record)
    }

    const closeFix = (outcome, tip) => {
      if (!fixEntry) return
      Object.assign(fixEntry, { outcome, tip, endedAt: Date.now() })
    }
    const orphan = async (exitReason) => {
      closeFix('orphaned', null)
      record = { ...record, state: 'orphaned', exitReason, usage: await safeUsage(adapter, paths.streamPath) }
      await writeJson(sessionFile, record)
      return { kind: 'orphaned' }
    }
    // After a fix-round collection the task tip must equal or descend from the tip the round
    // started from. A tip that does not is put back (only if it is still the one observed) and
    // the round is recorded as failed. Returns the refused result, or null when the tip is sound.
    const refuseResetTip = async (current) => {
      if (!fixRound) return null
      let tip = null
      try { tip = await checkedGit(git, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`], runRepo) } catch { tip = null }
      if (tip === priorTip) return null
      if (tip !== null && (await git(['merge-base', '--is-ancestor', '--end-of-options', priorTip, tip], { cwd: runRepo })).code === 0) return null
      if (tip !== null) await checkedGit(git, ['update-ref', `refs/heads/${branch}`, priorTip, tip], runRepo)
      const failed = { ...current, status: 'failed',
        blockers: appendBlocker(current.blockers, 'the fix round moved the task branch off its prior task tip; the prior tip was restored') }
      closeFix('reset-refused', tip)
      record = { ...record, state: 'failed', exitReason: 'fix-round-reset', result: failed, usage: await safeUsage(adapter, paths.streamPath) }
      await writeJson(sessionFile, record)
      await observe('handoff', 'blocked')
      return { kind: 'result', result: { taskId, ...failed, ...unverified } }
    }

    const reason = await exited
    if (reason === 'timeout') return orphan('timeout')
    // An adapter whose result lives in its stream file flushes that file after the child exits.
    await handle.flushed

    let result = await adapter.readResult({ resultPath: paths.resultPath, streamPath: paths.streamPath })
    if (!validateResult(result)) return orphan((await stderrTail(paths.errPath)) || 'no result')

    await adapter.collect(git, { runRepo, sandbox, branch })
    const reset = await refuseResetTip(result)
    if (reset) return reset
    let code = enforcementAnswer(await completeEnforcement(taskId)).code
    await observe('gate-result', code === 0 ? 'pass' : code === 3 ? 'fail' : 'unknown')

    if (code === 3) {
      // One enforcement resume with the fixed refusal, then re-check. A teammate that still fails
      // is a driver-forced failure, not the teammate's claim.
      await Promise.all([paths.resultPath, paths.streamPath, paths.errPath].map(file => rm(file, { force: true })))
      const h2 = await adapter.resume({
        sandbox, sessionId, message: fixedRefusal(taskId, runId), model, effort, network, ...paths,
      })
      const exited2 = waitForExit(h2.child, timeoutMs)
      await h2.sessionId
      const reason2 = await exited2
      if (reason2 === 'timeout') return orphan('timeout')
      await h2.flushed
      const reread = await adapter.readResult({ resultPath: paths.resultPath, streamPath: paths.streamPath })
      if (!validateResult(reread)) return orphan('no current valid result after resume')
      result = reread
      await adapter.collect(git, { runRepo, sandbox, branch })
      const resetAgain = await refuseResetTip(result)
      if (resetAgain) return resetAgain
      code = enforcementAnswer(await completeEnforcement(taskId)).code
      await observe('gate-result', code === 0 ? 'pass' : code === 3 ? 'fail' : 'unknown')
      if (code === 3) {
        const failed = {
          ...result,
          status: 'failed',
          blockers: appendBlocker(result.blockers, 'enforcement checks rejected the task twice'),
        }
        closeFix('failed', await checkedGit(git, ['rev-parse', '--verify', `refs/heads/${branch}`], runRepo).catch(() => null))
        record = {
          ...record, state: 'failed', exitReason: 'enforcement', result: failed,
          usage: await safeUsage(adapter, paths.streamPath),
        }
        await writeJson(sessionFile, record)
        await observe('handoff', 'blocked')
        await finalize()
        return { kind: 'result', result: { taskId, ...failed, ...unverified } }
      }
    }

    closeFix(result.status, await checkedGit(git, ['rev-parse', '--verify', `refs/heads/${branch}`], runRepo).catch(() => null))
    record = {
      ...record, state: result.status, exitReason: 'exit', result,
      usage: await safeUsage(adapter, paths.streamPath),
    }
    await writeJson(sessionFile, record)
    await observe('handoff', result.status === 'done' ? 'done' : 'blocked')
    await finalize()
    return { kind: 'result', result: { taskId, ...result, ...unverified } }
  }

  // A processTask throw (adapter.makeSandbox/collect throw via the codex adapter's `must()` on any
  // git failure) must orphan only THAT task, never reject the pool and abandon its siblings. The
  // error is written to the task's session so a resume can see why it failed.
  async function orphanThrow(task, err) {
    const message = err && err.message ? err.message : String(err)
    // The session write is itself guarded: a second fault here (e.g. the session write rejects)
    // must NOT escape the worker's catch and re-reject the pool, which would revive the
    // sibling-abandonment this whole path exists to prevent. A write failure still yields an
    // in-memory orphaned outcome; only the on-disk record is lost.
    try {
      const sessionFile = path.join(sessionsDir, `${task.id}.json`)
      const prior = (await readJson(sessionFile)) || {}
      await writeJson(sessionFile, { ...prior, taskId: task.id, state: 'orphaned', exitReason: message })
    } catch { /* double fault: keep the task orphaned in memory, do not re-throw */ }
    return { kind: 'orphaned' }
  }

  try {
    const outcomes = new Map()
    await runPool(phaseTasks, maxParallel, async (task) => {
      try {
        outcomes.set(task.id, await processTask(task))
      } catch (err) {
        outcomes.set(task.id, await orphanThrow(task, err))
      }
    })
    const results = []
    const orphaned = []
    for (const task of phaseTasks) {
      const outcome = outcomes.get(task.id)
      if (outcome && outcome.kind === 'result') results.push(outcome.result)
      else orphaned.push(task.id)
    }
    return { results, orphaned }
  } finally {
    await releaseLock(lockPath)
  }
}
