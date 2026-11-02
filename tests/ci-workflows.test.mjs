import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkflows, workflowSummary, ciAdvice } from '../scripts/ci-workflows.mjs'

// One temp project per call, with the given workflow files under .github/workflows.
function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'ci-wf-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (files) {
    const dir = join(root, '.github', 'workflows')
    mkdirSync(dir, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  }
  return root
}

async function one(t, text) {
  const read = await readWorkflows(project(t, { 'ci.yml': text }))
  assert.equal(read.present, true)
  assert.deepEqual(read.skipped, [])
  assert.equal(read.files.length, 1)
  assert.equal(read.files[0].path, '.github/workflows/ci.yml')
  return read.files[0]
}

const job = (runsOn, steps = '      - run: npm test\n') => `jobs:\n  test:\n    runs-on: ${runsOn}\n    steps:\n${steps}`

test('a matrix os list maps every runner label to its OS', async t => {
  const file = await one(t, [
    'on: push',
    'jobs:',
    '  test:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-latest, windows-latest, macos-latest]',
    '    runs-on: ${{ matrix.os }}',
    '    steps:',
    '      - run: npm test',
    '',
  ].join('\n'))
  assert.deepEqual([...file.oses].sort(), ['linux', 'macos', 'windows'])
  const block = await one(t, [
    'on: push',
    'jobs:',
    '  test:',
    '    strategy:',
    '      matrix:',
    '        os:',
    '          - ubuntu-22.04',
    "          - 'windows-2022'   # comment",
    '    runs-on: ${{ matrix.os }}',
    '',
  ].join('\r\n'))
  assert.deepEqual([...block.oses].sort(), ['linux', 'windows'])
})

test('runs-on names one OS', async t => {
  assert.deepEqual([...(await one(t, `on: push\n${job('macos-14')}`)).oses], ['macos'])
  assert.deepEqual([...(await one(t, `on: push\n${job('ubuntu-latest')}`)).oses], ['linux'])
  assert.deepEqual([...(await one(t, `on: push\n${job('[self-hosted, windows]')}`)).oses], ['windows'])
})

test('a push trigger filtered to the default branch is not a branch push', async t => {
  assert.equal((await one(t, `on: { push: { branches: [master] }, pull_request: {} }\n${job('ubuntu-latest')}`)).branchPushes, false)
  assert.equal((await one(t, `on:\n  push:\n    branches:\n      - main\n  pull_request:\n${job('ubuntu-latest')}`)).branchPushes, false)
  assert.equal((await one(t, `on: pull_request\n${job('ubuntu-latest')}`)).branchPushes, false)
  assert.equal((await one(t, `on:\n  push:\n    tags: ['v*']\n${job('ubuntu-latest')}`)).branchPushes, false)
})

test('a push trigger with no branch filter, or branches ** , is a branch push', async t => {
  assert.equal((await one(t, `on: push\n${job('ubuntu-latest')}`)).branchPushes, true)
  assert.equal((await one(t, `on: [push, pull_request]\n${job('ubuntu-latest')}`)).branchPushes, true)
  assert.equal((await one(t, `on:\n  push:\n  pull_request:\n${job('ubuntu-latest')}`)).branchPushes, true)
  assert.equal((await one(t, `on:\n  push:\n    branches: ['**']\n${job('ubuntu-latest')}`)).branchPushes, true)
  assert.equal((await one(t, `on:\n  push:\n    branches:\n      - '**'\n${job('ubuntu-latest')}`)).branchPushes, true)
  assert.equal((await one(t, `"on": { push: { branches: ['**'] } }\n${job('ubuntu-latest')}`)).branchPushes, true)
})

test('a step running the flaky detector is detected, a plain test step is not', async t => {
  assert.equal((await one(t, `on: push\n${job('ubuntu-latest')}`)).usesFlaky, false)
  assert.equal((await one(t, `on: push\n${job('ubuntu-latest', '      - run: node scripts/cli.mjs flaky --report r.json -- npm test\n')}`)).usesFlaky, true)
  assert.equal((await one(t, `on: push\n${job('ubuntu-latest', '      - run: |\n          npx fleetmates flaky -- npm test\n')}`)).usesFlaky, true)
  assert.equal((await one(t, `on: push\n${job('ubuntu-latest', '      # - run: npx fleetmates flaky -- npm test\n      - run: npm test\n')}`)).usesFlaky, false)
})

test('no .github/workflows directory reads as absent and gives no advice', async t => {
  const read = await readWorkflows(project(t, null))
  assert.deepEqual(read, { present: false, files: [], skipped: [] })
  const summary = workflowSummary(read)
  assert.equal(summary.present, false)
  assert.deepEqual(ciAdvice(summary, {}), [])
})

