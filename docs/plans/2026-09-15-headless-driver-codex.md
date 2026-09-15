# Headless driver and the Codex adapter — implementation plan

Spec: `docs/specs/2026-09-14-headless-driver-codex-design.md`. Sub-project 1 of 3. This plan
delivers the driver and the Codex adapter only; Gemini and OpenCode are later plans against the
adapter interface T5 fixes.

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies; zero dev dependencies (tests use `node:test`)
- Every `git` invocation passes `--end-of-options` before positional refs (existing rule)
- Commit messages: single-line summary, commitlint style, English
- No teammate ever runs unsandboxed by default; the driver never writes `done` from a teammate's word
- ESM only (`"type": "module"`); two-space indent; match surrounding style

## Destination

`node scripts/cli.mjs dispatch --run R --phase N --harness codex --root <repo>` runs a phase of a
written plan on Codex: each task in its own sandboxed clone, committed on `fleetmates/R/T`, fetched
into the run repo, enforcement-checked, and recorded — producing the same result shape the Workflow
path returns, so `gate`, `dispatch-integrator` and `finish` land the run unchanged. `npm test` is
green; `npm run test:e2e:codex` passes on a logged-in Codex and is skipped otherwise. The gate, not
the driver, decides landability.

## Not Yet Specified

- Does the clone layout hold on macOS (seatbelt) and Windows, where the sandbox mechanism and
  `.git` masking differ from Linux/bubblewrap?
- Should a task opt into the git-less `files` sandbox per-task (a plan `**Sandbox:**` line), or only
  run-wide through config?
- When a teammate's clone and the run repo diverge because the run branch advanced mid-phase, should
  `collect` rebase the task branch or leave the non-fast-forward for the gate's `merge` check?

## Out of Scope

- Gemini CLI and OpenCode adapters and packaging — each needs its own sandbox and git-resolution
  measurement; the clone layout is specific to Codex's bubblewrap sandbox.
- Mixed-harness fleets (different harnesses in one run) — the adapter boundary allows it later, but
  nothing here selects a harness per task.
- Moving the Claude Code path onto the driver — `Workflow`/`Agent` dispatch and `SubagentStop` stay.
- Codex in-session multi-agent tools (`spawn_agent`, `send_input`) — the driver owns coordination.
- `danger-full-access` as the default — it stays selectable (`sandbox = "full"`) but is never chosen
  automatically, because the clone layout removes the reason to.

### Task 1: extract RESULT_SCHEMA into one shared module

**Files:**
- Create: `scripts/result-schema.mjs`
- Modify: `templates/phase-workflow.js`
- Modify: `scripts/workflow-gen.mjs`
- Create: `tests/result-schema.test.mjs`
- Modify: `tests/workflow-gen.test.mjs`

- [ ] **Step 1:** Create `scripts/result-schema.mjs` exporting the schema the template currently
  inlines, so both dispatch paths validate against one definition:

  ```js
  // The teammate result contract. One definition so the Workflow template and the headless
  // driver validate identical shapes; the driver's adapter also hands this to codex via
  // --output-schema.
  export const RESULT_SCHEMA = {
    type: 'object',
    required: ['status', 'branch', 'filesChanged', 'summary', 'blockers'],
    properties: {
      status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
      branch: { type: 'string' },
      filesChanged: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      blockers: { type: 'array', items: { type: 'string' } },
    },
  }
  ```

- [ ] **Step 2:** In `templates/phase-workflow.js`, delete the inline `const RESULT_SCHEMA = {…}`
  block and replace it with the marker line `const RESULT_SCHEMA = __RESULT_SCHEMA__`. Leave the
  `schema: RESULT_SCHEMA` reference in the `agent(...)` options untouched. Update the file's top
  comment listing markers to include `RESULT_SCHEMA`.

- [ ] **Step 3:** In `scripts/workflow-gen.mjs`, import the schema
  (`import { RESULT_SCHEMA } from './result-schema.mjs'`), extend the marker regex to
  `const MARKER = /__(?:META|TASKS|BRIEFS|EFFORT|RESULT_SCHEMA)__/g`, and add to the `substitutions`
  object `__RESULT_SCHEMA__: () => JSON.stringify(RESULT_SCHEMA, null, 2)`.

- [ ] **Step 4:** Create `tests/result-schema.test.mjs`: assert the module exports an object whose
  `required` array is exactly `['status','branch','filesChanged','summary','blockers']` and whose
  `status` enum is exactly `['done','blocked','failed']`.

