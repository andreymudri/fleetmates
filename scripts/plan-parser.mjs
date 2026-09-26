// `printable` at the one place a plan's own bytes enter an error message: a plan is an
// agent-written file, and `doctor`, `liveness`, `plan-drift` and `init-run` all print this
// message to stdout. Neutralised here once, so no print site can forget to.
import { printable } from './reviews.mjs'

const TASK_HEADING = /^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/
const FILES_HEADING = /^\*\*Files:\*\*\s*$/
// The optional ` (protected)` after the verb authorises the task to change a path the gate
// manifest protects (docs/specs/2026-09-26-protected-paths-design.md). Exact lower case only.
// One modifier at most: `(protected)` authorises changing a protected path, `(drops)` authorises
// the gate's test inventory to see tests in that file stop running. A task needing both writes the
// path on two lines; a combined `(protected, drops)` is refused like any other malformed line.
const FILE_LINE = /^-\s+(?:Create|Modify|Test)(?:\s+\((protected|drops)\))?\s*:\s*`([^`]+)`\s*$/
// Anything shaped like a file line. Inside a Files block, a line of this shape that FILE_LINE
// does not match is refused: it used to drop out of `files` silently, and with `(protected)` a
// typo in the marking would silently remove scope permission instead of granting it.
// Any number of parenthesised groups, so a stacked `(drops) (protected)` is refused rather than
// matching neither pattern and dropping out of `files` silently.
const FILE_LINE_SHAPE = /^-\s+[A-Za-z]+(\s*\([^)]*\))*\s*:\s*`/
const DEPENDS_LINE = /^\*\*Depends:\*\*\s*(.+?)\s*$/
// Recorded verbatim, not validated: init-run owns the tier vocabulary via routing.mjs.
// A second check here would let the two drift apart silently.
const MODEL_LINE = /^\*\*Model:\*\*\s*(.+?)\s*$/
const SECTION_BREAK = /^(\*\*|###|- \[[ x]\])/
// Ends a task body: a document-level `## ` heading or a `---` rule. `### ` does not match,
// so task headings stay the business of TASK_HEADING. Only consulted outside a fence, so a
// `## ` or `---` written inside a task's fenced code block stays part of that task's brief.
const DOC_BREAK = /^(##\s|-{3,}\s*$)/
const NO_DEPS_SENTINELS = new Set(['none', 'n/a', 'na', '-', ''])

// A plan the parser refuses on its own terms, as opposed to a bug in the parser. `init-run`
// reports it as a refusal (exit 2) instead of letting a stack trace stand in for the message.
export class PlanParseError extends Error {}

export function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/)
  const tasks = []
  const seen = new Set()
  let current = null
  let inFiles = false
  let inFence = false
  let fenceChar = null
  let fenceLength = 0

  for (const [index, line] of lines.entries()) {
    // `inFence` still holds the state from before this line, so a closing fence and every
    // line within the block read as "inside a fence" here.
    if (current) {
      if (!inFence && DOC_BREAK.test(line)) current = null
      else if (!TASK_HEADING.test(line)) current.brief.push(line)
    }
    // Check for fence open/close
    const trimmed = line.trimStart()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const char = fenceMatch[1][0]
      const length = fenceMatch[1].length
      if (inFence && char === fenceChar && length >= fenceLength) {
        // Closing fence
        inFence = false
        fenceChar = null
        fenceLength = 0
      } else if (!inFence) {
        // Opening fence
        inFence = true
        fenceChar = char
        fenceLength = length
      }
      continue
    }

    // Skip all processing if inside a fence
    if (inFence) continue

    const heading = TASK_HEADING.exec(line)
    if (heading) {
      const id = `T${heading[1]}`
      if (seen.has(id)) throw new PlanParseError(`duplicate task id: ${id}`)
      seen.add(id)
      current = { id, title: heading[2], files: [], protectedFiles: [], dropFiles: [], deps: [], brief: [] }
      tasks.push(current)
      inFiles = false
      continue
    }
    if (!current) continue

    if (FILES_HEADING.test(line)) { inFiles = true; continue }

    const depends = DEPENDS_LINE.exec(line)
    if (depends) {
      current.deps = depends[1]
        .split(',')
        .map((d) => d.trim())
        .filter((d) => !NO_DEPS_SENTINELS.has(d.toLowerCase()))
      inFiles = false
      continue
    }

    const model = MODEL_LINE.exec(line)
    if (model) {
      current.tier = model[1]
      current.tierSource = 'declared'
      inFiles = false
      continue
    }

    if (inFiles) {
      const file = FILE_LINE.exec(line)
      if (file) {
        const declared = file[2].split(':')[0]
        current.files.push(declared)
        if (file[1] === 'protected') current.protectedFiles.push(declared)
        if (file[1] === 'drops') current.dropFiles.push(declared)
        continue
      }
      if (FILE_LINE_SHAPE.test(line)) {
        throw new PlanParseError(
          `plan line ${index + 1}: unrecognised file line — use "- Create|Modify|Test[ (protected|drops)]: \`path\`": ${printable(line.trim())}`,
        )
      }
      if (line.trim() !== '' && SECTION_BREAK.test(line.trim())) inFiles = false
    }
  }

  return tasks.map((task) => ({ ...task, brief: task.brief.join('\n').trim() }))
}
