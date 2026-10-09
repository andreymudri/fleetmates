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
import { answerKeys, createDeliverer, sanitizePaste } from '../../server/approvals/deliver.mjs'
import { ScreenModel } from '../../deckd/screen-model.mjs'
import { ensureRepo } from '../../server/adapters/repos.mjs'
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
  // Retried: the Windows VM run could not remove a directory a just-killed child still held.
  const rmRetry = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }
  for (const d of [bin?.binDir, rt?.dir, dir]) if (d) fs.rmSync(d, rmRetry)
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
 * `fm claude` would, running the scenario `script` (a fixture name, or a script object written to a
 * temporary file). `connect` wraps the deckd connection (to fake an older deckd), `wrapLink` wraps the
 * link the deliverer gets, and `claudePid` is stamped on every hook envelope.
 */
async function scenario(t, script, { connect = connectDeckd, deliver = {}, wrapLink = link => link, claudePid = null } = {}) {
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
  const deliverer = createDeliverer({ store, link: wrapLink(link), publish, ...deliver })
  const cwd = fs.mkdtempSync(path.join(dir, 'repo-'))
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'true' } }))
  const log = path.join(dir, `fake-${++logs}.jsonl`)
  let scriptFile = path.join(scriptsDir, `${script}.json`)
  if (typeof script === 'object') {
    scriptFile = path.join(dir, `script-${logs}.json`)
    fs.writeFileSync(scriptFile, JSON.stringify(script))
  }
  const reply = await term.request('spawn', { cwd, argv: ['claude'], cols: 120, rows: 40, origin: 'wrapped',
    env: { PATH: bin.env.PATH, HOME: home, FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_VERSION: VERSION, FAKE_CLAUDE_LOG: log } })
  const ptyId = reply.ptyId
  // Hook pump: each hook the fake logs goes to the projector with the PTY's id.
  let fed = 0
  let paused = false
  const pump = setInterval(() => {
    if (paused) return
    const hooks = entries(log).filter(entry => entry.hook)
    for (const entry of hooks.slice(fed)) projector.applyHooks([{ hook: entry.payload, hookTs: entry.ts, receivedAt: Date.now(), ptyId, claudePid, via: 'socket' }])
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
  /** Feed the hooks held since `pauseHooks`. */
  const resumeHooks = () => { paused = false }
  return { store, link, deliverer, ptyId, log, session, request, row, audits, published, cwd, pauseHooks, resumeHooks }
}

/**
 * The link as the deliverer sees it, with `writeGuarded` and `onParsed` replaced where given.
 * `lossy` resolves every write without sending it, so an answer never lands.
 */
function linkWith(link, { writeGuarded, onParsed } = {}) {
  return {
    get connected() { return link.connected },
    get features() { return link.features },
    request: (...args) => link.request(...args),
    writeGuarded: writeGuarded ?? ((...args) => link.writeGuarded(...args)),
    onParsed: onParsed ?? (fn => link.onParsed(fn))
  }
}
const lossy = link => linkWith(link, { writeGuarded: async () => ({ at: Date.now() }) })

/** A PostToolUse for the captured Bash command, applied as the session's own hook. */
function captureHook(s, event = 'PostToolUse') {
  const fixture = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'fixtures', 'hooks', VERSION, 'PostToolUse.Bash.json'), 'utf8'))
  const { sessionId } = entries(s.log).find(entry => entry.ready)
  const hook = { ...fixture, hook_event_name: event, session_id: sessionId, cwd: s.cwd }
  createProjector({ store: s.store }).applyHooks([{ hook, hookTs: Date.now(), receivedAt: Date.now(), ptyId: s.ptyId, claudePid: null, via: 'socket' }])
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
  // The fake's PostToolUse reports the free text "a typed reply", so the deck types that text.
  const { outcome } = await s.deliverer.answer(question.id, { choice: 'reply', text: 'a typed reply\x1b[201~' })
  assert.equal(await outcome, 'answered')
  assert.deepEqual(inputs(s.log).join(''), '3\x1b[200~a typed reply\x1b[201~\r')
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

// Inline scripts for cases no fixture script draws. They use the same frames and payloads.
const CLEAR = { print: '\u001b[2J\u001b[H' }
const bashInput = (command, description) => ({ tool_name: 'Bash', tool_input: { command, description } })
const inline = steps => ({ version: VERSION, sessionId: 'auto', steps: [{ hook: 'SessionStart', with: { source: 'startup' } }, ...steps, { sleep: 600000 }] })

