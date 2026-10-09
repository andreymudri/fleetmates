// The approvals tier classifier (docs/deck/07-approvals.md section 3, with the tier review changes
// adopted as D-75 to D-91). `classify` matches a permission request against the effective tiers
// set (tiers.default.json plus the user's tiers.json, see tiers-store.mjs), takes the highest
// matching tier, and then applies the floors, which are code and cannot be lowered or disabled.
import { createHash } from 'node:crypto'
import { existsSync, globSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import os from 'node:os'
// docs/deck/16-platforms.md section 6: Claude Code runs the Bash tool through Git Bash on Windows, so
// parsed command paths are POSIX paths on every host, never the host's `path`.
import { posix as path } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitRead, HOOKS_PATH_ENV, HOOKS_PATH_READS, hooksPathEnvironment, hooksPathFileRead } from '../adapters/git-read.mjs'
import { destructiveSql, legacyDestructive } from '../machines/request.mjs'
import { setupPaths } from '../setup/paths.mjs'
import { commandBase, gitSubcommandArgs, normalizeLongOption, parseCommand } from './shell.mjs'

/** The tiers, lowest first. */
export const TIERS = Object.freeze(['safe', 'caution', 'destructive'])
const rank = tier => TIERS.indexOf(tier)

/**
 * The highest of the given tiers; `null` and unknown values are ignored. Used to keep an open
 * request's tier from going down when it is recomputed (07-approvals 3.2 step 6).
 * @param {...(string|null|undefined)} tiers
 * @returns {string|null}
 */
export function maxTier(...tiers) {
  let best = null
  for (const tier of tiers) if (rank(tier) >= 0 && (best === null || rank(tier) > rank(best))) best = tier
  return best
}

const defaultsFile = fileURLToPath(new URL('./tiers.default.json', import.meta.url))
/** The shipped defaults, parsed once. */
export const DEFAULT_TIERS = Object.freeze(JSON.parse(readFileSync(defaultsFile, 'utf8')))

/**
 * sha256 of an effective entry list, recorded in the approvals audit as `tiers_sha256`.
 * @param {{ entries: object[] }} tiers
 * @returns {string}
 */
export function tiersSha256(tiers) {
  return createHash('sha256').update(JSON.stringify(tiers?.entries ?? [])).digest('hex')
}

let activeSource = null
/**
 * Register where request open reads the effective tiers (a tiers store's `current`). Without one,
 * the shipped defaults are used.
 * @param {(() => { entries: object[] }) | null} source
 */
export function setActiveTiers(source) {
  activeSource = typeof source === 'function' ? source : null
}

/**
 * The tiers set request open classifies with: the registered source, else the defaults.
 * @returns {{ entries: object[] }}
 */
export function activeTiers() {
  return activeSource?.() ?? DEFAULT_TIERS
}

// Floors (07-approvals 3.4). Lists of the env floor and the git `-c` keys (F1).
const PRIVILEGE_WORDS = Object.freeze(['sudo', 'doas', 'su', 'pkexec'])
const ENV_FLOOR = Object.freeze(['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'RUSTC_WRAPPER', 'BASH_ENV', 'PROMPT_COMMAND'])
const envFloor = name => ENV_FLOOR.includes(name) || name.startsWith('GIT_') || name.startsWith('CARGO_')
const GIT_C_EXACT = Object.freeze(['core.fsmonitor', 'core.hookspath', 'core.pager', 'core.sshcommand', 'core.editor', 'diff.external'])
const gitCKeyRunsCode = key => GIT_C_EXACT.includes(key) || /^(?:alias|filter|include|includeif)\./.test(key) || key.endsWith('.textconv')
// `git config` writes rated Destructive: the M1 keys and the F1 keys, plus the diff and merge
// driver commands and credential helpers, which also run programs.
const gitConfigWriteRunsCode = key => /^(?:remote\..+\.(?:push|mirror)|alias\..*|core\..*|push\..*|include.*|url\..*|filter\..*|diff\.external|diff\..+\.command|merge\..+\.driver|credential\..*)$/.test(key) || key.endsWith('.textconv')
const DEV_NULLS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])
const PERSISTENCE_FILES = Object.freeze(['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.config/fish/config.fish'])
const PERSISTENCE_DIRS = Object.freeze(['.config/fish/conf.d', '.config/hypr', '.config/systemd/user', '.config/autostart'])
// The deck's own launchd agents (docs/deck/16-platforms.md), folded as relFolded folds.
const LAUNCH_AGENT_PREFIX = 'library/launchagents/io.fleetmates.deck.'
// The deck's service controls on macOS and Windows: a launchctl word naming a deck label, and reg
// writing the per-user Run key that starts the deck at login. The key is matched with or without
// its backslashes, because an unquoted key loses them to the shell.
const namesLaunchLabel = word => fold(word).includes('io.fleetmates.deck')
const namesRunKey = word => /currentversion[\\/]*run(?:$|[\\/])/.test(fold(word))
const REG_WRITES = Object.freeze(['add', 'delete', 'copy', 'import', 'restore', 'load'])
function controlsDeckService(name, words) {
  const base = fold(name).replace(/\.exe$/, '')
  if (base === 'launchctl') return words.slice(1).some(namesLaunchLabel)
  if (base === 'reg') return REG_WRITES.includes(fold(words[1] ?? '')) && words.slice(2).some(namesRunKey)
  return false
}
// Bash read commands whose path operands go through the sensitive list (F9) whether or not the
// file exists yet. Every other command's operands and option values go through it too, once the
// path exists (a path that does not exist holds nothing to read).
const READ_COMMANDS = Object.freeze(['cat', 'head', 'tail', 'less', 'grep', 'rg', 'cp', 'base64', 'xxd', 'od', 'strings'])
// Commands that only print their own arguments, so a path among them is text, not a read.
const TEXT_COMMANDS = Object.freeze(['echo', 'printf'])
// Safe subcommands documented to rewrite the files or directories they are given (the working
// directory when they are given none; the tools are not run in this suite), so every path operand
// is a write target.
const OPERAND_WRITERS = Object.freeze(['terraform fmt', 'ruff check', 'ruff format', 'go fmt'])
// D-90 (a): formatters and fixers, keyed by command word and, where the tool has one, subcommand.
// Each function says whether the option words before any `--` put the tool in an explicit check,
// diff or dry-run mode, the only modes that write nothing. Any other invocation, and any invocation
// holding `--`, is Caution: after `--` these tools read `--check` or `-n` as a file name, and some
// (rustfmt through `cargo fmt --`) take options there that this table does not model. The modes are
// taken from each tool's documentation (`ruff help`, `black --help`, `cargo fmt --help`, `go help
// fmt`, `terraform fmt -help`, the eslint and prettier CLI docs); none of these tools is run here.
const FIXERS = Object.freeze({
  __proto__: null,
  'ruff check': args => !args.some(arg => arg.startsWith('--fix')) || args.includes('--diff'),
  'ruff format': args => args.includes('--check') || args.includes('--diff'),
  black: args => args.includes('--check') || args.includes('--diff'),
  'terraform fmt': args => args.includes('-check') || args.includes('-write=false'),
  'npx eslint': args => !args.some(arg => arg.startsWith('--fix') && arg !== '--fix-dry-run'),
  'npx prettier': args => !args.includes('--write') && !args.includes('-w') && (args.includes('--check') || args.includes('-c') || args.includes('--list-different') || args.includes('-l')),
  'go fmt': args => args.includes('-n'),
  'cargo fmt': args => args.includes('--check')
})
// D-89 (3): runners and checkers that write caches, reports or build outputs into their working
// directory or next to the paths they are given (pytest's .pytest_cache at its rootdir, coverage's
// .coverage and htmlcov, mypy's .mypy_cache, ruff's .ruff_cache), by command word.
const RUNNERS = Object.freeze(['pytest', 'python', 'python3', 'uv', 'mypy', 'ruff', 'black', 'pyright', 'cargo', 'go', 'gofmt', 'golangci-lint', 'staticcheck', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'terraform'])
const FILE_WRITE_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const GLOB_LIMIT = 1000
const GLOB_VISIT_LIMIT = 20000
// git subcommands whose unknown long options are at least Caution (F6).
const GIT_LONG_CHECKED = Object.freeze(['push', 'reset', 'clean', 'checkout', 'switch', 'restore', 'branch', 'rm', 'gc'])
const GIT_SAFE_GLOBALS = Object.freeze(['--no-pager', '-P'])

/** The sensitive list of 07-approvals 3.5 (F9), as written there. */
export const SENSITIVE_PATHS = Object.freeze(['~/.ssh/**', '~/.gnupg/**', '~/.aws/**', '~/.config/gh/**', '~/.netrc', '**/.env', '**/.env.*', '~/.claude/.credentials.json', '~/.git-credentials', '~/.npmrc', '~/.pypirc', '~/.docker/config.json', '~/.kube/config', '~/.config/gcloud/**', '~/.password-store/**', '~/.local/share/keyrings/**', '*.pem', '**/id_* (not *.pub)', '**/.envrc'])
/**
 * The execution-config list of 07-approvals 3.5 (F4, D-80: not `.envrc`), with the alternate names
 * and tool config files of D-89 (1).
 */
export const EXECUTION_CONFIG = Object.freeze(['.cargo/config*', 'build.rs', 'package.json', '.npmrc', '.yarnrc*', 'Makefile', 'GNUmakefile', 'BSDmakefile', 'justfile', '.justfile', 'conftest.py', 'pyproject.toml', 'pytest.ini', '.pytest.ini', 'tox.ini', 'setup.cfg', '.coveragerc', 'mypy.ini', '.mypy.ini', '.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json', 'setup.py', 'go.mod', 'go.work','.husky/**', '.githooks/**', '.github/workflows/**', '.claude/commands/**', '.claude/agents/**', '.claude/skills/**'])

