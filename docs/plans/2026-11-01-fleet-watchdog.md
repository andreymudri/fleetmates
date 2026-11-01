# Fleet watchdog implementation plan

Spec: `docs/specs/2026-11-01-fleet-watchdog-design.md`.

## Global Constraints

- Node >= 20, ESM `.mjs`, `node:test` + `node:assert/strict`
- Zero new runtime or dev dependencies at the repo root
- Commit messages: single line, commitlint style, English, no tool attribution of any kind
- No personal names, emails or real home paths in code, docs, fixtures or test output
- Every new test must be shown to fail under a mutation of the code it covers, then pass (CONTRIBUTING.md)
- Anything a plan or teammate authored that reaches a terminal goes through `printable` from `scripts/reviews.mjs`
- Run long test commands in the foreground with an explicit timeout of at least 600000 ms
- Watchdog state is supervision only: no gate check may read `watch.json`, the rescue directory or watchdog ledger events

## Destination

A fleet run whose implementer stalls recovers on its own: the orchestrator is told by `cli.mjs watch`
to resume, then respawn from a rescue patch, then give up and notify, with no token spent while every
teammate works.

## Out of Scope

- Deck session watching — the owner chose fleet teammates only; deck sessions have their own idle detection.
- Watching reviewers and the integrator — they have no task branch for liveness to measure.
- Acting on `unknown` rows — acting on an unmeasured signal can interrupt a working teammate.

### Task 1: pure ladder decision

**Files:**
- Create: `scripts/watch.mjs`
- Test: `tests/watch.test.mjs`

- [ ] **Step 1:** Write `tests/watch.test.mjs` first covering: first stall -> `resume` attempt 1; second stall after the window -> `resume` attempt 2; third -> `respawn` attempt 1 with `resumes` reset to 0; after respawn two resumes then `orphan`; `orphaned` history -> `none` forever; a stall inside `staleMinutes` of `lastActionAt` -> `none`; `working` and `not started` -> `none` with history unchanged; `unknown` -> `unmeasured` once carrying `reason`, then `none`; `resumes: 0, respawns: 0` -> first stall is `orphan`; `resumes: 0, respawns: 1` -> first stall is `respawn`; the input history object is never mutated. Run it and watch it fail (module missing).
- [ ] **Step 2:** Create `scripts/watch.mjs`:

```js
// The watchdog's ladder, pure: given one liveness row and what the watchdog already did for that
// task, decide the next action. No repository access and no clock of its own, like liveness.mjs.
// The signals behind a row are forgeable by the teammate they describe, so nothing here is gate
// evidence; it only decides how hard to nudge.

export const WATCH_DEFAULTS = Object.freeze({
  enabled: true, resumes: 2, respawns: 1, staleMinutes: 20, intervalMinutes: 5,
})

export const ACTIONS = Object.freeze(['none', 'resume', 'respawn', 'orphan', 'unmeasured'])

export function emptyHistory() {
  return { resumes: 0, respawns: 0, lastActionAt: null, orphaned: false, notified: false }
}

export function nextAction(row, history, config, now) {
  if (!Number.isFinite(now)) throw new Error(`nextAction requires a numeric clock, got ${JSON.stringify(now)}`)
  const h = { ...emptyHistory(), ...(history ?? {}) }
  const none = { action: 'none', attempt: 0, history: h }
  if (h.orphaned) return none
  if (row.state === 'unknown') {
    if (h.notified) return none
    return { action: 'unmeasured', attempt: 0, reason: row.unknownReason ?? null, history: { ...h, notified: true } }
  }
  if (row.state !== 'stalled') return none
  // A teammate just nudged gets a full window to show progress, measured from the nudge.
  if (h.lastActionAt != null && now - h.lastActionAt < config.staleMinutes * 60 * 1000) return none
  if (h.resumes < config.resumes) {
    return { action: 'resume', attempt: h.resumes + 1, history: { ...h, resumes: h.resumes + 1, lastActionAt: now } }
  }
  if (h.respawns < config.respawns) {
    return { action: 'respawn', attempt: h.respawns + 1, history: { ...h, resumes: 0, respawns: h.respawns + 1, lastActionAt: now } }
  }
  return { action: 'orphan', attempt: 0, history: { ...h, orphaned: true, lastActionAt: now } }
}
```

