// Tests for tools/replay/integrator-replay.mjs. Nothing here asserts real Claude Code behaviour:
// every session is this file's own fake `claude`, and every repository is a fixture under $TMPDIR.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  discoverIntegrations, sampleIntegrations, buildIntegrationClone, integratorSystemPrompt,
  buildDispatchPrompt, runIntegratorCell, buildVerdict, main,
} from '../tools/replay/integrator-replay.mjs'
import { censusRoot } from '../tools/replay/integrator-census.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENT_FILE = path.join(HERE, '..', 'agents', 'tm-integrator.md')
const WIN32_SKIP = process.platform === 'win32' ? 'shebang fake binaries do not execute on win32' : false

// A fake `claude` on PATH. It waits for stdin to close, logs {argv, input, cwd} to FAKE_CLAUDE_LOG,
// takes ONE entry off the JSON queue in FAKE_CLAUDE_QUEUE and carries out its `steps` in cwd:
//   { cmd: [bin, ...args], mayFail } runs a command (a failure throws unless mayFail);
//   { write: { relPath: content } } writes files.
// It then prints a `claude -p --output-format json` result built from the entry's totalCostUsd,
// numTurns, isError and permissionDenials, or `raw` verbatim, after writing the entry's `stderr`
// to its stderr.
const FAKE_CLAUDE_SRC = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const argv = process.argv.slice(2)
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', () => {
  const queuePath = process.env.FAKE_CLAUDE_QUEUE
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'))
  const entry = queue.shift()
  fs.writeFileSync(queuePath, JSON.stringify(queue))
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, input, cwd: process.cwd() }) + '\\n')
  }
  if (!entry) { process.stderr.write('fake claude: queue exhausted\\n'); process.exit(1) }
  for (const step of entry.steps || []) {
    if (step.cmd) {
      try {
        execFileSync(step.cmd[0], step.cmd.slice(1), { cwd: process.cwd(), stdio: 'ignore' })
      } catch (err) {
        if (!step.mayFail) throw err
      }
    }
    for (const [rel, content] of Object.entries(step.write || {})) {
      fs.writeFileSync(path.join(process.cwd(), rel), content)
    }
  }
  if (entry.stderr) process.stderr.write(entry.stderr)
  if (entry.raw !== undefined) {
    process.stdout.write(entry.raw)
  } else {
    const obj = {
      type: 'result', subtype: 'success', is_error: !!entry.isError, result: entry.result || '',
      session_id: 'sess-1', permission_denials: entry.permissionDenials || [],
    }
    if (entry.totalCostUsd !== undefined) obj.total_cost_usd = entry.totalCostUsd
    if (entry.numTurns !== undefined) obj.num_turns = entry.numTurns
    process.stdout.write(JSON.stringify(obj) + '\\n')
  }
  process.exit(0)
})
process.stdin.resume()
`

let pathDir
let originalPath

before(async () => {
  pathDir = await mkdtemp(path.join(tmpdir(), 'fm-intreplay-bin-'))
  const bin = path.join(pathDir, 'claude')
  await writeFile(bin, FAKE_CLAUDE_SRC, 'utf8')
  await chmod(bin, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${pathDir}${path.delimiter}${originalPath}`
})

after(async () => {
  process.env.PATH = originalPath
  await rm(pathDir, { recursive: true, force: true })
})

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim()
}

async function commitFile(dir, file, body, message) {
  await writeFile(path.join(dir, file), body, 'utf8')
  git(dir, ['add', file])
  git(dir, ['commit', '-q', '-m', message])
  return git(dir, ['rev-parse', 'HEAD'])
}

// The gate manifest's one command check fails when `bad.txt` exists at the tip.
const MANIFEST = JSON.stringify({
  phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'test ! -f bad.txt' }, { name: 'fileset', kind: 'fileset' }] } },
})
// Two command checks: the first passes everywhere, the second fails wherever b.txt exists, which
// is every tip of run r1 from phase 1 on.
const TWO_CHECKS = JSON.stringify({
  phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'test ! -f bad.txt' }, { name: 'lint', kind: 'command', run: 'test ! -f b.txt' }] } },
})

