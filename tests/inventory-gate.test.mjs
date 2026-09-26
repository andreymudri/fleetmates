// The test inventory end to end: a real repository, a real `node --test` suite writing JUnit, and
// the real `gate` command. See docs/specs/2026-09-26-test-inventory-design.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCli } from '../scripts/cli.mjs'
import { decideFix } from '../scripts/fix-loop.mjs'

// `env -u NODE_TEST_CONTEXT`: this file runs under `node --test`, and a child `node --test`
// inheriting that variable reports to the parent runner instead of writing its reporter's file.
const NODE_TEST = 'env -u NODE_TEST_CONTEXT node --test'
const SUITE = `${NODE_TEST} --test-reporter=junit --test-reporter-destination="$FLEETMATES_REPORT_DIR/node.xml" tests/*.test.mjs`

function manifest({ report = { format: 'junit', dir: true }, run = SUITE, skips } = {}) {
  return {
    ...(skips ? { skips } : {}),
    phases: { default: { checks: [{ name: 'test', kind: 'command', run, report }] } },
  }
}

function planWith(t1Lines) {
  return ['### Task 1: A', '', '**Files:**', ...t1Lines, '', '### Task 2: B', '', '**Files:**', '- Create: `b.mjs`', '', '**Depends:** T1', ''].join('\n')
}

const BASE_TESTS = `import { test } from 'node:test'
test('x', () => {})
test('y', () => {})
test('z', { skip: 'no db' }, () => {})
`

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// `main` carries the plan, the manifest and the suite; the repo is left on `run-branch`, and T1's
// branch holds `edit`'s changes.
async function withRun({ plan, gate = manifest(), tests = BASE_TESTS, extra = {} }, edit, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-inv-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 't@e'])
    git(root, ['config', 'user.name', 'T'])
    await mkdir(path.join(root, 'tests'))
    await writeFile(path.join(root, 'tests', 'a.test.mjs'), tests)
    await writeFile(path.join(root, 'plan.md'), plan)
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify(gate))
    await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
    for (const [rel, content] of Object.entries(extra)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await writeFile(path.join(root, rel), content)
    }
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'base'])
    git(root, ['checkout', '--quiet', '-b', 'run-branch'])
    await quiet(() => runCli(['init-run', path.join(root, 'plan.md'), '--run', 'r1', '--root', root], { out: () => {} }))
    git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T1'])
    await edit(root)
    git(root, ['add', '-A'])
    git(root, ['commit', '--quiet', '--allow-empty', '-m', 'T1'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function quiet(fn) { return fn() }

async function gate(root) {
  const lines = []
  const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], { out: (t) => lines.push(t) })
  const doc = JSON.parse(lines.join('\n'))
  if (process.env.INV_DEBUG) console.error(JSON.stringify(doc.results, null, 1))
  return { code, doc, inventory: doc.results.find((r) => r.kind === 'inventory') }
}

const T1 = ['- Create: `a.mjs`', '- Modify: `tests/a.test.mjs`']
const write = (rel, content) => (root) => writeFile(path.join(root, rel), content)

test('deleting a test that ran fails the inventory, naming it and the task that changed its file', async () => {
  await withRun({ plan: planWith(T1) }, write('tests/a.test.mjs', BASE_TESTS.replace("test('y', () => {})\n", '')), async (root) => {
    const { code, inventory } = await gate(root)
    assert.equal(code, 1)
    assert.equal(inventory.name, 'test:inventory')
    assert.equal(inventory.status, 'fail', inventory.output)
    assert.match(inventory.output, /^drop: tests\/a\.test\.mjs > test > y — ran at the baseline, absent now \(changed by T1\)$/m)
    assert.match(inventory.output, /"- Test \(drops\)"/)
  })
})

test('the same drop passes when a phase task marks the file (drops)', async () => {
  const plan = planWith(['- Create: `a.mjs`', '- Test (drops): `tests/a.test.mjs`'])
  await withRun({ plan }, write('tests/a.test.mjs', BASE_TESTS.replace("test('y', () => {})\n", '')), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'pass', inventory.output)
  })
})