- [ ] **Step 5:** In `tests/workflow-gen.test.mjs`, add a case: the generated source contains
  `const RESULT_SCHEMA = {` followed by `"status"` and `"branch"`, and contains no literal
  `__RESULT_SCHEMA__` marker. Run `npm test` and confirm the workflow-gen suite is green.

### Task 2: validate `harnesses.codex.*` config

**Files:**
- Modify: `scripts/config.mjs`
- Modify: `tests/config.test.mjs`

- [ ] **Step 1:** In `scripts/config.mjs`, after the `EFFORTS` export, add:

  ```js
  export const SANDBOXES = ['clone', 'files', 'full']
  export const KNOWN_HARNESSES = ['codex']
  ```

- [ ] **Step 2:** Add a `validateHarnesses` function that both layers call. It is not an
  enforcement key — nothing in it changes a gate verdict — so it is permitted in both
  `fleetmates.local.json` and `fleetmates.gate.json`:

  ```js
  export function validateHarnesses(harnesses, file) {
    if (harnesses === null || typeof harnesses !== 'object' || Array.isArray(harnesses)) {
      throw new ConfigError('harnesses must be an object keyed by harness name')
    }
    for (const [name, entry] of Object.entries(harnesses)) {
      if (!KNOWN_HARNESSES.includes(name)) {
        throw new ConfigError(`unknown harness in ${file}: harnesses.${name}`)
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ConfigError(`harnesses.${name} must be an object`)
      }
      for (const field of Object.keys(entry)) {
        if (!['sandbox', 'network', 'timeoutMinutes', 'tierModels'].includes(field)) {
          throw new ConfigError(`unknown key in ${file}: harnesses.${name}.${field}`)
        }
      }
      if (entry.sandbox !== undefined && !SANDBOXES.includes(entry.sandbox)) {
        throw new ConfigError(`harnesses.${name}.sandbox must be one of ${SANDBOXES.join(', ')}`)
      }
      if (entry.network !== undefined && typeof entry.network !== 'boolean') {
        throw new ConfigError(`harnesses.${name}.network must be a boolean`)
      }
      if (entry.timeoutMinutes !== undefined
        && (!Number.isInteger(entry.timeoutMinutes) || entry.timeoutMinutes < 1)) {
        throw new ConfigError(`harnesses.${name}.timeoutMinutes must be an integer >= 1`)
      }
      if (entry.tierModels !== undefined
        && (entry.tierModels === null || typeof entry.tierModels !== 'object'
          || Array.isArray(entry.tierModels))) {
        throw new ConfigError(`harnesses.${name}.tierModels must be an object`)
      }
    }
  }
  ```

- [ ] **Step 3:** In `validateLocal`, add `'harnesses'` to the allowed top-level key list (the array
  currently `['maxParallel', 'caveman', 'agents']`) and, after the `agents` block, add
  `if (local.harnesses !== undefined) validateHarnesses(local.harnesses, LOCAL_FILE)`.

- [ ] **Step 4:** In `validateGate`, after the `agents` block, add
  `if (gate.harnesses !== undefined) validateHarnesses(gate.harnesses, GATE_FILE)`. Do not add
  `harnesses` to `ENFORCEMENT_KEYS`.

- [ ] **Step 5:** In `loadConfig`, after assembling `agents`, merge harness config across layers the
  same way (gate first, local overriding): build `harnesses` where for each name present in either
  layer, `{ ...gate.harnesses?.[name], ...local?.harnesses?.[name] }`, and include it in the
  returned config object.

- [ ] **Step 6:** In `assertSafeKey`'s dotted-key path used by `config set` (the `agentMatch` regex
  region), add a parallel `harnessMatch = /^harnesses\.([a-z]+)\.(sandbox|network|timeoutMinutes)$/`
  so `config set harnesses.codex.sandbox clone` routes to `validateHarnesses` on a single-field
  object. Reuse the existing per-field validation by constructing `{ [field]: value }` and calling
  `validateHarnesses({ [name]: obj }, LOCAL_FILE)`.

- [ ] **Step 7:** In `tests/config.test.mjs`, add cases: a valid `harnesses.codex` object with each
  field passes `validateLocal` and `validateGate`; `sandbox: "bogus"` throws naming
  `clone, files, full`; an unknown harness name throws; an unknown field throws; `timeoutMinutes: 0`
  throws; `config set harnesses.codex.sandbox files` succeeds and `... full` succeeds and `... x`
  fails. Run `npm test` for the config suite.

