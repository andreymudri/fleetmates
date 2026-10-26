import { escalateTier, TIERS } from './routing.mjs'
import { normalizePath } from './enforce.mjs'

// A fileset or ownership failure is a process violation, not a code defect. Retrying it would
// apply optimisation pressure toward widening the plan's file set, which phase-gate forbids.
const PROCESS_KINDS = new Set(['fileset', 'ownership', 'inventory'])

const DEFAULT_FIX_ROUNDS = 2

// A plan written before model routing existed carries no tier. `escalateTier` throws on an
// unknown tier, and this function's whole contract is to return a decision the caller can
// serialise, so an old plan must not turn a gate FAIL into an uncaught crash. `mid` is the
// same default `inferTier` falls through to.
const DEFAULT_TIER = 'mid'

// `??` guarded only null/undefined, but `fix` reads plan.json out of `.fleetmates/`, which is
// agent-writable and re-read AFTER `init-run` validated the declared tiers. Any other value —
// `"fast"`, `""`, `3`, an object — reached `escalateTier` and threw `unknown tier`, killing the
// decision step with nothing on stdout. An unrecognised tier is no more informative than a
// missing one, so it takes the same fallback and `escalateTier` only ever sees a member of TIERS.
function safeTier(tier) {
  return TIERS.includes(tier) ? tier : DEFAULT_TIER
}