const within = (target, root) => typeof target === 'string' && typeof root === 'string' && (target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`))

// Name checks compare folded text on every platform: a case-insensitive file system (the macOS
// default) opens `.GIT/config` as `.git/config` and `.ENV` as `.env`, and HFS+ also ignores the
// zero-width code points git's is_hfs_dotgit() skips. Repo scope is not folded, so a case variant
// of the repo path reads as outside the repo, which only raises a tier. D-89 (2): the text is
// normalized with NFKC first, which maps U+017F (long s) to s and the st ligatures to st, as the
// Unicode case folding of a casefold file system does; toLowerCase alone keeps them.
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g
const fold = text => String(text).replace(HFS_IGNORED, '').normalize('NFKC').replace(HFS_IGNORED, '').toLowerCase()
const withinFolded = (target, root) => typeof target === 'string' && typeof root === 'string' && within(fold(target), fold(root))
// `location` relative to `base`, both folded; null when it is not strictly below `base`.
function relFolded(location, base) {
  if (!base) return null
  const rel = path.relative(fold(base), fold(location))
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel
}

// The path the kernel reaches for `location`, resolving every symlink on the way, including a
// dangling one (its target is where a writer creates the file), with the missing tail kept as
// written. A symlink loop resolves to the lexical path, which the kernel refuses to open (ELOOP).
const SYMLINK_HOPS = 40
function realExisting(location) {
  const lexical = path.resolve(location)
  let pending = lexical.split('/').filter(Boolean)
  let current = '/'
  let hops = 0
  while (pending.length) {
    const part = pending.shift()
    if (part === '.') continue
    if (part === '..') { current = path.dirname(current); continue }
    const next = path.join(current, part)
    let stat
    try { stat = lstatSync(next) } catch { return path.join(next, ...pending) }
    if (!stat.isSymbolicLink()) { current = next; continue }
    if (++hops > SYMLINK_HOPS) return lexical
    let target
    try { target = readlinkSync(next) } catch { return lexical }
    if (target.startsWith('/')) current = '/'
    pending = [...target.split('/').filter(Boolean), ...pending]
  }
  return current
}

// On win32 (docs/deck/16-platforms.md section 6) a Windows path and its Git Bash form name the same
// file: `C:\x`, `C:/x` and `/c/x` all read as `/c/x`, with `\` read as `/`. A drive path the parser
// already joined to the working directory (`/c/repo/C:\x`) is taken from its drive on. Set by
// classify for the length of one synchronous call.
let windowsPaths = false
function gitBashPath(text) {
  if (typeof text !== 'string') return text
  const at = text.search(/(?:^|\/)[A-Za-z]:[\\/]/)
  const rest = (at < 0 ? text : text.slice(text[at] === '/' ? at + 1 : at)).replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\//.exec(rest)
  return drive ? path.normalize(`/${drive[1].toLowerCase()}${rest.slice(2)}`) : rest
}
const hostForm = text => windowsPaths ? gitBashPath(text) : text
// An absolute input path (home, cwd, repo root, deck paths): POSIX, or on win32 also a Windows path.
const inputPath = (text, platform) => {
  if (typeof text !== 'string') return null
  const form = platform === 'win32' ? gitBashPath(text) : text
  return path.isAbsolute(form) ? path.normalize(form) : null
}

function resolveIn(location, cwd) {
  if (typeof location !== 'string' || !location) return null
  location = hostForm(location)
  if (path.isAbsolute(location)) return path.normalize(location)
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd, location) : null
}

const candidates = location => {
  const real = realExisting(location)
  return real === location ? [location] : [location, real]
}

function isPersistence(location, home) {
  const rel = relFolded(location, home)
  if (rel === null) return false
  return PERSISTENCE_FILES.includes(rel) || PERSISTENCE_DIRS.some(dir => rel === dir || rel.startsWith(`${dir}/`))
    || rel.startsWith(LAUNCH_AGENT_PREFIX)
}

function isSensitive(location, home) {
  const base = fold(path.basename(location))
  if (base === '.env' || base.startsWith('.env.') || base === '.envrc' || base.endsWith('.pem')) return true
  if (base.startsWith('id_') && !base.endsWith('.pub')) return true
  const rel = relFolded(location, home)
  if (rel === null) return false
  if (['.netrc', '.claude/.credentials.json', '.git-credentials', '.npmrc', '.pypirc', '.docker/config.json', '.kube/config'].includes(rel)) return true
  return ['.ssh', '.gnupg', '.aws', '.config/gh', '.config/gcloud', '.password-store', '.local/share/keyrings'].some(dir => rel === dir || rel.startsWith(`${dir}/`))
}

// The plain file names of the list, folded (the patterns are matched below).
const EXECUTION_CONFIG_NAMES = Object.freeze(EXECUTION_CONFIG.filter(name => !/[*/]/.test(name)).map(name => name.toLowerCase()))
function isExecutionConfig(rel) {
  const parts = fold(rel).split('/')
  const base = parts.at(-1)
  if (EXECUTION_CONFIG_NAMES.includes(base) || base.startsWith('.yarnrc')) return true
  if (parts.at(-2) === '.cargo' && base.startsWith('config')) return true
  const dirs = parts.slice(0, -1)
  return dirs.some((part, k) => ['.husky', '.githooks'].includes(part)
    || (part === '.github' && dirs[k + 1] === 'workflows')
    || (part === '.claude' && ['commands', 'agents', 'skills'].includes(dirs[k + 1])))
}

const isClaudeSettingsPath = location => {
  const folded = fold(location)
  return path.basename(folded) === '.mcp.json' || /(?:^|\/)\.claude\/settings[^/]*\.json$/.test(folded) || /(?:^|\/)\.claude\/hooks(?:\/|$)/.test(folded)
}
const isGitInternal = location => fold(location).split('/').includes('.git')

// Repo scope (07-approvals 3.5, F10): the repo root and its worktrees, by realpath; a worktree
// under `$HOME/.*` or a persistence location is not repo scope.
// With `lexical`, each root is returned as given (normalized) and by realpath, for the D-88 checks
// that walk a path's components from the root down.
function repoScope(repoRoot, worktrees, home, lexical = false) {
  const roots = []
  if (typeof repoRoot === 'string' && path.isAbsolute(repoRoot)) roots.push(realExisting(repoRoot), ...(lexical ? [path.normalize(repoRoot)] : []))
  for (const tree of Array.isArray(worktrees) ? worktrees : []) {
    if (typeof tree !== 'string' || !path.isAbsolute(tree)) continue
    const real = realExisting(tree)
    const rel = home ? path.relative(home, real) : '..'
    const hidden = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.startsWith('.')
    if (hidden || isPersistence(real, home) || (home && isPersistence(path.resolve(tree), home))) continue
    roots.push(real, ...(lexical ? [path.normalize(tree)] : []))
  }
  return lexical ? [...new Set(roots)] : roots
}

function scopeRelative(location, scope) {
  const real = realExisting(location)
  for (const root of scope) {
    if (!within(real, root)) continue
    const rel = path.relative(root, real)
    if (isGitInternal(rel)) return null
    return rel
  }
  return null
}

// On win32 the defaults are the win32 layout (setupPaths with `platform: 'win32'`, from the home as
// given), and every path is compared in its Git Bash form.
function deckControls(deckPaths, home, platform) {
  const env = { ...process.env, ...(home ? { HOME: home } : {}) }
  const defaults = setupPaths(env, { platform })
  const given = deckPaths ?? {}
  const config = given.config ?? defaults.config
  const state = given.state ?? defaults.state
  const runtime = given.runtime === undefined ? defaults.runtime : given.runtime
  const dirs = [config, state, runtime, given.token].map(dir => inputPath(dir, platform)).filter(Boolean)
  const all = new Set(dirs)
  for (const dir of dirs) all.add(realExisting(dir))
  const port = String(given.port ?? process.env.DECK_PORT ?? 47800)
  return { dirs: [...all], port }
}

// Read scope (07-approvals 3.5): a path is inside the repo when its realpath (or its nearest
// existing ancestor's) lies under the repo root or a worktree. Reads inside `.git` count as inside.
const inScope = (location, ctx) => {
  const real = realExisting(location)
  return ctx.scope.some(root => within(real, root))
}
// A word that reads as a path: absolute, home-relative, dot-relative, or holding a slash.
const syntaxPath = word => word.startsWith('/') || word.startsWith('~') || word === '.' || word === '..' || word.startsWith('./') || word.startsWith('../') || word.includes('/')
const expandHome = (word, ctx) => (word === '~' || word.startsWith('~/')) && ctx.home ? path.join(ctx.home, word.slice(1)) : word
// The sensitive-list locations under the home directory (07-approvals 3.5), for the ancestor check
// of commands that read a whole directory.
const HOME_SENSITIVE = Object.freeze(['.ssh', '.gnupg', '.aws', '.config/gh', '.netrc', '.claude/.credentials.json', '.git-credentials', '.npmrc', '.pypirc', '.docker/config.json', '.kube/config', '.config/gcloud', '.password-store', '.local/share/keyrings'])
const holdsSecret = (location, ctx) => candidates(location).some(candidate => isSensitive(candidate, ctx.home) || (ctx.home && HOME_SENSITIVE.some(rel => withinFolded(path.join(ctx.home, rel), candidate))))
const namesControl = (location, ctx) => candidates(location).some(candidate => ctx.deck.dirs.some(dir => withinFolded(candidate, dir)))
const ancestorOfControl = (location, ctx) => candidates(location).some(candidate => ctx.deck.dirs.some(dir => withinFolded(dir, candidate) || withinFolded(candidate, dir)))
const LOOPBACK = /(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d+)/i
const namesDeckPort = (text, ctx) => {
  const match = LOOPBACK.exec(text)
  return Boolean(match && match[1] === ctx.deck.port)
}

// D-88 (2): options that take a value, per command (git per subcommand). A value is never a path
// operand. `files` options name a file the command reads or writes, so their value is a path;
// `pattern` options supply the pattern or script, so the command then takes no pattern operand;
// `noPattern` options switch the pattern operand off (`rg --files`); `arity` is the number of value
// words when it is not one, and `fileIndex` which of them is the file. `single` commands spell long
// options with one dash and take no bundles (find, go).
// Only an option that takes its value from the next word belongs in `values`: one whose value is
// attached only (git `--abbrev[=<n>]`) or a boolean flag would hide the next word, a path, from the
// path rule. The entries were checked on the test host against git 2.55 (each run with a pathspec
// after it), GNU coreutils, grep, sed, diff and file `--help`, ripgrep, fd, jq 1.8.2, cargo 1.98
// and pytest `--help`, and the docker CLI's per-subcommand help. Tools not installed there (go,
// staticcheck, tree, yq, mypy, black, ruff, pytest plugins) have no values listed, so the word after
// any of their options stays an operand the path rule checks, except go's -run, -bench, -skip and
// -list (D-92 (e)), taken from `go help testflag` and not run.
const spec = (values, extra = {}) => ({ values: new Set(values), files: new Set(extra.files ?? []), pattern: new Set(extra.pattern ?? []), noPattern: new Set(extra.noPattern ?? []), arity: { __proto__: null, ...extra.arity }, fileIndex: { __proto__: null, ...extra.fileIndex }, single: extra.single === true })
const GIT_HISTORY_VALUES = ['-n', '-L', '-S', '-G', '-O', '--max-count', '--skip', '--author', '--committer', '--grep', '--since', '--until', '--after', '--before', '--output', '--diff-filter', '--format', '--date']
const CARGO_VALUES = ['-p', '-F', '-j', '-Z', '-m', '--package', '--features', '--bin', '--example', '--test', '--bench', '--exclude', '--jobs', '--target', '--target-dir', '--manifest-path', '--artifact-dir', '--profile', '--message-format', '--color', '--config']
const CARGO_FILES = ['--target-dir', '-m', '--manifest-path', '--artifact-dir']
const VALUE_OPTIONS = Object.freeze({
  __proto__: null,
  grep: spec(['-e', '-f', '-A', '-B', '-C', '-m', '-d', '-D', '--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--label', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--binary-files', '--devices', '--directories', '--group-separator'], { files: ['-f', '--file', '--exclude-from'], pattern: ['-e', '-f', '--regexp', '--file'] }),
  rg: spec(['-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-M', '-j', '-r', '-E', '-d', '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--after-context', '--before-context', '--context', '--max-count', '--max-columns', '--threads', '--replace', '--encoding', '--max-depth', '--max-filesize', '--ignore-file', '--sort', '--sortr', '--color', '--colors', '--type-add', '--type-clear', '--pre', '--pre-glob', '--path-separator', '--context-separator', '--field-match-separator', '--field-context-separator', '--engine', '--dfa-size-limit', '--regex-size-limit', '--hyperlink-format', '--generate'], { files: ['-f', '--file', '--ignore-file'], pattern: ['-e', '-f', '--regexp', '--file'], noPattern: ['--files', '--type-list'] }),
  fd: spec(['-e', '-t', '-d', '-E', '-S', '-o', '-j', '-x', '-X', '--extension', '--type', '--max-depth', '--min-depth', '--exact-depth', '--exclude', '--size', '--owner', '--threads', '--changed-within', '--changed-before', '--base-directory', '--search-path', '--ignore-file', '--path-separator', '--format', '--and', '--color', '--batch-size', '--max-results'], { files: ['--base-directory', '--search-path', '--ignore-file'] }),
  'git grep': spec(['-e', '-f', '-A', '-B', '-C', '-m', '--max-count', '--context', '--after-context', '--before-context', '--threads', '--max-depth'], { files: ['-f'], pattern: ['-e', '-f'] }),
  sed: spec(['-e', '-f', '-l', '--expression', '--file', '--line-length'], { files: ['-f', '--file'], pattern: ['-e', '-f', '--expression', '--file'] }),
  // jq 1.8.2: -f is a flag, and the filter file is then the first operand (`jq -f -c f.jq d.json`).
  jq: spec(['--arg', '--argjson', '--slurpfile', '--rawfile', '--indent', '-L'], { files: ['--slurpfile', '--rawfile', '-L'], pattern: ['-f', '--from-file'], arity: { '--arg': 2, '--argjson': 2, '--slurpfile': 2, '--rawfile': 2 }, fileIndex: { '--slurpfile': 2, '--rawfile': 2 } }),
  yq: spec([], { pattern: ['--from-file'] }),
  head: spec(['-n', '-c', '--lines', '--bytes']),
  tail: spec(['-n', '-c', '-s', '--lines', '--bytes', '--sleep-interval', '--pid']),
  cut: spec(['-d', '-f', '-c', '-b', '--delimiter', '--fields', '--characters', '--bytes', '--output-delimiter']),
  sort: spec(['-k', '-t', '-o', '-S', '-T', '--key', '--field-separator', '--output', '--buffer-size', '--temporary-directory', '--files0-from', '--batch-size', '--parallel', '--compress-program', '--random-source'], { files: ['-o', '--output', '-T', '--temporary-directory', '--files0-from', '--random-source'] }),
  uniq: spec(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars']),
  tree: spec([]),
  stat: spec(['-c', '--format', '--printf']),
  du: spec(['-d', '-B', '-t', '-X', '--max-depth', '--block-size', '--threshold', '--exclude', '--exclude-from', '--files0-from', '--time-style'], { files: ['-X', '--exclude-from', '--files0-from'] }),
  df: spec(['-x', '-t', '-B', '--type', '--exclude-type', '--block-size']),
  diff: spec(['-U', '-x', '-X', '-I', '-S', '-L', '-F', '-C', '-W', '--label', '--exclude', '--exclude-from', '--ignore-matching-lines', '--starting-file', '--from-file', '--to-file', '--line-format', '--horizon-lines', '--width', '--show-function-line', '--tabsize'], { files: ['-X', '--exclude-from', '--from-file', '--to-file'] }),
  cmp: spec(['-i', '-n', '--ignore-initial', '--bytes']),
  file: spec(['-m', '-f', '-F', '-e', '-P', '--magic-file', '--files-from', '--separator', '--exclude', '--parameter'], { files: ['-m', '-f', '--magic-file', '--files-from'] }),
  ls: spec(['-I', '-w', '-T', '--ignore', '--hide', '--width', '--tabsize', '--sort', '--format', '--time-style', '--block-size', '--quoting-style', '--indicator-style']),
  wc: spec(['--files0-from'], { files: ['--files0-from'] }),
  date: spec(['-d', '-f', '-r', '-s', '--date', '--file', '--reference', '--set'], { files: ['-f', '-r', '--file', '--reference'] }),
  'git commit': spec(['-m', '-F', '-t', '-c', '-C', '--message', '--file', '--template', '--reuse-message', '--reedit-message', '--author', '--date', '--fixup', '--squash', '--cleanup', '--trailer'], { files: ['-F', '--file', '-t', '--template'] }),
  'git log': spec(GIT_HISTORY_VALUES, { files: ['--output', '-O'] }),
  'git show': spec(GIT_HISTORY_VALUES, { files: ['--output', '-O'] }),
  'git diff': spec(GIT_HISTORY_VALUES, { files: ['--output', '-O'] }),
  'git blame': spec(['-L', '-S', '--contents', '--date', '--ignore-rev', '--ignore-revs-file'], { files: ['-S', '--contents', '--ignore-revs-file'] }),
  'git branch': spec(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '-u', '--set-upstream-to']),
  'git stash': spec(['-n', '--max-count', '--format', '--date']),
  'git add': spec(['--chmod', '--pathspec-from-file'], { files: ['--pathspec-from-file'] }),
  'git ls-files': spec(['-x', '-X', '--exclude', '--exclude-from', '--exclude-per-directory', '--format', '--with-tree'], { files: ['-X', '--exclude-from'] }),
  cargo: spec(CARGO_VALUES, { files: CARGO_FILES }),
  // D-92 (e): go test's -run, -bench, -skip and -list take a regular expression (`go help testflag`).
  go: spec(['-run', '-bench', '-skip', '-list'], { single: true, pattern: ['-run', '-bench', '-skip', '-list'] }),
  gofmt: spec([]),
  staticcheck: spec([], { single: true }),
  // -n (pytest-xdist) and --cov-config (pytest-cov) are plugin options not installed on the test host.
  pytest: spec(['-k', '-m', '-p', '-c', '-o', '-W', '--basetemp', '--rootdir', '--confcutdir', '--deselect', '--ignore', '--ignore-glob', '--junitxml', '--log-file'], { files: ['-c', '--basetemp', '--rootdir', '--confcutdir', '--deselect', '--ignore', '--junitxml', '--log-file'] }),
  mypy: spec([]),
  black: spec([]),
  ruff: spec([]),
  // docker by subcommand: -f is --follow, a flag, for logs, and a value elsewhere.
  'docker ps': spec(['-f', '-n', '--filter', '--format', '--last']),
  'docker images': spec(['-f', '--filter', '--format']),
  'docker logs': spec(['-n', '--tail', '--since', '--until']),
  'docker inspect': spec(['-f', '--format', '--type']),
  'docker version': spec(['-f', '--format']),
  'docker info': spec(['-f', '--format']),
  'docker compose ps': spec(['--filter', '--format', '--status']),
  'docker compose logs': spec(['-n', '--tail', '--since', '--until', '--index'])
})

// The modelled spec for a command, by its longest listed command words (git and docker by
// subcommand), or null.
const ownSpec = key => Object.hasOwn(VALUE_OPTIONS, key) ? VALUE_OPTIONS[key] : undefined
const valueSpec = (name, list) => ownSpec([name, list[1], list[2]].join(' ')) ?? ownSpec([name, list[1]].join(' ')) ?? ownSpec(name) ?? null

// Split a command's arguments (after its command words) into operands and option values by its
// value-option spec. Words after `--` are operands. A value of an option the spec does not know is
// returned with `modelled: false`, and only attached values (`--x=V`, `-xV`) can be one.
function splitArgs(words, valueSpecOf) {
  const out = { operands: [], values: [], patternGiven: false, noPattern: false }
  const known = valueSpecOf ?? spec([])
  const value = (word, option, index = 1) => out.values.push({ word, option, modelled: true, file: known.files.has(option) && (known.fileIndex[option] ?? 1) === index })
  for (let k = 0, options = true; k < words.length; k++) {
    const word = words[k]
    if (options && word === '--') { options = false; continue }
    if (!options || word === '-' || !word.startsWith('-')) { out.operands.push(word); continue }
    if (word.startsWith('--') || known.single) {
      const equal = word.indexOf('=')
      const name = equal > 0 ? word.slice(0, equal) : word
      const option = known.single && name.startsWith('--') ? name.slice(1) : name
      if (known.pattern.has(option)) out.patternGiven = true
      if (known.noPattern.has(option)) out.noPattern = true
      if (equal > 0) {
        if (known.values.has(option)) value(word.slice(equal + 1), option)
        else out.values.push({ word: word.slice(equal + 1), option, modelled: false, file: false })
        continue
      }
      if (!known.values.has(option)) continue
      const arity = known.arity[option] ?? 1
      for (let j = 1; j <= arity && k + 1 < words.length; j++) value(words[++k], option, j)
      continue
    }
    let consumed = false
    for (let c = 1; c < word.length; c++) {
      const flag = `-${word[c]}`
      if (known.pattern.has(flag)) out.patternGiven = true
      if (!known.values.has(flag)) continue
      consumed = true
      if (c + 1 < word.length) value(word.slice(c + 1), flag)
      else if (k + 1 < words.length) value(words[++k], flag)
      break
    }
    if (!consumed && word.length > 2) out.values.push({ word: word.slice(2), option: word.slice(0, 2), modelled: false, file: false })
  }
  return out
}

// find(1): leading -H -L -P -D -O options, then the start points, then the expression. Values of
// the predicates are not paths, except the files -newer, -samefile and the -fprint family name.
const FIND_VALUE = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-type', '-xtype', '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-regex', '-iregex', '-perm', '-user', '-group', '-uid', '-gid', '-links', '-inum', '-regextype', '-printf', '-fstype', '-lname', '-ilname', '-used', '-context', '-files0-from'])
const FIND_FILE = new Set(['-newer', '-anewer', '-cnewer', '-samefile', '-fprint', '-fprint0', '-fls', '-files0-from'])
function splitFind(words) {
  const out = { operands: [], values: [], patternGiven: false, noPattern: true, follows: false }
  let k = 0
  for (; k < words.length; k++) {
    const word = words[k]
    if (['-H', '-L'].includes(word)) { out.follows = true; continue }
    if (word === '-P' || /^-O\d*$/.test(word)) continue
    if (word === '-D') { k++; continue }
    break
  }
  for (; k < words.length && !words[k].startsWith('-') && !['(', ')', '!', ','].includes(words[k]); k++) out.operands.push(words[k])
  for (; k < words.length; k++) {
    const word = words[k]
    if (word === '-follow') out.follows = true
    if (word === '-fprintf') { out.values.push({ word: words[k + 1], option: word, modelled: true, file: true }); k += 2; continue }
    if (/^-newer[acmB][acmBt]$/.test(word)) { out.values.push({ word: words[k + 1], option: word, modelled: true, file: !word.endsWith('t') }); k++; continue }
    if (FIND_FILE.has(word) || FIND_VALUE.has(word)) { out.values.push({ word: words[k + 1], option: word, modelled: true, file: FIND_FILE.has(word) }); k++ }
  }
  return out
}

// The arguments of a segment split for the path rules: the command's own spec, find's grammar.
const segmentArgs = (name, list, words) => name === 'find' ? splitFind(words) : splitArgs(words, valueSpec(name, list))

// Whether something exists at `location` without following a final symlink.
const lexists = location => { try { lstatSync(location); return true } catch { return false } }

// D-88 (1): a location is bare when it lies lexically under a repo scope root and no component
// below that root is a symlink. Returns null, 'outside' or 'symlink' (a component that cannot be
// checked counts as a symlink).
function bareCheck(location, ctx) {
  const root = ctx.lexicalRoots.filter(dir => within(location, dir)).sort((a, b) => b.length - a.length)[0]
  if (!root) return 'outside'
  const rel = path.relative(root, location)
  let current = root
  for (const part of rel ? rel.split('/') : []) {
    current = path.join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? null : 'symlink' }
    if (stat.isSymbolicLink()) return 'symlink'
  }
  return null
}

const BARE_REASONS = Object.freeze({
  __proto__: null,
  cwd: ['scope.cwd', 'runs in a directory outside the repo or reached through a symlink'],
  absolute: ['path.absolute', 'names an absolute or home path'],
  symlink: ['path.symlink', 'names a path through a symlink'],
  outside: ['scope.read-outside', 'reads outside the repo'],
  dotdot: ['path.dotdot', 'names a path that leaves a directory with ..']
})

// The D-88 (1) verdict on one word of a Safe candidate, resolved against `cwd`. A word that names
// nothing that exists and does not read as a path is text; so is a pattern operand that names
// nothing that exists.
function wordVerdict(word, cwd, ctx, pattern = false) {
  if (typeof word !== 'string' || word === '-' || DEV_NULLS.has(word)) return null
  if (word.startsWith('/') || word.startsWith('~')) {
    const location = expandHome(word, ctx)
    if (pattern && !lexists(location)) return null
    return inScope(location, ctx) ? 'absolute' : 'outside'
  }
  const location = path.resolve(cwd, word)
  if (!lexists(location) && (pattern || !syntaxPath(word))) return null
  const parts = word.split('/')
  if (parts.some((part, k) => part === '..' && parts.slice(0, k).some(before => before !== '..' && before !== '.' && before !== ''))) return 'dotdot'
  return bareCheck(location, ctx)
}

// D-88 (3): recursive readers that follow symlinks, by the spellings each documents.
function followsSymlinks(name, words) {
  const short = flags => words.some(word => new RegExp(`^-[^-]*[${flags}]`).test(word))
  const long = (...options) => words.some(word => options.some(option => word.length > 3 && option.startsWith(word.split('=')[0])))
  if (name === 'grep') return short('R') || long('--dereference-recursive')
  if (name === 'rg') return short('L') || long('--follow')
  if (name === 'find') return splitFind(words.slice(1)).follows
  if (name === 'diff') return short('r') || long('--recursive')
  if (name === 'tree') return short('l')
  if (name === 'du') return short('LD') || long('--dereference', '--dereference-args')
  if (name === 'cp') return short('LH') || long('--dereference')
  if (name === 'tar') return short('h') || /^[^-]*h/.test(words[1] ?? '') || long('--dereference')
  if (name === 'ls') return (short('L') || long('--dereference')) && (short('R') || long('--recursive'))
  if (name === 'rsync') return short('LkK') || long('--copy-links', '--copy-dirlinks', '--keep-dirlinks')
  return false
}

// Whether the `.git` directory `marker` holds HEAD as a file or a symlink (dangling or not).
function headMarks(marker) {
  try {
    const head = lstatSync(path.join(marker, 'HEAD'))
    return head.isFile() || head.isSymbolicLink()
  } catch { return false }
}

// Whether `dir` holds a repository marker: a `.git` directory with a `HEAD` file or symlink, or a `.git`
// file that starts with `gitdir:`. An empty `.git` directory (one a sandbox mounts, say) is not one.
function hasGitMarker(dir) {
  const marker = path.join(dir, '.git')
  try {
    const stat = statSync(marker)
    if (stat.isDirectory()) return headMarks(marker)
    return stat.isFile() && stat.size <= 4096 && readFileSync(marker, 'utf8').startsWith('gitdir:')
  } catch { return false }
}

// Whether `dir` lies in a git work tree: an ancestor holds a repository marker, and `dir` is not inside `.git`.
function inGitWorkTree(dir) {
  if (typeof dir !== 'string' || isGitInternal(dir)) return false
  for (let current = dir; ; current = path.dirname(current)) {
    if (hasGitMarker(current)) return true
    if (path.dirname(current) === current) return false
  }
}

const isDirectory = location => { try { return statSync(location).isDirectory() } catch { return false } }

// jq and yq filters that read the environment or a file (jq `env`, `$ENV`, `import`, `include`;
// yq `env`, `strenv`, `envsubst`, `load*`, `eval`).
const FILTER_READS = Object.freeze({
  __proto__: null,
  jq: /\$ENV\b|\b(?:env|import|include|modulemeta|get_search_list)\b/,
  yq: /\b(?:env|strenv|envsubst|load\w*|eval\w*)\b/
})

function context(input, platform) {
  const win = platform === 'win32'
  const given = [input.homeDir, process.env.HOME, ...(win ? [process.env.USERPROFILE] : []), os.homedir()].find(dir => inputPath(dir, platform) !== null) ?? null
  const home = inputPath(given, platform)
  const repoRoot = win ? inputPath(input.repoRoot, platform) : input.repoRoot
  const worktrees = win && Array.isArray(input.worktrees) ? input.worktrees.map(tree => inputPath(tree, platform)) : input.worktrees
  return {
    home,
    cwd: inputPath(input.cwd, platform),
    deck: deckControls(input.deckPaths, win ? given : home, platform),
    scope: repoScope(repoRoot, worktrees, home),
    lexicalRoots: repoScope(repoRoot, worktrees, home, true)
  }
}

const reason = (entryId, tier, segment, description) => ({ entryId, tier, segment, description })

// The verdict on one write target: a floor, "writes outside the repo", or null inside the scope.
function writeVerdict(location, ctx, segment) {
  if (location === null) return reason('scope.outside', 'caution', segment, 'writes outside the repo')
  location = hostForm(location)
  if (DEV_NULLS.has(location)) return null
  const paths = candidates(location)
  if (paths.some(candidate => ctx.deck.dirs.some(dir => withinFolded(candidate, dir)))) return reason('floor.deck', 'destructive', segment, 'writes the deck\'s own files')
  const inside = scopeRelative(location, ctx.scope)
  if (paths.some(isClaudeSettingsPath) || (fold(path.basename(location)) === 'claude.md' && inside === null)) return reason('floor.claude-settings', 'destructive', segment, 'changes Claude Code settings or hooks')
  if (paths.some(isGitInternal) || inGitDirTarget(location, ctx)) return reason('floor.git-dir', 'destructive', segment, 'writes inside .git')
  if (paths.some(candidate => isPersistence(candidate, ctx.home))) return reason('floor.persistence', 'destructive', segment, 'runs at the next login or shell start')
  if (inside === null) return reason('scope.outside', 'caution', segment, 'writes outside the repo')
  // D-88 (6): a Bash write to the execution-config list is Caution, as an Edit or Write is.
  return configVerdict(location, ctx, segment)
}

// D-90 (c): a file whose name ends in .toml, .ini or .cfg, or starts with a dot, at the repo root
// or inside a directory whose name starts with a dot. `rel` is relative to the repo scope root.
function isConfigName(rel) {
  const parts = fold(rel).split('/')
  const base = parts.at(-1)
  if (!/\.(?:toml|ini|cfg)$/.test(base) && !base.startsWith('.')) return false
  const dirs = parts.slice(0, -1)
  return dirs.length === 0 || dirs.some(part => part.startsWith('.'))
}

// The execution-config (D-88 (6), D-89 (1)) and configuration-name (D-90 (c)) verdict on a write
// target inside the repo. D-90 (b): both checks run on the path as named and on its realpath, each
// relative to the repo scope roots it lies under (the configuration-name check uses the deepest
// one, so a worktree under `.claude/worktrees` is judged from its own root).
function configVerdict(location, ctx, segment) {
  for (const candidate of candidates(location)) {
    const roots = ctx.lexicalRoots.filter(root => within(candidate, root) && candidate !== root).sort((a, b) => b.length - a.length)
    if (roots.some(root => isExecutionConfig(path.relative(root, candidate)))) return reason('file.execution-config', 'caution', segment, 'changes what a build, test or hook runs')
    if (roots.length && isConfigName(path.relative(roots[0], candidate))) return reason('file.config-name', 'caution', segment, 'changes a configuration file at the repo root or in a dot directory')
  }
  // D-91 (3): the real target of a linked execution-config entry, or the core.hooksPath directory,
  // compared folded (D-92 (c)); D-92 (a): any path in a repo whose hooksPath read is not current.
  const real = realExisting(location)
  if (protectedTargets(ctx).some(target => withinFolded(real, target)) || underUnsettledRepo(location, ctx)) return reason('file.execution-config', 'caution', segment, 'changes what a build, test or hook runs')
  return null
}

// D-91 (3): the root-anchored names of the execution-config list and of the floors, which a repo
// may hold as symlinks into ordinary directories, and the directories whose entries are matched by
// name (`.yarnrc*` at the root, `.cargo/config*`, `.claude/settings*.json`).
const LINKED_NAMES = Object.freeze([...EXECUTION_CONFIG.filter(name => !/[*/]/.test(name)), '.cargo', '.husky', '.githooks', '.github', '.github/workflows', '.claude', '.claude/commands', '.claude/agents', '.claude/skills', '.claude/hooks', '.mcp.json', '.git'])
const LINKED_PATTERNS = Object.freeze([['', /^\.yarnrc/], ['.cargo', /^config/], ['.claude', /^settings.*\.json$/]])
const isLink = location => { try { return lstatSync(location).isSymbolicLink() } catch { return false } }
const statKey = location => {
  try {
    const stat = statSync(location, { bigint: true })
    // Darwin updates null-device timestamps on I/O; those writes never change its empty config.
    if (location === '/dev/null' && stat.isCharacterDevice()) return `${stat.dev}:${stat.ino}:${stat.rdev}:${stat.mode}:null`
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`
  } catch { return '-' }
}

