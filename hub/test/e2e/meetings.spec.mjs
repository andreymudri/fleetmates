// M4 Meetings end to end (docs/deck/screens/meetings.md section 10, rail-and-shell.md AC6, failures-and-loading.md
// AC6, docs/plans/2026-10-04-deck-m4.md Task 17): the built app, served by the real deck server over a temporary HOME
// that holds the meetings5 tree (config at the MEET-O11 default path ~/dev/turbidassist/config.yaml), with the fake
// scribed (hub/test/fakes/fake-scribed.mjs) inside this test process on the server's XDG_RUNTIME_DIR, in headless
// Chromium through playwright-core. Scenario data: hub/test/fixtures/ui/meetings.json.
//
// Host isolation: `isolateHost()` puts a logging shim for every host binary a meeting path can reach (systemd-run,
// systemctl, scribed, scribe, postmeet, xdg-open, notify-send, makoctl, pw-play) first on this process's PATH,
// points XDG_RUNTIME_DIR at a private temporary directory and removes DBUS_SESSION_BUS_ADDRESS, DISPLAY,
// WAYLAND_DISPLAY, SSH_AUTH_SOCK, every FLEETMATES_DECK_* key and every key naming a token from this process's
// environment, so Chromium, the build and every child inherit none of them. The server gets its own environment
// (HOME, XDG_RUNTIME_DIR, PATH with the shims first, SHELL). Beyond PATH, the systemd-run runner is injected and runs
// the shim by absolute path, the opener is recorded and never run, and the notifier runs the notify-send, pw-play and
// makoctl shims by absolute path.
//
// Not part of `npm --prefix hub test` (its glob is test/**/*.test.mjs). Run from hub/ with:
//   mkdir -p /tmp/hx && TMPDIR=/tmp/hx node --test --test-concurrency=1 test/e2e/meetings.spec.mjs
//
// This file also exports the meetings harness security.spec.mjs and accessibility.spec.mjs use. Its tests register
// only when it is the entry file (`import.meta.main`), so importing it runs nothing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { TOKEN, buildWeb, envelopeFor, fakeDeckd, fixture, hub, launchBrowser, openDeck, until } from './observe.spec.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { createNotifier } from '../../server/adapters/notify.mjs'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { fixtureNow, meetings5, writeMeetingsTree } from '../helpers/meetings-tree.mjs'

const run = promisify(execFile)

/** The parsed `hub/test/fixtures/ui/meetings.json`. */
export const meetingsUi = JSON.parse(await readFile(new URL('../fixtures/ui/meetings.json', import.meta.url), 'utf8'))

/** Every host binary a meeting path could reach; each is a logging shim first on PATH. */
export const HOST_BINARIES = Object.freeze(['systemd-run', 'systemctl', 'scribed', 'scribe', 'postmeet', 'xdg-open', 'notify-send', 'makoctl', 'pw-play'])
/** Shims that read their stdin to the end before exiting, as the notifier feeds them. */
const STDIN_SHIMS = new Set(['notify-send', 'pw-play', 'makoctl'])
/** The decided "Start scribed" argv (OPS-O1) with the harness's SHELL. */
export const DECIDED_ARGV = Object.freeze(['--user', '--collect', '--unit=turbidassist-scribed', '--property=KillMode=process', '/bin/sh', '-l', '-c', 'exec scribed'])
/** Environment keys that could reach the owner's desktop session or carry a credential. */
const HOST_KEY = /^(DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|SSH_AUTH_SOCK|FLEETMATES_DECK_.*)$|TOKEN/i

let isolation = null

/**
 * Isolate this test process from the owner's desktop session, once: logging shims first on PATH, a private
 * XDG_RUNTIME_DIR, and no session bus, display, SSH agent, deck or token variable. Children started afterwards
 * (Chromium, the build, the server's children) inherit the result.
 * @returns {{ shimDir: string, shimLog: string, runtime: string, removed: string[] }}
 */
