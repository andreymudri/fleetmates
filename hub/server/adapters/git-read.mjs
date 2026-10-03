import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * The configuration overrides of docs/deck/08-security.md section 4.8, placed before every git command,
 * plus `core.attributesFile=/dev/null` so a global attributes file cannot select a filter driver. These
 * flags alone do not stop a repository's own `.gitattributes` or `.git/info/attributes` from selecting a
 * `filter.<name>.clean` command in `.git/config`: git status, diff-files, diff-index and ls-files -m
 * re-hash a stat-dirty file through it. `allowedCommand` closes that by refusing every command that reads
 * work-tree content through attributes.
 */
export const SAFE_GIT_FLAGS = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'diff.external=',
  '-c', 'core.sshCommand=false',
  '-c', 'protocol.allow=never',
  '-c', 'core.attributesFile=/dev/null',
  '--no-pager'
])

const secretName = /TOKEN|SECRET|PASSWORD|AUTHORIZATION/i

/**
 * The environment a read-only git child gets: the server's own environment without any variable whose
 * name looks like a credential (the deck token among them) and without inherited `GIT_*` variables
 * (`GIT_DIR`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_PARAMETERS` and the like would redirect or reconfigure
 * the call), plus the four 4.8 variables and `GIT_ATTR_NOSYSTEM=1`.
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Record<string, string>}
 */
export function gitEnv(source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || secretName.test(key) || key.startsWith('GIT_')) continue
    env[key] = value
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '/bin/false', GIT_ATTR_NOSYSTEM: '1' }
}

const HOOKS_PATH_KEYS = '^(core\\.hookspath|include(if\\..+)?\\.path)$'
/**
 * The two config reads of the classifier's core.hooksPath cache (D-92 (a)), which with
 * `hooksPathFileRead` are the only multi-value config reads `allowedCommand` accepts, each exactly as
 * written: the values git applies, and every raw hooksPath, include.path and includeIf.*.path value
 * with the file it came from.
 */
export const HOOKS_PATH_READS = Object.freeze([
  Object.freeze(['config', '--type=path', '--get-all', 'core.hooksPath']),
  Object.freeze(['config', '--null', '--show-origin', '--get-regexp', HOOKS_PATH_KEYS])
])
/**
 * The third hooksPath read: the raw hooksPath, include.path and includeIf.*.path values of one config
 * file, read alone (`--file` follows no include), whether or not git includes it now.
 * @param {string} file an absolute path
 * @returns {string[]}
 */
export function hooksPathFileRead(file) {
  return ['config', '--file', file, '--null', '--get-regexp', HOOKS_PATH_KEYS]
}
const isFileRead = args => args.length === 6 && typeof args[2] === 'string' && path.isAbsolute(args[2]) && hooksPathFileRead(args[2]).every((word, k) => args[k] === word)
/**
 * The config-location variables the user's own git honours. The HOOKS_PATH_READS and
 * `hooksPathFileRead`, and no other command, get them from the server's environment and read the system config, so they see the
 * hooksPath the user's git applies.
 */
