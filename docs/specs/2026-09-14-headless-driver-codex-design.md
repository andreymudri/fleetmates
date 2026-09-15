# Headless driver and the Codex adapter — design

Date: 2026-09-14. Sub-project 1 of 3 for running fleetmates outside Claude Code. Gemini CLI and
OpenCode are sub-projects 2 and 3, each with its own spec, written against the adapter interface
this one fixes.

## Decisions already made

| Question | Decision |
|---|---|
| Which harnesses? | Codex CLI, Gemini CLI, OpenCode. |
| What counts as "works on harness X"? | Full parity: phased dispatch in worktrees, gate, integration, stop-time enforcement, redirecting a teammate, resuming a run, usage reporting, model and effort per role. |
| How are teammates run? | A **headless driver** inside fleetmates: it creates an isolated sandbox and runs one headless harness process per task. Not the harness's in-session subagents. |
| Which harness first? | Codex. It closes the adapter interface; Gemini and OpenCode implement it afterwards. |
| How do skills find the CLI outside Claude Code? | `<fleetmates root>` = `$CLAUDE_PLUGIN_ROOT` when set, otherwise two directories above the skill's own `SKILL.md`. No `bin`, no global install. |
| Which sandbox do Codex teammates use? | Measured, then chosen: `workspace-write` in an **isolated clone** (section 2/7), the default. `danger-full-access` and a git-less fallback stay selectable. Teammates never run unsandboxed by default. |
| Does the Claude Code path change? | No. `Workflow` / `Agent` dispatch and the `SubagentStop` hook stay as they are. |

## 1. Why a driver and not the harnesses' own subagents

None of the three harnesses gives a subagent its own git worktree. Claude Code's
`isolation: 'worktree'` has no equivalent, and it is what the whole fleet rests on. Beyond that the
three disagree on everything a fleet needs:

| Need | Codex 0.149 | Gemini 0.59 | OpenCode 1.18 |
|---|---|---|---|
| Worktree per subagent | no | no | no |
| Background / parallel subagents | yes | parallel in one turn, blocking | background behind an experimental flag |
| Block a finishing agent | `SubagentStop`, `Stop` | `AfterAgent`, session only | none |
| Message a running agent | `send_input` | no | no |
| Headless session with resume by id | `codex exec` / `exec resume` | `gemini -p` / `--resume` | `opencode run` / `serve` |

Source: three research reports of 2026-09-14 built from each project's docs and source, plus
`--help` on the installed binaries. Codex rows marked in section 2 were re-measured here.

The last row is the only capability all three share, so the driver builds on it. Every gap in the
table becomes a driver responsibility, implemented once: the driver owns the sandbox, runs the
enforcement check itself when the process exits, and redirects a teammate by stopping and
resuming its session.

## 2. Measured on this machine (codex-cli 0.149.0, Linux)

Each fact below was executed, not read. Scratch repositories lived in the session scratchpad; the
git log of those repositories, not any model's report, is the evidence for the git rows.

1. **The package installs unchanged.** `codex plugin marketplace add <repo>` reads
   `.claude-plugin/marketplace.json`; `codex plugin add fleetmates@fleetmates` installs into
   `$CODEX_HOME/plugins/cache/fleetmates/fleetmates/2.0.1/`.
2. **All 14 skills reach the model**, namespaced `fleetmates:*`, each with its absolute file path:
   `(file: …/plugins/cache/fleetmates/fleetmates/2.0.1/skills/<name>/SKILL.md)`. Checked with
   `codex debug prompt-input`.
3. **`$CLAUDE_PLUGIN_ROOT` is not set in the agent's shell.** Codex sets it only for hooks
   (`codex-rs/hooks/src/engine/discovery.rs`), and non-managed hooks need recorded trust.
4. **`codex exec` reads stdin even with a prompt argument.** With an inherited, never-closed stdin
   it waits forever and emits zero events (three processes, 611 s). With stdin closed it runs.
