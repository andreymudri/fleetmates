import { taskBranchName } from './enforce.mjs'
import { NAMES } from './names.mjs'
import { readFile } from 'node:fs/promises'
import { composeBatchBrief, composeBrief } from './brief.mjs'
import { RESULT_SCHEMA } from './result-schema.mjs'

const TEMPLATE = new URL('../templates/phase-workflow.js', import.meta.url)
const BATCHED_TEMPLATE = new URL('../templates/phase-workflow-batched.js', import.meta.url)
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// Escapes every character that could terminate or extend the emitted literal. The double
// quote matters even though the literal is single-quoted: a value carrying a `"` can break
// out of a JSON string elsewhere in the generated source, so no unescaped quote of either
// kind may survive. \r is escaped for the same reason as \n — a raw one ends the line.
function jsString(value) {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}'`
}

const MARKER = /__(?:META|TASKS|BATCHES|BRIEFS|EFFORT|RESULT_SCHEMA)__/g

// Groups a phase's tasks into batches one implementer does in sequence (docs/specs/
// 2026-11-06-cost-cuts-design.md, section 5). Deterministic: tasks are grouped by tier in plan
// order, each tier is chunked into runs of at most `batchSize`, and the batches are ordered by the
// plan position of their first task. Tiers never share a batch, so a batch has exactly one model.
// A task with no tier groups with the other tasks that have none.
export function batchTasks(tasks, batchSize) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be an integer >= 1')
  const open = new Map()
  const batches = []
  for (const task of tasks) {
    const key = task.tier ?? ''
    let batch = open.get(key)
    if (!batch || batch.length >= batchSize) {
      batch = []
      open.set(key, batch)
      batches.push(batch)
    }
    batch.push(task)
  }
  return batches
}

