// M4 Task 16, exit criterion 4 (docs/deck/12-milestones.md section 6; state-machines 9.5): while scribed is
// recording, a permission request gives its popup and no chime, whoever started the recording; after the recording a
// new request chimes once, a request opened during it never chimes late, and with quietInMeetings off a request
// during a recording chimes. The server runs as a child process (`node hub/server/main.mjs` by absolute path) with
// its default notifier; notify-send, makoctl, pw-play and the other host binaries are logging shims, and the child's
// PATH holds only them. The child's environment is built from nothing: HOME, XDG_RUNTIME_DIR, DECK_PORT, SHIM_LOG and
// PATH, so no session bus, display or token of this process reaches it. The fake scribed runs in this process.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { meetings5, writeMeetingsTree } from '../helpers/meetings-tree.mjs'

const token = 'q'.repeat(43)
const serverMain = fileURLToPath(new URL('../../server/main.mjs', import.meta.url))
const hookFixture = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))
const HOST_BINARIES = ['systemd-run', 'systemctl', 'scribed', 'scribe', 'postmeet', 'xdg-open', 'notify-send', 'makoctl', 'pw-play', 'claude']
/** The recorder's status poll (recorder.mjs `pollMs` default). */
const POLL_MS = 2000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, ms = 5000, what = 'condition') {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    assert.ok(Date.now() < until, `timed out waiting for ${what}`)
    await sleep(25)
  }
}

async function freePort() {
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const { port } = reservation.address()
  await new Promise(resolve => reservation.close(resolve))
  return port
}

