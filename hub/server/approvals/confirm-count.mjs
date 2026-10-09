import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, readlinkSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { gitRead } from '../adapters/git-read.mjs'
import { openNoFollowSync } from '../../platform/index.mjs'

/** The count kinds of docs/deck/07-approvals.md section 8. */
export const COUNT_KINDS = Object.freeze(['push_overwritten', 'reset_files', 'clean_files', 'rm_paths'])

const literalWord = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * A word is literal when the shell would pass it through unchanged: no quotes, escapes, expansions,
 * substitutions or glob characters. Anything else makes a count unknown.
 * @param {unknown} word
 */
function literal(word) {
  return typeof word === 'string' && literalWord.test(word)
}

function lines(output) {
  if (output?.code !== 0) return null
  return output.stdout.toString('utf8').split('\n').filter(Boolean).length
}

/** The words after `git <subcommand>`, or null when git has a global option other than the pager ones. */
function gitArgs(argv, subcommand) {
  if (argv[0] !== 'git') return null
  let index = 1
  while (argv[index] === '--no-pager' || argv[index] === '-P') index++
  return argv[index] === subcommand ? argv.slice(index + 1) : null
}

const pushValueOptions = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const pushRefusedOptions = /^(--all|--mirror|--tags|--delete|-d|--prune|--branches|--follow-tags)$/

async function pushOverwritten(argv, root) {
  const args = gitArgs(argv, 'push')
  if (!args) return null
  const operands = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (word === '--') { operands.push(...args.slice(index + 1)); break }
    if (pushRefusedOptions.test(word) || word.startsWith('--repo')) return null
    if (pushValueOptions.has(word)) { index++; continue }
    if (word.startsWith('-')) continue
    operands.push(word)
  }
  if (operands.length !== 2 || !operands.every(literal)) return null
  const [remote, refspec] = operands
  const parts = refspec.replace(/^\+/, '').split(':')
  if (parts.length > 2 || parts.some(part => !part)) return null
  let [local, remoteBranch = parts[0]] = parts
  remoteBranch = remoteBranch.replace(/^refs\/heads\//, '')
  if (local === 'HEAD' && parts.length === 1) {
    const branch = await gitRead(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    remoteBranch = branch?.code === 0 ? branch.stdout.toString('utf8').trim() : ''
    if (!literal(remoteBranch)) return null
  }
  if (remote.includes('/') || remote.startsWith('.')) return null
  const localSha = await gitRead(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${local}^{commit}`])
  const remoteSha = await gitRead(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/remotes/${remote}/${remoteBranch}^{commit}`])
  const ours = localSha?.code === 0 ? localSha.stdout.toString('utf8').trim() : ''
  const theirs = remoteSha?.code === 0 ? remoteSha.stdout.toString('utf8').trim() : ''
  if (!/^[0-9a-f]{40,64}$/.test(ours) || !/^[0-9a-f]{40,64}$/.test(theirs)) return null
  const counted = await gitRead(root, ['rev-list', '--count', `${ours}..${theirs}`])
  const value = counted?.code === 0 ? counted.stdout.toString('utf8').trim() : ''
  return /^\d+$/.test(value) ? Number(value) : null
}

async function cleanFiles(argv, root) {
  const args = gitArgs(argv, 'clean')
  if (!args || !args.every(literal)) return null
  const flags = []
  const paths = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (word === '--') { paths.push(...args.slice(index + 1)); break }
    if (word === '-e' || word === '--exclude') {
      if (index + 1 >= args.length) return null
      flags.push('-e', args[++index])
      continue
    }
    if (word.startsWith('--exclude=')) { flags.push(word); continue }
    if (['--force', '--quiet', '--dry-run'].includes(word)) continue
    if (/^-[A-Za-z]+$/.test(word)) {
      for (const letter of word.slice(1)) {
        if (letter === 'f' || letter === 'q' || letter === 'n') continue
        if (letter === 'd' || letter === 'x' || letter === 'X') flags.push(`-${letter}`)
        else return null
      }
      continue
    }
    if (word.startsWith('-')) return null
    paths.push(word)
  }
  return lines(await gitRead(root, ['clean', '-n', ...flags, '--', ...paths]))
}

