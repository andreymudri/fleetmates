import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFleetmatesReader } from '../../server/adapters/fleetmates.mjs'

async function withRepo(run) {
  const repo = await mkdtemp(path.join(tmpdir(), 'deck-runs-'))
  try {
    await run(repo)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

async function writeRun(repo, runId, plan, status) {
  const dir = path.join(repo, '.fleetmates', runId)
  await mkdir(dir, { recursive: true })
  if (plan !== undefined) await writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan))
  if (status !== undefined) await writeFile(path.join(dir, 'status.json'), JSON.stringify(status))
  return dir
}

test('reader discovers nested runs, skips index and keeps unknown states as safe text', async () => {
  await withRepo(async (repo) => {
    const runDir = await writeRun(repo, '2026/substop', {
      runId: '2026/substop', totalPhases: 2,
      tasks: [{ id: 'T1', title: 'Build\u202ehidden', phase: 2, files: ['src/a.js'], deps: [] }],
    }, {
      runId: '2026/substop', tasks: [{ id: 'T1', title: 'Build\u202ehidden', state: 'surprise\u202e' }],
    })
    await writeRun(repo, 'index', { runId: 'index', tasks: [] }, { runId: 'index', tasks: [] })
    await mkdir(path.join(runDir, 'worktrees', 'copy'), { recursive: true })
    await writeFile(path.join(runDir, 'worktrees', 'copy', 'plan.json'), '{"runId":"copy"}')
    const reader = createFleetmatesReader({ repoRoots: [repo], pollRun: async () => ({ derivedPhase: 2 }) })
    try {
      const runs = await reader.list()
      assert.equal(runs.length, 1)
      assert.equal(runs[0].runId, '2026/substop')
      assert.equal(runs[0].derivedPhase, 2)
      assert.equal(runs[0].tasks[0].title, 'Buildhidden')
      assert.equal(runs[0].tasks[0].state, 'surprise')
      assert.equal(runs[0].tasks[0].phaseLabel, 'Phase 2')
      assert.deepEqual(runs[0].gates, {})
      assert.equal(runs[0].readError, null)
    } finally {
      reader.close()
    }
  })
})

test('reader returns an error for truncated JSON or a FIFO without hanging', async () => {
  await withRepo(async (repo) => {
    const dir = await writeRun(repo, 'r1', { runId: 'r1', totalPhases: 1, tasks: [] })
    await writeFile(path.join(dir, 'status.json'), '{"tasks":')
    const reader = createFleetmatesReader({ repoRoots: [repo], retryDelayMs: 1 })
    try {
      const [truncated] = await reader.list()
      assert.equal(truncated.readError.file, 'status.json')
      assert.equal(truncated.readError.message.length > 0, true)
      reader.invalidate(repo, 'r1')
      await rm(path.join(dir, 'status.json'))
      execFileSync('mkfifo', [path.join(dir, 'status.json')])
      const [fifo] = await Promise.race([
        reader.list(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('FIFO read hung')), 1000)),
      ])
      assert.equal(fifo.readError.file, 'status.json')
    } finally {
      reader.close()
    }
  })
})

test('temporary status read error keeps the last good task state', async () => {
  await withRepo(async (repo) => {
    const dir = await writeRun(repo, 'r1', { runId: 'r1', tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'running' }],
    })
    const reader = createFleetmatesReader({ repoRoots: [repo], pollRun: async () => ({ derivedPhase: 1 }) })
    try {
      assert.equal((await reader.list())[0].tasks[0].state, 'running')
      await writeFile(path.join(dir, 'status.json'), '{invalid')
      reader.invalidate(repo, 'r1')
      const [stale] = await reader.list()
      assert.equal(stale.tasks[0].state, 'running')
      assert.equal(stale.readError.file, 'status.json')
      await writeFile(path.join(dir, 'status.json'), JSON.stringify({ runId: 'r1', tasks: [{ id: 'T1', state: 'done' }] }))
      reader.invalidate(repo, 'r1')
      assert.equal((await reader.list())[0].tasks[0].state, 'done')
    } finally { reader.close() }
  })
})

