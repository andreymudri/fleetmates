// Reconstructing a run's `plan.json` and `status.json` from git and the plan.
//
// `.fleetmates/` is gitignored, so a clean checkout, a pruned worktree, or a corrupted write loses
// the run's bookkeeping — and until now that was unrecoverable by anything but hand-editing JSON.
// Nothing in the design actually needs those files to be durable: the gate derives the anchor,
// the phase and every verdict from git, `status.gates` has no reader, and `complete` recomputes
// rather than trusting a record. This finishes that property by making the files reproducible.
//
// One thing is deliberately NOT reconstructed. A gate verdict is evidence that checks ran, and
// git carries branches, not evidence. Rebuilding a `gates` entry would manufacture the very
// record the whole design refuses to trust, with the plugin itself as the author. A rebuilt run
// has no gate history, and the honest consequence is that its phases must be gated again.

// `merged` settles the question on its own: once a branch is an ancestor of the run branch its
// own fork-point diff is empty, which says nothing about whether work was done. Before that,
// contributing nothing is the stale-base shape — a ref that exists while the work sits elsewhere
// — and that is `orphaned`, never `done`.
export function taskStateFrom({ exists = false, contributes = false, merged = false } = {}) {
  if (!exists) return 'pending'
  if (merged || contributes) return 'done'
  return 'orphaned'
}

export function rebuildRunState({ runId, tasks = [], info = {}, maxParallel, currentPhase }) {
  const totalPhases = tasks.reduce((max, t) => Math.max(max, t.phase ?? 0), 0)

  const plan = { runId, totalPhases, tasks }
  const status = {
    runId,
    // `currentPhase` is null when every phase is integrated. The digest renders this in its
    // header, so it records the last phase rather than letting a null through as "phase null".
    phase: currentPhase ?? totalPhases,
    totalPhases,
    maxParallel,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      state: taskStateFrom(info[t.id] ?? {}),
    })),
  }
  // No `gates`, no `fixRounds` — see the header. Their absence is the accurate record.
  return { plan, status }
}