test('option on a permission resolves to allow, deny or allow-always and follows their checks', async t => {
  // A Caution request on the SYNTHETIC always frame (D-95): option 2 would save a Claude Code rule.
  const s = await scenario(t, 'approve-always')
  const req = await s.request('npm run test')
  setActiveTiers(() => effectiveTiers(DEFAULT_TIERS, { disable: ['safe.npm.run-script'] }))
  t.after(() => setActiveTiers(null))
  await refused(s.deliverer.answer(req.id, { choice: 'option', optionKey: '2' }), 'tier_forbids')
  assert.equal(s.row(req.id).tier, 'caution')
  await refused(s.deliverer.answer(req.id, { choice: 'option', optionKey: '2' }, { via: 'popup' }), 'tier_forbids')
  await sleep(100)
  assert.deepEqual(inputs(s.log), [], 'option 2 never reached the PTY')
  // Option 3 is the "No" option: a deny.
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'option', optionKey: '3' })
  assert.equal(await outcome, 'answered')
  assert.deepEqual(inputs(s.log), ['3'])
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'browser', choice: 'deny' })

  // A Destructive request on the same SYNTHETIC frame: option 2 is refused even with the box ticked,
  // option 1 needs confirm like allow, option 3 is a deny that needs none.
  const d = await scenario(t, inline([
    { hook: 'PermissionRequest', variant: 'Bash', with: bashInput('rm -rf build', 'Remove the build directory') }, CLEAR,
    { frame: 'synthetic-permission-always', vars: { cmd: 'rm -rf build', description: 'Remove the build directory' } },
    { expectKey: { 1: 'yes', 2: 'always', 3: 'no', timeoutMs: 120000 } }
  ]))
  const rm = await d.request('rm -rf build')
  assert.equal(rm.tier, 'destructive')
  await refused(d.deliverer.answer(rm.id, { choice: 'option', optionKey: '2', confirm: true }), 'tier_forbids')
  await refused(d.deliverer.answer(rm.id, { choice: 'option', optionKey: '1' }), 'confirm_required')
  await sleep(100)
  assert.deepEqual(inputs(d.log), [])
  const denied = await d.deliverer.answer(rm.id, { choice: 'option', optionKey: '3' })
  assert.equal(await denied.outcome, 'did_not_land', 'the inline script draws nothing after the key')
  assert.deepEqual(inputs(d.log), ['3'])
})

test('answerKeys refuses a permission option that is neither Yes, No nor an offered allow-always', () => {
  const row = { kind: 'permission', tool_name: 'Edit', tier: 'safe', detail: '{}', source: 'permission_request' }
  const prompt = { kind: 'permission', question: 'Do you want to make this edit?', title: 'Edit file', body: '', truncated: false,
    options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'Yes, allow all edits during this session (shift+tab)' }, { key: '3', label: 'No' }] }
  assert.throws(() => answerKeys(row, { choice: 'option', optionKey: '2' }, prompt), error => error.code === 'tier_forbids')
  assert.deepEqual(answerKeys(row, { choice: 'option', optionKey: '1' }, prompt), { data: '1', label: 'Yes', choice: 'allow' })
  assert.deepEqual(answerKeys(row, { choice: 'option', optionKey: '3' }, prompt), { data: '3', label: 'No', choice: 'deny' })
})

test('an AskUserQuestion with several questions or a multi-select question gets options_unreadable', async t => {
  const script = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'question-options.json'), 'utf8'))
  const two = { questions: [
    { question: 'Pick A or B?', header: 'Choice', options: [{ label: 'A', description: 'Option A' }, { label: 'B', description: 'Option B' }], multiSelect: false },
    { question: 'Second question?', header: 'More', options: [{ label: 'C', description: 'Option C' }, { label: 'D', description: 'Option D' }], multiSelect: false }] }
  const multi = { questions: [{ ...two.questions[0], multiSelect: true }] }
  for (const toolInput of [two, multi]) {
    const steps = script.steps.map(step => ['PreToolUse', 'PermissionRequest'].includes(step.hook) ? { ...step, with: { tool_name: 'AskUserQuestion', tool_input: toolInput } } : step)
    const s = await scenario(t, { ...script, steps })
    const question = await until(() => s.store.get("SELECT * FROM requests WHERE kind = 'question' AND state = 'open' AND screen_match = 'on_screen'"), 'the question on screen')
    await refused(s.deliverer.answer(question.id, { choice: 'option', optionKey: '1' }), 'options_unreadable')
    await refused(s.deliverer.answer(question.id, { choice: 'reply', text: 'neither' }), 'options_unreadable')
    await sleep(100)
    assert.deepEqual(inputs(s.log), [])
  }
})