async function harness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mquiet-'))
  await writeMeetingsTree(home, meetings5)
  const rt = await makeRuntimeDir()
  const fake = await startFakeScribed({ dir: rt.dir })
  const state = path.join(home, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const shimDir = path.join(home, 'bin')
  const shimLog = path.join(home, 'shim-argv.jsonl')
  fs.mkdirSync(shimDir, { mode: 0o700 })
  for (const name of HOST_BINARIES) {
    fs.writeFileSync(path.join(shimDir, name), `#!${process.execPath}
import fs from 'node:fs'
for await (const chunk of process.stdin) {}
fs.appendFileSync(process.env.SHIM_LOG, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + '\\n')
process.stdout.write('42\\n')
`, { mode: 0o700 })
  }
  const port = await freePort()
  const env = { HOME: home, XDG_RUNTIME_DIR: rt.dir, DECK_PORT: String(port), PATH: shimDir, SHIM_LOG: shimLog }
  const resolved = execFileSync('/bin/sh', ['-c', 'command -v systemd-run; command -v notify-send; command -v pw-play; command -v makoctl'], { env, encoding: 'utf8' })
  assert.deepEqual(resolved.trim().split('\n'), ['systemd-run', 'notify-send', 'pw-play', 'makoctl'].map(name => path.join(shimDir, name)))
  const child = spawn(process.execPath, [serverMain], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stdout.on('data', chunk => { diagnostics += chunk })
  child.stderr.on('data', chunk => { diagnostics += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closing = once(child, 'close')
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000)
      await closing
      clearTimeout(timeout)
    }
    await fake.stop()
    await rt.cleanup()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  const headers = { Authorization: `Bearer ${token}`, Origin: base }
  let ready = false
  for (let i = 0; i < 200 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/health`, { headers })).ok } catch {}
    if (!ready) await sleep(25)
  }
  assert.equal(ready, true, diagnostics)
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(base + route, {
      method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }
  const calls = command => (fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
    .filter(row => row.command === command)
  const popups = () => calls('notify-send').filter(row => !row.args.includes('Test ping'))
  /**
   * Send SessionStart and PermissionRequest for `sessionId` through the hook socket, dated past the 3 s popup grace,
   * and wait for its popup.
   */
  const permission = async sessionId => {
    const before = popups().length
    const socket = net.connect(path.join(rt.dir, 'fleetmates-deck/hooks.sock'))
    await once(socket, 'connect')
    const at = Date.now() - 3100
    const envelope = event => ({ v: 1, hookTs: at, ptyId: null, claudePid: null, pidChain: [], truncated: false,
      hook: { ...hookFixture, cwd: home, session_id: sessionId, hook_event_name: event, ...(event === 'PermissionRequest' ? { tool_name: 'Bash', tool_input: { command: 'pwd' } } : {}) } })
    socket.end(['SessionStart', 'PermissionRequest'].map(event => JSON.stringify(envelope(event))).join('\n') + '\n')
    await once(socket, 'close')
    await waitFor(() => popups().length > before, 5000, `the popup of ${sessionId}`)
  }
  const recorder = async () => (await request('/api/meetings')).data.recorder
  const until = async (state, ms = 5000) => waitFor(async () => (await recorder()).state === state, ms, `recorder ${state}`)
  return { home, rt, fake, child, request, calls, popups, permission, recorder, until, get diagnostics() { return diagnostics } }
}

test('a deck recording quiets the chime but not the popup; after the stop nothing rings late, and a new session rings once', { timeout: 30_000 }, async t => {
  const h = await harness(t)
  const started = await h.request('/api/meetings/start', { method: 'POST', body: { tag: 'pessoal' } })
  assert.equal(started.status, 202, JSON.stringify(started.data))
  assert.equal(started.data.recorder.quiet, true)
  await h.permission('during-deck-recording')
  await sleep(1500)
  assert.equal(h.calls('pw-play').length, 0)

  assert.equal((await h.request('/api/meetings/stop', { method: 'POST' })).status, 202)
  await h.until('idle')
  // Several notification ticks (500 ms) and a poll after the recording ended: the request opened during it stays
  // silent.
  await sleep(POLL_MS + 1000)
  assert.equal(h.calls('pw-play').length, 0, 'a request opened during the recording rang when it ended')
  const open = (await h.request('/api/requests')).data.requests.filter(row => row.state === 'open')
  assert.equal(open.length, 1)

  await h.permission('after-the-recording')
  await waitFor(() => h.calls('pw-play').length > 0, 3000, 'the chime')
  await sleep(1500)
  assert.equal(h.calls('pw-play').length, 1)
  assert.equal(h.popups().length, 2)
})

test('a recording another client started quiets the chime within one poll, and nothing rings when it ends', { timeout: 30_000 }, async t => {
  const h = await harness(t)
  assert.equal((await h.recorder()).state, 'idle')
  const startedAt = Date.now()
  h.fake.setStatus({ recording: true, session_id: '2026-10-04T09-00-00', tag: 'pessoal', startedAt: Date.now() })
  await h.until('recording', POLL_MS + 1000)
  assert.ok(Date.now() - startedAt <= POLL_MS + 1000, `recording seen after ${Date.now() - startedAt} ms`)
  assert.equal(h.fake.received.some(entry => entry.parsed?.cmd === 'start'), false)
  await h.permission('during-other-recording')
  await sleep(1500)
  assert.equal(h.calls('pw-play').length, 0)

  h.fake.setStatus({ recording: false, session_id: null, tag: null })
  await h.until('idle', POLL_MS + 1000)
  await sleep(POLL_MS + 1000)
  assert.equal(h.calls('pw-play').length, 0, 'a request opened during the recording rang when it ended')
  await h.permission('after-other-recording')
  await waitFor(() => h.calls('pw-play').length > 0, 3000, 'the chime')
  await sleep(1000)
  assert.equal(h.calls('pw-play').length, 1)
})

test('with quietInMeetings false a request during a recording rings', { timeout: 30_000 }, async t => {
  const h = await harness(t)
  const patched = await h.request('/api/prefs', { method: 'PATCH', body: { quietInMeetings: false } })
  assert.equal(patched.status, 200, JSON.stringify(patched.data))
  const started = await h.request('/api/meetings/start', { method: 'POST', body: { tag: 'pessoal' } })
  assert.equal(started.status, 202, JSON.stringify(started.data))
  assert.equal(started.data.recorder.state, 'recording')
  assert.equal(started.data.recorder.quiet, false)
  await h.permission('loud-recording')
  await waitFor(() => h.calls('pw-play').length > 0, 3000, 'the chime')
  await sleep(1000)
  assert.equal(h.calls('pw-play').length, 1)
})
