// The answer routes over HTTP (docs/deck/05-api.md 2.4 and 4; M3 Task 16) against the real server, a real deckd
// (started in this process with an injected login environment, so no login shell runs) and the fake claude. Hooks
// the fake logs are fed to the server's ingestor with the PTY's id, as deck-hook would; the server's own wiring
// matches the screen to the requests. Scenario frames are the SYNTHETIC 2.1.285 frames of Task 10 (D-95).
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { startDeckServer } from '../../server/main.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const scriptsDir = path.resolve(here, '..', 'fixtures', 'scripts')
const VERSION = '2.1.285'
const token = 'a'.repeat(43)
// A test that needs a Safe request. The server classifies with the host platform, and on win32 the floor.platform
// reason makes every request at least Caution (server/approvals/tiers.mjs), so these skip there.
const safeTest = (name, fn) => test(name, { skip: process.platform === 'win32' && 'every request asks on Windows (floor.platform)' }, fn)

let rt
let deckd
let bin
let dir
let term
let logs = 0

before(async () => {
  rt = await makeRuntimeDir()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-'))
  bin = await fakeBin({ version: VERSION })
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const b64 = s => Buffer.from(s).toString('base64')

async function until(fn, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

function entries(log) {
  let text = ''
  try { text = fs.readFileSync(log, 'utf8') } catch {}
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}
const inputs = log => entries(log).filter(entry => typeof entry.input === 'string').map(entry => entry.input)

const CLEAR = { print: '\u001b[2J\u001b[H' }
const bashInput = (command, description) => ({ tool_name: 'Bash', tool_input: { command, description } })
const inline = steps => ({ version: VERSION, sessionId: 'auto', steps: [{ hook: 'SessionStart', with: { source: 'startup' } }, ...steps, { sleep: 600000 }] })
/** One Destructive Bash request drawn on the SYNTHETIC bash frame (D-95). */
const destructive = inline([
  { hook: 'PermissionRequest', variant: 'Bash', with: bashInput('rm -rf build', 'Remove the build directory') }, CLEAR,
  { frame: 'synthetic-permission-bash', vars: { cmd: 'rm -rf build', description: 'Remove the build directory' } },
  { expectKey: { 1: 'yes', 2: 'no', timeoutMs: 120000 } }
])

/** A deck server linked to the shared deckd, with a recording notifier and browser opener. */
async function server(t, options = {}) {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  // The environment the server gets; the token goes where the server reads it on this platform.
  const env = { HOME: home, XDG_RUNTIME_DIR: rt.dir, ...options.env }
  const { state, config } = setupPaths(env)
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(home, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  fs.mkdirSync(config, { recursive: true, mode: 0o700 })
  const popups = []
  const opened = []
  const openings = []
  let closed = 0
  const notifier = {
    async popup(spec) { popups.push(spec)
      return { ok: true, id: popups.length } },
    async dismiss() {}, async bell() {}, async testPing() { return { ok: true } }, close() { closed++ }
  }
  const deck = await startDeckServer({ port: 0, staticDir, runPollMs: 3_600_000,
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }), notifier, notificationTickMs: 100,
    scribedStatus: { start: async () => {}, stop() {}, snapshot: () => ({ state: 'unknown' }), isRecording: () => false },
    openBrowser: async (file, { env } = {}) => {
      opened.push(fs.readFileSync(file, 'utf8'))
      openings.push({ mode: fs.statSync(file).mode & 0o777, dirMode: fs.statSync(path.dirname(file)).mode & 0o777, env: { ...env } })
      return true }, ...options, env })
  t.after(() => deck.close())
  const published = []
  t.after(deck.subscribe(event => published.push(event)))
  const origin = () => `http://127.0.0.1:${deck.address().port}`
  const request = async (route, init = {}) => {
    const response = await fetch(origin() + route, { ...init, headers: { Authorization: `Bearer ${token}`, Origin: origin(), 'Content-Type': 'application/json', ...init.headers } })
    const text = await response.text()
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }
  const post = (route, body) => request(route, { method: 'POST', body: JSON.stringify(body) })
  return { deck, home, state, config, published, popups, opened, openings, origin, request, post, notifierClosed: () => closed }
}

/**
 * One fake claude spawned through deckd as `fm claude` would, running `script` (a fixture name or a script
 * object), with each hook it logs fed to the server. `ptyId: null` makes the hooks those of an observed session.
 */
async function spawn(t, h, script, { observed = false, files = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(dir, 'repo-'))
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'true' } }))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), content)
  const log = path.join(dir, `fake-${++logs}.jsonl`)
  let scriptFile = path.join(scriptsDir, `${script}.json`)
  if (typeof script === 'object') {
    scriptFile = path.join(dir, `script-${logs}.json`)
    fs.writeFileSync(scriptFile, JSON.stringify(script))
  }
  const reply = await term.request('spawn', { cwd, argv: ['claude'], cols: 120, rows: 40, origin: observed ? 'launched' : 'wrapped',
    env: { PATH: bin.env.PATH, HOME: h.home, FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_VERSION: VERSION, FAKE_CLAUDE_LOG: log } })
  const ptyId = reply.ptyId
  let fed = 0
  const pump = setInterval(() => {
    const hooks = entries(log).filter(entry => entry.hook)
    for (const entry of hooks.slice(fed)) {
      h.deck.ingest.receive(JSON.stringify({ v: 1, hookTs: entry.ts, ptyId: observed ? null : ptyId, claudePid: null, pidChain: [], truncated: false, hook: entry.payload }))
    }
    if (hooks.length > fed) h.deck.ingest.flush()
    fed = hooks.length
  }, 20)
  t.after(async () => {
    clearInterval(pump)
    try { await term.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 }) } catch {}
  })
  const row = id => h.deck.store.get('SELECT * FROM requests WHERE id = ?', id)
  /** The open request whose summary is `summary`, once its prompt is on screen (or just open). */
  const request = (summary, { onScreen = true } = {}) => until(() => {
    const found = h.deck.store.get("SELECT * FROM requests WHERE summary = ? AND state = 'open' ORDER BY created_at DESC", summary)
    return found && (!onScreen || found.screen_match === 'on_screen') ? found : null
  }, `request ${summary}${onScreen ? ' on screen' : ''}`)
  return { ptyId, log, cwd, row, request }
}