test('the closing hook wins over the deck choice: a terminal allow after a deck deny, a terminal deny after a deck allow', async t => {
  // The deck's keys are lost, so each answer is did_not_land; then the owner answers in the terminal.
  const a = await scenario(t, 'approve-safe', { wrapLink: lossy, claudePid: 4242 })
  const reqA = await a.request('npm run test')
  const sentA = await a.deliverer.answer(reqA.id, { choice: 'deny' })
  assert.equal(await sentA.outcome, 'did_not_land')
  await term.request('write', { ptyId: a.ptyId, data: b64('1'), source: { kind: 'terminal', name: 'test-terminal' } })
  await until(() => a.row(reqA.id).state === 'answered', 'the PostToolUse to close it')
  assert.deepEqual(JSON.parse(a.row(reqA.id).answer), { via: 'terminal', choice: 'allow' })
  // A terminal Safe allow from the same Claude process takes the terminal count (D-73, F16).
  assert.equal(a.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
  await until(() => a.audits(reqA.id).at(-1).kind === 'answered', 'the answered audit')
  assert.deepEqual([a.audits(reqA.id).at(-1).via, a.audits(reqA.id).at(-1).choice], ['terminal', 'allow'])
  await refused(a.deliverer.followup(reqA.id, 'use pnpm'), 'followup_window_closed')

  const b = await scenario(t, 'approve-safe', { wrapLink: lossy, claudePid: 4242 })
  const reqB = await b.request('npm run test')
  const sentB = await b.deliverer.answer(reqB.id, { choice: 'allow' })
  assert.equal(await sentB.outcome, 'did_not_land')
  await term.request('write', { ptyId: b.ptyId, data: b64('2'), source: { kind: 'terminal', name: 'test-terminal' } })
  await until(() => b.row(reqB.id).state === 'answered', 'the PermissionDenied to close it')
  assert.deepEqual(JSON.parse(b.row(reqB.id).answer), { via: 'terminal', choice: 'deny' })
  assert.equal(b.store.get('SELECT count(*) AS n FROM rule_counters').n, 0)
  await until(() => b.audits(reqB.id).at(-1).kind === 'answered', 'the answered audit')
  assert.deepEqual([b.audits(reqB.id).at(-1).via, b.audits(reqB.id).at(-1).choice], ['terminal', 'deny'])
})

test('after the late watch ends, a closing hook is a terminal answer', async t => {
  const s = await scenario(t, 'did-not-land', { deliver: { lateMs: 200 } })
  const req = await s.request('node --test capture.test.mjs')
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'allow' })
  assert.equal(await outcome, 'did_not_land')
  await sleep(600)
  captureHook(s)
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'terminal', choice: 'allow' })
})

test('a screen change after did_not_land is not proof of the deck answer', async t => {
  const s = await scenario(t, 'approve-safe', { wrapLink: lossy, deliver: { verifyMs: 300 } })
  const req = await s.request('npm run test')
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'allow' })
  assert.equal(await outcome, 'did_not_land')
  s.pauseHooks()
  // The owner denies in the terminal; the prompt leaves the screen.
  await term.request('write', { ptyId: s.ptyId, data: b64('2'), source: { kind: 'terminal', name: 'test-terminal' } })
  await until(() => entries(s.log).some(entry => entry.hook === 'PermissionDenied'), 'the fake to deny')
  await sleep(1500)
  assert.notEqual(s.row(req.id).state, 'answered')
  assert.equal(s.store.get('SELECT count(*) AS n FROM rule_counters').n, 0)
  assert.deepEqual(s.audits(req.id).map(row => row.kind), ['did_not_land'])
})

test('a follow-up is refused when the screen after the deny is a new prompt, not the idle input box', async t => {
  const s = await scenario(t, 'approve-always')
  const req = await s.request('npm run test')
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'deny' })
  assert.equal(await outcome, 'answered')
  await s.request('npm run lint')
  await refused(s.deliverer.followup(req.id, 'use pnpm'), 'followup_window_closed')
  await sleep(200)
  assert.deepEqual(inputs(s.log), ['3'], 'no paste reached the new prompt')
})

test('a deck allow its own hook proves is counted once with a real Claude pid', async t => {
  const s = await scenario(t, 'approve-safe', { claudePid: 4242, wrapLink: link => linkWith(link, { onParsed: () => () => {} }) })
  const req = await s.request('npm run test')
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'allow' })
  assert.equal(await outcome, 'answered')
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'browser', choice: 'allow' })
  await sleep(200)
  assert.equal(s.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
})

test('a batch id that re-classifies above Safe is skipped_not_safe', async t => {
  const s = await scenario(t, 'approve-safe')
  const req = await s.request('npm run test')
  setActiveTiers(() => effectiveTiers(DEFAULT_TIERS, { disable: ['safe.npm.run-script'] }))
  t.after(() => setActiveTiers(null))
  assert.deepEqual(await s.deliverer.batch([req.id]), [{ id: req.id, ok: false, error: 'skipped_not_safe' }])
  assert.equal(s.audits(req.id).at(-1).choice, 'skipped_not_safe')
  await sleep(100)
  assert.deepEqual(inputs(s.log), [])
})

test('sanitizePaste removes a paste end marker that removing another one rebuilds', () => {
  assert.equal(sanitizePaste('a\x1b[20\x1b[201~1~b'), 'ab')
})

/** Rows and cursor of a captured frame, rendered at the capture size. */
async function rendered(name) {
  const model = new ScreenModel({ cols: 120, rows: 40 })
  try {
    model.write(fs.readFileSync(path.resolve(here, '..', 'fixtures', 'screens', VERSION, `${name}.ansi`)))
    await model.flush()
    return { lines: model.lines(), cursor: model.cursor() }
  } finally { model.dispose() }
}