// The git work tree top level at or above `dir`, with its git dir and common dir. A `.git`
// directory counts only when it holds `HEAD`, as in hasGitMarker.
function gitDirs(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    const dotgit = path.join(current, '.git')
    let gitdir = null
    try {
      if (statSync(dotgit).isDirectory()) { if (headMarks(dotgit)) gitdir = dotgit }
      else {
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, 'utf8'))
        if (match) gitdir = path.resolve(current, match[1])
      }
    } catch {}
    if (gitdir) {
      let common = gitdir
      try { common = path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()) } catch {}
      return { top: current, gitdir, common }
    }
    if (path.dirname(current) === current) return null
  }
}

// D-92 (a): core.hooksPath as git itself reads it, per work tree top and home directory, through
// the read-only helper's HOOKS_PATH_READS:
// 1. `git config --type=path --get-all core.hooksPath` gives the values git applies now, with
//    includes, includeIf conditions, `~/` and `:(optional)` resolved by git (which drops an
//    optional value whose path does not exist yet).
// 2. `git config --null --show-origin --get-regexp` over core.hookspath and the include and
//    includeIf path keys gives every raw value git reads now with the file it came from.
// 3. `git config --file <file> --null --get-regexp` over the same keys, for every include or
//    includeIf target named anywhere (whether or not its condition holds now, and recursively, up
//    to HOOKS_PATH_FILE_LIMIT files), gives the raw values git would read from it once its
//    condition holds.
// Every raw hooksPath value is protected (`:(optional)` and `~/` applied by hand, taken from the
// work tree top when relative), and every include target (taken from its including file's
// directory, as git does) is protected and keyed. The values the environment sets (the
// hooksPathEnvironment variables, shown with a "command line" origin) count too. The helper's own
// `-c core.hooksPath=/dev/null` comes back as the last value of read 1 and as a "command line"
// `/dev/null` in read 2; both are dropped.
//
// The key is the stats of the repo, global and system config files and of every file a read named
// as a source or include target, and the config environment. HEAD is not keyed: an includeIf
// onbranch target is followed whatever the branch, so a branch switch changes nothing protected.
// The classifier is synchronous, so the reads are asynchronous: a classification starts them when
// a repo is first seen and whenever the key differs from the one the last completed read started
// under. A read holds only for the key it started under, so it is not current when a file of that
// key changed while it ran, or when it named a file that key did not hold (whose state before the
// read is unknown); a confirming read then starts at once. States:
// - `ready`: the last confirmed read holds for the current key.
// - `changed`: any other state. No read has landed yet (the first classification in a repo since
//   the server started), a read landed but does not hold for the current key (a config source was
//   written, the read was not confirmed), a read failed (the first one included), or read 3
//   stopped at HOOKS_PATH_FILE_LIMIT. Every value and include target found so far stays
//   protected, and so does every write in the repo, since the hooks directory may have any name.
//   A failed or stopped read is retried after HOOKS_PATH_RETRY_MS.
const HOOKS_PATH_RETRY_MS = 2000
const HOOKS_PATH_CONFIRM_ROUNDS = 3
const HOOKS_PATH_FILE_LIMIT = 64
const HOOKS_PATH_LIMIT = 512
const hooksPathEntries = new Map()

