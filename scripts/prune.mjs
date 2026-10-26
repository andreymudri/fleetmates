// Which of a run's worktrees may be removed, and which may not.
//
// The rule this encodes was written down twice and got followed wrongly both times, because it
// lives in two skills that each state half of it. `parallel-execution` wants a returned
// teammate's worktree gone so a later dispatch can take its branch; `phase-gate` resolves a
// `retry` by RESUMING that same teammate, which fails outright once its worktree is gone —
// taking the task's whole context with it. The reconciliation is: not until the phase has a
// passing gate.
//
// So the phase gate's verdict, not the teammate's return, is what makes a worktree prunable.
// Every refusal is reported with its reason rather than silently skipped: a command that removes
// three of five worktrees and says nothing about the other two reads as a complete job.
//
// Pure. The caller lists the worktrees, names the main one, and supplies the plan's task→phase
// map and the phases that hold a passing gate.

import { NAMES } from './names.mjs'
const TASK_BRANCH = new RegExp(`^${NAMES.branchPrefix}/([^/]+)/([^/]+)$`)

// A merge preview is a detached worktree under the system temp directory, named tm-preview-*.
// Its own cleanup runs in a `finally`, which a SIGKILL skips — so these accumulate, and every
// one of them shows up in `doctor` as a worktree the operator never created. They belong to no
// run and hold no branch, so reaping one strands no ref and loses no task context.
//
// TWO THINGS THIS CANNOT TELL, both of which the wording of any report must respect:
//
// 1. The name alone is not evidence. An operator may keep a deliberate detached worktree called
//    tm-preview-notes anywhere on disk. Only location makes it ours, so the temp root is a
//    required input: no temp root means identify NOTHING, never identify everything. The module
//    stays pure — it does not import `node:os` — so the caller supplies the root it observed.
// 2. Liveness is invisible in a worktree list. A gate running in another process RIGHT NOW holds
//    a detached, branchless tm-preview-* worktree indistinguishable from a leaked one. Removing
//    it under the running check fails that gate with missing files rather than a real verdict.
//    No heuristic here can fix that — a mtime or a lock file would be a guess dressed as a fact.
//    So what is identified is: belongs to no run, holds no branch, and is safe to remove ONLY
//    when no gate is running. That last clause is the caller's to satisfy, and the rendered
//    output says so rather than claiming a plain "safe to remove" it cannot verify.
//
//    Liveness therefore arrives as DATA, in `livePreviews`. scripts/merge-preview.mjs writes a
//    `.tm-preview-owner` marker into every preview it creates and removes it in its own
//    `finally`; the caller reads those markers — this module is pure and cannot — and hands in
//    the paths it found a living owner for. Those are excluded from `previews` and reported in
//    `skipped`, never dropped. Supplying nothing keeps the old behaviour exactly: every
//    identified preview is leaked. The set can only ever NARROW what is reaped.
const PREVIEW_DIR = /[\\/]tm-preview-[^\\/]+$/