test('a stop_question reply is typed only into the idle input box and its UserPromptSubmit proves it', async t => {
  // Unit level: a stop_question comes from the transcript, which the fake does not write, so the link is
  // a stub that serves captured frames and records writes.
  const home = fs.mkdtempSync(path.join(dir, 'stop-'))
  const store = openDeckDb(path.join(home, 'deck.db'))
  const projector = createProjector({ store })
  ensureRepo(store, home, Date.now)
  projector.create({ id: 's-stop', origin: 'wrapped', pty_id: 'pty_stop', process_key: 'pty_stop', repo_id: home, cwd: home })
  store.run('INSERT INTO requests(id, session_id, kind, summary, detail, options, state, source, match_key, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'q-stop', 's-stop', 'question', 'Ship it?', JSON.stringify({ question: 'Ship it?' }), '[]', 'open', 'stop_question', 'k-stop', Date.now() - 1000)
  let screen = { rev: 1, ...(await rendered('permission-2')) }
  const writes = []
  const link = { connected: true, features: ['guardedWrite'], request: async () => screen, onParsed: () => () => {},
    writeGuarded: async (ptyId, data) => { writes.push(data); return { at: Date.now() } } }
  const deliverer = createDeliverer({ store, link })
  t.after(() => { deliverer.close(); store.close() })
  await refused(deliverer.answer('q-stop', { choice: 'reply', text: 'yes' }), 'not_on_screen')
  assert.deepEqual(writes, [])
  screen = { rev: 2, ...(await rendered('idle-input')) }
  const { outcome } = await deliverer.answer('q-stop', { choice: 'reply', text: 'yes, ship\x1b[201~' })
  assert.deepEqual(writes, ['\x1b[200~yes, ship\x1b[201~\r'])
  projector.applyHooks([{ hook: { hook_event_name: 'UserPromptSubmit', session_id: 'claude-stop', cwd: home, prompt: 'yes, ship' }, hookTs: Date.now(), receivedAt: Date.now(), ptyId: 'pty_stop', claudePid: null, via: 'socket' }])
  assert.equal(await outcome, 'answered')
  assert.deepEqual(JSON.parse(store.get('SELECT answer FROM requests WHERE id = ?', 'q-stop').answer), { via: 'browser', choice: 'reply' })
})

const terminalKey = (s, key) => term.request('write', { ptyId: s.ptyId, data: b64(key), source: { kind: 'terminal', name: 'test-terminal' } })

test('a terminal answer while the deck keys are still in flight is a terminal answer, counted and audited', async t => {
  // The owner presses 1 in the terminal before deckd answers the guarded write, which the keypress
  // makes deckd refuse.
  const ctx = {}
  const s = await scenario(t, 'approve-safe', { claudePid: 4242, wrapLink: link => linkWith(link, { writeGuarded: async () => {
    await terminalKey(ctx.s, '1')
    await until(() => ctx.s.row(ctx.id).state === 'answered', 'the PostToolUse to close it')
    throw Object.assign(new Error('typing_in_terminal'), { code: 'typing_in_terminal' })
  } }) })
  ctx.s = s
  const req = await s.request('npm run test')
  ctx.id = req.id
  await refused(s.deliverer.answer(req.id, { choice: 'allow' }), 'typing_in_terminal')
  assert.deepEqual(inputs(s.log), ['1'])
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'terminal', choice: 'allow' })
  assert.equal(s.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
  const answered = s.audits(req.id).filter(row => row.kind === 'answered')
  assert.deepEqual(answered.map(row => [row.via, row.choice]), [['terminal', 'allow']])
})

test('an AskUserQuestion hook that reports another option than the deck typed is a terminal answer', async t => {
  // The deck's option 1 (A) is lost; the owner picks 2 (B) in the terminal.
  const s = await scenario(t, 'question-options', { wrapLink: lossy, deliver: { verifyMs: 300 } })
  const question = await until(() => s.store.get("SELECT * FROM requests WHERE kind = 'question' AND state = 'open' AND screen_match = 'on_screen'"), 'the question on screen')
  const { outcome } = await s.deliverer.answer(question.id, { choice: 'option', optionKey: '1' })
  assert.equal(await outcome, 'did_not_land')
  await terminalKey(s, '2')
  await until(() => s.row(question.id).state === 'answered', 'the PostToolUse to close it')
  assert.deepEqual(JSON.parse(s.row(question.id).answer), { via: 'terminal', choice: 'allow' })
  await until(() => s.audits(question.id).at(-1).kind === 'answered', 'the answered audit')
  const audit = s.audits(question.id).at(-1)
  assert.deepEqual([audit.via, audit.option_label], ['terminal', null])

  // The same hook naming the deck's option proves the deck answer (no screen proof here).
  const p = await scenario(t, 'question-options', { wrapLink: link => linkWith(link, { onParsed: () => () => {} }) })
  const q2 = await until(() => p.store.get("SELECT * FROM requests WHERE kind = 'question' AND state = 'open' AND screen_match = 'on_screen'"), 'the question on screen')
  const proved = await p.deliverer.answer(q2.id, { choice: 'option', optionKey: '1' })
  assert.equal(await proved.outcome, 'answered')
  assert.deepEqual(JSON.parse(p.row(q2.id).answer), { via: 'browser', choice: 'option' })
  assert.equal(p.audits(q2.id).at(-1).option_label, 'A')
})

