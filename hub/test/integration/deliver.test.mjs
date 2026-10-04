// Answer delivery against a real deckd (started in this process with an injected login environment, so
// no login shell runs), the fake claude and a real store (docs/deck/07-approvals.md 5,
// docs/deck/interaction/state-machines.md 2.5 to 2.7, docs/deck/09-testing.md 3.5). Hooks the fake
// fires are read from its log and fed to the projector with the PTY's id, as deck-hook would; parsed
// screens are written to the requests with request-updates `applyScreen`, as the server wiring does.
//
// SYNTHETIC frames (D-95): the captured 2.1.285 permission-2 box prints a fixed Caution command and
// only "1. Yes / 2. No", so Safe scenarios draw synthetic-permission-bash (permission-2 with the box
// rows as {{cmd}} and {{description}}), and the allow-always scenario draws
// synthetic-permission-always, whose option 2 reads "Yes, and don't ask again for npm run test".
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startDeckd } from '../../deckd/main.mjs'
import { connectDeckd } from '../../deckd/client.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector } from '../../server/machines/projector.mjs'
import { createDeckdLink } from '../../server/pty/link.mjs'
import { createDeliverer } from '../../server/approvals/deliver.mjs'
import { applyScreen } from '../../server/approvals/request-updates.mjs'
import { DEFAULT_TIERS, setActiveTiers } from '../../server/approvals/tiers.mjs'
import { effectiveTiers } from '../../server/approvals/tiers-store.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const scriptsDir = path.resolve(here, '..', 'fixtures', 'scripts')
const VERSION = '2.1.285'

let rt
let deckd
let bin
let dir
let term
let logs = 0

before(async () => {
  rt = await makeRuntimeDir()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-'))
  bin = await fakeBin({ version: VERSION })
  deckd = await startDeckd({ runtimeDir: rt.dir, version: '9.9.9', loginEnv: { PATH: bin.env.PATH, HOME: dir } })
  term = await connectDeckd({ runtimeDir: rt.dir, kind: 'terminal', name: 'test-terminal' })
})

after(async () => {
  term?.close()
  await deckd?.close()
  await bin?.cleanup()
  await rt?.cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
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

/** The fake's log entries. */
function entries(log) {
  let text = ''
  try { text = fs.readFileSync(log, 'utf8') } catch {}
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}
const inputs = log => entries(log).filter(entry => typeof entry.input === 'string').map(entry => entry.input)

/**
 * A server side (store, projector, deckd link, deliverer) and one fake claude spawned through deckd as
 * `fm claude` would, running the scenario `script`. `connect` wraps the deckd connection (to fake an
 * older deckd).
 */
async function scenario(t, script, { connect = connectDeckd, deliver = {} } = {}) {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const store = openDeckDb(path.join(home, 'state', 'deck.db'))
  const published = []
  const publish = event => published.push(event)
  const projector = createProjector({ store, publish })
  const link = createDeckdLink({ env: { XDG_RUNTIME_DIR: rt.dir }, connectDeckd: connect, store, projector, publish })
  await link.start()
  // The last parsed screen per session is applied again after hooks open requests, because the frame
  // usually reaches the server before the PermissionRequest hook that opens its request.
  const lastPrompt = new Map()
  const offScreen = link.onParsed(event => {
    if (!event.sessionId) return
    lastPrompt.set(event.sessionId, event.parsed.prompt)
    applyScreen(store, event.sessionId, event.parsed.prompt, Date.now())
  })
  const deliverer = createDeliverer({ store, link, publish, ...deliver })
  const cwd = fs.mkdtempSync(path.join(dir, 'repo-'))
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'true' } }))
  const log = path.join(dir, `fake-${++logs}.jsonl`)
  const reply = await term.request('spawn', { cwd, argv: ['claude'], cols: 120, rows: 40, origin: 'wrapped',
    env: { PATH: bin.env.PATH, HOME: home, FAKE_CLAUDE_SCRIPT: path.join(scriptsDir, `${script}.json`), FAKE_CLAUDE_VERSION: VERSION, FAKE_CLAUDE_LOG: log } })
  const ptyId = reply.ptyId
  // Hook pump: each hook the fake logs goes to the projector with the PTY's id.
  let fed = 0
  let paused = false
  const pump = setInterval(() => {
    if (paused) return
    const hooks = entries(log).filter(entry => entry.hook)
    for (const entry of hooks.slice(fed)) projector.applyHooks([{ hook: entry.payload, hookTs: entry.ts, receivedAt: Date.now(), ptyId, claudePid: null, via: 'socket' }])
    if (hooks.length > fed) {
      const sessionId = store.get('SELECT id FROM sessions WHERE pty_id = ?', ptyId)?.id
      if (sessionId && lastPrompt.has(sessionId)) applyScreen(store, sessionId, lastPrompt.get(sessionId), Date.now())
    }
    fed = hooks.length
  }, 20)
  t.after(async () => {
    clearInterval(pump)
    deliverer.close()
    offScreen()
    try { await term.request('kill', { ptyId, signal: 'SIGKILL', graceMs: 0 }) } catch {}
    link.close()
    store.close()
  })
  const session = await until(() => store.get('SELECT * FROM sessions WHERE pty_id = ?', ptyId), 'the session row')
  /** The open request whose summary is `summary`, once its prompt is on screen (or just open). */
  const request = (summary, { onScreen = true } = {}) => until(() => {
    const row = store.get("SELECT * FROM requests WHERE session_id = ? AND summary = ? AND state = 'open'", session.id, summary)
    return row && (!onScreen || row.screen_match === 'on_screen') ? row : null
  }, `request ${summary}${onScreen ? ' on screen' : ''}`)
  const row = id => store.get('SELECT * FROM requests WHERE id = ?', id)
  const audits = id => store.all('SELECT * FROM approval_audit WHERE request_id = ? ORDER BY id', id)
  /** Stop feeding hooks, so only the screen can prove an answer. */
  const pauseHooks = () => { paused = true }
  return { store, link, deliverer, ptyId, log, session, request, row, audits, published, cwd, pauseHooks }
}