test('skipping a test that ran is a drop', async () => {
  await withRun({ plan: planWith(T1) }, write('tests/a.test.mjs', BASE_TESTS.replace("test('y', () => {})", "test('y', { skip: true }, () => {})")), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail', inventory.output)
    assert.match(inventory.output, /drop: tests\/a\.test\.mjs > test > y — ran at the baseline, skipped now/)
  })
})

test('a renamed test reads as a drop', async () => {
  await withRun({ plan: planWith(T1) }, write('tests/a.test.mjs', BASE_TESTS.replace("test('y'", "test('y2'")), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail', inventory.output)
    assert.match(inventory.output, /drop: tests\/a\.test\.mjs > test > y — /)
    assert.doesNotMatch(inventory.output, /new skip/)
  })
})

const BORN_SKIPPED = "import { test } from 'node:test'\ntest('needs db', { skip: 'no DSN' }, () => {})\n"

test('a new test born skipped fails as a new skip', async () => {
  await withRun({ plan: planWith(['- Create: `tests/db.test.mjs`']) }, write('tests/db.test.mjs', BORN_SKIPPED), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail', inventory.output)
    assert.match(inventory.output, /^new skip: tests\/db\.test\.mjs > test > needs db \(changed by T1\)$/m)
    assert.match(inventory.output, /"skips"/)
  })
})

test('the same new skip passes when the manifest declares its unit in skips', async () => {
  const gateManifest = manifest({ skips: [{ file: 'tests/db.test.mjs', reason: 'no database in the gate' }] })
  await withRun({ plan: planWith(['- Create: `tests/db.test.mjs`']), gate: gateManifest }, write('tests/db.test.mjs', BORN_SKIPPED), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'pass', inventory.output)
  })
})

test('a standing skip is reported on a pass, and a stale skips entry is named', async () => {
  const gateManifest = manifest({ skips: [{ file: 'tests/gone.test.mjs', reason: 'removed long ago' }] })
  await withRun({ plan: planWith(['- Create: `a.mjs`']), gate: gateManifest }, write('a.mjs', 'export {}\n'), async (root) => {
    const { code, inventory } = await gate(root)
    assert.equal(code, 0)
    assert.equal(inventory.status, 'pass')
    assert.match(inventory.output, /^standing skip: tests\/a\.test\.mjs > test > z$/m)
    assert.match(inventory.output, /^stale skips entry: tests\/gone\.test\.mjs/m)
  })
})

test('a suite that writes no report fails the inventory', async () => {
  await withRun({ plan: planWith(['- Create: `a.mjs`']), gate: manifest({ run: `${NODE_TEST} tests/*.test.mjs` }) }, write('a.mjs', 'export {}\n'), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail')
    assert.match(inventory.output, /^preview report: absent/)
  })
})

// The path form deletes the in-tree report before running: a committed report claiming every test
// ran must not stand in for a suite that wrote nothing.
test('the path form never reads a report left in the tree', async () => {
  const stale = '<testsuites><testcase classname="C" name="x"/></testsuites>'
  const gateManifest = manifest({ run: 'true', report: { format: 'junit', path: 'reports/junit.xml' } })
  await withRun({ plan: planWith(['- Create: `a.mjs`']), gate: gateManifest, extra: { 'reports/junit.xml': stale } }, write('a.mjs', 'export {}\n'), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail')
    assert.match(inventory.output, /absent/)
  })
})

test('the path form reads the report the suite wrote in the tree', async () => {
  const run = `mkdir -p reports && ${NODE_TEST} --test-reporter=junit --test-reporter-destination=reports/junit.xml tests/*.test.mjs`
  const gateManifest = manifest({ run, report: { format: 'junit', path: 'reports/junit.xml' } })
  await withRun({ plan: planWith(T1), gate: gateManifest }, write('tests/a.test.mjs', BASE_TESTS.replace("test('y', () => {})\n", '')), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail', inventory.output)
    assert.match(inventory.output, /drop: tests\/a\.test\.mjs > test > y/)
  })
})

