# Protected Paths and Non-Removable Enforcement Checks

Date: 2026-09-26
Status: approved design, pre-implementation
First of two specs. The second, a weakened-test detector, depends on this one: its contract lives
in the gate manifest, and without this spec a teammate or an integrator merge could remove it.

## Why

Two holes exist today, both reproducible from the code as it stands:

1. **A task can change the files that decide what the gate checks.** `fileset` only asks whether
   a changed path is declared. A task that declares `fleetmates.gate.json` may rewrite it, and the
   next phase's gate reads the rewritten manifest from the main worktree. This has happened
   legitimately: run `claims`, T3, commit `effb6ce`, merged by `09f5ad9`, added the `claims` lens
   to the manifest. Nothing required that change to be authorised as anything other than an
   ordinary declared edit.
2. **The enforcement checks can be switched off by the manifest they are meant to police.**
   `fileset` and `ownership` run only when the manifest lists them. An integrator merge that
   carries content no parent explains is caught by `ownership`
   (`mergeContentExplainedByParents`, `scripts/gate-runner.mjs`), but only at the NEXT gate, which
   reads the manifest as that same merge left it. A merge that removes `ownership` from the
   manifest disables the check that would have caught it. `sideswap_rust` already runs with
   neither check declared (never added, not removed: no commit to its manifest touches either),
   which also means `--enforcement-only` refused every phase there and its teammates never got
   the SubagentStop early warning.

## Decisions

- **Protection is a rule inside `fileset`, not a new check kind.** Every existing manifest that has
  `fileset` gets it with no edit; a `fileset` failure is already a `process-violation` in
  `decideFix` (escalate, never retry); `fileset` is already task-scoped, so SubagentStop already
  reports it to the teammate before it stops. `decideFix` does not change.
- **`fileset` and `ownership` are implicit.** `checksForPhase` (`scripts/gate-config.mjs`) appends
  either one when the phase's check list lacks it. That function feeds `gate`, `complete`,
  `finish` and `prune-run`, so there is one injection point and no consumer can miss it. There is
  no manifest opt-out. The only way to not run them stays what it is today: the operator's
  `--no-fleet` flag on the CLI invocation, which no commit can set.
- **The manifest can add to the enforcement checks, never narrow them.** Today the `fileset` and
  `ownership` runners read nothing from their manifest entry except `name`, and `optional` is
  forced to `false` for both (`ALWAYS_ENFORCED_KINDS`). This becomes a stated invariant: any field
  either runner ever reads from its entry must only widen what it checks. Pinned by test.
- **Authorisation is a plan marking, read from the anchor.** A task that must change a protected
  path says so with a modifier on its existing file line:

  ```
  **Files:**
  - Modify: `scripts/review-gen.mjs`
  - Modify (protected): `fleetmates.gate.json`
  ```

  One line, one source of truth for the file set, the action preserved. The plan is read at
  `mergeBase(base, run)`, which no teammate commit reaches. A marking added mid-run goes through
  the existing amendment flow (`skills/parallel-execution/SKILL.md`, "Amending a plan mid-run"):
  commit on the base, `merge --no-ff` into the run branch. Approving an escalated protected-path
  change IS that amendment followed by a re-gate; there is no other approval path, because nothing
  integrates without a recomputed PASS.
- **Default protected set: the gate manifest only.** `protectedPaths(config)` returns
  `NAMES.gateFile`, `LEGACY.gateFile` and whatever the manifest's top-level `protected` array adds.
  The legacy name costs one entry and stops a teammate from creating a `teammates.gate.json` for a
  later migration to adopt. `package.json`, `jest.config.*`, `conftest.py` are opt-in: they change
  legitimately too often (every dependency add) and protecting them by default would train the
  operator to approve escalations without reading them.
- **Path matching is exact in v1**, after `normalizePath`, compared case-insensitively for
  membership in the protected set. No globs until someone asks.
- **The case asymmetry is intentional.** Membership in the protected set compares lower-cased (a
  `Fleetmates.gate.json` is what a case-insensitive filesystem — NTFS on the win32 CI, APFS on
  macOS — may open as the manifest). Authorisation compares exactly: a marking whose case differs
  from the changed path does not authorise it and escalates. Both directions err toward
  escalation. Do not "fix" the authorisation side to lower-case: that loosens it.

## Units

1. **`scripts/plan-parser.mjs`.** `FILE_LINE` accepts an optional ` (protected)` after the verb,
   exact case only. The path is pushed to `task.files` as today and also to a new
   `task.protectedFiles`. Any line shaped like a file line — `- <Word> [(<anything>)]: \`…\`` inside
   a `**Files:**` block — that does not match exactly makes `init-run` refuse, naming the line.
   Today such a line drops out of `files` silently, the same class of silent loss as the fence bug
   that erased T8–T12 of run `tier-classifier`; here it would silently remove scope permission.
2. **`scripts/gate-config.mjs`.**
   - `protectedPaths(config)` as above.
   - Validation of `protected` in the manifest validator the CLI already runs at its consumers
     (`resolveGateConfig`, `scripts/cli.mjs`): an array of non-empty, repo-relative strings with no
     `..` escape, the same rules as `preview.link`.
   - `checksForPhase` injects `{ name: 'fileset', kind: 'fileset', injected: true }` and
     `{ name: 'ownership', kind: 'ownership', injected: true }` when absent, after the declared
     checks, never duplicating one that is declared.