// Run r1:
//   phase 1: T1 and T2, merged consecutively and cleanly (T1's recorded message has a body);
//   phase 2: T3, which conflicts with T1 on base.txt and was resolved by hand to "resolved".
// Run r2: phase 1 merged T1, then an operator commit, then T2 — not consecutive, so not replayable.
// Every task branch is pruned: tips are only in status.json.
// With liveRuns:
//   run r3: its gate recorded T1 at an older sha, and the live branch fleetmates/r3/T1 moved on
//           before it was merged, so the merged tip's name is found only among the live refs;
//   run r4: no status.json and a live, merged task branch, so its phase is unknown.
// manifestName names the file `manifest` is committed as; null commits no manifest at all.
// prefix and stateDir name the task branches and the status directory, so a fixture can be a
// pre-rename run (`teammates/<run>/<task>` branches, `.teammates/` state).
async function buildFixture({ manifestName = 'fleetmates.gate.json', manifest = MANIFEST, liveRuns = false, prefix = 'fleetmates', stateDir = '.fleetmates' } = {}) {
  const b = (run, task) => `${prefix}/${run}/${task}`
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-intreplay-'))
  const repo = path.join(dir, 'repo')
  await mkdir(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  if (manifestName !== null) {
    await writeFile(path.join(repo, manifestName), manifest, 'utf8')
    git(repo, ['add', manifestName])
  }
  await commitFile(repo, 'base.txt', 'one\n', 'chore: base')
  git(repo, ['branch', 'run/r1'])
  git(repo, ['branch', 'run/r2'])

  git(repo, ['checkout', '-q', '-b', b('r1', 'T1'), 'run/r1'])
  const t1 = await commitFile(repo, 'base.txt', 'from T1\n', 'feat: t1')
  git(repo, ['checkout', '-q', '-b', b('r1', 'T2'), 'run/r1'])
  const t2 = await commitFile(repo, 'b.txt', 'b\n', 'feat: t2')
  git(repo, ['checkout', '-q', '-b', b('r1', 'T3'), 'run/r1'])
  const t3 = await commitFile(repo, 'base.txt', 'from T3\n', 'feat: t3')

  git(repo, ['checkout', '-q', 'run/r1'])
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r1): T1 one\n\nbody line', b('r1', 'T1')])
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r1): T2 two', b('r1', 'T2')])
  const p1Tip = git(repo, ['rev-parse', 'HEAD'])
  const conflicted = spawnSync('git', ['merge', '--no-ff', '-m', 'merge(r1): T3 three', b('r1', 'T3')], { cwd: repo, env: { ...process.env, ...GIT_ENV } })
  assert.notEqual(conflicted.status, 0, 'the fixture needs T3 to conflict')
  await writeFile(path.join(repo, 'base.txt'), 'resolved\n', 'utf8')
  git(repo, ['add', 'base.txt'])
  git(repo, ['commit', '-q', '-m', 'merge(r1): T3 three'])
  const p2Tip = git(repo, ['rev-parse', 'HEAD'])

  git(repo, ['checkout', '-q', '-b', b('r2', 'T1'), 'run/r2'])
  const r2t1 = await commitFile(repo, 'c.txt', 'c\n', 'feat: c')
  git(repo, ['checkout', '-q', '-b', b('r2', 'T2'), 'run/r2'])
  const r2t2 = await commitFile(repo, 'd.txt', 'd\n', 'feat: d')
  git(repo, ['checkout', '-q', 'run/r2'])
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r2): T1 c', b('r2', 'T1')])
  await commitFile(repo, 'op.txt', 'op\n', 'chore: operator')
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r2): T2 d', b('r2', 'T2')])
  git(repo, ['checkout', '-q', 'main'])
  let r3old = null
  if (liveRuns) {
    git(repo, ['branch', 'run/r3', 'main'])
    git(repo, ['checkout', '-q', '-b', b('r3', 'T1'), 'run/r3'])
    r3old = await commitFile(repo, 'e.txt', 'e\n', 'feat: e')
    await commitFile(repo, 'e.txt', 'e2\n', 'feat: e2')
    git(repo, ['checkout', '-q', 'run/r3'])
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r3): T1 e', b('r3', 'T1')])
    git(repo, ['branch', 'run/r4', 'main'])
    git(repo, ['checkout', '-q', '-b', b('r4', 'T1'), 'run/r4'])
    await commitFile(repo, 'f.txt', 'f\n', 'feat: f')
    git(repo, ['checkout', '-q', 'run/r4'])
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r4): T1 f', b('r4', 'T1')])
    git(repo, ['checkout', '-q', 'main'])
  }
  git(repo, ['branch', '-D', b('r1', 'T1'), b('r1', 'T2'), b('r1', 'T3'), b('r2', 'T1'), b('r2', 'T2')])

  for (const [runId, gates] of [
    ['r1', { 1: { verdict: 'PASS', phase: 1, branchShas: { [b('r1', 'T1')]: t1, [b('r1', 'T2')]: t2 } }, 2: { verdict: 'PASS', phase: 2, branchShas: { [b('r1', 'T3')]: t3 } } }],
    ['r2', { 1: { verdict: 'PASS', phase: 1, branchShas: { [b('r2', 'T1')]: r2t1, [b('r2', 'T2')]: r2t2 } } }],
    ...(liveRuns ? [['r3', { 1: { verdict: 'PASS', phase: 1, branchShas: { [b('r3', 'T1')]: r3old } } }]] : []),
  ]) {
    await mkdir(path.join(repo, stateDir, runId), { recursive: true })
    await writeFile(path.join(repo, stateDir, runId, 'status.json'), JSON.stringify({ runId, gates }), 'utf8')
  }
  const tmpRoot = path.join(dir, 'tmp')
  await mkdir(tmpRoot)
  return { dir, repo, tmpRoot, t1, t2, t3, p1Tip, p2Tip }
}

function merge(branch, message) {
  return { cmd: ['git', 'merge', '-q', '--no-ff', '-m', message, branch] }
}

// A faithful integration of each fixture phase, as fake-session steps.
const PHASE1_OK = [merge('fleetmates/r1/T1', 'merge(r1): T1 one'), merge('fleetmates/r1/T2', 'merge(r1): T2 two')]
const PHASE2_OK = [
  { cmd: ['git', 'merge', '-q', '--no-ff', '-m', 'merge(r1): T3 three', 'fleetmates/r1/T3'], mayFail: true },
  { write: { 'base.txt': 'resolved\n' } },
  { cmd: ['git', 'add', 'base.txt'] },
  { cmd: ['git', 'commit', '-q', '-m', 'merge(r1): T3 three'] },
]

