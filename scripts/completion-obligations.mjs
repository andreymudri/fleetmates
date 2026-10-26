import { createHash } from 'node:crypto'

const INPUTS = ['commit', 'plan', 'manifest', 'context', 'environment', 'verifier']
const KINDS = ['implementation', 'command', 'review', 'acceptance', 'integration']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
const run = value => typeof value === 'string' && value.length <= 255 && /^[\p{L}\p{M}\p{N}._/-]+$/u.test(value)
  && value === value.normalize('NFC') && !/\p{Default_Ignorable_Code_Point}/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..')
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function strictExecutionIdentity(inputs) {
  if (!object(inputs) || Object.keys(inputs).length !== INPUTS.length || !sha(inputs.commit)
      || INPUTS.slice(1).some(key => !hash(inputs[key]))) throw new Error('Invalid strict execution inputs')
  return digest(INPUTS.map(key => [key, inputs[key]]))
}
function refs(value) {
  if (!object(value) || Object.keys(value).length > 100 || Object.entries(value).some(([ref, tip]) =>
    !ref.startsWith('refs/heads/') || ref.length > 255 || /[\p{C}\s~^:?*\[\\]/u.test(ref)
    || ref.includes('..') || ref.includes('@{') || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
    || !sha(tip))) throw new Error('Invalid expected refs')
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
}
function artifact(value) {
  if (!object(value) || Object.keys(value).length !== 5 || value.version !== 1 || !run(value.runId)
      || !label(value.kind) || !hash(value.sha256) || !Number.isSafeInteger(value.byteLength)
      || value.byteLength < 0 || value.byteLength > 64 * 1024 * 1024) return null
  return JSON.stringify([value.version, value.runId, value.kind, value.sha256, value.byteLength])
}
function bounded(values, name, minimum = 0) {
  if (!Array.isArray(values) || values.length < minimum || values.length > 1000) throw new Error(`Invalid or unbounded ${name}`)
}
function unique(values, name) {
  const ids = new Set()
  for (const value of values) {
    if (!object(value) || !label(value.id) || ids.has(value.id)) throw new Error(`Invalid or duplicate ${name} id`)
    ids.add(value.id)
  }
}

// inputs bind the anchored request. Requirements supply exact step inputs, tree,
// refs, scope (step/final), kind, id and mandatory flag. Trusted callers refresh
// final expectations and supply artifact observations from independent reads.
export function summarizeCompletionObligations({ inputs, requirements, receipts, artifactObservations, branches, lifecycle }) {
  const identity = strictExecutionIdentity(inputs)
  bounded(requirements, 'requirements', 1); bounded(receipts, 'receipts'); bounded(artifactObservations, 'artifact observations')
  if (Buffer.byteLength(JSON.stringify({ inputs, requirements, receipts, artifactObservations, branches, lifecycle })) > 1024 * 1024) throw new Error('Completion input exceeds byte bound')
  unique(requirements, 'requirement'); unique(receipts, 'receipt')
  refs(branches)
  if (!object(lifecycle) || !run(lifecycle.runId) || !['running', 'blocked', 'failed', 'suspended', 'abandoned', 'interrupted', 'unknown-effect'].includes(lifecycle.state)) throw new Error('Invalid completion lifecycle')
  const observedArtifacts = new Set(artifactObservations.filter(o => object(o) && o.verified === true
    && o.reference?.runId === lifecycle.runId).map(o => artifact(o.reference)).filter(Boolean))
  const obligations = requirements.map(requirement => {
    if (!KINDS.includes(requirement.kind) || typeof requirement.mandatory !== 'boolean'
        || !['step', 'final'].includes(requirement.scope) || !sha(requirement.tree)) throw new Error('Invalid completion requirement')
    const expectedIdentity = strictExecutionIdentity(requirement.inputs), expectedRefs = refs(requirement.refs)
    if (expectedRefs.length === 0) throw new Error('Requirement needs exact expected refs')
    const relevant = receipts.filter(receipt => receipt.requirement === requirement.id)
    const current = relevant.filter(receipt => receipt.requestIdentity === identity && receipt.identity === expectedIdentity
      && receipt.tree === requirement.tree && expectedRefs.every(([ref, tip]) => branches[ref] === tip && receipt.refs?.[ref] === tip)
      && object(receipt.refs) && Object.keys(receipt.refs).length === expectedRefs.length)
    const verified = receipt => receipt.version === 2 && receipt.executionBacked === true && receipt.kind === requirement.kind
      && observedArtifacts.has(artifact(receipt.artifact))
    const status = current.some(receipt => receipt.status === 'fail') ? 'fail'
      : current.length > 0 && current.every(receipt => receipt.status === 'pass' && verified(receipt)) ? 'pass' : 'unresolved'
    return { id: requirement.id, kind: requirement.kind, mandatory: requirement.mandatory, scope: requirement.scope,
      identity: expectedIdentity, tree: requirement.tree, refs: Object.fromEntries(expectedRefs), status,
      receipts: current.map(receipt => receipt.id), stale: relevant.length - current.length }
  })
  const finalTrees = new Set(requirements.filter(r => r.scope === 'final' && r.mandatory)
    .map(r => JSON.stringify([r.inputs.commit, r.tree])))
  if (finalTrees.size > 1) {
    for (const obligation of obligations.filter(o => o.scope === 'final' && o.mandatory && o.status === 'pass')) {
      obligation.status = 'unresolved'
      obligation.reason = 'inconsistent-final-tree'
    }
  }
  for (const kind of ['implementation', 'acceptance', 'integration']) {
    if (!obligations.some(o => o.kind === kind && o.mandatory)) {
      obligations.push({ id: `missing-${kind}`, kind, mandatory: true, scope: 'step', status: 'unresolved', receipts: [], stale: 0 })
    }
  }
  for (const kind of ['command', 'review']) {
    if (!obligations.some(o => o.kind === kind && o.scope === 'final' && o.mandatory)) {
      obligations.push({ id: `missing-final-${kind}`, kind, mandatory: true, scope: 'final', status: 'unresolved', receipts: [], stale: 0 })
    }
  }
  const mandatory = obligations.filter(o => o.mandatory)
  const verifiedComplete = lifecycle.state === 'running' && mandatory.every(o => o.status === 'pass')
  const state = ['suspended', 'abandoned', 'blocked', 'failed'].includes(lifecycle.state) ? lifecycle.state
    : mandatory.some(o => o.status === 'fail') ? 'failed' : verifiedComplete ? 'verified-complete' : 'unresolved'
  return { version: 2, identity, verifiedComplete, state, obligations, stale: obligations.reduce((sum, o) => sum + o.stale, 0),
    trust: ['Artifact observations and expected step/final identities must come from the trusted controller and actual artifact reads.',
      'This report does not authenticate supplied observations, grant publication authority or prove graceful harness callbacks.',
      'Legacy observations and enforcement-only checks cannot establish strict completion.'] }
}
