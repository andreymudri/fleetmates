import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCli } from '../scripts/cli.mjs'
import { loadConfig } from '../scripts/config.mjs'
import { WATCH_DEFAULTS } from '../scripts/watch.mjs'
import { appendEvent, fingerprint, ledgerPath, readEvents } from '../scripts/event-ledger.mjs'

// Two tasks in ONE phase, so both are the current phase's subjects and the watchdog sees both.
const PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`
`

function git(cwd, args, env) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env })
}

async function withRun(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-watch-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  git(root, ['config', 'core.autocrlf', 'false'])
  await writeFile(path.join(root, 'plan.md'), PLAN, 'utf8')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\nfleetmates.local.json\nwt-*/\n', 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'initial'])
  git(root, ['checkout', '--quiet', '-b', 'run-branch'])
  const lines = []
  const io = { out: (t) => lines.push(t), err: () => {} }
  try {
    const code = await runCli(['init-run', path.join(root, 'plan.md'), '--run', 'r1', '--root', root], io)
    assert.equal(code, 0)
    lines.length = 0
    await fn({ root, io, lines, g: (args, env) => git(root, args, env) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// A task branch with one commit. `old` dates it in 2001, which is how a stalled teammate is
// reproduced without waiting for one.
async function taskBranch(root, g, id, file, { old = false } = {}) {
  g(['checkout', '--quiet', '-b', `fleetmates/r1/${id}`, 'run-branch'])
  await writeFile(path.join(root, file), `export const x = '${id}'\n`, 'utf8')
  g(['add', file])
  const when = old ? '2001-02-03T04:05:06Z' : new Date().toISOString()
  g(['commit', '--quiet', '-m', `${id} work`], { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when })
  g(['checkout', '--quiet', 'run-branch'])
}

async function ageTree(dir, whenMs) {
  const when = new Date(whenMs)
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      await utimes(full, when, when)
    }
  }
}

// T1 stalled (old tip, registered worktree untouched for six hours), T2 working (fresh tip).
async function stalledAndWorking(root, g) {
  await taskBranch(root, g, 'T1', 'a.mjs', { old: true })
  await taskBranch(root, g, 'T2', 'b.mjs')
  const wt = path.join(root, 'wt-T1')
  g(['worktree', 'add', '--quiet', wt, 'fleetmates/r1/T1'])
  await ageTree(wt, Date.now() - 6 * 60 * 60 * 1000)
  return wt
}

const events = (lines) => lines.map((l) => JSON.parse(l))
const watchOnce = (root, io, extra = []) =>
  runCli(['watch', '--run', 'r1', '--plan', 'plan.md', '--once', ...extra, '--root', root], io)
const watchJson = async (root) => JSON.parse(await readFile(path.join(root, '.fleetmates', 'r1', 'watch.json'), 'utf8'))
const envelopeFile = (root) => path.join(root, '.fleetmates', 'watch-envelope.json')

async function setStates(root, states) {
  const file = path.join(root, '.fleetmates', 'r1', 'status.json')
  const status = JSON.parse(await readFile(file, 'utf8'))
  for (const task of status.tasks) if (states[task.id]) task.state = states[task.id]
  await writeFile(file, JSON.stringify(status), 'utf8')
}

const HISTORY = { resumes: 0, respawns: 0, lastActionAt: null, orphaned: false, notified: false, maxQuietMs: 300000, sampled: false }

test('loadConfig resolves watch to the watchdog defaults plus learn and spinFailures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-watch-cfg-'))
  try {
    const { resolved } = await loadConfig(root)
    assert.deepEqual(resolved.watch, { ...WATCH_DEFAULTS, learn: true, spinFailures: 5 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// macOS reaches the temp dir through /var -> /private/var and Windows through an 8.3 name, so a
// --root that is not its own realpath is the normal case there. A symlink reproduces it on Linux.
test('watch --once records its action when --root is reached through a symlink', { skip: process.platform === 'win32' }, async () => {
  await withRun(async ({ root, io, lines, g }) => {
    const wt = await stalledAndWorking(root, g)
    const alias = `${root}-alias`
    await symlink(root, alias, 'dir')
    try {
      assert.equal(await watchOnce(alias, io), 0, lines.join('\n'))
      const out = events(lines)
      assert.deepEqual(out.map((e) => e.event), ['start', 'resume'], JSON.stringify(lines))
      const ledger = await readEvents(ledgerPath(root, 'r1', 'T1'))
      assert.ok(ledger.some((e) => e.kind === 'watchdog' && e.action === 'resume'), JSON.stringify(ledger))
    } finally {
      await rm(alias, { force: true })
      g(['worktree', 'remove', '--force', wt])
    }
  })
})

test('watch --once resumes the stalled task only, records it, and a second pass waits out the grace window', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    const wt = await stalledAndWorking(root, g)
    const code = await watchOnce(root, io)
    assert.equal(code, 0)
    const out = events(lines)
    assert.deepEqual(out[0], { event: 'start', staleMinutes: 20, learned: false, samples: 0 })
    assert.equal(out.length, 2, `exactly one action line, got ${JSON.stringify(lines)}`)
    assert.equal(out[1].event, 'resume')
    assert.equal(out[1].task, 'T1')
    assert.equal(out[1].attempt, 1)
    assert.equal(out[1].reason, undefined)
    assert.equal((await watchJson(root)).T1.resumes, 1)
    const ledger = await readEvents(ledgerPath(root, 'r1', 'T1'))
    assert.ok(ledger.some((e) => e.kind === 'watchdog' && e.action === 'resume'), JSON.stringify(ledger))
    assert.equal(existsSync(path.join(root, '.fleetmates', 'r1', 'watch.lock')), false, 'the lock is released')

    lines.length = 0
    assert.equal(await watchOnce(root, io), 0)
    assert.deepEqual(events(lines), [{ event: 'start', staleMinutes: 20, learned: false, samples: 0 }])
    assert.equal((await watchJson(root)).T1.resumes, 1)
    g(['worktree', 'remove', '--force', wt])
  })
})

test('watch --once exits phase-idle when every phase task is done', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await stalledAndWorking(root, g)
    await setStates(root, { T1: 'done', T2: 'done' })
    assert.equal(await watchOnce(root, io), 0)
    const out = events(lines)
    assert.deepEqual(out.at(-1), { event: 'exit', reason: 'phase-idle' })
    assert.equal(out.some((e) => e.event === 'resume'), false)
  })
})