// `rounds` is JSON.parse output, so `rounds[id]` resolves up the prototype chain: a task id of
// `constructor` yielded Object itself, which `??` does not catch (not nullish) and which compares
// false against the budget, so the task retried forever with `round` a concatenated function
// source. Own keys only, and only a finite non-negative number counts — anything else is 0.
function roundsFor(rounds, id) {
  if (rounds === null || typeof rounds !== 'object') return 0
  if (!Object.hasOwn(rounds, id)) return 0
  const value = rounds[id]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

// Every list decideFix walks arrives from JSON.parse, where "valid JSON" is far wider than
// "array". `?? []` accepted `{}` and `5` alike, and the caller's try covers only readFile and
// JSON.parse, so a non-array here threw past it. Absent and malformed both mean "nothing usable".
function asArray(value) {
  return Array.isArray(value) ? value : []
}

// Both sides of every comparison go through `normalizePath` (the repo-wide convention, from
// enforce.mjs) so a reviewer that reports `C:\repo\src\a.mjs` still matches the plan's
// declared POSIX `src/a.mjs`. Normalisation alone is not enough: it leaves an absolute path
// with a machine-specific prefix, so a declared path carrying a directory is matched as a
// whole trailing run of path segments rather than by raw equality — `vendor/other-src/a.mjs`
// is not `src/a.mjs`.
//
// A declared path with NO directory (`a.mjs`) gets no such latitude: it has nothing to anchor
// it, so a trailing-segment match would let it claim every same-named file in the tree, which
// is the widest over-attribution available. It matches the repo-root file only.
function declaredMatch(declared, candidate) {
  const file = normalizePath(declared)
  if (!file) return 0
  if (candidate === file) return file.length
  if (file.includes('/') && candidate.endsWith(`/${file}`)) return file.length
  return 0
}

// Specificity, not array order, decides ownership. When T1 declares `src/a.mjs` and T2 declares
// `vendor/src/a.mjs`, a report of `vendor/src/a.mjs` suffix-matches BOTH; `tasks.find` then
// handed the retry to whichever task the plan listed first. Retrying T1 for a file outside its
// own declared write set either wastes the round or pushes T1 to widen its fileset and fail the
// next gate. The longest declared path that matches is the one that actually owns the file.
function ownerOf(tasks, reported) {
  const candidate = normalizePath(reported)
  let owner = null
  let best = 0
  for (const task of tasks) {
    for (const declared of asArray(task.files)) {
      const score = declaredMatch(declared, candidate)
      if (score > best) {
        best = score
        owner = task
      }
    }
  }
  return owner
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g

// Path characters that may not sit directly against a match in free-form command output. `/` is
// tolerated on the leading side of a declared path that carries a directory — an absolute path
// legitimately prefixes it — but not for a bare filename, which must not be reached through any
// parent directory. A trailing `/` would make the match a directory component of some other
// path, and a trailing `.` or `-` a neighbouring file such as `src/a.mjs.snap`, which belongs to
// nobody. An unbounded `output.includes(file)` attributed all of those to the declaring task.
//
// Returns the end offset of every occurrence rather than a boolean, so two declared paths that
// match the same text can be compared: `src/a.mjs` and `vendor/src/a.mjs` both match the run
// ending at the same offset, and only the longer one is a real mention.
function mentionEnds(output, declared) {
  const normalized = normalizePath(declared)
  if (!normalized) return []
  const file = normalized.replace(REGEX_META, '\\$&')
  const lead = normalized.includes('/') ? '0-9A-Za-z._-' : '0-9A-Za-z._\\-/'
  const re = new RegExp(`(?<![${lead}])${file}(?![0-9A-Za-z._\\-/])`, 'g')
  const ends = []
  for (const match of output.matchAll(re)) ends.push(match.index + match[0].length)
  return ends
}

function attribute(check, tasks) {
  const ids = new Set()
  if (check.kind === 'agent') {
    for (const finding of asArray(check.findings)) {
      const owner = ownerOf(tasks, finding?.file)
      if (owner) ids.add(owner.id)
    }
    return [...ids]
  }
  if (check.kind === 'command') {
    // Deliberately conservative. Retrying the wrong teammate on someone else's failure
    // wastes a round and pollutes an innocent branch, so no match means escalate.
    const output = normalizePath(check.output ?? '')
    // Collect every occurrence with its end offset, then keep only the longest declared path at
    // each offset. Comparing per occurrence rather than per task means output that names both
    // `vendor/src/a.mjs` and `src/a.mjs` on separate lines still attributes to both owners.
    const byEnd = new Map()
    for (const task of tasks) {
      for (const declared of asArray(task.files)) {
        const length = normalizePath(declared).length
        for (const end of mentionEnds(output, declared)) {
          const current = byEnd.get(end)
          if (!current || length > current.length) byEnd.set(end, { id: task.id, length })
        }
      }
    }
    for (const { id } of byEnd.values()) ids.add(id)
    return [...ids]
  }
  return []
}

// Mirrors `aggregateVerdict` (scripts/gate-runner.mjs), which blocks the phase on three things:
// a non-optional `fail`, ANY unrecognized or missing status, and ANY non-optional `pending`.
// `optional` is honoured for `fail` and `pending` but deliberately NOT for an unrecognized
// status — a check that cannot even report a status must never be waved through.
const RECOGNIZED = new Set(['pass', 'fail', 'skip', 'pending'])
const CLEAR = new Set(['pass', 'skip'])

// Counting only `fail` left the loop with no exit: a check whose `kind` has no runner emits
// `pending`, the gate FAILs, and decideFix returned `none`. The skill forbids integrating on
// `none` and asks the operator to re-derive the verdict — but re-derivation is deterministic,
// so gate -> none -> gate repeats forever with no escalate.
function isBlocking(check) {
  const status = check?.status
  if (CLEAR.has(status)) return false
  if (!RECOGNIZED.has(status)) return true
  return check?.optional !== true
}

// `verdict` is the object `scripts/cli.mjs` prints: `aggregateVerdict`'s summary — whose
// `failed`/`optionalFailed`/`skipped`/`pending` are arrays of check *names* — spread over the
// per-check objects, which live under `results`. There is no `checks` key; reading one meant
// seeing zero failing checks on every real gate FAIL, so the process-violation rule never
// fired on real output.
//
// `rounds` is what `readFixRounds(status, phase)` returns: the per-phase `{ taskId: count }`
// map, already unwrapped. Indexing it by phase a second time yields `{}`, which silently
// disabled the budget and pinned every retry at round 1.
export function decideFix(verdict, phase, tasks, rounds, config) {
  // Nullish `results` is the empty verdict and still decides `none`. Present-but-not-an-array is
  // a different animal: the file parsed as JSON but is not a verdict, so nothing about the gate
  // is actually known. Returning `none` there would claim the phase is clean on unread evidence,
  // and would loop forever besides — re-derivation is deterministic. It escalates to a human.
  const raw = verdict?.results
  if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
    return { decision: 'escalate', tasks: [], reason: 'malformed-verdict', check: null }
  }
  const results = asArray(raw)

  // The process-violation scan runs BEFORE the optional filter, over anything not `pass` and
  // not `skip`. `ALWAYS_ENFORCED_KINDS` forces `optional: false` at result-construction time
  // inside the gate process, but decideFix does not consume that object — it consumes a
  // serialized verdict handed in by the caller, which per the skill is assembled by the same
  // agent whose violation is being adjudicated. A fileset failure marked `optional: true` is
  // therefore reachable, and must not be filtered away into `none` or a plain `retry`.
  const violation = results.find(
    (check) => PROCESS_KINDS.has(check?.kind) && !CLEAR.has(check?.status),
  )
  if (violation) {
    return { decision: 'escalate', tasks: [], reason: 'process-violation', check: violation.name }
  }

  // An `optional` failure is surfaced by the gate but never blocks it — aggregateVerdict
  // routes it to `optionalFailed` and still returns PASS. An advisory lint must not escalate
  // a phase the gate passed, so it must not enter the failing set here either.
  const failed = results.filter(isBlocking)
  if (failed.length === 0) return { decision: 'none', tasks: [], reason: null }

  const targets = new Map()
  for (const check of failed) {
    const ids = attribute(check, tasks)
    if (ids.length === 0) {
      return { decision: 'escalate', tasks: [], reason: 'unattributable', check: check.name }
    }
    for (const id of ids) {
      if (!targets.has(id)) targets.set(id, [])
      targets.get(id).push(check.name)
    }
  }

  const budget = config?.fixRounds ?? DEFAULT_FIX_ROUNDS
  const phaseRounds = rounds
  for (const id of targets.keys()) {
    if (roundsFor(phaseRounds, id) >= budget) {
      return { decision: 'escalate', tasks: [], reason: 'budget-exhausted', taskId: id }
    }
  }

  const retries = [...targets].map(([id, checks]) => {
    const task = tasks.find((t) => t.id === id)
    const tier = escalateTier(safeTier(task?.tier))
    return { taskId: id, tier, round: roundsFor(phaseRounds, id) + 1, checks }
  })
  return { decision: 'retry', tasks: retries, reason: null }
}
