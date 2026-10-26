import { evidenceIdentity, reviewerMetrics } from './workflow-evidence.mjs'

// Explicit duplicate links are observations, never inferred from similar text.
export function summarizeReviewOutcomes({ inputs, findings, labeledDefects = null }) {
  const identity = evidenceIdentity(inputs)
  if (!Array.isArray(findings)) throw new Error('Review findings must be an array')
  const byId = new Map()
  const text = value => typeof value === 'string' && value.trim().length > 0
  for (const finding of findings) {
    if (!finding || !text(finding.id) || byId.has(finding.id)
        || !['confirmed', 'refuted', 'duplicate', 'unreproduced', 'accepted'].includes(finding.outcome)
        || !text(finding.identity) || !text(finding.rationale)
        || !finding.provenance || ['lens', 'category', 'model', 'source'].some(k => !text(finding.provenance[k]))
        || !Array.isArray(finding.evidence) || finding.evidence.length === 0 || finding.evidence.some(v => !text(v))) {
      throw new Error('Finding requires unique identity, provenance, rationale and evidence references')
    }
    if (finding.outcome === 'duplicate' ? !text(finding.duplicateOf) : finding.duplicateOf != null) throw new Error('Only duplicate outcomes must name duplicateOf')
    byId.set(finding.id, finding)
  }
  const canonical = finding => {
    const visited = new Set()
    let current = finding
    while (current.outcome === 'duplicate') {
      if (visited.has(current.id)) throw new Error('Duplicate finding cycle')
      visited.add(current.id)
      const next = byId.get(current.duplicateOf)
      if (!next || next.identity !== current.identity) throw new Error('Duplicate target missing or belongs to different inputs')
      current = next
    }
    return current.id
  }
  const groups = new Map(), current = [], stale = []
  for (const finding of findings) {
    const canonicalId = canonical(finding)
    if (finding.identity !== identity) { stale.push(finding.id); continue }
    current.push(finding)
    if (!groups.has(canonicalId)) groups.set(canonicalId, { id: canonicalId, outcome: byId.get(canonicalId).outcome, observations: [] })
    groups.get(canonicalId).observations.push({ id: finding.id, provenance: finding.provenance, rationale: finding.rationale, evidence: finding.evidence })
  }
  const breakdown = {}
  for (const dimension of ['lens', 'category', 'model']) {
    const buckets = new Map()
    for (const finding of current) {
      const key = finding.provenance[dimension]
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(finding)
    }
    breakdown[dimension] = [...buckets].map(([value, observations]) => ({ value, ...reviewerMetrics(observations, labeledDefects) }))
  }
  return { version: 1, identity, mode: 'reporting', trust: 'Outcome and evidence references are observations, not independent reproduction proof.',
    metrics: reviewerMetrics(current, labeledDefects), breakdown, groups: [...groups.values()], stale }
}