### Task 3: hardened local fetch and a git-common-dir writability preflight

**Files:**
- Modify: `scripts/git.mjs`
- Modify: `tests/git.test.mjs`

- [ ] **Step 1:** In `scripts/git.mjs`, add a hardened fetch helper. It is the only host-side git
  that ever touches a teammate git dir, so it neutralises planted config (measured safe, but belt
  and suspenders per spec §7):

  ```js
  // Fetch one branch from a teammate's git dir into this repo. Runs with hooks, fsmonitor and
  // optional locks disabled and a null hooksPath so a config the teammate planted in <fromGitDir>
  // cannot execute on the host. Fast-forward only: a non-ff means the run branch advanced under
  // the task and the gate's merge check must judge it, not a silent reset.
  export async function fetchTaskBranch(git, { fromGitDir, branch }) {
    return git([
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      'fetch', '--no-tags', '--no-write-fetch-head',
      '--end-of-options', fromGitDir,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ], { env: { GIT_OPTIONAL_LOCKS: '0' } })
  }
  ```

  If `createGit`/`defaultGitExec` does not currently forward an `env` option, thread a
  `{ env }` fourth argument through `defaultGitExec` (`spawn('git', args, { cwd, env: { ...process.env, ...env } })`)
  and through `createGit`; leave every existing call site unchanged (they pass no `env`).

- [ ] **Step 2:** Add a functional writability preflight for the orchestrator's own repo. It writes
  and removes a temp file under the git common dir, so it detects a sandboxed shell by behaviour,
  not by reading an environment variable:

  ```js
  import { mkdtemp, rm } from 'node:fs/promises'
  import path from 'node:path'

  // Returns { ok: true } if this process can write the repo's git dir, else { ok: false, dir, code }.
  // Used by every CLI command that writes git, so a sandboxed orchestrator fails fast with a fixable
  // message instead of deep inside a worktree add.
  export async function gitDirWritable(git, root) {
    const common = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }))
      .stdout.trim()
    try {
      const probe = await mkdtemp(path.join(common, '.fm-writable-'))
      await rm(probe, { recursive: true, force: true })
      return { ok: true, dir: common }
    } catch (err) {
      return { ok: false, dir: common, code: err.code || 'EACCES' }
    }
  }
  ```

- [ ] **Step 3:** In `tests/git.test.mjs`, add: `fetchTaskBranch` builds an argv containing
  `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `--no-tags`, the git dir and the
  `refs/heads/<b>:refs/heads/<b>` refspec, and passes `GIT_OPTIONAL_LOCKS=0` in env (assert against a
  fake `git` exec that records its args and env). Add an end-to-end leg on a real temp repo: create a
  second repo with a commit on a branch, `fetchTaskBranch` brings that branch in.

- [ ] **Step 4:** In `tests/git.test.mjs`, add: `gitDirWritable` returns `{ ok: true }` on a normal
  temp repo, and `{ ok: false }` with a code when the common dir is made unwritable (`chmod 0500`;
  skip the negative leg when running as root, where the mode is ignored). Run `npm test` for the git
  suite.

### Task 4: the brief renders the CLI as an absolute path

**Files:**
- Modify: `scripts/brief.mjs`
- Modify: `tests/brief.test.mjs`

- [ ] **Step 1:** In `scripts/brief.mjs`, resolve the CLI path once from this module's own location
  rather than emitting a literal `$CLAUDE_PLUGIN_ROOT`, so a teammate on any harness (whose shell may
  not export that variable) gets a path that works:

  ```js
  import { fileURLToPath } from 'node:url'
  import path from 'node:path'

  // scripts/brief.mjs -> scripts/ -> <fleetmates root>/scripts/cli.mjs
  const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs')
  ```

- [ ] **Step 2:** Replace every `'    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" <sub> …'` line the
  brief composes (the `locate` line near the top and the `complete` line near the bottom) with a form
  that interpolates `CLI_PATH`, e.g. ``` `    node ${JSON.stringify(CLI_PATH)} locate --run ${runId} --task ${task.id}` ```.
  Keep the surrounding brief text identical.

- [ ] **Step 3:** In `tests/brief.test.mjs`, change the assertions that pin
  `$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs` to assert the brief contains an absolute path ending in
  `/scripts/cli.mjs` (matching `/node "?\/.*\/scripts\/cli\.mjs/`) and that it no longer contains the
  literal string `$CLAUDE_PLUGIN_ROOT`. Run `npm test` for the brief suite.

