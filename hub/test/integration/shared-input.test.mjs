// Shared input on one PTY (state-machines section 3, M2 exit criterion 3). The machine is first driven on
// an injected clock, then end to end: a real deckd started in this process with an injected login
// environment, the fake claude, a deckd terminal client named kitty and a browser tab on the deck server.
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
import { createInputMachine, INPUT_QUIET_MS, COLLISION_WINDOW_MS, COLLISION_HOLD_MS } from '../../server/machines/input.mjs'
import { encodeFrame, FRAME_KIND } from '../../server/pty-bridge/frames.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

/** A manual clock with setTimeout and clearTimeout. */
function clock() {
  let at = 1_000_000
  let next = 0
  const timers = new Map()
  return {
    now: () => at,
    setTimeout: (fn, ms) => { const id = ++next
      timers.set(id, { fn, due: at + ms })
      return id },
    clearTimeout: id => { timers.delete(id) },
    advance(ms) {
      const end = at + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
        if (!due) break
        timers.delete(due[0])
        at = due[1].due
        due[1].fn()
      }
      at = end
    }
  }
}

function machine(options = {}) {
  const c = clock()
  const views = []
  const m = createInputMachine({ now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, emit: view => views.push(view), ...options })
  return { c, m, views, states: () => views.map(view => view.state) }
}

const kitty = { kind: 'terminal', name: 'kitty' }

test('the timing constants are those of state-machines 3', () => {
  assert.deepEqual([INPUT_QUIET_MS, COLLISION_WINDOW_MS, COLLISION_HOLD_MS], [2000, 1500, 3000])
})

test('terminal bytes then browser bytes inside the window collide, the chip holds 3 s, then quiet', () => {
  const { c, m, views, states } = machine()
  m.input(kitty)
  assert.deepEqual(views.at(-1), { state: 'terminal_active', from: 'terminal', name: 'kitty', detached: false })
  c.advance(1499)
  m.input({ kind: 'browser' })
  assert.deepEqual(views.at(-1), { state: 'collision', from: 'browser', name: null, detached: false })
  c.advance(2999)
  assert.equal(m.view().state, 'collision', 'held while the chip shows, even past inputQuiet')
  c.advance(1)
  assert.deepEqual(states(), ['terminal_active', 'collision', 'quiet'])
  assert.equal(views.at(-1).from, 'browser', 'quiet keeps who typed last')
})

test('the collision settles on the source of the latest byte while it is still active', () => {
  const { c, m, states } = machine()
  m.input({ kind: 'browser' })
  c.advance(100)
  m.input(kitty)
  c.advance(2900)
  m.input(kitty)
  c.advance(100)
  assert.equal(m.view().state, 'terminal_active')
  assert.equal(m.view().name, 'kitty')
  c.advance(2000)
  assert.deepEqual(states(), ['browser_active', 'collision', 'terminal_active', 'quiet'])
})

test('bytes from the other source outside the window switch the indicator without a collision', () => {
  const { c, m, states } = machine()
  m.input(kitty)
  c.advance(1500)
  m.input({ kind: 'browser' })
  c.advance(1999)
  m.input({ kind: 'deck' })
  assert.deepEqual(states(), ['terminal_active', 'browser_active'], 'deck keys count as browser')
  c.advance(2000)
  assert.deepEqual(states(), ['terminal_active', 'browser_active', 'quiet'])
})

test('quiet starts from the seeded source and only terminal clients count for detached', () => {
  const { m, views } = machine({ from: 'terminal', name: 'kitty' })
  assert.deepEqual(m.view(), { state: 'quiet', from: 'terminal', name: 'kitty', detached: false })
  m.client('attached', { kind: 'server' })
  m.client('detached', { kind: 'server' })
  assert.equal(views.length, 0)
  m.client('attached', kitty)
  m.client('attached', { kind: 'terminal', name: 'foot' })
  m.client('detached', kitty)
  assert.equal(views.length, 0, 'one terminal is still attached')
  m.client('detached', { kind: 'terminal', name: 'foot' })
  assert.deepEqual(views.at(-1), { state: 'quiet', from: 'terminal', name: 'kitty', detached: true })
  m.client('attached', kitty)
  assert.equal(views.at(-1).detached, false)
  m.terminals(1)
  m.client('detached', kitty)
  assert.equal(views.at(-1).detached, true)
})

