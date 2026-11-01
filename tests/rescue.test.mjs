import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rescuePatchPath, rescueWorktree } from '../scripts/rescue.mjs'

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-rescue-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  await writeFile(path.join(repo, 'tracked.txt'), 'one\n')
  await writeFile(path.join(repo, '.gitignore'), 'ignored.log\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  const base = git(repo, ['rev-parse', 'HEAD']).trim()
  const wt = path.join(root, 'wt')
  git(repo, ['worktree', 'add', '-q', '-b', 'task', wt])
  return { root, repo, wt, base, patchDir: path.join(root, 'patches'), common: path.join(repo, '.git') }
}

async function dirtyWorktree(wt) {
  await writeFile(path.join(wt, 'tracked.txt'), 'two\n')
  await writeFile(path.join(wt, 'notes.txt'), 'untracked text\n')
  await writeFile(path.join(wt, 'blob.bin'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
  await writeFile(path.join(wt, 'ignored.log'), 'not for the patch\n')
}

// Applies the patch on a fresh checkout of the base commit and checks the work came back intact.
async function assertReproduced(f, patchFile) {
  const fresh = path.join(f.root, 'fresh')
  git(f.repo, ['worktree', 'add', '-q', '--detach', fresh, f.base])
  git(fresh, ['apply', '--index', patchFile])
  assert.equal(await readFile(path.join(fresh, 'tracked.txt'), 'utf8'), 'two\n')
  assert.equal(await readFile(path.join(fresh, 'notes.txt'), 'utf8'), 'untracked text\n')
  assert.deepEqual(
    await readFile(path.join(fresh, 'blob.bin')),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  )
  assert.equal(existsSync(path.join(fresh, 'ignored.log')), false)
}

test('rescueWorktree writes a patch that reproduces tracked and untracked work but not ignored files', async (t) => {
  const f = await fixture(t)
  await dirtyWorktree(f.wt)
  const removed = []
  const { patchFile, empty } = await rescueWorktree({
    worktree: f.wt, patchDir: f.patchDir, taskId: 'T3', commonDir: f.common,
    removeWorktree: async (p) => { removed.push(p) },
  })
  assert.equal(empty, false)
  assert.ok(patchFile && existsSync(patchFile), 'patch file exists at the returned path')
  await assertReproduced(f, patchFile)
})

test('rescueWorktree leaves the worktree status and its real index untouched', async (t) => {
  const f = await fixture(t)
  await dirtyWorktree(f.wt)
  const before = git(f.wt, ['status', '--porcelain'])
  await rescueWorktree({
    worktree: f.wt, patchDir: f.patchDir, taskId: 'T3', commonDir: f.common, removeWorktree: async () => {},
  })
  assert.equal(git(f.wt, ['status', '--porcelain']), before)
  assert.equal(spawnSync('git', ['-C', f.wt, 'diff', '--cached', '--quiet']).status, 0)
})

test('rescueWorktree removes the worktree exactly once, after saving the patch', async (t) => {
  const f = await fixture(t)
  await dirtyWorktree(f.wt)
  const removed = []
  await rescueWorktree({
    worktree: f.wt, patchDir: f.patchDir, taskId: 'T3', commonDir: f.common,
    removeWorktree: async (p) => {
      assert.deepEqual(readdirSync(f.patchDir), ['T3-1.patch'], 'patch on disk before removal')
      removed.push(p)
    },
  })
  assert.deepEqual(removed, [f.wt])
})

test('rescueWorktree on a clean worktree returns empty and still removes it', async (t) => {
  const f = await fixture(t)
  const clean = path.join(f.root, 'clean')
  git(f.repo, ['worktree', 'add', '-q', '-b', 'clean', clean])
  const removed = []
  const result = await rescueWorktree({
    worktree: clean, patchDir: f.patchDir, taskId: 'T3', commonDir: f.common,
    removeWorktree: async (p) => { removed.push(p) },
  })
  assert.equal(result.empty, true)
  assert.equal(result.patchFile, null)
  assert.deepEqual(removed, [clean])
})

test('rescueWorktree throws and never removes the worktree when the patch cannot be written', async (t) => {
  const f = await fixture(t)
  await dirtyWorktree(f.wt)
  const blocker = path.join(f.root, 'not-a-directory')
  await writeFile(blocker, 'plain file')
  const removed = []
  await assert.rejects(() => rescueWorktree({
    worktree: f.wt, patchDir: blocker, taskId: 'T3', commonDir: f.common,
    removeWorktree: async (p) => { removed.push(p) },
  }))
  assert.deepEqual(removed, [])
})

// A user's diff.* or color.* setting must not change what the patch contains.
for (const [name, configure] of [
  ['diff.external', async (f) => {
    const script = path.join(f.root, 'pretty.sh')
    await writeFile(script, '#!/bin/sh\necho "pretty diff of $1"\n', { mode: 0o755 })
    git(f.wt, ['config', 'diff.external', script])
  }],
  ['diff.noprefix', (f) => git(f.wt, ['config', 'diff.noprefix', 'true'])],
  ['color.diff', (f) => git(f.wt, ['config', 'color.diff', 'always'])],
]) {
  test(`rescueWorktree keeps the patch applicable when ${name} is set in the worktree`, async (t) => {
    const f = await fixture(t)
    await configure(f)
    await dirtyWorktree(f.wt)
    const { patchFile } = await rescueWorktree({
      worktree: f.wt, patchDir: f.patchDir, taskId: 'T3', commonDir: f.common, removeWorktree: async () => {},
    })
    await assertReproduced(f, patchFile)
  })
}

// A worktree that teammates control must not be able to run code in the rescuing process.
test('rescueWorktree refuses a worktree whose .git file points at a foreign git dir', async (t) => {
  const f = await fixture(t)
  const foreign = path.join(f.root, 'foreign')
  await mkdir(foreign)
  git(foreign, ['init', '-q', '-b', 'main'])
  const marker = path.join(f.root, 'marker')
  const script = path.join(f.root, 'fsmonitor.sh')
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 })
  git(foreign, ['config', 'core.fsmonitor', script])
  await dirtyWorktree(f.wt)
  await writeFile(path.join(f.wt, '.git'), `gitdir: ${path.join(foreign, '.git')}\n`)
  const removed = []
  await assert.rejects(() => rescueWorktree({
    worktree: f.wt, patchDir: f.patchDir, taskId: 'T3', commonDir: f.common,
    removeWorktree: async (p) => { removed.push(p) },
  }), /another repository/)
  assert.equal(existsSync(marker), false, 'planted fsmonitor never ran')
  assert.deepEqual(removed, [])
  assert.equal(existsSync(f.patchDir), false, 'no patch was written')
})