3. **`runFilesetCheck`** (`scripts/gate-runner.mjs`). For each task in the derived phase, over the
   diff it already computes (`changedFiles({ base: runSha, branch })`, three-dot, `--no-renames`):
   - out-of-scope violations exactly as today;
   - protected violations: every changed path whose lower-cased form is in the lower-cased
     protected set and which is not in `task.protectedFiles` — evaluated even when the path IS in
     `task.files`.
   Output lists the two classes under separate headings so an escalation shows at a glance whether
   it was scope or protection. `--no-renames` already makes `git mv` of a protected file report the
   old path as a deletion; the rule needs nothing extra for renames or deletions, only tests.
4. **`mergeContentExplainedByParents`.** Today a file both sides touched is a "genuine conflict"
   and the integrator's resolution is accepted unverified. For a protected path that acceptance
   additionally requires that at least one secondary parent is an ancestor of a task branch whose
   task marks that path `(protected)`. Otherwise `ownership` fails naming the file and the merge.
   Unprotected conflict resolutions keep today's behaviour.
5. **Injected-check note.** When an injected `ownership` fails, its output ends with:
   `check injected: the manifest does not declare it; the commits above may predate this fleetmates
   version, or come from an inline run (use --no-fleet)`. The note cannot say which: knowing when the
   update was applied would need a record under `.fleetmates/`, which is agent-writable and never
   consulted by an enforcement check.

## Data flow

Per gate invocation, nothing new is read and nothing is read twice:

1. `tasks` from the plan at the anchor, each with `files` and `protectedFiles`.
2. The manifest, once, from the main worktree (unchanged: an uncommitted edit still applies);
   `checksForPhase` injects, `protectedPaths` resolves.
3. Per task, the diff `fileset` already takes; the protected rule is a second filter over it.
4. `ownership` walks `anchor..run` as today; only the conflict branch of the content rule gains the
   protected condition.
5. SubagentStop and `fix` take no new path.

## Errors and escalation

| Situation | Result |
|---|---|
| Task changes a protected path without `(protected)` | `fileset` FAIL, "protected" class; `fix` escalates as `process-violation` |
| Task marks a path `(protected)` with different case than the change | Not authorised; same FAIL |
| Protected path in a hand-resolved conflict, no parent from a task marking it | `ownership` FAIL naming file and merge |
| Merge content on a protected path explained by no parent | `ownership` FAIL — today's behaviour, now pinned with the manifest as the target |
| Manifest lacks `fileset` and/or `ownership` | Injected; the gate prints one line naming what it injected |
| Injected `ownership` fails | FAIL with the injected-check note |
| Invalid `protected` entry (absolute, `..`, not a string, not an array) | Manifest rejected at validation, naming the entry — not a check FAIL |
| Manifest left invalid by a merge | Rejected at validation; no verdict is recorded; integration, `finish` and `prune-run` require a recomputed PASS and do not get one |
| `(protected)` on a path outside the protected set | No effect, no warning: the marking only authorises |
| Unknown modifier, or `(Protected)` / any case other than exact | `init-run` refuses, naming the line |

## Testing

**Unit.**
- `plan-parser`: `(protected)` with Create, Modify and Test populates both `files` and
  `protectedFiles`; unknown modifier and wrong case refuse. Regression: every `docs/plans/*.md` in
  this repository parses to the same tasks and files as before. **If an old plan now refuses, that
  is the silent-drop bug surfacing, not a regression: correct the plan, do not relax the parser.**
- `gate-config`: default `protectedPaths`; each invalid `protected` shape refused; `checksForPhase`
  injects when absent, never duplicates, marks `injected`, and the result is non-optional.

**Real-git fixtures (`gate-runner`).**
- `fileset`: edit, delete, `git mv` out of, `git mv` into, and case-only rename of a protected path
  each FAIL; marked passes; declared-but-unmarked fails; output separates the two classes. The
  case-only rename commit is built with plumbing (`update-index`, `write-tree`, `commit-tree`), not
  through the worktree, so NTFS and APFS produce the same commit as ext4 — no `win32` skip.
- `ownership`: evil merge on the manifest fails; protected conflict passes with a marked parent and
  fails without; an injected failure carries the note.

**Adversarial (`tests/adversarial.test.mjs`).**
1. **Narrowing a declared check.** A phase-N merge rewrites the declared `ownership` entry
   (`"optional": true` plus arbitrary extra fields) and changes other manifest content; the phase
   N+1 gate still fails on that merge. Removing the entries outright is covered by injection and
   gets its own short case.
2. **Last phase.** The same attack on the final merge fails in `finish`.
3. **Early warning.** A teammate editing the manifest, declared but unmarked, is blocked by
   SubagentStop (`complete --enforcement-only` exits 3).
4. **Rejection is not a pass.** A merge leaves `protected` invalid; `gate` records no verdict and
   `finish` refuses.
