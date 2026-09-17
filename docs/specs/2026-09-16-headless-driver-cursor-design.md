# Headless driver — the Cursor adapter — design

Date: 2026-09-16. A sub-project of running fleetmates outside Claude Code, taken ahead of Gemini
CLI and OpenCode. It implements the adapter interface fixed by
`docs/specs/2026-09-14-headless-driver-codex-design.md` (the "Codex spec"), whose driver, CLI
commands, preflight, lock and orphan handling it reuses unchanged.

## Decisions already made

| Question | Decision |
|---|---|
| Security bar? | Same as Codex: every sandbox claim measured on this machine, host-side evidence only. |
| Sandbox layout? | **Git-less checkout only** (`files`). The isolated-clone layouts are refused for Cursor (§3). |
| Who commits? | The host, from the checkout, through a shared hardened `commitFilesTree` (§4). |
| Does Codex change? | Yes, one fix: its `files` mode never commits the teammate's work today (§4.3). |
| Scope of "runs on Cursor"? | Cursor as a **teammate backend** driven by `dispatch --harness cursor`. The orchestrator stays whatever harness the user drives. |

## 1. Measured on this machine (cursor-agent 2026.09.15-d2fe57e, Linux)

Each fact below was executed. Escape probes lived under `$HOME/.cache`, not `/tmp`, because Cursor's
sandbox allows writes to temp directories; the evidence is the host's `ls`/`git log` afterwards,
never the model's report.

1. **Headless JSON.** `cursor-agent -p --output-format json` prints one object
   `{type:"result", subtype, is_error, result, session_id, request_id, usage}` with
   `usage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`.
2. **Stream.** `--output-format stream-json` emits `{"type":"system","subtype":"init","session_id":…}`
   first, before any model call, and ends with the same `type:"result"` object as item 1.
3. **Prompt on stdin.** `-p` with no prompt argument reads the prompt from stdin and exits once
   stdin closes.
4. **Resume.** `-p --resume <session_id>` keeps the conversation (the model recalled its previous
   reply) and keeps the same `session_id`.
5. **Effort is part of the model id.** `cursor-agent models` lists variants such as
   `claude-opus-5-low|medium|high`, `gpt-5.3-codex-high|xhigh`. The `--help` bracket form
   `'model[effort=low]'` was refused: `Cannot use this model: claude-opus-5-thinking-high[effort=low]`.
6. **`--force` disables the sandbox.** With `--sandbox enabled --force`: a shell write outside the
   workspace, an edit-tool write outside it, an edit-tool write into another repository, a write into
   a separate git dir, and `curl https://example.com` all succeeded.
7. **Without `--force` the sandbox holds for the basics.** Outside shell write:
   `Permission denied`. Edit tool outside the workspace: `Rejected:`. Network:
   `curl: (7) CONNECT tunnel failed, response 403`. In-workspace edit-tool writes and `git commit`
   still succeed — `--force` is not needed for a teammate to work.
8. **A separate git dir is writable, including `config`.** In a `clone --separate-git-dir` layout the
   agent wrote `<gitdir>/planted.txt`, ran `git config filter.x.clean …`, and appended to
   `<gitdir>/config`. Cursor's protection of `.git/config` covers only `<workspace>/.git`.
9. **Cursor runs git outside the sandbox.** With that planted `filter.x.clean` (a `touch` of a path
   outside every writable root) and `* filter=x` in `.gitattributes`, the marker appeared after a
   turn in which the model was told to run no tools. Same class as Codex spec §2 item 9.
10. **A workspace `.cursor/sandbox.json` is agent-writable and widens the next session.** The agent
    wrote `{"additionalReadwritePaths":["<outside>"]}`; the next session's outside write succeeded.
11. **A workspace `.cursor/hooks.json` runs outside the sandbox.** Its `sessionStart` command touched
    a path outside the workspace. No CLI flag disables hooks. The agent itself cannot write
    `.cursor/hooks.json` or `.cursor/cli.json` (`Read-only file system`).
12. **`.claude/` is agent-writable.** The agent wrote `.claude/settings.local.json`. A project
    `.claude/settings.json` `SessionStart`/`Stop` hook did not fire in this run; Cursor's docs say
    Claude Code hooks are read, so this is treated as a live vector anyway.
13. **A git-less directory works.** The agent edits files normally with no repository present.
14. **A workspace nested in a repository stays confined.** Workspace
    `<repo>/.fleetmates/r/files/T` (gitignored): shell writes to `<repo>/`, `<repo>/.git/` and the
    sibling `<repo>/.fleetmates/r/` were denied with `Permission denied`, an edit-tool write to
    `<repo>/` was `Rejected:`, and an in-workspace write succeeded. Measured during implementation,
    before the checkout location was relied on.