test('malformed agent title cannot crash run discovery', async () => {
  await withRepo(async (repo) => {
    await writeRun(repo, 'r1', { runId: 'r1', tasks: [{ id: 'T1', title: { toString: null }, phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'running' }],
    })
    const reader = createFleetmatesReader({ repoRoots: [repo], pollRun: async () => ({ derivedPhase: 1 }) })
    try {
      const [run] = await reader.list()
      assert.equal(run.tasks[0].title, '')
      assert.equal(run.tasks[0].state, 'running')
    } finally { reader.close() }
  })
})

test('reader does not create a missing status file', async () => {
  await withRepo(async (repo) => {
    const dir = await writeRun(repo, 'r1', { runId: 'r1', tasks: [] })
    const before = await readdir(dir)
    const reader = createFleetmatesReader({ repoRoots: [repo], pollRun: async () => ({ derivedPhase: null, liveness: [] }) })
    try {
      await reader.list()
      assert.deepEqual(await readdir(dir), before)
    } finally { reader.close() }
  })
})

test('reader can open run files that have no write permission', async () => {
  await withRepo(async (repo) => {
    const dir = await writeRun(repo, 'r1', { runId: 'r1', tasks: [] }, { runId: 'r1', tasks: [] })
    await chmod(path.join(dir, 'plan.json'), 0o444)
    await chmod(path.join(dir, 'status.json'), 0o444)
    const reader = createFleetmatesReader({ repoRoots: [repo], pollRun: async () => ({ derivedPhase: null, liveness: [] }) })
    try { assert.equal((await reader.list())[0].readError, null) } finally { reader.close() }
  })
})

test('reader polls an active run at most once per 60 seconds and never edits run files', async () => {
  await withRepo(async (repo) => {
    const dir = await writeRun(repo, 'r1', { runId: 'r1', totalPhases: 2, tasks: [] }, {
      runId: 'r1', tasks: [], gates: { 1: { verdict: 'PASS', phase: 1 } },
    })
    const before = await Promise.all(['plan.json', 'status.json'].map((name) => readFile(path.join(dir, name))))
    const entriesBefore = (await readdir(dir, { recursive: true })).sort()
    let now = 1_000_000
    let polls = 0
    const reader = createFleetmatesReader({
      repoRoots: [repo], clock: () => now,
      pollRun: async () => { polls++; return { derivedPhase: 2 } },
    })
    try {
      await reader.list()
      await reader.list()
      now += 59_999
      await reader.list()
      assert.equal(polls, 1)
      now += 1
      await reader.list()
      assert.equal(polls, 2)
      const after = await Promise.all(['plan.json', 'status.json'].map((name) => readFile(path.join(dir, name))))
      assert.deepEqual(after, before)
      assert.deepEqual((await readdir(dir, { recursive: true })).sort(), entriesBefore)
    } finally {
      reader.close()
    }
  })
})

test('run file changes are debounced and refresh rows without another git poll', async () => {
  await withRepo(async (repo) => {
    const dir = await writeRun(repo, 'r1', {
      runId: 'r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }],
    }, { runId: 'r1', tasks: [{ id: 'T1', state: 'pending' }] })
    let change
    let notifications = 0
    let polls = 0
    const reader = createFleetmatesReader({
      repoRoots: [repo], clock: () => 1_000_000, debounceMs: 10,
      pollRun: async () => { polls++; return { derivedPhase: 1 } },
      watchFactory: (_dir, callback) => {
        change = callback
        return { close() {} }
      },
    })
    try {
      reader.watch(() => { notifications++ })
      assert.equal((await reader.list())[0].tasks[0].state, 'pending')
      await writeFile(path.join(dir, 'status.json'), JSON.stringify({
        runId: 'r1', tasks: [{ id: 'T1', state: 'done' }],
      }))
      change()
      change()
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(notifications, 1)
      assert.equal((await reader.list())[0].tasks[0].state, 'done')
      assert.equal(polls, 1)
    } finally {
      reader.close()
    }
  })
})

