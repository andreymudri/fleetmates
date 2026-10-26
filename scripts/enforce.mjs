// Plans are authored by hand on Windows and read by git, which always emits posix
// separators. Both sides are normalized before comparison. Comparison stays
// case-sensitive: git is case-sensitive, and a case-only mismatch is a real mistake.
import { NAMES } from './names.mjs'
export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function taskBranchName(runId, taskId) {
  return `${NAMES.branchPrefix}/${runId}/${taskId}`
}

// Convention only, deliberately. An earlier version preferred a branch recorded in
// status.json, but that file is written by the agents being enforced — letting it choose
// which branch is inspected hands the subject of the check control over the check. A
// teammate that commits somewhere other than the convention now fails the gate, which is
// the intended outcome rather than a limitation.
export function resolveTaskBranch(task, runId) {
  return task?.id ? taskBranchName(runId, task.id) : null
}

export function filesetViolations(changed, declared) {
  const allowed = new Set((declared ?? []).map(normalizePath))
  return (changed ?? []).map(normalizePath).filter((p) => !allowed.has(p))
}

// Different spellings can name the same ref to git: `refs/heads/main`, `heads/main`
// and `main` are one ref. Strip a leading refs/heads/ or heads/ repeatedly (not just
// once), so a branch whose actual name itself starts with refs/heads/ — whose full ref
// is refs/heads/refs/heads/<name> — still normalizes to the same string as its short
// spelling.
//
// The comparison then folds case. Whether that fold is *necessary* depends on the
// filesystem the check runs on: on a case-insensitive filesystem (Windows, macOS) git
// itself treats `Main` and `main` as one branch, so folding is required there to catch
// a real alias. On a case-sensitive filesystem (Linux, most CI) `main` and `Main` are
// genuinely different branches to git, so the fold can over-trigger — reporting `Main`
// as a violation of the `main` run branch even though git would allow both to exist.
// That over-triggering is deliberate: this is an enforcement check, and only reachable
// by a branch deliberately named against the `fleetmates/<runId>/<taskId>` convention,
// so failing closed toward "flag it" is the right default in both directions.
//
// This is still a string comparison, not a git query: this module stays pure and has
// no git access, so it cannot resolve either side to a sha. A branch that is the same
// commit as the run branch under a name this normalization does not recognize will not
// be caught here — a sha-based comparison would be strictly correct but needs the git
// wrapper, which lives in the caller, not this predicate.
function normalizeBranchRef(name) {
  let ref = String(name)
  let stripped = true
  while (stripped) {
    stripped = false
    if (ref.startsWith('refs/heads/')) { ref = ref.slice('refs/heads/'.length); stripped = true }
    else if (ref.startsWith('heads/')) { ref = ref.slice('heads/'.length); stripped = true }
  }
  return ref.toLowerCase()
}

// "Lowest un-integrated phase" is wrong when a later phase is integrated and an earlier one
// is not: the check would run against the earlier phase, and once that integrates it would
// return null (nothing to check) — so the later phase's declared file set is never enforced
// at all. That state is not a legitimate run; it is reported, not resolved.
export function derivePhase({ tasks = [], integratedPhases = [] } = {}) {
  const list = tasks ?? []
  const phases = [...new Set(list.map((t) => t?.phase))]
  if (phases.some((p) => !Number.isInteger(p))) {
    return { error: 'the plan contains a task with a non-integer phase' }
  }
  phases.sort((a, b) => a - b)
  const integrated = new Set(integratedPhases ?? [])
  const known = phases.filter((p) => integrated.has(p))
  const firstOpen = phases.find((p) => !integrated.has(p))
  if (firstOpen !== undefined && known.some((p) => p > firstOpen)) {
    return { error: `phase ${firstOpen} is not integrated but a later phase is — refusing to guess which phase to enforce` }
  }
  return { phase: firstOpen ?? null }
}

