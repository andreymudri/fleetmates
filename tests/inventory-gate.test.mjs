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