test('a Destructive answer without confirm is 409 confirm_required and the fake receives nothing; with it the allow lands', async t => {
  const h = await server(t)
  const s = await spawn(t, h, destructive)
  const rm = await s.request('rm -rf build')
  assert.equal(rm.tier, 'destructive')
  // The confirm label is filled from the entry's template and count after the request opened (07-approvals 8).
  const label = await until(() => s.row(rm.id).confirm_label, 'the confirm label')
  assert.equal(label, 'I checked the 1 paths that will be deleted')
  assert.ok(h.published.some(event => event.type === 'request.updated' && event.data.id === rm.id && event.data.confirmLabel === label), 'the label is published')
  const refused = await h.post(`/api/requests/${rm.id}/answer`, { choice: 'allow' })
  assert.equal(refused.status, 409)
  assert.equal(refused.data.error.code, 'confirm_required')
  assert.equal(refused.data.error.retryable, false)
  await sleep(200)
  assert.deepEqual(inputs(s.log), [])
  const allowed = await h.post(`/api/requests/${rm.id}/answer`, { choice: 'allow', confirm: true })
  assert.equal(allowed.status, 202)
  assert.equal(allowed.data.request.id, rm.id)
  await until(() => inputs(s.log).length === 1, 'the allow key')
  assert.deepEqual(inputs(s.log), ['1'])
})

