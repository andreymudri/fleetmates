import { probeCommand } from './probe-command.mjs'
// The only module in this repository that knows the OpenCode CLI (`opencode`), per
// docs/specs/2026-11-02-headless-driver-opencode-design.md. Everything else talks to
// `opencodeAdapter` through the harness-neutral interface (`scripts/harnesses/index.mjs`).
//
// Teammates only ever run in a git-less `files` checkout (spec §2): OpenCode has NO operating
// system sandbox at all, so the containment that exists is a git-less workspace plus permission
// rules the host writes, and no layout that leaves a repository in the workspace is safe.
import { spawn as spawnProcess } from 'node:child_process'
import { createWriteStream, constants, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateResult } from '../result-schema.mjs'
import { makeFilesSandbox, scrubControlPaths, commitFilesTree, FILES_PREAMBLE } from './files-sandbox.mjs'

export { FILES_PREAMBLE }

// The OpenCode release every measurement in the spec was taken on. A different build may change
// the event names, the error taxonomy or the permission keys this adapter depends on, so `probe`
// reports a mismatch (spec §4.5). Measured: `opencode --version` prints `opencode v2.2.5`.
export const MEASURED_VERSION = '2.2.5'

// `--server` points the run at a server the host does not control; `--continue`/`-c` and `--fork`
// reach a session this adapter did not create (the user's own last session, in the shared service);
// `--agent` swaps the whole agent definition, including its permissions; `--wizard` is interactive.
// None of them may ever reach a teammate's command line.
const FORBIDDEN_FLAGS = ['--server', '--continue', '-c', '--fork', '--agent', '--wizard']

// Measured: without `--standalone` the run talks to the user's shared background server and
// inherits ITS config and permissions, so the config content this adapter sets would not apply.
// `--format json` is what produces the NDJSON `readResult` and `readUsage` read.
export function assertSafeArgv(argv) {
  for (const arg of argv) {
    const flag = arg.split('=')[0]
    if (FORBIDDEN_FLAGS.includes(flag)) throw new Error(`opencode argv contains forbidden flag ${flag}`)
  }
  if (!argv.includes('--standalone')) throw new Error('opencode argv is missing --standalone')
  const format = argv.indexOf('--format')
  if (format === -1 || argv[format + 1] !== 'json') throw new Error('opencode argv is missing --format json')
  return argv
}

// OpenCode's enforcement is pattern matching over tool calls, not confinement: `resolveRoleCapabilities`
// does not know this harness, so a required role policy can never be satisfied here. Refused rather
// than silently downgraded to a legacy, unverified run.
function refuseEnforcement(sandbox, enforcement) {
  if (enforcement !== undefined || sandbox?.meta?.enforcement !== undefined
    || (Object.hasOwn(sandbox?.meta ?? {}, 'prerequisites') && sandbox.meta.prerequisites?.rolePolicy !== null)) {
    throw new Error('Required OpenCode enforcement is unsupported: OpenCode has no operating system sandbox')
  }
}

// A model reaches opencode as ONE argv element after `-m`, so it must be one bounded token; a
// leading dash would read as a flag. Measured: the accepted form is `provider/model#variant`, so
// `#` is part of the token. Refused, never repaired.
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,127}$/

function baseArgs({ model }) {
  if (model && (typeof model !== 'string' || !MODEL_TOKEN.test(model))) throw new Error('Invalid opencode model name')
  // `--auto` approves everything that is not explicitly denied. Without it the run auto-REJECTS
  // every "ask" with no one to answer, so a headless teammate cannot work at all; the denies in
  // `configContent` are what `--auto` must not override.
  return ['run', '--standalone', '--format', 'json', '--auto', ...(model ? ['-m', model] : [])]
}

export function buildSpawnArgv({ sandbox, model, prompt, enforcement }) {
  refuseEnforcement(sandbox, enforcement)
  return assertSafeArgv([...baseArgs({ model }), '--', promptArg(prompt)])
}

export function buildResumeArgv({ sandbox, sessionId, model, message, enforcement }) {
  refuseEnforcement(sandbox, enforcement)
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid opencode session id')
  return assertSafeArgv([...baseArgs({ model }), '-s', sessionId, '--', promptArg(message)])
}

