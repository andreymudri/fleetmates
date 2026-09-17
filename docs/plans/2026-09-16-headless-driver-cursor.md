# Headless driver — Cursor adapter — implementation plan

Spec: `docs/specs/2026-09-16-headless-driver-cursor-design.md`. Implements the adapter interface of
`docs/specs/2026-09-14-headless-driver-codex-design.md` for `cursor-agent`, plus the shared
git-less sandbox that also fixes Codex's `files` mode.

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies; zero dev dependencies (tests use `node:test`)
- Every `git` invocation passes `--end-of-options` before positional refs where refs are positional
- Commit messages: single-line summary, commitlint style, English, no co-author or tool attribution trailers
- No Cursor argv ever contains `--force`, `--yolo`, `--approve-mcps`, `--sandbox disabled`, `--worktree`, `--api-key`
- No git command ever runs with a `files` checkout as cwd, work tree or git dir
- ESM only (`"type": "module"`); two-space indent; no semicolons; match surrounding style
- `npm test` green after every task

## Destination

`node scripts/cli.mjs dispatch --run R --phase N --harness cursor --root <repo>` runs a phase on
Cursor: each task in a scrubbed git-less checkout, committed by the host on `fleetmates/R/T`,
enforcement-checked and recorded in the same result shape as Codex, so `gate`,
`dispatch-integrator` and `finish` land it unchanged. A Codex `files`-mode task lands its edits on
its branch. `npm test` is green; `npm run test:e2e:cursor` passes on a logged-in Cursor and skips
otherwise.

## Not Yet Specified

- Does Cursor's sandbox hold the same way on macOS (seatbelt), where §1 of the spec was not measured?
- Should a teammate that legitimately needs to change `.claude/settings.json` get an escape hatch on the Cursor path?

## Out of Scope

- Running the orchestrator inside Cursor — Cursor is a teammate backend here; plugin packaging for Cursor is its own project.
- Multi-commit history from Cursor teammates — the git-less layout is what closes the unsandboxed-git vector.
- Gemini CLI and OpenCode adapters — each needs its own sandbox measurement.

### Task 1: result validator for adapters without schema-enforced output

**Files:**
- Modify: `scripts/result-schema.mjs`
- Test: `tests/result-schema.test.mjs`

- [ ] **Step 1:** Add failing tests: `validateResult` returns `true` for a well-formed result and
  `false` for: non-object, array, missing each required key, wrong type per key, `status` outside
  the enum, a non-string entry in `filesChanged`/`blockers`, and an extra key.
- [ ] **Step 2:** Append to `scripts/result-schema.mjs`:

  ```js
  // A hand-rolled check of RESULT_SCHEMA for harnesses with no schema-enforced output (Cursor).
  // Kept next to the schema so the two cannot drift; covers exactly the keywords RESULT_SCHEMA uses.
  export function validateResult(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const props = RESULT_SCHEMA.properties
    for (const key of Object.keys(value)) if (!(key in props)) return false
    for (const key of RESULT_SCHEMA.required) if (!(key in value)) return false
    for (const [key, spec] of Object.entries(props)) {
      if (!(key in value)) continue
      const v = value[key]
      if (spec.type === 'string') {
        if (typeof v !== 'string') return false
        if (spec.enum && !spec.enum.includes(v)) return false
      } else if (spec.type === 'array') {
        if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) return false
      }
    }
    return true
  }
  ```
- [ ] **Step 3:** `npm test` green; commit `feat(result-schema): validateResult for unenforced harness output`.

### Task 2: shared git-less sandbox, control-path scrub and hardened commit

**Files:**
- Create: `scripts/harnesses/files-sandbox.mjs`
- Test: `tests/files-sandbox.test.mjs`

