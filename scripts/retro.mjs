// A retrospective of one run: what cost fix rounds, which gates were last recorded failing, which
// teammates were orphaned or failed, and how long they waited on provider limits. It turns that
// into PROPOSED learnings, in the heading format `selectLearnings` reads
// (scripts/learning-context.mjs), and into findings in the shape `feedback-draft` takes.
//
// It writes nothing. `fleetmates.learnings.md` is human-owned: a person reads the proposals, writes
// the lesson in their own words, and keeps only what is worth carrying into the next run.
//
// WHAT IT READS IS AGENT-WRITTEN. `status.json` and the session records under `.fleetmates/` are
// written by the agents of the run, so nothing here is evidence that the run was good or bad. It is
// a list of places to look. That is also why no gate check reads this module.

import { printable } from './reviews.mjs'

const RUN_ID = /^[A-Za-z0-9._/-]+$/
const MAX_SCOPE = 50

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const own = (obj, key) => obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key)
const safeText = (value) => printable(String(value)).replace(/[\r\n]+/g, ' ').slice(0, 200)

// A file is usable as a learning scope glob only when it survives the heading the scope is written
// into: one line, no comma (the scope's separator), and inside the length bound selectLearnings
// enforces. Anything else is left out, never rewritten into a different path.
function scopeOf(files) {
  const list = (Array.isArray(files) ? files : [])
    .filter((f) => typeof f === 'string' && f !== '' && f.length <= 512 && !/[,\p{C}\p{Zl}\p{Zp}]/u.test(f))
  return [...new Set(list)].slice(0, MAX_SCOPE)
}

// `plan` is the run's plan record ({ tasks: [{ id, title, files, phase }] }), `status` its
// status.json, `sessions` the per-task session records a headless driver wrote (may be empty: a
// Claude Code run has none). Returns `{ findings, markdown }`; both empty when nothing went wrong.
export function draftRetro({ runId, date, plan, status, sessions = [] }) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('retro needs a run id of letters, digits, ".", "_", "/" or "-"')
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('retro needs an ISO date (YYYY-MM-DD)')
  const tasks = new Map((Array.isArray(plan?.tasks) ? plan.tasks : [])
    .filter((t) => t && typeof t.id === 'string')
    .map((t) => [t.id, t]))
  const findings = []

  // Fix rounds per task, summed over the phases they were spent in.
  const rounds = own(status, 'fixRounds') && typeof status.fixRounds === 'object' ? status.fixRounds : {}
  const spent = new Map()
  for (const [phase, perTask] of Object.entries(rounds)) {
    if (!perTask || typeof perTask !== 'object') continue
    for (const [taskId, n] of Object.entries(perTask)) {
      if (!Number.isInteger(n) || n <= 0) continue
      const entry = spent.get(taskId) ?? { total: 0, phases: [] }
      entry.total += n
      entry.phases.push(`${phase}=${n}`)
      spent.set(taskId, entry)
    }
  }
  for (const [taskId, { total, phases }] of [...spent].sort((a, b) => b[1].total - a[1].total)) {
    const task = tasks.get(taskId)
    findings.push({
      id: `retro-fix-${taskId}`,
      type: 'pitfall',
      title: safeText(`${taskId} needed ${count(total, 'fix round')}${task?.title ? `: ${task.title}` : ''}`),
      description: 'A gate failed on this task\'s work. Replace this with what the next teammate on these files should do differently.',
      scope: scopeOf(task?.files),
      evidence: [safeText(`status.json fixRounds (phase=rounds): ${phases.join(', ')}`)],
    })
  }

  // The last recorded verdict of each phase. Only the last one is kept by the gate, so an earlier
  // failure that was fixed shows up above as fix rounds, not here.
  const gates = own(status, 'gates') && typeof status.gates === 'object' ? status.gates : {}
  for (const [phase, gate] of Object.entries(gates)) {
    if (!gate || gate.verdict === 'PASS') continue
    const failed = Array.isArray(gate.failed) ? gate.failed.filter((c) => typeof c === 'string').map(safeText) : []
    const phaseTasks = [...tasks.values()].filter((t) => String(t.phase) === String(phase))
    findings.push({
      id: `retro-gate-${phase}`,
      type: 'pitfall',
      title: safeText(`phase ${phase} was last recorded ${gate.verdict ?? 'without a verdict'}${failed.length ? ` (${failed.join(', ')})` : ''}`),
      description: 'The run stopped with this gate failing. Replace this with the cause, once you know it.',
      scope: scopeOf(phaseTasks.flatMap((t) => t.files ?? [])),
      evidence: [safeText(`status.json gates.${phase}: verdict=${gate.verdict ?? '?'} failed=[${failed.join(', ')}]`)],
    })
  }

  // Headless teammates that ended without a usable result, and the limit waits they sat through.
  for (const record of sessions) {
    if (!record || typeof record.taskId !== 'string') continue
    const task = tasks.get(record.taskId)
    if (record.state === 'orphaned' || record.state === 'failed') {
      findings.push({
        id: `retro-${record.state}-${record.taskId}`,
        type: 'pitfall',
        title: safeText(`${record.taskId} ended ${record.state}: ${record.exitReason ?? 'no reason recorded'}`),
        description: 'The teammate produced no usable result. Replace this with what would have let it finish (smaller task, more time, another model).',
        scope: scopeOf(task?.files),
        evidence: [safeText(`sessions/${record.taskId}.json state=${record.state} exitReason=${record.exitReason ?? ''}`)],
      })
    }
    const waits = Array.isArray(record.limitWaits) ? record.limitWaits : []
    if (waits.length > 0) {
      const minutes = Math.round(waits.reduce((sum, w) => sum + (Number.isFinite(w?.delayMs) ? w.delayMs : 0), 0) / 60_000)
      findings.push({
        id: `retro-limit-${record.taskId}`,
        type: 'pitfall',
        title: safeText(`${record.taskId} waited ${count(waits.length, 'time')} on a provider limit (about ${count(minutes, 'minute')})`),
        description: 'The provider limited this run. Replace this with what to change (fewer teammates at once, another plan or provider), or drop it.',
        scope: ['**'],
        evidence: [safeText(`sessions/${record.taskId}.json limitWaits: ${waits.map((w) => w?.type).join(', ')}`)],
      })
    }
  }

  // A finding with no usable scope still says something about the run, so it applies everywhere
  // rather than being dropped.
  for (const f of findings) if (f.scope.length === 0) f.scope = ['**']

  const markdown = findings.map((f) => [
    `## ${date} run: ${runId} scope: ${f.scope.join(', ')}`,
    '',
    `- ${f.title}`,
    `- Evidence: ${f.evidence.join('; ')}`,
    `- Lesson: ${f.description}`,
    '',
  ].join('\n')).join('\n')
  return { findings, markdown }
}