// The prompt is a positional argument, never stdin: measured, a non-TTY stdin is read to EOF and
// CONCATENATED to the prompt, so the child's stdin is `ignore` (the `</dev/null` of the spec) and
// the whole prompt has to travel in argv. Everything after `--` is the message, so a prompt that
// starts with a dash is still a prompt.
function promptArg(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('opencode prompt must be a non-empty string')
  return text
}

// Bash commands that would make a commit, move a ref or change a branch. The gate is computed from
// git, and a teammate that commits on its own would put work on a ref the host never observed, so
// these are denied even though `bash` is `allow` by default. Both the bare command and the
// argument form are listed: OpenCode matches the last rule whose pattern matches, and the exact
// glob semantics of a bash pattern are NOT MEASURED (spec §6).
const DENIED_BASH = ['git commit', 'git push', 'git checkout', 'git switch', 'git branch',
  'git reset', 'git rebase', 'git merge', 'git tag', 'git update-ref', 'git cherry-pick', 'git am']

// The policy the adapter hands the child in `OPENCODE_CONFIG_CONTENT` (spec §4.2). `snapshot: false`
// stops OpenCode keeping a parallel snapshot repository over the checkout. `external_directory`
// deny is its only path-scoped rule; with `network: false`, `webfetch` and `websearch` are denied
// too. In `none` mode the deny rules are dropped: that mode exists to say, loudly, that nothing is
// enforced. A `full` sandbox (reviewers, the integrator) does not get them either: the integrator's
// whole job is to merge and commit in the user's own repository.
export function configContent({ mode, network }) {
  if (mode !== 'files') return JSON.stringify({ snapshot: false })
  const bash = { '*': 'allow' }
  for (const command of DENIED_BASH) {
    bash[command] = 'deny'
    bash[`${command} *`] = 'deny'
  }
  return JSON.stringify({
    snapshot: false,
    permission: {
      external_directory: 'deny',
      ...(network ? {} : { webfetch: 'deny', websearch: 'deny' }),
      bash,
    },
  })
}

// The environment one teammate's `opencode` runs with. `OPENCODE_CONFIG_CONTENT` is the
// second-to-last config layer, so it wins over the user's global and project config (but not over
// a managed `/etc/opencode/`, which `probe` reports). In a teammate checkout the project config
// layers are switched off outright: `opencode.json` and `.opencode/` are scrubbed control paths,
// and `.claude` material in the checkout is teammate-writable too.
export function childEnv({ mode, network, env = process.env }) {
  const own = {
    OPENCODE_CONFIG_CONTENT: configContent({ mode, network }),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  }
  if (mode === 'full') return { ...env, ...own }
  return {
    ...env,
    ...own,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
  }
}

// OpenCode has no output-schema flag (spec §4.4), so the contract travels in the prompt and
// `readResult` validates what comes back. Appended to every spawn prompt and resume message in a
// git-less checkout only: a `full` sandbox (reviewers, integrator) works in the real repository
// with git, and its persona already defines what it returns.
export const RESULT_INSTRUCTION = '\n\n---\n'
  + 'This workspace is a plain directory with no git repository: do not run git, and do not try to '
  + 'commit. When you finish, the host commits every file in the workspace for you. Files under '
  + '.opencode/ and opencode.json, which configure plugins, MCP servers and permissions, together '
  + 'with .cursor/ config, .claude/settings*.json and .vscode/, are reset by the host; changing '
  + 'them fails the task.\n'
  + 'Your final message must be exactly one JSON object and nothing else, with exactly these keys: '
  + '"status" ("done", "blocked" or "failed"), "branch" (string), "filesChanged" (array of '
  + 'strings), "summary" (string), "blockers" (array of strings).'

const isCheckout = (sandbox) => sandbox.meta.mode === 'files' || sandbox.meta.mode === 'none'

function withInstruction(sandbox, text) {
  return isCheckout(sandbox) ? `${FILES_PREAMBLE}${text}${RESULT_INSTRUCTION}` : text
}

// A control-path refusal is recorded next to the checkout, because the scrub that detects the
// violation also removes the evidence. Without the marker a re-dispatch resumes the cleaned
// checkout and commits it.
const refusalMarker = (sandbox) => `${sandbox.cwd}.control-path`

