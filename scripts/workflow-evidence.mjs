import { createHash } from 'node:crypto'
const INPUTS = ['commit', 'plan', 'manifest', 'environment', 'verifier']
export function evidenceIdentity(inputs) {
  if (!inputs || INPUTS.some(k => typeof inputs[k] !== 'string' || !inputs[k])) throw new Error('Missing evidence input identity')
  return createHash('sha256').update(JSON.stringify(INPUTS.map(k => [k, inputs[k]]))).digest('hex')
}
export function summarizeAcceptance({ inputs, requirements, evidence }) {
  const identity = evidenceIdentity(inputs)
  if (!Array.isArray(requirements) || requirements.length === 0 || !Array.isArray(evidence)) throw new Error('Acceptance requirements and evidence are required')
  const ids = new Set()
  const obligations = requirements.map(requirement => {
    if (!requirement || typeof requirement.id !== 'string' || !requirement.id || ids.has(requirement.id)
        || !['deterministic', 'judgment', 'human'].includes(requirement.kind)) throw new Error('Invalid acceptance requirement')
    ids.add(requirement.id)
    const relevant = evidence.filter(e => e.requirement === requirement.id && e.identity === identity)
    if (relevant.some(e => !['pass', 'fail', 'unresolved'].includes(e.status) || typeof e.log !== 'string' || !e.log)) throw new Error('Evidence needs a status and full log path')
    // Conflicting evidence is not resolved by whichever array element happened to come last.
    const status = relevant.some(e => e.status === 'fail') ? 'fail'
      : relevant.some(e => e.status === 'unresolved') ? 'unresolved'
      : relevant.some(e => e.status === 'pass' && e.kind === requirement.kind) ? 'pass'
      : requirement.kind === 'human' ? 'human-required' : 'unresolved'
    return { ...requirement, status, logs: relevant.map(e => e.log), stale: evidence.filter(e => e.requirement === requirement.id && e.identity !== identity).length }
  })
  return { version: 1, identity, complete: obligations.every(o => o.status === 'pass'), obligations,
    mode: 'legacy-observations', verifiedComplete: false,
    trust: 'Legacy acceptance observations are not strict execution-backed completion evidence.' }
}
export function reviewerMetrics(findings, labeledDefects = null) {
  if (!Array.isArray(findings)) throw new Error('Findings must be an array')
  const known = ['confirmed', 'refuted', 'duplicate', 'unreproduced', 'accepted']
  const counts = Object.fromEntries(known.map(k => [k, 0]))
  const seen = new Set()
  for (const finding of findings) {
    if (!finding || typeof finding.id !== 'string' || !finding.id || seen.has(finding.id) || !known.includes(finding.outcome)) throw new Error('Invalid or duplicate finding identity')
    seen.add(finding.id); counts[finding.outcome]++
  }
  const judged = counts.confirmed + counts.refuted
  let recall = null
  if (labeledDefects !== null) {
    if (!Array.isArray(labeledDefects) || labeledDefects.some(v => typeof v !== 'string') || new Set(labeledDefects).size !== labeledDefects.length) throw new Error('Invalid independent defect labels')
    const detected = new Set(findings.filter(f => f.outcome === 'confirmed').map(f => f.defect).filter(v => labeledDefects.includes(v)))
    recall = labeledDefects.length ? detected.size / labeledDefects.length : null
  }
  return { counts, precision: judged ? counts.confirmed / judged : null, recall }
}