- [ ] **Step 3:** Run `node --test tests/watch.test.mjs`; all pass. Mutate (e.g. `<` to `<=` on `h.resumes`, drop the grace check, drop `resumes: 0` on respawn), confirm a test fails for each, restore.
- [ ] **Step 4:** Commit `feat(watch): pure ladder decision for the fleet watchdog`.

### Task 2: watch config block

**Files:**
- Modify: `scripts/config.mjs`
- Test: `tests/config.test.mjs`

- [ ] **Step 1:** Add tests to `tests/config.test.mjs`: `validateLocal({ watch: { resumes: 3 } })` passes; each of `watch.enabled: 'yes'`, `watch.resumes: -1`, `watch.respawns: 1.5`, `watch.staleMinutes: 0`, `watch.intervalMinutes: 0`, `watch.bogus: 1`, `watch: []` throws `ConfigError` naming the key; `validateGate` accepts the same block; `loadConfig` on a repo with no files resolves `resolved.watch` to `{ enabled: true, resumes: 2, respawns: 1, staleMinutes: 20, intervalMinutes: 5 }`; a local `watch.resumes: 4` over a gate `watch.resumes: 1` resolves to 4 and keeps the other defaults; `validateKey('watch.respawns', 2)` returns 2 and `validateKey('watch.respawns', -1)` throws. Watch them fail.
- [ ] **Step 2:** In `scripts/config.mjs` add, after `validateHarnesses`:

```js
// The watchdog's knobs. Not an enforcement key: nothing here changes a verdict, it only decides how
// hard the orchestrator nudges a stalled teammate, so both layers may carry it.
const WATCH_FIELDS = {
  enabled: (v) => typeof v === 'boolean',
  resumes: (v) => Number.isInteger(v) && v >= 0,
  respawns: (v) => Number.isInteger(v) && v >= 0,
  staleMinutes: (v) => Number.isInteger(v) && v >= 1,
  intervalMinutes: (v) => Number.isInteger(v) && v >= 1,
}
const WATCH_RULES = {
  enabled: 'a boolean', resumes: 'an integer >= 0', respawns: 'an integer >= 0',
  staleMinutes: 'an integer >= 1', intervalMinutes: 'an integer >= 1',
}

export function validateWatch(watch, file) {
  if (watch === null || typeof watch !== 'object' || Array.isArray(watch)) {
    throw new ConfigError('watch must be an object')
  }
  for (const [field, value] of Object.entries(watch)) {
    if (!Object.hasOwn(WATCH_FIELDS, field)) throw new ConfigError(`unknown key in ${file}: watch.${field}`)
    if (!WATCH_FIELDS[field](value)) throw new ConfigError(`watch.${field} must be ${WATCH_RULES[field]}`)
  }
  return watch
}
```

- [ ] **Step 3:** In `validateLocal` add `'watch'` to the allowed key list and `if (local.watch !== undefined) validateWatch(local.watch, LOCAL_FILE)`. In `validateGate` add `if (gate.watch !== undefined) validateWatch(gate.watch, GATE_FILE)` (and `'watch'` to its allowed list if it has one). In `loadConfig` add to `resolved`: `watch: { enabled: true, resumes: 2, respawns: 1, staleMinutes: 20, intervalMinutes: 5, ...gate.watch, ...local?.watch }`. Do not import `scripts/watch.mjs` here; the literal defaults must equal `WATCH_DEFAULTS` from Task 1 and a test in Task 6 pins that equality.
- [ ] **Step 4:** In `validateKey`, before the final throw:

```js
  const watchMatch = /^watch\.([A-Za-z]+)$/.exec(dotted)
  if (watchMatch) { validateWatch({ [watchMatch[1]]: value }, LOCAL_FILE); return value }
```

- [ ] **Step 5:** Run `node --test tests/config.test.mjs`; pass. Mutate each validator to accept everything, confirm failures, restore.
- [ ] **Step 6:** Commit `feat(config): watch block for the fleet watchdog`.

### Task 3: rescue patch