// The files whose stats make up the key, beside the sources a read named.
function hooksPathBaseFiles(dirs, home) {
  const xdg = process.env.XDG_CONFIG_HOME
  const files = [path.join(dirs.common, 'config'), path.join(dirs.gitdir, 'config.worktree'), '/etc/gitconfig']
  if (home) files.push(path.join(home, '.gitconfig'), path.join(home, '.config', 'git', 'config'))
  if (xdg && path.isAbsolute(xdg)) files.push(path.join(xdg, 'git', 'config'))
  for (const name of HOOKS_PATH_ENV) if (process.env[name] && path.isAbsolute(process.env[name])) files.push(process.env[name])
  return files
}

function hooksPathKey(dirs, home, sources) {
  const files = [...new Set([...hooksPathBaseFiles(dirs, home), ...sources])]
  const environment = [process.env.XDG_CONFIG_HOME ?? '', JSON.stringify(Object.entries(hooksPathEnvironment()).sort())]
  return [...environment, ...files.map(file => `${file}=${statKey(file)}`)].join('|')
}

// One raw config value with `:(optional)` and `~/` applied, as git applies them to a path.
function expandRaw(value, home) {
  const text = value.startsWith(':(optional)') ? value.slice(':(optional)'.length) : value
  return (text === '~' || text.startsWith('~/')) && home ? path.join(home, text.slice(1)) : text
}

// The `key\nvalue` entries of a `--null --get-regexp` output into `out`: hooksPath values taken from
// the work tree top, include targets from the directory of `file`. False when the shape is wrong.
function collectRaw(entries, file, top, home, out) {
  for (const entry of entries) {
    const newline = entry.indexOf('\n')
    if (newline < 0) return false
    const value = expandRaw(entry.slice(newline + 1), home)
    if (!value) continue
    if (entry.slice(0, newline) === 'core.hookspath') out.hooks.push(path.isAbsolute(value) ? path.normalize(value) : path.resolve(top, value))
    else out.includes.push(path.isAbsolute(value) ? path.normalize(value) : path.resolve(path.dirname(file), value))
  }
  return true
}

// Read 2: every file git named as an origin, and the raw values, those of the environment ("command
// line" origins, taken from the work tree top) included, the helper's own `/dev/null` excepted. Null
// when the shape is wrong.
function parseConfigSources(stdout, top, home) {
  const parts = String(stdout).split('\0')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 2) return null
  const out = { hooks: [], includes: [], sources: [] }
  for (let k = 0; k < parts.length; k += 2) {
    const fromFile = parts[k].startsWith('file:')
    if (!fromFile && parts[k + 1] === 'core.hookspath\n/dev/null') continue
    const file = fromFile ? path.resolve(top, parts[k].slice('file:'.length)) : path.join(top, 'command-line')
    if (fromFile) out.sources.push(file)
    if (!collectRaw([parts[k + 1]], file, top, home, out)) return null
  }
  return out
}

// Read 3, recursively: the raw values of every include target, whether or not git reads it now, into
// `raw`. A target that does not exist or that git cannot parse holds no values (git cannot apply it
// either); it stays keyed and protected. True when every target was read; false when the
// HOOKS_PATH_FILE_LIMIT stopped it, git could not run or printed an unexpected shape, with what was
// found so far kept in `raw`.
async function readIncludeTargets(dirs, home, raw) {
  const seen = new Set(raw.sources)
  const queue = raw.includes.filter(file => !seen.has(file))
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    if (seen.size >= HOOKS_PATH_FILE_LIMIT) return false
    seen.add(file)
    const result = await gitRead(dirs.top, hooksPathFileRead(file), { home })
    if (!result) return false
    if (result.code !== 0) continue
    const parts = String(result.stdout).split('\0')
    if (parts.at(-1) === '') parts.pop()
    const found = { hooks: [], includes: [] }
    if (!collectRaw(parts, file, dirs.top, home, found)) return false
    raw.hooks.push(...found.hooks)
    raw.includes.push(...found.includes)
    queue.push(...found.includes)
  }
  return true
}

function readHooksPath(entry, dirs, home, key, round = 0) {
  const [applied, sources] = HOOKS_PATH_READS
  entry.pending = Promise.all([gitRead(dirs.top, [...applied], { home }), gitRead(dirs.top, [...sources], { home })]).then(async ([first, second]) => {
    const lines = first?.code === 0 ? String(first.stdout).split('\n') : null
    if (lines?.at(-1) === '') lines.pop()
    const appliedOk = lines?.at(-1) === '/dev/null'
    if (appliedOk) lines.pop()
    // A relative core.hooksPath is taken from the top of the work tree (githooks(5)).
    const values = appliedOk ? lines.filter(Boolean).map(value => path.isAbsolute(value) ? path.normalize(value) : path.resolve(dirs.top, value)) : []
    const raw = second?.code === 0 ? parseConfigSources(second.stdout, dirs.top, home) : null
    const complete = appliedOk && raw !== null && await readIncludeTargets(dirs, home, raw)
    entry.pending = null
    // Whatever was found is kept and protected, a failed or stopped read included.
    entry.hooks = [...new Set([...(complete ? [] : entry.hooks ?? []), ...values, ...(raw?.hooks ?? [])])]
    entry.includes = [...new Set([...(complete ? [] : entry.includes), ...(raw?.includes ?? [])])]
    entry.sources = [...new Set([...(complete ? [] : entry.sources), ...(raw?.sources ?? []), ...(raw?.includes ?? [])])]
    const now = hooksPathKey(dirs, home, entry.sources)
    if (!complete) {
      // Never current: the repo reads as changed until a read completes.
      entry.doneKey = null
      entry.failedKey = now
      entry.failedAt = Date.now()
      return
    }
    // The read holds for the key it started under. That key stops matching when a file of it
    // changed during the read, and when the read named a file it did not hold (whose state before
    // the read is unknown); a confirming read then starts at once.
    entry.doneKey = key
    if (now !== key && round + 1 < HOOKS_PATH_CONFIRM_ROUNDS) readHooksPath(entry, dirs, home, now, round + 1)
  })
}

// The hooksPath state of the repo holding `root` (see above). A directory outside any git work tree
// has no hooksPath and is ready at once.
function hooksPathState(root, home) {
  const dirs = gitDirs(root)
  if (!dirs) return { ready: true, changed: false, hooks: [], includes: [], pending: null, failed: false }
  const id = `${dirs.top}\u0000${home ?? ''}`
  let entry = hooksPathEntries.get(id)
  if (!entry) {
    if (hooksPathEntries.size >= HOOKS_PATH_LIMIT) hooksPathEntries.delete(hooksPathEntries.keys().next().value)
    entry = { hooks: null, includes: [], sources: [], doneKey: null, failedKey: null, failedAt: 0, pending: null }
    hooksPathEntries.set(id, entry)
  }
  const key = hooksPathKey(dirs, home, entry.sources)
  const current = entry.hooks !== null && entry.doneKey === key
  // A failed or stopped read is retried at the next classification after HOOKS_PATH_RETRY_MS, so a
  // repo git cannot read does not start git at every classification.
  const failed = entry.failedKey === key && Date.now() - entry.failedAt < HOOKS_PATH_RETRY_MS
  if (!entry.pending && !current && !failed) readHooksPath(entry, dirs, home, key)
  return { ready: current, changed: !current, hooks: entry.hooks ?? [], includes: entry.includes, pending: entry.pending, failed }
}

/**
 * The per-repo core.hooksPath cache the classifier reads (D-92 (a)). `load` starts a read when one
 * is due and resolves the protected hooksPath values once a read for the current config is
 * confirmed, or the last values when the read failed; `next` starts a read when one is due and
 * resolves when that one read (not a confirming read it starts) has finished; `clear` forgets every
 * repo.
 */
export const hooksPathCache = Object.freeze({
  /**
   * @param {string} root a directory in the work tree
   * @param {string} home the home directory git reads the global config from
   * @returns {Promise<string[]>}
   */
  async load(root, home) {
    for (let round = 0; round < 10; round++) {
      const state = hooksPathState(root, home)
      if (state.ready || state.failed) return state.hooks
      await state.pending
    }
    return hooksPathState(root, home).hooks
  },
  /**
   * @param {string} root a directory in the work tree
   * @param {string} home the home directory git reads the global config from
   * @returns {Promise<void>}
   */
  async next(root, home) {
    await hooksPathState(root, home).pending
  },
  clear() { hooksPathEntries.clear() }
})

// Per repo root: the listed names found as symlinks, cached under a key built from the stats of
// the root and the directories searched by pattern, so a new link is seen at the next
// classification. The links are resolved at each call, so a link changed further along the path
// is seen too.
const protectedCache = new Map()
function protectedLinks(root) {
  const roots = [root, ...['.cargo', '.claude', '.github'].map(name => path.join(root, name))]
  const dirKey = roots.map((dir, k) => k === 0 ? (() => { try { const stat = lstatSync(dir, { bigint: true }); return `${stat.ino}:${stat.mtimeNs}` } catch { return '-' } })() : statKey(dir)).join('|')
  const cached = protectedCache.get(root)
  if (cached && cached.dirKey === dirKey) return cached.links
  const links = LINKED_NAMES.map(name => path.join(root, name)).filter(isLink)
  for (const [dir, pattern] of LINKED_PATTERNS) {
    let names = []
    try { names = readdirSync(path.join(root, dir)) } catch {}
    for (const name of names) if (pattern.test(name) && isLink(path.join(root, dir, name))) links.push(path.join(root, dir, name))
  }
  protectedCache.set(root, { dirKey, links })
  return links
}

// The real paths a write may not reach at Safe, for every repo scope root of a classification: the
// targets of linked entries, the core.hooksPath directories and the include targets of the git
// config. Also collects the roots whose hooksPath read is not current (`ctx.hooksChanged`), and D-92 (b) the git dir and
// common dir a `.git` file names when they lie inside a repo root (`ctx.gitDirTargets`), both as
// named and by realpath.
function protectedTargets(ctx) {
  if (!ctx.protectedTargets) {
    const targets = new Set()
    const changed = new Set()
    const gitTargets = new Set()
    const roots = [...new Set(ctx.lexicalRoots)]
    for (const root of roots) {
      const hooks = hooksPathState(root, ctx.home)
      if (hooks.changed) changed.add(root)
      for (const location of [...protectedLinks(root), ...hooks.hooks, ...hooks.includes]) targets.add(realExisting(location))
      const dirs = gitDirs(root)
      if (!dirs || dirs.gitdir === path.join(dirs.top, '.git')) continue
      for (const dir of [dirs.gitdir, dirs.common]) {
        for (const form of new Set([path.normalize(dir), realExisting(dir)])) if ([...roots, ...ctx.scope].some(base => withinFolded(form, base))) gitTargets.add(form)
      }
    }
    ctx.protectedTargets = [...targets]
    ctx.hooksChanged = [...changed]
    ctx.gitDirTargets = [...gitTargets]
  }
  return ctx.protectedTargets
}
function gitDirTargets(ctx) {
  protectedTargets(ctx)
  return ctx.gitDirTargets
}
const inGitDirTarget = (location, ctx) => candidates(location).some(candidate => gitDirTargets(ctx).some(dir => withinFolded(candidate, dir)))

// D-92 (a): while the hooksPath read of a repo is not current (none landed yet, or the config
// changed since), any path below its root may be in the hooks directory.
function underUnsettledRepo(location, ctx) {
  protectedTargets(ctx)
  return ctx.hooksChanged.some(root => candidates(location).some(candidate => relFolded(candidate, root) !== null))
}

// Glob matching for argument globs: `*` is any text, `?` one character, and `-<N>` a number option.
const globCache = new Map()
function argGlob(glob) {
  let compiled = globCache.get(glob)
  if (!compiled) {
    compiled = glob === '-<N>' ? /^-\d+$/ : new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    globCache.set(glob, compiled)
  }
  return compiled
}
const matchesAny = (globs, text) => Array.isArray(globs) && globs.some(glob => argGlob(glob).test(text))
const toolGlob = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')

