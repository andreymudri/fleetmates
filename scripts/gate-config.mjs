import { LEGACY, NAMES } from './names.mjs'
import { normalizePath } from './enforce.mjs'
import { QUARANTINE_FILE } from './flaky.mjs'
import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'

const MANIFEST = NAMES.gateFile
const INFERRED_ORDER = ['typecheck', 'lint', 'test', 'build']
const DEFAULT_FIX_ROUNDS = 2
const DEFAULT_LENS = ['correctness', 'security', 'tests']

export function defaultMaxParallel() {
  return Math.max(1, Math.min(8, availableParallelism() - 2))
}

export async function loadGateConfig(root) {
  try {
    return JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// The suggested `test` check carries the runner's own refusal of a focused test and, where the
// runner writes JUnit without a dependency, the test inventory's report contract. `node --test`
// ignores `.only` unless `--test-only` is given, so it needs no flag; Jest has no refusal at all,
// and a focused Jest suite shows up as drops in the inventory instead.
function inferTestCheck(script, platform) {
  // Only a script that names no reporter of its own: added reporters would leave node with more
  // reporters than destinations, and it refuses to start (review, reproduced on this repository).
  // The flags go right after `node --test` in the script itself — node stops reading its own
  // options at the first positional argument, so `npm run test -- …` never reaches the runner, and
  // NODE_OPTIONS is inherited by every nested `node --test` a suite spawns, which then writes into
  // the same report (both measured).
  // `--test` as a whole flag: `--test-concurrency` and `--test-only` must not match (review: the
  // rewrite glued the rest of such a flag onto the report path). The script no longer runs through
  // `npm run`, so `node_modules/.bin` is put on PATH the way npm would.
  // The rewrite is sh (`PATH=…`, `$FLEETMATES_REPORT_DIR`), and win32 runs checks through cmd.exe,
  // which expands neither — the suite would write its report to a literal `$FLEETMATES_REPORT_DIR`
  // directory and the inventory would fail every gate (measured on the release CI). There the
  // plain check is suggested and the report left for the user to add in cmd syntax.
  const nodeTest = /\bnode\s+--test(?=\s|$)/
  if (platform !== 'win32' && nodeTest.test(script) && !/--test-reporter/.test(script) && !/[;&|`$\\]/.test(script)) {
    return {
      name: 'test',
      kind: 'command',
      run: `PATH="$PWD/node_modules/.bin:$PATH" ${script.replace(nodeTest, 'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="$FLEETMATES_REPORT_DIR/node.xml"')}`,
      report: { format: 'junit', dir: true },
    }
  }
  if (/\bvitest\b/.test(script)) return { name: 'test', kind: 'command', run: 'npm run test -- --allowOnly=false' }
  if (/\bmocha\b/.test(script)) return { name: 'test', kind: 'command', run: 'npm run test -- --forbid-only' }
  return { name: 'test', kind: 'command', run: 'npm run test' }
}

export function inferGateConfig(pkg, { platform = process.platform } = {}) {
  const scripts = pkg?.scripts ?? {}
  const checks = INFERRED_ORDER
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => (name === 'test' ? inferTestCheck(scripts.test, platform) : { name, kind: 'command', run: `npm run ${name}` }))

  checks.push({ name: 'fileset', kind: 'fileset' })
  checks.push({ name: 'ownership', kind: 'ownership' })

  checks.push({
    name: 'review',
    kind: 'agent',
    agent: 'tm-reviewer',
    blockOn: ['high'],
  })

  const config = {
    maxParallel: defaultMaxParallel(),
    lens: DEFAULT_LENS,
    phases: { default: { fixRounds: DEFAULT_FIX_ROUNDS, checks } },
  }
  // Inference happens only while a manifest is being created — `gate` exits 3 and prints this
  // for confirmation. At gate time nothing is inferred: the gate links exactly what the saved
  // manifest says, so the default is visible in a file the user approved.
  if (pkg) config.preview = { link: ['node_modules'] }
  return config
}

// Top-level rather than per-phase: what a project needs in order to run its checks does not
// vary by phase. Absent or empty means link nothing, which is the behaviour before this field
// existed, so no existing manifest changes meaning.
export function previewLinks(config) {
  const link = config?.preview?.link
  return Array.isArray(link) ? link : []
}

// The two checks no manifest can remove. Everything they decide is computed from git; the only
// thing the manifest contributes is the protected set, and only through its top-level key.
export const ENFORCEMENT_CHECK_KINDS = ['fileset', 'ownership']

// The gate manifest is always protected, under both names: the current one is what the gate
// reads, and the legacy one is what a later migration would adopt. The flaky quarantine is
// protected with it, so a teammate cannot quarantine its own failing test. `protected` only adds.
export function protectedPaths(config) {
  const extra = Array.isArray(config?.protected) ? config.protected : []
  return [...new Set([NAMES.gateFile, LEGACY.gateFile, QUARANTINE_FILE, ...extra].map(normalizePath))]
}

const PORTABILITY_LENS = 'portability'
const PORTABILITY_OSES = ['macos', 'windows']

// The lenses of the phase's review (`agent`) check, plus `portability` when the project's CI runs
// on macOS or Windows. `summary` is `workflowSummary` from scripts/ci-workflows.mjs; a lens the
// manifest already lists is kept once. A phase with no review check has no lenses to dispatch.
// The phase name `run` resolves the run review's check (`checksForRun`), not a manifest block.
export function reviewLenses(config, phaseName, summary) {
  const checks = phaseName === RUN_PHASE ? checksForRun(config) : checksForPhase(config, phaseName)
  const review = checks.find((check) => check?.kind === 'agent')
  if (!review) return []
  const lenses = [...new Set(review.lens)]
  const oses = summary?.oses instanceof Set ? summary.oses : new Set(Array.isArray(summary?.oses) ? summary.oses : [])
  if (PORTABILITY_OSES.some((os) => oses.has(os)) && !lenses.includes(PORTABILITY_LENS)) lenses.push(PORTABILITY_LENS)
  return lenses
}

// Where an `agent` check reviews: on each phase gate (`phase`), or once on the run's integrated
// diff (`run`), which `finish` computes as the reserved entry named `run` after the numbered
// phases (docs/specs/2026-11-06-cost-cuts-design.md, section 2). A `scope` that is absent, or not
// one of the two, takes the default; `validateGate` refuses any other value in the tracked
// manifest, so only a programmatic caller reaches the fallback with one.
export const REVIEW_SCOPES = ['phase', 'run']
export const DEFAULT_REVIEW_SCOPE = 'phase'
export const RUN_PHASE = 'run'

export function reviewScope(check) {
  return REVIEW_SCOPES.includes(check?.scope) ? check.scope : DEFAULT_REVIEW_SCOPE
}

// Strict `kind` comparison on purpose: a non-string kind is never a review here, so it stays in the
// phase's list, where `runChecks` diagnoses and fails it, instead of moving to a gate that may not run.
function runScopedReview(check) {
  return check?.kind === 'agent' && reviewScope(check) === 'run'
}

// The computed check of the run entry. Like `fileset` it reads git and the anchored plan only; it is
// injected into the run entry when that list lacks it, and its `protected` set is overwritten.
export const RUN_CHECK_KINDS = ['fileset-run']
const PROTECTED_KINDS = [...ENFORCEMENT_CHECK_KINDS, ...RUN_CHECK_KINDS]

// The per-entry rules `checksForPhase` and `checksForRun` share. See `checksForPhase` for why each
// overwrite is an overwrite.
function normalizeCheck(check, { fallback, guarded, expectedSkips }) {
  let out = check
  if (out && typeof out === 'object' && Object.hasOwn(out, 'injected')) {
    out = { ...out }
    delete out.injected
  }
  if (out?.kind === 'agent' && !Array.isArray(out.lens)) return { ...out, lens: fallback }
  if (PROTECTED_KINDS.includes(out?.kind)) return { ...out, protected: guarded }
  if (out?.kind === 'command' && out.report !== undefined) return { ...out, skips: expectedSkips }
  return out
}

function normalizeRules(config) {
  return {
    fallback: Array.isArray(config?.lens) && config.lens.length ? config.lens : DEFAULT_LENS,
    guarded: protectedPaths(config),
    expectedSkips: Array.isArray(config?.skips) ? config.skips.map((s) => s?.file).filter((f) => typeof f === 'string') : [],
  }
}

// Appends an injected entry for each kind the list lacks. Results are keyed by name, so an injected
// check must not collide with a declared one that happens to carry this name under another kind.
function injectMissing(result, kinds, guarded) {
  const names = new Set(result.map((check) => check?.name))
  for (const kind of kinds) {
    if (result.some((check) => check?.kind === kind)) continue
    let name = kind
    for (let n = 1; names.has(name); n += 1) name = n === 1 ? `${kind}:injected` : `${kind}:injected-${n}`
    names.add(name)
    result.push({ name, kind, injected: true, protected: guarded })
  }
  return result
}

// The manifest blocks that hold a phase's checks: every key of `phases` but the reserved `run`,
// `default` first. A run-scoped review declared on a named phase is still the run's to carry —
// leaving it out of both gates would drop a review the manifest asked for without a word.
function phaseBlocks(config) {
  const phases = config?.phases ?? {}
  const names = Object.keys(phases).filter((name) => name !== RUN_PHASE && name !== 'default')
  return ['default', ...names].map((name) => phases[name]).filter((block) => block && typeof block === 'object')
}

// Whether `finish` computes the reserved `run` entry: some block carries a run-scoped review, or
// the manifest declares `phases.run`. With neither, a run's verdicts are exactly the phase gates'.
export function hasRunEntry(config) {
  const phases = config?.phases
  if (phases && typeof phases === 'object' && Object.hasOwn(phases, RUN_PHASE)) return true
  return phaseBlocks(config).some((block) => Array.isArray(block.checks) && block.checks.some(runScopedReview))
}

// The checks of the run entry. `phases.run.checks` when declared. Otherwise the `default` block's
// `command` checks, then every run-scoped review (from `default`, then from the named phases, the
// first of each name only: results are keyed by name), then the computed `fileset-run`. `fileset`,
// `ownership` and phase-scoped reviews stay on the phase gates. The lens fallback and the
// `protected` and `skips` overwrites are `checksForPhase`'s, and `fileset-run` is injected into a
// declared `phases.run` that lacks it too, so the manifest can no more drop it than `fileset`.
export function checksForRun(config) {
  const rules = normalizeRules(config)
  const declared = config?.phases?.[RUN_PHASE]?.checks
  let checks
  if (Array.isArray(declared)) {
    checks = declared
  } else {
    const commands = (config?.phases?.default?.checks ?? []).filter((check) => check?.kind === 'command')
    const reviews = []
    const seen = new Set()
    for (const block of phaseBlocks(config)) {
      for (const check of Array.isArray(block.checks) ? block.checks : []) {
        if (!runScopedReview(check) || seen.has(check.name)) continue
        seen.add(check.name)
        reviews.push(check)
      }
    }
    checks = [...commands, ...reviews]
  }
  return injectMissing(checks.map((check) => normalizeCheck(check, rules)), RUN_CHECK_KINDS, rules.guarded)
}

// `fileset` and `ownership` are injected when the phase's list lacks them. The manifest the gate
// reads is the run tip's, AFTER the last integration: a merge that removed `ownership` from it
// would otherwise switch off, at the next gate, the one check that reports that merge. Every
// consumer (`gate`, `complete`, `finish`, `prune-run`) reads its checks through here, so this is
// the single injection point. The operator's `--no-fleet` flag stays the only way not to run them.
//
// A declared entry of either kind gets `protected` overwritten, not merged: the manifest widens the
// set through its top-level key only, so no per-check field can narrow what these checks enforce.
//
// `injected` is this function's mark, never the manifest's: a declared entry carrying it would have
// its name printed as if this code had chosen it, and the name is manifest text. The inventory's
// expected skips come from the top-level `skips` only, overwriting anything the check entry
// carries, the same rule as `protected`.
//
// A run-scoped review (`reviewScope`) is left out: `finish` carries it in the run entry
// (`checksForRun`). Leaving it out shifts the list position of every later entry, and a malformed
// entry is reported by that position, so after a run-scoped review the reported number is one low.
export function checksForPhase(config, phaseName) {
  const phases = config?.phases ?? {}
  const checks = (phases[phaseName]?.checks ?? phases.default?.checks ?? []).filter((check) => !runScopedReview(check))
  const rules = normalizeRules(config)
  return injectMissing(checks.map((check) => normalizeCheck(check, rules)), ENFORCEMENT_CHECK_KINDS, rules.guarded)
}

// A fix-round budget is only meaningful as a non-negative whole number: the loop
// compares `roundsSoFar >= budget`, and any other value makes that comparison
// NaN -> false forever, leaving the retry loop unbounded. Discard anything else
// so the next fallback in the chain supplies a usable bound.
function validFixRounds(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

export function fixRoundsForPhase(config, phaseName) {
  const phases = config?.phases ?? {}
  return validFixRounds(phases[phaseName]?.fixRounds)
    ?? validFixRounds(phases.default?.fixRounds)
    ?? DEFAULT_FIX_ROUNDS
}
