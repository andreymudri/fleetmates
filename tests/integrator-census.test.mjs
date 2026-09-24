import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { censusRoot, summarize } from '../tools/replay/integrator-census.mjs'
import { projectSlug } from '../scripts/usage.mjs'

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'replay', 'integrator-census.mjs')

// Fixed commit times, so the transcript fixture can cover phase 1's merges and not phase 2's.
const T0 = 1_780_000_000
const at = (offset) => `${T0 + offset} +0000`

function git(cwd, args, date = at(0)) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim()
}

async function commitFile(dir, file, body, message, date) {
  await writeFile(path.join(dir, file), body, 'utf8')
  git(dir, ['add', file], date)
  git(dir, ['commit', '-q', '-m', message], date)
  return git(dir, ['rev-parse', 'HEAD'])
}

// Run r1, two phases, on a repository whose task branches of phase 1 are pruned:
//   phase 1: T1 (clean, dispatched message), T2 (clean, message with a body and a trailer),
//            then one non-merge commit by the integrator
//   phase 2: T3, which conflicts with that commit and is resolved by hand
// plus a merge of the base branch (a plan amendment), which is not an integration.
// Run r2 has no status.json; its one task branch is still a live `teammates/` ref.
async function buildFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-census-'))
  const repo = path.join(dir, 'repo')
  await mkdir(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  await commitFile(repo, 'base.txt', 'one\n', 'chore: base', at(0))
  git(repo, ['branch', 'run/r1'])
  git(repo, ['branch', 'run/r2'])

  git(repo, ['checkout', '-q', '-b', 'fleetmates/r1/T1', 'run/r1'])
  const t1 = await commitFile(repo, 'a.txt', 'a\n', 'feat: a', at(10))
  git(repo, ['checkout', '-q', '-b', 'fleetmates/r1/T2', 'run/r1'])
  const t2 = await commitFile(repo, 'b.txt', 'b\n', 'feat: b', at(20))
  git(repo, ['checkout', '-q', '-b', 'fleetmates/r1/T3', 'run/r1'])
  const t3 = await commitFile(repo, 'base.txt', 'three\n', 'feat: three', at(30))

  git(repo, ['checkout', '-q', 'run/r1'])
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r1): T1 a', 'fleetmates/r1/T1'], at(1000))
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r1): T2 b\n\nbody line\n\nCo-Authored-By: x <x@example.invalid>', 'fleetmates/r1/T2'], at(1100))
  await commitFile(repo, 'base.txt', 'integrator\n', 'fix: integrator edit', at(1200))

  git(repo, ['checkout', '-q', 'main'])
  await commitFile(repo, 'plan.md', 'plan\n', 'docs: amend plan', at(1500))
  git(repo, ['checkout', '-q', 'run/r1'])
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge: take the amendment into run/r1', 'main'], at(1600))

  const conflicted = spawnSync('git', ['merge', '--no-ff', '-m', 'merge(r1): T3 three', 'fleetmates/r1/T3'], { cwd: repo })
  assert.notEqual(conflicted.status, 0, 'the fixture needs T3 to conflict')
  await writeFile(path.join(repo, 'base.txt'), 'resolved\n', 'utf8')
  git(repo, ['add', 'base.txt'], at(5000))
  // An explicit -m: `--no-edit` keeps git's `# Conflicts:` block, which is not the single-line form.
  git(repo, ['commit', '-q', '-m', 'merge(r1): T3 three'], at(5000))

  git(repo, ['checkout', '-q', '-b', 'teammates/r2/T1', 'run/r2'])
  await commitFile(repo, 'c.txt', 'c\n', 'feat: c', at(6000))
  git(repo, ['checkout', '-q', 'run/r2'])
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge(r2): T1 c', 'teammates/r2/T1'], at(6100))
  git(repo, ['checkout', '-q', 'main'])

  git(repo, ['branch', '-D', 'fleetmates/r1/T1', 'fleetmates/r1/T2'])

  const stateDir = path.join(repo, '.fleetmates', 'r1')
  await mkdir(stateDir, { recursive: true })
  await writeFile(path.join(stateDir, 'status.json'), JSON.stringify({
    runId: 'r1',
    gates: {
      1: { verdict: 'PASS', phase: 1, branchShas: { 'fleetmates/r1/T1': t1, 'fleetmates/r1/T2': t2 } },
      2: { verdict: 'PASS', phase: 2, branchShas: { 'fleetmates/r1/T3': t3 } },
    },
    integrations: {
      1: { status: 'done', escalated: [] },
      2: { status: 'blocked', escalated: [{ taskId: 'T3', reason: 'semantic' }] },
    },
  }), 'utf8')

  // One integrator transcript spanning phase 1's merges, and one reviewer transcript over the same
  // window that must not be joined. Phase 2 has none.
  const projectsDir = path.join(dir, 'config', 'projects')
  const subagents = path.join(projectsDir, projectSlug(path.resolve(repo)), 'sess-1', 'subagents')
  await mkdir(subagents, { recursive: true })
  const record = (offset, output) => JSON.stringify({
    timestamp: new Date((T0 + offset) * 1000).toISOString(),
    message: { usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })
  await writeFile(path.join(subagents, 'agent-int.jsonl'), [record(990, 10), record(1050, 10), record(1210, 10)].join('\n'), 'utf8')
  await writeFile(path.join(subagents, 'agent-int.meta.json'), JSON.stringify({ agentType: 'fleetmates:tm-integrator', model: 'haiku' }), 'utf8')
  await writeFile(path.join(subagents, 'agent-rev.jsonl'), [record(990, 99), record(1210, 99)].join('\n'), 'utf8')
  await writeFile(path.join(subagents, 'agent-rev.meta.json'), JSON.stringify({ agentType: 'fleetmates:tm-reviewer', model: 'opus' }), 'utf8')

  return { dir, repo, projectsDir, configDir: path.join(dir, 'config') }
}