// The forms an argument is matched in (07-approvals 3.3): itself, its `--opt` without `=value`,
// its normalised long option or every candidate of an ambiguous one, and a short bundle expanded.
function argVariants(arg, longOpts = []) {
  const out = [arg]
  if (arg.startsWith('--') && arg !== '--') {
    const equal = arg.indexOf('=')
    if (equal > 0) out.push(arg.slice(0, equal))
    const normalized = normalizeLongOption(arg, longOpts)
    for (const option of [normalized].flat()) {
      if (typeof option !== 'string') continue
      out.push(option)
      const at = option.indexOf('=')
      if (at > 0) out.push(option.slice(0, at))
    }
  } else if (/^-[^-]/.test(arg) && arg.length > 2) {
    for (const flag of arg.slice(1)) out.push(`-${flag}`)
  }
  return out
}
const anyVariant = (args, globs, longOpts) => args.some(arg => argVariants(arg, longOpts).some(variant => matchesAny(globs, variant)))

// Whether every option in `rest` is on the entry's allowOpts (or is one of its outputOpts). Words
// after `--` are operands. A short bundle is allowed when each letter is, and a number may follow
// an allowed letter as its value (`-A3`); entries with multi-letter single-dash options (`find
// -name`, `go -race`) take no bundles.
function disallowedOption(entry, rest) {
  if (!Array.isArray(entry.allowOpts)) return null
  const allow = entry.allowOpts
  const outputs = entry.outputOpts ?? []
  const bundles = !allow.some(option => /^-[A-Za-z]{2,}/.test(option) && !/^-(.)\1+$/.test(option))
  for (const arg of rest) {
    if (arg === '--') return null
    if (!arg.startsWith('-') || arg === '-') continue
    if (matchesAny(allow, arg)) continue
    // An output option is allowed in the spellings the parser resolves to a write target: the
    // option alone (its value is the next word), `--long=value`, and a two-letter `-oVALUE`. A
    // single-dash `-o=VALUE` is not one of them (the parser reads `=VALUE` as the path, while Go's
    // documented flag syntax reads VALUE), so it stays off the Safe list.
    if (outputs.some(option => arg === option || (option.startsWith('--') && arg.startsWith(`${option}=`)) || (option.length === 2 && arg.startsWith(option) && arg[2] !== '='))) continue
    if (bundles && !arg.startsWith('--') && arg.length > 2) {
      let ok = true
      for (let c = 1; c < arg.length; c++) {
        const flag = `-${arg[c]}`
        if (outputs.includes(flag)) { if (arg[c + 1] === '=') ok = false; break }
        if (!matchesAny(allow, flag)) { ok = false; break }
        if (/^\d+$/.test(arg.slice(c + 1))) break
      }
      if (ok) continue
    }
    return arg
  }
  return null
}

// sed's script rule (D-88 (4)): Safe only for a script this small parser reads in full, made of the
// commands p, d, = and q (with an exit code), each with optional line, step or regex addresses
// (`!` allowed), and s/// with flags limited to g, p, I and a number. Everything else, including
// labels, branches, a, i, c, y, braces, comments, the e, w, r, R, W commands and the e, w and m
// flags of s, is not Safe. GNU sed 4.10 (checked) reads a bracket expression in a regex as one item
// but not in a replacement, and lets blanks stand between s flags (`s/a/b/ w FILE` writes FILE).
// A bracket expression holding the delimiter, a newline or a backslash is refused, so a reader
// that does not know brackets ends the regex where this one does.
export function sedScriptSafe(script) {
  if (typeof script !== 'string') return false
  let i = 0
  const n = script.length
  const at = () => script[i]
  const skipBlank = () => { while (i < n && (at() === ' ' || at() === '\t')) i++ }
  const digits = () => { const start = i; while (i < n && /[0-9]/.test(at())) i++; return i > start }
  const bracket = delim => {
    i++
    if (at() === '^') i++
    if (at() === ']') i++
    while (i < n) {
      const c = script[i]
      if (c === '\n' || c === '\\' || c === delim) return false
      if (c === '[' && /[:.=]/.test(script[i + 1] ?? '')) {
        const close = script.indexOf(`${script[i + 1]}]`, i + 2)
        if (close < 0) return false
        const inner = script.slice(i, close + 2)
        if (inner.includes(delim) || inner.includes('\n') || inner.includes('\\')) return false
        i = close + 2
        continue
      }
      i++
      if (c === ']') return true
    }
    return false
  }
  // A regex after its opening delimiter, through the closing one.
  const regex = delim => {
    while (i < n) {
      const c = script[i]
      if (c === '\n') return false
      if (c === '\\') { if (i + 1 >= n || script[i + 1] === '\n') return false; i += 2; continue }
      if (c === delim) { i++; return true }
      if (c === '[') { if (!bracket(delim)) return false; continue }
      i++
    }
    return false
  }
  const badDelim = delim => !delim || '\n\\[]'.includes(delim)
  // true when an address was read, false when there is none, null when it cannot be read.
  const address = () => {
    const c = at()
    if (c !== undefined && /[0-9]/.test(c)) {
      digits()
      if (at() === '~') { i++; if (!digits()) return null }
      return true
    }
    if (c === '$') { i++; return true }
    if (c === '/' || c === '\\') {
      let delim = '/'
      if (c === '\\') { delim = script[i + 1]; if (badDelim(delim)) return null; i += 2 } else i++
      if (!regex(delim)) return null
      while (i < n && /[IM]/.test(at())) i++
      return true
    }
    return false
  }
  const substitute = () => {
    const delim = at()
    if (badDelim(delim)) return false
    i++
    if (!regex(delim)) return false
    let closed = false
    while (i < n) {
      const c = script[i]
      if (c === '\n') return false
      if (c === '\\') { if (i + 1 >= n || script[i + 1] === '\n') return false; i += 2; continue }
      i++
      if (c === delim) { closed = true; break }
    }
    if (!closed) return false
    for (;;) {
      skipBlank()
      const c = at()
      if (c === undefined || c === ';' || c === '\n') return true
      if (!/[gpI0-9]/.test(c)) return false
      i++
    }
  }
  for (;;) {
    while (i < n && /[ \t\n;]/.test(at())) i++
    if (i >= n) return true
    const first = address()
    if (first === null) return false
    if (first) {
      skipBlank()
      if (at() === ',') {
        i++
        skipBlank()
        if (at() === '+' || at() === '~') { i++; if (!digits()) return false }
        else if (address() !== true) return false
      }
    }
    skipBlank()
    while (at() === '!') { i++; skipBlank() }
    const command = at()
    i++
    if (command === 's') { if (!substitute()) return false }
    else if (command === 'q') { skipBlank(); digits() }
    else if (command !== 'p' && command !== 'd' && command !== '=') return false
    skipBlank()
    if (i < n && at() !== ';' && at() !== '\n') return false
  }
}

function sedScripts(rest) {
  const scripts = []
  let explicit = false
  const operands = []
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k]
    if (arg === '--') { operands.push(...rest.slice(k + 1)); break }
    if (arg.startsWith('--expression=')) { explicit = true; scripts.push(arg.slice(13)); continue }
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      const e = arg.indexOf('e', 1)
      if (e > 0) {
        explicit = true
        scripts.push(e < arg.length - 1 ? arg.slice(e + 1) : rest[++k])
      }
      continue
    }
    if (!arg.startsWith('-')) operands.push(arg)
  }
  if (!explicit) scripts.push(operands[0])
  return scripts
}

// The SQL a psql or sqlite3 segment runs: a list of statements, `null` for an interactive session,
// or 'unknown' when it comes from a file, a heredoc or a pipe the deck cannot read (3.7).
function segmentSql(name, words, segment) {
  const args = words.slice(1)
  const fromStdin = segment.redirects.some(redirect => String(redirect.op).startsWith('<')) || (segment.stage ?? 0) > 0
  const sql = []
  if (name === 'psql') {
    for (let k = 0; k < args.length; k++) {
      const arg = args[k]
      if (arg === '-f' || arg.startsWith('--file') || /^-[^-]*f/.test(arg)) return 'unknown'
      if (arg === '-c' || arg === '--command') sql.push(args[++k])
      else if (arg.startsWith('--command=')) sql.push(arg.slice(10))
      else if (/^-c./.test(arg)) sql.push(arg.slice(2))
    }
  } else {
    const operands = []
    for (let k = 0; k < args.length; k++) {
      const arg = args[k]
      if (arg === '-init' || arg === '--init') return 'unknown'
      if (arg === '-cmd' || arg === '--cmd') { sql.push(args[++k]); continue }
      if (arg.startsWith('-')) continue
      operands.push(arg)
    }
    sql.push(...operands.slice(1))
  }
  if (sql.some(text => typeof text !== 'string')) return 'unknown'
  if (!sql.length) return fromStdin ? 'unknown' : null
  return sql
}

const SQLITE_READ_DOTS = new Set(['.tables', '.schema', '.indexes', '.indices', '.databases', '.headers', '.mode', '.width', '.nullvalue', '.separator', '.show', '.dbinfo', '.fullschema', '.help', '.quit', '.exit'])
function sqlWrites(statements) {
  if (statements === 'unknown') return true
  if (statements === null) return false
  return statements.some(text => text.split('\n').some(line => line.trim().startsWith('.') && !SQLITE_READ_DOTS.has(line.trim().split(/\s/)[0])) || destructiveSql(text))
}

// Read-only glob expansion (F9): fs.globSync with a visit budget; more than GLOB_LIMIT matches, or
// a walk that runs out of budget, is unknown (null).
function expandGlob(pattern, cwd) {
  if (!path.isAbsolute(pattern) && !cwd) return null
  let visited = 0
  let over = false
  let matches
  try {
    matches = globSync(pattern, { cwd: cwd ?? '/', exclude: () => { if (++visited > GLOB_VISIT_LIMIT) over = true; return over } })
  } catch { return null }
  if (over || matches.length > GLOB_LIMIT) return null
  return matches.map(match => path.resolve(cwd ?? '/', match))
}

// Prepared per tiers set: Bash entries by command word, the outputOpts table for the parser, and
// the other tool entries.
const prepared = new WeakMap()
function prepare(tiers) {
  let ready = prepared.get(tiers)
  if (ready) return ready
  const bash = new Map()
  const bashGlobs = []
  const tools = []
  const outputOpts = Object.create(null)
  for (const entry of Array.isArray(tiers?.entries) ? tiers.entries : []) {
    if (!entry || typeof entry !== 'object' || rank(entry.tier) < 0 || typeof entry.tool !== 'string') continue
    if (entry.tool === 'Bash' && typeof entry.cmd === 'string') {
      const words = entry.cmd.trim().split(/\s+/)
      const item = { entry, words }
      if (words[0].includes('*')) bashGlobs.push(item)
      else bash.set(words[0], [...(bash.get(words[0]) ?? []), item])
      if (Array.isArray(entry.outputOpts) && entry.outputOpts.length) {
        const key = words[0] === 'git' ? words.slice(0, 2).join(' ') : words[0]
        outputOpts[key] = [...new Set([...(Array.isArray(outputOpts[key]) ? outputOpts[key] : []), ...entry.outputOpts])]
      }
    } else if (entry.tool !== 'Bash') tools.push({ entry, pattern: toolGlob(entry.tool) })
  }
  outputOpts.uniq = { options: Array.isArray(outputOpts.uniq) ? outputOpts.uniq : [], operands: [1], values: ['-f', '-s', '-w'] }
  ready = { bash, bashGlobs, tools, outputOpts }
  prepared.set(tiers, ready)
  return ready
}

// The command word list an entry matches against: git's global options are taken out (and
// returned apart) so `git --no-pager log` matches `git log`.
function commandList(words) {
  const name = commandBase(words[0])
  if (name !== 'git') return { name, list: [name, ...words.slice(1)], globals: [] }
  const rest = gitSubcommandArgs(words.slice(1))
  return { name, list: ['git', ...rest], globals: words.slice(1, words.length - rest.length) }
}

// Safe entries match their command words exactly in place. Caution and Destructive entries let
// options stand between the command words, each option taking at most one value word, so
// `kubectl -n prod delete pod x` still matches `kubectl delete`.
function matchCommand(item, list) {
  const { entry, words } = item
  if (words.length > list.length) return null
  if (entry.tier === 'safe') {
    for (let k = 1; k < words.length; k++) if (list[k] !== words[k]) return null
    return { rest: list.slice(words.length) }
  }
  const search = (k, at, skipped) => {
    if (k === words.length) return { rest: [...skipped, ...list.slice(at)] }
    if (at >= list.length) return null
    if (list[at] === words[k]) {
      const found = search(k + 1, at + 1, skipped)
      if (found) return found
    }
    if (!list[at].startsWith('-') || list[at] === '--') return null
    return search(k, at + 1, [...skipped, list[at]]) ?? (at + 1 < list.length && !list[at].includes('=') ? search(k, at + 2, [...skipped, list[at], list[at + 1]]) : null)
  }
  return search(1, 1, [])
}

function scriptMatches(names, script) {
  if (typeof script !== 'string' || !script) return false
  return names.some(name => name.endsWith(':') ? script.startsWith(name) && script.length > name.length : script === name)
}

// The path a git revision or pathspec word names: `:N:path` (index stage N), `:(magic)path` and
// short-magic `:/path`, `:!path`, `:^path` (gitglossary pathspec), `REV:path`, else the word.
function gitPathPart(word) {
  const stage = /^:[0-3]:(.*)$/s.exec(word)
  if (stage) return stage[1]
  const long = /^:\([^)]*\)(.*)$/s.exec(word)
  if (long) return long[1]
  const short = /^:[/!^]*:?(.*)$/s.exec(word)
  if (short) return short[1]
  return word.includes(':') ? word.slice(word.indexOf(':') + 1) : word
}

function gitConfigVerdict(rest, text) {
  const args = rest.slice(1)
  // -t is --type (git 2.55 `git config -h`), so `git config -t bool core.fsmonitor x` sets core.fsmonitor.
  const valueOptions = ['-f', '-t', '--file', '--blob', '--type', '--default', '--comment', '--value']
  const readModes = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l']
  const writeModes = ['--unset', '--unset-all', '--remove-section', '--rename-section', '--add', '--replace-all', '--edit', '-e']
  const operands = []
  let mode = null
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]
    if (valueOptions.includes(arg)) { k++; continue }
    if (readModes.includes(arg)) { mode = 'read'; continue }
    if (writeModes.includes(arg)) { mode = arg === '--edit' || arg === '-e' ? 'edit' : 'write'; continue }
    if (!arg.startsWith('-')) operands.push(arg)
  }
  if (mode === null && ['get', 'list'].includes(operands[0])) { mode = 'read'; operands.shift() }
  else if (mode === null && ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(operands[0])) { mode = operands[0] === 'edit' ? 'edit' : 'write'; operands.shift() }
  if (mode === null) mode = operands.length >= 2 ? 'write' : 'read'
  if (mode === 'read') return null
  if (mode === 'edit') return reason('floor.git-config-write', 'destructive', text, 'edits the git configuration')
  const key = String(operands[0] ?? '').toLowerCase()
  if (gitConfigWriteRunsCode(key) || gitConfigWriteRunsCode(`${key}.`)) return reason('floor.git-config-write', 'destructive', text, 'sets git configuration that runs programs')
  return null
}

