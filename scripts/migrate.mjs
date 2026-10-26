// Moves a repository from the claude-teammates spellings to the fleetmates ones, the first time
// any CLI command runs in it. `scripts/cli.mjs` calls `migrate` once per invocation, before any
// command reads a name; the stop-time hook never does, because it fires inside running teammates.
//
// It refuses rather than acts when a teammate may still be running under the old names, and it
// never retries: a failure stops at the step that failed and prints how to reverse every step
// that ran. See docs/specs/2026-09-13-fleetmates-rename-design.md, section 2.
import { execFile } from 'node:child_process'
import { copyFile, lstat, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureGitignored } from './config.mjs'
import { DEFAULT_STALE_MINUTES, livenessRows } from './liveness.mjs'
import { LEGACY, NAMES } from './names.mjs'
import { printable } from './reviews.mjs'

export const BACKUP_SUFFIX = '.pre-fleetmates'
export const MIGRATION_STEPS = Object.freeze(['branches', 'claim-refs', 'stored-names', 'state-dir', 'manifests', 'gitignore'])

// Only these keys name something the code resolves. Free text — briefs, prompts, findings — is a
// record of what was said at the time and is left as it was written.
const REWRITE_KEYS = new Set(['branch', 'findingsPath', 'verdictFile', 'file'])

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const STATE_SEGMENT = new RegExp(`(^|[\\\\/])${escapeRegExp(LEGACY.stateDir)}(?=[\\\\/]|$)`, 'g')

function runGit(root, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

async function git(root, args) {
  const result = await runGit(root, args)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`)
  return result.stdout
}

async function exists(p) {
  try {
    await lstat(p)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

// For the reverse commands only: they are printed for an operator to paste into a POSIX shell.
const shellQuote = (s) => (/^[\w./@:+=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)

export function rewriteStoredName(value) {
  if (typeof value !== 'string') return value
  let next = value
  if (next.startsWith(`${LEGACY.refPrefix}/`)) next = `${NAMES.refPrefix}/${next.slice(LEGACY.refPrefix.length + 1)}`
  else if (next.startsWith(`${LEGACY.branchPrefix}/`)) next = `${NAMES.branchPrefix}/${next.slice(LEGACY.branchPrefix.length + 1)}`
  return next.replace(STATE_SEGMENT, `$1${NAMES.stateDir}`)
}

// `Object.fromEntries`, not assignment: a planted `"__proto__"` key in agent-written JSON is an
// own property after JSON.parse, and assigning it onto `{}` would set the prototype instead.
function rewriteStoredNames(node) {
  if (Array.isArray(node)) return node.map(rewriteStoredNames)
  if (node === null || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [
    key,
    REWRITE_KEYS.has(key) && typeof value === 'string' ? rewriteStoredName(value) : rewriteStoredNames(value),
  ]))
}

const renamedBranch = (name) => `${NAMES.branchPrefix}/${name.slice(LEGACY.branchPrefix.length + 1)}`
const renamedRef = (ref) => `${NAMES.refPrefix}/${ref.slice(LEGACY.refPrefix.length + 1)}`

async function filesUnder(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    // Links are not followed: a planted link would otherwise have this rewrite files outside the
    // state directory.
    if (entry.isSymbolicLink()) continue
    // Nor is a worktree registered inside it: that is someone's checkout, and its JSON files are
    // project content, not run state.
    if (entry.isDirectory() && await exists(path.join(full, '.git'))) continue
    if (entry.isDirectory()) found.push(...await filesUnder(full))
    else if (entry.isFile()) found.push(full)
  }
  return found
}

async function listWorktrees(root) {
  const result = await runGit(root, ['worktree', 'list', '--porcelain'])
  if (result.code !== 0) return []
  const entries = []
  let current = null
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null }
      entries.push(current)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  return entries
}

function isUnder(child, parent) {
  const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  const rel = path.relative(fold(parent), fold(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export async function legacyInventory(root) {
  const refs = await runGit(root, [
    'for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${LEGACY.branchPrefix}/`, `${LEGACY.refPrefix}/`,
  ])
  const branches = []
  const claimRefs = []
  if (refs.code === 0) {
    for (const line of refs.stdout.split(/\r?\n/)) {
      const space = line.lastIndexOf(' ')
      if (space === -1) continue
      const ref = line.slice(0, space)
      const sha = line.slice(space + 1)
      if (ref.startsWith(`refs/heads/${LEGACY.branchPrefix}/`)) branches.push({ name: ref.slice('refs/heads/'.length), sha })
      else if (ref.startsWith(`${LEGACY.refPrefix}/`)) claimRefs.push({ ref, sha })
    }
  }
  return {
    gitRepo: refs.code === 0,
    stateDir: await exists(path.join(root, LEGACY.stateDir)),
    gateFile: await exists(path.join(root, LEGACY.gateFile)),
    localFile: await exists(path.join(root, LEGACY.localFile)),
    branches,
    claimRefs,
  }
}

