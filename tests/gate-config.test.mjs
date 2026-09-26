import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  loadGateConfig,
  inferGateConfig,
  checksForPhase,
  fixRoundsForPhase,
  previewLinks,
  protectedPaths,
} from '../scripts/gate-config.mjs'

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-gate-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('loadGateConfig returns null when the manifest is absent', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await loadGateConfig(root), null)
  })
})

test('loadGateConfig reads the manifest', async () => {
  await withTempRoot(async (root) => {
    const config = { maxParallel: 4, phases: { default: { checks: [] } } }
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify(config), 'utf8')
    assert.deepEqual(await loadGateConfig(root), config)
  })
})

test('inferGateConfig includes only scripts that exist', () => {
  const config = inferGateConfig({ scripts: { test: 'vitest run', build: 'next build' } })
  const names = config.phases.default.checks.map((c) => c.name)
  assert.deepEqual(names, ['test', 'build', 'fileset', 'ownership', 'review'])
})

test('inferGateConfig always appends fileset and ownership checks before review', () => {
  const config = inferGateConfig({ scripts: { test: 'node --test' } })
  const names = config.phases.default.checks.map((c) => c.name)
  assert.deepEqual(names, ['test', 'fileset', 'ownership', 'review'])
  const fileset = config.phases.default.checks.find((c) => c.name === 'fileset')
  const ownership = config.phases.default.checks.find((c) => c.name === 'ownership')
  assert.equal(fileset.kind, 'fileset')
  assert.notEqual(fileset.optional, true)
  assert.equal(ownership.kind, 'ownership')
  assert.notEqual(ownership.optional, true)
})

test('inferGateConfig orders typecheck, lint, test, build', () => {
  const config = inferGateConfig({ scripts: { build: 'b', lint: 'l', typecheck: 't', test: 'x' } })
  const names = config.phases.default.checks.filter((c) => c.kind === 'command').map((c) => c.name)
  assert.deepEqual(names, ['typecheck', 'lint', 'test', 'build'])
})

test('inferGateConfig always appends the review agent check', () => {
  const config = inferGateConfig({})
  const review = config.phases.default.checks.at(-1)
  assert.equal(review.kind, 'agent')
  assert.equal(review.agent, 'tm-reviewer')
  assert.deepEqual(review.blockOn, ['high'])
})

test('inferGateConfig sets a maxParallel default', () => {
  assert.equal(typeof inferGateConfig({}).maxParallel, 'number')
})

test('checksForPhase prefers a named phase over default', () => {
  const config = {
    phases: {
      default: { checks: [{ name: 'a', kind: 'command' }] },
      integration: { checks: [{ name: 'b', kind: 'command' }] },
    },
  }
  assert.equal(checksForPhase(config, 'integration')[0].name, 'b')
  assert.equal(checksForPhase(config, 'phase-2')[0].name, 'a')
})

test('checksForPhase returns only the injected enforcement checks when nothing is configured', () => {
  assert.deepEqual(checksForPhase({ phases: {} }, 'default').map((c) => [c.name, c.kind, c.injected]), [
    ['fileset', 'fileset', true],
    ['ownership', 'ownership', true],
  ])
})

test('inferGateConfig emits fixRounds: 2 on the default phase', () => {
  const config = inferGateConfig({ scripts: { test: 'node --test' } })
  assert.equal(config.phases.default.fixRounds, 2)
})

test('fixRoundsForPhase returns a named phase explicit value', () => {
  const config = {
    phases: {
      default: { fixRounds: 2, checks: [] },
      integration: { fixRounds: 5, checks: [] },
    },
  }
  assert.equal(fixRoundsForPhase(config, 'integration'), 5)
})

test('fixRoundsForPhase falls back to the default phase value for an unknown phase name', () => {
  const config = {
    phases: {
      default: { fixRounds: 5, checks: [] },
    },
  }
  assert.equal(fixRoundsForPhase(config, 'phase-2'), 5)
})

test('fixRoundsForPhase returns 2 when no fixRounds is set anywhere, and for null', () => {
  const config = { phases: { default: { checks: [] } } }
  assert.equal(fixRoundsForPhase(config, 'default'), 2)
  assert.equal(fixRoundsForPhase(config, 'unknown'), 2)
  assert.equal(fixRoundsForPhase(null, 'default'), 2)
})

test('fixRoundsForPhase falls back key-by-key when a named phase omits fixRounds', () => {
  const config = {
    phases: {
      default: { fixRounds: 5, checks: [{ name: 'test', kind: 'command', run: 'npm test' }] },
      integration: { checks: [{ name: 'test', kind: 'command', run: 'npm test' }] },
    },
  }
  assert.equal(fixRoundsForPhase(config, 'integration'), 5)
})

test('fixRoundsForPhase rejects a non-integer fixRounds and falls back to the default phase', () => {
  const withDefault = (value) => ({
    phases: { default: { fixRounds: 3, checks: [] }, integration: { fixRounds: value, checks: [] } },
  })
  assert.equal(fixRoundsForPhase(withDefault('many'), 'integration'), 3)
  assert.equal(fixRoundsForPhase(withDefault(-1), 'integration'), 3)
  assert.equal(fixRoundsForPhase(withDefault(1.5), 'integration'), 3)
})

test('fixRoundsForPhase rejects a non-integer default fixRounds and falls back to 2', () => {
  const only = (value) => ({ phases: { default: { fixRounds: value, checks: [] } } })
  assert.equal(fixRoundsForPhase(only('many'), 'default'), 2)
  assert.equal(fixRoundsForPhase(only(-1), 'default'), 2)
  assert.equal(fixRoundsForPhase(only(1.5), 'default'), 2)
  assert.equal(fixRoundsForPhase(only(null), 'default'), 2)
})