5. **The first `--json` event carries the session id:** `{"type":"thread.started","thread_id":…}`,
   before any model call.
6. **Token usage** arrives per turn:
   `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}`.
7. **`workspace-write` cannot commit in a *linked worktree*.** Codex keeps `<root>/.git`
   read-only, and resolves a `gitdir:` pointer file so its target is protected too
   (`codex-rs/protocol/src/permissions.rs:1757-1794`, tag `rust-v0.149.0`). For a linked worktree
   that target is `<main>/.git/worktrees/T`, which holds `index.lock`; `git add`/`commit` exit 128.
   `--add-dir <main>/.git` does not help. Every control write outside the cwd was denied, so the
   sandbox was active.
8. **`workspace-write` *can* commit in a separate clone.** `git clone --shared
   --separate-git-dir=<gitdir> <repo> <clone>` with `codex exec -s workspace-write -C <clone>
   --add-dir <gitdir>` commits: the exact-path `--add-dir` drops the git dir's read-only default
   (`permissions.rs:1187-1191`). Writes to the main worktree, the main `.git`, another teammate's
   clone or git dir, and the run directory were all denied. This is the basis of the isolated-clone
   layout in section 7.
9. **Codex runs `git status` outside the sandbox every turn** (`core/src/turn_metadata.rs:453-477`),
   in the session cwd, hardened with `GIT_OPTIONAL_LOCKS=0 -c core.hooksPath=/dev/null
   -c core.fsmonitor=false` (`git-utils/src/info.rs:404-420`) — but **not** against a
   `filter.<x>.clean` the teammate plants in its own git config. Measured: with a clone that keeps
   its `.git` pointer, a planted clean filter fired outside the sandbox in a turn where the model
   ran no command at all. The section 7 layout removes the teammate's git dir from where that
   status resolves.
10. **Codex hooks run outside the sandbox**, cwd = the session dir (`hooks/src/engine/command_runner.rs`).
    `--disable hooks` (or `-c features.hooks=false`) stops all of them — plugin, config, and project
    `.codex/hooks.json` — before discovery. Measured: a project `SessionStart` hook wrote outside the
    writable roots with hooks on, and did not run with `--disable hooks`.
11. **A sandboxed agent cannot create or widen `.git`/`.codex`.** In the clone `<clone>/.git` shows
    as an empty read-only directory (bwrap masks the missing protected name); creating the pointer
    file or `mkdir .git` is denied, so the agent cannot redirect the harness's git back at its own
    config.
12. **`codex exec resume` stays sandboxed and still commits.** It takes no `-s`/`-C`/`--add-dir`;
    passing `-c sandbox_mode`, `-c sandbox_workspace_write.writable_roots`, and
    `-c shell_environment_policy.set` reproduces the sandbox. Measured: an outside control write was
    denied and a second commit landed.
13. **The host's `git fetch <gitdir>` is safe.** With real new commits to transfer and
    `uploadpack.packObjectsHook` plus a `pre-upload-pack` hook planted in the git dir, a local
    `git fetch` from it fired neither. A local fetch does not run a send-side upload-pack transport.
14. **A permission profile that denies `<gitdir>/config` write is a dead end.** Codex writes that
    file at session start (loading the `local` AGENTS.md environment); denying it aborts startup
    with `bwrap: Can't write data to file …/config: Bad file descriptor`. So the git config must be
    writable, and the clean-filter vector cannot be closed by permissions.
15. Unauthenticated, `codex exec` retries a 401 for about 45 s before exiting 1; `$CLAUDE_PLUGIN_ROOT`
    is set only for hooks (item 3); and an orchestrator inside `workspace-write` cannot drive a fleet
    — a nested `codex exec` dies with `Read-only file system` — which is why the orchestrator runs
    unsandboxed (section 7).

## 3. Architecture

