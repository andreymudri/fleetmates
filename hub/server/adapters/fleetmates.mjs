import fs, { constants, existsSync, readFileSync, watch as fsWatch } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Where this adapter loads the fleetmates modules (names, liveness, git) from. Inside a fleetmates
 * checkout (the hub's parent holds a package.json named `fleetmates` and scripts/names.mjs) it is
 * that checkout's scripts/, so the root contract test and the deck read the same code and a stale
 * vendored copy is never used. Otherwise, as in an installed package, it is vendor/fleetmates/,
 * which `prepack` fills with bin/vendor-fleetmates.mjs.
 * @param {string} [adapterDir] the directory holding this adapter
 * @returns {string}
 */
export function fleetmatesScriptsDir(adapterDir = path.dirname(fileURLToPath(import.meta.url))) {
  const repo = path.resolve(adapterDir, '../../..')
  try {
    if (JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).name === 'fleetmates'
      && existsSync(path.join(repo, 'scripts', 'names.mjs'))) return path.join(repo, 'scripts')
  } catch {}
  const vendored = path.resolve(adapterDir, '../../vendor/fleetmates')
  if (existsSync(path.join(vendored, 'names.mjs'))) return vendored
  throw new Error('fleetmates modules not found: run from a fleetmates checkout, or install a package packed with bin/vendor-fleetmates.mjs')
}

const scriptsDir = fleetmatesScriptsDir()
const load = (name) => import(pathToFileURL(path.join(scriptsDir, name)).href)
const [{ NAMES }, { livenessRows, DEFAULT_STALE_MINUTES }, { createGit, defaultGitExec }, { worktreeKey, indexDir, isLocalAbsolute }] = await Promise.all([
  load('names.mjs'), load('liveness.mjs'), load('git.mjs'), load('state.mjs'),
])

const MAX_FILE_BYTES = 1024 * 1024
const MAX_DISCOVERY_DEPTH = 16
const MAX_TOUCH_ENTRIES = 5000
const RUN_INTERNAL_DIRS = new Set(['claims', 'clones', 'index', 'reviews', 'sessions', 'worktrees'])
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)

const safeText = (value) => {
  try { return String(value ?? '').replace(/[\p{Bidi_Control}\p{Cc}]/gu, '') } catch { return '' }
}
const finiteNumber = (value) => Number.isFinite(value) ? value : null
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function readJson(file, retryDelayMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle
    try {
      handle = await open(file, READ_FLAGS)
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('not a regular file')
      if (info.size > MAX_FILE_BYTES) throw new Error('file exceeds size limit')
      const data = await handle.readFile('utf8')
      return { value: JSON.parse(data), error: null }
    } catch (error) {
      if (error.code === 'ENOENT') return { value: null, error: null }
      if (error instanceof SyntaxError && attempt === 0) {
        await wait(retryDelayMs)
        continue
      }
      return { value: null, error: error instanceof SyntaxError ? 'Malformed JSON' : safeText(error.message) }
    } finally {
      if (handle) await handle.close()
    }
  }
  return { value: null, error: 'Malformed JSON' }
}

async function discover(repoRoot) {
  const stateRoot = path.join(repoRoot, NAMES.stateDir)
  const found = []
  async function visit(dir, parts) {
    if (parts.length > MAX_DISCOVERY_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    const isRun = parts.length && entries.some((entry) => entry.name === 'plan.json' || entry.name === 'status.json')
    if (isRun) {
      found.push({ repoRoot, runId: parts.join('/'), dir })
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!parts.length && entry.name === 'index') continue
      if (isRun && RUN_INTERNAL_DIRS.has(entry.name)) continue
      if (entry.name === '.' || entry.name === '..') continue
      await visit(path.join(dir, entry.name), [...parts, entry.name])
    }
  }
  await visit(stateRoot, [])
  return found
}

async function newestWorktreeMtime(dir, ignored) {
  let newest = null
  let visited = 0
  const stack = [dir]
  while (stack.length) {
    let entries
    const current = stack.pop()
    try { entries = await readdir(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++visited > MAX_TOUCH_ENTRIES) return { at: newest, floored: true }
      if (entry.name === '.git' || entry.isSymbolicLink()) continue
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full).split(path.sep).join('/')
      if (ignored.has(rel) || ignored.has(`${rel}/`)) continue
      if (entry.isDirectory()) { stack.push(full); continue }
      if (!entry.isFile()) continue
      try {
        const mtime = (await stat(full)).mtimeMs
        if (newest === null || mtime > newest) newest = mtime
      } catch {}
    }
  }
  return { at: newest, floored: false }
}

async function branchHasTaskCommit(repoRoot, branch, tip) {
  const result = await defaultGitExec(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], repoRoot)
  if (result.code !== 0) return null
  const creationTip = result.stdout.trim().split('\n').at(-1)
  return creationTip ? creationTip !== tip : null
}

