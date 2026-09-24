// Tests for tools/replay/replay.mjs — the controlled replay tool (see tools/replay/README.md).
// Every claim below is backed by a test in this file that was run in this worktree; nothing
// here asserts real Claude Code behaviour, only the contract this file's own fake `claude`
// binary and fixture git repos give it to work against.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp, mkdir, rm, writeFile, readFile, chmod, readdir, realpath, stat, symlink, lstat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn as spawnReal } from 'node:child_process'
import path from 'node:path'
import { defaultGitExec } from '../scripts/git.mjs'
import { taskBranchName } from '../scripts/enforce.mjs'
import {
  hashCellKey, mulberry32, seededShuffle, poolFromPlans, listRunPlans, locateTasks,
  selectDiverseSample, computeLoss, parseClaudeOutput, materializeBaseTree, removeClone,
  resolveBaseSha, planMarkdownAtBase, buildReplayPrompt, runTierCell, main, DEFAULT_TIERS,
  copyPreviewPaths, directoryByteSize, runPreflight, PREFLIGHT_FILE, pickFailReason, DEFAULT_SEED,
} from '../tools/replay/replay.mjs'

const WIN32_FAKE_SKIP = process.platform === 'win32' ? 'shebang fake binaries do not execute on win32' : false

// A fake `claude` on PATH. It BLOCKS until stdin closes (so a caller that leaves stdin open
// hangs the test, the same discipline tests/harness-cursor.test.mjs uses for cursor-agent), then
// consumes ONE entry from a JSON array queue file (env FAKE_CLAUDE_QUEUE), writing that entry
// back with the consumed item removed so a second invocation sees the next one. Each invocation
// appends {argv, input, cwd} to FAKE_CLAUDE_LOG (JSONL) when set, so a test can assert how many
// times it ran and with what resume/session arguments. A queue entry shape:
//   { files: {relPath: content}, remove: [relPath], totalCostUsd, isError, result, sessionId, raw, exitCode,
//     permissionDenials: [{ tool_name, tool_use_id, tool_input }], numTurns }
// `permission_denials` is always printed (an empty array unless the entry sets one), matching the
// shape the first real replay recorded for a real `claude -p --output-format json` result.
// `files` are written into cwd, then `tryFiles` (the same, but a failed write is only logged to
// FAKE_CLAUDE_LOG + '.errors' instead of crashing), then `remove` entries are deleted, before the
// result is printed.
// `raw`, when present, is written to stdout VERBATIM instead of a constructed JSON object (used
// for the malformed-output case).
const FAKE_CLAUDE_SRC = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
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
  for (const [rel, content] of Object.entries(entry.files || {})) {
    const dest = path.join(process.cwd(), rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
  }
  for (const [rel, content] of Object.entries(entry.tryFiles || {})) {
    try {
      fs.writeFileSync(path.join(process.cwd(), rel), content)
    } catch (err) {
      if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG + '.errors', rel + ' ' + err.code + '\\n')
    }
  }
  for (const rel of entry.remove || []) {
    fs.rmSync(path.join(process.cwd(), rel), { force: true })
  }
  if (entry.raw !== undefined) {
    process.stdout.write(entry.raw)
  } else {
    const obj = {
      type: 'result', subtype: 'success', is_error: !!entry.isError,
      result: entry.result || '', session_id: entry.sessionId || 'sess-1',
      permission_denials: entry.permissionDenials || [],
    }
    if (entry.totalCostUsd !== undefined) obj.total_cost_usd = entry.totalCostUsd
    if (entry.numTurns !== undefined) obj.num_turns = entry.numTurns
    process.stdout.write(JSON.stringify(obj) + '\\n')
  }
  process.exit(entry.exitCode || 0)
})
process.stdin.resume()
`

let pathDir
let originalPath

before(async () => {
  pathDir = await mkdtemp(path.join(tmpdir(), 'fm-replay-fake-bin-'))
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

async function git(args, cwd) {
  const res = await defaultGitExec(args, cwd)
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr || res.stdout}`)
  return res.stdout
}

async function allRefShas(dir) {
  const res = await defaultGitExec(['for-each-ref', '--format=%(objectname) %(refname)'], dir)
  return res.stdout.trim().split('\n').filter(Boolean)
}

// Builds one fixture project: a git repo on `master` with a committed plan (including a `##
// Global Constraints` section, so buildReplayPrompt's extraction has something real to find), a
// `fleetmates.gate.json`, one task `T1` whose declared file is `DONE.txt`, a run branch, and a
// task branch that actually creates `DONE.txt`.
//
// By default (`mergeTaskIntoRun`/`mergeRunIntoMaster` both true) the fixture is fully LANDED —
// the task branch merged into the run branch (with a `--no-ff` merge subject naming the task id
// as a whole token, e.g. "Merge T1: <nonce>", the same shape locateTasks's merge-search looks
// for), the run branch merged into master, and exactly the shape that makes
// `merge-base(taskBranch, runBranch)` degenerate to the task's own tip (see `resolveBaseSha`'s own
// comment): master and the run branch both already contain DONE.txt after this, which is what the
// leakage test below exists to prove replay.mjs no longer exposes.
//
// `taskMergeSubject` overrides the task->run merge's commit message (for the three real-world
// message shapes fix round 2 was told to handle). `squashMergeIntoRun` replaces the `--no-ff`
// task->run merge with `git merge --squash` (no 2-parent commit at all — the shape a squash-merged
// task actually leaves behind). `deleteTaskBranch` removes the task branch's own ref after all
// merges are done, simulating `prune-run` — the caller then has ONLY git history to locate the
// task from, exactly the situation fix round 2 exists for.
async function buildFixtureRepo({
  dir, runId = 'r1', taskId = 'T1', briefNonce, phase = 1, gateConfig,
  mergeTaskIntoRun = true, mergeRunIntoMaster = true, taskMergeSubject, squashMergeIntoRun = false,
  deleteTaskBranch = false,
}) {
  await mkdir(dir, { recursive: true })
  await git(['init', '--quiet'], dir)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/master'], dir)
  await git(['config', 'user.email', 'fixture@example.com'], dir)
  await git(['config', 'user.name', 'Fixture'], dir)

  await mkdir(path.join(dir, 'docs'), { recursive: true })
  const planMd = [
    '# Fixture plan',
    '',
    '## Global Constraints',
    '',
    '- Node >= 24.2.0',
    '',
    `### Task 1: ${briefNonce}`,
    '',
    '**Files:**',
    '- Create: `DONE.txt`',
    '',
    `Write DONE.txt. Nonce: ${briefNonce}.`,
    '',
  ].join('\n')
  await writeFile(path.join(dir, 'docs', 'plan.md'), planMd, 'utf8')

  const defaultGateConfig = {
    phases: {
      default: {
        checks: [
          {
            name: 'done-marker',
            kind: 'command',
            run: `node -e "process.exit(require('fs').existsSync('DONE.txt') ? 0 : 1)"`,
          },
        ],
      },
    },
  }
  await writeFile(path.join(dir, 'fleetmates.gate.json'), JSON.stringify(gateConfig ?? defaultGateConfig, null, 2), 'utf8')
  await git(['add', '-A'], dir)
  await git(['commit', '--quiet', '-m', 'base'], dir)
  const baseSha = (await git(['rev-parse', 'HEAD'], dir)).trim()

  const runBranch = `run/${runId}`
  await git(['checkout', '--quiet', '-b', runBranch], dir)

  const taskBranch = taskBranchName(runId, taskId)
  await git(['checkout', '--quiet', '-b', taskBranch], dir)
  await writeFile(path.join(dir, 'DONE.txt'), 'DONE\n', 'utf8')
  await git(['add', '-A'], dir)
  await git(['commit', '--quiet', '-m', 'do the task'], dir)

  if (squashMergeIntoRun) {
    await git(['checkout', '--quiet', runBranch], dir)
    await git(['merge', '--squash', '--quiet', taskBranch], dir)
    await git(['commit', '--quiet', '-m', `squash merge ${taskId}`], dir)
  } else if (mergeTaskIntoRun) {
    await git(['checkout', '--quiet', runBranch], dir)
    await git(['merge', '--no-ff', '--quiet', '-m', taskMergeSubject ?? `Merge ${taskId}: ${briefNonce}`, taskBranch], dir)
  }
  if (mergeRunIntoMaster) {
    await git(['checkout', '--quiet', 'master'], dir)
    await git(['merge', '--no-ff', '--quiet', '-m', 'merge run', runBranch], dir)
  }
  await git(['checkout', '--quiet', 'master'], dir)
  if (deleteTaskBranch) {
    await git(['branch', '-D', taskBranch], dir)
  }

  const planState = {
    runId,
    totalPhases: 1,
    tasks: [{
      id: taskId,
      title: briefNonce,
      brief: `Write DONE.txt. Nonce: ${briefNonce}.`,
      files: ['DONE.txt'],
      deps: [],
      phase,
      tier: 'mid',
      tierSource: 'inferred',
    }],
    planPath: 'docs/plan.md',
    destination: '',
    notYetSpecified: [],
    outOfScope: [],
    runBranch,
  }
  await mkdir(path.join(dir, '.fleetmates', runId), { recursive: true })
  await writeFile(path.join(dir, '.fleetmates', runId, 'plan.json'), `${JSON.stringify(planState, null, 2)}\n`, 'utf8')

  return {
    root: dir, runId, taskId, baseSha, runBranch, taskBranch, planPath: 'docs/plan.md',
  }
}

async function writeQueue(queuePath, entries) {
  await writeFile(queuePath, JSON.stringify(entries), 'utf8')
}

function passingEntry({ totalCostUsd = 0.1, sessionId = 'sess-1' } = {}) {
  return { files: { 'DONE.txt': 'DONE\n' }, totalCostUsd, sessionId }
}

function failingEntry({ totalCostUsd = 0.05, sessionId = 'sess-1' } = {}) {
  return { files: { 'WRONG.txt': 'nope\n' }, totalCostUsd, sessionId }
}

// The one session `--execute` always spends first (the preflight): it creates the preflight
// file and reports no permission denial.
function preflightEntry() {
  return { files: { [PREFLIGHT_FILE]: 'ok\n' }, totalCostUsd: 0.01, sessionId: 'sess-preflight', numTurns: 2 }
}

function deniedEntry({ tools = ['Write'], sessionId = 'sess-1' } = {}) {
  return {
    files: {},
    totalCostUsd: 0.02,
    sessionId,
    numTurns: 1,
    result: 'File creation is pending your permission approval.',
    permissionDenials: tools.map((t, i) => ({ tool_name: t, tool_use_id: `tu-${i}`, tool_input: {} })),
  }
}

// ---------------------------------------------------------------------------------------------
// Finding A — answer leakage. A plain `git clone --local` copies every ref (the task's own
// solved branch, the run branch, a master that already contains the merged work), and the old
// `cli.mjs brief`-based prompt told the session to `git checkout -B` onto a base that could
// already hold the answer. `materializeBaseTree` + `buildReplayPrompt` replace both.
// ---------------------------------------------------------------------------------------------

test('materializeBaseTree: a fully-landed fixture leaves no ref, reflog or object containing the task output', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-leak-'))
  // mergeTaskIntoRun/mergeRunIntoMaster both true (the default): master's CURRENT tip already
  // contains DONE.txt, exactly the shape the finding describes.
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'leak-check' })
  const masterDone = await defaultGitExec(['show', 'master:DONE.txt'], fixture.root)
  assert.equal(masterDone.code, 0, 'sanity: master really does contain DONE.txt in this fixture')

  const baseSha = await resolveBaseSha({ root: fixture.root, runId: fixture.runId, taskId: fixture.taskId })
  assert.equal(baseSha, fixture.baseSha, 'the resolved base predates the task entirely')

  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const { cloneDir } = await materializeBaseTree({ root: fixture.root, baseSha, tmpRoot })

  const refs = await allRefShas(cloneDir)
  assert.equal(refs.length, 1, 'exactly one ref: the single commit this function creates')

  const log = (await defaultGitExec(['log', '--all', '--oneline'], cloneDir)).stdout.trim().split('\n').filter(Boolean)
  assert.equal(log.length, 1, 'exactly one commit reachable from anywhere in the materialized repo')

  for (const line of refs) {
    const [sha] = line.split(' ')
    const catFile = await defaultGitExec(['cat-file', '-e', `${sha}:DONE.txt`], cloneDir)
    assert.notEqual(catFile.code, 0, `DONE.txt must not be reachable from ${line}`)
  }
  await assert.rejects(readFile(path.join(cloneDir, 'DONE.txt')), 'DONE.txt is not even in the working tree')

  const remotes = (await defaultGitExec(['remote'], cloneDir)).stdout.trim()
  assert.equal(remotes, '', 'no remote points back at the source repo')

  await removeClone(cloneDir)
  await rm(scratch, { recursive: true, force: true })
})

test('buildReplayPrompt: contains no checkout-to-branch, locate or complete instruction', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-prompt-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'prompt-check' })
  const baseSha = await resolveBaseSha({ root: fixture.root, runId: fixture.runId, taskId: fixture.taskId })
  const markdown = await planMarkdownAtBase({ root: fixture.root, baseSha, planPath: fixture.planPath })
  const prompt = buildReplayPrompt({ markdown, taskId: fixture.taskId })

  assert.ok(prompt.includes('prompt-check'), 'sanity: the real task text made it into the prompt')
  assert.ok(prompt.includes('Node >= 24.2.0'), 'the Global Constraints section made it into the prompt')
  assert.ok(prompt.includes('DONE.txt'), 'the declared file is named')
  assert.ok(!/checkout\s+-B/.test(prompt), 'no branch checkout instruction')
  assert.ok(!prompt.includes('locate --run'), 'no locate instruction')
  assert.ok(!prompt.includes('complete --run'), 'no completion-command instruction')
  assert.ok(!prompt.includes(fixture.root), 'no absolute path from this machine')
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Finding G — base resolution must use the task branch's own reflog, not
// merge-base(taskBranch, runBranch): once the task branch is merged into the run branch (which
// every fixture here now is, by default), the task branch becomes an ANCESTOR of the run branch,
// and merge-base of an ancestor and its descendant is the ancestor itself — the task's own
// FINISHED commit, not what it started from.
// ---------------------------------------------------------------------------------------------

test('resolveBaseSha: recovers the true fork point, not the run branch tip and not the task branch tip', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-basesha-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'base-sha' })
  const runTip = (await git(['rev-parse', fixture.runBranch], fixture.root)).trim()
  const taskTip = (await git(['rev-parse', fixture.taskBranch], fixture.root)).trim()
  // The naive formula this replaces: confirmed directly that it lands on the task's own tip.
  const naiveMergeBase = (await git(['merge-base', fixture.taskBranch, fixture.runBranch], fixture.root)).trim()
  assert.equal(naiveMergeBase, taskTip, 'sanity: plain merge-base really does degenerate to the task tip once merged')

  const sha = await resolveBaseSha({ root: fixture.root, runId: fixture.runId, taskId: fixture.taskId })
  assert.equal(sha, fixture.baseSha)
  assert.notEqual(sha, runTip)
  assert.notEqual(sha, taskTip)

  const missing = await resolveBaseSha({ root: fixture.root, runId: fixture.runId, taskId: 'T-nonexistent' })
  assert.equal(missing, null)
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Step 1 — cell outcomes, via the fake `claude` binary.
// ---------------------------------------------------------------------------------------------

test('runTierCell: a cell that succeeds on the first attempt records pass and a real cost', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'cell-success' })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [passingEntry({ totalCostUsd: 0.42 })])
  const logPath = path.join(scratch, 'log.jsonl')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })

  assert.equal(cell.usageLimit, false)
  assert.equal(cell.status, 'pass')
  assert.equal(cell.totalCostUsd, 0.42)
  assert.equal(cell.costMissing, false)
  assert.equal(cell.fixRound, false)
  assert.ok(cell.wallClockMs >= 0)

  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(calls.length, 1, 'a passing first attempt needs no fix round')

  // Finding F: the clone (and its sibling .tar) must not survive the cell.
  assert.deepEqual(await readdir(tmpRoot), [], 'tmpRoot is empty once the cell finishes')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a gate failure is followed by exactly one fix round, which can still pass', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'fix-round' })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [
    failingEntry({ totalCostUsd: 0.1 }),
    // The fix round both writes the declared file AND removes the undeclared one the first
    // attempt left behind — a real fix undoes its own mess, not just adds on top of it.
    { files: { 'DONE.txt': 'DONE\n' }, remove: ['WRONG.txt'], totalCostUsd: 0.2, sessionId: 'sess-1' },
  ])
  const logPath = path.join(scratch, 'log.jsonl')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })

  assert.equal(cell.status, 'pass')
  assert.equal(cell.fixRound, true)
  // Fix-round cost is included, per "Cost measurement": the fix round's cost is counted.
  assert.ok(Math.abs(cell.totalCostUsd - 0.3) < 1e-9)

  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(calls.length, 2)
  assert.ok(calls[1].argv.includes('--resume'), 'the fix round resumes the same session')
  assert.ok(calls[1].argv.includes('sess-1'))
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: an undeclared file left behind after the fix round still fails the fileset check', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'leftover-file' })
  const queuePath = path.join(scratch, 'queue.json')
  // The fix round writes the declared file (the gate's own command check would now pass) but
  // never removes WRONG.txt from the first attempt — an untracked file, which `git diff` alone
  // (without first staging it) would never see. The cell must still fail.
  await writeQueue(queuePath, [
    failingEntry({ totalCostUsd: 0.1 }),
    passingEntry({ totalCostUsd: 0.2, sessionId: 'sess-1' }),
  ])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.status, 'fail')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a tier that fails both the first attempt and the fix round is recorded as failed', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'unresolved' })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [failingEntry({ totalCostUsd: 0.1 }), failingEntry({ totalCostUsd: 0.1 })])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.status, 'fail')
  assert.equal(cell.fixRound, true)
  assert.deepEqual(await readdir(tmpRoot), [], 'tmpRoot is empty even on a failed cell')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a usage-limit error stops the cell cleanly with no result', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'usage-limit' })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [{
    files: {}, isError: true, result: 'Claude AI usage limit reached. Try again later.', totalCostUsd: 0.01,
  }])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.usageLimit, true)
  assert.equal(cell.status, undefined)
  assert.deepEqual(await readdir(tmpRoot), [], 'tmpRoot is empty even after a usage-limit stop')
  await rm(scratch, { recursive: true, force: true })
})

