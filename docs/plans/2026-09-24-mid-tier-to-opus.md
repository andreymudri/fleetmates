# Route the `mid` tier to opus, and measure the integrator on haiku

Date: 2026-09-24. Target release: **2.2.0**.

## Why

The tier-classifier run (archived, never merged; outcome in
`docs/specs/2026-09-22-neural-tier-classifier-notes.md`) replayed 30 real, already-merged tasks
at every tier with Claude:

| tier | model | passed | mean cost (US$, list price) | mean wall-clock |
|---|---|---|---|---|
| cheap | haiku | 26/30 | 1.09 | 10.6 min |
| mid | sonnet | 29/30 | 3.87 | 14.1 min |
| capable | opus | 29/30 | 1.52 | 5.4 min |

Opus completes a task in far fewer turns than sonnet, so on this evidence it is cheaper and
faster per task. Under the measured cost matrix the fixed policy "always capable" beat the
trained classifier. The saving is in not using sonnet for implementers.

## Decisions already made

| Question | Decision |
|---|---|
| What changes | The Claude tier→model map for implementer dispatches: `cheap -> haiku`, `mid -> opus`, `capable -> opus`. The tiers, the heuristic, `escalateTier`, the gates and the reviewer (`capable` -> opus) are unchanged. |
| Evidence | The existing 30-task replay is enough. Its data is salvaged into the repo with the tool. |
| Cost proxy | The session's `total_cost_usd` (list price). The operator's subscription draws opus and sonnet from a shared pool, so list price is a fair proxy. |
| Integrator | Measured, not assumed. Census the integrator's real work, then replay past integrations on haiku with sonnet as the control. If haiku holds, the integrator's fixed tier becomes `cheap`. Otherwise it keeps an explicit `sonnet`, which is the only role outside the tier map. |
| Other harnesses | Codex and Cursor keep their own `harnesses.<name>.tierModels`. Nothing here was measured on them. |
| Release | 2.2.0 (minor). The mapping is a default. Release notes give the evidence and how to restore sonnet. |
| Replay tool | Salvaged to `tools/replay/`, Claude-only, an operator tool that is not in the npm package's `files`. |

## Global Constraints

- Node >= 24.2.0
- ESM only; two-space indent; no semicolons; match surrounding style
- Root `package.json` keeps zero runtime dependencies and zero dev dependencies; `tools/replay/` adds no dependency either
- `npm test` never opens a network connection, never starts a model session and never requires Python
- Replay tooling never modifies another repository; replay cells clone into `$TMPDIR`
- Only hashed keys and metrics are committed from replays, never task text, briefs or code
- Model names appear only in skill text and replay tooling, never in `fleetmates.gate.json` or `fleetmates.local.json`
- Commit messages: single-line summary, commitlint style, English, no co-author or tool attribution trailers
- `npm test` green after every task

## Destination

A fleet on the Claude harness dispatches `mid` implementer tasks to opus by default, and runs
the integrator on the cheapest model the integrator measurement supports. `tools/replay/` can
rerun the evidence whenever models or prices change.

## Out of Scope

- A tier classifier of any kind — the archived run showed "always capable" beating it; revisit only after a new replay shows tier cost is monotonic again.
- Changing Codex or Cursor defaults — no replay was run on those harnesses.
- Reviewer routing — the reviewer already runs at `capable`, which maps to opus before and after.

## Operator checkpoints

1. **After T3:** run the integrator census and the integrator replay on this machine:
   - `node tools/replay/integrator-census.mjs --roots <comma-separated repo roots> --out tools/replay/data/`
   - `node tools/replay/integrator-replay.mjs --roots <same> --count 15 --models '{"candidate":"haiku","control":"sonnet"}' --execute`

   Commit `tools/replay/data/integrator-census.json`, `tools/replay/data/integrator-replay.jsonl`
   and `tools/replay/data/integrator-verdict.json` on the base branch, then merge the base into
   the run branch. T4 is dispatched only after this.

### Task 1: salvage the replay tool and cost-matrix loss into tools/replay/