function gateRows(gates) {
  const result = {}
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) return result
  for (const [phase, gate] of Object.entries(gates)) {
    const key = safeText(phase)
    if (!key || Object.prototype.hasOwnProperty.call(Object.prototype, key) || !gate || typeof gate !== 'object') continue
    if (gate.verdict !== 'PASS' && gate.verdict !== 'FAIL') continue
    result[key] = {
      verdict: gate.verdict,
      failed: Array.isArray(gate.failed) ? gate.failed.map(safeText) : [],
      optionalFailed: Array.isArray(gate.optionalFailed) ? gate.optionalFailed.map(safeText) : [],
      skipped: Array.isArray(gate.skipped) ? gate.skipped.map(safeText) : [],
      pending: Array.isArray(gate.pending) ? gate.pending.map(safeText) : [],
      phase: finiteNumber(gate.phase),
      phaseName: gate.phaseName == null ? null : safeText(gate.phaseName),
      recordedAt: finiteNumber(gate.recordedAt),
    }
  }
  return result
}

async function defaultPollRun({ repoRoot, runId, plan, status, now }) {
  const git = createGit({ cwd: repoRoot })
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []
  const statusById = new Map((Array.isArray(status?.tasks) ? status.tasks : []).filter((task) => task && typeof task.id === 'string').map((task) => [task.id, task]))
  const tips = {}
  const shas = new Map()
  const started = new Map()
  for (const task of tasks) {
    if (typeof task.id !== 'string' || !/^T\d+$/.test(task.id)) continue
    const branch = `${NAMES.branchPrefix}/${runId}/${task.id}`
    try {
      if (!await git.branchExists(branch)) continue
      const sha = await git.resolveRef(`refs/heads/${branch}`)
      shas.set(task.id, sha)
      started.set(task.id, await branchHasTaskCommit(repoRoot, branch, sha))
      tips[task.id] = { branch, at: await git.commitTime(sha) }
    } catch {}
  }
  let derivedPhase = null
  let phaseDerivation = 'unknown'
  if (typeof plan?.runBranch === 'string' && plan.runBranch) {
    try {
      const runSha = await git.resolveRef(`refs/heads/${plan.runBranch}`)
      const phases = [...new Set(tasks.map((task) => task.phase).filter(Number.isInteger))].sort((a, b) => a - b)
      let missingBranch = false
      for (const phase of phases) {
        const phaseTasks = tasks.filter((task) => task.phase === phase)
        const gatePassed = status?.gates?.[phase]?.verdict === 'PASS'
        let integrated = true
        for (const task of phaseTasks) {
          const sha = shas.get(task.id)
          if (!sha || started.get(task.id) === null) missingBranch = true
          if (statusById.get(task.id)?.state !== 'done'
            || (sha ? started.get(task.id) === false || (started.get(task.id) === null && !gatePassed) || !await git.isAncestor(sha, runSha) : !gatePassed)) integrated = false
        }
        if (!integrated) { derivedPhase = phase; break }
      }
      phaseDerivation = missingBranch ? 'unknown' : 'verified'
    } catch {}
  }
  const touches = {}
  try {
    const byBranch = new Map((await git.worktrees()).filter((wt) => wt.branch).map((wt) => [wt.branch, wt.path]))
    for (const task of tasks) {
      const branch = `${NAMES.branchPrefix}/${runId}/${task.id}`
      const dir = byBranch.get(branch)
      if (!dir) continue
      touches[task.id] = { branch, ...await newestWorktreeMtime(dir, new Set()) }
    }
  } catch {}
  const liveness = livenessRows({
    tasks: Array.isArray(status?.tasks) ? status.tasks : [],
    tips, touches, now, staleMinutes: DEFAULT_STALE_MINUTES,
  })
  return { derivedPhase, phaseDerivation, liveness }
}

