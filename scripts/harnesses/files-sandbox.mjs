// The git-less sandbox shared by every adapter that offers one (spec
// docs/specs/2026-09-16-headless-driver-cursor-design.md §4.2-§4.3). A teammate gets a plain
// checkout of the run branch's tree with no repository in it, so nothing a harness runs outside its
// own sandbox (Cursor's git, Codex's per-turn `git status`) can resolve teammate-written git config.
// The host then turns the checkout into a commit WITHOUT ever pointing git at it: every blob is
// hashed from bytes the host read itself, with filters off, and the tree is assembled in a private
// index. No hook, filter, attribute or symlink target from the checkout is ever evaluated.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, lstat, readdir, readFile, readlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Workspace files a harness reads as configuration — hooks that run outside the sandbox, sandbox
// policy that widens the next session, MCP and editor config. A teammate must never add, change or
// delete these: they are scrubbed from the checkout and taken from the run branch at commit time.
export const CONTROL_PATHS = [
  '.cursor/sandbox.json',
  '.cursor/hooks.json',
  '.cursor/hooks',
  '.cursor/cli.json',
  '.cursor/mcp.json',
  '.cursor/worktrees.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.vscode',
]

export function isControlPath(rel) {
  const p = rel.split(path.sep).join('/')
  return CONTROL_PATHS.some((entry) => p === entry || p.startsWith(`${entry}/`))
}

// A plain, git-less checkout of `runBranch`'s tree. The checkout runs against a PRIVATE index
// outside the checkout: without `GIT_INDEX_FILE` it would take the run repo's own `index.lock` (so
// two concurrent builds collide) and stage the branch's tree into the run repo's shared index.
// `checkoutRoot` overrides where the checkout lives (default `<runRepo>/.fleetmates/<runId>/files`).
export async function makeFilesSandbox(git, { runRepo, runBranch, runId, taskId, checkoutRoot }) {
  const base = path.join(runRepo, '.fleetmates', runId)
  const branch = `fleetmates/${runId}/${taskId}`
  const cwd = path.join(checkoutRoot ?? path.join(base, 'files'), taskId)
  await mkdir(cwd, { recursive: true })
  await mkdir(base, { recursive: true })
  const filesIndex = path.join(base, `files-index-${taskId}`)
  const res = await git(['--work-tree', cwd, 'checkout', runBranch, '--', '.'],
    { cwd: runRepo, env: { GIT_INDEX_FILE: filesIndex } })
  await rm(filesIndex, { force: true })
  if (res.code !== 0) {
    throw new Error(`git checkout of ${runBranch} into ${cwd} failed: ${(res.stderr || '').trim() || `exit ${res.code}`}`)
  }
  return { cwd, meta: { mode: 'files', branch, runBranch } }
}

// Removes every control path present in `cwd` (never following a symlink) and returns the
// relative paths it found, sorted.
export async function scrubControlPaths(cwd) {
  const found = []
  for (const rel of CONTROL_PATHS) {
    const abs = path.join(cwd, rel)
    try {
      await lstat(abs)
    } catch {
      continue
    }
    await rm(abs, { recursive: true, force: true })
    found.push(rel)
  }
  return found.sort()
}

// git with an optional stdin payload. `defaultGitExec` has no stdin, and `hash-object --stdin`
// is what lets the host hash bytes it read itself instead of handing git a path in the checkout.
function gitRun(args, { cwd, env, input }) {
  return new Promise((resolve, reject) => {
    // stdin is a pipe only when there is a payload: a command that never reads it (rev-parse,
    // write-tree) can exit before an empty write lands, and that write then fails with EPIPE.
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, env: { ...process.env, ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    let stderr = ''
    child.stdout.on('data', (d) => stdout.push(d))
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      const text = Buffer.concat(stdout).toString('utf8')
      if (code !== 0) {
        reject(new Error(`commitFilesTree: git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`))
      } else {
        resolve(text)
      }
    })
    if (child.stdin) {
      // A git that dies early surfaces through its exit code in 'close'; the write error itself
      // must not escape as an unhandled stream error.
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

async function walk(root, rel, skip, entries) {
  for (const name of await readdir(path.join(root, rel))) {
    if (name === '.git') continue
    const childRel = rel ? `${rel}/${name}` : name
    if (isControlPath(childRel) || skip.has(childRel)) continue
    const abs = path.join(root, childRel)
    const st = await lstat(abs)
    if (st.isSymbolicLink()) {
      entries.push({ rel: childRel, mode: '120000', read: () => readlink(abs) })
    } else if (st.isDirectory()) {
      await walk(root, childRel, skip, entries)
    } else if (st.isFile()) {
      entries.push({ rel: childRel, mode: (st.mode & 0o111) ? '100755' : '100644', read: () => readFile(abs) })
    }
  }
}

async function identity(runRepo) {
  const get = async (key) => {
    try {
      return (await gitRun(['config', '--get', key], { cwd: runRepo })).trim()
    } catch {
      return ''
    }
  }
  return { name: (await get('user.name')) || 'fleetmates', email: (await get('user.email')) || 'fleetmates@localhost' }
}

// Commits the checkout on top of `runBranch` as `branch`. Control paths and gitlinks keep the run
// branch's entries; everything else comes from the checkout. An unchanged tree points `branch` at
// `runBranch` without a commit.
export async function commitFilesTree(_git, { runRepo, runBranch, sandbox, branch }) {
  const idxDir = await mkdtemp(path.join(os.tmpdir(), 'fm-files-idx-'))
  const env = { GIT_INDEX_FILE: path.join(idxDir, 'index') }
  const g = (args, input) => gitRun(args, { cwd: runRepo, env, input })
  try {
    const base = (await g(['rev-parse', '--verify', '--end-of-options', `${runBranch}^{commit}`])).trim()
    const baseTree = (await g(['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`])).trim()

    const lines = []
    const kept = new Set()
    for (const record of (await g(['ls-tree', '-r', '-z', '--end-of-options', base])).split('\0')) {
      if (!record) continue
      const tab = record.indexOf('\t')
      const [mode, , sha] = record.slice(0, tab).split(' ')
      const rel = record.slice(tab + 1)
      if (isControlPath(rel) || mode === '160000') {
        lines.push(`${mode} ${sha}\t${rel}`)
        kept.add(rel)
      }
    }

    const entries = []
    await walk(sandbox.cwd, '', kept, entries)
    for (const entry of entries) {
      const sha = (await g(['hash-object', '-w', '--no-filters', '--stdin'], await entry.read())).trim()
      lines.push(`${entry.mode} ${sha}\t${entry.rel}`)
    }

    await g(['read-tree', '--empty'])
    if (lines.length) await g(['update-index', '-z', '--index-info'], lines.map((l) => `${l}\0`).join(''))
    const tree = (await g(['write-tree'])).trim()

    let target = base
    if (tree !== baseTree) {
      const who = await identity(runRepo)
      const commitEnv = {
        ...env,
        GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,
        GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
      }
      target = (await gitRun(['commit-tree', tree, '-p', base, '-m', `${branch}: files sandbox`],
        { cwd: runRepo, env: commitEnv })).trim()
    }
    await g(['update-ref', `refs/heads/${branch}`, target])
    return target
  } finally {
    await rm(idxDir, { recursive: true, force: true })
  }
}