test('watch refuses while another live watch holds the lock, and leaves the lock alone', async () => {
  await withRun(async ({ root, io, lines }) => {
    const lock = path.join(root, '.fleetmates', 'r1', 'watch.lock')
    // The parent of this test process: alive, and not this process's own pid.
    await writeFile(lock, `${process.ppid}\n`, 'utf8')
    const code = await watchOnce(root, io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), new RegExp(`pid ${process.ppid}`))
    assert.equal(await readFile(lock, 'utf8'), `${process.ppid}\n`)
  })
})

test('watch is a no-op when watch.enabled is false', async () => {
  await withRun(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify({ watch: { enabled: false } }), 'utf8')
    assert.equal(await watchOnce(root, io), 0)
    assert.match(lines.join('\n'), /watchdog disabled by watch\.enabled/)
    assert.equal(existsSync(path.join(root, '.fleetmates', 'r1', 'watch.json')), false)
  })
})

test('watch on a run id with no run directory exits 2', async () => {
  await withRun(async ({ root, io, lines }) => {
    const code = await runCli(['watch', '--run', 'nope', '--plan', 'plan.md', '--once', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /run nope has no directory/)
  })
})

async function failures(root, taskId, n) {
  const file = ledgerPath(root, 'r1', taskId)
  for (let i = 0; i < n; i++) {
    await appendEvent(file, { kind: 'command-run', at: Date.now() - 1000, fingerprint: fingerprint('npm test'), result: 'fail' })
  }
}

test('a working task that keeps failing the same command is resumed as spinning', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    await taskBranch(root, g, 'T2', 'b.mjs')
    await failures(root, 'T2', 5)
    assert.equal(await watchOnce(root, io), 0)
    const actions = events(lines).filter((e) => e.event !== 'start')
    assert.equal(actions.length, 1, JSON.stringify(lines))
    assert.equal(actions[0].event, 'resume')
    assert.equal(actions[0].task, 'T2')
    assert.equal(actions[0].attempt, 1)
    assert.equal(actions[0].reason, 'spinning')
  })
})

test('four failures of one command are not a spin', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    await taskBranch(root, g, 'T2', 'b.mjs')
    await failures(root, 'T2', 4)
    assert.equal(await watchOnce(root, io), 0)
    assert.deepEqual(events(lines).filter((e) => e.event !== 'start'), [])
  })
})

