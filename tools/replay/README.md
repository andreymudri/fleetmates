# tools/replay — controlled tier replay

An operator tool, Claude-only. It is not part of the npm package: the root `package.json`
`files` list does not include `tools/`.

## What it measures

`replay.mjs` re-runs tasks that already landed in real fleet runs, once per tier (`cheap`,
`mid`, `capable`), each as a fresh headless `claude -p` session on the model that tier maps to.
For every cell it records the pass/fail outcome, `total_cost_usd` as the session reports it (list
price), wall-clock time, turns and whether a fix round was needed. From those records it writes
per-tier means and a cost matrix to `loss.json`.

Tasks are discovered from `.fleetmates/<run>/plan.json` under each `--roots` directory, and only
tasks whose work is on the repository's default branch count as landed. Each cell starts from
the task's base tree only: `git archive` of the base commit, extracted into a fresh single-commit
repository under `$TMPDIR` and removed afterwards. The source repository is only read, never
written.

**Pass rule.** A cell passes when, after the session (and at most one `--resume` fix round):

- every `command` check of the task's own phase in the gate manifest, as committed at the base
  commit, passes; and
- the change is non-empty, touches at least one declared file and touches nothing outside the
  task's declared files.

A session that reports any permission denial makes the cell invalid rather than failed: nothing
is recorded and the run stops. A usage-limit error also stops the run with nothing recorded for
that cell. Rerunning the same command resumes at the first missing `(task, tier)` pair.

Only a hashed key (`sha256(repo realpath, run id, task id)`) and metrics are written to
`data/replay-results.jsonl`. Task text, briefs and code are never written. The key is
pseudonymous, not secret: it is unsalted and exists for dedupe and resume, so anyone who can
guess a repository path, run slug and task id can recompute it and match it to a record. 11 of
the 30 committed keys were recovered that way from this repository's own run list. What such a
match reveals is that task's metrics, nothing more.

## Running it

Every mode except `--dry-run` and `--recompute-loss` starts real `claude -p` sessions under the
account `claude` is logged into, so it uses your Claude subscription usage (a full 30-task run
is 90 cells, each one session plus at most one fix round, plus the preflight). Sessions run
with `--permission-mode bypassPermissions` and `--strict-mcp-config`: tool calls run unattended
with your own OS permissions, and `$TMPDIR` is a starting directory, not a sandbox.

Models come from `--models '{"cheap":"...","mid":"...","capable":"..."}'`, or else from
`harnesses.claude.tierModels` in `fleetmates.local.json` in the current directory.

```sh
# List the cells that would run; starts no session and writes nothing.
node tools/replay/replay.mjs --roots ~/Work/projetos --count 30 --dry-run

# Preflight: one session in a scratch repo must create a file with zero permission denials.
node tools/replay/replay.mjs --preflight --models '{"cheap":"haiku","mid":"sonnet","capable":"opus"}'

# Smoke: one cell at the capable tier on the first selected task. Records nothing.
node tools/replay/replay.mjs --roots ~/Work/projetos --smoke --models '{"cheap":"haiku","mid":"sonnet","capable":"opus"}'

# Execute: runs the preflight first, then every missing cell, then rewrites loss.json.
node tools/replay/replay.mjs --roots ~/Work/projetos --count 30 --execute --models '{"cheap":"haiku","mid":"sonnet","capable":"opus"}'
```

`--seed N` changes the task sample (default `20260922`). `--out <dir>` sets where `--execute`
and `--recompute-loss` read and write `replay-results.jsonl` and `loss.json` (default
`tools/replay/data/`). `--dry-run` and `--smoke` write neither file.

## Rereading the tier costs after a model or pricing change

The cost of each cell is the `total_cost_usd` its session reported at the time, so neither a new
model nor a new price list changes the committed numbers. To measure again:

1. Pick an empty output directory, for example `tools/replay/data/2026-10-rerun/`. `--execute`
   skips every `(task, tier)` pair already in the output directory's `replay-results.jsonl`, so
   a run on top of the committed file records nothing new.
2. Run `--preflight`, then `--execute --out <that dir>` with the new `--models` mapping and the
   same `--roots`, `--count` and `--seed`.
3. Read `tierMeans` and `costMatrix` in that directory's `loss.json`. To make it the committed
   measurement, replace the two files in `tools/replay/data/` with the new ones and update the
   table below.

When only the loss formula in `computeLoss` changes, the data does not need rerunning:

```sh
node tools/replay/replay.mjs --recompute-loss --out tools/replay/data/ [--seed N]
```

It reads `replay-results.jsonl` in `--out`, starts no session, leaves that file byte-identical and
rewrites `loss.json`, keeping the existing `tierModels` and recording the bootstrap `seed` it used.
It exits 2 without writing `loss.json` when `replay-results.jsonl` is absent or has no records.

## Current per-tier means

From `data/replay-results.jsonl`: 30 landed tasks, 90 cells, recorded 2026-09-23 to 2026-09-24.

| tier | model | passed | mean cost (US$, list price) | mean wall-clock | fix rounds |
|---|---|---|---|---|---|
| cheap | haiku | 26/30 | 1.09 | 10.6 min | 9 |
| mid | sonnet | 29/30 | 3.87 | 14.1 min | 6 |
| capable | opus | 29/30 | 1.52 | 5.4 min | 2 |

Tier cost is not monotonic: opus averaged 21 turns per cell against sonnet's 57 and came out
cheaper and faster per task. `loss.json`'s `costMatrix` is built from these means. Its
`underOverRatio` assumes cost rises with tier, and its bootstrap interval spans from about -189
to 257, so it is reported only.
