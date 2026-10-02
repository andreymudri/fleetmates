import { gitRead } from '../adapters/git-read.mjs'

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
 * would overwrite (`git rev-list --count <local>..<remote-tracking ref>`, as of the last fetch), changed
 * files a reset would discard (`git status --porcelain` lines), untracked files `git clean` would delete
 * (`git clean -n` with the request's flags minus `-f`), or the literal operands of `rm` (never expanded).
 * Every git call is read-only through `gitRead`. Resolves null when a word is not literal, the command
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
    if (kind === 'reset_files') return lines(await gitRead(root, ['status', '--porcelain']))
    if (kind === 'clean_files') return await cleanFiles(argv, root)
    if (kind === 'rm_paths') return rmPaths(argv)
    return null
  } catch { return null }
}
