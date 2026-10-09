// M2 exit criterion 2: restarting the web server loses no session. A real deckd (started in this process
// with an injected login environment, so no login shell runs) runs three wrapped fake claudes on the
// echo.json script; a browser client types into each through one server, the server is closed and a new one
// starts on the same state dir, and the client reconnects with its lastSeq and epoch, re-attaches and types
// again. deckd still runs all three PTYs and no session is crashed.
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { startDeckServer } from '../../server/main.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { encodeFrame, decodeFrame, FRAME_KIND } from '../../server/pty-bridge/frames.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'

const token = 'a'.repeat(43)
let rt
let deckd
let bin
let dir
let term

before(async () => {
  rt = await makeRuntimeDir()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rst-'))
  bin = await fakeBin({ version: '2.1.282' })
  deckd = await startDeckd({ runtimeDir: rt.dir, version: '9.9.9', loginEnv: { PATH: bin.env.PATH, HOME: dir } })
  term = await connectDeckd({ runtimeDir: rt.dir, kind: 'terminal', name: 'test-terminal' })
})

after(async () => {
  term?.close()
  await deckd?.close()
  await bin?.cleanup()
  await rt?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Resolve once `fn()` is truthy, re-checked whenever `changed` fires. */
function waiter(changed) {
  return (fn, what) => new Promise((resolve, reject) => {
    const check = () => {
      const value = fn()
      if (value) { changed.delete(check)
        clearTimeout(timer)
        resolve(value) }
    }
    const timer = setTimeout(() => { changed.delete(check)
      reject(Error(`timed out waiting for ${what}`)) }, 15_000)
    changed.add(check)
    check()
  })
}

/** A browser tab: it says hello with `resume` ({ lastSeq, epoch }) and tracks lastSeq as the SPA does. */
async function tab(t, deck, resume = { lastSeq: 0, epoch: null }) {
  const port = deck.address().port
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { headers: { Origin: `http://127.0.0.1:${port}` } })
  ws.on('error', () => {})
  t.after(() => ws.terminate())
  const json = []
  const output = new Map()
  const changed = new Set()
  const state = { lastSeq: resume.lastSeq, epoch: resume.epoch }
  ws.on('message', (data, binary) => {
    if (binary) {
      const frame = decodeFrame(data)
      if (frame.kind !== FRAME_KIND.input) output.set(frame.sessionId, (output.get(frame.sessionId) ?? '') + frame.payload.toString())
    } else {
      const message = JSON.parse(data.toString())
      json.push(message)
      if (message.t === 'snapshot') Object.assign(state, { lastSeq: message.seq, epoch: message.epoch })
      else if (typeof message.seq === 'number') state.lastSeq = Math.max(state.lastSeq, message.seq)
    }
    for (const fn of [...changed]) fn()
  })
  ws.on('close', () => { for (const fn of [...changed]) fn() })
  const until = waiter(changed)
  await once(ws, 'open')
  ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, epoch: state.epoch, lastSeq: state.lastSeq }))
  await until(() => json.some(m => m.t === 'snapshot' || m.t === 'replay.end'), 'the snapshot or replay')
  return {
    ws, json, state, until,
    output: sessionId => output.get(sessionId) ?? '',
    attach: sessionId => ws.send(JSON.stringify({ t: 'term.attach', sessionId, cols: 100, rows: 30 })),
    type: (sessionId, text) => ws.send(encodeFrame(FRAME_KIND.input, sessionId, Buffer.from(text)))
  }
}

test('a restarted server reconciles the three running PTYs and the reconnected tab types into each again', async t => {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const env = { HOME: home, XDG_RUNTIME_DIR: rt.dir }
  // Where the server reads its state for this env on this platform; both servers start on it.
  const stateDir = setupPaths(env).state
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(stateDir, 'token'), token, { mode: 0o600 })
  const start = () => startDeckServer({ env, port: 0, notifications: false,
    runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })

  const first = await start()
  let firstClosed = false
  t.after(() => firstClosed ? undefined : first.close())
  const ptyIds = []
  for (let n = 0; n < 3; n++) {
    const { ptyId } = await term.request('spawn', { cwd: fs.mkdtempSync(path.join(dir, 'repo-')), argv: ['claude'], cols: 100, rows: 30, origin: 'wrapped',
      env: { PATH: bin.env.PATH, HOME: dir, FAKE_CLAUDE_SCRIPT: 'echo', FAKE_CLAUDE_VERSION: '2.1.282' } })
    ptyIds.push(ptyId)
    t.after(() => term.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 }).catch(() => {}))
  }
  // The spawned events reach the server on its own deckd connection; wait for the three rows it publishes.
  const changed = new Set()
  t.after(first.subscribe(() => { for (const fn of [...changed]) fn() }))
  const rows = await waiter(changed)(() => {
    const found = ptyIds.map(ptyId => first.projector.snapshot().sessions.find(session => session.ptyId === ptyId))
    return found.every(Boolean) && found
  }, 'a session row for each spawn')

  const before = await tab(t, first)
  for (const [n, row] of rows.entries()) {
    before.attach(row.id)
    await before.until(() => before.json.some(m => m.t === 'term.attached' && m.sessionId === row.id), `attach ${n}`)
    before.type(row.id, `hi-${n}`)
  }
  for (const [n, row] of rows.entries()) await before.until(() => before.output(row.id).includes(`hi-${n}`), `the echo of hi-${n}`)
  const resume = { ...before.state }
  assert.equal(typeof resume.epoch, 'string')

  const closing = once(before.ws, 'close')
  firstClosed = true
  await first.close()
  await closing

  const second = await start()
  t.after(() => second.close())
  assert.equal(second.link.health().state, 'ok', 'the new server reconciled with deckd')
  const after = await tab(t, second, resume)
  assert.equal(after.json[0].t, 'welcome')
  assert.equal(after.json[0].epoch, resume.epoch, 'the same state dir keeps the epoch')
  for (const [n, row] of rows.entries()) {
    after.attach(row.id)
    await after.until(() => after.json.some(m => m.t === 'term.attached' && m.sessionId === row.id), `re-attach ${n}`)
    after.type(row.id, `ping-${n}`)
  }
  for (const [n, row] of rows.entries()) await after.until(() => after.output(row.id).includes(`ping-${n}`), `the echo of ping-${n}`)
  assert.equal(after.json.filter(m => m.t === 'term.error').length, 0)

  const { ptys } = await term.request('list')
  assert.deepEqual(ptys.map(pty => pty.ptyId).filter(id => ptyIds.includes(id)).sort(), [...ptyIds].sort(), 'deckd still runs all three')
  const sessions = second.projector.snapshot().sessions.filter(session => ptyIds.includes(session.ptyId))
  assert.equal(sessions.length, 3, 'no duplicate rows after reconcile')
  for (const session of sessions) {
    assert.notEqual(session.state, 'crashed')
    assert.equal(session.alive, true)
  }
})