// Finding H — a usage limit on the FIX ROUND (attempt 2), not just the first attempt: a
// separate code path (`attempt2.parsed.usageLimit`) that nothing exercised before.
test('runTierCell: a usage-limit error on the fix round (attempt 2) also stops the cell with no result', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'usage-limit-fix-round' })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [
    failingEntry({ totalCostUsd: 0.1 }),
    { files: {}, isError: true, result: 'usage limit reached', totalCostUsd: 0.02, sessionId: 'sess-1' },
  ])
  const logPath = path.join(scratch, 'log.jsonl')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })

  assert.equal(cell.usageLimit, true)
  assert.equal(cell.status, undefined)
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(calls.length, 2, 'both the first attempt and the fix round ran before the limit hit')
  assert.deepEqual(await readdir(tmpRoot), [], 'tmpRoot is empty even after a fix-round usage-limit stop')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: malformed JSON output fails the cell without a fix round and without a cost', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'malformed' })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [{ raw: 'this is not json at all\n' }])
  const logPath = path.join(scratch, 'log.jsonl')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })

  assert.equal(cell.status, 'fail')
  assert.equal(cell.costMissing, true)
  assert.equal(cell.totalCostUsd, null)
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  // No session id could be read from malformed output, so there is nothing to resume: exactly
  // one attempt, not two.
  assert.equal(calls.length, 1)
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a missing total_cost_usd is recorded as missing, never as 0', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'missing-cost' })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [{ files: { 'DONE.txt': 'DONE\n' }, sessionId: 'sess-1' }])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.status, 'pass')
  assert.equal(cell.costMissing, true)
  assert.equal(cell.totalCostUsd, null)
  assert.notEqual(cell.totalCostUsd, 0)
  await rm(scratch, { recursive: true, force: true })
})

test('parseClaudeOutput: distinguishes malformed output, missing cost and a usage-limit error', () => {
  assert.equal(parseClaudeOutput('not json').malformed, true)
  assert.equal(parseClaudeOutput('[]').malformed, true)
  const ok = parseClaudeOutput(JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's1', total_cost_usd: 0.5 }))
  assert.equal(ok.malformed, false)
  assert.equal(ok.totalCostUsd, 0.5)
  assert.equal(ok.costMissing, false)
  const missing = parseClaudeOutput(JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's1' }))
  assert.equal(missing.costMissing, true)
  assert.equal(missing.totalCostUsd, null)
  const limited = parseClaudeOutput(JSON.stringify({ type: 'result', is_error: true, result: 'Usage limit reached, try again at 3pm.' }))
  assert.equal(limited.usageLimit, true)
  const ordinaryError = parseClaudeOutput(JSON.stringify({ type: 'result', is_error: true, result: 'something else went wrong' }))
  assert.equal(ordinaryError.usageLimit, false)
})

// ---------------------------------------------------------------------------------------------
// Finding B — a no-op session (changes nothing, or changes only undeclared files) must not pass,
// even when the gate's own command checks do not depend on the declared files at all.
// ---------------------------------------------------------------------------------------------

test('runTierCell: a no-op session fails even when the gate command check would trivially pass', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-noop-'))
  // A gate manifest whose only check passes unconditionally — nothing here is watching for
  // DONE.txt, so only the "no declared file changed" rule can catch a no-op.
  const gateConfig = {
    phases: { default: { checks: [{ name: 'always-pass', kind: 'command', run: 'node -e "process.exit(0)"' }] } },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'noop', gateConfig })
  const queuePath = path.join(scratch, 'queue.json')
  // The queue entry writes and removes nothing at all: a genuine no-op turn.
  await writeQueue(queuePath, [{ totalCostUsd: 0.1, sessionId: 'sess-1' }, { totalCostUsd: 0.1, sessionId: 'sess-1' }])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do nothing',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.status, 'fail')
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Finding C — grading uses the TASK's own phase, read from the gate manifest as committed at the
// base commit, not a hardcoded 'default'.
// ---------------------------------------------------------------------------------------------

test('runTierCell: a phase-specific check (not "default") grades the cell', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-phase-'))
  const gateConfig = {
    phases: {
      default: { checks: [{ name: 'always-pass', kind: 'command', run: 'node -e "process.exit(0)"' }] },
      // Phase "1" always fails, regardless of what the session did — if the tool ever fell back
      // to 'default' for a phase-1 task, this cell would incorrectly read as a pass.
      1: { checks: [{ name: 'always-fail', kind: 'command', run: 'node -e "process.exit(1)"' }] },
    },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'phase-check', phase: 1, gateConfig })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [passingEntry({ totalCostUsd: 0.1 }), passingEntry({ totalCostUsd: 0.1 })])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.status, 'fail', 'phase 1 always-fail must be the check used, not default')
  await rm(scratch, { recursive: true, force: true })
})

// Tests-lens duplicate named in the finding: the existing fix-round test above only exercises a
// FILESET failure. This one's only failure is a command check, with the fileset clean throughout.
test('runTierCell: a fix round recovers from a command-check-only failure (fileset stays clean)', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-cmdonly-'))
  const gateConfig = {
    phases: {
      default: {
        checks: [{
          name: 'content-check',
          kind: 'command',
          run: `node -e "process.exit(require('fs').readFileSync('DONE.txt','utf8').trim()==='DONE' ? 0 : 1)"`,
        }],
      },
    },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'cmd-only-fix', gateConfig })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [
    // Declares DONE.txt (fileset is clean) but with the WRONG content, so only the command check fails.
    { files: { 'DONE.txt': 'WRONG CONTENT\n' }, totalCostUsd: 0.1, sessionId: 'sess-1' },
    { files: { 'DONE.txt': 'DONE\n' }, totalCostUsd: 0.1, sessionId: 'sess-1' },
  ])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.status, 'pass')
  assert.equal(cell.fixRound, true)
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Finding D (round 1) — the manifest's `preview.link` entries (e.g. node_modules) are made
// available inside the cell from the source repo, under the same safety rules the gate's merge
// preview applies. Round 1 did this with a symlink. Fix round 3, below, replaces the symlink with
// a copy: a symlink from the cell into the source repo's own directory has no cwd confinement — a
// `claude -p` session is an ordinary process with the user's own permissions — so a write through
// the link reaches the SOURCE repo for real, and `realpath` on the link resolves straight into
// it, exposing whatever sits next to it (including the source repo's own `.git`).
// ---------------------------------------------------------------------------------------------

test('runTierCell: preview.link makes a gitignored dependency available to gate checks', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-link-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: {
      default: {
        checks: [
          {
            name: 'has-dep',
            kind: 'command',
            run: `node -e "process.exit(require('fs').existsSync('node_modules/some-pkg/index.js') ? 0 : 1)"`,
          },
          { name: 'done-marker', kind: 'command', run: `node -e "process.exit(require('fs').existsSync('DONE.txt') ? 0 : 1)"` },
        ],
      },
    },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'preview-link', gateConfig })
  // Never committed — exactly the gitignored, npm-installed shape preview.link exists for.
  await mkdir(path.join(fixture.root, 'node_modules', 'some-pkg'), { recursive: true })
  await writeFile(path.join(fixture.root, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1\n', 'utf8')

  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [passingEntry({ totalCostUsd: 0.1 })])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.status, 'pass', 'without the link, has-dep would fail and so would this cell')
  assert.deepEqual(await readdir(tmpRoot), [], 'the link is torn down along with the clone')
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Fix round 3, finding 1 (MEDIUM, security) — `preview.link` write-through. Reproduced before this
// fix: a session wrote to `node_modules/dep/index.js` through the symlink and the change survived
// teardown, landing in the SOURCE repo's real file; `realpath(cell/node_modules)/../.git/refs/heads`
// also resolved into the source repo, exposing its solved branches. `copyPreviewPaths` replaces
// the symlink with a real, independent copy.
// ---------------------------------------------------------------------------------------------

test('copyPreviewPaths: no path under the cell resolves, via realpath, into the source repo', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-realpath-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(path.join(sourceRoot, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'node_modules', 'dep', 'index.js'), 'original\n', 'utf8')

  const cellDir = path.join(scratch, 'cell')
  await mkdir(cellDir, { recursive: true })
  const teardown = await copyPreviewPaths(cellDir, sourceRoot, ['node_modules'])

  const realCell = await realpath(cellDir)
  const realCopied = await realpath(path.join(cellDir, 'node_modules'))
  const realSource = await realpath(path.join(sourceRoot, 'node_modules'))
  assert.notEqual(realCopied, realSource, 'the copied node_modules is not the source repo\'s own directory')
  assert.equal(path.dirname(realCopied), realCell, 'the copy resolves to a path directly under the cell, not elsewhere')
  // The exact escape reproduced: realpath(cell/node_modules)/../.git must land in the CELL, if
  // anywhere, never back in the source repo.
  assert.notEqual(path.resolve(realCopied, '..', '.git'), path.resolve(sourceRoot, '.git'))

  await teardown()
  await assert.rejects(stat(path.join(cellDir, 'node_modules')), 'the copy is removed afterwards')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a session write under the copied preview.link directory never reaches the source repo', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-writethrough-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: {
      default: {
        checks: [{ name: 'done-marker', kind: 'command', run: `node -e "process.exit(require('fs').existsSync('DONE.txt') ? 0 : 1)"` }],
      },
    },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'copy-writethrough', gateConfig })
  await mkdir(path.join(fixture.root, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(fixture.root, 'node_modules', 'dep', 'index.js'), 'original\n', 'utf8')

  const queuePath = path.join(scratch, 'queue.json')
  // The session's own queue entry writes DONE.txt (declared) AND, separately, mutates the linked
  // dependency file — exactly the write the old symlink let through to the source repo for real.
  // `tryFiles`: the copy is read-only now (see the read-only tests below), so the write is refused
  // rather than crashing the fake session.
  await writeQueue(queuePath, [{
    files: { 'DONE.txt': 'DONE\n' },
    tryFiles: { 'node_modules/dep/index.js': 'mutated by the session\n' },
    totalCostUsd: 0.1,
  }])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath },
  })

  assert.equal(cell.status, 'pass')
  const sourceContent = await readFile(path.join(fixture.root, 'node_modules', 'dep', 'index.js'), 'utf8')
  assert.equal(sourceContent, 'original\n', 'the source repo\'s own dependency file is untouched by the session\'s write')
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Gate retry round 1, HIGH H1 — copyPreviewPaths validated `realTarget` but copied `target`
// (unresolved). `cp -a` and `fs.cp({ verbatimSymlinks: true })` both copy a top-level symlink
// argument AS a symlink, so a manifest entry that is itself a symlink (in-repo, e.g. pnpm's own
// store layout) landed in the cell as a symlink pointing straight back into the source repo —
// the exact write-through door the copy was supposed to close, reopened by a different top-level
// shape than the plain-directory case round 3 tested. Reproduced directly before this fix: writing
// cell/node_modules/dep/index.js changed the SOURCE file, for both an absolute and a relative
// in-repo symlink target.
// ---------------------------------------------------------------------------------------------

test('copyPreviewPaths: an ABSOLUTE in-repo symlink entry copies a real directory, not a symlink back to the source', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-abssym-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(path.join(sourceRoot, 'store', 'nm', 'dep'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'store', 'nm', 'dep', 'index.js'), 'original\n', 'utf8')
  // node_modules -> <abs>/source/store/nm — an ABSOLUTE, in-repo symlink.
  await symlink(path.join(sourceRoot, 'store', 'nm'), path.join(sourceRoot, 'node_modules'))

  const cellDir = path.join(scratch, 'cell')
  await mkdir(cellDir, { recursive: true })
  const teardown = await copyPreviewPaths(cellDir, sourceRoot, ['node_modules'])

  const info = await stat(path.join(cellDir, 'node_modules'))
  assert.ok(info.isDirectory())
  // lstat, not stat: confirms the top-level entry itself is a REAL directory in the cell, not
  // still a symlink (which stat() would also happily follow and report as "a directory").
  const linkInfo = await lstat(path.join(cellDir, 'node_modules'))
  assert.ok(!linkInfo.isSymbolicLink(), 'the top-level entry is a real directory, not a symlink')

  // The copy is read-only; chmod follows a symlink, so a copy that were still a symlink back into
  // the source would make the source file writable too and the write below would reach it.
  await chmod(path.join(cellDir, 'node_modules', 'dep', 'index.js'), 0o644)
  await writeFile(path.join(cellDir, 'node_modules', 'dep', 'index.js'), 'mutated\n', 'utf8')
  const sourceContent = await readFile(path.join(sourceRoot, 'store', 'nm', 'dep', 'index.js'), 'utf8')
  assert.equal(sourceContent, 'original\n', 'a write through the copy does not reach the source repo')

  await teardown()
  await rm(scratch, { recursive: true, force: true })
})

test('copyPreviewPaths: a RELATIVE in-repo symlink entry copies a real directory, not a symlink back to the source', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-relsym-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(path.join(sourceRoot, 'store', 'nm', 'dep'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'store', 'nm', 'dep', 'index.js'), 'original\n', 'utf8')
  // node_modules -> store/nm — a RELATIVE, in-repo symlink (resolved from node_modules' own
  // parent directory, i.e. the repo root, per POSIX symlink semantics).
  await symlink('store/nm', path.join(sourceRoot, 'node_modules'))

  const cellDir = path.join(scratch, 'cell')
  await mkdir(cellDir, { recursive: true })
  const teardown = await copyPreviewPaths(cellDir, sourceRoot, ['node_modules'])

  const linkInfo = await lstat(path.join(cellDir, 'node_modules'))
  assert.ok(!linkInfo.isSymbolicLink(), 'the top-level entry is a real directory, not a dangling relative symlink')

  // The copy is read-only; chmod follows a symlink, so a copy that were still a symlink back into
  // the source would make the source file writable too and the write below would reach it.
  await chmod(path.join(cellDir, 'node_modules', 'dep', 'index.js'), 0o644)
  await writeFile(path.join(cellDir, 'node_modules', 'dep', 'index.js'), 'mutated\n', 'utf8')
  const sourceContent = await readFile(path.join(sourceRoot, 'store', 'nm', 'dep', 'index.js'), 'utf8')
  assert.equal(sourceContent, 'original\n', 'a write through the copy does not reach the source repo')

  await teardown()
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Gate retry round 1, HIGH H2 — none of copyPreviewPaths' four refusals had a test: turning the
// outside-repo guard into `if (false)` left `npm test` green. One test per refusal.
// ---------------------------------------------------------------------------------------------

test('copyPreviewPaths: refuses an entry whose target resolves outside the repository, and copies nothing', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-outsiderepo-'))
  const sourceRoot = path.join(scratch, 'source')
  const outside = path.join(scratch, 'outside-the-repo')
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, 'secret.txt'), 'not part of the repo\n', 'utf8')
  await mkdir(sourceRoot, { recursive: true })
  // node_modules -> an absolute directory OUTSIDE the repo entirely.
  await symlink(outside, path.join(sourceRoot, 'node_modules'))

  const cellDir = path.join(scratch, 'cell')
  await mkdir(cellDir, { recursive: true })
  await assert.rejects(
    copyPreviewPaths(cellDir, sourceRoot, ['node_modules']),
    /resolves outside the repository/,
  )
  assert.deepEqual(await readdir(cellDir), [], 'nothing was copied into the cell')
  await rm(scratch, { recursive: true, force: true })
})

test('copyPreviewPaths: refuses an entry that is not a directory', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-notdir-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(sourceRoot, { recursive: true })
  await writeFile(path.join(sourceRoot, 'node_modules'), 'this is a file, not a directory\n', 'utf8')

  const cellDir = path.join(scratch, 'cell')
  await mkdir(cellDir, { recursive: true })
  await assert.rejects(
    copyPreviewPaths(cellDir, sourceRoot, ['node_modules']),
    /not a directory/,
  )
  assert.deepEqual(await readdir(cellDir), [], 'nothing was copied into the cell')
  await rm(scratch, { recursive: true, force: true })
})

test('copyPreviewPaths: refuses an entry whose destination would land outside the cell', async () => {
  // `dir` and `repoRoot` as SIBLINGS under the same parent: an entry of '../repo/shared/nm'
  // resolves back INSIDE repoRoot (repoRoot/../repo/shared/nm === repoRoot/shared/nm, since
  // repoRoot's own directory is itself named 'repo') but resolves OUTSIDE `dir` (dir/../repo/...
  // lands in dir's sibling, not inside dir) — exactly the asymmetry a `..`-laden entry can
  // produce when the two bases are not the same directory.
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-outsidecell-'))
  const outer = path.join(scratch, 'outer')
  const repoRoot = path.join(outer, 'repo')
  const cellDir = path.join(outer, 'cell')
  await mkdir(path.join(repoRoot, 'shared', 'nm'), { recursive: true })
  await mkdir(cellDir, { recursive: true })

  const entry = '../repo/shared/nm'
  await assert.rejects(
    copyPreviewPaths(cellDir, repoRoot, [entry]),
    /would be copied outside the preview tree/,
  )
  assert.deepEqual(await readdir(cellDir), [], 'nothing was copied into the cell')
  await rm(scratch, { recursive: true, force: true })
})

