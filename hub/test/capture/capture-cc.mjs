#!/usr/bin/env node
// Capture hook and screen fixtures from the real Claude Code on this machine
// (docs/deck/09-testing.md section 5.2, steps 1 to 4 and 6, hooks and screens only).
// It starts ONE real Claude Code session on the owner's subscription. See README.md.
//
// Usage: node test/capture/capture-cc.mjs [--out <dir>] [--unattended] [--cols 120] [--rows 40]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const SCRIPT_VERSION = '0.1.0'
const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const captureHook = path.join(hubDir, 'test', 'capture', 'capture-hook.mjs')

/** Events from docs/deck/04-integrations.md section 2.1. */
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop',
  'SubagentStart', 'SubagentStop', 'CwdChanged', 'PreCompact', 'PostCompact',
  'WorktreeCreate', 'WorktreeRemove'
]

const CMD = 'echo capture-ok'
const QUESTION = 'Should I paginate or truncate?'
const PROMPTS = {
  bash: `Run this exact Bash command with the Bash tool and nothing else: ${CMD}`,
  edit: 'Use the Edit tool to append a line saying capture-edit to notes.txt. Do nothing else.',
  ask: 'Use the AskUserQuestion tool to ask me to pick A or B',
  question: `Do not use any tool. Reply with only this sentence: ${QUESTION}`
}

// Redaction (docs/deck/09-testing.md section 4).
/** What the redaction below replaces, recorded in MANIFEST.json. */
export const REDACTIONS = [
  'throwaway repo path -> /home/you/fixture-repo',
  '$HOME -> /home/you',
  'account email (~/.claude.json oauthAccount) -> you@example.com, any case',
  'account display name -> You, any case',
  'account organization name -> Example Org, any case',
  'username -> you, any case',
  'session ids -> fixed ULIDs',
  'transcript_path -> /home/you/.claude/projects/fixture/<id>.jsonl',
  'typed prompts -> "fixture prompt: <step>"',
  'JWTs (eyJ...eyJ...sig) -> REDACTED',
  'token-like runs (40+ base64, base64url or hex chars with a letter and a digit, / included, matched across escape sequences) -> REDACTED'
]

const JWT_RE = /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g
const TOKEN_RUN_RE = /[A-Za-z0-9+/_=-]{40,}/g
// CSI, OSC and two-byte escape sequences.
const ESC_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
/** @param {string} s */
const secretLike = s => s.length >= 40 && /\d/.test(s) && /[A-Za-z]/.test(s)

/**
 * [start, end) spans of JWTs and token-like runs in escape-free text.
 * @param {string} plain
 * @returns {[number, number][]}
 */
function tokenSpans (plain) {
  /** @type {[number, number][]} */
  const spans = []
  for (const m of plain.matchAll(JWT_RE)) spans.push([/** @type {number} */ (m.index), /** @type {number} */ (m.index) + m[0].length])
  let masked = plain
  for (const [a, b] of spans) masked = masked.slice(0, a) + ' '.repeat(b - a) + masked.slice(b)
  for (const m of masked.matchAll(TOKEN_RUN_RE)) {
    const run = m[0]
    const at = /** @type {number} */ (m.index)
    const before = masked[at - 1]
    const pathLike = run.startsWith('/') || before === '.' || before === '~'
    if (run.split('/').some(secretLike) || (!pathLike && secretLike(run))) spans.push([at, at + run.length])
  }
  return spans.sort((x, y) => x[0] - y[0])
}

/**
 * Replace JWTs and token-like runs with REDACTED. A run of base64 characters
 * (including `/` and `=`) is redacted when one `/`-separated piece is 40+ chars with a
 * letter and a digit, or when the whole run is and it does not look like a path: a path
 * run starts with `/` or follows a `.` or `~`, as in `/home/you/.claude/projects/...`.
 * Matching runs on the text with escape sequences removed, so a token split by colour or
 * cursor codes is still found; the escape sequences inside it are kept after REDACTED.
 * @param {string} s
 * @returns {string}
 */
export function redactTokens (s) {
  let plain = ''
  /** @type {number[]} index in s of each char of plain */
  const pos = []
  let last = 0
  const keep = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let i = from; i < to; i++) { plain += s[i]; pos.push(i) }
  }
  for (const m of s.matchAll(ESC_RE)) {
    keep(last, /** @type {number} */ (m.index))
    last = /** @type {number} */ (m.index) + m[0].length
  }
  keep(last, s.length)
  let out = ''
  let cursor = 0
  for (const [a, b] of tokenSpans(plain)) {
    const from = pos[a]
    const to = pos[b - 1] + 1
    out += s.slice(cursor, from) + 'REDACTED' + (s.slice(from, to).match(ESC_RE) ?? []).join('')
    cursor = to
  }
  return out + s.slice(cursor)
}

