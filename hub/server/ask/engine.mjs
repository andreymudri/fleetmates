// The Ask engine (M5; 10-memory 2.2, 2.5, 2.6; D-142): runs `claude -p --restricted` with the four vault-mcp read
// tools only, streams its stream-json answer, and enforces one ask per thread, at most `maxConcurrent` at once
// (a FIFO behind them), a 120 s total and a 45 s idle limit, and cancel by process group. It writes only
// under `<stateDir>/ask/` (the empty 0700 cwd of every ask and `running.json`), and reads its own system
// prompts and, on Linux, `/proc` for the identity of the processes it started; the vault is reached by the
// child's own vault-mcp, never from here. Logs carry run and thread ids, lengths, durations and exit codes only.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiError } from '../http/router.mjs'
import { CLAUDE_SESSION_VARS } from '../../deckd/login-env.mjs'

/** The four vault-mcp read tools, the only tools an ask may run (D-132). */
export const ASK_READ_TOOLS = Object.freeze(['vault_search', 'vault_get_note', 'vault_list', 'vault_backlinks'].map(t => `mcp__vault__${t}`))
/** Built-ins and every vault-mcp write tool, denied by name as well. */
export const ASK_DENIED_TOOLS = Object.freeze(['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
  ...['vault_write_note', 'vault_edit_note', 'vault_learn', 'vault_move', 'vault_delete'].map(t => `mcp__vault__${t}`)])

export const ASK_TOTAL_MS = 120_000
export const ASK_IDLE_MS = 45_000
export const ASK_KILL_GRACE_MS = 2_000
export const ASK_DELTA_MS = 50
export const ASK_STDERR_BYTES = 2_000
export const ASK_TIMEOUT_ERROR = 'timed out after 120 s'
export const ASK_NOT_CONNECTED_ERROR = 'vault-mcp did not start for the ask'
export const ASK_INTERRUPTED_ERROR = 'interrupted by a deck restart'