test('copyPreviewPaths: refuses an entry already present in the materialized tree', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-exists-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(path.join(sourceRoot, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'node_modules', 'dep', 'index.js'), 'dependency\n', 'utf8')

  const cellDir = path.join(scratch, 'cell')
  // Something already tracked/materialized at the same path — copying over it would shadow it.
  await mkdir(path.join(cellDir, 'node_modules'), { recursive: true })
  await writeFile(path.join(cellDir, 'node_modules', 'TRACKED.txt'), 'already here\n', 'utf8')

  await assert.rejects(
    copyPreviewPaths(cellDir, sourceRoot, ['node_modules']),
    /already present in the materialized/,
  )
  const stillThere = await readFile(path.join(cellDir, 'node_modules', 'TRACKED.txt'), 'utf8')
  assert.equal(stillThere, 'already here\n', 'the refusal leaves the already-present path untouched')
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Gate retry round 1, MEDIUM M1 — the destination check compared the UNRESOLVED
// `dst = path.resolve(dir, entry)` against `realpath(dir)`. Under a symlinked tmp root (macOS's
// default /var -> /private/var, or a symlinked TMPDIR), every entry failed that comparison and
// runTierCell's old catch-and-continue then graded the cell without its dependencies, silently.
// Both are fixed here: `dst` is now built from the resolved root throughout, and a genuine
// copyPreviewPaths failure now fails the CELL, visibly, instead of being swallowed.
// ---------------------------------------------------------------------------------------------

test('copyPreviewPaths: a symlinked destination root does not make every entry refuse as "outside the preview tree"', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-symtmp-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(path.join(sourceRoot, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'node_modules', 'dep', 'index.js'), 'dependency\n', 'utf8')

  const realCellParent = path.join(scratch, 'real-tmp')
  await mkdir(realCellParent, { recursive: true })
  const symlinkedCellParent = path.join(scratch, 'tmp-link')
  await symlink(realCellParent, symlinkedCellParent)
  // The cell itself is reached ONLY through the symlinked path — exactly the macOS /var shape.
  const cellDir = path.join(symlinkedCellParent, 'cell')
  await mkdir(cellDir, { recursive: true })

  const teardown = await copyPreviewPaths(cellDir, sourceRoot, ['node_modules'])
  const copied = await readFile(path.join(cellDir, 'node_modules', 'dep', 'index.js'), 'utf8')
  assert.equal(copied, 'dependency\n', 'the entry copied successfully through the symlinked destination root')
  await teardown()
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a preview.link copy failure fails the cell visibly, instead of grading it without dependencies', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-visible-fail-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: {
      default: {
        checks: [{
          name: 'has-dep',
          kind: 'command',
          run: `node -e "process.exit(require('fs').existsSync('node_modules/dep/index.js') ? 0 : 1)"`,
        }],
      },
    },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'copy-visible-fail', gateConfig })
  // node_modules resolves OUTSIDE the repo — the same refusal H2 tests directly, but exercised
  // through the full runTierCell pipeline this time.
  const outside = path.join(scratch, 'outside-the-repo')
  await mkdir(outside, { recursive: true })
  await symlink(outside, path.join(fixture.root, 'node_modules'))

  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [passingEntry({ totalCostUsd: 0.1 })])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const logPath = path.join(scratch, 'log.jsonl')

  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles: ['DONE.txt'],
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })

  assert.equal(cell.status, 'invalid', 'the cell is invalid rather than silently graded without its dependency')
  assert.ok(cell.previewLinkError, 'the failure reason is surfaced, not swallowed')
  assert.ok(cell.previewLinkError.includes('outside the repository'))
  const calls = await readFile(logPath, 'utf8').catch(() => '')
  assert.equal(calls, '', 'claude was never even invoked — the cell failed before any attempt')
  await rm(scratch, { recursive: true, force: true })
})

test('directoryByteSize / main --dry-run: prints the total bytes that will be copied per cell', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-bytes-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: { default: { checks: [] } },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'byte-count', gateConfig })
  const depContent = 'x'.repeat(1000)
  await mkdir(path.join(fixture.root, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(fixture.root, 'node_modules', 'dep', 'index.js'), depContent, 'utf8')

  const directSize = await directoryByteSize(path.join(fixture.root, 'node_modules'))
  assert.ok(directSize >= 1000, 'directoryByteSize sees the real file on disk')

  const messages = []
  const io = { out: (s) => messages.push(s) }
  const code = await main(['--roots', fixture.root, '--count', '1', '--dry-run'], io)
  assert.equal(code, 0)
  const sampleLine = messages.find((m) => m.includes('preview-copy-bytes='))
  assert.ok(sampleLine, 'a sampled task line reports preview-copy-bytes')
  const reported = Number(sampleLine.match(/preview-copy-bytes=(\d+)/)[1])
  assert.ok(reported >= 1000, `expected the reported bytes (${reported}) to include the ~1000-byte dependency file`)
  await rm(scratch, { recursive: true, force: true })
})

// Gate retry round 1, round-3 low test gap (:1060) — the manifest is read at the task's own
// resolved BASE, never the source repo's current HEAD, which may have moved on since.
test('main --dry-run: preview-copy-bytes reads the gate manifest at the task\'s BASE, not the repo\'s current HEAD', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-bytesatbase-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: { default: { checks: [] } },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'bytes-at-base', gateConfig })
  await mkdir(path.join(fixture.root, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(fixture.root, 'node_modules', 'dep', 'index.js'), 'x'.repeat(1000), 'utf8')
  // A SECOND, much bigger directory that only HEAD's manifest declares — not the task's own base.
  await mkdir(path.join(fixture.root, 'vendor', 'big'), { recursive: true })
  await writeFile(path.join(fixture.root, 'vendor', 'big', 'data.bin'), 'y'.repeat(50000), 'utf8')

  // Simulates the manifest evolving on master AFTER this task already landed: HEAD now declares
  // BOTH directories, but the task's own resolved base still only ever declared node_modules.
  await writeFile(
    path.join(fixture.root, 'fleetmates.gate.json'),
    JSON.stringify({ preview: { link: ['node_modules', 'vendor'] }, phases: { default: { checks: [] } } }, null, 2),
    'utf8',
  )
  await git(['add', '-A'], fixture.root)
  await git(['commit', '--quiet', '-m', 'manifest grew after this task landed'], fixture.root)

  const messages = []
  const io = { out: (s) => messages.push(s) }
  const code = await main(['--roots', fixture.root, '--count', '1', '--dry-run'], io)
  assert.equal(code, 0)
  const sampleLine = messages.find((m) => m.includes('preview-copy-bytes='))
  const reported = Number(sampleLine.match(/preview-copy-bytes=(\d+)/)[1])
  assert.ok(reported < 50000, `expected only the base's node_modules (~1000 bytes), not HEAD's added vendor/ (~50000 bytes) too — got ${reported}`)
  assert.ok(reported >= 1000)
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Finding E (round 1) — only LANDED tasks are selected. Superseded in fix round 2: `prune-run`
// deletes a task's own branch once its run integrates, so on a real fleet history the branch is
// gone by the time this tool runs, and a scheme that depends on it existing (the old
// `filterLandedTasks`) finds nothing — measured directly: `git for-each-ref refs/heads/fleetmates/*`
// returns 0 branches in every repo with fleet runs on this machine. `locateTasks` replaces it: the
// reflog path is still tried first, but is only accepted once the branch itself is confirmed
// landed (an ancestor of the default branch, not merely present) — so a live-but-never-merged
// branch is excluded exactly as `filterLandedTasks` excluded it — and a task whose branch is gone
// falls back to locating its integration merge directly in the default branch's history.
// ---------------------------------------------------------------------------------------------

test('locateTasks: excludes a pending task (live, never-merged branch) and a task on an unlanded run', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-landed-'))
  const landed = await buildFixtureRepo({
    dir: path.join(scratch, 'landed'), runId: 'r1', taskId: 'T1', briefNonce: 'landed-task',
    mergeTaskIntoRun: true, mergeRunIntoMaster: true,
  })
  const pending = await buildFixtureRepo({
    dir: path.join(scratch, 'pending'), runId: 'r2', taskId: 'T1', briefNonce: 'pending-task',
    mergeTaskIntoRun: false, mergeRunIntoMaster: false,
  })
  const unlandedRun = await buildFixtureRepo({
    dir: path.join(scratch, 'unlanded'), runId: 'r3', taskId: 'T1', briefNonce: 'unlanded-run',
    mergeTaskIntoRun: true, mergeRunIntoMaster: false,
  })

  const plans = await listRunPlans([landed.root, pending.root, unlandedRun.root])
  const pool = poolFromPlans(plans)
  assert.equal(pool.length, 3, 'sanity: all three tasks are in the merged pool before locating')

  const result = await locateTasks(pool)
  assert.equal(result.length, 3, 'every pooled task is reported, located or not')
  const located = result.filter((r) => r.located)
  assert.equal(located.length, 1)
  assert.equal(located[0].root, landed.root)
  assert.equal(located[0].method, 'reflog')
  const unlocatable = result.filter((r) => !r.located)
  assert.equal(unlocatable.length, 2)
  for (const r of unlocatable) assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
  await rm(scratch, { recursive: true, force: true })
})

test('main --dry-run: a pending task from an in-progress run is never selected', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-drypending-'))
  const pending = await buildFixtureRepo({
    dir: path.join(scratch, 'proj'), briefNonce: 'still-in-progress', mergeTaskIntoRun: false, mergeRunIntoMaster: false,
  })
  const messages = []
  const io = { out: (s) => messages.push(s) }
  const code = await main(['--roots', pending.root, '--count', '30', '--dry-run'], io)
  assert.equal(code, 0)
  assert.ok(messages[0].startsWith('dry run: 0 task(s) located'))
  assert.ok(messages.some((m) => m.includes('1 unlocatable')))
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Fix round 2 — the replay pool was EMPTY on a real machine because `prune-run` deletes a task's
// branch after its run integrates, and both the reflog-based base resolution and the old
// branch-ancestry `filterLandedTasks` depended on that branch still existing. `locateTasks` now
// falls back to locating the task's integration merge directly in the default branch's history
// when the branch is gone. Each test below deletes the task branch first — `buildFixtureRepo`'s
// own `deleteTaskBranch` option — so only git history, never a branch ref, is available to locate
// the task from.
// ---------------------------------------------------------------------------------------------

test('locateTasks: a deleted task branch resolves the same base the reflog path would have', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-mergefallback-'))
  const fixture = await buildFixtureRepo({
    dir: path.join(scratch, 'proj'), runId: 'r1', taskId: 'T1', briefNonce: 'merge-fallback',
    mergeTaskIntoRun: true, mergeRunIntoMaster: true,
  })
  // Ground truth, captured BEFORE the branch is deleted: what the reflog path would have resolved.
  const expectedBase = await resolveBaseSha({ root: fixture.root, runId: fixture.runId, taskId: fixture.taskId })
  assert.equal(expectedBase, fixture.baseSha, 'sanity: the reflog path resolves the true base before deletion')

  await git(['branch', '-D', fixture.taskBranch], fixture.root)
  const afterDelete = await resolveBaseSha({ root: fixture.root, runId: fixture.runId, taskId: fixture.taskId })
  assert.equal(afterDelete, null, 'sanity: the reflog path really does find nothing once the branch is gone')

  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const [result] = await locateTasks(pool)
  assert.equal(result.located, true)
  assert.equal(result.method, 'merge')
  assert.equal(result.baseSha, expectedBase, 'the merge-search fallback resolves the SAME base the reflog path found')
  await rm(scratch, { recursive: true, force: true })
})

test('locateTasks: recognizes all three real-world integration-merge message shapes', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-shapes-'))
  // `merge(<run>)` names the run it belongs to, so that shape's fixture run is called "portals": a
  // subject naming a different run is rejected (see the mto-followups step 3 tests below).
  const shapes = [
    { taskId: 'T6', subject: 'Merge T6: the crafting planner' },
    { taskId: 'T5', subject: 'merge(portals): T5 wire portals into settings', runId: 'portals' },
    { taskId: 'T3', subject: "Merge branch 'teammates/reporting/T3' into reporting-integri" },
  ]
  for (const [i, shape] of shapes.entries()) {
    const fixture = await buildFixtureRepo({
      dir: path.join(scratch, `proj${i}`), runId: shape.runId ?? `r${i}`, taskId: shape.taskId, briefNonce: `shape-${i}`,
      taskMergeSubject: shape.subject, mergeTaskIntoRun: true, mergeRunIntoMaster: true,
    })
    const expectedBase = await resolveBaseSha({ root: fixture.root, runId: fixture.runId, taskId: fixture.taskId })
    await git(['branch', '-D', fixture.taskBranch], fixture.root)

    const plans = await listRunPlans([fixture.root])
    const pool = poolFromPlans(plans)
    const [result] = await locateTasks(pool)
    assert.equal(result.located, true, `shape "${shape.subject}" must be located`)
    assert.equal(result.method, 'merge')
    assert.equal(result.baseSha, expectedBase, `shape "${shape.subject}" must resolve the true base`)
  }
  await rm(scratch, { recursive: true, force: true })
})

