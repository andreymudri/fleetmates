import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadGateConfig, checksForPhase, checksForRun } from '../scripts/gate-config.mjs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('the plugin ships its own gate manifest', async () => {
  const config = await loadGateConfig(root)
  assert.ok(config, 'fleetmates.gate.json is missing')
  assert.equal(typeof config.maxParallel, 'number')
})

test('the default phase runs the test suite, and the run entry runs it and the review', async () => {
  const config = await loadGateConfig(root)
  for (const checks of [checksForPhase(config, 'default'), checksForRun(config)]) {
    const test_ = checks.find((c) => c.name === 'test')
    assert.equal(test_.kind, 'command')
    assert.match(test_.run, /npm test/)
  }
  const review = checksForRun(config).find((c) => c.name === 'review')
  assert.equal(review.agent, 'tm-reviewer')
})

test('every review the manifest declares says in so many words that it runs once per run', async () => {
  const config = await loadGateConfig(root)
  const reviews = Object.entries(config.phases).flatMap(([name, block]) =>
    block.checks.filter((c) => c.kind === 'agent').map((c) => [name, c.scope]))
  assert.deepEqual(reviews.sort(), [['10', 'run'], ['default', 'run']])
})

test('the default phase enforces fileset and ownership, and leaves the review to the run entry', async () => {
  // A phase gate runs before `finish` computes the run entry, so fileset and ownership still
  // decide every phase before the review sees the integrated diff.
  const checks = checksForPhase(await loadGateConfig(root), 'default')
  const fileset = checks.find((c) => c.name === 'fileset')
  const ownership = checks.find((c) => c.name === 'ownership')
  assert.ok(fileset, 'fileset check is missing from the manifest')
  assert.equal(fileset.kind, 'fileset')
  assert.notEqual(fileset.optional, true)
  assert.ok(ownership, 'ownership check is missing from the manifest')
  assert.equal(ownership.kind, 'ownership')
  assert.notEqual(ownership.optional, true)
  assert.equal(checks.find((c) => c.kind === 'agent'), undefined, 'the review belongs to the run entry')
  const run = checksForRun(await loadGateConfig(root))
  assert.ok(run.some((c) => c.kind === 'fileset-run' && c.optional !== true), 'the run entry checks its own file set')
})
