#!/usr/bin/env node
// Fake `claude` for deck tests (docs/deck/09-testing.md section 3). It replays a JSON
// script from FAKE_CLAUDE_SCRIPT and logs every input chunk, hook fired and resize as JSON
// lines to FAKE_CLAUDE_LOG. v0 verbs: hook, frame, expectInput, expectKey, branch, sleep,
// print, exit, hang, echo. Not implemented yet: newSession, subagent. With `-p` it is the
// Ask engine's `claude -p` instead (askMode below): no script, a stream-json fixture replayed.
// FAKE_CLAUDE_FIXTURES overrides the fixture root (default hub/test/fixtures).
//
// Exit codes: 96 missing frame, 97 expectInput/expectKey timeout, 98 an Ask argv that is not
// the 10-memory 2.2 invocation, 2 bad script or fixture.

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixturesDir = process.env.FAKE_CLAUDE_FIXTURES || path.join(hubDir, 'test', 'fixtures')
const logFile = process.env.FAKE_CLAUDE_LOG

/**
 * Append one JSON line to FAKE_CLAUDE_LOG, stamped with `ts`.
 * @param {Record<string, unknown>} entry
 */
function log (entry) {
  if (!logFile) return
  appendFileSync(logFile, JSON.stringify({ ts: Date.now(), ...entry }) + '\n')
}

/**
 * Write to stderr, then exit with `code`.
 * @param {number} code
 * @param {string} message
 * @returns {never}
 */
function die (code, message) {
  process.stderr.write(message + '\n')
  process.exit(code)
}

/**
 * The newest `hooks/<version>` fixture directory, else package.json testedClaudeCode.
 * @returns {string}
 */
function defaultVersion () {
  try {
    const dirs = readdirSync(path.join(fixturesDir, 'hooks'))
      .filter(d => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
      })
    if (dirs.length) return dirs[dirs.length - 1]
  } catch {}
  const pkg = JSON.parse(readFileSync(path.join(hubDir, 'package.json'), 'utf8'))
  return pkg.fleetmatesDeck.testedClaudeCode
}

// `-p` (Ask engine) mode, 09-testing 3.6. The expected argv is written out here on its own rather than taken
// from the server's askArgv, so a change that widens the Ask's tools in the server fails here.
const ASK_READ_TOOLS = ['vault_search', 'vault_get_note', 'vault_list', 'vault_backlinks'].map(t => `mcp__vault__${t}`)
const ASK_DENIED = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
  ...['vault_write_note', 'vault_edit_note', 'vault_learn', 'vault_move', 'vault_delete'].map(t => `mcp__vault__${t}`)]
/** Flags that take one value, with the value they must have when it is fixed. */
const ASK_VALUE_FLAGS = /** @type {Record<string, string|null>} */ ({
  '--output-format': 'stream-json',
  '--permission-prompts': 'none',
  '--mcp-config': null,
  '--tools': '',
  '--allowedTools': null,
  '--disallowedTools': null,
  '--append-system-prompt': null
})
const ASK_SWITCHES = ['-p', '--verbose', '--include-partial-messages', '--no-session-persistence', '--restricted', '--strict-mcp-config']
/** Variadic in the real CLI: each must be followed by exactly one value, then another `--` flag. */
const ASK_VARIADIC = ['--mcp-config', '--tools', '--allowedTools', '--disallowedTools']

/**
 * Check an Ask argv against the invocation of 10-memory 2.2. Returns the first problem found, or null.
 * @param {string[]} argv
 * @returns {string | null}
 */