The tool and its data exist on the archived branch `run/tier-classifier` at
`tools/classifier/replay.mjs`, `tests/classifier-replay.test.mjs`,
`tools/classifier/data/replay-results.jsonl` and `tools/classifier/data/loss.json`.

**Files:**
- Create: `tools/replay/replay.mjs`
- Create: `tools/replay/README.md`
- Create: `tools/replay/data/replay-results.jsonl`
- Create: `tools/replay/data/loss.json`
- Test: `tests/replay.test.mjs`

**Model:** mid

- [ ] **Step 1:** Copy the four files from `run/tier-classifier` with
  `git show run/tier-classifier:<path>` to the new paths. Fix the imports, the default output
  directory (`tools/replay/data/`) and the test's import path. Remove every reference to the
  classifier (the dataset, labels, evaluate.mjs, the tier-model). Keep the cost-matrix
  computation (`computeLoss`, `lossVersion: 2`), `--strict-mcp-config`,
  `--permission-mode bypassPermissions`, `--preflight`, `--smoke` and `--recompute-loss`.
- [ ] **Step 2:** Fix the two open follow-ups from the archived run, test first:
  - `--recompute-loss` refuses with exit 2, naming the missing file, when
    `replay-results.jsonl` is absent. It never overwrites `loss.json` from zero records.
  - `--recompute-loss` honours `--seed` and records the seed it used in `loss.json`.
- [ ] **Step 3:** Run `node tools/replay/replay.mjs --recompute-loss --out tools/replay/data/`.
  `replay-results.jsonl` must stay byte-identical to the archived copy. `loss.json` must match
  the archived one except `date` and the added `seed`.
- [ ] **Step 4:** Write `tools/replay/README.md` covering:
  - what the tool measures and the pass rule;
  - how to run preflight, smoke and execute;
  - that it uses subscription usage;
  - how to reread the tier costs after a model or pricing change;
  - the current per-tier means table.
- [ ] **Step 5:** Confirm `package.json` `files` does not include `tools/`, and do not change it.
  `npm test` green; commit `feat(replay): salvage the replay tool and cost-matrix loss from the classifier run`.

### Task 2: integrator census

How much judgement does the integrator actually exercise? Measure the work, not the model.

**Files:**
- Create: `tools/replay/integrator-census.mjs`
- Test: `tests/integrator-census.test.mjs`

**Model:** mid

- [ ] **Step 1:** Write failing tests against fixture repositories for a census over local fleet
  runs. For every integration merge on a `run/*` branch (a `--no-ff` merge whose second parent is
  a `fleetmates/<run>/<task>` or `teammates/<run>/<task>` tip), record:
  - the run and the phase;
  - the number of branches merged in that phase;
  - whether the merge needed conflict resolution (its tree differs from a clean
    `git merge-tree` of its parents);
  - whether the integrator committed anything that is not a merge;
  - whether the message matches the dispatched single-line form;
  - from `.fleetmates/<run>/status.json`, whether the integration was escalated or reported
    `blocked`.
- [ ] **Step 2:** Where Claude Code session transcripts exist, join integrator sessions (agent
  type `tm-integrator`) through the same reader `cli.mjs usage` uses. Record their model, turns
  and output tokens. A missing transcript is recorded as missing, never as 0.
- [ ] **Step 3:** Implement
  `node tools/replay/integrator-census.mjs --roots <a,b> --out <dir>`. Dry run by default;
  `--execute` writes `integrator-census.json` with per-integration rows (hashed keys only) and a
  summary:
  - the share of clean integrations;
  - the conflict count;
  - the escalation count;
  - the median and p90 turns;
  - the model mix.
- [ ] **Step 4:** `npm test` green; commit `feat(replay): integrator census over local runs`.

### Task 3: integrator replay, haiku against sonnet

**Files:**
- Create: `tools/replay/integrator-replay.mjs`
- Test: `tests/integrator-replay.test.mjs`

**Depends:** T1

**Model:** capable