/** Bytes of work-tree content `reset_files` hashes before it gives up and answers null. */
const maxHashedBytes = 64 * 1024 * 1024
const skipWorktree = 0x40000000
const assumeValid = 0x8000

async function text(root, args) {
  const output = await gitRead(root, args, { maxBuffer: 64 * 1024 * 1024 })
  return output?.code === 0 ? output.stdout.toString('utf8') : null
}

/** Every sticky match of `pattern` over the whole of `output`, or null when any byte is left unmatched. */
function records(output, pattern) {
  const found = []
  let at = 0
  while (at < output.length) {
    pattern.lastIndex = at
    const match = pattern.exec(output)
    if (!match) return null
    found.push(match)
    at = pattern.lastIndex
  }
  return found
}

/** `git ls-tree -r -z --full-tree HEAD` as path -> { mode, oid }, or null on unexpected output. */
function treeEntries(output) {
  const found = records(output, /(\d{6}) [a-z]+ ([0-9a-f]{40,64})\t([^\0]*)\0/y)
  return found && new Map(found.map(([, mode, oid, name]) => [name, { mode, oid }]))
}

/** `git ls-files --stage --debug -z` as path -> { mode, oid, stage, mtime (ns), size, flags }, or null. */
function indexEntries(output) {
  const found = records(output, /(\d{6}) ([0-9a-f]{40,64}) (\d)\t([^\0]*)\0 {2}ctime: \d+:\d+\n {2}mtime: (\d+):(\d+)\n {2}dev: \d+\tino: \d+\n {2}uid: \d+\tgid: \d+\n {2}size: (\d+)\tflags: ([0-9a-f]+)\n/y)
  if (!found) return null
  const entries = new Map()
  for (const [, mode, oid, stage, name, seconds, nanoseconds, size, flags] of found) {
    const unmerged = entries.get(name)?.stage !== undefined && entries.get(name).stage !== '0'
    entries.set(name, {
      mode, oid, stage: unmerged ? entries.get(name).stage : stage,
      mtime: BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds), size: Number(size), flags: Number.parseInt(flags, 16)
    })
  }
  return entries
}

function readBytes(file, size) {
  const fd = openNoFollowSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== size) return null
    const bytes = Buffer.alloc(size)
    let at = 0
    while (at < size) {
      const read = readSync(fd, bytes, at, size - at, at)
      if (!read) break
      at += read
    }
    return bytes.subarray(0, at)
  } finally { closeSync(fd) }
}

/**
 * Whether the work-tree file at `file` differs from its index entry, decided in this process with no git
 * call that reads work-tree content: a missing path, a changed type or executable bit is a change; a size
 * and mtime equal to the cached index stat (and older than the index file) is no change; anything else is
 * hashed as raw bytes and compared with the index blob. Raw bytes skip clean filters and end-of-line
 * conversion, so in a repository that converts content a stat-dirty file can count as changed where git
 * status would not list it. Returns null when the hashing budget runs out.
 */
function worktreeChanged(file, entry, scan) {
  let stat
  try { stat = lstatSync(file, { bigint: true }) } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return true
    throw error
  }
  const link = entry.mode === '120000'
  if (link ? !stat.isSymbolicLink() : !stat.isFile()) return true
  if (!link && scan.fileMode && ((stat.mode & 0o100n) !== 0n) !== (entry.mode === '100755')) return true
  if (stat.mtimeNs === entry.mtime && Number(stat.size) === entry.size && stat.mtimeNs < scan.indexTime) return false
  if (Number(stat.size) > scan.remaining) return null
  scan.remaining -= Number(stat.size)
  const bytes = link ? Buffer.from(readlinkSync(file)) : readBytes(file, Number(stat.size))
  if (!bytes) return true
  return createHash(scan.format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.oid
}