// git global options: the F1 `-c` keys, and whether the globals leave a Safe git entry Safe
// (only `--no-pager`, `-P` and `-C <dir inside the repo scope>`).
function gitGlobals(globals, segment, ctx) {
  const floors = []
  let safe = true
  let dir = segment.cwd
  for (let k = 0; k < globals.length; k++) {
    const word = globals[k]
    let config = null
    if (word === '-c' || word === '--config-env') config = globals[++k]
    else if (word.startsWith('-c')) config = word.slice(2)
    else if (word.startsWith('--config-env=')) config = word.slice(13)
    if (config !== null) {
      safe = false
      const key = String(config ?? '').split('=')[0].toLowerCase()
      if (gitCKeyRunsCode(key)) floors.push('git -c ' + key)
      continue
    }
    if (GIT_SAFE_GLOBALS.includes(word)) continue
    if (word === '-C') {
      dir = resolveIn(globals[++k], dir)
      if (dir === null || scopeRelative(dir, ctx.scope) === null) safe = false
      continue
    }
    safe = false
  }
  return { floors, safe }
}

// go build and go test outputs (`go help build`, `go help testflag`; not run here: no Go toolchain
// on the test host). `-o DIR/`, or `-o` naming an existing directory, writes DIR/<name>; go build
// with no -o writes a single main package to the working directory as <name>; go test writes
// <name>.test. <name> is the last element of the package's import path without a /vN suffix, or the
// first file's name for .go operands. The deck does not know which packages are main, so it judges
// every name an operand can give: each word that is not an option is taken as a package (a value
// of an option the deck does not model gives an extra name, which only adds checks). A `...`
// pattern gives the names of the directories under it, skipping the ones go skips (names starting
// with . or _, and testdata); a pattern the deck cannot list is Caution.
const GO_WALK_LIMIT = 5000
const goMajorVersion = element => /^v(?:[2-9]|[1-9]\d+)$/.test(element)
function goModulePath(dir) {
  let text
  try { text = readFileSync(path.join(dir, 'go.mod'), 'utf8') } catch { return null }
  const match = /^\s*module\s+(?:"([^"]+)"|([^\s/][^\s]*))/m.exec(text)
  return match ? (match[1] ?? match[2]) : null
}
const importBase = elements => elements.length > 1 && goMajorVersion(elements.at(-1)) ? elements.at(-2) : elements.at(-1)
// The names a package directory can build to: its own name, its module's name at a module root, and
// its parent's name for a /vN directory. null when a go.mod cannot be read.
function goDirNames(dir) {
  const names = [path.basename(dir)]
  if (goMajorVersion(path.basename(dir))) names.push(path.basename(path.dirname(dir)))
  if (lexists(path.join(dir, 'go.mod'))) {
    const module = goModulePath(dir)
    if (module === null) return null
    names.push(importBase(module.split('/')))
  }
  return names
}
function goPatternNames(base) {
  const names = goDirNames(base)
  if (names === null) return null
  const pending = [base]
  let seen = 0
  while (pending.length) {
    let entries
    try { entries = readdirSync(pending.pop(), { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'testdata') continue
      if (++seen > GO_WALK_LIMIT) return null
      const dir = path.join(entry.parentPath, entry.name)
      const more = goDirNames(dir)
      if (more === null) return null
      names.push(...more)
      pending.push(dir)
    }
  }
  return names
}
function goPackageNames(word, cwd) {
  if (word.endsWith('.go')) return [path.basename(word, '.go')]
  const relative = word === '.' || word === '..' || word.startsWith('./') || word.startsWith('../') || path.isAbsolute(word)
  if (word.includes('...')) {
    if (!relative || !cwd) return null
    const prefix = word.slice(0, word.indexOf('...'))
    return goPatternNames(path.resolve(cwd, prefix.endsWith('/') ? prefix : path.dirname(prefix || '.')))
  }
  if (relative) return cwd ? goDirNames(path.resolve(cwd, word)) : null
  return [importBase(word.split('/'))]
}
function goOutputVerdicts(list, words, info, segment, ctx, text) {
  if (list[1] !== 'build' && list[1] !== 'test') return []
  const suffix = list[1] === 'test' ? '.test' : ''
  const offset = words.length - list.length
  const packages = []
  const outputs = []
  let unknown = false
  for (let k = 2; k < list.length; k++) {
    const word = list[k]
    const literal = !info[k + offset] || info[k + offset].literal
    const match = /^--?o=(.*)$/s.exec(word)
    if (word === '-o' || word === '--o' || match) {
      const value = match ? match[1] : list[++k]
      if (value === undefined || (!match && info[k + offset] && !info[k + offset].literal) || !literal) { unknown = true; continue }
      outputs.push(value)
      continue
    }
    if (word.startsWith('-')) continue
    if (!literal) { unknown = true; continue }
    packages.push(word)
  }
  const dirs = []
  for (const value of outputs) {
    const location = resolveIn(value, segment.cwd)
    if (location && (value.endsWith('/') || isDirectory(location))) dirs.push(location)
  }
  if (!outputs.length && list[1] === 'build') dirs.push(segment.cwd)
  if (!dirs.length) return []
  const verdicts = []
  const fail = () => [reason('go.output', 'caution', text, 'writes a build output the deck cannot name')]
  if (unknown || dirs.some(dir => typeof dir !== 'string')) return fail()
  const names = []
  for (const word of packages.length ? packages : ['.']) {
    const more = goPackageNames(word, segment.cwd)
    if (more === null) return fail()
    names.push(...more)
  }
  for (const dir of dirs) {
    for (const name of new Set(names)) {
      const verdict = writeVerdict(path.join(dir, `${name}${suffix}`), ctx, text)
      if (verdict) verdicts.push(verdict)
    }
  }
  return verdicts
}

// cargo's build commands write CACHEDIR.TAG, debug/ and .rustc_info.json into the target directory
// (cargo 1.98, run on the test host): --target-dir, else `target` next to the Cargo.toml cargo
// finds from the working directory up (each one is checked, as the workspace root may be higher).
const CARGO_BUILDS = Object.freeze(['build', 'check', 'test', 'clippy', 'doc', 'bench', 'nextest'])
function cargoTargetVerdicts(list, segment, ctx, text) {
  if (!CARGO_BUILDS.includes(list[1])) return []
  const dirs = []
  for (let k = 2; k < list.length; k++) {
    if (list[k] === '--') break
    if (list[k] === '--target-dir') dirs.push(resolveIn(list[k + 1] ?? '', segment.cwd))
    else if (list[k].startsWith('--target-dir=')) dirs.push(resolveIn(list[k].slice(13), segment.cwd))
  }
  if (!dirs.length && segment.cwd) {
    for (let current = segment.cwd; ; current = path.dirname(current)) {
      if (lexists(path.join(current, 'Cargo.toml'))) dirs.push(path.join(current, 'target'))
      if (path.dirname(current) === current) break
    }
  }
  return dirs.map(dir => writeVerdict(dir === null ? null : path.join(dir, 'CACHEDIR.TAG'), ctx, text)).filter(Boolean)
}

// Whether `dir` lies inside .git or inside a directory on the execution-config list (D-89 (3)),
// by its path as given and by its realpath.
function inControlledDir(dir, ctx) {
  return inGitDirTarget(dir, ctx) || candidates(dir).some(candidate => isGitInternal(candidate) || [...ctx.scope, ...ctx.lexicalRoots].some(root => {
    if (!within(candidate, root) || candidate === root) return false
    return isExecutionConfig(`${path.relative(root, candidate)}/_`)
  }))
}

// D-91 (1): the options that take a pattern or script beyond the value-option specs (pytest -k and
// -m select tests by expression, node --test-name-pattern by regular expression; the shells' -c and
// the interpreters' -c and -e take the script itself), and the commands whose first operand is a
// script or pattern when no option gave one.
const SHELL_SCRIPT = ['-c']
const PATTERN_OPTIONS = Object.freeze({ __proto__: null, pytest: ['-k', '-m'], node: ['--test-name-pattern', '--test-skip-pattern', '-e', '-p', '--eval', '--print'], sh: SHELL_SCRIPT, bash: SHELL_SCRIPT, dash: SHELL_SCRIPT, zsh: SHELL_SCRIPT, ksh: SHELL_SCRIPT, fish: SHELL_SCRIPT, python: SHELL_SCRIPT, python3: SHELL_SCRIPT, perl: ['-e', '-E'], ruby: ['-e'] })
const SCRIPT_OPERAND = Object.freeze(['sed', 'awk', 'gawk', 'mawk', 'jq', 'yq', 'grep', 'egrep', 'fgrep', 'rg'])
// The words of a segment that are pattern or script text: the option names whose value is one, and
// the indexes in `words` of the values given in the next word and of the script or pattern operand.
function scriptText(name, list, words) {
  const known = valueSpec(name, list) ?? spec([])
  const module = (name === 'python' || name === 'python3') && list[1] === '-m' ? list[2] : null
  const options = new Set([...known.pattern].filter(option => !known.files.has(option)))
  for (const key of [name, module]) for (const option of Object.hasOwn(PATTERN_OPTIONS, key ?? '') ? PATTERN_OPTIONS[key] : []) options.add(option)
  const indexes = new Set()
  let operand = SCRIPT_OPERAND.includes(name) && !segmentArgs(name, list, words.slice(1)).patternGiven
  for (let k = 1; k < words.length; k++) {
    const word = words[k]
    if (word === '--') { if (operand && k + 1 < words.length) indexes.add(k + 1); break }
    if (word.startsWith('-') && word !== '-') {
      const short = !word.startsWith('--') && !known.single && word.length > 2 ? `-${word.at(-1)}` : null
      if (options.has(word) || (short && options.has(short) && !options.has(word.slice(0, 2)))) indexes.add(k + 1)
      if (known.values.has(word) || options.has(word) || (short && options.has(short))) k++
      continue
    }
    if (operand) { indexes.add(k); operand = false }
  }
  return { options, indexes }
}

function classifySegment(segment, ctx, ready, out) {
  const text = segment.words.join(' ')
  const push = item => out.reasons.push(item)
  if (segment.wrappers.some(wrapper => PRIVILEGE_WORDS.includes(wrapper)) || segment.stdinShell) push(reason('floor.privilege', 'caution', text, 'runs as another user'))
  for (const assigned of segment.assignments) if (envFloor(assigned.name)) push(reason('floor.env', 'caution', text, `sets ${assigned.name}`))
  if (segment.payloadOf !== null) push(reason('floor.payload', 'caution', text, segment.remote ? 'runs on another host or in a container' : 'runs a command for another command'))
  for (const mount of segment.mounts) {
    const source = typeof mount.source === 'string' ? path.normalize(hostForm(mount.source)) : null
    if (source && (source === '/' || within(ctx.home, source))) push(reason('floor.mount', 'destructive', text, 'mounts your home directory into a container'))
  }
  if (segment.privileged) push(reason('floor.privileged', 'destructive', text, 'runs a privileged container'))
  for (const write of segment.writes) {
    const verdict = writeVerdict(write.path ?? null, ctx, text)
    if (verdict) push(verdict)
  }
  if (!segment.words.length) return
  if (!segment.literal) { push(reason('unknown.nonliteral', 'caution', text, 'the command word is not literal')); return }
  const words = segment.words
  const { name, list, globals } = commandList(words)
  if (PRIVILEGE_WORDS.includes(name)) push(reason('floor.privilege', 'caution', text, 'runs as another user'))
  const info = segment.wordInfo ?? []
  const operands = []
  // The file an option names in its own word: `--file=PATH`, `--pathspec-from-file=PATH` or a
  // stuck short value such as `-FPATH`. An option's value in the next word is an operand already.
  const optionValues = []
  // D-91 (1): a word with white space is judged like any other word, except pattern or script text.
  const script = scriptText(name, list, words)
  const textWord = (word, k) => /\s/.test(word) && script.indexes.has(k)
  for (let k = 1; k < words.length; k++) {
    const word = words[k]
    if (info[k]?.glob) {
      const matches = expandGlob(word, segment.cwd)
      if (matches === null) push(reason('unknown.glob', 'caution', text, 'a glob matches too many files to check'))
      else operands.push(...matches.map(location => ({ location, word })))
      continue
    }
    if (info[k] && !info[k].literal) continue
    if (namesDeckPort(word, ctx)) push(reason('floor.deck', 'destructive', text, 'talks to the deck\'s own server'))
    if (word.startsWith('-') && word !== '--') {
      const equal = word.indexOf('=')
      const value = equal > 0 ? word.slice(equal + 1) : (!word.startsWith('--') && word.length > 2 ? word.slice(2) : '')
      const option = equal > 0 ? word.slice(0, equal) : word.slice(0, 2)
      const location = value && !(/\s/.test(value) && script.options.has(option)) ? resolveIn(value, segment.cwd) : null
      if (location) optionValues.push({ location, word })
      continue
    }
    if (textWord(word, k)) continue
    const location = resolveIn(word, segment.cwd)
    if (location) operands.push({ location, word })
  }
  // The deck floor reads operands only: an option value may be a pattern (`--regexp=cache/token`),
  // and the M1 floor already rates the options that read a file (machines.test.mjs pins both).
  const named = [...operands, ...optionValues]
  if (!TEXT_COMMANDS.includes(name) && operands.some(({ location }) => namesControl(location, ctx))) push(reason('floor.deck', 'destructive', text, 'names the deck\'s own files'))
  if (name === 'systemctl' && words.some(word => /^fleetmates-deck/.test(commandBase(word)))) push(reason('floor.deck', 'destructive', text, 'controls the deck\'s own services'))
  if (controlsDeckService(name, words)) push(reason('floor.deck', 'destructive', text, 'controls the deck\'s own services'))
  // Commands that read a whole directory tree: their roots may not hold the deck's files (F9). diff
  // -r prints every file under its operands in full (with -N, against an empty directory).
  const shortFlag = (flags) => words.some(word => new RegExp(`^-[^-]*[${flags}]`).test(word))
  const recursive = name === 'rg' || name === 'find' || name === 'rsync' || name === 'fd' || name === 'tree'
    || (name === 'du' && (shortFlag('a') || words.includes('--all')))
    || (name === 'grep' && (shortFlag('rR') || words.some(word => word === '--recursive' || word.startsWith('--recursive') || word === '--dereference-recursive')))
    || (name === 'cp' && (shortFlag('rRa') || words.some(word => ['--recursive', '--archive'].includes(word))))
    || (name === 'diff' && (shortFlag('r') || words.some(word => word.startsWith('--rec'))))
    || (name === 'ls' && (shortFlag('R') || words.some(word => word.startsWith('--recur'))))
    || (name === 'tar' && (/^[^-]*c/.test(words[1] ?? '') || words.some(word => /^-[^-]*c/.test(word) || word === '--create')))
  // git diff runs as `git diff --no-index` when a path is outside the working tree, and then
  // recurses into directory operands like diff -r (git-diff(1)).
  const gitDiff = name === 'git' && list[1] === 'diff'
  if (recursive || gitDiff || name === 'diff') {
    // The roots are the path operands: option values are not (D-88 (2)), nor is the pattern operand
    // of grep, rg, fd and git grep. A glob root stands for its expansion.
    const split = segmentArgs(name, list, name === 'git' ? list.slice(2) : words.slice(1))
    const patternSlot = ['grep', 'rg', 'fd'].includes(name) || (name === 'git' && list[1] === 'grep')
    const rootWords = patternSlot && !split.patternGiven && !split.noPattern ? split.operands.slice(1) : split.operands
    const roots = rootWords.flatMap(word => {
      const expanded = operands.filter(item => item.word === word).map(item => item.location)
      return expanded.length ? expanded : [resolveIn(word, segment.cwd)].filter(Boolean)
    })
    // With no root that exists, the command reads the working directory (a root that names nothing
    // is read as the cwd too, so an option the spec misses cannot hide the cwd).
    const implicit = recursive && !roots.some(lexists) && segment.cwd
    if (implicit) roots.push(segment.cwd)
    if ((recursive || gitDiff) && roots.some(root => ancestorOfControl(root, ctx))) push(reason('floor.deck', 'destructive', text, 'reads a directory that holds the deck\'s own files'))
    // diff without -r still prints every top-level file of a directory operand.
    if (roots.some(root => holdsSecret(root, ctx))) push(reason('read.secret', 'caution', text, 'reads a secret file'))
    if (implicit && !inScope(segment.cwd, ctx)) push(reason('scope.read-outside', 'caution', text, 'reads outside the repo'))
    // D-88 (5): git diff compares directories (as --no-index) or runs outside a work tree only at
    // Caution. diff on a directory reads the files in it, following their symlinks.
    if ((gitDiff || name === 'diff') && roots.some(isDirectory)) push(reason('read.directory', 'caution', text, 'compares directories'))
    if (gitDiff && !inGitWorkTree(segment.cwd)) push(reason('git.no-work-tree', 'caution', text, 'runs git diff outside a git work tree'))
  }
  // D-88 (3): a recursive reader that follows symlinks reads wherever a link in the tree points.
  if (followsSymlinks(name, words)) push(reason('read.follows-symlinks', 'caution', text, 'reads a directory tree following symlinks'))
  const sensitive = ({ location }) => candidates(location).some(candidate => isSensitive(candidate, ctx.home))
  const exists = ({ location }) => { try { return existsSync(location) } catch { return false } }
  if ((READ_COMMANDS.includes(name) && operands.some(sensitive)) || (!TEXT_COMMANDS.includes(name) && named.some(item => exists(item) && sensitive(item)))) push(reason('read.secret', 'caution', text, 'reads a secret file'))
  if (name === 'go') {
    // Go's flag package documents `-o=PATH`, `--o=PATH` and `--o PATH` as spellings of `-o PATH`
    // (not run here: no Go toolchain on the test host). The parser does not record them as writes,
    // so their value is checked as the output file here.
    for (let k = 1; k < words.length; k++) {
      if (info[k] && !info[k].literal) continue
      const match = /^--?o=(.*)$/.exec(words[k])
      const value = match ? match[1] : (words[k] === '--o' ? words[k + 1] : null)
      if (value === null || value === undefined) continue
      const verdict = writeVerdict(info[k + 1] && !match && !info[k + 1].literal ? null : resolveIn(value, segment.cwd), ctx, text)
      if (verdict) push(verdict)
    }
    for (const verdict of goOutputVerdicts(list, words, info, segment, ctx, text)) push(verdict)
  }
  if (name === 'cargo') for (const verdict of cargoTargetVerdicts(list, segment, ctx, text)) push(verdict)
  const subcommand = Object.hasOwn(FIXERS, `${name} ${list[1] ?? ''}`) ? 2 : (Object.hasOwn(FIXERS, name) ? 1 : 0)
  if (subcommand) {
    const args = list.slice(subcommand)
    const end = args.indexOf('--')
    if (end >= 0 || !FIXERS[list.slice(0, subcommand).join(' ')](args)) push(reason('format.writes', 'caution', text, 'rewrites files: not in a check or diff mode'))
  }
  if (RUNNERS.includes(name)) {
    // D-90 (d): a runner operand is cut at `::` and `[` (a pytest node id or parameter id; a glob
    // that matches nothing reaches the runner as written), and one that names nothing is judged by
    // its nearest existing ancestor, which must lie in the repo. A word the deck cannot read, or a
    // glob too large to expand, is an unknown directory. D-91 (1): so is an operand that still holds
    // white space after the cut and names nothing; only pattern or script text is left out.
    const targets = []
    for (let k = 1; k < words.length; k++) {
      const word = words[k]
      if (info[k] && !info[k].literal && !info[k].glob) { targets.push(null); continue }
      if (word.startsWith('-') || textWord(word, k)) continue
      if (info[k]?.glob) {
        const matches = expandGlob(word, segment.cwd)
        if (matches === null) { targets.push(null); continue }
        if (matches.length) { targets.push(...matches); continue }
      }
      const cut = word.split('::')[0].split('[')[0] || '.'
      const target = resolveIn(cut, segment.cwd)
      targets.push(target !== null && /\s/.test(cut) && !lexists(target) ? null : target)
    }
    // D-91 (2): pytest 8.2 and later, and mypy (argparse fromfile_prefix_chars), read more arguments
    // from FILE for a word `@FILE`, which no option list here can see.
    const pyTool = ['python', 'python3'].includes(name) && list[1] === '-m' ? list[2] : name
    if (['pytest', 'mypy'].includes(pyTool) && words.slice(1).some(word => word.startsWith('@'))) push(reason('unknown.option', 'caution', text, 'reads more arguments from a file'))
    const dirs = [segment.cwd]
    let outside = false
    for (const target of targets) {
      // The walk up stops at the repo scope root a target lies under as written.
      const root = target === null ? undefined : ctx.lexicalRoots.filter(dir => within(target, dir)).sort((a, b) => b.length - a.length)[0]
      let found = target
      while (found !== null && found !== root && !lexists(found)) found = path.dirname(found) === found ? null : path.dirname(found)
      const dir = found === null ? null : (found === root || isDirectory(found) ? found : path.dirname(found))
      if (dir !== null && !inScope(dir, ctx)) outside = true
      dirs.push(dir)
    }
    if (dirs.some(dir => dir === null || inControlledDir(dir, ctx))) push(reason('runner.config-dir', 'caution', text, 'runs in .git or in a directory of hooks or build configuration'))
    if (outside) push(reason('runner.outside', 'caution', text, 'runs on a path outside the repo'))
  }
  if (OPERAND_WRITERS.includes(`${name} ${words[1] ?? ''}`)) {
    // A non-literal operand, or a glob too large to expand, is an unknown target (null).
    const targets = []
    for (let k = 2, parsing = true; k < words.length; k++) {
      const word = words[k]
      if (parsing && word === '--' && (!info[k] || info[k].literal)) { parsing = false; continue }
      if (info[k]?.glob) { targets.push(...(expandGlob(word, segment.cwd) ?? [null])); continue }
      if (info[k] && !info[k].literal) { targets.push(null); continue }
      if (parsing && word.startsWith('-') && word !== '-') continue
      // A go package pattern `DIR/...` stands for DIR and the packages under it.
      if (word !== '-') targets.push(resolveIn(name === 'go' && word.includes('...') ? word.slice(0, word.indexOf('...')) || '.' : word, segment.cwd))
    }
    if (!targets.length) targets.push(segment.cwd)
    for (const target of targets) {
      const verdict = writeVerdict(target, ctx, text)
      if (verdict) push(verdict)
    }
  }
  if (name === 'git') {
    const { floors, safe } = gitGlobals(globals, segment, ctx)
    for (const key of floors) push(reason('floor.git-c', 'destructive', text, `${key} runs a program`))
    out.gitGlobalsSafe = safe
    if (list[1] === 'config') {
      const verdict = gitConfigVerdict(list.slice(1), text)
      if (verdict) push(verdict)
    }
    if (list[1] === 'worktree' && list[2] === 'add') {
      const args = list.slice(3)
      let target = null
      for (let k = 0; k < args.length; k++) {
        if (['-b', '-B', '--reason'].includes(args[k])) { k++; continue }
        if (args[k].startsWith('-')) continue
        target = args[k]
        break
      }
      if (target !== null) {
        const verdict = writeVerdict(resolveIn(target, segment.cwd), ctx, text)
        if (verdict) push(verdict)
      }
    }
    // git read subcommands print a committed file whether or not the work tree still holds it:
    // a pathspec, a `REV:path`, an index-stage `:N:path` or the file of an `-L` range naming a
    // sensitive-list file is a secret read.
    if (['show', 'log', 'diff', 'blame', 'grep', 'whatchanged'].includes(list[1])) {
      const split = segmentArgs(name, list, list.slice(2))
      const named = (list[1] === 'grep' && !split.patternGiven ? split.operands.slice(1) : split.operands).map(gitPathPart)
      for (const value of split.values) if (value.option === '-L' && typeof value.word === 'string' && value.word.includes(':')) named.push(value.word.slice(value.word.lastIndexOf(':') + 1))
      const secret = named.some(part => part !== '' && isSensitive(path.resolve(segment.cwd ?? '/', part), ctx.home))
      if (secret) push(reason('read.secret', 'caution', text, 'reads a secret file'))
    }
    if (list[1] === 'add' && list.slice(2).some(arg => !arg.startsWith('-') && (() => { const location = resolveIn(arg, segment.cwd); return location && candidates(location).some(candidate => isSensitive(candidate, ctx.home)) })())) push(reason('git.stages-secret', 'caution', text, 'stages a secret file'))
  }
  matchEntries(segment, ctx, ready, out, { name, list, text, words })
}

// D-88 (1) and (2), the path rule of a Safe candidate: the working directory and every path the
// command names must be bare, a plain relative path that stays lexically inside the repo scope with
// no symlink in any component below the scope root. Absolute and `~` paths are not bare, even inside
// the repo. A path is an operand that names something that exists (lstat) or reads as a path
// (syntaxPath), the value of an option that names a file, or a write target. Values of options
// that take a pattern, script or number are never paths. The pattern operand of a `"afterFirst"`
// entry counts only when it names something that exists. `pathOperands: "none"` entries take
// text only and do not read the working directory.
function bareVerdict(entry, name, list, tail, segment, ctx, text) {
  if (entry.pathOperands === 'none') return null
  const fail = kind => reason(BARE_REASONS[kind][0], 'caution', text, BARE_REASONS[kind][1])
  const cwd = segment.cwd
  if (!cwd || bareCheck(cwd, ctx) !== null) return fail('cwd')
  if (tail.info.some(info => info && (!info.literal || info.glob))) return fail('outside')
  const split = segmentArgs(name, list, tail.words)
  for (const value of split.values) {
    if (!value.file && (value.modelled || !syntaxPath(String(value.word ?? '')))) continue
    const verdict = wordVerdict(value.word, cwd, ctx)
    if (verdict) return fail(verdict)
  }
  const patternFirst = entry.pathOperands === 'afterFirst' && !split.patternGiven && !split.noPattern
  for (let k = 0; k < split.operands.length; k++) {
    const verdict = wordVerdict(split.operands[k], cwd, ctx, patternFirst && k === 0)
    if (verdict) return fail(verdict)
  }
  for (const write of segment.writes) {
    if (typeof write.path !== 'string' || DEV_NULLS.has(write.path)) continue
    const verdict = bareCheck(write.path, ctx)
    if (verdict) return fail(verdict === 'outside' ? 'outside' : 'symlink')
  }
  // jq and yq: a filter that reads the environment or a file reads outside the repo.
  if (Object.hasOwn(FILTER_READS, name) && !split.patternGiven && split.operands.length && FILTER_READS[name].test(split.operands[0])) return fail('outside')
  return null
}

// Words after `--` that an entry forwards to another program (the test binary, a package script):
// an option not on `forwardOpts` is Caution, and a path among them that a floor protects keeps that
// floor, because the program may write it (`cargo test -- --logfile PATH` replaces PATH).
function forwardedVerdicts(entry, tail, segment, ctx, text) {
  const at = tail.words.findIndex((word, k) => word === '--' && (!tail.info[k] || tail.info[k].literal))
  if (at < 0) return []
  const verdicts = []
  let flagged = false
  for (const word of tail.words.slice(at + 1)) {
    if (!flagged && word.startsWith('-') && word !== '-' && !matchesAny(entry.forwardOpts, word)) {
      flagged = true
      verdicts.push(reason('forward.option', 'caution', text, 'passes options to the test program'))
    }
    const equal = word.startsWith('-') ? word.indexOf('=') : -1
    const value = equal > 0 ? word.slice(equal + 1) : word
    if (!value || value.startsWith('-') || !syntaxPath(value)) continue
    const verdict = writeVerdict(resolveIn(expandHome(value, ctx), segment.cwd), ctx, text)
    if (verdict?.tier === 'destructive') verdicts.push(verdict)
  }
  return verdicts
}

// `operandOpts` entries (git branch) take operands only alongside one of those options: without
// one, `git branch NAME` creates a branch instead of listing.
function operandsAllowed(entry, words) {
  if (words.some(word => argVariants(word).some(variant => matchesAny(entry.operandOpts, variant)))) return true
  return !words.some(word => word !== '--' && !word.startsWith('-'))
}

function matchEntries(segment, ctx, ready, out, { name, list, text, words }) {
  const items = [...(ready.bash.get(name) ?? []), ...ready.bashGlobs.filter(item => argGlob(item.words[0]).test(name))]
  let matched = false
  let safeEntry = null
  let longOpts = []
  const sql = ['psql', 'sqlite3'].includes(name) ? segmentSql(name, words, segment) : undefined
  for (const item of items) {
    const { entry } = item
    const found = matchCommand(item, list)
    if (!found) continue
    let rest = found.rest
    if (Array.isArray(entry.longOpts)) longOpts = [...longOpts, ...entry.longOpts]
    if (Array.isArray(entry.script)) {
      const script = rest.find(arg => !arg.startsWith('-'))
      if (!scriptMatches(entry.script, script)) continue
      rest = rest.filter(arg => arg !== script)
    }
    if (entry.sql === 'write' && !sqlWrites(sql)) continue
    if (entry.sql === 'read' && sqlWrites(sql)) continue
    if (Array.isArray(entry.anyArg) && !anyVariant(rest, entry.anyArg, entry.longOpts)) continue
    if (Array.isArray(entry.noneArg) && anyVariant(rest, entry.noneArg, entry.longOpts)) {
      if (entry.tier === 'safe') out.reasons.push(reason('unknown.option', 'caution', text, 'uses an argument outside the Safe pattern'))
      continue
    }
    if (entry.tier === 'safe') {
      const bad = disallowedOption(entry, rest)
      if (bad !== null) { out.reasons.push(reason('unknown.option', 'caution', text, `uses ${bad}, which is not on the Safe option list`)); continue }
      if (name === 'git' && !out.gitGlobalsSafe) { out.reasons.push(reason('git.global-option', 'caution', text, 'uses a git global option')); continue }
      if (name === 'sed' && !sedScripts(rest).every(sedScriptSafe)) { out.reasons.push(reason('sed.script', 'caution', text, 'the sed script can run a command or write a file')); continue }
      if (name === 'cargo') {
        const at = rest.findIndex(arg => arg === '--target-dir' || arg.startsWith('--target-dir='))
        if (at >= 0) {
          const dir = rest[at].includes('=') ? rest[at].slice(rest[at].indexOf('=') + 1) : rest[at + 1]
          const location = resolveIn(dir, segment.cwd)
          if (!location || scopeRelative(location, ctx.scope) === null) { out.reasons.push(reason('cargo.target-dir', 'caution', text, 'builds into a directory outside the repo')); continue }
        }
      }
      const tail = { words: words.slice(words.length - found.rest.length), info: (segment.wordInfo ?? []).slice(words.length - found.rest.length) }
      if (Array.isArray(entry.operandOpts) && !operandsAllowed(entry, tail.words)) { out.reasons.push(reason('unknown.operand', 'caution', text, 'takes an operand outside the Safe pattern')); continue }
      if (Array.isArray(entry.forwardOpts)) {
        const forwarded = forwardedVerdicts(entry, tail, segment, ctx, text)
        if (forwarded.length) { out.reasons.push(...forwarded); continue }
      }
      const bare = bareVerdict(entry, name, list, tail, segment, ctx, text)
      if (bare) { out.reasons.push(bare); continue }
      if (!safeEntry) safeEntry = { entry, script: Array.isArray(entry.script) ? found.rest.find(arg => !arg.startsWith('-')) : null }
    }
    matched = true
    out.reasons.push(reason(entry.id, entry.tier, text, entry.description ?? ''))
  }
  if (name === 'git' && GIT_LONG_CHECKED.includes(list[1]) && longOpts.length) {
    const unknown = list.slice(2).find(arg => arg.startsWith('--') && arg !== '--' && normalizeLongOption(arg, longOpts) === null)
    if (unknown) out.reasons.push(reason('unknown.long-option', 'caution', text, `${unknown.split('=')[0]} is not a known option`))
  }
  if (!matched) out.reasons.push(reason('unknown.command', 'caution', text, words[0].includes('/') ? 'runs a script' : 'no pattern matches this command'))
  out.safeEntries.push(safeEntry)
}

function classifyBash(command, ctx, ready) {
  const out = { reasons: [], safeEntries: [], gitGlobalsSafe: true }
  const parsed = parseCommand(command, { cwd: ctx.cwd, homeDir: ctx.home, outputOpts: ready.outputOpts })
  if (!parsed.ok) {
    out.reasons.push(reason('unknown.parse', 'caution', command, 'the command could not be read'))
    return { ...out, parsed }
  }
  if (!parsed.plain) out.reasons.push(reason('floor.plain', 'caution', command, 'not a plain command'))
  for (const route of parsed.routes) {
    const interpreter = parsed.segments[route.interpreter]
    out.reasons.push(reason('floor.network-interpreter', 'destructive', interpreter ? interpreter.words.join(' ') : command, 'runs code fetched from the network'))
  }
  for (const segment of parsed.segments) {
    out.gitGlobalsSafe = true
    classifySegment(segment, ctx, ready, out)
  }
  return { ...out, parsed }
}

function matchToolEntries(toolName, ready, test) {
  return ready.tools.filter(({ entry, pattern }) => pattern.test(toolName) && test(entry)).map(({ entry }) => entry)
}

function classifyFileTool(toolName, toolInput, ctx, ready, reasons) {
  const raw = toolInput?.file_path ?? toolInput?.notebook_path ?? toolInput?.path
  const location = resolveIn(typeof raw === 'string' ? raw : null, ctx.cwd)
  if (!location) { reasons.push(reason('unknown.path', 'caution', String(raw ?? ''), 'the path could not be read')); return null }
  const shown = String(raw)
  if (namesControl(location, ctx)) reasons.push(reason('floor.deck', 'destructive', shown, 'names the deck\'s own files'))
  if (FILE_WRITE_TOOLS.includes(toolName)) {
    const verdict = writeVerdict(location, ctx, shown)
    if (verdict && verdict.tier === 'destructive') reasons.push(verdict)
    const config = configVerdict(location, ctx, shown)
    if (config) reasons.push(config)
    // D-90 (b): a target reached through a symlink below the repo root, or one whose realpath is
    // in the repo while the path as named is not, is Caution.
    const bare = bareCheck(location, ctx)
    if (bare === 'symlink' || (bare === 'outside' && scopeRelative(location, ctx.scope) !== null)) reasons.push(reason('path.symlink', 'caution', shown, 'names a path through a symlink'))
  } else if (candidates(location).some(candidate => isSensitive(candidate, ctx.home))) reasons.push(reason('read.secret', 'caution', shown, 'reads a secret file'))
  const inside = scopeRelative(location, ctx.scope) !== null
  const entries = matchToolEntries(toolName, ready, entry => {
    if (entry.path === undefined) return true
    if (entry.path === 'inRepo') return inside
    if (entry.path === 'outsideRepo') return !inside
    return Array.isArray(entry.path) && entry.path.some(glob => pathGlob(glob, ctx.home).test(location))
  })
  for (const entry of entries) reasons.push(reason(entry.id, entry.tier, shown, entry.description ?? ''))
  if (!entries.length) reasons.push(reason('unknown.tool', 'caution', shown, 'no pattern matches this tool'))
  return null
}

function pathGlob(glob, home) {
  let text = glob.startsWith('~/') && home ? `${home}/${glob.slice(2)}` : glob
  const anchored = text.startsWith('/')
  text = text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\/\*\*$/, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  text = text.replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '(?:/.*)?').replace(/\u0002/g, '.*')
  return new RegExp(anchored ? `^${text}$` : `(?:^|/)${text}$`)
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return null }
}