async function refused(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code)
    return true
  })
}

test('approve-safe: allow answers 1 and the request closes answered via browser within 3 s', async t => {
  const s = await scenario(t, 'approve-safe')
  const req = await s.request('npm run test')
  assert.equal(req.tier, 'safe')
  const started = Date.now()
  const { request, outcome } = await s.deliverer.answer(req.id, { choice: 'allow' })
  assert.equal(request.delivery, 'verifying')
  assert.equal(await outcome, 'answered')
  assert.ok(Date.now() - started < 3000, 'proved within the verify timeout')
  const closed = s.row(req.id)
  assert.equal(closed.state, 'answered')
  assert.deepEqual(JSON.parse(closed.answer), { via: 'browser', choice: 'allow' })
  assert.deepEqual(inputs(s.log), ['1'])
  assert.ok(s.published.some(event => event.type === 'request.updated' && event.data.id === req.id && event.data.delivery === 'verifying'))
  assert.ok(s.published.some(event => event.type === 'request.closed' && event.data.id === req.id))
  // A Safe allow from the deck counts toward "Make it a rule?" (D-73).
  assert.equal(s.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
  const [audit] = s.audits(req.id)
  assert.equal(audit.kind, 'answered')
  assert.equal(audit.via, 'browser')
  assert.equal(audit.choice, 'allow')
  assert.equal(audit.option_label, 'Yes')
  // The PostToolUse that follows finds the request closed and does not count it again.
  await until(() => entries(s.log).some(entry => entry.hook === 'PostToolUse'), 'PostToolUse')
  await sleep(200)
  assert.equal(s.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
})

test('approve-always (SYNTHETIC frame, D-95): option 2 lands only when allowAlways holds, else tier_forbids', async t => {
  // Not offered: a Caution request on the captured permission-2 frame, whose option 2 is "No".
  const caution = await scenario(t, 'did-not-land')
  const creq = await caution.request('node --test capture.test.mjs')
  assert.equal(creq.tier, 'caution')
  await refused(caution.deliverer.answer(creq.id, { choice: 'allow_always' }), 'tier_forbids')
  await sleep(100)
  assert.deepEqual(inputs(caution.log), [], 'no key reached the fake')
  assert.equal(caution.audits(creq.id).at(-1).choice, 'tier_forbids')

  const s = await scenario(t, 'approve-always')
  const req = await s.request('npm run test')
  await until(() => s.row(req.id).options.includes("don't ask again"), 'the stored options')
  // No hook reaches the server from here, so the prompt leaving the screen is the only proof.
  s.pauseHooks()
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'allow_always' })
  assert.equal(await outcome, 'answered')
  await until(() => entries(s.log).some(entry => entry.hook === 'PostToolUse'), 'the fake to fire PostToolUse')
  assert.equal(s.store.get("SELECT count(*) AS n FROM hook_events WHERE event = 'PostToolUse'").n, 0, 'the hook was not applied')
  assert.deepEqual(inputs(s.log), ['2'])
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'browser', choice: 'allow_always' })
})

