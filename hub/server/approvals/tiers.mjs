// The approvals tier classifier (docs/deck/07-approvals.md section 3, with the tier review changes
// adopted as D-75 to D-87). `classify` matches a permission request against the effective tiers
// set (tiers.default.json plus the user's tiers.json, see tiers-store.mjs), takes the highest
// matching tier, and then applies the floors, which are code and cannot be lowered or disabled.
import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitRead } from '../adapters/git-read.mjs'
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
const FILE_WRITE_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const GLOB_LIMIT = 1000
const GLOB_VISIT_LIMIT = 20000
// git subcommands whose unknown long options are at least Caution (F6).
const GIT_LONG_CHECKED = Object.freeze(['push', 'reset', 'clean', 'checkout', 'switch', 'restore', 'branch', 'rm', 'gc'])
const GIT_SAFE_GLOBALS = Object.freeze(['--no-pager', '-P'])

/** The sensitive list of 07-approvals 3.5 (F9), as written there. */
export const SENSITIVE_PATHS = Object.freeze(['~/.ssh/**', '~/.gnupg/**', '~/.aws/**', '~/.config/gh/**', '~/.netrc', '**/.env', '**/.env.*', '~/.claude/.credentials.json', '~/.git-credentials', '~/.npmrc', '~/.pypirc', '~/.docker/config.json', '~/.kube/config', '~/.config/gcloud/**', '~/.password-store/**', '~/.local/share/keyrings/**', '*.pem', '**/id_* (not *.pub)', '**/.envrc'])
/** The execution-config list of 07-approvals 3.5 (F4, D-80: not `.envrc`). */
export const EXECUTION_CONFIG = Object.freeze(['.cargo/config*', 'build.rs', 'package.json', '.npmrc', '.yarnrc*', 'Makefile', 'justfile', 'conftest.py', 'pyproject.toml', 'setup.py', 'go.mod', '.husky/**', '.githooks/**', '.github/workflows/**', '.claude/commands/**', '.claude/agents/**', '.claude/skills/**'])