5. **Inline run and `--no-fleet`.** A fixture shaped like `sideswap_rust`'s `mainnet-dry-run`:
   `init-run`, no task branches, commits straight on the run branch. Without the flag: FAIL with
   the injected-check note. With `--no-fleet`: today's behaviour, unchanged.
6. **Pinned limit.** A hand-resolved conflict on an UNprotected path is still accepted.

## Out of scope, stated

- **A teammate that can move `refs/heads/<base>`.** A marking, like any plan amendment, is
  authoritative because it is on the base. The trust boundary is write access to the base branch,
  not the plan read. The same holds for a task marked `(protected)` on the manifest: it may
  legitimately remove anything from it — injection keeps `fileset` and `ownership` running, but it
  could drop a command check.
- **Hand-resolved conflicts on unprotected paths** stay unverified (adversarial case 6 pins it).
- **A manifest opt-out for the enforcement checks.** Not built. If one is ever needed it must be
  read from the manifest AT THE ANCHOR, not the working tree, or an integrator merge that sets it
  switches `ownership` off before `ownership` can report that merge.
- **Globs in `protected`.**

## Next: spec 2, weakened-test detector (recorded, not designed here)

Decisions already taken, so they are not re-litigated:

- Primary signal is runtime: JUnit XML from the project's own runner, baseline run at `runSha`
  (the run tip before the phase merges, which is what the preview builds on) versus the preview.
  Per test file: executed count drops or skipped count rises → escalate as a process violation;
  IDs listed. A test already skipped at the baseline does not count.
- Report contract on a `command` check, two forms: under `$FLEETMATES_REPORT_DIR` (a fresh
  directory per execution) when the runner can write there; an in-tree path deleted by the gate
  before the run and required after it (Gradle, nextest if it cannot point outside). Declared and
  absent is a process FAIL; undeclared is `skip` with a reason, never `pass`. Baseline and preview
  run under the same parsed manifest.
- No baseline cache in v1: a cache under `.fleetmates/` is agent-writable.
- `.only` has no regex: the suggested manifest uses the runner's own refusal (`--forbid-only`,
  `--allowOnly=false`, `node --test` ignores it without `--test-only`). Jest has none: every
  `.only` there escalates. Pin that each runner's refusal message names the file.
- Rust moves to `cargo nextest`; fallback plan `cargo test -- --list` / `--list --ignored`. Unity
  (NUnit) is `skip` with a reason.
- Out of scope, pinned by an adversarial test: loosened assertions (`toBe(5)` → `toBeDefined()`),
  and a runner subverted by teammate code that writes the report itself.
- The normalised report (file → executed, skipped, IDs) is its own structure, so a later
  **permanent-skip check** (the `rustot-stats` case: five live assertions skipped at every gate
  because the environment was not provisioned) is a new consumer, not rework. That check is a
  separate item after spec 2.

## Implementation notes (2026-09-26)

What the implementation changed relative to the text above, and why:

- **The two `fileset` classes are labelled lines, not headings.** `T1: outside declared set — …`
  stays byte-identical to what every existing consumer matches; the new class is
  `T1: protected — … (mark it "Modify (protected)" …)`. Same separation, no churn.
- **`ownership` no longer lets task-branch reachability explain a commit on the run branch's own
  first-parent chain.** Adversarial case 1 failed against the design as written: the phase N+1
  branch forks from the run tip, so the evil phase-N merge is in its history and reachability
  "explained" it — at every later gate and in `finish`. The same held for any direct write made
  before a later dispatch. On the chain, only the merge-content rule explains a commit now. A
  fast-forward integration, already outside `tm-integrator`'s contract, now fails `ownership` too.
- **Vouching stops at each branch's floor.** The security and claims review of the first version
  reproduced the same hole one step removed: a payload committed on a throwaway side branch and
  merged with an ordinary `--no-ff` sits OFF the chain, and the next phase's branch vouched for it
  again. A task branch now vouches only for commits past its floor, the latest chain commit it
  descends from — which also covers a run tip rebuilt with `commit-tree` so its first parent is the
  anchor (adversarial tests for both).
- **`gate` does not print the injected line** the error table describes: its stdout is one JSON
  document, so the names go in an `injected` field. `complete`, `finish` and `prune-run` print it.
- **`injected` is `checksForPhase`'s mark only**; a declared entry carrying it has it stripped,
  because the mark makes its name print as this code's own text.
- **`--enforcement-only`'s refusal of a manifest with no enforcement check is gone.** Injection
  made that manifest shape unreachable; the tests that pinned the refusal now pin that the flag
  answers with the injected checks and never reads PASS on nothing.
- **`init-run` reports a malformed file line as a refusal (exit 2)**, through a `PlanParseError`,
  and the quoted line goes through `printable` inside the parser, because `doctor`, `liveness`
  and `plan-drift` print the same message.
- **Test fixtures that committed straight onto the run branch** (a manifest before dispatch, a
  results file at the repository root) were passing only through the reachability hole above or
  with no ownership check at all. They now commit on the base (`absorbIntoBase` in
  `tests/cli.test.mjs`) and keep scratch files under the ignored state directory.