async function withQueue(dir, entries) {
  const queue = path.join(dir, `queue-${Math.random().toString(36).slice(2)}.json`)
  const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`)
  await writeFile(queue, JSON.stringify(entries), 'utf8')
  // The fake's own git calls must not pick up the operator's global config (hooks, signing).
  return { env: { FAKE_CLAUDE_QUEUE: queue, FAKE_CLAUDE_LOG: log, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, log, queue }
}

async function readLog(log) {
  try {
    return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function integrationsOf(fx) {
  return discoverIntegrations({ root: fx.repo, projectsDir: path.join(fx.dir, 'no-projects') })
}

const byPhase = (list, run, phase) => list.find((i) => i.runId === run && i.phase === phase)

test('discovery groups a run\'s merges by phase, marks conflicts from the census and refuses non-consecutive phases', async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const all = await integrationsOf(fx)
  const p1 = byPhase(all, 'r1', 1)
  const p2 = byPhase(all, 'r1', 2)
  const r2 = byPhase(all, 'r2', 1)
  assert.equal(p1.eligible, true)
  assert.equal(p1.conflicted, false)
  assert.deepEqual(p1.merges.map((m) => [m.branch, m.tip, m.message]), [
    ['fleetmates/r1/T1', fx.t1, 'merge(r1): T1 one'],
    ['fleetmates/r1/T2', fx.t2, 'merge(r1): T2 two'],
  ])
  assert.equal(p1.finalTree, git(fx.repo, ['rev-parse', `${fx.p1Tip}^{tree}`]))
  assert.equal(p2.eligible, true)
  assert.equal(p2.conflicted, true)
  assert.equal(p2.startSha, fx.p1Tip)
  assert.equal(p2.finalTree, git(fx.repo, ['rev-parse', `${fx.p2Tip}^{tree}`]))
  assert.equal(r2.eligible, false)
  assert.equal(r2.reason, 'non-consecutive')
  assert.match(p1.key, /^[0-9a-f]{16}$/)
})

test('discovery names a merged tip from the live refs, and reports an unknown phase or branch without sampling it', async (t) => {
  const fx = await buildFixture({ liveRuns: true })
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const all = await integrationsOf(fx)
  const r3 = byPhase(all, 'r3', 1)
  assert.equal(r3.eligible, true, JSON.stringify(r3))
  assert.deepEqual(r3.merges.map((m) => m.branch), ['fleetmates/r3/T1'])
  const r4 = all.filter((i) => i.runId === 'r4')
  assert.deepEqual(r4.map((i) => [i.eligible, i.reason, i.phase]), [[false, 'phase-unknown', null]])
  const sampled = sampleIntegrations(all, { count: 50, seed: 1 })
  assert.ok(!sampled.some((i) => i.runId === 'r4' || i.runId === 'r2'))
  assert.equal(sampled.length, 3)

  // A merge the census counted whose second parent no source names any more: the run's status.json
  // is gone by the time the names are read.
  const censusFn = async (args) => {
    const rows = await censusRoot(args)
    await rm(path.join(fx.repo, '.fleetmates', 'r1'), { recursive: true, force: true })
    return rows
  }
  const late = await discoverIntegrations({ root: fx.repo, projectsDir: path.join(fx.dir, 'no-projects'), censusFn })
  const r1 = late.filter((i) => i.runId === 'r1')
  assert.deepEqual(r1.map((i) => [i.eligible, i.reason]), [[false, 'branch-unknown'], [false, 'branch-unknown']])
  assert.ok(!sampleIntegrations(late, { count: 50, seed: 1 }).some((i) => i.runId === 'r1'))
})

test('the scratch clone holds the run branch at the first parent and every task branch at its merged tip, and nothing of the recorded merges', async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p2 = byPhase(await integrationsOf(fx), 'r1', 2)
  const before = git(fx.repo, ['for-each-ref', '--format=%(objectname) %(refname)'])
  const { cloneDir } = await buildIntegrationClone({ integration: p2, tmpRoot: fx.tmpRoot })
  try {
    assert.ok(cloneDir.startsWith(fx.tmpRoot + path.sep))
    assert.equal(git(cloneDir, ['rev-parse', 'run/r1']), fx.p1Tip)
    assert.equal(git(cloneDir, ['rev-parse', 'fleetmates/r1/T3']), fx.t3)
    assert.equal(git(cloneDir, ['symbolic-ref', '--short', 'HEAD']), 'run/r1')
    const has = spawnSync('git', ['cat-file', '-e', fx.p2Tip], { cwd: cloneDir })
    assert.notEqual(has.status, 0, 'the recorded merge must not be in the clone')
    assert.deepEqual(git(cloneDir, ['for-each-ref', '--format=%(refname)']).split('\n').sort(), ['refs/heads/fleetmates/r1/T3', 'refs/heads/run/r1'])
  } finally {
    await rm(cloneDir, { recursive: true, force: true })
  }
  assert.equal(git(fx.repo, ['for-each-ref', '--format=%(objectname) %(refname)']), before, 'the source repository is never written')
})

test('the dispatch prompt names the branches in the recorded order with the exact single-line messages', async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const prompt = buildDispatchPrompt(p1)
  const i1 = prompt.indexOf('fleetmates/r1/T1')
  const i2 = prompt.indexOf('fleetmates/r1/T2')
  assert.ok(i1 >= 0 && i2 > i1)
  assert.ok(prompt.includes('`merge(r1): T1 one`'))
  assert.ok(prompt.includes('`merge(r1): T2 two`'))
  assert.ok(!prompt.includes('body line'))
  assert.ok(prompt.includes('run/r1'))
})

test('the system prompt is the body of agents/tm-integrator.md, without its frontmatter', async () => {
  const body = await integratorSystemPrompt()
  const file = await readFile(AGENT_FILE, 'utf8')
  assert.ok(file.endsWith(body))
  assert.ok(!body.startsWith('---'))
  assert.ok(body.includes('sole writer'))
})

test('a faithful integration passes, and the session is spawned with the dispatched argv', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK, totalCostUsd: 0.25, numTurns: 7 }])
  const cell = await runIntegratorCell({ integration: p1, model: 'fake-model', tmpRoot: fx.tmpRoot, env: q.env })
  assert.equal(cell.status, 'pass', JSON.stringify(cell))
  assert.equal(cell.failReason, null)
  assert.equal(cell.totalCostUsd, 0.25)
  assert.equal(cell.turns, 7)
  const [call] = await readLog(q.log)
  const body = await integratorSystemPrompt()
  assert.deepEqual(call.argv, [
    '-p', '--model', 'fake-model', '--output-format', 'json', '--permission-mode', 'bypassPermissions',
    '--strict-mcp-config', '--append-system-prompt', body,
  ])
  assert.equal(call.input, buildDispatchPrompt(p1))
  assert.deepEqual(await readdir(fx.tmpRoot), [], 'the clone is removed afterwards')
})

test('a hand-resolved conflict passes when the resolution reproduces the recorded tree', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p2 = byPhase(await integrationsOf(fx), 'r1', 2)
  const q = await withQueue(fx.dir, [{ steps: PHASE2_OK, totalCostUsd: 0.1, numTurns: 3 }])
  const cell = await runIntegratorCell({ integration: p2, model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.equal(cell.status, 'pass', JSON.stringify(cell))
})

const FAILURES = [
  ['a different conflict resolution', 2, [
    { cmd: ['git', 'merge', '-q', '--no-ff', '-m', 'merge(r1): T3 three', 'fleetmates/r1/T3'], mayFail: true },
    { write: { 'base.txt': 'other\n' } }, { cmd: ['git', 'add', 'base.txt'] }, { cmd: ['git', 'commit', '-q', '-m', 'merge(r1): T3 three'] },
  ], 'wrong-tree'],
  ['a missing branch', 1, [PHASE1_OK[0]], 'wrong-tree'],
  ['a session that does nothing', 1, [], 'escalated'],
  ['an escalation that aborts the conflicted merge and reports', 2, [
    { cmd: ['git', 'merge', '-q', '--no-ff', '-m', 'merge(r1): T3 three', 'fleetmates/r1/T3'], mayFail: true },
    { cmd: ['git', 'merge', '--abort'] },
  ], 'escalated'],
  ['an API error before any merge', 1, [], 'session-error', { isError: true, result: 'API Error: 529 overloaded' }],
  ['unparseable output before any merge', 1, [], 'session-error', { raw: 'not json' }],
  ['an API error after a faithful integration', 1, PHASE1_OK, 'session-error', { isError: true }],
  ['an API error after a partial integration', 1, [PHASE1_OK[0]], 'wrong-tree', { isError: true }],
  ['T1 merged into T2, and only T2 into the run branch', 1, [
    { cmd: ['git', 'checkout', '-q', 'fleetmates/r1/T2'] },
    merge('fleetmates/r1/T1', 'merge(r1): T1 one'),
    { cmd: ['git', 'checkout', '-q', 'run/r1'] },
    PHASE1_OK[1],
  ], 'extra-commits'],
  ['a squash merge', 1, [
    { cmd: ['git', 'merge', '-q', '--squash', 'fleetmates/r1/T1'] }, { cmd: ['git', 'commit', '-q', '-m', 'merge(r1): T1 one'] },
    PHASE1_OK[1],
  ], 'not-merge'],
  ['a trailer on the message', 1, [
    merge('fleetmates/r1/T1', 'merge(r1): T1 one\n\nCo-Authored-By: x <x@example.invalid>'), PHASE1_OK[1],
  ], 'message'],
  ['the merges in another order', 1, [PHASE1_OK[1], PHASE1_OK[0]], 'message'],
  ['the merges in another order with the messages swapped to the dispatched order', 1, [
    merge('fleetmates/r1/T2', 'merge(r1): T1 one'), merge('fleetmates/r1/T1', 'merge(r1): T2 two'),
  ], 'not-merge'],
  ['a run branch deleted after a faithful integration', 1, [
    ...PHASE1_OK, { cmd: ['git', 'checkout', '-q', '--detach'] }, { cmd: ['git', 'branch', '-D', 'run/r1'] },
  ], 'wrong-tree'],
  ['an extra commit that leaves the tree unchanged', 1, [
    ...PHASE1_OK, { cmd: ['git', 'commit', '-q', '--allow-empty', '-m', 'chore: note'] },
  ], 'extra-commits'],
  ['a commit added to a task branch before merging it', 1, [
    { cmd: ['git', 'checkout', '-q', 'fleetmates/r1/T2'] },
    { cmd: ['git', 'commit', '-q', '--allow-empty', '-m', 'chore: note'] },
    { cmd: ['git', 'checkout', '-q', 'run/r1'] },
    ...PHASE1_OK,
  ], 'extra-commits'],
]

for (const [name, phase, steps, reason, extra = {}] of FAILURES) {
  test(`${name} fails with ${reason}`, { skip: WIN32_SKIP }, async (t) => {
    const fx = await buildFixture()
    t.after(() => rm(fx.dir, { recursive: true, force: true }))
    const integration = byPhase(await integrationsOf(fx), 'r1', phase)
    const q = await withQueue(fx.dir, [{ steps, totalCostUsd: 0.1, numTurns: 2, ...extra }])
    const cell = await runIntegratorCell({ integration, model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
    assert.equal(cell.status, 'fail')
    assert.equal(cell.failReason, reason)
  })
}

test('the project\'s test command gates the pass', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK }])
  // The tree and the history are right; only the command check fails.
  const cell = await runIntegratorCell({
    integration: p1, model: 'm', tmpRoot: fx.tmpRoot, env: q.env,
    runCheckFn: async (check) => ({ status: 'fail', output: 'boom', exitCode: 1, name: check.name }),
  })
  assert.equal(cell.status, 'fail')
  assert.equal(cell.failReason, 'command:test')
  const q2 = await withQueue(fx.dir, [{ steps: PHASE1_OK }])
  const ran = []
  const ok = await runIntegratorCell({
    integration: p1, model: 'm', tmpRoot: fx.tmpRoot, env: q2.env,
    runCheckFn: async (check, { cwd }) => { ran.push([check.name, git(cwd, ['rev-parse', 'HEAD^{tree}'])]); return { status: 'pass' } },
  })
  assert.equal(ok.status, 'pass')
  assert.deepEqual(ran, [['test', p1.finalTree]], 'the check runs at the integrated tip')
})

test('a permission denial marks the cell invalid, never a pass', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK, permissionDenials: [{ tool_name: 'Bash' }] }])
  const cell = await runIntegratorCell({ integration: p1, model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.equal(cell.invalid, true)
  assert.notEqual(cell.status, 'pass')
  assert.deepEqual(cell.deniedTools, ['Bash'])
})

test('sampling is seeded, over-samples conflicted integrations and skips ineligible ones', () => {
  const mk = (key, conflicted, eligible = true) => ({ key, conflicted, eligible })
  const list = [mk('a', false), mk('b', false), mk('c', true), mk('d', false), mk('e', true), mk('f', true, false)]
  const one = sampleIntegrations(list, { count: 2, seed: 7 })
  assert.deepEqual(one.map((i) => i.key).sort(), ['c', 'e'])
  const four = sampleIntegrations(list, { count: 4, seed: 7 })
  assert.equal(four.length, 4)
  assert.ok(four.slice(0, 2).every((i) => i.conflicted))
  assert.ok(!four.some((i) => i.key === 'f'))
  assert.deepEqual(sampleIntegrations([...list].reverse(), { count: 4, seed: 7 }), four)
  const other = sampleIntegrations(list, { count: 4, seed: 8 })
  assert.equal(other.length, 4)
  assert.equal(sampleIntegrations(list, { count: 50, seed: 7 }).length, 5)
})

test('the seed decides the sample order', () => {
  const clean = 'abcdefghij'.split('').map((key) => ({ key, conflicted: false, eligible: true }))
  const order = (seed) => sampleIntegrations(clean, { count: 10, seed }).map((i) => i.key).join('')
  assert.equal(order(7), order(7))
  assert.notEqual(order(7), order(8))
  assert.notEqual(order(7), 'abcdefghij')
  assert.notEqual(order(8), 'abcdefghij')
})

const row = (key, role, model, status, failReason, cost) => ({ key, role, model, status, failReason, turns: 1, totalCostUsd: cost, wallClockMs: 1 })
const MODELS = { candidate: 'haiku', control: 'sonnet' }

test('the verdict is cheap only when the candidate passes as often, never builds a wrong tree, and costs less', () => {
  const base = [
    row('k1', 'candidate', 'haiku', 'pass', null, 0.1), row('k1', 'control', 'sonnet', 'pass', null, 0.5),
    row('k2', 'candidate', 'haiku', 'fail', 'message', 0.1), row('k2', 'control', 'sonnet', 'fail', 'message', 0.5),
  ]
  const cheap = buildVerdict(base, { models: MODELS })
  assert.equal(cheap.verdict, 'cheap')
  assert.equal(cheap.sampleSize, 2)
  assert.equal(cheap.counts.candidate.pass, 1)
  assert.equal(cheap.counts.control.pass, 1)
  assert.equal(cheap.counts.candidate.wrongTree, 0)
  assert.equal(cheap.counts.candidate.meanCostUsd, 0.1)
  assert.equal(typeof cheap.rule, 'string')

  const fewer = [...base.slice(0, 2), row('k2', 'candidate', 'haiku', 'fail', 'message', 0.1), row('k2', 'control', 'sonnet', 'pass', null, 0.5)]
  assert.equal(buildVerdict(fewer, { models: MODELS }).verdict, 'sonnet')

  const wrongTree = [...base.slice(0, 2), row('k2', 'candidate', 'haiku', 'fail', 'wrong-tree', 0.1), row('k2', 'control', 'sonnet', 'fail', 'wrong-tree', 0.5)]
  assert.equal(buildVerdict(wrongTree, { models: MODELS }).verdict, 'sonnet')

  const pricier = base.map((r) => (r.role === 'candidate' ? { ...r, totalCostUsd: 0.9 } : r))
  assert.equal(buildVerdict(pricier, { models: MODELS }).verdict, 'sonnet')

  const costUnknown = base.map((r) => (r.role === 'candidate' ? { ...r, totalCostUsd: null } : r))
  assert.equal(buildVerdict(costUnknown, { models: MODELS }).verdict, 'sonnet')

  // An integration measured by only one role is left out, so both sides see the same sample.
  const unpaired = [...base, row('k3', 'candidate', 'haiku', 'pass', null, 0.1)]
  assert.equal(buildVerdict(unpaired, { models: MODELS }).sampleSize, 2)
  // Rows from another model pairing are not counted.
  const stale = [...base, row('k3', 'candidate', 'opus', 'fail', 'wrong-tree', 9), row('k3', 'control', 'sonnet', 'pass', null, 0.5)]
  assert.equal(buildVerdict(stale, { models: MODELS }).verdict, 'cheap')

  // Escalations are counted per role and are not passes; they do not veto cheap.
  const escalated = [...base, row('k3', 'candidate', 'haiku', 'fail', 'escalated', 0.1), row('k3', 'control', 'sonnet', 'fail', 'escalated', 0.5)]
  const withEscalations = buildVerdict(escalated, { models: MODELS })
  assert.equal(withEscalations.verdict, 'cheap')
  assert.equal(withEscalations.counts.candidate.escalated, 1)
  assert.equal(withEscalations.counts.control.escalated, 1)
  assert.equal(withEscalations.counts.candidate.pass, 1)
  // An integration either role could not judge (no manifest) is left out of the comparison.
  const invalid = [...base, row('k3', 'candidate', 'haiku', 'invalid', 'no-manifest', 0.1), row('k3', 'control', 'sonnet', 'invalid', 'no-manifest', 0.5)]
  assert.equal(buildVerdict(invalid, { models: MODELS }).sampleSize, 2)
  // Each side's exclusion on its own. Kept, a candidate-only invalid row would be a candidate
  // non-pass against a control pass, and a control-only invalid row would let the candidate's
  // wrong tree veto cheap: both would turn the verdict to sonnet.
  const candidateInvalid = [...base, row('k3', 'candidate', 'haiku', 'invalid', 'no-manifest', 0.1), row('k3', 'control', 'sonnet', 'pass', null, 0.5)]
  assert.deepEqual([buildVerdict(candidateInvalid, { models: MODELS }).verdict, buildVerdict(candidateInvalid, { models: MODELS }).sampleSize], ['cheap', 2])
  const controlInvalid = [...base, row('k3', 'candidate', 'haiku', 'fail', 'wrong-tree', 0.1), row('k3', 'control', 'sonnet', 'invalid', 'no-manifest', 0.5)]
  assert.deepEqual([buildVerdict(controlInvalid, { models: MODELS }).verdict, buildVerdict(controlInvalid, { models: MODELS }).sampleSize], ['cheap', 2])
  // An unknown control mean never makes the candidate count as cheaper.
  const controlCostUnknown = base.map((r) => (r.role === 'control' ? { ...r, totalCostUsd: null } : r))
  const unknownControl = buildVerdict(controlCostUnknown, { models: MODELS })
  assert.equal(unknownControl.counts.control.meanCostUsd, null)
  assert.equal(unknownControl.verdict, 'sonnet')
})

function io() {
  const lines = []
  return { lines, out: (s) => lines.push(s) }
}

test('a dry run starts no session and writes nothing', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const q = await withQueue(fx.dir, [])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '5', '--out', out], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 0)
  assert.deepEqual(await readLog(q.log), [])
  await assert.rejects(readdir(out))
  assert.ok(sink.lines.some((l) => /2 eligible/.test(l)), sink.lines.join('\n'))
})

test('execute runs the preflight, then the same sample for candidate and control, and writes only hashed keys and metrics', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  // Sample order: the conflicted phase 2 first, then phase 1. Preflight is one candidate cell.
  const q = await withQueue(fx.dir, [
    { steps: [], totalCostUsd: 0.01, numTurns: 1 },
    { steps: PHASE2_OK, totalCostUsd: 0.1, numTurns: 4 },
    { steps: PHASE2_OK, totalCostUsd: 0.4, numTurns: 9 },
    { steps: PHASE1_OK, totalCostUsd: 0.1, numTurns: 4 },
    { steps: [PHASE1_OK[0]], totalCostUsd: 0.4, numTurns: 9 },
  ])
  const sink = io()
  const argv = ['--roots', fx.repo, '--count', '2', '--out', out, '--execute', '--models', JSON.stringify(MODELS)]
  const code = await main(argv, sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env, now: () => '2026-09-24T00:00:00.000Z' })
  assert.equal(code, 0, sink.lines.join('\n'))
  const calls = await readLog(q.log)
  assert.deepEqual(calls.map((c) => c.argv[2]), ['haiku', 'haiku', 'sonnet', 'haiku', 'sonnet'])
  const rows = (await readFile(path.join(out, 'integrator-replay.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r) => r.role), ['candidate', 'control', 'candidate', 'control'])
  assert.equal(rows[0].key, rows[1].key)
  assert.equal(rows[2].key, rows[3].key)
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['costMissing', 'failReason', 'key', 'model', 'role', 'status', 'timestamp', 'totalCostUsd', 'turns', 'wallClockMs'])
  }
  assert.deepEqual(rows.map((r) => r.status), ['pass', 'pass', 'pass', 'fail'])
  assert.equal(rows[3].failReason, 'wrong-tree')
  const text = await readFile(path.join(out, 'integrator-replay.jsonl'), 'utf8')
  for (const secret of ['T1', 'T3', 'merge(r1)', 'fleetmates/r1', 'base.txt']) assert.ok(!text.includes(secret), secret)
  const verdict = JSON.parse(await readFile(path.join(out, 'integrator-verdict.json'), 'utf8'))
  assert.equal(verdict.verdict, 'cheap')
  assert.equal(verdict.sampleSize, 2)
  assert.deepEqual(verdict.models, MODELS)
  assert.equal(verdict.counts.candidate.pass, 2)
  assert.equal(verdict.counts.control.pass, 1)

  // A rerun with the same arguments records nothing new and starts no session.
  const again = await main(argv, io(), { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(again, 0)
  assert.equal((await readLog(q.log)).length, 5)
})

test('execute stops with nothing recorded when a cell reports a permission denial', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const q = await withQueue(fx.dir, [
    { steps: [], totalCostUsd: 0.01 },
    { steps: PHASE2_OK, permissionDenials: [{ tool_name: 'Bash' }] },
  ])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '1', '--out', out, '--execute', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 1)
  assert.ok(sink.lines.some((l) => l.startsWith('INVALID')), sink.lines.join('\n'))
  const rows = await readFile(path.join(out, 'integrator-replay.jsonl'), 'utf8').catch(() => '')
  assert.equal(rows, '')
})

test('the preflight aborts execute when its cell reports a permission denial', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const q = await withQueue(fx.dir, [{ steps: [], permissionDenials: [{ tool_name: 'Write' }] }])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '1', '--out', out, '--execute', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 1)
  assert.equal((await readLog(q.log)).length, 1)
  assert.ok(sink.lines.some((l) => /preflight: FAILED/.test(l)), sink.lines.join('\n'))
})

test('smoke runs one candidate cell, prints it and records nothing', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const q = await withQueue(fx.dir, [{ steps: PHASE2_OK, totalCostUsd: 0.2, numTurns: 5 }])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '1', '--out', out, '--smoke', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 0, sink.lines.join('\n'))
  assert.ok(sink.lines.some((l) => /smoke: .* model=haiku status=pass/.test(l)), sink.lines.join('\n'))
  await assert.rejects(readdir(out))
})

for (const mode of ['--execute', '--smoke', '--preflight']) {
  test(`${mode} refuses without both models, on a valid root`, { skip: WIN32_SKIP }, async (t) => {
    const fx = await buildFixture()
    t.after(() => rm(fx.dir, { recursive: true, force: true }))
    const q = await withQueue(fx.dir, [])
    const out = path.join(fx.dir, 'out')
    const sink = io()
    const code = await main(['--roots', fx.repo, '--out', out, mode, '--models', '{"candidate":"haiku"}'], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
    assert.equal(code, 2)
    assert.deepEqual(sink.lines, [`--models must name a model for 'control', e.g. '{"candidate":"haiku","control":"sonnet"}'`])
    const bare = io()
    assert.equal(await main(['--roots', fx.repo, '--out', out, mode], bare, { tmpRoot: fx.tmpRoot, claudeEnv: q.env }), 2)
    assert.deepEqual(bare.lines, [`--execute, --smoke and --preflight need --models '{"candidate":"...","control":"..."}'`])
    assert.deepEqual(await readLog(q.log), [])
  })
}

for (const [name, entry] of [['unparseable output', { steps: [], raw: 'not json' }], ['an is_error result', { steps: [], isError: true, result: 'API Error' }]]) {
  test(`a preflight with ${name} aborts --execute`, { skip: WIN32_SKIP }, async (t) => {
    const fx = await buildFixture()
    t.after(() => rm(fx.dir, { recursive: true, force: true }))
    const out = path.join(fx.dir, 'out')
    const q = await withQueue(fx.dir, [entry, { steps: PHASE2_OK }, { steps: PHASE2_OK }])
    const sink = io()
    const code = await main(['--roots', fx.repo, '--count', '1', '--out', out, '--execute', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
    assert.equal(code, 1)
    assert.equal((await readLog(q.log)).length, 1)
    assert.ok(sink.lines.some((l) => /preflight: FAILED \(session error\)/.test(l)), sink.lines.join('\n'))
    assert.equal(await readFile(path.join(out, 'integrator-replay.jsonl'), 'utf8').catch(() => ''), '')
  })
}

test('the census is pointed at a directory that exists, holds no transcripts and is removed afterwards', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const seen = []
  const censusFn = async (args) => {
    seen.push({ dir: args.projectsDir, entries: await readdir(args.projectsDir) })
    return censusRoot(args)
  }
  const code = await main(['--roots', fx.repo, '--count', '5'], io(), { tmpRoot: fx.tmpRoot, censusFn })
  assert.equal(code, 0)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].entries, [])
  await assert.rejects(readdir(seen[0].dir), { code: 'ENOENT' }, 'the census directory is removed afterwards')
})

test('both roles escalating a conflicted integration, the candidate cheaper, gives cheap', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const escalate = [
    { cmd: ['git', 'merge', '-q', '--no-ff', '-m', 'merge(r1): T3 three', 'fleetmates/r1/T3'], mayFail: true },
    { cmd: ['git', 'merge', '--abort'] },
  ]
  const q = await withQueue(fx.dir, [
    { steps: escalate, totalCostUsd: 0.05, numTurns: 2 },
    { steps: escalate, totalCostUsd: 0.05, numTurns: 2, result: 'escalated: semantic conflict in base.txt' },
    { steps: escalate, totalCostUsd: 0.5, numTurns: 6, result: 'escalated: semantic conflict in base.txt' },
  ])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '1', '--out', out, '--execute', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 0, sink.lines.join('\n'))
  const rows = (await readFile(path.join(out, 'integrator-replay.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(rows.map((r) => [r.role, r.status, r.failReason]), [['candidate', 'fail', 'escalated'], ['control', 'fail', 'escalated']])
  const verdict = JSON.parse(await readFile(path.join(out, 'integrator-verdict.json'), 'utf8'))
  assert.equal(verdict.verdict, 'cheap')
  assert.equal(verdict.counts.candidate.escalated, 1)
  assert.equal(verdict.counts.control.escalated, 1)
  assert.equal(verdict.counts.candidate.wrongTree, 0)
})

test('every command check gates the pass, not only the first', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture({ manifest: TWO_CHECKS })
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK }])
  const cell = await runIntegratorCell({ integration: p1, model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.equal(cell.status, 'fail')
  assert.equal(cell.failReason, 'command:lint')
})

test('a tree that carries only the pre-rename teammates.gate.json is judged by it', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture({ manifestName: 'teammates.gate.json', manifest: TWO_CHECKS })
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK }])
  const cell = await runIntegratorCell({ integration: p1, model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.equal(cell.status, 'fail')
  assert.equal(cell.failReason, 'command:lint')
})

test('a tree with no gate manifest at all is invalid, never a pass', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture({ manifestName: null })
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK }])
  const cell = await runIntegratorCell({ integration: p1, model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.equal(cell.status, 'invalid')
  assert.equal(cell.failReason, 'no-manifest')
})

test('an optional command check that fails does not fail the cell, as in the real gate', { skip: WIN32_SKIP }, async (t) => {
  const manifest = JSON.stringify({
    phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'true' }, { name: 'advisory', kind: 'command', run: 'false', optional: true }] } },
  })
  const fx = await buildFixture({ manifest })
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK }])
  const cell = await runIntegratorCell({ integration: p1, model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.equal(cell.status, 'pass', JSON.stringify(cell))
})

test('the checks are the integration\'s own phase\'s, not the default\'s', { skip: WIN32_SKIP }, async (t) => {
  const manifest = JSON.stringify({
    phases: {
      1: { checks: [{ name: 'phase-one', kind: 'command', run: 'true' }] },
      default: { checks: [{ name: 'default-only', kind: 'command', run: 'false' }] },
    },
  })
  const fx = await buildFixture({ manifest })
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const all = await integrationsOf(fx)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK }, { steps: PHASE2_OK }])
  const p1 = await runIntegratorCell({ integration: byPhase(all, 'r1', 1), model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.deepEqual([p1.status, p1.failReason], ['pass', null])
  const p2 = await runIntegratorCell({ integration: byPhase(all, 'r1', 2), model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.deepEqual([p2.status, p2.failReason], ['fail', 'command:default-only'])
})

test('a preview.link directory of the source repository is copied into the clone for the command checks', { skip: WIN32_SKIP }, async (t) => {
  const manifest = JSON.stringify({
    preview: { link: ['deps'] },
    phases: { default: { checks: [{ name: 'needs-deps', kind: 'command', run: 'test -f deps/lib.txt' }] } },
  })
  const fx = await buildFixture({ manifest })
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  await mkdir(path.join(fx.repo, 'deps'))
  await writeFile(path.join(fx.repo, 'deps', 'lib.txt'), 'untracked build input\n', 'utf8')
  const p1 = byPhase(await integrationsOf(fx), 'r1', 1)
  const q = await withQueue(fx.dir, [{ steps: PHASE1_OK }])
  const cell = await runIntegratorCell({ integration: p1, model: 'm', tmpRoot: fx.tmpRoot, env: q.env })
  assert.deepEqual([cell.status, cell.failReason], ['pass', null])
  assert.equal(await readFile(path.join(fx.repo, 'deps', 'lib.txt'), 'utf8'), 'untracked build input\n', 'the source copy is left alone')
})

test('a pre-rename run (.teammates/ state, teammates/ task branches) names its merged tips', async (t) => {
  const fx = await buildFixture({ prefix: 'teammates', stateDir: '.teammates' })
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const all = await integrationsOf(fx)
  const p1 = byPhase(all, 'r1', 1)
  assert.equal(p1.eligible, true, JSON.stringify(p1))
  assert.deepEqual(p1.merges.map((m) => [m.branch, m.tip]), [['teammates/r1/T1', fx.t1], ['teammates/r1/T2', fx.t2]])
  assert.deepEqual(byPhase(all, 'r1', 2).merges.map((m) => m.branch), ['teammates/r1/T3'])
})

test('the printed resume command survives bash with the --models JSON intact', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, "o u't")
  const q = await withQueue(fx.dir, [
    { steps: [], totalCostUsd: 0.01 },
    { steps: [], isError: true, result: 'Claude AI usage limit reached' },
  ])
  const sink = io()
  const argv = ['--roots', fx.repo, '--count', '1', '--out', out, '--execute', '--models', JSON.stringify(MODELS)]
  const code = await main(argv, sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 1)
  const prefix = 'BLOCKED: usage limit, resume with '
  const line = sink.lines.find((l) => l.startsWith(prefix))
  assert.ok(line, sink.lines.join('\n'))
  const words = spawnSync('bash', ['-c', `f() { printf '%s\\0' "$@"; }; f ${line.slice(prefix.length)}`], { encoding: 'utf8' }).stdout.split('\0').slice(0, -1)
  assert.deepEqual(words, ['node', 'tools/replay/integrator-replay.mjs', ...argv])
})

test('a rerun with a different candidate model runs that model\'s cells and skips only what it already recorded', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const q = await withQueue(fx.dir, [
    { steps: [], totalCostUsd: 0.01 }, { steps: [], totalCostUsd: 0.1 }, { steps: [], totalCostUsd: 0.2 },
    { steps: [], totalCostUsd: 0.01 }, { steps: [], totalCostUsd: 0.1 },
  ])
  const run = (models) => main(['--roots', fx.repo, '--count', '1', '--out', out, '--execute', '--models', JSON.stringify(models)], io(), { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(await run(MODELS), 0)
  assert.equal(await run({ candidate: 'opus', control: 'sonnet' }), 0)
  assert.deepEqual((await readLog(q.log)).map((c) => c.argv[2]), ['haiku', 'haiku', 'sonnet', 'opus', 'opus'])
  const rows = (await readFile(path.join(out, 'integrator-replay.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(rows.map((r) => [r.role, r.model]), [['candidate', 'haiku'], ['control', 'sonnet'], ['candidate', 'opus']])
})

test('a standalone preflight on a healthy session returns 0 and records nothing', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const q = await withQueue(fx.dir, [{ steps: [], totalCostUsd: 0.01, numTurns: 1 }])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '1', '--out', out, '--preflight', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 0, sink.lines.join('\n'))
  assert.ok(sink.lines.some((l) => /^preflight: ok — model=haiku/.test(l)), sink.lines.join('\n'))
  assert.equal((await readLog(q.log)).length, 1)
  await assert.rejects(readdir(out))
})

test('execute prints one progress line per finished cell, made only of what the jsonl records', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const q = await withQueue(fx.dir, [
    { steps: [], totalCostUsd: 0.01 },
    { steps: PHASE2_OK, totalCostUsd: 0.1 },
    { steps: PHASE2_OK, totalCostUsd: 0.4 },
    { steps: PHASE1_OK, totalCostUsd: 0.1 },
    { steps: [PHASE1_OK[0]], totalCostUsd: 0.4 },
  ])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '2', '--out', out, '--execute', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 0, sink.lines.join('\n'))
  const rows = (await readFile(path.join(out, 'integrator-replay.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  const expected = rows.map((r, i) => `cell ${i + 1}/4: ${r.role} ${r.model} status=${r.status} failReason=${r.failReason ?? 'none'} ${(r.wallClockMs / 1000).toFixed(1)}s`)
  assert.deepEqual(sink.lines.filter((l) => l.startsWith('cell ')), expected)
})

// Starts with a control sequence and a newline, and is longer than the 300 characters shown.
const NOISY_HEAD = 'boom\x1b[31m red\n'
const NOISY_STDERR = `${NOISY_HEAD}${'x'.repeat(400)}TAIL`

test('a session error prints the first 300 characters of its stderr, controls made visible, and never records it', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const out = path.join(fx.dir, 'out')
  const q = await withQueue(fx.dir, [
    { steps: [], totalCostUsd: 0.01 },
    { steps: [], raw: 'not json', stderr: NOISY_STDERR },
    { steps: [], totalCostUsd: 0.2 },
  ])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '1', '--out', out, '--execute', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 0, sink.lines.join('\n'))
  const line = sink.lines.find((l) => l.startsWith('cell 1/2: candidate'))
  assert.ok(line, sink.lines.join('\n'))
  assert.match(line, /failReason=session-error \d+\.\ds stderr: /)
  assert.ok(line.endsWith(`stderr: boom<0x1B>[31m red<0x0A>${'x'.repeat(300 - NOISY_HEAD.length)}`), line)
  assert.ok(!line.includes('\x1b') && !line.includes('TAIL'), line)
  assert.ok(!sink.lines.find((l) => l.startsWith('cell 2/2: control')).includes('stderr'))
  const text = await readFile(path.join(out, 'integrator-replay.jsonl'), 'utf8')
  assert.ok(!text.includes('boom') && !text.includes('xxxx'), text)
})

test('a preflight session error prints the session\'s stderr', { skip: WIN32_SKIP }, async (t) => {
  const fx = await buildFixture()
  t.after(() => rm(fx.dir, { recursive: true, force: true }))
  const q = await withQueue(fx.dir, [{ steps: [], isError: true, result: 'API Error', stderr: 'Error: \x07auth failed\n' }])
  const sink = io()
  const code = await main(['--roots', fx.repo, '--count', '1', '--out', path.join(fx.dir, 'out'), '--preflight', '--models', JSON.stringify(MODELS)], sink, { tmpRoot: fx.tmpRoot, claudeEnv: q.env })
  assert.equal(code, 1)
  assert.deepEqual(sink.lines.filter((l) => l.startsWith('preflight:')), ['preflight: FAILED (session error) — model=haiku — stderr: Error: <0x07>auth failed'])
})
