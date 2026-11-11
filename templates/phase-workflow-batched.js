// Static preamble for generated phase workflows whose tasks are batched (scripts/workflow-gen.mjs,
// `batchTasks`). The generator replaces the META marker with the meta literal, the TASKS marker
// with the phase's tasks in plan order, the BATCHES marker with a JSON array of
// { id, tasks: [taskId, ...], schema, model? }, the BRIEFS marker with a JSON object mapping each
// batch id to its already-composed batch brief, and the EFFORT marker with a plain JS literal.
// Briefs are composed by the generator through scripts/brief.mjs, not here: a generated workflow
// runs without module or filesystem access.
__META__

const TASKS = __TASKS__

const BATCHES = __BATCHES__

const BRIEFS = __BRIEFS__

const EFFORT = __EFFORT__

phase('Implement')

// One teammate per batch, in one worktree, doing the batch's tasks in sequence.
const answers = await parallel(BATCHES.map((b) => () =>
  agent(
    BRIEFS[b.id],
    {
      label: b.id,
      phase: 'Implement',
      schema: b.schema,
      isolation: 'worktree',
      agentType: 'fleetmates:tm-implementer',
      ...(b.model ? { model: b.model } : {}),
      ...(EFFORT ? { effort: EFFORT } : {}),
    },
  )
))

// Flattened to the per-task shape an unbatched phase returns. An entry counts only for a task of
// its own batch, and only the first entry per task; every task left without one is orphaned.
const byTask = new Map()
answers.forEach((answer, i) => {
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.results)) return
  for (const entry of answer.results) {
    if (entry === null || typeof entry !== 'object') continue
    const { taskId, ...result } = entry
    if (!BATCHES[i].tasks.includes(taskId) || byTask.has(taskId)) continue
    byTask.set(taskId, { taskId, ...result })
  }
})

return { results: TASKS.filter((t) => byTask.has(t.id)).map((t) => byTask.get(t.id)), orphaned: TASKS.filter((t) => !byTask.has(t.id)).map((t) => t.id) }