```
orchestrator: the harness's main agent, following the skills
  └─ cli.mjs dispatch --run R --phase N --harness codex        (run in the background, waited on)
       preflight: git common dir writable, adapter.probe() ok
       for each task in the phase, at most maxParallel at once:
         1. adapter.makeSandbox(T) → an isolated checkout on branch fleetmates/R/T (see §7)
         2. adapter.spawn → record sessionId in .fleetmates/R/sessions/T.json as soon as it is known
         3. process exits → adapter.readResult → validate against the result schema
         4. adapter.collect(T): git fetch the task branch from the sandbox into the run repo (§7)
         5. complete --enforcement-only
              exit 3 → adapter.resume(sessionId, fixed refusal text), at most once, then back to 4
         6. write result, usage and exit reason to sessions/T.json
       print the phase results in the same shape the Workflow path returns
```

The driver holds git; the teammate's sandbox is a throwaway clone whose git config the teammate
may write but nothing on the host ever executes. Step 4 is the *only* host-side git touch against
teammate material, and it is a plain `fetch` — measured not to run send-side hooks (§2 item 13).

### Units

- **`scripts/driver.mjs`**: the loop above. Knows git, the run directory and the result
  contract. Knows no harness flag.
- **`scripts/harnesses/codex.mjs`**: the only module that knows Codex. Exports the adapter.
- **`scripts/harnesses/index.mjs`**: maps a `--harness` name to its adapter and refuses an unknown
  one with exit 2 and the list of known names.
- **`scripts/result-schema.mjs`**: `RESULT_SCHEMA`, moved out of `templates/phase-workflow.js`.
  `workflow-gen.mjs` embeds it through a new `__RESULT_SCHEMA__` marker, so the Workflow path and
  the driver validate against one definition.

### Adapter interface

```js
{
  name: 'codex',
  probe({ env }) → { ok: true } | { ok: false, reason, fix },   // installed, logged in, home writable
  makeSandbox({ runRepo, runBranch, runId, taskId, mode }) → { cwd, meta },  // §7: clone or plain copy
  collect({ runRepo, sandbox, branch }) → void,                 // hardened `git fetch` from the sandbox
  cleanup({ sandbox }) → void,
  spawn({ sandbox, prompt, model, effort, schemaPath, resultPath, streamPath }) → handle,
  resume({ sandbox, sessionId, message, model, effort, schemaPath, resultPath, streamPath }) → handle,
  // handle: { child, sessionId: Promise<string|null> }
  readResult({ resultPath }) → object | null,
  readUsage({ streamPath }) → { input, cachedInput, cacheWrite, output, reasoning } | null,
}
```

`spawn` and `resume` start the process and return at once. The driver owns waiting, timeouts,
signals and the enforcement loop, so the adapters stay free of control flow and the tests for that
flow are written once. `makeSandbox`/`collect`/`cleanup` own the whole sandbox lifecycle, so what
counts as "isolated" is the adapter's business and section 7's layout does not leak into the driver
— the git-less fallback and a future harness that isolates differently are the same interface.

### The prompt

`<body of agents/tm-<role>.md without its frontmatter>` + a blank line + the brief from
`composeBrief`. A persona prefix, not a registered harness agent: Codex plugins cannot ship agent
definitions, and a prefix behaves the same on all three harnesses.

`composeBrief` renders the CLI as an absolute path resolved from `import.meta.url`, on every
path including Claude Code. Today the brief emits a literal `$CLAUDE_PLUGIN_ROOT`, which is only
expanded if the teammate's shell happens to have it.

### Branches and isolation

Each teammate's branch is `fleetmates/R/T`, created inside its own sandbox (§7), never in the run
repo's worktree. The implementer brief's `checkout -B` becomes a no-op on this path, and the Claude
Code failure mode where a teammate skips it and commits to a harness-named branch cannot occur. The
branch reaches the run repo only through `collect`'s `fetch`. If the branch already exists (a fix
round or a resumed run), the driver fetches onto it fast-forward-only and never force-resets it.

`.fleetmates/` is gitignored, so the sandboxes under it do not dirty the run worktree. The
`ownership` check and `subagent-stop.mjs` have each had defects involving nested git dirs before;
the plan carries a test that gates a phase whose sandboxes live under `.fleetmates/`.

