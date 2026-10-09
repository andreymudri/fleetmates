import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn as realSpawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeBin } from '../helpers/fake-bin.mjs'
import {
  askArgv, askEnv, createAskEngine, ASK_DENIED_TOOLS, ASK_NOT_CONNECTED_ERROR, ASK_READ_TOOLS, ASK_TIMEOUT_ERROR,
  ASK_TOTAL_MS, ASK_IDLE_MS, readProcIdentity, resultPaths, resultCount, parseResultLine, MAX_RESULT_LINE
} from '../../server/ask/engine.mjs'
import { CLAUDE_SESSION_VARS } from '../../deckd/login-env.mjs'
import { parseAnswer, validateCitations } from '../../server/ask/answer.mjs'
import { posixTest } from '../helpers/platform.mjs'

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixtures = path.join(hubDir, 'test', 'fixtures', 'claude-p', 'synthetic')
const MCP = [process.execPath, '/nonexistent/vault-mcp/dist/server/index.js']
const VARIADIC = ['--mcp-config', '--tools', '--allowedTools', '--disallowedTools']

/**
 * Timers whose 45 s and 120 s handles are held for the test to fire; shorter ones run for real.
 */
function fakeTimers () {
  /** @type {{ fn: () => void, ms: number, cleared: boolean }[]} */
  const held = []
  return {
    held,
    setTimeout (/** @type {() => void} */ fn, /** @type {number} */ ms) {
      if (ms >= 10_000) {
        const h = { fn, ms, cleared: false }
        held.push(h)
        return h
      }
      return { real: setTimeout(fn, ms) }
    },
    clearTimeout (/** @type {any} */ h) {
      if (h?.real) clearTimeout(h.real)
      else if (h) h.cleared = true
    },
    /** @param {number} ms */
    fire (ms) {
      for (const h of held.filter(x => x.ms === ms && !x.cleared)) {
        h.cleared = true
        h.fn()
      }
    }
  }
}

/**
 * Poll until fn returns a truthy value.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function waitFor (fn, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** @param {number} pid */
function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A temp state dir, the fake claude wrapper by absolute path, an isolated base env and an engine whose spawn
 * records every call before calling the real spawn.
 * @param {import('node:test').TestContext} t
 * @param {{ fixture: string, extraEnv?: Record<string, string>, maxConcurrent?: number, procIdentity?: (pid: number) => any }} opts
 */
async function setup (t, { fixture, extraEnv = {}, maxConcurrent, procIdentity }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-ask-'))
  const bin = await fakeBin({})
  const runtime = path.join(dir, 'run')
  await mkdir(runtime, { mode: 0o700 })
  const logFile = path.join(dir, 'fake.jsonl')
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: path.join(dir, 'home'),
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus',
    DISPLAY: ':99',
    ANTHROPIC_API_KEY: 'sk-test-not-a-key',
    FLEETMATES_DECK_TOKEN: 'deck-token-test',
    VAULT_AUTO_PUSH: '1',
    FAKE_CLAUDE_P_FIXTURE: fixture,
    FAKE_CLAUDE_LOG: logFile,
    ...extraEnv
  }
  /** @type {{ cmd: string, argv: string[], opts: any, pid?: number }[]} */
  const spawns = []
  /** @type {object[]} */
  const logs = []
  const timers = fakeTimers()
  const claudeCommand = bin.claudePath
  const engine = createAskEngine({
    claudeCommand,
    stateDir: path.join(dir, 'state'),
    env,
    timers,
    log: entry => logs.push(entry),
    ...(maxConcurrent ? { maxConcurrent } : {}),
    ...(procIdentity ? { procIdentity } : {}),
    spawn: /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ argv, /** @type {any} */ opts) => {
      const child = realSpawn(cmd, argv, opts)
      spawns.push({ cmd, argv, opts, pid: child.pid })
      return child
    })
  })
  t.after(async () => {
    for (const s of spawns) if (s.pid && alive(s.pid)) try { process.kill(-s.pid, 'SIGKILL') } catch {}
    await bin.cleanup()
    await rm(dir, { recursive: true, force: true })
  })
  const fakeLog = async () => (await readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { dir, engine, spawns, logs, timers, claudeCommand, fakeLog }
}

/**
 * A fixture that starts connected, streams one partial delta, then hangs.
 * @param {import('node:test').TestContext} t
 */