test('missing task branch with done status has an unknown derived phase', async () => {
  await withRepo(async (repo) => {
    execFileSync('git', ['init', '-q', '-b', 'run/r1'], { cwd: repo })
    await writeFile(path.join(repo, 'readme.txt'), 'run')
    execFileSync('git', ['add', 'readme.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'run'], { cwd: repo })
    await writeRun(repo, 'r1', { runId: 'r1', runBranch: 'run/r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'done' }],
    })
    const reader = createFleetmatesReader({ repoRoots: [repo] })
    try {
      const [run] = await reader.list()
      assert.equal(run.derivedPhase, null)
      assert.equal(run.phaseDerivation, 'unknown')
    } finally { reader.close() }
  })
})

test('task branch at the run tip stays in its pending phase', async () => {
  await withRepo(async (repo) => {
    execFileSync('git', ['init', '-q', '-b', 'run/r1'], { cwd: repo })
    await writeFile(path.join(repo, 'readme.txt'), 'run')
    execFileSync('git', ['add', 'readme.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'run'], { cwd: repo })
    execFileSync('git', ['branch', 'fleetmates/r1/T1'], { cwd: repo })
    await writeRun(repo, 'r1', { runId: 'r1', runBranch: 'run/r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'pending' }],
    })
    let now = Date.now()
    const reader = createFleetmatesReader({ repoRoots: [repo], clock: () => now })
    try {
      assert.equal((await reader.list())[0].derivedPhase, 1)
      await writeFile(path.join(repo, '.fleetmates', 'r1', 'status.json'), JSON.stringify({ runId: 'r1', tasks: [{ id: 'T1', state: 'done' }] }))
      now += 60_000
      reader.invalidate(repo, 'r1')
      assert.equal((await reader.list())[0].derivedPhase, 1)
    } finally { reader.close() }
  })
})

test('base-only task branch remains pending after an unrelated run commit', async () => {
  await withRepo(async (repo) => {
    execFileSync('git', ['init', '-q', '-b', 'run/r1'], { cwd: repo })
    await writeFile(path.join(repo, 'base.txt'), 'base')
    execFileSync('git', ['add', 'base.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base'], { cwd: repo })
    execFileSync('git', ['branch', 'fleetmates/r1/T1'], { cwd: repo })
    await writeFile(path.join(repo, 'unrelated.txt'), 'run only')
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'unrelated'], { cwd: repo })
    await writeRun(repo, 'r1', { runId: 'r1', runBranch: 'run/r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'pending' }],
    })
    const reader = createFleetmatesReader({ repoRoots: [repo] })
    try { assert.equal((await reader.list())[0].derivedPhase, 1) } finally { reader.close() }
  })
})

test('run polling does not execute repository fsmonitor commands', async () => {
  await withRepo(async (repo) => {
    execFileSync('git', ['init', '-q', '-b', 'run/r1'], { cwd: repo })
    await writeFile(path.join(repo, 'base.txt'), 'base')
    execFileSync('git', ['add', 'base.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base'], { cwd: repo })
    const worktree = path.join(repo, 'tasks', 'T1')
    await mkdir(path.dirname(worktree), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'fleetmates/r1/T1', worktree], { cwd: repo })
    const script = path.join(repo, 'fsmonitor.sh')
    await writeFile(script, `#!/bin/sh\ntouch ${path.join(repo, 'fsmonitor-executed')}\n`)
    await chmod(script, 0o700)
    execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: repo })
    await writeRun(repo, 'r1', { runId: 'r1', runBranch: 'run/r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'running' }],
    })
    const reader = createFleetmatesReader({ repoRoots: [repo] })
    try {
      await reader.list()
      assert.equal((await readdir(repo)).includes('fsmonitor-executed'), false)
    } finally { reader.close() }
  })
})