async function priorRefusal(sandbox) {
  try {
    return (await readFile(refusalMarker(sandbox), 'utf8')).trim()
  } catch {
    return null
  }
}

async function prepareWorkspace(sandbox) {
  if (!isCheckout(sandbox)) return
  const refused = await priorRefusal(sandbox)
  if (refused) throw new Error(`control-path: ${refused}`)
  await scrubControlPaths(sandbox.cwd)
}

// An `opencode run` process with the prompt in argv and stdin at `ignore` — the `</dev/null` of
// spec §1: a non-TTY stdin is concatenated to the prompt. The session id resolves from the first
// event carrying a NON-EMPTY `sessionID` (measured: an early error carries `""`). A resume appends
// to the stream, after a host-written turn marker, so `readResult` never reads the previous turn's
// answer and `readUsage` still sees every turn. `flushed` resolves once the stream file holds every
// byte the child wrote.
//
// The stream file is also where `readResult` finds the answer, so its bound counts the file: a
// resume's budget of `maxStreamBytes` starts at the stream file's existing size, and stdout and
// stderr draw on it together. The chunk that crosses it keeps only the bytes that fit, the child is
// SIGKILLed, nothing more is written and the handle's `outputLimited` reads true.
export const STREAM_LIMIT_BYTES = 64 * 1024 * 1024
const SESSION_LINE_LIMIT = 1024 * 1024

// Written by the host, never by OpenCode: OpenCode emits no event when a turn begins that a reader
// can trust (an `error` can precede `step_start`, measured), and no final result event at all —
// the end of a turn is EOF. The marker is what bounds "this turn" in an appended stream.
export const TURN_MARKER = { type: 'fleetmates.turn' }

const existingBytes = (file) => { try { return statSync(file).size } catch { return 0 } }

function run(argv, { streamPath, errPath, cwd, env, append, maxStreamBytes = STREAM_LIMIT_BYTES }) {
  const child = spawnProcess('opencode', argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const flags = append ? 'a' : 'w'
  let written = append ? existingBytes(streamPath) : 0
  const out = createWriteStream(streamPath, { flags })
  const err = createWriteStream(errPath ?? `${streamPath}.err`, { flags })
  let limited = false
  const take = (chunk) => {
    if (limited) return null
    const room = maxStreamBytes - written
    { written += chunk.length; return chunk }
    limited = true
    written = maxStreamBytes
    return chunk.subarray(0, Math.max(0, room))
  }
  const stop = () => {
    out.end()
    err.end()
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    settle(null)
  }
  child.stderr.on('data', (chunk) => {
    const part = take(chunk)
    if (part === null) return
    if (part.length) err.write(part)
    if (limited) stop()
  })
  child.stderr.on('end', () => { if (!limited) err.end() })
  const flushed = Promise.all([
    new Promise((resolve) => { out.on('finish', resolve); out.on('error', resolve) }),
    new Promise((resolve) => { err.on('finish', resolve); err.on('error', resolve) }),
  ]).then(() => undefined)

  let resolveSessionId
  let idFound = false
  const sessionId = new Promise((resolve) => { resolveSessionId = resolve })
  const settle = (value) => {
    if (idFound) return
    idFound = true
    resolveSessionId(value)
  }
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    const part = take(chunk)
    if (part === null) return
    if (part.length) out.write(part)
    if (!idFound) {
      buffer += part.toString('utf8')
      let nl
      while (!idFound && (nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let evt
        // Measured: plain text shares the stdout with the NDJSON (a flag error prints the whole
        // help there). An unparsable line is skipped, never fatal.
        try { evt = JSON.parse(line) } catch { continue }
        if (evt && typeof evt === 'object' && typeof evt.sessionID === 'string' && evt.sessionID) {
          settle(evt.sessionID)
        }
      }
      if (buffer.length > SESSION_LINE_LIMIT) buffer = ''
    }
    if (limited) stop()
  })
  child.stdout.on('end', () => {
    if (!limited) out.end()
    settle(null)
  })
  child.on('error', () => {
    if (!limited) { out.end(); err.end() }
    settle(null)
  })
  return { child, sessionId, flushed, get outputLimited() { return limited } }
}

