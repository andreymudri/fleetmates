import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import net from 'node:net'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import nodePty from 'node-pty'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { encode, createLineDecoder } from '../../deckd/protocol.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hubDir = path.resolve(here, '..', '..')
const mainPath = path.join(hubDir, 'deckd', 'main.mjs')
const fmPath = path.join(hubDir, 'bin', 'fm.mjs')
const script = path.join(hubDir, 'test', 'fixtures', 'scripts', 'two-sources.json')
const TERM_NAME = 'fm-test'

/** @type {Awaited<ReturnType<typeof makeRuntimeDir>>} */
let rt
/** @type {Awaited<ReturnType<typeof fakeBin>>} */
let fb
/** @type {string} */
let tmp
/** @type {string} */
let logPath
/** @type {NodeJS.ProcessEnv} */
let env
/** @type {import('node:child_process').ChildProcess} */
let deckd
/** @type {Awaited<ReturnType<typeof connectDeckd>>} */
let browser
/** @type {ReturnType<typeof runInPty>[]} */
const ptys = []
let stoppingDeckd = false
/** @type {string | null} */
let deckdDied = null

/**
 * Poll until `fn` resolves truthy, or throw after the deadline.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {string | (() => string | Promise<string>)} what
 * @returns {Promise<NonNullable<T>>}
 */
async function until (fn, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return /** @type {NonNullable<T>} */ (v)
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === 'function' ? await what() : what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Every input chunk the fake logged, concatenated in order.
 * @returns {Promise<string>}
 */
async function fakeInput () {
  let text
  try {
    text = await readFile(logPath, 'utf8')
  } catch {
    return ''
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => typeof e.input === 'string').map((e) => e.input).join('')
}

/**
 * Entries of the fake's log.
 * @returns {Promise<any[]>}
 */
async function fakeLog () {
  const text = await readFile(logPath, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/**
 * Run a command inside a PTY and collect what it prints.
 * @param {string} file
 * @param {string[]} args
 * @param {{ cols?: number, rows?: number, env?: NodeJS.ProcessEnv }} [opts]
 */
function runInPty (file, args, { cols = 100, rows = 30, env: e = env } = {}) {
  const pty = nodePty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: tmp, env: /** @type {Record<string, string>} */ (e) })
  let out = ''
  pty.onData((d) => { out += d })
  /** @type {Promise<{ exitCode: number, signal?: number }>} */
  const exit = new Promise((resolve) => pty.onExit(resolve))
  /**
   * The exit, or a rejection naming the command after the deadline.
   * @param {number} [timeoutMs]
   */
  const exited = (timeoutMs = 10000) => {
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const late = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${[file, ...args].join(' ')} did not exit: ${JSON.stringify(out)}`)), timeoutMs)
    })
    return /** @type {Promise<{ exitCode: number, signal?: number }>} */ (Promise.race([exit, late]).finally(() => clearTimeout(timer)))
  }
  const handle = { pty, exited, out: () => out }
  ptys.push(handle)
  return handle
}

/**
 * The `list` entry for one PTY, or undefined.
 * @param {string} ptyId
 */
async function listed (ptyId) {
  const res = await browser.request('list')
  return res.ptys.find((/** @type {any} */ p) => p.ptyId === ptyId)
}

/**
 * Wait for a PTY not in `known` that has an attached terminal client.
 * @param {Set<string>} known
 * @returns {Promise<any>} its `list` entry
 */
async function newAttachedPty (known) {
  return until(async () => {
    const res = await browser.request('list')
    return res.ptys.find((/** @type {any} */ p) => !known.has(p.ptyId) && p.clients.some((/** @type {any} */ c) => c.kind === 'terminal'))
  }, 'fm claude to spawn and attach')
}

/** @returns {Promise<Set<string>>} */
async function knownPtys () {
  const res = await browser.request('list')
  return new Set(res.ptys.map((/** @type {any} */ p) => p.ptyId))
}

/**
 * @param {string} s
 * @returns {string}
 */
const b64 = (s) => Buffer.from(s).toString('base64')

before(async () => {
  rt = await makeRuntimeDir()
  tmp = await mkdtemp(path.join(os.tmpdir(), 'deck-fm-'))
  logPath = path.join(tmp, 'fake.log')
  fb = await fakeBin({ script, log: logPath })
  env = { ...fb.env, XDG_RUNTIME_DIR: rt.dir, TERM_PROGRAM: TERM_NAME }
  deckd = spawn(process.execPath, [mainPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deckd did not start: ${stderr}`)), 10000)
    deckd.stderr?.on('data', (d) => {
      stderr += d
      if (stderr.includes('deckd listening on')) {
        clearTimeout(timer)
        resolve(undefined)
      }
    })
    deckd.once('exit', (code) => reject(new Error(`deckd exited ${code}: ${stderr}`)))
  })
  // A deckd that dies mid-file takes every later test down with it; print
  // why at once, and fail every test that ends after it (afterEach below).
  deckd.on('exit', (code, signal) => {
    if (stoppingDeckd) return
    deckdDied = `deckd exited unexpectedly (code ${code}, signal ${signal}); its stderr:\n${stderr}`
    process.stderr.write(deckdDied + '\n')
  })
  // hello accepts only `server` and `terminal` clients; a browser is served
  // through a `server` connection that stamps its writes `source.kind: 'browser'`.
  browser = await connectDeckd({ runtimeDir: rt.dir, kind: 'server', name: 'fm-test-browser' })
})

