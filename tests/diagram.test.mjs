import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DIAGRAM_SCHEMA, validateDiagram, phaseDiagram } from '../scripts/diagram.mjs'
import { writeState } from '../scripts/state.mjs'
import { runCli } from '../scripts/cli.mjs'

const graph = () => ({ v: 1, kind: 'architecture', nodes: [
  { id: 'api', label: 'API', state: 'running', lane: 0 }, { id: 'store', label: 'Store', state: 'queued', lane: 1 },
], edges: [{ from: 'api', to: 'store', kind: 'connects' }] })

test('diagram schema and validator accept JSON data and reject markup, unknown states and dangling edges', () => {
  const source = graph(), copy = validateDiagram(source)
  assert.deepEqual(copy, source)
  copy.nodes[0].label = 'changed'
  assert.equal(source.nodes[0].label, 'API')
  assert.equal(DIAGRAM_SCHEMA.properties.nodes.maxItems, 256)
  for (const change of [g => { g.script = 'run' }, g => { g.nodes[0].state = 'approved' }, g => { g.nodes[0].label = 'bad\u202e' },
    g => { g.nodes[0].lane = 300 }, g => { g.nodes.push({ ...g.nodes[0] }) }, g => { g.edges[0].to = 'absent' }, g => { g.edges.push({ ...g.edges[0] }) },
    g => { g.nodes = Array.from({ length: 257 }, (_, n) => ({ id: `n${n}`, label: `n${n}`, state: 'done', lane: 0 })) },
  ]) { const value = graph(); change(value); assert.throws(() => validateDiagram(value)) }
})

test('phase diagram emits bounded labels and dependencies with lifecycle states', () => {
  const data = phaseDiagram({ tasks: [{ id: 'T1', title: 'arbitrary teammate prose', phase: 1, deps: [] }, { id: 'T2', phase: 2, deps: ['T1', 'T1', 'missing'] }] },
    { tasks: [{ id: 'T1', state: 'done' }, { id: 'T2', state: 'constructor' }] })
  assert.equal(data.nodes[0].label, 'T1')
  assert.equal(data.nodes[0].state, 'done')
  assert.equal(data.nodes[1].state, 'unknown')
  assert.equal(data.nodes[1].lane, 2)
  assert.deepEqual(data.edges, [{ from: 'T1', to: 'T2', kind: 'depends' }])
})

test('diagram CLI emits the stored run phase view and refuses absent plans', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diagram-test-')))
  try {
    await writeState(root, 'r1', 'plan', { tasks: [{ id: 'T1', phase: 1 }] })
    await writeState(root, 'r1', 'status', { tasks: [{ id: 'T1', state: 'blocked' }] })
    const out = []
    assert.equal(await runCli(['diagram', '--run', 'r1', '--root', root], { out: text => out.push(text) }), 0)
    assert.equal(JSON.parse(out.pop()).nodes[0].state, 'blocked')
    assert.equal(await runCli(['diagram', '--run', 'missing', '--root', root], { out: text => out.push(text) }), 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