## 2. Why this layout

| Layout | Verdict | Reason |
|---|---|---|
| Clone, `.git` pointer kept | rejected | Item 9: a planted clean filter fires outside the sandbox. |
| Clone, `.git` pointer removed (Codex default) | rejected | The agent's shell needs `GIT_DIR` to commit. Cursor has no shell-only environment setting like Codex's `shell_environment_policy`, and putting `GIT_DIR` on the `cursor-agent` process exposes Cursor's own unsandboxed git (item 9) to the teammate's writable config (item 8). |
| `danger`/`--force` | rejected | Item 6: no sandbox at all. |
| **Git-less checkout** | **chosen** | No repository inside the sandbox, so item 9 has nothing to act on. Items 10–12 are closed by scrubbing (§4.2). |

The cost: a Cursor teammate cannot commit, so a task lands as one host-made commit, not a series.

## 3. Components

- **`scripts/harnesses/cursor.mjs`** — the only module that knows Cursor's CLI. Exports
  `cursorAdapter` with the eight functions of the Codex spec's adapter interface:
  `probe`, `makeSandbox`, `collect`, `cleanup`, `spawn`, `resume`, `readResult`, `readUsage`.
- **`scripts/harnesses/files-sandbox.mjs`** — harness-neutral, used by both adapters:
  - `makeFilesSandbox(git, { runRepo, runBranch, runId, taskId })` — the git-less checkout,
    moved verbatim out of `makeCodexSandbox`'s `files` branch (private `GIT_INDEX_FILE`, run repo
    index and HEAD untouched).
  - `commitFilesTree(git, { runRepo, runBranch, sandbox, branch })` — §4.3.
  - `CONTROL_PATHS` and `scrubControlPaths(cwd) → string[]` — §4.2.
- **`scripts/harnesses/index.mjs`** — registers `cursor`.
- **`scripts/config.mjs`** — `KNOWN_HARNESSES` gains `cursor`; `harnesses.cursor.sandbox` accepts
  only `files` (§6).
- **`scripts/harnesses/codex.mjs`** — `makeCodexSandbox` delegates its `files` branch to
  `makeFilesSandbox`; `collectCodex` calls `commitFilesTree` in `files` mode.

## 4. The adapter

### 4.1 Argv

Spawn:

    cursor-agent -p --output-format stream-json --trust --sandbox enabled --workspace <cwd> [--model <id>]

Resume: the same, plus `--resume <sessionId>`. The prompt or redirect message goes on stdin, and
stdin is always closed (item 3). The child's cwd is the checkout.

`buildSpawnArgv` / `buildResumeArgv` are pure and exported. They never emit `--force`, `--yolo`,
`--approve-mcps`, `--sandbox disabled`, `--worktree` or `--api-key`; an internal assertion throws if
the built argv contains any of them, so a later edit cannot silently reintroduce item 6.

