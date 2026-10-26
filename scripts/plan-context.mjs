import { parsePlan } from './plan-parser.mjs'

// Use the plan's existing task/dependency grammar. Co-change history is not a contract.
export function selectPlanContracts(markdown, source, task) {
  if (typeof markdown !== 'string' || typeof source !== 'string' || !source || !task
      || typeof task.id !== 'string') throw new Error('Invalid plan context inputs')
  const tasks = parsePlan(markdown), byId = new Map(tasks.map(t => [t.id, t]))
  const lines = markdown.split(/\r?\n/), ranges = new Map()
  let current = null, fence = null
  for (const [index, line] of lines.entries()) {
    const boundary = /^\s*(`{3,}|~{3,})/.exec(line)
    if (boundary) {
      if (!fence) fence = boundary[1]
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length) fence = null
    } else if (!fence) {
      const heading = /^###\s+Task\s+(\d+)\s*:/.exec(line)
      if (heading || /^(##\s|-{3,}\s*$)/.test(line)) {
        if (current) current.endLine = index
        current = null
        if (heading) { current = { startLine: index + 1, endLine: lines.length }; ranges.set(`T${heading[1]}`, current) }
      }
    }
  }
  const members = task.members ?? [task.id]
  if (!Array.isArray(members) || members.some(id => typeof id !== 'string') || new Set(members).size !== members.length) throw new Error('Invalid plan context members')
  const selected = new Map()
  for (const id of members) {
    const owner = byId.get(id)
    if (!owner) continue // Legacy synthetic task records have no contract to select.
    // Opt in with a tracked acceptance heading; preserve the entire task so adjacent
    // constraints and verification commands cannot disappear during extraction.
    if (owner.ui?.length || /^\*\*Acceptance:\*\*/m.test(owner.brief)) selected.set(id, 'tracked acceptance and task contract')
    for (const dependency of owner.deps) {
      if (!byId.has(dependency)) throw new Error(`Declared dependency ${dependency} is absent from anchored plan`)
      if (!selected.has(dependency)) selected.set(dependency, `declared dependency contract for ${id}`)
    }
  }
  return [...selected].map(([id, reason]) => {
    const range = ranges.get(id)
    if (!range) throw new Error('Plan context provenance is unavailable')
    return { id: `plan-contract-${id}`, source, ...range, text: lines.slice(range.startLine - 1, range.endLine).join('\n'), mandatory: true, reason }
  })
}