async function markTurn(streamPath, prompt) {
  await writeFile(streamPath, `${JSON.stringify({ ...TURN_MARKER, bytes: Buffer.byteLength(prompt) })}\n`, { flag: 'a' })
}

export async function spawnOpenCode({ sandbox, prompt, model, network, enforcement, streamPath, errPath, maxStreamBytes, env = process.env }) {
  const text = withInstruction(sandbox, prompt)
  const argv = buildSpawnArgv({ sandbox, model, prompt: text, enforcement })
  await prepareWorkspace(sandbox)
  await markTurn(streamPath, text)
  return run(argv, { streamPath, errPath, cwd: sandbox.cwd, append: true, maxStreamBytes,
    env: childEnv({ mode: sandbox.meta.mode, network, env }) })
}

export async function resumeOpenCode({ sandbox, sessionId, message, model, network, enforcement, streamPath, errPath, maxStreamBytes, env = process.env }) {
  const text = withInstruction(sandbox, message)
  const argv = buildResumeArgv({ sandbox, sessionId, model, message: text, enforcement })
  await prepareWorkspace(sandbox)
  await markTurn(streamPath, text)
  return run(argv, { streamPath, errPath, cwd: sandbox.cwd, append: true, maxStreamBytes,
    env: childEnv({ mode: sandbox.meta.mode, network, env }) })
}

// A bounded read of the stream file that does not follow a final symlink: `null` when it is
// absent, a link, not a regular file or larger than `max` bytes.
// win32 has no O_NOFOLLOW, so there the link is refused by lstat before the open, and the opened
// handle must be the very file lstat saw (same dev and ino). `noFollow: null` forces that path on
// any platform; `beforeOpen`, a test-only hook run between the lstat and the open, lets a test swap
// the file in that window.
async function readBounded(file, max, { noFollow = constants.O_NOFOLLOW, beforeOpen } = {}) {
  let handle
  let seen = null
  try {
    if (noFollow) {
      handle = await open(file, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0))
    } else {
      seen = await lstat(file, { bigint: true })
      if (!seen.isFile()) return null
      await beforeOpen?.()
      handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    }
  } catch { return null }
  try {
    const info = await handle.stat({ bigint: true })
    if (seen && (info.dev !== seen.dev || info.ino !== seen.ino)) return null
    if (!info.isFile() || info.size > BigInt(max)) return null
    const buffer = Buffer.alloc(max + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return offset > max ? null : buffer.subarray(0, offset).toString('utf8')
  } catch { return null } finally { await handle.close() }
}

// Every parsable JSON object of the stream, in order. Measured: the stdout mixes NDJSON with plain
// text, so a line that does not parse is SKIPPED rather than ending the read.
async function streamEvents(streamPath, maxStreamBytes = STREAM_LIMIT_BYTES, { noFollow, beforeOpen } = {}) {
  const raw = await readBounded(streamPath, maxStreamBytes, { noFollow, beforeOpen })
  if (raw === null) return []
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const evt = JSON.parse(line)
      if (evt && typeof evt === 'object' && !Array.isArray(evt)) events.push(evt)
    } catch { /* a partial, plain-text or foreign line */ }
  }
  return events
}

// The events of the last turn: everything after the host's own turn marker.
function lastTurn(events) {
  let start = 0
  events.forEach((evt, i) => { if (evt.type === TURN_MARKER.type) start = i + 1 })
  return events.slice(start)
}

// Errors OpenCode reports for reasons that are not the task: the provider refused to route, or the
// account ran out of free quota (429, with `retryAfterMs`). Measured taxonomy: `provider.no-route`,
// `provider.free-limit`, `unknown`. A retriable error means the turn says nothing about the work,
// so a caller can distinguish "the harness could not run" from "the teammate failed".
const RETRIABLE_ERRORS = new Set(['provider.free-limit', 'provider.no-route'])