**Files:**
- Create: `scripts/rescue.mjs`
- Test: `tests/rescue.test.mjs`

- [ ] **Step 1:** Write `tests/rescue.test.mjs` against a temp git repo (`mkdtemp` under `tmpdir()`, `git init`, one commit, `git worktree add -b task wt`). In `wt`: modify a tracked file, add an untracked text file, add an untracked binary file (bytes 0-255), add a file matched by `.gitignore`. Call `rescueWorktree`. Assert: the patch exists at the returned path; `git apply --index <patch>` on a fresh `git worktree add` of the same commit reproduces the tracked change and both untracked files byte for byte, and not the ignored file; `git -C wt status --porcelain` before and after `rescueWorktree` is identical up to the removal (the real index was never staged: run a variant with `removeWorktree` stubbed to a no-op and assert `git -C wt diff --cached --quiet` still exits 0); `removeWorktree` was called once with the worktree path; a clean worktree returns `{ empty: true }` and still removes it; when the patch directory is unwritable (`patchDir` pointing at an existing regular file), it throws and `removeWorktree` is never called. `rescuePatchPath(dir, 'T3')` returns `dir/T3-1.patch`, then `T3-2.patch` once `T3-1.patch` exists; an id with `/` maps to a 16-hex fingerprint prefix. Watch it fail.
- [ ] **Step 2:** Create `scripts/rescue.mjs`:

```js
// Before a stalled teammate is replaced, its uncommitted work is saved as a patch the replacement
// applies first. Staged through a throwaway index so the worktree's own index is never touched, and
// the worktree is removed only after the patch is safely on disk.
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fingerprint } from './event-ledger.mjs'

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

export function rescueName(taskId) {
  return SAFE_ID.test(taskId) ? taskId : fingerprint(taskId).slice(0, 16)
}

export async function rescuePatchPath(dir, taskId) {
  const name = rescueName(taskId)
  let entries = []
  try { entries = await readdir(dir) } catch { /* absent dir: first patch */ }
  let n = 1
  while (entries.includes(`${name}-${n}.patch`)) n++
  return path.join(dir, `${name}-${n}.patch`)
}

function gitBuffer(cwd, args, env) {
  return execFileSync('git', args, { cwd, env, maxBuffer: 512 * 1024 * 1024 })
}

export async function rescueWorktree({ worktree, patchDir, taskId, removeWorktree }) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'fm-rescue-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') }
  let patch
  try {
    gitBuffer(worktree, ['read-tree', 'HEAD'], env)
    gitBuffer(worktree, ['add', '-A', '--', '.'], env)
    patch = gitBuffer(worktree, ['diff', '--cached', '--binary', 'HEAD'], env)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const empty = patch.length === 0
  let patchFile = null
  if (!empty) {
    await mkdir(patchDir, { recursive: true })
    patchFile = await rescuePatchPath(patchDir, taskId)
    await writeFile(patchFile, patch, { flag: 'wx' })
  }
  await removeWorktree(worktree)
  return { patchFile, empty }
}
```

- [ ] **Step 3:** Run `node --test tests/rescue.test.mjs`; pass. Mutations: drop the `GIT_INDEX_FILE` env (index test must fail), move `removeWorktree` before `writeFile` (unwritable test must fail), drop `--binary` (binary test must fail). Restore.
- [ ] **Step 4:** Commit `feat(watch): rescue a stalled worktree as a patch before removal`.

### Task 4: watchdog ledger event

**Files:**
- Modify: `scripts/event-ledger.mjs`
- Test: `tests/event-ledger.test.mjs`