- [ ] **Step 1:** Write failing tests with a fake `claude` executable and fixture repositories.
  For each sampled past integration, the tool builds a scratch clone under `$TMPDIR` containing:
  - the run branch at the merge's first parent;
  - every task branch at its merged tip. Branches are recreated from the merges' second-parent
    SHAs, because pruned task branches no longer exist as refs.

  It then runs the integrator in that clone:
  - the command is `claude -p --model <m> --output-format json --permission-mode bypassPermissions --strict-mcp-config`;
  - the system prompt is the body of `agents/tm-integrator.md`, passed with `--append-system-prompt`;
  - the dispatch prompt names the branches in the recorded order and the exact merge messages.
- [ ] **Step 2:** The pass rule for a cell is all of:
  - the final tree equals the recorded integration's tree;
  - every commit on the run branch is a `--no-ff` merge carrying exactly the dispatched
    single-line message and no trailers;
  - no extra commits;
  - the project's test command passes.

  A permission denial marks the cell invalid, never a pass.
- [ ] **Step 3:** Sampling:
  - `--count N` picks N integrations with a fixed seed;
  - integrations the census marks as conflicted are over-sampled, so the hard cases are
    represented;
  - the same sample runs for `candidate` and `control`.
- [ ] **Step 4:** Output `integrator-replay.jsonl`, with one row per cell: hashed key, model,
  status, failReason, turns, cost and wall-clock. Output `integrator-verdict.json` from this rule:
  - **`cheap`** when haiku's pass count is at least sonnet's, haiku has zero wrong-tree results,
    and haiku's mean cost is lower;
  - **`sonnet`** otherwise.

  The verdict records the counts, the rule and the sample size.
- [ ] **Step 5:** Implement preflight (one cell, then check permission denials), smoke and
  execute, the same way `tools/replay/replay.mjs` does. Reuse its clone and preview helpers by
  import, never by copying them. `npm test` green; commit
  `feat(replay): integrator replay comparing a candidate model to a control`.

### Task 4: route `mid` to opus and apply the integrator verdict

**Files:**
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `skills/fleetmates-config/SKILL.md`
- Modify: `README.md`
- Test: `tests/skill-model-map.test.mjs`

**Depends:** T1, T2, T3

**Model:** mid

- [ ] **Step 1:** Write a failing test that reads `skills/parallel-execution/SKILL.md` and
  asserts:
  - the dispatch map is exactly `cheap -> haiku`, `mid -> opus`, `capable -> opus`;
  - the workflow example passes `--models '{"cheap":"haiku","mid":"opus","capable":"opus"}'`;
  - the integrator's fixed role model matches `tools/replay/data/integrator-verdict.json`.

  Strip comments before asserting, per the repo's source-text assertion convention.
- [ ] **Step 2:** Update the map, the workflow example and every sentence that says `mid` means
  sonnet. Apply the verdict:
  - if the verdict is `cheap`, the integrator's fixed tier becomes `cheap` (haiku);
  - if it is `sonnet`, the integrator keeps `mid`'s old model as an explicit role model
    (`sonnet`), stated as the one role outside the tier map, with the verdict file cited.

  A configured `agents.integrator.tier` still replaces the fixed value.
- [ ] **Step 3:** Update `phase-gate`, the `fleetmates-config` skill and the README wherever they
  name the map or the integrator's model. In the README, add a short "Why `mid` runs on opus"
  paragraph with the replay table, a link to `tools/replay/README.md`, and how to restore sonnet
  for `mid`. That is done on the dispatch side by passing a different `--models` map; config
  stores tiers, not models.
- [ ] **Step 4:** `npm test` green; commit `feat(routing): route the mid tier to opus and set the integrator model from measurement`.

### Task 5: release 2.2.0

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `CHANGELOG.md`

**Depends:** T4

**Model:** cheap

- [ ] **Step 1:** Bump both versions from 2.1.0 to 2.2.0.
- [ ] **Step 2:** Add a `2.2.0` section to `CHANGELOG.md`:
  - **Changed:** `mid` implementer tasks dispatch to opus on the Claude harness, with the replay
    evidence in one sentence and how to restore sonnet;
  - **Changed:** the integrator model per the verdict;
  - **Added:** `tools/replay/` (not shipped in the npm package).
- [ ] **Step 3:** `npm test` green; commit `chore(release): 2.2.0`.