// The last `error` event of the last turn, normalized, or `null`. The exit code alone is not the
// signal: measured, exit 1 covers a provider error, a rate limit, a malformed model id and an
// unknown flag alike, and a successful exit was not measurable without a paid credential.
export async function readError({ streamPath, maxStreamBytes, noFollow, beforeOpen }) {
  const events = lastTurn(await streamEvents(streamPath, maxStreamBytes, { noFollow, beforeOpen }))
  const evt = events.filter((e) => e.type === 'error' && e.error && typeof e.error === 'object').pop()
  if (!evt) return null
  const type = typeof evt.error.type === 'string' ? evt.error.type : 'unknown'
  return {
    type,
    message: typeof evt.error.message === 'string' ? evt.error.message : '',
    retriable: RETRIABLE_ERRORS.has(type),
    retryAfterMs: Number.isSafeInteger(evt.error.retryAfterMs) ? evt.error.retryAfterMs : null,
  }
}

// Every way a model's final text can carry the result object: the whole text, the last fenced
// json block, or a JSON object that ends the text after prose.
function parseCandidates(text) {
  const out = []
  const trimmed = text.trim()
  try { out.push(JSON.parse(trimmed)) } catch { /* not bare JSON */ }
  const fences = [...trimmed.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)]
  if (fences.length) {
    try { out.push(JSON.parse(fences[fences.length - 1][1])) } catch { /* unparsable fence */ }
  }
  if (trimmed.endsWith('}')) {
    for (let i = trimmed.lastIndexOf('{'); i >= 0; i = trimmed.lastIndexOf('{', i - 1)) {
      try {
        out.push(JSON.parse(trimmed.slice(i)))
        break
      } catch { /* widen to the previous brace */ }
      if (i === 0) break
    }
  }
  return out
}

// The envelope's `type` uses an underscore (`text`, `step_start`, `step_finish`) while
// `part.type` uses a hyphen (`step-start`) — measured, and deliberately not unified here.
// The `text` event's own shape is NOT MEASURED (it needs a paid credential), so the reader accepts
// the text at `part.text` and ignores anything else.
const textOf = (evt) => (evt.type === 'text' && evt.part && typeof evt.part.text === 'string' ? evt.part.text : null)

// The turn's result, validated. There is no result event: the turn ends at EOF, so the answer is
// the model's last text (spec §4.4). Only the events after the host's turn marker count, so a
// resume never returns the previous turn's answer. An `error` event in the turn means there is no
// answer at all. `null` — never a throw — for anything that is not a valid result: every such case
// is `orphaned`, not a driver crash.
export async function readResult({ streamPath, maxStreamBytes, noFollow, beforeOpen }) {
  const turn = lastTurn(await streamEvents(streamPath, maxStreamBytes, { noFollow, beforeOpen }))
  if (turn.some((e) => e.type === 'error')) return null
  const texts = turn.map(textOf).filter((t) => typeof t === 'string' && t.length)
  if (!texts.length) return null
  for (const text of [texts[texts.length - 1], texts.join('')]) {
    for (const candidate of parseCandidates(text)) {
      if (validateResult(candidate)) return candidate
    }
  }
  return null
}

// Sums `step_finish.part.tokens` over the whole stream (a resume appends its own events). `null`
// when the stream carries no such event, so a caller can tell "zero usage" from "none recorded".
// NOT MEASURED: the `step_finish` event needs a paid credential, so the token field names are taken
// from OpenCode's published event types and read defensively — a missing field counts as zero
// rather than failing the read.
export async function readUsage({ streamPath, maxStreamBytes }) {
  const events = await streamEvents(streamPath, maxStreamBytes)
  const totals = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  let found = false
  for (const evt of events) {
    const tokens = evt.type === 'step_finish' ? evt.part?.tokens : null
    if (!tokens || typeof tokens !== 'object') continue
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    found = true
    totals.input += num(tokens.input)
    totals.output += num(tokens.output)
    totals.reasoning += num(tokens.reasoning)
    totals.cachedInput += num(tokens.cache?.read)
    totals.cacheWrite += num(tokens.cache?.write)
  }
  return found ? totals : null
}

// Where OpenCode checkouts live: outside the run repo, and never in a temp directory — every
// teammate on the host can write a temp directory, and OpenCode confines nothing, so one
// teammate's checkout must at least not sit where the shell of another is told to work.
export function opencodeCheckoutRoot({ runRepo, runId, env = process.env }) {
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  const repoKey = createHash('sha256').update(path.resolve(runRepo)).digest('hex').slice(0, 16)
  return path.join(cache, 'fleetmates', 'opencode', repoKey, runId)
}

