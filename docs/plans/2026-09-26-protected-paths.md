# Protected Paths and Non-Removable Enforcement Checks — Implementation Plan

Spec: `docs/specs/2026-09-26-protected-paths-design.md`

## Global Constraints

- Node >= 20, zero new runtime dependencies, ESM `.mjs`
- Code style matches the surrounding file: no semicolons, two-space indent, single quotes, comments explain why
- Tests use `node:test` + `node:assert/strict`; enforcement behaviour is tested against real git repositories, never a fake git
- Commit messages: single-line, commitlint style, English; no co-author or tool attribution lines
- `npm test` green at the end of every task
- Source-text assertions strip comments before counting a symbol

## Destination

A manifest, a teammate or an integrator merge can no longer switch off `fileset` or `ownership`, and a task can only change a protected path when the plan at the anchor marks it `(protected)`.

## Out of Scope

- The weakened-test detector — spec 2, depends on this one landing first.
- Globs in `protected` — exact paths until someone asks.
- A manifest opt-out for the enforcement checks — `--no-fleet` already exists outside the run's reach.

### Task 1: plan parser — `(protected)` modifier and refusal of malformed file lines

**Files:**
- Modify: `scripts/plan-parser.mjs`
- Test: `tests/plan-parser.test.mjs`
- Modify: `skills/writing-plans/SKILL.md`
- Test: `tests/skill-writing-plans.test.mjs`

- [ ] **Step 1:** Failing tests in `tests/plan-parser.test.mjs`:
  - `- Modify (protected): \`fleetmates.gate.json\`` puts the path in both `task.files` and `task.protectedFiles`; same for Create and Test.
  - A task without the modifier has `protectedFiles: []`.
  - `- Modify (Protected): \`x\``, `- Modify (protect): \`x\``, `- Modfy: \`x\`` and `- Modify: \`x\` (new)` inside a `**Files:**` block each throw an Error whose message contains the 1-based line number and the line text.
  - The same malformed lines OUTSIDE a Files block, or inside a fence, do not throw.
  - Regression: every `docs/plans/*.md` parses without throwing and yields the same `{ id, files, deps }` as `parsePlan` with the modifier support removed — implemented by comparing against a snapshot built in the test from a copy of the old regex (`/^-\s+(?:Create|Modify|Test)\s*:\s*\`([^\`]+)\`\s*$/`). If a plan throws, fix the plan, not the parser.
