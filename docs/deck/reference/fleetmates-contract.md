# fleetmates integration contract for "fleetmates deck" (hub/)

Source: fleetmates v2.2.0, branch `master` at `273080a`. All paths are repo-relative. `file:line`
references were read from that commit. Where the code does not say something, this document says
"not found" rather than guessing.

---

## 1. Repo layout

### Top level

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json`, `marketplace.json` | Claude Code plugin manifest (name `fleetmates`, version `2.2.0`). |
| `agents/` | Persona prompts: `tm-implementer.md`, `tm-reviewer.md`, `tm-integrator.md`. |
| `hooks/` | `hooks.json`, `run-hook.cmd` (bash/cmd polyglot wrapper), `session-start`, `update-check`. |
| `scripts/` | All runtime code, plain ESM `.mjs`. `cli.mjs` is the single entry point. `scripts/harnesses/` holds the headless adapters (`codex.mjs`, `cursor.mjs`, `files-sandbox.mjs`, `index.mjs`). |
| `skills/<name>/SKILL.md` | 14 skills (prose is runtime behaviour for agents, CONTRIBUTING.md:54-60). |
| `templates/` | `phase-workflow.js` (Workflow tool preamble), `SKILL.template.md`. |
| `tests/` | Flat `*.test.mjs` files plus `tests/md-contract.mjs` helper and `tests/fixtures/`. |
| `tools/replay/` | Operator replay tooling and data. Not shipped (pack.test.mjs:31-32). |
| `docs/specs/`, `docs/plans/`, `docs/followups/` | Design docs, executable plans, open-findings lists. |
| `fleetmates.gate.json` | This repo's own gate manifest (tracked). |
| `jsconfig.json` | Editor config only (`checkJs: false`, `noEmit: true`, excludes `.fleetmates`, `docs`). |
| `.github/workflows/test.yml`, `release.yml` | CI matrix ubuntu/windows/macos on Node 24; release publishes to npm on `v*` tags with `--provenance`. |

There is no `bin/` directory and no `bin` field in `package.json`.

### package.json (whole relevant surface)

- `"type": "module"`, `"engines": { "node": ">=24.2.0" }`.
- `dependencies` / `devDependencies`: none. Zero deps, runtime and dev, is a hard rule
  (CONTRIBUTING.md:18-19; CI has no install step, test.yml comment "No install step").
- `"files"` whitelist: `.claude-plugin/ agents/ hooks/ scripts/ skills/ templates/ README.md LICENSE
  LICENSE-THIRD-PARTY NOTICE.md CHANGELOG.md`. A new `hub/` is NOT shipped unless added here.
- `scripts`:
  - `test`: `node --test --test-reporter=./scripts/quiet-reporter.mjs tests/*.test.mjs`
  - `test:verbose`: `node --test tests/*.test.mjs`
  - `test:e2e:codex` / `test:e2e:cursor`: `FLEETMATES_E2E=1 node --test tests/e2e-<x>.test.mjs`
  - `test:hostile-tmpdir`: `node scripts/hostile-tmpdir-sweep.mjs`

### CLI entry and dispatch

- Invocation is always `node "<fleetmates root>/scripts/cli.mjs" <command> [flags] --root <project>`
  (README.md:220; every skill). The rename spec decided "No `bin`; skills keep calling
  `node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs"`" and lists "A `fleetmates` CLI binary" as out of scope
  (docs/specs/2026-09-13-fleetmates-rename-design.md:11 and :207). So `fleetmates ui` as a bare
  command does not exist today; see section 6.
- Entry guard: `isEntryPoint(import.meta.main, ...)` then `process.exitCode = await runCli(argv)`
  (scripts/cli.mjs:6104-6115).
- `runCli(argv, io = { out: console.log })` (cli.mjs:2770). `io.err` defaults to `console.error`
  (cli.mjs:2777). Convention: `io.out` carries the answer, `io.err` carries commentary.
- Flag parsing: `parseFlags` (cli.mjs:200-253). `--name value` only; `--name=value` is refused
  (cli.mjs:222-225); valueless switches are the `VALUELESS_FLAGS` set (cli.mjs:185).
- Pre-dispatch sequence inside `runCli`, in order:
  1. rejected spellings, exit 2 (cli.mjs:2784-2788);
  2. empty `--root` refused (cli.mjs:2799-2802); `root = flags.root ?? process.cwd()` (2803);
  3. unknown flags refused against `KNOWN_FLAGS` + `UNIVERSAL_FLAGS = {root}` (cli.mjs:2810-2815, tables at 332-365);
  4. required args from `REQUIRED` (cli.mjs:2817-2840, table at 273-321);
  5. `migrate(root, ...)` runs before any command (cli.mjs:2845-2846): moves a legacy `.teammates/`
     state dir etc. to the fleetmates spellings;
  6. `--run` containment check under `.fleetmates/` (cli.mjs:2851-2865);
  7. git-writability preflight for `GIT_WRITING_COMMANDS` (cli.mjs:391-393, 2872-2878).
- Dispatch is a flat chain of `if (command === '<name>') { ... return code }` blocks
  (cli.mjs:2880 to 6002), ending in `io.out(USAGE); return 2` (cli.mjs:6100-6101).
- `USAGE` string lists every command (cli.mjs:142-175).

### Existing subcommands (handler line)

`init-run` 2880, `digest` 3100, `claim` 3109, `unclaim` 3115, `locate` 3121, `brief` 3242,
`workflow` 3279, `dispatch` 3392, `dispatch-reviews` 3513, `dispatch-integrator` 3565, `message`
3639, `sessions` 3692, `doctor` 3736, `liveness` 3833, `rebuild-state` 3983, `prune-run` 4118,
`finish` 4477, `plan-drift` 4602, `usage` 4634, `map` 4702, `map-notes` 4766, `preview-check` 4872,
`review-dispatch` 4932, `collect-reviews` 5114, `gate` 5579, `complete` 5730, `fix` 5905,
`record-fix-round` 5980, `config` 6002.

### Tests

- Runner: built-in `node:test` + `node:assert/strict` (e.g. tests/digest.test.mjs:1-3).
- Organisation: one file per module, `tests/<module>.test.mjs` (`state.test.mjs`,
  `digest.test.mjs`, `liveness.test.mjs`, `cli.test.mjs` at 15,515 lines, ...); prose contracts in
  `tests/skill-*.test.mjs`, `agents.test.mjs`, `skill-contracts.test.mjs` using
  `tests/md-contract.mjs`; packaging in `pack.test.mjs`, `packaging.test.mjs`, `npm-scripts.test.mjs`;
  e2e suites skip unless `FLEETMATES_E2E=1`.
- The `test` glob is `tests/*.test.mjs`, NOT recursive: a `tests/hub/x.test.mjs` would never run.
- `npm-scripts.test.mjs:21-26` forbids shell pipelines, `>`, `&&`, `grep` in the named npm scripts
  (Windows cmd.exe).
- Tests shell out to real git (temp repos, worktrees); need a git identity (CONTRIBUTING.md:28-32).
- House rule: every new test is mutation-verified ("would this test fail if the code were wrong",
  CONTRIBUTING.md:34-45).
- CONTRIBUTING.md:21 says "683 passing"; not re-run for this document.

### Lint / format / typing

- No linter or formatter config exists (no eslint, prettier, editorconfig; not in CI).
- Observed style: ESM `.mjs`, no semicolons, single quotes, 2-space indent, trailing commas in
  multi-line literals, long "why" comments that state limits, `printable()` on every agent-derived
  value printed.
- `.gitattributes`: `* text=auto eol=lf`.
- JSDoc typing: effectively not used. `jsconfig.json` has `checkJs: false`. Only
  `scripts/plan-sections.mjs` carries JSDoc tags (`@param`/`@returns`/`@throws`, around lines 53-59,
  125-130, 159-165). Everything else documents in prose comments.
- Commits: single line, commitlint style, English (CONTRIBUTING.md:22). Observed prefixes:
  `fix(scope):`, `feat(scope):`, `docs(scope):`, `test(scope):`, `chore(release):`,
  `merge(<runId>): T<n> ...` for fleet merges.

### docs/ conventions

- `docs/specs/YYYY-MM-DD-<slug>-design.md` (also `-probe-findings.md`, `-notes.md`). Header is
  `# <Title> - design` style plus `Date: YYYY-MM-DD. Release: ...`, then a "Decisions already made"
  table, numbered sections, "Out of scope".
- `docs/plans/YYYY-MM-DD-<slug>.md` are executable fleet plans parsed by `scripts/plan-parser.mjs`:
  `### Task N: <title>` (plan-parser.mjs:1), `**Files:**` followed by
  `- Create|Modify|Test: \`path\`` (lines 2-3), `**Depends:** T1, T2` (line 4), optional
  `**Model:** cheap|mid|capable` (line 7; tiers in routing.mjs:2). Optional plan sections
  `## Destination` (prose), `## Not Yet Specified`, `## Out of Scope` (bullets)
  (plan-sections.mjs:167-170). Plans observed also carry `## Why`, `## Global Constraints`.
- `docs/followups/YYYY-MM-DD-<slug>-open-findings.md`.
- Language: all docs are English. No PT-BR docs and no EN/PT-BR pairing pattern exists.

---

## 2. `.fleetmates/` on-disk layout

State root: `<project root>/.fleetmates/` (`NAMES.stateDir`, scripts/names.mjs:13), gitignored
(.gitignore). Legacy name `.teammates/` (names.mjs:24) is migrated by `scripts/migrate.mjs` on first
CLI touch and read nowhere else (names.mjs:1-4).

```
.fleetmates/
  index/<sha256 of normalised worktree path>.json   # worktree location records, shared by ALL runs
  <runId>/                                          # runId may NEST, e.g. 2026/substop
    plan.json                                       # init-run, rebuild-state, workflow, gate (runBranch fill)
    status.json                                     # the board (section 3)
    claims/<taskId>.json                            # claim/unclaim
    sessions/<taskId>.json                          # headless driver session record
    sessions/<taskId>.{schema.json,result.json,stream.jsonl,stderr.log}
    sessions/review-<lens>.{schema.json,result.json,stream.jsonl,stderr.log}
    sessions/integrator.{schema.json,result.json,stream.jsonl,stderr.log}
    driver.lock                                     # headless driver lock (pid)
    reviews/<phaseName>-<lens>.json                 # reviewer findings drops
    reviews/results-<phase>.json                    # collect-reviews output, exists only on success
    map.md                                          # map-notes output
    *.<pid>.<n>.tmp                                 # transient atomic-write scratch files
```

Sources:
- `runDir(root, runId) = path.join(root, '.fleetmates', runId)` (state.mjs:42-44).
- State file names are allowlisted to `plan`, `status`, `findings` (state.mjs:13, 46-49). No writer
  of `findings.json` was found.
- `index/` is at the state root, not per run (state.mjs:84-107, `indexDir` 325-327). A run
  enumerator must skip it. Precedent: tools/replay/replay.mjs:302-322 counts a directory as a run
  only if it holds `plan.json` or `status.json` (that code does not handle nested ids).
- Nested run ids are legal: `init-run --run 2026/substop` creates `.fleetmates/2026/substop/`
  (state.mjs:197-203; `isRunId` 275-276).
- `claims/<taskId>.json`: `{ "taskId", "teammate" }`, created with flag `wx` (state.mjs:69-81).
- `sessions/`: driver writes (driver.mjs:281-336, 353-406); `dispatch` stamps `harness`
  (cli.mjs:3485-3493); reviewer/integrator sidecars (cli.mjs:3539-3557, 3621-3631).
- `driver.lock` (driver.mjs:282).
- `reviews/<phaseName>-<lens>.json` (reviews.mjs:126), `reviews/results-<name>.json`
  (cli.mjs:5192), removed at the start of every `collect-reviews` round (cli.mjs:5121-5160).
- `map.md` (cli.mjs:4768).
- Nothing ever deletes a run directory (README.md:270-272). Location records are never deleted
  either (state.mjs:94, 329-333).

### Identifiers and names

- Task ids are `T<digits>` minted by the parser: `T1`, `T2`, ... (plan-parser.mjs:57). Capital T.
  There is no `t1`/`t2` teammate naming anywhere in code.
- Id allowlist: `/^[\p{L}\p{M}\p{N}._-]+$/u` per `/`-separated component, NFC only, no `..`, no
  leading `-`, no invisible code points; run id <= 255 bytes, task id <= 128 bytes
  (state.mjs:32-35, 211-278).
- Task branch: `fleetmates/<runId>/<taskId>` (`taskBranchName`, enforce.mjs:9-11).
- Private ref: `refs/fleetmates/<runId>/<taskId>` (`teammateRef`, git.mjs:765-767).
- Run branch: operator-chosen, example `run/<runId>` (skills/parallel-execution/SKILL.md:12);
  recorded as `plan.json.runBranch` by fill-if-absent (cli.mjs:1168-1194).

### plan.json (for reference; the deck will need it to label phases)

Written by `init-run` through `writePlan` (cli.mjs:3031-3040, 1168-1194):

| Field | Type | Notes |
|---|---|---|
| `runId` | string | |
| `totalPhases` | number | max task phase (cli.mjs:2957) |
| `tasks` | array | each: `id`, `title`, `files: string[]`, `deps: string[]`, `brief: string` (plan-parser.mjs:60, 97), `phase: number` (phases.mjs:47-81, `assignPhases`), `tier: 'cheap'\|'mid'\|'capable'`, `tierSource: 'declared'\|'inferred'\|'configured'`, `inferredTier?` (cli.mjs:2937-2978) |
| `planPath` | string | repo-relative, `/`-separated (cli.mjs:2986) |
| `destination` | string \| null | plan-sections.mjs:167 |
| `notYetSpecified` | `{ text, line }[]` | plan-sections.mjs:168 |
| `outOfScope` | `{ text, line }[]` | plan-sections.mjs:169 |
| `runBranch` | string, optional | absent when unknown; never overwritten once set (cli.mjs:1177-1192) |

`rebuild-state` writes `{ runId, totalPhases, tasks }` from git plus the fields above
(rebuild.mjs:27; cli.mjs:4088-4098).

---

## 3. status.json schema

Path: `.fleetmates/<runId>/status.json`. Read by `readState(root, runId, 'status')`
(state.mjs:51-58), written by `writeState` (state.mjs:60-67), pretty-printed JSON with a trailing
newline.

### Top-level fields

| Field | Type | Writer(s) | Notes |
|---|---|---|---|
| `runId` | string | init-run (cli.mjs:3078), rebuild (rebuild.mjs:29) | |
| `phase` | number | init-run: `previous?.phase ?? 1` (cli.mjs:3079); rebuild: `currentPhase ?? totalPhases` (rebuild.mjs:32) | NOT advanced by any command as phases integrate (no writer of `status.phase` found). Treat as stale. The real current phase is derived from git (section 5). |
| `totalPhases` | number | init-run (3080), rebuild (rebuild.mjs:33) | |
| `maxParallel` | number | init-run from resolved config (3081), rebuild (rebuild.mjs:34) | default `max(1, min(8, cores-2))` (gate-config.mjs:11-13) |
| `tasks` | array of task entries | see below | |
| `gates` | object, optional | `gate` (cli.mjs:5713-5726) | preserved across re-init (3083); dropped by rebuild (rebuild.mjs:41) |
| `fixRounds` | object, optional | `record-fix-round` via `recordFixRound` (state.mjs:534-540; cli.mjs:5993-5994) | preserved across re-init (3084); dropped by rebuild |

Other keys may appear: the orchestrator agent edits this file by hand per the skills
("Append every result to `status.json`", skills/parallel-execution/SKILL.md:126; "Note in
`status.json` that the task restarted", same file :369). `gate`, `complete`, `dispatch` and
`record-fix-round` read-modify-write the whole object, so unknown keys survive them.

### Task entry (`tasks[]`)

| Field | Type | Writer | Notes |
|---|---|---|---|
| `id` | string (`T<n>`) | init-run (cli.mjs:3082), rebuild (rebuild.mjs:36) | |
| `title` | string | same | verbatim plan heading text, agent-authored |
| `state` | string | see lifecycle | |
| `startedAt` | number (ms epoch), optional | no code writer found; hand-written by orchestrator | read by digest for `running` (digest.mjs:26-28) |
| `blockedBy` | string, optional | no code writer found; hand-written | read by digest for `blocked` (digest.mjs:31, 41) |

### Task state lifecycle

| State | Set by |
|---|---|
| `pending` | init-run, every task (cli.mjs:3082); rebuild when no branch exists (rebuild.mjs:18-19) |
| `running` | no code writer; orchestrator by hand (digest renders it, digest.mjs:12) |
| `done` | `complete` without `--enforcement-only` (cli.mjs:5891-5892); `dispatch` copying a result status (cli.mjs:3502); rebuild when merged or contributing (rebuild.mjs:20) |
| `blocked`, `failed` | `dispatch` copies the teammate result `status`, enum `done\|blocked\|failed` (result-schema.mjs:8; cli.mjs:3502) |
| `orphaned` | `dispatch` when a task returned nothing (cli.mjs:3503); rebuild when branch exists and contributes nothing (rebuild.mjs:21); orchestrator by hand (fleet-supervision/SKILL.md:103) |

`complete --enforcement-only` (the SubagentStop path) deliberately does NOT write `done`
(cli.mjs:5882-5890). A stopped teammate's task "returns to `pending`, never `done`"
(fleet-lifecycle/SKILL.md:71), done by hand.

Note: the digest only knows `running, done, blocked, orphaned, pending` (digest.mjs:11-19), so a
`failed` task renders under `unknown` (digest.mjs:59-61).

### `gates` entries

Key: `String(ctx.currentPhase ?? phaseName)` for a fleet gate, `solo:<phaseName>` for a
`--no-fleet` gate (cli.mjs:5677). With every phase integrated `currentPhase` is null and the key
falls back to the manifest phase name (e.g. `"default"`). Written with `Object.defineProperty`
so `__proto__` is a real key (cli.mjs:5714-5724). Only written when `--run` was given and
`status.json` exists and parsed (cli.mjs:5685-5713).

Value = `{ ...aggregateVerdict(results), anchorSha, planHash, branchShas, phase, phaseName, recordedAt }`
(cli.mjs:5661-5668, 5720; gate-runner.mjs:1756-1780). `results` itself is NOT stored.

| Field | Type | Notes |
|---|---|---|
| `verdict` | `'PASS'` \| `'FAIL'` | |
| `failed` | string[] | check names |
| `optionalFailed` | string[] | |
| `skipped` | string[] | |
| `pending` | string[] | |
| `anchorSha` | string | absent on solo (undefined is dropped by JSON) |
| `planHash` | string | absent on solo |
| `branchShas` | `{ [branch]: sha }` | may be `{}` |
| `phase` | number \| null | absent on solo |
| `phaseName` | string | manifest key, usually `default` |
| `recordedAt` | number (ms epoch) | |

### `fixRounds`

`{ "<numeric phase as string>": { "<taskId>": <count> } }` (state.mjs:530-540). Bookkeeping only,
agent-resettable (state.mjs:511-513).

### Example

```json
{
  "runId": "mto-followups",
  "phase": 1,
  "totalPhases": 2,
  "maxParallel": 6,
  "tasks": [
    { "id": "T1", "title": "replay.mjs argument fixes", "state": "done" },
    { "id": "T2", "title": "integrator-census test gaps", "state": "running", "startedAt": 1790000000000 },
    { "id": "T3", "title": "integrator-replay fixes", "state": "blocked", "blockedBy": "T2" },
    { "id": "T4", "title": "routing prose", "state": "pending" }
  ],
  "gates": {
    "1": {
      "verdict": "PASS", "failed": [], "optionalFailed": [], "skipped": [], "pending": [],
      "anchorSha": "b11a728...", "planHash": "...", "branchShas": { "fleetmates/mto-followups/T1": "..." },
      "phase": 1, "phaseName": "default", "recordedAt": 1790000500000
    }
  },
  "fixRounds": { "1": { "T1": 1 } }
}
```

(`startedAt`/`blockedBy` shapes follow tests/digest.test.mjs:8-19.)

### Session record (`sessions/<taskId>.json`, headless harnesses only)

Written by the driver (driver.mjs:335, 349, 354, 391-394, 401-404, 422): `taskId`, `sessionId`
(harness session id), `sandbox`, `state` (`running`, then the result status, `failed`, or
`orphaned`), `effortIgnored?`, `exitReason?` (`timeout`, `exit`, `enforcement`, or an error
message), `result?` (RESULT_SCHEMA: `status`, `branch`, `filesChanged`, `summary`, `blockers`,
result-schema.mjs:4-15), `usage?` (`{ input, cachedInput, cacheWrite, output, reasoning }`,
cli.mjs:134-140), `sandboxRemoved?`, plus `harness` stamped by `dispatch` (cli.mjs:3490).
`sessions` and `message` also read `startedAt`, `updatedAt`, `pid` (cli.mjs:3668, 3717); no writer
of those three was found in `scripts/`.

---

## 4. digest.mjs and liveness.mjs

### scripts/digest.mjs (74 lines)

Imports only `printable` from `./reviews.mjs` (line 1). Exports one function:

```js
export function renderDigest(status, now, caveman = false)   // digest.mjs:45
```

- Pure: takes a parsed status object and a ms clock, returns a multi-line string.
- Header: `run <runId> · phase <phase>/<totalPhases> · <n> tasks`, or caveman
  `<runId> p<phase>/<totalPhases> n<n>` (lines 51-53). Uses `status.phase` (the stale value).
- Groups in order `running, done, blocked, orphaned, pending`, then `unknown` for any other state
  (lines 11-19, 55-61); empty groups are omitted (64).
- Per task: running `title(12m)` or `title(?)` when `startedAt` is not a number (22-28); done
  `title ✓` (30); blocked `title` + U+2014 + ` needs <blockedBy>` (31); else title. Caveman forms at
  35-43.
- Footer: `idle slots <maxParallel - running>` floored at 0 (71-72). Throws if `tasks` is missing
  (reads `tasks.length`).
- CLI wrapper: `digest --run <id>` exits 1 with `no status for run <id>` when absent
  (cli.mjs:3100-3107).

### scripts/liveness.mjs (113 lines)

Imports only `printable` from `./reviews.mjs` (line 17). Pure: no git, no fs; the caller gathers
signals (lines 1-12). Exports:

```js
export const DEFAULT_STALE_MINUTES = 20                                     // :19
export function livenessRows({ tasks = [], tips = {}, touches = {}, now,
                               staleMinutes = DEFAULT_STALE_MINUTES } = {})  // :23
export const STALL_HINT = '  -> likely cause: backgrounded command ...'     // :86
export function renderLiveness(rows = [], { staleMinutes = DEFAULT_STALE_MINUTES } = {})  // :88
export function hasStall(rows = [])                                         // :104
export function hasUnknown(rows = [])                                       // :111
```

Inputs: `tasks` = `[{ id }]`; `tips[taskId] = { branch, at }` (last commit time, ms); `touches[taskId]
= { branch, at, floored }` (newest mtime in worktree, ms); `now` must be finite or it throws (:24).

Row: `{ taskId, branch, tipAgeMs, touchAgeMs, floored, state, unknownReason }` (:32, :69).

Staleness logic (threshold = `staleMinutes * 60000`, :25):
1. No tip and no touch record: `state: 'not started'` (:31-33).
2. `fresh` = any measured age (tip or touch) `<= threshold` (:63-64). Fresh: `working`.
3. Else if touch was measured (record present, `at != null`, not floored): `stalled` (:61-68).
4. Else `unknown` with `unknownReason` `'walk-capped'` (floored) or
   `'no-worktree-measurement'` (no touch record or `at` null) (:65-68).
A missing tip is a measured negative, a missing touch is not (:50-60).

`renderLiveness` prints `liveness (stale after Nm)`, a header, one row per task
(`<taskId>  <tip>m  <touched>m[ (floor)]  <state>`, `-` when null) and `STALL_HINT` under each
stalled row (:88-101).

How the CLI gathers the signals (cli.mjs:3833-3981): tasks = current derived phase only (3908);
tip from `git.commitTime` of `fleetmates/<run>/<task>` (3938-3942; git.mjs:500-514 returns
seconds * 1000); touch from `newestMtime(worktreeDir, { ignored })` over the worktree git reports for
that branch (3930-3952; cli.mjs:618-652), capped at `MAX_WALK_ENTRIES = 5000` (cli.mjs:603).
Exit codes: 1 stall, 2 unknown or cannot derive, 0 otherwise (3975-3980). `--stale <minutes>`
overrides (3846-3850).

### `printable()` escaping (scripts/reviews.mjs)

```js
export function printable(value)       // reviews.mjs:57
export function printableBlock(value)  // reviews.mjs:68
```

- `String(value)` then replaces every char in `[\u0000-\u001f\u007f-\u009f  ]` with a
  visible token `<0xHH>` uppercase hex, at least 2 digits, e.g. ESC becomes `<0x1B>` (reviews.mjs:45,
  49, 57-59). `undefined` renders as `"undefined"`.
- `printableBlock` keeps tab and newline, neutralises the rest (reviews.mjs:47, 68-70).
- Deliberately NOT escaped: bidi and format controls (U+202E, U+2066-2069, U+200E/200F, U+061C)
  (reviews.mjs:25-31).
- It is terminal escaping, not HTML escaping. `state.mjs` has a separate private `shown()` that
  JSON-quotes and escapes `\p{Cf}`, spaces and default-ignorables (state.mjs:291-297).

---

## 5. Gates, phases, tasks, teammates, lead, sessions, hooks

- **Phase assignment**: `assignPhases` greedily places tasks whose deps are scheduled and whose
  normalised file sets are disjoint; phase numbers start at 1 (phases.mjs:47-81).
- **Current phase is derived from git, never read from status.json**: `derive()` (cli.mjs:2396-2480)
  requires HEAD on the run branch and refuses if it equals the base (2444-2456), then
  `deriveContext` computes `anchorSha = merge-base(base, run)`, reads the plan at the anchor, finds
  integrated phases and returns `{ currentPhase, phaseError, integratedPhases, anchorSha, runSha,
  planHash, tasks, ... }` (gate-runner.mjs:1043-1202); `derivePhase` = first non-integrated phase or
  an error if a later one is integrated first (enforce.mjs:63-77). `currentPhase == null` means the
  run is fully integrated (cli.mjs:3904-3906).
- **Gate**: `gate --run --plan [--phase <manifest key>] [--no-fleet] [--results]` recomputes from
  git, prints the verdict JSON, records into `status.gates`, exits 0 on PASS else 1
  (cli.mjs:5579-5728). Checks come from `fleetmates.gate.json` `phases.<name>.checks` (kinds
  `command`, `fileset`, `ownership`, `agent`; `merge` is gate-computed). The recorded entry is
  never trusted as evidence (state.mjs:511-529; rebuild.mjs:1-12; CONTRIBUTING.md:67-70).
  Its one consumer that acts on it is `dispatch-integrator`, which looks up the exact numeric key
  (cli.mjs:3565-3608).
- **Teammates**: a teammate is a background Claude Code `Agent` (`fleetmates:tm-implementer`,
  `isolation: 'worktree'`) per task, or a headless codex/cursor process via `dispatch`
  (skills/parallel-execution/SKILL.md:54-122). Workflow agents are labelled by task id
  (templates/phase-workflow.js:30). The only persisted teammate name is the free-form `--by` in
  `claims/<taskId>.json` (state.mjs:69-72; fleet-lifecycle/SKILL.md:58). In practice the teammate is
  identified by its task id.
- **Lead**: no "lead" concept in code. The orchestrator is the main Claude Code session running the
  skills. Harness "agent teams" (`TeamCreate`, `~/.claude/teams`, `TeammateIdle`) is not used
  (docs/specs/2026-08-10-agent-teams-adoption-design.md:6-17, 37-40).
- **How a run is identified**: by its run id, i.e. its directory under `.fleetmates/`, plus the
  branch convention `fleetmates/<runId>/<taskId>` and the recorded `plan.json.runBranch`. There is
  no global registry of runs.
- **Claude Code session mapping**: none is recorded. The SubagentStop hook reads only `cwd` and
  `stop_hook_active` from its payload (subagent-stop.mjs:63-65) and resolves the task through
  `.fleetmates/index/` keyed by worktree path (state.mjs:407-497). The only link to Claude Code
  sessions is `usage`, which reads the harness transcript store
  `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<projectSlug(root)>/<session-id>/subagents/agent-<id>.jsonl`
  and `.meta.json` (usage-store.mjs:3-10; cli.mjs:4673-4681). `projectSlug` replaces `/`, `\`, `:`
  with `-` (usage.mjs:22-24). Without `--session` it picks the newest session dir that has a
  `subagents/` dir (usage-store.mjs:45-77). This layout is explicitly "HARNESS-INTERNAL AND NOT A
  PUBLIC API" (usage-store.mjs:3).
  Headless sessions map task to `sessionId` in `sessions/<taskId>.json`.
- **Hooks** (hooks/hooks.json): `SessionStart` (matcher `startup|resume|clear|compact|fork`) runs
  `session-start` synchronously (injects the `using-fleetmates` skill) and `update-check` async;
  `SubagentStop` runs `node scripts/subagent-stop.mjs`, exit 2 blocks the stop. Update-check state
  lives in `${CLAUDE_CONFIG_DIR}/fleetmates` or `$HOME/.claude/fleetmates` (hooks/session-start,
  `STATE_DIR` block).
- **Config**: `fleetmates.gate.json` (tracked, enforcement keys `phases`, `lens`, `preview`) and
  `fleetmates.local.json` (gitignored ergonomics: `maxParallel`, `caveman`, agent tier/effort)
  (config.mjs:7-23, `loadConfig` 253; names.mjs:11-12).

### CLI commands the deck can reuse (read-only)

| Command | Reads | Output | Exit |
|---|---|---|---|
| `digest --run` | status.json | text board | 0, 1 no status, 2 config |
| `liveness --run --plan [--stale]` | git + worktrees | text rows | 0/1/2 |
| `doctor --run --plan` | git | text report | 0, 1 problems |
| `sessions --run` | sessions/*.json | text table | 0, 1 none |
| `usage [--session] [--json] [--run]` | transcripts or sessions/ | text or JSON | 0/1 |
| `plan-drift --run --plan` | git | text | 0/1 |
| `config list\|get` | config layers | text | 0/2 |

Prefer importing the pure modules instead of scraping text: `readState` (state.mjs:51),
`renderDigest` (digest.mjs:45), `livenessRows`/`hasStall`/`hasUnknown` (liveness.mjs:23, 104, 111),
`newestMtime`/`MAX_WALK_ENTRIES` (exported from cli.mjs:603, 618), `collectDoctorReport`
(doctor.mjs:32), `readSessionUsage` (usage-store.mjs:83), `createGit` (git.mjs:191),
`taskBranchName` (enforce.mjs:9), `NAMES` (names.mjs:9). Importing `cli.mjs` is safe: its
side effect is guarded by `isEntryPoint` (cli.mjs:6113), and tests already import `runCli` directly
(packaging.test.mjs:7). `runCli(argv, { out, err })` returns the exit code and can capture output
in-process (pattern used at cli.mjs:3448-3452, 3525-3528). Avoid write commands (`complete`, `gate`,
`claim`, `record-fix-round`, `init-run`, `dispatch*`) from the deck.

### Where `ui` / `deck init` plug in

1. Add a branch `if (command === 'ui') { ... return <code> }` in `runCli`, before the final
   `io.out(USAGE); return 2` (cli.mjs:6100). `deck init` fits the `config` pattern: one command
   name, subcommand in `positional[0]` (cli.mjs:6002 onward; `config list|get|set|unset`).
2. Add the command to `REQUIRED` (cli.mjs:273-321, `[]` if nothing is required, and say so in a
   comment as `config` does at 317-320) and to `KNOWN_FLAGS` (cli.mjs:333-365). The tripwire test
   regex-scans the source for `command === '<name>'` and requires both tables to match exactly
   (tests/cli.test.mjs:9919-9927); another test sends `--totally-bogus` to every command and expects
   exit 2 (tests/cli.test.mjs:9886-9897), so a long-running server command must validate flags
   before it binds a port.
3. Add a line to `USAGE` (cli.mjs:142-175) and to README "Commands" (README.md:218-272).
4. Do not add it to `GIT_WRITING_COMMANDS` (cli.mjs:391-393) unless it writes git.
5. Remember `migrate()` runs first for every command (cli.mjs:2845), so `ui` inherits the legacy
   `.teammates` migration and its refusals.
6. A literal `fleetmates ui` needs a `"bin"` in package.json, which reverses a recorded decision
   (rename spec :11, :207). The in-policy form is `node scripts/cli.mjs ui`.
7. Shipping `hub/` needs `"hub/"` in `package.json` `files`; pack.test.mjs:32 only forbids
   `tests/ docs/ .github/ tools/`. Hub tests must live at `tests/*.test.mjs` to be globbed.
8. Zero-dependency rule applies to the hub too (CONTRIBUTING.md:18-19): `node:http`, no framework,
   no bundler, unless that rule is explicitly changed.

---

## 6. Stability, versioning and reader risks

### Guarantees

- None stated. No `schemaVersion` field in `status.json` or `plan.json`; no document calls these
  files a public or stable interface. Search for semver/schema-version/public-API wording found only
  the transcript-store disclaimer (usage-store.mjs:3).
- The design treats `.fleetmates/` as disposable bookkeeping: gitignored, reproducible by
  `rebuild-state`, which drops `gates` and `fixRounds` on purpose (rebuild.mjs:1-12, 41).
- Precedent for breaking changes: 2.0.0 renamed every on-disk name, bridged only by
  `migrate.mjs` (rename spec :3-4; names.mjs:1-4, 20-29).
- Practical contract: the deck lives in the same repo and package, so it should import
  `names.mjs`/`state.mjs` rather than restate paths, tolerate missing and unknown fields, and pin the
  shapes it depends on with tests in `tests/`.

### Risks for a reader

1. **Atomic replace, not locked**: `writeState` writes `<file>.<pid>.<n>.tmp` then `rename`s over
   the target (state.mjs:60-67). A reader sees the whole old or whole new file on POSIX. A crash can
   leave `*.tmp` files behind; `fs.watch` will fire for tmp names and for the rename. Windows
   rename-over-open-file behaviour was not measured here.
2. **Lost updates between writers**: `gate`, `complete`, `dispatch`, `record-fix-round` and the
   orchestrator's hand edits all read-modify-write the whole file with no lock
   (cli.mjs:3498-3505, 5713-5725, 5878-5892, 5984-5994). The deck must never write status.json.
3. **Non-atomic writes elsewhere**: session records use plain `writeFile` (driver.mjs:123-125;
   cli.mjs:3491), and claims are created with `wx` then filled (state.mjs:75). Expect empty or
   truncated JSON; retry on parse failure.
4. **Corrupt JSON throws**: `readState` returns null only for ENOENT and rethrows parse errors
   (state.mjs:51-58). Show an error state, do not crash.
5. **FIFO / symlink**: `readState` opens by path, follows symlinks, and a FIFO parks the open
   forever (cli.mjs:1749-1758). Read with `O_RDONLY|O_NONBLOCK` and check `isFile()` as
   `findTaskByWorktree` does (state.mjs:414-433; cli.mjs:1786-1789).
6. **Agent-written content**: titles, `blockedBy`, ids, gate fields and all of `status.json` are
   written by the agents being supervised (skills/fleet-supervision/SKILL.md:18). HTML-escape
   everything; `printable` alone is not HTML-safe and passes bidi controls.
7. **`status.phase` is stale** and `state` values are claims (`done` is a claim until the gate,
   skills/parallel-execution/SKILL.md:139). Label `gates` as "recorded", not verified.
8. **Unknown states**: `failed` (and any hand-written state) is outside the digest's known set.
9. **Run discovery**: skip `.fleetmates/index/`, handle nested run ids, treat a dir as a run only if
   it holds `plan.json` or `status.json`.
10. **Deriving truth is expensive and checkout-dependent**: `derive` needs the main worktree on the
    run branch (cli.mjs:2409-2456) and shells out to git; `liveness` walks up to 5000 entries per
    worktree. Poll these on a slow timer, not per request.
11. **Missing optional fields**: `gates`, `fixRounds`, `startedAt`, `blockedBy`, `runBranch`, and
    solo-gate `anchorSha`/`planHash`/`phase` may all be absent.