function askArgvProblem (argv) {
  if (argv.includes('--safe-mode')) return '--safe-mode is not part of the Ask argv'
  if (argv.includes('--model')) return '--model is not part of the Ask argv in M5'
  for (const flag of ASK_SWITCHES) if (!argv.includes(flag)) return `missing ${flag}`
  /** @type {Record<string, string>} */
  const values = {}
  for (const [flag, want] of Object.entries(ASK_VALUE_FLAGS)) {
    const at = argv.indexOf(flag)
    if (at < 0) return `missing ${flag}`
    if (at + 1 >= argv.length) return `${flag} has no value`
    const value = argv[at + 1]
    if (want !== null && value !== want) return `${flag} is ${JSON.stringify(value)}, expected ${JSON.stringify(want)}`
    if (ASK_VARIADIC.includes(flag) && !(argv[at + 2] ?? '').startsWith('--')) {
      return `${flag} is not followed by exactly one value and then a -- flag`
    }
    values[flag] = value
  }
  const allowed = values['--allowedTools'].split(',')
  if (allowed.length !== ASK_READ_TOOLS.length || !ASK_READ_TOOLS.every(t => allowed.includes(t))) {
    return `--allowedTools is ${values['--allowedTools']}, expected exactly ${ASK_READ_TOOLS.join(',')}`
  }
  const denied = values['--disallowedTools'].split(',')
  const missing = ASK_DENIED.filter(t => !denied.includes(t))
  if (missing.length) return `--disallowedTools lacks ${missing.join(',')}`
  let config
  try {
    config = JSON.parse(values['--mcp-config'])
  } catch {
    return '--mcp-config is not JSON'
  }
  const servers = Object.keys(config?.mcpServers ?? {})
  if (servers.length !== 1 || servers[0] !== 'vault') return `--mcp-config servers are ${servers.join(',') || 'none'}, expected vault only`
  const env = config.mcpServers.vault.env ?? {}
  if ('VAULT_AUTO_PUSH' in env) return '--mcp-config passes VAULT_AUTO_PUSH'
  return null
}

/**
 * The Ask mode: validate argv, read the prompt from stdin to its end (only its length is logged), replay
 * FAKE_CLAUDE_P_FIXTURE (a path, or a name under fixtures/claude-p/synthetic/) with FAKE_CLAUDE_P_DELAY_MS
 * between lines, hang when its last line is {"hang":true}, then write FAKE_CLAUDE_P_STDERR and exit with
 * FAKE_CLAUDE_P_EXIT (default 0).
 * @param {string[]} argv
 * @returns {Promise<never>}
 */
async function askMode (argv) {
  const problem = askArgvProblem(argv)
  if (problem) die(98, `fake claude -p: ${problem}`)
  let promptLength = 0
  for await (const chunk of process.stdin) promptLength += chunk.toString('utf8').length
  log({ mode: 'p', promptLength, role: process.env.FLEETMATES_DECK_ROLE ?? null, cwd: process.cwd() })
  const fixture = process.env.FAKE_CLAUDE_P_FIXTURE
  if (!fixture) die(2, 'FAKE_CLAUDE_P_FIXTURE is not set')
  const file = existsSync(fixture) ? fixture : path.join(fixturesDir, 'claude-p', 'synthetic', `${fixture}.jsonl`)
  let lines
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
  } catch (err) {
    die(2, `cannot read fixture ${fixture}: ${/** @type {Error} */ (err).message}`)
  }
  let hang = false
  try {
    hang = lines.length > 0 && JSON.parse(lines[lines.length - 1]).hang === true
  } catch {}
  if (hang) lines.pop()
  if (process.env.FAKE_CLAUDE_P_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_P_STDERR)
  const delay = Number(process.env.FAKE_CLAUDE_P_DELAY_MS ?? 0)
  for (const line of lines) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    await new Promise(resolve => process.stdout.write(line + '\n', resolve))
  }
  if (hang) {
    setInterval(() => {}, 1 << 30)
    await new Promise(() => {})
  }
  process.exit(Number(process.env.FAKE_CLAUDE_P_EXIT ?? 0))
}