## 4. CLI commands

| Command | Does |
|---|---|
| `dispatch --run R --phase N --harness H` | Runs every not-yet-finished implementer task of the phase. Idempotent: a task with a valid result is skipped, a task with a session and no result is resumed, a task with neither is spawned. The same command resumes an interrupted run. |
| `dispatch-reviews --run R --phase N --harness H` | Runs one `tm-reviewer` per lens from the existing `review-dispatch` output, in parallel, cwd at the project root. Writes nothing itself; `collect-reviews` is unchanged. |
| `dispatch-integrator --run R --phase N --harness H` | Runs `tm-integrator` alone at the project root, only when the phase has a recorded PASS. Refuses otherwise with exit 4. |
| `message --run R --task T --harness H --text <s>` | If the task's process is alive, SIGTERM its process group and wait. Then resume the session with the text. |
| `sessions --run R` | One row per task: harness, session id, state (`running`, `done`, `blocked`, `failed`, `orphaned`), elapsed, tokens. |

`usage --run R` reads `.fleetmates/R/sessions/*` when the run has driver sessions, and the Claude
Code transcript store otherwise.

## 5. The Codex adapter

```
# spawn — cwd is the clone, git dir reached only through the agent's own shell env
codex exec --json -C <clone> -s workspace-write --disable hooks
           -m <model> -c model_reasoning_effort=<effort>
           -c 'shell_environment_policy.set={GIT_DIR="<gitdir>",GIT_WORK_TREE="<clone>"}'
           -c sandbox_workspace_write.exclude_slash_tmp=true
           -c sandbox_workspace_write.exclude_tmpdir_env_var=true
           --add-dir <gitdir> --output-schema <schemaPath> -o <resultPath>   stdin: prompt, then closed

# resume — no -s/-C/--add-dir; the sandbox is rebuilt through -c, cwd is the clone
codex exec resume <sessionId> --json --disable hooks -m … -c model_reasoning_effort=…
           -c sandbox_mode="workspace-write"
           -c sandbox_workspace_write.writable_roots=["<gitdir>"]
           -c 'shell_environment_policy.set={GIT_DIR="<gitdir>",GIT_WORK_TREE="<clone>"}'
           --output-schema <schemaPath> -o <resultPath>                      stdin: message, then closed
```

- **`--disable hooks` is mandatory** (§2 item 10): Codex hooks run outside the sandbox. The adapter
  refuses to spawn without it.
- **The clone carries no `.git` pointer** (§7). `GIT_DIR` is set only in the agent's shell via
  `shell_environment_policy.set`, never in the `codex` process environment — otherwise Codex's own
  per-turn `git status` inherits it and runs the teammate's planted config (§2 item 9).
- `stdout` goes to `streamPath` (`sessions/T.jsonl`); the adapter resolves `sessionId` from the
  first `thread.started` line. `stderr` goes to `sessions/T.err`.
- `-m` and the effort option are omitted when the role has no configured value, so Codex's own
  defaults apply, the same way the Workflow path omits `model` and `effort`.
- `readUsage` sums `turn.completed.usage` across the stream.
- `probe`: `codex login status` must not say `Not logged in`, and `$CODEX_HOME` (default `~/.codex`)
  must be writable, since section 2 item 15 shows the process dies without it.
- Whether `--output-schema` accepts `RESULT_SCHEMA` as written is **not yet measured**. OpenAI's
  structured output rejects schemas without `additionalProperties: false`. The first plan task
  runs it; if Codex refuses, `result-schema.mjs` gains the property for both paths, which the
  Workflow path tolerates.

## 6. Enforcement

After a teammate's process exits, the driver `collect`s the task branch into the run repo and runs
`complete --run R --task T --plan P --root <run repo> --enforcement-only` — in the run repo, never
in the teammate's sandbox, so no teammate git config is ever on the path. It reads the exit status
with the contract `subagent-stop.mjs` already consumes:

