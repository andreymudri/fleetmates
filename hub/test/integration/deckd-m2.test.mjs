// deckd M2 behaviour: hello versioning, exit tails, the login environment,
// spawn validation, the line cap, the runtime dir check, and pins for the M0
// throttles. deckd runs in this process with an injected login environment,
// so no test runs a login shell.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { mkdtemp, mkdir, chmod, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { encode, createLineDecoder } from '../../deckd/protocol.mjs'
import { PtyHost } from '../../deckd/pty-host.mjs'
import { Ring } from '../../deckd/ring.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const stub = path.join(here, 'stubs', 'claude')

/** @type {Awaited<ReturnType<typeof makeRuntimeDir>>} */
let rt
/** @type {Awaited<ReturnType<typeof startDeckd>>} */
let deckd
/** @type {string} */
let binDir
const LOGIN_ONLY = 'DECK_TEST_LOGIN_ONLY'

before(async () => {
  rt = await makeRuntimeDir()
  binDir = await mkdtemp(path.join(rt.dir, 'bin-'))
  // A `claude` that prints the variables under test, then echoes input.
  await writeFile(path.join(binDir, 'claude'), [
    '#!/bin/sh',
    `printf 'ENV login=[%s] term=[%s] pty=[%s]\\r\\n' "$${LOGIN_ONLY}" "$TERM" "$FLEETMATES_DECK_PTY"`,
    'exec cat'
  ].join('\n') + '\n', { mode: 0o700 })
  deckd = await startDeckd({
    runtimeDir: rt.dir,
    version: '9.9.9',
    loginEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: rt.dir, [LOGIN_ONLY]: 'from-login' }
  })
})

after(async () => {
  await deckd?.close()
  await rt?.cleanup()
})

/**
 * @param {number} [proto]
 */
function client (proto) {
  return connectDeckd({ runtimeDir: rt.dir, kind: 'server', name: 'm2', proto })
}

/**
 * Poll `screen` until a row matches.
 * @param {Awaited<ReturnType<typeof client>>} c
 * @param {string} ptyId
 * @param {(line: string) => boolean} pred
 */
