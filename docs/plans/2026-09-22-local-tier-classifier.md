# Local task-tier classifier — implementation plan

Date: 2026-09-22.

This plan replaces Fleetmates' four-rule implementer-tier heuristic, as the default, with a small
linear classifier. The classifier ships inside the npm package and runs in-process as plain
JavaScript. It covers:

- measuring what a wrong tier actually costs;
- building the dataset;
- training and evaluation;
- routing;
- configuration and reporting;
- release.

This change adds no application code.

A neural encoder was researched as well. It is inactive, and is only activated if the linear
model misses a release gate twice. The research is in
`docs/specs/2026-09-22-neural-tier-classifier-notes.md`.

## Decisions already made

| Question | Decision |
|---|---|
| What is classified? | Every implementer task with neither a declared `**Model:**` tier nor a configured `agents.implementer.tier`. Research, documentation, test and code tasks are all eligible. |
| Output | One of `cheap`, `mid`, `capable`, plus all three probabilities. `confidence` is the largest probability and is recorded for audit only. |
| Precedence | Declared task tier > configured implementer tier > classifier > existing heuristic. |
| Enforcement | The classifier never changes gates, reviewers, integrators, filesets, ownership or escalation. |
| Default | **On.** `classifier: "off"` restores the heuristic. Because default routing changes for every existing user, it ships as **3.0.0**. |
| Opt-out location | Both `fleetmates.local.json` and `fleetmates.gate.json`. Local wins when both are set. It is not an enforcement key. |
| Model | Multinomial logistic regression over hashed text n-grams and structural features. The weights live in `classifier/tier-model.json` inside the npm package, capped at 1 MiB. |
| Runtime | Pure JavaScript in the `init-run` process, with no child process, network, native addon or dependency. |
| Training | Pure JavaScript under `tools/classifier/`. It imports the **same** shipped feature extractor, so training and runtime cannot compute features differently. No Python. |
| Thresholds | Tuned on the validation split to minimise weighted loss subject to the gates, then frozen into `tier-model.json`. |
| Loss weight | Measured by a controlled replay of real tasks, not assumed. See "Cost measurement". |
| Cheap tier | Allowed in v1, protected by the gates. |
| Failure direction | A missing, invalid or incompatible weights file falls back to the heuristic with one run-level diagnostic. It never blocks `init-run`. |
| Privacy | Task text never leaves the machine. No telemetry. Nothing is collected from users' runs automatically. |
| Gate miss | Improve the data and retrain once. A second miss activates the neural design note, and nothing ships in the meantime. |
| Heuristic | Kept unchanged as the fallback. The evaluator also reports a re-tuned heuristic, for measurement only. |
| Build tools | Claude, through the Claude Code subscription, generates synthetic tasks and runs the replay. GPT, through the Codex CLI, is the second labeller. **Using the feature requires neither.** |

## Why not Jev

Jev inspired the interface: unstructured state in, typed probabilistic decisions out. It is not a
valid dependency. Checked on 2026-09-22:

- <https://typesafe.ai/blog/introducing-system-one-models-and-jev> prices input at
  $0.042/MTok.
- Access is only through `POST https://api.typesafe.ai/v1/systemone` with a bearer key.
- TypeSafeAI's Hugging Face organization publishes no Jev weights.

Calling it would add a second billing and network layer to every `init-run`.

## Routing contract

`classifierInput(task, tasks)` builds one canonical record per eligible task:

- title;
- brief, capped deterministically at 8 KiB (the first 6 KiB plus the last 2 KiB, cut on UTF-8
  code-point boundaries);
- sorted declared file paths;
- dependency count, dependent count and file count;
- whether the brief contains a fenced code block.

Task ids, absolute paths, remotes, user names, run ids and all other plan text are excluded.

`extractFeatures(record, spec)` produces a sparse vector. `spec` is read from the weights file.
The vector contains:

- lowercase word unigrams and bigrams from title and brief;
- path tokens (each directory segment and the file extension, from every declared path);
- the numeric fields as `log1p` values plus the fence flag.

Text features are hashed with 32-bit FNV-1a into `2^spec.hashBits` buckets (default 14), with
signed hashing to reduce collision bias. The output is L2-normalised.

`predict(weights, features)` returns softmax probabilities in the fixed order
`cheap, mid, capable`. `selectTier(probabilities, thresholds)` applies the frozen policy:

1. `capable` when `p(capable) >= thresholds.capableMin`;
2. otherwise `cheap` only when `p(cheap) >= thresholds.cheapMin`,
   `p(capable) < thresholds.cheapCapableMax`, and the gap to the runner-up is at least
   `thresholds.cheapGap`;
