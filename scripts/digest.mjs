import { printable } from './reviews.mjs'

// Everything this module renders comes out of `status.json`, and the task titles in it come
// straight out of the plan a planning agent wrote — `plan-parser.mjs` takes a `### Task 1:`
// heading's text verbatim. `blockedBy` is written by whoever reported the block. A terminal
// ACTS on control bytes, so a crafted title can erase the line the digest just drew and write a
// passing gate over it. Every agent-written value below is therefore spliced through
// `printable`, the same helper the CLI uses; see its definition in `reviews.mjs` for what it
// does and what it deliberately leaves alone.

const SECTIONS = [
  { state: 'running', label: 'running' },
  { state: 'done', label: 'done' },
  { state: 'blocked', label: 'blocked' },
  { state: 'orphaned', label: 'orphaned' },
  { state: 'pending', label: 'pending' },
]

const KNOWN = new Set(SECTIONS.map((s) => s.state))

function describe(task, now) {
  const title = printable(task.title)
  if (task.state === 'running') {
    // A running task with no startedAt is a bookkeeping bug, not a zero-minute task.
    // Say so rather than rendering NaNm.
    if (typeof task.startedAt !== 'number') return `${title}(?)`
    const mins = Math.floor((now - task.startedAt) / 60_000)
    return `${title}(${mins}m)`
  }
  if (task.state === 'done') return `${title} ✓`
  if (task.state === 'blocked') return `${title} — needs ${printable(task.blockedBy)}`
  return title
}

function describeTerse(task, now) {
  const title = printable(task.title)
  if (task.state === 'running') {
    if (typeof task.startedAt !== 'number') return `${title}?`
    return `${title}${Math.floor((now - task.startedAt) / 60_000)}m`
  }
  if (task.state === 'blocked') return `${title}<${printable(task.blockedBy)}`
  return title
}

export function renderDigest(status, now, caveman = false) {
  const { runId, phase, totalPhases, maxParallel, tasks } = status
  const say = caveman ? describeTerse : describe
  // The header's three values are read out of the same file the titles are, so they take the
  // same route. For the numbers `printable` is `String()` and nothing else; it matters when a
  // hand-edited status.json carries a string where a number was expected.
  const lines = [caveman
    ? `${printable(runId)} p${printable(phase)}/${printable(totalPhases)} n${tasks.length}`
    : `run ${printable(runId)} · phase ${printable(phase)}/${printable(totalPhases)} · ${tasks.length} tasks`]

  const groups = SECTIONS.map(({ state, label }) => ({
    label,
    group: tasks.filter((t) => t.state === state),
  }))
  // Never drop a task: an unrecognized state is surfaced under `unknown` rather than
  // silently omitted. A task missing from the digest is a task nobody chases.
  groups.push({ label: 'unknown', group: tasks.filter((t) => !KNOWN.has(t.state)) })

  for (const { label, group } of groups) {
    if (group.length === 0) continue
    const body = group.map((t) => say(t, now)).join(' ')
    lines.push(caveman
      ? `${label} ${group.length} ${body}`
      : `${label.padEnd(9)} ${String(group.length).padStart(1)}  ${body}`)
  }

  const idle = Math.max(0, maxParallel - tasks.filter((t) => t.state === 'running').length)
  lines.push(caveman ? `idle ${idle}` : `idle slots ${idle}`)
  return lines.join('\n')
}