export const HOOKS_PATH_ENV = Object.freeze(['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
const isHooksPathRead = args => isFileRead(args) || HOOKS_PATH_READS.some(form => form.length === args.length && form.every((word, k) => args[k] === word))

/** Words before `--` (the options and revisions; pathspecs come after `--`). */
function options(args) {
  const end = args.indexOf('--')
  return end < 0 ? args : args.slice(0, end)
}

/** True when a word is the long option `long` or a short-option cluster holding any of `letters`. */
function hasOption(words, letters, long) {
  return words.some(word => long.includes(word.split('=')[0]) || /^-[A-Za-z]+$/.test(word) && [...word.slice(1)].some(letter => letters.includes(letter)))
}

/**
 * Whether `gitRead` will run `args`. Only commands that read the object store, the index entries or
 * the directory listing are allowed; none of them passes work-tree content through a gitattributes
 * filter, textconv or diff driver, so a repository's config and attributes never choose a program to
 * run. `status`, `diff` against the work tree, `diff-files`, `diff-index`, `show`, `log` and anything
 * that writes are refused. `diff` is allowed only as `diff --no-index --no-ext-diff --no-textconv`, which
 * `gitRead` runs outside any repository. The subcommand must be the first word, so no `-c` or `-C` can
 * follow the safe flags.
 * @param {string[]} args git arguments after the safe flags
 * @returns {boolean}
 */
export function allowedCommand(args) {
  if (!Array.isArray(args) || !args.every(word => typeof word === 'string')) return false
  const [command, ...rest] = args
  const words = options(rest)
  switch (command) {
    case 'rev-parse':
    case 'rev-list':
    case 'ls-tree':
      return true
    case 'symbolic-ref':
      // Two operands would set the ref.
      return !hasOption(words, 'd', ['--delete']) && words.filter(word => !word.startsWith('-')).length <= 1
    case 'cat-file':
      return !hasOption(words, '', ['--filters', '--textconv'])
    case 'ls-files':
      // -m, -d and -k compare the work tree with the index, which re-hashes stat-dirty files.
      return !hasOption(words, 'mdk', ['--modified', '--deleted', '--killed'])
    case 'clean':
      return hasOption(words, 'n', ['--dry-run']) && !hasOption(words, 'fi', ['--force', '--interactive'])
    case 'worktree':
      return rest[0] === 'list'
    case 'config':
      // D-92 (a): the classifier's two core.hooksPath reads, exactly as written.
      if (isHooksPathRead(args)) return true
      return words.includes('--get') && words.every(word => ['--get', '--bool', '--type=bool', '--null', '-z'].includes(word) || !word.startsWith('-'))
    case 'diff':
      return ['--no-index', '--no-ext-diff', '--no-textconv'].every(word => words.includes(word))
    default:
      return false
  }
}

/**
 * Run one read-only git command in `root` with the 4.8 flags: an argv array (never a shell), a timeout,
 * and no credential variables in the environment. A command `allowedCommand` refuses is never started
 * and resolves null. `diff --no-index` runs with `GIT_DIR=/dev/null`, so git finds no repository and no
 * repository attributes apply to the two files. Resolves `{ code, stdout }` for any exit status, so a
 * caller can read `git diff --no-index` exit 1 as "differences"; resolves null when git could not start,
 * timed out, was killed or wrote more than `maxBuffer` bytes. It never rejects. `home`, an absolute
 * path, replaces `HOME` in the child's environment, so the global config git reads is that home's.
 * The HOOKS_PATH_READS run without `GIT_CONFIG_NOSYSTEM` and with the HOOKS_PATH_ENV variables.
 * @param {string} root working directory of the git call
 * @param {string[]} args git arguments after the safe flags
 * @param {{ timeoutMs?: number, maxBuffer?: number, input?: string|Buffer, home?: string }} [options]
 * @returns {Promise<{ code: number, stdout: Buffer } | null>}
 */
export function gitRead(root, args, { timeoutMs = 1500, maxBuffer = 1024 * 1024, input, home } = {}) {
  if (!allowedCommand(args)) return Promise.resolve(null)
  const base = { ...gitEnv(), ...(typeof home === 'string' && path.isAbsolute(home) ? { HOME: home } : {}) }
  if (isHooksPathRead(args)) {
    delete base.GIT_CONFIG_NOSYSTEM
    for (const name of HOOKS_PATH_ENV) if (typeof process.env[name] === 'string') base[name] = process.env[name]
  }
  const env = args[0] === 'diff' ? { ...base, GIT_DIR: '/dev/null' } : base
  return new Promise(resolve => {
    let child
    try {
      child = execFile('git', [...SAFE_GIT_FLAGS, ...args], {
        cwd: root,
        env,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer,
        encoding: 'buffer',
        shell: false,
        windowsHide: true
      }, (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout })
        if (typeof error.code === 'number' && !error.killed && !error.signal) return resolve({ code: error.code, stdout })
        resolve(null)
      })
    } catch { resolve(null); return }
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
