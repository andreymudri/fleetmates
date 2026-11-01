// Before a stalled teammate is replaced, its uncommitted work is saved as a patch the replacement
// applies first. Staged through a throwaway index so the worktree's own index is never touched, and
// the worktree is removed only after the patch is safely on disk. The worktree belongs to the
// teammate, so every git call runs with its config neutralised: no fsmonitor or hook it planted,
// no GIT_* variable from the environment, and a patch shape no user diff setting can change.
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fingerprint } from './event-ledger.mjs'

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/
const HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
const PATCH_SHAPE = [
  '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
]

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

// GIT_* keys (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*, ...) are dropped so the environment cannot
// point git at another repository or config; only the keys this module sets are added back.
function hardenedEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return { ...env, GIT_OPTIONAL_LOCKS: '0', ...extra }
}

function git(cwd, args, env) {
  return execFileSync('git', [...HARDENED, ...args], { cwd, env, maxBuffer: 512 * 1024 * 1024 })
}

async function assertSameRepository(worktree, commonDir) {
  if (typeof commonDir !== 'string' || commonDir === '') throw new TypeError('rescueWorktree needs commonDir')
  const found = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], hardenedEnv())
    .toString('utf8').trim()
  if (await realpath(found) !== await realpath(commonDir)) {
    throw new Error(`worktree ${worktree} belongs to another repository, not ${commonDir}`)
  }
}

export async function rescueWorktree({ worktree, patchDir, taskId, removeWorktree, commonDir }) {
  await assertSameRepository(worktree, commonDir)
  const scratch = mkdtempSync(path.join(tmpdir(), 'fm-rescue-'))
  const env = hardenedEnv({ GIT_INDEX_FILE: path.join(scratch, 'index') })
  let patch
  try {
    git(worktree, ['read-tree', 'HEAD'], env)
    git(worktree, ['add', '-A', '--', '.'], env)
    patch = git(worktree, ['diff', '--cached', ...PATCH_SHAPE, 'HEAD'], env)
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