- [ ] **Step 2:** Implement:

  ```js
  const FILE_LINE = /^-\s+(?:Create|Modify|Test)(\s+\(protected\))?\s*:\s*`([^`]+)`\s*$/
  // Anything shaped like a file line. Inside a Files block a line of this shape that FILE_LINE
  // does not match is refused: it used to drop out of `files` silently, and with `(protected)`
  // a typo would silently remove scope permission.
  const FILE_LINE_SHAPE = /^-\s+[A-Za-z]+(\s*\([^)]*\))?\s*:\s*`/
  ```

  Track the line number in the loop; in the `inFiles` branch push `file[2].split(':')[0]` to `files` and, when `file[1]`, to `protectedFiles`; when `FILE_LINE_SHAPE` matches but `FILE_LINE` does not, `throw new Error(\`plan line ${n}: unrecognised file line — use "- Create|Modify|Test[ (protected)]: \\\`path\\\`": ${line.trim()}\`)`. Initialise `protectedFiles: []` on each task.
- [ ] **Step 3:** Update `skills/writing-plans/SKILL.md` "Machine-readable task format": document the optional ` (protected)` modifier (exact lower case), what it authorises, that it is read from the plan at the anchor, and replace "Any other bullet form is silently dropped" with the refusal. Adjust `tests/skill-writing-plans.test.mjs` if it pins the old sentence.
- [ ] **Step 4:** `npm test`, commit `feat(plan-parser): accept the (protected) modifier and refuse malformed file lines`.

### Task 2: manifest — `protected` key, `protectedPaths`, implicit enforcement checks

**Files:**
- Modify: `scripts/config.mjs`
- Modify: `scripts/gate-config.mjs`
- Test: `tests/config.test.mjs`
- Test: `tests/gate-config.test.mjs`

- [ ] **Step 1:** Failing tests:
  - `ENFORCEMENT_KEYS` equals `['phases', 'lens', 'preview', 'protected']`; `validateLocal` rejects `protected` in the local file.
  - `ENFORCEMENT_VALIDATORS.protected` rejects: non-array, non-string entry, empty string, absolute path, `..` and `a/../../b` escapes; accepts `['package.json', 'tests/conftest.py']`.
  - `protectedPaths({})` → `['fleetmates.gate.json', 'teammates.gate.json']`; with `protected: ['package.json']` appends it, normalised, no duplicates.
  - `checksForPhase` on a phase with no enforcement checks returns the declared checks followed by `{ name: 'fileset', kind: 'fileset', injected: true, protected: [...] }` and `{ name: 'ownership', kind: 'ownership', injected: true, protected: [...] }`; with both declared, no injection and no `injected` key; with only one declared, only the other is injected; a declared entry's own `protected` field is overwritten by `protectedPaths(config)` (the manifest can widen through the top-level key only).
- [ ] **Step 2:** `config.mjs`: add `'protected'` to `ENFORCEMENT_KEYS` and a validator:

  ```js
  protected: (v) => {
    if (!Array.isArray(v)) throw new ConfigError('protected must be an array of repo-relative paths')
    for (const entry of v) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new ConfigError(`protected entries must be non-empty strings, got ${JSON.stringify(entry)}`)
      }
      const normalized = path.posix.normalize(entry.replaceAll('\\', '/'))
      if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)
        || normalized === '..' || normalized.startsWith('../')) {
        throw new ConfigError(`protected entry must be repo-relative, got ${JSON.stringify(entry)}`)
      }
    }
    return v
  },
  ```
- [ ] **Step 3:** `gate-config.mjs`:

  ```js
  export const ENFORCEMENT_CHECK_KINDS = ['fileset', 'ownership']

  export function protectedPaths(config) {
    const extra = Array.isArray(config?.protected) ? config.protected : []
    return [...new Set([NAMES.gateFile, LEGACY.gateFile, ...extra].map(normalizePath))]
  }
  ```

  In `checksForPhase`, after the lens mapping: every entry whose kind is in `ENFORCEMENT_CHECK_KINDS` gets `protected: protectedPaths(config)`; for each kind absent from the list, append `{ name: kind, kind, injected: true, protected }`. If a declared check already uses the name `fileset`/`ownership` with another kind, name the injected one `<kind>:injected` so results stay unique.
- [ ] **Step 4:** `npm test`, commit `feat(gate-config): protected paths and implicit fileset/ownership checks`.

### Task 3: gate — protected rule in fileset, protected conflicts in ownership, injection notes

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/gate-runner.test.mjs`

**Depends:** T1, T2

- [ ] **Step 1:** Failing real-git tests in `tests/gate-runner.test.mjs` (through `runFilesetCheck` / `runOwnershipCheck` with a real `createGit`):
  - fileset: a task that edits, deletes, `git mv`s away, `git mv`s onto, or case-renames `fleetmates.gate.json` fails with a line under `protected:`; the case-only rename commit is built with `git update-index --index-info`, `write-tree` and `commit-tree`, never through the worktree; the same task marked `(protected)` passes; declared without marking fails; an out-of-scope file and a protected file in one task produce both headings.
  - ownership: a two-way conflict on the manifest resolved by hand fails when no secondary parent belongs to a task marking it, passes when one does; the same conflict on an unprotected file passes.
  - ownership injected: an `injected: true` ownership check that fails ends with the injected-check note; a declared one does not.
- [ ] **Step 2:** `runFilesetCheck`: build `const guarded = new Set((check.protected ?? []).map((p) => normalizePath(p).toLowerCase()))`; per task, after the out-of-scope computation:

  ```js
  // Membership folds case (a case-insensitive filesystem may open `Fleetmates.gate.json` as the
  // manifest); authorisation does not. A marking with different case escalates. Deliberate —
  // do not fold the authorisation side, that loosens it.
  const marked = new Set((task.protectedFiles ?? []).map(normalizePath))
  const touched = changed.map(normalizePath).filter((p) => guarded.has(p.toLowerCase()) && !marked.has(p))
  ```

  Collect scope problems and protected problems separately; output `out of scope:\n…` and `protected (mark it "Modify (protected)" in the plan on the base branch, or revert):\n…` sections, each line prefixed with the task id.
- [ ] **Step 3:** `mergeContentExplainedByParents(git, firstParent, secondaryParents, mergeSha, guard)`: `guard = { paths: Set<lowercase>, authorised: Set<exact> }`. Where a file is a genuine conflict or has `cleanContributions.size > 1`, if `guard.paths.has(file.toLowerCase()) && !guard.authorised.has(file)` return `{ ok: false, file }`; return `{ ok: true }` otherwise, and adapt the caller. In `runOwnershipCheck`, build `authorised` per merge: the union of `protectedFiles` of every task whose branch sha has a secondary parent as ancestor. Unexplained-by-protected merges are reported as `merge <sha> resolved a conflict on protected <file> with no parent from a task marking it (protected)`.
- [ ] **Step 4:** In `runOwnershipCheck`, when failing and `check.injected === true`, append `\ncheck injected: the manifest does not declare it; the commits above may predate this fleetmates version, or come from an inline run (use --no-fleet)`.
- [ ] **Step 5:** `cli.mjs`: where `gate`, `complete`, `finish` and `prune-run` print their header for a phase, print one line `injected <names>: the manifest does not declare them` when `checksForPhase` injected anything. Keep stdout JSON-parseable where a command prints JSON — if the command's stdout is a single JSON document, carry the note as an `injected` field instead of a line.
- [ ] **Step 6:** `npm test`, commit `feat(gate): protected paths in fileset and ownership, notes for injected checks`.

### Task 4: adversarial tests and docs

**Files:**
- Test: `tests/adversarial.test.mjs`
- Modify: `docs/specs/2026-08-05-tamper-evident-enforcement-design.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Depends:** T3

- [ ] **Step 1:** Adversarial tests, each in its own `withRepo`:
  1. Narrowing a declared check: a phase-1 integrator merge rewrites the manifest's `ownership` entry (`optional: true`, extra fields) and smuggles content; the phase-2 gate fails naming that merge. A second case removes both entries outright; still fails.
  2. Last phase: the same smuggled merge as the final integration; `finish` refuses.
  3. Early warning: a task declaring `fleetmates.gate.json` without marking; `complete --enforcement-only` exits 3.
  4. Rejection is not a pass: a merge leaves `"protected": "package.json"`; `gate` exits non-zero with no verdict in `status.json`, and `finish` refuses.
  5. Inline run: `init-run`, no task branches, commits straight on the run branch, manifest without enforcement checks; `gate` fails with the injected-check note; `gate --no-fleet` behaves as before.
  6. LIMIT: a hand-resolved conflict on an unprotected path passes `ownership`.
- [ ] **Step 2:** Docs: add the protected-path rule and injection to "Enforced" and the base-branch trust boundary plus unprotected conflicts to "Not defended against" in the tamper-evident spec; in `skills/parallel-execution/SKILL.md` "Amending a plan mid-run", say approving an escalated protected change is exactly that amendment; in `skills/phase-gate/SKILL.md`, the two fileset headings and the injected note; README manifest section gains `protected`; CHANGELOG `Unreleased` entry.
- [ ] **Step 3:** `npm test`, commit `test(adversarial): protected paths and non-removable enforcement checks; docs`.