async function projectRun(entry, planResult, statusResult, polled) {
  const plan = planResult.value && typeof planResult.value === 'object' ? planResult.value : {}
  const status = statusResult.value && typeof statusResult.value === 'object' ? statusResult.value : {}
  const planTasks = Array.isArray(plan.tasks) ? plan.tasks : []
  const statusTasks = Array.isArray(status.tasks) ? status.tasks : []
  const byId = new Map(statusTasks.filter((task) => task && typeof task.id === 'string').map((task) => [task.id, task]))
  const allTasks = [...planTasks]
  for (const task of statusTasks) {
    if (task && typeof task.id === 'string' && !planTasks.some((planned) => planned?.id === task.id)) allTasks.push(task)
  }
  const tasks = allTasks.filter((task) => task && typeof task.id === 'string').map((task) => {
    const current = byId.get(task.id) ?? {}
    const phase = finiteNumber(task.phase)
    return {
      id: safeText(task.id),
      title: safeText(current.title ?? task.title),
      state: safeText(current.state ?? 'pending'),
      phase,
      phaseLabel: phase == null ? null : `Phase ${phase}`,
      files: Array.isArray(task.files) ? task.files.map(safeText) : [],
      deps: Array.isArray(task.deps) ? task.deps.map(safeText) : [],
      tier: task.tier == null ? null : safeText(task.tier),
      startedAt: finiteNumber(current.startedAt),
      blockedBy: current.blockedBy == null ? null : safeText(current.blockedBy),
    }
  })
  const livenessById = new Map((polled?.liveness ?? []).map((row) => [row.taskId, row.state]))
  return {
    repoId: await realpath(entry.repoRoot),
    runId: safeText(entry.runId),
    kind: 'build',
    leadSessionId: null,
    derivedPhase: finiteNumber(polled?.derivedPhase),
    phaseDerivation: polled?.phaseDerivation === 'verified' ? 'verified' : 'unknown',
    totalPhases: finiteNumber(plan.totalPhases ?? status.totalPhases) ?? 0,
    maxParallel: finiteNumber(status.maxParallel),
    planPath: plan.planPath == null ? null : safeText(plan.planPath),
    runBranch: plan.runBranch == null ? null : safeText(plan.runBranch),
    tasks,
    gates: gateRows(status.gates),
    teammates: tasks.map((task) => ({
      taskId: task.id, sessionId: null, state: task.state, liveness: livenessById.get(task.id) ?? null,
    })),
    readError: planResult.error ? { file: 'plan.json', message: planResult.error }
      : statusResult.error ? { file: 'status.json', message: statusResult.error } : null,
  }
}

// Teammate lookup (04-integrations 1.3, state-machines 11). The record bound and the id rules below restate
// scripts/state.mjs, which keeps them private; the parity test in test/unit/fleetmates-adapter.test.mjs
// compares this lookup with `findTaskByWorktree` over a set of hostile ids.
const MAX_RECORD_BYTES = 64 * 1024
const MAX_RUN_ID_BYTES = 255
const MAX_TASK_ID_BYTES = 128
const ID_COMPONENT = /^[\p{L}\p{M}\p{N}._-]+$/u
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u
const RECORD_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)
const TASK_CACHE_LIMIT = 1024

function idInside(repoRoot, value, single) {
  if (typeof value !== 'string' || value === '') return false
  const base = path.resolve(repoRoot, NAMES.stateDir)
  const rel = path.relative(base, path.resolve(base, value))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  return !single || !rel.includes(path.sep)
}
function idPath(value, maxBytes) {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > maxBytes) return false
  if (value.normalize('NFC') !== value || value.includes('..')) return false
  return value.split('/').every((part) => part !== '.' && part !== '..' && !part.startsWith('-') && ID_COMPONENT.test(part) && !INVISIBLE.test(part))
}

/**
 * Whether `runId` passes the fleetmates run id rules (scripts/state.mjs): contained in the state directory,
 * nesting allowed, an allowlisted NFC id of at most 255 bytes with no `..` and no component starting with `-`.
 * @param {string} repoRoot absolute repository root
 * @param {unknown} runId
 * @returns {boolean}
 */
export function isRunName(repoRoot, runId) {
  return idInside(repoRoot, runId, false) && idPath(runId, MAX_RUN_ID_BYTES)
}
const isTaskName = (repoRoot, taskId) => idInside(repoRoot, taskId, true) && idPath(taskId, MAX_TASK_ID_BYTES)

function readTaskRecord(io, repoRoot, cwd) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) return null
  const key = worktreeKey(cwd)
  if (key === '') return null
  let fd
  try {
    fd = io.openSync(path.join(indexDir(repoRoot), `${key}.json`), RECORD_FLAGS)
    const info = io.fstatSync(fd)
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null
    const buffer = Buffer.alloc(info.size)
    const bytes = io.readSync(fd, buffer, 0, buffer.length, 0)
    const record = JSON.parse(buffer.toString('utf8', 0, bytes))
    if (!isRunName(repoRoot, record?.runId) || !isTaskName(repoRoot, record.taskId)) return null
    if (!isLocalAbsolute(record.worktree) || worktreeKey(record.worktree) !== key) return null
    return { runId: record.runId, taskId: record.taskId }
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { io.closeSync(fd) } catch {}
  }
}

/**
 * Create a synchronous teammate lookup that reads one fleetmates index record per `cwd` and caches the
 * answer for `ttlMs` when it finds a task; a miss is read again on the next call. It never writes under `.fleetmates/`.
 * @param {{ clock?: () => number, ttlMs?: number, io?: Pick<typeof fs, 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'> }} [options]
 * @returns {{ taskForCwd: (repoRoot: string, cwd: string) => { runId: string, taskId: string } | null }}
 */