/**
 * The account fields that can show on screen, from `<home>/.claude.json` `oauthAccount`.
 * Missing or unreadable file: an empty object.
 * @param {string} home
 * @returns {Promise<{ emailAddress?: string, displayName?: string, organizationName?: string }>}
 */
export async function readAccount (home) {
  try {
    const acct = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')).oauthAccount ?? {}
    /** @type {Record<string, string>} */
    const out = {}
    for (const k of ['emailAddress', 'displayName', 'organizationName']) {
      if (typeof acct[k] === 'string' && acct[k].trim()) out[k] = acct[k]
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Replace every occurrence of `literal`, ignoring case.
 * @param {string} s
 * @param {string} literal
 * @param {string} replacement
 */
const replaceAnyCase = (s, literal, replacement) =>
  s.replace(new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replacement)

/**
 * Build the redaction functions for one capture run.
 * @param {{ repo: string, home?: string, user?: string, prompts?: Record<string, string>,
 *   account?: { emailAddress?: string, displayName?: string, organizationName?: string } }} opts
 */
export function createRedactor ({ repo, home, user, prompts = {}, account = {} }) {
  /** @type {Map<string, string>} */
  const sessionMap = new Map()
  /**
   * The fixed ULID for a session id, assigned in order of first sight.
   * @param {string} id
   */
  const ulidFor = id => {
    if (!sessionMap.has(id)) sessionMap.set(id, '01J' + String(sessionMap.size + 1).padStart(23, '0'))
    return /** @type {string} */ (sessionMap.get(id))
  }
  /** @type {[string | undefined, string][]} */
  const people = [
    [account.emailAddress, 'you@example.com'],
    [account.displayName, 'You'],
    [account.organizationName, 'Example Org']
  ]
  /**
   * Path, account, username and token redaction for any text.
   * @param {string} s
   * @returns {string}
   */
  const redactText = s => {
    let out = repo ? s.replaceAll(repo, '/home/you/fixture-repo') : s
    if (home) out = out.replaceAll(home, '/home/you')
    for (const [literal, placeholder] of people) if (literal && literal.length >= 2) out = replaceAnyCase(out, literal, placeholder)
    if (user && user.length >= 3) out = replaceAnyCase(out, user, 'you')
    return redactTokens(out)
  }
  /**
   * @param {any} v
   * @returns {any}
   */
  const redactValue = v => {
    if (typeof v === 'string') {
      let s = v
      for (const [step, prompt] of Object.entries(prompts)) s = s.replaceAll(prompt, `fixture prompt: ${step}`)
      for (const [id] of sessionMap) s = s.replaceAll(id, ulidFor(id))
      return redactText(s)
    }
    if (Array.isArray(v)) return v.map(redactValue)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)]))
    return v
  }
  /**
   * Redact one hook payload; its session_id becomes a fixed ULID.
   * @param {Record<string, any>} p
   */
  const redactPayload = p => {
    if (typeof p.session_id === 'string') ulidFor(p.session_id)
    const out = redactValue(p)
    if (typeof p.transcript_path === 'string') out.transcript_path = `/home/you/.claude/projects/fixture/${out.session_id ?? 'unknown'}.jsonl`
    return out
  }
  return { redactText, redactValue, redactPayload, ulidFor }
}