// End to end.
const token = 'a'.repeat(43)
let rt
let deckd
let bin
let dir

before(async () => {
  rt = await makeRuntimeDir()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shi-'))
  bin = await fakeBin({ version: '2.1.282' })
  deckd = await startDeckd({ runtimeDir: rt.dir, version: '9.9.9', loginEnv: { PATH: bin.env.PATH, HOME: dir } })
})

after(async () => {
  await deckd?.close()
  await bin?.cleanup()
  await rt?.cleanup()
  // Windows refuses to remove a directory a closing process or an open file still holds; retry for a while.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('kitty types, the browser types inside the window: terminal_active, collision, quiet, lastInputFrom browser, then detached', async t => {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const env = { HOME: home, XDG_RUNTIME_DIR: rt.dir }
  // The token where the server reads it for this env: ~/.local/state/... on linux, under AppData\Local on win32.
  const tokenFile = setupPaths(env).token
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  const deck = await startDeckServer({ env, port: 0, notifications: false,
    runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(() => deck.close())
  const kittyClient = await connectDeckd({ runtimeDir: rt.dir, kind: 'terminal', name: 'kitty' })
  t.after(() => kittyClient.close())
  const script = path.join(dir, 'script.json')
  fs.writeFileSync(script, JSON.stringify({ sessionId: 'auto', steps: [{ print: 'ready>' }, { echo: {} }] }))
  let off
  const ready = new Promise(resolve => { off = deck.link.onParsed(event => { if (event.lines.some(line => line.includes('ready>'))) resolve(event.ptyId) }) })
  t.after(() => off())
  const { ptyId } = await kittyClient.request('spawn', { cwd: fs.mkdtempSync(path.join(dir, 'repo-')), argv: ['claude'], cols: 100, rows: 30, origin: 'wrapped',
    env: { PATH: bin.env.PATH, HOME: dir, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_VERSION: '2.1.282' } })
  t.after(() => kittyClient.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 }).catch(() => {}))
  await kittyClient.request('attach', { ptyId, stream: true })
  assert.equal(await ready, ptyId)
  const row = deck.projector.snapshot().sessions.find(session => session.ptyId === ptyId)

  const port = deck.address().port
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { headers: { Origin: `http://127.0.0.1:${port}` } })
  ws.on('error', () => {})
  t.after(() => ws.terminate())
  const messages = []
  const changed = new Set()
  ws.on('message', (data, binary) => {
    if (!binary) messages.push(JSON.parse(data.toString()))
    for (const fn of [...changed]) fn()
  })
  const until = (fn, what) => new Promise((resolve, reject) => {
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
  await once(ws, 'open')
  ws.send(JSON.stringify({ t: 'hello', apiVersion: 1, epoch: null, lastSeq: 0 }))
  await until(() => messages.some(m => m.t === 'snapshot'), 'the snapshot')
  ws.send(JSON.stringify({ t: 'term.attach', sessionId: row.id, cols: 100, rows: 30 }))
  await until(() => messages.some(m => m.t === 'term.attached'), 'term.attached')
  const sources = () => messages.filter(m => m.t === 'input.source' && m.data.sessionId === row.id).map(m => m.data)

  await kittyClient.request('write', { ptyId, data: Buffer.from('k').toString('base64'), source: { kind: 'terminal', name: 'kitty' } })
  ws.send(encodeFrame(FRAME_KIND.input, row.id, Buffer.from('b')))
  await until(() => sources().length >= 2, 'two input.source events')
  assert.deepEqual(sources().slice(0, 2).map(view => [view.state, view.from, view.name]), [['terminal_active', 'terminal', 'kitty'], ['collision', 'browser', null]])
  await until(() => sources().some(view => view.state === 'quiet'), 'quiet')
  assert.deepEqual(sources().map(view => view.state), ['terminal_active', 'collision', 'quiet'])
  const session = deck.projector.snapshot().sessions.find(s => s.id === row.id)
  assert.equal(session.lastInputFrom, 'browser')
  assert.equal(sources().at(-1).detached, false)

  await kittyClient.request('detach', { ptyId })
  const detached = await until(() => sources().find(view => view.detached), 'detached')
  assert.deepEqual(detached, { sessionId: row.id, state: 'quiet', from: 'browser', name: null, detached: true })
  assert.equal(messages.find(m => m.t === 'input.source').seq, undefined, 'input.source is ephemeral')
})