- [ ] **Step 1:** Write failing tests in real temp repos (`git init`, one commit on `main`):
  - `makeFilesSandbox` checks out `runBranch`'s tree with no `.git`, leaves run repo index and HEAD untouched, and two concurrent builds both resolve.
  - `scrubControlPaths` removes every `CONTROL_PATHS` entry (files, the `.cursor/hooks/` and `.vscode/` dirs, a symlinked entry without touching its target) and returns the found relative paths sorted.
  - `commitFilesTree`: an edit, an added file, a deleted file and a `chmod +x` all land on `fleetmates/r1/T1` as one commit whose parent is `runBranch`.
  - Unchanged checkout → no new commit; the task branch equals `runBranch`.
  - A symlink `leak -> /etc/hostname` commits as mode `120000` with blob content `/etc/hostname`.
  - Run repo config defines `filter.x.clean = "touch <marker>"`; checkout contains `.gitattributes` `* filter=x` and an edited file → after commit the marker does not exist (positive control: `git -C runRepo add` of the same file in a scratch worktree does create it).
  - `runBranch` holds `.claude/settings.json`; the checkout lacks it and has a planted `.cursor/sandbox.json` → the task commit still has `.claude/settings.json` identical to `runBranch` and no `.cursor/sandbox.json`.
  - Run repo index, HEAD and `git status --porcelain` identical before and after.
- [ ] **Step 2:** Implement `scripts/harnesses/files-sandbox.mjs` exporting:
  - `CONTROL_PATHS = ['.cursor/sandbox.json', '.cursor/hooks.json', '.cursor/hooks', '.cursor/cli.json', '.cursor/mcp.json', '.cursor/worktrees.json', '.claude/settings.json', '.claude/settings.local.json', '.vscode']`
  - `isControlPath(rel)` — true when `rel` equals an entry or lies under a directory entry.
  - `makeFilesSandbox(git, { runRepo, runBranch, runId, taskId })` — the body of `makeCodexSandbox`'s `files` branch moved verbatim, returning `{ cwd, meta: { mode: 'files', branch } }`.
  - `scrubControlPaths(cwd)` — for each entry, `lstat`; if present `rm({ recursive: true, force: true })` and record it; returns the sorted list.
  - `commitFilesTree(git, { runRepo, runBranch, sandbox, branch })`:
    1. `idx = await mkdtemp(path.join(os.tmpdir(), 'fm-files-idx-'))`, index file `idx/index`; `env = { GIT_INDEX_FILE }`; every call `git(['-c', 'core.hooksPath=/dev/null', ...args], { cwd: runRepo, env })`.
    2. `read-tree --end-of-options <runBranch>`; list with `ls-files -z`; `update-index --force-remove -z --stdin` for every non-control path.
    3. Walk `sandbox.cwd` with `lstat` (skip any `.git` segment, skip `isControlPath`). Regular file → `hash-object -w --no-filters --stdin` with the bytes as stdin, mode `100755` if any exec bit else `100644`. Symlink → `readlink` text through `hash-object -w --no-filters --stdin`, mode `120000`. Collect `${mode} ${sha}\t${rel}` lines; feed with `update-index --index-info`.
    4. `write-tree`; compare with `rev-parse --end-of-options <runBranch>^{tree}`. Equal → `update-ref refs/heads/<branch> <runBranch sha>`. Else `commit-tree <tree> -p <runBranch sha> -m "<branch>: files sandbox"` with `GIT_AUTHOR_NAME/EMAIL` and committer from the run repo's configured identity, falling back to `fleetmates <fleetmates@localhost>`; `update-ref`.
    5. `finally` removes `idx`. Any non-zero git exit throws `Error('commitFilesTree: git <args> failed: <stderr>')`.
  - The git exec used must support a stdin payload; if `defaultGitExec` lacks one, use `spawn('git', …)` locally in this module with the same env merge and `--end-of-options` discipline.
- [ ] **Step 3:** `npm test` green; commit `feat(harnesses): shared git-less sandbox with hardened host commit`.

### Task 3: Codex files mode commits the teammate's work

**Files:**
- Modify: `scripts/harnesses/codex.mjs`
- Modify: `tests/harness-codex.test.mjs`

**Depends:** T2

