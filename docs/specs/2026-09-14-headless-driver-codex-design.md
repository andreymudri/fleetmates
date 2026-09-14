# Headless driver and the Codex adapter — design

Date: 2026-09-14. Sub-project 1 of 3 for running fleetmates outside Claude Code. Gemini CLI and
OpenCode are sub-projects 2 and 3, each with its own spec, written against the adapter interface
this one fixes.

## Decisions already made

| Question | Decision |
|---|---|
| Which harnesses? | Codex CLI, Gemini CLI, OpenCode. |
| What counts as "works on harness X"? | Full parity: phased dispatch in worktrees, gate, integration, stop-time enforcement, redirecting a teammate, resuming a run, usage reporting, model and effort per role. |
| How are teammates run? | A **headless driver** inside fleetmates: it creates each worktree and runs one headless harness process per task. Not the harness's in-session subagents. |
| Which harness first? | Codex. It closes the adapter interface; Gemini and OpenCode implement it afterwards. |
| How do skills find the CLI outside Claude Code? | `<fleetmates root>` = `$CLAUDE_PLUGIN_ROOT` when set, otherwise two directories above the skill's own `SKILL.md`. No `bin`, no global install. |
| Which sandbox do Codex teammates use? | Measured, then chosen: `workspace-write` cannot commit (section 2), so the default is `danger-full-access`, held in an explicit config key. |
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
table becomes a driver responsibility, implemented once: the driver owns the worktree, runs the
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
7. **`workspace-write` cannot commit in a linked worktree.** With `/tmp` and `$TMPDIR` excluded
   from the writable roots (so a control write outside the cwd was denied, proving the sandbox was
   active): `git add` and `git commit` both exit 128. Adding `--add-dir <repo>/.git` does not
   change that. Network is denied unless `sandbox_workspace_write.network_access=true`.
8. **An orchestrator inside `workspace-write` cannot drive a fleet.** `git worktree add` from the
   repository root failed, and a nested `codex exec` died with
   `failed to initialize in-process app-server client: Read-only file system (os error 30)`.
9. Unauthenticated, `codex exec` retries a 401 for about 45 s before exiting 1.

## 3. Architecture

```
orchestrator: the harness's main agent, following the skills
  └─ cli.mjs dispatch --run R --phase N --harness codex        (run in the background, waited on)
       preflight: git common dir writable, adapter.probe() ok
       for each task in the phase, at most maxParallel at once:
         1. worktree  .fleetmates/R/worktrees/T  on branch fleetmates/R/T, forked from the run branch
         2. adapter.spawn → record sessionId in .fleetmates/R/sessions/T.json as soon as it is known
         3. process exits → adapter.readResult → validate against the result schema
         4. complete --enforcement-only
              exit 3 → adapter.resume(sessionId, fixed refusal text), at most once, then back to 3
         5. write result, usage and exit reason to sessions/T.json
       print the phase results in the same shape the Workflow path returns
```

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
  spawn({ cwd, prompt, model, effort, sandbox, schemaPath, resultPath, streamPath }) → handle,
  resume({ cwd, sessionId, message, model, effort, sandbox, schemaPath, resultPath, streamPath }) → handle,
  // handle: { child, sessionId: Promise<string|null> }
  readResult({ resultPath }) → object | null,
  readUsage({ streamPath }) → { input, cachedInput, cacheWrite, output, reasoning } | null,
}
```

`spawn` and `resume` start the process and return at once. The driver owns waiting, timeouts,
signals and the enforcement loop, so the adapters stay free of control flow and the tests for that
flow are written once.

### The prompt

`<body of agents/tm-<role>.md without its frontmatter>` + a blank line + the brief from
`composeBrief`. A persona prefix, not a registered harness agent: Codex plugins cannot ship agent
definitions, and a prefix behaves the same on all three harnesses.

`composeBrief` renders the CLI as an absolute path resolved from `import.meta.url`, on every
path including Claude Code. Today the brief emits a literal `$CLAUDE_PLUGIN_ROOT`, which is only
expanded if the teammate's shell happens to have it.

### Branches and worktrees

The driver creates `fleetmates/R/T` itself, forked from the recorded run branch. The implementer
brief's `checkout -B` becomes a no-op on this path, and the Claude Code failure mode where a
teammate skips it and commits to a harness-named branch cannot occur. If the branch already exists
(a fix round or a resumed run), the driver reuses it and never resets it.

`.fleetmates/` is gitignored, so worktrees under it do not dirty the main worktree. The `ownership`
check and `subagent-stop.mjs` have each had defects involving nested worktrees before; the plan
carries a test that gates a phase whose worktrees live under `.fleetmates/`.

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
codex exec --json -C <cwd> -s <sandbox> -m <model> -c model_reasoning_effort=<effort>
           --output-schema <schemaPath> -o <resultPath>          stdin: the prompt, then closed
codex exec resume <sessionId> --json -m … -c … --output-schema <schemaPath> -o <resultPath>
           stdin: the message, then closed
```