/** Run one capture (steps 1 to 4 and 6). Exits the process. */
async function main () {
  const { values: opts } = parseArgs({
    options: {
      out: { type: 'string', default: path.join(hubDir, 'test', 'fixtures') },
      unattended: { type: 'boolean', default: false },
      cols: { type: 'string', default: '120' },
      rows: { type: 'string', default: '40' },
      help: { type: 'boolean', default: false }
    }
  })
  if (opts.help) {
    process.stdout.write('usage: capture-cc.mjs [--out <dir>] [--unattended] [--cols 120] [--rows 40]\n')
    process.exit(0)
  }
  const cols = Number(opts.cols)
  const rows = Number(opts.rows)
  const stepTimeoutMs = Number(process.env.CAPTURE_STEP_TIMEOUT_MS || 120000)

  // Version gate: refuse before creating or starting anything.
  const pkg = JSON.parse(readFileSync(path.join(hubDir, 'package.json'), 'utf8'))
  const tested = pkg.fleetmatesDeck?.testedClaudeCode
  let versionOutput
  try {
    versionOutput = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000 }).trim()
  } catch (err) {
    process.stderr.write(`cannot run claude --version: ${/** @type {Error} */ (err).message}\n`)
    process.exit(1)
  }
  const version = versionOutput.split(/\s+/)[0]
  if (version !== tested) {
    process.stderr.write(`claude --version reports ${version} ("${versionOutput}") but hub/package.json fleetmatesDeck.testedClaudeCode is ${tested}; refusing to capture\n`)
    process.exit(1)
  }

  const [{ default: pty }, headless] = await Promise.all([import('node-pty'), import('@xterm/headless')])
  const Terminal = headless.Terminal ?? headless.default?.Terminal

  /** @param {number} ms */
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  /** @param {string} s */
  const latin1 = s => Buffer.from(s, 'utf8').toString('latin1')

  // Step 1: throwaway repo with a project-level capture hook for every event.
  const repo = await mkdtemp(path.join(os.tmpdir(), 'deck-capture-repo-'))
  const raw = await mkdtemp(path.join(os.tmpdir(), 'deck-capture-raw-'))
  // Every exit path from here on removes both temp dirs and stops claude.
  let killChild = () => {}
  try {
    const hooksLog = path.join(raw, 'hooks.jsonl')
    const shq = (/** @type {string} */ s) => `'${s.replaceAll("'", "'\\''")}'`
    const hookCommand = `CAPTURE_OUT=${shq(raw)} ${shq(process.execPath)} ${shq(captureHook)}`
    const settingsLocal = JSON.stringify({
      hooks: Object.fromEntries(EVENTS.map(e => [e, [{ hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] }]]))
    }, null, 2) + '\n'
    await mkdir(path.join(repo, '.claude'))
    await writeFile(path.join(repo, '.claude', 'settings.local.json'), settingsLocal)
    await writeFile(path.join(repo, 'README.md'), '# capture fixture repo\n\nThrowaway repo for deck fixture capture.\n')
    await writeFile(path.join(repo, 'notes.txt'), 'first line\n')
    const git = (/** @type {string[]} */ ...a) => execFileSync('git', ['-c', 'user.name=capture', '-c', 'user.email=capture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: repo, stdio: 'ignore' })
    git('init', '-q')
    git('add', 'README.md', 'notes.txt')
    git('commit', '-qm', 'init')

    // Step 2: the real claude in node-pty at a fixed size, with a headless terminal attached.
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, CAPTURE_OUT: raw }
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    let lastOutputAt = Date.now()
    let exited = false
    const child = pty.spawn('claude', [], { cwd: repo, env: /** @type {Record<string, string>} */ (env), cols, rows, name: 'xterm-256color' })
    killChild = () => { try { child.kill('SIGKILL') } catch {} }
    child.onData(d => {
      const b = Buffer.from(d, 'utf8')
      chunks.push(b)
      total += b.length
      lastOutputAt = Date.now()
      term.write(d)
    })
    /** @type {Promise<{ exitCode: number }>} */
    const exitPromise = new Promise(resolve => child.onExit(e => { exited = true; resolve(e) }))

    const mark = () => total
    /** @param {number} from */
    const bytesSince = from => Buffer.concat(chunks).subarray(from)
    const screenText = () => {
      const buf = term.buffer.active
      const out = []
      for (let i = 0; i < rows; i++) out.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '')
      return out.join('\n')
    }

    /** @type {{ receivedAt: number, payload: Record<string, any> }[]} */
    let hooks = []
    async function readHooks () {
      const text = await readFile(hooksLog, 'utf8').catch(() => '')
      hooks = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
      return hooks
    }

    /**
     * Wait for a hook record at index >= from matching pred.
     * @param {number} from
     * @param {(p: Record<string, any>) => boolean} pred
     * @param {number} [timeoutMs]
     */
    async function waitHook (from, pred, timeoutMs = stepTimeoutMs) {
      const end = Date.now() + timeoutMs
      while (Date.now() < end && !exited) {
        const found = (await readHooks()).slice(from).find(h => pred(h.payload))
        if (found) return found
        await sleep(200)
      }
      return undefined
    }

    /**
     * Wait until the PTY has been silent for quietMs.
     * @param {number} quietMs
     * @param {number} [timeoutMs]
     */
    async function waitQuiet (quietMs, timeoutMs = stepTimeoutMs) {
      const end = Date.now() + timeoutMs
      while (Date.now() < end && !exited) {
        if (Date.now() - lastOutputAt >= quietMs) return true
        await sleep(100)
      }
      return false
    }

    /** @param {string} text */
    async function typePrompt (text) {
      child.write(text)
      await sleep(400)
      child.write('\r')
    }

    const { redactText, redactPayload, ulidFor } = createRedactor({ repo, home: os.homedir(), user: os.userInfo().username, prompts: PROMPTS, account: await readAccount(os.homedir()) })

    // Frames.
    const screensDir = path.join(opts.out, 'screens', version)
    const hooksDir = path.join(opts.out, 'hooks', version)
    /** @type {Record<string, { bytes: number, placeholders: Record<string, number> }>} */
    const frames = {}
    /**
     * Write the raw PTY bytes since `from` as a frame, once per name.
     * @param {string} name
     * @param {number} from
     * @param {Record<string, string>} [vars] placeholder name -> literal text to replace
     */
    async function saveFrame (name, from, vars = {}) {
      if (frames[name]) return
      let text = bytesSince(from).toString('latin1')
      /** @type {Record<string, number>} */
      const placeholders = {}
      for (const [k, literal] of Object.entries(vars)) {
        const parts = text.split(latin1(literal))
        placeholders[k] = parts.length - 1
        text = parts.join(`{{${k}}}`)
      }
      text = latin1(redactText(Buffer.from(text, 'latin1').toString('utf8')))
      await mkdir(screensDir, { recursive: true })
      await writeFile(path.join(screensDir, `${name}.ansi`), Buffer.from(text, 'latin1'))
      frames[name] = { bytes: Buffer.byteLength(text, 'latin1'), placeholders }
      log(`frame ${name}: ${frames[name].bytes} bytes`)
    }

    /** @param {string} msg */
    function log (msg) {
      process.stderr.write(`[capture] ${msg}\n`)
    }

    /** Numbered options visible on screen, e.g. "1. Yes". */
    function visibleOptions () {
      return screenText().split('\n').filter(l => /^\s*[❯>›]?\s*\d\.\s+\S/.test(l)).length
    }

    // Step 3: the scenario. Each step returns true when it saw what it waited for.
    let idleMark = 0
    /** @type {Record<string, [number, number]>} */
    const windows = {}
    /** @type {{ step: string, reason: string }[]} */
    const skipped = []
    const rl = opts.unattended ? undefined : readline.createInterface({ input: process.stdin, output: process.stderr })

    /**
     * Run a step with retries: unattended retries up to 2 times then skips; attended asks.
     * @param {string} name
     * @param {() => Promise<string | true>} fn returns true, or a failure reason
     */
    async function step (name, fn) {
      for (let attempt = 1; ; attempt++) {
        if (exited) {
          skipped.push({ step: name, reason: 'claude exited before this step' })
          return
        }
        log(`step ${name}, attempt ${attempt}`)
        const start = Date.now()
        const result = await fn()
        windows[name] = [start, Date.now()]
        if (result === true) return
        log(`step ${name} failed: ${result}`)
        let retry
        if (rl) {
          const answer = (await rl.question(`step ${name} failed (${result}). [r]etry, [s]kip, or [d]one (it worked)? `)).trim().toLowerCase()
          if (answer.startsWith('d')) return
          retry = answer.startsWith('r')
        } else {
          retry = attempt <= 2
        }
        if (!retry) {
          skipped.push({ step: name, reason: result })
          return
        }
        child.write('\x1b')
        await waitQuiet(1500)
        idleMark = mark()
      }
    }

    /**
     * Submit a prompt that runs `echo capture-ok` and answer the permission prompt with `key`.
     * @param {string} key
     */
    async function bashStep (key) {
      const from = idleMark
      const h = (await readHooks()).length
      await typePrompt(PROMPTS.bash)
      const pre = await waitHook(h, p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash')
      if (!pre) return 'no PreToolUse(Bash)'
      await saveFrame('spinner', from)
      const perm = await waitHook(h, p => p.hook_event_name === 'PermissionRequest' && p.tool_name === 'Bash', 30000)
      if (!perm) return 'no PermissionRequest(Bash); was the command already allowed?'
      await waitQuiet(1000)
      const n = visibleOptions()
      if (n === 3) await saveFrame('permission-bash-3', from, { cmd: CMD })
      else if (n === 2) await saveFrame('permission-2', from, { cmd: CMD })
      const answerMark = mark()
      child.write(key)
      if (key === '3') {
        await waitQuiet(2000)
      } else {
        if (!await waitHook(h, p => p.hook_event_name === 'PostToolUse' && p.tool_name === 'Bash')) return 'no PostToolUse(Bash)'
        await waitQuiet(1000)
        await saveFrame('tool-output', answerMark)
        if (!await waitHook(h, p => p.hook_event_name === 'Stop')) return 'no Stop'
        await waitQuiet(1500)
      }
      idleMark = mark()
      return true
    }

    // Startup: trust dialog if any, then the idle input box.
    await step('startup', async () => {
      const h = (await readHooks()).length
      await waitQuiet(2000)
      if (/trust (this|the files in this) folder/i.test(screenText())) {
        await saveFrame('trust-folder', 0)
        idleMark = mark()
        child.write('\r')
      }
      if (!await waitHook(h, p => p.hook_event_name === 'SessionStart')) return 'no SessionStart'
      await waitQuiet(1500)
      await saveFrame('idle-input', idleMark)
      idleMark = mark()
      return true
    })
    await step('bash-1', () => bashStep('1'))
    await step('bash-2', async () => {
      const r = await bashStep('2')
      // "Yes, and don't ask again" writes a rule; restore the hooks-only settings so bash-3 prompts.
      await writeFile(path.join(repo, '.claude', 'settings.local.json'), settingsLocal)
      await sleep(1000)
      return r
    })
    await step('bash-3', () => bashStep('3'))
    await step('edit', async () => {
      const from = idleMark
      const h = (await readHooks()).length
      await typePrompt(PROMPTS.edit)
      const perm = await waitHook(h, p => p.hook_event_name === 'PermissionRequest' && /^(Edit|Write|MultiEdit)$/.test(p.tool_name))
      if (!perm) return 'no PermissionRequest(Edit)'
      await waitQuiet(1000)
      await saveFrame('permission-edit', from)
      child.write('1')
      if (!await waitHook(h, p => p.hook_event_name === 'Stop')) return 'no Stop'
      await waitQuiet(1500)
      idleMark = mark()
      return true
    })
    await step('ask', async () => {
      const from = idleMark
      const h = (await readHooks()).length
      await typePrompt(PROMPTS.ask)
      if (!await waitHook(h, p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'AskUserQuestion')) return 'no PreToolUse(AskUserQuestion)'
      await waitQuiet(1000)
      await saveFrame('question-options', from)
      child.write('1')
      if (!await waitHook(h, p => p.hook_event_name === 'PostToolUse' && p.tool_name === 'AskUserQuestion', 5000)) {
        child.write('\r')
      }
      if (!await waitHook(h, p => p.hook_event_name === 'Stop')) return 'no Stop'
      await waitQuiet(1500)
      idleMark = mark()
      return true
    })
    await step('question', async () => {
      const from = idleMark
      const h = (await readHooks()).length
      await typePrompt(PROMPTS.question)
      if (!await waitHook(h, p => p.hook_event_name === 'Stop')) return 'no Stop'
      await waitQuiet(1500)
      await saveFrame('question-text', from, { question: QUESTION })
      idleMark = mark()
      return true
    })
    await step('compact', async () => {
      const from = idleMark
      const h = (await readHooks()).length
      await typePrompt('/compact')
      if (!await waitHook(h, p => p.hook_event_name === 'PreCompact')) return 'no PreCompact'
      await sleep(1500)
      await saveFrame('compacting', from)
      if (!await waitHook(h, p => p.hook_event_name === 'PostCompact' || (p.hook_event_name === 'SessionStart' && p.source === 'compact'), Math.max(stepTimeoutMs, 300000))) return 'no PostCompact'
      await waitQuiet(2000)
      idleMark = mark()
      return true
    })
    await step('clear', async () => {
      const h = (await readHooks()).length
      await typePrompt('/clear')
      if (!await waitHook(h, p => p.hook_event_name === 'SessionStart' && p.source === 'clear')) return 'no SessionStart(clear)'
      await waitQuiet(1500)
      idleMark = mark()
      return true
    })
    await step('exit', async () => {
      await typePrompt('/exit')
      const done = await Promise.race([exitPromise.then(() => true), sleep(30000).then(() => false)])
      return done ? true : 'claude did not exit after /exit'
    })
    if (!exited) {
      child.kill('SIGTERM')
      await Promise.race([exitPromise, sleep(5000)])
    }
    rl?.close()
    await sleep(500)
    await readHooks()

    // Step 4 (hooks half): one payload per event and variant, plus the approve-safe sequence.
    /** @param {Record<string, any>} p */
    function fileName (p) {
      const e = p.hook_event_name
      const variant = ({
        SessionStart: p.source,
        SessionEnd: p.reason,
        PreToolUse: p.tool_name,
        PostToolUse: p.tool_name,
        PostToolUseFailure: p.tool_name,
        PermissionRequest: p.tool_name,
        PermissionDenied: p.tool_name,
        Notification: p.notification_type
      })[e]
      return variant ? `${e}.${variant}.json` : `${e}.json`
    }
    for (const h of hooks) if (typeof h.payload.session_id === 'string') ulidFor(h.payload.session_id)
    await mkdir(hooksDir, { recursive: true })
    /** @type {string[]} */
    const written = []
    for (const h of hooks) {
      const name = fileName(h.payload)
      if (!h.payload.hook_event_name || written.includes(name)) continue
      await writeFile(path.join(hooksDir, name), JSON.stringify(redactPayload(h.payload), null, 2) + '\n')
      written.push(name)
    }
    const approve = windows['bash-1']
    if (approve && !skipped.some(s => s.step === 'bash-1')) {
      const seq = hooks.filter(h => h.receivedAt >= approve[0] && h.receivedAt <= approve[1])
      await writeFile(path.join(hooksDir, 'sequence.approve-safe.jsonl'),
        seq.map(h => JSON.stringify({ hookTs: h.receivedAt, payload: redactPayload(h.payload) })).join('\n') + (seq.length ? '\n' : ''))
      written.push('sequence.approve-safe.jsonl')
    }
    const manifest = {
      claudeVersion: versionOutput,
      version,
      capturedAt: new Date().toISOString(),
      scriptVersion: SCRIPT_VERSION,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      node: process.version,
      size: { cols, rows },
      redactions: REDACTIONS,
      skipped,
      hooks: written.sort(),
      frames
    }
    await writeFile(path.join(hooksDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')

    // Step 6: diff against the previous version's set (added, removed and retyped fields).
    /**
     * @param {any} v
     * @param {string} prefix
     * @param {Record<string, string>} acc
     */
    function fieldTypes (v, prefix = '', acc = {}) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, x] of Object.entries(v)) fieldTypes(x, prefix ? `${prefix}.${k}` : k, acc)
      } else if (prefix) {
        acc[prefix] = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
      }
      return acc
    }
    const cmpVersion = (/** @type {string} */ a, /** @type {string} */ b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
    }
    const others = existsSync(path.join(opts.out, 'hooks'))
      ? (await readdir(path.join(opts.out, 'hooks'))).filter(d => /^\d+\.\d+\.\d+$/.test(d) && cmpVersion(d, version) < 0).sort(cmpVersion)
      : []
    const prev = others.at(-1)
    if (!prev) {
      log('no previous fixture set to diff against')
    } else {
      const prevDir = path.join(opts.out, 'hooks', prev)
      const names = new Set([...(await readdir(prevDir)), ...written].filter(n => n.endsWith('.json') && n !== 'MANIFEST.json'))
      for (const n of [...names].sort()) {
        const read = async (/** @type {string} */ d) => existsSync(path.join(d, n)) ? fieldTypes(JSON.parse(await readFile(path.join(d, n), 'utf8'))) : undefined
        const [a, b] = [await read(prevDir), await read(hooksDir)]
        if (!a) { process.stdout.write(`${n}: added in ${version}\n`); continue }
        if (!b) { process.stdout.write(`${n}: not captured in ${version}\n`); continue }
        for (const k of Object.keys(b)) if (!(k in a)) process.stdout.write(`${n}: + ${k} (${b[k]})\n`)
        for (const k of Object.keys(a)) if (!(k in b)) process.stdout.write(`${n}: - ${k}\n`)
        for (const k of Object.keys(a)) if (k in b && a[k] !== b[k]) process.stdout.write(`${n}: ~ ${k} ${a[k]} -> ${b[k]}\n`)
      }
    }
    log(`wrote ${written.length} hook files to ${hooksDir} and ${Object.keys(frames).length} frames to ${screensDir}`)
    log(`skipped steps: ${skipped.length ? skipped.map(s => s.step).join(', ') : 'none'}; review every file before committing`)
  } finally {
    killChild()
    await rm(repo, { recursive: true, force: true })
    await rm(raw, { recursive: true, force: true })
  }
  process.exit(0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