- [ ] **Step 1:** Add a failing test: `makeCodexSandbox(mode: 'files')`, write `a.txt` edit and `new.txt` into `sandbox.cwd`, `collectCodex` → `git log fleetmates/r1/T9` has one new commit containing both. Run it and see it fail (`unknown revision` / branch missing).
- [ ] **Step 2:** In `codex.mjs`, import `makeFilesSandbox, commitFilesTree` from `./files-sandbox.mjs`; `makeCodexSandbox` returns `makeFilesSandbox(git, { runRepo, runBranch, runId, taskId })` for `files`; `collectCodex` for `files` returns `commitFilesTree(git, { runRepo, runBranch: sandbox.meta.runBranch, sandbox, branch })`. Store `runBranch` in `meta` for both layouts (files-sandbox returns `meta.runBranch` — add it there too if T2 did not).
- [ ] **Step 3:** Existing files-mode tests still pass; commit `fix(codex): files sandbox commits the teammate's edits`.

### Task 4: the Cursor adapter

**Files:**
- Create: `scripts/harnesses/cursor.mjs`
- Test: `tests/harness-cursor.test.mjs`

**Depends:** T1, T2

- [ ] **Step 1:** Tests first, with a fake `cursor-agent` on `PATH` (CommonJS shebang script, same approach as `tests/harness-codex.test.mjs`). The fake answers `status` from `FAKE_CURSOR_LOGGED_IN`, writes its argv to `FAKE_CURSOR_ARGV_OUT`, blocks until stdin closes, then prints `system/init` (session id `FAKE_CURSOR_SESSION`), one `assistant` line and a `result` line whose `result` is `FAKE_CURSOR_RESULT_TEXT` with usage `{inputTokens:10,outputTokens:5,cacheReadTokens:2,cacheWriteTokens:1}`; `FAKE_CURSOR_IS_ERROR=1` sets `is_error:true`; `FAKE_CURSOR_NO_RESULT=1` omits the line. Cases:
  - `buildSpawnArgv`/`buildResumeArgv` exact arrays with and without `model`; resume adds `--resume <id>`; `assertSafeArgv` throws for each forbidden flag.
  - spawn records the session id from `system/init`; stdin is closed (fake would hang otherwise).
  - spawn and resume on a `files` sandbox scrub first and write `.cursor/sandbox.json` with `networkPolicy.default` `deny`, or `allow` with `network: true`; a `full` sandbox is neither scrubbed nor written.
  - `readResult`: raw JSON → object; fenced ```` ```json ```` block after prose → object; prose → null; `is_error` → null; no result line → null; extra key → null; last result line wins.
  - `readUsage`: two result lines → `{ input: 20, cachedInput: 4, cacheWrite: 2, output: 10, reasoning: 0 }`; none → null.
  - `collectCursor`: clean checkout commits; a modified driver `sandbox.json` or a planted `.claude/settings.local.json` throws `control-path: …` and creates no branch.
  - `makeSandbox` with `clone` or `full` throws `Cursor runs git outside its sandbox; only "files" is supported`.
  - `probe` (injectable `home` and `env`): logged out → `fix: 'run: cursor-agent login'`; missing binary → `fix: 'install the Cursor CLI'`; unwritable home → not ok; global `sandbox.json` with `additionalReadwritePaths` or `networkPolicy.default: 'allow'` → not ok; global `hooks.json` → `{ ok: true, warning }`.
  - `cursorAdapter` has the eight functions plus `name: 'cursor'`, `defaultSandbox: 'files'`, `supportsEffort: false`.
- [ ] **Step 2:** Implement `scripts/harnesses/cursor.mjs`:
  - `FORBIDDEN_FLAGS = ['--force', '-f', '--yolo', '--approve-mcps', '--worktree', '-w', '--api-key']`; `assertSafeArgv(argv)` also throws when `--sandbox` is followed by anything but `enabled`.
  - `buildSpawnArgv({ sandbox, model })` → `['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--workspace', sandbox.cwd, ...(model ? ['--model', model] : [])]`; `buildResumeArgv({ sandbox, sessionId, model })` → same plus `['--resume', sessionId]`. Both call `assertSafeArgv`.
  - `RESULT_INSTRUCTION` appended to every spawn prompt and resume message: the final message must be exactly one JSON object with keys `status` (`done|blocked|failed`), `branch`, `filesChanged`, `summary`, `blockers`, and nothing else; no commits are possible or needed, the host commits the workspace.
  - `prepareWorkspace(sandbox, network)` — when `meta.mode === 'files'`: `scrubControlPaths`, then write `.cursor/sandbox.json` = `JSON.stringify({ type: 'workspace_readwrite', networkPolicy: { default: network ? 'allow' : 'deny' } })`; store the exact text in `sandbox.meta.sandboxJson`.
  - `run(argv, { promptText, streamPath, errPath, cwd })` — as in codex.mjs but binary `cursor-agent`, session id from the first line with `type === 'system' && subtype === 'init'`, stream appended (`flags: 'a'`) so a resume keeps earlier result lines.
  - `readResult({ streamPath })` — last `type:"result"` line; `is_error` → null; parse `result` whole, else the last ```` ```json ```` fence; `validateResult` or null. The driver passes `resultPath` too; ignore it.
  - `readUsage({ streamPath })` — sum per spec §4.4.
  - `makeCursorSandbox(git, opts)` — `files` → `makeFilesSandbox`; otherwise throw.
  - `collectCursor(git, { runRepo, sandbox, branch })` — `full` → return; read `.cursor/sandbox.json` text, `found = scrubControlPaths`; unexpected = found minus `.cursor/sandbox.json` when its text equalled `meta.sandboxJson`; non-empty → throw `control-path: <list>`; else `commitFilesTree`.
  - `cleanup({ sandbox })` — `files` → `rm(sandbox.cwd)`; `full` → nothing.
  - `probe({ env, home })` per spec §4.5, `status` via `spawn('cursor-agent', ['status'])`, `ENOENT` → install fix.
  - export `cursorAdapter = { name: 'cursor', defaultSandbox: 'files', supportsEffort: false, probe, makeSandbox: makeCursorSandbox, collect: collectCursor, cleanup, spawn: spawnCursor, resume: resumeCursor, readResult, readUsage }`.