async function withFixture(fn) {
  const fx = await buildFixture()
  try {
    await fn(fx)
  } finally {
    await rm(fx.dir, { recursive: true, force: true })
  }
}

// Rows carry hashed keys only, so the tests identify a row by the order the census emits them in:
// per run branch (sorted by name), oldest merge first.
async function rowsFor(fx) {
  const rows = await censusRoot({ root: fx.repo, projectsDir: fx.projectsDir })
  return rows
}

test('finds every integration merge, including pruned task branches, and skips a base merge', async () => {
  await withFixture(async (fx) => {
    const rows = await rowsFor(fx)
    assert.equal(rows.length, 4, 'three merges on run/r1 and one on run/r2; the base merge is not an integration')
    const [r1t1, r1t2, r1t3, r2t1] = rows
    assert.equal(r1t1.run, r1t2.run)
    assert.equal(r1t1.run, r1t3.run)
    assert.notEqual(r1t1.run, r2t1.run)
  })
})

test('records the phase and the number of branches merged in it', async () => {
  await withFixture(async (fx) => {
    const [r1t1, r1t2, r1t3, r2t1] = await rowsFor(fx)
    assert.equal(r1t1.phase, 1)
    assert.equal(r1t2.phase, 1)
    assert.equal(r1t3.phase, 2)
    assert.equal(r1t1.branchesInPhase, 2)
    assert.equal(r1t3.branchesInPhase, 1)
    assert.equal(r2t1.phase, null, 'no status.json means the phase is unknown, not phase 0')
    assert.equal(r2t1.branchesInPhase, null)
  })
})

test('a merge whose tree differs from a clean merge-tree needed conflict resolution', async () => {
  await withFixture(async (fx) => {
    const [r1t1, r1t2, r1t3, r2t1] = await rowsFor(fx)
    assert.equal(r1t1.conflict, false)
    assert.equal(r1t2.conflict, false)
    assert.equal(r1t3.conflict, true)
    assert.equal(r2t1.conflict, false)
  })
})

test('counts the non-merge commits the integrator made after a merge', async () => {
  await withFixture(async (fx) => {
    const [r1t1, r1t2, r1t3] = await rowsFor(fx)
    assert.equal(r1t1.nonMergeCommits, 0)
    assert.equal(r1t2.nonMergeCommits, 1)
    assert.equal(r1t3.nonMergeCommits, 0)
  })
})

test('a message is in the dispatched form only as a single line naming the task', async () => {
  await withFixture(async (fx) => {
    const [r1t1, r1t2, r1t3, r2t1] = await rowsFor(fx)
    assert.equal(r1t1.messageForm, true)
    assert.equal(r1t2.messageForm, false, 'a body and a trailer are not the single-line form')
    assert.equal(r1t3.messageForm, true)
    assert.equal(r2t1.messageForm, true)
  })
})

test('escalation and blocked come from status.json, and are null where nothing was recorded', async () => {
  await withFixture(async (fx) => {
    const [r1t1, , r1t3, r2t1] = await rowsFor(fx)
    assert.equal(r1t1.escalated, false)
    assert.equal(r1t1.blocked, false)
    assert.equal(r1t3.escalated, true)
    assert.equal(r1t3.blocked, true)
    assert.equal(r2t1.escalated, null)
    assert.equal(r2t1.blocked, null)
  })
})