safeTest('a batch holding a Destructive id is 409 batch_not_safe and answers none', async t => {
  const h = await server(t)
  const s = await spawn(t, h, 'prompt-swap')
  const safe = await s.request('npm run test', { onScreen: false })
  const rm = await s.request('rm -rf build')
  const response = await h.post('/api/requests/answer-batch', { ids: [safe.id, rm.id], choice: 'allow' })
  assert.equal(response.status, 409)
  assert.equal(response.data.error.code, 'batch_not_safe')
  assert.deepEqual(response.data.error.details.ids, [rm.id])
  await sleep(200)
  assert.deepEqual(inputs(s.log), [])
  assert.equal(s.row(safe.id).state, 'open')
  assert.equal(s.row(rm.id).state, 'open')
})

test('allow_always on a Caution request is 409 tier_forbids; the typing guard is 409 typing_in_terminal and retryable', async t => {
  const h = await server(t)
  const s = await spawn(t, h, 'did-not-land')
  const req = await s.request('node --test capture.test.mjs')
  assert.equal(req.tier, 'caution')
  const always = await h.post(`/api/requests/${req.id}/answer`, { choice: 'allow_always' })
  assert.equal(always.status, 409)
  assert.equal(always.data.error.code, 'tier_forbids')
  await term.request('write', { ptyId: s.ptyId, data: b64('x'), source: { kind: 'terminal', name: 'test-terminal' } })
  const typing = await h.post(`/api/requests/${req.id}/answer`, { choice: 'deny' })
  assert.equal(typing.status, 409)
  assert.equal(typing.data.error.code, 'typing_in_terminal')
  assert.equal(typing.data.error.retryable, true)
  await sleep(200)
  assert.deepEqual(inputs(s.log), ['x'], 'only the typed byte reached the fake')
})

test("an observed session's answer is 409 read_only_session", async t => {
  const h = await server(t)
  const s = await spawn(t, h, 'approve-safe', { observed: true })
  const req = await s.request('npm run test', { onScreen: false })
  const session = h.deck.store.get('SELECT * FROM sessions WHERE id = ?', req.session_id)
  assert.equal(session.origin, 'observed')
  const response = await h.post(`/api/requests/${req.id}/answer`, { choice: 'allow' })
  assert.equal(response.status, 409)
  assert.equal(response.data.error.code, 'read_only_session')
})

test('a popup allow action on a Destructive request answers nothing and opens the session (exit criterion 1)', async t => {
  // A deck token variable in the server's environment never reaches the opener.
  const h = await server(t, { env: { FLEETMATES_DECK_TOKEN: token } })
  const s = await spawn(t, h, destructive)
  const rm = await s.request('rm -rf build')
  const popup = await until(() => h.popups.find(spec => spec.onAction), 'the needs-you popup', 10000)
  assert.deepEqual(popup.actions, ['open'], 'a Destructive popup offers Open only')
  // The state directory was loosened after start: the bootstrap file holding the token must stay private anyway.
  fs.chmodSync(h.state, 0o755)
  // A forged allow click is still only an Open.
  popup.onAction('allow')
  await until(() => h.opened.length === 1, 'the browser opener')
  assert.match(h.opened[0], new RegExp(`#token=${token}&to=${encodeURIComponent(`/s/${rm.session_id}`)}`))
  const [opening] = h.openings
  // POSIX file modes; Windows has no mode bits to read back, so only the rest of this test runs there.
  if (process.platform !== 'win32') {
    assert.equal(opening.mode, 0o600, 'the bootstrap file is 0600')
    assert.equal(opening.dirMode, 0o700, 'its directory is 0700 again')
  }
  assert.deepEqual(Object.entries(opening.env).filter(([key, value]) => /TOKEN/i.test(key) || String(value).includes(token)), [], 'the opener env carries no deck token')
  await sleep(300)
  assert.deepEqual(inputs(s.log), [], 'no key reached the Destructive prompt')
  assert.equal(s.row(rm.id).state, 'open')
  assert.equal(h.deck.store.get("SELECT count(*) AS n FROM approval_audit WHERE request_id = ? AND kind <> 'refused'", rm.id).n, 0)
  // With a deck tab connected, Open navigates that tab instead.
  const ws = new WebSocket(`ws://127.0.0.1:${h.deck.address().port}/api/ws`, ['deck.v1', `deck.auth.${token}`], { headers: { Origin: h.origin() } })
  t.after(() => ws.close())
  await once(ws, 'open')
  popup.onAction('allow')
  await until(() => h.published.some(event => event.type === 'ui.navigate'), 'ui.navigate')
  assert.deepEqual(h.published.find(event => event.type === 'ui.navigate').data, { path: `/s/${rm.session_id}` })
  assert.equal(h.opened.length, 1, 'the browser is not opened again')
  assert.deepEqual(inputs(s.log), [])
  // Shutdown closes the notification machine, which closes the notifier (no popup child outlives the server).
  await h.deck.close()
  assert.equal(h.notifierClosed(), 1)
})