3. otherwise `mid`.

Starting values before tuning are 0.25, 0.85, 0.05 and 0.35. Probabilities that are non-finite,
outside `[0, 1]`, or sum outside `1 ± 1e-6` invalidate the whole batch.

Persisted task routing fields:

```json
{
  "tier": "mid",
  "tierSource": "classified",
  "inferredTier": "capable",
  "classification": {
    "tier": "mid",
    "probabilities": { "cheap": 0.08, "mid": 0.81, "capable": 0.11 },
    "confidence": 0.81,
    "modelVersion": "tier-v1"
  }
}
```

`inferredTier` keeps its existing meaning: the heuristic tier. A fallback records
`tierSource: "inferred"` plus one run-level diagnostic, and never a failure object on each task.
Declared tasks, and tasks configured at `init-run`, never carry `classification`.

**Two existing code paths change, and both are covered by tests:**

- **Order of config resolution.** `init-run` currently calls `resolveConfig` *after* the tier
  loop (`scripts/cli.mjs`, init-run). Config must be resolved first, so that configured tasks
  and `classifier: "off"` are known before anything is classified.
- **The `workflow` retier revert.** Today, removing `agents.implementer.tier` reverts a
  `configured` task to `inferredTier` / `"inferred"`. A task that was classified at `init-run`
  would silently drop to the heuristic. The revert now restores `classification.tier` /
  `"classified"` when `classification` is present, and `inferredTier` otherwise.

## Cost measurement (controlled replay)

The loss weight for under-tiering against over-tiering is measured, not assumed.
`tools/classifier/replay.mjs` re-runs about 30 already-merged tasks from local fleet runs.
Every task is run at each tier with Claude Code in headless mode, which uses subscription usage
limits, not metered spend.

- **Isolation.** Each cell runs in a scratch `git clone --local` of the source repo at the
  task's base commit, created under `$TMPDIR`. The source repository is never modified.
- **Prompt and model.** Each cell gets the same brief `cli.mjs brief` produced for the original
  implementer. It runs `claude -p --model <tier model> --output-format json` with the tier-model
  mapping recorded in the results.
- **Pass rule.** The original phase's gate command checks plus fileset ownership must pass
  within **one fix round**. The fix round sends the gate failure output back once, and its cost
  is counted.
- **Cost.** Two costs are recorded separately:
  - usage-weighted cost: the session's `total_cost_usd`, which reflects list prices and is the
    proxy for how fast the subscription limit burns;
  - wall-clock seconds.
- **Outcome label.** Each task's label is the cheapest tier that passed. A task where no tier
  passed is recorded as `unresolved`. It is excluded from the ratio but kept in the report.
- **Ratio.** For each task with an outcome tier t\*:
  - the under-tier cost at a tier t < t\* is the cost of the attempt at t (fix round included)
    plus the cost at t\*;
  - the over-tier cost at a tier t > t\* is the cost at t minus the cost at t\*.

  `underOverRatio` = mean under-tier cost / mean over-tier cost, computed on the usage-weighted
  cost, with a bootstrap 95% interval. The evaluator freezes the point estimate. Wall-clock
  ratios are reported beside it.
- **What gets committed.** Only metrics keyed by `sha256(repo realpath, run id, task id)` enter
  `tools/classifier/data/replay-results.jsonl`, never code or task text.
- **Usage limits.** Every finished cell is appended as it completes. A usage-limit error stops
  the run cleanly, and the next invocation resumes from the first missing cell.

## Dataset

`tools/classifier/data/` holds two files. Both are frozen by the operator, not generated by a
teammate.

- `dataset.jsonl` — every row, with `split` one of `train`, `validation` or `holdout`.
- `dataset.lock.json` — the SHA-256 of `dataset.jsonl` and the counts that satisfy the rules
  below. `dataset.mjs verify-frozen` checks it.

Row schema (additional properties rejected):