export function createTaskLocator({ clock = Date.now, ttlMs = 60_000, io = fs } = {}) {
  const cache = new Map()
  return {
    taskForCwd(repoRoot, cwd) {
      const key = `${repoRoot}\0${cwd}`
      const now = clock()
      const hit = cache.get(key)
      if (hit && now - hit.at < ttlMs) return { ...hit.task }
      cache.delete(key)
      const task = readTaskRecord(io, repoRoot, cwd)
      // A miss is not kept: a teammate's own `locate` hook looks its worktree up before the record exists.
      if (!task) return null
      if (cache.size >= TASK_CACHE_LIMIT) cache.delete(cache.keys().next().value)
      cache.set(key, { at: now, task })
      return { ...task }
    },
  }
}

const defaultLocator = createTaskLocator()
/**
 * The fleetmates task whose worktree is `cwd`, from `<repoRoot>/.fleetmates/index/<worktreeKey(cwd)>.json`,
 * or null. Synchronous, a hit is cached per `cwd` for 60 s, a miss is not.
 * @param {string} repoRoot absolute main repository root
 * @param {string} cwd the directory a hook reported
 * @returns {{ runId: string, taskId: string } | null}
 */
export function taskForCwd(repoRoot, cwd) {
  return defaultLocator.taskForCwd(repoRoot, cwd)
}

/** Create a read-only fleetmates run reader with a bounded git poll interval. */
export function createFleetmatesReader({ repoRoots = [], clock = Date.now, pollRun = defaultPollRun,
  pollIntervalMs = 60_000, retryDelayMs = 25, debounceMs = 250, watchFactory = fsWatch } = {}) {
  const cache = new Map()
  const watchers = new Map()
  const debounceTimers = new Map()
  let listener = null
  const keyFor = (repoRoot, runId) => `${repoRoot}\0${runId}`
  const attachWatcher = (entry) => {
    const key = keyFor(entry.repoRoot, entry.runId)
    if (!listener || watchers.has(key)) return
    try {
      const watcher = watchFactory(entry.dir, () => {
        clearTimeout(debounceTimers.get(key))
        debounceTimers.set(key, setTimeout(() => {
          debounceTimers.delete(key)
          const item = cache.get(key)
          if (item) item.dirty = true
          listener?.(entry.repoRoot, entry.runId)
        }, debounceMs))
      })
      watcher.on?.('error', () => {
        watcher.close()
        watchers.delete(key)
        const item = cache.get(key)
        if (item) item.dirty = true
      })
      watchers.set(key, watcher)
    } catch {
      const item = cache.get(key)
      if (item) item.dirty = true
    }
  }
  return {
    /** Read discovered runs, reusing cached polls inside the interval. */
    async list() {
      const entries = (await Promise.all(repoRoots.map(discover))).flat()
      const rows = []
      for (const entry of entries) {
        const key = keyFor(entry.repoRoot, entry.runId)
        const previous = cache.get(key)
        const now = clock()
        const due = !previous || now - previous.polledAt >= pollIntervalMs
        const dirty = previous?.dirty === true
        if (previous && !due && !dirty) {
          rows.push(previous.run)
          continue
        }
        const planResult = await readJson(path.join(entry.dir, 'plan.json'), retryDelayMs)
        const statusResult = await readJson(path.join(entry.dir, 'status.json'), retryDelayMs)
        let polled = previous?.polled ?? null
        if (due && !planResult.error && !statusResult.error) {
          try {
            polled = await pollRun({ repoRoot: entry.repoRoot, runId: entry.runId,
              plan: planResult.value, status: statusResult.value, now })
          } catch {
            polled = null
          }
        }
        const readError = planResult.error ? { file: 'plan.json', message: planResult.error }
          : statusResult.error ? { file: 'status.json', message: statusResult.error } : null
        const run = readError && previous
          ? { ...previous.run, readError }
          : await projectRun(entry, planResult, statusResult, polled)
        cache.set(key, { entry, run, polled, polledAt: due ? now : previous.polledAt, dirty: false })
        rows.push(run)
        attachWatcher(entry)
      }
      return rows
    },
    /** Mark a run's files for re-reading on the next list call. */
    invalidate(repoRoot, runId) {
      const item = cache.get(keyFor(repoRoot, runId))
      if (item) item.dirty = true
    },
    /** Notify when a known run directory changes. */
    watch(callback) {
      listener = callback
      for (const item of cache.values()) attachWatcher(item.entry)
    },
    /** Close all file watchers. */
    close() {
      for (const timer of debounceTimers.values()) clearTimeout(timer)
      debounceTimers.clear()
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
      listener = null
    },
  }
}