test('deny-then-instruct: deny lands 3, then the follow-up text reaches the fake with no control byte', async t => {
  const s = await scenario(t, 'deny-then-instruct')
  const req = await s.request('npm run test')
  await refused(s.deliverer.followup(req.id, 'too early'), 'followup_window_closed')
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'deny' })
  assert.equal(await outcome, 'answered')
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'browser', choice: 'deny' })
  assert.deepEqual(inputs(s.log), ['3'])
  // The idle input box shows once the fake drew it.
  const text = 'use pnpm\x1b[201~\x1b[A\x03 instead\r\n\tplease\x9b1~'
  await until(async () => {
    try { await s.deliverer.followup(req.id, text); return true } catch (error) {
      if (error.code === 'followup_window_closed') return false
      throw error
    }
  }, 'the follow-up to be accepted')
  await until(() => entries(s.log).some(entry => entry.expectInput), 'the fake to take the paste')
  const pasted = entries(s.log).find(entry => entry.expectInput).expectInput
  assert.equal(pasted, '\x1b[200~use pnpm[A instead\n\tplease1~\x1b[201~\r')
  const inner = pasted.slice('\x1b[200~'.length, -'\x1b[201~\r'.length)
  assert.doesNotMatch(inner, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  // One follow-up per deny.
  await refused(s.deliverer.followup(req.id, 'again'), 'followup_window_closed')
})

test('did-not-land: no proof in 3 s gives did_not_land, the deck does not retry, and a late hook still answers', async t => {
  const s = await scenario(t, 'did-not-land')
  const req = await s.request('node --test capture.test.mjs')
  const started = Date.now()
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'allow' })
  assert.equal(await outcome, 'did_not_land')
  assert.ok(Date.now() - started >= 2900, 'waited for the verify timeout')
  assert.equal(s.row(req.id).delivery, 'did_not_land')
  assert.equal(s.row(req.id).state, 'open')
  assert.equal(s.audits(req.id).at(-1).kind, 'did_not_land')
  await sleep(1500)
  assert.deepEqual(inputs(s.log), ['1'], 'exactly one key, no retry')
  // Late proof (state-machines 2.7 row 15): the matching hook closes it with the deck's via.
  const fixture = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'fixtures', 'hooks', VERSION, 'PostToolUse.Bash.json'), 'utf8'))
  const projector = createProjector({ store: s.store })
  const { sessionId } = entries(s.log).find(entry => entry.ready)
  projector.applyHooks([{ hook: { ...fixture, session_id: sessionId, cwd: s.cwd }, hookTs: Date.now(), receivedAt: Date.now(), ptyId: s.ptyId, claudePid: null, via: 'socket' }])
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'browser', choice: 'allow' })
  await until(() => s.audits(req.id).at(-1).kind === 'answered', 'the late answer audit')
})

test('answered-in-terminal: the terminal answer closes the request and a later browser answer gets request_closed', async t => {
  const s = await scenario(t, 'answered-in-terminal')
  const req = await s.request('npm run test')
  await term.request('write', { ptyId: s.ptyId, data: b64('1'), source: { kind: 'terminal', name: 'test-terminal' } })
  await until(() => s.row(req.id).state === 'answered', 'the hook to close the request')
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'terminal', choice: 'allow' })
  await refused(s.deliverer.answer(req.id, { choice: 'allow' }), 'request_closed')
  assert.deepEqual(inputs(s.log), ['1'])
})

test('typing guard (D-84): terminal or Focus input 300 ms before the answer gives typing_in_terminal and no key', async t => {
  for (const source of [{ kind: 'terminal', name: 'test-terminal' }, { kind: 'browser', name: 'focus' }]) {
    const s = await scenario(t, 'approve-safe')
    const req = await s.request('npm run test')
    await term.request('write', { ptyId: s.ptyId, data: b64('x'), source })
    await sleep(300)
    await refused(s.deliverer.answer(req.id, { choice: 'allow' }), 'typing_in_terminal')
    await sleep(200)
    assert.deepEqual(inputs(s.log), ['x'], `${source.kind}: only the typed byte reached the fake`)
    assert.equal(s.row(req.id).delivery, 'idle')
    assert.equal(s.row(req.id).state, 'open')
  }
})