test('rescueWorktree ignores GIT_DIR and GIT_INDEX_FILE from the process environment', async (t) => {
  const f = await fixture(t)
  const foreign = path.join(f.root, 'foreign')
  await mkdir(foreign)
  git(foreign, ['init', '-q', '-b', 'main'])
  const decoyIndex = path.join(f.root, 'decoy-index')
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  t.after(restore)
  process.env.GIT_DIR = path.join(foreign, '.git')
  process.env.GIT_INDEX_FILE = decoyIndex
  await dirtyWorktree(f.wt)
  let patchFile
  try {
    ({ patchFile } = await rescueWorktree({
      worktree: f.wt, patchDir: f.patchDir, taskId: 'T3', commonDir: f.common, removeWorktree: async () => {},
    }))
  } finally {
    restore()
  }
  assert.equal(existsSync(decoyIndex), false, 'the decoy index was never written')
  await assertReproduced(f, patchFile)
})

test('rescuePatchPath numbers patches per task and maps unsafe ids to a fingerprint prefix', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-rescue-names-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(await rescuePatchPath(dir, 'T3'), path.join(dir, 'T3-1.patch'))
  await writeFile(path.join(dir, 'T3-1.patch'), '')
  assert.equal(await rescuePatchPath(dir, 'T3'), path.join(dir, 'T3-2.patch'))
  assert.equal(await rescuePatchPath(path.join(dir, 'absent'), 'T3'), path.join(dir, 'absent', 'T3-1.patch'))
  const unsafe = path.basename(await rescuePatchPath(dir, 'feat/T3'))
  assert.match(unsafe, /^[0-9a-f]{16}-1\.patch$/)
})