test('a Try again refused at write time keeps watching the earlier did_not_land answer', async t => {
  let writes = 0
  const s = await scenario(t, 'approve-safe', { claudePid: 4242, deliver: { verifyMs: 500 },
    wrapLink: link => linkWith(link, { writeGuarded: (...args) => ++writes === 1 ? Promise.resolve({ at: Date.now() }) : link.writeGuarded(...args) }) })
  const req = await s.request('npm run test')
  const first = await s.deliverer.answer(req.id, { choice: 'allow' })
  assert.equal(await first.outcome, 'did_not_land')
  await terminalKey(s, 'x')
  await sleep(100)
  await refused(s.deliverer.answer(req.id, { choice: 'allow' }), 'typing_in_terminal')
  assert.equal(s.row(req.id).delivery, 'did_not_land')
  await terminalKey(s, '1')
  await until(() => s.row(req.id).state === 'answered', 'the PostToolUse to close it')
  await until(() => s.audits(req.id).some(row => row.kind === 'answered'), 'the answered audit')
  assert.equal(s.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
})

test('a UserPromptSubmit closing a deck allow that did not land is a terminal deny with no rule count', async t => {
  const s = await scenario(t, 'approve-safe', { wrapLink: lossy, deliver: { verifyMs: 300 } })
  const req = await s.request('npm run test')
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'allow' })
  assert.equal(await outcome, 'did_not_land')
  s.pauseHooks()
  captureHook(s, 'UserPromptSubmit')
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'terminal', choice: 'deny' })
  await until(() => s.audits(req.id).at(-1).kind === 'answered', 'the answered audit')
  assert.deepEqual([s.audits(req.id).at(-1).via, s.audits(req.id).at(-1).choice], ['terminal', 'deny'])
  assert.equal(s.store.get('SELECT count(*) AS n FROM rule_counters').n, 0)
})

test('a hook contradicting the deck inside the verify window settles closed, and batch reports it not ok', async t => {
  const s = await scenario(t, 'approve-safe', { wrapLink: lossy })
  const req = await s.request('npm run test')
  const { outcome } = await s.deliverer.answer(req.id, { choice: 'allow' })
  await terminalKey(s, '2')
  assert.equal(await outcome, 'closed')
  assert.deepEqual(JSON.parse(s.row(req.id).answer), { via: 'terminal', choice: 'deny' })

  const b = await scenario(t, 'approve-safe', { wrapLink: lossy })
  const reqB = await b.request('npm run test')
  const results = b.deliverer.batch([reqB.id])
  await until(() => b.row(reqB.id).delivery === 'verifying', 'the batch write')
  await terminalKey(b, '2')
  assert.deepEqual(await results, [{ id: reqB.id, ok: false, error: 'request_closed' }])
})