| Field | Meaning |
|---|---|
| `id` | Stable row id |
| `source` | Group key: one real plan or synthetic project. Splits are grouped by it. |
| `origin` | `public`, `own` (scrubbed from the operator's private runs), `synthetic` |
| `generator` | For synthetic rows: model family and version. Otherwise `null`. |
| `title`, `brief`, `files`, `deps`, `dependentCount`, `hasFence` | The routing input fields |
| `label` | `cheap`, `mid` or `capable` |
| `labelKind` | `judged` (rubric) or `outcome` (replay) |
| `labelProcedure` | `operator+gpt` (independent labels, operator resolves) or `operator-twice` (the operator relabels at least 7 days later; disagreements are resolved then) |
| `labels` | The raw independent labels before resolution |
| `license` | SPDX id, or `own` |
| `split` | `train`, `validation`, `holdout` |

Freeze rules, enforced by `verify-frozen`:

- **Holdout size and spread.** At least 300 rows, at least 75 per class, and at least 20
  `source` groups. No group supplies more than 10% of holdout rows.
- **Synthetic share.** At most 60% of all rows and at most 40% of holdout rows.
- **Split integrity.** No `source` appears in more than one split.
- **Generator and labeller families differ.** Synthetic rows come from a Claude model, and the
  model labeller is GPT through Codex. No row is generated and model-labelled by the same
  family.
- **Replay rows.** Every replay task with a resolved outcome is a holdout row with
  `labelKind: "outcome"`. Its text is scrubbed by the operator first.
- **Content.** No absolute paths, secrets, e-mail addresses or personal names. A pattern scan
  runs, and the operator still reviews every `own` row by hand.

The labelling rubric assigns the **minimum sufficient tier**:

- `cheap`: mechanical, localised work with an explicit transformation or example and low
  ambiguity.
- `mid`: ordinary implementation or investigation that needs codebase reasoning but no broad
  architectural judgement.
- `capable`: architecture, security, concurrency, migration, ambiguous diagnosis, cross-cutting
  change, or output that defines interfaces several later tasks use.

Judged labels record human judgement. Outcome labels record what actually passed, and they are
the only ground truth. The report shows both separately.

## Release gates

`tools/classifier/evaluate.mjs` exits non-zero on any miss. It is evaluated on the frozen
holdout, with the frozen thresholds, and with the rounded weights exactly as shipped. Rate gates
use the 95% Wilson bound. With 300 rows, zero observed errors still has an upper bound of 1.26%.

| Gate | Required result |
|---|---|
| Catastrophic under-tier | `capable -> cheap` count is exactly 0, on judged and outcome rows alike |
| All under-tiering | Point estimate at most 3%; Wilson upper bound at most 5% |
| Cheap precision | Point estimate at least 90%; Wilson lower bound at least 85% |
| Cheap recall | At least 50% |
| Weighted loss | At least 15% below the current heuristic, with under-tier errors weighted by the measured `underOverRatio`. A paired bootstrap (10,000 resamples, fixed seed) must give a 95% interval for the improvement that excludes 0. |
| Outcome rows | Weighted loss on `labelKind: "outcome"` rows no worse than the heuristic's |
| Calibration | Top-label ECE with 10 equal-width bins at most 0.10 |
| Determinism | Golden probabilities agree within 1e-12 and tiers are identical on Linux, macOS and Windows in the normal `npm test` matrix |
| Size | `tier-model.json` at most 1 MiB (target 512 KiB) |
| Speed | Load plus classifying 100 tasks takes at most 50 ms p95 on CI |

The report contains the heuristic baseline and a **re-tuned heuristic** baseline. The re-tuned
one is a grid search over the four existing rule thresholds on the training split, and it is
reported only, never shipped. The report also contains:

- the confusion matrix;
- per-class precision, recall and F1;
- weighted loss using both the usage-weighted and the wall-clock ratio;
- calibration buckets;
- label agreement (Cohen's kappa for each `labelProcedure`);
- size and speed.

## Global Constraints

- Node >= 24.2.0
- ESM only; two-space indent; no semicolons; match surrounding style
- Root `package.json` keeps zero runtime dependencies and zero dev dependencies; `tools/classifier/` adds no dependency either
- `npm test` never opens a network connection, never starts a model session and never requires Python
- The shipped classifier makes no network call, spawns no process and loads no native addon
- Task text, probabilities and outcomes never leave the machine
- Declared task tier and configured implementer tier always outrank classifier output
- Reviewer and integrator routing, enforcement gates and `escalateTier` stay unchanged
- Every classifier failure falls back to the existing heuristic with one bounded run-level diagnostic
- Replay and dataset tooling never modify another repository; replay clones into `$TMPDIR`
- Commit messages: single-line summary, commitlint style, English, no co-author or tool attribution trailers
- `npm test` green after every task

## Destination

After upgrading to 3.0.0, every implementer task without a declared or configured tier is routed
by a classifier that ships inside the package. It runs offline, in-process, and deterministically
on every platform. It measurably beats the old heuristic on a frozen holdout that includes real
outcome labels. It records its probabilities for audit, falls back to the heuristic on any
failure, and is switched off per user or per team with `classifier: "off"`. A maintainer can
reproduce the replay, dataset checks, training and evaluation with Node alone, and cannot ship
weights that miss a gate.

## Out of Scope

- The neural/WASM classifier — kept in `docs/specs/2026-09-22-neural-tier-classifier-notes.md` and activated only after two gate misses.
- Reviewer or integrator classification — those roles take part in enforcement and need their own threat and quality analysis.
- Replacing declared `**Model:**` or `agents.implementer.tier` — explicit operator decisions remain authoritative.
- Changing tiers after dispatch — retries use the existing monotonic escalation from the recorded tier.
- Automatic training from users' runs — collecting their task text without consent breaks the privacy decision.
- Replay on Codex or Cursor — v1 measures Claude only; the other harnesses inherit the ratio, and the model card says so.
- Changing the heuristic's rules — it is measured against a re-tuned version, but routing only changes through the classifier.
- Model updates outside Fleetmates releases — the weights are package content and move only with a version bump.

## Operator checkpoints

Two steps need the operator and cannot be delegated to a teammate:

1. **If T6 reports `BLOCKED`:** run the printed replay command yourself (it resumes). Commit
   `replay-results.jsonl` and `loss.json` onto the run branch.
2. **After T6 and T7 are merged:** do the following, then commit `dataset.jsonl` and
   `dataset.lock.json` onto the run branch:
   - run the generation, labelling and extraction tools;
   - scrub the `own` rows;
   - add the replay outcome rows to the holdout;
   - resolve label disagreements, and relabel where `operator-twice` applies;
   - run `node tools/classifier/dataset.mjs freeze`.

T8 is dispatched only after checkpoint 2. Its phase gate runs
`node tools/classifier/dataset.mjs verify-frozen`, so the fleet cannot train on an unfrozen
dataset.

### Task 1: shipped feature extractor

**Files:**
- Create: `scripts/classifier-features.mjs`
- Test: `tests/classifier-features.test.mjs`

- [ ] **Step 1:** Write failing tests for `classifierInput(task, tasks)`:
  - field inclusion and sorted paths;
  - dependent counting across the plan;
  - fence detection with both backtick and tilde fences;
  - the 6 KiB head plus 2 KiB tail cap, with multibyte characters straddling both cut points;
  - exclusion of task id, absolute root, remotes, run id and other tasks' text.
- [ ] **Step 2:** Write failing tests for `extractFeatures(record, spec)`:
  - the FNV-1a 32-bit hash on fixed vectors (`''`, `'a'`, `'foobar'`);
  - signed-hash sign selection;
  - bucket range for `hashBits` 10–16;
  - unigram and bigram tokenisation on punctuation and camelCase;
  - path tokens;
  - `log1p` numeric features;
  - L2 normalisation;
  - identical output for identical input;
  - refusal of an unknown `spec.version`.
- [ ] **Step 3:** Implement both as pure functions with no filesystem, process or config access.
  Export `FEATURE_SPEC_VERSION = 1`.
- [ ] **Step 4:** `npm test` green; commit `feat(classifier): shipped feature extractor`.

### Task 2: shipped model loader, predictor and decision policy

**Files:**
- Create: `scripts/classifier-policy.mjs`
- Test: `tests/classifier-policy.test.mjs`
- Create: `tests/fixtures/classifier-tiny-model.json`
- Create: `tests/fixtures/classifier-golden.json`

**Depends:** T1

- [ ] **Step 1:** Define the weights-file shape:
  - `{ abi: 1, modelVersion, featureSpec, classes: ["cheap","mid","capable"], weights: number[3][2^hashBits + numeric], bias: number[3], thresholds: { capableMin, cheapMin, cheapCapableMax, cheapGap }, trainedAt, datasetSha256 }`;
  - every weight is a finite number with at most 6 significant digits.

  Write failing tests for `validateModel` that reject:
  - a wrong ABI, class order or dimensions;
  - non-finite numbers or out-of-range thresholds;
  - extra keys.
- [ ] **Step 2:** Write failing tests for `predict`: a numerically stable softmax (max-subtracted),
  a sum within 1e-12 of 1, and a fixed class order.
- [ ] **Step 3:** Write failing table tests for `selectTier`:
  - every threshold boundary, exactly at and just beside it;
  - NaN, infinity, negative values and sums outside tolerance, each invalidating the result.
- [ ] **Step 4:** Write failing tests for `routeTasks({ tasks, roleTier, classifierSetting, model })`.
  It returns each task's `{ tier, tierSource, inferredTier, classification? }` plus an optional
  run diagnostic. Cover:
  - the full precedence chain;
  - `off`;
  - a `null` model, which yields the heuristic and a diagnostic naming the reason;
  - an invalid batch, which yields the heuristic for **every** task, never a mix.
- [ ] **Step 5:** Create a tiny hand-written fixture model and a golden file of probabilities for
  12 fixed inputs. The golden test compares with a 1e-12 tolerance, so every CI OS checks
  determinism.
- [ ] **Step 6:** Implement `loadModel(path)`. It reads with `lstat` (refusing symlinks),
  validates, and returns the model or `{ unavailable: reason }`, never throwing for operational
  failures. Implement the pure functions above.
- [ ] **Step 7:** `npm test` green; commit
  `feat(classifier): pure predictor, policy and precedence`.

### Task 3: dataset schema, validator and rubric

**Files:**
- Create: `tools/classifier/README.md`
- Create: `tools/classifier/dataset.mjs`
- Test: `tests/classifier-dataset.test.mjs`

- [ ] **Step 1:** Write `tools/classifier/README.md` with:
  - the rubric from this plan, with at least three examples per tier and the boundary cases
    (research, documentation, tests, migration, security, concurrency, mechanical code);
  - both label procedures;
  - the disagreement-resolution rule;
  - the scrubbing checklist for `own` rows;
  - the ban on collecting users' tasks.
- [ ] **Step 2:** Write failing tests for row validation against the schema table in this plan.
  Cover additional properties, unknown labels, unsafe paths, a `generator` family equal to the
  labeller family, and the secret, e-mail and absolute-path scan.
- [ ] **Step 3:** Write failing tests for the freeze rules: holdout size, per-class minimums,
  source count, the 10% group share, synthetic caps, source leakage across splits, and replay
  outcome rows being present in the holdout.
- [ ] **Step 4:** Implement three subcommands:
  - `node tools/classifier/dataset.mjs check <file>`: reports every violation, exits 1 on any;
  - `freeze`: runs `check`, then writes `dataset.lock.json` with the SHA-256 and counts;
  - `verify-frozen`: exits 1 on a hash mismatch or a missing lock.
- [ ] **Step 5:** `npm test` green; commit
  `feat(classifier): dataset schema, rubric and freeze checks`.

### Task 4: evaluator and release gates

**Files:**
- Create: `tools/classifier/evaluate.mjs`
- Test: `tests/classifier-evaluate.test.mjs`

**Depends:** T2

- [ ] **Step 1:** Write failing tests against hand-computed fixtures for:
  - the confusion matrix and per-class precision, recall and F1;
  - Wilson bounds (0/300 gives an upper bound of 0.0126);
  - weighted loss with an injected `underOverRatio`;
  - top-label ECE with 10 bins;
  - a fixed-seed paired bootstrap;
  - Cohen's kappa;
  - separate judged and outcome slices.
- [ ] **Step 2:** Write failing tests that the heuristic baseline calls the real `inferTier`
  from `scripts/routing.mjs`, and that the re-tuned heuristic grid search is fit on train rows
  only.
- [ ] **Step 3:** Write failing tests that every gate in the "Release gates" table has a
  pass/fail case, and that one missed gate yields exit code 1 with the gate named.
- [ ] **Step 4:** Implement
  `node tools/classifier/evaluate.mjs --model <json> --dataset <jsonl> --loss <json>`. It writes
  `report.json` and `report.md`, both deterministic for the same inputs.
- [ ] **Step 5:** `npm test` green; commit `feat(classifier): evaluator and release gates`.

### Task 5: replay tool

**Files:**
- Create: `tools/classifier/replay.mjs`
- Test: `tests/classifier-replay.test.mjs`

- [ ] **Step 1:** Write failing tests using a fake `claude` executable that the test creates
  itself and puts on `PATH`. Cover:
  - cell success;
  - gate failure then fix-round success;
  - failure at every tier (`unresolved`);
  - a usage-limit error, which stops cleanly;
  - resuming from the first missing cell;
  - malformed JSON output;
  - a missing `total_cost_usd`, recorded as missing and never as 0.
- [ ] **Step 2:** Write failing tests for task selection. It takes merged tasks from
  `.fleetmates/<run>/plan.json` under the roots passed with `--roots`, as a diverse sample of
  `--count` tasks with a fixed seed. Committed output contains only hashed keys and metrics;
  the test asserts no brief, title or path from the fixture appears in it.
- [ ] **Step 3:** Write failing tests that each cell clones the source repo into `$TMPDIR` with
  `git clone --local`, checks out the base commit, never writes to the source repo, and removes
  the clone afterwards.
- [ ] **Step 4:** Implement the tool, with `--dry-run` as the default (it prints the planned
  cells) and `--execute`. The pass rule, cost fields and ratio follow "Cost measurement". It
  writes `replay-results.jsonl` (append-only, one line per finished cell) and `loss.json`
  (`underOverRatio`, its interval, the wall-clock ratio, the tier-model mapping and the date).
- [ ] **Step 5:** `npm test` green; commit
  `feat(classifier): resumable controlled replay for loss weighting`.

### Task 6: run the replay

**Files:**
- Create: `tools/classifier/data/replay-results.jsonl`
- Create: `tools/classifier/data/loss.json`

**Depends:** T5, T13

**Model:** mid

- [ ] **Step 1:** Run
  `node tools/classifier/replay.mjs --roots <comma-separated repo roots> --count 30 --dry-run`
  and record the planned cell count. `--roots` takes each repository root, not a parent folder.
- [ ] **Step 2:** Run `--smoke` first (Task 13). If the smoke cell does not pass, stop and report
  `BLOCKED` with its `failReason`. Only then run the same command with `--execute`. On a usage-limit stop, commit the
  partial results, report `BLOCKED: usage limit, resume with <exact command>`, and stop.
  Resuming does not re-run finished cells.
- [ ] **Step 3:** If a headless `claude` session cannot start from this environment, report
  `BLOCKED` with the exact command for the operator to run. Do not substitute a guessed ratio.
- [ ] **Step 4:** Once every cell is finished, confirm `loss.json` exists. Its interval is
  reported as measured, even if wide.
- [ ] **Step 5:** `npm test` green; commit `data(classifier): replay outcomes and measured loss ratio`.

### Task 13: replay sessions can actually edit, and failures say why

The first real replay run (2026-09-22, 90 cells, about 9 h) recorded 90 of 90 cells as `fail`
at every tier. Root cause, reproduced: `claude -p` without a permission mode denies every
`Write`/`Edit`, so each session changed nothing and was graded as a no-op fail. The session
itself exits 0 and reports the denials only in `permission_denials`. No test could catch this,
because every test used a fake `claude`.

**Files:**
- Modify: `tools/classifier/replay.mjs`
- Test: `tests/classifier-replay.test.mjs`

**Depends:** T5

**Model:** capable

- [ ] **Step 1:** Write a failing test that the spawned argv contains
  `--permission-mode bypassPermissions`. Add it to the spawn. The operator chose this mode so
  a replay session has the same freedom a fleet teammate had. The header comment must say
  plainly that the session runs unattended with the operator's OS permissions, and that the
  `$TMPDIR` clone is not a sandbox.
- [ ] **Step 2:** Write failing tests that a session JSON result with a non-empty
  `permission_denials` array makes the cell **invalid**, not `fail`:
  - nothing is appended for it;
  - `main` stops the run with a message naming the denied tool names and the count;
  - resume re-runs the cell.
- [ ] **Step 3:** Write failing tests that every appended record carries `failReason` for a
  `fail`. The value is one of `no-op`, `fileset`, `command:<check name>`, `session-error` or
  `preview-copy`, and never contains task text, paths or command output. Also record
  `permissionDenials` (a count) and `turns`.
- [ ] **Step 4:** Add a `--preflight` step that `--execute` always runs first. It starts one real
  session in a scratch git repo under `$TMPDIR`, asks it to create one file and run
  `git status`, and aborts the whole run unless the file exists and the session reports zero
  permission denials. Test it with a fake `claude` in both a success and a denial case.
- [ ] **Step 5:** Add `--smoke`. It runs exactly one cell at the `capable` tier on the first
  selected task, prints its status, `failReason`, cost and turns, and appends nothing. Test it
  with a fake `claude`.
- [ ] **Step 6:** `npm test` green. Run
  `node tools/classifier/replay.mjs --preflight --models '{"cheap":"haiku","mid":"sonnet","capable":"opus"}'`
  once for real and paste its output. It is one small session. Commit
  `fix(classifier): replay sessions run with edit permission and record why a cell failed`.

### Task 7: dataset generation and labelling pipeline

**Files:**
- Create: `tools/classifier/generate.mjs`
- Create: `tools/classifier/label.mjs`
- Create: `tools/classifier/extract-own.mjs`
- Test: `tests/classifier-pipeline.test.mjs`

**Depends:** T3

- [ ] **Step 1:** Write failing tests with fake `claude` and `codex` executables for:
  - `generate.mjs`: asks Claude for tasks across a list of invented project descriptions,
    stamps `origin: synthetic` and `generator`, and assigns `source` per project;
  - `label.mjs`: asks GPT through `codex exec` to label each row against the README rubric,
    blind to any existing label, and records the answer in `labels`;
  - `extract-own.mjs`: reads local runs' plan tasks into an **uncommitted** staging file under
    `$TMPDIR`, pre-scrubs paths and names, and marks every row as needing operator review.
- [ ] **Step 2:** Write failing tests that no tool writes its staging output inside the repo, and
  that `label.mjs` refuses to label rows whose generator family is GPT.
- [ ] **Step 3:** Implement the three tools. Each is dry-run by default and resumable, and emits
  rows that pass `dataset.mjs check`.
- [ ] **Step 4:** Document the operator steps in `tools/classifier/README.md`: scrub the `own`
  rows, resolve disagreements, add replay outcome rows, then `freeze`.
- [ ] **Step 5:** `npm test` green; commit
  `feat(classifier): generation, labelling and extraction pipeline`.

### Task 8: train, tune and ship the weights

**Files:**
- Create: `tools/classifier/train.mjs`
- Test: `tests/classifier-train.test.mjs`
- Create: `classifier/tier-model.json`
- Create: `docs/specs/2026-09-22-tier-classifier-model-card.md`

**Depends:** T1, T2, T4, T6, T7

**Model:** capable

- [ ] **Step 1:** Write failing tests on a synthetic separable fixture:
  - training converges;
  - the result is identical for a fixed seed;
  - the cost-weighted loss uses `underOverRatio`;
  - L2 regularisation strength is chosen by grouped cross-validation on train rows;
  - threshold tuning reads validation rows only and **never** holdout rows;
  - weights are rounded to 6 significant digits **before** evaluation.
- [ ] **Step 2:** Implement `train.mjs`: full-batch gradient descent with a fixed iteration cap
  and seed, and a grid of `hashBits` in {12, 13, 14, 15}. Select the smallest configuration
  whose validation loss is within one standard error of the best.
- [ ] **Step 3:** Confirm `node tools/classifier/dataset.mjs verify-frozen` passes. Train, write
  `classifier/tier-model.json`, and run the evaluator on the holdout once.
- [ ] **Step 4:** If any gate misses, commit nothing under `classifier/`. Report `BLOCKED` with the
  report attached. This is the one permitted data-improvement retry; a second miss activates the
  neural design note.
- [ ] **Step 5:** Write the model card. It covers:
  - dataset provenance and the share of each origin;
  - label procedures and kappa;
  - replay coverage, and the statement that Codex and Cursor inherit the Claude ratio;
  - chosen `hashBits`, regularisation strength and thresholds;
  - the full report;
  - the statement that judged labels are human judgement and only outcome rows are ground truth;
  - known limitations.
- [ ] **Step 6:** `npm test` green; commit `feat(classifier): trained tier model v1`.

### Task 9: classifier config switch

**Files:**
- Modify: `scripts/config.mjs`
- Test: `tests/config.test.mjs`
- Modify: `skills/fleetmates-config/SKILL.md`
- Modify: `tests/fixtures/fleetmates-config.SKILL.md`
- Test: `tests/skill-config.test.mjs`

The fixture is a byte-for-byte snapshot of the skill, and `tests/skill-config.test.mjs` keeps a
heading inventory and negative screens. All three files change together, or `npm test` fails.

- [ ] **Step 1:** Write failing tests covering the `classifier` key:
  - accepted as `"on"` or `"off"` in both `fleetmates.local.json` and `fleetmates.gate.json`;
  - defaults to `"on"`, with local winning over gate;
  - its source is reported;
  - objects, booleans and other strings are rejected;
  - not present in `ENFORCEMENT_KEYS`.
- [ ] **Step 2:** Write failing tests that `config set classifier off` and
  `config set classifier off --local` write to the right layer.
- [ ] **Step 3:** Implement the change in `validateLocal`, `validateGate` and resolved config.
  Every existing row and validator stays as it is.
- [ ] **Step 4:** Add the `classifier` row to the skill:
  - it is on by default;
  - `config set classifier off` turns it off, `--local` makes that per user;
  - `classifier benchmark` exists;
  - it never overrides a declared or configured tier.

  Copy the skill to the fixture, and extend the heading inventory in the same commit.
- [ ] **Step 5:** `npm test` green; commit `feat(config): classifier on/off switch`.

### Task 10: classify at init-run and keep it on retier

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`
- Test: `tests/routing.test.mjs`

**Depends:** T2, T8, T9

- [ ] **Step 1:** Add tests proving `scripts/routing.mjs` (`inferTier`, `escalateTier`, `TIERS`) is
  unchanged in behaviour.
- [ ] **Step 2:** Write failing `init-run` tests for:
  - precedence: declared, then configured, then classified;
  - `off` falls back to inferred;
  - research and documentation tasks are classified;
  - `plan.json` records the `classification` fields;
  - the printed phase listing shows `classified` as a source.
- [ ] **Step 3:** Write failing fallback tests. A missing, symlinked, invalid, wrong-ABI or
  wrong-dimension model file, or an invalid prediction, routes every eligible task through the
  heuristic. In each case `init-run` writes one diagnostic, exits 0, and starts no process and
  opens no connection.
- [ ] **Step 4:** Write failing `workflow` retier tests:
  - classified, then configured, then un-configured returns `classification.tier` /
    `"classified"`;
  - configured at init-run, then un-configured returns `inferredTier` / `"inferred"`;
  - a `plan.json` without `classification` behaves exactly as today.
- [ ] **Step 5:** In `init-run`, move `resolveConfig` ahead of tier assignment. Load
  `classifier/tier-model.json` relative to the package, never the project root, and call
  `routeTasks` before writing `plan.json`. Change the `workflow` revert branch to prefer
  `classification.tier`. `fix` and both dispatch paths remain consumers of recorded tiers only.
- [ ] **Step 6:** `npm test` green; commit `feat(routing): classify implementer tiers at init-run`.

### Task 11: classifier benchmark report

**Files:**
- Create: `scripts/classifier-report.mjs`
- Test: `tests/classifier-report.test.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T10

- [ ] **Step 1:** Write failing tests for a pure report over existing run files. Each task shows:
  - chosen tier, heuristic tier and source;
  - confidence;
  - later escalation count;
  - terminal status;
  - recorded harness and model;
  - token usage where available.

  No task text or title appears.
- [ ] **Step 2:** Write failing tests for missing or corrupt run files, incomplete runs, mixed
  sources, fallback runs, unreadable usage (named as missing, never shown as 0) and control
  bytes.
- [ ] **Step 3:** Compute the aggregates:
  - counts by source and fallback reason;
  - tier distribution;
  - the classifier-versus-heuristic matrix;
  - escalation-proxy under-tier counts;
  - gate completion rate;
  - tokens by chosen tier.
- [ ] **Step 4:** Register `classifier benchmark [--run <id>] [--json]` in `USAGE` and the
  argument contract, rejecting extra positionals and flags. Without `--run`, it prints the model
  version, `datasetSha256`, size, and load and classification time for 100 synthetic records.
- [ ] **Step 5:** State in the output that escalation is an outcome proxy, not correctness, and
  that token comparisons across different tasks are observational.
- [ ] **Step 6:** `npm test` green; commit `feat(classifier): benchmark and routing report`.

### Task 12: package, document and prepare 3.0.0

**Files:**
- Modify: `package.json`
- Modify: `tests/pack.test.mjs`
- Modify: `tests/packaging.test.mjs`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `LICENSE-THIRD-PARTY`
- Modify: `NOTICE.md`

**Depends:** T8, T10, T11

- [ ] **Step 1:** Add `classifier/` to package `files`. Assert that `npm pack --dry-run` includes
  `classifier/tier-model.json` at no more than 1 MiB, and excludes `tools/`, datasets, replay
  data and the model card's raw reports.
- [ ] **Step 2:** In the README, document:
  - what is classified and the precedence chain;
  - that the classifier is on by default and how to turn it off (per user and per team);
  - how to read the `classification` fields;
  - `classifier benchmark`;
  - the measured size and speed, copied from the evaluator report, never from targets.
- [ ] **Step 3:** In `SECURITY.md`, state that the classifier runs in-process on package content,
  with no network, no child process and no data leaving the machine.
- [ ] **Step 4:** Credit dataset sources and licences in `LICENSE-THIRD-PARTY` and `NOTICE.md`,
  and verify that each public source's licence is compatible.
- [ ] **Step 5:** Add a `CHANGELOG` `Unreleased` section headed **BREAKING (3.0.0): implementer
  tiers are classified by default**. Include the one-line opt-out. The version bump itself
  happens at release time, not in this task.
- [ ] **Step 6:** Pin these README and SECURITY claims in `tests/packaging.test.mjs` against the
  real behaviour: default on, opt-out keys, no network, and no process.
- [ ] **Step 7:** `npm test` green; commit `docs: tier classifier on by default (3.0.0)`.
