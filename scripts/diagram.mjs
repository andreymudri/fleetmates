// JSON data for native architecture and phase views, never executable markup.
export const LIFECYCLE_STATES = Object.freeze(['queued', 'running', 'blocked', 'done', 'failed', 'unknown'])
export const DIAGRAM_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false, required: ['v', 'kind', 'nodes', 'edges'],
  properties: {
    v: { const: 1 }, kind: { enum: ['architecture', 'phase'] },
    nodes: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false, required: ['id', 'label', 'state', 'lane'], properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, label: { type: 'string', minLength: 1, maxLength: 120 },
      state: { enum: LIFECYCLE_STATES }, lane: { type: 'integer', minimum: 0, maximum: 256 },
    } } },
    edges: { type: 'array', maxItems: 1024, items: { type: 'object', additionalProperties: false, required: ['from', 'to', 'kind'], properties: {
      from: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, to: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, kind: { enum: ['depends', 'connects'] },
    } } },
  },
})
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
export function validateDiagram(value) {
  if (!keys(value, ['v', 'kind', 'nodes', 'edges']) || value.v !== 1 || !['architecture', 'phase'].includes(value.kind)
    || !Array.isArray(value.nodes) || value.nodes.length > 256 || !Array.isArray(value.edges) || value.edges.length > 1024) throw new Error('invalid diagram')
  const ids = new Set()
  for (const node of value.nodes) {
    if (!keys(node, ['id', 'label', 'state', 'lane']) || !id(node.id) || ids.has(node.id) || typeof node.label !== 'string' || !node.label.trim() || node.label.length > 120
      || /[\p{Cc}\p{Cf}]/u.test(node.label) || !LIFECYCLE_STATES.includes(node.state) || !Number.isInteger(node.lane) || node.lane < 0 || node.lane > 256) throw new Error('invalid diagram node')
    ids.add(node.id)
  }
  const edges = new Set()
  for (const edge of value.edges) {
    const key = JSON.stringify([edge.from, edge.to, edge.kind])
    if (!keys(edge, ['from', 'to', 'kind']) || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || !['depends', 'connects'].includes(edge.kind) || edges.has(key)) throw new Error('invalid diagram edge')
    edges.add(key)
  }
  return structuredClone(value)
}

export function phaseDiagram(plan, status) {
  const states = new Map((Array.isArray(status?.tasks) ? status.tasks : []).filter(task => /^T\d+$/.test(task?.id)).map(task => [task.id, task.state]))
  const stateMap = { pending: 'queued', running: 'running', blocked: 'blocked', done: 'done', failed: 'failed', orphaned: 'failed' }
  const tasks = (Array.isArray(plan?.tasks) ? plan.tasks : []).filter(task => /^T\d+$/.test(task?.id)).slice(0, 256)
  const nodes = tasks.map(task => ({ id: task.id, label: task.id, state: Object.hasOwn(stateMap, states.get(task.id)) ? stateMap[states.get(task.id)] : 'unknown', lane: Number.isInteger(task.phase) && task.phase >= 0 && task.phase <= 256 ? task.phase : 0 }))
  const ids = new Set(nodes.map(node => node.id))
  const edges = tasks.flatMap(task => [...new Set(Array.isArray(task.deps) ? task.deps : [])].filter(dep => ids.has(dep) && dep !== task.id).map(dep => ({ from: dep, to: task.id, kind: 'depends' }))).slice(0, 1024)
  return validateDiagram({ v: 1, kind: 'phase', nodes, edges })
}
