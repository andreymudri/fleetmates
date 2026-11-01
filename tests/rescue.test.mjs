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
  return { root, repo, wt, base, patchDir: path.join(root, 'patches') }
}

async function dirtyWorktree(wt) {
  await writeFile(path.join(wt, 'tracked.txt'), 'two\n')
  await writeFile(path.join(wt, 'notes.txt'), 'untracked text\n')
  await writeFile(path.join(wt, 'blob.bin'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)))
  await writeFile(path.join(wt, 'ignored.log'), 'not for the patch\n')
}

test('rescueWorktree writes a patch that reproduces tracked and untracked work but not ignored files', async (t) => {
  const { root, repo, wt, base, patchDir } = await fixture(t)
  await dirtyWorktree(wt)
  const removed = []
  const { patchFile, empty } = await rescueWorktree({
    worktree: wt, patchDir, taskId: 'T3', removeWorktree: async (p) => { removed.push(p) },
  })
  assert.equal(empty, false)
  assert.ok(patchFile && existsSync(patchFile), 'patch file exists at the returned path')

  const fresh = path.join(root, 'fresh')
  git(repo, ['worktree', 'add', '-q', '--detach', fresh, base])
  git(fresh, ['apply', '--index', patchFile])
  assert.equal(await readFile(path.join(fresh, 'tracked.txt'), 'utf8'), 'two\n')
  assert.equal(await readFile(path.join(fresh, 'notes.txt'), 'utf8'), 'untracked text\n')
  assert.deepEqual(
    await readFile(path.join(fresh, 'blob.bin')),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  )
  assert.equal(existsSync(path.join(fresh, 'ignored.log')), false)
})

test('rescueWorktree leaves the worktree status and its real index untouched', async (t) => {
  const { wt, patchDir } = await fixture(t)
  await dirtyWorktree(wt)
  const before = git(wt, ['status', '--porcelain'])
  await rescueWorktree({ worktree: wt, patchDir, taskId: 'T3', removeWorktree: async () => {} })
  assert.equal(git(wt, ['status', '--porcelain']), before)
  assert.equal(spawnSync('git', ['-C', wt, 'diff', '--cached', '--quiet']).status, 0)
})

test('rescueWorktree removes the worktree exactly once, after saving the patch', async (t) => {
  const { wt, patchDir } = await fixture(t)
  await dirtyWorktree(wt)
  const removed = []
  await rescueWorktree({
    worktree: wt, patchDir, taskId: 'T3',
    removeWorktree: async (p) => {
      assert.deepEqual(readdirSync(patchDir), ['T3-1.patch'], 'patch on disk before removal')
      removed.push(p)
    },
  })
  assert.deepEqual(removed, [wt])
})

test('rescueWorktree on a clean worktree returns empty and still removes it', async (t) => {
  const { root, repo, patchDir } = await fixture(t)
  const clean = path.join(root, 'clean')
  git(repo, ['worktree', 'add', '-q', '-b', 'clean', clean])
  const removed = []
  const result = await rescueWorktree({
    worktree: clean, patchDir, taskId: 'T3', removeWorktree: async (p) => { removed.push(p) },
  })
  assert.equal(result.empty, true)
  assert.equal(result.patchFile, null)
  assert.deepEqual(removed, [clean])
})

test('rescueWorktree throws and never removes the worktree when the patch cannot be written', async (t) => {
  const { wt, root } = await fixture(t)
  await dirtyWorktree(wt)
  const blocker = path.join(root, 'not-a-directory')
  await writeFile(blocker, 'plain file')
  const removed = []
  await assert.rejects(() => rescueWorktree({
    worktree: wt, patchDir: blocker, taskId: 'T3', removeWorktree: async (p) => { removed.push(p) },
  }))
  assert.deepEqual(removed, [])
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
