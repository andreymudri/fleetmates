// Before a stalled teammate is replaced, its uncommitted work is saved as a patch the replacement
// applies first. Staged through a throwaway index so the worktree's own index is never touched, and
// the worktree is removed only after the patch is safely on disk.
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fingerprint } from './event-ledger.mjs'

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

export function rescueName(taskId) {
  return SAFE_ID.test(taskId) ? taskId : fingerprint(taskId).slice(0, 16)
}

export async function rescuePatchPath(dir, taskId) {
  const name = rescueName(taskId)
  let entries = []
  try { entries = await readdir(dir) } catch { /* absent dir: first patch */ }
  let n = 1
  while (entries.includes(`${name}-${n}.patch`)) n++
  return path.join(dir, `${name}-${n}.patch`)
}

function gitBuffer(cwd, args, env) {
  return execFileSync('git', args, { cwd, env, maxBuffer: 512 * 1024 * 1024 })
}

export async function rescueWorktree({ worktree, patchDir, taskId, removeWorktree }) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'fm-rescue-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') }
  let patch
  try {
    gitBuffer(worktree, ['read-tree', 'HEAD'], env)
    gitBuffer(worktree, ['add', '-A', '--', '.'], env)
    patch = gitBuffer(worktree, ['diff', '--cached', '--binary', 'HEAD'], env)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const empty = patch.length === 0
  let patchFile = null
  if (!empty) {
    await mkdir(patchDir, { recursive: true })
    patchFile = await rescuePatchPath(patchDir, taskId)
    await writeFile(patchFile, patch, { flag: 'wx' })
  }
  await removeWorktree(worktree)
  return { patchFile, empty }
}