test('prompt-swap: a Safe answer is refused not_on_screen when a Destructive prompt replaced it; Destructive needs confirm', async t => {
  const s = await scenario(t, 'prompt-swap')
  const safe = await s.request('npm run test', { onScreen: false })
  const rm = await s.request('rm -rf build')
  assert.equal(rm.tier, 'destructive')
  // As a screen event that arrived before the swap would leave it: the stored match says on_screen.
  s.store.run("UPDATE requests SET screen_match = 'on_screen' WHERE id = ?", safe.id)
  await refused(s.deliverer.answer(safe.id, { choice: 'allow' }), 'not_on_screen')
  await sleep(200)
  assert.deepEqual(inputs(s.log), [], 'the Destructive prompt received no key')
  // A batch holding a Destructive id is refused whole.
  await assert.rejects(s.deliverer.batch([safe.id, rm.id]), error => {
    assert.equal(error.code, 'batch_not_safe')
    assert.deepEqual(error.details.ids, [rm.id])
    return true
  })
  await refused(s.deliverer.answer(rm.id, { choice: 'allow' }, { via: 'popup' }), 'tier_forbids')
  await refused(s.deliverer.answer(rm.id, { choice: 'allow' }), 'confirm_required')
  assert.deepEqual(inputs(s.log), [])
  // Exit criterion 1: with the box ticked the Destructive allow lands.
  const { outcome } = await s.deliverer.answer(rm.id, { choice: 'allow', confirm: true })
  assert.equal(await outcome, 'answered')
  assert.deepEqual(inputs(s.log), ['1'])
  const audit = s.audits(rm.id).at(-1)
  assert.equal(audit.kind, 'answered')
  assert.equal(audit.confirm_label, 'I checked what this command will change')
})

test('a popup answer on a Caution request gets tier_forbids', async t => {
  const s = await scenario(t, 'did-not-land')
  const req = await s.request('node --test capture.test.mjs')
  await refused(s.deliverer.answer(req.id, { choice: 'allow' }, { via: 'popup' }), 'tier_forbids')
  await refused(s.deliverer.batch([req.id]), 'batch_not_safe')
  await sleep(100)
  assert.deepEqual(inputs(s.log), [])
})

test('subagents-parallel: a Safe batch of two prompts of one session answers them in turn (F12)', async t => {
  const s = await scenario(t, 'subagents-parallel')
  const first = await s.request('npm run test')
  const second = await s.request('npm run lint', { onScreen: false })
  assert.equal(s.row(second.id).screen_match, 'queued')
  const results = await s.deliverer.batch([first.id, second.id])
  assert.deepEqual(results, [{ id: first.id, ok: true }, { id: second.id, ok: true }])
  assert.deepEqual(inputs(s.log), ['1', '1'])
  assert.equal(JSON.parse(s.row(second.id).answer).via, 'batch')
})

test('a Safe answer after the user tiers file raised the command to Caution follows the Caution rules', async t => {
  const s = await scenario(t, 'approve-safe')
  const req = await s.request('npm run test')
  assert.equal(req.tier, 'safe')
  setActiveTiers(() => effectiveTiers(DEFAULT_TIERS, { disable: ['safe.npm.run-script'] }))
  t.after(() => setActiveTiers(null))
  await refused(s.deliverer.answer(req.id, { choice: 'allow' }, { via: 'popup' }), 'tier_forbids')
  assert.equal(s.row(req.id).tier, 'caution')
  assert.equal(s.row(req.id).rule_pattern, null)
  assert.deepEqual(inputs(s.log), [])
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'allow' })
  assert.equal(await outcome, 'answered')
  assert.equal(s.store.get('SELECT count(*) AS n FROM rule_counters').n, 0, 'a Caution allow is not counted')
})

test('question-options: an option and a free-text reply are typed from the parsed keys', async t => {
  const s = await scenario(t, 'question-options')
  const question = await until(() => s.store.get("SELECT * FROM requests WHERE kind = 'question' AND state = 'open' AND screen_match = 'on_screen'"), 'the question on screen')
  await refused(s.deliverer.answer(question.id, { choice: 'allow' }), 'validation_failed')
  const { outcome } = await s.deliverer.answer(question.id, { choice: 'reply', text: 'neither\x1b[201~' })
  assert.equal(await outcome, 'answered')
  assert.deepEqual(inputs(s.log).join(''), '3\x1b[200~neither\x1b[201~\r')
  assert.deepEqual(JSON.parse(s.row(question.id).answer), { via: 'browser', choice: 'reply' })
})

test('a deckd without guardedWrite gives deckd_outdated', async t => {
  const s = await scenario(t, 'approve-safe', { connect: options => connectDeckd({ ...options, proto: 1 }) })
  const req = await s.request('npm run test')
  assert.deepEqual(s.link.features, [])
  await refused(s.deliverer.answer(req.id, { choice: 'allow' }), 'deckd_outdated')
  await sleep(100)
  assert.deepEqual(inputs(s.log), [])
})