async function hangFixture (t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-ask-fx-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = readFileSync(path.join(fixtures, 'answer-cited.jsonl'), 'utf8').split('\n')[0]
  const delta = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Parcial: o worker ' } } }
  const file = path.join(dir, 'hang.jsonl')
  await writeFile(file, [first, JSON.stringify(delta), JSON.stringify({ hang: true })].join('\n') + '\n')
  return file
}

/**
 * The common run options.
 * @param {string} threadId
 * @param {object} [extra]
 */
const ask = (threadId, extra = {}) => ({ threadId, prompt: 'Como o worker faz retry?', mcpCommand: MCP, vaultPath: '/home/you/vault', lang: 'en', ...extra })

test('askArgv is the 10-memory 2.2 argv in order, with no --safe-mode and no --model', () => {
  const argv = askArgv({ mcpCommand: ['npx', '-y', '@andreymudri/vault-mcp'], vaultPath: '/home/you/vault', lang: 'pt', systemPrompt: 'PROMPT' })
  const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1])
  assert.deepEqual(argv, [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
    '--restricted', '--strict-mcp-config', '--permission-prompts', 'none', '--mcp-config', argv[11], '--tools', '',
    '--allowedTools', ASK_READ_TOOLS.join(','), '--disallowedTools', ASK_DENIED_TOOLS.join(','),
    '--append-system-prompt', 'PROMPT'
  ])
  assert.deepEqual(config, { mcpServers: { vault: { type: 'stdio', command: 'npx', args: ['-y', '@andreymudri/vault-mcp'], env: { VAULT_PATH: '/home/you/vault', VAULT_LANG: 'pt' } } } })
  assert.ok(!argv.includes('--safe-mode') && !argv.includes('--model'))
})

test('askArgv: every variadic flag is followed by exactly one value and then a -- flag', () => {
  const argv = askArgv({ mcpCommand: MCP, vaultPath: '/home/you/vault', lang: 'en', systemPrompt: 'PROMPT' })
  for (const flag of VARIADIC) {
    const at = argv.indexOf(flag)
    assert.ok(at >= 0, flag)
    assert.ok(at + 2 < argv.length, `${flag} is not followed by a value and a flag`)
    assert.ok(!argv[at + 1].startsWith('--'), `${flag} value`)
    assert.ok(argv[at + 2].startsWith('--'), `${flag} is followed by ${argv[at + 2]}`)
  }
})

test('askArgv: --allowedTools holds the four read tools and no write tool', () => {
  const argv = askArgv({ mcpCommand: MCP, vaultPath: '/home/you/vault', lang: 'en', systemPrompt: 'PROMPT' })
  const allowed = argv[argv.indexOf('--allowedTools') + 1].split(',')
  assert.deepEqual([...allowed].sort(), ['mcp__vault__vault_backlinks', 'mcp__vault__vault_get_note', 'mcp__vault__vault_list', 'mcp__vault__vault_search'])
  for (const w of ['vault_write_note', 'vault_edit_note', 'vault_learn', 'vault_move', 'vault_delete']) {
    assert.ok(!allowed.includes(`mcp__vault__${w}`), w)
    assert.ok(argv[argv.indexOf('--disallowedTools') + 1].split(',').includes(`mcp__vault__${w}`), w)
  }
})

test('askArgv never puts VAULT_AUTO_PUSH or the server env in the MCP config', (t) => {
  const before = process.env.VAULT_AUTO_PUSH
  process.env.VAULT_AUTO_PUSH = '1'
  t.after(() => {
    if (before === undefined) delete process.env.VAULT_AUTO_PUSH
    else process.env.VAULT_AUTO_PUSH = before
  })
  const argv = askArgv({ mcpCommand: MCP, vaultPath: '/home/you/vault', lang: 'en', systemPrompt: 'PROMPT' })
  const raw = argv[argv.indexOf('--mcp-config') + 1]
  assert.doesNotMatch(raw, /VAULT_AUTO_PUSH/)
  assert.deepEqual(Object.keys(JSON.parse(raw).mcpServers.vault.env), ['VAULT_PATH', 'VAULT_LANG'])
})