// Fields that carry the action itself, so prose such as `description` never feeds a tier (F17).
function actionInput(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  if (toolName === 'Bash') return { command: input.command }
  if (FILE_WRITE_TOOLS.includes(toolName) || toolName === 'Read') return { file_path: input.file_path, notebook_path: input.notebook_path }
  const { description, ...rest } = input
  return rest
}

/**
 * Classify a permission request (docs/deck/07-approvals.md 3.2). Pure except for the read-only
 * realpath and glob checks of the paths it names, the read-only, cached D-91 (3) look at the repo's
 * root-level links and `.git` file, and the D-92 (a) core.hooksPath cache, whose git read it starts
 * in the background when one is due (`hooksPathCache`).
 * @param {{ toolName: string, toolInput?: object, cwd?: string, repoRoot?: string, worktrees?: string[], homeDir?: string, deckPaths?: { config?: string, state?: string, runtime?: string|null, token?: string, port?: number|string }, tiers?: { entries: object[] }, platform?: string }} input
 * @returns {{ tier: 'safe'|'caution'|'destructive', reasons: { entryId: string, tier: string, segment: string, description: string }[], ruleCandidate: string|null, ruleNote: string|null, confirm: { template: string|null, count: string|null }, description: string }}
 */
export function classify(input) {
  const platform = input?.platform ?? process.platform
  const previous = windowsPaths
  windowsPaths = platform === 'win32'
  try { return classifyOn(input, platform) } finally { windowsPaths = previous }
}