// A throw in a top-level after() did not fail the run (node 26.7.0), so the
// check runs after each test instead.
afterEach(() => {
  if (deckdDied) throw new Error(deckdDied)
})

after(async () => {
  for (const { pty } of ptys) {
    try { pty.kill('SIGKILL') } catch {}
  }
  browser?.close()
  stoppingDeckd = true
  if (deckd && deckd.exitCode === null) {
    const exited = new Promise((resolve) => deckd.once('exit', resolve))
    deckd.kill('SIGTERM')
    await exited
  }
  await fb?.cleanup()
  await rt?.cleanup()
  await rm(tmp, { recursive: true, force: true })
})

/** @type {ReturnType<typeof runInPty>} */
let fm
/** @type {string} */
let ptyId

test('fm claude spawns claude through deckd, wrapped, at the terminal size, and attaches as the terminal', async () => {
  const known = await knownPtys()
  fm = runInPty(process.execPath, [fmPath, 'claude', '--flag-for-fake'], { cols: 100, rows: 30 })
  const p = await newAttachedPty(known)
  ptyId = p.ptyId
  assert.deepEqual(p.argv, ['claude', '--flag-for-fake'])
  assert.equal(p.origin, 'wrapped')
  assert.equal(p.cwd, tmp)
  assert.equal(p.cols, 100)
  assert.equal(p.rows, 30)
  assert.deepEqual(p.clients, [{ kind: 'terminal', name: TERM_NAME }])
  // The fake logs `ready` after it has put its terminal in raw mode; keys
  // typed before that would also be echoed by the PTY's line discipline.
  await until(async () => (await fakeLog()).some((e) => e.ready && e.argv?.[0] === '--flag-for-fake'), 'the fake to be ready')
})

test('keys typed into fm reach the fake, its echo reaches fm, and lastInputFrom is the terminal', async () => {
  fm.pty.write('fmkey1')
  await until(async () => (await fakeInput()).includes('fmkey1'), 'fmkey1 in the fake log')
  await until(() => fm.out().includes('fmkey1'), () => `fmkey1 echoed to fm: ${JSON.stringify(fm.out())}`)
  assert.deepEqual((await listed(ptyId)).lastInputFrom, { kind: 'terminal', name: TERM_NAME })
})

test('a browser write reaches the same fake, and lastInputFrom follows the last writer in both orders', async () => {
  // terminal (previous test), then browser
  await browser.request('write', { ptyId, data: b64('brkey1'), source: { kind: 'browser', name: 'tab' } })
  await until(async () => (await fakeInput()).includes('brkey1'), 'brkey1 in the fake log')
  assert.deepEqual((await listed(ptyId)).lastInputFrom, { kind: 'browser', name: 'tab' })
  // browser, then terminal
  fm.pty.write('fmkey2')
  await until(async () => (await fakeInput()).includes('fmkey2'), 'fmkey2 in the fake log')
  assert.deepEqual((await listed(ptyId)).lastInputFrom, { kind: 'terminal', name: TERM_NAME })
  // and terminal, then browser once more
  await browser.request('write', { ptyId, data: b64('brkey2'), source: { kind: 'browser', name: 'tab' } })
  await until(async () => (await fakeInput()).includes('brkey2'), 'brkey2 in the fake log')
  assert.deepEqual((await listed(ptyId)).lastInputFrom, { kind: 'browser', name: 'tab' })
})