- [ ] **Step 3:** `npm test` green; commit `feat(harnesses): Cursor adapter`.

### Task 5: register Cursor and its config

**Files:**
- Modify: `scripts/harnesses/index.mjs`
- Modify: `scripts/config.mjs`
- Modify: `tests/config.test.mjs`

**Depends:** T4

- [ ] **Step 1:** Failing tests: `KNOWN_HARNESSES` is `['codex', 'cursor']`; `harnesses.cursor.{sandbox:'files', network, timeoutMinutes, tierModels}` validate in both layers and through `config set`; `harnesses.cursor.sandbox` `clone` and `full` are refused with `Cursor runs git outside its sandbox; only "files" is supported`; codex still accepts all three; `getAdapter('cursor').name === 'cursor'`.
- [ ] **Step 2:** `KNOWN_HARNESSES = ['codex', 'cursor']`; add `HARNESS_SANDBOXES = { codex: SANDBOXES, cursor: ['files'] }` and use it in `validateHarnesses` and in `validateKey` for `harnesses.<name>.sandbox`, with the Cursor-specific message; register `cursor: cursorAdapter` in `index.mjs` and update its comment.
- [ ] **Step 3:** `npm test` green; commit `feat(config): harnesses.cursor keys`.

### Task 6: driver and CLI honour per-adapter defaults, effort and probe warnings

