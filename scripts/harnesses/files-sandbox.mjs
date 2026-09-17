// The git-less sandbox shared by every adapter that offers one (spec
// docs/specs/2026-09-16-headless-driver-cursor-design.md §4.2-§4.3). A teammate gets a plain
// checkout of the run branch's tree with no repository in it, so nothing a harness runs outside its
// own sandbox (Cursor's git, Codex's per-turn `git status`) can resolve teammate-written git config.
// The host then turns the checkout into a commit WITHOUT ever pointing git at it: every blob is
// hashed from bytes the host read itself, with filters off, and the tree is assembled in a private
// index. No hook, filter, attribute or symlink target from the checkout is ever evaluated.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, lstat, readdir, readFile, readlink, symlink, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Sent BEFORE the persona and brief to a teammate in a files checkout, by every adapter that offers
// one (Cursor always, Codex in `files` mode). The implementer persona assumes a git
// worktree — create the task branch, run `locate`, commit, prove the commit with `git log`, run
// `complete` — none of which a git-less checkout can do, and a model told both things with no
// precedence can reasonably give up and report `failed`. This names each cancelled step and says
// it overrides them; RESULT_INSTRUCTION then closes the prompt with the result contract.
export const FILES_PREAMBLE = 'READ FIRST — this overrides the instructions that follow. You are running in a '
  + 'plain directory with NO git repository and NO worktree. Skip every step below that uses git or a '
  + 'worktree: do not create or check out a branch, do not run `locate` or `complete`, do not commit, and do '
  + 'not try to prove a commit with `git log` or `git diff`. Edit the files your task names, run the '
  + 'project\'s tests if you can, and report. The host commits your workspace to the task branch and runs '
  + 'the checks itself; a missing commit is never a reason to report `blocked` or `failed`.\n\n---\n\n'

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

// The directories that contain control paths. A teammate that replaces one with a symlink or a
// plain file would redirect every path beneath it (`.claude -> ~/.claude`), so an ancestor that is
// not a real directory is itself treated as a control path.
export const CONTROL_ANCESTORS = [...new Set(CONTROL_PATHS.filter((p) => p.includes('/')).map((p) => p.split('/')[0]))].sort()

export function isControlPath(rel) {
  const p = rel.split(path.sep).join('/')
  return CONTROL_PATHS.some((entry) => p === entry || p.startsWith(`${entry}/`))
}

// A plain, git-less copy of `runBranch`'s tree, written BYTE-EXACT from the blobs: no index, no
// `git checkout`, so no smudge filter, no autocrlf/eol conversion and no index.lock. Exactness is the
// point — `commitFilesTree` hashes the checkout with `--no-filters`, so any conversion on the way out
// (measured on Windows CI: `core.autocrlf` turned every `\n` into `\r\n`) would read back as an edit
// to every file. Gitlinks (submodules) become empty directories and are kept from the run branch at
// commit time. `checkoutRoot` overrides where the checkout lives (default
// `<runRepo>/.fleetmates/<runId>/files`).
export async function makeFilesSandbox(git, { runRepo, runBranch, runId, taskId, checkoutRoot }) {
  const branch = `fleetmates/${runId}/${taskId}`
  const cwd = path.join(checkoutRoot ?? path.join(runRepo, '.fleetmates', runId, 'files'), taskId)
  await mkdir(cwd, { recursive: true })
  const label = `makeFilesSandbox (${runBranch} into ${cwd})`
  const entries = []
  for (const record of (await gitRun(['ls-tree', '-r', '-z', '--end-of-options', `${runBranch}^{tree}`], { cwd: runRepo }, label)).split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const [mode, type, sha] = record.slice(0, tab).split(' ')
    entries.push({ mode, type, sha, rel: record.slice(tab + 1) })
  }
  for (const entry of entries.filter((e) => e.type === 'commit')) {
    await mkdir(path.join(cwd, ...entry.rel.split('/')), { recursive: true })
  }
  // Blobs are read in batches so a large tree is never held in memory at once.
  const blobs = entries.filter((e) => e.type === 'blob')
  for (let start = 0; start < blobs.length; start += BATCH) {
    const chunk = blobs.slice(start, start + BATCH)
    const raw = await gitRun(['cat-file', '--batch'], { cwd: runRepo, input: chunk.map((e) => `${e.sha}\n`).join(''), raw: true }, label)
    const contents = splitBatch(raw)
    for (const [i, entry] of chunk.entries()) await writeEntry(cwd, entry, contents[i])
  }
  return { cwd, meta: { mode: 'files', branch, runBranch } }
}

const BATCH = 200

async function writeEntry(cwd, entry, bytes) {
  const abs = path.join(cwd, ...entry.rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  if (entry.mode === '120000') {
    try {
      await symlink(bytes.toString('utf8'), abs)
    } catch {
      // No symlink privilege (Windows): the link text as a file. commitFilesTree maps an unchanged
      // blob back to the run branch's mode there.
      await writeFile(abs, bytes)
    }
    return
  }
  await writeFile(abs, bytes)
  if (entry.mode === '100755') await chmod(abs, 0o755)
}

// Splits `git cat-file --batch` output (`<sha> <type> <size>\n<bytes>\n` per object) into buffers.
function splitBatch(buf) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    const header = buf.subarray(pos, nl).toString('utf8').split(' ')
    if (header[1] === 'missing') throw new Error(`makeFilesSandbox: blob ${header[0]} missing`)
    const size = Number(header[2])
    out.push(buf.subarray(nl + 1, nl + 1 + size))
    pos = nl + 1 + size + 1
  }
  return out
}

