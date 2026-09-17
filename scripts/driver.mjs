// The headless driver loop. Owns the whole per-phase control flow so a harness adapter
// (`scripts/harnesses/*`) can stay declarative: the adapter knows a CLI's argv and sandbox,
// the driver knows the ordering, concurrency, timeout, session bookkeeping and the enforcement
// gate. It never writes `done` from a teammate's word — a returned status is the teammate's
// claim, and every `done` claim must survive `complete --enforcement-only` (the same check the
// phase gate recomputes) before it is recorded. Returns `{ results, orphaned }` in the shape the
// Workflow template returns (`templates/phase-workflow.js`), so the CLI post-processing, the
// gate and `finish` are identical on both dispatch paths.
import { mkdir, readFile, writeFile, rm, link, unlink } from 'node:fs/promises'
import path from 'node:path'

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
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
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

// Runs one phase's implementer tasks on a harness, at most `maxParallel` at once. Returns
// `{ results, orphaned }` in the shape the Workflow path returns: `results` is `{ taskId, ... }`
// entries (the teammate's own result fields), `orphaned` is the ids of tasks that produced no
// usable result. Never writes `done` itself — a recorded status is the teammate's claim subjected
// to `completeEnforcement`, and the gate still decides landability.
export async function dispatchPhase({
  adapter, git, runRepo, runId, runBranch, phaseTasks,
  maxParallel, sandboxMode, network, timeoutMinutes, tierModels, effortFor,
  composeBriefFor, personaFor, runDir, completeEnforcement,
}) {
  const sessionsDir = path.join(runDir, 'sessions')
  const lockPath = path.join(runDir, 'driver.lock')
  await mkdir(sessionsDir, { recursive: true })
  await acquireLock(lockPath)

  const timeoutMs = (Number(timeoutMinutes) > 0 ? Number(timeoutMinutes) : 30) * 60_000

  const resolveModel = (task) => {
    if (task.model) return task.model
    if (task.tier && tierModels && tierModels[task.tier]) return tierModels[task.tier]
    return undefined
  }

  async function processTask(task) {
    const taskId = task.id
    const branch = `fleetmates/${runId}/${taskId}`
    const sessionFile = path.join(sessionsDir, `${taskId}.json`)
    let record = (await readJson(sessionFile)) || {}

    // Idempotent resume of a whole run: a recorded, well-formed result is final — re-record it
    // and never respawn the task.
    if (record.result && typeof record.result === 'object' && typeof record.result.status === 'string') {
      return { kind: 'result', result: { taskId, ...record.result } }
    }

    const resumePath = typeof record.sessionId === 'string' && record.sessionId.length > 0
    const sandbox = (resumePath && record.sandbox)
      ? record.sandbox
      : await adapter.makeSandbox(git, { runRepo, runBranch, runId, taskId, mode: sandboxMode })

    const role = task.role || 'implementer'
    const prompt = `${personaFor(role)}\n\n${composeBriefFor(task)}`
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

    const handle = resumePath
      ? await adapter.resume({ sandbox, sessionId: record.sessionId, message: prompt, model, effort, network, ...paths })
      : await adapter.spawn({ sandbox, prompt, model, effort, network, ...paths })

    // Subscribe to the child's exit synchronously, before awaiting anything else: a fast child can
    // exit between the spawn and the point we would otherwise start waiting, and that 'exit' would
    // fire with no listener and hang the driver.
    const exited = waitForExit(handle.child, timeoutMs)
    const sessionId = (await handle.sessionId) ?? record.sessionId ?? null
    record = { ...record, taskId, sessionId, sandbox, state: 'running', ...(effortIgnored ? { effortIgnored } : {}) }
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

    const orphan = async (exitReason) => {
      record = { ...record, state: 'orphaned', exitReason, usage: await safeUsage(adapter, paths.streamPath) }
      await writeJson(sessionFile, record)
      return { kind: 'orphaned' }
    }

    const reason = await exited
    if (reason === 'timeout') return orphan('timeout')
    // An adapter whose result lives in its stream file flushes that file after the child exits.
    await handle.flushed

    let result = await adapter.readResult({ resultPath: paths.resultPath, streamPath: paths.streamPath })
    if (result == null) return orphan((await stderrTail(paths.errPath)) || 'no result')

    await adapter.collect(git, { runRepo, sandbox, branch })
    let code = await completeEnforcement(taskId)

    if (code === 3) {
      // One enforcement resume with the fixed refusal, then re-check. A teammate that still fails
      // is a driver-forced failure, not the teammate's claim.
      const h2 = await adapter.resume({
        sandbox, sessionId, message: fixedRefusal(taskId, runId), model, effort, network, ...paths,
      })
      const exited2 = waitForExit(h2.child, timeoutMs)
      await h2.sessionId
      const reason2 = await exited2
      if (reason2 === 'timeout') return orphan('timeout')
      await h2.flushed
      const reread = await adapter.readResult({ resultPath: paths.resultPath, streamPath: paths.streamPath })
      if (reread != null) result = reread
      await adapter.collect(git, { runRepo, sandbox, branch })
      code = await completeEnforcement(taskId)
      if (code === 3) {
        const failed = {
          ...result,
          status: 'failed',
          blockers: appendBlocker(result.blockers, 'enforcement checks rejected the task twice'),
        }
        record = {
          ...record, state: 'failed', exitReason: 'enforcement', result: failed,
          usage: await safeUsage(adapter, paths.streamPath),
        }
        await writeJson(sessionFile, record)
        await finalize()
        return { kind: 'result', result: { taskId, ...failed } }
      }
    }

    record = {
      ...record, state: result.status, exitReason: 'exit', result,
      usage: await safeUsage(adapter, paths.streamPath),
    }
    await writeJson(sessionFile, record)
    await finalize()
    return { kind: 'result', result: { taskId, ...result } }
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
