// deckd M3 behaviour: the guarded write (docs/deck/07-approvals.md 5.1,
// state-machines 2.6, D-84). deckd runs in this process with an injected
// login environment, so no test runs a login shell, and every PTY runs the
// fake `claude` with the `echo` script.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { PtyHost } from '../../deckd/pty-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const echoScript = path.resolve(here, '..', 'fixtures', 'scripts', 'echo.json')

/** @type {Awaited<ReturnType<typeof makeRuntimeDir>>} */
let rt
/** @type {Awaited<ReturnType<typeof fakeBin>>} */
let fake
/** @type {Awaited<ReturnType<typeof startDeckd>>} */
let deckd
/** @type {Awaited<ReturnType<typeof connectDeckd>>} */
let c
/** @type {Record<string, string>} */
let loginEnv
/** @type {string} */
let logDir
let logN = 0

before(async () => {
  rt = await makeRuntimeDir()
  fake = await fakeBin({ script: echoScript })
  logDir = await mkdtemp(path.join(rt.dir, 'logs-'))
  loginEnv = {
    PATH: [fake.binDir, process.env.PATH ?? '/usr/bin:/bin'].join(path.delimiter),
    HOME: rt.dir,
    FAKE_CLAUDE_VERSION: '2.1.282',
    FAKE_CLAUDE_SCRIPT: echoScript
  }
  deckd = await startDeckd({ runtimeDir: rt.dir, version: '9.9.9', loginEnv })
  c = await connectDeckd({ runtimeDir: rt.dir, kind: 'server', name: 'm3' })
})

after(async () => {
  c?.close()
  await deckd?.close()
  await fake?.cleanup()
  await rt?.cleanup()
})

/**
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Input chunks the fake logged so far.
 * @param {string} log
 * @returns {Promise<string[]>}
 */
async function inputs (log) {
  const text = await readFile(log, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => typeof e.input === 'string').map((e) => e.input)
}

/**
 * Poll until `fn` resolves true.
 * @param {() => Promise<boolean>} fn
 * @param {string} what
 */
async function until (fn, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

/**
 * Spawn the echoing fake and wait until it logged `ready` (its stdin is raw by then).
 * @returns {Promise<{ ptyId: string, log: string }>}
 */
async function spawnEcho () {
  const log = path.join(logDir, `fake-${++logN}.jsonl`)
  const res = await c.request('spawn', { cwd: rt.dir, argv: ['claude'], env: { FAKE_CLAUDE_LOG: log }, cols: 80, rows: 24 })
  await until(async () => (await readFile(log, 'utf8').catch(() => '')).includes('"ready":true'), 'the fake to be ready')
  return { ptyId: res.ptyId, log }
}

/**
 * @param {string} ptyId
 */
async function kill (ptyId) {
  const exited = new Promise((resolve) => {
    const off = c.on('exit', (m) => { if (m.ptyId === ptyId) { off(); resolve(undefined) } })
  })
  await c.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 })
  await exited
}

/**
 * Poll `screen` until the first row equals `row`; resolve with the reply.
 * @param {string} ptyId
 * @param {string} row
 */
async function screenWith (ptyId, row) {
  /** @type {any} */
  let res
  await until(async () => {
    res = await c.request('screen', { ptyId, scrollback: 0 })
    return res.lines[0] === row
  }, `row ${JSON.stringify(row)}`)
  return res
}

/**
 * @param {string} s
 */
const b64 = (s) => Buffer.from(s).toString('base64')

test('hello lists guardedWrite in features and the client exposes them', async () => {
  assert.deepEqual(c.features, ['guardedWrite'])
})

test('client.features is an empty array when hello carries no features (an M2 deckd)', async () => {
  const one = await connectDeckd({ runtimeDir: rt.dir, kind: 'server', name: 'm3-proto1', proto: 1 })
  try {
    assert.equal(one.proto, 1)
    assert.deepEqual(one.features, [])
  } finally {
    one.close()
  }
})

test('a guarded write with the rev of a fresh screen reply lands', async () => {
  const { ptyId, log } = await spawnEcho()
  try {
    const { rev } = await c.request('screen', { ptyId, scrollback: 0 })
    const res = await c.request('write', { ptyId, data: b64('y'), source: { kind: 'deck' }, guard: { rev, quietMs: 1000 } })
    assert.equal(typeof res.at, 'number')
    await until(async () => (await inputs(log)).includes('y'), 'the fake to log the guarded byte')
  } finally {
    await kill(ptyId)
  }
})