test('fixRoundsForPhase accepts zero as an explicit no-retry budget', () => {
  const config = { phases: { default: { fixRounds: 0, checks: [] } } }
  assert.equal(fixRoundsForPhase(config, 'default'), 0)
})

test('previewLinks returns the declared link list', () => {
  assert.deepEqual(previewLinks({ preview: { link: ['node_modules'] } }), ['node_modules'])
})

test('previewLinks returns [] when there is nothing to link', () => {
  assert.deepEqual(previewLinks({}), [])
  assert.deepEqual(previewLinks({ preview: {} }), [])
  assert.deepEqual(previewLinks({ preview: { link: null } }), [])
  assert.deepEqual(previewLinks(null), [])
})

test('previewLinks returns [] when link is not an array', () => {
  assert.deepEqual(previewLinks({ preview: { link: 'node_modules' } }), [])
})

test('checksForPhase keeps an agent check that already has its own lens untouched', () => {
  const check = { name: 'review', kind: 'agent', agent: 'tm-reviewer', lens: ['tests'] }
  const config = { lens: ['correctness'], phases: { default: { checks: [check] } } }
  const [result] = checksForPhase(config, 'default')
  assert.equal(result, check)
  assert.deepEqual(result.lens, ['tests'])
})

test('checksForPhase gives an agent check with no lens the manifest top-level lens', () => {
  const check = { name: 'review', kind: 'agent', agent: 'tm-reviewer' }
  const config = { lens: ['correctness'], phases: { default: { checks: [check] } } }
  const [result] = checksForPhase(config, 'default')
  assert.deepEqual(result.lens, ['correctness'])
})

test('checksForPhase falls back to DEFAULT_LENS when neither the check nor the manifest has a lens', () => {
  const check = { name: 'review', kind: 'agent', agent: 'tm-reviewer' }
  const config = { phases: { default: { checks: [check] } } }
  const [result] = checksForPhase(config, 'default')
  assert.deepEqual(result.lens, ['correctness', 'security', 'tests'])
})

test('checksForPhase returns a command check unchanged, same object identity', () => {
  const check = { name: 'test', kind: 'command', run: 'npm test' }
  const config = { lens: ['correctness'], phases: { default: { checks: [check] } } }
  const [result] = checksForPhase(config, 'default')
  assert.equal(result, check)
})

test('checksForPhase falls back to DEFAULT_LENS when the top-level lens is empty', () => {
  const check = { name: 'review', kind: 'agent', agent: 'tm-reviewer' }
  const config = { lens: [], phases: { default: { checks: [check] } } }
  const [result] = checksForPhase(config, 'default')
  assert.deepEqual(result.lens, ['correctness', 'security', 'tests'])
})

test('inferGateConfig emits preview.link with node_modules when given a package', () => {
  const config = inferGateConfig({ scripts: { test: 'node --test' } })
  assert.deepEqual(config.preview, { link: ['node_modules'] })
})

test('inferGateConfig emits no preview key when given no package', () => {
  assert.equal(inferGateConfig(null).preview, undefined)
  assert.equal(inferGateConfig(undefined).preview, undefined)
})

// --- protected paths and implicit enforcement checks (docs/specs/2026-09-26-protected-paths-design.md)

test('protectedPaths always holds the manifest under both names and adds the manifest key, normalised', () => {
  assert.deepEqual(protectedPaths({}), ['fleetmates.gate.json', 'teammates.gate.json'])
  assert.deepEqual(
    protectedPaths({ protected: ['package.json', './package.json', 'tests\\conftest.py', 'fleetmates.gate.json'] }),
    ['fleetmates.gate.json', 'teammates.gate.json', 'package.json', 'tests/conftest.py'],
  )
})

test('checksForPhase injects fileset and ownership after the declared checks, never duplicating one', () => {
  const only = (checks) => ({ phases: { default: { checks } } })
  const cmd = { name: 'test', kind: 'command', run: 'x' }
  assert.deepEqual(checksForPhase(only([cmd]), 'default').map((c) => c.name), ['test', 'fileset', 'ownership'])
  const both = checksForPhase(only([{ name: 'fileset', kind: 'fileset' }, cmd, { name: 'own', kind: 'ownership' }]), 'default')
  assert.deepEqual(both.map((c) => c.name), ['fileset', 'test', 'own'])
  assert.ok(both.every((c) => c.injected === undefined))
  const one = checksForPhase(only([{ name: 'fs', kind: 'fileset' }]), 'default')
  assert.deepEqual(one.map((c) => [c.name, c.injected]), [['fs', undefined], ['ownership', true]])
})

test('an injected check whose name is taken by another kind gets a distinct name', () => {
  const checks = checksForPhase({ phases: { default: { checks: [{ name: 'ownership', kind: 'command', run: 'x' }] } } }, 'default')
  assert.deepEqual(checks.map((c) => [c.name, c.kind]), [['ownership', 'command'], ['fileset', 'fileset'], ['ownership:injected', 'ownership']])
})

test('an enforcement check carries the protected set from the top-level key, never its own', () => {
  const config = {
    protected: ['package.json'],
    phases: { default: { checks: [{ name: 'fileset', kind: 'fileset', protected: [] }] } },
  }
  for (const check of checksForPhase(config, 'default')) {
    assert.deepEqual(check.protected, ['fleetmates.gate.json', 'teammates.gate.json', 'package.json'], check.name)
  }
})
