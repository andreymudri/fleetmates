// Approval rules (docs/deck/07-approvals.md sections 6, 7 and 9; state-machines 2.8): the rule
// suggestion machine per (repo, pattern), pattern validation for rules added by hand (7.3, F13),
// the safe writer and revoker of `<repo>/.claude/settings.local.json` (7.2, 9) and the deck's
// mirror of the rules found there (7.4, SET-O5). The settings file is the source of truth; the
// `rules` table is only a mirror with the source and date of each rule.
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { gitRead as defaultGitRead } from '../adapters/git-read.mjs'
import { apiError } from '../http/router.mjs'
import { matchKey } from '../machines/request.mjs'
import { setupPaths } from '../setup/paths.mjs'
import { commandBase } from './shell.mjs'
import { activeTiers, classify as defaultClassify } from './tiers.mjs'

/** Copy of the refusals (07-approvals 7.3, Decided; the script line is D-86). */
export const RULE_COPY = Object.freeze({
  destructive: 'Destructive commands can never become rules.',
  script: 'Script rules name one script exactly.',
  invalid: 'Not a Claude Code permission pattern.',
  // docs/deck/16-platforms.md section 6: on Windows every request asks, and a rule would not.
  unsupported: 'Rules are not written on Windows: every request asks there.'
})

/** The default suggestion threshold (07-approvals 6, Decided). */
export const DEFAULT_THRESHOLD = 5
/** Backups kept per repo (07-approvals 7.2 step 6). */
export const BACKUPS_KEPT = 20
/** Write attempts before `settings_changed` (07-approvals 7.2 step 7). */
export const WRITE_ATTEMPTS = 3

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Text that names Claude Code settings or the deck's own controls (07-approvals 7.3).
const CONTROL_TEXT = [/\.claude\/settings/i, /settings(?:\.local)?\.json/i, /\.claude\.json/i, /fleetmates[/-]deck/i, /deckd/i, /\bdeck[-.]token\b/i]
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * The rule refused or accepted by {@link validatePattern}.
 * @typedef {{ ok: true, pattern: string, tool: string, tier: 'safe'|'caution', warning: 'toolWide'|null } | { ok: false, code: 'invalid_pattern'|'destructive_rule', message: string }} PatternVerdict
 */

/**
 * The canonical form of a pattern for equivalence (07-approvals 7.1): `Bash(x:*)` and `Bash(x *)`
 * are the same rule, and inner whitespace runs count as one space.
 * @param {string} pattern
 * @returns {string}
 */
export function canonicalPattern(pattern) {
  const text = String(pattern ?? '').trim()
  const bash = /^Bash\((.*)\)$/s.exec(text)
  if (!bash) return text
  let inner = bash[1].trim().replace(/\s+/g, ' ')
  if (inner.endsWith(':*')) inner = `${inner.slice(0, -2).trimEnd()} *`
  return `Bash(${inner})`
}

/**
 * Whether two patterns are the same rule (07-approvals 7.1).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function samePattern(a, b) {
  return canonicalPattern(a) === canonicalPattern(b)
}

/**
 * The settings file rules are written to: `<repo>/.claude/settings.local.json`.
 * @param {string} repoRoot
 * @returns {string}
 */
export function settingsPath(repoRoot) {
  return path.join(repoRoot, '.claude', 'settings.local.json')
}

/**
 * The suggestion threshold from the `ruleSuggestAfter` preference (3, 5, or null for Never).
 * @param {{ get: Function }} store
 * @returns {number|null}
 */
export function ruleThreshold(store) {
  try {
    const row = store.get('SELECT value FROM prefs WHERE key = ?', 'ruleSuggestAfter')
    if (!row) return DEFAULT_THRESHOLD
    const value = JSON.parse(row.value)
    return value === null ? null : Number.isInteger(value) && value > 0 ? value : DEFAULT_THRESHOLD
  } catch { return DEFAULT_THRESHOLD }
}

/**
 * The `ruleNote` of the tiers entry whose `rule` is this pattern (`anyFlags`, D-78), or null. Since
 * D-103 no default tiers entry carries one, so only a user tiers table can give a note.
 * @param {string} pattern
 * @param {{ entries?: object[] }} [tiers]
 * @returns {string|null}
 */
export function ruleNoteFor(pattern, tiers = activeTiers()) {
  const entry = (tiers?.entries ?? []).find(item => item?.tier === 'safe' && typeof item.rule === 'string' && samePattern(item.rule, pattern))
  return typeof entry?.ruleNote === 'string' ? entry.ruleNote : null
}

// ---------------------------------------------------------------------------------------------
// Reading the settings file

function fail(file, errno) {
  return apiError(500, 'settings_io_failed', { path: file, errno })
}

function parseError(error) {
  const at = /position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(String(error?.message ?? ''))
  if (at?.[2]) return `not valid JSON (line ${at[2]}, column ${at[3]})`
  return at ? `not valid JSON (position ${at[1]})` : 'not valid JSON'
}