// Whether `dir/.git` marks a repository: a `.git` directory only when it holds a `HEAD` that is
// not a directory, a `.git` file only when it starts with `gitdir:`. Plain filesystem checks, as
// in cursor.mjs: no git command ever runs against a checkout.
async function gitMarker(dir) {
  const marker = path.join(dir, '.git')
  try {
    const st = await lstat(marker)
    if (st.isDirectory()) return !(await lstat(path.join(marker, 'HEAD'))).isDirectory()
    if (st.isFile() && st.size <= 4096) return (await readFile(marker, 'utf8')).startsWith('gitdir:')
  } catch { /* absent or unreadable: not a marker */ }
  return false
}

// The nearest ancestor of `dir` holding a `.git` repository marker, or null.
export async function enclosingGitRoot(dir) {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (await gitMarker(cur)) return cur
    if (path.dirname(cur) === cur) return null
  }
}

// `files` (default) and `none` share the git-less checkout: the difference is the permission policy
// the child gets (`configContent`), not the layout. `clone` and `full` are refused — OpenCode
// resolves the enclosing repository from its cwd and has no sandbox keeping a teammate out of the
// git directory it finds there.
export async function makeOpenCodeSandbox(git, { runRepo, runBranch, runId, taskId, mode, env = process.env, requireFresh = false }) {
  if (mode !== 'files' && mode !== 'none') {
    throw new Error('OpenCode has no operating system sandbox; only "files" and the opt-in "none" are supported')
  }
  const checkoutRoot = opencodeCheckoutRoot({ runRepo, runId, env })
  await mkdir(checkoutRoot, { recursive: true })
  // OpenCode resolves its "project" with `git rev-parse --show-toplevel` from the cwd, reads that
  // repository's `opencode.json` and `.opencode/`, and (per the documentary survey) writes a
  // project id into its `.git`. A checkout inside a repository would therefore hand the teammate
  // that repository's config. Refused; whether the `.git` write actually happens is NOT MEASURED.
  const repo = await enclosingGitRoot(checkoutRoot)
  if (repo) {
    throw new Error(`OpenCode checkouts must not live inside a git repository, but ${checkoutRoot} is inside ${repo}: `
      + 'OpenCode would read that repository as the project. Point XDG_CACHE_HOME outside it.')
  }
  if (requireFresh) {
    try {
      await lstat(path.join(checkoutRoot, taskId))
      throw new Error('Refusing to overwrite an existing worker workspace')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const sandbox = await makeFilesSandbox(git, { runRepo, runBranch, runId, taskId, checkoutRoot })
  sandbox.meta.mode = mode
  return sandbox
}

// Refuses the task when the teammate touched a control path (spec §4.2); otherwise the host commits
// the checkout. Unlike Cursor, this adapter writes no config file into the checkout at all — the
// policy travels in the environment — so ANY control path found at collect is the teammate's.
export async function collectOpenCode(git, { runRepo, sandbox, branch }) {
  if (!isCheckout(sandbox)) return
  const refused = await priorRefusal(sandbox)
  if (refused) throw new Error(`control-path: ${refused}`)
  const found = await scrubControlPaths(sandbox.cwd)
  if (found.length) {
    await writeFile(refusalMarker(sandbox), found.join(', '))
    throw new Error(`control-path: ${found.join(', ')}`)
  }
  await commitFilesTree(git, { runRepo, runBranch: sandbox.meta.runBranch, sandbox, branch })
}

// Removes a finished task's checkout, then its now-empty run and repo directories (never the shared
// `fleetmates/opencode` root, and never a directory that still holds another task's checkout).
export async function cleanup({ sandbox }) {
  if (!isCheckout(sandbox)) return
  await rm(sandbox.cwd, { recursive: true, force: true })
  await rm(refusalMarker(sandbox), { force: true })
  let dir = path.dirname(sandbox.cwd)
  for (let i = 0; i < 2; i++) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

const VERSION_LINE = /\bv?(\d+)\.(\d+)\.(\d+)\b/

// Authenticated, on the measured major version, config home writable, and no managed config that
// outranks the policy this adapter sets. Never runs an agent turn.
//
// Every successful probe carries a warning: OpenCode has NO operating system sandbox, in any mode,
// and `sandbox: "none"` drops even the permission denies. `sandboxMode` is optional, so a caller
// that knows the configured mode gets the stronger sentence.
export async function probe({ env = process.env, sandboxMode } = {}) {
  const home = env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode')
  const version = await probeCommand('opencode', ['--version'], env)
  if (version.timedOut || version.outputLimited) {
    return { ok: false, reason: 'opencode version probe exceeded its execution limits', fix: 'check the OpenCode CLI and retry' }
  }
  if (version.code === -1) {
    return { ok: false, reason: `opencode could not be started (${version.errorCode})`, fix: 'install OpenCode 2: npm i -g @opencode/cli@2.2.5' }
  }
  const match = VERSION_LINE.exec(version.text)
  if (version.code !== 0 || !match) {
    return { ok: false, reason: `opencode --version exited ${version.code}: ${version.text.trim()}`, fix: 'install OpenCode 2: npm i -g @opencode/cli@2.2.5' }
  }
  const found = `${match[1]}.${match[2]}.${match[3]}`
  if (match[1] !== MEASURED_VERSION.split('.')[0]) {
    return {
      ok: false,
      reason: `opencode ${found} is not the OpenCode 2 CLI this adapter was measured on (${MEASURED_VERSION}); the 1.x line is a different CLI`,
      fix: `install OpenCode 2: npm i -g @opencode/cli@${MEASURED_VERSION}`,
    }
  }
  const auth = await probeCommand('opencode', ['auth', 'list'], env)
  if (auth.timedOut || auth.outputLimited) {
    return { ok: false, reason: 'opencode authentication probe exceeded its execution limits', fix: 'check the OpenCode CLI and retry' }
  }
  if (auth.code !== 0) {
    return { ok: false, reason: `opencode auth list exited ${auth.code}: ${auth.text.trim()}`, fix: 'run: opencode auth login' }
  }
  if (/no authenticated integrations/i.test(auth.text)) {
    return { ok: false, reason: 'opencode reports no authenticated integrations', fix: 'run: opencode auth login' }
  }
  try {
    const dir = await mkdtemp(path.join(home, '.fm-probe-'))
    await rm(dir, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, reason: `${home} is not writable: ${err.code || err.message}`, fix: `ensure ${home} is writable` }
  }
  // The managed layer (`/etc/opencode/` on Linux, MDM on macOS) is merged AFTER
  // OPENCODE_CONFIG_CONTENT, so it can re-allow what this adapter denies and the adapter cannot
  // narrow it back.
  const managed = env.FLEETMATES_OPENCODE_MANAGED_DIR || '/etc/opencode'
  let managedFound = false
  try {
    await lstat(managed)
    managedFound = true
  } catch { /* no managed config */ }

  const warnings = [
    'OpenCode has no operating system sandbox: a teammate\'s shell is limited only by OpenCode\'s own permission rules, which are pattern matching',
    ...(sandboxMode === 'none' ? ['harnesses.opencode.sandbox is "none": even those permission rules are off, so a teammate runs with the full access of the user running fleetmates'] : []),
    ...(managedFound ? [`${managed} is merged after the policy this adapter sets and can re-allow what it denies`] : []),
    ...(found === MEASURED_VERSION ? [] : [`opencode ${found} differs from the measured ${MEASURED_VERSION}; the event format and permission keys are not pinned by any version guarantee`]),
  ]
  return { ok: true, warning: warnings.join('; ') }
}

export async function createVerificationExecutor() { throw new Error('Required OpenCode non-model verification is unsupported') }

export const opencodeAdapter = {
  name: 'opencode',
  createVerificationExecutor,
  defaultSandbox: 'files',
  // `--variant` is part of the model reference (`provider/model#variant`), not a separate flag.
  supportsEffort: false,
  // Checkouts live outside the run repo, where nothing else ever removes them.
  cleanupOnResult: true,
  probe,
  makeSandbox: makeOpenCodeSandbox,
  collect: collectOpenCode,
  cleanup,
  spawn: spawnOpenCode,
  resume: resumeOpenCode,
  readResult,
  readUsage,
  readError,
}