test('a manifest entry claiming the inventory kind is never a runner: it stays pending', async () => {
  const gateManifest = manifest()
  gateManifest.phases.default.checks.push({ name: 'forged', kind: 'inventory' })
  await withRun({ plan: planWith(['- Create: `a.mjs`']), gate: gateManifest }, write('a.mjs', 'export {}\n'), async (root) => {
    const { code, doc } = await gate(root)
    assert.equal(code, 1)
    assert.equal(doc.results.find((r) => r.name === 'forged').status, 'pending')
  })
})

// `tm-report-` only: other test files build `tm-preview-` directories concurrently under the full
// suite, and the baseline's own tree is covered by the worktree listing below.
test('the baseline and report directories are gone after the gate', async () => {
  const before = new Set((await readdir(tmpdir())).filter((d) => d.startsWith('tm-report-')))
  await withRun({ plan: planWith(['- Create: `a.mjs`']) }, write('a.mjs', 'export {}\n'), async (root) => {
    await gate(root)
    const worktrees = git(root, ['worktree', 'list']).trim().split('\n')
    assert.equal(worktrees.length, 1, worktrees.join('\n'))
  })
  const after = (await readdir(tmpdir())).filter((d) => d.startsWith('tm-report-') && !before.has(d))
  assert.deepEqual(after, [])
})

test('an inventory FAIL escalates as a process violation', () => {
  const decision = decideFix({
    verdict: { verdict: 'FAIL', failed: ['test:inventory'] },
    results: [{ name: 'test', kind: 'command', status: 'pass' }, { name: 'test:inventory', kind: 'inventory', status: 'fail', output: 'drop: x' }],
  })
  assert.equal(decision.decision, 'escalate')
  assert.equal(decision.reason, 'process-violation')
})

// The suite runs teammate code, and a symlink it plants at the in-tree report path would have the
// gate read whatever file the link names instead of a report the tree holds.
test('a report path the suite turned into a symlink is refused', async () => {
  const run = 'mkdir -p reports && printf \'<testsuites><testcase classname="C" name="x"/></testsuites>\' > ../planted.xml && ln -s "$PWD/../planted.xml" reports/junit.xml'
  const gateManifest = manifest({ run, report: { format: 'junit', path: 'reports/junit.xml' } })
  await withRun({ plan: planWith(['- Create: `a.mjs`']), gate: gateManifest }, write('a.mjs', 'export {}\n'), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail')
    assert.match(inventory.output, /symbolic link/)
  })
})

// --- CLI: the early check, finish, and the suggested manifest --------------------------------

test('complete reports the inventory as skipped: the early check runs no baseline', async () => {
  await withRun({ plan: planWith(T1) }, write('tests/a.test.mjs', BASE_TESTS.replace("test('y', () => {})\n", '')), async (root) => {
    const lines = []
    await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], { out: (t) => lines.push(t) })
    const text = lines.join('\n')
    assert.match(text, /test:inventory/)
    assert.match(text, /early check does not run the baseline/)
    assert.doesNotMatch(text, /drop: /)
  })
})

test('finish names the standing skips at the last gate', async () => {
  await withRun({ plan: planWith(['- Create: `a.mjs`']) }, write('a.mjs', 'export {}\n'), async (root) => {
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'fleetmates/r1/T1'])
    git(root, ['checkout', '--quiet', '-b', 'fleetmates/r1/T2'])
    await writeFile(path.join(root, 'b.mjs'), 'export {}\n')
    git(root, ['add', 'b.mjs'])
    git(root, ['commit', '--quiet', '-m', 'T2'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    const lines = []
    await runCli(['finish', '--run', 'r1', '--plan', 'plan.md', '--root', root], { out: (t) => lines.push(t) })
    assert.match(lines.join('\n'), /^standing skips at the last gate: 1 \(units: tests\/a\.test\.mjs\)$/m)
  })
})