**Files:**
- Modify: `scripts/driver.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `tests/driver.test.mjs`
- Modify: `tests/cli.test.mjs`

**Depends:** T5

- [ ] **Step 1:** Failing tests:
  - driver with a stub adapter `supportsEffort: false` and an `effortFor` returning `'high'` writes `effortIgnored: true` in `sessions/T.json` and passes `effort: undefined` to spawn; with `supportsEffort` absent the record has no `effortIgnored` and effort is passed.
  - driver passes `streamPath` to `readResult` alongside `resultPath`.
  - `harnessSettings(resolved, 'cursor', 'files').sandboxMode === 'files'`; codex default stays `clone`.
  - `dispatch --harness cursor` with a stub adapter whose probe returns `{ ok: true, warning: 'w' }` prints `warning: w` and continues.
- [ ] **Step 2:** driver: `const effortRaw = effortFor ? effortFor(task) : undefined; const effort = adapter.supportsEffort === false ? undefined : effortRaw`; include `effortIgnored: true` in the first record write when `adapter.supportsEffort === false && effortRaw`; call `readResult({ resultPath, streamPath })` at both sites.
- [ ] **Step 3:** cli: `harnessSettings(resolved, harnessName, defaultSandbox = 'clone')` uses `entry.sandbox ?? defaultSandbox`; every call passes `adapter.defaultSandbox`; after each `adapter.probe` success, `if (probe.warning) io.out(\`warning: ${probe.warning}\`)`; the unsandboxed-orchestrator message names cursor alongside codex where it lists harness flags only if that text is harness-specific.
- [ ] **Step 4:** `npm test` green; commit `feat(driver): per-adapter sandbox default, effort support and probe warnings`.

### Task 7: real-Cursor end-to-end and security canaries

**Files:**
- Create: `tests/e2e-cursor.test.mjs`
- Modify: `package.json`
- Modify: `tests/npm-scripts.test.mjs`

**Depends:** T6

- [ ] **Step 1:** `package.json` script `"test:e2e:cursor": "FLEETMATES_E2E=1 node --test tests/e2e-cursor.test.mjs"`; `tests/npm-scripts.test.mjs` asserts it.
- [ ] **Step 2:** `tests/e2e-cursor.test.mjs`, every test skipped unless `FLEETMATES_E2E === '1'` and `cursorAdapter.probe()` is ok. Scratch dirs under `path.join(os.homedir(), '.cache', 'fleetmates-e2e-cursor')`, never `os.tmpdir()`; markers in a sibling `outside/` dir; each case has a positive control (the host writes the marker path itself once and deletes it, proving the path is observable):
  1. files sandbox spawn told to `echo x > <outside>/shell` → marker absent.
  2. told to create `<outside>/edit` with its file tool → marker absent.
  3. `network: false`, told to `curl -sS -m 5 https://example.com -o <workspace>/net.html` → `net.html` absent.
  4. told to write `.cursor/sandbox.json` widening to `<outside>` → `collectCursor` throws `control-path`, no task branch.
  5. `runBranch` carries `.cursor/hooks.json` with `sessionStart` touching `<outside>/hook` → after a spawn the marker is absent.
  6. session 1 plants `.cursor/sandbox.json` widening to `<outside>`; resume told to `echo x > <outside>/widen` → marker absent.
  7. Full run: three-task plan (each creates one file) in a scratch repo → `init-run`, `dispatch --harness cursor --phase 1`, `gate`, `dispatch-integrator`; the run branch contains all three files. Cheapest model via `harnesses.cursor.tierModels`.
- [ ] **Step 3:** Run `npm run test:e2e:cursor` for real; record the output. Commit `test(e2e): real Cursor security canaries and full run`.

### Task 8: documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `skills/fleetmates-config/SKILL.md`

**Depends:** T5

- [ ] **Step 1:** README: a "Running on Cursor" section after "Running on Codex": `cursor-agent login`; `--harness cursor`; teammates are `files`-only because Cursor runs git outside its sandbox; one host-made commit per task; `.cursor/*` and `.claude/settings*.json` never change from a Cursor teammate; effort chosen through the model id in `harnesses.cursor.tierModels`; the probe refuses a widening global `~/.cursor/sandbox.json` and warns on a global `~/.cursor/hooks.json`.
- [ ] **Step 2:** `skills/fleetmates-config/SKILL.md`: harnesses section names `codex` and `cursor`; `harnesses.cursor.*` fields with `sandbox` only `files`, and `tierModels` example `claude-opus-5-high`.
- [ ] **Step 3:** CHANGELOG `Unreleased`: Added — Cursor adapter; Fixed — Codex `files` sandbox never committed the teammate's edits.
- [ ] **Step 4:** `npm test` green (skill contract tests); commit `docs: Cursor harness`.