export function isolateHost() {
  if (isolation) return isolation
  const shimDir = fs.mkdtempSync(path.join(tmpdir(), 'mtg-bin-'))
  const shimLog = path.join(shimDir, 'argv.jsonl')
  for (const name of HOST_BINARIES) {
    fs.writeFileSync(path.join(shimDir, name), `#!${process.execPath}
import fs from 'node:fs'
${STDIN_SHIMS.has(name) ? 'for await (const chunk of process.stdin) {}\n' : ''}fs.appendFileSync(${JSON.stringify(shimLog)}, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2), envKeys: Object.keys(process.env).sort() }) + '\\n')
process.stdout.write('42\\n')
`, { mode: 0o700 })
  }
  const runtime = fs.mkdtempSync(path.join(tmpdir(), 'mtg-xdg-'))
  fs.chmodSync(runtime, 0o700)
  const removed = Object.keys(process.env).filter(key => HOST_KEY.test(key)).sort()
  for (const key of removed) delete process.env[key]
  process.env.XDG_RUNTIME_DIR = runtime
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`
  process.on('exit', () => {
    fs.rmSync(shimDir, { recursive: true, force: true })
    fs.rmSync(runtime, { recursive: true, force: true })
  })
  isolation = { shimDir, shimLog, runtime, removed }
  return isolation
}

/**
 * Every shim invocation logged so far.
 * @returns {{ command: string, args: string[], envKeys: string[] }[]}
 */
export function shimCalls() {
  const { shimLog } = isolateHost()
  return fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

/** Absolute path of one shim. */
export const shimPath = name => path.join(isolateHost().shimDir, name)

/**
 * A scribed session id (`YYYY-MM-DDTHH-MM-SS`, local time).
 * @param {Date} [d]
 */
export function sessionIdFor(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

/** The meetings5 fixture with the qa 1.7 hostile session added. */
export const hostileFixture = Object.freeze({ ...meetings5, sessions: [...meetings5.sessions, meetingsUi.xss.session] })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function writeLines(socketPath, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    socket.once('error', reject)
    socket.once('connect', () => socket.end(lines.join(''), resolve))
  })
}

/**
 * Start the real deck server on the built app over a temporary HOME holding the meetings5 tree, with the fake
 * scribed on its runtime directory (unless `scribed: false`), a fake deckd, the recorded opener and the injected
 * systemd-run runner (the shim by absolute path, then `onSystemdRun`).
 * @param {{ after?: Function }} t test context; its `after` removes everything
 * @param {{ web: string, fixture?: object, now?: number, variants?: string[], scribed?: boolean, fake?: object,
 *   notifications?: boolean, onSystemdRun?: (h: object) => Promise<void> }} options
 */
export async function startMeetings(t, options) {
  isolateHost()
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'mtg-'))
  const home = path.join(dir, 'home')
  const runtime = path.join(dir, 'r')
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  const tree = await writeMeetingsTree(home, options.fixture ?? meetings5, { now: options.now ?? fixtureNow(), variants: options.variants ?? [] })
  const env = { HOME: home, XDG_RUNTIME_DIR: runtime, PATH: process.env.PATH, SHELL: '/bin/sh' }
  const paths = setupPaths(env)
  await mkdir(paths.state, { recursive: true, mode: 0o700 })
  await writeFile(paths.token, TOKEN, { mode: 0o600 })
  await mkdir(path.dirname(paths.hook), { recursive: true, mode: 0o700 })
  await copyFile(path.join(hub, 'hook/deck-hook.mjs'), paths.hook)
  const commands = []
  const opened = []
  const systemdRuns = []
  let fake = options.scribed === false ? null : await startFakeScribed({ dir: runtime, ...options.fake })
  const h = {
    dir, home, runtime, env, paths, tree, commands, opened, systemdRuns, contexts: new Set(),
    get fake() { return fake },
    /** Start the fake scribed (after `scribed: false` or `stopFake`). */
    async startFake(fakeOptions = {}) { fake = await startFakeScribed({ dir: runtime, ...options.fake, ...fakeOptions }) },
    /** Stop the fake scribed and remove its socket. */
    async stopFake() { await fake?.stop()
      fake = null },
    get port() { return h.deck.address().port },
    get base() { return `http://127.0.0.1:${h.port}` },
    get hooksSocket() { return path.join(runtime, 'fleetmates-deck', 'hooks.sock') },
    /** Authorized JSON request to the deck API. */
    async api(route, method = 'GET', body) {
      const response = await fetch(h.base + route, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: h.base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } })
      const text = await response.text()
      return { status: response.status, data: text ? JSON.parse(text) : null }
    },
    /** The recorder view of `GET /api/meetings`. */
    async recorder() { return (await h.api('/api/meetings')).data.recorder },
    /** Start a recording through the API and return the recorder (`recording`). */
    async record(tag) {
      const started = await h.api('/api/meetings/start', 'POST', { tag })
      assert.equal(started.status, 202, JSON.stringify(started.data))
      assert.equal(started.data.recorder.state, 'recording')
      return started.data.recorder
    },
    /** A recording started by another client: the fake's status turns `recording: true`. Returns its session id. */
    otherClient(tag = 'pessoal', patch = {}) {
      const id = sessionIdFor()
      fake.setStatus({ recording: true, session_id: id, tag, elapsed_s: null, startedAt: Date.now(), asks: [], ...patch })
      return id
    },
    /** Push transcript events (meetings.json `live` rows) for a session, once the recorder's subscription is open. */
    async push(lines, sessionId) {
      await until(() => fake.connections.some(conn => conn.subscribed && !conn.closed), { timeout: 5000, message: 'the recorder subscription' })
      for (const line of lines) fake.pushTranscript({ ...line, session_id: sessionId })
    },
    /** The pins of a meeting. */
    async pins(id) { return (await h.api(`/api/meetings/${encodeURIComponent(id)}`)).data.pins },
    /** Send hook envelopes through the real hooks socket. */
    async sendHooks(envelopes) { await writeLines(h.hooksSocket, envelopes.map(row => JSON.stringify(row) + '\n')) },
    /** The bytes of deck.db and its -wal and -shm files, as one buffer. */
    dbBytes() {
      const files = ['deck.db', 'deck.db-wal', 'deck.db-shm'].map(name => path.join(paths.state, name)).filter(file => fs.existsSync(file))
      return Buffer.concat(files.map(file => fs.readFileSync(file)))
    },
    async close() {
      for (const context of h.contexts) await context.close().catch(() => {})
      await h.deck.close().catch(() => {})
      await fake?.stop().catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  }
  const runCommand = (file, args) => {
    commands.push([file, ...args])
    if (file === 'claude') return { status: 0, stdout: '2.1.282 (Claude Code)\n', stderr: '' }
    if (file === 'systemctl' && args.includes('is-active')) return { status: 3, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  h.deck = await startDeckServer({
    env, port: 0, staticDir: options.web, connectDeckd: fakeDeckd().connect, runCommand, random: () => 0.5, reconnectMs: 1000,
    runPollMs: 3_600_000, configDebounceMs: 20,
    notifications: options.notifications === true,
    ...(options.notifications === true ? {
      notifier: createNotifier({ notifyCommand: shimPath('notify-send'), soundCommand: shimPath('pw-play'), dismissCommand: shimPath('makoctl'), env })
    } : {}),
    // The opener is recorded, never run: no test may reach the desktop's real xdg-open.
    services: { open: async target => { opened.push(target) } },
    // "Start scribed": the shim by absolute path with the server's argv and environment, never the real systemd-run.
    scribedExecFile: async (file, args, execOptions) => {
      systemdRuns.push({ file, args })
      assert.equal(file, 'systemd-run')
      await run(shimPath('systemd-run'), args, { env: execOptions.env, timeout: execOptions.timeout ?? 5000 })
      await options.onSystemdRun?.(h)
    }
  })
  h.deck.store.run('INSERT INTO prefs(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'firstRunCompletedAt', JSON.stringify(1000), 1000)
  t?.after?.(() => h.close())
  return h
}

/**
 * A qa 1.7 checker for a page: no img, no new script, no javascript: link, no inline handler; with `controls`, no
 * raw escape, bell or bidi override in the DOM text. Returns the page's visible text.
 * @param {import('playwright-core').Page} page
 * @param {string[]} scripts the page's script elements before any payload rendered
 */
export function checker(page, scripts) {
  return async (where, { controls = true } = {}) => {
    const found = await page.evaluate(() => ({
      img: document.querySelectorAll('img').length,
      scripts: [...document.querySelectorAll('script')].map(row => row.outerHTML),
      javascript: document.querySelectorAll('[href^="javascript:" i]').length,
      handlers: [...document.querySelectorAll('*')].filter(el => [...el.attributes].some(attr => /^on/i.test(attr.name))).length,
      bold: [...document.querySelectorAll('b')].length,
      text: document.body.innerText,
      hidden: [...new Set(document.body.textContent.match(/[\u001b\u0007‮]/g) ?? [])].map(char => `U+${char.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()}`)
    }))
    assert.equal(found.img, 0, `${where}: no img element`)
    assert.deepEqual(found.scripts, scripts, `${where}: no new script element`)
    assert.equal(found.javascript, 0, `${where}: no javascript: link`)
    assert.equal(found.handlers, 0, `${where}: no inline event handler attribute`)
    assert.equal(found.bold, 0, `${where}: no b element`)
    if (controls) assert.deepEqual(found.hidden, [], `${where}: escape, bell and bidi controls never reach the DOM text raw`)
    return found.text
  }
}

/** A PermissionRequest (after its SessionStart) for an observed session, old enough to pass the popup delay. */
export function requestEnvelopes(key) {
  const now = Date.now()
  const session = { key, fixture: 'meetings' }
  return [envelopeFor(session, { e: 'SessionStart', ago: 10 }, now), envelopeFor(session, { e: 'PermissionRequest', ago: 3.1, tool_name: 'Bash', tool_input: { command: 'pwd' } }, now)]
}

if (import.meta.main) {
  isolateHost()
  // Every test gets a deadline, so a hung browser or server fails the test instead of the run.
  const spec = (name, options, fn) => typeof options === 'function' ? test(name, { timeout: 120_000 }, options) : test(name, { timeout: 120_000, ...options }, fn)
  let web
  let browser
  before(async () => {
    web = await buildWeb()
    browser = await launchBrowser()
  })
  after(async () => {
    await browser?.close()
    await web?.cleanup()
  })
  const fixedClock = page => page.clock.setFixedTime(fixtureNow())
  const rowTitles = page => page.$$eval('.meetings-row-title', rows => rows.map(row => row.textContent))
  // The bar's own text: since Task 19 the bar also holds the visually hidden skip link as its first child.
  const barText = page => page.textContent('.rec-bar-text')

  spec('host isolation: every host binary resolves to its shim, and no session bus, display, agent or token reaches a child', async () => {
    const { shimDir, runtime, removed } = isolateHost()
    for (const name of HOST_BINARIES) {
      assert.equal(execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(), path.join(shimDir, name), `${name} is the shim`)
    }
    const keys = execFileSync(process.execPath, ['-e', 'process.stdout.write(Object.keys(process.env).join("\\n"))'], { encoding: 'utf8' }).split('\n')
    assert.deepEqual(keys.filter(key => HOST_KEY.test(key)), [], 'a child inherits no host key')
    assert.equal(process.env.XDG_RUNTIME_DIR, runtime)
    process.stdout.write(`removed from the test environment: ${JSON.stringify(removed)}\n`)
  })

  spec('meetings AC1: day groups read Today, Yesterday, Thursday and the newest row is selected with its detail', async t => {
    const h = await startMeetings(t, { web: web.dir })
    const page = await openDeck(browser, h, '/meetings', { before: fixedClock })
    await page.waitForSelector('.meetings-row')
    assert.deepEqual(await page.$$eval('.meetings-group > h2', rows => rows.map(row => row.textContent)), ['Today', 'Yesterday', 'Thursday'])
    const first = page.locator('.meetings-row').first()
    assert.equal(await first.getAttribute('aria-current'), 'page', 'the first row is selected')
    assert.equal(await first.locator('.meetings-row-title').textContent(), 'Client A · weekly sync')
    await page.waitForSelector('.meeting-detail-title')
    assert.equal(await page.textContent('.meeting-detail-title'), 'Client A · weekly sync')
    assert.deepEqual(page.errors, [])
  })

  spec('meetings AC2: "feature flag" reads 4 hits in 2 meetings, hits are mark elements and the detail counts its own', async t => {
    const h = await startMeetings(t, { web: web.dir })
    const page = await openDeck(browser, h, '/meetings', { before: fixedClock })
    await page.waitForSelector('.meetings-row')
    await page.fill('#meetings-search', 'feature flag')
    await page.waitForFunction(() => document.querySelector('.meetings-search-helper')?.textContent === '4 hits in 2 meetings', null, { timeout: 5000 })
    const marks = await page.$$eval('.meetings-rows mark', rows => rows.map(row => row.textContent.toLowerCase()))
    assert.ok(marks.length >= 2 && marks.every(text => text === 'feature flag'), `hits are mark elements: ${JSON.stringify(marks)}`)
    await page.waitForSelector('.meeting-section .meeting-hits')
    assert.ok(await page.locator('h3', { hasText: '"feature flag" in this meeting · 2 hits' }).count(), 'the detail counts its own hits')
    assert.ok(await page.$$eval('.meeting-hits mark', rows => rows.length) >= 2)
  })

  spec('meetings AC3: Record opens a listbox of the config tags with pessoal selected and the confidential ones marked', async t => {
    const h = await startMeetings(t, { web: web.dir })
    const page = await openDeck(browser, h, '/meetings')
    await page.click('.meetings-record')
    await page.waitForSelector('[role="listbox"]')
    const options = await page.$$eval('[role="listbox"] [role="option"]', rows => rows.map(row => [row.textContent, row.getAttribute('aria-selected')]))
    assert.deepEqual(options, [['pessoal', 'true'], ['client-a · transcript not stored', 'false'], ['client-b · transcript not stored', 'false']])
  })

  spec('meetings AC4: choosing client-a sends exactly that start, Record shows Starting…, then the live route and the bar', async t => {
    const h = await startMeetings(t, { web: web.dir })
    // scribed answers the start after 1.5 s, so the button's waiting state is on screen long enough to read.
    h.fake.on('start', async cmd => {
      await sleep(1500)
      const id = sessionIdFor()
      h.fake.setStatus({ recording: true, session_id: id, tag: cmd.tag, elapsed_s: null, startedAt: Date.now(), asks: [] })
      return { type: 'ok', cmd: 'start', session_id: id }
    })
    const page = await openDeck(browser, h, '/meetings')
    await page.click('.meetings-record')
    await page.click('[role="option"][data-tag="client-a"]')
    await page.waitForFunction(() => document.querySelector('.meetings-record')?.textContent === 'Starting…', null, { timeout: 1000 })
    await page.waitForFunction(() => location.pathname === '/meetings/live', null, { timeout: 10_000 })
    await page.waitForSelector('.rec-bar--recording')
    assert.equal(await page.textContent('.rec-bar-label'), 'Recording')
    assert.deepEqual(h.fake.received.filter(row => row.parsed?.cmd === 'start').map(row => row.raw), ['{"cmd":"start","tag":"client-a"}'])
  })

  spec('meetings AC5: a refused start toasts "scribed refused:" with scribed\'s message verbatim in pt-BR', async t => {
    const h = await startMeetings(t, { web: web.dir })
    const message = meetingsUi.refusals.busy
    h.fake.on('start', () => ({ type: 'error', cmd: 'start', message }))
    const page = await openDeck(browser, h, '/meetings')
    await page.click('.meetings-record')
    await page.click('[role="option"][data-tag="pessoal"]')
    await page.waitForSelector('.archive-toast--error')
    assert.equal(await page.textContent('.archive-toast--error .archive-toast-text'), `scribed refused: ${message}`)
    assert.equal(await page.textContent('.archive-toast--error [lang="pt-BR"]'), message)
    assert.equal(new URL(page.url()).pathname, '/meetings', 'no navigation')
  })

  spec('meetings AC6: another client\'s recording shows the bar within 2 s without navigation; a request pops up and the bell stays silent', async t => {
    const h = await startMeetings(t, { web: web.dir, notifications: true })
    const page = await openDeck(browser, h, '/')
    const before = shimCalls().length
    const started = Date.now()
    h.otherClient('pessoal')
    // One 2 s status poll plus delivery to the page.
    await page.waitForSelector('.rec-bar--recording', { timeout: 2500 })
    const took = Date.now() - started
    assert.ok(took <= 2500, `the bar appeared after ${took} ms`)
    assert.equal(new URL(page.url()).pathname, '/', 'no navigation')
    await h.sendHooks(requestEnvelopes('ac6'))
    await until(() => shimCalls().slice(before).some(row => row.command === 'notify-send'), { timeout: 15_000, message: 'a notify-send popup' })
    await sleep(1000)
    assert.deepEqual(shimCalls().slice(before).filter(row => row.command === 'pw-play'), [], 'no bell while recording')
  })

  spec('meetings AC7: Alt P pins the current elapsed seconds, the newest line takes the pinned style, and a second Alt P within 2 s adds no pin', async t => {
    const h = await startMeetings(t, { web: web.dir })
    const recorder = await h.record('pessoal')
    h.fake.setStatus({ elapsed_s: meetingsUi.elapsedS })
    await h.push(meetingsUi.live, recorder.meetingId)
    await until(async () => (await h.recorder()).elapsedS === meetingsUi.elapsedS, { timeout: 5000, message: 'the polled elapsed seconds' })
    const page = await openDeck(browser, h, '/meetings/live')
    await page.waitForFunction(n => document.querySelectorAll('.live-log .transcript-line').length === n, meetingsUi.live.length, { timeout: 5000 })
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Alt+KeyP')
    await until(async () => (await h.pins(recorder.meetingId)).length === 1, { timeout: 5000, message: 'one pin' })
    assert.equal((await h.pins(recorder.meetingId))[0].t, meetingsUi.elapsedS, 'the pin holds the current elapsed seconds')
    await page.waitForFunction(() => [...document.querySelectorAll('.live-log .transcript-line')].at(-1)?.classList.contains('transcript-line--pinned'), null, { timeout: 5000 })
    await page.keyboard.press('Alt+KeyP')
    await sleep(500)
    assert.equal((await h.pins(recorder.meetingId)).length, 1, 'a second Alt P within 2 s merges')
    assert.equal(await page.$$eval('.live-log .transcript-line--pinned', rows => rows.length), 1, 'only the newest line is pinned')
  })

  spec('meetings AC8: Stop shows "Stopping… saving the session", ignores recording:false polls until the stop returns, and says "Still stopping" after 60 s', { timeout: 150_000 }, async t => {
    const h = await startMeetings(t, { web: web.dir, fake: { stopDelayMs: 66_000 } })
    await h.record('pessoal')
    const page = await openDeck(browser, h, '/meetings/live')
    await page.waitForSelector('.rec-bar--recording')
    const clicked = Date.now()
    await page.click('button:text-is("Stop and summarize")')
    await page.waitForSelector('.rec-bar--stopping')
    assert.equal(await barText(page), 'Stopping… saving the session')
    // The fake reports recording:false from the moment it received the stop; three polls later the bar still stops.
    await sleep(6500)
    assert.equal(h.fake.state.recording, false, 'scribed polls report recording:false')
    assert.equal((await h.recorder()).state, 'stopping')
    assert.equal(await barText(page), 'Stopping… saving the session')
    await page.waitForFunction(() => document.querySelector('.rec-bar-text')?.textContent === 'Still stopping, scribed is closing the session', null, { timeout: 70_000 })
    assert.ok(Date.now() - clicked >= 60_000, 'the slow text waits 60 s')
    await page.waitForSelector('.rec-bar', { state: 'detached', timeout: 20_000 })
  })

  spec('meetings AC9: after a confidential recording and a reload, the deck database holds no transcript or ask text', async t => {
    const conf = meetingsUi.confidential
    const h = await startMeetings(t, { web: web.dir, fake: { askDeltas: conf.deltas } })
    const recorder = await h.record(conf.tag)
    assert.equal(recorder.confidential, true)
    const page = await openDeck(browser, h, '/meetings/live')
    await h.push(conf.live, recorder.meetingId)
    await page.waitForFunction(n => document.querySelectorAll('.live-log .transcript-line').length === n, conf.live.length, { timeout: 5000 })
    await page.fill('.live-ask-input', conf.question)
    await page.press('.live-ask-input', 'Enter')
    await page.waitForFunction(text => document.querySelector('.live-ask-answer')?.textContent === text, conf.deltas.join(''), { timeout: 5000 })
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Alt+KeyP')
    await until(async () => (await h.pins(recorder.meetingId)).length === 1, { timeout: 5000, message: 'the pin' })
    await page.click('button:text-is("Stop and summarize")')
    await until(async () => (await h.recorder()).state === 'idle', { timeout: 10_000, message: 'the recorder to stop' })
    await page.reload()
    await page.waitForFunction(() => document.querySelector('main#main')?.getAttribute('aria-busy') !== 'true')
    const text = (await page.textContent('body')) ?? ''
    assert.ok(conf.sentinels.every(sentinel => !text.includes(sentinel)), 'the reloaded page shows no live text')
    const bytes = h.dbBytes()
    assert.deepEqual(conf.sentinels.filter(sentinel => bytes.includes(sentinel)), [], 'deck.db, -wal and -shm hold no sentinel')
    assert.deepEqual(h.deck.store.all("SELECT type FROM events WHERE type LIKE 'ask.%' OR type = 'meeting.transcript'"), [], 'no ask or transcript event is stored')
    assert.deepEqual(h.deck.store.all('SELECT label FROM meeting_pins').map(row => row.label), [null], 'the confidential pin stores no label')
  })

  spec('meetings AC10: with scribed down the list and detail load and the degraded card replaces Record', async t => {
    const h = await startMeetings(t, { web: web.dir, scribed: false })
    const page = await openDeck(browser, h, '/meetings', { before: fixedClock })
    await page.waitForSelector('.meetings-row')
    assert.equal((await rowTitles(page)).length, 5, 'the five past meetings are listed')
    await page.waitForSelector('.meetings-list-header .degraded-card')
    assert.equal(await page.locator('.meetings-record').count(), 0, 'Record is replaced')
    assert.equal(await page.textContent('.meetings-list-header .degraded-card-title'), 'No one on the radio')
    await page.waitForSelector('.meeting-detail-title')
    assert.equal(await page.textContent('.meeting-detail-title'), 'Client A · weekly sync')
  })

  spec('meetings AC11: an awaiting_names row reads "Needs speaker names" and its detail copies the postmeet name command', async t => {
    const h = await startMeetings(t, { web: web.dir, variants: ['awaitingNames'] })
    const id = h.tree.ids.awaitingNames
    const page = await openDeck(browser, h, '/meetings', { before: fixedClock })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.base })
    const row = page.locator(`a.meetings-row[href="/meetings/${id}"]`)
    await row.waitFor()
    assert.equal(await row.locator('.meetings-row-meta').textContent(), 'Needs speaker names')
    await row.click()
    await page.waitForSelector('.meeting-banner--hint')
    assert.equal(await page.textContent('.meeting-banner--hint .meeting-banner-text'), `Needs speaker names. Run: postmeet name ${id}`)
    await page.click('.meeting-banner--hint button:text-is("Copy")')
    await until(() => page.evaluate(() => navigator.clipboard.readText()).then(text => text === `postmeet name ${id}`), { timeout: 3000, message: 'the command on the clipboard' })
  })

  spec('meetings AC12: <b> tags in a stored transcript, a summary and a live line render as literal text', async t => {
    const h = await startMeetings(t, { web: web.dir, fixture: hostileFixture })
    const id = h.tree.ids.hostile
    const page = await openDeck(browser, h, `/meetings/${id}`)
    await page.waitForSelector('.meeting-summary')
    assert.ok((await page.textContent('.meeting-summary')).includes('<b>negrito</b>'), 'the summary shows the tags')
    await page.click('button:text-is("Full transcript")')
    await page.waitForSelector('.meeting-transcript .transcript-line')
    assert.equal(await page.locator('.meeting-transcript .transcript-line-text').first().textContent(), meetingsUi.xss.session.transcript[0].text)
    assert.equal(await page.locator('b').count(), 0, 'no b element')
    await page.keyboard.press('Escape')
    const recorder = await h.record('pessoal')
    await h.push(meetingsUi.xss.live.slice(0, 1), recorder.meetingId)
    await page.goto(`${h.base}/meetings/live`)
    await page.waitForSelector('.live-log .transcript-line')
    assert.equal(await page.textContent('.live-log .transcript-line-text'), meetingsUi.xss.live[0].text)
    assert.equal(await page.locator('b').count(), 0, 'no b element in the live view')
  })

  spec('meetings AC13: under reduced motion the rec dot is static and "Recording" and the timer stay', async t => {
    const h = await startMeetings(t, { web: web.dir })
    await h.record('pessoal')
    const page = await openDeck(browser, h, '/', { reducedMotion: 'reduce' })
    await page.waitForSelector('.rec-bar--recording')
    const dot = await page.$eval('.rec-bar-dot', node => ({ pulse: node.classList.contains('motion-rec-pulse'), animation: getComputedStyle(node).animationName }))
    assert.deepEqual(dot, { pulse: false, animation: 'none' }, 'the dot is static')
    assert.equal(await page.isVisible('.rec-bar-label'), true)
    assert.equal(await page.textContent('.rec-bar-label'), 'Recording')
    assert.equal(await page.isVisible('.rec-bar-timer'), true)
    assert.match(await page.textContent('.rec-bar-timer'), /^\d{2,}:\d{2}$/)
  })

  spec('rail-and-shell AC6: another client\'s recording shows the bar within 2 s and names the Rail item "Meetings, recording"', async t => {
    const h = await startMeetings(t, { web: web.dir })
    const page = await openDeck(browser, h, '/')
    assert.equal(await page.getAttribute('.rail-item--meetings .rail-link', 'aria-label'), 'Meetings')
    const started = Date.now()
    h.otherClient('client-b')
    await page.waitForSelector('.rec-bar--recording', { timeout: 2500 })
    assert.ok(Date.now() - started <= 2500, 'within one 2 s poll plus delivery')
    assert.equal(await page.getAttribute('.rail-item--meetings .rail-link', 'aria-label'), 'Meetings, recording')
  })

  // Finding M4-T17-F1 (S2, layout), fixed by Task 19. Task 17 measured the Rail shrinking by 16 px, not 40, while
  // recording (a content-box height on a Rail with 12 px top and bottom padding) and the shell 25 px taller than the
  // viewport (that and the 41 px bar: 40 px plus its 1 px bottom border). The recording height of the Rail now
  // subtracts its padding, and the bar is border-box so its border sits inside the 40 px token. Without the bar's
  // border-box the bar is 41 px and `.shell` scrolls 1 px inside itself, which `documentElement.scrollHeight` does
  // not see, so the last two assertions read the bar and `.shell` directly.
  spec('rail-and-shell AC6: while recording the Rail is 40 px shorter and the shell fits the viewport', async t => {
    const h = await startMeetings(t, { web: web.dir })
    const page = await openDeck(browser, h, '/')
    const sizes = () => page.evaluate(() => ({ rail: document.querySelector('nav.rail').getBoundingClientRect().height, scroll: document.documentElement.scrollHeight, inner: innerHeight }))
    const before = await sizes()
    h.otherClient('client-b')
    await page.waitForSelector('.rec-bar--recording', { timeout: 2500 })
    const during = await sizes()
    assert.equal(before.rail - during.rail, 40, 'the Rail is 40 px shorter')
    assert.ok(during.scroll <= during.inner, `the shell fits the viewport (${during.scroll} of ${during.inner} px)`)
    // The bar half (border-box): the bar is exactly the 40 px token and `.shell` does not scroll inside itself.
    const bar = await page.evaluate(() => {
      const shell = document.querySelector('.shell')
      return { bar: document.querySelector('.rec-bar').offsetHeight, scroll: shell.scrollHeight, client: shell.clientHeight }
    })
    assert.equal(bar.bar, 40, 'the bar is 40 px tall, its border included')
    assert.equal(bar.scroll, bar.client, `the shell does not overflow itself (${bar.scroll} of ${bar.client} px)`)
  })

  spec('failures-and-loading AC6: with scribed down the list loads, and only Record and the live view show the degraded card', async t => {
    const h = await startMeetings(t, { web: web.dir, scribed: false })
    const page = await openDeck(browser, h, '/meetings')
    await page.waitForSelector('.meetings-row')
    await page.waitForSelector('.meetings-list-header .degraded-card')
    assert.equal(await page.locator('.degraded-card').count(), 1, 'one card, in the Record area')
    await page.click('.meetings-row >> nth=2')
    await page.waitForSelector('.meeting-detail-title')
    assert.equal(await page.locator('.meetings-detail-pane .degraded-card').count(), 0, 'the detail has no card')
    await page.goto(`${h.base}/`)
    await page.waitForSelector('main#main')
    assert.equal(await page.locator('.degraded-card').count(), 0, 'Home has no card')
    await page.goto(`${h.base}/meetings/live`)
    await page.waitForFunction(() => document.querySelector('main#main')?.getAttribute('aria-busy') !== 'true')
    await page.waitForSelector('.degraded-card', { timeout: 5000 })
  })

  spec('"Start scribed" from the degraded card runs the systemd-run shim with the decided argv, and the card recovers when scribed answers', async t => {
    const h = await startMeetings(t, { web: web.dir, scribed: false, onSystemdRun: async deck => deck.startFake() })
    const page = await openDeck(browser, h, '/meetings')
    await page.waitForSelector('.meetings-list-header .degraded-card')
    const before = shimCalls().length
    await page.click('.degraded-card button:text-is("Start scribed")')
    await page.waitForSelector('.meetings-record', { timeout: 10_000 })
    assert.equal(await page.locator('.degraded-card').count(), 0, 'the card is gone')
    const calls = shimCalls().slice(before).filter(row => row.command === 'systemd-run')
    assert.deepEqual(calls.map(row => row.args), [[...DECIDED_ARGV]], 'the shim ran once with the decided argv')
    assert.deepEqual(calls[0].envKeys.filter(key => HOST_KEY.test(key)), [], 'systemd-run gets no session bus, display, agent or token')
    process.stdout.write(`systemd-run child environment keys: ${JSON.stringify(calls[0].envKeys)}\n`)
    assert.deepEqual(h.systemdRuns.map(row => row.file), ['systemd-run'])
  })

  spec('Home Calm shows the last meeting of today with its meta and launches its first action item', async t => {
    const h = await startMeetings(t, { web: web.dir })
    const now = Date.now()
    const calm = fixture('calm')
    await h.sendHooks(calm.sessions.flatMap(session => session.hooks.map(step => envelopeFor(session, step, now))))
    await until(() => h.deck.store.get('SELECT COUNT(*) AS n FROM sessions').n >= calm.sessions.length, { message: 'the calm sessions' })
    const page = await openDeck(browser, h, '/', { before: fixedClock })
    await page.waitForSelector('h1.calm-headline')
    await page.waitForSelector('.calm-meeting-title')
    assert.equal(await page.textContent('.calm-meeting-title'), 'Client A · weekly sync')
    assert.equal(await page.textContent('.calm-meeting-meta'), 'Today 14:00 · 42 min · 3 action items')
    const item = await page.textContent('.calm-meeting-item .calm-loop-text')
    assert.match(item, /feature flag da 3\.2/)
    await page.click('.calm-meeting-item button:text-is("Launch as session")')
    await page.waitForFunction(() => location.pathname === '/new', null, { timeout: 5000 })
    assert.equal(new URL(page.url()).searchParams.get('task'), item)
  })
}

