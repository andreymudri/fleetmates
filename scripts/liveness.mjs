// Which teammates are actually working, computed from two signals neither of which is a
// self-report: when each task branch was last committed to, and when anything under its worktree
// was last touched. A teammate mid-edit has a fresh worktree and a stale tip; a teammate parked
// waiting for a notification that never arrives has neither.
//
// This is a supervision aid and nothing reads it. Both signals are forgeable by the teammate they
// describe — GIT_COMMITTER_DATE moves a commit's timestamp, and any background process touching a
// file refreshes an mtime — so it must never be cited as evidence for a gate. It catches the
// failure that actually happens, not an adversary.
//
// Pure so it is testable without a repository: the caller gathers `tips` and `touches` and the
// clock, and this decides.

// The only import this module has, and it stays that way: `reviews.mjs` has no imports of its
// own, so pulling in `printable` costs nothing and cannot cycle. Purity here means "no repository
// access", not "no code reuse" — a second copy of the escaping is how two renderers drift.
import { printable } from './reviews.mjs'

export const DEFAULT_STALE_MINUTES = 20

// A task with no branch and no worktree has not started. Reporting that as a stall would make
// every queued task of a wide phase look like a hung teammate on the first heartbeat.
export function livenessRows({ tasks = [], tips = {}, touches = {}, now, staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  if (!Number.isFinite(now)) throw new Error(`livenessRows requires a numeric clock, got ${JSON.stringify(now)}`)
  const thresholdMs = staleMinutes * 60 * 1000
  return (tasks ?? []).map((task) => {
    const tip = tips[task.id] ?? null
    const touch = touches[task.id] ?? null
    const tipAgeMs = tip?.at == null ? null : now - tip.at
    const touchAgeMs = touch?.at == null ? null : now - touch.at
    if (tip == null && touch == null) {
      return { taskId: task.id, branch: tip?.branch ?? null, tipAgeMs: null, touchAgeMs: null, floored: false, state: 'not started', unknownReason: null }
    }
    // A floored measurement is a LOWER bound on freshness: the walk stopped early, so the newest
    // file may be one it never reached. The task can only be more recently touched than reported,
    // never less — so a floored row cannot be called stalled.
    //
    // It cannot be called working either, and calling it working was a real defect rather than a
    // theoretical one: on any project whose worktree holds more entries than the walk's cap —
    // a `dist/`, `.next/`, `target/` or `.venv` is enough — every walk floors, every row read
    // working, and the command's only failure signal could never fire on exactly the repositories
    // it exists to supervise. So there are three answers, and the third says so: `unknown` means
    // freshness was NOT measured, which the caller reports rather than dressing up as an
    // all-clear.
    //
    // A fresh TIP still settles the row as working, because that signal was measured and a commit
    // inside the window is proof of work on its own. Only when nothing measured is fresh does the
    // touch signal decide between `unknown` and `stalled`.
    //
    // A capped walk is one of two ways the touch signal goes unmeasured, and the other is the more
    // common: NO touch record at all, because no worktree is registered for the branch. That is
    // absence of evidence, not evidence of absence — a teammate dispatched without worktree
    // isolation, or working in the main worktree, is not observed by this signal at all. Reported
    // as a measured stall it fired the hang alarm on the first heartbeat of such a phase, with
    // every teammate working and simply not having committed yet. A record whose `at` is null is
    // the same answer for the same reason: the walk read nothing, so nothing was measured.
    //
    // A missing TIP is deliberately NOT treated this way. `branchExists` returning false is a
    // measured negative — git is authoritative that nothing has been committed on that ref — so a
    // task with a stale worktree and no branch is a genuine measured stall.
    const floored = touch?.floored === true
    const touchMeasured = touch != null && touch.at != null && !floored
    const ages = [tipAgeMs, touchAgeMs].filter((a) => a != null)
    const fresh = ages.some((age) => age <= thresholdMs)
    const unknownReason = fresh || touchMeasured
      ? null
      : (floored ? 'walk-capped' : 'no-worktree-measurement')
    const state = fresh ? 'working' : (unknownReason ? 'unknown' : 'stalled')
    return { taskId: task.id, branch: tip?.branch ?? touch?.branch ?? null, tipAgeMs, touchAgeMs, floored, state, unknownReason }
  })
}

// A guess at the cause of a stalled row, not a diagnosis: `stalled` means no fresh commit and no
// fresh worktree write, and that absence has more than one possible cause. The one named here is
// the only one this repository has a written record of — a teammate backgrounded its test command
// and is now waiting on a notification that a backgrounded command never sends. That is a record,
// not a frequency: no relative count of the causes exists, and `skills/fleet-supervision/SKILL.md`
// names the other one. The fix is to resume that same agent with an instruction to run in the
// foreground, not to respawn it: a respawn discards the task's whole context, and the returned
// teammate's worktree keeps its branch checked out.
//
// Exported so the skill-text pin can import the string instead of regexing this file for it: a
// pin that reads source as text matches a line-start occurrence inside a comment or a template
// literal just as happily as the declaration, and goes green while `renderLiveness` emits a hint
// the skill no longer contains.
export const STALL_HINT = '  -> likely cause: backgrounded command waiting on a notification that never arrives; resume this agent (do not respawn) and tell it to run in the foreground'

export function renderLiveness(rows = [], { staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  const age = (ms) => (ms == null ? '-' : `${Math.floor(ms / 60000)}m`)
  const lines = [`liveness (stale after ${staleMinutes}m)`, 'task  tip     touched  state']
  for (const row of rows) {
    const note = row.floored ? ' (floor)' : ''
    // `taskId` comes from the plan, which a planning agent wrote, and a terminal ACTS on control
    // bytes: an id carrying `ESC [ 2 K` `ESC [ 1 A` erases the row reporting it and the line
    // above, while the command still exits 1. That matters most in this renderer of all of them —
    // `liveness` exists to say a teammate has gone quiet, so an id that deletes its own `stalled`
    // row defeats the check exactly where it is used.
    lines.push(`${printable(row.taskId)}  ${age(row.tipAgeMs)}  ${age(row.touchAgeMs)}${note}  ${printable(row.state)}`)
    if (row.state === 'stalled') lines.push(STALL_HINT)
  }
  return lines.join('\n')
}

export function hasStall(rows = []) {
  return rows.some((row) => row.state === 'stalled')
}

// Rows whose freshness was never measured. Separate from `hasStall` because the two say different
// things and the caller answers them with different exit codes: a stall is a measurement, and this
// is the absence of one.
export function hasUnknown(rows = []) {
  return rows.some((row) => row.state === 'unknown')
}
