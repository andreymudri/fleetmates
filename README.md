# fleetmates

A Claude Code plugin that runs a written plan across background teammates, each in its own git
worktree, with an automated gate between phases.

You write a plan. The plugin splits it into phases of tasks whose file sets don't overlap,
dispatches one teammate per task, and refuses to move to the next phase until a gate — computed
from git, not from anything an agent reported — says the phase is clean.

Teammates run as Claude Code subagents, or headless through the Codex CLI or the Cursor CLI — see
[Running on Codex](#running-on-codex) and [Running on Cursor](#running-on-cursor).

```
phase 1   T1  T2  T3        3 worktrees, in parallel
  gate    merge · test · fileset · ownership · review
phase 2   T4
  gate    ...
          -> merged to the run branch
```

## Requirements

- Claude Code
- Node.js >= 24.2.0
- git >= 2.24, because every git invocation this plugin makes passes `--end-of-options` to stop
  a ref name beginning with `-` from being parsed as a flag
- A git repository — worktree isolation depends on it

Zero runtime and zero dev dependencies. Tests use the built-in `node:test` runner.

## Install

    /plugin marketplace add andreymudri/fleetmates
    /plugin install fleetmates

The marketplace installs the package published on npm as `fleetmates`, not a checkout. To develop
against a local checkout instead, load the directory directly — skill edits then take effect on
the next session without a publish:

    claude --plugin-dir /path/to/fleetmates

### What installing registers

Beyond the skills and commands, the plugin declares a `SubagentStop` hook with no matcher and
`async: false`. That means **every** subagent stop on this machine — in any project, including one
with no fleetmates run — synchronously spawns `node scripts/subagent-stop.mjs` before the stop is
allowed to complete.

The handler is written to be cheap and to fail open: it resolves the stopping agent through a
worktree location record and returns immediately when it finds none, which is the case for every
subagent outside a run, and any error is an allow. But it is a synchronous spawn on a hot path and
it is machine-wide rather than scoped to this repository, so it is worth knowing before installing.

### Update notices

Claude Code updates plugins in the background and says nothing, so a new version usually arrives
silently. This plugin tells you two things instead.

**Which version you are on, and whether the install actually works.** The first session after the
installed version changes, the plugin reports the change, links its release notes, and confirms
what it found — `ready: 14 skills, 3 agents, cli ok`. Once per version, then silent. No network.

If parts are missing it says so instead, naming them, and repeats that **every** session until
fixed:

    WARNING: fleetmates is installed but NOT fully working. Missing: scripts/cli.mjs.
    Fleet commands and phase gates will fail. Reinstall with /plugin install fleetmates.

Note what this cannot tell you: whether the plugin is *enabled*. Claude Code only runs a plugin's
hooks when `enabledPlugins` has it turned on, so if it were off, nothing here would run to report
it. The check covers the failure you can actually hit with it on — a partial unpack, an interrupted
update, a missing `node`.

**Whether a newer one is published.** A background check compares the installed version against the
published one and reports a newer one on a later session. It runs at most once every 24 hours.

The check is a single `GET` to `https://registry.npmjs.org/fleetmates/latest`, the npm registry's
record of the newest published version, with a five-second timeout. It sends nothing about you, your machine,
or your project beyond the request itself, and it runs in a hook declared `"async": true`, so it
never delays a session. If it fails — offline, proxied, no `curl` — it exits silently, and the
24-hour limit still applies: the attempt is stamped before it is made, so a machine that can never
reach the registry does not retry on every session.

Turn it off with:

    FLEETMATES_UPDATE_CHECK=0

`CLAUDE_TEAMMATES_UPDATE_CHECK=0`, the name from before the rename, still works, so an opt-out set
under the old name is not switched back on.

Both notices keep their state in `${CLAUDE_CONFIG_DIR:-~/.claude}/fleetmates/`: the version
you last saw, and the cached result of the last check. Deleting that directory re-shows the current
version's notice once.

Because the check writes a cache the *next* session reads, a newly published version is reported
one session after the check that found it. That is the cost of never blocking session start.

## Running on Codex

fleetmates also runs headless under Codex CLI, alongside Claude Code, from the same package:

    codex plugin marketplace add andreymudri/fleetmates
    codex plugin add fleetmates@fleetmates
    codex login

The package installs unchanged from the same `.claude-plugin/marketplace.json` — there is no
separate Codex manifest.

**Trust the hooks in `/hooks` after installing.** Without that, `using-fleetmates` activates only
by its description text, not through the `SubagentStop` hook this plugin relies on for
enforcement.

### Sandbox

Teammates run sandboxed in an isolated clone by default (`harnesses.codex.sandbox = "clone"`) —
never unsandboxed. A git-less `files` fallback and `full` (`danger-full-access`) are also
selectable. The orchestrator itself needs full access to write the run repo's git, and exits with
a fixable message if it is started inside a sandbox. Network access is off by default.

In `files` mode the teammate has no repository of its own, so:

- its prompt opens with an override telling it to skip every git step of the implementer
  instructions (task branch, `locate`, commit, commit proof, `complete`);
- fleetmates commits the checkout as **one commit** on the task branch, byte for byte, without
  running git in the checkout;
- a change to `.cursor/*.json`, `.cursor/hooks/`, `.claude/settings*.json` or `.vscode/` is refused
  (the task is orphaned, naming the paths) rather than dropped.

## Running on Cursor

Cursor can run a fleet's teammates. The orchestrator stays whichever harness you drive — Claude
Code or Codex — and passes `--harness cursor` to `dispatch`, `dispatch-reviews`,
`dispatch-integrator` and `message`:

    cursor-agent login

### Sandbox

Cursor runs git itself, outside its own sandbox, so a repository inside a teammate's workspace is a
way out of it. Cursor teammates therefore only ever run in a git-less `files` checkout
(`harnesses.cursor.sandbox` accepts nothing else), always with `--sandbox enabled` and never with
`--force`:

- A Cursor teammate cannot commit. Its prompt opens with an override telling it to skip every git
  step of the implementer instructions, and when it finishes, fleetmates commits its checkout as
  **one commit** on the task branch, byte for byte, without ever pointing git at the checkout.
- Checkouts live under `$XDG_CACHE_HOME/fleetmates/cursor/` (default `~/.cache`), outside the
  repository: Cursor runs the `.cursor/hooks.json` of any git repository that encloses its
  workspace. `dispatch` refuses if that cache directory is itself inside a git repository.
  A checkout is removed once its task is recorded `done`; a blocked, failed or orphaned task keeps
  its checkout, so `message` or a new `dispatch` can resume it there.
- `.cursor/{sandbox,hooks,cli,mcp,worktrees}.json`, `.cursor/hooks/`, `.claude/settings*.json` and
  `.vscode/` are removed from the checkout before every session, without following symlinks at any
  level. A teammate that changes one of them — or replaces `.cursor` or `.claude` with a file or a
  symlink — is orphaned, and that checkout is refused for good; none of those paths ever changes on
  the task branch.
- Network access is off by default; `harnesses.cursor.network = true` turns it on.
- `dispatch` refuses to start while a global `~/.cursor/sandbox.json` widens every sandbox (extra
  writable paths, a non-default `type`, or a network default of `allow`), and warns when a global
  `~/.cursor/hooks.json` exists, because those hooks run outside the sandbox.

### Platforms

The Cursor sandbox behaviour above was measured on Linux. The adapter spawns `cursor-agent`
directly, without a shell, which a Windows `.cmd` shim does not support; running Cursor teammates on
Windows is untested.

### Models and effort

Cursor has no separate effort setting: effort is part of the model id. Map each tier to the variant
you want in `harnesses.cursor.tierModels`, for example
`{ "cheap": "composer-2.5", "mid": "claude-sonnet-5-thinking-high", "capable": "claude-opus-5-high" }`
(`cursor-agent models` lists them). An unmapped tier runs `--model auto`, the only model a free
Cursor plan accepts. `agents.<role>.effort` is ignored for Cursor teammates, and each
session record says so with `effortIgnored: true`.

## Coming from claude-teammates

fleetmates is claude-teammates, renamed. To move over:

1. `/plugin uninstall claude-teammates` — left installed, its hooks keep running beside the new
   ones, and fleetmates warns about it at every session start until it is gone.
2. `/plugin marketplace add andreymudri/fleetmates`, then `/plugin install fleetmates`.
3. Run any fleetmates command once in each repository. The first run moves `.teammates/`,
   `teammates.gate.json`, `teammates.local.json`, the `teammates/<run>/<task>` branches and the
   `refs/teammates/` claim refs to their `fleetmates` names, and adds the new ignore lines next
   to the old ones. It refuses, and changes nothing, while a teammate from an old run is still
   working, or when both spellings of something already exist.

A migration that fails part-way stops, and prints every step it completed with the command that
reverses it.

## Getting started

Say what you want built. The `using-fleetmates` skill routes you: an unclear idea goes to
`brainstorming`, settled requirements go to `writing-plans`, and a written plan with three or
more disjoint tasks offers you a fleet.

A fleet is worth it when tasks genuinely don't overlap. For a two-task change, running it inline
in one session costs less than orchestrating it — the plugin will say so rather than fan out
regardless.

## What the phase gate guarantees

The gate merges the phase's task branches into a scratch worktree and runs its checks there, so
`test` measures what integration will actually produce. It also checks that each teammate's
**committed** changes stayed inside the files its task declared, and that every commit on the run
branch is explained by a task branch or by the base. It computes all of this from git each time
it runs, and trusts nothing an agent wrote — `.fleetmates/` state is written by the very agents
the gate exists to enforce, so no check reads it.

**It is tamper-evident, not tamper-proof.** A teammate runs its own tests, and running a
teammate's code is arbitrary execution — so a determined one can do anything you can. The gate
catches drift and mistakes reliably. It is not a security boundary, and nothing here should be
relied on as one. `docs/specs/2026-08-05-tamper-evident-enforcement-design.md` lists exactly
what is out of scope, and `tests/adversarial.test.mjs` pins each limit with a test.

## Commands

Run everything through `node scripts/cli.mjs <command> --root <project root>`. The skills call
these for you; they are listed here because an operator often wants the same answer directly.

Driving a run:

- `init-run <planPath> --run <id>` — parse the plan, assign phases, write `.fleetmates/<id>/`
- `workflow --run <id> --phase <n>` — generate the phase's implementer dispatches
- `complete --run <id> --task <id>` — a teammate verifying its own task before returning
- `gate --run <id> --plan <path>` — compute the current phase's verdict
- `fix --run <id> --phase <n> --verdict <path>` — decide retry, escalate, or none
- `finish --run <id> --plan <path>` — recompute a verdict for **every** phase, not just the current one

Seeing what is actually there:

- `doctor --run <id> --plan <path>` — the run as git describes it: branch tips, real contributions,
  worktrees, dirty paths. `digest` renders what the agents wrote; this asks git instead
- `liveness --run <id> --plan <path>` — which of the current phase's teammates have committed or
  touched their worktree inside the window (20 minutes by default, `--stale` to change it). Exit 1
  when one has done neither, and only when both signals were measured. Exit 2 whenever it did not
  measure what was asked: no current phase can be named, the run id matches nothing, the
  working-tree plan has no task in that phase, or a teammate's row reads `unknown` — no worktree of
  its branch could be read, or the walk hit its 5000-entry cap. The walk skips what git ignores, so
  a generated directory in .gitignore keeps the report measurable. It is a
  supervision report and nothing else reads it: both signals are forgeable by the teammate they
  describe, so a stalled row is a prompt to look, never gate evidence
- `plan-drift --run <id> --plan <path>` — what changed in the plan since the anchor, and whether it
  changed too late to reach the work
- `digest --run <id>` — the compact fleet status board

Reviews:

- `review-dispatch --run <id>` — generate the reviewer dispatches from the manifest, with the tier,
  findings path and scratch worktree already resolved
- `collect-reviews --run <id>` — rebuild a `gate --results` file from the reviewers' findings drops

One lens carries a method of its own. `claims` reads the diff for sentences asserting a guarantee —
a comment, a skill line, a spec line — then breaks what each one protects and runs the suite: a
claim whose mutation leaves the suite green is a finding. It is bounded, not exhaustive. It probes a
capped number of the claims it enumerates and reports the rest under an `unprobed` key, and it
returns nothing at all when it cannot get a green baseline first.

Housekeeping:

- `preview-check` — validate `preview.link` before a run rather than at the first gate
- `prune-run --run <id> --plan <path>` — remove this run's worktrees, but only where the phase's gate
  recomputes to PASS, and delete each removed worktree's branch where the run branch already
  contains it. Dry run unless `--yes`
- `rebuild-state --run <id> --plan <path>` — reconstruct `.fleetmates/` bookkeeping from git. It
  rebuilds no gate history: a verdict is evidence that checks ran, and git carries branches, not
  evidence
- `.fleetmates/<run-id>/` is never removed by any command. `resume` and `rebuild-state` read it,
  it is gitignored, and deleting it is the operator's call — an age-based sweep would take the
  only record of a run someone is in the middle of resuming

## Skills

- `using-fleetmates` — entrypoint; routes to the right process or fleet skill before anything else happens
- `brainstorming` — explores intent and design before implementation
- `writing-plans` — turns a spec into a plan this plugin can parse, phase, and dispatch to a fleet
- `executing-plans` — executes a written plan inline in this session, with checkpoints
- `parallel-execution` — splits a plan into phases and dispatches worktree-isolated implementers
- `fleet-lifecycle` — spawns, lists, messages, scales, stops, or resumes background teammates
- `fleet-supervision` — renders the fleet digest and surfaces blocked or failed teammates
- `phase-gate` — runs command, agent, and MCP checks and decides PASS or FAIL for a finished phase
- `test-driven-development` — write the failing test first and watch it fail for the right reason
- `systematic-debugging` — reproduce and isolate before changing anything
- `receiving-code-review` — verify feedback technically rather than agreeing performatively
- `finishing-a-development-branch` — re-runs the gate to verify each phase, then decides how the run branch lands
- `writing-skills` — creating, editing, and verifying skills before deployment

## Gate manifest

Copy `fleetmates.gate.json` into any project the fleet runs in, or let
`node scripts/cli.mjs gate --run <id>` infer one from `package.json` and print it for you to
confirm. A project whose test runner is itself a dependency should declare what to link into the
preview:

```json
{ "preview": { "link": ["node_modules"] } }
```

The preview contains tracked content only, so without that a command check runs against a tree
with no dependencies installed and fails for a reason that has nothing to do with the code.

## Configuration

Two files, split by trust rather than by topic.

**`fleetmates.gate.json`** is tracked. Alongside the manifest above it holds every key that can
change a verdict: `phases` (the checks and their fix-round budgets), `lens`, `preview`, and
`agents.reviewer.tier` / `agents.reviewer.effort`. Those go here and nowhere else — see
`SECURITY.md` for why the reviewer's tier counts as enforcement.

**`fleetmates.local.json`** is gitignored and holds machine-local ergonomics. Allowlisted keys,
and nothing else:

| Key | Domain | Default |
|---|---|---|
| `maxParallel` | integer >= 1 | `max(1, min(8, cores - 2))` |
| `caveman` | `false \| "lite" \| "full" \| "ultra"` | `false` |
| `agents.<role>.tier` | `"cheap" \| "mid" \| "capable"` | unset — see below |
| `agents.<role>.effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | unset — inherits the session's |

`<role>` is `implementer` or `integrator` in the local file; `reviewer` is accepted only in the
tracked manifest. An unknown key, or an enforcement key in the local file, is a hard error naming
the key — a setting that was silently dropped is a setting you believe took effect.

An unset tier resolves differently per role, so "default" is not one answer. The **implementer**
tier is inferred per task by `init-run` from the plan; a configured value overrides that
inference for every task. The **reviewer** and **integrator** are not in the plan and are not
inferred: the dispatching skill fixes them at `capable` and `mid`, and a configured tier replaces
that fixed choice.

### `caveman` is narrower than its position in that table suggests

Measured 2026-08-25 against real subagent transcripts, because it had been carried for a session
as the largest remaining token lever and is not one.

`caveman` has exactly two consumers: it rewrites the **implementer** brief, and it renders the
local `digest` output terse. Reviewer and integrator dispatches carry no caveman path, so the
reviewers — the largest emitters in a run — are unaffected by any value you set. Inside the
implementer brief the instruction is scoped to the returned summary and blockers, and that summary
is the last message an agent emits, so it is re-read zero times by the agent that wrote it.

The caveman brief is **larger** than the default by about 3%: the added STYLE block costs more
than compressing the connective prose saves, and a brief sits in the prefix, so that cost is
re-read every turn. The three levels are validated but not honoured by this plugin's own code —
`digest` reads only whether the value is truthy, and the brief passes the level through to an
external `caveman:caveman` skill, instructing the agent to apply the style directly when that
skill is absent.

If a run's output cost is the problem, reach for `agents.<role>.effort`. Thinking is 72-76% of an
agent's output tokens; `effort` is the control for thinking and no style instruction can touch it.
Lowering it trades review depth for tokens, which `caveman` does not.

### The four subcommands manage ergonomics, not enforcement

    node scripts/cli.mjs config list
    node scripts/cli.mjs config get maxParallel
    node scripts/cli.mjs config set <key> <value> [--local]
    node scripts/cli.mjs config unset <key> [--local]

`get`, `set` and `unset` accept only the four ergonomics keys in the table above. They do **not**
accept `phases`, `lens` or `preview` in either file — including without `--local`:

    $ node scripts/cli.mjs config set lens correctness
    unknown config key: lens        # exit 2

That is deliberate, not a gap. Enforcement policy is edited **by hand** in `fleetmates.gate.json`
so it lands as a reviewable diff rather than as a CLI mutation that leaves nothing to read.

**Check a hand edit with `config list`.** It *validates* more than it *prints*, and the two sets
are worth keeping apart. What it prints is fixed: the eight ergonomics rows in the worked example
below, and nothing else — `phases`, `lens` and `preview` never appear in its output. What it
validates is the whole of both layers, so it exits 2 with a message on a file that is no longer
valid JSON, a malformed ergonomics key, or a badly *shaped* enforcement key:

    $ node scripts/cli.mjs config list          # fleetmates.gate.json holds "lens": "performance"
    lens must be a non-empty array of strings   # exit 2

To read back an enforcement key's value, open `fleetmates.gate.json`. No subcommand will show it.

**`config list` checks shape, not content, and the difference bites.** A `lens` of `["nonsense"]`
is a well-shaped array of strings, so it is accepted, and `config list` exits 0 without printing
it. Whether those lens names mean anything to a reviewer is only exercised when the next `gate`
dispatches one — the same is true of a check's `run` string or a `preview.link` path. Shape is
structure and the CLI can see it; content is policy and only a real run can.

**Do not reach for `config get` here.** It rejects every enforcement key by name, in either file,
and that rejection says nothing about the manifest:

    $ node scripts/cli.mjs config get lens
    unknown config key: lens                    # exit 2

`config list` is the verification step; `config get` is for the ergonomics keys in the table above.

`list` reads both layers; `set` and `unset` write the tracked manifest unless you pass `--local`.

Worked example — raise the fan-out on a large machine without committing that choice:

    $ node scripts/cli.mjs config set maxParallel 12 --local
    wrote fleetmates.local.json

    $ node scripts/cli.mjs config list
    maxParallel  12  (fleetmates.local.json)
    caveman      false  (default)
    agents.implementer.tier    -  (default)
    agents.implementer.effort  -  (default)
    agents.reviewer.tier    -  (default)
    agents.reviewer.effort  -  (default)
    agents.integrator.tier    -  (default)
    agents.integrator.effort  -  (default)

In a project whose `.gitignore` does not yet exclude the file, `config set --local` adds the
entry and reports `added fleetmates.local.json to .gitignore` on a second line. This repository
already carries that entry, so the transcript above is what you get here.

`config list` prints the layer each *ergonomics* value came from, so a value you did not expect
can be traced to the file that set it.

**Model names never appear in either file.** Configuration stores a *tier* — `cheap`, `mid` or
`capable`. The map from tier to a concrete model lives in the dispatching skill and reaches the
CLI through `workflow --models`, so this repository and `fleetmates.gate.json` stay free of model
names that would otherwise go stale. Setting a model name as a tier is rejected.

## Layout

- `skills/` — process and human interaction (entrypoint: `using-fleetmates`)
- `agents/` — `tm-implementer`, `tm-reviewer`, `tm-integrator`
- `scripts/` — deterministic logic, driven via `scripts/cli.mjs`
- `templates/` — generated Workflow source
- `hooks/` — SessionStart context injection
- `fleetmates.gate.json` — this plugin's own phase gate

## Development

    npm test

Prints failures and one summary line — nothing per passing test. For the full per-test output:

    npm run test:verbose

The suite's pass lines were about 40,000 tokens of output. That mattered more than it looks:
every agent in a fleet run is told to run `npm test`, some of them repeatedly, and anything
sitting in an agent's context is re-read on every later turn. Measured across three real agents,
cache reads were 2.19M tokens against 212 tokens of fresh input.

Design notes: `docs/specs/`.

## License

MIT — see `LICENSE`.

Some skills are adapted from [superpowers](https://github.com/obra/superpowers) (© Jesse Vincent,
MIT). See `NOTICE.md` for what was adapted and `LICENSE-THIRD-PARTY` for the license text.