const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION || defaultVersion()} (Claude Code)\n`)
  process.exit(0)
}
if (args.includes('-p') || args.includes('--print')) await askMode(args)

const scriptArg = process.env.FAKE_CLAUDE_SCRIPT
if (!scriptArg) die(2, 'FAKE_CLAUDE_SCRIPT is not set')
const scriptPath = existsSync(scriptArg) ? scriptArg : path.join(fixturesDir, 'scripts', `${scriptArg}.json`)
/** @type {{ version?: string, sessionId?: string, steps: any[] }} */
let script
try {
  script = JSON.parse(readFileSync(scriptPath, 'utf8'))
} catch (err) {
  die(2, `cannot read script ${scriptArg}: ${/** @type {Error} */ (err).message}`)
}
if (!Array.isArray(script.steps)) die(2, `script ${scriptArg} has no steps array`)

const version = process.env.FAKE_CLAUDE_VERSION || script.version || defaultVersion()
const sessionId = !script.sessionId || script.sessionId === 'auto' ? randomUUID() : script.sessionId
const cwd = process.cwd()
const home = process.env.HOME || os.homedir()
const transcriptPath = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'), `${sessionId}.jsonl`)

// Input: every chunk is logged, then either echoed (inside an `echo` step) or appended to
// `pending`, which expectInput and expectKey consume.
let pending = ''
let echoing = false
let inputEnded = false
/** @type {Set<() => void>} */
const inputListeners = new Set()
let lastInput = ''
/** @type {string | undefined} */
let lastLabel

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', chunk => {
  const text = chunk.toString('utf8')
  log({ input: text, bytes: chunk.length })
  if (echoing) process.stdout.write(chunk)
  else pending += text
  for (const fn of inputListeners) fn()
})
process.stdin.on('end', () => {
  inputEnded = true
  for (const fn of inputListeners) fn()
})

process.on('SIGWINCH', () => {
  const [cols, rows] = process.stdout.isTTY ? process.stdout.getWindowSize() : [0, 0]
  log({ resize: { cols, rows } })
})

/** @type {Set<Promise<void>>} */
const runningHooks = new Set()

/**
 * Resolve when `check` returns a value other than undefined, re-checking on every input
 * change; resolve undefined after timeoutMs.
 * @template T
 * @param {() => T | undefined} check
 * @param {number} [timeoutMs]
 * @returns {Promise<T | undefined>}
 */
function waitInput (check, timeoutMs) {
  return new Promise(resolve => {
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const listener = () => {
      const v = check()
      if (v === undefined) return
      inputListeners.delete(listener)
      clearTimeout(timer)
      resolve(v)
    }
    inputListeners.add(listener)
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        inputListeners.delete(listener)
        resolve(undefined)
      }, timeoutMs)
    }
    listener()
  })
}

/**
 * @param {number} ms
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Replace "$input" string values with the last matched input, recursively.
 * @param {any} v
 * @returns {any}
 */
function substitute (v) {
  if (v === '$input') return lastInput
  if (Array.isArray(v)) return v.map(substitute)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x)]))
  return v
}

/**
 * The value a hook matcher is tested against, and the fixture variant suffix.
 * @param {Record<string, any>} payload
 * @returns {string | undefined}
 */
function matchTarget (payload) {
  return payload.tool_name ?? payload.source ?? payload.reason ?? payload.notification_type ?? payload.trigger
}

/**
 * Read the command hooks registered for `event` in the user and project settings.
 * @param {string} event
 * @param {Record<string, any>} payload
 * @returns {{ command: string, async: boolean, timeout: number }[]}
 */
function hookCommands (event, payload) {
  const files = [path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]
  const target = matchTarget(payload)
  const out = []
  for (const file of files) {
    let settings
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const groups = settings?.hooks?.[event]
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const m = group.matcher
      if (m && m !== '*' && target !== undefined && !new RegExp(`^(?:${m})$`).test(target)) continue
      for (const h of group.hooks ?? []) {
        if (h.type !== 'command' || typeof h.command !== 'string') continue
        out.push({ command: h.command, async: h.async === true, timeout: typeof h.timeout === 'number' ? h.timeout : 60 })
      }
    }
  }
  return out
}

/**
 * Run one hook command through sh with the payload on stdin, killed after its timeout.
 * @param {string} command
 * @param {string} input
 * @param {number} timeoutSec
 * @returns {Promise<void>}
 */
function runHookCommand (command, input, timeoutSec) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: process.env, stdio: ['pipe', 'ignore', 'ignore'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000)
    child.on('error', () => { clearTimeout(timer); resolve() })
    child.on('close', () => { clearTimeout(timer); resolve() })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/**
 * Build the payload for `event` and fire every registered command.
 * @param {{ hook: string, variant?: string, with?: Record<string, any> }} step
 */
async function fireHook (step) {
  const event = step.hook
  const extra = substitute(step.with ?? {})
  const variant = step.variant ?? matchTarget(extra)
  const dir = path.join(fixturesDir, 'hooks', version)
  /** @type {Record<string, any>} */
  let base = {}
  for (const name of [variant && `${event}.${variant}.json`, `${event}.json`]) {
    if (!name) continue
    const file = path.join(dir, name)
    if (existsSync(file)) {
      base = JSON.parse(readFileSync(file, 'utf8'))
      break
    }
  }
  const payload = {
    ...base,
    hook_event_name: event,
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
    ...extra
  }
  const commands = hookCommands(event, payload)
  log({ hook: event, payload, commands: commands.length })
  const input = JSON.stringify(payload)
  const waits = []
  for (const c of commands) {
    const run = runHookCommand(c.command, input, c.timeout)
    runningHooks.add(run)
    run.then(() => runningHooks.delete(run))
    if (!c.async) waits.push(run)
  }
  await Promise.all(waits)
}

/**
 * Write a captured frame with `{{name}}` placeholders filled from vars.
 * @param {{ frame: string, vars?: Record<string, string>, forMs?: number, tickMs?: number }} step
 */
async function writeFrame (step) {
  const file = path.join(fixturesDir, 'screens', version, `${step.frame}.ansi`)
  if (!existsSync(file)) die(96, `missing frame ${step.frame} for ${version}`)
  let text = readFileSync(file, 'latin1')
  for (const [k, v] of Object.entries(step.vars ?? {})) {
    text = text.replaceAll(`{{${k}}}`, Buffer.from(String(v), 'utf8').toString('latin1'))
  }
  const bytes = Buffer.from(text, 'latin1')
  process.stdout.write(bytes)
  if (step.forMs) {
    const end = Date.now() + step.forMs
    const tick = step.tickMs ?? 250
    while (Date.now() + tick < end) {
      await sleep(tick)
      process.stdout.write(bytes)
    }
    await sleep(Math.max(0, end - Date.now()))
  }
}

/**
 * Echo input for forMs, or until input ends when forMs is absent.
 * @param {{ forMs?: number }} opts
 */
async function echo (opts) {
  if (pending) {
    process.stdout.write(pending)
    pending = ''
  }
  echoing = true
  if (opts.forMs !== undefined) await sleep(opts.forMs)
  else await waitInput(() => (inputEnded ? true : undefined))
  echoing = false
}

/**
 * Run a list of steps in order.
 * @param {any[]} steps
 */
async function runSteps (steps) {
  for (const step of steps) {
    if ('hook' in step) {
      await fireHook(step)
    } else if ('frame' in step) {
      await writeFrame(step)
    } else if ('expectInput' in step) {
      const { match, timeoutMs = 5000 } = step.expectInput
      const re = new RegExp(match)
      const got = await waitInput(() => {
        const m = re.exec(pending)
        if (!m) return undefined
        pending = pending.slice(m.index + m[0].length)
        return m[0]
      }, timeoutMs)
      if (got === undefined) die(97, `expectInput timed out after ${timeoutMs} ms waiting for /${match}/`)
      lastInput = got
      log({ expectInput: got })
    } else if ('expectKey' in step) {
      const { timeoutMs = 5000, ...keys } = step.expectKey
      const label = await waitInput(() => {
        for (let i = 0; i < pending.length; i++) {
          const key = pending[i]
          if (Object.hasOwn(keys, key)) {
            pending = pending.slice(i + 1)
            lastInput = key
            return keys[key]
          }
        }
        return undefined
      }, timeoutMs)
      if (label === undefined) die(97, `expectKey timed out after ${timeoutMs} ms waiting for one of ${Object.keys(keys).join(', ')}`)
      lastLabel = label
      log({ expectKey: lastInput, label })
    } else if ('branch' in step) {
      const list = lastLabel === undefined ? undefined : step.branch[lastLabel]
      if (!Array.isArray(list)) die(2, `branch has no steps for label ${lastLabel}`)
      await runSteps(list)
    } else if ('sleep' in step) {
      await sleep(typeof step.sleep === 'number' ? step.sleep : step.sleep.ms)
    } else if ('print' in step) {
      const p = typeof step.print === 'string' ? { text: step.print } : step.print
      ;(p.stream === 'stderr' ? process.stderr : process.stdout).write(p.text)
    } else if ('echo' in step) {
      await echo(step.echo ?? {})
    } else if ('exit' in step) {
      const { code = 0, signal, stderr } = step.exit
      await Promise.all(runningHooks)
      if (stderr) process.stderr.write(stderr)
      if (signal) process.kill(process.pid, signal)
      process.exit(code)
    } else if ('hang' in step) {
      process.stdin.removeAllListeners('data')
      setInterval(() => {}, 1 << 30)
      await new Promise(() => {})
    } else {
      die(2, `unknown step ${JSON.stringify(step)}`)
    }
  }
}

log({ ready: true, version, sessionId, argv: args })
await runSteps(script.steps)
await Promise.all(runningHooks)
process.exit(0)