// LOW, round 3, finding 3 — the task-id match is a WHOLE token: "Merge T30: ..." must not locate
// T3, even though it touches exactly T3's declared files and "T30" contains the substring "T3".
test('locateTasks: a merge naming a different, longer task id ("T30") does not locate "T3"', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-wholetoken-'))
  const fixture = await buildFixtureRepo({
    dir: path.join(scratch, 'proj'), runId: 'r1', taskId: 'T3', briefNonce: 'whole-token',
    taskMergeSubject: 'Merge T30: an unrelated task that happens to touch DONE.txt too',
  })
  await git(['branch', '-D', fixture.taskBranch], fixture.root)

  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const [result] = await locateTasks(pool)
  assert.equal(result.located, false, '"Merge T30: ..." must not be read as naming T3')
  assert.ok(result.reason.includes('T3'), `reason should name the task actually being searched for: ${result.reason}`)
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Fix round 3, finding 2 (MEDIUM, correctness) — a bare task id is not unique across runs.
// Reproduced on a real repo: codex-driver's T4 resolved to a DIFFERENT run's "merge: T4 into
// run/purge-followups" instead of its own "merge(codex-driver): T4 brief". This fixture builds
// two runs, A and B, that both land a task literally called "T1" editing the same file — the
// synthetic version of that same collision — and confirms the new rule: never guess.
// ---------------------------------------------------------------------------------------------

// Two runs, `runA` and `runB`, each landing their own "T1" (declared file `a.js`) on the same
// master. `runB` forks from master AFTER `runA` has already landed, so its own true base already
// contains runA's a.js — resolving runB's T1 to runA's base would be a DIFFERENT wrong answer
// than resolving it to runA's MERGE, but still wrong; this fixture lets a test tell either kind
// of leak apart from the correct answer. `taskAMergeSubject`/`taskBMergeSubject` are plain
// strings the caller controls, so one test can omit any run-id hint (forcing ambiguity) and
// another can include one (forcing disambiguation).
async function buildTwoRunCollisionFixture({
  dir, taskAMergeSubject, taskBMergeSubject, squashA = false, squashB = false,
}) {
  return buildRunsCollisionFixture({
    dir,
    runs: [
      { runId: 'runA', subject: taskAMergeSubject, squash: squashA },
      { runId: 'runB', subject: taskBMergeSubject, squash: squashB },
    ],
  })
}

// The same shape for any list of runs, in landing order: each run lands its own "T1" editing
// `a.js`. `state: false` leaves out that run's `.fleetmates/<run>/plan.json` — a run whose state
// directory is gone, or lives in another checkout: its merges are still in git history, but
// locateTasks never learns its run id from the roots.
async function buildRunsCollisionFixture({ dir, runs }) {
  await mkdir(dir, { recursive: true })
  await git(['init', '--quiet'], dir)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/master'], dir)
  await git(['config', 'user.email', 'fixture@example.com'], dir)
  await git(['config', 'user.name', 'Fixture'], dir)
  await mkdir(path.join(dir, 'docs'), { recursive: true })
  const planMd = [
    '# Fixture plan', '', '## Global Constraints', '', '- Node >= 24.2.0', '',
    '### Task 1: edit a.js', '', '**Files:**', '- Modify: `a.js`', '', 'Edit a.js.', '',
  ].join('\n')
  await writeFile(path.join(dir, 'docs', 'plan.md'), planMd, 'utf8')
  await writeFile(path.join(dir, 'a.js'), 'initial\n', 'utf8')
  await writeFile(path.join(dir, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
  await git(['add', '-A'], dir)
  await git(['commit', '--quiet', '-m', 'base'], dir)

  // Two passes, deliberately separate: writing `.fleetmates/<runId>/plan.json` INSIDE the git
  // history loop, even after that run's own commits are made, left it sitting untracked in the
  // working tree through the NEXT run's `git add -A` — which then staged it into that run's own
  // task commit, polluting its diff with a file outside its declared set. `.fleetmates` state is
  // never committed to git in real usage either; keeping it out of every commit here is not just a
  // test-fixture fix, it is the accurate shape.
  const runBranches = {}
  for (const { runId, subject, squash = false } of runs) {
    const content = `from ${runId}\n`
    const runBranch = `run/${runId}`
    runBranches[runId] = runBranch
    const taskBranch = taskBranchName(runId, 'T1')
    await git(['checkout', '--quiet', '-b', runBranch], dir)
    await git(['checkout', '--quiet', '-b', taskBranch], dir)
    await writeFile(path.join(dir, 'a.js'), content, 'utf8')
    await git(['add', '-A'], dir)
    await git(['commit', '--quiet', '-m', `${runId} does T1`], dir)
    await git(['checkout', '--quiet', runBranch], dir)
    if (squash) {
      // A squash merge: no 2-parent commit at all, so this run's OWN "T1" never becomes a
      // candidate for --merges to find — the shape a squash-landed task actually leaves behind.
      await git(['merge', '--squash', '--quiet', taskBranch], dir)
      await git(['commit', '--quiet', '-m', `squash merge T1 for ${runId}`], dir)
    } else {
      await git(['merge', '--no-ff', '--quiet', '-m', subject, taskBranch], dir)
    }
    await git(['checkout', '--quiet', 'master'], dir)
    await git(['merge', '--no-ff', '--quiet', '-m', `merge ${runId}`, runBranch], dir)
    await git(['branch', '-D', taskBranch], dir)
  }

  for (const { runId, state = true } of runs) {
    if (!state) continue
    await mkdir(path.join(dir, '.fleetmates', runId), { recursive: true })
    const planState = {
      runId,
      totalPhases: 1,
      tasks: [{
        id: 'T1', title: 'x', brief: 'x', files: ['a.js'], deps: [], phase: 1, tier: 'mid', tierSource: 'inferred',
      }],
      planPath: 'docs/plan.md',
      destination: '',
      notYetSpecified: [],
      outOfScope: [],
      runBranch: runBranches[runId],
    }
    await writeFile(path.join(dir, '.fleetmates', runId, 'plan.json'), JSON.stringify(planState, null, 2), 'utf8')
  }
  return { root: dir }
}

test('locateTasks: two runs with the same task id never resolve to the OTHER run\'s base — ambiguous when neither subject names a run', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-collision-ambiguous-'))
  const fixture = await buildTwoRunCollisionFixture({
    dir: path.join(scratch, 'proj'),
    // Neither subject names a run — the old "earliest in history" tiebreak would have silently
    // picked runA's (it landed first). The new rule must not guess.
    taskAMergeSubject: 'Merge T1: edit a.js',
    taskBMergeSubject: 'Merge T1: edit a.js',
  })

  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const results = await locateTasks(pool)
  const runBResult = results.find((r) => r.runId === 'runB')
  assert.equal(runBResult.located, false, 'runB\'s T1 must not silently resolve to ANY base when the subjects are indistinguishable')
  assert.ok(runBResult.reason.includes('ambiguous'), `reason should say ambiguous: ${runBResult.reason}`)
  assert.match(runBResult.reason, /[0-9a-f]{12}.*[0-9a-f]{12}/, 'both candidate merges\' short shas are named')
  await rm(scratch, { recursive: true, force: true })
})

test('locateTasks: a run-id token in the merge subject disambiguates two runs with the same task id', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-collision-runid-'))
  const fixture = await buildTwoRunCollisionFixture({
    dir: path.join(scratch, 'proj'),
    taskAMergeSubject: 'Merge T1: edit a.js (runA)',
    taskBMergeSubject: 'Merge T1: edit a.js (runB)',
  })
  // Ground truth: runB's OWN base, resolved before either branch existed only conceptually here —
  // reconstructed directly via git, since both task branches are already deleted by the fixture.
  const runBRunBranchTip = (await git(['rev-parse', 'run/runB'], fixture.root)).trim()
  const expectedBase = (await git(['rev-parse', `${runBRunBranchTip}^`], fixture.root)).trim()

  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const results = await locateTasks(pool)
  const runAResult = results.find((r) => r.runId === 'runA')
  const runBResult = results.find((r) => r.runId === 'runB')
  assert.equal(runBResult.located, true)
  assert.equal(runBResult.method, 'merge')
  assert.equal(runBResult.baseSha, expectedBase, 'runB\'s T1 resolves to runB\'s own base, not runA\'s')
  assert.notEqual(runBResult.baseSha, runAResult.baseSha, 'runA and runB really do have different bases here')
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Gate retry round 1, MEDIUM M2 — a single surviving candidate was accepted even when its subject
// clearly named a DIFFERENT run, so a squash-landed task silently resolved to another run's
// same-id merge. Reproduced on a real repo: runa's squashed T1 resolved to runb's merge base.
// ---------------------------------------------------------------------------------------------

test('locateTasks: runA\'s squash-merged T1 never resolves to runB\'s unrelated T1 merge', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-squash-collision-'))
  const fixture = await buildTwoRunCollisionFixture({
    dir: path.join(scratch, 'proj'),
    squashA: true,
    // runA's own T1 leaves no merge candidate at all (squashed) — the only subject left matching
    // "T1" is runB's own, unrelated task, and its subject names runB explicitly.
    taskBMergeSubject: 'Merge T1: edit a.js (runB)',
  })

  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const results = await locateTasks(pool)
  const runAResult = results.find((r) => r.runId === 'runA')
  const runBResult = results.find((r) => r.runId === 'runB')
  assert.equal(runBResult.located, true, 'sanity: runB\'s own T1 is legitimately locatable')
  assert.equal(runAResult.located, false, 'runA\'s squashed T1 must not resolve to runB\'s base')
  assert.notEqual(runAResult.baseSha, runBResult.baseSha)
  assert.ok(runAResult.reason.includes('other run'), `reason should say it belongs to another run: ${runAResult.reason}`)
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Gate retry round 1, round-3 low test gap (:310) — the run-id tiebreak's own match must be a
// whole token too: querying run "r1" must not match a subject naming run "r10".
// ---------------------------------------------------------------------------------------------

test('locateTasks: the run-id tiebreak is a whole token — run "r1" does not match a subject naming "r10"', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-runid-wholetoken-'))
  const dir = path.join(scratch, 'proj')
  await mkdir(dir, { recursive: true })
  await git(['init', '--quiet'], dir)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/master'], dir)
  await git(['config', 'user.email', 'fixture@example.com'], dir)
  await git(['config', 'user.name', 'Fixture'], dir)
  await mkdir(path.join(dir, 'docs'), { recursive: true })
  const planMd = [
    '# Fixture plan', '', '## Global Constraints', '', '- Node >= 24.2.0', '',
    '### Task 1: edit a.js', '', '**Files:**', '- Modify: `a.js`', '', 'Edit a.js.', '',
  ].join('\n')
  await writeFile(path.join(dir, 'docs', 'plan.md'), planMd, 'utf8')
  await writeFile(path.join(dir, 'a.js'), 'initial\n', 'utf8')
  await writeFile(path.join(dir, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
  await git(['add', '-A'], dir)
  await git(['commit', '--quiet', '-m', 'base'], dir)

  for (const [runId, content, subject] of [
    ['r1', 'from r1\n', 'Merge T1: edit a.js (r1)'],
    ['r10', 'from r10\n', 'Merge T1: edit a.js (r10)'],
  ]) {
    const runBranch = `run/${runId}`
    const taskBranch = taskBranchName(runId, 'T1')
    await git(['checkout', '--quiet', '-b', runBranch], dir)
    await git(['checkout', '--quiet', '-b', taskBranch], dir)
    await writeFile(path.join(dir, 'a.js'), content, 'utf8')
    await git(['add', '-A'], dir)
    await git(['commit', '--quiet', '-m', `${runId} does T1`], dir)
    await git(['checkout', '--quiet', runBranch], dir)
    await git(['merge', '--no-ff', '--quiet', '-m', subject, taskBranch], dir)
    await git(['checkout', '--quiet', 'master'], dir)
    await git(['merge', '--no-ff', '--quiet', '-m', `merge ${runId}`, runBranch], dir)
    await git(['branch', '-D', taskBranch], dir)
  }
  for (const runId of ['r1', 'r10']) {
    await mkdir(path.join(dir, '.fleetmates', runId), { recursive: true })
    const planState = {
      runId,
      totalPhases: 1,
      tasks: [{
        id: 'T1', title: 'x', brief: 'x', files: ['a.js'], deps: [], phase: 1, tier: 'mid', tierSource: 'inferred',
      }],
      planPath: 'docs/plan.md',
      destination: '',
      notYetSpecified: [],
      outOfScope: [],
      runBranch: `run/${runId}`,
    }
    await writeFile(path.join(dir, '.fleetmates', runId, 'plan.json'), JSON.stringify(planState, null, 2), 'utf8')
  }

  const r1RunBranchTip = (await git(['rev-parse', 'run/r1'], dir)).trim()
  const expectedR1Base = (await git(['rev-parse', `${r1RunBranchTip}^`], dir)).trim()

  const plans = await listRunPlans([dir])
  const pool = poolFromPlans(plans)
  const results = await locateTasks(pool)
  const r1Result = results.find((r) => r.runId === 'r1')
  const r10Result = results.find((r) => r.runId === 'r10')
  assert.equal(r1Result.located, true)
  assert.equal(r1Result.baseSha, expectedR1Base, 'run "r1" resolves to its OWN base, not "r10"\'s, despite "r1" being a prefix of "r10"')
  assert.notEqual(r1Result.baseSha, r10Result.baseSha)
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// mto-followups T1, step 2 — a run id is a hyphenated slug, and `\b` treats '-' as a boundary.
// Reproduced before the fix (scratchpad repro-hyphen.mjs): with runs "foo" and "foo-bar", run
// foo's squash-merged T1 resolved to foo-bar's merge, because `\bfoo\b` matched inside
// "(foo-bar)" and the own-run guard then took foo-bar's merge for foo's own.
// ---------------------------------------------------------------------------------------------

async function locateByRun(root) {
  const results = await locateTasks(poolFromPlans(await listRunPlans([root])))
  return Object.fromEntries(results.map((r) => [r.runId, r]))
}

test('locateTasks: run "foo"\'s squash-merged T1 never resolves to run "foo-bar"\'s T1 merge', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-hyphen-'))
  const { root } = await buildRunsCollisionFixture({
    dir: path.join(scratch, 'proj'),
    runs: [
      { runId: 'foo', squash: true },
      { runId: 'foo-bar', subject: 'Merge T1: edit a.js (foo-bar)' },
    ],
  })
  const byRun = await locateByRun(root)
  assert.equal(byRun['foo-bar'].located, true, 'sanity: foo-bar\'s own T1 is locatable')
  assert.equal(byRun.foo.located, false, 'foo\'s squashed T1 must not resolve to foo-bar\'s base')
  assert.ok(byRun.foo.reason.includes('other run'), byRun.foo.reason)
  await rm(scratch, { recursive: true, force: true })
})

// One test per anchor. The subjects name the run in running text, never in the "(<run>)" form, so
// only the run-id patterns decide — the subject parse would otherwise catch these on its own.
for (const { own, other, why } of [
  { own: 'foo', other: 'foo-bar', why: 'own-run lookahead: "foo" is not a whole token of "foo-bar"' },
  { own: 'bar', other: 'foo-bar', why: 'own-run lookbehind: "bar" is not a whole token of "foo-bar"' },
]) {
  test(`locateTasks: ${why}`, async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-hyphen-own-'))
    const { root } = await buildRunsCollisionFixture({
      dir: path.join(scratch, 'proj'),
      runs: [
        { runId: own, squash: true },
        { runId: other, subject: `Merge T1: edit a.js for ${other}` },
      ],
    })
    const byRun = await locateByRun(root)
    assert.equal(byRun[own].located, false, `${own}'s T1 must not resolve to ${other}'s merge`)
    assert.ok(byRun[own].reason.includes('other run'), byRun[own].reason)
    await rm(scratch, { recursive: true, force: true })
  })
}

// The other-run patterns: run "baz"'s own merge subject mentions "foo-bar" (a run with no state
// here), and "foo" is a known run. With `\b`, "foo" matched inside "foo-bar" and baz's own, sole
// candidate was rejected as foo's.
for (const { mention, why } of [
  { mention: 'foo-bar', why: 'other-run lookahead: known run "foo" is not named by "foo-bar"' },
  { mention: 'bar-foo', why: 'other-run lookbehind: known run "foo" is not named by "bar-foo"' },
]) {
  test(`locateTasks: ${why}`, async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-hyphen-other-'))
    const { root } = await buildRunsCollisionFixture({
      dir: path.join(scratch, 'proj'),
      runs: [
        { runId: 'foo', squash: true },
        { runId: 'baz', subject: `Merge T1: edit a.js, rebased over ${mention}` },
      ],
    })
    const byRun = await locateByRun(root)
    assert.equal(byRun.baz.located, true, byRun.baz.reason)
    assert.equal(byRun.baz.method, 'merge')
    await rm(scratch, { recursive: true, force: true })
  })
}

test('locateTasks: the own-run guard keeps a sole candidate whose subject names both its own run and another', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-own-guard-'))
  const { root } = await buildRunsCollisionFixture({
    dir: path.join(scratch, 'proj'),
    runs: [
      { runId: 'runA', subject: 'Merge T1: edit a.js for runA after runB' },
      { runId: 'runB', squash: true },
    ],
  })
  const byRun = await locateByRun(root)
  assert.equal(byRun.runA.located, true, `a subject naming runA is runA's even when it also names runB: ${byRun.runA.reason}`)
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// mto-followups T1, step 3 — "another run" was only a run with `.fleetmates/<run>/plan.json` under
// the roots. Reproduced before the fix: with runB's state directory gone, runA's squash-merged T1
// resolved to the sole candidate left, runB's merge, even though its subject names runB in the
// forms fleetmates writes.
// ---------------------------------------------------------------------------------------------

for (const subject of ['Merge T1: edit a.js (runB)', 'merge(runB): T1 edit a.js']) {
  test(`locateTasks: a subject naming another run ("${subject}") is rejected with no state dir for that run`, async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-stateless-'))
    const { root } = await buildRunsCollisionFixture({
      dir: path.join(scratch, 'proj'),
      runs: [
        { runId: 'runA', squash: true },
        { runId: 'runB', subject, state: false },
      ],
    })
    const byRun = await locateByRun(root)
    assert.equal(byRun.runB, undefined, 'sanity: runB has no state, so it is not in the pool')
    assert.equal(byRun.runA.located, false, 'runA\'s squashed T1 must not resolve to runB\'s merge')
    assert.ok(byRun.runA.reason.includes('other run'), byRun.runA.reason)
    await rm(scratch, { recursive: true, force: true })
  })
}

test('locateTasks: a subject in the "(<run>)" or "merge(<run>)" form naming the task\'s own run is accepted', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-own-form-'))
  for (const [i, subject] of ['Merge T1: edit a.js (runA)', 'merge(runA): T1 edit a.js (T1-T3)'].entries()) {
    const { root } = await buildRunsCollisionFixture({
      dir: path.join(scratch, `proj${i}`),
      runs: [{ runId: 'runA', subject }],
    })
    const byRun = await locateByRun(root)
    assert.equal(byRun.runA.located, true, `${subject}: ${byRun.runA.reason}`)
  }
  await rm(scratch, { recursive: true, force: true })
})

test('locateTasks: a sole candidate from a run with no state dir and no run named in its subject is still accepted', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-stateless-neutral-'))
  const { root } = await buildRunsCollisionFixture({
    dir: path.join(scratch, 'proj'),
    runs: [
      { runId: 'runA', squash: true },
      { runId: 'runB', subject: 'Merge T1: edit a.js', state: false },
    ],
  })
  const byRun = await locateByRun(root)
  assert.equal(byRun.runA.located, true, 'nothing identifies the merge as another run\'s, so it is not rejected')
  await rm(scratch, { recursive: true, force: true })
})

// LOW, round 3, finding 4 — the earliest-match tiebreak this replaces must not resurface for a
// task merged twice within the SAME run (e.g. re-merged after a fix round): the second merge must
// not silently win by virtue of being "earliest" (there is no such rule left) or "latest" either —
// with neither subject naming anything to disambiguate them, this is exactly the round-3 ambiguity
// rule's job.
test('locateTasks: a task merged twice (same run) is covered by the new ambiguity rule, never "earliest"', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-mergedtwice-'))
  const fixture = await buildFixtureRepo({
    dir: path.join(scratch, 'proj'), runId: 'r1', taskId: 'T1', briefNonce: 'merged-twice',
    mergeTaskIntoRun: true, mergeRunIntoMaster: false,
  })
  // A second round: one more commit on the task branch, merged into the run branch AGAIN with the
  // same generic subject template (no run-id hint) — a second, equally valid-looking candidate.
  // `git add DONE.txt` specifically, not `-A`: buildFixtureRepo already wrote
  // `.fleetmates/r1/plan.json` to the working tree (untracked, never committed in real usage
  // either), and `-A` here would stage it into this commit too, contaminating its diff with a
  // file outside the declared set and masking the very ambiguity this test means to reach.
  await git(['checkout', '--quiet', fixture.taskBranch], fixture.root)
  await writeFile(path.join(fixture.root, 'DONE.txt'), 'DONE AGAIN\n', 'utf8')
  await git(['add', 'DONE.txt'], fixture.root)
  await git(['commit', '--quiet', '-m', 'fix round'], fixture.root)
  await git(['checkout', '--quiet', fixture.runBranch], fixture.root)
  await git(['merge', '--no-ff', '--quiet', '-m', `Merge ${fixture.taskId}: merged-twice`, fixture.taskBranch], fixture.root)
  await git(['checkout', '--quiet', 'master'], fixture.root)
  await git(['merge', '--no-ff', '--quiet', '-m', 'merge run', fixture.runBranch], fixture.root)
  await git(['branch', '-D', fixture.taskBranch], fixture.root)

  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const [result] = await locateTasks(pool)
  assert.equal(result.located, false, 'two indistinguishable candidate merges must not resolve to either one by default')
  assert.ok(result.reason.includes('ambiguous'), `reason should say ambiguous: ${result.reason}`)
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Gate retry round 1, round-3 low test gap (:296/298) — the planPath-at-base filter must
// eliminate an otherwise-passing candidate whose base PREDATES the plan file's own existence,
// leaving the genuinely valid candidate as the sole (non-ambiguous) answer, not a tie.
// ---------------------------------------------------------------------------------------------

test('locateTasks: a task with one valid merge plus an older same-id merge from before the plan existed resolves to the valid one', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-oldplan-'))
  const dir = path.join(scratch, 'proj')
  await mkdir(dir, { recursive: true })
  await git(['init', '--quiet'], dir)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/master'], dir)
  await git(['config', 'user.email', 'fixture@example.com'], dir)
  await git(['config', 'user.name', 'Fixture'], dir)
  // The very first commit has NO docs/plan.md at all yet.
  await writeFile(path.join(dir, 'DONE.txt'), 'not done\n', 'utf8')
  await writeFile(path.join(dir, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }), 'utf8')
  await git(['add', '-A'], dir)
  await git(['commit', '--quiet', '-m', 'base, before the plan existed'], dir)

  const runBranch = 'run/r1'
  await git(['checkout', '--quiet', '-b', runBranch], dir)

  // OLD candidate: task branch off the pre-plan base, merged with a subject naming T1. Its own
  // merge-base predates docs/plan.md entirely.
  const taskBranchV1 = taskBranchName('r1', 'T1')
  await git(['checkout', '--quiet', '-b', taskBranchV1], dir)
  await writeFile(path.join(dir, 'DONE.txt'), 'v1\n', 'utf8')
  await git(['add', 'DONE.txt'], dir)
  await git(['commit', '--quiet', '-m', 'v1'], dir)
  await git(['checkout', '--quiet', runBranch], dir)
  await git(['merge', '--no-ff', '--quiet', '-m', 'Merge T1: v1 (before the plan existed)', taskBranchV1], dir)
  await git(['branch', '-D', taskBranchV1], dir)

  // The plan is added AFTER the old merge, on the run branch.
  await mkdir(path.join(dir, 'docs'), { recursive: true })
  const planMd = [
    '# Fixture plan', '', '## Global Constraints', '', '- Node >= 24.2.0', '',
    '### Task 1: v2', '', '**Files:**', '- Modify: `DONE.txt`', '', 'v2.', '',
  ].join('\n')
  await writeFile(path.join(dir, 'docs', 'plan.md'), planMd, 'utf8')
  await git(['add', '-A'], dir)
  await git(['commit', '--quiet', '-m', 'add the plan'], dir)

  // VALID candidate: a fresh task branch off the run branch's NEW tip (which now has the plan),
  // merged with a subject also naming T1.
  const taskBranchV2 = taskBranchName('r1', 'T1')
  await git(['checkout', '--quiet', '-b', taskBranchV2], dir)
  await writeFile(path.join(dir, 'DONE.txt'), 'v2\n', 'utf8')
  await git(['add', 'DONE.txt'], dir)
  await git(['commit', '--quiet', '-m', 'v2'], dir)
  await git(['checkout', '--quiet', runBranch], dir)
  await git(['merge', '--no-ff', '--quiet', '-m', 'Merge T1: v2', taskBranchV2], dir)
  const runBranchTipAfterV2 = (await git(['rev-parse', runBranch], dir)).trim()
  const expectedBase = (await git(['rev-parse', `${runBranchTipAfterV2}^`], dir)).trim()
  await git(['branch', '-D', taskBranchV2], dir)

  await git(['checkout', '--quiet', 'master'], dir)
  await git(['merge', '--no-ff', '--quiet', '-m', 'merge r1', runBranch], dir)

  await mkdir(path.join(dir, '.fleetmates', 'r1'), { recursive: true })
  const planState = {
    runId: 'r1',
    totalPhases: 1,
    tasks: [{
      id: 'T1', title: 'x', brief: 'x', files: ['DONE.txt'], deps: [], phase: 1, tier: 'mid', tierSource: 'inferred',
    }],
    planPath: 'docs/plan.md',
    destination: '',
    notYetSpecified: [],
    outOfScope: [],
    runBranch,
  }
  await writeFile(path.join(dir, '.fleetmates', 'r1', 'plan.json'), JSON.stringify(planState, null, 2), 'utf8')

  const plans = await listRunPlans([dir])
  const pool = poolFromPlans(plans)
  const [result] = await locateTasks(pool)
  assert.equal(result.located, true, `expected the valid (post-plan) merge to resolve, got: ${result.located ? '' : result.reason}`)
  assert.equal(result.method, 'merge')
  assert.equal(result.baseSha, expectedBase, 'resolves to the VALID candidate\'s base, not ambiguous with the pre-plan one')
  await rm(scratch, { recursive: true, force: true })
})

test('locateTasks: a merge whose diff touches an undeclared file is rejected', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-undeclared-'))
  // mergeTaskIntoRun/mergeRunIntoMaster both false: the raw task and run branches only, so the
  // undeclared file can be added to the task branch BEFORE the merge is made — a commit added
  // after the fact would never change what an already-made merge's own parent pointer sees.
  const fixture = await buildFixtureRepo({
    dir: path.join(scratch, 'proj'), runId: 'r1', taskId: 'T1', briefNonce: 'undeclared-file',
    mergeTaskIntoRun: false, mergeRunIntoMaster: false,
  })
  // A file the task's declared set (['DONE.txt'], from the fixture's own plan.json) does not cover.
  await git(['checkout', '--quiet', fixture.taskBranch], fixture.root)
  await writeFile(path.join(fixture.root, 'SNEAKY.txt'), 'not declared\n', 'utf8')
  await git(['add', '-A'], fixture.root)
  await git(['commit', '--quiet', '-m', 'sneak in an undeclared file'], fixture.root)

  await git(['checkout', '--quiet', fixture.runBranch], fixture.root)
  await git(['merge', '--no-ff', '--quiet', '-m', `Merge ${fixture.taskId}: undeclared-file`, fixture.taskBranch], fixture.root)
  await git(['checkout', '--quiet', 'master'], fixture.root)
  await git(['merge', '--no-ff', '--quiet', '-m', 'merge run', fixture.runBranch], fixture.root)
  await git(['branch', '-D', fixture.taskBranch], fixture.root)

  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const [result] = await locateTasks(pool)
  assert.equal(result.located, false)
  assert.ok(result.reason.includes('T1'))
  await rm(scratch, { recursive: true, force: true })
})