- [ ] **Step 1:** Add tests: `projectEvent({ kind: 'watchdog', at: 1, action: 'resume' })` returns `{ v: 1, at: 1, kind: 'watchdog', action: 'resume' }`; an `action` outside `resume|respawn|orphan|unmeasured` is dropped from the projection; `action` on a non-`watchdog` kind is dropped; `ledgerSummary` and `stallDecision` give the same answer with and without interleaved `watchdog` events (a watchdog event is not a stop). Watch them fail.
- [ ] **Step 2:** In `scripts/event-ledger.mjs` add `'watchdog'` to `KINDS`, add `const WATCH_ACTIONS = new Set(['resume', 'respawn', 'orphan', 'unmeasured'])`, and in `projectEvent` after the `hook` line: `if (event.kind === 'watchdog' && WATCH_ACTIONS.has(value.action)) event.action = value.action`. If `ledgerSummary`/`stallDecision` count events by kind in a way a `watchdog` event would change, make them skip `watchdog` explicitly.
- [ ] **Step 3:** Run `node --test tests/event-ledger.test.mjs`; pass. Mutate (drop the kind guard on `action`), confirm failure, restore.
- [ ] **Step 4:** Commit `feat(watch): record watchdog actions in the event ledger`.

### Task 5: watch loop and lock

**Files:**
- Create: `scripts/watch-loop.mjs`
- Test: `tests/watch-loop.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Write `tests/watch-loop.test.mjs` with an injected `tick`, fake clock and `sleep` that advances the clock by `intervalMinutes`. Cover: a row stalled on every tick yields events `resume 1`, `resume 2`, `respawn 1`, `resume 1`, `resume 2`, `orphan` in that order with ticks spaced by the stale window, then no more events for that task; `tick` returning `inFlight: false` emits `{event:'exit',reason:'phase-idle'}` and returns 0; `tick` throwing three times in a row emits three `watch-error` events then `{event:'exit',reason:'errors'}` and returns 1, while two throws then a success resets the count; `state.save` receives the history after every tick and a loop started with a saved history continues the ladder (a saved `resumes: 2` makes the next stall a `respawn`); `onAction` is awaited once per non-`none` action with `(taskId, decision)`; a task id containing `\u001b[2J` and `\u009b` is emitted with neither raw byte. Lock: `acquireLock(file, pid, isAlive)` creates the file holding the pid; a second call with `isAlive` returning true throws `LockHeldError` whose message names the holder pid; with `isAlive` false it takes over and rewrites the pid; `releaseLock(file, pid)` removes it only when it still holds `pid`. Watch it fail.
- [ ] **Step 2:** Create `scripts/watch-loop.mjs`:

```js
// The watchdog's heartbeat. Everything that touches the world is injected: `tick` gathers liveness
// rows for the current phase, `emit` prints one event, `state` persists the ladder, `sleep` waits.
// So the whole sequence is testable with a fake clock and no repository.
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { printable } from './reviews.mjs'
import { nextAction } from './watch.mjs'

export const MAX_TICK_FAILURES = 3

export class LockHeldError extends Error {}

export async function acquireLock(file, pid, isAlive) {
  try {
    await writeFile(file, `${pid}\n`, { flag: 'wx' })
    return
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  const holder = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10)
  if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) {
    throw new LockHeldError(`another watch (pid ${holder}) already holds ${file}`)
  }
  await writeFile(file, `${pid}\n`)
}

export async function releaseLock(file, pid) {
  const holder = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10)
  if (holder === pid) await unlink(file).catch(() => {})
}

