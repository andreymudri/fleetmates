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
  reviewScope,
  checksForRun,
  hasRunEntry,
  reviewLenses,
  DEFAULT_REVIEW_SCOPE,
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
  assert.deepEqual(protectedPaths({}), ['fleetmates.gate.json', 'teammates.gate.json', 'fleetmates.flaky.json'])
  assert.deepEqual(
    protectedPaths({ protected: ['package.json', './package.json', 'tests\\conftest.py', 'fleetmates.gate.json'] }),
    ['fleetmates.gate.json', 'teammates.gate.json', 'fleetmates.flaky.json', 'package.json', 'tests/conftest.py'],
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
    assert.deepEqual(check.protected, ['fleetmates.gate.json', 'teammates.gate.json', 'fleetmates.flaky.json', 'package.json'], check.name)
  }
})

test('a declared entry cannot mark itself injected: the mark is checksForPhase\'s own', () => {
  const checks = checksForPhase({ phases: { default: { checks: [{ name: 'x\u001b[2K', kind: 'command', run: 'y', injected: true }] } } }, 'default')
  assert.equal(checks[0].injected, undefined)
  assert.deepEqual(checks.filter((c) => c.injected).map((c) => c.name), ['fileset', 'ownership'])
})

test('an injected check never shares a name with a declared one, whatever names are declared', () => {
  const checks = checksForPhase({ phases: { default: { checks: [
    { name: 'fileset', kind: 'command', run: 'x' },
    { name: 'fileset:injected', kind: 'agent' },
  ] } } }, 'default')
  const names = checks.map((c) => c.name)
  assert.equal(new Set(names).size, names.length, JSON.stringify(names))
  assert.ok(checks.some((c) => c.kind === 'fileset' && c.injected))
})

test('the inferred test check carries the runner\'s refusal of a focused test, and a report for node --test', () => {
  const test = (script, platform = 'linux') => inferGateConfig({ scripts: { test: script } }, { platform }).phases.default.checks.find((c) => c.name === 'test')
  const node = test('node --test tests/*.test.mjs')
  // cmd.exe expands neither `PATH=…` nor `$FLEETMATES_REPORT_DIR`: win32 gets the plain check.
  assert.deepEqual(test('node --test tests/*.test.mjs', 'win32'), { name: 'test', kind: 'command', run: 'npm run test' })
  assert.deepEqual(node.report, { format: 'junit', dir: true })
  assert.equal(node.run, 'PATH="$PWD/node_modules/.bin:$PATH" node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="$FLEETMATES_REPORT_DIR/node.xml" tests/*.test.mjs')
  // `--test` as a whole flag, written right after `node`: `--test-concurrency=1` or `--test-only`
  // is not `--test` followed by text, and a script shaped otherwise gets the plain check.
  for (const script of ['node --test-concurrency=1 --test tests/', 'node --test-only tests/']) {
    assert.deepEqual(test(script), { name: 'test', kind: 'command', run: 'npm run test' }, script)
  }
  assert.match(test('node --test --test-concurrency=1 tests/').run, /node --test --test-reporter=spec .*node\.xml" --test-concurrency=1 tests\/$/)
  // A script naming its own reporter, or carrying shell syntax, gets no report: added reporters
  // would outnumber destinations and node refuses to start; rewriting shell is not this code's job.
  assert.deepEqual(test('node --test --test-reporter=./r.mjs tests/*.test.mjs'), { name: 'test', kind: 'command', run: 'npm run test' })
  assert.deepEqual(test('node --test tests/ && echo done'), { name: 'test', kind: 'command', run: 'npm run test' })
  assert.deepEqual(test('vitest run'), { name: 'test', kind: 'command', run: 'npm run test -- --allowOnly=false' })
  assert.deepEqual(test('mocha'), { name: 'test', kind: 'command', run: 'npm run test -- --forbid-only' })
  assert.deepEqual(test('jest'), { name: 'test', kind: 'command', run: 'npm run test' })
})

test('checksForPhase hands a report-bearing command check the top-level skips, overwriting its own', () => {
  const config = {
    skips: [{ file: 'tests/db.py', reason: 'no db' }],
    phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'x', report: { format: 'junit', dir: true }, skips: ['forged.py'] }, { name: 'lint', kind: 'command', run: 'y' }] } },
  }
  const checks = checksForPhase(config, 'default')
  assert.deepEqual(checks.find((c) => c.name === 'test').skips, ['tests/db.py'])
  assert.equal(checks.find((c) => c.name === 'lint').skips, undefined)
})

// --- review scope (docs/specs/2026-11-06-cost-cuts-design.md, section 2) ---------------------

const REVIEW = { name: 'review', kind: 'agent', agent: 'tm-reviewer' }
const runReview = { ...REVIEW, scope: 'run' }
const phaseReview = { ...REVIEW, scope: 'phase' }

test('the default review scope stays phase until the run review is wired end to end', () => {
  assert.equal(DEFAULT_REVIEW_SCOPE, 'phase')
})

test('reviewScope returns a declared phase or run, and the default for anything else', () => {
  assert.equal(reviewScope(runReview), 'run')
  assert.equal(reviewScope(phaseReview), 'phase')
  for (const scope of [undefined, null, 'RUN', 'all', 1, ['run']]) {
    assert.equal(reviewScope({ ...REVIEW, scope }), DEFAULT_REVIEW_SCOPE, JSON.stringify(scope))
  }
  assert.equal(reviewScope(null), DEFAULT_REVIEW_SCOPE)
})