test('a hook that closes the request before deckd answers the accepted write is settled once by the write', async t => {
  // Agreeing hook: the deck's keys were accepted, so the deck answered, counted and audited once.
  const ctx = {}
  const accepted = link => linkWith(link, { writeGuarded: async (...args) => {
    await ctx.press()
    await until(() => ctx.s.row(ctx.id).state !== 'open', 'the hook to close it')
    return { at: Date.now() }
  } })
  const a = await scenario(t, 'approve-safe', { claudePid: 4242, wrapLink: accepted })
  Object.assign(ctx, { s: a, press: () => terminalKey(a, '1') })
  ctx.id = (await a.request('npm run test')).id
  const sentA = await a.deliverer.answer(ctx.id, { choice: 'allow' })
  assert.equal(await sentA.outcome, 'answered')
  assert.deepEqual(JSON.parse(a.row(ctx.id).answer), { via: 'browser', choice: 'allow' })
  assert.equal(a.row(ctx.id).delivery, 'verifying')
  assert.equal(a.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
  assert.deepEqual(a.audits(ctx.id).filter(row => row.kind === 'answered').map(row => [row.via, row.choice]), [['browser', 'allow']])

  // Contradicting hook (the owner denied): the hook's verdict wins even though the write was accepted.
  const b = await scenario(t, 'approve-safe', { claudePid: 4242, wrapLink: accepted })
  Object.assign(ctx, { s: b, press: () => terminalKey(b, '2') })
  ctx.id = (await b.request('npm run test')).id
  const sentB = await b.deliverer.answer(ctx.id, { choice: 'allow' })
  assert.equal(await sentB.outcome, 'closed')
  assert.deepEqual(JSON.parse(b.row(ctx.id).answer), { via: 'terminal', choice: 'deny' })
  assert.equal(b.store.get('SELECT count(*) AS n FROM rule_counters').n, 0)
  assert.deepEqual(b.audits(ctx.id).filter(row => row.kind === 'answered').map(row => [row.via, row.choice]), [['terminal', 'deny']])

  // A confirmed Destructive deck allow whose hook lands first keeps its confirm label in the audit.
  const d = await scenario(t, 'prompt-swap', { wrapLink: link => linkWith(link, { writeGuarded: async (...args) => {
    const written = await link.writeGuarded(...args)
    await until(() => ctx.s.row(ctx.id).state !== 'open', 'the hook to close it')
    return written
  } }) })
  ctx.s = d
  ctx.id = (await d.request('rm -rf build')).id
  const sentD = await d.deliverer.answer(ctx.id, { choice: 'allow', confirm: true })
  assert.equal(await sentD.outcome, 'answered')
  assert.deepEqual(JSON.parse(d.row(ctx.id).answer), { via: 'browser', choice: 'allow' })
  const audit = d.audits(ctx.id).filter(row => row.kind === 'answered')
  assert.deepEqual(audit.map(row => [row.via, row.confirm_label]), [['browser', 'I checked what this command will change']])
})

test('a tier that rises during the screen read is checked before the keys are written', async t => {
  const ctx = {}
  const s = await scenario(t, 'approve-safe')
  const raising = linkWith(s.link, {})
  raising.request = async (op, fields) => {
    const reply = await s.link.request(op, fields)
    if (op === 'screen') s.store.run("UPDATE requests SET tier = 'destructive', rule_pattern = NULL WHERE id = ?", ctx.id)
    return reply
  }
  const deliverer = createDeliverer({ store: s.store, link: raising })
  t.after(() => deliverer.close())
  ctx.id = (await s.request('npm run test')).id
  await refused(deliverer.answer(ctx.id, { choice: 'allow' }, { via: 'popup' }), 'tier_forbids')
  s.store.run("UPDATE requests SET tier = 'safe' WHERE id = ?", ctx.id)
  await refused(deliverer.answer(ctx.id, { choice: 'allow' }), 'confirm_required')
  await sleep(100)
  assert.deepEqual(inputs(s.log), [])
})

test('a terminal answer while a Try again is in flight is audited once, via terminal, and counted', async t => {
  let writes = 0
  const ctx = {}
  const s = await scenario(t, 'approve-safe', { claudePid: 4242, deliver: { verifyMs: 300 }, wrapLink: link => linkWith(link, { writeGuarded: async () => {
    if (++writes === 1) return { at: Date.now() }
    await terminalKey(ctx.s, '1')
    await until(() => ctx.s.row(ctx.id).state !== 'open', 'the hook to close it')
    // Long enough for the earlier attempt's late watch to poll the closed row before the refusal.
    await sleep(600)
    throw Object.assign(new Error('typing_in_terminal'), { code: 'typing_in_terminal' })
  } }) })
  ctx.s = s
  ctx.id = (await s.request('npm run test')).id
  // The earlier attempt was a deny, so the owner's terminal allow contradicts it: no late proof.
  const first = await s.deliverer.answer(ctx.id, { choice: 'deny' })
  assert.equal(await first.outcome, 'did_not_land')
  await refused(s.deliverer.answer(ctx.id, { choice: 'allow' }), 'typing_in_terminal')
  await sleep(600)
  assert.deepEqual(JSON.parse(s.row(ctx.id).answer), { via: 'terminal', choice: 'allow' })
  assert.deepEqual(s.audits(ctx.id).filter(row => row.kind === 'answered').map(row => [row.via, row.choice]), [['terminal', 'allow']])
  assert.equal(s.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
})

test('a deck free-text reply that did not land is a terminal answer when the owner picks an option', async t => {
  const s = await scenario(t, 'question-options', { wrapLink: lossy, deliver: { verifyMs: 300 } })
  const question = await until(() => s.store.get("SELECT * FROM requests WHERE kind = 'question' AND state = 'open' AND screen_match = 'on_screen'"), 'the question on screen')
  // The deck's text equals the label the owner then picks, so only the option-label rule can tell them apart.
  const { outcome } = await s.deliverer.answer(question.id, { choice: 'reply', text: 'B' })
  assert.equal(await outcome, 'did_not_land')
  await terminalKey(s, '2')
  await until(() => s.row(question.id).state === 'answered', 'the PostToolUse to close it')
  assert.deepEqual(JSON.parse(s.row(question.id).answer), { via: 'terminal', choice: 'allow' })
  await until(() => s.audits(question.id).at(-1).kind === 'answered', 'the answered audit')
  assert.equal(s.audits(question.id).at(-1).via, 'terminal')
})

test('a UserPromptSubmit after a deck option that did not land is a terminal deny', async t => {
  const s = await scenario(t, 'question-options', { wrapLink: lossy, deliver: { verifyMs: 300 } })
  const question = await until(() => s.store.get("SELECT * FROM requests WHERE kind = 'question' AND state = 'open' AND screen_match = 'on_screen'"), 'the question on screen')
  const { outcome } = await s.deliverer.answer(question.id, { choice: 'option', optionKey: '1' })
  assert.equal(await outcome, 'did_not_land')
  s.pauseHooks()
  captureHook(s, 'UserPromptSubmit')
  assert.deepEqual(JSON.parse(s.row(question.id).answer), { via: 'terminal', choice: 'deny' })
  await until(() => s.audits(question.id).at(-1).kind === 'answered', 'the answered audit')
  assert.deepEqual([s.audits(question.id).at(-1).via, s.audits(question.id).at(-1).option_label], ['terminal', null])
})

test('a deck free-text reply that did not land is a terminal answer when the owner types other text', async t => {
  // The fake reports the free text "a typed reply"; the deck's reply was different text.
  const s = await scenario(t, 'question-options', { wrapLink: lossy, deliver: { verifyMs: 300 } })
  const question = await until(() => s.store.get("SELECT * FROM requests WHERE kind = 'question' AND state = 'open' AND screen_match = 'on_screen'"), 'the question on screen')
  const { outcome } = await s.deliverer.answer(question.id, { choice: 'reply', text: 'the deck text' })
  assert.equal(await outcome, 'did_not_land')
  await terminalKey(s, '3')
  await terminalKey(s, '\x1b[200~a typed reply\x1b[201~\r')
  await until(() => s.row(question.id).state === 'answered', 'the PostToolUse to close it')
  assert.deepEqual(JSON.parse(s.row(question.id).answer), { via: 'terminal', choice: 'allow' })
  assert.doesNotMatch(s.row(question.id).answer, /deck text/)
})

test('a late proof of a did_not_land answer while a Try again is refused is the deck answer (row 15)', async t => {
  // The deck's first '1' reaches Claude, which is slow: no screen proof (onParsed is a no-op) and its
  // PostToolUse is held. Try again reads the stale screen (Claude has not redrawn); its write is then
  // refused screen_changed by deckd after the held hook closed the request.
  const ctx = { writes: 0 }
  const s = await scenario(t, 'approve-safe', { claudePid: 4242, deliver: { verifyMs: 300 }, wrapLink: link => {
    const wrapped = linkWith(link, { onParsed: () => () => {}, writeGuarded: async (...args) => {
      if (++ctx.writes === 1) {
        ctx.s.pauseHooks()
        return link.writeGuarded(...args)
      }
      ctx.s.resumeHooks()
      await until(() => ctx.s.row(ctx.id).state !== 'open', 'the held hook to close it')
      return link.writeGuarded(...args)
    } })
    wrapped.request = async (op, fields) => {
      if (op === 'screen' && ctx.screen && ctx.writes > 0) return ctx.screen
      const reply = await link.request(op, fields)
      if (op === 'screen') ctx.screen = reply
      return reply
    }
    return wrapped
  } })
  ctx.s = s
  ctx.id = (await s.request('npm run test')).id
  const first = await s.deliverer.answer(ctx.id, { choice: 'allow' })
  assert.equal(await first.outcome, 'did_not_land')
  await until(() => entries(s.log).some(entry => entry.hook === 'PostToolUse'), 'the fake to run the tool')
  await refused(s.deliverer.answer(ctx.id, { choice: 'allow' }), 'request_closed')
  await sleep(400)
  assert.deepEqual(inputs(s.log), ['1'])
  assert.deepEqual(JSON.parse(s.row(ctx.id).answer), { via: 'browser', choice: 'allow' })
  assert.deepEqual(s.audits(ctx.id).filter(row => row.kind === 'answered').map(row => [row.via, row.choice, row.option_label]), [['browser', 'allow', 'Yes']])
  assert.equal(s.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
})

/** The first write is lost (did_not_land) and the Try again is refused typing_in_terminal. */
function refusedRetry() {
  let writes = 0
  return link => linkWith(link, { writeGuarded: async () => {
    if (++writes === 1) return { at: Date.now() }
    throw Object.assign(new Error('typing_in_terminal'), { code: 'typing_in_terminal' })
  } })
}

test('a refused Try again restores the earlier answer: deck allow, refused deny, the owner presses No', async t => {
  // A terminal deny, and no follow-up window for a deny the deck never typed.
  const a = await scenario(t, 'approve-safe', { claudePid: 4242, deliver: { verifyMs: 300 }, wrapLink: refusedRetry() })
  const idA = (await a.request('npm run test')).id
  assert.equal(await (await a.deliverer.answer(idA, { choice: 'allow' })).outcome, 'did_not_land')
  await refused(a.deliverer.answer(idA, { choice: 'deny' }), 'typing_in_terminal')
  assert.equal(JSON.parse(a.row(idA).answer).choice, 'allow')
  await sleep(1100)
  await terminalKey(a, '2')
  await until(() => a.row(idA).state === 'answered', 'the PermissionDenied to close it')
  assert.deepEqual(JSON.parse(a.row(idA).answer), { via: 'terminal', choice: 'deny' })
  await refused(a.deliverer.followup(idA, 'use pnpm'), 'followup_window_closed')
})

test('a refused Try again restores the earlier answer: deck deny, refused allow, the owner presses 1', async t => {
  // A terminal allow, counted as terminal.
  const b = await scenario(t, 'approve-safe', { claudePid: 4242, deliver: { verifyMs: 300 }, wrapLink: refusedRetry() })
  const idB = (await b.request('npm run test')).id
  assert.equal(await (await b.deliverer.answer(idB, { choice: 'deny' })).outcome, 'did_not_land')
  await refused(b.deliverer.answer(idB, { choice: 'allow' }), 'typing_in_terminal')
  await sleep(1100)
  await terminalKey(b, '1')
  await until(() => b.row(idB).state === 'answered', 'the PostToolUse to close it')
  assert.deepEqual(JSON.parse(b.row(idB).answer), { via: 'terminal', choice: 'allow' })
  await until(() => b.audits(idB).some(row => row.kind === 'answered'), 'the answered audit')
  assert.deepEqual(b.audits(idB).filter(row => row.kind === 'answered').map(row => row.via), ['terminal'])
  assert.equal(b.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
})

test('an accepted Try again stops the earlier late watch: one audit row and one count', async t => {
  let writes = 0
  const s = await scenario(t, 'approve-safe', { claudePid: 4242, deliver: { verifyMs: 300 },
    wrapLink: link => linkWith(link, { writeGuarded: (...args) => ++writes === 1 ? Promise.resolve({ at: Date.now() }) : link.writeGuarded(...args) }) })
  const id = (await s.request('npm run test')).id
  assert.equal(await (await s.deliverer.answer(id, { choice: 'allow' })).outcome, 'did_not_land')
  assert.equal(await (await s.deliverer.answer(id, { choice: 'allow' })).outcome, 'answered')
  await sleep(800)
  assert.deepEqual(inputs(s.log), ['1'])
  assert.deepEqual(s.audits(id).filter(row => row.kind === 'answered').map(row => row.via), ['browser'])
  assert.equal(s.store.get('SELECT count FROM rule_counters WHERE pattern = ?', 'Bash(npm run test)')?.count, 1)
})

/**
 * A stop_question row on a stub link serving the idle input box; `writeGuarded` is the stub write.
 * @param {any} t
 * @param {(store: any) => Function} writeGuarded
 */
async function stopQuestionDeck(t, writeGuarded) {
  const home = fs.mkdtempSync(path.join(dir, 'stop-'))
  const store = openDeckDb(path.join(home, 'deck.db'))
  const projector = createProjector({ store })
  ensureRepo(store, home, Date.now)
  projector.create({ id: 's-stop', origin: 'wrapped', pty_id: 'pty_stop', process_key: 'pty_stop', repo_id: home, cwd: home })
  store.run('INSERT INTO requests(id, session_id, kind, summary, detail, options, state, source, match_key, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'q-stop', 's-stop', 'question', 'Ship it?', JSON.stringify({ question: 'Ship it?' }), '[]', 'open', 'stop_question', 'k-stop', Date.now() - 1000)
  const screen = { rev: 1, ...(await rendered('idle-input')) }
  const link = { connected: true, features: ['guardedWrite'], request: async () => screen, onParsed: () => () => {}, writeGuarded: writeGuarded(store) }
  const deliverer = createDeliverer({ store, link, verifyMs: 200 })
  t.after(() => { deliverer.close(); store.close() })
  const submit = prompt => projector.applyHooks([{ hook: { hook_event_name: 'UserPromptSubmit', session_id: 'claude-stop', cwd: home, prompt }, hookTs: Date.now(), receivedAt: Date.now(), ptyId: 'pty_stop', claudePid: null, via: 'socket' }])
  return { store, deliverer, submit, row: () => store.get('SELECT * FROM requests WHERE id = ?', 'q-stop') }
}

test('a stop_question reply that did not land is a terminal answer when the owner submits other text', async t => {
  const q = await stopQuestionDeck(t, () => async () => ({ at: Date.now() }))
  const { outcome } = await q.deliverer.answer('q-stop', { choice: 'reply', text: 'deck words' })
  assert.equal(await outcome, 'did_not_land')
  q.submit('owner own words')
  assert.deepEqual(JSON.parse(q.row().answer), { via: 'terminal', choice: 'observed' })
  await until(() => q.store.get("SELECT via FROM approval_audit WHERE request_id = 'q-stop' AND kind = 'answered'"), 'the answered audit')
  assert.equal(q.store.get("SELECT via FROM approval_audit WHERE request_id = 'q-stop' AND kind = 'answered'").via, 'terminal')
})

test('a request expired while the deck write is in flight keeps no attempt as its answer', async t => {
  const q = await stopQuestionDeck(t, store => async () => {
    store.run("UPDATE requests SET state = 'expired', expired_reason = 'process_ended' WHERE id = 'q-stop'")
    throw Object.assign(new Error('deckd_unavailable'), { code: 'deckd_unavailable' })
  })
  await refused(q.deliverer.answer('q-stop', { choice: 'reply', text: 'deck words' }), 'deckd_unavailable')
  assert.deepEqual([q.row().state, q.row().delivery, q.row().answer], ['expired', 'idle', null])
})

test('an extension scan raises the tier before any permission keys are delivered', async t => {
  let scans = 0
  const s = await scenario(t, 'approve-safe', { deliver: { scan: async () => { scans++; return { entryId: 'extension.scan', tier: 'destructive', description: 'Flagged instruction' } } } })
  const req = await s.request('npm run test')
  await refused(s.deliverer.answer(req.id, { choice: 'allow' }), 'confirm_required')
  assert.equal(scans, 1)
  assert.equal(s.row(req.id).tier, 'destructive')
  assert.deepEqual(inputs(s.log), [])
  const accepted = await s.deliverer.answer(req.id, { choice: 'allow', confirm: true })
  assert.equal(await accepted.outcome, 'answered')
  assert.equal(scans, 2)
  assert.deepEqual(inputs(s.log), ['1'])
})