test('a resize of the fm terminal is forwarded to the PTY', async () => {
  // The terminal must be the last input source for deckd to follow its size.
  fm.pty.write('fmkey3')
  await until(async () => (await fakeInput()).includes('fmkey3'), 'fmkey3 in the fake log')
  const t0 = Date.now()
  fm.pty.resize(90, 25)
  await until(async () => {
    const p = await listed(ptyId)
    return p.cols === 90 && p.rows === 25
  }, 'the PTY to become 90x25')
  const screen = await browser.request('screen', { ptyId, scrollback: 0 })
  assert.equal(screen.cols, 90)
  assert.equal(screen.rows, 25)
  // The child got a SIGWINCH. Only its arrival is checked, not the size the
  // fake logs with it: when this test was written the fake logged
  // {"cols":100,"rows":30} for this resize, the size before it.
  await until(async () => (await fakeLog()).some((e) => e.resize && e.ts >= t0), 'the fake to log a resize')
})

test('fm attach replays earlier output, then streams, with no byte lost or doubled at the seam', async () => {
  // Keep output flowing while fm attach connects, until deckd reports the
  // attach and for a while after, so the replay/stream seam falls inside it.
  let attachedAt = -1
  let i = 0
  const off = browser.on('client', (ev) => {
    if (ev.ptyId === ptyId && ev.change === 'attached' && attachedAt === -1) attachedAt = i
  })
  const attach = runInPty(process.execPath, [fmPath, 'attach', ptyId])
  const deadline = Date.now() + 10000
  while (attachedAt === -1 || i < attachedAt + 50) {
    if (Date.now() > deadline) throw new Error('fm attach never attached')
    await browser.request('write', { ptyId, data: b64(`w${i},`), source: { kind: 'deck' } })
    i++
  }
  off()
  await until(async () => (await fakeInput()).includes(`w${i - 1},`), 'the last write in the fake log')
  // Earlier echoed text, typed before fm attach started, can only come from the replay.
  await until(() => attach.out().includes('fmkey1'), () => `the replay: ${JSON.stringify(attach.out())}`)
  // The fake echoes every input byte verbatim, and there is no newline in
  // any of it, so the whole echo fits the 5000-line replay: the attach
  // client must end up with exactly the concatenated input.
  const expected = await fakeInput()
  await until(() => attach.out().length >= expected.length, () => `attach output to reach ${expected.length} bytes, has ${attach.out().length}`)
  assert.equal(attach.out(), expected)
  // New output after the replay is streamed.
  await browser.request('write', { ptyId, data: b64('late1'), source: { kind: 'browser' } })
  await until(() => attach.out().includes('late1'), 'late1 streamed to fm attach')
  assert.equal(attach.out(), await fakeInput())
})

test('fm claude and fm attach exit with the code of a signalled child when the PTY dies', async () => {
  const attach = ptys[ptys.length - 1]
  await browser.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 })
  const [a, b] = await Promise.all([fm.exited(), attach.exited()])
  assert.equal(a.exitCode, 128 + 9)
  assert.equal(b.exitCode, 128 + 9)
})

test('fm claude passes its environment, exits with the child\'s exit code, and restores the terminal', async () => {
  const exitScript = path.join(tmp, 'exit7.json')
  await writeFile(exitScript, JSON.stringify({ steps: [{ expectInput: { match: 'q', timeoutMs: 30000 } }, { exit: { code: 7 } }] }))
  const known = await knownPtys()
  const sh = runInPty('/bin/sh', ['-c', '"$0" "$1" claude; echo "fm-exit=$?"; stty -a', process.execPath, fmPath],
    { env: { ...env, FAKE_CLAUDE_SCRIPT: exitScript } })
  await newAttachedPty(known)
  sh.pty.write('q')
  const exited = await sh.exited()
  assert.equal(exited.exitCode, 0)
  const out = sh.out()
  assert.match(out, /fm-exit=7/)
  const stty = out.slice(out.indexOf('fm-exit=7'))
  assert.match(stty, /(^|[\s;])icanon/, stty)
  assert.match(stty, /(^|[\s;])echo[\s;]/, stty)
})