safeTest('a popup allow action on a Safe request answers it once through the deliverer, via popup', async t => {
  const h = await server(t)
  const s = await spawn(t, h, 'approve-safe')
  const req = await s.request('npm run test')
  const popup = await until(() => h.popups.find(spec => spec.onAction), 'the needs-you popup', 10000)
  assert.deepEqual(popup.actions, ['allow', 'open'])
  popup.onAction('allow')
  await until(() => s.row(req.id).state === 'answered', 'the popup answer')
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'popup', choice: 'allow' })
  assert.deepEqual(inputs(s.log), ['1'])
  assert.deepEqual(h.opened, [], 'an allow opens nothing')
})

safeTest('a tiers.json change raises an open request and is audited; a broken file is rejected and reported', async t => {
  const h = await server(t, { notifications: false })
  const s = await spawn(t, h, 'approve-safe')
  const req = await s.request('npm run test')
  assert.equal(req.tier, 'safe')
  const audits = kind => h.deck.store.get('SELECT count(*) AS n FROM approval_audit WHERE kind = ?', kind).n
  assert.equal(audits('tiers_loaded'), 1, 'the start is audited')
  fs.writeFileSync(path.join(h.config, 'tiers.json'), JSON.stringify({ version: 1, extends: 'default', disable: ['safe.npm.run-script'], entries: [] }))
  await until(() => s.row(req.id).tier === 'caution', 'the raised tier')
  assert.equal(s.row(req.id).rule_pattern, null)
  assert.ok(h.published.some(event => event.type === 'request.updated' && event.data.id === req.id && event.data.tier === 'caution'))
  await until(() => audits('tiers_loaded') === 2, 'the tiers_loaded row')
  fs.writeFileSync(path.join(h.config, 'tiers.json'), '{ "version": 1,\n  "entries": [ }')
  await until(() => audits('tiers_rejected') === 1, 'the tiers_rejected row')
  const rules = await h.request('/api/rules')
  assert.equal(typeof rules.data.tiersError.line, 'number')
  assert.match(rules.data.tiersError.message, /JSON/)
  assert.equal(s.row(req.id).tier, 'caution', 'the previous set stays in force')
})