// The schema of one batch's answer: one RESULT_SCHEMA object per task of the batch, each naming
// its task. The count is exact, so a teammate that finished only some tasks still has to report
// the rest (as `blocked`); only a teammate that returns nothing leaves its tasks orphaned.
function batchResultSchema(taskIds) {
  return {
    type: 'object',
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        minItems: taskIds.length,
        maxItems: taskIds.length,
        items: {
          type: 'object',
          required: ['taskId', ...RESULT_SCHEMA.required],
          properties: { taskId: { type: 'string', enum: taskIds }, ...RESULT_SCHEMA.properties },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  }
}

// Serializes a plain JS value (string/number/boolean/null/array/object) as a JS
// literal with unquoted identifier keys and single-quoted strings, matching the
// "pure literal" meta declaration expected by the generated workflow source.
function jsLiteral(value, indent = '') {
  const nextIndent = indent + '  '
  if (typeof value === 'string') return jsString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((v) => `${nextIndent}${jsLiteral(v, nextIndent)}`).join(',\n')
    return `[\n${items}\n${indent}]`
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  const entries = keys
    .map((key) => {
      const keyLiteral = IDENTIFIER.test(key) ? key : jsString(key)
      return `${nextIndent}${keyLiteral}: ${jsLiteral(value[key], nextIndent)}`
    })
    .join(',\n')
  return `{\n${entries}\n${indent}}`
}

// The branch name is computed once here rather than derived again inside the template,
// so the brief's `checkout -B` and the dispatch cannot disagree about the string.
function slimTasks(tasks, runId, tierModels, neighbours) {
  return tasks.map(({ id, title, files, tier }) => {
    const model = tierModels?.[tier]
    const base = { id, title, files, branch: taskBranchName(runId, id) }
    const near = neighbours?.[id]
    const withNear = Array.isArray(near) && near.length > 0 ? { ...base, neighbours: near } : base
    return model ? { ...withNear, model } : withNear
  })
}

export async function generatePhaseWorkflow({
  runId, phase, tasks, maxParallel, tierModels,
  planPath = '', baseBranch = '', constraints = [], caveman = false, effort = '', neighbours = {}, contextBundles = {},
  batchSize = 1,
}) {
  if (!tasks || tasks.length === 0) throw new Error(`no tasks for phase ${phase}`)
  // A batch of one is a task, so a phase whose batches each hold one task gets the unbatched
  // script, byte for byte (pinned against a golden file in tests/workflow-gen.test.mjs).
  const batches = batchTasks(tasks, batchSize)
  if (batches.some((batch) => batch.length > 1)) {
    return generateBatchedWorkflow({
      runId, phase, tasks, batches, maxParallel, tierModels, planPath, baseBranch, constraints, caveman, effort, neighbours, contextBundles,
    })
  }

  const meta = {
    name: `${NAMES.branchPrefix}-${runId}-phase-${phase}`,
    description: `Run phase ${phase} of ${NAMES.product} run ${runId} (${tasks.length} tasks, max ${maxParallel} parallel)`,
    phases: [{ title: 'Implement', detail: `${tasks.length} worktree-isolated implementers` }],
  }

  const slim = slimTasks(tasks, runId, tierModels, neighbours)
  const template = await readFile(TEMPLATE, 'utf8')

  const substitutions = {
    __META__: () => `export const meta = ${jsLiteral(meta)}`,
    __TASKS__: () => JSON.stringify(slim, null, 2),
    // One brief per task, composed here rather than in the template: a generated workflow runs
    // without module or filesystem access, so composeBrief cannot be called at workflow runtime.
    // Embedding the finished text is the only way both dispatch paths (this generator and
    // `cli.mjs brief`) can share one implementation.
    __BRIEFS__: () => JSON.stringify(
      Object.fromEntries(slim.map((task) => [task.id, composeBrief({
        task, runId, planPath, baseBranch, constraints, caveman, contextBundle: contextBundles[task.id] ?? null,
      })])),
      null,
      2,
    ),
    __EFFORT__: () => jsLiteral(effort),
    __RESULT_SCHEMA__: () => JSON.stringify(RESULT_SCHEMA, null, 2),
  }

  // One global pass over the template, not a chain of per-marker replacements. A chain
  // rewrites the *first* occurrence anywhere in the string, so a value substituted early
  // (a task title, say) could itself contain a later marker and be rescanned — turning
  // caller-supplied text into a substitution site and, with a quote, into executable code.
  // A single global pass resumes after each replacement, so inserted text is never rescanned.
  //
  // The replacer is a function, not a string: String.prototype.replace treats $&, $`, $',
  // $$ and $<n> in a *string* replacement as special patterns, which would silently corrupt
  // output for a title/plan path/branch/constraint containing e.g. "$&".
  return template.replace(MARKER, (marker) => substitutions[marker]())
}

// One agent per batch. Its brief is `composeBatchBrief` over the batch's tasks, the same function
// `cli.mjs brief --task A --task B` calls; its model is the batch's tier's; its schema asks for one
// result per task. The template flattens the answers back to the per-task `{ taskId, ...result }`
// shape of an unbatched phase, in plan order, and reports every task without a result `orphaned`,
// so nothing that reads a phase's results needs to know the phase was batched.
async function generateBatchedWorkflow({
  runId, phase, tasks, batches, maxParallel, tierModels, planPath, baseBranch, constraints, caveman, effort, neighbours, contextBundles,
}) {
  const meta = {
    name: `${NAMES.branchPrefix}-${runId}-phase-${phase}`,
    description: `Run phase ${phase} of ${NAMES.product} run ${runId} (${tasks.length} tasks in ${batches.length} batches, max ${maxParallel} parallel)`,
    phases: [{ title: 'Implement', detail: `${batches.length} worktree-isolated implementers, each doing its tasks in sequence` }],
  }
  const slim = slimTasks(tasks, runId, tierModels, neighbours)
  const byId = new Map(slim.map((task) => [task.id, task]))
  const slimBatches = batches.map((batch) => {
    const ids = batch.map((task) => task.id)
    // Every task of a batch has the same tier, so the first task's model is the batch's.
    const model = byId.get(ids[0]).model
    const base = { id: ids.join('+'), tasks: ids, schema: batchResultSchema(ids) }
    return model ? { ...base, model } : base
  })
  const template = await readFile(BATCHED_TEMPLATE, 'utf8')
  const substitutions = {
    __META__: () => `export const meta = ${jsLiteral(meta)}`,
    __TASKS__: () => JSON.stringify(slim, null, 2),
    __BATCHES__: () => JSON.stringify(slimBatches, null, 2),
    __BRIEFS__: () => JSON.stringify(
      Object.fromEntries(slimBatches.map((batch) => [batch.id, composeBatchBrief({
        tasks: batch.tasks.map((id) => byId.get(id)),
        runId, planPath, baseBranch, constraints, caveman, contextBundles,
      })])),
      null,
      2,
    ),
    __EFFORT__: () => jsLiteral(effort),
  }
  // The same single global pass, with a function replacer, as the unbatched script: see there.
  return template.replace(MARKER, (marker) => substitutions[marker]())
}
