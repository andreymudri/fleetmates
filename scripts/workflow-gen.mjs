import { taskBranchName } from './enforce.mjs'
import { NAMES } from './names.mjs'
import { readFile } from 'node:fs/promises'
import { composeBrief } from './brief.mjs'
import { RESULT_SCHEMA } from './result-schema.mjs'

const TEMPLATE = new URL('../templates/phase-workflow.js', import.meta.url)
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

const MARKER = /__(?:META|TASKS|BRIEFS|EFFORT|RESULT_SCHEMA)__/g

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

export async function generatePhaseWorkflow({
  runId, phase, tasks, maxParallel, tierModels,
  planPath = '', baseBranch = '', constraints = [], caveman = false, effort = '', neighbours = {},
}) {
  if (!tasks || tasks.length === 0) throw new Error(`no tasks for phase ${phase}`)

  const meta = {
    name: `${NAMES.branchPrefix}-${runId}-phase-${phase}`,
    description: `Run phase ${phase} of ${NAMES.product} run ${runId} (${tasks.length} tasks, max ${maxParallel} parallel)`,
    phases: [{ title: 'Implement', detail: `${tasks.length} worktree-isolated implementers` }],
  }

  // The branch name is computed once here rather than derived again inside the template,
  // so the brief's `checkout -B` and the dispatch cannot disagree about the string.
  const slim = tasks.map(({ id, title, files, tier }) => {
    const model = tierModels?.[tier]
    const base = { id, title, files, branch: taskBranchName(runId, id) }
    const near = neighbours?.[id]
    const withNear = Array.isArray(near) && near.length > 0 ? { ...base, neighbours: near } : base
    return model ? { ...withNear, model } : withNear
  })
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
        task, runId, planPath, baseBranch, constraints, caveman,
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