export async function runWatch({ tick, emit, state, sleep, now, config, onAction = async () => {} }) {
  const history = { ...((await state.load()) ?? {}) }
  const intervalMs = config.intervalMinutes * 60 * 1000
  let failures = 0
  for (;;) {
    let snapshot
    try {
      snapshot = await tick()
      failures = 0
    } catch (err) {
      failures++
      emit({ event: 'watch-error', message: printable(err?.message ?? err) })
      if (failures >= MAX_TICK_FAILURES) { emit({ event: 'exit', reason: 'errors' }); return 1 }
      await sleep(intervalMs)
      continue
    }
    if (!snapshot.inFlight) { emit({ event: 'exit', reason: 'phase-idle' }); return 0 }
    const at = now()
    for (const row of snapshot.rows) {
      const decision = nextAction(row, history[row.taskId], config, at)
      history[row.taskId] = decision.history
      if (decision.action === 'none') continue
      const event = { event: decision.action, task: printable(row.taskId), at: new Date(at).toISOString() }
      if (decision.attempt) event.attempt = decision.attempt
      if (decision.reason) event.reason = decision.reason
      emit(event)
      await onAction(row.taskId, decision)
    }
    await state.save(history)
    await sleep(intervalMs)
  }
}
```

- [ ] **Step 3:** Run `node --test tests/watch-loop.test.mjs`; pass. Mutations: drop `failures = 0`, drop `printable`, skip `state.save`, ignore `isAlive`; each must fail a test. Restore.
- [ ] **Step 4:** Commit `feat(watch): heartbeat loop and single-instance lock`.

### Task 6: watch and rescue commands

**Files:**
- Modify: `scripts/cli.mjs`
- Create: `tests/watch-cli.test.mjs`
- Modify: `tests/cli.test.mjs`

**Depends:** T2, T3, T4, T5

**Model:** capable

- [ ] **Step 1:** Write `tests/watch-cli.test.mjs`, reusing the temp-repo setup pattern of the existing `liveness` tests in `tests/cli.test.mjs` (init-run on a two-task one-phase plan, task branches and worktrees created by hand, mtimes set with `utimes`, commit dates with `GIT_COMMITTER_DATE`). Cover, via `runCli`: `watch --once` on a run with one stalled and one working task prints exactly one JSON line `{"event":"resume","task":"T1","attempt":1,...}`, writes `.fleetmates/<run>/watch.json` with `T1.resumes === 1`, appends a `watchdog` event with `action: 'resume'` to T1's ledger, and returns 0; a second `--once` immediately after prints nothing for T1 (grace window); `watch --once` when every phase task has `state` `done` in `status.json` prints `{"event":"exit","reason":"phase-idle"}`; `watch` with a live pid in `watch.lock` exits 2 naming that pid; `watch` with `watch.enabled: false` in `fleetmates.local.json` prints `watchdog disabled by watch.enabled` and returns 0; `watch` on a missing run id returns 2. `rescue --run r --task T1` on a dirty worktree prints the patch path under `.fleetmates/r/rescue/`, the worktree is gone from `git worktree list`, and the patch applies; `rescue` on a task with no registered worktree returns 2 and touches nothing. Also pin `resolved.watch` defaults from `loadConfig` equal `WATCH_DEFAULTS` from `scripts/watch.mjs`. Watch them fail.
- [ ] **Step 2:** In `scripts/cli.mjs`, extract the signal gathering in the `liveness` branch (from the `derive` call through building `tips`/`touches`) into `async function currentPhaseSignals(root, runId, flags)` returning `{ problem, finished, phase, subject, tips, touches }` with the same error texts; make `liveness` call it with no behaviour change (its existing tests in `tests/cli.test.mjs` must stay green unchanged).
- [ ] **Step 3:** Register the commands: add `watch` and `rescue` to `USAGE` (`watch --run <id> --plan <path> [--once]`, `rescue --run <id> --task <t>`), `REQUIRED` (`watch: ['run', 'plan']`, `rescue: ['run', 'task']`) and `KNOWN_FLAGS` (`watch: ['run', 'plan', 'once']`, `rescue: ['run', 'task']`). Update the usage regex assertion in `tests/cli.test.mjs` (around the line matching `init-run\|gate\|doctor\|liveness`) to include the two names.
- [ ] **Step 4:** Implement `watch`: check the run dir exists (same message as `liveness`); `const { resolved } = await loadConfig(root)`; if `!resolved.watch.enabled` print the disabled line and return 0; acquire `.fleetmates/<run>/watch.lock` with `process.pid` and `isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }`, returning 2 with the `LockHeldError` message on conflict; build `tick` from `currentPhaseSignals` + `livenessRows` (staleMinutes from `resolved.watch`), where `inFlight` is false when `finished`, or when every `subject` task's `state` in `readState(root, runId, 'status')` is one of `done`, `blocked`, `orphaned`, and a `problem` throws an `Error(problem)`; `state` loads/saves `watch.json` via `readState`/`writeState`; `emit = (e) => io.out(JSON.stringify(e))`; `onAction` appends `{ kind: 'watchdog', at: Date.now(), action }` with `appendEvent(ledgerPath(root, runId, taskId), ...)`, swallowing ledger errors as a `watch-error` event; with `--once`, `sleep` throws a private sentinel that the command catches to return 0. Release the lock in a `finally`.
- [ ] **Step 5:** Implement `rescue`: find the worktree registered for `taskBranchName(runId, flags.task)` via `git.worktrees()`; none -> print `no worktree is registered for task <id>` and return 2; otherwise `rescueWorktree({ worktree, patchDir: path.join(runDir(root, runId), 'rescue'), taskId: flags.task, removeWorktree: (d) => git.removeWorktree(d) })`, print `rescued <id> to <patch>` or `<id> had no uncommitted work`, then `worktree removed: <path>`, return 0; any thrown error prints `rescue failed, worktree left in place: <message>` and returns 1. All ids printed through `printable`.
- [ ] **Step 6:** Run `node --test tests/watch-cli.test.mjs tests/cli.test.mjs` with a 600000 ms timeout; pass. Mutations: make `inFlight` always true, skip the lock, call `removeWorktree` on a missing branch; each must fail a test. Restore. Then `npm test` with a 600000 ms timeout.
- [ ] **Step 7:** Commit `feat(cli): watch and rescue commands`.

### Task 7: skills and changelog

**Files:**
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/fleet-supervision/SKILL.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/skills.test.mjs`