test('the start line reports a learned stale window, and watch.learn false keeps the configured one', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    await taskBranch(root, g, 'T2', 'b.mjs')
    await writeFile(envelopeFile(root), JSON.stringify({ v: 1, samplesMs: Array(5).fill(8 * 60000) }), 'utf8')
    assert.equal(await watchOnce(root, io), 0)
    assert.deepEqual(events(lines)[0], { event: 'start', staleMinutes: 12, learned: true, samples: 5 })

    lines.length = 0
    await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify({ watch: { learn: false } }), 'utf8')
    assert.equal(await watchOnce(root, io), 0)
    assert.deepEqual(events(lines)[0], { event: 'start', staleMinutes: 20, learned: false, samples: 0 })
  })
})

test('an unreadable envelope file reads as no samples', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    await taskBranch(root, g, 'T2', 'b.mjs')
    await writeFile(envelopeFile(root), '{not json', 'utf8')
    assert.equal(await watchOnce(root, io), 0)
    assert.deepEqual(events(lines)[0], { event: 'start', staleMinutes: 20, learned: false, samples: 0 })
  })
})

test('a task that finished without the watchdog acting adds exactly one envelope sample', async () => {
  await withRun(async ({ root, io, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    await taskBranch(root, g, 'T2', 'b.mjs')
    await setStates(root, { T1: 'done' })
    await writeFile(path.join(root, '.fleetmates', 'r1', 'watch.json'), JSON.stringify({ T1: HISTORY }), 'utf8')
    assert.equal(await watchOnce(root, io), 0)
    assert.deepEqual(JSON.parse(await readFile(envelopeFile(root), 'utf8')), { v: 1, samplesMs: [300000] })
    assert.equal((await watchJson(root)).T1.sampled, true)
    assert.equal(await watchOnce(root, io), 0)
    assert.deepEqual(JSON.parse(await readFile(envelopeFile(root), 'utf8')).samplesMs, [300000])
  })
})

test('the last task of a phase is sampled even though the watch exits phase-idle', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    await taskBranch(root, g, 'T2', 'b.mjs')
    await setStates(root, { T1: 'done', T2: 'done' })
    await writeFile(path.join(root, '.fleetmates', 'r1', 'watch.json'), JSON.stringify({ T1: HISTORY }), 'utf8')
    assert.equal(await watchOnce(root, io), 0)
    assert.deepEqual(events(lines).at(-1), { event: 'exit', reason: 'phase-idle' })
    assert.deepEqual(JSON.parse(await readFile(envelopeFile(root), 'utf8')).samplesMs, [300000])
    assert.equal((await watchJson(root)).T1.sampled, true)
  })
})

test('a task the watchdog resumed adds no envelope sample', async () => {
  await withRun(async ({ root, io, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    await taskBranch(root, g, 'T2', 'b.mjs')
    await setStates(root, { T1: 'done' })
    await writeFile(path.join(root, '.fleetmates', 'r1', 'watch.json'), JSON.stringify({ T1: { ...HISTORY, resumes: 1 } }), 'utf8')
    assert.equal(await watchOnce(root, io), 0)
    assert.equal(existsSync(envelopeFile(root)), false)
  })
})

test('rescue saves a dirty worktree as a patch under the run, removes it, and the patch applies', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs', { old: true })
    const wt = path.join(root, 'wt-T1')
    g(['worktree', 'add', '--quiet', wt, 'fleetmates/r1/T1'])
    await writeFile(path.join(wt, 'a.mjs'), 'export const x = 2\n', 'utf8')
    await writeFile(path.join(wt, 'new.txt'), 'fresh\n', 'utf8')
    const code = await runCli(['rescue', '--run', 'r1', '--task', 'T1', '--root', root], io)
    assert.equal(code, 0, lines.join('\n'))
    const out = lines.join('\n')
    const patch = /^rescued T1 to (.+)$/m.exec(out)?.[1]
    assert.ok(patch, out)
    assert.ok(patch.startsWith(path.join(root, '.fleetmates', 'r1', 'rescue') + path.sep), patch)
    assert.match(out, /worktree removed: /)
    assert.equal(existsSync(wt), false)
    assert.doesNotMatch(g(['worktree', 'list', '--porcelain']), /wt-T1/)
    const fresh = path.join(root, 'wt-fresh')
    g(['worktree', 'add', '--quiet', '--detach', fresh, 'fleetmates/r1/T1'])
    git(fresh, ['apply', '--index', patch])
    assert.equal(await readFile(path.join(fresh, 'a.mjs'), 'utf8'), 'export const x = 2\n')
    assert.equal(await readFile(path.join(fresh, 'new.txt'), 'utf8'), 'fresh\n')
    g(['worktree', 'remove', '--force', fresh])
  })
})