safeTest('approve-safe through HTTP closes the request and publishes request.updated then request.closed; unknown keys are refused', async t => {
  const h = await server(t)
  const s = await spawn(t, h, 'approve-safe')
  const req = await s.request('npm run test')
  assert.equal(req.tier, 'safe')
  const unknown = await h.post(`/api/requests/${req.id}/answer`, { choice: 'allow', extra: true })
  assert.equal(unknown.status, 422)
  assert.equal(unknown.data.error.code, 'validation_failed')
  assert.deepEqual(unknown.data.error.details.fields, ['extra'])
  for (const [route, body] of [['/api/requests/answer-batch', { ids: [req.id], choice: 'allow', confirm: true }], [`/api/requests/${req.id}/followup`, { text: 'x', via: 'y' }]]) {
    const response = await h.post(route, body)
    assert.equal(response.status, 422, route)
    assert.equal(response.data.error.code, 'validation_failed', route)
  }
  assert.deepEqual(inputs(s.log), [])
  const answered = await h.post(`/api/requests/${req.id}/answer`, { choice: 'allow' })
  assert.equal(answered.status, 202)
  await until(() => s.row(req.id).state === 'answered', 'the request to close')
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'browser', choice: 'allow' })
  assert.deepEqual(inputs(s.log), ['1'])
  const mine = h.published.filter(event => ['request.updated', 'request.closed'].includes(event.type) && event.data?.id === req.id)
  const verifying = mine.findIndex(event => event.type === 'request.updated' && event.data.delivery === 'verifying')
  const closed = mine.findIndex(event => event.type === 'request.closed')
  assert.ok(verifying >= 0 && closed > verifying, `request.updated (verifying) then request.closed: ${mine.map(event => `${event.type}:${event.data.delivery}`).join(', ')}`)
  const response = await h.post(`/api/requests/${req.id}/answer`, { choice: 'allow' })
  assert.equal(response.status, 409)
  assert.equal(response.data.error.code, 'request_closed')
})

test('the server audits an expired request and a terminal answer the deliverer did not see, once each', async t => {
  const h = await server(t, { notifications: false })
  const s = await spawn(t, h, 'answered-in-terminal')
  const req = await s.request('npm run test')
  await term.request('write', { ptyId: s.ptyId, data: b64('1'), source: { kind: 'terminal', name: 'test-terminal' } })
  await until(() => s.row(req.id).state === 'answered', 'the terminal answer')
  const audits = () => h.deck.store.all('SELECT kind, via, choice FROM approval_audit WHERE request_id = ? ORDER BY id', req.id).map(row => ({ ...row }))
  await until(() => audits().length, 'the audit row')
  await sleep(300)
  assert.deepEqual(audits(), [{ kind: 'answered', via: 'terminal', choice: 'allow' }])
  const d = await spawn(t, h, destructive)
  const rm = await d.request('rm -rf build')
  await term.request('kill', { ptyId: d.ptyId, signal: 'SIGKILL', graceMs: 0 })
  await until(() => d.row(rm.id).state === 'expired', 'the request to expire')
  await until(() => h.deck.store.get("SELECT id FROM approval_audit WHERE request_id = ? AND kind = 'expired'", rm.id), 'the expired audit row')
  assert.equal(h.deck.store.get('SELECT count(*) AS n FROM approval_audit WHERE request_id = ?', rm.id).n, 1)
})

test('a deck deny the closing hook contradicts gets exactly one answered audit row, written once by the server or the deliverer', async t => {
  const h = await server(t, { notifications: false })
  const s = await spawn(t, h, 'did-not-land')
  const req = await s.request('node --test capture.test.mjs')
  const denied = await h.post(`/api/requests/${req.id}/answer`, { choice: 'deny' })
  assert.equal(denied.status, 202)
  assert.equal(s.row(req.id).delivery, 'verifying')
  // The tool ran anyway: a PostToolUse for the same input contradicts the deck's deny.
  const opened = entries(s.log).find(entry => entry.hook && entry.payload.hook_event_name === 'PermissionRequest').payload
  h.deck.ingest.receive(JSON.stringify({ v: 1, hookTs: Date.now(), ptyId: s.ptyId, claudePid: null, pidChain: [], truncated: false,
    hook: { ...opened, hook_event_name: 'PostToolUse', tool_response: { stdout: '', stderr: '' } } }))
  h.deck.ingest.flush()
  await until(() => s.row(req.id).state === 'answered', 'the hook to close the request')
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'terminal', choice: 'allow' })
  // Past the deliverer's proof poll, so both writers have had their turn.
  await sleep(800)
  const rows = h.deck.store.all("SELECT kind, via, choice FROM approval_audit WHERE request_id = ? AND kind = 'answered'", req.id).map(row => ({ ...row }))
  assert.deepEqual(rows, [{ kind: 'answered', via: 'terminal', choice: 'allow' }])
})