test('fresh edits in a task worktree count as working with an old branch tip', async () => {
  await withRepo(async (repo) => {
    execFileSync('git', ['init', '-q', '-b', 'run/r1'], { cwd: repo })
    await writeFile(path.join(repo, 'readme.txt'), 'run')
    execFileSync('git', ['add', 'readme.txt'], { cwd: repo })
    const old = new Date(Date.now() - 25 * 60_000).toISOString()
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'run'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } })
    const worktree = path.join(repo, 'tasks', 'T1')
    await mkdir(path.dirname(worktree), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'fleetmates/r1/T1', worktree], { cwd: repo })
    await writeFile(path.join(worktree, 'active-edit.txt'), 'now')
    await writeRun(repo, 'r1', { runId: 'r1', runBranch: 'run/r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'running' }],
    })
    const reader = createFleetmatesReader({ repoRoots: [repo] })
    try { assert.equal((await reader.list())[0].teammates[0].liveness, 'working') } finally { reader.close() }
  })
})

test('an unmerged task branch keeps the phase open even when status says done', async () => {
  await withRepo(async (repo) => {
    execFileSync('git', ['init', '-q', '-b', 'run/r1'], { cwd: repo })
    await writeFile(path.join(repo, 'readme.txt'), 'run')
    execFileSync('git', ['add', 'readme.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'run'], { cwd: repo })
    execFileSync('git', ['switch', '-q', '-c', 'fleetmates/r1/T1'], { cwd: repo })
    await writeFile(path.join(repo, 'task.txt'), 'unmerged')
    execFileSync('git', ['add', 'task.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'task'], { cwd: repo })
    execFileSync('git', ['switch', '-q', 'run/r1'], { cwd: repo })
    await writeRun(repo, 'r1', { runId: 'r1', runBranch: 'run/r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'done' }],
    })
    const reader = createFleetmatesReader({ repoRoots: [repo] })
    try {
      const [run] = await reader.list()
      assert.equal(run.derivedPhase, 1)
      assert.equal(run.phaseDerivation, 'verified')
    } finally { reader.close() }
  })
})

test('a merged task branch marked done closes its phase', async () => {
  await withRepo(async (repo) => {
    execFileSync('git', ['init', '-q', '-b', 'run/r1'], { cwd: repo })
    await writeFile(path.join(repo, 'base.txt'), 'base')
    execFileSync('git', ['add', 'base.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base'], { cwd: repo })
    execFileSync('git', ['switch', '-q', '-c', 'fleetmates/r1/T1'], { cwd: repo })
    await writeFile(path.join(repo, 'task.txt'), 'task')
    execFileSync('git', ['add', 'task.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'task'], { cwd: repo })
    execFileSync('git', ['switch', '-q', 'run/r1'], { cwd: repo })
    execFileSync('git', ['merge', '-q', '--ff-only', 'fleetmates/r1/T1'], { cwd: repo })
    await writeRun(repo, 'r1', { runId: 'r1', runBranch: 'run/r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'done' }],
    })
    const reader = createFleetmatesReader({ repoRoots: [repo] })
    try {
      const [run] = await reader.list()
      assert.equal(run.derivedPhase, null)
      assert.equal(run.phaseDerivation, 'verified')
    } finally { reader.close() }
  })
})

test('recorded gate keyed by a manifest phase name remains visible', async () => {
  await withRepo(async (repo) => {
    await writeRun(repo, 'r1', { runId: 'r1', tasks: [] }, {
      runId: 'r1', tasks: [], gates: { default: { verdict: 'PASS', phase: null, phaseName: 'default', recordedAt: 1000 } },
    })
    const reader = createFleetmatesReader({ repoRoots: [repo], pollRun: async () => ({ derivedPhase: null, liveness: [] }) })
    try {
      const gate = (await reader.list())[0].gates.default
      assert.equal(gate.verdict, 'PASS')
      assert.equal(gate.phaseName, 'default')
    } finally { reader.close() }
  })
})