async function waitRow (c, ptyId, pred, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const res = await c.request('screen', { ptyId, scrollback: 0 })
    const row = res.lines.find(pred)
    if (row !== undefined) return row
    if (Date.now() > end) throw new Error(`timed out on the screen of ${ptyId}: ${JSON.stringify(res.lines)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Wait for one event.
 * @param {Awaited<ReturnType<typeof client>>} c
 * @param {string} ev
 * @param {(msg: any) => boolean} pred
 * @returns {Promise<any>}
 */
function nextEvent (c, ev, pred) {
  return new Promise((resolve) => {
    const off = c.on(ev, (msg) => {
      if (!pred(msg)) return
      off()
      resolve(msg)
    })
  })
}

/**
 * Kill a PTY and wait for its exit event.
 * @param {Awaited<ReturnType<typeof client>>} c
 * @param {string} ptyId
 */
async function killAndWait (c, ptyId) {
  const exited = nextEvent(c, 'exit', (m) => m.ptyId === ptyId)
  await c.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 })
  return exited
}

test('hello with proto 1, 2 and 3 answers 1, 2 and 2; 0 and 1.5 are unsupported', async () => {
  for (const [asked, got] of [[1, 1], [2, 2], [3, 2]]) {
    const c = await client(asked)
    try {
      assert.equal(c.proto, got, `asked ${asked}`)
      assert.equal(c.deckdVersion, '9.9.9')
      assert.equal(c.bootId, deckd.bootId)
    } finally {
      c.close()
    }
  }
  for (const bad of [0, 1.5]) {
    await assert.rejects(client(bad), { code: 'unsupported_proto' })
  }
})

test('a proto 2 hello carries loginEnvNames, sorted names only; proto 1 does not', async () => {
  const sock = net.connect(deckd.socketPath)
  await new Promise((resolve) => sock.once('connect', resolve))
  /** @type {any[]} */
  const answers = []
  sock.on('data', createLineDecoder((m) => answers.push(m), () => {}))
  try {
    sock.write(encode({ id: 1, op: 'hello', proto: 1, client: { kind: 'server' } }))
    sock.write(encode({ id: 2, op: 'hello', proto: 2, client: { kind: 'server' } }))
    const end = Date.now() + 5000
    while (answers.length < 2 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
    const [one, two] = answers
    assert.equal(one.proto, 1)
    assert.equal(Object.hasOwn(one, 'loginEnvNames'), false)
    assert.equal(two.proto, 2)
    // the injected env has LOGIN_ONLY, which this process does not, and HOME, which differs
    assert.ok(two.loginEnvNames.includes(LOGIN_ONLY), JSON.stringify(two.loginEnvNames))
    assert.ok(two.loginEnvNames.includes('HOME'))
    assert.deepEqual(two.loginEnvNames, [...two.loginEnvNames].sort())
    assert.ok(!JSON.stringify(two).includes('from-login'), 'no values in hello')
  } finally {
    sock.destroy()
  }
})

test('exits carries a tail for proto 2 only: the last 1,000 lines, at most 256 KiB', async () => {
  const c2 = await client(2)
  const c1 = await client(1)
  try {
    const since = Date.now() - 1
    // Short lines: the 1,000-line cut decides.
    const short = await c2.request('spawn', { cwd: rt.dir, argv: [stub], env: {}, cols: 80, rows: 24, origin: 'launched' })
    // Long lines: the last 1,000 are 301 bytes each, so the 256 KiB cut decides.
    const long = await c2.request('spawn', { cwd: rt.dir, argv: [stub], env: {}, cols: 80, rows: 24, origin: 'launched' })
    await waitRow(c2, short.ptyId, (l) => l === 'READY')
    await waitRow(c2, long.ptyId, (l) => l === 'READY')
    let shortText = ''
    let longText = ''
    for (let i = 0; i < 20000; i++) {
      const n = String(i).padStart(5, '0')
      shortText += `S${n}\n`
      longText += i < 19000 ? `S${n}\n` : `L${n}` + 'y'.repeat(294) + '\n'
    }
    for (const [ptyId, text] of [[short.ptyId, shortText], [long.ptyId, longText]]) {
      const buf = Buffer.from(text + 'END\n')
      for (let off = 0; off < buf.length; off += 32 * 1024) {
        await c2.request('write', { ptyId, data: buf.subarray(off, off + 32 * 1024).toString('base64'), source: { kind: 'deck' } })
      }
      await waitRow(c2, ptyId, (l) => l === 'END')
      await killAndWait(c2, ptyId)
    }
    const res2 = await c2.request('exits', { since })
    const res1 = await c1.request('exits', { since })
    for (const e of res1.exits) assert.equal(Object.hasOwn(e, 'tail'), false)
    const byId = new Map(res2.exits.map((/** @type {any} */ e) => [e.ptyId, e]))

    const shortTail = Buffer.from(byId.get(short.ptyId).tail, 'base64').toString()
    const shortRows = shortTail.split('\n')
    assert.equal(shortRows.pop(), '')
    assert.equal(shortRows.length, 1000)
    assert.equal(shortRows[0], 'S19001\r')
    assert.equal(shortRows[998], 'S19999\r')
    assert.equal(shortRows[999], 'END\r')

    const longBytes = Buffer.from(byId.get(long.ptyId).tail, 'base64')
    assert.ok(longBytes.length <= 256 * 1024, `tail is ${longBytes.length} bytes`)
    const longRows = longBytes.toString().split('\n')
    assert.equal(longRows.pop(), '')
    assert.ok(longRows.length < 1000)
    // starts on a line boundary and ends with the newest lines
    assert.match(longRows[0], /^L\d{5}y{294}\r$/)
    assert.match(longRows[longRows.length - 2], /^L19999y/)
    assert.equal(longRows[longRows.length - 1], 'END\r')
  } finally {
    c1.close()
    c2.close()
  }
})

test('the exit event keeps { ptyId, code, signal, at } for a proto 2 client', async () => {
  const c = await client(2)
  try {
    const res = await c.request('spawn', { cwd: rt.dir, argv: [stub], env: {}, origin: 'launched' })
    await waitRow(c, res.ptyId, (l) => l === 'READY')
    const ev = await killAndWait(c, res.ptyId)
    assert.deepEqual(Object.keys(ev).sort(), ['at', 'code', 'ev', 'ptyId', 'signal'])
  } finally {
    c.close()
  }
})

test('launched spawns get the login env, wrapped spawns only req.env; both get TERM and FLEETMATES_DECK_PTY', async () => {
  const c = await client(2)
  try {
    const argv = [path.join(binDir, 'claude')]
    const launched = await c.request('spawn', { cwd: rt.dir, argv, env: {}, origin: 'launched' })
    const wrapped = await c.request('spawn', { cwd: rt.dir, argv, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb' }, origin: 'wrapped' })
    const l = await waitRow(c, launched.ptyId, (row) => row.startsWith('ENV '))
    const w = await waitRow(c, wrapped.ptyId, (row) => row.startsWith('ENV '))
    assert.equal(l, `ENV login=[from-login] term=[xterm-256color] pty=[${launched.ptyId}]`)
    assert.equal(w, `ENV login=[] term=[xterm-256color] pty=[${wrapped.ptyId}]`)
    await killAndWait(c, launched.ptyId)
    await killAndWait(c, wrapped.ptyId)
  } finally {
    c.close()
  }
})

test('spawn refuses a non-string env value, an env that is not an object, and a bad cwd', async () => {
  const c = await client(2)
  try {
    const base = { argv: [stub], origin: 'launched' }
    for (const fields of [
      { cwd: rt.dir, env: { A: 1 } },
      { cwd: rt.dir, env: ['A=1'] },
      { cwd: rt.dir, env: 'A=1' },
      { cwd: 'relative/dir', env: {} },
      { cwd: path.join(rt.dir, 'missing'), env: {} },
      { cwd: stub, env: {} }
    ]) {
      await assert.rejects(c.request('spawn', { ...base, ...fields }), { code: 'bad_request' }, JSON.stringify(fields))
    }
    const list = await c.request('list')
    assert.deepEqual(list.ptys, [])
  } finally {
    c.close()
  }
})

test('a 1.5 MiB line without a newline yields one line_too_long, then ping is answered', async () => {
  const sock = net.connect(deckd.socketPath)
  await new Promise((resolve) => sock.once('connect', resolve))
  /** @type {any[]} */
  const got = []
  sock.on('data', createLineDecoder((m) => got.push(m), () => {}))
  try {
    const chunk = Buffer.alloc(64 * 1024, 'x')
    for (let i = 0; i < 24; i++) sock.write(chunk)
    sock.write('\n' + encode({ id: 1, op: 'hello', proto: 2, client: { kind: 'server' } }) + encode({ id: 2, op: 'ping' }))
    const end = Date.now() + 10000
    while (!got.some((m) => m.id === 2) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
    const errors = got.filter((m) => m.ok === false)
    assert.deepEqual(errors.map((m) => m.error.code), ['line_too_long'])
    const ping = got.find((m) => m.id === 2)
    assert.equal(ping?.ok, true, JSON.stringify(got))
  } finally {
    sock.destroy()
  }
})

test('startDeckd refuses a runtime dir with group or world permission bits', async () => {
  const loose = await mkdtemp(path.join(rt.dir, 'loose-'))
  await chmod(loose, 0o755)
  await assert.rejects(startDeckd({ runtimeDir: loose, loginEnv: {} }), /0755/)
  await mkdir(path.join(loose, 'g'), { mode: 0o700 })
  await chmod(path.join(loose, 'g'), 0o710)
  await assert.rejects(startDeckd({ runtimeDir: path.join(loose, 'g'), loginEnv: {} }), /0710/)
  await rm(loose, { recursive: true, force: true })
})

test('pin: at most 5 screen events in one second while the stub writes 40 frames', async () => {
  const c = await client(2)
  try {
    const res = await c.request('spawn', { cwd: rt.dir, argv: [stub], env: {}, cols: 80, rows: 24, origin: 'launched' })
    await waitRow(c, res.ptyId, (l) => l === 'READY')
    /** @type {number[]} */
    const times = []
    c.on('screen', (m) => { if (m.ptyId === res.ptyId) times.push(Date.now()) })
    await c.request('watchScreen', { ptyId: res.ptyId, on: true })
    for (let i = 0; i < 40; i++) {
      await c.request('write', { ptyId: res.ptyId, data: Buffer.from(`\r\nframe-${i}`).toString('base64'), source: { kind: 'deck' } })
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await waitRow(c, res.ptyId, (l) => l === 'frame-39')
    assert.ok(times.length >= 2, `only ${times.length} screen events`)
    let worst = 0
    for (let i = 0; i < times.length; i++) {
      let n = 0
      for (let j = i; j < times.length && times[j] - times[i] < 1000; j++) n++
      worst = Math.max(worst, n)
    }
    assert.ok(worst <= 5, `${worst} screen events inside one second`)
    await killAndWait(c, res.ptyId)
  } finally {
    c.close()
  }
})

test('pin: a Ring fed 6,000 lines keeps 5,000', () => {
  const ring = new Ring()
  for (let i = 0; i < 6000; i++) ring.push(Buffer.from(`line-${i}\n`))
  assert.equal(ring.lines, 5000)
  const rows = ring.snapshot().toString().split('\n')
  assert.equal(rows[0], 'line-1000')
})

test('pin: a second resize 100 ms after the first lands no sooner than 1 s after it', async () => {
  /** @type {(v?: unknown) => void} */
  let onExit = () => {}
  const exited = new Promise((resolve) => { onExit = resolve })
  const host = PtyHost.spawn({ cwd: rt.dir, argv: [stub], env: {}, cols: 80, rows: 24 }, {
    onOutput: () => {},
    onExit: () => onExit()
  })
  try {
    /** @type {{ at: number, cols: number }[]} */
    const applied = []
    const real = host.proc.resize.bind(host.proc)
    host.proc.resize = (cols, rows) => {
      applied.push({ at: Date.now(), cols })
      real(cols, rows)
    }
    host.requestResize(100, 30, { kind: 'browser' })
    assert.equal(applied.length, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    host.requestResize(110, 33, { kind: 'browser' })
    assert.equal(applied.length, 1, 'the second resize waits')
    const end = Date.now() + 5000
    while (applied.length < 2 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(applied[1]?.cols, 110)
    assert.ok(applied[1].at - applied[0].at >= 1000 - 5, `landed after ${applied[1].at - applied[0].at} ms`)
  } finally {
    host.kill('SIGKILL', 0)
    await exited
    host.dispose()
  }
})