const SEARCH_TOOL = 'mcp__vault__vault_search'
const GET_NOTE_TOOL = 'mcp__vault__vault_get_note'
const MARK = '```deck-answer'
const MARK_RE = /^```deck-answer/m
const EM = '\u2014'
const SEP = ` ${EM} `
const SCORE = ' (score '
/** Longer result lines are not read for paths (vault-mcp's own lines are short). */
export const MAX_RESULT_LINE = 4096

/**
 * Read one vault-mcp result line (contract 1.6) without a backtracking regex, so the work is linear in the
 * line whatever an untrusted title holds:
 * - `- <path> <EM> <title>...` (vault_list, vault_backlinks) gives `{ path, line: null }`; the path ends at
 *   the first `.md <EM> `, so a path that itself holds ` <EM> ` is kept whole;
 * - `<path>:<line> <EM> <trail> (score ...)`, or `<path>:<line> (score ...)` when the chunk has no heading
 *   trail (vault_search), gives `{ path, line }`; the path ends at the first `:<digits>` followed by
 *   ` <EM> ` or ` (score `, so ` <EM> ` inside the path does not cut it.
 * Snippet lines (`> `), lines starting with white space and lines over MAX_RESULT_LINE give null.
 * @param {string} text
 * @returns {{ path: string, line: number | null } | null}
 */
export function parseResultLine (text) {
  if (text.length > MAX_RESULT_LINE || !text || text[0] === '>' || /\s/.test(text[0])) return null
  if (text.startsWith('- ')) {
    const end = text.indexOf(`.md${SEP}`, 2)
    const p = end < 0 ? '' : text.slice(2, end + 3)
    return p.length > 3 && p[0] !== '>' && !/\s/.test(p[0]) ? { path: p, line: null } : null
  }
  if (!text.endsWith(')')) return null
  const score = text.lastIndexOf(SCORE)
  if (score < 0 || text.indexOf(')', score + SCORE.length) !== text.length - 1) return null
  // Each character is read at most twice: once by indexOf, once as a digit after one colon.
  for (let colon = text.indexOf(':'); colon > 0 && colon < score; colon = text.indexOf(':', colon + 1)) {
    let end = colon + 1
    while (end < score && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++
    if (end > colon + 1 && (end === score || text.startsWith(SEP, end))) {
      return { path: text.slice(0, colon), line: Number(text.slice(colon + 1, end)) }
    }
  }
  return null
}

const promptDir = path.dirname(fileURLToPath(import.meta.url))
/** @type {Map<string, string>} */
const promptCache = new Map()

/**
 * The system prompt text for a deck language: `system-prompt.pt.md` for a `pt` language, else the English one.
 * @param {string} [lang]
 * @returns {string}
 */
export function systemPromptFor (lang) {
  const which = /^pt\b/i.test(String(lang ?? '')) ? 'pt' : 'en'
  let text = promptCache.get(which)
  if (text === undefined) {
    text = readFileSync(path.join(promptDir, `system-prompt.${which}.md`), 'utf8')
    promptCache.set(which, text)
  }
  return text
}

/**
 * The `claude -p` argv of 10-memory 2.2, in that order. Each variadic flag (`--mcp-config`, `--tools`,
 * `--allowedTools`, `--disallowedTools`) is followed by one value and then another `--` flag. The MCP config
 * names one stdio server `vault` with only `VAULT_PATH` and `VAULT_LANG` in its env. No `--safe-mode`
 * (D-132) and no `--model` (D-142).
 * @param {{ mcpCommand: string[], vaultPath: string, lang: string, systemPrompt: string }} opts
 * @returns {string[]}
 */
export function askArgv ({ mcpCommand, vaultPath, lang, systemPrompt }) {
  if (!Array.isArray(mcpCommand) || !mcpCommand.length) throw new TypeError('mcpCommand must be a non-empty argv array')
  const config = {
    mcpServers: {
      vault: { type: 'stdio', command: mcpCommand[0], args: mcpCommand.slice(1), env: { VAULT_PATH: vaultPath, VAULT_LANG: lang } }
    }
  }
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--restricted',
    '--strict-mcp-config',
    '--permission-prompts', 'none',
    '--mcp-config', JSON.stringify(config),
    '--tools', '',
    '--allowedTools', ASK_READ_TOOLS.join(','),
    '--disallowedTools', ASK_DENIED_TOOLS.join(','),
    '--append-system-prompt', systemPrompt
  ]
}

/**
 * Whether an environment variable stays out of an ask's env: deck tokens and other `FLEETMATES_DECK_*`
 * variables, API keys, the desktop session (D-Bus, X11, Wayland, SSH agent), `VAULT_AUTO_PUSH` (the
 * vault-mcp child inherits claude's env, and an ask never writes), and Claude Code's per-session variables
 * (`CLAUDE_SESSION_VARS` of deckd's login env, the messaging token among them), so an ask started by a server
 * that itself runs inside a Claude Code session is not taken for that session's child.
 * @param {string} name
 */
function dropped (name) {
  return CLAUDE_SESSION_VARS.includes(name) || /^(DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|SSH_AUTH_SOCK|VAULT_AUTO_PUSH|ANTHROPIC_AUTH_TOKEN)$/.test(name) ||
    /^FLEETMATES_DECK_/.test(name) || /DECK.*TOKEN/i.test(name) || /API_?KEY/i.test(name)
}

/**
 * The env of an ask: `base` without the variables `dropped` names, plus `FLEETMATES_DECK_ROLE=ask`.
 * @param {NodeJS.ProcessEnv} base
 * @returns {NodeJS.ProcessEnv}
 */
export function askEnv (base) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !dropped(k)) env[k] = v
  env.FLEETMATES_DECK_ROLE = 'ask'
  return env
}

/**
 * The text of a tool_result block, whose `content` is a string or a list of text items.
 * @param {any} block
 * @returns {string}
 */
function toolResultText (block) {
  const c = block?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter(i => i?.type === 'text' && typeof i.text === 'string').map(i => i.text).join('\n')
  return ''
}

/**
 * Note paths a vault tool answer returned, and the `{ path, line }` hits of a `vault_search` answer. A
 * `vault_get_note` answer is read up to its first blank line (header and `Links:`), never its raw body;
 * other answers by their result lines, never their `> ` snippets.
 * @param {string} tool
 * @param {string} text
 * @returns {{ paths: string[], hits: { path: string, line: number }[] }}
 */
export function resultPaths (tool, text) {
  const out = []
  /** @type {{ path: string, line: number }[]} */
  const hits = []
  const lines = text.split('\n')
  if (tool === GET_NOTE_TOOL) {
    for (const line of lines) {
      if (!line.trim()) break
      const head = new RegExp(`^(.+?\\.md) ${EM} `).exec(line)
      if (head) out.push(head[1])
      const links = /^Links: (.+)$/.exec(line)
      if (links) for (const p of links[1].split(',')) if (p.trim().endsWith('.md')) out.push(p.trim())
    }
    return { paths: out, hits }
  }
  for (const line of lines) {
    const found = parseResultLine(line)
    if (!found) continue
    out.push(found.path)
    if (found.line !== null && tool === SEARCH_TOOL) hits.push({ path: found.path, line: found.line })
  }
  return { paths: out, hits }
}

/**
 * The result count of a `vault_search` answer: its leading `<n> result(s)` number, else its hit lines
 * (0 for `No results for ...`).
 * @param {string} text
 * @returns {number}
 */
export function resultCount (text) {
  const m = /^(\d+) /.exec(text)
  if (m) return Number(m[1])
  return text.split('\n').filter(l => parseResultLine(l)?.line != null).length
}

/**
 * The part of an answer that may be shown while it streams: everything before the first line starting with
 * the `deck-answer` fence, and, unless `final`, without a last line that could still become that fence.
 * @param {string} text
 * @param {boolean} final
 */
function forwardable (text, final) {
  const m = MARK_RE.exec(text)
  if (m) return text.slice(0, m.index)
  if (final) return text
  const nl = text.lastIndexOf('\n')
  const last = text.slice(nl + 1)
  return last && MARK.startsWith(last) ? text.slice(0, nl + 1) : text
}

/**
 * The identity of a live process on Linux: its start time (field 22 of `/proc/<pid>/stat`, clock ticks since
 * boot) and the boot id (`/proc/sys/kernel/random/boot_id`). Null when either cannot be read (the process is
 * gone, or the system has no `/proc`, as on macOS).
 * @param {number} pid
 * @param {(file: string) => string} [readText] reads a /proc file as text (injected by tests)
 * @returns {{ startTime: string, bootId: string } | null}
 */
export function readProcIdentity (pid, readText = file => readFileSync(file, 'utf8')) {
  try {
    const stat = readText(`/proc/${pid}/stat`)
    // The command name (field 2) is in parentheses and may hold spaces; fields after it start at field 3.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTime = fields[22 - 3]
    const bootId = readText('/proc/sys/kernel/random/boot_id').trim()
    if (!/^\d+$/.test(startTime ?? '') || !bootId) return null
    return { startTime, bootId }
  } catch {
    return null
  }
}

/**
 * @typedef {{
 *   status: 'complete'|'cancelled'|'error', text: string, rawResult: string|null, toolPaths: string[],
 *   searchHits: { path: string, line: number }[],
 *   searches: { query: string, resultCount: number|null }[], durationMs: number, exitCode: number|null,
 *   error: string|null, stderrTail: string
 * }} AskRunResult
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (handle: any) => void }} Timers
 */

/**
 * The Ask engine. `run()` starts or queues one `claude -p`; `cancel()` stops it; `reapOrphans()` kills the
 * process groups a previous server left in `running.json`. `procIdentity` reads a pid's start time and boot
 * id (default `readProcIdentity`), recorded at spawn and checked before a reap.
 * @param {{
 *   claudeCommand: string,
 *   spawn?: typeof nodeSpawn,
 *   stateDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 *   timers?: Timers,
 *   log?: (entry: object) => void,
 *   maxConcurrent?: number,
 *   killGroup?: (pid: number, signal: NodeJS.Signals) => void,
 *   procIdentity?: (pid: number) => { startTime: string, bootId: string } | null
 * }} opts
 */
export function createAskEngine ({
  claudeCommand, spawn = nodeSpawn, stateDir, env = process.env, now = Date.now,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h) },
  log = () => {}, maxConcurrent = 2,
  killGroup = (pid, signal) => { try { process.kill(-pid, signal) } catch {} },
  procIdentity = readProcIdentity
}) {
  const askDir = path.join(stateDir, 'ask')
  const runningFile = path.join(askDir, 'running.json')
  /** @type {Map<string, any>} */
  const byThread = new Map()
  /** @type {Map<string, any>} */
  const runs = new Map()
  /** @type {any[]} */
  const queue = []
  let active = 0

  function ensureDir () {
    mkdirSync(askDir, { recursive: true, mode: 0o700 })
    chmodSync(askDir, 0o700)
  }

  function writeRunning () {
    const list = [...runs.values()].filter(r => r.state === 'running' && r.pid)
      .map(r => ({ runId: r.runId, threadId: r.threadId, pid: r.pid, startedAt: r.startedAt, startTime: r.identity?.startTime ?? null, bootId: r.identity?.bootId ?? null }))
    ensureDir()
    const tmp = `${runningFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ runs: list }) + '\n', { mode: 0o600 })
    renameSync(tmp, runningFile)
  }

  /** @param {any} r @param {boolean} [final] */
  function emitDelta (r, final = false) {
    const shown = forwardable(r.text, final)
    if (shown.length <= r.sent) return
    const chunk = shown.slice(r.sent)
    r.sent = shown.length
    r.lastDeltaAt = now()
    try { r.opts.onDelta?.(chunk) } catch {}
  }

  /** @param {any} r */
  function scheduleDelta (r) {
    if (r.deltaTimer !== null) return
    const wait = r.lastDeltaAt === null ? 0 : Math.max(0, r.lastDeltaAt + ASK_DELTA_MS - now())
    if (wait === 0) {
      emitDelta(r)
      return
    }
    r.deltaTimer = timers.setTimeout(() => {
      r.deltaTimer = null
      if (r.state === 'running') emitDelta(r)
    }, wait)
  }

  /** @param {any} r @param {string} s */
  function appendText (r, s) {
    r.text += s
    scheduleDelta(r)
  }

  /** @param {any} r */
  function resetIdle (r) {
    if (r.idleTimer !== null) timers.clearTimeout(r.idleTimer)
    r.idleTimer = timers.setTimeout(() => expire(r), ASK_IDLE_MS)
  }

  /** @param {any} r */
  function expire (r) {
    if (r.state !== 'running' || r.cancelled) return
    r.timedOut = true
    log({ event: 'ask.engine.timeout', runId: r.runId, threadId: r.threadId })
    killGroup(r.pid, 'SIGKILL')
  }

  /** @param {any} r @param {string} line */
  function handleLine (r, line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'system' && msg.subtype === 'init') {
      const vault = Array.isArray(msg.mcp_servers) ? msg.mcp_servers.find((/** @type {any} */ s) => s?.name === 'vault') : null
      if (!vault || vault.status !== 'connected') {
        r.failure = ASK_NOT_CONNECTED_ERROR
        killGroup(r.pid, 'SIGKILL')
      }
      return
    }
    if (r.failure) return
    if (msg.type === 'stream_event') {
      const ev = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        r.sawDelta = true
        appendText(r, ev.delta.text)
      }
      return
    }
    const content = Array.isArray(msg.message?.content) ? msg.message.content : []
    if (msg.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          r.toolNames.set(block.id, block.name)
          if (block.name === SEARCH_TOOL) {
            const entry = { query: String(block.input?.query ?? ''), resultCount: null }
            r.searches.push(entry)
            r.searchById.set(block.id, entry)
            try { r.opts.onSearch?.({ query: entry.query }) } catch {}
          }
        } else if (block?.type === 'text' && typeof block.text === 'string') {
          r.assistantText.push(block.text)
        }
      }
      return
    }
    if (msg.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue
        const text = toolResultText(block)
        const tool = r.toolNames.get(block.tool_use_id) ?? ''
        if (!block.is_error) {
          const found = resultPaths(tool, text)
          for (const p of found.paths) r.toolPaths.add(p)
          r.searchHits.push(...found.hits)
        }
        const search = r.searchById.get(block.tool_use_id)
        if (search) search.resultCount = block.is_error ? 0 : resultCount(text)
      }
      return
    }
    if (msg.type === 'result') r.result = msg
  }

  /** @param {any} r */
  function settle (r) {
    if (r.state === 'done') return
    const wasRunning = r.state === 'running'
    r.state = 'done'
    for (const key of ['totalTimer', 'idleTimer', 'deltaTimer']) {
      if (r[key] !== null) timers.clearTimeout(r[key])
      r[key] = null
    }
    byThread.delete(r.threadId)
    runs.delete(r.runId)
    if (wasRunning) {
      active--
      try { writeRunning() } catch {}
    }
    if (!r.sawDelta && !r.failure && !r.cancelled) {
      const fallback = r.assistantText.join('\n\n') || (typeof r.result?.result === 'string' && !r.result.is_error ? r.result.result : '')
      r.text += fallback
    }
    if (!r.failure) emitDelta(r, true)
    const stderrTail = r.stderr.toString('utf8').trim()
    /** @type {AskRunResult['status']} */
    let status = 'error'
    let error = null
    if (r.cancelled) status = 'cancelled'
    else if (r.timedOut) error = ASK_TIMEOUT_ERROR
    else if (r.failure) error = r.failure
    else if (r.result?.is_error) error = typeof r.result.result === 'string' && r.result.result ? r.result.result : 'claude ended with an error'
    else if (r.result) status = 'complete'
    else error = `claude exited ${r.exitCode ?? r.signal ?? 'without a result'}${stderrTail ? `: ${stderrTail}` : ''}`
    const durationMs = now() - (r.startedAt ?? r.queuedAt)
    log({ event: 'ask.engine.done', runId: r.runId, threadId: r.threadId, status, exitCode: r.exitCode, durationMs, length: r.text.length })
    r.resolve({
      status,
      text: status === 'error' && r.failure ? '' : r.text,
      rawResult: typeof r.result?.result === 'string' ? r.result.result : null,
      toolPaths: [...r.toolPaths],
      searchHits: r.searchHits.map((/** @type {any} */ h) => ({ ...h })),
      searches: r.searches.map((/** @type {any} */ s) => ({ ...s })),
      durationMs,
      exitCode: r.exitCode,
      error,
      stderrTail
    })
    pump()
  }

  /** @param {any} r */
  function start (r) {
    active++
    r.state = 'running'
    r.startedAt = now()
    const { prompt, mcpCommand, vaultPath, lang } = r.opts
    let child
    try {
      ensureDir()
      const argv = askArgv({ mcpCommand, vaultPath, lang, systemPrompt: systemPromptFor(lang) })
      child = spawn(claudeCommand, argv, { cwd: askDir, env: askEnv(env), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      r.failure = `could not start claude: ${/** @type {any} */ (err).code ?? /** @type {Error} */ (err).message}`
      settle(r)
      return
    }
    r.child = child
    r.pid = child.pid ?? null
    r.identity = r.pid ? procIdentity(r.pid) : null
    log({ event: 'ask.engine.start', runId: r.runId, threadId: r.threadId, length: String(prompt ?? '').length })
    child.on('error', (/** @type {any} */ err) => {
      r.failure ??= `could not start claude: ${err.code ?? err.message}`
      if (!r.pid) settle(r)
    })
    if (r.pid) {
      try { writeRunning() } catch {}
    }
    r.totalTimer = timers.setTimeout(() => expire(r), ASK_TOTAL_MS)
    resetIdle(r)
    const decoder = new StringDecoder('utf8')
    let buf = ''
    const lines = (/** @type {string} */ s) => {
      buf += s
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (r.state !== 'running') continue
        resetIdle(r)
        if (line.trim()) handleLine(r, line)
      }
    }
    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => lines(decoder.write(chunk)))
    child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
      const all = Buffer.concat([r.stderr, chunk])
      r.stderr = all.length > ASK_STDERR_BYTES ? all.subarray(all.length - ASK_STDERR_BYTES) : all
    })
    child.on('close', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
      lines(decoder.end() + '\n')
      r.exitCode = code
      r.signal = signal
      settle(r)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(String(prompt ?? ''))
  }

  function pump () {
    while (active < maxConcurrent && queue.length) start(queue.shift())
  }

  /**
   * Start an ask, or queue it behind `maxConcurrent` running ones. Throws `ask_in_progress` (409) at once
   * when the thread already has one running or queued. The promise carries the run id as `runId`.
   * @param {{
   *   threadId: string, prompt: string, mcpCommand: string[], vaultPath: string, lang: string,
   *   runId?: string, onDelta?: (text: string) => void, onSearch?: (search: { query: string }) => void
   * }} opts
   * @returns {Promise<AskRunResult> & { runId: string }}
   */
  function run (opts) {
    if (byThread.has(opts.threadId)) throw apiError(409, 'ask_in_progress')
    const runId = opts.runId ?? randomUUID()
    /** @type {(value: AskRunResult) => void} */
    let resolve = () => {}
    const promise = /** @type {Promise<AskRunResult> & { runId: string }} */ (new Promise(res => { resolve = res }))
    promise.runId = runId
    const r = {
      runId, threadId: opts.threadId, opts, resolve, state: 'queued', queuedAt: now(), startedAt: null,
      child: null, pid: null, identity: null, text: '', sent: 0, lastDeltaAt: null, deltaTimer: null, totalTimer: null,
      idleTimer: null, sawDelta: false, assistantText: [], toolNames: new Map(), toolPaths: new Set(), searchHits: [],
      searches: [], searchById: new Map(), stderr: Buffer.alloc(0), result: null, failure: null,
      cancelled: false, timedOut: false, exitCode: null, signal: null
    }
    byThread.set(opts.threadId, r)
    runs.set(runId, r)
    queue.push(r)
    pump()
    return promise
  }

  /**
   * Cancel a run: a queued one ends at once as `cancelled`; a running one gets SIGTERM to its process group,
   * then SIGKILL after 2 s, and ends as `cancelled` with its partial text. False for an unknown run id.
   * @param {string} runId
   * @returns {boolean}
   */
  function cancel (runId) {
    const r = runs.get(runId)
    if (!r || r.state === 'done') return false
    r.cancelled = true
    if (r.state === 'queued') {
      queue.splice(queue.indexOf(r), 1)
      settle(r)
      return true
    }
    log({ event: 'ask.engine.cancel', runId: r.runId, threadId: r.threadId })
    if (r.pid) {
      killGroup(r.pid, 'SIGTERM')
      const pid = r.pid
      timers.setTimeout(() => killGroup(pid, 'SIGKILL'), ASK_KILL_GRACE_MS)
    }
    return true
  }

  /**
   * Kill the process groups listed in `running.json` whose leader is still the process the deck started,
   * and empty the list. A group is killed only when the pid's start time and the boot id both match the ones
   * recorded at spawn; an entry without them, or with a pid now held by another process (pid reuse after a
   * reboot or a long downtime), is dropped without killing anything. Returns the thread id of every listed
   * run, killed or already gone: all of them were interrupted by the restart. Call it once at start, before
   * the first `run()`.
   * @returns {string[]}
   */
  function reapOrphans () {
    /** @type {any[]} */
    let listed = []
    try {
      const parsed = JSON.parse(readFileSync(runningFile, 'utf8'))
      if (Array.isArray(parsed?.runs)) listed = parsed.runs
    } catch {}
    const threads = []
    for (const e of listed) {
      if (Number.isInteger(e?.pid) && e.pid > 1 && typeof e.startTime === 'string' && typeof e.bootId === 'string') {
        const current = procIdentity(e.pid)
        if (current && current.startTime === e.startTime && current.bootId === e.bootId) killGroup(e.pid, 'SIGKILL')
      }
      if (typeof e?.threadId === 'string') threads.push(e.threadId)
    }
    writeRunning()
    if (listed.length) log({ event: 'ask.engine.reaped', count: listed.length })
    return threads
  }

  /** Runs in flight and queued, for health and tests. */
  function stats () {
    return { running: active, queued: queue.length }
  }

  return { run, cancel, reapOrphans, stats }
}