- **3** (a task-scoped check rejected: `fileset`, `merge`): resume the session once with the same
  fixed text the hook sends today (`resume` stays sandboxed and can still commit, §2 item 12), then
  `collect` again and re-run the check. A second 3 records the task as `failed` with `enforcement`
  as the reason.
- **0, 2, 4**: record and move on. As with the hook, only the teammate's own fixable work may
  cost it a turn.

This is stronger than the hook: the hook resolves a teammate through records under `.fleetmates/`
that teammates can write, while the driver knows which worktree it created. It is still not the
gate. The phase gate stays the only verdict.

## 7. Sandbox

Teammates run under Codex's own `workspace-write` sandbox by default — never unsandboxed. The
problem the layout solves: `workspace-write` cannot commit in a linked worktree (§2 item 7), and
the naive fix (a clone the agent can commit to) lets the agent write its own git config, which
Codex's per-turn `git status` then executes *outside* the sandbox (§2 item 9). The measured-safe
layout removes the teammate's git dir from every path the host walks.

### The isolated-clone layout (`harnesses.codex.sandbox = "clone"`, default)

`makeSandbox` builds, per task:

```
.fleetmates/R/gitdirs/T     ← the git dir (objects shared with the run repo via --shared)
.fleetmates/R/clones/T      ← the work tree, with NO .git pointer file
```

- `git clone --shared --separate-git-dir=<gitdir> <run repo> <clone>`, then `checkout -b
  fleetmates/R/T`, then **delete `<clone>/.git`**.
- `spawn` runs with cwd `<clone>`, `--add-dir <gitdir>`, `--disable hooks`, and `GIT_DIR`/
  `GIT_WORK_TREE` set **only in the agent's shell** (§5).

Why each piece is load-bearing, all measured (§2):

- **No `.git` pointer, `GIT_DIR` only in the agent shell** (items 9, 12): Codex's per-turn
  host-side `git status` walks up from `<clone>` and resolves to the *run repo* (where `.fleetmates/`
  is gitignored), not the teammate's git dir, so a planted `filter.<x>.clean` never runs on the host.
- **`--disable hooks`** (item 10): Codex hooks run outside the sandbox.
- **The agent cannot re-point at its git dir** (item 11): `<clone>/.git` is a read-only masked
  directory; it can neither create the pointer file nor `mkdir .git`.
- **Host touches the git dir only through `collect`'s `fetch`** (item 13), hardened
  `GIT_OPTIONAL_LOCKS=0 -c core.hooksPath=/dev/null -c core.fsmonitor=false`. The driver **never**
  runs git with the clone as cwd or the teammate git dir as `--git-dir`; `liveness`
  (`scripts/git.mjs:479`) does exactly that and is therefore not used on this path.
- A permission profile is **not** used: denying `<gitdir>/config` write aborts Codex startup, and
  the config must stay writable, so it cannot close the filter vector (§2 item 14).

Unmeasured, and therefore each a first-phase plan task before this layout is trusted:

- macOS (seatbelt) and Windows — only Linux/bubblewrap was measured; the "walks up to the run repo"
  behaviour and the `.git` masking may differ.
- That the harness `git status` resolves to the run repo is inferred from the canary, not observed
  directly; the task confirms which repo it opens.
- `resume` reproducing the sandbox through `-c` across a real multi-phase run.

### The git-less fallback (`harnesses.codex.sandbox = "files"`)

`makeSandbox` gives the teammate a plain checkout of the branch's tree with **no git at all** (§2
item 4 — a teammate with no repo runs fine). The teammate only edits files; `collect` computes the
diff against the fork point and commits it in the run repo, treating the tree as untrusted. Safe by
construction — no teammate-controlled git config exists — at the cost of the teammate's own `git`
(granular commits, and tests that need git history). Selectable for platforms where the clone
layout is not yet confirmed.

### `danger-full-access`