test('locateTasks: a squash-merged task is reported unlocatable', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-squash-'))
  const fixture = await buildFixtureRepo({
    dir: path.join(scratch, 'proj'), runId: 'r1', taskId: 'T1', briefNonce: 'squash-merge',
    squashMergeIntoRun: true, mergeRunIntoMaster: true, deleteTaskBranch: true,
  })
  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const [result] = await locateTasks(pool)
  assert.equal(result.located, false)
  assert.ok(result.reason.includes('T1'), `reason should name the task: ${result.reason}`)
  await rm(scratch, { recursive: true, force: true })
})

test('locateTasks: a task whose planPath is absent at the resolved base is reported unlocatable', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-noplan-'))
  const fixture = await buildFixtureRepo({
    dir: path.join(scratch, 'proj'), runId: 'r1', taskId: 'T1', briefNonce: 'no-plan-path',
  })
  const [result] = await locateTasks([{
    root: fixture.root, runId: fixture.runId, taskId: fixture.taskId, files: ['DONE.txt'], tier: 'mid', phase: 1,
    planPath: 'docs/does-not-exist.md',
  }])
  assert.equal(result.located, false)
  assert.ok(result.reason.includes('docs/does-not-exist.md'))
  await rm(scratch, { recursive: true, force: true })
})

