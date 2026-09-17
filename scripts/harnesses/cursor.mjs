// The only module in this repository that knows the Cursor CLI (`cursor-agent`), per
// docs/specs/2026-09-16-headless-driver-cursor-design.md. Everything else talks to
// `cursorAdapter` through the harness-neutral interface (`scripts/harnesses/index.mjs`).
//
// Teammates only ever run in a git-less `files` checkout (spec §2): Cursor runs git outside its
// own sandbox (§1 item 9), so no layout that leaves a repository in the workspace is safe.
import { spawn as spawnProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateResult } from '../result-schema.mjs'
import { makeFilesSandbox, scrubControlPaths, commitFilesTree, FILES_PREAMBLE } from './files-sandbox.mjs'

export { FILES_PREAMBLE }

// `--force`/`--yolo` switch Cursor's sandbox off entirely (§1 item 6); `--approve-mcps` starts
// workspace MCP servers unasked; `--worktree` moves the session out of our checkout; `--api-key`
// would put a credential in argv. None of them may ever reach a teammate's command line.
const FORBIDDEN_FLAGS = ['--force', '-f', '--yolo', '--approve-mcps', '--worktree', '-w', '--api-key']

export function assertSafeArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const flag = arg.split('=')[0]
    if (FORBIDDEN_FLAGS.includes(flag)) throw new Error(`cursor argv contains forbidden flag ${flag}`)
    if (flag === '--sandbox' && (arg.includes('=') ? arg.split('=')[1] : argv[i + 1]) !== 'enabled') {
      throw new Error('cursor argv contains forbidden flag --sandbox without "enabled"')
    }
  }
  return argv
}

// With no `--model`, cursor-agent does not fall back to `auto`: it picks a named default, which a
// free plan refuses at the first call ("Named models unavailable Free plans can only use Auto",
// exit 1). An unmapped tier therefore asks for `auto` explicitly.
function baseArgs({ sandbox, model }) {
  return ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--workspace', sandbox.cwd,
    '--model', model || 'auto']
}

export function buildSpawnArgv({ sandbox, model }) {
  return assertSafeArgv(baseArgs({ sandbox, model }))
}

export function buildResumeArgv({ sandbox, sessionId, model }) {
  return assertSafeArgv([...baseArgs({ sandbox, model }), '--resume', sessionId])
}

// Cursor has no output-schema flag (§4.4), so the contract travels in the prompt and `readResult`
// validates what comes back. Appended to every spawn prompt and resume message in a `files`
// checkout only: a `full` sandbox (reviewers, integrator) works in the real repository with git,
// and its persona already defines what it returns.
export const RESULT_INSTRUCTION = '\n\n---\n'
  + 'This workspace is a plain directory with no git repository: do not run git, and do not try to '
  + 'commit. When you finish, the host commits every file in the workspace for you. Files under '
  + '.cursor/ that configure hooks, sandbox, CLI or MCP, .claude/settings*.json and .vscode/ are '
  + 'reset by the host; changing them fails the task.\n'
  + 'Your final message must be exactly one JSON object and nothing else, with exactly these keys: '
  + '"status" ("done", "blocked" or "failed"), "branch" (string), "filesChanged" (array of '
  + 'strings), "summary" (string), "blockers" (array of strings).'

function withInstruction(sandbox, text) {
  return sandbox.meta.mode === 'files' ? `${FILES_PREAMBLE}${text}${RESULT_INSTRUCTION}` : text
}

// Scrub, then write the driver's own policy (§4.2). Only a `files` checkout is touched: a `full`
// sandbox is the user's own repository (reviewers, integrator), whose control files are theirs.
// A control-path refusal is recorded next to the checkout — in the checkout root, which the sandbox
// cannot write (measured: sibling paths of a workspace are denied) — because the scrub that detects
// the violation also removes the evidence. Without the marker a re-dispatch resumes the cleaned
// checkout and commits it.
const refusalMarker = (sandbox) => `${sandbox.cwd}.control-path`

async function priorRefusal(sandbox) {
  try {
    return (await readFile(refusalMarker(sandbox), 'utf8')).trim()
  } catch {
    return null
  }
}

async function prepareWorkspace(sandbox, network) {
  if (sandbox.meta.mode !== 'files') return
  const refused = await priorRefusal(sandbox)
  if (refused) throw new Error(`control-path: ${refused}`)
  await scrubControlPaths(sandbox.cwd)
  const text = JSON.stringify({ type: 'workspace_readwrite', networkPolicy: { default: network ? 'allow' : 'deny' } })
  await mkdir(path.join(sandbox.cwd, '.cursor'), { recursive: true })
  await writeFile(path.join(sandbox.cwd, '.cursor', 'sandbox.json'), text)
  sandbox.meta.sandboxJson = text
}

