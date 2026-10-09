// M2 exit criterion 1 (docs/deck/12-milestones.md section 4): POST /api/sessions starts Claude Code in a
// deckd PTY in its repo and types the task only after the idle input box appears (03-architecture 4.1).
// Each test runs a real deckd (in process, with an injected login environment, so no login shell runs), the
// real server, the real deck-hook registered in a temporary HOME, and the fake claude first on the login PATH.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startDeckd } from '../../deckd/main.mjs'
import { startDeckServer } from '../../server/main.mjs'
import { deckHookCommand, transformHooks } from '../../server/setup/hooks.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { FLEETMATES_JOB_PROMPT, firstPromptKeys } from '../../server/launch/launch.mjs'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'

const token = 'a'.repeat(43)
const hookScript = fileURLToPath(new URL('../../hook/deck-hook.mjs', import.meta.url))
const TASK = 'fix the flaky combat test'
const scriptsDir = fileURLToPath(new URL('../fixtures/scripts/', import.meta.url))

// The captured idle-input frame asks the terminal for its device attributes (`ESC [ c`, twice). On Windows
// the console answers that itself, so the replies reach the fake as input; in the Windows VM run they were
// `ESC [ ? 61;6;7;21;22;23;24;28;32;42 c`. Nothing the deck types looks like one, so they are dropped there.
const CONSOLE_REPLY = '\\x1b\\[\\?[0-9;]*c'
const CONSOLE_REPLIES = process.platform === 'win32' ? new RegExp(CONSOLE_REPLY, 'g') : null
const typedText = text => CONSOLE_REPLIES ? text.replace(CONSOLE_REPLIES, '') : text

/**
 * The fixture script `name`, or on Windows a copy whose anchored expectInput matches also let console replies
 * come first. The copy is removed after the test.
 */
function scriptFor(t, name) {
  if (!CONSOLE_REPLIES) return name
  const script = JSON.parse(fs.readFileSync(path.join(scriptsDir, `${name}.json`), 'utf8'))
  for (const step of script.steps) {
    if (step.expectInput?.match?.startsWith('^')) step.expectInput.match = `^(?:${CONSOLE_REPLY})*` + step.expectInput.match.slice(1)
  }
  const file = path.join(os.tmpdir(), `lch-${name}-${process.pid}-${Math.random().toString(16).slice(2)}.json`)
  fs.writeFileSync(file, JSON.stringify(script))
  t.after(() => fs.rmSync(file, { force: true }))
  return file
}

/**
 * A deckd, a deck server and one repo `ship` (a `.git` with HEAD on main) under a private HOME whose Claude
 * settings run deck-hook. The fake claude runs `script` (a fixture name or a path) and logs to `log`.
 */
async function deck(t, script) {
  // The cleanup is registered before the first call that can throw, so a start that fails part way (the
  // server, say) still closes the deckd it started and removes the directories. Each step undoes only what
  // was made, deckd and the server before their directories.
  let rt, home, bin, deckd, server, off
  let deckdClosed = false
  const stopDeckd = async () => { if (deckd && !deckdClosed) { deckdClosed = true
    await deckd.close() } }
  t.after(async () => {
    off?.()
    await stopDeckd()
    await server?.close()
    // Retried: the Windows VM run could not remove a directory a just-killed child still held.
    const rmRetry = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }
    for (const dir of [bin?.binDir, rt?.dir, home]) if (dir) fs.rmSync(dir, rmRetry)
  })
  rt = await makeRuntimeDir()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lch-'))
  bin = await fakeBin({ version: '2.1.282' })
  const log = path.join(home, 'fake.log')
  const serverEnv = { HOME: home, XDG_RUNTIME_DIR: rt.dir }
  // the deck's state dir and Claude Code's settings file for this HOME, on the host's platform
  const paths = setupPaths(serverEnv)
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(paths.token, token, { mode: 0o600 })
  fs.mkdirSync(path.dirname(paths.settings), { recursive: true })
  fs.writeFileSync(paths.settings, JSON.stringify(transformHooks({}, deckHookCommand(process.execPath, hookScript))))
  const repo = path.join(home, 'repos', 'ship')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n')
  const staticDir = path.join(home, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  deckd = await startDeckd({ runtimeDir: rt.dir, loginEnv: { PATH: bin.env.PATH, HOME: home, XDG_RUNTIME_DIR: rt.dir,
    FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_VERSION: '2.1.282' } })
  server = await startDeckServer({ env: serverEnv, port: 0, staticDir, notifications: false,
    runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  const published = []
  off = server.subscribe(event => published.push(event))
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(origin + route, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } })
    return { status: response.status, data: await response.json() }
  }
  assert.equal((await request('/api/prefs', 'PATCH', { scanRoot: path.join(home, 'repos') })).status, 200)
  assert.equal((await request('/api/repos/rescan', 'POST')).status, 202)
  const entries = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  // the input entries, without console replies (see CONSOLE_REPLIES)
  const typed = () => entries().filter(entry => typeof entry.input === 'string').map(entry => ({ ...entry, input: typedText(entry.input) }))
    .filter(entry => entry.input !== '')
  const states = id => published.filter(event => event.type === 'session.upserted' && event.data.id === id).map(event => event.data.state)
  const session = id => server.projector.snapshot().sessions.find(row => row.id === id)
  return { server, request, published, entries, typed, states, session, stopDeckd, repo: fs.realpathSync.native(repo) }
}