test('a workflow file over 256 KiB is skipped and reported, not parsed', async t => {
  const big = `on: push\n${job('windows-latest')}${'# pad\n'.repeat(50000)}`
  const read = await readWorkflows(project(t, { 'big.yml': big, 'small.yaml': `on: pull_request\n${job('ubuntu-latest')}` }))
  assert.equal(read.present, true)
  assert.deepEqual(read.files.map(f => f.path), ['.github/workflows/small.yaml'])
  assert.equal(read.skipped.length, 1)
  assert.equal(read.skipped[0].path, '.github/workflows/big.yml')
  assert.match(read.skipped[0].reason, /256 KiB/)
  assert.deepEqual([...workflowSummary(read).oses], ['linux'])
})

test('workflowSummary unions the files', async t => {
  const read = await readWorkflows(project(t, {
    'a.yml': `on: pull_request\n${job('ubuntu-latest')}`,
    'b.yml': `on: push\n${job('macos-latest', '      - run: npx fleetmates flaky -- npm test\n')}`,
  }))
  const summary = workflowSummary(read)
  assert.equal(summary.present, true)
  assert.deepEqual([...summary.oses].sort(), ['linux', 'macos'])
  assert.equal(summary.branchPushes, true)
  assert.equal(summary.usesFlaky, true)
})

test('ciAdvice gives the three warnings, and nothing for a workflow set that satisfies all three', () => {
  const bad = { present: true, oses: new Set(['linux']), branchPushes: false, usesFlaky: false }
  const warnings = ciAdvice(bad, { name: 'x' })
  assert.equal(warnings.length, 3)
  assert.match(warnings[0], /push/)
  assert.match(warnings[1], /single OS/)
  assert.match(warnings[2], /flaky/)
  for (const w of warnings) assert.doesNotMatch(w, /\n/)
  const good = { present: true, oses: new Set(['linux', 'windows']), branchPushes: true, usesFlaky: true }
  assert.deepEqual(ciAdvice(good, {}), [])
  // A package.json os field restricting the package to the one OS the CI runs silences that warning only.
  assert.deepEqual(ciAdvice({ ...good, oses: new Set(['linux']) }, { os: ['linux'] }), [])
  assert.deepEqual(ciAdvice({ ...good, oses: new Set(['macos']) }, { os: ['darwin'] }), [])
  assert.deepEqual(ciAdvice({ ...good, oses: new Set(['linux']) }, { os: ['!win32', '!darwin'] }), [])
  assert.equal(ciAdvice({ ...good, oses: new Set(['linux']) }, { os: ['linux', 'darwin'] }).length, 1)
  assert.equal(ciAdvice({ ...good, oses: new Set(['linux']) }, null).length, 1)
})

test('an on: value it cannot read is reported as null, not guessed', async t => {
  assert.equal((await one(t, `on: { push: { branches: [master }\n${job('ubuntu-latest')}`)).branchPushes, null)
  assert.equal((await one(t, job('ubuntu-latest'))).branchPushes, null)
})

test('the flaky step is recognised with a quoted cli.mjs path, as the spec invokes it', async t => {
  const step = run => `on: push\n${job('ubuntu-latest', `      - run: ${run}\n`)}`
  assert.equal((await one(t, step('node "${{ github.workspace }}/scripts/cli.mjs" flaky -- npm test'))).usesFlaky, true)
  assert.equal((await one(t, step("node '/x/scripts/cli.mjs' flaky --report r.json -- npm test"))).usesFlaky, true)
  assert.equal((await one(t, step('node /x/scripts/cli.mjs flaky -- npm test'))).usesFlaky, true)
  assert.equal((await one(t, step('node "/x/scripts/cli.mjs" flakyish -- npm test'))).usesFlaky, false)
  assert.equal((await one(t, step('node "/x/scripts/cli.mjs" gate -- flaky'))).usesFlaky, false)
})

// The rule: a push filter covers fleet run branches when, after GitHub's ordered `!` negations,
// it matches `run/ci-reliability` or `fleetmates/ci-reliability/T1`. `*` matches no slash, `**`
// matches anything.
test('a branch filter covers fleet run branches only when a pattern matches run/<id> or fleetmates/<run>/<task>', async t => {
  const covers = async list => (await one(t, `on:\n  push:\n    branches: [${list}]\n${job('ubuntu-latest')}`)).branchPushes
  for (const yes of ["'**'", "'run/**'", "'fleetmates/**'", "'run/*'", "master, 'run/**'", "'fleetmates/*/*'", "'**', '!run/**'"]) assert.equal(await covers(yes), true, yes)
  for (const no of ["'feat/*'", 'master', "'release/*'", "'*'", "'fleetmates/*'", "'**/master'", "'run-*'", "'**', '!run/**', '!fleetmates/**'"]) assert.equal(await covers(no), false, no)
})
