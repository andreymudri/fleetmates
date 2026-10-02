import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFleetmatesReader, createTaskLocator, fleetmatesScriptsDir, isRunName, taskForCwd } from '../../server/adapters/fleetmates.mjs'

const rootState = await import(pathToFileURL(path.join(fleetmatesScriptsDir(), 'state.mjs')).href)

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

test('reader refuses a run file symlink even when its target is valid JSON', async () => {
  await withRepo(async (repo) => {
    const dir = await writeRun(repo, 'r1', { runId: 'r1', tasks: [] })
    const outside = path.join(repo, 'outside.json')
    await writeFile(outside, JSON.stringify({ runId: 'r1', tasks: [] }))
    await symlink(outside, path.join(dir, 'status.json'))
    const reader = createFleetmatesReader({ repoRoots: [repo], pollRun: async () => ({ derivedPhase: null }) })
    try { assert.equal((await reader.list())[0].readError.file, 'status.json') } finally { reader.close() }
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
    const old = new Date('2020-01-01T00:00:00.000Z')
    await Promise.all(['plan.json', 'status.json'].map((name) => utimes(path.join(dir, name), old, old)))
    const before = await Promise.all(['plan.json', 'status.json'].map((name) => readFile(path.join(dir, name))))
    const mtimeBefore = await Promise.all(['plan.json', 'status.json'].map(async (name) => (await stat(path.join(dir, name))).mtimeMs))
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
      assert.deepEqual(await Promise.all(['plan.json', 'status.json'].map(async (name) => (await stat(path.join(dir, name))).mtimeMs)), mtimeBefore)
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

test('a run directory deleted and recreated with the same id gets a fresh watcher', async () => {
  await withRepo(async (repo) => {
    const plan = { runId: 'r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }
    const status = (state) => ({ runId: 'r1', tasks: [{ id: 'T1', state }] })
    const opened = []
    let notifications = 0
    const reader = createFleetmatesReader({
      repoRoots: [repo], debounceMs: 10, pollRun: async () => ({ derivedPhase: 1 }),
      watchFactory: (dir, callback) => {
        const watcher = fs.watch(dir, callback)
        const record = { dir, closed: false }
        const close = watcher.close.bind(watcher)
        watcher.close = () => { record.closed = true; close() }
        opened.push(record)
        return watcher
      },
    })
    const until = async (predicate, ms = 2000) => {
      const end = Date.now() + ms
      while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
      return predicate()
    }
    try {
      reader.watch(() => { notifications++ })
      const dir = await writeRun(repo, 'r1', plan, status('pending'))
      assert.equal((await reader.list()).length, 1)
      await writeFile(path.join(dir, 'status.json'), JSON.stringify(status('running')))
      assert.ok(await until(() => notifications >= 1), 'first edit notifies')
      await rm(dir, { recursive: true, force: true })
      assert.equal((await reader.list()).length, 0)
      assert.deepEqual(opened.filter((record) => !record.closed), [], 'no watcher left open for a vanished run')
      await writeRun(repo, 'r1', plan, status('pending'))
      assert.equal((await reader.list()).length, 1)
      const before = notifications
      await writeFile(path.join(dir, 'status.json'), JSON.stringify(status('done')))
      assert.ok(await until(() => notifications > before), 'edit after recreation notifies within 2 s')
      assert.equal((await reader.list())[0].tasks[0].state, 'done')
    } finally {
      reader.close()
    }
  })
})

test('a watcher that reports its own run directory removed is closed before the next list', async () => {
  await withRepo(async (repo) => {
    const dir = await writeRun(repo, 'r1', {
      runId: 'r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }],
    }, { runId: 'r1', tasks: [{ id: 'T1', state: 'pending' }] })
    const watchers = []
    const notified = []
    const reader = createFleetmatesReader({
      repoRoots: [repo], debounceMs: 10, pollRun: async () => ({ derivedPhase: 1 }),
      watchFactory: (_dir, callback) => {
        const watcher = { callback, closed: false, close() { this.closed = true } }
        watchers.push(watcher)
        return watcher
      },
    })
    try {
      reader.watch((repoRoot, runId) => { notified.push(runId) })
      await reader.list()
      assert.equal(watchers.length, 1)
      watchers[0].callback('rename', 'status.json')
      assert.equal(watchers[0].closed, false, 'a file rename inside the run keeps the watcher')
      await rm(dir, { recursive: true, force: true })
      watchers[0].callback('rename', 'r1')
      assert.equal(watchers[0].closed, true)
      assert.deepEqual(notified, ['r1'])
      await writeRun(repo, 'r1', { runId: 'r1', totalPhases: 1, tasks: [] }, { runId: 'r1', tasks: [] })
      await reader.list()
      assert.equal(watchers.length, 2, 'the recreated run gets a fresh watcher')
      assert.equal(watchers[1].closed, false)
    } finally {
      reader.close()
    }
  })
})

test('missing task branch with done status keeps the phase open as unknown', async () => {
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
      assert.equal(run.derivedPhase, 1)
      assert.equal(run.phaseDerivation, 'unknown')
    } finally { reader.close() }
  })
})

test('a passed gate permits a pruned task branch to appear complete but unverified', async () => {
  await withRepo(async (repo) => {
    execFileSync('git', ['init', '-q', '-b', 'run/r1'], { cwd: repo })
    await writeFile(path.join(repo, 'readme.txt'), 'run')
    execFileSync('git', ['add', 'readme.txt'], { cwd: repo })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'run'], { cwd: repo })
    await writeRun(repo, 'r1', { runId: 'r1', runBranch: 'run/r1', totalPhases: 1, tasks: [{ id: 'T1', title: 'Task', phase: 1 }] }, {
      runId: 'r1', tasks: [{ id: 'T1', state: 'done' }], gates: { 1: { verdict: 'PASS', phase: 1 } },
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

// taskForCwd (M2 Task 7): the one index record for a worktree, read synchronously with the root guards.
async function withTeammate(run) {
  await withRepo(async (base) => {
    const repo = fs.realpathSync(base)
    const worktree = path.join(repo, 'wt-T2')
    await mkdir(worktree)
    await rootState.writeLocation(repo, 'r1', 'T2', { worktree, branch: 'fleetmates/r1/T2' })
    await run(repo, worktree)
  })
}

/** Every file under `.fleetmates/` with its size and mtime, to prove a lookup writes nothing. */
function stateTree(repo) {
  const rows = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const info = fs.lstatSync(full)
      rows.push(`${path.relative(repo, full)} ${info.size} ${info.mtimeMs}`)
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(path.join(repo, '.fleetmates'))
  return rows.sort()
}

/** A locator over the real file system that counts the record opens. */
function countingLocator(clock) {
  let opens = 0
  const locator = createTaskLocator({
    clock: () => clock.now,
    io: { ...fs, openSync: (...args) => { opens++
      return fs.openSync(...args) } },
  })
  return { locator, get opens() { return opens } }
}

test('taskForCwd resolves a worktree to its run and task, and null for any other directory', async () => {
  await withTeammate(async (repo, worktree) => {
    const before = stateTree(repo)
    assert.deepEqual(taskForCwd(repo, worktree), { runId: 'r1', taskId: 'T2' })
    assert.deepEqual(taskForCwd(repo, `${worktree}/`), { runId: 'r1', taskId: 'T2' }, 'the key is the normalised path')
    assert.equal(taskForCwd(repo, repo), null)
    assert.equal(taskForCwd(repo, path.join(repo, 'elsewhere')), null)
    assert.equal(taskForCwd(repo, ''), null)
    assert.equal(taskForCwd('relative/repo', worktree), null)
    assert.deepEqual(stateTree(repo), before, 'the lookup writes nothing under .fleetmates/')
  })
})

test('taskForCwd caches a hit for 60 s and never caches a miss', async () => {
  await withTeammate(async (repo, worktree) => {
    const clock = { now: 1_000 }
    const h = countingLocator(clock)
    assert.deepEqual(h.locator.taskForCwd(repo, worktree), { runId: 'r1', taskId: 'T2' })
    assert.equal(h.opens, 1)
    clock.now += 59_999
    assert.deepEqual(h.locator.taskForCwd(repo, worktree), { runId: 'r1', taskId: 'T2' })
    assert.equal(h.opens, 1, 'a second lookup inside 60 s reads nothing')
    clock.now += 1
    assert.deepEqual(h.locator.taskForCwd(repo, worktree), { runId: 'r1', taskId: 'T2' })
    assert.equal(h.opens, 2, 'the entry expires at 60 s')
    // A teammate's `locate` writes its record after its own hook already looked the worktree up.
    const later = path.join(repo, 'wt-T3')
    await mkdir(later)
    assert.equal(h.locator.taskForCwd(repo, later), null)
    assert.equal(h.opens, 3)
    await rootState.writeLocation(repo, 'r1', 'T3', { worktree: later, branch: 'fleetmates/r1/T3' })
    assert.deepEqual(h.locator.taskForCwd(repo, later), { runId: 'r1', taskId: 'T3' }, 'the earlier miss was not cached')
    assert.equal(h.opens, 4)
  })
})

test('taskForCwd refuses an oversized record, a FIFO and a record naming another worktree', async () => {
  await withTeammate(async (repo, worktree) => {
    const record = path.join(rootState.indexDir(repo), `${rootState.worktreeKey(worktree)}.json`)
    const fresh = () => createTaskLocator().taskForCwd(repo, worktree)
    const valid = fs.readFileSync(record, 'utf8')
    fs.writeFileSync(record, valid.trimEnd() + ' '.repeat(64 * 1024))
    assert.equal(fresh(), null, 'over 64 KiB')
    fs.writeFileSync(record, valid.trimEnd() + ' '.repeat(64 * 1024 - Buffer.byteLength(valid.trimEnd())))
    assert.deepEqual(fresh(), { runId: 'r1', taskId: 'T2' }, 'exactly 64 KiB is still read')
    fs.writeFileSync(record, JSON.stringify({ runId: 'r1', taskId: 'T2', worktree: path.join(repo, 'other') }))
    assert.equal(fresh(), null, 'a record filed under one key naming another directory')
    fs.writeFileSync(record, JSON.stringify({ runId: 'r1', taskId: 'T2', worktree: 'wt-T2' }))
    assert.equal(fresh(), null, 'a relative worktree')
    fs.rmSync(record)
    execFileSync('mkfifo', [record])
    // In a child process: a blocking open on a FIFO with no writer never returns, so in-process it would hang the runner.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { createTaskLocator } = await import(${JSON.stringify(new URL('../../server/adapters/fleetmates.mjs', import.meta.url).href)})
       process.stdout.write(JSON.stringify(createTaskLocator().taskForCwd(${JSON.stringify(repo)}, ${JSON.stringify(worktree)})))`],
    { encoding: 'utf8', timeout: 10_000 })
    assert.equal(child.signal, null, 'the FIFO lookup returned instead of blocking')
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout, 'null')
  })
})

test('taskForCwd applies the root name rules exactly as findTaskByWorktree does', async () => {
  await withTeammate(async (repo, worktree) => {
    const record = path.join(rootState.indexDir(repo), `${rootState.worktreeKey(worktree)}.json`)
    const runIds = ['r1', '2026/substop', '../x', 'a..b', '-x', 'x;y', '', 'r\u200b1', 'e\u0301', '/abs', 'a//b', 'r'.repeat(255), 'r'.repeat(256), 'é', 7]
    const taskIds = ['T2', 'T2/x', '..', '.', '-T', 'T\u2800', 'x'.repeat(128), 'x'.repeat(129), null]
    let compared = 0
    for (const runId of runIds) {
      for (const taskId of taskIds) {
        fs.writeFileSync(record, JSON.stringify({ runId, taskId, worktree }))
        const expected = await rootState.findTaskByWorktree(repo, worktree)
        const actual = createTaskLocator().taskForCwd(repo, worktree)
        assert.deepEqual(actual, expected && { runId: expected.runId, taskId: expected.taskId }, JSON.stringify({ runId, taskId }))
        compared++
      }
    }
    assert.ok(compared > 100)
    for (const runId of runIds) {
      fs.writeFileSync(record, JSON.stringify({ runId, taskId: 'T2', worktree }))
      assert.equal(isRunName(repo, runId), (await rootState.findTaskByWorktree(repo, worktree)) !== null, JSON.stringify(runId))
    }
    assert.equal(isRunName(repo, 'r1'), true)
    assert.equal(isRunName(repo, '2026/substop'), true)
    assert.equal(isRunName(repo, '../escape'), false)
    assert.equal(isRunName(repo, '-rf'), false)
  })
})