test('fm attach of an unknown PTY exits 1 naming it; the client rejects with the deckd code', async () => {
  await assert.rejects(browser.request('attach', { ptyId: 'pty_00000000' }), (/** @type {any} */ err) => err.code === 'not_found')
  const r = await runPlain(['attach', 'pty_00000000'], env)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /pty_00000000/)
})

/**
 * A scripted deckd on a fresh runtime dir: `respond(req, sock)` writes the
 * answer to each request itself, so a test controls what shares a write.
 * @param {(req: any, sock: net.Socket) => void} respond
 */
async function scriptedDeckd (respond) {
  const fakeRt = await makeRuntimeDir()
  const dir = path.join(fakeRt.dir, 'fleetmates-deck')
  await mkdir(dir, { mode: 0o700 })
  /** @type {string[]} */
  const ops = []
  /** @type {net.Socket[]} */
  const conns = []
  const server = net.createServer((sock) => {
    conns.push(sock)
    sock.on('error', () => {})
    sock.on('data', createLineDecoder((req) => {
      ops.push(req.op)
      respond(req, sock)
    }, () => {}))
  })
  await new Promise((resolve) => server.listen(path.join(dir, 'deckd.sock'), () => resolve(undefined)))
  return {
    ops,
    conns,
    env: { ...env, XDG_RUNTIME_DIR: fakeRt.dir },
    async close () {
      for (const c of conns) c.destroy()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
      await fakeRt.cleanup()
    }
  }
}

/**
 * @param {number} id
 * @param {object} [fields]
 */
const okLine = (id, fields = {}) => encode({ id, ok: true, ...fields })

test('fm attach drops output already in the replay and keeps output after it, even from the same read', async () => {
  // `screen` is answered with output events on both sides of the response,
  // all in one socket write, so the seam does not depend on timing. PRE was
  // sent before the snapshot (deckd would have it in the replay), POST after.
  const out = (/** @type {string} */ s) => encode({ ev: 'output', ptyId: 'pty_seam0000', data: b64(s) })
  const fake = await scriptedDeckd((req, sock) => {
    if (req.op === 'screen') {
      sock.write(out('PRE') + okLine(req.id, { rev: 1, cols: 100, rows: 30, cursor: { x: 0, y: 0 }, lines: [], scrollback: b64('REPLAY') }) + out('POST'))
    } else {
      sock.write(okLine(req.id))
    }
  })
  try {
    const attach = runInPty(process.execPath, [fmPath, 'attach', 'pty_seam0000'], { env: fake.env })
    await until(() => attach.out().includes('POST'), () => `POST: ${JSON.stringify(attach.out())}`)
    const c = fake.conns[0]
    c.write(out('LIVE'))
    c.write(encode({ ev: 'output', ptyId: 'pty_other000', data: b64('OTHER') }))
    c.write(encode({ ev: 'exit', ptyId: 'pty_seam0000', code: 3, signal: null, at: Date.now() }))
    const exited = await attach.exited()
    assert.equal(exited.exitCode, 3)
    assert.equal(attach.out(), 'REPLAYPOSTLIVE')
    assert.deepEqual(fake.ops.slice(0, 3), ['hello', 'attach', 'screen'])
  } finally {
    await fake.close()
  }
})

test('fm claude exits with the code of a child that exited before fm learned its ptyId', async () => {
  // The `exit` event arrives ahead of the spawn response, and attach then
  // fails the way deckd fails it for a PTY that is gone.
  const fake = await scriptedDeckd((req, sock) => {
    if (req.op === 'spawn') {
      sock.write(encode({ ev: 'exit', ptyId: 'pty_early000', code: 5, signal: null, at: Date.now() }) + okLine(req.id, { ptyId: 'pty_early000', pid: 1, startedAt: Date.now() }))
    } else if (req.op === 'attach' || req.op === 'screen') {
      sock.write(encode({ id: req.id, ok: false, error: { code: 'not_found', message: 'no pty pty_early000' } }))
    } else {
      sock.write(okLine(req.id))
    }
  })
  try {
    const fmEarly = runInPty(process.execPath, [fmPath, 'claude'], { env: fake.env })
    const exited = await fmEarly.exited()
    assert.equal(exited.exitCode, 5, fmEarly.out())
    assert.deepEqual(fake.ops.slice(0, 2), ['hello', 'spawn'])
  } finally {
    await fake.close()
  }
})

