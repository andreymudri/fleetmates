import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { layoutClusters, layoutLocal, labelled, nearestInDirection } from '../../web/src/screens/memory/graph-layout.js'

const graph = { nodes: [{ id: '00-index/index-knowledge.md' }, { id: '02-wiki/test/test-moc.md' }, { id: '02-wiki/test/leaf.md' }, { id: '04-daily/today.md' }], edges: [{ source: '00-index/index-knowledge.md', target: '02-wiki/test/test-moc.md' }, { source: '02-wiki/test/test-moc.md', target: '02-wiki/test/leaf.md' }] }
test('graph layout is deterministic, excludes daily notes and traverses two-hop neighbours', () => {
  const first = layoutClusters(graph)
  assert.deepEqual(layoutClusters(graph), first)
  assert.equal(first.nodes.length, 3)
  assert.equal(first.nodes.find(node => node.kind === 'index').x, 450)
  assert.equal(layoutLocal(graph, '00-index/index-knowledge.md').nodes.find(node => node.path.endsWith('leaf.md')).hop, 2)
})
test('large graphs suppress leaf labels, preserve MOCs, and arrow movement picks the requested direction', () => {
  assert.equal(labelled({ id: '02-wiki/test/leaf.md' }, { total: 301, fresh: true }), false)
  assert.equal(labelled({ id: '02-wiki/test/test-moc.md' }, { total: 301 }), true)
  const nodes = [{ path: 'centre', x: 0, y: 0 }, { path: 'right', x: 2, y: 0 }, { path: 'left', x: -1, y: 0 }]
  assert.equal(nearestInDirection(nodes, nodes[0], 'ArrowRight').path, 'right')
  const big = { nodes: Array.from({ length: 1000 }, (_, i) => ({ id: `02-wiki/domain${i % 8}/note-${i}.md` })), edges: [] }
  const started = performance.now()
  assert.equal(layoutClusters(big).nodes.length, 1000)
  assert.ok(performance.now() - started < 200)
})