const nothingLegacy = (inv) => !inv.stateDir && !inv.gateFile && !inv.localFile && inv.branches.length === 0 && inv.claimRefs.length === 0

async function conflicts(root, inv) {
  const found = []
  for (const [present, legacy, current] of [
    [inv.stateDir, LEGACY.stateDir, NAMES.stateDir],
    [inv.gateFile, LEGACY.gateFile, NAMES.gateFile],
    [inv.localFile, LEGACY.localFile, NAMES.localFile],
  ]) {
    if (present && await exists(path.join(root, current))) found.push(`${legacy} and ${current} both exist`)
  }
  for (const { name } of inv.branches) {
    const target = renamedBranch(name)
    if ((await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`])).code === 0) {
      found.push(`branches ${printable(name)} and ${printable(target)} both exist`)
    }
  }
  for (const { ref } of inv.claimRefs) {
    const target = renamedRef(ref)
    if ((await runGit(root, ['rev-parse', '--verify', '--quiet', target])).code === 0) {
      found.push(`refs ${printable(ref)} and ${printable(target)} both exist`)
    }
  }
  return found
}

// The same two signals `cli.mjs liveness` gathers, over EVERY task of every legacy run: `migrate`
// cannot derive the current phase, and a wider net can only refuse more.
async function liveTasks(root, { measureTouch, now, staleMinutes }) {
  const stateDir = path.join(root, LEGACY.stateDir)
  const byBranch = new Map((await listWorktrees(root)).filter((w) => w.branch).map((w) => [w.branch, w.path]))
  const live = []
  for (const entry of await readdir(stateDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let plan
    try {
      plan = JSON.parse(await readFile(path.join(stateDir, entry.name, 'plan.json'), 'utf8'))
    } catch {
      continue
    }
    const tasks = (Array.isArray(plan?.tasks) ? plan.tasks : []).filter((t) => typeof t?.id === 'string')
    const tips = {}
    const touches = {}
    for (const task of tasks) {
      const branch = `${LEGACY.branchPrefix}/${entry.name}/${task.id}`
      const tip = await runGit(root, ['log', '-1', '--format=%ct', `refs/heads/${branch}`, '--'])
      if (tip.code === 0 && tip.stdout.trim() !== '') tips[task.id] = { branch, at: Number(tip.stdout.trim()) * 1000 }
      const dir = byBranch.get(branch)
      if (dir && measureTouch) {
        const walked = await measureTouch(dir).catch(() => ({ at: null, floored: false }))
        touches[task.id] = { branch, at: walked.at, floored: walked.floored === true }
      }
    }
    for (const row of livenessRows({ tasks, tips, touches, now, staleMinutes })) {
      if (row.state === 'working' || row.unknownReason === 'walk-capped') live.push(`${printable(entry.name)}/${printable(row.taskId)}`)
    }
  }
  return live
}

export async function migrate(root, {
  io = { out: console.log, err: console.error },
  measureTouch = null,
  now = Date.now(),
  staleMinutes = DEFAULT_STALE_MINUTES,
  // A TEST SEAM and nothing else: production callers never pass it. It is how each step's
  // failure path is reached without breaking git or the filesystem for real.
  beforeStep = async () => {},
} = {}) {
  root = path.resolve(root)
  const inv = await legacyInventory(root)
  if (nothingLegacy(inv)) return { code: 0, migrated: false }

  const clash = await conflicts(root, inv)
  if (clash.length > 0) {
    io.out(`cannot migrate ${LEGACY.product} names to ${NAMES.product}: ${clash.join('; ')}. Remove or merge one of each pair by hand, then re-run.`)
    return { code: 2, migrated: false }
  }
  if (inv.stateDir) {
    const live = await liveTasks(root, { measureTouch, now, staleMinutes })
    if (live.length > 0) {
      io.out(`cannot migrate ${LEGACY.product} names to ${NAMES.product} while teammates are live: ${live.join(', ')}. `
        + `A teammate on the old plugin keeps writing to ${LEGACY.stateDir}/ after the move, which splits its run. `
        + `Wait until they go stale (${staleMinutes} minutes with no commit and no file write) or stop the fleet, then re-run.`)
      return { code: 2, migrated: false }
    }
  }

  const done = []
  const record = (did, undo) => {
    done.push({ did, undo })
    io.err(`  ${did}`)
  }
  const legacyState = path.join(root, LEGACY.stateDir)
  const currentState = path.join(root, NAMES.stateDir)
  const rel = (p) => path.relative(root, p).split(path.sep).join('/')

  const steps = {
    branches: async () => {
      for (const { name } of inv.branches) {
        const target = renamedBranch(name)
        await git(root, ['branch', '-m', name, target])
        record(`branch ${printable(name)} -> ${printable(target)}`, `git branch -m ${shellQuote(target)} ${shellQuote(name)}`)
      }
    },
    'claim-refs': async () => {
      for (const { ref, sha } of inv.claimRefs) {
        const target = renamedRef(ref)
        await git(root, ['update-ref', target, sha, ''])
        await git(root, ['update-ref', '-d', ref, sha])
        record(`ref ${printable(ref)} -> ${printable(target)}`, `git update-ref ${shellQuote(ref)} ${sha} && git update-ref -d ${shellQuote(target)} ${sha}`)
      }
    },
    'stored-names': async () => {
      if (!inv.stateDir) return
      for (const file of await filesUnder(legacyState)) {
        if (file.endsWith(BACKUP_SUFFIX)) continue
        const text = await readFile(file, 'utf8')
        let next = null
        if (file.endsWith('.json')) {
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            continue
          }
          const rewritten = rewriteStoredNames(parsed)
          if (JSON.stringify(rewritten) !== JSON.stringify(parsed)) {
            next = /\n\s/.test(text.trim()) ? `${JSON.stringify(rewritten, null, 2)}\n` : `${JSON.stringify(rewritten)}\n`
          }
        } else if (path.basename(file) === 'map.md' && text.startsWith(`<!-- ${LEGACY.mapHeader} `)) {
          next = `<!-- ${NAMES.mapHeader} ${text.slice(`<!-- ${LEGACY.mapHeader} `.length)}`
        }
        if (next === null) continue
        const backup = `${file}${BACKUP_SUFFIX}`
        if (!await exists(backup)) await copyFile(file, backup)
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, next, 'utf8')
        await rename(tmp, file)
        record(`rewrote stored names in ${printable(rel(file))}`, `mv ${shellQuote(rel(backup))} ${shellQuote(rel(file))}`)
      }
    },
    'state-dir': async () => {
      if (!inv.stateDir) return
      const realState = await realpath(legacyState)
      const inside = (await listWorktrees(root)).filter((w) => isUnder(w.path, realState))
      await rename(legacyState, currentState)
      const repairBack = inside.map((w) => ` && git worktree repair ${shellQuote(w.path)}`).join('')
      record(`moved ${LEGACY.stateDir}/ -> ${NAMES.stateDir}/`, `mv ${NAMES.stateDir} ${LEGACY.stateDir}${repairBack}`)
      for (const w of inside) {
        const moved = path.join(currentState, path.relative(realState, path.resolve(w.path)))
        await git(root, ['worktree', 'repair', moved])
        record(`repaired worktree ${printable(rel(moved))}`, '(reversed by the state directory line below)')
      }
    },
    manifests: async () => {
      for (const [present, legacy, current] of [
        [inv.gateFile, LEGACY.gateFile, NAMES.gateFile],
        [inv.localFile, LEGACY.localFile, NAMES.localFile],
      ]) {
        if (!present) continue
        const tracked = inv.gitRepo && (await runGit(root, ['ls-files', '--error-unmatch', '--', legacy])).code === 0
        if (tracked) {
          await git(root, ['mv', '--', legacy, current])
          record(`git mv ${legacy} ${current}`, `git mv ${current} ${legacy}`)
        } else {
          await rename(path.join(root, legacy), path.join(root, current))
          record(`moved ${legacy} -> ${current}`, `mv ${current} ${legacy}`)
        }
      }
    },
    gitignore: async () => {
      let text = ''
      try {
        text = await readFile(path.join(root, '.gitignore'), 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        const bare = trimmed.replace(/^\//, '').replace(/\/$/, '')
        let replacement = null
        if (bare === LEGACY.stateDir) replacement = trimmed.replace(LEGACY.stateDir, NAMES.stateDir)
        else if (bare === LEGACY.localFile) replacement = trimmed.replace(LEGACY.localFile, NAMES.localFile)
        if (replacement && await ensureGitignored(root, replacement)) {
          record(`added ${replacement} to .gitignore`, `remove the line ${replacement} from .gitignore`)
        }
      }
    },
  }

  io.err(`migrating ${LEGACY.product} names to ${NAMES.product} in ${printable(root)}`)
  for (const name of MIGRATION_STEPS) {
    try {
      await beforeStep(name)
      await steps[name]()
    } catch (err) {
      io.out(`migration to ${NAMES.product} stopped at step ${name}: ${printable(err.message)}`)
      if (done.length === 0) {
        io.out('nothing had been changed yet.')
      } else {
        io.out('already done, and how to reverse it (from the repository root, in this order):')
        for (const step of [...done].reverse()) io.out(`  ${step.undo}    # undoes: ${step.did}`)
      }
      return { code: 4, migrated: false }
    }
  }

  // Backups are only kept while a failure could still need them. Every one left from this or an
  // earlier interrupted attempt now sits under the new state directory.
  if (await exists(currentState)) {
    for (const file of await filesUnder(currentState)) {
      if (file.endsWith(BACKUP_SUFFIX)) await unlink(file).catch(() => {})
    }
  }
  return { code: 0, migrated: true }
}
