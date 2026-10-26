// What changed in the plan since the anchor the gate reads it at.
//
// The gate hashes the plan, so it notices THAT the plan moved; `verdictCoversTree` reports "the
// plan changed since the verdict was recorded" and stops there. This says what changed, per task,
// and — the part that matters — whether it changed too late to affect the work.
//
// Both incidents this exists for came from the same blind spot. A later phase's brief still
// described interfaces that earlier fix rounds had already replaced, so the teammate implemented
// against a description of code that no longer existed. And a task's acceptance criteria went on
// demanding behaviour a security fix had deliberately removed, so satisfying the plan meant
// weakening the fix. In both cases the plan and the tree disagreed, nothing reported it, and the
// disagreement was found by a human reading both.
//
// Pure: it compares two parsed plans and a list of integrated phases. Reading either plan, and
// deciding which phases are integrated, belongs to the caller.
//
// `planDrift` returns the values as they were read; only the rendering below neutralises control
// bytes, so a caller consuming the report as data still sees the plan's own text.

import { printable } from './reviews.mjs'

const FIELDS = ['title', 'phase', 'brief']

function byId(tasks) {
  const map = new Map()
  for (const task of tasks ?? []) map.set(task.id, task)
  return map
}

function listDiff(before = [], after = []) {
  const had = new Set(before)
  const has = new Set(after)
  return {
    added: after.filter((x) => !had.has(x)),
    removed: before.filter((x) => !has.has(x)),
  }
}

export function planDrift({ anchored = [], current = [], integratedPhases = [] } = {}) {
  const anchoredById = byId(anchored)
  const currentById = byId(current)
  const integrated = new Set(integratedPhases ?? [])

  const added = current.filter((t) => !anchoredById.has(t.id)).map((t) => t.id)
  const removed = anchored.filter((t) => !currentById.has(t.id)).map((t) => t.id)

  const changed = []
  for (const before of anchored) {
    const after = currentById.get(before.id)
    if (!after) continue
    const fields = FIELDS.filter((f) => String(before[f] ?? '') !== String(after[f] ?? ''))
    const files = listDiff(before.files, after.files)
    const deps = listDiff(before.deps, after.deps)
    if (files.added.length || files.removed.length) fields.push('files')
    if (deps.added.length || deps.removed.length) fields.push('deps')
    if (fields.length === 0) continue
    changed.push({
      id: before.id,
      phase: after.phase,
      fields,
      filesAdded: files.added,
      filesRemoved: files.removed,
      depsAdded: deps.added,
      depsRemoved: deps.removed,
    })
  }

  // A removed task is drift against the phase it USED to occupy — the phase it is gone from is
  // what decides whether its removal came too late, and the current plan no longer says.
  const removedEntries = removed.map((id) => ({
    id,
    phase: anchoredById.get(id)?.phase,
    fields: ['removed'],
    filesAdded: [],
    filesRemoved: anchoredById.get(id)?.files ?? [],
    depsAdded: [],
    depsRemoved: [],
  }))

  const all = [...changed, ...removedEntries]
  // An amendment to a task nobody has implemented yet is how a plan is meant to evolve mid-run.
  // An amendment to a task whose phase is already integrated describes work that is already done
  // — the brief a teammate worked from no longer exists, and no later check will ever compare
  // the two again.
  const tooLate = all.filter((c) => integrated.has(c.phase))
  const effective = all.filter((c) => !integrated.has(c.phase))

  return { added, removed, changed, tooLate, effective }
}

// Everything spliced into a line here came out of the plan file, which is text someone committed
// on the base branch — a higher bar than a commit message, but the terminal treats the bytes the
// same. Neutralised below: the task id, the phase, and the four file and dep lists, each entry
// wrapped on its own so a control byte cannot survive the `join`. NOT wrapped: `entry.fields`,
// whose members are the literals this module itself pushes (`FIELDS`, plus `files`, `deps` and
// `removed`) and never plan text. `printable`, not `printableBlock`: each of these renders as one
// line, and a newline surviving would let a value close the line and open one that reads like a
// line this command printed. This covers the sites below and claims nothing about any other file.
function describe(entry) {
  const list = (values) => values.map((v) => printable(v)).join(', ')
  const parts = [`  ${printable(entry.id)} (phase ${printable(entry.phase ?? '?')}): ${entry.fields.join(', ')}`]
  if (entry.filesAdded.length) parts.push(`      files added: ${list(entry.filesAdded)}`)
  if (entry.filesRemoved.length) parts.push(`      files removed: ${list(entry.filesRemoved)}`)
  if (entry.depsAdded.length) parts.push(`      deps added: ${list(entry.depsAdded)}`)
  if (entry.depsRemoved.length) parts.push(`      deps removed: ${list(entry.depsRemoved)}`)
  return parts.join('\n')
}

export function renderDrift(report) {
  const lines = []
  // Task ids straight out of the working-tree plan, wrapped per entry for the same reason the
  // lists in `describe` are.
  if (report.added.length) lines.push(`added since the anchor: ${report.added.map((id) => printable(id)).join(', ')}`)

  if (report.tooLate.length) {
    lines.push('changed TOO LATE — these phases are already integrated, so the brief the work was done from no longer exists:')
    for (const entry of report.tooLate) lines.push(describe(entry))
  }
  if (report.effective.length) {
    lines.push('changed and still effective — these tasks are not integrated yet, so the amendment reaches the work:')
    for (const entry of report.effective) lines.push(describe(entry))
  }

  if (lines.length === 0) return 'no drift: the working-tree plan matches the plan at the anchor'
  // Said last, where it is read: a dispatch already sent carries the old text regardless of what
  // the file says now.
  lines.push('a dispatch already sent carries the old brief; correct it in the dispatch, not only in the plan')
  return lines.join('\n')
}
