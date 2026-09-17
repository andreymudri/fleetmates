// The only module in this repository that knows the Cursor CLI (`cursor-agent`), per
// docs/specs/2026-09-16-headless-driver-cursor-design.md. Everything else talks to
// `cursorAdapter` through the harness-neutral interface (`scripts/harnesses/index.mjs`).
//
// Teammates only ever run in a git-less `files` checkout (spec §2): Cursor runs git outside its
// own sandbox (§1 item 9), so no layout that leaves a repository in the workspace is safe.
import { spawn as spawnProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateResult } from '../result-schema.mjs'
import { makeFilesSandbox, scrubControlPaths, commitFilesTree } from './files-sandbox.mjs'

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

function baseArgs({ sandbox, model }) {
  const args = ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled', '--workspace', sandbox.cwd]
  if (model) args.push('--model', model)
  return args
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
  return sandbox.meta.mode === 'files' ? `${text}${RESULT_INSTRUCTION}` : text
}

// Scrub, then write the driver's own policy (§4.2). Only a `files` checkout is touched: a `full`
// sandbox is the user's own repository (reviewers, integrator), whose control files are theirs.
async function prepareWorkspace(sandbox, network) {
  if (sandbox.meta.mode !== 'files') return
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

async function resultLines(streamPath) {
  let raw
  try {
    raw = await readFile(streamPath, 'utf8')
  } catch {
    return []
  }
  const lines = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let evt
    try { evt = JSON.parse(line) } catch { continue }
    if (evt && evt.type === 'result') lines.push(evt)
  }
  return lines
}

function parseResultText(text) {
  try {
    return JSON.parse(text)
  } catch { /* fall through to the fenced form */ }
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)]
  if (!fences.length) return null
  try {
    return JSON.parse(fences[fences.length - 1][1])
  } catch {
    return null
  }
}

// The last `result` line's text, parsed and validated. `null` — never a throw — for anything that
// is not a valid result, because every such case is `orphaned`, not a driver crash.
export async function readResult({ streamPath }) {
  const lines = await resultLines(streamPath)
  const last = lines[lines.length - 1]
  if (!last || last.is_error || typeof last.result !== 'string') return null
  const parsed = parseResultText(last.result.trim())
  return validateResult(parsed) ? parsed : null
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

export async function makeCursorSandbox(git, { runRepo, runBranch, runId, taskId, mode }) {
  if (mode !== 'files') throw new Error('Cursor runs git outside its sandbox; only "files" is supported')
  return makeFilesSandbox(git, { runRepo, runBranch, runId, taskId })
}

// Refuses the task when the teammate touched a control path (§4.2); otherwise the host commits
// the checkout. The driver's own `sandbox.json`, byte-identical to what it wrote, is expected.
export async function collectCursor(git, { runRepo, sandbox, branch }) {
  if (sandbox.meta.mode !== 'files') return
  let policy = null
  try {
    policy = await readFile(path.join(sandbox.cwd, '.cursor', 'sandbox.json'), 'utf8')
  } catch { /* absent: nothing to excuse */ }
  const found = await scrubControlPaths(sandbox.cwd)
  const unexpected = found.filter((rel) => !(rel === '.cursor/sandbox.json'
    && typeof sandbox.meta.sandboxJson === 'string' && policy === sandbox.meta.sandboxJson))
  if (unexpected.length) throw new Error(`control-path: ${unexpected.join(', ')}`)
  await commitFilesTree(git, { runRepo, runBranch: sandbox.meta.runBranch, sandbox, branch })
}

export async function cleanup({ sandbox }) {
  if (sandbox.meta.mode !== 'files') return
  await rm(sandbox.cwd, { recursive: true, force: true })
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
  probe,
  makeSandbox: makeCursorSandbox,
  collect: collectCursor,
  cleanup,
  spawn: spawnCursor,
  resume: resumeCursor,
  readResult,
  readUsage,
}