/**
 * Tracked files `git reset --hard` would discard: every path whose index entry differs from HEAD
 * (staged, unmerged, added or deleted) plus every path whose work-tree file differs from its index
 * entry. Untracked files are not counted, since a reset leaves them alone. It reads HEAD with `ls-tree`,
 * the index with `ls-files --stage --debug` and the work tree itself, and never runs `git status`, which
 * passes stat-dirty files through a repository's `filter.<name>.clean` command.
 */
async function resetFiles(root) {
  const top = (await text(root, ['rev-parse', '--show-toplevel']))?.trim()
  if (!top || !path.isAbsolute(top)) return null
  const format = (await text(top, ['rev-parse', '--show-object-format']))?.trim()
  const indexPath = (await text(top, ['rev-parse', '--git-path', 'index']))?.trim()
  const head = await gitRead(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (!['sha1', 'sha256'].includes(format) || !indexPath || head?.code !== 0) return null
  const tree = await text(top, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])
  const listed = await text(top, ['ls-files', '--stage', '--debug', '-z'])
  const headFiles = tree === null ? null : treeEntries(tree)
  const indexFiles = listed === null ? null : indexEntries(listed)
  if (!headFiles || !indexFiles) return null
  let indexTime = 0n
  try { indexTime = statSync(path.resolve(top, indexPath), { bigint: true }).mtimeNs } catch {}
  const fileMode = (await text(top, ['config', '--bool', '--get', 'core.filemode']))?.trim() !== 'false'
  const scan = { format, indexTime, fileMode, remaining: maxHashedBytes }
  let count = 0
  for (const name of new Set([...headFiles.keys(), ...indexFiles.keys()])) {
    const before = headFiles.get(name)
    const entry = indexFiles.get(name)
    if (!before || !entry || entry.stage !== '0' || before.mode !== entry.mode || before.oid !== entry.oid) { count++; continue }
    if (entry.mode === '160000' || entry.flags & (skipWorktree | assumeValid)) continue
    const changed = worktreeChanged(path.join(top, name), entry, scan)
    if (changed === null) return null
    if (changed) count++
  }
  return count
}

function rmPaths(argv) {
  if (argv[0] !== 'rm' || !argv.every(literal)) return null
  let count = 0
  let options = true
  for (const word of argv.slice(1)) {
    if (options && word === '--') { options = false; continue }
    if (options && word.startsWith('-') && word !== '-') continue
    count++
  }
  return count
}

/**
 * The count for a Destructive confirm label (docs/deck/07-approvals.md section 8): commits a force push
 * would overwrite (`git rev-list --count <local>..<remote-tracking ref>`, as of the last fetch), tracked
 * files a reset would discard (index or work tree differing from HEAD; untracked files are not counted),
 * untracked files `git clean` would delete (`git clean -n` with the request's flags minus `-f`), or the
 * literal operands of `rm` (never expanded). Every git call goes through `gitRead`, which refuses any
 * command that reads work-tree content through gitattributes. Resolves null when a word is not literal, the command
 * is not one it can count, or any step fails; it never rejects.
 * @param {'push_overwritten'|'reset_files'|'clean_files'|'rm_paths'} kind
 * @param {string[]} argv the command words, starting with `git` or `rm`
 * @param {string} root repository root the command runs in
 * @returns {Promise<number|null>}
 */
export async function countFor(kind, argv, root) {
  try {
    if (!Array.isArray(argv) || !argv.length) return null
    if (kind === 'push_overwritten') return await pushOverwritten(argv, root)
    if (kind === 'reset_files') return await resetFiles(root)
    if (kind === 'clean_files') return await cleanFiles(argv, root)
    if (kind === 'rm_paths') return rmPaths(argv)
    return null
  } catch { return null }
}