const within = (target, root) => typeof target === 'string' && typeof root === 'string' && (target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`))

function realExisting(location) {
  let current = path.resolve(location)
  const missing = []
  for (;;) {
    try { return path.join(realpathSync(current), ...missing.reverse()) }
    catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(location)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function resolveIn(location, cwd) {
  if (typeof location !== 'string' || !location) return null
  if (path.isAbsolute(location)) return path.normalize(location)
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd, location) : null
}

const candidates = location => {
  const real = realExisting(location)
  return real === location ? [location] : [location, real]
}

function isPersistence(location, home) {
  if (!home) return false
  const rel = path.relative(home, location)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  return PERSISTENCE_FILES.includes(rel) || PERSISTENCE_DIRS.some(dir => rel === dir || rel.startsWith(`${dir}/`))
}

function isSensitive(location, home) {
  const base = path.basename(location)
  if (base === '.env' || base.startsWith('.env.') || base === '.envrc' || base.endsWith('.pem')) return true
  if (base.startsWith('id_') && !base.endsWith('.pub')) return true
  if (!home) return false
  const rel = path.relative(home, location)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  if (['.netrc', '.claude/.credentials.json', '.git-credentials', '.npmrc', '.pypirc', '.docker/config.json', '.kube/config'].includes(rel)) return true
  return ['.ssh', '.gnupg', '.aws', '.config/gh', '.config/gcloud', '.password-store', '.local/share/keyrings'].some(dir => rel === dir || rel.startsWith(`${dir}/`))
}

function isExecutionConfig(rel) {
  const parts = rel.split('/')
  const base = parts.at(-1)
  if (['build.rs', 'package.json', '.npmrc', 'Makefile', 'justfile', 'conftest.py', 'pyproject.toml', 'setup.py', 'go.mod'].includes(base) || base.startsWith('.yarnrc')) return true
  if (parts.at(-2) === '.cargo' && base.startsWith('config')) return true
  const dirs = parts.slice(0, -1)
  return dirs.some((part, k) => ['.husky', '.githooks'].includes(part)
    || (part === '.github' && dirs[k + 1] === 'workflows')
    || (part === '.claude' && ['commands', 'agents', 'skills'].includes(dirs[k + 1])))
}

const isClaudeSettingsPath = location => path.basename(location) === '.mcp.json' || /(?:^|\/)\.claude\/settings[^/]*\.json$/.test(location) || /(?:^|\/)\.claude\/hooks(?:\/|$)/.test(location)
const isGitInternal = location => location.split('/').includes('.git')

// Repo scope (07-approvals 3.5, F10): the repo root and its worktrees, by realpath; a worktree
// under `$HOME/.*` or a persistence location is not repo scope.
function repoScope(repoRoot, worktrees, home) {
  const roots = []
  if (typeof repoRoot === 'string' && path.isAbsolute(repoRoot)) roots.push(realExisting(repoRoot))
  for (const tree of Array.isArray(worktrees) ? worktrees : []) {
    if (typeof tree !== 'string' || !path.isAbsolute(tree)) continue
    const real = realExisting(tree)
    const rel = home ? path.relative(home, real) : '..'
    const hidden = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.startsWith('.')
    if (hidden || isPersistence(real, home) || (home && isPersistence(path.resolve(tree), home))) continue
    roots.push(real)
  }
  return roots
}

function scopeRelative(location, scope) {
  const real = realExisting(location)
  for (const root of scope) {
    if (!within(real, root)) continue
    const rel = path.relative(root, real)
    if (rel.split('/').includes('.git')) return null
    return rel
  }
  return null
}

function deckControls(deckPaths, home) {
  const env = { ...process.env, ...(home ? { HOME: home } : {}) }
  const defaults = setupPaths(env)
  const given = deckPaths ?? {}
  const config = given.config ?? defaults.config
  const state = given.state ?? defaults.state
  const runtime = given.runtime === undefined ? defaults.runtime : given.runtime
  const dirs = [config, state, runtime, given.token].filter(dir => typeof dir === 'string' && path.isAbsolute(dir))
  const all = new Set(dirs)
  for (const dir of dirs) all.add(realExisting(dir))
  const port = String(given.port ?? process.env.DECK_PORT ?? 47800)
  return { dirs: [...all], port }
}

const namesControl = (location, ctx) => candidates(location).some(candidate => ctx.deck.dirs.some(dir => within(candidate, dir)))
const ancestorOfControl = (location, ctx) => candidates(location).some(candidate => ctx.deck.dirs.some(dir => within(dir, candidate) || within(candidate, dir)))
const LOOPBACK = /(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d+)/i
const namesDeckPort = (text, ctx) => {
  const match = LOOPBACK.exec(text)
  return Boolean(match && match[1] === ctx.deck.port)
}

function context(input) {
  const home = typeof input.homeDir === 'string' && path.isAbsolute(input.homeDir) ? path.normalize(input.homeDir) : (process.env.HOME && path.isAbsolute(process.env.HOME) ? process.env.HOME : os.homedir())
  return {
    home,
    cwd: typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? path.normalize(input.cwd) : null,
    deck: deckControls(input.deckPaths, home),
    scope: repoScope(input.repoRoot, input.worktrees, home)
  }
}

const reason = (entryId, tier, segment, description) => ({ entryId, tier, segment, description })

// The verdict on one write target: a floor, "writes outside the repo", or null inside the scope.
function writeVerdict(location, ctx, segment) {
  if (location === null) return reason('scope.outside', 'caution', segment, 'writes outside the repo')
  if (DEV_NULLS.has(location)) return null
  const paths = candidates(location)
  if (paths.some(candidate => ctx.deck.dirs.some(dir => within(candidate, dir)))) return reason('floor.deck', 'destructive', segment, 'writes the deck\'s own files')
  const inside = scopeRelative(location, ctx.scope)
  if (paths.some(isClaudeSettingsPath) || (path.basename(location) === 'CLAUDE.md' && inside === null)) return reason('floor.claude-settings', 'destructive', segment, 'changes Claude Code settings or hooks')
  if (paths.some(isGitInternal)) return reason('floor.git-dir', 'destructive', segment, 'writes inside .git')
  if (paths.some(candidate => isPersistence(candidate, ctx.home))) return reason('floor.persistence', 'destructive', segment, 'runs at the next login or shell start')
  return inside === null ? reason('scope.outside', 'caution', segment, 'writes outside the repo') : null
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

// sed's script rule (F2): Safe only for a literal script with no e, w, W, r or R command and no
// e or w flag on s. Anything this reader does not understand is unsafe.
export function sedScriptSafe(script) {
  if (typeof script !== 'string') return false
  let i = 0
  const n = script.length
  const at = () => script[i]
  const skipSpace = () => { while (i < n && /[ \t]/.test(at())) i++ }
  const readDelimited = delim => {
    while (i < n) {
      const c = script[i]
      if (c === '\\') { i += 2; continue }
      if (c === '\n') return false
      i++
      if (c === delim) return true
    }
    return false
  }
  const readAddress = () => {
    const c = at()
    if (/[0-9]/.test(c)) { while (i < n && /[0-9~]/.test(at())) i++; return true }
    if (c === '$') { i++; return true }
    if (c === '/' || c === '\\') {
      let delim = '/'
      if (c === '\\') { delim = script[i + 1]; if (!delim || delim === '\n') return null; i += 2 } else i++
      if (!readDelimited(delim)) return null
      while (i < n && /[IM]/.test(at())) i++
      return true
    }
    return false
  }
  const toLineEnd = stops => { while (i < n && !stops.includes(at())) i++ }
  while (i < n) {
    while (i < n && /[\s;]/.test(at())) i++
    if (i >= n) break
    const first = readAddress()
    if (first === null) return false
    if (first) {
      skipSpace()
      if (at() === ',') {
        i++
        skipSpace()
        if (at() === '+' || at() === '~') { i++; while (i < n && /[0-9]/.test(at())) i++ }
        else if (readAddress() !== true) return false
      }
    }
    skipSpace()
    while (at() === '!') { i++; skipSpace() }
    const command = at()
    i++
    if ('{}=dDgGhHnNpPxzF'.includes(command)) continue
    if ('qQlL'.includes(command)) { skipSpace(); while (i < n && /[0-9]/.test(at())) i++; continue }
    if (command === '#') { toLineEnd('\n'); continue }
    if (':btTv'.includes(command)) { toLineEnd(';\n'); continue }
    if ('aic'.includes(command)) {
      while (i < n && at() !== '\n') { if (at() === '\\') i++; i++ }
      continue
    }
    if (command === 's' || command === 'y') {
      const delim = at()
      if (!delim || delim === '\\' || delim === '\n') return false
      i++
      if (!readDelimited(delim) || !readDelimited(delim)) return false
      if (command === 'y') continue
      while (i < n && !/[;\n}\s]/.test(at())) {
        if (!/[gpiImM0-9]/.test(at())) return false
        i++
      }
      continue
    }
    return false
  }
  return true
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

function gitConfigVerdict(rest, text) {
  const args = rest.slice(1)
  const valueOptions = ['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']
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

function classifySegment(segment, ctx, ready, out) {
  const text = segment.words.join(' ')
  const push = item => out.reasons.push(item)
  if (segment.wrappers.some(wrapper => PRIVILEGE_WORDS.includes(wrapper)) || segment.stdinShell) push(reason('floor.privilege', 'caution', text, 'runs as another user'))
  for (const assigned of segment.assignments) if (envFloor(assigned.name)) push(reason('floor.env', 'caution', text, `sets ${assigned.name}`))
  if (segment.payloadOf !== null) push(reason('floor.payload', 'caution', text, segment.remote ? 'runs on another host or in a container' : 'runs a command for another command'))
  for (const mount of segment.mounts) {
    const source = typeof mount.source === 'string' ? path.normalize(mount.source) : null
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
      const location = value && !/\s/.test(value) ? resolveIn(value, segment.cwd) : null
      if (location) optionValues.push({ location, word })
      continue
    }
    // A relative word with white space is a script or text argument (`sh -c 'echo x'`), not a path.
    if (!path.isAbsolute(word) && /\s/.test(word)) continue
    const location = resolveIn(word, segment.cwd)
    if (location) operands.push({ location, word })
  }
  // The deck floor reads operands only: an option value may be a pattern (`--regexp=cache/token`),
  // and the M1 floor already rates the options that read a file (machines.test.mjs pins both).
  const named = [...operands, ...optionValues]
  if (!TEXT_COMMANDS.includes(name) && operands.some(({ location }) => namesControl(location, ctx))) push(reason('floor.deck', 'destructive', text, 'names the deck\'s own files'))
  if (name === 'systemctl' && words.some(word => /^fleetmates-deck/.test(commandBase(word)))) push(reason('floor.deck', 'destructive', text, 'controls the deck\'s own services'))
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
  if (recursive) {
    const roots = operands.map(operand => operand.location)
    if (roots.length <= (['grep', 'rg', 'fd'].includes(name) ? 1 : 0) && segment.cwd) roots.push(segment.cwd)
    if (roots.some(root => ancestorOfControl(root, ctx))) push(reason('floor.deck', 'destructive', text, 'reads a directory that holds the deck\'s own files'))
  }
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
      if (word !== '-') targets.push(resolveIn(word, segment.cwd))
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
    if (list[1] === 'add' && list.slice(2).some(arg => !arg.startsWith('-') && (() => { const location = resolveIn(arg, segment.cwd); return location && candidates(location).some(candidate => isSensitive(candidate, ctx.home)) })())) push(reason('git.stages-secret', 'caution', text, 'stages a secret file'))
  }
  matchEntries(segment, ctx, ready, out, { name, list, text, words })
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
    const rel = scopeRelative(location, ctx.scope)
    if (rel !== null && isExecutionConfig(rel)) reasons.push(reason('file.execution-config', 'caution', shown, 'changes what a build, test or hook runs'))
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
 * realpath and glob checks of the paths it names.
 * @param {{ toolName: string, toolInput?: object, cwd?: string, repoRoot?: string, worktrees?: string[], homeDir?: string, deckPaths?: { config?: string, state?: string, runtime?: string|null, token?: string, port?: number|string }, tiers?: { entries: object[] } }} input
 * @returns {{ tier: 'safe'|'caution'|'destructive', reasons: { entryId: string, tier: string, segment: string, description: string }[], ruleCandidate: string|null, ruleNote: string|null, confirm: { template: string|null, count: string|null }, description: string }}
 */
export function classify(input) {
  const { toolName, cwd = null, repoRoot = null } = input ?? {}
  const toolInput = actionInput(toolName, input?.toolInput)
  const tiers = input?.tiers ?? DEFAULT_TIERS
  const ready = prepare(tiers)
  const ctx = context(input ?? {})
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