test('locateTasks: never reads status.json — a fully-landed task is still located even when it claims pending', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-nostatus-'))
  const fixture = await buildFixtureRepo({
    dir: path.join(scratch, 'proj'), runId: 'r1', taskId: 'T1', briefNonce: 'status-json-ignored',
  })
  // Deliberately invalid JSON: if this were ever read and parsed, the tool would throw. A pass
  // here (the task still located, main() still completing) is direct proof it never was.
  await writeFile(path.join(fixture.root, '.fleetmates', fixture.runId, 'status.json'), '{not valid json at all', 'utf8')

  const plans = await listRunPlans([fixture.root])
  const pool = poolFromPlans(plans)
  const [result] = await locateTasks(pool)
  assert.equal(result.located, true, 'landed by git evidence alone, regardless of what status.json (invalid here) claims')

  const messages = []
  const io = { out: (s) => messages.push(s) }
  const code = await main(['--roots', fixture.root, '--count', '1', '--dry-run'], io)
  assert.equal(code, 0)
  assert.ok(messages[0].startsWith('dry run: 1 task(s) located'))
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// main: resuming a whole replay run from the first missing cell, after a usage-limit stop.
// ---------------------------------------------------------------------------------------------

test('main: resumes from the first missing cell after a usage-limit stop, without redoing finished cells', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-scratch-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'resume-run' })
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  const logPath = path.join(scratch, 'log.jsonl')

  // preflight passes; cheap passes; mid hits a usage limit before it can finish.
  await writeQueue(queuePath, [
    preflightEntry(),
    passingEntry({ totalCostUsd: 0.1 }),
    { files: {}, isError: true, result: 'usage limit reached' },
  ])

  const argv = ['--roots', fixture.root, '--count', '1', '--seed', '7', '--execute', '--models', JSON.stringify({ cheap: 'm-cheap', mid: 'm-mid', capable: 'm-capable' })]
  const messages = []
  const io = { out: (s) => messages.push(s) }
  const code1 = await main(argv, io, {
    tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })
  assert.equal(code1, 1)
  assert.ok(messages.some((m) => m.startsWith('BLOCKED: usage limit, resume with')))

  const linesAfterStop = (await readFile(path.join(outDir, 'replay-results.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(linesAfterStop.length, 1, 'only the finished cheap cell is committed')
  assert.equal(JSON.parse(linesAfterStop[0]).tier, 'cheap')

  // Resume: cheap must not be re-run (a fresh queue with only the preflight plus 2 entries — mid,
  // capable — is enough; one more would mean cheap ran again).
  await writeQueue(queuePath, [preflightEntry(), passingEntry({ totalCostUsd: 0.2 }), passingEntry({ totalCostUsd: 0.3 })])
  const code2 = await main(argv, io, {
    tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })
  assert.equal(code2, 0)

  const finalLines = (await readFile(path.join(outDir, 'replay-results.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(finalLines.length, 3)
  const tiers = finalLines.map((l) => JSON.parse(l).tier).sort()
  assert.deepEqual(tiers, ['capable', 'cheap', 'mid'])

  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// Task selection: pure diversity/determinism, plus the privacy contract.
// ---------------------------------------------------------------------------------------------

test('hashCellKey: deterministic and distinct per (root, run, task)', () => {
  const a = hashCellKey('/repo/one', 'r1', 'T1')
  const b = hashCellKey('/repo/one', 'r1', 'T1')
  const c = hashCellKey('/repo/one', 'r1', 'T2')
  const d = hashCellKey('/repo/two', 'r1', 'T1')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('mulberry32/seededShuffle: same seed reproduces the same sequence', () => {
  const rng1 = mulberry32(123)
  const rng2 = mulberry32(123)
  const seq1 = [rng1(), rng1(), rng1()]
  const seq2 = [rng2(), rng2(), rng2()]
  assert.deepEqual(seq1, seq2)
  const shuffled1 = seededShuffle([1, 2, 3, 4, 5], 9)
  const shuffled2 = seededShuffle([1, 2, 3, 4, 5], 9)
  assert.deepEqual(shuffled1, shuffled2)
  assert.deepEqual([...shuffled1].sort(), [1, 2, 3, 4, 5])
})

function syntheticPool() {
  const pool = []
  for (let i = 0; i < 20; i += 1) {
    pool.push({ root: '/repo/a', runId: 'r1', taskId: `A${i}`, tier: 'cheap', files: [] })
  }
  for (let i = 0; i < 4; i += 1) {
    pool.push({ root: '/repo/b', runId: 'r1', taskId: `B${i}`, tier: 'capable', files: [] })
  }
  return pool
}

test('selectDiverseSample: deterministic for a fixed seed, order-independent of the input pool', () => {
  const pool = syntheticPool()
  const sampleA = selectDiverseSample(pool, { count: 6, seed: 42 })
  const sampleB = selectDiverseSample(pool, { count: 6, seed: 42 })
  assert.deepEqual(sampleA, sampleB)

  const reversed = [...pool].reverse()
  const sampleC = selectDiverseSample(reversed, { count: 6, seed: 42 })
  const key = (t) => `${t.root}:${t.taskId}`
  assert.deepEqual(sampleA.map(key).sort(), sampleC.map(key).sort())
})

test('selectDiverseSample: pulls from every root rather than letting one dominate', () => {
  const pool = syntheticPool()
  const sample = selectDiverseSample(pool, { count: 6, seed: 1 })
  const roots = new Set(sample.map((t) => t.root))
  assert.equal(roots.size, 2, 'both /repo/a and /repo/b should be represented in a diverse sample')
})

test('selectDiverseSample: a count at or above the pool size returns the whole pool once', () => {
  const pool = syntheticPool()
  const sample = selectDiverseSample(pool, { count: 1000, seed: 3 })
  assert.equal(sample.length, pool.length)
})

test('poolFromPlans/listRunPlans: merges tasks from multiple .fleetmates/<run>/plan.json files under the given roots, carrying no title or brief text', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-pool-'))
  const rootA = path.join(scratch, 'a')
  const rootB = path.join(scratch, 'b')
  await mkdir(path.join(rootA, '.fleetmates', 'run1'), { recursive: true })
  await mkdir(path.join(rootB, '.fleetmates', 'run2'), { recursive: true })
  await writeFile(path.join(rootA, '.fleetmates', 'run1', 'plan.json'), JSON.stringify({
    tasks: [{
      id: 'T1', title: 'secret title', brief: 'secret brief', files: ['f.js'], tier: 'mid', phase: 2,
    }],
    planPath: 'p.md',
    runBranch: 'run/run1',
  }), 'utf8')
  await writeFile(path.join(rootB, '.fleetmates', 'run2', 'plan.json'), JSON.stringify({
    tasks: [{ id: 'T9', title: 'z', brief: 'w', files: [], tier: 'cheap', phase: 1 }], planPath: 'p2.md', runBranch: 'run/run2',
  }), 'utf8')

  const plans = await listRunPlans([rootA, rootB])
  assert.equal(plans.length, 2)
  const pool = poolFromPlans(plans)
  assert.equal(pool.length, 2)
  const t1 = pool.find((t) => t.taskId === 'T1')
  assert.equal(t1.root, rootA)
  assert.equal(t1.runId, 'run1')
  assert.equal(t1.phase, 2)
  assert.equal(t1.title, undefined, 'title never enters the pool')
  assert.equal(t1.brief, undefined, 'brief never enters the pool')
  assert.equal(t1.runBranch, undefined, 'runBranch never enters the pool either — base resolution no longer needs it')

  await rm(scratch, { recursive: true, force: true })
})

test('main --dry-run (default): reports the planned cells without writing any file, and leaks no task text', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-dry-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'super-secret-nonce-xyz' })
  const outDir = path.join(scratch, 'data')
  const messages = []
  const io = { out: (s) => messages.push(s) }
  const argv = ['--roots', fixture.root, '--count', '1', '--seed', '1', '--models', JSON.stringify({ cheap: 'm', mid: 'm', capable: 'm' })]
  const code = await main(argv, io, { outDir })
  assert.equal(code, 0)
  const joined = messages.join('\n')
  assert.ok(!joined.includes('super-secret-nonce-xyz'))
  assert.ok(!joined.includes('DONE.txt'))
  await assert.rejects(readFile(path.join(outDir, 'replay-results.jsonl')))
  await rm(scratch, { recursive: true, force: true })
})

test('main --execute: committed output contains only hashed keys and metrics, never brief/title/path text', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-privacy-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'nonce-must-not-leak-77' })
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [
    preflightEntry(),
    passingEntry({ totalCostUsd: 0.1 }), passingEntry({ totalCostUsd: 0.2 }), passingEntry({ totalCostUsd: 0.3 }),
  ])
  const argv = ['--roots', fixture.root, '--count', '1', '--seed', '2', '--execute', '--models', JSON.stringify({ cheap: 'm', mid: 'm', capable: 'm' })]
  const io = { out: () => {} }
  const code = await main(argv, io, { tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath } })
  assert.equal(code, 0)

  const resultsText = await readFile(path.join(outDir, 'replay-results.jsonl'), 'utf8')
  assert.ok(!resultsText.includes('nonce-must-not-leak-77'))
  assert.ok(!resultsText.includes(fixture.root))
  assert.ok(!resultsText.includes('DONE.txt'))
  for (const line of resultsText.trim().split('\n')) {
    const record = JSON.parse(line)
    assert.deepEqual(
      Object.keys(record).sort(),
      ['costMissing', 'failReason', 'fixRound', 'key', 'permissionDenials', 'status', 'tier', 'timestamp',
        'totalCostUsd', 'turns', 'wallClockMs'],
    )
    assert.match(record.key, /^[0-9a-f]{64}$/)
  }

  const lossText = await readFile(path.join(outDir, 'loss.json'), 'utf8')
  assert.ok(!lossText.includes('nonce-must-not-leak-77'))
  assert.ok(!lossText.includes(fixture.root))
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// materializeBaseTree/removeClone: isolation and cleanup, on a plain (non-fleetmates) fixture.
// ---------------------------------------------------------------------------------------------

test('materializeBaseTree/removeClone: materializes into tmpRoot at the base commit, and never touches the source repo', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-clone-'))
  const src = path.join(scratch, 'src')
  await mkdir(src, { recursive: true })
  await git(['init', '--quiet'], src)
  await git(['symbolic-ref', 'HEAD', 'refs/heads/master'], src)
  await git(['config', 'user.email', 'a@b.c'], src)
  await git(['config', 'user.name', 'A'], src)
  await writeFile(path.join(src, 'a.txt'), 'one\n', 'utf8')
  await git(['add', '-A'], src)
  await git(['commit', '--quiet', '-m', 'one'], src)
  const baseSha = (await git(['rev-parse', 'HEAD'], src)).trim()
  await writeFile(path.join(src, 'a.txt'), 'two\n', 'utf8')
  await git(['add', '-A'], src)
  await git(['commit', '--quiet', '-m', 'two'], src)
  const tipSha = (await git(['rev-parse', 'HEAD'], src)).trim()

  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const statusBefore = await git(['status', '--porcelain'], src)
  assert.equal(statusBefore, '')

  const { cloneDir, baseSha: materializedSha } = await materializeBaseTree({ root: src, baseSha, tmpRoot })
  assert.ok(cloneDir.startsWith(tmpRoot))
  assert.notEqual(materializedSha, baseSha, 'a fresh, parentless commit is a different object than the source commit')
  const cloneContent = await readFile(path.join(cloneDir, 'a.txt'), 'utf8')
  assert.equal(cloneContent, 'one\n')

  // Writing into the clone's working tree must never reach the source repo.
  await writeFile(path.join(cloneDir, 'a.txt'), 'mutated in the clone\n', 'utf8')
  await writeFile(path.join(cloneDir, 'new-file.txt'), 'also only in the clone\n', 'utf8')

  const srcContentAfter = await readFile(path.join(src, 'a.txt'), 'utf8')
  assert.equal(srcContentAfter, 'two\n', 'the source repo working tree is untouched')
  const srcTipAfter = (await git(['rev-parse', 'HEAD'], src)).trim()
  assert.equal(srcTipAfter, tipSha, 'the source repo history is untouched')
  const statusAfter = await git(['status', '--porcelain'], src)
  assert.equal(statusAfter, '', 'the source repo has no uncommitted changes from the clone')

  await removeClone(cloneDir)
  await assert.rejects(readFile(path.join(cloneDir, 'a.txt')))
  assert.deepEqual(await readdir(tmpRoot), [], 'the sibling .tar file is cleaned up too')

  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// loss.json: underOverRatio, its interval, the wall-clock ratio, the tier-model mapping and the
// date.
// ---------------------------------------------------------------------------------------------

test('computeLoss: computes underOverRatio from hand-computed under/over costs and excludes unresolved tasks', () => {
  const models = { cheap: 'm-cheap', mid: 'm-mid', capable: 'm-capable' }
  const records = [
    // task A: outcome tier is mid (cheap failed, mid passed, capable passed too but is "over").
    { key: 'A', tier: 'cheap', status: 'fail', totalCostUsd: 1, wallClockMs: 1000 },
    { key: 'A', tier: 'mid', status: 'pass', totalCostUsd: 2, wallClockMs: 2000 },
    { key: 'A', tier: 'capable', status: 'pass', totalCostUsd: 5, wallClockMs: 5000 },
    // task B: unresolved — every tier failed, excluded from the ratio.
    { key: 'B', tier: 'cheap', status: 'fail', totalCostUsd: 1, wallClockMs: 1000 },
    { key: 'B', tier: 'mid', status: 'fail', totalCostUsd: 2, wallClockMs: 2000 },
    { key: 'B', tier: 'capable', status: 'fail', totalCostUsd: 3, wallClockMs: 3000 },
  ]
  const loss = computeLoss(records, { models, bootstrapSamples: 50, now: () => '2026-09-22T00:00:00.000Z' })
  // under-tier cost at cheap (< mid*): cost(cheap) + cost(mid*) = 1 + 2 = 3
  // over-tier cost at capable (> mid*): cost(capable) - cost(mid*) = 5 - 2 = 3
  assert.ok(Math.abs(loss.underOverRatio - 1) < 1e-9)
  assert.ok(Math.abs(loss.wallClockRatio - 1) < 1e-9)
  assert.equal(loss.resolvedTaskCount, 1)
  assert.equal(loss.unresolvedTaskCount, 1)
  assert.deepEqual(loss.tierModels, models)
  assert.equal(loss.date, '2026-09-22T00:00:00.000Z')
  assert.ok(loss.underOverRatioInterval)
  assert.ok(typeof loss.underOverRatioInterval.low === 'number')
  assert.ok(typeof loss.underOverRatioInterval.high === 'number')
})

test('computeLoss: a missing cost is excluded from the ratio rather than treated as 0', () => {
  const models = { cheap: 'm', mid: 'm', capable: 'm' }
  const records = [
    // task A: cheap's cost is missing, so it must contribute NOTHING to underCosts rather than a
    // silent 0 (a 0 there would drag the ratio down to 2/3 instead of leaving it to task B alone).
    { key: 'A', tier: 'cheap', status: 'fail', totalCostUsd: null, wallClockMs: 1000 },
    { key: 'A', tier: 'mid', status: 'pass', totalCostUsd: 2, wallClockMs: 2000 },
    { key: 'A', tier: 'capable', status: 'pass', totalCostUsd: 5, wallClockMs: 5000 },
    // task B: an ordinary, fully-known task, so there IS still a real under-tier data point.
    { key: 'B', tier: 'cheap', status: 'fail', totalCostUsd: 1, wallClockMs: 1000 },
    { key: 'B', tier: 'mid', status: 'pass', totalCostUsd: 4, wallClockMs: 2000 },
    { key: 'B', tier: 'capable', status: 'pass', totalCostUsd: 4, wallClockMs: 5000 },
  ]
  const loss = computeLoss(records, { models, bootstrapSamples: 10 })
  // underCosts = [task B's cheap(1) + mid*(4) = 5] — task A contributes nothing, not 0 + 2 = 2.
  // overCosts = [task A's capable(5) - mid*(2) = 3, task B's capable(4) - mid*(4) = 0]
  const expectedRatio = 5 / ((3 + 0) / 2)
  assert.ok(Math.abs(loss.underOverRatio - expectedRatio) < 1e-9)
})

// ---------------------------------------------------------------------------------------------
// computeLoss also returns tierMeans, costMatrix and wallClockMatrix, exactly
// as the header of the loss.json section in tools/replay/replay.mjs defines them: the first
// replay showed tier cost is not monotonic, so a single underOverRatio cannot weight the loss any
// more (see tools/replay/README.md). The existing underOverRatio, its
// interval and wallClockRatio stay in the output unchanged (asserted above already).
// ---------------------------------------------------------------------------------------------

test('computeLoss: tierMeans, costMatrix and wallClockMatrix match "Cost measurement" exactly, including the over-tier floor', () => {
  const models = { cheap: 'm-cheap', mid: 'm-mid', capable: 'm-capable' }
  const records = [
    // task A: outcome tier mid — cheap failed, mid passed, capable passed too (over-tier).
    { key: 'A', tier: 'cheap', status: 'fail', totalCostUsd: 1, wallClockMs: 1000 },
    { key: 'A', tier: 'mid', status: 'pass', totalCostUsd: 2, wallClockMs: 2000 },
    { key: 'A', tier: 'capable', status: 'pass', totalCostUsd: 5, wallClockMs: 5000 },
    // task B: outcome tier capable — cheap and mid both failed, capable passed.
    { key: 'B', tier: 'cheap', status: 'fail', totalCostUsd: 3, wallClockMs: 3000 },
    { key: 'B', tier: 'mid', status: 'fail', totalCostUsd: 10, wallClockMs: 10000 },
    { key: 'B', tier: 'capable', status: 'pass', totalCostUsd: 1, wallClockMs: 1000 },
  ]
  const loss = computeLoss(records, { models, bootstrapSamples: 20 })
  assert.equal(loss.lossVersion, 2)

  // m(cheap) = mean(1, 3) = 2; m(mid) = mean(2, 10) = 6; m(capable) = mean(5, 1) = 3 — every
  // FINISHED cell, pass or fail alike, not just the ones that fed underOverRatio above.
  assert.deepEqual(loss.tierMeans.usage, { cheap: 2, mid: 6, capable: 3 })
  assert.deepEqual(loss.tierMeans.wallClock, { cheap: 2000, mid: 6000, capable: 3000 })

  // floor = 0.05 * min(2, 6, 3) = 0.1
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} !~ ${b}`)
  close(loss.costMatrix.cheap.cheap, 0, 'diagonal is 0')
  close(loss.costMatrix.mid.mid, 0, 'diagonal is 0')
  close(loss.costMatrix.capable.capable, 0, 'diagonal is 0')
  close(loss.costMatrix.cheap.mid, 8, 'under-tier: m(cheap) + m(mid) = 2 + 6')
  close(loss.costMatrix.cheap.capable, 5, 'under-tier: m(cheap) + m(capable) = 2 + 3')
  close(loss.costMatrix.mid.capable, 9, 'under-tier: m(mid) + m(capable) = 6 + 3')
  close(loss.costMatrix.mid.cheap, 4, 'over-tier: m(mid) - m(cheap) = 6 - 2')
  close(loss.costMatrix.capable.cheap, 1, 'over-tier: m(capable) - m(cheap) = 3 - 2')
  // over-tier floor: m(capable) - m(mid) = 3 - 6 = -3, floored at 0.1 rather than negative or 0.
  close(loss.costMatrix.capable.mid, 0.1, 'over-tier floor: max(3 - 6, 0.1)')

  // wallClockMatrix is built the same way, from mean wall-clock instead of mean cost.
  close(loss.wallClockMatrix.cheap.mid, 8000, 'wallClock under-tier: 2000 + 6000')
  close(loss.wallClockMatrix.capable.mid, 100, 'wallClock over-tier floor: max(3000 - 6000, 100)')

  // Unchanged existing fields.
  assert.equal(typeof loss.underOverRatio, 'number')
  assert.ok(loss.underOverRatioInterval)
  assert.equal(typeof loss.wallClockRatio, 'number')
})

test('computeLoss: a record with a missing cost is excluded from tierMeans, never counted as 0', () => {
  const records = [
    { key: 'A', tier: 'cheap', status: 'fail', totalCostUsd: null, wallClockMs: null },
    { key: 'B', tier: 'cheap', status: 'fail', totalCostUsd: 4, wallClockMs: 4000 },
  ]
  const loss = computeLoss(records, { bootstrapSamples: 5 })
  assert.equal(loss.tierMeans.usage.cheap, 4, 'the missing-cost record contributes nothing, not a silent 0')
  assert.equal(loss.tierMeans.wallClock.cheap, 4000)
})

// ---------------------------------------------------------------------------------------------
// CLI: --roots is always required; --models is required only for --execute (a dry run never
// spawns `claude`), matching the README examples, neither of which needs --models
// at all — `node tools/replay/replay.mjs --roots ~/Work/projetos --count 30 --dry-run`, then
// the same command with `--execute`.
// ---------------------------------------------------------------------------------------------

test('main: --roots is required', async () => {
  const messages = []
  const io = { out: (s) => messages.push(s) }
  const code = await main([], io)
  assert.equal(code, 2)
  assert.ok(messages[0].includes('--roots'))
})

// mto-followups T1, step 1 — reproduced before the fix: a bare `--seed` parsed as `true`,
// Number(true) is 1, and `--recompute-loss` wrote a loss.json with "seed": 1; a bare `--out` fell
// back to the default data directory and rewrote the loss.json there.
test('main: a bare --seed exits 2 naming the flag, and writes no loss.json', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-bare-seed-'))
  await writeFile(path.join(scratch, 'replay-results.jsonl'), `${RECOMPUTE_RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  const messages = []
  const code = await main(['--recompute-loss', '--out', scratch, '--seed'], { out: (s) => messages.push(s) }, { bootstrapSamples: 5 })
  assert.equal(code, 2, messages.join(' | '))
  assert.match(messages.join('\n'), /--seed/)
  await assert.rejects(stat(path.join(scratch, 'loss.json')), 'no loss.json was written')
  await rm(scratch, { recursive: true, force: true })
})

test('main: a bare --out exits 2 naming the flag, and never falls back to the default data directory', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-bare-out-'))
  const defaultDir = path.join(scratch, 'default')
  await mkdir(defaultDir, { recursive: true })
  await writeFile(path.join(defaultDir, 'replay-results.jsonl'), `${RECOMPUTE_RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  const messages = []
  const code = await main(['--recompute-loss', '--out'], { out: (s) => messages.push(s) }, { outDir: defaultDir, bootstrapSamples: 5 })
  assert.equal(code, 2, messages.join(' | '))
  assert.match(messages.join('\n'), /--out/)
  assert.deepEqual(await readdir(defaultDir), ['replay-results.jsonl'], 'the default directory gained no loss.json')
  await rm(scratch, { recursive: true, force: true })
})

test('main: a value-taking flag followed by another flag exits 2 naming it', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-flag-flag-'))
  await writeFile(path.join(scratch, 'replay-results.jsonl'), `${RECOMPUTE_RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  const messages = []
  const code = await main(['--seed', '--recompute-loss', '--out', scratch], { out: (s) => messages.push(s) }, { bootstrapSamples: 5 })
  assert.equal(code, 2, messages.join(' | '))
  assert.match(messages.join('\n'), /--seed/)
  await assert.rejects(stat(path.join(scratch, 'loss.json')), 'no loss.json was written')
  await rm(scratch, { recursive: true, force: true })
})

test('main: a dry run needs no --models at all', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-nomodel-'))
  const messages = []
  const io = { out: (s) => messages.push(s) }
  // No .fleetmates directory under `scratch`, so the pool is empty — this only has to prove the
  // command does not refuse for a missing --models, not that it finds any tasks.
  const code = await main(['--roots', scratch, '--count', '30', '--dry-run'], io)
  assert.equal(code, 0)
  assert.ok(messages[0].startsWith('dry run:'))
  await rm(scratch, { recursive: true, force: true })
})

test('main: --execute refuses without a usable --models mapping or local config', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-nomodel-'))
  const messages = []
  const io = { out: (s) => messages.push(s) }
  const code1 = await main(['--roots', scratch, '--execute'], io, { configRoot: scratch })
  assert.equal(code1, 2)
  assert.ok(messages.at(-1).includes('--models'))

  const code2 = await main(
    ['--roots', scratch, '--execute', '--models', JSON.stringify({ cheap: 'x' })],
    io,
    { configRoot: scratch },
  )
  assert.equal(code2, 2)
  assert.ok(messages.at(-1).includes('--models'))
  await rm(scratch, { recursive: true, force: true })
})

test('main: --execute falls back to harnesses.claude.tierModels in fleetmates.local.json when --models is absent', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-localcfg-'))
  await writeFile(
    path.join(scratch, 'fleetmates.local.json'),
    JSON.stringify({ harnesses: { claude: { tierModels: { cheap: 'm-cheap', mid: 'm-mid', capable: 'm-capable' } } } }),
    'utf8',
  )
  const messages = []
  const io = { out: (s) => messages.push(s) }
  // No .fleetmates directory under `scratch`, so the sample is empty and the run finishes
  // immediately — this only has to prove --models was not required, not run a real cell.
  const code = await main(['--roots', scratch, '--execute'], io, { configRoot: scratch, outDir: path.join(scratch, 'data') })
  assert.equal(code, 0)
  assert.ok(messages.at(-1).startsWith('replay complete:'))
  await rm(scratch, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// `--recompute-loss --out <dir>` rewrites loss.json from the existing
// replay-results.jsonl alone: it runs no cell and spawns no process.
// ---------------------------------------------------------------------------------------------

const RECOMPUTE_RECORDS = [
  {
    key: 'A', tier: 'cheap', status: 'fail', failReason: 'command:tests', permissionDenials: 0,
    turns: 3, totalCostUsd: 1, costMissing: false, wallClockMs: 1000, fixRound: false,
    timestamp: '2026-09-24T00:00:00.000Z',
  },
  {
    key: 'A', tier: 'mid', status: 'pass', failReason: null, permissionDenials: 0,
    turns: 2, totalCostUsd: 2, costMissing: false, wallClockMs: 2000, fixRound: false,
    timestamp: '2026-09-24T00:00:01.000Z',
  },
  {
    key: 'A', tier: 'capable', status: 'pass', failReason: null, permissionDenials: 0,
    turns: 1, totalCostUsd: 5, costMissing: false, wallClockMs: 5000, fixRound: false,
    timestamp: '2026-09-24T00:00:02.000Z',
  },
]

test('main --recompute-loss: rewrites loss.json from the existing replay-results.jsonl, spawns nothing and leaves it byte-identical', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-recompute-'))
  const resultsText = `${RECOMPUTE_RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`
  const resultsPath = path.join(scratch, 'replay-results.jsonl')
  await writeFile(resultsPath, resultsText, 'utf8')
  const messages = []
  const io = { out: (s) => messages.push(s) }
  // A spawnFn that throws proves the run never spawns a process — nothing here reaches it.
  const spawnFn = () => { throw new Error('must not spawn a process') }
  const code = await main(['--recompute-loss', '--out', scratch], io, { spawnFn })
  assert.equal(code, 0)
  assert.ok(messages.at(-1).startsWith('recompute-loss:'), messages.join(' | '))

  const lossAfter = JSON.parse(await readFile(path.join(scratch, 'loss.json'), 'utf8'))
  assert.equal(lossAfter.lossVersion, 2)
  assert.deepEqual(lossAfter.tierMeans.usage, { cheap: 1, mid: 2, capable: 5 })
  assert.ok(lossAfter.costMatrix)

  const resultsAfter = await readFile(resultsPath, 'utf8')
  assert.equal(resultsAfter, resultsText, 'replay-results.jsonl must be byte-identical afterward')
  await rm(scratch, { recursive: true, force: true })
})

test('main --recompute-loss: preserves tierModels from the existing loss.json rather than dropping it', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-recompute-models-'))
  const resultsText = `${RECOMPUTE_RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`
  await writeFile(path.join(scratch, 'replay-results.jsonl'), resultsText, 'utf8')
  const models = { cheap: 'haiku', mid: 'sonnet', capable: 'opus' }
  await writeFile(path.join(scratch, 'loss.json'), `${JSON.stringify({ tierModels: models })}\n`, 'utf8')
  const spawnFn = () => { throw new Error('must not spawn a process') }
  const code = await main(['--recompute-loss', '--out', scratch], { out: () => {} }, { spawnFn })
  assert.equal(code, 0)
  const lossAfter = JSON.parse(await readFile(path.join(scratch, 'loss.json'), 'utf8'))
  assert.deepEqual(lossAfter.tierModels, models)
  await rm(scratch, { recursive: true, force: true })
})

// `--recompute-loss` with no replay data must refuse rather than write a loss.json computed from
// zero records over the committed one.
test('main --recompute-loss: refuses with exit 2 naming the missing replay-results.jsonl, and leaves loss.json untouched', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-recompute-missing-'))
  const lossPath = path.join(scratch, 'loss.json')
  const lossText = `${JSON.stringify({ lossVersion: 2, sentinel: true })}\n`
  await writeFile(lossPath, lossText, 'utf8')
  const messages = []
  const code = await main(['--recompute-loss', '--out', scratch], { out: (s) => messages.push(s) })
  assert.equal(code, 2)
  const resultsPath = path.join(scratch, 'replay-results.jsonl')
  assert.ok(messages.some((m) => m.includes(resultsPath)), messages.join(' | '))
  assert.equal(await readFile(lossPath, 'utf8'), lossText, 'loss.json must be byte-identical afterward')
  await rm(scratch, { recursive: true, force: true })
})