Still selectable (`harnesses.codex.sandbox = "full"`) for users who accept it. It is not the
default and the config key's documentation says why.

### Network

`workspace-write` denies network unless `sandbox_workspace_write.network_access=true`. Off by
default; a separate `harnesses.codex.network` key turns it on for tasks that install dependencies,
with the exfiltration trade-off stated. `npm install` inside the clone is not yet measured beyond
"network reaches the registry".

### Orchestrator

The orchestrator itself must run unsandboxed (§2 item 15): it writes the run repo's `.git`, and a
nested `codex exec` cannot even start inside `workspace-write`. Every CLI command that writes to git
(`init-run`, `dispatch*`, `gate`, `finish`, `prune-run`) starts with a functional preflight: create
and remove a file in `git rev-parse --git-common-dir`. On `EROFS` or `EACCES` it exits 2 naming both
ways out:

    cannot write to <dir>: this shell is sandboxed.
      Start the harness with full access (codex: --sandbox danger-full-access),
      or re-run this one command with sandbox escalation.

A behaviour test, not an environment-variable check, so Gemini and OpenCode inherit it unchanged.
Codex-specific environment variables for sandbox detection were not verified, and are not used.

## 8. Configuration

A new ergonomics key, allowed in `fleetmates.local.json` and `fleetmates.gate.json`:

```json
{
  "harnesses": {
    "codex": {
      "sandbox": "clone",
      "network": false,
      "timeoutMinutes": 90,
      "tierModels": { "cheap": "…", "mid": "…", "capable": "…" }
    }
  }
}
```

- Not an enforcement key: nothing in it changes a gate verdict, since `fileset` and `ownership`
  are recomputed from git.
- `sandbox` is one of `clone` (default, §7), `files` (git-less fallback), `full`
  (`danger-full-access`). `config set` refuses any other value.
- `network` gates `sandbox_workspace_write.network_access`; default `false`.
- `tierModels` maps the existing tiers (`cheap`, `mid`, `capable`) to model ids. An unmapped tier
  omits `-m`.
- Effort reuses `agents.<role>.effort`. The five fleetmates values are valid Codex values as spelled.
- `config set` validates each field. Unknown harness names and unknown fields are refused, as for
  `agents`.

## 9. Skills, packaging, documentation

- **Invocation.** Every `node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs"` in skills and agents becomes
  `node "<fleetmates root>/scripts/cli.mjs"`. `using-fleetmates` defines `<fleetmates root>`
  once, in the section that today explains `CLAUDE_PLUGIN_ROOT`.
- **Harness branches.** `parallel-execution` and `fleet-lifecycle` gain a section "On a harness
  other than Claude Code" that maps `Workflow`/`Agent` dispatch to `dispatch`, `SendMessage` to
  `message`, and `resumeFromRunId` to re-running `dispatch`. `phase-gate` maps the reviewer
  dispatch to `dispatch-reviews`, and the integrator step to `dispatch-integrator`.
  `using-fleetmates` and `fleetmates-config` offer choices as a numbered list where
  `AskUserQuestion` does not exist.
- **The `--harness` value** is stated by the orchestrator. The skills tell it to pass the harness
  it is running in, and the CLI never guesses.
- **Packaging.** No manifest changes. `hooks/hooks.json` is left as it is; under Codex the
  `SubagentStop` handler fires for the orchestrator's own in-session subagents and fails open, as
  it does for unrelated subagents under Claude Code.
- **README.** A "Codex" install section: marketplace add, plugin add, `codex login`, trusting the
  hooks in `/hooks` (without it `using-fleetmates` activates only by its description), and the
  sandbox model from section 7 — teammates run sandboxed in an isolated clone, the orchestrator
  runs with full access.
- **Tests that pin skill text** (`md-contract`, `skill-contracts`, `agents.test.mjs:370`) change
  in the same commits as the text they pin.

## 10. Error handling

