# fleetmates

**A Claude Code plugin that runs a written plan across background teammates, each in its own git
worktree, with an automated gate between phases.**

[![npm](https://img.shields.io/npm/v/fleetmates?color=cb3837&logo=npm)](https://www.npmjs.com/package/fleetmates) [![test](https://github.com/andreymudri/fleetmates/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/andreymudri/fleetmates/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node >=24.2.0](https://img.shields.io/badge/node-%3E%3D24.2.0-339933?logo=node.js&logoColor=white)](package.json) [![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

![How a fleetmates run works: a plan of three tasks that each declare their files, init-run grouping them into two phases, two teammates working in parallel on their own branches, the gate checking merge, test, fileset and ownership and the integrator merging, then a phase 2 gate failing fileset because T3 edited src/middleware/auth.mjs outside its declared files, a fix round, and the run passing every phase](https://raw.githubusercontent.com/andreymudri/fleetmates/master/docs/media/fleetmates-demo.gif)

*One real run on a demo todo-api. The plan, branch names, check names and verdicts are the run's own; the teammates' commits
were scripted.*

You write a plan. The plugin splits it into phases of tasks whose file sets don't overlap,
dispatches one teammate per task, and refuses to move to the next phase until a gate — computed
from git, not from anything an agent reported — says the phase is clean.

Teammates run as Claude Code subagents, or headless through the Codex CLI or the Cursor CLI — see
[Running on Codex](#running-on-codex) and [Running on Cursor](#running-on-cursor).

## Why fleetmates

- **Parallel teammates in isolated worktrees.** Each task gets its own git worktree and branch, so
  teammates in the same phase never edit the same checkout.
- **A phase gate computed from git.** Merge, test, fileset and ownership checks run on the merged
  tree, plus any command, agent or MCP checks the manifest declares. Nothing an agent wrote under
  `.fleetmates/` decides a verdict.
- **Declared file sets.** A task may change only the files its plan lists. A change outside them
  fails `fileset` and names the path.
- **Fix rounds with a budget.** After a failed gate, `fix` decides whether to retry, escalate or do
  nothing, within the phase's `fixRounds` budget.
- **Review lenses.** Reviewers run one lens each (for example correctness, security, tests or
  `claims`), and the manifest decides which severities block.
- **Codex and Cursor harnesses.** The same plan, gate and result contract, dispatched headless
  through the Codex CLI or the Cursor CLI.
- **A local deck.** An optional web UI in `hub/` shows which session needs you and mirrors the
  team run.
- **Zero dependencies.** No runtime or dev dependencies; tests use the built-in `node:test` runner.

## Quick start

Requirements:

- Claude Code
- Node.js >= 24.2.0
- git >= 2.24, because every git invocation this plugin makes passes `--end-of-options` to stop
  a ref name beginning with `-` from being parsed as a flag
- A git repository — worktree isolation depends on it

Zero runtime and zero dev dependencies. Tests use the built-in `node:test` runner.

Install the plugin in Claude Code:

    /plugin marketplace add andreymudri/fleetmates
    /plugin install fleetmates

The marketplace installs the package published on npm as `fleetmates`, not a checkout. To develop
against a local checkout instead, load the directory directly — skill edits then take effect on
the next session without a publish:

    claude --plugin-dir /path/to/fleetmates

Then:

Say what you want built. The `using-fleetmates` skill routes you: an unclear idea goes to
`brainstorming`, settled requirements go to `writing-plans`, and a written plan with three or
more disjoint tasks offers you a fleet.

A fleet is worth it when tasks genuinely don't overlap. For a two-task change, running it inline
in one session costs less than orchestrating it — the plugin will say so rather than fan out
regardless.

Installing registers a machine-wide synchronous `SubagentStop` hook, a main-session `Stop` guard
and an update check that runs at most once a day. [docs/reference/installation.md](docs/reference/installation.md) says
exactly what each one does and how to turn the update check off.

## How it works

```
phase 1   T1  T2  T3        3 worktrees, in parallel
  gate    merge · test · fileset · ownership · review
phase 2   T4
  gate    ...
          -> merged to the run branch
```

1. **Plan.** Each task in the plan declares the files it may touch (`**Files:**`) and the tasks it
   depends on (`**Depends:**`). The `writing-plans` skill produces this format.
2. **Phases.** `init-run` groups tasks whose dependencies are met and whose file sets are disjoint
   into phases.
3. **Teammates.** Each task in a phase goes to its own teammate, in its own worktree, on the
   branch `fleetmates/<run>/<task>`.
4. **Gate.** When the phase finishes, the gate merges its branches into a scratch worktree and runs
   its checks there. Only on PASS does the integrator merge the branches into the run branch.
5. **Land.** `finish` recomputes the verdict of every phase before the run branch lands.

The GIF above walks through one such run, including a gate that catches a file changed outside its
declared set.

### What the phase gate guarantees

The gate merges the phase's task branches into a scratch worktree and runs its checks there, so
`test` measures what integration will actually produce. It also checks that each teammate's
**committed** changes stayed inside the files its task declared, and that every commit on the run
branch is explained by a task branch or by the base. Those two checks run whether or not the
manifest lists them, and a task may change the manifest itself — or any path in its `protected`
list — only when its plan line marks it `(protected)`. It computes all of this from git each time
it runs, and trusts nothing an agent wrote — `.fleetmates/` state is written by the very agents
the gate exists to enforce, so no check reads it.

**It is tamper-evident, not tamper-proof.** A teammate runs its own tests, and running a
teammate's code is arbitrary execution — so a determined one can do anything you can. The gate
catches drift and mistakes reliably. It is not a security boundary, and nothing here should be
relied on as one. `docs/specs/2026-08-05-tamper-evident-enforcement-design.md` lists exactly
what is out of scope, and `tests/adversarial.test.mjs` pins each limit with a test.

## fleetmates deck

A local web deck in `hub/` that watches your Claude Code sessions and tells you which one needs
you. It is a separate package with its own dependencies, not yet published; the plugin above does
not need it.

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/andreymudri/fleetmates/master/hub/docs/screenshots/home.png" alt="The deck's Home: three sessions waiting on you (a Safe npm run test, a Destructive rm -rf dist and a question), a fleetmates team run in phase 2 and a running session"></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/andreymudri/fleetmates/master/hub/docs/screenshots/team.png" alt="The Team run page of a fleetmates run: phase 1 done with gate 1 passed, task T3 of phase 2 running after gate 2 failed on fileset, and the lead session's tool steps"></td>
  </tr>
  <tr>
    <td><em>Home: which session is working, which one needs you, and the team run.</em></td>
    <td><em>Team run: phases, gates and tasks of a fleetmates run.</em></td>
  </tr>
</table>

From a checkout, on Linux with systemd:

    npm ci --prefix hub && npm --prefix hub run build
    node scripts/cli.mjs deck init
    node scripts/cli.mjs ui

`node scripts/cli.mjs deck <init|doctor|status|open|uninstall-hooks>` forwards to the deck's own
`fleetmates-deck` command, and `ui` is `deck open`; both refuse with the install command when
`hub/node_modules` is missing. See [hub/README.md](hub/README.md) for requirements, security and
uninstall, and [docs/deck/](docs/deck/) for the design.

## Reference

### Commands

Run everything through `node scripts/cli.mjs <command> --root <project root>`. The skills call
these for you; they are listed here because an operator often wants the same answer directly.

Driving a run:

- `init-run <planPath> --run <id>` — parse the plan, assign phases, write `.fleetmates/<id>/`
- `workflow --run <id> --phase <n>` — generate the phase's implementer dispatches
- `complete --run <id> --task <id>` — a teammate verifying its own task before returning
- `gate --run <id> --plan <path>`: compute the current phase's verdict. Exit 0 is PASS, 1 FAIL, 2 a
  broken manifest and 3 no manifest. Exit 5 is a FAIL whose only failed entries are `derive` and/or
  `run-state`: the gate could not establish the run, plan or run state it was asked to judge, so no
  check judged the work. A check that failed beside `run-state` keeps exit 1
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

How reviewers check the task specification, how the instruction security lint works, and how
the `claims` lens probes claims by mutation are covered in [docs/reference/reviews.md](docs/reference/reviews.md).

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

### Skills

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

### Gate manifest

Copy `fleetmates.gate.json` into any project the fleet runs in, or let
`node scripts/cli.mjs gate --run <id>` infer one from `package.json` and print it for you to
confirm. `fileset` and `ownership` run on every phase even when the manifest omits them. Linking
dependencies into the preview, protected paths, JUnit reports and declared skips are covered in
[docs/reference/gate-manifest.md](docs/reference/gate-manifest.md).

### Configuration

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
inferred: the dispatching skill fixes them at `capable` and `cheap`, and a configured tier replaces
that fixed choice. The integrator's `cheap` comes from a replay, recorded in
`tools/replay/data/integrator-verdict.json`: haiku and sonnet each passed 14 of 14 past
integrations with no wrong-tree result, at a mean US$0.049 against US$0.171. None of those
integrations had a conflict, so the replay covered clean integrations only. The integrator now
escalates every conflict ([`agents/tm-integrator.md`](agents/tm-integrator.md)), so it never
resolves one on any model. Set `agents.integrator.tier` to route integration higher.

The `config list|get|set|unset` subcommands and how to check a hand edit are covered in
[docs/reference/configuration.md](docs/reference/configuration.md).

#### `caveman` is narrower than its position in that table suggests

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

#### Why `mid` runs on opus

On the Claude harness the map is `cheap -> haiku`, `mid -> opus`, `capable -> opus`. A replay of
30 tasks that had already merged in real runs, each rerun at every tier from its base tree:

| tier | model | passed | mean cost (US$, list price) | mean wall-clock |
|---|---|---|---|---|
| cheap | haiku | 26/30 | 1.09 | 10.6 min |
| mid (before) | sonnet | 29/30 | 3.87 | 14.1 min |
| capable | opus | 29/30 | 1.52 | 5.4 min |

Opus passed as many tasks as sonnet at under half the mean cost and wall-clock, so `mid` now
dispatches to opus. The data and the tool that reran it are in
[`tools/replay/`](tools/replay/README.md). Codex and Cursor keep their own
`harnesses.<name>.tierModels`; nothing here was measured on them.

To restore sonnet for `mid`, change the map on the dispatch side, not in configuration: dispatch
`mid` tasks on sonnet and pass
`--models '{"cheap":"haiku","mid":"sonnet","capable":"opus"}'` to `workflow`.

### Running on Codex

fleetmates also runs headless under Codex CLI, alongside Claude Code, from the same package:

    codex plugin marketplace add andreymudri/fleetmates
    codex plugin add fleetmates@fleetmates
    codex login

Trust the hooks in `/hooks` after installing. Teammates run sandboxed in an isolated clone by
default (`harnesses.codex.sandbox = "clone"`). Sandbox modes, the `files` fallback and network
access are covered in [docs/reference/harnesses.md](docs/reference/harnesses.md#running-on-codex).

### Running on Cursor

Cursor can run a fleet's teammates while Claude Code or Codex stays the orchestrator: pass
`--harness cursor` to `dispatch`, `dispatch-reviews`, `dispatch-integrator` and `message`, after

    cursor-agent login

Cursor teammates always run in a git-less `files` checkout with the sandbox enabled. The sandbox
rules, platforms and model mapping are covered in
[docs/reference/harnesses.md](docs/reference/harnesses.md#running-on-cursor).

### Execution, recovery and diagnostics

The event ledger, hook diagnostics (`doctor --hooks`), reviewer outcome reports and the bounded
execution commands (`environment-check`, `workflow-execute` and the rest) are documented in
[docs/reference/execution.md](docs/reference/execution.md).

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

Design notes live in [docs/specs/](docs/specs/), and the deck's design in [docs/deck/](docs/deck/).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: the project has no
dependencies, and every new test must be shown to fail before it is trusted.

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

## License

MIT — see `LICENSE`.

Some skills are adapted from [superpowers](https://github.com/obra/superpowers) (© Jesse Vincent,
MIT). See `NOTICE.md` for what was adapted and `LICENSE-THIRD-PARTY` for the license text.