function norm(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

// Strictly inside, by whole segments: `/tmpx/...` is not under `/tmp`. An empty or missing root
// is inside nothing, which is what turns a missing temp root into "identify nothing".
function under(path, root) {
  const r = norm(root)
  if (!r) return false
  return norm(path).startsWith(`${r}/`)
}

function isPreviewWorktree(w, tempRoot) {
  return Boolean(w) && Boolean(w.detached) && !w.branch && PREVIEW_DIR.test(norm(w.path)) && under(w.path, tempRoot)
}

// The caller's paths, normalised the same way every other path here is: separators and trailing
// slashes only. Case is deliberately NOT folded — this module has no filesystem to ask whether
// case matters, and the caller hands back the very paths it was given, so folding would buy
// nothing and claim knowledge the module does not have.
function liveSet(livePreviews) {
  const out = new Set()
  for (const p of livePreviews ?? []) out.add(norm(p))
  return out
}

function isLeakedPreview(w, tempRoot, live) {
  return isPreviewWorktree(w, tempRoot) && !live.has(norm(w.path))
}

export function leakedPreviews(worktrees = [], { tempRoot = null, livePreviews = null } = {}) {
  const live = liveSet(livePreviews)
  return worktrees
    .filter((w) => isLeakedPreview(w, tempRoot, live))
    .map((w) => ({ path: w.path, head: w.head ?? null }))
}

export function selectPrunableWorktrees({
  runId,
  worktrees = [],
  mainWorktree = null,
  taskPhases = null,
  passedPhases = [],
  tempRoot = null,
  livePreviews = null,
} = {}) {
  const prunable = []
  const skipped = []
  const passed = new Set(passedPhases ?? [])
  const live = liveSet(livePreviews)

  for (const wt of worktrees) {
    const isMain = mainWorktree != null && norm(wt.path) === norm(mainWorktree)
    if (isMain) {
      // Stated even when it holds no task branch: the one worktree the whole design keeps
      // teammates out of is the one an over-eager prune would take from the operator.
      skipped.push({ path: wt.path, reason: 'this is the main worktree; it is never pruned' })
      continue
    }
    // Reported in `previews` instead, so it is not also reported as a refusal. Anything NOT
    // identified as a preview keeps falling through to the refusals below — a worktree this
    // command mentions in neither list is one the operator was never told about.
    if (isPreviewWorktree(wt, tempRoot)) {
      // A preview the caller found a living owner for is in neither list by accident: it is a
      // refusal, with the reason spelled out, because it is the one the operator is likeliest
      // to come back and ask about.
      if (live.has(norm(wt.path))) {
        skipped.push({ path: wt.path, reason: 'a gate owns this preview right now' })
      }
      continue
    }
    if (!wt.branch) {
      skipped.push({ path: wt.path, reason: 'no branch checked out (detached); this run does not own it' })
      continue
    }
    const match = TASK_BRANCH.exec(wt.branch)
    if (!match) {
      skipped.push({ path: wt.path, reason: `holds ${wt.branch}, which is not a task branch of any run` })
      continue
    }
    const [, branchRun, taskId] = match
    if (branchRun !== runId) {
      skipped.push({ path: wt.path, reason: 'belongs to another run' })
      continue
    }

    // No phase map supplied: the caller is not in a position to say whether a fix round could
    // still need this worktree, so nothing is removed. Assuming "safe" here is precisely the
    // default that made a retry unresumable.
    if (taskPhases) {
      const phase = taskPhases[taskId]
      if (phase === undefined) {
        skipped.push({ path: wt.path, reason: `holds ${wt.branch}, whose task is not in the plan` })
        continue
      }
      if (!passed.has(phase)) {
        skipped.push({ path: wt.path, reason: `phase ${phase} has no passing gate yet; a retry resumes this teammate and cannot without its worktree` })
        continue
      }
    }
    prunable.push({ path: wt.path, branch: wt.branch, taskId })
  }

  return { runId, prunable, skipped, previews: leakedPreviews(worktrees, { tempRoot, livePreviews }) }
}

export function renderPrunePlan(plan) {
  const lines = []
  const previews = plan.previews ?? []
  if (plan.prunable.length === 0) {
    // "nothing to prune" above a list of worktrees `--yes` is about to remove is a summary that
    // states as fact something false. When previews are present, say what is actually there.
    lines.push(previews.length ? 'no run worktrees to prune; leaked merge previews were found:' : 'nothing to prune')
  } else {
    lines.push(`prunable (${plan.prunable.length}):`)
    for (const w of plan.prunable) lines.push(`  ${w.taskId}  ${w.branch}  ${w.path}`)
  }
  if (previews.length) {
    // Deliberately not "safe to remove". A worktree list cannot distinguish a leaked preview from
    // the one a gate is using in another process right now, and removing that one fails the gate
    // with missing files instead of a verdict. The condition is stated so the caller can check it.
    lines.push(`leaked merge previews (${previews.length}) — each belongs to no run and holds no branch, and a killed gate skips its own cleanup, which is how they accumulate. Liveness cannot be told from a worktree list, so these are safe to remove only when no gate is running:`)
    for (const p of plan.previews) lines.push(`  ${p.path}`)
  }
  if (plan.skipped.length) {
    lines.push('left alone:')
    for (const s of plan.skipped) lines.push(`  ${s.path} — ${s.reason}`)
  }
  return lines.join('\n')
}