test('askEnv drops deck tokens, API keys, the desktop session and VAULT_AUTO_PUSH, and marks the role', () => {
  const env = askEnv({
    PATH: '/usr/bin', HOME: '/home/you', DBUS_SESSION_BUS_ADDRESS: 'x', DISPLAY: ':0', WAYLAND_DISPLAY: 'w',
    SSH_AUTH_SOCK: 's', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', FLEETMATES_DECK_TOKEN: 't',
    FLEETMATES_DECK_ROLE: 'web', DECK_TOKEN: 't', VAULT_AUTO_PUSH: '1', CLAUDE_CODE_OAUTH_TOKEN: 'o'
  })
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/you', CLAUDE_CODE_OAUTH_TOKEN: 'o', FLEETMATES_DECK_ROLE: 'ask' })
})

test('askEnv drops every Claude Code per-session variable deckd strips, the messaging token among them', () => {
  const named = ['CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_SSE_PORT', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']
  for (const name of named) assert.ok(CLAUDE_SESSION_VARS.includes(name), name)
  const base = Object.fromEntries([...CLAUDE_SESSION_VARS, ...named].map(n => [n, 'v']))
  const env = askEnv({ PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1', ...base })
  assert.deepEqual(env, { PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1', FLEETMATES_DECK_ROLE: 'ask' })
})

test('answer-cited completes: deltas in order without the block, toolPaths and searches from the stream', async (t) => {
  const { engine, logs } = await setup(t, { fixture: path.join(fixtures, 'answer-cited.jsonl') })
  /** @type {string[]} */
  const deltas = []
  /** @type {object[]} */
  const searchesSeen = []
  const result = await engine.run(ask('t1', { onDelta: (/** @type {string} */ d) => deltas.push(d), onSearch: (/** @type {object} */ s) => searchesSeen.push(s) }))
  assert.equal(result.status, 'complete')
  assert.equal(result.error, null)
  assert.equal(result.exitCode, 0)
  const parsed = parseAnswer(result.text)
  assert.ok(parsed.block, 'the full text keeps its block for parseAnswer')
  assert.equal(parsed.block.citations.length, 2)
  const shown = deltas.join('')
  assert.ok(deltas.length >= 1)
  for (const d of deltas) assert.doesNotMatch(d, /deck-answer|```/)
  assert.equal(shown.trimEnd(), parsed.text)
  assert.ok(result.text.startsWith(shown))
  assert.equal(result.rawResult, result.text)
  assert.deepEqual([...result.toolPaths].sort(), ['02-wiki/nestjs/auth-guard.md', '02-wiki/nestjs/bullmq-worker.md'])
  assert.deepEqual(result.searches, [{ query: 'retry backoff bullmq', resultCount: 2 }])
  assert.deepEqual(result.searchHits, [{ path: '02-wiki/nestjs/bullmq-worker.md', line: 13 }, { path: '02-wiki/nestjs/auth-guard.md', line: 11 }])
  assert.deepEqual(searchesSeen, [{ query: 'retry backoff bullmq' }])
  const logged = JSON.stringify(logs)
  assert.doesNotMatch(logged, /worker|retry|Como/)
})

test('answer-miss records every search with its count; no-block completes with its text', async (t) => {
  const miss = await setup(t, { fixture: 'answer-miss' })
  const r = await miss.engine.run(ask('t1'))
  assert.equal(r.status, 'complete')
  assert.deepEqual(r.searches, [{ query: 'kubernetes operator', resultCount: 0 }, { query: 'operador k8s', resultCount: 0 }])
  assert.equal(parseAnswer(r.text).block?.isMiss, true)
  const nb = await setup(t, { fixture: 'no-block' })
  const r2 = await nb.engine.run(ask('t1'))
  assert.equal(r2.status, 'complete')
  assert.equal(parseAnswer(r2.text).block, null)
  assert.match(r2.text, /fila desacopla/)
})

test('a second run on the same thread throws ask_in_progress', async (t) => {
  const fixture = await hangFixture(t)
  const s2 = await setup(t, { fixture })
  const first = s2.engine.run(ask('t1'))
  assert.throws(() => s2.engine.run(ask('t1')), (/** @type {any} */ err) => err.code === 'ask_in_progress' && err.status === 409)
  const other = s2.engine.run(ask('t2'))
  s2.engine.cancel(first.runId)
  s2.engine.cancel(other.runId)
  assert.equal((await first).status, 'cancelled')
  assert.equal((await other).status, 'cancelled')
})

test('a third concurrent run waits in the FIFO until one of two finishes', async (t) => {
  const fixture = await hangFixture(t)
  const s = await setup(t, { fixture, maxConcurrent: 2 })
  const a = s.engine.run(ask('t1'))
  const b = s.engine.run(ask('t2'))
  const c = s.engine.run(ask('t3'))
  await waitFor(async () => (await s.fakeLog()).filter(e => e.mode === 'p').length === 2)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(s.spawns.length, 2)
  assert.deepEqual(s.engine.stats(), { running: 2, queued: 1 })
  s.engine.cancel(a.runId)
  assert.equal((await a).status, 'cancelled')
  await waitFor(() => s.spawns.length === 3)
  s.engine.cancel(b.runId)
  s.engine.cancel(c.runId)
  await Promise.all([b, c])
})

test('the 120 s timer ends a hung ask with "timed out after 120 s" and its process group is gone', async (t) => {
  const fixture = await hangFixture(t)
  const s = await setup(t, { fixture })
  /** @type {string[]} */
  const deltas = []
  const p = s.engine.run(ask('t1', { onDelta: (/** @type {string} */ d) => deltas.push(d) }))
  await waitFor(() => deltas.length > 0)
  const pid = /** @type {number} */ (s.spawns[0].pid)
  assert.ok(alive(pid))
  assert.ok(s.timers.held.some(h => h.ms === ASK_IDLE_MS), 'an idle timer is armed')
  s.timers.fire(ASK_TOTAL_MS)
  const r = await p
  assert.equal(r.status, 'error')
  assert.equal(r.error, ASK_TIMEOUT_ERROR)
  assert.equal(r.text, 'Parcial: o worker ')
  assert.equal(alive(pid), false)
})

test('the 45 s idle timer ends an ask the same way', async (t) => {
  const fixture = await hangFixture(t)
  const s = await setup(t, { fixture })
  /** @type {string[]} */
  const deltas = []
  const p = s.engine.run(ask('t1', { onDelta: (/** @type {string} */ d) => deltas.push(d) }))
  await waitFor(() => deltas.length > 0)
  s.timers.fire(ASK_IDLE_MS)
  const r = await p
  assert.equal(r.error, ASK_TIMEOUT_ERROR)
})

test('cancel keeps the partial text and returns cancelled', async (t) => {
  const fixture = await hangFixture(t)
  const s = await setup(t, { fixture })
  /** @type {string[]} */
  const deltas = []
  const p = s.engine.run(ask('t1', { onDelta: (/** @type {string} */ d) => deltas.push(d) }))
  await waitFor(() => deltas.length > 0)
  assert.equal(s.engine.cancel(p.runId), true)
  const r = await p
  assert.equal(r.status, 'cancelled')
  assert.equal(r.text, 'Parcial: o worker ')
  assert.equal(alive(/** @type {number} */ (s.spawns[0].pid)), false)
  assert.equal(s.engine.cancel(p.runId), false)
})

test('vault-not-connected ends the ask with "vault-mcp did not start for the ask"', async (t) => {
  const s = await setup(t, { fixture: 'vault-not-connected' })
  /** @type {string[]} */
  const deltas = []
  const r = await s.engine.run(ask('t1', { onDelta: (/** @type {string} */ d) => deltas.push(d) }))
  assert.equal(r.status, 'error')
  assert.equal(r.error, ASK_NOT_CONNECTED_ERROR)
  assert.deepEqual(deltas, [])
})

test('result.is_error gives the result text; an exit without a result gives the exit code and the stderr tail', async (t) => {
  const s = await setup(t, { fixture: 'error' })
  const r = await s.engine.run(ask('t1'))
  assert.equal(r.status, 'error')
  assert.equal(r.error, 'API Error: 529 Overloaded')
  const initOnly = path.join(s.dir, 'init-only.jsonl')
  await writeFile(initOnly, readFileSync(path.join(fixtures, 'answer-cited.jsonl'), 'utf8').split('\n')[0] + '\n')
  const noisy = await setup(t, { fixture: initOnly, extraEnv: { FAKE_CLAUDE_P_EXIT: '1', FAKE_CLAUDE_P_STDERR: 'x'.repeat(3000) + 'Invalid API key' } })
  const r2 = await noisy.engine.run(ask('t1'))
  assert.equal(r2.status, 'error')
  assert.match(/** @type {string} */ (r2.error), /^claude exited 1: x+Invalid API key$/)
  assert.ok(r2.stderrTail.length <= 2000)
  assert.ok(r2.stderrTail.endsWith('Invalid API key'))
})

posixTest('the child gets FLEETMATES_DECK_ROLE=ask, no desktop or secret variables, the prompt on stdin and the 0700 ask cwd', { reason: 'asserts the 0700 mode of the ask cwd and spawns the #! wrapper by name' }, async (t) => {
  const s = await setup(t, { fixture: 'answer-cited' })
  const prompt = 'Como o worker faz retry?'
  await s.engine.run(ask('t1', { prompt }))
  assert.equal(s.spawns.length, 1)
  const { cmd, opts } = s.spawns[0]
  assert.equal(cmd, s.claudeCommand)
  assert.ok(path.isAbsolute(cmd))
  assert.equal(opts.env.FLEETMATES_DECK_ROLE, 'ask')
  for (const k of ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'ANTHROPIC_API_KEY', 'FLEETMATES_DECK_TOKEN', 'VAULT_AUTO_PUSH']) assert.equal(opts.env[k], undefined, k)
  assert.equal(opts.detached, true)
  assert.equal(opts.cwd, path.join(s.dir, 'state', 'ask'))
  assert.equal((await stat(opts.cwd)).mode & 0o777, 0o700)
  const entry = (await s.fakeLog()).find(e => e.mode === 'p')
  assert.equal(entry.promptLength, prompt.length)
  assert.equal(entry.role, 'ask')
  assert.equal(entry.cwd, opts.cwd)
  assert.doesNotMatch(JSON.stringify(await s.fakeLog()), /Como o worker/)
})

/** A procIdentity stand-in: every pid has start time `st-<pid>` on boot `boot-a`. */
const fakeIdentity = (/** @type {number} */ pid) => ({ startTime: `st-${pid}`, bootId: 'boot-a' })

test('running.json lists a running ask with its start time and boot id, and is emptied when it ends', async (t) => {
  const fixture = await hangFixture(t)
  const s = await setup(t, { fixture, procIdentity: fakeIdentity })
  /** @type {string[]} */
  const deltas = []
  const p = s.engine.run(ask('t-live', { onDelta: (/** @type {string} */ d) => deltas.push(d) }))
  await waitFor(() => deltas.length > 0)
  const runningFile = path.join(s.dir, 'state', 'ask', 'running.json')
  const listed = JSON.parse(await readFile(runningFile, 'utf8')).runs
  const pid = s.spawns[0].pid
  assert.deepEqual(listed.map((/** @type {any} */ e) => [e.threadId, e.pid, e.startTime, e.bootId]), [['t-live', pid, `st-${pid}`, 'boot-a']])
  s.engine.cancel(p.runId)
  await p
  assert.deepEqual(JSON.parse(await readFile(runningFile, 'utf8')).runs, [])
})

test('readProcIdentity reads a live pid start time and the boot id on Linux, and null for no process', { skip: process.platform !== 'linux' && 'needs /proc' }, () => {
  const id = readProcIdentity(process.pid)
  assert.ok(id)
  assert.match(id.startTime, /^\d+$/)
  assert.match(id.bootId, /^[0-9a-f-]{36}$/)
  assert.equal(readProcIdentity(2 ** 22 + 7), null)
})

posixTest('reapOrphans kills a listed group whose start time and boot id still match, and returns its thread', { reason: 'kills a POSIX process group' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-ask-reap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'run'), { mode: 0o700 })
  // An orphan left by a previous server: its own process group, listed in running.json.
  const orphan = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: path.join(dir, 'run') }
  })
  const exited = new Promise(resolve => orphan.on('exit', resolve))
  t.after(() => { if (orphan.pid && alive(orphan.pid)) process.kill(-orphan.pid, 'SIGKILL') })
  const pid = /** @type {number} */ (orphan.pid)
  await mkdir(path.join(dir, 'state', 'ask'), { recursive: true })
  const runningFile = path.join(dir, 'state', 'ask', 'running.json')
  await writeFile(runningFile, JSON.stringify({ runs: [{ runId: 'r-old', threadId: 't-orphan', pid, startedAt: 1, startTime: `st-${pid}`, bootId: 'boot-a' }] }))
  const fresh = createAskEngine({
    claudeCommand: '/nonexistent/claude', stateDir: path.join(dir, 'state'), procIdentity: fakeIdentity,
    spawn: /** @type {any} */ (() => { throw new Error('no spawn') })
  })
  assert.deepEqual(fresh.reapOrphans(), ['t-orphan'])
  const gone = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))])
  assert.equal(gone, true, 'the orphan group was killed')
  assert.equal(alive(pid), false)
  assert.deepEqual(JSON.parse(await readFile(runningFile, 'utf8')).runs, [])
})

test('reapOrphans kills nothing when the boot id or the start time differ, or the entry has no identity', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-ask-reap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'state', 'ask'), { recursive: true })
  const runningFile = path.join(dir, 'state', 'ask', 'running.json')
  /** @type {[number, string][]} */
  const kills = []
  const engine = createAskEngine({
    claudeCommand: '/nonexistent/claude', stateDir: path.join(dir, 'state'), procIdentity: fakeIdentity,
    killGroup: (pid, signal) => { kills.push([pid, signal]) },
    spawn: /** @type {any} */ (() => { throw new Error('no spawn') })
  })
  await writeFile(runningFile, JSON.stringify({
    runs: [
      { runId: 'r1', threadId: 't-boot', pid: 4242, startedAt: 1, startTime: 'st-4242', bootId: 'boot-old' },
      { runId: 'r2', threadId: 't-start', pid: 4243, startedAt: 1, startTime: 'st-1', bootId: 'boot-a' },
      { runId: 'r3', threadId: 't-none', pid: 4244, startedAt: 1 }
    ]
  }))
  assert.deepEqual(engine.reapOrphans(), ['t-boot', 't-start', 't-none'])
  assert.deepEqual(kills, [])
  assert.deepEqual(JSON.parse(await readFile(runningFile, 'utf8')).runs, [])
  // The same entry with a matching identity is killed through the same injected killGroup.
  await writeFile(runningFile, JSON.stringify({ runs: [{ runId: 'r4', threadId: 't-match', pid: 4245, startedAt: 1, startTime: 'st-4245', bootId: 'boot-a' }] }))
  assert.deepEqual(engine.reapOrphans(), ['t-match'])
  assert.deepEqual(kills, [[4245, 'SIGKILL']])
})

test('a vault_search hit without a heading trail still reaches toolPaths and searchHits', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-ask-fx-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const raw = readFileSync(path.join(fixtures, 'answer-cited.jsonl'), 'utf8')
  const withTrail = '02-wiki/nestjs/bullmq-worker.md:13 \\u2014 Worker BullMQ > Retry e backoff (score 12.34)'
  assert.equal(raw.split(withTrail).length, 2, 'the fixture has the hit line once')
  const fixture = path.join(dir, 'no-trail.jsonl')
  await writeFile(fixture, raw.replace(withTrail, '02-wiki/nestjs/bullmq-worker.md:9 (score 12.34)'))
  const s = await setup(t, { fixture })
  const r = await s.engine.run(ask('t1'))
  assert.equal(r.status, 'complete')
  assert.deepEqual([...r.toolPaths].sort(), ['02-wiki/nestjs/auth-guard.md', '02-wiki/nestjs/bullmq-worker.md'])
  assert.deepEqual(r.searchHits, [{ path: '02-wiki/nestjs/bullmq-worker.md', line: 9 }, { path: '02-wiki/nestjs/auth-guard.md', line: 11 }])
  assert.deepEqual(r.searches, [{ query: 'retry backoff bullmq', resultCount: 2 }])
})

const EMD = String.fromCharCode(0x2014)

test('a vault_get_note answer is read only up to its first blank line, never its body', () => {
  const text = [
    `02-wiki/nestjs/a.md ${EMD} A`, 'Frontmatter:', '  tipo: wiki', 'Links: 02-wiki/nestjs/b.md', 'Broken links: (none)', '',
    `evil.md ${EMD} x`, 'Links: evil-links.md', `- evil-list.md ${EMD} y`, `evil-hit.md:3 ${EMD} z (score 1.0)`
  ].join('\n')
  const r = resultPaths('mcp__vault__vault_get_note', text)
  assert.deepEqual(r.paths, ['02-wiki/nestjs/a.md', '02-wiki/nestjs/b.md'])
  assert.deepEqual(r.hits, [])
})

test('readProcIdentity takes field 22 of /proc/<pid>/stat, after a command name with spaces and parentheses', () => {
  // Fields 3..52 after the command name; field 22 is the start time, field 23 the virtual memory size.
  const after = Array.from({ length: 50 }, (_, i) => String(i + 3))
  after[22 - 3] = '98765'
  after[23 - 3] = '11111'
  const stat = `4321 (a b) (c) ${after.join(' ')}\n`
  /** @type {string[]} */
  const read = []
  const id = readProcIdentity(4321, file => {
    read.push(file)
    return file.endsWith('/stat') ? stat : 'boot-id-x\n'
  })
  assert.deepEqual(id, { startTime: '98765', bootId: 'boot-id-x' })
  assert.deepEqual(read, ['/proc/4321/stat', '/proc/sys/kernel/random/boot_id'])
})

test('a result line over MAX_RESULT_LINE characters is not read for paths', () => {
  const long = `02-wiki/x/longa.md:3 ${EMD} ${'a'.repeat(5000)} (score 1.0)`
  const fits = `02-wiki/x/curta.md:4 ${EMD} ${'a'.repeat(MAX_RESULT_LINE - 60)} (score 1.0)`
  assert.ok(long.length > MAX_RESULT_LINE && fits.length <= MAX_RESULT_LINE)
  assert.equal(parseResultLine(long), null)
  const r = resultPaths('mcp__vault__vault_search', `2 result(s) for "x".\n\n${long}\n> a\n\n${fits}\n> b`)
  assert.deepEqual(r.paths, ['02-wiki/x/curta.md'])
  assert.deepEqual(r.hits, [{ path: '02-wiki/x/curta.md', line: 4 }])
  assert.equal(resultCount(`${long}\n${fits}`), 1)
})

test('parseResultLine reads list, trailed and trail-less hit lines, and refuses snippets', () => {
  assert.deepEqual(parseResultLine(`- 02-wiki/a b.md ${EMD} T (tipo: x, status: y, tags: z)`), { path: '02-wiki/a b.md', line: null })
  assert.deepEqual(parseResultLine(`02-wiki/a.md:13 ${EMD} H > I (score 12.34, via graph)`), { path: '02-wiki/a.md', line: 13 })
  assert.deepEqual(parseResultLine('02-wiki/a.md:9 (score 0.79)'), { path: '02-wiki/a.md', line: 9 })
  assert.equal(parseResultLine(`> 02-wiki/a.md:9 (score 0.79)`), null)
  assert.equal(parseResultLine(' 02-wiki/a.md:9 (score 0.79)'), null)
  assert.equal(parseResultLine('02-wiki/a.md (score 0.79)'), null)
})

test('crafted result lines that do not match cost linear work: 100 lines of about 4,000 characters well under 500 ms', () => {
  const unit = `:1 ${EMD} (score x`
  const listy = (`- a.md ${EMD} ` + unit.repeat(400)).slice(0, 4000) + 'Z'
  const hitty = (`a.md:1 ${EMD} ` + unit.repeat(400)).slice(0, 4000) + 'Z'
  const text = [...Array(50).fill(listy), ...Array(50).fill(hitty)].join('\n')
  const start = performance.now()
  const r = resultPaths('mcp__vault__vault_list', text)
  resultCount(text)
  const ms = performance.now() - start
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`)
  assert.equal(r.paths.length, 50)
})

test('a path that itself holds " <EM> " stays whole in search, list and backlink lines, and its cited line is kept', async () => {
  const search = [
    '2 result(s) for "pauta".', '',
    `notas/Reunião ${EMD} Acme.md:12 ${EMD} Pauta (score 0.91)`, '> item da pauta', '',
    'notas/Plano ' + EMD + ' Q4.md:3 (score 0.5)', '> meta do trimestre'
  ].join('\n')
  const r = resultPaths('mcp__vault__vault_search', search)
  assert.deepEqual(r.paths, [`notas/Reunião ${EMD} Acme.md`, `notas/Plano ${EMD} Q4.md`])
  assert.deepEqual(r.hits, [{ path: `notas/Reunião ${EMD} Acme.md`, line: 12 }, { path: `notas/Plano ${EMD} Q4.md`, line: 3 }])
  assert.equal(resultCount(search.split('\n').slice(2).join('\n')), 2)
  const list = `1 note(s):\n- notas/Reunião ${EMD} Acme.md ${EMD} Reunião com Acme (tipo: reuniao, status: ${EMD}, tags: acme)`
  assert.deepEqual(resultPaths('mcp__vault__vault_list', list).paths, [`notas/Reunião ${EMD} Acme.md`])
  const back = `1 note(s) point to notas/x.md:\n- notas/Reunião ${EMD} Acme.md ${EMD} Reunião com Acme`
  assert.deepEqual(resultPaths('mcp__vault__vault_backlinks', back).paths, [`notas/Reunião ${EMD} Acme.md`])
  const kept = await validateCitations([{ path: `notas/Reunião ${EMD} Acme.md`, line: 12, viaGraph: false }],
    { toolPaths: r.paths, knownPaths: [], searchHits: r.hits, lineBound: () => 5 })
  assert.equal(kept.kept.length, 1)
})

test('askEnv drops every FLEETMATES_DECK_ variable and ANTHROPIC_AUTH_TOKEN, then sets FLEETMATES_DECK_ROLE=ask', () => {
  const env = askEnv({
    PATH: '/usr/bin', FLEETMATES_DECK_SOCKET: '/run/deck.sock', FLEETMATES_DECK_STATE_DIR: '/tmp/s',
    FLEETMATES_DECK_ROLE: 'web', ANTHROPIC_AUTH_TOKEN: 'a'
  })
  assert.deepEqual(env, { PATH: '/usr/bin', FLEETMATES_DECK_ROLE: 'ask' })
})

test('the ask limits are 120 s total and 45 s idle, and the timeout message says 120 s (D-142)', () => {
  assert.equal(ASK_TOTAL_MS, 120000)
  assert.equal(ASK_IDLE_MS, 45000)
  assert.equal(ASK_TIMEOUT_ERROR, 'timed out after 120 s')
})

// The npm cmd-shim that @anthropic-ai/claude-code installs as claude.cmd, with a placeholder package path.
const CLAUDE_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\claude-placeholder\\cli.js" %*', ''
].join('\r\n')

/**
 * Run one ask through an engine whose spawn records its call and then throws, so nothing is started.
 * @param {import('node:test').TestContext} t
 * @param {{ platform: string, claudeCommand: string }} opts
 */
async function spawnCall (t, { platform, claudeCommand }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-ask-plat-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  /** @type {{ file: string, args: string[], options: any }[]} */
  const calls = []
  const engine = createAskEngine({
    claudeCommand, platform, stateDir: path.join(dir, 'state'), env: { PATH: '/usr/bin' },
    spawn: /** @type {any} */ ((/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ options) => {
      calls.push({ file, args, options })
      throw Object.assign(new Error('spawn spy'), { code: 'ESPY' })
    })
  })
  const result = await engine.run(ask('t-plat'))
  return { calls, result, dir }
}

test('on win32 the ask spawns claude through commandSpawn: an npm claude.cmd shim runs node on its script, hidden, with the same argv', async (t) => {
  const shimDir = await mkdtemp(path.join(os.tmpdir(), 'deck-ask-shim-'))
  t.after(() => rm(shimDir, { recursive: true, force: true }))
  const shim = path.join(shimDir, 'claude.cmd')
  await writeFile(shim, CLAUDE_SHIM)
  const linux = await spawnCall(t, { platform: 'linux', claudeCommand: '/home/you/.local/bin/claude' })
  assert.equal(linux.calls.length, 1)
  assert.equal(linux.calls[0].file, '/home/you/.local/bin/claude')
  assert.equal('windowsHide' in linux.calls[0].options, false)
  assert.equal(linux.result.error, 'could not start claude: ESPY')
  const win = await spawnCall(t, { platform: 'win32', claudeCommand: shim })
  assert.equal(win.calls.length, 1)
  assert.equal(win.calls[0].file, process.execPath)
  assert.equal(win.calls[0].args[0], path.win32.resolve(path.win32.dirname(shim), 'node_modules\\claude-placeholder\\cli.js'))
  assert.deepEqual(win.calls[0].args.slice(1), linux.calls[0].args)
  assert.equal(win.calls[0].options.windowsHide, true)
  assert.equal(win.calls[0].options.detached, true)
  assert.equal(win.calls[0].options.cwd, path.join(win.dir, 'state', 'ask'))
})

test('on win32 a claude batch file that is not an npm shim is refused before spawning, with a message naming the fix', async (t) => {
  const { calls, result } = await spawnCall(t, { platform: 'win32', claudeCommand: 'C:\\Users\\you\\bin\\claude.bat' })
  assert.deepEqual(calls, [])
  assert.equal(result.status, 'error')
  assert.equal(result.error, 'could not start claude: claudeCommand is a .cmd or .bat file that cannot take the ask arguments safely; point it at claude.exe or an npm claude.cmd')
})