test('the follow-up after a deck deny reaches the fake over HTTP as one sanitized paste', async t => {
  const h = await server(t, { notifications: false })
  const s = await spawn(t, h, 'deny-then-instruct')
  const req = await s.request('npm run test')
  const denied = await h.post(`/api/requests/${req.id}/answer`, { choice: 'deny' })
  assert.equal(denied.status, 202)
  await until(() => s.row(req.id).state === 'answered', 'the deny to land')
  assert.deepEqual(inputs(s.log), ['3'])
  const text = 'use pnpm\x1b[201~\x1b[A\x03 instead'
  const sent = await until(async () => {
    const response = await h.post(`/api/requests/${req.id}/followup`, { text })
    if (response.status === 409 && response.data.error.code === 'followup_window_closed') return null
    return response
  }, 'the follow-up to be accepted')
  assert.equal(sent.status, 202)
  await until(() => entries(s.log).some(entry => entry.expectInput), 'the fake to take the paste')
  assert.equal(entries(s.log).find(entry => entry.expectInput).expectInput, '\x1b[200~use pnpm[A instead\x1b[201~\r')
})

safeTest('answer-batch refuses any choice but allow and answers nothing; with allow it returns one result per id', async t => {
  const h = await server(t, { notifications: false })
  const s = await spawn(t, h, 'approve-safe')
  const req = await s.request('npm run test')
  const deny = await h.post('/api/requests/answer-batch', { ids: [req.id], choice: 'deny' })
  assert.equal(deny.status, 422)
  assert.equal(deny.data.error.code, 'validation_failed')
  assert.deepEqual(deny.data.error.details.fields, ['choice'])
  await sleep(200)
  assert.deepEqual(inputs(s.log), [], 'a refused batch types nothing')
  assert.equal(s.row(req.id).state, 'open')
  const allowed = await h.post('/api/requests/answer-batch', { ids: [req.id], choice: 'allow' })
  assert.equal(allowed.status, 202)
  assert.deepEqual(allowed.data.results, [{ id: req.id, ok: true }])
  assert.deepEqual(inputs(s.log), ['1'])
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'batch', choice: 'allow' })
})

safeTest('a popup allow the deliverer refuses at click time opens the session instead (state-machines 2.7 row 6)', async t => {
  const h = await server(t)
  const s = await spawn(t, h, inline([
    { hook: 'PermissionRequest', variant: 'Bash', with: bashInput('cat notes.txt', 'Read the notes') }, CLEAR,
    { frame: 'synthetic-permission-bash', vars: { cmd: 'cat notes.txt', description: 'Read the notes' } },
    { expectKey: { 1: 'yes', 2: 'no', timeoutMs: 120000 } }
  ]), { files: { 'notes.txt': 'notes\n' } })
  const req = await s.request('cat notes.txt')
  assert.equal(req.tier, 'safe')
  const popup = await until(() => h.popups.find(spec => spec.onAction), 'the needs-you popup', 10000)
  assert.deepEqual(popup.actions, ['allow', 'open'])
  // The path operand became a symlink after the request opened: re-classified at click time, it is Caution (D-88).
  fs.rmSync(path.join(s.cwd, 'notes.txt'))
  fs.symlinkSync(path.join(s.cwd, 'package.json'), path.join(s.cwd, 'notes.txt'))
  popup.onAction('allow')
  await until(() => h.opened.length === 1, 'the session to open')
  assert.match(h.opened[0], new RegExp(`&to=${encodeURIComponent(`/s/${req.session_id}`)}`))
  assert.deepEqual(inputs(s.log), [])
  assert.equal(s.row(req.id).tier, 'caution')
  assert.equal(s.row(req.id).state, 'open')
})