// A cursor-agent process with the prompt on stdin, stdin then closed (§1 item 3). The session id
// resolves from the first `system/init` line. A resume appends to the stream so `readUsage` still
// sees the first session's result line. `flushed` resolves once the stream file holds every byte
// the child wrote: the child's 'exit' can fire before the write stream finishes, and `readResult`
// reads that file, so the driver awaits `flushed` before reading.
function run(argv, { promptText, streamPath, errPath, cwd, append }) {
  const child = spawnProcess('cursor-agent', argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const flags = append ? 'a' : 'w'
  const out = createWriteStream(streamPath, { flags })
  const err = createWriteStream(errPath ?? `${streamPath}.err`, { flags })
  child.stderr.pipe(err)
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
    out.write(chunk)
    if (idFound) return
    buffer += chunk.toString('utf8')
    let nl
    while (!idFound && (nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      let evt
      try { evt = JSON.parse(line) } catch { continue }
      if (evt && evt.type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
        settle(evt.session_id)
      }
    }
  })
  child.stdout.on('end', () => {
    out.end()
    settle(null)
  })
  child.on('error', () => settle(null))
  child.stdin.on('error', () => {})
  child.stdin.end(promptText)
  return { child, sessionId, flushed }
}

export async function spawnCursor({ sandbox, prompt, model, network, streamPath, errPath }) {
  await prepareWorkspace(sandbox, network)
  const argv = buildSpawnArgv({ sandbox, model })
  return run(argv, { promptText: withInstruction(sandbox, prompt), streamPath, errPath, cwd: sandbox.cwd, append: false })
}

export async function resumeCursor({ sandbox, sessionId, message, model, network, streamPath, errPath }) {
  await prepareWorkspace(sandbox, network)
  const argv = buildResumeArgv({ sandbox, sessionId, model })
  return run(argv, { promptText: withInstruction(sandbox, message), streamPath, errPath, cwd: sandbox.cwd, append: true })
}

async function streamEvents(streamPath) {
  let raw
  try {
    raw = await readFile(streamPath, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const evt = JSON.parse(line)
      if (evt && typeof evt === 'object') events.push(evt)
    } catch { /* a partial or foreign line */ }
  }
  return events
}

const resultLines = async (streamPath) => (await streamEvents(streamPath)).filter((e) => e.type === 'result')

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

// The turn's result, validated. Cursor's `result` field is the CONCATENATION of every assistant
// message in the turn (measured: "Creating `hello.txt`…{\"status\":…}"), so the last assistant
// message is read first and `result` is the fallback. Only the events after the last `user` line
// count, so a resume never returns the previous session's answer. `null` — never a throw — for
// anything that is not a valid result: every such case is `orphaned`, not a driver crash.
export async function readResult({ streamPath }) {
  const events = await streamEvents(streamPath)
  let start = 0
  events.forEach((e, i) => { if (e.type === 'user') start = i })
  const turn = events.slice(start)
  const result = turn.filter((e) => e.type === 'result').pop()
  if (!result || result.is_error) return null
  const texts = []
  const assistant = turn.filter((e) => e.type === 'assistant').pop()
  const parts = assistant?.message?.content
  if (Array.isArray(parts)) {
    const text = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
    if (text) texts.push(text)
  }
  if (typeof result.result === 'string') texts.push(result.result)
  for (const text of texts) {
    for (const candidate of parseCandidates(text)) {
      if (validateResult(candidate)) return candidate
    }
  }
  return null
}

export async function readUsage({ streamPath }) {
  const lines = (await resultLines(streamPath)).filter((l) => l.usage && typeof l.usage === 'object')
  if (!lines.length) return null
  const totals = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  for (const { usage: u } of lines) {
    totals.input += u.inputTokens || 0
    totals.cachedInput += u.cacheReadTokens || 0
    totals.cacheWrite += u.cacheWriteTokens || 0
    totals.output += u.outputTokens || 0
  }
  return totals
}

// Where Cursor checkouts live: outside the run repo AND outside every git repository. Cursor loads
// `.cursor/hooks.json` from the root of the git repository enclosing its workspace and runs those
// hooks outside the sandbox (measured: a nested workspace fired the repo root's `sessionStart`; a
// plain parent directory's did not). Never a temp directory either — temp dirs are writable from
// every sandbox, so one teammate could reach another's checkout.
export function cursorCheckoutRoot({ runRepo, runId, env = process.env }) {
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  const repoKey = createHash('sha256').update(path.resolve(runRepo)).digest('hex').slice(0, 16)
  return path.join(cache, 'fleetmates', 'cursor', repoKey, runId)
}

// The nearest ancestor of `dir` holding a `.git` entry, or null. Plain filesystem checks: no git
// command ever runs against a checkout.
export async function enclosingGitRoot(dir) {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    try {
      await lstat(path.join(cur, '.git'))
      return cur
    } catch { /* keep walking */ }
    if (path.dirname(cur) === cur) return null
  }
}