// The suggested command is run exactly as inferred, so it is measured here rather than trusted:
// reporter flags appended after node's positional file pattern never reach the test runner.
test('the inferred node --test check writes a report the inventory reads', async () => {
  const { inferGateConfig } = await import('../scripts/gate-config.mjs')
  const inferred = inferGateConfig({ scripts: { test: 'node --test tests/*.test.mjs' } }).phases.default.checks.find((c) => c.name === 'test')
  assert.ok(inferred.report, JSON.stringify(inferred))
  const gateManifest = { phases: { default: { checks: [inferred] } } }
  const context = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  try {
    await withRun({ plan: planWith(T1), gate: gateManifest, extra: { 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test tests/*.test.mjs' } }) } },
      write('tests/a.test.mjs', BASE_TESTS.replace("test('y', () => {})\n", '')), async (root) => {
        const { inventory } = await gate(root)
        assert.equal(inventory.status, 'fail', inventory.output)
        assert.match(inventory.output, /drop: tests\/a\.test\.mjs > test > y/)
      })
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context
  }
})

// --- adversarial ------------------------------------------------------------------------------

test('a teammate that adds .skip to an existing test fails the gate, and fix escalates it', async () => {
  const skipped = BASE_TESTS.replace("test('x', () => {})", "test.skip('x', () => {})")
  await withRun({ plan: planWith(T1) }, write('tests/a.test.mjs', skipped), async (root) => {
    const { code, doc, inventory } = await gate(root)
    assert.equal(code, 1)
    assert.match(inventory.output, /drop: tests\/a\.test\.mjs > test > x — ran at the baseline, skipped now/)
    const decision = decideFix(doc, 1, [{ id: 'T1', phase: 1 }], 0, {})
    assert.equal(decision.decision, 'escalate')
    assert.equal(decision.reason, 'process-violation')
  })
})

// `report` lives in the manifest, which spec 1 protects: a task removing it without a (protected)
// marking fails fileset, even when it declares the manifest.
test('removing the report contract from the manifest without (protected) fails fileset', async () => {
  const plan = planWith(['- Create: `a.mjs`', '- Modify: `fleetmates.gate.json`'])
  const withoutReport = manifest()
  delete withoutReport.phases.default.checks[0].report
  await withRun({ plan }, write('fleetmates.gate.json', JSON.stringify(withoutReport)), async (root) => {
    const { code, doc } = await gate(root)
    assert.equal(code, 1)
    const fileset = doc.results.find((r) => r.kind === 'fileset')
    assert.equal(fileset.status, 'fail')
    assert.match(fileset.output, /T1: protected — fleetmates\.gate\.json/)
  })
})

// LIMIT (spec, "Out of scope"): a loosened assertion keeps the test running, so the run count does
// not move and the inventory passes. The `tests` review lens is what judges this.
test('LIMIT: a loosened assertion passes the inventory', async () => {
  const strict = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('sum', () => { assert.equal(1 + 1, 2) })\n"
  const loose = strict.replace('assert.equal(1 + 1, 2)', 'assert.ok(1 + 1)')
  await withRun({ plan: planWith(T1), tests: strict }, write('tests/a.test.mjs', loose), async (root) => {
    const { code, inventory } = await gate(root)
    assert.equal(code, 0)
    assert.equal(inventory.status, 'pass')
  })
})

// LIMIT (spec, "Out of scope"): the report is written by a process running teammate code. A test
// file that drops its own report into $FLEETMATES_REPORT_DIR — every *.xml there is merged — can
// claim a deleted test still ran.
test('LIMIT: a test file that writes its own report controls the inventory', async () => {
  const forger = `import { writeFileSync } from 'node:fs'
import { test } from 'node:test'
writeFileSync(process.env.FLEETMATES_REPORT_DIR + '/forged.xml', '<testsuites><testcase classname="test" name="y" file="' + process.cwd() + '/tests/a.test.mjs"/></testsuites>')
test('innocent', () => {})
`
  const plan = planWith(['- Create: `a.mjs`', '- Modify: `tests/a.test.mjs`', '- Create: `tests/forger.test.mjs`'])
  await withRun({ plan }, async (root) => {
    await writeFile(path.join(root, 'tests', 'a.test.mjs'), BASE_TESTS.replace("test('y', () => {})\n", ''))
    await writeFile(path.join(root, 'tests', 'forger.test.mjs'), forger)
  }, async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'pass', inventory.output)
  })
})

// Review round: a committed `reports -> ../victim` made the pre-run delete reach outside the tree.
test('a report path through a symlinked directory is refused and deletes nothing outside the tree', async () => {
  const victimRoot = await mkdtemp(path.join(tmpdir(), 'tm-inv-victim-'))
  try {
    await writeFile(path.join(victimRoot, 'junit.xml'), 'keep me')
    const gateManifest = manifest({ run: 'true', report: { format: 'junit', path: 'reports/junit.xml' } })
    await withRun({ plan: planWith(['- Create: `a.mjs`', '- Create: `reports`']), gate: gateManifest }, async (root) => {
      const { symlink } = await import('node:fs/promises')
      await symlink(victimRoot, path.join(root, 'reports'))
    }, async (root) => {
      const { inventory } = await gate(root)
      assert.equal(inventory.status, 'fail')
      assert.match(inventory.output, /symbolic link/)
    })
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(path.join(victimRoot, 'junit.xml'), 'utf8'), 'keep me')
  } finally {
    await rm(victimRoot, { recursive: true, force: true })
  }
})

// The in-tree form deletes before it runs, so it never runs outside a worktree the gate owns.
test('the in-tree report is never deleted in a tree the gate does not own', async () => {
  const { runCommandCheck } = await import('../scripts/gate-runner.mjs')
  const { readFile } = await import('node:fs/promises')
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-inv-own-'))
  try {
    await mkdir(path.join(dir, 'reports'))
    await writeFile(path.join(dir, 'reports', 'junit.xml'), 'a person\'s file')
    const check = { name: 'test', kind: 'command', run: 'true', report: { format: 'junit', path: 'reports/junit.xml' } }
    const result = await runCommandCheck(check, { cwd: dir, previewDir: null })
    assert.match(result.report.error, /worktree the gate owns/)
    assert.equal(await readFile(path.join(dir, 'reports', 'junit.xml'), 'utf8'), 'a person\'s file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- review round: fail-closed baseline, phase-scoped authorisation, every skip path ----------

// The suite writes a report only where T1's file exists: the preview has one, the baseline not.
test('a baseline run that writes no report fails the inventory, never passes it', async () => {
  const gateManifest = manifest({ run: `if [ -f a.mjs ]; then ${SUITE}; fi` })
  await withRun({ plan: planWith(['- Create: `a.mjs`']), gate: gateManifest }, write('a.mjs', 'export {}\n'), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail')
    assert.match(inventory.output, /^baseline report: absent/)
  })
})

test('a baseline tree that cannot be built fails the inventory', async () => {
  const { runChecks, deriveContext } = await import('../scripts/gate-runner.mjs')
  const { createGit } = await import('../scripts/git.mjs')
  await withRun({ plan: planWith(['- Create: `a.mjs`']) }, write('a.mjs', 'export {}\n'), async (root) => {
    const real = createGit({ cwd: root })
    let adds = 0
    // The preview's worktree is the first add; the baseline's is the second, and it fails.
    const git = Object.assign(Object.create(real), {
      addWorktreeDetached: async (...args) => { adds += 1; if (adds === 2) throw new Error('disk full'); return real.addWorktreeDetached(...args) },
    })
    for (const key of Object.keys(real)) if (key !== 'addWorktreeDetached') git[key] = real[key]
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run-branch', baseBranch: 'main', planPath: 'plan.md' })
    const results = await runChecks(manifest().phases.default.checks, { ...ctx, git, cwd: root })
    const inventory = results.find((r) => r.kind === 'inventory')
    assert.equal(inventory.status, 'fail')
    assert.match(inventory.output, /baseline report: the baseline tree could not be built: disk full/)
  })
})

// Authorisation comes from the tasks of the phase being gated only: a later task marking the same
// file must not approve an earlier phase's drop.
test('a (drops) marking on a task of another phase authorises nothing', async () => {
  const plan = ['### Task 1: A', '', '**Files:**', ...T1, '', '### Task 2: B', '', '**Files:**', '- Test (drops): `tests/a.test.mjs`', '- Create: `b.mjs`', '', '**Depends:** T1', ''].join('\n')
  await withRun({ plan }, write('tests/a.test.mjs', BASE_TESTS.replace("test('y', () => {})\n", '')), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'fail', inventory.output)
    assert.match(inventory.output, /drop: tests\/a\.test\.mjs > test > y/)
  })
})

test('a solo gate reports the inventory as skipped', async () => {
  await withRun({ plan: planWith(['- Create: `a.mjs`']) }, write('a.mjs', 'export {}\n'), async (root) => {
    const lines = []
    await runCli(['gate', '--no-fleet', '--run', 'r1', '--plan', 'plan.md', '--root', root], { out: (t) => lines.push(t) })
    const doc = JSON.parse(lines.filter((l) => !l.startsWith('--no-fleet')).join('\n'))
    const inventory = doc.results.find((r) => r.kind === 'inventory')
    assert.equal(inventory.status, 'skip')
    assert.match(inventory.output, /solo gate/)
  })
})

test('a phase with no branch to merge reports the inventory as skipped', async () => {
  await withRun({ plan: planWith(['- Create: `a.mjs`']) }, write('a.mjs', 'export {}\n'), async (root) => {
    git(root, ['branch', '-D', 'fleetmates/r1/T1'])
    const { inventory } = await gate(root)
    assert.equal(inventory.status, 'skip')
    assert.match(inventory.output, /no phase branches/)
  })
})

test('a phase that does not merge cleanly reports the inventory as skipped', async () => {
  await withRun({ plan: planWith(T1) }, write('tests/a.test.mjs', BASE_TESTS.replace("'x'", "'x from T1'")), async (root) => {
    await writeFile(path.join(root, 'tests', 'a.test.mjs'), BASE_TESTS.replace("'x'", "'x from the run branch'"))
    git(root, ['commit', '--quiet', '-am', 'a conflicting write on the run branch'])
    const { inventory, doc } = await gate(root)
    assert.equal(doc.results.find((r) => r.kind === 'merge').status, 'fail')
    assert.equal(inventory.status, 'skip')
    assert.match(inventory.output, /does not merge cleanly/)
  })
})

test('the inventory output caps each class of line', async () => {
  const many = "import { test } from 'node:test'\n" + Array.from({ length: 60 }, (_, i) => `test('t${i}', () => {})\n`).join('')
  await withRun({ plan: planWith(T1), tests: many }, write('tests/a.test.mjs', "import { test } from 'node:test'\ntest('only', () => {})\n"), async (root) => {
    const { inventory } = await gate(root)
    assert.equal(inventory.output.split('\n').filter((l) => l.startsWith('drop: ')).length, 50)
    assert.match(inventory.output, /^… and 10 more drops$/m)
  })
})

// Review round 2: `x\y` was a separator to the symlink walk and a file name to `rm`, so a committed
// symlink named `x\y` let the pre-run delete reach outside the tree. The delete is built from the
// walked segments, and a backslash is refused outright.
test('a report path with a backslash never reaches rm', async () => {
  const { runCommandCheck } = await import('../scripts/gate-runner.mjs')
  const { symlink, readFile } = await import('node:fs/promises')
  const tree = await mkdtemp(path.join(tmpdir(), 'tm-inv-bs-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'tm-inv-out-'))
  try {
    await writeFile(path.join(outside, 'z'), 'keep me')
    await symlink(outside, path.join(tree, 'x\\y'))
    const check = { name: 'test', kind: 'command', run: 'true', report: { format: 'junit', path: 'x\\y/z' } }
    const result = await runCommandCheck(check, { cwd: tree, previewDir: tree })
    assert.match(result.report.error, /not a plain path/)
    assert.equal(await readFile(path.join(outside, 'z'), 'utf8'), 'keep me')
  } finally {
    await rm(tree, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