test('main --recompute-loss: refuses with exit 2 on a replay-results.jsonl with zero records, and creates no loss.json', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-recompute-empty-'))
  await writeFile(path.join(scratch, 'replay-results.jsonl'), '', 'utf8')
  const messages = []
  const code = await main(['--recompute-loss', '--out', scratch], { out: (s) => messages.push(s) })
  assert.equal(code, 2)
  assert.ok(messages.some((m) => m.includes('replay-results.jsonl')), messages.join(' | '))
  await assert.rejects(stat(path.join(scratch, 'loss.json')), { code: 'ENOENT' })
  await rm(scratch, { recursive: true, force: true })
})

// Three keys with several distinct under- and over-tier costs, so the bootstrap interval actually
// depends on the seed. RECOMPUTE_RECORDS has a single key, whose interval is {low:1,high:1} for
// every seed and so cannot tell an honoured seed from an ignored one.
function seedSensitiveRecord(key, tier, status, cost) {
  return {
    key, tier, status, failReason: status === 'pass' ? null : 'command:tests', permissionDenials: 0,
    turns: 1, totalCostUsd: cost, costMissing: false, wallClockMs: cost * 1000, fixRound: false,
    timestamp: '2026-09-24T00:00:00.000Z',
  }
}
const SEED_SENSITIVE_RECORDS = [
  seedSensitiveRecord('A', 'cheap', 'fail', 1), seedSensitiveRecord('A', 'mid', 'pass', 2),
  seedSensitiveRecord('A', 'capable', 'pass', 5),
  seedSensitiveRecord('B', 'cheap', 'fail', 4), seedSensitiveRecord('B', 'mid', 'fail', 1),
  seedSensitiveRecord('B', 'capable', 'pass', 3),
  seedSensitiveRecord('C', 'cheap', 'pass', 1), seedSensitiveRecord('C', 'mid', 'pass', 6),
  seedSensitiveRecord('C', 'capable', 'pass', 2),
]

test('main --recompute-loss: honours --seed and records the seed it used in loss.json', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-recompute-seed-'))
  const resultsText = `${SEED_SENSITIVE_RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`
  await writeFile(path.join(scratch, 'replay-results.jsonl'), resultsText, 'utf8')
  const lossPath = path.join(scratch, 'loss.json')

  const code = await main(['--recompute-loss', '--out', scratch, '--seed', '7'], { out: () => {} }, { bootstrapSamples: 50 })
  assert.equal(code, 0)
  const seeded = JSON.parse(await readFile(lossPath, 'utf8'))
  assert.equal(seeded.seed, 7)

  const codeDefault = await main(['--recompute-loss', '--out', scratch], { out: () => {} }, { bootstrapSamples: 50 })
  assert.equal(codeDefault, 0)
  const unseeded = JSON.parse(await readFile(lossPath, 'utf8'))
  assert.equal(unseeded.seed, DEFAULT_SEED)
  assert.ok(seeded.underOverRatioInterval && unseeded.underOverRatioInterval)
  // The interval itself must move with the seed, not just the recorded `seed` field.
  assert.notDeepEqual(seeded.underOverRatioInterval, unseeded.underOverRatioInterval)

  const messages = []
  const codeBad = await main(['--recompute-loss', '--out', scratch, '--seed', 'x'], { out: (s) => messages.push(s) })
  assert.equal(codeBad, 2)
  assert.ok(messages.some((m) => m.includes('--seed')), messages.join(' | '))
  await rm(scratch, { recursive: true, force: true })
})

// `--execute` reads and writes replay-results.jsonl and loss.json in `--out` when given, never in
// the default data directory (here the `outDir` dep, standing in for tools/replay/data/).
test('main --execute: honours --out for replay-results.jsonl and loss.json, leaving the default data directory untouched', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-execute-out-'))
  const outFlagDir = path.join(scratch, 'out')
  const defaultDir = path.join(scratch, 'default')
  const emptyRoot = path.join(scratch, 'root')
  await mkdir(outFlagDir, { recursive: true })
  await mkdir(defaultDir, { recursive: true })
  await mkdir(emptyRoot, { recursive: true })
  const resultsText = `${RECOMPUTE_RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`
  await writeFile(path.join(outFlagDir, 'replay-results.jsonl'), resultsText, 'utf8')
  const spawnFn = () => { throw new Error('must not spawn a process') }
  const messages = []
  const code = await main(
    ['--roots', emptyRoot, '--execute', '--out', outFlagDir, '--models', '{"cheap":"a","mid":"b","capable":"c"}'],
    { out: (s) => messages.push(s) },
    { outDir: defaultDir, spawnFn, bootstrapSamples: 5 },
  )
  assert.equal(code, 0, messages.join(' | '))
  const loss = JSON.parse(await readFile(path.join(outFlagDir, 'loss.json'), 'utf8'))
  assert.deepEqual(loss.tierMeans.usage, { cheap: 1, mid: 2, capable: 5 })
  assert.equal(await readFile(path.join(outFlagDir, 'replay-results.jsonl'), 'utf8'), resultsText)
  assert.deepEqual(await readdir(defaultDir), [])
  await rm(scratch, { recursive: true, force: true })
})

// Sanity: DEFAULT_TIERS is the fixed order everything above assumes.
test('DEFAULT_TIERS is the fixed cheap, mid, capable order', () => {
  assert.deepEqual(DEFAULT_TIERS, ['cheap', 'mid', 'capable'])
})

// ---------------------------------------------------------------------------------------------
// Replay sessions can actually edit, and failures say why. The first real replay
// recorded every cell as `fail` because `claude -p` without a permission mode denied every
// Write/Edit (reproduced in the first real replay). Everything below runs against this
// file's fake `claude`, so it proves the tool's own handling, not real Claude Code behaviour.
// ---------------------------------------------------------------------------------------------

async function runCellWith({ scratch, fixture, queue, declaredFiles = ['DONE.txt'] }) {
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, queue)
  const logPath = path.join(scratch, 'log.jsonl')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const cell = await runTierCell({
    root: fixture.root,
    baseSha: fixture.baseSha,
    tmpRoot,
    prompt: 'do the task',
    model: 'fake-model',
    claudeBin: 'claude',
    declaredFiles,
    phase: 1,
    env: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })
  const calls = (await readFile(logPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { cell, calls, tmpRoot }
}

function permissionModeOf(argv) {
  const i = argv.indexOf('--permission-mode')
  return i === -1 ? null : argv[i + 1]
}

const MODELS_ARG = JSON.stringify({ cheap: 'm-cheap', mid: 'm-mid', capable: 'm-capable' })

test('runTierCell: every session, fix round included, is spawned with --permission-mode bypassPermissions and --strict-mcp-config', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-permmode-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'perm-mode' })
  const { cell, calls } = await runCellWith({
    scratch,
    fixture,
    queue: [failingEntry(), { files: { 'DONE.txt': 'DONE\n' }, remove: ['WRONG.txt'], totalCostUsd: 0.1, sessionId: 'sess-1' }],
  })
  assert.equal(cell.status, 'pass')
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(permissionModeOf(call.argv), 'bypassPermissions')
    // A measured session never loads the operator's own global MCP servers.
    assert.ok(call.argv.includes('--strict-mcp-config'), `argv missing --strict-mcp-config: ${call.argv.join(' ')}`)
  }
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a non-empty permission_denials makes the cell invalid, not fail, with no fix round', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-denied-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'denied-cell' })
  const { cell, calls, tmpRoot } = await runCellWith({
    scratch, fixture, queue: [deniedEntry({ tools: ['Write', 'Edit', 'Write'] }), passingEntry()],
  })
  assert.equal(cell.invalid, true)
  assert.equal(cell.status, undefined, 'an invalid cell carries no pass/fail status at all')
  assert.equal(cell.permissionDenials, 3)
  assert.deepEqual(cell.deniedTools, ['Edit', 'Write'])
  assert.equal(calls.length, 1, 'a denied session is not given a fix round')
  assert.deepEqual(await readdir(tmpRoot), [], 'the clone is still removed')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a denial in the fix round also makes the cell invalid', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-denied-fix-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'denied-fix' })
  const { cell, calls } = await runCellWith({ scratch, fixture, queue: [failingEntry(), deniedEntry({ tools: ['Bash'] })] })
  assert.equal(cell.invalid, true)
  assert.equal(cell.permissionDenials, 1)
  assert.deepEqual(cell.deniedTools, ['Bash'])
  assert.equal(calls.length, 2)
  await rm(scratch, { recursive: true, force: true })
})

test('main --execute: a denied cell appends nothing, stops the run naming the tools and count, and resume re-runs it', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-denied-main-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'denied-nonce-13' })
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  const logPath = path.join(scratch, 'log.jsonl')
  await writeQueue(queuePath, [preflightEntry(), deniedEntry({ tools: ['Write', 'Edit'] })])
  const argv = ['--roots', fixture.root, '--count', '1', '--seed', '3', '--execute', '--models', MODELS_ARG]
  const messages = []
  const io = { out: (s) => messages.push(s) }
  const deps = { tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath } }

  const code1 = await main(argv, io, deps)
  assert.equal(code1, 1)
  const stop = messages.find((m) => m.startsWith('INVALID:'))
  assert.ok(stop, `a stop message was printed: ${messages.join(' | ')}`)
  assert.ok(stop.includes('2 permission denial'), stop)
  assert.ok(stop.includes('Edit') && stop.includes('Write'), stop)
  assert.ok(!stop.includes('denied-nonce-13'), 'no task text in the stop message')
  await assert.rejects(readFile(path.join(outDir, 'replay-results.jsonl')), 'nothing was appended for the denied cell')

  await writeQueue(queuePath, [preflightEntry(), passingEntry(), passingEntry(), passingEntry()])
  const code2 = await main(argv, io, deps)
  assert.equal(code2, 0)
  const lines = (await readFile(path.join(outDir, 'replay-results.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((r) => r.tier), ['cheap', 'mid', 'capable'], 'the denied cheap cell ran again on resume')
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  const cheapCalls = calls.filter((c) => c.argv.includes('m-cheap') && !c.input.includes(PREFLIGHT_FILE))
  assert.equal(cheapCalls.length, 2, 'the cheap cell was attempted once in each invocation')
  await rm(scratch, { recursive: true, force: true })
})

// Step 3 — every `fail` says why, without task text, paths or command output.
const FAIL_REASONS = /^(no-op|fileset|command:[^\s/\\]+|session-error|preview-copy)$/

test('runTierCell: failReason is no-op when no declared file changed', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-reason-noop-'))
  const gateConfig = {
    phases: { default: { checks: [{ name: 'always-pass', kind: 'command', run: 'node -e "process.exit(0)"' }] } },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'reason-noop', gateConfig })
  const { cell } = await runCellWith({
    scratch,
    fixture,
    queue: [{ totalCostUsd: 0.1, numTurns: 3 }, { totalCostUsd: 0.1, numTurns: 4 }],
  })
  assert.equal(cell.status, 'fail')
  assert.equal(cell.failReason, 'no-op')
  assert.equal(cell.permissionDenials, 0)
  assert.equal(cell.turns, 7, 'turns sums both attempts')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: failReason is fileset when an undeclared file is left behind', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-reason-fileset-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'reason-fileset' })
  const { cell } = await runCellWith({ scratch, fixture, queue: [failingEntry(), passingEntry()] })
  assert.equal(cell.status, 'fail')
  assert.equal(cell.failReason, 'fileset')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: failReason is command:<check name>, never the command output', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-reason-cmd-'))
  const gateConfig = {
    phases: {
      default: {
        checks: [
          { name: 'first-ok', kind: 'command', run: 'node -e "process.exit(0)"' },
          { name: 'unit-tests', kind: 'command', run: 'node -e "console.log(\'SECRET-OUTPUT-42\'); process.exit(1)"' },
        ],
      },
    },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'reason-cmd', gateConfig })
  const { cell } = await runCellWith({ scratch, fixture, queue: [passingEntry(), passingEntry()] })
  assert.equal(cell.status, 'fail')
  assert.equal(cell.failReason, 'command:unit-tests')
  assert.ok(!JSON.stringify(cell).includes('SECRET-OUTPUT-42'), 'no command output anywhere in the cell result')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: failReason is session-error for malformed session output', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-reason-session-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'reason-session' })
  const { cell } = await runCellWith({ scratch, fixture, queue: [{ raw: 'not json\n' }] })
  assert.equal(cell.status, 'fail')
  assert.equal(cell.failReason, 'session-error')
  assert.equal(cell.turns, null, 'turns unknown from malformed output is null, never 0')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: failReason is preview-copy when the preview.link copy is refused', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-reason-copy-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: { default: { checks: [{ name: 'x', kind: 'command', run: 'node -e "process.exit(0)"' }] } },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'reason-copy', gateConfig })
  const outside = path.join(scratch, 'outside-the-repo')
  await mkdir(outside, { recursive: true })
  await symlink(outside, path.join(fixture.root, 'node_modules'))
  const { cell, calls } = await runCellWith({ scratch, fixture, queue: [passingEntry()] })
  // mto-followups T1, step 4 — reproduced before the fix: this cell was `fail` with cost 0 and
  // `costMissing: false`, a free failed attempt that pulled the tier's mean cost down.
  assert.equal(cell.status, 'invalid')
  assert.equal(cell.failReason, 'preview-copy')
  assert.equal(cell.permissionDenials, 0)
  assert.equal(cell.totalCostUsd, null, 'no session ran, so there is no cost — never 0')
  assert.equal(cell.costMissing, true)
  assert.equal(cell.wallClockMs, null)
  assert.equal(cell.turns, null)
  assert.equal(calls.length, 0)
  await rm(scratch, { recursive: true, force: true })
})

test('main --execute: a preview-copy failure prints its line and appends invalid records the loss ignores', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-main-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: { default: { checks: [{ name: 'x', kind: 'command', run: 'node -e "process.exit(0)"' }] } },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'copy-main', gateConfig })
  const outside = path.join(scratch, 'outside-the-repo')
  await mkdir(outside, { recursive: true })
  await symlink(outside, path.join(fixture.root, 'node_modules'))
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [preflightEntry()])
  const messages = []
  const argv = ['--roots', fixture.root, '--count', '1', '--execute', '--models', MODELS_ARG]
  const code = await main(argv, { out: (s) => messages.push(s) }, { tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath } })
  assert.equal(code, 0, messages.join(' | '))
  const lines = messages.filter((m) => m.includes('preview.link copy'))
  assert.equal(lines.length, DEFAULT_TIERS.length, messages.join(' | '))
  for (const [i, tier] of DEFAULT_TIERS.entries()) {
    assert.match(lines[i], new RegExp(`^  [0-9a-f]{12} ${tier}: INVALID \\(preview-copy\\), preview\\.link copy: preview link "node_modules" resolves outside the repository$`))
  }
  const records = (await readFile(path.join(outDir, 'replay-results.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(records.length, DEFAULT_TIERS.length)
  for (const r of records) {
    assert.equal(r.status, 'invalid')
    assert.equal(r.failReason, 'preview-copy')
    assert.equal(r.totalCostUsd, null)
    assert.equal(r.costMissing, true)
    assert.equal(r.wallClockMs, null)
  }
  const loss = JSON.parse(await readFile(path.join(outDir, 'loss.json'), 'utf8'))
  assert.equal(loss.resolvedTaskCount, 0)
  assert.equal(loss.unresolvedTaskCount, 0, 'an invalid cell is no evidence about the task, so it is not counted as unresolved')
  await rm(scratch, { recursive: true, force: true })
})

test('main --smoke: a preview-copy failure prints its line and exits 1', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-smoke-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: { default: { checks: [{ name: 'x', kind: 'command', run: 'node -e "process.exit(0)"' }] } },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'copy-smoke', gateConfig })
  const outside = path.join(scratch, 'outside-the-repo')
  await mkdir(outside, { recursive: true })
  await symlink(outside, path.join(fixture.root, 'node_modules'))
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [])
  const messages = []
  const argv = ['--roots', fixture.root, '--count', '1', '--smoke', '--models', MODELS_ARG]
  const code = await main(argv, { out: (s) => messages.push(s) }, { tmpRoot, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath } })
  assert.equal(code, 1, messages.join(' | '))
  assert.match(messages.join('\n'), /^ {2}[0-9a-f]{12} capable: INVALID \(preview-copy\), preview\.link copy: preview link "node_modules" resolves outside the repository$/m)
  await rm(scratch, { recursive: true, force: true })
})

// mto-followups T1, step 4 — the destination check compared only the textual path, so a nested
// entry under a directory the base tree holds as a SYMLINK passed it, and the copy landed wherever
// that symlink points. Reproduced before the fix: the entry's content appeared in the outside
// directory.
test('copyPreviewPaths: refuses a nested entry under a base-tree symlink, and writes nothing through it', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-nested-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(path.join(sourceRoot, 'vendor', 'nm', 'dep'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'vendor', 'nm', 'dep', 'index.js'), 'dependency\n', 'utf8')
  const outside = path.join(scratch, 'outside-the-cell')
  await mkdir(outside, { recursive: true })
  const cellDir = path.join(scratch, 'cell')
  await mkdir(cellDir, { recursive: true })
  await symlink(outside, path.join(cellDir, 'vendor'))

  await assert.rejects(
    copyPreviewPaths(cellDir, sourceRoot, ['vendor/nm']),
    /would be copied outside the preview tree/,
  )
  assert.deepEqual(await readdir(outside), [], 'nothing was copied through the symlink')
  await rm(scratch, { recursive: true, force: true })
})

// mto-followups T1, step 4 — the copied link trees are excluded from the fileset check, so a
// session's edit under one went unseen. They are now read-only (files and directories) while the
// session runs, and made writable again before removal.
const ROOT_SKIP = process.getuid?.() === 0 ? 'root ignores file modes' : false