function classifyOn(input, platform) {
  const { toolName, cwd = null, repoRoot = null } = input ?? {}
  const toolInput = actionInput(toolName, input?.toolInput)
  const tiers = input?.tiers ?? DEFAULT_TIERS
  const ready = prepare(tiers)
  const ctx = context(input ?? {}, platform)
  const reasons = []
  let ruleCandidate = null
  let ruleNote = null
  let bash = null
  if (typeof toolName !== 'string' || !toolName) reasons.push(reason('unknown.tool', 'caution', '', 'no tool named'))
  else if (toolName === 'Bash') {
    if (typeof toolInput.command !== 'string') reasons.push(reason('unknown.parse', 'caution', '', 'no command'))
    else {
      bash = classifyBash(toolInput.command, ctx, ready)
      reasons.push(...bash.reasons)
    }
  } else if (FILE_WRITE_TOOLS.includes(toolName) || toolName === 'Read') classifyFileTool(toolName, toolInput, ctx, ready, reasons)
  else if (['Grep', 'Glob'].includes(toolName)) {
    const location = resolveIn(typeof toolInput.path === 'string' ? toolInput.path : ctx.cwd, ctx.cwd)
    if (location && ancestorOfControl(location, ctx)) reasons.push(reason('floor.deck', 'destructive', location, 'reads a directory that holds the deck\'s own files'))
    if (location && candidates(location).some(candidate => isSensitive(candidate, ctx.home))) reasons.push(reason('read.secret', 'caution', location, 'reads a secret file'))
    for (const entry of matchToolEntries(toolName, ready, () => true)) reasons.push(reason(entry.id, entry.tier, location ?? '', entry.description ?? ''))
  } else if (toolName === 'WebFetch') {
    const host = hostOf(toolInput.url)
    if (host && ['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'].includes(host)) reasons.push(reason('floor.deck', 'destructive', String(toolInput.url), 'talks to a server on this machine, which may be the deck'))
    for (const entry of matchToolEntries(toolName, ready, entry => entry.domain === undefined || (host !== null && toolGlob(entry.domain).test(host)))) reasons.push(reason(entry.id, entry.tier, host ?? '', entry.description ?? ''))
  } else {
    const entries = matchToolEntries(toolName, ready, () => true)
    for (const entry of entries) reasons.push(reason(entry.id, entry.tier, toolName, entry.description ?? ''))
    if (entries.length === 1 && entries[0].tier === 'safe' && typeof entries[0].rule === 'string') ruleCandidate = entries[0].rule
  }
  if (!reasons.some(item => !item.entryId.startsWith('floor.'))) reasons.push(reason('unknown.tool', 'caution', toolName ?? '', 'no pattern matches this request'))
  if (legacyDestructive({ tool_name: toolName, tool_input: toolInput, cwd }, { repoRoot })) reasons.push(reason('floor.m1', 'destructive', '', 'matches a Destructive check of the M1 classifier'))
  // docs/deck/16-platforms.md section 6: a `C:\` path can escape the POSIX scope checks.
  if (platform === 'win32') reasons.push(reason('floor.platform', 'caution', '', 'Windows requests always ask: the tier rules read POSIX paths'))
  const tier = maxTier(...reasons.map(item => item.tier)) ?? 'caution'
  if (bash) {
    const segments = bash.parsed.ok ? bash.parsed.segments : []
    const only = segments.length === 1 ? segments[0] : null
    const safe = bash.safeEntries.length === 1 ? bash.safeEntries[0] : null
    if (tier === 'safe' && only && safe && !only.wrappers.length && !only.wrapperOptions && only.payloadOf === null && !only.redirects.length && typeof safe.entry.rule === 'string') {
      ruleCandidate = safe.entry.rule.replace('{script}', safe.script ?? '')
      ruleNote = safe.entry.ruleNote ?? null
    }
  }
  if (tier !== 'safe') ruleCandidate = null
  if (ruleCandidate === null) ruleNote = null
  const top = reasons.find(item => item.tier === tier && !item.entryId.startsWith('safe.')) ?? reasons.find(item => item.tier === tier)
  const entries = new Map((tiers.entries ?? []).map(entry => [entry.id, entry]))
  const confirmEntry = tier === 'destructive' ? reasons.map(item => entries.get(item.entryId)).find(entry => entry?.tier === 'destructive' && typeof entry.confirm === 'string') : null
  return {
    tier,
    reasons,
    ruleCandidate,
    ruleNote,
    confirm: { template: confirmEntry?.confirm ?? null, count: confirmEntry?.count ?? null },
    description: top?.description ?? ''
  }
}

/**
 * A per-repo cache of `git worktree list --porcelain` read through the Task 11 helper, so the
 * synchronous classifier can take worktrees. `get` returns the cached list (empty until the first
 * read finishes) and starts that read; `drop` forgets a repo, for WorktreeCreate and
 * WorktreeRemove hooks.
 * @param {{ read?: (root: string, args: string[]) => Promise<{ code: number, stdout: Buffer } | null> }} [options]
 */
export function createWorktreeCache({ read = gitRead } = {}) {
  const cache = new Map()
  const refresh = async root => {
    const result = await read(root, ['worktree', 'list', '--porcelain'])
    const list = result && result.code === 0 ? String(result.stdout).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9)).filter(tree => path.isAbsolute(tree)) : []
    const entry = cache.get(root)
    if (entry) entry.list = list
    return list
  }
  return {
    get(root) {
      if (typeof root !== 'string' || !path.isAbsolute(root)) return []
      const entry = cache.get(root)
      if (entry) return entry.list
      const fresh = { list: [] }
      cache.set(root, fresh)
      let directory = false
      try { directory = existsSync(root) && statSync(root).isDirectory() } catch {}
      fresh.pending = directory ? refresh(root) : Promise.resolve([])
      return fresh.list
    },
    async load(root) {
      this.get(root)
      await cache.get(root)?.pending
      return cache.get(root)?.list ?? []
    },
    drop(root) { cache.delete(root) },
    clear() { cache.clear() }
  }
}

/** The worktree cache request open uses. */
export const worktrees = createWorktreeCache()
