import { parsePlan } from './plan-parser.mjs'
import { proseSection } from './plan-sections.mjs'

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

// The longest Statement a brief carries, in characters. A request with a pasted document would
// otherwise be repeated in the brief of every teammate.
export const STATEMENT_LIMIT = 2000

// What the whole plan is for: its Destination and the request it was written from. A brief names
// one task; without this an implementer judges its work against the plan author's reading of the
// request and never sees the request. Read with `proseSection` and not `parsePlanSections`, so a
// defect in another header section does not take this away: `init-run` already refuses that plan,
// and a brief is not where it is reported.
//
// Returns null for a plan with neither section, so its brief is the brief it had before.
export function planRequestContext(markdown, source) {
  if (typeof markdown !== 'string' || typeof source !== 'string') return null
  const destination = proseSection(markdown, 'Destination') || null
  const whole = proseSection(markdown, 'Statement') || null
  if (!destination && !whole) return null
  // Code points, so the cut never leaves half of a surrogate pair.
  const points = whole === null ? [] : [...whole]
  const statementTruncated = points.length > STATEMENT_LIMIT
  return { source, destination, statement: statementTruncated ? points.slice(0, STATEMENT_LIMIT).join('') : whole, statementTruncated }
}