test('fm attach exits 1 when the deckd connection drops', async () => {
  const fake = await scriptedDeckd((req, sock) => {
    sock.write(okLine(req.id, req.op === 'screen' ? { rev: 1, cols: 100, rows: 30, cursor: { x: 0, y: 0 }, lines: [], scrollback: b64('REPLAY') } : {}))
  })
  try {
    const attach = runInPty(process.execPath, [fmPath, 'attach', 'pty_drop0000'], { env: fake.env })
    await until(() => attach.out().includes('REPLAY'), 'the replay')
    fake.conns[0].destroy()
    const exited = await attach.exited()
    assert.equal(exited.exitCode, 1)
    assert.match(attach.out(), /lost the connection to deckd/)
  } finally {
    await fake.close()
  }
})

test('fm claude and fm attach exit 2 when deckd is not running', async () => {
  const empty = await makeRuntimeDir()
  // A socket file left by a deckd that died: connecting is refused.
  const stale = await makeRuntimeDir()
  const staleSock = path.join(stale.dir, 'fleetmates-deck', 'deckd.sock')
  await mkdir(path.dirname(staleSock), { mode: 0o700 })
  const r0 = spawnSync(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => process.exit(0))', staleSock])
  assert.equal(r0.status, 0, String(r0.stderr))
  assert.ok((await stat(staleSock)).isSocket())
  try {
    for (const dir of [empty.dir, stale.dir]) {
      for (const args of [['claude'], ['attach', 'pty_00000000']]) {
        const r = await runPlain(args, { ...env, XDG_RUNTIME_DIR: dir })
        assert.equal(r.code, 2, r.stderr)
        assert.match(r.stderr, /deckd is not running/)
      }
    }
    const r = await runPlain(['claude'], { ...env, XDG_RUNTIME_DIR: '' })
    assert.equal(r.code, 2, r.stderr)
    assert.match(r.stderr, /deckd is not running/)
  } finally {
    await empty.cleanup()
    await stale.cleanup()
  }
})

test('typing in fm attach moves the PTY to the fm terminal size, which fm reported on attach', async () => {
  const res = await browser.request('spawn', { cwd: tmp, argv: ['claude'], cols: 120, rows: 30, origin: 'launched' })
  const id = res.ptyId
  try {
    await browser.request('resize', { ptyId: id, cols: 120, rows: 30, source: { kind: 'browser' } })
    await browser.request('write', { ptyId: id, data: b64('from-browser'), source: { kind: 'browser' } })
    const attach = runInPty(process.execPath, [fmPath, 'attach', id], { cols: 80, rows: 24, env: { ...env, TERM_PROGRAM: 'rvterm' } })
    await until(async () => (await listed(id))?.clients.some((/** @type {any} */ c) => c.kind === 'terminal' && c.name === 'rvterm'), 'fm attach to attach')
    attach.pty.write('typed-in-fm\r')
    await until(async () => (await fakeInput()).includes('typed-in-fm'), 'typed-in-fm in the fake log')
    await until(async () => {
      const p = await listed(id)
      return p.cols === 80 && p.rows === 24
    }, async () => `the PTY to become 80x24: ${JSON.stringify(await listed(id))}`)
    assert.deepEqual((await listed(id)).lastInputFrom, { kind: 'terminal', name: 'rvterm' })
    await browser.request('kill', { ptyId: id, signal: 'SIGKILL', graceMs: 0 })
    await attach.exited()
  } finally {
    await browser.request('kill', { ptyId: id, signal: 'SIGKILL', graceMs: 0 }).catch(() => {})
  }
})

/**
 * Run fm without a TTY and collect its exit code and stderr.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} e
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function runPlain (args, e) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fmPath, ...args], { env: e, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fm ${args.join(' ')} did not exit: ${stderr}`)) }, 10000)
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}