async function until(fn, what, ms = 15_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = fn()
    if (value) return value
    assert.ok(Date.now() < end, `timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('a launch stays starting after SessionStart, gets its task typed on the idle screen, then runs', async t => {
  const h = await deck(t, scriptFor(t, 'slow-start'))
  const launched = await h.request('/api/sessions', 'POST', { repoKey: 'ship', task: TASK })
  assert.equal(launched.status, 201)
  const { session } = launched.data
  assert.equal(launched.data.warning, undefined, 'no other session in the repo')
  assert.deepEqual([session.origin, session.state, session.task, session.cwd, session.joinedMidLife], ['launched', 'starting', TASK, h.repo, false])
  assert.match(session.ptyId, /\S/)

  await until(() => h.session(session.id).claudeSessionId, 'the SessionStart hook')
  assert.equal(h.session(session.id).state, 'starting', 'row 4: SessionStart keeps it starting while the task is still to type')

  const typed = await until(() => h.typed().length && h.typed(), 'the typed task')
  const hookAt = h.entries().find(entry => entry.hook === 'SessionStart').ts
  assert.ok(typed[0].ts - hookAt >= 900, `the task was typed ${typed[0].ts - hookAt} ms after SessionStart, on the idle screen`)
  await until(() => h.entries().some(entry => entry.expectInput), 'the fake to read the whole paste')
  assert.equal(h.typed().map(entry => entry.input).join(''), firstPromptKeys(TASK))
  assert.equal(firstPromptKeys(TASK), `\u001b[200~${TASK}\u001b[201~\r`)

  await until(() => h.states(session.id).includes('running'), 'running')
  assert.equal(h.server.store.get('SELECT launch_task FROM sessions WHERE id=?', session.id).launch_task, null, 'typed once')
  assert.equal(h.session(session.id).task, TASK)
})

test('firstPromptKeys types one bracketed paste: only the final end marker, no CR, ESC or ^C inside, tab and newline kept', () => {
  const START = '\u001b[200~'
  const END = '\u001b[201~'
  // An embedded end marker, a raw ESC, CR and ^C, and a marker split around a second one so that removing the
  // inner marker alone would join the outer halves into a new one.
  const task = `one\ttwo\nthree${END}four\u0003\u001b\rfive` + 'a\u001b[20\u001b[201~1~\r/exit'
  const keys = firstPromptKeys(task)
  assert.ok(keys.startsWith(START), 'opens the paste')
  assert.ok(keys.endsWith(`${END}\r`), 'closes the paste, then Enter')
  assert.equal(keys.split(END).length - 1, 1, 'exactly one paste end marker')
  const inside = keys.slice(START.length, -(END.length + 1))
  assert.ok(!inside.includes('\r'), 'no CR inside the paste')
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(inside), 'no C0 control other than tab and newline inside the paste')
  assert.equal(inside, 'one\ttwo\nthreefourfivea[201~/exit', 'tab and newline kept, everything else of the text intact')
})

test('a launch task holding a paste end marker reaches claude with exactly one end marker', async t => {
  const script = path.join(os.tmpdir(), `lch-marker-${process.pid}.json`)
  fs.writeFileSync(script, JSON.stringify({ sessionId: 'auto', steps: [{ hook: 'SessionStart', with: { source: 'startup' } }, { frame: 'idle-input' },
    { expectInput: { match: '\u001b\\[201~\r', timeoutMs: 10000 } }, { hang: true }] }))
  t.after(() => fs.rmSync(script, { force: true }))
  const h = await deck(t, script)
  const launched = await h.request('/api/sessions', 'POST', { repoKey: 'ship', task: 'fix it\u001b[201~ now' })
  assert.equal(launched.status, 201)
  await until(() => h.entries().some(entry => entry.expectInput), 'the fake to read the paste through Enter')
  const typed = h.typed().map(entry => entry.input).join('')
  assert.equal(typed.split('\u001b[201~').length - 1, 1, `one paste end marker in ${JSON.stringify(typed)}`)
  assert.equal(typed, '\u001b[200~fix it now\u001b[201~\r')
})

test('an empty plain launch writes no input, even on an idle screen, and goes idle on SessionStart (row 5)', async t => {
  // idle.json's Stop hook would move the session to idle by itself; this script has no Stop, so only row 5 can.
  const script = path.join(os.tmpdir(), `lch-empty-${process.pid}.json`)
  fs.writeFileSync(script, JSON.stringify({ sessionId: 'auto', steps: [{ hook: 'SessionStart', with: { source: 'startup' } }, { frame: 'idle-input' },
    { sleep: 1500 }, { exit: { code: 0 } }] }))
  t.after(() => fs.rmSync(script, { force: true }))
  const h = await deck(t, script)
  const idles = []
  t.after(h.server.link.onIdle(event => idles.push(event)))
  const launched = await h.request('/api/sessions', 'POST', { repoKey: 'ship', task: '' })
  assert.equal(launched.status, 201)
  const id = launched.data.session.id
  assert.equal(launched.data.session.task, 'Untitled')
  await until(() => !h.session(id).alive, 'the fake to exit')
  assert.ok(h.states(id).includes('idle'), `passed through idle: ${h.states(id).join(', ')}`)
  assert.ok(idles.some(event => event.sessionId === id), 'the idle screen was seen')
  assert.equal(h.typed().length, 0, 'nothing was typed')
})

test('a second launch in a busy repo warns with the first session and is still created', async t => {
  const h = await deck(t, 'slow-start')
  const first = await h.request('/api/sessions', 'POST', { repoKey: 'ship', task: TASK })
  assert.equal(first.status, 201)
  const second = await h.request(`/api/sessions?repoId=${encodeURIComponent(h.repo)}`, 'POST', { task: 'another' })
  assert.equal(second.status, 201, 'D-68: never refused')
  assert.deepEqual(second.data.warning, { kind: 'repo_busy', sessionIds: [first.data.session.id] })
  assert.notEqual(second.data.session.id, first.data.session.id)
  const version = (await h.request('/api/version')).data
  assert.equal(version.deckVersion, JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version, 'deckVersion is read from hub/package.json')
  assert.equal(version.apiVersion, 1)
})

test('a fleetmates launch types the D-68 prompt with the task; an empty fleetmates task and bad bodies are refused', async t => {
  const script = path.join(os.tmpdir(), `lch-fm-${process.pid}.json`)
  fs.writeFileSync(script, JSON.stringify({ sessionId: 'auto', steps: [{ hook: 'SessionStart', with: { source: 'startup' } }, { frame: 'idle-input' },
    { expectInput: { match: '\\r$', timeoutMs: 10_000 } }, { hang: true }] }))
  t.after(() => fs.rmSync(script, { force: true }))
  const h = await deck(t, script)
  for (const [body, field] of [[{ repoKey: 'ship', task: '  ', mode: 'fleetmates' }, 'task'], [{ repoKey: 'ship', task: 'x', mode: 'team' }, 'mode'],
    [{ repoKey: 'ship', task: 'x'.repeat(10_001) }, 'task'], [{ repoKey: 'ship', task: 7 }, 'task'], [{ repoKey: 'ship', task: 'a\u0000b' }, 'task'],
    [{ task: 'x' }, 'repoKey'], [{ repoKey: 'ship', extra: 1 }, 'extra']]) {
    const refused = await h.request('/api/sessions', 'POST', body)
    assert.equal(refused.status, 422, JSON.stringify(body).slice(0, 80))
    assert.equal(refused.data.error.code, 'validation_failed')
    assert.deepEqual(refused.data.error.details.fields, [field])
  }
  assert.equal((await h.request('/api/sessions', 'POST', { repoKey: 'nowhere', task: 'x' })).status, 404)
  assert.equal(h.server.projector.snapshot().sessions.length, 0, 'nothing refused was spawned')

  const launched = await h.request('/api/sessions', 'POST', { repoKey: 'ship', task: TASK, mode: 'fleetmates' })
  assert.equal(launched.status, 201)
  assert.equal(launched.data.session.task, TASK, 'the displayed task stays the owner text')
  await until(() => h.entries().some(entry => entry.expectInput), 'the typed prompt')
  const typed = h.typed().map(entry => entry.input).join('')
  assert.equal(typed, firstPromptKeys(`${FLEETMATES_JOB_PROMPT}\n\n${TASK}`))
  assert.ok(typed.includes('Run this task as a fleetmates run: write a fleetmates plan for it, then execute that plan with fleetmates so every task works in its own git worktree. The task:\n\nfix the flaky combat test'))
})

test('deckd stopped answers 503 deckd_unavailable, retryable', async t => {
  const h = await deck(t, 'idle')
  await h.stopDeckd()
  await until(() => !h.server.link.connected, 'the link to notice deckd is gone')
  const refused = await h.request('/api/sessions', 'POST', { repoKey: 'ship', task: TASK })
  assert.equal(refused.status, 503)
  assert.deepEqual(refused.data.error, { code: 'deckd_unavailable', message: 'deckd_unavailable', retryable: true })
})