### Task 5: the Codex adapter and the harness registry

**Files:**
- Create: `scripts/harnesses/codex.mjs`
- Create: `scripts/harnesses/index.mjs`
- Create: `tests/harness-codex.test.mjs`

**Depends:** T1, T3

- [ ] **Step 1:** Create `scripts/harnesses/index.mjs` mapping a `--harness` name to its adapter and
  refusing an unknown one:

  ```js
  import { codexAdapter } from './codex.mjs'

  const ADAPTERS = { codex: codexAdapter }

  export function getAdapter(name) {
    const adapter = ADAPTERS[name]
    if (!adapter) {
      throw new Error(`unknown harness: ${name} (known: ${Object.keys(ADAPTERS).join(', ')})`)
    }
    return adapter
  }

  export const HARNESS_NAMES = Object.keys(ADAPTERS)
  ```

- [ ] **Step 2:** Create `scripts/harnesses/codex.mjs`. Import the schema and git helpers; write the
  spawn/resume argv builders exactly to spec §5, with `--disable hooks` mandatory, `GIT_DIR` only in
  the agent shell, and the clone carrying no `.git` pointer:

  ```js
  import { spawn } from 'node:child_process'
  import { writeFile, rm, mkdir } from 'node:fs/promises'
  import { createInterface } from 'node:readline'
  import { createReadStream } from 'node:fs'
  import path from 'node:path'
  import { RESULT_SCHEMA } from '../result-schema.mjs'
  import { fetchTaskBranch } from '../git.mjs'

  const SANDBOX_FLAG = { clone: 'workspace-write', files: 'workspace-write', full: 'danger-full-access' }

  function baseArgs({ sandbox, model, effort, network }) {
    const args = ['--json', '--disable', 'hooks', '--skip-git-repo-check',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true']
    if (network) args.push('-c', 'sandbox_workspace_write.network_access=true')
    if (model) args.push('-m', model)
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`)
    return args
  }

  // A codex process, prompt fed on stdin then closed (an open inherited stdin hangs codex exec
  // forever, measured). sessionId resolves from the first thread.started line of the stream.
  function run(argv, { promptText, streamPath, errPath }) {
    const child = spawn('codex', argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = createWriteStreamSync(streamPath)
    const err = createWriteStreamSync(errPath)
    child.stdout.pipe(out)
    child.stderr.pipe(err)
    child.stdin.end(promptText)               // close stdin: never leave it open
    const sessionId = firstThreadId(child.stdout)
    return { child, sessionId }
  }
  ```

  Implement `firstThreadId(stream)` as a promise that tees the stdout, scans lines for
  `{"type":"thread.started","thread_id":"…"}`, resolves with the id (or `null` on close without
  one). Implement `createWriteStreamSync` with `node:fs` `createWriteStream`. Keep the stream file
  the single source for both the session id and `readUsage`.

- [ ] **Step 3:** Implement `makeSandbox` for the three modes. `clone` builds the measured-safe
  layout — a `--shared` clone with a separate git dir and **no `.git` pointer**:

  ```js
  export async function makeCodexSandbox(git, { runRepo, runBranch, runId, taskId, mode }) {
    const base = path.join(runRepo, '.fleetmates', runId)
    if (mode === 'files') {
      const cwd = path.join(base, 'files', taskId)
      await mkdir(cwd, { recursive: true })
      await git(['--work-tree', cwd, 'checkout', runBranch, '--', '.'], { cwd: runRepo }) // seed the tree
      return { cwd, meta: { mode, branch: `fleetmates/${runId}/${taskId}` } }
    }
    const gitdir = path.join(base, 'gitdirs', taskId)
    const cwd = path.join(base, 'clones', taskId)
    await git(['clone', '--shared', `--separate-git-dir=${gitdir}`,
      '--end-of-options', runRepo, cwd])
    await git(['checkout', '-b', `fleetmates/${runId}/${taskId}`, `origin/${runBranch}`], { cwd })
      .catch(() => git(['checkout', '-b', `fleetmates/${runId}/${taskId}`], { cwd }))
    if (mode === 'clone') await rm(path.join(cwd, '.git'), { force: true }) // no pointer: keep harness git off the teammate config
    return { cwd, meta: { mode, gitdir, branch: `fleetmates/${runId}/${taskId}` } }
  }
  ```

- [ ] **Step 4:** Implement `spawn` and `resume` as thin wrappers building the argv per §5. `spawn`
  adds `-s <flag>`, `-C <cwd>`, `--add-dir <gitdir>`, `--output-schema`, `-o`, and — for `clone`
  mode — `-c shell_environment_policy.set={GIT_DIR="…",GIT_WORK_TREE="…"}`. `resume` builds
  `['exec','resume',sessionId,...]`, reconstructs the sandbox through
  `-c sandbox_mode="workspace-write"`, `-c sandbox_workspace_write.writable_roots=["<gitdir>"]`, and
  the same `shell_environment_policy.set`, and runs with cwd set to the clone (resume takes no `-C`).
  For `full` mode omit the `shell_environment_policy.set` and `--add-dir`. Write `RESULT_SCHEMA` to
  `schemaPath` once (`await writeFile(schemaPath, JSON.stringify(RESULT_SCHEMA))`) before the first
  spawn.

- [ ] **Step 5:** Implement `collect`, `readResult`, `readUsage`, `probe`, `cleanup`:

  ```js
  export async function collectCodex(git, { runRepo, sandbox, branch }) {
    if (sandbox.meta.mode === 'files') return             // driver commits the diff itself; nothing to fetch
    await fetchTaskBranch((a, o) => git(a, { ...o, cwd: runRepo }),
      { fromGitDir: sandbox.meta.gitdir, branch })
  }
  ```

  `readResult({ resultPath })`: read and `JSON.parse` the `-o` file; on ENOENT or parse error return
  `null`. `readUsage({ streamPath })`: sum `turn.completed.usage` fields across the stream, returning
  `{ input, cachedInput, cacheWrite, output, reasoning }` or `null`. `probe({ env })`: run
  `codex login status`; `{ ok: false, reason, fix: 'run: codex login' }` if it says `Not logged in`,
  and check `CODEX_HOME` (or `~/.codex`) is writable. `cleanup({ sandbox })`: `rm -rf` the clone and
  git dir (or the files dir).

- [ ] **Step 6:** Export the adapter object binding these:
  `export const codexAdapter = { name: 'codex', probe, makeSandbox: makeCodexSandbox, collect: collectCodex, cleanup, spawn, resume, readResult, readUsage, sandboxFlag: SANDBOX_FLAG }`.

- [ ] **Step 7:** Create `tests/harness-codex.test.mjs` with a fake `codex` on `PATH` (a Node script
  written to a temp dir, prepended to `PATH`) that: emits a `thread.started` line then a
  `turn.completed` line with a usage object, writes the `-o` result file, and **blocks if stdin is
  still open** (reads stdin to end; the test asserts the process does not hang because the adapter
  closes stdin). Cases: `spawn` resolves the session id from the stream; `readResult` parses the
  file and returns `null` when absent; `readUsage` sums two `turn.completed` usages; the built spawn
  argv contains `--disable`, `hooks`, `-s`, `workspace-write`, `--add-dir`, and (clone mode) a
  `shell_environment_policy.set` with `GIT_DIR`; the built resume argv contains `exec`, `resume`, the
  session id, `sandbox_mode`, and `writable_roots`; `makeCodexSandbox` in `clone` mode leaves no
  `.git` under the clone and a populated git dir; `probe` returns `ok:false` with the `codex login`
  fix when the fake reports `Not logged in`. Run `npm test` for this suite.

### Task 6: the driver loop

**Files:**
- Create: `scripts/driver.mjs`
- Create: `tests/driver.test.mjs`

**Depends:** T5, T2

- [ ] **Step 1:** Create `scripts/driver.mjs` exporting `dispatchPhase`. It owns the whole
  control flow so the adapter stays declarative. Signature:

  ```js
  // Runs one phase's implementer tasks on a harness, at most maxParallel at once. Returns
  // { results, orphaned } in the shape the Workflow path returns. Never writes `done` itself:
  // a returned status is the teammate's claim; the gate decides.
  export async function dispatchPhase({
    adapter, git, runRepo, runId, runBranch, phaseTasks,
    maxParallel, sandboxMode, network, timeoutMinutes, tierModels, effortFor,
    composeBriefFor, personaFor, runDir, completeEnforcement,
  }) { /* … */ }
  ```

  where `completeEnforcement(taskId)` runs `complete --enforcement-only` in the run repo and returns
  its exit code, and `composeBriefFor`/`personaFor`/`effortFor` are injected so the driver need not
  import the CLI.

- [ ] **Step 2:** Implement per-task flow with a concurrency pool bounded by `maxParallel`:

  ```
  for each task, acquiring a pool slot:
    if sessions/T.json has a valid result → skip (idempotent resume of a run)
    if sessions/T.json has a sessionId and no result → resumePath = true
    sandbox = adapter.makeSandbox(...)  (skipped if resuming and its record still has the sandbox)
    prompt = personaFor(role) + '\n\n' + composeBriefFor(task)
    handle = resumePath ? adapter.resume(...) : adapter.spawn(...)
    record sessionId to sessions/T.json as soon as handle.sessionId resolves
    await exit or timeout (SIGTERM the process group, 10s, SIGKILL) → on timeout: orphaned('timeout')
    result = adapter.readResult(...); if null → orphaned(stderr tail)
    adapter.collect(...)          // fetch the task branch into the run repo
    code = completeEnforcement(task.id)
      if code === 3 and not already resumed for enforcement:
        adapter.resume(sessionId, FIXED_REFUSAL); await exit; adapter.collect(...); code = completeEnforcement(...)
        if still 3 → failed('enforcement')
      else record
    write { result, usage: adapter.readUsage(...), exitReason } to sessions/T.json
  ```

  Use the same `FIXED_REFUSAL` text `subagent-stop.mjs` sends today (import it or copy the constant;
  if copied, add a test asserting the two strings are identical).

- [ ] **Step 3:** Hold a `.fleetmates/R/driver.lock` containing the driver pid; refuse a second
  concurrent `dispatch*` on the same run with exit 1, but take over a lock whose pid is no longer
  alive (`process.kill(pid, 0)` throws ESRCH) so a killed driver never blocks a resume.

- [ ] **Step 4:** Create `tests/driver.test.mjs` driving `dispatchPhase` with a stub adapter (plain
  JS object, no real codex) whose `spawn`/`resume` resolve immediately and whose `readResult` and
  `completeEnforcement` are scripted per case. Cases: one task spawns → done and recorded; enforcement
  returns 3 then 0 → one resume, recorded done; enforcement returns 3 twice → `failed('enforcement')`;
  `readResult` null → `orphaned`; timeout → `orphaned('timeout')` and sessionId still recorded;
  re-running `dispatchPhase` with a valid recorded result skips that task and resumes one with a
  session and no result; a live `driver.lock` with this pid refuses a second call, a stale pid is
  taken over. Run `npm test` for the driver suite.

### Task 7: CLI commands, preflight, and usage from sessions

**Files:**
- Modify: `scripts/cli.mjs`
- Modify: `tests/cli.test.mjs`

**Depends:** T6, T3, T2

- [ ] **Step 1:** Register five commands in `USAGE`, the arg-spec table (the object near line 213
  keyed by command), and the allowed-flags table (near line 267): `dispatch`, `dispatch-reviews`,
  `dispatch-integrator` each taking `run, phase, harness, plan, base, models`; `message` taking
  `run, task, harness, text`; `sessions` taking `run`. Add `dispatch`, `dispatch-reviews`,
  `dispatch-integrator`, `finish`, `prune-run`, `init-run`, `gate` to a new
  `GIT_WRITING_COMMANDS` set used by the preflight in Step 2.

- [ ] **Step 2:** At the top of the command handler, for any command in `GIT_WRITING_COMMANDS`, call
  `gitDirWritable(git, root)` (from `scripts/git.mjs`). On `{ ok: false }` print to stderr and exit 2:

  ```
  cannot write to <dir>: this shell is sandboxed.
    Start the harness with full access (codex: --sandbox danger-full-access),
    or re-run this one command with sandbox escalation.
  ```

- [ ] **Step 3:** Implement the `dispatch` handler: resolve the run's plan and run branch from
  `.fleetmates/<run>/plan.json`, load config, resolve the harness adapter via
  `getAdapter(flags.harness)` (default `codex`), run `adapter.probe(...)` and exit 2 with its `fix`
  on failure, then call `dispatchPhase(...)` passing `composeBriefFor`/`personaFor` closures built
  from the existing `composeBrief` and the `tm-<role>.md` body, and `completeEnforcement` a closure
  that runs the existing `complete --enforcement-only` code path in `root`. Append each result to
  `status.json` exactly as the Workflow path's post-processing does, and print the phase breakdown.

- [ ] **Step 4:** Implement `dispatch-reviews` (run one `tm-reviewer` per lens from the existing
  `review-dispatch` output, cwd at the project root, in parallel; write nothing — `collect-reviews`
  is unchanged) and `dispatch-integrator` (run `tm-integrator` alone at the project root; refuse with
  exit 4 unless the phase has a recorded PASS). Both go through the same adapter, reusing
  `dispatchPhase`'s spawn/collect primitives with a single task and the reviewer/integrator persona.

- [ ] **Step 5:** Implement `message` (SIGTERM the task's live process group if any, then
  `adapter.resume(sessionId, flags.text)`) and `sessions` (print one row per task from
  `.fleetmates/<run>/sessions/*.json`: harness, session id, state, elapsed, tokens).

- [ ] **Step 6:** In the existing `usage` handler, when `.fleetmates/<run>/sessions/*.json` exist,
  read token totals from them (`readUsage` output already stored per task); otherwise keep reading
  the Claude Code transcript store. Do not remove the transcript path.

- [ ] **Step 7:** In `tests/cli.test.mjs`, add cases: `dispatch --harness bogus` exits naming known
  harnesses; every `GIT_WRITING_COMMANDS` command exits 2 with the sandbox message when the common
  dir is unwritable (chmod 0500; skip as root) and none created anything; `dispatch-integrator`
  refuses with exit 4 without a recorded PASS; `sessions` renders recorded rows; `usage` reads the
  sessions store when present. Use a stub harness registered for the test, or a fake `codex` on
  `PATH` as in T5. Run `npm test` for the cli suite.

### Task 8: skills invoke the CLI by `<fleetmates root>` and carry harness branches

**Files:**
- Modify: `skills/using-fleetmates/SKILL.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/fleet-lifecycle/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `skills/fleetmates-config/SKILL.md`
- Modify: `skills/executing-plans/SKILL.md`
- Modify: `skills/finishing-a-development-branch/SKILL.md`
- Modify: `skills/fleet-supervision/SKILL.md`
- Modify: `skills/writing-plans/SKILL.md`
- Modify: `skills/writing-skills/SKILL.md`
- Modify: `agents/tm-implementer.md`
- Modify: `tests/skill-contracts.test.mjs`
- Modify: `tests/md-contract.test.mjs`

**Depends:** T7

- [ ] **Step 1:** In `skills/using-fleetmates/SKILL.md`, in the "Invoking the CLI" section, define
  `<fleetmates root>` once: it is `$CLAUDE_PLUGIN_ROOT` when that variable is set (Claude Code),
  otherwise the directory two levels above the skill's own `SKILL.md`
  (`dirname(dirname(<this skill's dir>))`). State that every CLI call in every skill uses
  `node "<fleetmates root>/scripts/cli.mjs" <subcommand> --root <project root>`.

- [ ] **Step 2:** Replace every literal `"$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs"` across the ten skill
  files and `agents/tm-implementer.md` with `"<fleetmates root>/scripts/cli.mjs"`. Keep every
  surrounding word identical so the contract tests only see the path token change.

- [ ] **Step 3:** In `skills/parallel-execution/SKILL.md`, add a subsection "On a harness other than
  Claude Code" under the dispatch section: when the orchestrator is not Claude Code, dispatch a phase
  with `node "<fleetmates root>/scripts/cli.mjs" dispatch --run <id> --phase <n> --harness <name>
  --root <project root>` instead of the `Workflow`/`Agent` path; it is worktree-isolated,
  gate-identical, and resuming a run re-runs the same `dispatch`. State the harness name is the one
  the orchestrator is running in, passed explicitly.

- [ ] **Step 4:** In `skills/fleet-lifecycle/SKILL.md`, map the operations for the non-Claude path:
  `message <name>` becomes `cli.mjs message --run <id> --task <t> --harness <h> --text <s>`;
  resuming becomes re-running `dispatch`; `sessions` replaces the agent panel. In
  `skills/phase-gate/SKILL.md`, map the reviewer dispatch to
  `cli.mjs dispatch-reviews --run <id> --phase <name> --harness <h>` and the integrator step to
  `cli.mjs dispatch-integrator --run <id> --phase <name> --harness <h>`.

- [ ] **Step 5:** In `skills/fleetmates-config/SKILL.md`, document `harnesses.codex.sandbox`
  (`clone` default, `files`, `full`), `harnesses.codex.network`, `harnesses.codex.timeoutMinutes`,
  and `harnesses.codex.tierModels`, set via `config set harnesses.codex.<field> <value>`. Note that
  where `AskUserQuestion` does not exist the skill offers choices as a numbered list.

- [ ] **Step 6:** Update `tests/skill-contracts.test.mjs` and `tests/md-contract.test.mjs`: change
  any assertion pinning `$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs` to accept `<fleetmates root>/scripts/cli.mjs`,
  and add an assertion that `using-fleetmates` defines `<fleetmates root>` in terms of both
  `$CLAUDE_PLUGIN_ROOT` and the skill directory. Run `npm test` for the skill suites.

### Task 9: README and changelog for the Codex path

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Depends:** T7

- [ ] **Step 1:** In `README.md`, add a "Running on Codex" section: `codex plugin marketplace add
  andreymudri/fleetmates`, `codex plugin add fleetmates@fleetmates`, `codex login`, and trusting the
  hooks in `/hooks` (without trust, `using-fleetmates` activates only by its description). State that
  the package installs unchanged from the same `.claude-plugin/marketplace.json`.

- [ ] **Step 2:** In the same section, state the sandbox model from spec §7: teammates run sandboxed
  in an isolated clone (`harnesses.codex.sandbox = "clone"`, the default); a git-less `files`
  fallback and `full` (`danger-full-access`) are selectable; the orchestrator itself needs full
  access and will exit with a fixable message if run in a sandbox. Note network is off by default.

- [ ] **Step 3:** Add a `## Unreleased` entry to `CHANGELOG.md` describing the headless driver and
  the Codex adapter, listing the new commands (`dispatch`, `dispatch-reviews`, `dispatch-integrator`,
  `message`, `sessions`) and the `harnesses.codex.*` config. Single-line summary style consistent
  with existing entries.

### Task 10: end-to-end and security-regression tests on real Codex

**Files:**
- Create: `tests/e2e-codex.test.mjs`
- Modify: `package.json`
- Modify: `tests/npm-scripts.test.mjs`

**Depends:** T7

- [ ] **Step 1:** In `package.json` scripts, add
  `"test:e2e:codex": "node --test tests/e2e-codex.test.mjs"`. Leave the default `test` script (which
  globs `tests/*.test.mjs`) — since `e2e-codex.test.mjs` matches that glob, guard every test in it
  with a skip when Codex is unavailable (Step 2) so `npm test` stays green offline.

- [ ] **Step 2:** Create `tests/e2e-codex.test.mjs`. At the top, a `codexReady()` helper runs
  `codex login status` and checks the binary exists; every test uses `{ skip: !codexReady() }`. Build
  a scratch git repo in a temp dir for each test.

- [ ] **Step 3:** Security-regression cases, each with a canary file written to a path outside every
  writable root and a positive control proving the canary fires:
  1. clone layout — plant `filter.fm.clean` + `info/attributes` in the task git dir, run a
     no-command turn, assert the canary did **not** fire; then a host `git status` in the clone
     (positive control) **does** fire it;
  2. the agent cannot create `<clone>/.git` (a turn that tries `printf > .git` and `mkdir .git`, both
     denied; `.git` absent afterward);
  3. `--disable hooks` — a project `.codex/hooks.json` `SessionStart` hook does **not** run; with
     hooks enabled (control) it does;
  4. `resume` — after a spawn, a resume whose command writes outside the roots is denied and a second
     commit still lands on the branch;
  5. host `fetchTaskBranch` from a git dir carrying a planted `uploadpack.packObjectsHook` does
     **not** fire it, with real new commits to transfer.

- [ ] **Step 4:** One full-run case: a three-task plan in the scratch repo through `init-run`,
  `dispatch --harness codex`, `gate`, `dispatch-integrator`, asserting the run branch holds all three
  task merges and `git log` shows the expected commits. Also assert (spec §7 open item) that the
  harness's per-turn git status resolved to the run repo — a `filter.fm.clean` planted in the task
  git dir did not fire during the whole run.

- [ ] **Step 5:** In `tests/npm-scripts.test.mjs`, assert `package.json` has a `test:e2e:codex`
  script pointing at `tests/e2e-codex.test.mjs`. Run `npm test` and confirm green (the e2e cases skip
  without Codex).