export async function makeCursorSandbox(git, { runRepo, runBranch, runId, taskId, mode, env = process.env }) {
  if (mode !== 'files') throw new Error('Cursor runs git outside its sandbox; only "files" is supported')
  const checkoutRoot = cursorCheckoutRoot({ runRepo, runId, env })
  await mkdir(checkoutRoot, { recursive: true })
  const repo = await enclosingGitRoot(checkoutRoot)
  if (repo) {
    throw new Error(`Cursor checkouts must not live inside a git repository, but ${checkoutRoot} is inside ${repo}: `
      + 'Cursor runs that repository\'s .cursor/hooks.json outside its sandbox. Point XDG_CACHE_HOME outside it.')
  }
  return makeFilesSandbox(git, { runRepo, runBranch, runId, taskId, checkoutRoot })
}

// Refuses the task when the teammate touched a control path (§4.2); otherwise the host commits
// the checkout. The driver's own `sandbox.json`, byte-identical to what it wrote, is expected.
export async function collectCursor(git, { runRepo, sandbox, branch }) {
  if (sandbox.meta.mode !== 'files') return
  const refused = await priorRefusal(sandbox)
  if (refused) throw new Error(`control-path: ${refused}`)
  let policy = null
  try {
    policy = await readFile(path.join(sandbox.cwd, '.cursor', 'sandbox.json'), 'utf8')
  } catch { /* absent: nothing to excuse */ }
  const found = await scrubControlPaths(sandbox.cwd)
  const unexpected = found.filter((rel) => !(rel === '.cursor/sandbox.json'
    && typeof sandbox.meta.sandboxJson === 'string' && policy === sandbox.meta.sandboxJson))
  if (unexpected.length) {
    await writeFile(refusalMarker(sandbox), unexpected.join(', '))
    throw new Error(`control-path: ${unexpected.join(', ')}`)
  }
  await commitFilesTree(git, { runRepo, runBranch: sandbox.meta.runBranch, sandbox, branch })
}

// Removes a finished task's checkout, then its now-empty run and repo directories (never the shared
// `fleetmates/cursor` root, and never a directory that still holds another task's checkout).
export async function cleanup({ sandbox }) {
  if (sandbox.meta.mode !== 'files') return
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

function status(env) {
  return new Promise((resolve) => {
    let text = ''
    const child = spawnProcess('cursor-agent', ['status'], { env })
    child.stdout.on('data', (d) => { text += d })
    child.stderr.on('data', (d) => { text += d })
    child.on('error', (err) => resolve({ code: -1, text: '', errorCode: err.code }))
    child.on('close', (code) => resolve({ code: code ?? 1, text }))
  })
}

// Logged in, config home writable, and no global policy that widens every teammate (§4.5). Never
// runs an agent turn.
export async function probe({ env = process.env } = {}) {
  const home = env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor')
  const st = await status(env)
  if (st.code === -1) {
    return { ok: false, reason: `cursor-agent could not be started (${st.errorCode})`, fix: 'install the Cursor CLI' }
  }
  if (/not logged in/i.test(st.text)) {
    return { ok: false, reason: 'cursor-agent reports it is not logged in', fix: 'run: cursor-agent login' }
  }
  if (st.code !== 0) {
    return { ok: false, reason: `cursor-agent status exited ${st.code}: ${st.text.trim()}`, fix: 'run: cursor-agent login' }
  }
  try {
    const dir = await mkdtemp(path.join(home, '.fm-probe-'))
    await rm(dir, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, reason: `${home} is not writable: ${err.code || err.message}`, fix: `ensure ${home} is writable` }
  }

  const globalPolicy = path.join(home, 'sandbox.json')
  let raw = null
  try {
    raw = await readFile(globalPolicy, 'utf8')
  } catch { /* no global policy */ }
  if (raw !== null) {
    let policy
    try {
      policy = JSON.parse(raw)
    } catch {
      return { ok: false, reason: `${globalPolicy} is not valid JSON`, fix: `fix or remove ${globalPolicy}` }
    }
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
      return { ok: false, reason: `${globalPolicy} is not a JSON object`, fix: `fix or remove ${globalPolicy}` }
    }
    const widens = (policy.type !== undefined && policy.type !== 'workspace_readwrite')
      || (Array.isArray(policy.additionalReadwritePaths) && policy.additionalReadwritePaths.length > 0)
      || (policy.networkPolicy && policy.networkPolicy.default === 'allow')
    if (widens) {
      return {
        ok: false,
        reason: `${globalPolicy} widens every teammate's sandbox (type, additionalReadwritePaths or networkPolicy.default "allow")`,
        fix: `remove those settings from ${globalPolicy}; use harnesses.cursor.network for network access`,
      }
    }
  }

  try {
    await readFile(path.join(home, 'hooks.json'))
    return { ok: true, warning: `${path.join(home, 'hooks.json')} runs outside the sandbox for every Cursor teammate` }
  } catch {
    return { ok: true }
  }
}

export const cursorAdapter = {
  name: 'cursor',
  defaultSandbox: 'files',
  supportsEffort: false,
  // Checkouts live outside the run repo, where nothing else ever removes them.
  cleanupOnResult: true,
  probe,
  makeSandbox: makeCursorSandbox,
  collect: collectCursor,
  cleanup,
  spawn: spawnCursor,
  resume: resumeCursor,
  readResult,
  readUsage,
}