test('joins the integrator transcript covering a merge and records a missing one as missing', async () => {
  await withFixture(async (fx) => {
    const [r1t1, r1t2, r1t3] = await rowsFor(fx)
    assert.equal(r1t1.transcript.status, 'found')
    assert.equal(r1t1.transcript.model, 'haiku')
    assert.equal(r1t1.transcript.turns, 3)
    assert.equal(r1t1.transcript.output, 30)
    assert.equal(r1t2.transcript.session, r1t1.transcript.session, 'one integrator session merged the whole phase')
    assert.equal(r1t3.transcript.status, 'missing')
    assert.equal(r1t3.transcript.turns, null, 'missing is never 0')
    assert.equal(r1t3.transcript.output, null)
    assert.equal(r1t3.transcript.model, null)
  })
})

test('a root with no transcript store records every transcript as missing', async () => {
  await withFixture(async (fx) => {
    const rows = await censusRoot({ root: fx.repo, projectsDir: path.join(fx.dir, 'nowhere') })
    assert.equal(rows.length, 4)
    for (const row of rows) {
      assert.equal(row.transcript.status, 'missing')
      assert.equal(row.transcript.turns, null)
    }
  })
})

test('rows carry hashed keys and metrics, never run names, task ids or messages', async () => {
  await withFixture(async (fx) => {
    const rows = await rowsFor(fx)
    const text = JSON.stringify(rows)
    for (const plain of ['r1', 'r2', 'T1', 'T2', 'T3', 'merge(', 'fleetmates/', 'teammates/', fx.repo, 'sess-1', 'agent-int']) {
      assert.ok(!text.includes(plain), `rows must not contain ${plain}`)
    }
    for (const row of rows) {
      assert.match(row.key, /^[0-9a-f]{16}$/)
      assert.match(row.run, /^[0-9a-f]{12}$/)
    }
  })
})

test('summary reports clean share, conflicts, escalations, turn percentiles and the model mix', async () => {
  await withFixture(async (fx) => {
    const summary = summarize(await rowsFor(fx))
    assert.equal(summary.integrations, 4)
    assert.equal(summary.clean, 3)
    assert.equal(summary.cleanShare, 0.75)
    assert.equal(summary.conflicts, 1)
    assert.equal(summary.escalations, 1)
    assert.equal(summary.escalationUnrecorded, 1)
    assert.equal(summary.transcripts.sessions, 1, 'turns are per integrator session, not per merge')
    assert.equal(summary.transcripts.missingRows, 2)
    assert.equal(summary.turns.median, 3)
    assert.equal(summary.turns.p90, 3)
    assert.deepEqual(summary.modelMix, { haiku: 1 })
  })
})

test('summary turn statistics are null when no transcript was found', () => {
  const summary = summarize([])
  assert.equal(summary.integrations, 0)
  assert.equal(summary.cleanShare, null)
  assert.equal(summary.turns.median, null)
  assert.equal(summary.turns.p90, null)
  assert.deepEqual(summary.modelMix, {})
})

function runTool(args, env) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
}

test('the CLI is a dry run by default and writes nothing', async () => {
  await withFixture(async (fx) => {
    const out = path.join(fx.dir, 'out')
    const res = runTool(['--roots', fx.repo, '--out', out], { CLAUDE_CONFIG_DIR: fx.configDir })
    assert.equal(res.status, 0, res.stderr + res.stdout)
    assert.match(res.stdout, /dry run/)
    assert.match(res.stdout, /"integrations": 4/)
    await assert.rejects(readdir(out), 'a dry run must not create the output directory')
  })
})

test('--execute writes integrator-census.json with rows and the summary', async () => {
  await withFixture(async (fx) => {
    const out = path.join(fx.dir, 'out')
    const res = runTool(['--roots', `${fx.repo},${fx.repo}`, '--out', out, '--execute'], { CLAUDE_CONFIG_DIR: fx.configDir })
    assert.equal(res.status, 0, res.stderr + res.stdout)
    const written = JSON.parse(await readFile(path.join(out, 'integrator-census.json'), 'utf8'))
    assert.equal(written.rows.length, 4, 'a root named twice is censused once')
    assert.equal(written.summary.conflicts, 1)
    assert.equal(written.summary.transcripts.sessions, 1)
    assert.ok(!JSON.stringify(written).includes(fx.repo), 'the root path is not written')
  })
})

test('the CLI refuses a missing --roots or a root that is not a repository', async () => {
  const res = runTool(['--out', tmpdir()], {})
  assert.equal(res.status, 2)
  assert.match(res.stdout + res.stderr, /--roots/)
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-census-norepo-'))
  try {
    const bad = runTool(['--roots', dir], {})
    assert.equal(bad.status, 2)
    assert.match(bad.stdout + bad.stderr, /not a git repository/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