- `stdout` goes to `streamPath` (`sessions/T.jsonl`); the adapter resolves `sessionId` from the
  first `thread.started` line. `stderr` goes to `sessions/T.err`.
- `-m` and the effort option are omitted when the role has no configured value, so Codex's own
  defaults apply, the same way the Workflow path omits `model` and `effort`.
- `readUsage` sums `turn.completed.usage` across the stream.
- `probe`: `codex login status` must not say `Not logged in`, and `$CODEX_HOME` (default `~/.codex`)
  must be writable, since section 2 item 8 shows the process dies without it.
- Whether `--output-schema` accepts `RESULT_SCHEMA` as written is **not yet measured**. OpenAI's
  structured output rejects schemas without `additionalProperties: false`. The first plan task
  runs it; if Codex refuses, `result-schema.mjs` gains the property for both paths, which the
  Workflow path tolerates.

## 6. Enforcement

After a teammate's process exits, the driver runs
`complete --run R --task T --plan P --root <project root> --enforcement-only` and reads
the exit status with the contract `subagent-stop.mjs` already consumes:

- **3** (a task-scoped check rejected: `fileset`, `merge`): resume the session once with the same
  fixed text the hook sends today, then run the check again. A second 3 records the task as
  `failed` with `enforcement` as the reason.
- **0, 2, 4**: record and move on. As with the hook, only the teammate's own fixable work may
  cost it a turn.

This is stronger than the hook: the hook resolves a teammate through records under `.fleetmates/`
that teammates can write, while the driver knows which worktree it created. It is still not the
gate. The phase gate stays the only verdict.

## 7. Sandbox

**Teammates.** `harnesses.codex.sandbox`, default `danger-full-access`, allowed values the three
Codex modes. `workspace-write` stays selectable for users who configure writable roots that work;
section 2 item 7 is quoted in the key's documentation so nobody has to re-measure why it is not
the default.

**Orchestrator.** Every CLI command that writes to git (`init-run`, `dispatch*`, `gate`,
`finish`, `prune-run`) starts with a functional preflight: create and remove a file
in `git rev-parse --git-common-dir`. On `EROFS` or `EACCES` it exits 2 naming both ways out:

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
      "sandbox": "danger-full-access",
      "timeoutMinutes": 90,
      "tierModels": { "cheap": "…", "mid": "…", "capable": "…" }
    }
  }
}
```

- Not an enforcement key: nothing in it changes a gate verdict, since `fileset` and `ownership`
  are recomputed from git.
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
  hooks in `/hooks` (without it `using-fleetmates` activates only by its description), and the two
  sandbox facts from section 7.
- **Tests that pin skill text** (`md-contract`, `skill-contracts`, `agents.test.mjs:370`) change
  in the same commits as the text they pin.

## 10. Error handling

| Condition | Result |
|---|---|
| `probe` fails | `dispatch*` exits 2 before creating any worktree, printing the adapter's `fix` (e.g. `run: codex login`). |
| Git common dir not writable | Exit 2, section 7 message. |
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
- **Config.** Valid and invalid `harnesses.codex.*` values through `config set`.
- **Nested worktrees.** Gate a phase whose worktrees live under `.fleetmates/R/worktrees/`:
  `ownership` passes and `fileset` sees each branch's paths.
- **End to end, real Codex.** Skipped automatically when `probe` fails. A three-task plan in a
  scratch repository: `init-run`, `dispatch`, `gate`, `dispatch-integrator`, and a check that the
  run branch holds all three merges. Runs through `npm run test:e2e:codex`, not `npm test`,
  because it spends tokens.

## Out of scope

- Gemini CLI and OpenCode adapters and packaging (sub-projects 2 and 3).
- Mixed fleets (teammates from different harnesses in one run). The adapter boundary allows it
  later, but nothing here selects a harness per task.
- Moving Claude Code onto the driver.
- Codex's in-session multi-agent tools (`spawn_agent`, `send_input`).
- Codex `--worktree` (0.154.0). The driver's worktrees do not depend on it.