test('rescue of a clean worktree removes it and says there was no work', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    const wt = path.join(root, 'wt-T1')
    g(['worktree', 'add', '--quiet', wt, 'fleetmates/r1/T1'])
    assert.equal(await runCli(['rescue', '--run', 'r1', '--task', 'T1', '--root', root], io), 0)
    assert.match(lines.join('\n'), /T1 had no uncommitted work/)
    assert.equal(existsSync(wt), false)
  })
})

test('rescue of a task with no registered worktree exits 2 and touches nothing', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    const before = g(['worktree', 'list', '--porcelain'])
    const code = await runCli(['rescue', '--run', 'r1', '--task', 'T1', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /no worktree is registered for task T1/)
    assert.equal(g(['worktree', 'list', '--porcelain']), before)
    assert.equal(existsSync(path.join(root, '.fleetmates', 'r1', 'rescue')), false)
  })
})

test('rescue refuses a worktree whose .git points at another repository and leaves it in place', async () => {
  await withRun(async ({ root, io, lines, g }) => {
    await taskBranch(root, g, 'T1', 'a.mjs')
    const wt = path.join(root, 'wt-T1')
    g(['worktree', 'add', '--quiet', wt, 'fleetmates/r1/T1'])
    const other = await mkdtemp(path.join(tmpdir(), 'tm-watch-other-'))
    try {
      git(other, ['init', '--quiet', '--initial-branch=main'])
      git(other, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '--allow-empty', '-m', 'o'])
      await unlink(path.join(wt, '.git')) // hidden on Windows: writing over it is EPERM
      await writeFile(path.join(wt, '.git'), `gitdir: ${path.join(other, '.git')}\n`, 'utf8')
      const code = await runCli(['rescue', '--run', 'r1', '--task', 'T1', '--root', root], io)
      assert.equal(code, 1)
      assert.match(lines.join('\n'), /rescue failed, worktree left in place: .*another repository/)
      assert.ok((await stat(wt)).isDirectory())
      assert.match(g(['worktree', 'list', '--porcelain']), /wt-T1/)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})

test('config get, set and unset agree on every watch key', async () => {
  await withRun(async ({ root, io, lines }) => {
    const keys = ['enabled', 'resumes', 'respawns', 'staleMinutes', 'intervalMinutes', 'learn', 'spinFailures']
    for (const key of keys) {
      lines.length = 0
      assert.equal(await runCli(['config', 'get', `watch.${key}`, '--root', root], io), 0, `get watch.${key}: ${lines.join('\n')}`)
    }
    assert.equal(await runCli(['config', 'set', 'watch.resumes', '3', '--local', '--root', root], io), 0)
    lines.length = 0
    assert.equal(await runCli(['config', 'get', 'watch.resumes', '--root', root], io), 0)
    assert.deepEqual(lines, ['3'])
    lines.length = 0
    assert.equal(await runCli(['config', 'unset', 'watch.resumes', '--local', '--root', root], io), 0, lines.join('\n'))
    lines.length = 0
    assert.equal(await runCli(['config', 'get', 'watch.resumes', '--root', root], io), 0)
    assert.deepEqual(lines, ['2'])
  })
})

test('watch and rescue require their arguments and refuse unknown flags', async () => {
  await withRun(async ({ root, io, lines }) => {
    assert.equal(await runCli(['watch', '--run', 'r1', '--root', root], io), 2)
    assert.match(lines.join('\n'), /missing required argument: --plan/)
    lines.length = 0
    assert.equal(await runCli(['rescue', '--run', 'r1', '--root', root], io), 2)
    assert.match(lines.join('\n'), /missing required argument: --task/)
    lines.length = 0
    assert.equal(await runCli(['rescue', '--run', 'r1', '--task', 'T1', '--once', '--root', root], io), 2)
    assert.match(lines.join('\n'), /rescue does not take --once/)
  })
})
