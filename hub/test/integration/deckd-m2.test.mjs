// deckd M2 behaviour: hello versioning, exit tails, the login environment,
// spawn validation, the line cap, the runtime dir check, and pins for the M0
// throttles. deckd runs in this process with an injected login environment,
// so no test runs a login shell.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, chmod, writeFile, readFile, rm, rmdir, stat, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { cmdShim } from '../helpers/fake-bin.mjs'
import { posixTest } from '../helpers/platform.mjs'
import { runtimeBase, deckDir, endpoint } from '../../platform/index.mjs'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd, checkEndpointDirs } from '../../deckd/client.mjs'
import { encode, createLineDecoder } from '../../deckd/protocol.mjs'
import { PtyHost } from '../../deckd/pty-host.mjs'
import { Ring } from '../../deckd/ring.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubScript = path.join(here, 'stubs', 'claude')
const mainPath = path.resolve(here, '..', '..', 'deckd', 'main.mjs')
const onWindows = process.platform === 'win32'
/** What a minimal environment keeps so node can start on Windows; nothing elsewhere. */
const winBaseEnv = onWindows && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}

/**
 * This process's environment as plain string values (Windows only; see the
 * loginEnv in before()).
 * @returns {Record<string, string>}
 */
function winFullEnv () {
  return Object.fromEntries(Object.entries(process.env).filter((e) => typeof e[1] === 'string'))
}

/**
 * Write a `claude` into `dir` that runs the node module `script` with this
 * node, and return its path. POSIX: a `#!/bin/sh` script that execs node on
 * it. Windows: an npm cmd-shim `claude.cmd` and an entry module beside it
 * that imports `script`, because the shim addresses a script relative to its
 * own directory.
 * @param {string} dir
 * @param {string} script
 * @returns {Promise<string>}
 */
async function nodeClaude (dir, script) {
  if (onWindows) {
    await writeFile(path.join(dir, 'claude-entry.mjs'), `await import(${JSON.stringify(pathToFileURL(script).href)})\n`)
    const file = path.join(dir, 'claude.cmd')
    await writeFile(file, cmdShim('claude-entry.mjs'))
    return file
  }
  const q = (/** @type {string} */ v) => `'${v.replaceAll("'", "'\\''")}'`
  const file = path.join(dir, 'claude')
  await writeFile(file, `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} "$@"\n`, { mode: 0o700 })
  return file
}

/**
 * Write a `claude` into `dir` that prints `prefix` and then, for each name in
 * `names`, ` <label>=[<value or empty>]`, then echoes its input until killed.
 * @param {string} dir
 * @param {string} prefix
 * @param {[string, string][]} names label and variable name pairs
 * @returns {Promise<string>}
 */
async function envClaude (dir, prefix, names) {
  const script = path.join(dir, 'env-claude.mjs')
  await writeFile(script, [
    `const names = ${JSON.stringify(names)}`,
    `const line = ${JSON.stringify(prefix)} + names.map(([label, name]) => \` \${label}=[\${process.env[name] ?? ''}]\`).join('')`,
    "process.stdout.write(line + '\\r\\n')",
    "process.stdin.on('data', (d) => process.stdout.write(d))"
  ].join('\n') + '\n')
  return nodeClaude(dir, script)
}

/** @type {Awaited<ReturnType<typeof makeRuntimeDir>>} */
let rt
/** @type {Awaited<ReturnType<typeof startDeckd>>} */
let deckd
/** @type {string} */
let binDir
/** The stub `claude` deckd spawns. @type {string} */
let stub
const LOGIN_ONLY = 'DECK_TEST_LOGIN_ONLY'