// Steps 1 to 4 of 07-approvals 7.2: the realpath of the repo, the lstat checks of `.claude` and
// the target, the parse and the type checks. Never follows a symlink at `.claude` or the target.
function readSettings(repoRoot, { create = false } = {}) {
  let root
  try { root = realpathSync(repoRoot) } catch (error) { throw fail(settingsPath(repoRoot), error.code ?? 'not found') }
  const dir = path.join(root, '.claude')
  const file = settingsPath(root)
  let dirInfo = null
  try { dirInfo = lstatSync(dir) } catch (error) { if (error.code !== 'ENOENT') throw fail(file, error.code) }
  if (dirInfo && (dirInfo.isSymbolicLink() || !dirInfo.isDirectory())) throw fail(file, 'not a regular file')
  let info = null
  if (dirInfo) {
    try { info = lstatSync(file) } catch (error) { if (error.code !== 'ENOENT') throw fail(file, error.code) }
  }
  if (info && (info.isSymbolicLink() || !info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) throw fail(file, 'not a regular file')
  let bytes = null
  let data = {}
  if (info) {
    try { bytes = readFileSync(file) } catch (error) { throw fail(file, error.code ?? 'unreadable') }
    try { data = JSON.parse(bytes.toString('utf8')) } catch (error) { throw fail(file, parseError(error)) }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail(file, 'the top level is not an object')
  }
  if (Object.hasOwn(data, 'permissions') && (!data.permissions || typeof data.permissions !== 'object' || Array.isArray(data.permissions))) throw fail(file, 'permissions is not an object')
  if (data.permissions && Object.hasOwn(data.permissions, 'allow') && !Array.isArray(data.permissions.allow)) throw fail(file, 'permissions.allow is not an array')
  if (create && !dirInfo) mkdirSync(dir, { mode: 0o700 })
  return { root, dir, file, bytes, data, mode: info ? info.mode & 0o777 : 0o600 }
}

function allowList(data) {
  return Array.isArray(data?.permissions?.allow) ? data.permissions.allow.filter(item => typeof item === 'string') : []
}

function sameBytes(a, b) {
  if (a === null || b === null) return a === b
  return Buffer.compare(a, b) === 0
}

function currentBytes(file) {
  try {
    const info = lstatSync(file)
    if (!info.isFile()) return Buffer.from('not a file')
    return readFileSync(file)
  } catch (error) { return error.code === 'ENOENT' ? null : Buffer.from(`error ${error.code}`) }
}

const sha256 = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex')

function stamp(at) {
  const date = new Date(at)
  const two = value => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}-${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}`
}

const BACKUP_NAME = /^(\d{8}-\d{6})(?:-(\d+))?\.json$/

/**
 * The backup directory of a repo: `<state>/backups/rules/<sha256(repo path)>`.
 * @param {string} stateDir
 * @param {string} repoRoot the realpath of the repo
 * @returns {string}
 */
export function backupDir(stateDir, repoRoot) {
  return path.join(stateDir, 'backups', 'rules', createHash('sha256').update(repoRoot).digest('hex'))
}

function backup(stateDir, root, bytes, at) {
  const dir = backupDir(stateDir, root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (let up = dir; up.startsWith(stateDir) && up !== stateDir; up = path.dirname(up)) chmodSync(up, 0o700)
  const base = stamp(at)
  let name = `${base}.json`
  for (let n = 1; ; n++) {
    let fd
    try { fd = openSync(path.join(dir, name), 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      name = `${base}-${String(n).padStart(4, '0')}.json`
      continue
    }
    try { writeSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    break
  }
  return path.join(dir, name)
}

// Keep the newest BACKUPS_KEPT backups of a repo. Called after a successful rename only, so a
// restarted attempt never costs an older backup.
function prune(backupPath) {
  const dir = path.dirname(backupPath)
  const kept = readdirSync(dir).map(entry => ({ entry, match: BACKUP_NAME.exec(entry) })).filter(item => item.match)
    .sort((a, b) => a.match[1] < b.match[1] ? 1 : a.match[1] > b.match[1] ? -1 : Number(b.match[2] ?? 0) - Number(a.match[2] ?? 0))
  for (const old of kept.slice(BACKUPS_KEPT)) unlinkSync(path.join(dir, old.entry))
}

// Steps 3 to 8 of 07-approvals 7.2 with `change` as step 5. `change(data)` returns false when there
// is nothing to write. Every call is synchronous so two writes in one process never interleave.
function rewrite(repoRoot, { change, verify, stateDir, at, beforeRename, create = false }) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const read = readSettings(repoRoot, { create })
    const data = read.data
    const result = change(data)
    if (result === false) return { changed: false, read }
    const text = `${JSON.stringify(data, null, 2)}\n`
    const temp = path.join(read.dir, `.settings.local.json.deck-tmp-${process.pid}`)
    try { unlinkSync(temp) } catch {}
    let fd
    try {
      fd = openSync(temp, 'wx', read.mode)
      writeSync(fd, text)
      fsyncSync(fd)
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd) } catch {} }
      try { unlinkSync(temp) } catch {}
      throw fail(read.file, error.code ?? 'write failed')
    }
    closeSync(fd)
    try { chmodSync(temp, read.mode) } catch {}
    // Step 6 (backup) before step 7 (re-read compare), so only the compare-to-rename gap is left
    // for a concurrent writer. A restarted attempt drops its backup of the stale bytes.
    const backupPath = read.bytes === null ? null : backup(stateDir, read.root, read.bytes, at)
    beforeRename?.(attempt)
    if (!sameBytes(currentBytes(read.file), read.bytes)) {
      try { unlinkSync(temp) } catch {}
      if (backupPath) { try { unlinkSync(backupPath) } catch {} }
      continue
    }
    try { renameSync(temp, read.file) } catch (error) {
      try { unlinkSync(temp) } catch {}
      throw fail(read.file, error.code ?? 'rename failed')
    }
    if (backupPath) prune(backupPath)
    const after = readSettings(read.root)
    if (!verify(allowList(after.data))) throw fail(read.file, 'the rule was not found once after the write')
    return { changed: true, read, after, backupPath, beforeSha256: sha256(read.bytes), afterSha256: sha256(after.bytes) }
  }
  throw apiError(409, 'settings_changed', { path: settingsPath(repoRoot) })
}

// ---------------------------------------------------------------------------------------------
// Pattern validation (07-approvals 7.3, F13, D-86)

function refused(code, message) {
  return { ok: false, code, message }
}

/**
 * The persistence floor of tiers.mjs (`PERSISTENCE_FILES` and `PERSISTENCE_DIRS`, home-relative),
 * copied because tiers.mjs does not export them; validate.test.mjs keeps the copies equal.
 */
export const PERSISTENCE_FILES = Object.freeze(['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.config/fish/config.fish'])
export const PERSISTENCE_DIRS = Object.freeze(['.config/fish/conf.d', '.config/hypr', '.config/systemd/user', '.config/autostart'])

// Tools whose rule specifier is a path glob (Claude Code permission syntax).
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS'])
const GLOB_CHARS = /[*?[\]{}]/
// npm's names for `run` (npm help run: run-script, rum, urn).
const NPM_RUN = ['run', 'run-script', 'rum', 'urn']
// pnpm subcommands that are not scripts. pnpm runs any other first word as a script, so without a
// word boundary a prefix naming one could reach another script (D-86). `test`, `t` and `start` run
// scripts and are left out.
const PNPM_BUILTINS = ['add', 'install', 'i', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'link', 'ln', 'unlink', 'import', 'rebuild', 'rb', 'prune', 'fetch', 'patch', 'patch-commit', 'audit', 'list', 'ls', 'll', 'la', 'outdated', 'why', 'licenses', 'exec', 'dlx', 'create', 'publish', 'pack', 'store', 'root', 'bin', 'env', 'setup', 'init', 'deploy', 'config', 'get', 'set', 'server', 'doctor', 'help']

const absolute = value => typeof value === 'string' && path.isAbsolute(value)
const fold = value => String(value).normalize('NFKC').toLowerCase()

// The real path of `location`, or of its nearest existing ancestor joined with the rest.
function realExisting(location) {
  let current = location
  const rest = []
  for (let depth = 0; depth < 64; depth++) {
    try { return path.join(realpathSync(current), ...rest.reverse()) } catch {}
    const parent = path.dirname(current)
    if (parent === current) return location
    rest.push(path.basename(current))
    current = parent
  }
  return location
}

// The deck's controls (F9) and Claude Code's settings directory, for `env` with `homeDir` as HOME.
function deckContext({ env = process.env, homeDir = null, platform = process.platform } = {}) {
  const given = platform === 'win32' ? typeof homeDir === 'string' && path.win32.isAbsolute(homeDir) : absolute(homeDir)
  const base = { ...env, ...(given ? { HOME: homeDir } : {}) }
  let paths = {}
  try { paths = setupPaths(base, { platform }) } catch {}
  const home = given ? homeDir : paths.home
  const controls = [paths.config, paths.state, paths.share, paths.runtime, paths.token].filter(absolute)
  return {
    home,
    port: String(base.DECK_PORT ?? 47800),
    token: paths.token,
    controls,
    claudeDir: absolute(paths.settings) ? path.dirname(paths.settings) : null,
    deckPaths: { config: paths.config, state: paths.state, runtime: paths.runtime ?? null, token: paths.token, port: base.DECK_PORT ?? 47800 }
  }
}

function namesControl(text, ctx) {
  if (CONTROL_TEXT.some(pattern => pattern.test(text))) return true
  return ctx.controls.some(dir => text.includes(dir) || (absolute(ctx.home) && dir.startsWith(`${ctx.home}/`) && text.includes(`~/${dir.slice(ctx.home.length + 1)}`)))
}

// The paths a rule's glob can start from, as Claude Code reads the specifier: `//p` is absolute,
// `~/p` is under the home directory, `/p` is relative to the settings file (taken here as absolute,
// the repo root and the repo's `.claude` directory, to fail closed) and anything else is relative to
// the repo. Each is the glob's literal root: the components before the first one with a glob
// character. Null for a form the deck does not read (`~user/`, variables).
function globRoots(spec, { repoRoot, home }) {
  if (spec.includes('$') || /^~[^/]/.test(spec) || (spec.startsWith('~') && !absolute(home))) return null
  const literal = text => {
    const parts = text.split('/')
    const at = parts.findIndex(part => GLOB_CHARS.test(part))
    return at < 0 ? text : parts.slice(0, at).join('/')
  }
  const base = absolute(repoRoot) ? repoRoot : process.cwd()
  if (spec.startsWith('//')) return [path.resolve('/', literal(spec.slice(1)) || '/')]
  if (spec === '~' || spec.startsWith('~/')) return [path.resolve(home, literal(spec.slice(2)) || '.')]
  if (spec.startsWith('/')) {
    const rest = literal(spec.slice(1)) || '.'
    return [path.resolve('/', rest), path.resolve(base, rest), path.resolve(base, '.claude', rest)]
  }
  return [path.resolve(base, literal(spec) || '.')]
}

// Paths no allow rule may cover, hold or sit inside: the deck controls (F9), Claude Code settings
// (the user's settings directory and the repo's `.claude/settings*.json`, `.claude/hooks` and
// `.mcp.json`), the repo's `.git` and the persistence floor.
function protectedTargets(ctx, repoRoot) {
  const list = [...ctx.controls]
  if (ctx.claudeDir) list.push(ctx.claudeDir)
  if (absolute(ctx.home)) {
    list.push(path.join(ctx.home, '.claude'))
    for (const name of [...PERSISTENCE_FILES, ...PERSISTENCE_DIRS]) list.push(path.join(ctx.home, name))
  }
  if (absolute(repoRoot)) for (const name of ['.git', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.mcp.json']) list.push(path.join(repoRoot, name))
  return [...new Set([...list, ...list.map(realExisting)])]
}

// Whether `a` and `b` are the same path or one holds the other (case folded).
function related(a, b) {
  const one = fold(a)
  const two = fold(b)
  const down = path.relative(one, two)
  const up = path.relative(two, one)
  const inside = rel => rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  return inside(down) || inside(up)
}

// The deck's launchd agents (the persistence floor of tiers.mjs, docs/deck/16-platforms.md): a root
// that is one of them, lies inside one, or holds `~/Library/LaunchAgents` (and so the agents).
const LAUNCH_AGENTS = 'library/launchagents'
const LAUNCH_AGENT_PREFIX = 'io.fleetmates.deck.'
function reachesLaunchAgent(root, home) {
  if (!absolute(home)) return false
  const rel = path.relative(fold(home), fold(root)).split(path.sep).join('/')
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  if (rel === '' || LAUNCH_AGENTS === rel || LAUNCH_AGENTS.startsWith(`${rel}/`)) return true
  return rel.startsWith(`${LAUNCH_AGENTS}/`) && rel.slice(LAUNCH_AGENTS.length + 1).startsWith(LAUNCH_AGENT_PREFIX)
}

// A root that names a `.git` directory, Claude Code settings or hooks by its components, in any repo.
function namesProtectedComponent(root) {
  const parts = fold(root).split('/')
  if (parts.includes('.git') || parts.at(-1) === '.mcp.json') return true
  const at = parts.lastIndexOf('.claude')
  return at >= 0 && at < parts.length - 1 && (/^settings[^/]*\.json$/.test(parts[at + 1]) || parts[at + 1] === 'hooks')
}

function pathVerdict(tool, spec, { classify, tiers, repoRoot, ctx }) {
  if (!spec.trim() || spec !== spec.trim()) return refused('invalid_pattern', RULE_COPY.invalid)
  const roots = globRoots(spec, { repoRoot, home: ctx.home })
  if (!roots) return refused('invalid_pattern', RULE_COPY.invalid)
  const targets = protectedTargets(ctx, repoRoot)
  const candidates = [...new Set([...roots, ...roots.map(realExisting)])]
  if (namesControl(spec, ctx) || candidates.some(root => namesProtectedComponent(root) || reachesLaunchAgent(root, ctx.home) || targets.some(target => related(root, target)))) return refused('destructive_rule', RULE_COPY.destructive)
  if (tool !== 'Read') return refused('invalid_pattern', RULE_COPY.invalid)
  const result = classify({ toolName: 'Read', toolInput: { file_path: roots[0] }, cwd: repoRoot ?? null, repoRoot: repoRoot ?? null, homeDir: ctx.home, deckPaths: ctx.deckPaths, tiers, platform: ctx.platform })
  if (result.tier === 'destructive') return refused('destructive_rule', RULE_COPY.destructive)
  return { ok: true, pattern: `${tool}(${spec})`, tool, tier: result.tier, warning: null }
}

/**
 * Arguments that, appended to a Bash prefix, make the command reach a Destructive floor of
 * tiers.mjs. Each probe names its floor and a carrier command that reaches the floor with it, which
 * validate.test.mjs runs; the same test fails when tiers.mjs gains a Destructive floor that has
 * neither a probe nor an entry in {@link FLOOR_PROBE_EXEMPT}.
 * On win32 the home and deck paths are Windows paths, named in single quotes so the backslashes
 * reach the command as written (Claude Code runs the Bash tool through Git Bash there).
 * @param {{ env?: object, homeDir?: string|null, platform?: string }} [options]
 * @returns {{ floor: string, carrier: string, args: string }[]}
 */
export function floorProbes({ env = process.env, homeDir = null, platform = process.platform } = {}) {
  const ctx = deckContext({ env, homeDir, platform })
  const home = ctx.home
  const win = platform === 'win32'
  const isAbsolute = value => typeof value === 'string' && (win ? path.win32 : path.posix).isAbsolute(value)
  const at = (...parts) => win ? `'${path.win32.join(home, ...parts)}'` : `${home}/${parts.join('/')}`
  const probes = [
    { floor: 'floor.git-config-write', carrier: 'git config', args: 'core.hooksPath /tmp/x' },
    { floor: 'floor.git-config-write', carrier: 'git config', args: 'core.fsmonitor x' },
    { floor: 'floor.git-config-write', carrier: 'git config', args: 'alias.x x' },
    { floor: 'floor.git-config-write', carrier: 'git config', args: '--edit' },
    { floor: 'floor.git-c', carrier: 'git', args: '-c core.pager=x status' },
    { floor: 'floor.git-dir', carrier: 'cp', args: 'x .git/hooks/pre-commit' },
    { floor: 'floor.git-dir', carrier: 'tee', args: '.git/hooks/pre-commit' },
    { floor: 'floor.claude-settings', carrier: 'cp', args: 'x .claude/settings.json' },
    { floor: 'floor.claude-settings', carrier: 'tee', args: '.claude/settings.local.json' },
    { floor: 'floor.mount', carrier: 'docker run', args: '-v /:/host x' },
    { floor: 'floor.privileged', carrier: 'docker run', args: '--privileged x' }
  ]
  if (isAbsolute(home)) {
    probes.push({ floor: 'floor.claude-settings', carrier: 'cp', args: `x ${at('.claude', 'settings.json')}` })
    probes.push({ floor: 'floor.persistence', carrier: 'cp', args: `x ${at('.bashrc')}` })
    probes.push({ floor: 'floor.persistence', carrier: 'tee', args: at('.bashrc') })
  }
  // floor.deck is probed by its write form only: the classifier also rates any command that merely
  // names a deck control Destructive, which `probeReaches` subtracts, so a read of the token
  // (`cat <token>`) is not something a probe can tell from a mention (`cargo test <token>`).
  if (isAbsolute(ctx.token)) probes.push({ floor: 'floor.deck', carrier: 'cp', args: `x ${win ? `'${ctx.token}'` : ctx.token}` })
  return probes
}

/**
 * Destructive floors with no probe, and why none is needed.
 */
export const FLOOR_PROBE_EXEMPT = Object.freeze({
  'floor.network-interpreter': 'needs a fetch command piped into an interpreter: no fetch command or interpreter is the rule of a Safe tiers entry, the only prefix rules accepted (D-101), and a pipe is a second command, which a prefix rule does not approve (07-approvals 7.1)',
  'floor.m1': 'the M1 checks (deck controls, sensitive writes, destructive MCP tools and SQL, rm-style commands) are covered by the deck, write and persistence probes above and by the Destructive entries the prefix is compared with'
})

// Whether a Bash prefix is an npm or pnpm script rule in any form (D-86): `run` (or an npm alias of
// it) anywhere after the command word, options included, or a pnpm first word that is not a known
// non-script subcommand.
function scriptPrefix(words) {
  const name = commandBase(words[0])
  if (!['npm', 'pnpm'].includes(name)) return false
  const rest = words.slice(1)
  if (rest.some(word => NPM_RUN.includes(word))) return true
  if (name !== 'pnpm') return false
  const first = rest.find(word => !word.startsWith('-'))
  return first === undefined || !PNPM_BUILTINS.includes(first)
}

// The rule of a Safe tiers entry that this pattern equals, if any (`{script}` templates excluded).
function safeEntryRule(pattern, tiers) {
  return (tiers?.entries ?? []).some(entry => entry?.tier === 'safe' && typeof entry.rule === 'string' && !entry.rule.includes('{') && samePattern(entry.rule, pattern))
}

function wordGlob(word) {
  return new RegExp(`^${word.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}

// Whether a Bash prefix could run a command a Destructive entry matches: the prefix is a prefix of
// the entry's command words (`git` reaches `git push`) or the entry's words are a prefix of it
// (`git push origin` is still `git push`).
function reachesDestructive(words, tiers) {
  const base = [commandBase(words[0]), ...words.slice(1)]
  for (const entry of tiers?.entries ?? []) {
    if (entry?.tier !== 'destructive' || entry.tool !== 'Bash' || typeof entry.cmd !== 'string') continue
    const cmd = entry.cmd.trim().split(/\s+/)
    const shared = Math.min(cmd.length, base.length)
    let match = true
    for (let i = 0; i < shared && match; i++) match = i === 0 ? wordGlob(cmd[0]).test(base[0]) : cmd[i] === base[i]
    if (match) return true
  }
  return false
}

function toolGlob(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
}

const destructiveReasons = result => new Set(result.reasons.filter(item => item.tier === 'destructive').map(item => `${item.entryId}\u0000${item.description}`))

/**
 * Whether `<prefix> <args>` reaches a Destructive reason that `true <args>` does not. The baseline
 * removes the floors the classifier raises on the argument text alone (any command naming a deck
 * control is Destructive, whatever it does), which every prefix would otherwise share, so what is
 * left is what the prefix's command does with its arguments: a write, a git config key.
 * @param {(command: string) => { reasons: object[] }} run
 * @param {string} prefix
 * @param {string} args
 * @returns {boolean}
 */
export function probeReaches(run, prefix, args) {
  const baseline = destructiveReasons(run(`true ${args}`))
  return [...destructiveReasons(run(`${prefix} ${args}`))].some(key => !baseline.has(key))
}

function bashVerdict(pattern, inner, { classify, tiers, repoRoot, ctx }) {
  const body = inner.trim()
  if (body === '*' || body === '') return refused(body === '*' ? 'destructive_rule' : 'invalid_pattern', body === '*' ? RULE_COPY.destructive : RULE_COPY.invalid)
  let prefix = null
  let exact = null
  if (body.endsWith(':*')) prefix = body.slice(0, -2).trim()
  else if (/\s\*$/.test(body)) prefix = body.slice(0, -1).trim()
  else exact = body
  const command = prefix ?? exact
  if (!command || command.includes('*') || /[\u0000-\u001f\u007f]/.test(command)) return refused('invalid_pattern', RULE_COPY.invalid)
  const words = command.split(/\s+/)
  if (prefix !== null && scriptPrefix(words)) return refused('invalid_pattern', RULE_COPY.script)
  if (namesControl(command, ctx)) return refused('destructive_rule', RULE_COPY.destructive)
  // D-101: a prefix rule must be the rule of a Safe tiers entry. Such a rule then still goes through
  // the Destructive entries, classify and the floor probes below, and is reported at tier safe.
  const own = prefix !== null && safeEntryRule(pattern, tiers)
  if (prefix !== null && !own) return refused('destructive_rule', RULE_COPY.destructive)
  if (prefix !== null && reachesDestructive(words, tiers)) return refused('destructive_rule', RULE_COPY.destructive)
  const run = text => classify({ toolName: 'Bash', toolInput: { command: text }, cwd: repoRoot ?? null, repoRoot: repoRoot ?? null, homeDir: ctx.home, deckPaths: ctx.deckPaths, tiers, platform: ctx.platform })
  const result = run(command)
  if (result.tier === 'destructive') return refused('destructive_rule', RULE_COPY.destructive)
  if (prefix !== null && floorProbes({ env: ctx.env, homeDir: ctx.home, platform: ctx.platform }).some(probe => probeReaches(run, prefix, probe.args))) return refused('destructive_rule', RULE_COPY.destructive)
  return { ok: true, pattern, tool: 'Bash', tier: own ? 'safe' : result.tier, warning: null }
}

/**
 * Validate a rule pattern before it is written (07-approvals 7.3 and F13; D-86 for script rules).
 * Accepts `Bash(<prefix>:*)`, `Bash(<prefix> *)`, `Bash(<exact>)`, `WebFetch(domain:<host>)`,
 * `mcp__<server>__<tool>`, `Read(<glob>)` and tool-wide rules other than Bash and the file tools
 * (those carry `warning: 'toolWide'`). Refuses with `destructive_rule` and "Destructive commands
 * can never become rules.":
 * - a bare `Bash` or `Bash(*)`, and the tool-wide file tool rules;
 * - a Bash prefix that is not the rule of a Safe tiers entry (D-101), and one that is but reaches a
 *   Destructive entry or a Destructive floor with any of the {@link floorProbes} arguments;
 * - a Bash pattern the classifier rates Destructive, and a pattern naming the deck's controls or
 *   Claude Code settings;
 * - a path rule (`Read`, the file tools, `Glob`, `Grep`, `LS`) whose glob root, with `~` and `//`
 *   expanded, is, holds or lies inside a deck control, Claude Code settings, a `.git` directory or
 *   a persistence floor path.
 * An npm or pnpm script prefix, in any option layout, is `invalid_pattern` with "Script rules name
 * one script exactly."; anything else outside the syntax is `invalid_pattern`.
 * On win32 every pattern is refused with `rules_unsupported_on_win32` (docs/deck/16-platforms.md
 * section 6): nothing is auto-approved there, and a written rule would auto-approve inside Claude Code.
 * @param {string} pattern
 * @param {{ classify?: Function, tiers?: { entries: object[] }, repoRoot?: string|null, homeDir?: string|null, env?: object, platform?: string }} [options]
 * @returns {PatternVerdict}
 */
export function validatePattern(pattern, options = {}) {
  const { platform = process.platform } = options
  if (platform === 'win32') return refused('rules_unsupported_on_win32', RULE_COPY.unsupported)
  return judgePattern(pattern, { ...options, platform })
}

// The checks of validatePattern without the win32 refusal, which the mirror uses to mark a rule found
// in a settings file Destructive whatever the platform.
function judgePattern(pattern, { classify = defaultClassify, tiers = activeTiers(), repoRoot = null, homeDir = null, env = process.env, platform = process.platform } = {}) {
  if (typeof pattern !== 'string') return refused('invalid_pattern', RULE_COPY.invalid)
  const text = pattern.trim()
  if (!text || text !== pattern || text.length > 1000 || /[\u0000-\u001f\u007f]/.test(text)) return refused('invalid_pattern', RULE_COPY.invalid)
  const ctx = { ...deckContext({ env, homeDir, platform }), env, platform }
  const call = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/s.exec(text)
  if (!call) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(text)) return refused('invalid_pattern', RULE_COPY.invalid)
    if (text === 'Bash' || FILE_TOOLS.has(text)) return refused('destructive_rule', RULE_COPY.destructive)
    if (text.startsWith('mcp__')) {
      const tool = /^mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+$/.test(text)
      if (!tool && !/^mcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/.test(text)) return refused('invalid_pattern', RULE_COPY.invalid)
      if (!tool) {
        // A server-wide rule reaches any tool of the server, so any Destructive MCP entry that can match a tool of it refuses it.
        const reach = (tiers?.entries ?? []).some(entry => entry?.tier === 'destructive' && typeof entry.tool === 'string' && entry.tool.startsWith('mcp__') && toolGlob(entry.tool).test(`${text}__x_delete_x`))
        if (reach || namesControl(text, ctx)) return refused('destructive_rule', RULE_COPY.destructive)
        return { ok: true, pattern: text, tool: text, tier: 'caution', warning: 'toolWide' }
      }
      const result = classify({ toolName: text, toolInput: {}, tiers, platform })
      if (result.tier === 'destructive' || namesControl(text, ctx)) return refused('destructive_rule', RULE_COPY.destructive)
      return { ok: true, pattern: text, tool: text, tier: result.tier, warning: null }
    }
    return { ok: true, pattern: text, tool: text, tier: 'caution', warning: 'toolWide' }
  }
  const [, tool, inner] = call
  if (tool === 'Bash') return bashVerdict(text, inner, { classify, tiers, repoRoot, ctx })
  if (PATH_TOOLS.has(tool)) return pathVerdict(tool, inner, { classify, tiers, repoRoot, ctx })
  if (tool === 'WebFetch') {
    const host = /^domain:([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$/.exec(inner)?.[1]?.toLowerCase()
    if (!host || host.includes('..')) return refused('invalid_pattern', RULE_COPY.invalid)
    if (LOOPBACK_HOSTS.has(host) || /^127\./.test(host)) return refused('destructive_rule', RULE_COPY.destructive)
    const result = classify({ toolName: 'WebFetch', toolInput: { url: `https://${host}/` }, tiers, platform })
    if (result.tier === 'destructive') return refused('destructive_rule', RULE_COPY.destructive)
    return { ok: true, pattern: text, tool, tier: result.tier, warning: null }
  }
  return refused('invalid_pattern', RULE_COPY.invalid)
}

// ---------------------------------------------------------------------------------------------
// The suggestion machine (state-machines 2.8)

function repoName(store, repoId) {
  return store.get('SELECT name FROM repos WHERE id = ?', repoId)?.name ?? path.basename(repoId)
}

function offerView(store, row, threshold, tiers) {
  return { repoId: row.repo_id, repoKey: repoName(store, row.repo_id), pattern: row.pattern, count: row.count, threshold, ruleNote: ruleNoteFor(row.pattern, tiers) }
}

function inSettings(repoRoot, pattern) {
  try { return allowList(readSettings(repoRoot).data).some(item => samePattern(item, pattern)) } catch { return false }
}

function permissionPid(store, row, at) {
  const rows = store.all("SELECT claude_pid, payload FROM hook_events WHERE session_id = ? AND event = 'PermissionRequest' AND hook_ts BETWEEN ? AND ? ORDER BY hook_ts DESC, id DESC", row.session_id, row.created_at - 2000, at)
  for (const item of rows) {
    try { if (matchKey(JSON.parse(item.payload)) === row.match_key) return item.claude_pid ?? null } catch {}
  }
  return null
}

function closingPid(store, row, at) {
  const rows = store.all("SELECT claude_pid, payload FROM hook_events WHERE session_id = ? AND event = 'PostToolUse' AND hook_ts = ? ORDER BY id DESC", row.session_id, at)
  for (const item of rows) {
    try { if (matchKey(JSON.parse(item.payload)) === row.match_key) return item.claude_pid ?? null } catch {}
  }
  return null
}

/**
 * Count an allowed request toward "Make it a rule?" (07-approvals 6, state-machines 2.8), inside the
 * caller's transaction. It counts only when the request is a permission that was allowed, its tier
 * was `safe` at answer time, it has a `rule_pattern` (D-74), the pattern is not already in the repo's
 * settings file, and the threshold is not Never (null). For `via: 'terminal'` the request's
 * `PermissionRequest` row and the closing `PostToolUse` row in `hook_events` must carry the same
 * non-null `claude_pid` (F16); `closingPid` stands in for the closing row while its hook is being
 * applied and the row is not written yet. Reaching the threshold sets the machine to `offered` and
 * appends `rule.offered` (a RuleOffer with `ruleNote`). A pattern found in the settings file sets the
 * machine to `accepted` instead.
 * @param {{ get: Function, all: Function, run: Function, appendEvent: Function }} store
 * @param {{ id: string }} request a `requests` row, or any object with its `id`
 * @param {{ via: 'browser'|'terminal'|'popup'|'batch', at: number, threshold: number|null, choice?: string, tier?: string, closingPid?: number|null, tiers?: { entries: object[] } }} options
 * @returns {{ counted: boolean, offered: boolean, count?: number, reason?: string }}
 */
export function recordAllow(store, request, { via, at, threshold, choice, tier, closingPid: givenPid, tiers = activeTiers() } = {}) {
  const row = store.get('SELECT * FROM requests WHERE id = ?', request?.id)
  if (!row || row.kind !== 'permission') return { counted: false, offered: false, reason: 'not_permission' }
  let answer = null
  try { answer = JSON.parse(row.answer ?? 'null') } catch {}
  if (!['allow', 'allow_always'].includes(choice ?? answer?.choice)) return { counted: false, offered: false, reason: 'not_allowed' }
  if ((tier ?? row.tier) !== 'safe') return { counted: false, offered: false, reason: 'not_safe' }
  if (typeof row.rule_pattern !== 'string' || !row.rule_pattern) return { counted: false, offered: false, reason: 'no_pattern' }
  if (threshold === null || !Number.isInteger(threshold) || threshold < 1) return { counted: false, offered: false, reason: 'never' }
  const repoId = store.get('SELECT repo_id FROM sessions WHERE id = ?', row.session_id)?.repo_id
  if (!repoId || !store.get('SELECT id FROM repos WHERE id = ?', repoId)) return { counted: false, offered: false, reason: 'no_repo' }
  const pattern = row.rule_pattern
  if (via === 'terminal') {
    const opened = permissionPid(store, row, at)
    const closed = givenPid === undefined ? closingPid(store, row, at) : givenPid
    if (opened === null || closed === null || opened !== closed) return { counted: false, offered: false, reason: 'process_mismatch' }
  }
  const counter = store.get('SELECT * FROM rule_counters WHERE repo_id = ? AND pattern = ?', repoId, pattern)
  if (inSettings(repoId, pattern)) {
    if (counter?.state === 'offered') store.appendEvent({ at, type: 'rule.withdrawn', data: { repoId, pattern } })
    store.run('INSERT INTO rule_counters(repo_id, pattern, count, state, updated_at) VALUES(?,?,0,?,?) ON CONFLICT(repo_id, pattern) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at', repoId, pattern, 'accepted', at)
    return { counted: false, offered: false, reason: 'in_settings' }
  }
  const before = counter && counter.state !== 'accepted' ? counter.count : 0
  const count = before + 1
  const offered = counter?.state === 'offered' || count >= threshold
  store.run('INSERT INTO rule_counters(repo_id, pattern, count, state, offered_at, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id, pattern) DO UPDATE SET count = excluded.count, state = excluded.state, offered_at = COALESCE(rule_counters.offered_at, excluded.offered_at), updated_at = excluded.updated_at',
    repoId, pattern, count, offered ? 'offered' : 'counting', offered ? at : null, at)
  if (offered) store.appendEvent({ at, type: 'rule.offered', data: offerView(store, { repo_id: repoId, pattern, count }, threshold, tiers) })
  return { counted: true, offered, count }
}

/**
 * Dismiss an offer (`U.DismissRule`): the machine returns to `counting(0)` and `rule.withdrawn` is
 * appended. Inside the caller's transaction.
 * @param {{ get: Function, run: Function, appendEvent: Function }} store
 * @param {string} repoId
 * @param {string} pattern
 * @param {{ at?: number }} [options]
 * @returns {boolean} false when there was no offer
 */
export function dismissOffer(store, repoId, pattern, { at = Date.now() } = {}) {
  const row = store.get('SELECT state FROM rule_counters WHERE repo_id = ? AND pattern = ?', repoId, pattern)
  if (row?.state !== 'offered') return false
  store.run('UPDATE rule_counters SET count = 0, state = ?, offered_at = NULL, dismissed_at = ?, updated_at = ? WHERE repo_id = ? AND pattern = ?', 'counting', at, at, repoId, pattern)
  store.appendEvent({ at, type: 'rule.withdrawn', data: { repoId, pattern } })
  return true
}

/**
 * The open offers, for the snapshot's `ruleOffers`.
 * @param {{ all: Function, get: Function }} store
 * @param {{ threshold?: number|null, tiers?: { entries: object[] } }} [options]
 * @returns {{ repoId: string, repoKey: string, pattern: string, count: number, threshold: number|null, ruleNote: string|null }[]}
 */
export function offers(store, { threshold = ruleThreshold(store), tiers = activeTiers() } = {}) {
  return store.all("SELECT * FROM rule_counters WHERE state = 'offered' ORDER BY offered_at, repo_id, pattern").map(row => offerView(store, row, threshold, tiers))
}

/**
 * Apply a threshold change. Never (null) freezes the counters (they keep their count and stop
 * counting) and withdraws every offer with `rule.withdrawn`. Inside the caller's transaction.
 * @param {{ all: Function, run: Function, appendEvent: Function }} store
 * @param {number|null} threshold
 * @param {{ at?: number }} [options]
 * @returns {number} offers withdrawn
 */
export function applyThreshold(store, threshold, { at = Date.now() } = {}) {
  if (threshold !== null) return 0
  const rows = store.all("SELECT repo_id, pattern FROM rule_counters WHERE state = 'offered'")
  for (const row of rows) {
    store.run('UPDATE rule_counters SET state = ?, offered_at = NULL, updated_at = ? WHERE repo_id = ? AND pattern = ?', 'counting', at, row.repo_id, row.pattern)
    store.appendEvent({ at, type: 'rule.withdrawn', data: { repoId: row.repo_id, pattern: row.pattern } })
  }
  return rows.length
}

// ---------------------------------------------------------------------------------------------
// The mirror, the writer and the revoker (07-approvals 7.2, 7.4 and 9)

// judgePattern, not validatePattern: a rule found in the file is marked Destructive on win32 too.
function ruleView(row, tiers, platform = process.platform) {
  const verdict = judgePattern(row.pattern, { tiers, classify: defaultClassify, repoRoot: row.repo_id, platform })
  const destructive = !verdict.ok && verdict.code === 'destructive_rule'
  return {
    repoId: row.repo_id,
    pattern: row.pattern,
    source: row.source,
    approvalsBefore: row.approvals_before ?? null,
    createdAt: row.created_at ?? null,
    tier: destructive ? 'destructive' : verdict.ok ? verdict.tier : null,
    destructive,
    warning: verdict.ok ? verdict.warning : null
  }
}

/**
 * Write an allow rule to `<repo>/.claude/settings.local.json` by 07-approvals 7.2 steps 1 to 9: the
 * repo realpath; `lstat` of `.claude` and the target, refusing a symlink or anything but a regular
 * file owned by the user; the parse and type checks (nothing is written on any refusal); append the
 * pattern only when no equivalent entry is present (`rule_exists` otherwise); no other key is
 * touched and key and array order are kept; the previous bytes are backed up to
 * `<state>/backups/rules/<sha256(repo path)>/<yyyymmdd-hhmmss>.json` (0600, newest 20 kept); a temp
 * file in the same directory is written, `fsync`ed, the target re-read and the write restarted when
 * its bytes changed (`settings_changed` after 3 attempts), then renamed over the target and verified
 * to hold the pattern once. Then the mirror row, `rule_audit` (`added`) and `rule.upserted`; the
 * offer, if any, is withdrawn. `tracked` is whether `git ls-files --error-unmatch` knows the file.
 * The pattern is validated first ({@link validatePattern}; a refusal throws its `invalid_pattern` or
 * `destructive_rule` code and nothing is written), then written as given: callers pass the deck's
 * canvas form `Bash(<prefix>:*)` (D-97).
 * @param {{ get: Function, all: Function, run: Function, appendEvent: Function, tx: Function }} store
 * @param {{ repoId: string, pattern: string, source: 'suggested'|'manual', stateDir: string, at?: number, gitRead?: Function, beforeRename?: (attempt: number) => void, tiers?: object, publish?: Function, platform?: string }} options
 * @returns {Promise<{ rule: object, backupPath: string|null, beforeSha256: string|null, afterSha256: string }>}
 */
export async function writeRule(store, { repoId, pattern, source, stateDir, at = Date.now(), gitRead = defaultGitRead, beforeRename, tiers = activeTiers(), publish, platform = process.platform } = {}) {
  // The writer validates the pattern itself, so no caller can write a refused rule (on win32, none).
  const verdict = validatePattern(pattern, { tiers, repoRoot: repoId, platform })
  if (!verdict.ok) throw apiError(422, verdict.code, { message: verdict.message })
  const done = rewrite(repoId, {
    stateDir, at, beforeRename, create: true,
    change: data => {
      if (allowList(data).some(item => samePattern(item, pattern))) throw apiError(409, 'rule_exists', { pattern })
      data.permissions ??= {}
      data.permissions.allow ??= []
      data.permissions.allow.push(pattern)
      return true
    },
    verify: list => list.filter(item => item === pattern).length === 1
  })
  const events = []
  const append = event => { const seq = store.appendEvent(event); events.push({ seq: Number(seq), ...event }) }
  const view = store.tx(() => {
    const counter = store.get('SELECT count, state FROM rule_counters WHERE repo_id = ? AND pattern = ?', repoId, pattern)
    const approvalsBefore = source === 'suggested' ? counter?.count ?? null : null
    store.run('INSERT INTO rules(repo_id, pattern, source, approvals_before, created_at, seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id, pattern) DO UPDATE SET source = excluded.source, approvals_before = excluded.approvals_before, created_at = excluded.created_at, seen_at = excluded.seen_at',
      repoId, pattern, source, approvalsBefore, at, at)
    store.run('INSERT INTO rule_audit(at, repo_id, pattern, action, actor, approvals_before) VALUES(?,?,?,?,?,?)', at, repoId, pattern, 'added', source === 'suggested' ? 'suggestion' : 'manual', approvalsBefore)
    if (counter?.state === 'offered') append({ at, type: 'rule.withdrawn', entityId: null, data: { repoId, pattern } })
    store.run('INSERT INTO rule_counters(repo_id, pattern, count, state, updated_at) VALUES(?,?,0,?,?) ON CONFLICT(repo_id, pattern) DO UPDATE SET state = excluded.state, offered_at = NULL, updated_at = excluded.updated_at', repoId, pattern, 'accepted', at)
    const rule = ruleView(store.get('SELECT * FROM rules WHERE repo_id = ? AND pattern = ?', repoId, pattern), tiers, platform)
    append({ at, type: 'rule.upserted', entityId: null, data: rule })
    return rule
  })
  for (const event of events) publish?.(event)
  const tracked = await gitRead(done.read.root, ['ls-files', '--error-unmatch', '.claude/settings.local.json']).then(result => result?.code === 0, () => false)
  return { rule: { ...view, tracked }, backupPath: done.backupPath, beforeSha256: done.beforeSha256, afterSha256: done.afterSha256 }
}

/**
 * Revoke a rule (07-approvals 9): the 7.2 steps with step 5 "remove the exact strings found" (every
 * entry equivalent to `pattern`). When none is left in the file it reports `already_removed` and
 * refreshes the mirror. Either way the rule machine returns to `counting(0)`, the mirror row goes,
 * `rule_audit` gets `revoked` (or `undo` for the toast's Undo) and `rule.removed` is appended.
 * @param {{ get: Function, run: Function, appendEvent: Function, tx: Function }} store
 * @param {{ repoId: string, pattern: string, stateDir: string, undo?: boolean, at?: number, beforeRename?: (attempt: number) => void, publish?: Function }} options
 * @returns {{ removed: true } | { removed: false, reason: 'already_removed' }}
 */
export function revokeRule(store, { repoId, pattern, stateDir, undo = false, at = Date.now(), beforeRename, publish } = {}) {
  const done = rewrite(repoId, {
    stateDir, at, beforeRename,
    change: data => {
      const list = Array.isArray(data.permissions?.allow) ? data.permissions.allow : []
      const kept = list.filter(item => typeof item !== 'string' || !samePattern(item, pattern))
      if (kept.length === list.length) return false
      data.permissions.allow = kept
      return true
    },
    verify: list => !list.some(item => samePattern(item, pattern))
  })
  const events = []
  const append = event => { const seq = store.appendEvent(event); events.push({ seq: Number(seq), ...event }) }
  store.tx(() => {
    const mirrored = store.all('SELECT pattern FROM rules WHERE repo_id = ?', repoId).filter(row => samePattern(row.pattern, pattern))
    for (const row of mirrored) store.run('DELETE FROM rules WHERE repo_id = ? AND pattern = ?', repoId, row.pattern)
    if (done.changed) store.run('INSERT INTO rule_audit(at, repo_id, pattern, action, actor) VALUES(?,?,?,?,?)', at, repoId, pattern, undo ? 'undo' : 'revoked', 'manual')
    else for (const row of mirrored) store.run('INSERT INTO rule_audit(at, repo_id, pattern, action, actor) VALUES(?,?,?,?,?)', at, repoId, row.pattern, 'vanished', 'external')
    for (const row of store.all('SELECT pattern, state FROM rule_counters WHERE repo_id = ?', repoId).filter(item => samePattern(item.pattern, pattern))) {
      if (row.state === 'offered') append({ at, type: 'rule.withdrawn', entityId: null, data: { repoId, pattern: row.pattern } })
      store.run('UPDATE rule_counters SET count = 0, state = ?, offered_at = NULL, updated_at = ? WHERE repo_id = ? AND pattern = ?', 'counting', at, repoId, row.pattern)
    }
    if (done.changed || mirrored.length) append({ at, type: 'rule.removed', entityId: null, data: { repoId, pattern } })
  })
  for (const event of events) publish?.(event)
  return done.changed ? { removed: true } : { removed: false, reason: 'already_removed' }
}

/**
 * Re-read a repo's settings file and refresh the mirror (07-approvals 7.4): a rule the deck did not
 * write becomes a `manual` row with null `created_at` ("added by hand", SET-O5) and a `found` audit
 * row; a mirrored rule no longer in the file gets `vanished` and `rule.removed`; a rule a Destructive
 * entry matches carries `destructive: true`. An unreadable file leaves the mirror as it is and is
 * reported as `readError`.
 * @param {{ get: Function, all: Function, run: Function, appendEvent: Function, tx: Function }} store
 * @param {string} repoId
 * @param {{ at?: number, tiers?: object, publish?: Function, platform?: string }} [options]
 * @returns {{ repoId: string, settingsPath: string, readError?: { file: string, message: string }, rules: object[] }}
 */
export function listRules(store, repoId, { at = Date.now(), tiers = activeTiers(), publish, platform = process.platform } = {}) {
  const file = settingsPath(repoId)
  let list
  try { list = allowList(readSettings(repoId).data) } catch (error) {
    const rules = store.all('SELECT * FROM rules WHERE repo_id = ? ORDER BY pattern', repoId).map(row => ruleView(row, tiers, platform))
    return { repoId, settingsPath: file, readError: { file: error.details?.path ?? file, message: error.details?.errno ?? error.code ?? 'unreadable' }, rules }
  }
  const events = []
  const append = event => { const seq = store.appendEvent(event); events.push({ seq: Number(seq), ...event }) }
  const rules = store.tx(() => {
    const present = [...new Set(list)]
    const mirror = new Map(store.all('SELECT * FROM rules WHERE repo_id = ?', repoId).map(row => [row.pattern, row]))
    for (const [pattern] of mirror) {
      if (present.includes(pattern)) continue
      store.run('DELETE FROM rules WHERE repo_id = ? AND pattern = ?', repoId, pattern)
      store.run('INSERT INTO rule_audit(at, repo_id, pattern, action, actor) VALUES(?,?,?,?,?)', at, repoId, pattern, 'vanished', 'external')
      store.run("UPDATE rule_counters SET count = 0, state = 'counting', updated_at = ? WHERE repo_id = ? AND pattern = ? AND state = 'accepted'", at, repoId, pattern)
      append({ at, type: 'rule.removed', entityId: null, data: { repoId, pattern } })
    }
    for (const pattern of present) {
      if (mirror.has(pattern)) { store.run('UPDATE rules SET seen_at = ? WHERE repo_id = ? AND pattern = ?', at, repoId, pattern); continue }
      store.run('INSERT INTO rules(repo_id, pattern, source, approvals_before, created_at, seen_at) VALUES(?,?,?,?,?,?)', repoId, pattern, 'manual', null, null, at)
      store.run('INSERT INTO rule_audit(at, repo_id, pattern, action, actor) VALUES(?,?,?,?,?)', at, repoId, pattern, 'found', 'external')
      for (const counter of store.all('SELECT pattern, state FROM rule_counters WHERE repo_id = ?', repoId).filter(row => samePattern(row.pattern, pattern) && row.state !== 'accepted')) {
        if (counter.state === 'offered') append({ at, type: 'rule.withdrawn', entityId: null, data: { repoId, pattern: counter.pattern } })
        store.run("UPDATE rule_counters SET state = 'accepted', offered_at = NULL, updated_at = ? WHERE repo_id = ? AND pattern = ?", at, repoId, counter.pattern)
      }
      append({ at, type: 'rule.upserted', entityId: null, data: ruleView(store.get('SELECT * FROM rules WHERE repo_id = ? AND pattern = ?', repoId, pattern), tiers, platform) })
    }
    return present.map(pattern => ruleView(store.get('SELECT * FROM rules WHERE repo_id = ? AND pattern = ?', repoId, pattern), tiers, platform))
  })
  for (const event of events) publish?.(event)
  return { repoId, settingsPath: file, rules }
}

/**
 * The rules service bound to a store, the deck's state directory and a publisher, for the API
 * (Task 16) and answer delivery (Task 10). Each method that changes the database runs in its own
 * transaction and publishes the events it appended; `recordAllow` runs inside the caller's.
 * @param {{ store: object, paths?: { state: string }, publish?: Function, now?: () => number, gitRead?: Function, classify?: Function, tiers?: () => object, platform?: string }} options
 */
export function createRules({ store, paths = setupPaths(process.env), publish = () => {}, now = Date.now, gitRead = defaultGitRead, classify = defaultClassify, tiers = activeTiers, platform = process.platform } = {}) {
  const inTx = fn => {
    const before = Number(store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq)
    const result = store.tx(fn)
    for (const row of store.all('SELECT seq, at, type, entity_id, data FROM events WHERE seq > ? ORDER BY seq', before)) publish({ seq: Number(row.seq), at: row.at, type: row.type, entityId: row.entity_id, data: JSON.parse(row.data) })
    return result
  }
  return {
    threshold: () => ruleThreshold(store),
    recordAllow: (request, options = {}) => recordAllow(store, request, { at: now(), threshold: ruleThreshold(store), tiers: tiers(), ...options }),
    dismissOffer: (repoId, pattern) => inTx(() => dismissOffer(store, repoId, pattern, { at: now() })),
    offers: () => offers(store, { tiers: tiers() }),
    setThreshold: threshold => inTx(() => applyThreshold(store, threshold, { at: now() })),
    validatePattern: (pattern, options = {}) => validatePattern(pattern, { classify, tiers: tiers(), platform, ...options }),
    write: (repoId, pattern, { source = 'manual', beforeRename } = {}) => writeRule(store, { repoId, pattern, source, stateDir: paths.state, at: now(), gitRead, beforeRename, tiers: tiers(), publish, platform }),
    revoke: (repoId, pattern, { undo = false, beforeRename } = {}) => revokeRule(store, { repoId, pattern, stateDir: paths.state, undo, at: now(), beforeRename, publish }),
    listRules: repoId => listRules(store, repoId, { at: now(), tiers: tiers(), publish, platform })
  }
}