test('checksForPhase leaves out a run-scoped agent check and keeps a phase-scoped one', () => {
  const cmd = { name: 'test', kind: 'command', run: 'x' }
  const dropped = checksForPhase({ phases: { default: { checks: [cmd, runReview] } } }, '1')
  assert.deepEqual(dropped.map((c) => c.name), ['test', 'fileset', 'ownership'])
  const kept = checksForPhase({ phases: { default: { checks: [cmd, phaseReview] } } }, '1')
  assert.deepEqual(kept.map((c) => c.name), ['test', 'review', 'fileset', 'ownership'])
})

test('checksForPhase keeps an unscoped agent check while the default scope is phase', () => {
  const checks = checksForPhase({ phases: { default: { checks: [REVIEW] } } }, '1')
  assert.deepEqual(checks.map((c) => c.name), ['review', 'fileset', 'ownership'])
})

test('checksForRun takes the default block\'s command checks and run-scoped reviews, plus fileset-run', () => {
  const config = {
    lens: ['correctness'],
    phases: { default: { checks: [
      { name: 'test', kind: 'command', run: 'x' },
      { name: 'fileset', kind: 'fileset' },
      { name: 'ownership', kind: 'ownership' },
      { name: 'tdd', kind: 'tdd' },
      { ...phaseReview, name: 'phase-review' },
      runReview,
    ] } },
  }
  const checks = checksForRun(config)
  assert.deepEqual(checks.map((c) => [c.name, c.kind]), [['test', 'command'], ['review', 'agent'], ['fileset-run', 'fileset-run']])
  assert.deepEqual(checks[1].lens, ['correctness'])
  assert.equal(checks[2].injected, true)
  assert.deepEqual(checks[2].protected, protectedPaths(config))
})

test('checksForRun also carries a run-scoped review declared on a named phase, once per name', () => {
  const config = { phases: {
    default: { checks: [{ ...runReview, lens: ['tests'] }] },
    10: { checks: [{ ...runReview, lens: ['security'] }, { ...runReview, name: 'docs-review' }] },
  } }
  const checks = checksForRun(config)
  assert.deepEqual(checks.map((c) => c.name), ['review', 'docs-review', 'fileset-run'])
  assert.deepEqual(checks[0].lens, ['tests'])
})

test('checksForRun uses phases.run when declared, with the same lens and protected rules', () => {
  const config = {
    protected: ['package.json'],
    phases: {
      default: { checks: [{ name: 'test', kind: 'command', run: 'x' }, runReview] },
      run: { checks: [{ name: 'smoke', kind: 'command', run: 'y' }, REVIEW, { name: 'fs', kind: 'fileset-run', protected: [] }] },
    },
  }
  const checks = checksForRun(config)
  assert.deepEqual(checks.map((c) => c.name), ['smoke', 'review', 'fs'])
  assert.deepEqual(checks[1].lens, ['correctness', 'security', 'tests'])
  assert.deepEqual(checks[2].protected, protectedPaths(config))
  assert.equal(checks[2].injected, undefined)
})

test('checksForRun injects fileset-run into a declared phases.run that lacks it, under a free name', () => {
  const checks = checksForRun({ phases: { run: { checks: [{ name: 'fileset-run', kind: 'command', run: 'x' }] } } })
  assert.deepEqual(checks.map((c) => [c.name, c.kind, c.injected]), [['fileset-run', 'command', undefined], ['fileset-run:injected', 'fileset-run', true]])
})

test('checksForRun hands a report-bearing command check the top-level skips', () => {
  const config = {
    skips: [{ file: 'tests/db.py', reason: 'no db' }],
    phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'x', report: { format: 'junit', dir: true }, skips: ['forged.py'] }] } },
  }
  assert.deepEqual(checksForRun(config).find((c) => c.name === 'test').skips, ['tests/db.py'])
})

test('hasRunEntry is true only for a run-scoped review or a declared phases.run', () => {
  assert.equal(hasRunEntry({ phases: { default: { checks: [REVIEW, phaseReview] } } }), false)
  assert.equal(hasRunEntry({ phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'x', scope: 'run' }] } } }), false)
  assert.equal(hasRunEntry({}), false)
  assert.equal(hasRunEntry(null), false)
  assert.equal(hasRunEntry({ phases: { default: { checks: [runReview] } } }), true)
  assert.equal(hasRunEntry({ phases: { 2: { checks: [runReview] } } }), true)
  assert.equal(hasRunEntry({ phases: { run: { checks: [] } } }), true)
})

test('reviewLenses resolves the run review\'s lenses for the phase name "run"', () => {
  const config = { lens: ['claims'], phases: { default: { checks: [runReview] } } }
  assert.deepEqual(reviewLenses(config, 'run', { oses: new Set(['windows']) }), ['claims', 'portability'])
  assert.deepEqual(reviewLenses(config, '1', undefined), [])
  assert.deepEqual(reviewLenses({ phases: { default: { checks: [phaseReview] } } }, 'run', undefined), [])
})