| Condition | Result |
|---|---|
| `probe` fails | `dispatch*` exits 2 before creating any sandbox, printing the adapter's `fix` (e.g. `run: codex login`). |
| Git common dir not writable | Exit 2, section 7 message. |
| `makeSandbox` cannot build the clone (disk, git error) | Task recorded `orphaned` with the git error; the phase continues for the others. |
| Adapter asked to spawn without `--disable hooks` | Internal invariant; the adapter refuses rather than run teammate hooks outside the sandbox. |
| Process exits with no result file, or one that fails the schema | `orphaned`, last 20 lines of stderr in `sessions/T.json`. Never `done`. |
| `timeoutMinutes` elapses | SIGTERM the process group, 10 s, SIGKILL. `orphaned`, `timeout` as the reason. The session stays resumable. |
| `resume` fails to start | Recorded on the task; no retry loop. |
| Driver killed mid-phase | `sessions/*.json` already hold every session id; re-running `dispatch` resumes. |
| A second `dispatch*` on the same run while one is live | Refused with exit 1. The driver holds `.fleetmates/R/driver.lock` containing its pid; a lock whose pid is no longer alive is taken over, so a killed driver never blocks the resume in the row above. |

The driver never writes `done` from a teammate's word alone. A returned `done` is recorded as the
teammate's claim, exactly as on the Workflow path, and `doctor` and the gate decide.

## 11. Testing

- **Driver and adapter, unit.** A fake `codex` on `PATH`: a Node script that replays JSONL
  fixtures copied from the section 2 runs (`thread.started`, `turn.completed` with usage),
  writes or withholds the `-o` file, and exits with a chosen code. It also blocks reading stdin
  unless stdin is closed, so a regression of section 2 item 4 hangs the test into its timeout.
  Cases: spawn to done; enforcement exit 3 then resume then pass; a second 3 is `failed`; missing
  result is `orphaned`; timeout; `message` on a live and on an exited task; `dispatch` re-run
  resumes only unfinished tasks; `probe` refusal.
- **Preflight.** A repository whose common dir is made read-only: every git-writing command exits
  2 with the message, and none of them has created anything.
- **Config.** Valid and invalid `harnesses.codex.*` values through `config set`, including the three
  `sandbox` values and rejection of a fourth.
- **Sandbox layout, unit.** `makeSandbox` for `clone` produces a clone with no `.git` pointer, a
  separate git dir, and the branch checked out; `collect` fast-forwards the branch into the run repo
  and refuses a non-fast-forward. `files` produces a git-less tree and `collect` commits its diff.
- **Nested git dirs.** Gate a phase whose sandboxes live under `.fleetmates/`: `ownership` passes
  and `fileset` sees each branch's paths.
- **Security regression, real Codex (canary).** The measured escapes, as tests that fail if a Codex
  update reopens them, each with a canary written to a path outside every writable root:
  1. clone layout — a planted `filter.clean` does **not** fire during a no-command turn;
  2. the agent **cannot** create `<clone>/.git`;
  3. `--disable hooks` — a project `SessionStart` hook does **not** run;
  4. `resume` — an outside control write is denied and a commit still lands;
  5. host `git fetch <gitdir>` — a planted `uploadpack.packObjectsHook` does **not** fire.
  Each has a positive control proving the canary works. Runs through `npm run test:e2e:codex`,
  skipped when `probe` fails.
- **End to end, real Codex.** A three-task plan in a scratch repository: `init-run`, `dispatch`
  (clone sandbox), `gate`, `dispatch-integrator`, and a check that the run branch holds all three
  merges. `npm run test:e2e:codex`, not `npm test`, because it spends tokens.

## Out of scope

- Gemini CLI and OpenCode adapters and packaging (sub-projects 2 and 3).
- Mixed fleets (teammates from different harnesses in one run). The adapter boundary allows it
  later, but nothing here selects a harness per task.
- Moving Claude Code onto the driver.
- Codex's in-session multi-agent tools (`spawn_agent`, `send_input`).
- Codex `--worktree` (0.154.0). The driver's worktrees do not depend on it.
