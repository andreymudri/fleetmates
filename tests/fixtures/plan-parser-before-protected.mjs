const TASK_HEADING = /^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/
const FILES_HEADING = /^\*\*Files:\*\*\s*$/
const FILE_LINE = /^-\s+(?:Create|Modify|Test)\s*:\s*`([^`]+)`\s*$/
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

export function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/)
  const tasks = []
  const seen = new Set()
  let current = null
  let inFiles = false
  let inFence = false
  let fenceChar = null
  let fenceLength = 0

  for (const line of lines) {
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
      if (seen.has(id)) throw new Error(`duplicate task id: ${id}`)
      seen.add(id)
      current = { id, title: heading[2], files: [], deps: [], brief: [] }
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
        current.files.push(file[1].split(':')[0])
        continue
      }
      if (line.trim() !== '' && SECTION_BREAK.test(line.trim())) inFiles = false
    }
  }

  return tasks.map((task) => ({ ...task, brief: task.brief.join('\n').trim() }))
}