**Depends:** T6

- [ ] **Step 1:** Add tests to `tests/skills.test.mjs`: `parallel-execution` names `cli.mjs" watch --run` and `Monitor` inside section `## 2. Dispatch the phase`; `fleet-supervision` has a `## The watchdog` section naming each event `resume`, `respawn`, `orphan`, `unmeasured`, `watch-error`, `exit`, and the commands `rescue --run` and `dispatch` with `--task`; the old sentence "It reports; it does not act." is still present for `liveness` (the report itself is unchanged). Strip comments before counting, per the repo's source-text assertion rule. Watch them fail.
- [ ] **Step 2:** In `skills/parallel-execution/SKILL.md`, at the end of section 2, add: after dispatching a phase, unless `watch.enabled` is false, start `node "<fleetmates root>/scripts/cli.mjs" watch --run <id> --plan <path> --root <project root>` with `Monitor` so each stdout line is an event; it exits on its own when the phase has nothing in flight; at most one per run.
- [ ] **Step 3:** In `skills/fleet-supervision/SKILL.md` add `## The watchdog` after `## When a teammate stalls`, with this response table:

| Event | Orchestrator response |
|---|---|
| `resume` | `SendMessage` to that teammate (other harnesses: `cli.mjs message --task`) with exactly: "The fleet watchdog saw no commit and no file change for the stale window. If a command is running in the background, re-run it in the foreground with an explicit timeout of at least 600000 ms. Then reply with your current status." If the agent is gone, treat it as `respawn`. |
| `respawn` | `TaskStop` the teammate, run `cli.mjs rescue --run <id> --task <t>`, then `cli.mjs dispatch --run <id> --phase <n> --task <t>` (Claude Code: re-spawn `tm-implementer` for that task), telling the new teammate to run `git apply --index <patch>` first when rescue printed a patch. If rescue fails, treat it as `orphan`. |
| `orphan` | Mark the task `orphaned` in status, `PushNotification` the owner with the task id, take no further action on it. |
| `unmeasured` | `PushNotification` the owner with the task id and reason; take no action. |
| `watch-error` | Nothing; three in a row end the watchdog with `exit` reason `errors`. |
| `exit` | `phase-idle`: done. `errors`, or the Monitor stream ending with no `exit` event: restart `watch` once; `watch.json` keeps the ladder. |

Also state that watchdog events are supervision only and never gate evidence, and document the five `watch.*` config keys with defaults. Update the failure-handling table row "Silent past the heartbeat" to point at the watchdog.
- [ ] **Step 4:** Add an `## Unreleased` section at the top of `CHANGELOG.md` with one bullet: fleet watchdog (`cli.mjs watch`, `cli.mjs rescue`, `watch.*` config).
- [ ] **Step 5:** Run `node --test tests/skills.test.mjs` then `npm test`, both with a 600000 ms timeout; pass. Mutate one skill sentence the test pins, confirm failure, restore.
- [ ] **Step 6:** Commit `docs(skills): drive the fleet watchdog from parallel-execution and fleet-supervision`.