// Ownership no longer asks "did HEAD move since a stored baseline" — that baseline lived in
// status.json and any teammate could reset it, which turned a direct write to the run
// branch into an accepted one. It now asks the question git can answer: is every commit on
// the run branch since the anchor accounted for by this run's task branches?
// `sideDoorBranches` are this run's task branches that are ancestors of the BASE branch without
// being ancestors of the run branch. That is a route into the base this design has no legitimate
// use for: a task branch reaches the base by riding the run branch, which lands as a whole after
// a recorded PASS. Anything else — a reviewer octopus-merging task branches into master, a
// teammate merging its own work "to be helpful" — puts integrated content in front of users with
// no gate verdict behind it, and every check here otherwise looks only at the run branch, so it
// used to be accepted with a note.
//
// It needs no base sha recorded at run start, which is what makes it trustworthy: the question
// is asked of git about two refs that exist right now, so there is no stored state for the
// enforced party to rewrite. It cannot say WHEN the branch reached the base, only that it is
// there by a route the run branch does not explain.
export function ownershipViolations({ runBranch, baseBranch, taskBranches = [], sideDoorBranches = [], unexplainedCommits = [], dirty = false } = {}) {
  const violations = []
  if (!runBranch) {
    violations.push('no run branch was supplied — the gate cannot establish what it is protecting')
    return violations
  }
  for (const branch of taskBranches) {
    if (normalizeBranchRef(branch) === normalizeBranchRef(runBranch)) {
      violations.push(`task branch ${branch} is the run branch; only tm-integrator writes there`)
    }
  }
  for (const branch of sideDoorBranches) {
    violations.push(`task branch ${branch} is an ancestor of base branch ${baseBranch ?? '(unknown)'} but not of run branch ${runBranch} — this run's work reached the base by some route other than the run branch, so it is integrated with no gate verdict behind it`)
  }
  for (const sha of unexplainedCommits) {
    violations.push(`commit ${sha} on ${runBranch} is reachable from no task branch of this run and from no ancestor of the base branch — either it is a direct write, or the integrator merged without --no-ff and destroyed the ancestry this check reads`)
  }
  if (dirty) {
    violations.push('main worktree has uncommitted changes; teammates work only in their own worktrees')
  }
  return violations
}

// The counterpart to the base-ancestry explanation in the ownership check: whatever that
// clause admits, this states out loud. Accepting a base-explained commit silently would be a
// net loss of signal — an accidental commit landing on the base mid-run used to surface as an
// ownership failure (wrong, but visible), and would otherwise now ride in with a green gate
// and no record anywhere.
//
// It deliberately does NOT compare against a base sha recorded at run start. That state would
// have to live in `.fleetmates/`, which the ownership check must never read: those files are
// written by the very agents this check enforces, so consulting them would let the enforced
// party supply the evidence and destroy the property that makes ownership tamper-evident.
// The check reports what it accepted; it does not claim the base did not move.
export function baseExplainedNote({ baseBranch, commits = [] } = {}) {
  if (!commits || commits.length === 0) return ''
  const label = commits.length === 1 ? 'commit' : 'commits'
  return `accepted ${commits.length} ${label} by ancestry of base branch ${baseBranch} rather than any task branch of this run: ${commits.join(', ')}`
}

// A recorded PASS is no longer consulted to decide completion — the gate is recomputed
// instead. This predicate exists for the narrower job of deciding whether an already-known
// verdict still describes the current tree: a teammate that amends its branch after a
// passing gate leaves the verdict describing a tree that no longer exists.
export function verdictCoversTree(verdict, current) {
  if (!verdict || verdict.verdict !== 'PASS') return 'no passing verdict'
  if (!verdict.anchorSha || verdict.anchorSha !== current?.anchorSha) return 'anchor moved since the verdict was recorded'
  if (verdict.planHash !== current?.planHash) return 'the plan changed since the verdict was recorded'
  const recorded = verdict.branchShas ?? {}
  const now = current?.branchShas ?? {}
  const names = new Set([...Object.keys(recorded), ...Object.keys(now)])
  for (const name of names) {
    if (recorded[name] !== now[name]) return `branch ${name} moved since the verdict was recorded`
  }
  return null
}

// FNV-1a over the plan markdown. Not a security hash and not required to be: it detects a
// plan that changed between a verdict and its use, in a module that must stay import-free.
// Tamper-evidence here rests on git, not on this digest.
export function planHash(markdown) {
  let hash = 0x811c9dc5
  const text = String(markdown ?? '')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