// Removes every control path present in `cwd` and returns the relative paths it found, sorted.
// Symlinks are never followed at ANY level: a control ancestor that is not a real directory is
// removed itself (the link, not its target) before any path beneath it is looked at, so no `lstat`
// or `rm` below ever resolves through a teammate-made link.
export async function scrubControlPaths(cwd) {
  const found = []
  for (const dir of CONTROL_ANCESTORS) {
    const abs = path.join(cwd, dir)
    let st
    try {
      st = await lstat(abs)
    } catch {
      continue
    }
    if (st.isDirectory() && !st.isSymbolicLink()) continue
    await rm(abs, { force: true })
    found.push(dir)
  }
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
function gitRun(args, { cwd, env, input, raw = false }, label = 'commitFilesTree') {
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
      const bytes = Buffer.concat(stdout)
      if (code !== 0) {
        reject(new Error(`${label}: git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`))
      } else {
        resolve(raw ? bytes : bytes.toString('utf8'))
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

// Collects the checkout's committable entries into `out.entries` and its control-path entries into
// `out.control`. A control ancestor that is not a real directory is never committed (it would
// displace or redirect the protected entries beneath it) and is reported in `out.control` as a
// change. A path that is an ancestor of a kept run-branch entry is never committed either: in
// `update-index --index-info` a later file entry silently replaces the directory beneath it.
async function walk(root, rel, kept, out) {
  for (const name of await readdir(path.join(root, rel))) {
    if (name === '.git') continue
    const childRel = rel ? `${rel}/${name}` : name
    const abs = path.join(root, childRel)
    const st = await lstat(abs)
    const realDir = st.isDirectory() && !st.isSymbolicLink()
    if (CONTROL_ANCESTORS.includes(childRel) && !realDir) {
      out.control.push({ rel: childRel, mode: 'not-a-directory' })
      continue
    }
    const control = isControlPath(childRel)
    if (!realDir && !control && kept.some((k) => k.startsWith(`${childRel}/`))) continue
    const bucket = control ? out.control : out.entries
    if (st.isSymbolicLink()) {
      bucket.push({ rel: childRel, mode: '120000', read: () => readlink(abs) })
    } else if (realDir) {
      await walk(root, childRel, kept, out)
    } else if (st.isFile()) {
      bucket.push({ rel: childRel, mode: (st.mode & 0o111) ? '100755' : '100644', read: () => readFile(abs) })
    }
  }
}

// Windows filesystems carry no exec bit and, without privilege, no symlinks, so a file whose bytes
// are unchanged keeps the run branch's mode there; elsewhere the filesystem's own mode is the truth
// (a chmod-only change is a change).
function modeFor(entry, sha, baseEntries) {
  if (process.platform !== 'win32') return entry.mode
  const base = baseEntries.get(entry.rel)
  return base && base.sha === sha ? base.mode : entry.mode
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
//
// `refuseControlChanges`: for a harness that does not scrub its checkout (Codex), a control path the
// teammate added, changed or removed would otherwise be dropped silently; with this set the commit is
// refused with `control-path: <paths>` and no ref is written. A scrubbing harness (Cursor) leaves it
// off, because its checkout never holds control paths by the time it is committed.
export async function commitFilesTree(_git, { runRepo, runBranch, sandbox, branch, refuseControlChanges = false }) {
  const idxDir = await mkdtemp(path.join(os.tmpdir(), 'fm-files-idx-'))
  const env = { GIT_INDEX_FILE: path.join(idxDir, 'index') }
  const g = (args, input) => gitRun(args, { cwd: runRepo, env, input })
  try {
    const base = (await g(['rev-parse', '--verify', '--end-of-options', `${runBranch}^{commit}`])).trim()
    const baseTree = (await g(['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`])).trim()

    const lines = []
    const kept = []
    const baseControl = new Map()
    const baseEntries = new Map()
    for (const record of (await g(['ls-tree', '-r', '-z', '--end-of-options', base])).split('\0')) {
      if (!record) continue
      const tab = record.indexOf('\t')
      const [mode, , sha] = record.slice(0, tab).split(' ')
      const rel = record.slice(tab + 1)
      if (isControlPath(rel) || mode === '160000') {
        lines.push(`${mode} ${sha}\t${rel}`)
        kept.push(rel)
      }
      if (isControlPath(rel)) baseControl.set(rel, `${mode} ${sha}`)
      baseEntries.set(rel, { mode, sha })
    }

    const found = { entries: [], control: [] }
    await walk(sandbox.cwd, '', kept, found)
    if (refuseControlChanges) {
      const changed = new Set()
      const seen = new Set()
      for (const entry of found.control) {
        if (entry.mode === 'not-a-directory') {
          changed.add(entry.rel)
          continue
        }
        seen.add(entry.rel)
        const sha = (await g(['hash-object', '-w', '--no-filters', '--stdin'], await entry.read())).trim()
        if (baseControl.get(entry.rel) !== `${modeFor(entry, sha, baseEntries)} ${sha}`) changed.add(entry.rel)
      }
      for (const rel of baseControl.keys()) {
        if (!seen.has(rel) && !found.control.some((e) => e.mode === 'not-a-directory' && rel.startsWith(`${e.rel}/`))) {
          changed.add(rel)
        }
      }
      if (changed.size) throw new Error(`control-path: ${[...changed].sort().join(', ')}`)
    }
    const entries = found.entries
    for (const entry of entries) {
      const sha = (await g(['hash-object', '-w', '--no-filters', '--stdin'], await entry.read())).trim()
      lines.push(`${modeFor(entry, sha, baseEntries)} ${sha}\t${entry.rel}`)
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