before(async () => {
  rt = await makeRuntimeDir()
  binDir = await mkdtemp(path.join(rt.dir, 'bin-'))
  stub = onWindows ? await nodeClaude(await mkdtemp(path.join(rt.dir, 'stub-')), stubScript) : stubScript
  // A `claude` that prints the variables under test, then echoes input.
  await envClaude(binDir, 'ENV', [['login', LOGIN_ONLY], ['term', 'TERM'], ['pty', 'FLEETMATES_DECK_PTY']])
  deckd = await startDeckd({
    runtimeDir: rt.dir,
    version: '9.9.9',
    // On Windows the stub, a node process, starts from this environment too.
    // On the Windows 11 VM the stubs launched with only these three names
    // were gone about a second after spawn while the wrapped ones, which had
    // SystemRoot, ran; so there it gets this process's environment under them.
    loginEnv: { ...(onWindows ? winFullEnv() : {}), PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: rt.dir, [LOGIN_ONLY]: 'from-login' }
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

posixTest('exits carries a tail for proto 2 only: the last 1,000 lines, at most 256 KiB', {
  // The assertions count the echoed bytes line by line. ConPTY re-renders
  // output instead of passing it through, and on the Windows 11 VM the
  // 20,000-line echo had not reached END on the screen after 27 s.
  reason: 'ConPTY re-renders the echoed flood, so the tail is not the byte stream these assertions count'
}, async () => {
  const c2 = await client(2)
  const c1 = await client(1)
  /** PTYs this test spawned, killed in `finally` when a failure left them running. @type {string[]} */
  const spawned = []
  try {
    const since = Date.now() - 1
    // Short lines: the 1,000-line cut decides.
    const short = await c2.request('spawn', { cwd: rt.dir, argv: [stub], env: {}, cols: 80, rows: 24, origin: 'launched' })
    spawned.push(short.ptyId)
    // Long lines: the last 1,000 are 301 bytes each, so the 256 KiB cut decides.
    const long = await c2.request('spawn', { cwd: rt.dir, argv: [stub], env: {}, cols: 80, rows: 24, origin: 'launched' })
    spawned.push(long.ptyId)
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
    const live = new Set((await c2.request('list').catch(() => ({ ptys: [] }))).ptys.map((/** @type {any} */ p) => p.ptyId))
    for (const id of spawned) if (live.has(id)) await killAndWait(c2, id)
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
    const argv = [path.join(binDir, onWindows ? 'claude.cmd' : 'claude')]
    const launched = await c.request('spawn', { cwd: rt.dir, argv, env: {}, origin: 'launched' })
    const wrapped = await c.request('spawn', { cwd: rt.dir, argv, env: { ...winBaseEnv, PATH:process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb' }, origin: 'wrapped' })
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
    // Only PTYs these spawns could have added count, not one an earlier test left running.
    const before = new Set((await c.request('list')).ptys.map((/** @type {any} */ p) => p.ptyId))
    const base = { argv: [stub], origin: 'launched' }
    // path.relative gives back an absolute path when rt.dir is on another drive than the working directory (TEMP
    // on C:, the checkout on D: on the GitHub Windows runner); '.' is then the relative directory that exists.
    const fromHere = path.relative(process.cwd(), rt.dir)
    const relative = fromHere && !path.isAbsolute(fromHere) ? fromHere : '.'
    assert.equal(path.isAbsolute(relative), false, relative)
    for (const fields of [
      { cwd: rt.dir, env: { A: 1 } },
      { cwd: rt.dir, env: ['A=1'] },
      { cwd: rt.dir, env: 'A=1' },
      // relative, though it names a directory that exists from here
      { cwd: relative, env: {} },
      { cwd: path.join(rt.dir, 'missing'), env: {} },
      { cwd: stub, env: {} }
    ]) {
      await assert.rejects(c.request('spawn', { ...base, ...fields }), { code: 'bad_request' }, JSON.stringify(fields))
    }
    const list = await c.request('list')
    assert.deepEqual(list.ptys.filter((/** @type {any} */ p) => !before.has(p.ptyId)), [])
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

/**
 * Start deckd on `runtimeDir` and return the error it refused with, or
 * null after closing a deckd that did start.
 * @param {string} runtimeDir
 * @returns {Promise<Error | null>}
 */
async function startError (runtimeDir) {
  return startDeckd({ runtimeDir, loginEnv: {} }).then((d) => d.close().then(() => null), (err) => err)
}

posixTest('startDeckd refuses a runtime dir with group or world permission bits', async () => {
  const loose = await mkdtemp(path.join(rt.dir, 'loose-'))
  try {
    await chmod(loose, 0o755)
    // ensurePrivateDir's message: the base is checked before anything is created under it
    assert.equal(String((await startError(loose))?.message), `runtime dir ${loose} has mode 0755; it must allow no group or world access (0700)`)
    await mkdir(path.join(loose, 'g'), { mode: 0o700 })
    await chmod(path.join(loose, 'g'), 0o710)
    assert.equal(String((await startError(path.join(loose, 'g')))?.message), `runtime dir ${path.join(loose, 'g')} has mode 0710; it must allow no group or world access (0700)`)
    // and nothing was created under the refused base
    await assert.rejects(stat(path.join(loose, 'fleetmates-deck')), { code: 'ENOENT' })
  } finally {
    await rm(loose, { recursive: true, force: true })
  }
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

/**
 * A `claude` that prints Claude Code's session variables and a profile-style
 * one, then waits.
 * @param {string} dir
 * @returns {Promise<string>} its path
 */
async function sessionVarsClaude (dir) {
  return envClaude(dir, 'SESS', [['cc', 'CLAUDECODE'], ['sid', 'CLAUDE_CODE_SESSION_ID'], ['foo', 'CLAUDE_CODE_FOO']])
}

/**
 * Run `node main.mjs` with exactly `env` (plus a private runtime dir) until
 * it listens, call `fn`, then stop it with SIGTERM.
 * @param {Record<string, string>} env
 * @param {(runtimeDir: string, stderr: () => string) => Promise<void>} [fn]
 */
async function withMain (env, fn = async () => {}) {
  const runtime = await makeRuntimeDir()
  try {
    await runMain({ ...env, XDG_RUNTIME_DIR: runtime.dir }, (stderr) => fn(runtime.dir, stderr))
  } finally {
    await runtime.cleanup()
  }
}

/**
 * Run `node main.mjs` with exactly `env` until it listens, call `fn`, then
 * stop it with SIGTERM.
 * @param {Record<string, string>} env
 * @param {(stderr: () => string) => Promise<void>} fn
 */
async function runMain (env, fn) {
  const proc = spawn(process.execPath, [mainPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr?.on('data', (d) => { stderr += d })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`deckd did not start: ${stderr}`)), 15000)
      proc.stderr?.on('data', () => {
        if (stderr.includes('deckd listening on')) { clearTimeout(timer); resolve(undefined) }
      })
      proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`deckd exited ${code}: ${stderr}`)) })
    })
    await fn(() => stderr)
  } finally {
    if (proc.exitCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve))
      proc.kill('SIGTERM')
      await exited
    }
  }
}

posixTest('main runs the login probe unless DECKD_LOGIN_ENV=inherit; NODE_TEST_CONTEXT does not skip it', { reason: 'the fake login shell is a /bin/sh script, and win32 runs no probe' }, async () => {
  const dir = await mkdtemp(path.join(rt.dir, 'probe-'))
  const marker = path.join(dir, 'probe.argv')
  // A fake login shell: records its argv, then runs the probe's command
  // without reading any profile.
  const shell = path.join(dir, 'fake-shell')
  await writeFile(shell, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${marker}'\nexec /bin/sh -c "$4"\n`, { mode: 0o700 })
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, SHELL: shell }
  try {
    await withMain({ ...base, NODE_TEST_CONTEXT: 'child-v8' })
    const ran = await readFile(marker, 'utf8')
    assert.deepEqual(ran.split('\n').slice(0, 3), ['-l', '-i', '-c'])
    await rm(marker)
    await withMain({ ...base, NODE_TEST_CONTEXT: 'child-v8', DECKD_LOGIN_ENV: 'inherit' })
    assert.equal(await readFile(marker, 'utf8').catch(() => ''), '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('main with DECKD_LOGIN_ENV=inherit still drops the session variables from launched sessions', async () => {
  const dir = await mkdtemp(path.join(rt.dir, 'inherit-'))
  const claude = await sessionVarsClaude(dir)
  try {
    await withMain({
      ...winBaseEnv,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      SHELL: path.join(dir, 'no-such-shell'),
      DECKD_LOGIN_ENV: 'inherit',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_FOO: 'kept'
    }, async (runtimeDir) => {
      const c = await connectDeckd({ runtimeDir, kind: 'server', name: 'm2' })
      try {
        const res = await c.request('spawn', { cwd: dir, argv: [claude], env: {}, origin: 'launched' })
        assert.equal(await waitRow(c, res.ptyId, (l) => l.startsWith('SESS ')), 'SESS cc=[] sid=[] foo=[kept]')
        await killAndWait(c, res.ptyId)
      } finally {
        c.close()
      }
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startDeckd without loginEnv drops the session variables of its own environment', async () => {
  const runtime = await makeRuntimeDir()
  const claude = await sessionVarsClaude(runtime.dir)
  const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_FOO: process.env.CLAUDE_CODE_FOO }
  Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_FOO: 'kept' })
  /** @type {Awaited<ReturnType<typeof startDeckd>> | undefined} */
  let d
  try {
    d = await startDeckd({ runtimeDir: runtime.dir })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  const c = await connectDeckd({ runtimeDir: runtime.dir, kind: 'server', name: 'm2' })
  try {
    const res = await c.request('spawn', { cwd: runtime.dir, argv: [claude], env: {}, origin: 'launched' })
    assert.equal(await waitRow(c, res.ptyId, (l) => l.startsWith('SESS ')), 'SESS cc=[] sid=[] foo=[kept]')
    await killAndWait(c, res.ptyId)
  } finally {
    c.close()
    await d?.close()
    await runtime.cleanup()
  }
})

test('main with XDG_RUNTIME_DIR unset listens under the runtimeBase fallback, and connectDeckd reaches it there', {
  skip: process.platform !== 'linux' && 'the /tmp/fleetmates-deck-<uid> fallback is the linux base'
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deck-home-'))
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SHELL: path.join(home, 'no-such-shell'), DECKD_LOGIN_ENV: 'inherit' }
  const base = runtimeBase({ env })
  assert.equal(base, `/tmp/fleetmates-deck-${process.getuid?.()}`)
  // Remove afterwards only what this test created: another run may own the base.
  const exists = (/** @type {string} */ p) => stat(p).then(() => true, () => false)
  const baseExisted = await exists(base)
  const deckDirExisted = await exists(deckDir(base))
  try {
    // The base is shared by every user of the fallback on this machine: a
    // parallel test file, another worktree or a gate preview may hold it with
    // its own deckd. main has no override for it, so wait for that one to go
    // (up to 30 s) instead of failing on `another deckd is listening`.
    const deadline = Date.now() + 30000
    for (;;) {
      try {
        await runMain(env, async (stderr) => {
          assert.ok(stderr().includes(`deckd listening on ${endpoint(base, 'deckd')}`), stderr())
          const c = await connectDeckd({ runtimeDir: base, kind: 'server', name: 'm2' })
          try {
            assert.equal(typeof (await c.request('ping')).at, 'number')
          } finally {
            c.close()
          }
        })
        break
      } catch (err) {
        if (!/^deckd exited \d+: [^]*another deckd is listening on /.test(/** @type {Error} */ (err).message) || Date.now() > deadline) throw err
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  } finally {
    // Not recursive: a concurrent run of this test (another worktree, a gate
    // preview) may be using the same base, and its socket must survive.
    // A dir still holding something stays.
    const rmEmpty = (/** @type {string} */ d) => rmdir(d).catch(() => {})
    if (!deckDirExisted) await rmEmpty(deckDir(base))
    if (!baseExisted) await rmEmpty(base)
    await rm(home, { recursive: true, force: true })
  }
})

test('on a pipe endpoint a second deckd on the same base is refused, and connectDeckd reaches the first', async () => {
  // win32 is injected. Off Windows the `\\.\pipe\...` name is then a Unix
  // socket file of that name in the working directory, and so is the
  // win32-joined deck dir: both land in a temp dir made the working directory
  // for this test only.
  const cwd = process.cwd()
  const scratch = await mkdtemp(path.join(rt.dir, 'pipe-'))
  const base = path.join(scratch, 'base')
  process.chdir(scratch)
  /** @type {Awaited<ReturnType<typeof startDeckd>> | undefined} */
  let first
  try {
    first = await startDeckd({ runtimeDir: base, platform: 'win32', loginEnv: {} })
    const pipe = endpoint(base, 'deckd', { platform: 'win32' })
    assert.equal(first.socketPath, pipe)
    assert.match(pipe, /^\\\\\.\\pipe\\fleetmates-deck-[0-9a-f]{16}-deckd$/)
    await assert.rejects(startDeckd({ runtimeDir: base, platform: 'win32', loginEnv: {} }), { message: `another deckd is listening on ${pipe}` })
    const c = await connectDeckd({ runtimeDir: base, platform: 'win32', kind: 'server', name: 'm2' })
    try {
      assert.equal(c.bootId, first.bootId)
    } finally {
      c.close()
    }
  } finally {
    await first?.close()
    process.chdir(cwd)
    await rm(scratch, { recursive: true, force: true })
  }
})

/**
 * A runtime dir laid out as deckd leaves it (base and deck dir 0700), changed
 * by `prepare`, with a plain listener on its deckd endpoint that counts the
 * connections it receives, standing in for a squatter's.
 * @param {(base: string, deck: string) => Promise<void>} prepare
 * @param {(base: string, connections: () => number) => Promise<void>} fn
 */
async function withSquatter (prepare, fn) {
  const base = await mkdtemp(path.join(rt.dir, 'sq-'))
  const deck = path.join(base, 'fleetmates-deck')
  await mkdir(deck, { mode: 0o700 })
  await chmod(deck, 0o700)
  await prepare(base, deck)
  let connections = 0
  const server = net.createServer((s) => { connections++; s.destroy() })
  await new Promise((resolve) => server.listen(endpoint(base, 'deckd'), () => resolve(undefined)))
  try {
    await fn(base, () => connections)
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await rm(base, { recursive: true, force: true })
  }
}

/**
 * Assert connectDeckd refuses `base` with not_private, naming `dir` and
 * `problem`, before connecting to anything.
 * @param {string} base
 * @param {() => number} connections
 * @param {string} dir
 * @param {RegExp} problem
 * @param {number | null} [uid]
 */
async function assertNotPrivate (base, connections, dir, problem, uid) {
  const err = await connectDeckd({ runtimeDir: base, kind: 'server', name: 'm2', ...(uid === undefined ? {} : { uid }) }).then(
    (c) => { c.close(); return null }, (e) => e)
  assert.equal(err?.code, 'not_private', String(err))
  assert.ok(err.message.startsWith(`deckd endpoint dir ${dir} is not private: it `), err.message)
  assert.match(err.message, problem)
  assert.equal(connections(), 0)
}

posixTest('connectDeckd refuses a runtime dir that allows group or world access, before connecting', async () => {
  await withSquatter((base) => chmod(base, 0o777), async (base, connections) => {
    await assertNotPrivate(base, connections, base, /has mode 0777/)
  })
})

posixTest('connectDeckd refuses a deck dir that allows group access, before connecting', async () => {
  await withSquatter((_base, deck) => chmod(deck, 0o750), async (base, connections) => {
    await assertNotPrivate(base, connections, deckDir(base), /has mode 0750/)
  })
})

posixTest('connectDeckd refuses a deck dir that is a symlink, though its target is private', async () => {
  await withSquatter(async (base, deck) => {
    const real = path.join(base, 'real')
    await mkdir(real, { mode: 0o700 })
    await chmod(real, 0o700)
    await rm(deck, { recursive: true })
    await symlink(real, deck)
  }, async (base, connections) => {
    await assertNotPrivate(base, connections, deckDir(base), /is a symlink/)
  })
})

posixTest('connectDeckd refuses dirs owned by another uid', async () => {
  const other = (process.getuid?.() ?? 0) + 1
  await withSquatter(async () => {}, async (base, connections) => {
    await assertNotPrivate(base, connections, base, new RegExp(`is owned by uid ${process.getuid?.()}, not by this user`), other)
  })
})

posixTest('checkEndpointDirs accepts the layout deckd makes, and a missing base rejects with ENOENT as an unreachable deckd does', async () => {
  await withSquatter(async () => {}, async (base) => {
    await checkEndpointDirs(base)
  })
  const missing = path.join(rt.dir, 'no-such-base')
  await assert.rejects(checkEndpointDirs(missing), { code: 'ENOENT' })
  await assert.rejects(connectDeckd({ runtimeDir: missing, kind: 'server' }), { code: 'ENOENT' })
})

test('checkEndpointDirs checks the base and deck dir, or only the /tmp fallback dir for a too-long base', async () => {
  /** @type {string[]} */
  let seen = []
  /** @param {string} p */
  const lstat = async (p) => {
    seen.push(p)
    return /** @type {any} */ ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700 })
  }
  await checkEndpointDirs('/run/user/1000', { platform: 'linux', uid: 1000, lstat })
  assert.deepEqual(seen, ['/run/user/1000', '/run/user/1000/fleetmates-deck'])
  seen = []
  const long = '/home/you/' + 'x'.repeat(100)
  assert.equal(endpoint(long, 'deckd', { platform: 'linux', uid: 1000 }), '/tmp/fleetmates-deck-1000/deckd.sock')
  await checkEndpointDirs(long, { platform: 'linux', uid: 1000, lstat })
  // the endpoint's uid is this process's, as deckd's is
  assert.deepEqual(seen, [`/tmp/fleetmates-deck-${process.getuid?.() ?? null}`])
})

posixTest('startDeckd refuses a deck dir that is a symlink, which its clients would refuse', async () => {
  const base = await mkdtemp(path.join(rt.dir, 'sl-'))
  try {
    const real = path.join(base, 'real')
    await mkdir(real, { mode: 0o700 })
    await chmod(real, 0o700)
    await symlink(real, path.join(base, 'fleetmates-deck'))
    const err = await startError(base)
    assert.equal(/** @type {any} */ (err)?.code, 'not_private', String(err))
    assert.match(String(err?.message), /fleetmates-deck is not private: it is a symlink/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('checkEndpointDirs checks nothing for a win32 pipe endpoint', async () => {
  await checkEndpointDirs(path.join(rt.dir, 'no-such-base'), { platform: 'win32', lstat: () => { throw new Error('lstat must not run on win32') } })
})