`dispatch-reviews` and `dispatch-integrator` hand the adapter `{ cwd: <run repo>, meta: { mode:
'full' } }` (the Codex spec's orchestrator-side roles). For Cursor, `full` keeps the same argv —
`--sandbox enabled`, never `--force` — with the run repo as workspace, and skips the scrub and the
`sandbox.json` write of §4.2: that workspace is the user's own repository, whose control files are
theirs, and anything written there would be committed. Only `files` sandboxes are scrubbed.
`makeSandbox` for Cursor throws for any mode other than `files`.

### 4.2 Scrub (before spawn, before every resume, and at collect)

`CONTROL_PATHS`, relative to the checkout:

- `.cursor/sandbox.json`, `.cursor/hooks.json`, `.cursor/hooks/`, `.cursor/cli.json`,
  `.cursor/mcp.json`, `.cursor/worktrees.json`
- `.claude/settings.json`, `.claude/settings.local.json`
- `.vscode/`

`scrubControlPaths` removes each (without following symlinks) and returns the ones it found.

- **Before spawn** — files that arrive from `runBranch` are removed. Then the adapter writes its own
  `.cursor/sandbox.json`: `{"type":"workspace_readwrite","networkPolicy":{"default":"deny"}}`, or
  `"default":"allow"` when `network` is on. The file the driver writes is recorded as expected.
- **Before resume** — the same scrub and rewrite, so anything planted in one session never
  loosens the next (item 10). This covers both the enforcement retry and `message`.
- **At collect** — scrub again. Any found path other than the driver's own `sandbox.json` with its
  exact written content means the teammate touched a control file: `collect` throws
  `control-path: <paths>`, the driver records the task `orphaned` with that reason, nothing is
  committed, and the checkout is kept for inspection.

Control paths are never part of a teammate's diff in either direction: `commitFilesTree` takes
every `CONTROL_PATHS` entry from `runBranch`'s tree, not from the checkout (§4.3 step 3), so a
scrubbed file is not deleted on the branch and a planted one is never added. A plan that must change
one of them has to do it on the Claude Code path or by hand; the `control-path` error says so.

### 4.3 `commitFilesTree` (shared; fixes Codex `files` mode)

Today `collectCodex` returns early for `files` and `scripts/driver.mjs` commits nothing, so a
Codex `files`-mode task never reaches its branch, although the Codex spec (§7, §11) says `collect`
commits the diff. `commitFilesTree` implements that, safely:

1. Walk the checkout with `lstat`; skip `.git` entries anywhere.
2. Regular file → `git hash-object -w --no-filters --stdin` fed the bytes read by the host.
   Executable bit → mode `100755`, else `100644`. Symlink → the link text as a blob, mode `120000`;
   the target is never read.
3. Seed a temporary `GIT_INDEX_FILE` (outside the run repo and the checkout) with
   `git read-tree runBranch`, remove every non-control path from it, then feed the checkout's
   `mode sha path` lines for non-control paths to `git update-index --index-info`. Control paths
   keep `runBranch`'s entries (§4.2); a checkout path that is itself a `CONTROL_PATHS` entry is
   skipped. `git write-tree`.
4. If the tree equals `runBranch^{tree}`: no commit; `fleetmates/<run>/<task>` points at `runBranch`.
5. Otherwise `git commit-tree <tree> -p <runBranch>` and `git update-ref` the task branch.

Every git call runs with `cwd = runRepo` and `-c core.hooksPath=/dev/null`. No git command ever runs
with the checkout as cwd or work tree, so an in-tree `.gitattributes` never selects a filter and no
teammate content is executed. The temporary index is removed on success and failure.

### 4.4 Data flow

- **Session id** — from the first `system/init` line (item 2), recorded in `sessions/T.json` as soon
  as it is seen.
- **Result** — Cursor has no output-schema flag. The prompt ends with a fixed instruction: the final
  message must be exactly one JSON object matching `RESULT_SCHEMA`. `readResult` takes the `result`
  string of the last `type:"result"` line in the stream file and parses it — whole text, else the
  last fenced ```` ```json ```` block — then validates it against `RESULT_SCHEMA`. It returns `null`
  (→ `orphaned`) for: no result line, `is_error: true`, unparsable text, schema failure. No retry.
  Nothing is written into the checkout.
- **Usage** — `readUsage` sums `usage` over every `type:"result"` line (a resume appends one):
  `inputTokens→input`, `cacheReadTokens→cachedInput`, `cacheWriteTokens→cacheWrite`,
  `outputTokens→output`, `reasoning: 0`. `null` when there is no result line.
- **Model** — `harnesses.cursor.tierModels` maps `cheap`/`mid`/`capable` to full Cursor model ids,
  e.g. `"capable": "claude-opus-5-high"`. Unmapped → no `--model` (Cursor's `auto`).
- **Effort** — not passable (item 5). The adapter ignores `agents.<role>.effort` and the driver
  records `effortIgnored: true` in `sessions/T.json`. Docs tell the user to choose the effort variant
  in `tierModels`.

### 4.5 Probe

- `cursor-agent status` output must not contain `Not logged in` → else
  `{ ok:false, fix: "run: cursor-agent login" }`. A spawn error (binary missing) →
  `fix: "install the Cursor CLI"`.
- `~/.cursor` (or `$CURSOR_CONFIG_DIR`) must be writable (create and remove a temp dir).
- A global `~/.cursor/sandbox.json` with non-empty `additionalReadwritePaths` or a
  `networkPolicy.default` of `"allow"` → `ok:false`: it widens every teammate's sandbox, and the
  per-repo file the driver writes cannot narrow it back.
- A global `~/.cursor/hooks.json` → `ok:true` with a `warning` printed by `dispatch`: the user's own
  hooks run outside the sandbox for every teammate.
- Never runs an agent turn.

## 5. Error handling

| Condition | Result |
|---|---|
| `probe` fails | `dispatch*` exits 2 before any checkout, printing `reason` and `fix`. |
| Control path touched by the teammate | `orphaned`, reason `control-path: <paths>`, no commit, checkout kept. |
| No result line / `is_error` / unparsable / schema failure | `orphaned`, last 20 stderr lines recorded (driver, unchanged). |
| `commitFilesTree` git failure | Adapter throws; the driver's existing handling records `orphaned` with the git error. |
| Argv would contain a forbidden flag | Internal assertion throws before spawning. |
| Timeout, driver kill, second driver, redirect | Driver behaviour from the Codex spec, unchanged. |

## 6. Configuration

```json
{ "harnesses": { "cursor": {
  "sandbox": "files", "network": false, "timeoutMinutes": 90,
  "tierModels": { "cheap": "composer-2.5", "mid": "claude-sonnet-5-thinking-high", "capable": "claude-opus-5-high" }
} } }
```

- `sandbox` defaults to `files`; `clone` and `full` are refused for `cursor` with
  `Cursor runs git outside its sandbox; only "files" is supported`.
- `network` controls the `networkPolicy.default` the adapter writes (§4.2). Default `false`.
- Same layering, validation and `config set`/`unset` rules as `harnesses.codex.*`.

## 7. Testing

**Default `npm test` (no Cursor needed):**

- `tests/harness-cursor.test.mjs`
  - Argv: exact spawn and resume shapes; forbidden flags never present; the assertion throws when one is injected.
  - `readResult`: raw JSON, fenced JSON, prose, `is_error`, no result line, schema violation.
  - `readUsage`: two result lines summed; none → `null`.
  - Session id parsed from `system/init`.
  - `probe`: logged-out text, missing binary, unwritable home, widening global `sandbox.json` refused, global `hooks.json` warns.
  - Scrub runs before spawn and before resume; the driver-written `sandbox.json` is not reported at collect, a modified one is.
- A fake `cursor-agent` on `PATH` (as `tests/harness-codex.test.mjs` does for `codex`) that replays
  `stream-json` fixtures from §1 runs and blocks on stdin unless it is closed.
- `tests/files-sandbox.test.mjs`
  - Each `CONTROL_PATHS` entry scrubbed, including as a symlink.
  - `commitFilesTree`: edits, additions, deletions and exec bits land; an in-tree `.gitattributes`
    selecting a filter defined in the run repo's config does **not** fire (marker file); a symlink to
    a host file commits as a link; run repo index and HEAD untouched; unchanged tree → no commit.
- Codex regression: a `files`-mode edit lands on `fleetmates/<run>/<task>`. Written first and
  watched failing on `09f716e`, whose `collectCodex` returns early for `files` (read, not yet run).
- `commitFilesTree` keeps a `runBranch` `.claude/settings.json` on the task branch although the
  scrub removed it from the checkout, and never adds a planted one.
- Config: `harnesses.cursor.*` accepted; `sandbox: clone|full` refused with the reason.

**Opt-in `npm run test:e2e:cursor` (`FLEETMATES_E2E=1`, real Cursor, spends tokens):**

- End to end: a three-task plan in a scratch repo under `$HOME` → `init-run`, `dispatch --harness
  cursor`, `gate`, `dispatch-integrator`; the run branch holds all three merges.
- Security canaries, each with a positive control, each checked by a marker outside every writable root:
  1. shell write outside the checkout denied;
  2. edit-tool write outside the checkout denied;
  3. network denied with `network: false`;
  4. a teammate-planted `.cursor/sandbox.json` → task `orphaned`, file absent from every branch;
  5. a `.cursor/hooks.json` on `runBranch` → scrubbed, its `sessionStart` marker absent;
  6. a planted `sandbox.json` in session 1 does not widen the resumed session 2.

## 8. Documentation

- README: a "Cursor" section — `cursor-agent login`, why Cursor teammates are `files`-only (§2),
  one commit per task, effort through `tierModels`, the global `~/.cursor` probe rules, and that
  `.cursor/*`/`.claude/settings*` changes cannot come from a Cursor teammate.
- `skills/fleetmates-config/SKILL.md`: `harnesses.cursor.*`.
- The harness sections of `parallel-execution`, `fleet-lifecycle`, `phase-gate`: `--harness cursor`
  is accepted wherever `codex` is. Skill-text contract tests change in the same commits.
- CHANGELOG: the Cursor adapter, and the Codex `files`-mode commit fix.
- `package.json`: `test:e2e:cursor`.

## Out of scope

- Running the orchestrator inside Cursor (installing the skills as a Cursor plugin).
- Cursor Cloud agents, `cursor-agent worker`, `--worktree`.
- Mixed-harness fleets.
- Multi-commit history from Cursor teammates.
- Gemini CLI and OpenCode adapters.