test('copyPreviewPaths: the copied tree is read-only, files and directories, and teardown still removes it', { skip: ROOT_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-readonly-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(path.join(sourceRoot, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'node_modules', 'dep', 'index.js'), 'original\n', 'utf8')
  const cellDir = path.join(scratch, 'cell')
  await mkdir(cellDir, { recursive: true })
  const teardown = await copyPreviewPaths(cellDir, sourceRoot, ['node_modules'])

  await assert.rejects(writeFile(path.join(cellDir, 'node_modules', 'dep', 'index.js'), 'mutated\n'), { code: 'EACCES' })
  await assert.rejects(writeFile(path.join(cellDir, 'node_modules', 'dep', 'new.js'), 'new\n'), { code: 'EACCES' })
  await assert.rejects(writeFile(path.join(cellDir, 'node_modules', 'new.js'), 'new\n'), { code: 'EACCES' })
  assert.equal(await readFile(path.join(cellDir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'original\n')
  const sourceMode = (await stat(path.join(sourceRoot, 'node_modules', 'dep', 'index.js'))).mode
  assert.ok(sourceMode & 0o200, 'the source repo\'s own file keeps its write permission')

  await teardown()
  assert.deepEqual(await readdir(cellDir), [], 'teardown removed the read-only copy')
  await rm(scratch, { recursive: true, force: true })
})

test('copyPreviewPaths: an inner symlink in the copied tree is left alone, so its target keeps its mode', { skip: ROOT_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-readonly-sym-'))
  const sourceRoot = path.join(scratch, 'source')
  await mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true })
  const outsideFile = path.join(scratch, 'outside.js')
  await writeFile(outsideFile, 'outside\n', 'utf8')
  await symlink(outsideFile, path.join(sourceRoot, 'node_modules', 'link.js'))
  const cellDir = path.join(scratch, 'cell')
  await mkdir(cellDir, { recursive: true })
  const teardown = await copyPreviewPaths(cellDir, sourceRoot, ['node_modules'])
  assert.ok((await stat(outsideFile)).mode & 0o200, 'chmod never followed the inner symlink')
  await teardown()
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a session write under a copied link directory does not change it, and the clone is still removed', { skip: WIN32_FAKE_SKIP || ROOT_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-copy-readonly-cell-'))
  const gateConfig = {
    preview: { link: ['node_modules'] },
    phases: {
      default: {
        checks: [
          { name: 'done-marker', kind: 'command', run: `node -e "process.exit(require('fs').existsSync('DONE.txt') ? 0 : 1)"` },
          {
            name: 'link-intact',
            kind: 'command',
            run: `node -e "const fs = require('fs'); process.exit(fs.readFileSync('node_modules/dep/index.js', 'utf8') === 'original\\\\n' && !fs.existsSync('node_modules/dep/new.js') ? 0 : 1)"`,
          },
        ],
      },
    },
  }
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'copy-readonly-cell', gateConfig })
  await mkdir(path.join(fixture.root, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(fixture.root, 'node_modules', 'dep', 'index.js'), 'original\n', 'utf8')
  const { cell, tmpRoot } = await runCellWith({
    scratch,
    fixture,
    queue: [{
      files: { 'DONE.txt': 'DONE\n' },
      tryFiles: { 'node_modules/dep/index.js': 'mutated by the session\n', 'node_modules/dep/new.js': 'new\n' },
      totalCostUsd: 0.1,
    }],
  })
  const errors = await readFile(path.join(scratch, 'log.jsonl.errors'), 'utf8')
  assert.match(errors, /node_modules\/dep\/index\.js EACCES/)
  assert.match(errors, /node_modules\/dep\/new\.js EACCES/)
  assert.equal(cell.status, 'pass', 'link-intact saw the copied tree unchanged after the session')
  assert.deepEqual(await readdir(tmpRoot), [], 'the clone, read-only link tree included, was removed')
  await rm(scratch, { recursive: true, force: true })
})

test('runTierCell: a passing cell carries failReason null, zero denials and its turns', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-reason-pass-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'reason-pass' })
  const { cell } = await runCellWith({ scratch, fixture, queue: [{ ...passingEntry(), numTurns: 5 }] })
  assert.equal(cell.status, 'pass')
  assert.equal(cell.failReason, null)
  assert.equal(cell.permissionDenials, 0)
  assert.equal(cell.turns, 5)
  await rm(scratch, { recursive: true, force: true })
})

test('main --execute: every appended fail record carries a failReason from the fixed set, with no task text', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-reason-main-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'reason-main-nonce-91' })
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [
    preflightEntry(),
    failingEntry(), failingEntry(), // cheap: fileset, fix round too
    { raw: 'garbage' }, // mid: session-error
    { ...passingEntry(), numTurns: 6 }, // capable: pass
  ])
  const argv = ['--roots', fixture.root, '--count', '1', '--execute', '--models', MODELS_ARG]
  const code = await main(argv, { out: () => {} }, { tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath } })
  assert.equal(code, 0)
  const text = await readFile(path.join(outDir, 'replay-results.jsonl'), 'utf8')
  assert.ok(!text.includes('reason-main-nonce-91'))
  assert.ok(!text.includes(fixture.root))
  assert.ok(!text.includes('WRONG.txt'))
  const records = text.trim().split('\n').map((l) => JSON.parse(l))
  const byTier = Object.fromEntries(records.map((r) => [r.tier, r]))
  assert.equal(byTier.cheap.failReason, 'fileset')
  assert.equal(byTier.mid.failReason, 'session-error')
  assert.equal(byTier.capable.failReason, null)
  assert.equal(byTier.capable.turns, 6)
  for (const r of records) {
    if (r.status === 'fail') assert.match(r.failReason, FAIL_REASONS)
    assert.equal(r.permissionDenials, 0)
  }
  await rm(scratch, { recursive: true, force: true })
})

// Step 4 — preflight: one session in a scratch repo that must be able to write.
test('runPreflight: passes when the session creates the file with zero denials, and cleans up', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-ok-'))
  const queuePath = path.join(scratch, 'queue.json')
  const logPath = path.join(scratch, 'log.jsonl')
  await writeQueue(queuePath, [preflightEntry()])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const result = await runPreflight({
    tmpRoot, model: 'm-pre', claudeBin: 'claude', env: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath },
  })
  assert.equal(result.ok, true)
  assert.equal(result.fileExists, true)
  assert.equal(result.permissionDenials, 0)
  assert.equal(result.turns, 2)
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(calls.length, 1)
  assert.equal(permissionModeOf(calls[0].argv), 'bypassPermissions')
  assert.ok(calls[0].argv.includes('m-pre'))
  assert.ok(calls[0].input.includes(PREFLIGHT_FILE), 'the prompt names the file to create')
  assert.ok(calls[0].input.includes('git status'), 'the prompt asks for git status')
  assert.ok(calls[0].cwd.startsWith(await realpath(tmpRoot)), 'the session ran under tmpRoot')
  const gitDir = await stat(path.join(calls[0].cwd, '.git')).catch(() => null)
  assert.equal(gitDir, null, 'the scratch repo is removed afterwards')
  assert.deepEqual(await readdir(tmpRoot), [])
  await rm(scratch, { recursive: true, force: true })
})

test('runPreflight: runs in a git repository', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-git-'))
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [preflightEntry()])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  let sawGitRepo = null
  const spawnFn = (bin, args, opts) => {
    sawGitRepo = defaultGitExec(['rev-parse', '--is-inside-work-tree'], opts.cwd)
    return spawnReal(bin, args, opts)
  }
  const result = await runPreflight({ tmpRoot, model: 'm', claudeBin: 'claude', env: { FAKE_CLAUDE_QUEUE: queuePath }, spawnFn })
  assert.equal(result.ok, true)
  assert.equal((await sawGitRepo).stdout.trim(), 'true')
  await rm(scratch, { recursive: true, force: true })
})

test('runPreflight: fails when the session reports a denial and no file was created', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-denied-'))
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [deniedEntry({ tools: ['Write'] })])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const result = await runPreflight({ tmpRoot, model: 'm', claudeBin: 'claude', env: { FAKE_CLAUDE_QUEUE: queuePath } })
  assert.equal(result.ok, false)
  assert.equal(result.fileExists, false)
  assert.equal(result.permissionDenials, 1)
  assert.deepEqual(result.deniedTools, ['Write'])
  assert.deepEqual(await readdir(tmpRoot), [])
  await rm(scratch, { recursive: true, force: true })
})

test('runPreflight: a created file with a denial still fails', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-mixed-'))
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [{ ...deniedEntry({ tools: ['Bash'] }), files: { [PREFLIGHT_FILE]: 'ok\n' } }])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const result = await runPreflight({ tmpRoot, model: 'm', claudeBin: 'claude', env: { FAKE_CLAUDE_QUEUE: queuePath } })
  assert.equal(result.ok, false)
  assert.equal(result.fileExists, true)
  assert.equal(result.permissionDenials, 1)
  await rm(scratch, { recursive: true, force: true })
})

test('main --preflight: needs no --roots, prints the verdict, and exits 0 on success', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-main-'))
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [preflightEntry()])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const messages = []
  const code = await main(
    ['--preflight', '--models', MODELS_ARG],
    { out: (s) => messages.push(s) },
    { tmpRoot, outDir: path.join(scratch, 'data'), claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath } },
  )
  assert.equal(code, 0, messages.join(' | '))
  assert.ok(messages.some((m) => m.startsWith('preflight: ok')), messages.join(' | '))
  await assert.rejects(readFile(path.join(scratch, 'data', 'replay-results.jsonl')))
  await rm(scratch, { recursive: true, force: true })
})

test('main --preflight: a denied preflight exits 1 naming the tools', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-main-denied-'))
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [deniedEntry({ tools: ['Write'] })])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const messages = []
  const code = await main(
    ['--preflight', '--models', MODELS_ARG],
    { out: (s) => messages.push(s) },
    { tmpRoot, outDir: path.join(scratch, 'data'), claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath } },
  )
  assert.equal(code, 1)
  const failure = messages.find((m) => m.startsWith('preflight: FAILED'))
  assert.ok(failure && failure.includes('Write') && failure.includes('1 permission denial'), messages.join(' | '))
  await rm(scratch, { recursive: true, force: true })
})

test('main --execute: a failed preflight aborts the whole run before any cell', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-abort-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'preflight-abort' })
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  const logPath = path.join(scratch, 'log.jsonl')
  await writeQueue(queuePath, [deniedEntry({ tools: ['Write'] }), passingEntry(), passingEntry(), passingEntry()])
  const messages = []
  const code = await main(
    ['--roots', fixture.root, '--count', '1', '--execute', '--models', MODELS_ARG],
    { out: (s) => messages.push(s) },
    { tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath } },
  )
  assert.equal(code, 1)
  const failure = messages.find((m) => m.startsWith('preflight: FAILED'))
  assert.ok(failure, messages.join(' | '))
  assert.ok(failure.includes('Write'), failure)
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n')
  assert.equal(calls.length, 1, 'only the preflight session ran')
  await assert.rejects(readFile(path.join(outDir, 'replay-results.jsonl')))
  await assert.rejects(readFile(path.join(outDir, 'loss.json')))
  await rm(scratch, { recursive: true, force: true })
})

// Step 5 — smoke: exactly one capable cell on the first selected task, nothing appended.
test('main --smoke: runs one capable cell, prints status, failReason, cost and turns, and appends nothing', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-smoke-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'smoke-nonce-55' })
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  const logPath = path.join(scratch, 'log.jsonl')
  await writeQueue(queuePath, [{ ...passingEntry({ totalCostUsd: 0.37 }), numTurns: 4 }])
  const messages = []
  const code = await main(
    ['--roots', fixture.root, '--count', '5', '--smoke', '--models', MODELS_ARG],
    { out: (s) => messages.push(s) },
    { tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath, FAKE_CLAUDE_LOG: logPath } },
  )
  assert.equal(code, 0, messages.join(' | '))
  const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(calls.length, 1, 'exactly one session')
  assert.ok(calls[0].argv.includes('m-capable'), 'at the capable tier')
  const line = messages.find((m) => m.startsWith('smoke:'))
  assert.ok(line, messages.join(' | '))
  assert.ok(line.includes('status=pass'), line)
  assert.ok(line.includes('failReason=none'), line)
  assert.ok(line.includes('cost=0.37'), line)
  assert.ok(line.includes('turns=4'), line)
  assert.ok(!messages.join('\n').includes('smoke-nonce-55'))
  await assert.rejects(readFile(path.join(outDir, 'replay-results.jsonl')), 'smoke appends nothing')
  await assert.rejects(readFile(path.join(outDir, 'loss.json')), 'smoke writes no loss.json')
  await rm(scratch, { recursive: true, force: true })
})

test('main --smoke: a failing cell prints its failReason and exits non-zero', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-smoke-fail-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'smoke-fail' })
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [{ totalCostUsd: 0.1 }, { totalCostUsd: 0.1 }])
  const messages = []
  const code = await main(
    ['--roots', fixture.root, '--smoke', '--models', MODELS_ARG],
    { out: (s) => messages.push(s) },
    { tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath } },
  )
  assert.equal(code, 1)
  const line = messages.find((m) => m.startsWith('smoke:'))
  assert.ok(line && line.includes('status=fail') && line.includes('failReason=no-op'), messages.join(' | '))
  await assert.rejects(readFile(path.join(outDir, 'replay-results.jsonl')))
  await rm(scratch, { recursive: true, force: true })
})

test('main --smoke: a denied session prints INVALID with the tools and count', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-smoke-denied-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'smoke-denied' })
  const outDir = path.join(scratch, 'data')
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [deniedEntry({ tools: ['Edit'] })])
  const messages = []
  const code = await main(
    ['--roots', fixture.root, '--smoke', '--models', MODELS_ARG],
    { out: (s) => messages.push(s) },
    { tmpRoot, outDir, claudeEnv: { FAKE_CLAUDE_QUEUE: queuePath } },
  )
  assert.equal(code, 1)
  const line = messages.find((m) => m.startsWith('INVALID:'))
  assert.ok(line && line.includes('1 permission denial') && line.includes('Edit'), messages.join(' | '))
  await assert.rejects(readFile(path.join(outDir, 'replay-results.jsonl')))
  await rm(scratch, { recursive: true, force: true })
})

test('parseClaudeOutput: reads permission_denials and num_turns', () => {
  const denied = parseClaudeOutput(JSON.stringify({
    is_error: false,
    result: 'pending',
    permission_denials: [{ tool_name: 'Write' }, { tool_name: 'Write' }, { tool_name: 'Edit' }],
    num_turns: 3,
  }))
  assert.equal(denied.permissionDenials, 3)
  assert.deepEqual(denied.deniedTools, ['Edit', 'Write'])
  assert.equal(denied.turns, 3)
  const clean = parseClaudeOutput(JSON.stringify({ is_error: false, result: 'ok' }))
  assert.equal(clean.permissionDenials, 0)
  assert.deepEqual(clean.deniedTools, [])
  assert.equal(clean.turns, null)
})

// Gate retry, round 1 — each pickFailReason branch and each runPreflight pass condition has its
// own test.
test('runTierCell: failReason is session-error for an is_error result that is not a usage limit', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-reason-iserror-'))
  const fixture = await buildFixtureRepo({ dir: path.join(scratch, 'proj'), briefNonce: 'reason-iserror' })
  const errorEntry = { isError: true, result: 'API Error: 500 internal server error', totalCostUsd: 0.01, sessionId: 'sess-1' }
  const { cell } = await runCellWith({ scratch, fixture, queue: [errorEntry, errorEntry] })
  assert.equal(cell.status, 'fail')
  assert.equal(cell.failReason, 'session-error', 'an errored session that changed nothing is not a no-op')
  await rm(scratch, { recursive: true, force: true })
})

test('pickFailReason: each branch, and a failed verification with no recorded reason throws', () => {
  const clean = { malformed: false, isError: false }
  assert.equal(pickFailReason({ reasons: ['no-op'] }, { malformed: true, isError: false }), 'session-error')
  assert.equal(pickFailReason({ reasons: ['no-op'] }, { malformed: false, isError: true }), 'session-error')
  assert.equal(pickFailReason({ reasons: ['no-op', 'fileset'] }, clean), 'fileset')
  assert.equal(pickFailReason({ reasons: ['command:a', 'no-op'] }, clean), 'no-op')
  assert.equal(pickFailReason({ reasons: ['command:a', 'command:b'] }, clean), 'command:a')
  assert.throws(() => pickFailReason({ reasons: [] }, clean), /no recorded reason/)
  assert.throws(() => pickFailReason({}, clean), /no recorded reason/)
})

test('runPreflight: a created file with non-JSON output does not pass', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-malformed-'))
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [{ files: { [PREFLIGHT_FILE]: 'ok\n' }, raw: 'this is not json\n' }])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const result = await runPreflight({ tmpRoot, model: 'm', claudeBin: 'claude', env: { FAKE_CLAUDE_QUEUE: queuePath } })
  assert.equal(result.fileExists, true, 'sanity: the file was created')
  assert.equal(result.permissionDenials, 0, 'sanity: no denial to fail on')
  assert.equal(result.malformed, true)
  assert.equal(result.ok, false)
  await rm(scratch, { recursive: true, force: true })
})

test('runPreflight: a created file with a usage-limit result does not pass', { skip: WIN32_FAKE_SKIP }, async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'fm-replay-preflight-limit-'))
  const queuePath = path.join(scratch, 'queue.json')
  await writeQueue(queuePath, [{
    files: { [PREFLIGHT_FILE]: 'ok\n' }, isError: true, result: 'Claude AI usage limit reached.', totalCostUsd: 0.01,
  }])
  const tmpRoot = path.join(scratch, 'tmp')
  await mkdir(tmpRoot, { recursive: true })
  const result = await runPreflight({ tmpRoot, model: 'm', claudeBin: 'claude', env: { FAKE_CLAUDE_QUEUE: queuePath } })
  assert.equal(result.fileExists, true, 'sanity: the file was created')
  assert.equal(result.permissionDenials, 0, 'sanity: no denial to fail on')
  assert.equal(result.malformed, false, 'sanity: the output parsed')
  assert.equal(result.usageLimit, true)
  assert.equal(result.ok, false)
  await rm(scratch, { recursive: true, force: true })
})