test('after the fake prints more output the old rev is refused with screen_changed and nothing reaches the fake', async () => {
  const { ptyId, log } = await spawnEcho()
  try {
    const { rev } = await c.request('screen', { ptyId, scrollback: 0 })
    // An unguarded deck write the fake echoes: more output on the screen.
    await c.request('write', { ptyId, data: b64('more'), source: { kind: 'deck' } })
    await screenWith(ptyId, 'more')
    await assert.rejects(
      c.request('write', { ptyId, data: b64('Z'), source: { kind: 'deck' }, guard: { rev, quietMs: 0 } }),
      { code: 'screen_changed' }
    )
    // A later unguarded marker byte reaches the fake; the refused byte never did.
    await c.request('write', { ptyId, data: b64('!'), source: { kind: 'deck' } })
    await until(async () => (await inputs(log)).includes('!'), 'the marker byte')
    assert.deepEqual(await inputs(log), ['more', '!'])
  } finally {
    await kill(ptyId)
  }
})

test('output deckd has not parsed yet refuses a guarded write even at the current rev', async () => {
  // Driven on a PtyHost directly: ScreenModel parses written bytes on a
  // later tick, so bytes fed to it and not yet parsed are pending while
  // `rev` still has the value a server last read.
  const log = path.join(logDir, `fake-${++logN}.jsonl`)
  const host = PtyHost.spawn({ cwd: rt.dir, argv: ['claude'], baseEnv: loginEnv, env: { FAKE_CLAUDE_LOG: log } }, { onOutput: () => {}, onExit: () => {} })
  const gone = new Promise((resolve) => host.proc.onExit(() => resolve(undefined)))
  try {
    await until(async () => (await readFile(log, 'utf8').catch(() => '')).includes('"ready":true'), 'the fake to be ready')
    await host.screen.flush()
    const rev = host.screen.rev
    assert.equal(host.screen.pending(), false)
    host.screen.write(Buffer.from('unparsed'))
    assert.equal(host.screen.rev, rev)
    assert.equal(host.screen.pending(), true)
    assert.throws(() => host.write(Buffer.from('Q'), { kind: 'deck' }, { rev, quietMs: 0 }), { code: 'screen_changed' })
    await host.screen.flush()
    assert.equal(host.screen.pending(), false)
    const fresh = host.screen.rev
    host.write(Buffer.from('R'), { kind: 'deck' }, { rev: fresh, quietMs: 0 })
    await until(async () => (await inputs(log)).includes('R'), 'the fake to log R')
    assert.deepEqual(await inputs(log), ['R'])
  } finally {
    host.kill('SIGKILL', 0)
    await gone
    host.dispose()
  }
})

for (const kind of /** @type {const} */ (['terminal', 'browser'])) {
  test(`a ${kind}-source write 300 ms before a guarded write refuses it with typing_in_terminal; 1200 ms before lets it through`, async () => {
    const { ptyId, log } = await spawnEcho()
    try {
      const typed = await c.request('write', { ptyId, data: b64('t'), source: { kind, name: 'tty' } })
      const { rev } = await screenWith(ptyId, 't')
      await sleep(Math.max(0, typed.at + 300 - Date.now()))
      await assert.rejects(
        c.request('write', { ptyId, data: b64('N'), source: { kind: 'deck' }, guard: { rev, quietMs: 1000 } }),
        { code: 'typing_in_terminal' }
      )
      // A deck write 100 ms before the guarded one is not typing: it neither
      // counts itself nor resets the terminal or browser time.
      await sleep(Math.max(0, typed.at + 1100 - Date.now()))
      await c.request('write', { ptyId, data: b64('d'), source: { kind: 'deck' } })
      await screenWith(ptyId, 'td')
      await sleep(Math.max(0, typed.at + 1200 - Date.now()))
      const now = await c.request('screen', { ptyId, scrollback: 0 })
      await c.request('write', { ptyId, data: b64('Y'), source: { kind: 'deck' }, guard: { rev: now.rev, quietMs: 1000 } })
      await until(async () => (await inputs(log)).includes('Y'), 'the fake to log Y')
      assert.deepEqual(await inputs(log), ['t', 'd', 'Y'])
    } finally {
      await kill(ptyId)
    }
  })
}

test('a guarded write from any source but deck is bad_request; a bad guard is bad_request', async () => {
  const { ptyId, log } = await spawnEcho()
  try {
    const { rev } = await c.request('screen', { ptyId, scrollback: 0 })
    for (const kind of ['browser', 'terminal']) {
      await assert.rejects(
        c.request('write', { ptyId, data: b64('B'), source: { kind }, guard: { rev, quietMs: 0 } }),
        { code: 'bad_request' }, kind
      )
    }
    for (const guard of [null, 5, { rev: 1.5, quietMs: 0 }, { rev, quietMs: -1 }, { rev, quietMs: 5001 }, { rev }, { quietMs: 0 }]) {
      await assert.rejects(
        c.request('write', { ptyId, data: b64('B'), source: { kind: 'deck' }, guard }),
        { code: 'bad_request' }, JSON.stringify(guard)
      )
    }
    await c.request('write', { ptyId, data: b64('!'), source: { kind: 'deck' }, guard: { rev, quietMs: 5000 } })
    await until(async () => (await inputs(log)).includes('!'), 'the marker byte')
    assert.deepEqual(await inputs(log), ['!'])
  } finally {
    await kill(ptyId)
  }
})
