// Static preamble for generated phase workflows. The generator replaces the TASKS
// marker below with a JSON array of { id, title, files, branch, model? }, the META
// marker with the meta literal, the BRIEFS marker with a JSON object mapping each
// task id to its already-composed brief text, and the EFFORT marker with a plain JS
// literal, and the RESULT_SCHEMA marker with the shared result-schema literal. Briefs are
// composed by the generator through scripts/brief.mjs, not here: a generated workflow runs
// without module or filesystem access, so the only way both dispatch paths (this template and
// `cli.mjs brief`) can share one implementation is for the text to arrive already composed.
__META__

const TASKS = __TASKS__

const BRIEFS = __BRIEFS__

const EFFORT = __EFFORT__

const RESULT_SCHEMA = __RESULT_SCHEMA__

// Briefs are composed by the generator, not here: a generated workflow runs without module
// or filesystem access, so the only way both dispatch paths can share one implementation is
// for the text to arrive already composed.
const compose = (t) => BRIEFS[t.id]

phase('Implement')

const results = await parallel(TASKS.map((t) => () =>
  agent(
    compose(t),
    {
      label: t.id,
      phase: 'Implement',
      schema: RESULT_SCHEMA,
      isolation: 'worktree',
      agentType: 'fleetmates:tm-implementer',
      ...(t.model ? { model: t.model } : {}),
      ...(EFFORT ? { effort: EFFORT } : {}),
    },
  ).then((r) => (r === null ? null : { taskId: t.id, ...r }))
))

return { results: results.filter(Boolean), orphaned: TASKS.filter((t, i) => !results[i]).map((t) => t.id) }
