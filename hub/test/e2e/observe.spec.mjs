// M1 Observe end to end (docs/deck/09-testing.md sections 2 and 12, 12-milestones.md section 3):
// the built app, served by the real deck server with a real SQLite store in a temporary HOME,
// driven by fake hooks (pinned 2.1.282 payloads written to the real hooks.sock), a fake deckd
// and fake setup commands, in headless Chromium through playwright-core.
//
// Not part of `npm --prefix hub test` (its glob is test/**/*.test.mjs). Run with:
//   mkdir -p /tmp/hx/e2e && TMPDIR=/tmp/hx/e2e node --test hub/test/e2e/observe.spec.mjs
// CHROMIUM_PATH overrides /usr/bin/chromium. DECK_VISUAL_DIR, when set, receives the visual
// baselines (see hub/test/visual/README.md).
//
// This file also exports the harness the other e2e suites and the perf scripts use. Its tests
// register only when it is the entry file (`import.meta.main`), so importing it runs nothing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { makeEnvelope } from '../../hook/deck-hook.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

/** Absolute path of `hub/`. */
export const hub = fileURLToPath(new URL('../..', import.meta.url))
/** The token every harness deck uses. */
export const TOKEN = 'a'.repeat(43)
/** The parsed `hub/test/fixtures/ui/observe.json`. */
export const ui = JSON.parse(await readFile(new URL('../fixtures/ui/observe.json', import.meta.url), 'utf8'))

const hookDir = new URL(`../fixtures/hooks/${ui.claudeCodeVersion}/`, import.meta.url)
const hookBase = new Map()
for (const name of await readdir(hookDir)) {
  if (name.endsWith('.json') && name !== 'MANIFEST.json') hookBase.set(name.slice(0, -5), JSON.parse(await readFile(new URL(name, hookDir), 'utf8')))
}

/**
 * The first usable Chromium or Chrome, or null.
 * @returns {Promise<string | null>}
 */
export async function findChromium() {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (!candidate) continue
    try { await access(candidate)
      return candidate } catch {}
  }
  return null
}

/**
 * Launch headless Chromium, failing loudly when none is installed.
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchBrowser() {
  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the e2e suites (set CHROMIUM_PATH)')
  return chromium.launch({ executablePath, headless: true })
}

/**
 * Build the web app once into a private temporary directory (never `hub/web/dist`).
 * @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>}
 */
export async function buildWeb() {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2e-web-'))
  execFileSync('npm', ['run', 'build', '--', '--outDir', dir], { cwd: hub, stdio: 'pipe' })
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * A fake deckd for `connectDeckd`: answers `list` and `exits`, and can go down (dropping every
 * open link) and come back. Counts connection attempts. From attempt `holdFrom` on, a connection
 * attempt neither succeeds nor fails until `release()`, so the link reports no further attempt.
 * @param {{ up?: boolean, ptys?: object[], holdFrom?: number }} [options]
 */
export function fakeDeckd({ up = true, ptys = [], holdFrom = Infinity } = {}) {
  let isUp = up
  let attempts = 0
  const links = new Set()
  const exits = []
  const held = []
  return {
    ptys,
    exits,
    /** @returns {number} connection attempts so far */
    attempts: () => attempts,
    /** The `connectDeckd` option. */
    connect: async () => {
      attempts++
      if (attempts >= holdFrom) await new Promise((_, reject) => { held.push(reject) })
      if (!isUp) throw Object.assign(Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      const listeners = new Map()
      const link = {
        request: async op => op === 'list' ? { ptys: [...ptys] } : op === 'exits' ? { exits: [...exits] } : {},
        on(event, callback) {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event).add(callback)
          return () => listeners.get(event)?.delete(callback)
        },
        emit(event, message) { for (const callback of listeners.get(event) ?? []) callback(message) },
        close() { links.delete(link) }
      }
      links.add(link)
      return link
    },
    /** Stop answering and drop every live link. */
    down() {
      isUp = false
      for (const link of [...links]) { links.delete(link)
        link.emit('close', {}) }
    },
    /** Answer the next connection attempt. */
    up() { isUp = true },
    /** Fail every held connection attempt. */
    release() { for (const reject of held.splice(0)) reject(Object.assign(Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) },
    /** Send a deckd event to every live link. */
    emit(event, message) { for (const link of links) link.emit(event, message) }
  }
}

/**
 * A pinned hook payload for `event` merged with `fields` (as fake claude does: `<event>.<variant>.json`,
 * then `<event>.json`, then any `<event>.*.json`).
 * @param {string} event
 * @param {object} fields
 * @returns {object}
 */
export function hookPayload(event, fields = {}) {
  const variant = fields.tool_name ?? fields.source ?? fields.reason ?? fields.notification_type
  const base = hookBase.get(`${event}.${variant}`) ?? hookBase.get(event) ?? [...hookBase].find(([name]) => name.startsWith(`${event}.`))?.[1] ?? {}
  return { ...structuredClone(base), ...fields, hook_event_name: event }
}

/**
 * A deck-hook envelope for one fixture event, with no process identity (an observed session whose
 * claude process the deck cannot see), so no test depends on the processes running it.
 * @param {{ key: string, fixture?: string, repo?: string }} session
 * @param {{ e: string, ago?: number, at?: number, [field: string]: any }} step
 * @param {number} now
 * @returns {object}
 */
export function envelopeFor(session, step, now) {
  const { e, ago = 0, at, ...fields } = step
  const sessionId = `fx-${session.fixture ?? 'x'}-${session.key}`
  const repo = session.repo ?? session.key
  const hook = hookPayload(e, {
    session_id: sessionId,
    cwd: `${ui.home}/${repo}`,
    transcript_path: `/home/you/.claude/projects/fixture/${sessionId}.jsonl`,
    ...(e === 'SessionStart' ? { source: 'startup' } : {}),
    ...(e === 'Stop' ? { stop_hook_active: false } : {}),
    ...fields
  })
  const envelope = makeEnvelope(hook, { hookTs: at ?? now - Math.round(ago * 1000), ptyId: null })
  return { ...envelope, pidChain: [], claudePid: null }
}

/**
 * The sessions of a fixture, with `extends` resolved.
 * @param {string} name
 * @returns {{ sessions: object[], review: string[], expect: object }}
 */
export function fixture(name) {
  const own = ui.fixtures[name]
  assert.ok(own, `no UI fixture ${name}`)
  const parent = own.extends ? fixture(own.extends) : { sessions: [], review: [], expect: {} }
  return { sessions: [...parent.sessions, ...own.sessions].map(row => ({ ...row, fixture: name })), review: [...parent.review, ...(own.review ?? [])], expect: { ...parent.expect, ...own.expect } }
}

function writeLines(socketPath, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    socket.once('error', reject)
    socket.once('connect', () => socket.end(lines.join(''), resolve))
  })
}

/**
 * Wait until `check` returns a truthy value.
 * @template T
 * @param {() => T | Promise<T>} check
 * @param {{ timeout?: number, interval?: number, message?: string }} [options]
 * @returns {Promise<T>}
 */
export async function until(check, { timeout = 10_000, interval = 20, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw Error(`timed out waiting for ${message}`)
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

/**
 * Start the real deck server on the built app with a temporary HOME, a fake deckd and fake setup commands.
 * @param {{ after?: Function }} t test context (its `after` removes everything); omit for manual `close()`
 * @param {{ web: string, port?: number, deckd?: ReturnType<typeof fakeDeckd>, firstRun?: boolean, env?: object, runCommand?: Function, services?: object, reconnectMs?: number, deckdTimeoutMs?: number, hookScript?: boolean }} options
 */
export async function startDeck(t, options) {
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'e2e-'))
  const env = { HOME: path.join(dir, 'home'), XDG_RUNTIME_DIR: path.join(dir, 'r'), ...options.env }
  const paths = setupPaths(env)
  await mkdir(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 })
  await mkdir(paths.state, { recursive: true, mode: 0o700 })
  await writeFile(paths.token, TOKEN, { mode: 0o600 })
  // `init` installs the hook script before the web server ever runs (13-operations 2.3).
  if (options.hookScript !== false) {
    await mkdir(path.dirname(paths.hook), { recursive: true, mode: 0o700 })
    await copyFile(path.join(hub, 'hook/deck-hook.mjs'), paths.hook)
  }
  const deckd = options.deckd ?? fakeDeckd()
  const commands = []
  const runCommand = options.runCommand ?? ((file, args) => {
    commands.push([file, ...args])
    if (file === 'claude') return { status: 0, stdout: `${ui.claudeCodeVersion} (Claude Code)\n`, stderr: '' }
    if (file === 'systemctl' && args.includes('is-active')) return { status: 3, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  })
  const start = port => startDeckServer({ env, port, staticDir: options.web, notifications: false, connectDeckd: deckd.connect, runCommand,
    random: () => 0.5, reconnectMs: options.reconnectMs ?? 1000, deckdTimeoutMs: options.deckdTimeoutMs, services: options.services })
  const h = {
    dir, env, paths, deckd, commands, ids: new Map(),
    deck: await start(options.port ?? 0),
    get port() { return this.deck.address()?.port ?? this.savedPort },
    get base() { return `http://127.0.0.1:${this.port}` },
    get hooksSocket() { return path.join(env.XDG_RUNTIME_DIR, 'fleetmates-deck', 'hooks.sock') },
    /** Send envelopes through hooks.sock and wait until the store has recorded every one. */
    async send(envelopes) {
      const count = () => h.deck.store.get('SELECT COUNT(*) AS n FROM hook_events').n + h.deck.store.get('SELECT COUNT(*) AS n FROM rejected_events').n
      const before = count()
      await writeLines(h.hooksSocket, envelopes.map(row => JSON.stringify(row) + '\n'))
      await until(() => count() >= before + envelopes.length, { message: `${envelopes.length} hook envelopes to be stored` })
    },
    /** Send one fixture event for a session key now. */
    async hook(key, step, repo) {
      await h.send([envelopeFor({ key, fixture: h.fixtureName, repo }, { ago: 0, ...step }, Date.now())])
    },
    /** Load a UI fixture: its hooks, then reviews, then one projector tick (stale sessions). */
    async load(name) {
      const data = fixture(name)
      h.fixtureName = name
      const now = Date.now()
      const envelopes = data.sessions.flatMap(session => session.hooks.map(step => envelopeFor(session, step, now)))
      await h.send(envelopes)
      for (const session of data.sessions) {
        const id = h.deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', `fx-${name}-${session.key}`)?.id
        assert.ok(id, `fixture session ${session.key} was not created`)
        h.ids.set(session.key, id)
      }
      for (const key of data.review) h.deck.projector.signal(h.ids.get(key), { type: 'review' }, Date.now())
      h.deck.projector.tick(Date.now())
      if (data.expect.states) {
        const states = Object.fromEntries([...h.ids].map(([key, id]) => [key, h.deck.store.get('SELECT state FROM sessions WHERE id=?', id).state]))
        assert.deepEqual(Object.fromEntries(Object.keys(data.expect.states).map(key => [key, states[key]])), data.expect.states, `fixture ${name} session states`)
      }
      return data
    },
    /** The fixture key of a session id. */
    keyOf(id) { return [...h.ids].find(([, value]) => value === id)?.[0] ?? id },
    /** Mark First run complete, as a returning user has it. */
    completeFirstRun() {
      h.deck.store.run('INSERT INTO prefs(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'firstRunCompletedAt', JSON.stringify(1000), 1000)
    },
    /** Stop the server and start a new one on the same port and state. */
    async restart() {
      await h.deck.close()
      h.deck = await start(h.savedPort)
    },
    /** Browser contexts opened on this deck by {@link openDeck}; closed with it. */
    contexts: new Set(),
    async close() {
      for (const context of h.contexts) await context.close().catch(() => {})
      await h.deck.close()
      deckd.release?.()
      await rm(dir, { recursive: true, force: true })
    }
  }
  h.savedPort = h.deck.address().port
  if (!options.firstRun) h.completeFirstRun()
  t?.after?.(() => h.close())
  return h
}

/**
 * Open the deck in a fresh browser context (cold cache) with the token in the fragment and wait for the snapshot.
 * @param {import('playwright-core').Browser} browser
 * @param {{ base: string }} h
 * @param {string} [route]
 * @param {{ viewport?: { width: number, height: number }, reducedMotion?: 'reduce' | 'no-preference', wait?: boolean, init?: Function, before?: (page: import('playwright-core').Page) => void | Promise<void>, rewrite?: (message: object) => object }} [options]
 */
export async function openDeck(browser, h, route = '/', { viewport = { width: 1920, height: 1080 }, reducedMotion = 'no-preference', wait = true, init, before, rewrite } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion })
  h.contexts?.add(context)
  const page = await context.newPage()
  // `rewrite` edits each server message on its way to the page (what a newer server could send).
  if (rewrite) {
    await page.routeWebSocket(/\/api\/ws$/, ws => {
      const server = ws.connectToServer()
      server.onMessage(message => ws.send(typeof message === 'string' ? JSON.stringify(rewrite(JSON.parse(message))) : message))
    })
  }
  page.errors = []
  page.dialogs = []
  page.on('pageerror', error => page.errors.push(error.message))
  page.on('dialog', dialog => { page.dialogs.push(dialog.message())
    dialog.dismiss().catch(() => {}) })
  if (init) await page.addInitScript(init)
  await before?.(page)
  await page.goto(`${h.base}${route}#token=${TOKEN}`)
  if (wait) await page.waitForFunction(() => document.querySelector('main#main') && document.querySelector('main#main').getAttribute('aria-busy') !== 'true', null, { timeout: 10_000 })
  return page
}

/** Session ids of the Home grid cards, in DOM order. */
export const gridIds = page => page.$$eval('.home-grid > article', cards => cards.map(card => card.getAttribute('aria-labelledby').replace(/^card-title-/, '')))
const domId = id => String(id).replace(/[^\w-]/g, '_')
/** The card article for a session id. */
export const card = (page, id) => page.locator(`article[aria-labelledby="card-title-${domId(id)}"]`)

if (import.meta.main) {
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

  const busyDeck = async t => {
    const h = await startDeck(t, { web: web.dir })
    await h.load('busy')
    return h
  }
  const keys = (h, ids) => ids.map(id => h.keyOf(id))
  const chipTexts = page => page.$$eval('.home-header .count-chip .count-label', chips => chips.map(chip => chip.textContent))
  const badge = page => page.$eval('nav[aria-label="Deck sections"]', nav => nav.querySelector('.rail-badge')?.textContent ?? null)

  spec('Home AC1: busy shows the grid in urgency order and the quiet row', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    const expect = fixture('busy').expect
    await page.waitForSelector('.home-grid > article')
    assert.deepEqual(keys(h, await gridIds(page)), expect.grid)
    const quiet = await page.$$eval('.quiet-row > article', cards => cards.map(card => card.getAttribute('aria-labelledby').replace(/^card-title-/, '')))
    assert.deepEqual(keys(h, quiet), expect.quiet)
    assert.deepEqual(page.errors, [])
  })

  spec('Home AC1: nothing scrolls with busy at 1920 x 1080', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    await page.waitForSelector('.home-grid > article')
    const overflow = await page.evaluate(() => [...document.querySelectorAll('*')].filter(el => {
      const style = getComputedStyle(el)
      return el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(style.overflowY) || el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(style.overflowX)
    }).map(el => `${el.className || el.tagName} ${el.scrollHeight}/${el.clientHeight}`).concat(document.scrollingElement.scrollHeight > innerHeight ? ['document'] : []))
    assert.deepEqual(overflow, [], 'nothing scrolls')
  })

  spec('Home AC2: chips, Rail badge and drawer subtitle read the same counts', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    const expect = fixture('busy').expect
    assert.deepEqual(await chipTexts(page), expect.chips)
    assert.equal(await badge(page), expect.badge)
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    assert.equal(await page.textContent('.drawer-subtitle'), expect.drawerSubtitle)
  })

  spec('Home AC3: a new permission request turns its card into approval within 1 s and updates chip and badge in one frame', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    await page.evaluate(() => {
      window.__frames = []
      const sample = () => {
        const chip = document.querySelector('.count-chip--needs .count-label')?.textContent
        const badge = document.querySelector('.rail-badge')?.textContent
        window.__frames.push([chip, badge])
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    const portfolio = h.ids.get('portfolio-site')
    const sent = Date.now()
    await h.hook('portfolio-site', { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run build' } })
    await card(page, portfolio).and(page.locator('.session-card--approval')).waitFor({ timeout: 5000 })
    const elapsed = Date.now() - sent
    assert.ok(elapsed < 1000, `the card became approval ${elapsed} ms after the hook (budget 1 s; PermissionRequest flushes the reorder buffer early)`)
    assert.deepEqual(await chipTexts(page), ['4 need you', '1 running', '1 to review'])
    assert.equal(await badge(page), '4')
    const frames = await page.evaluate(() => window.__frames)
    assert.ok(!frames.some(([chip, badge]) => chip === '4 need you' && badge === '3' || chip === '3 need you' && badge === '4'), 'no frame shows the chip and the badge disagreeing')
  })

  spec('Home AC3: the card that starts needing you moves ahead of the running research card', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    await h.hook('portfolio-site', { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run build' } })
    await card(page, h.ids.get('portfolio-site')).and(page.locator('.session-card--approval')).waitFor({ timeout: 5000 })
    await page.mouse.move(5, 5)
    await page.waitForTimeout(500)
    const order = keys(h, await gridIds(page))
    assert.ok(order.indexOf('portfolio-site') < order.indexOf('research'), `portfolio-site moves ahead of research: ${order.join(', ')}`)
  })

  spec('Home AC4 (pointer hysteresis): no card moves while the pointer is over the grid, until it leaves or 5 s pass', async t => {
    const h = await busyDeck(t)
    // The live order.changed messages as they reach the page, so each check runs after the reorder arrived.
    const orders = []
    const page = await openDeck(browser, h, '/', { rewrite: message => { if (message.t === 'order.changed') orders.push(message.data.order)
      return message } })
    const ahead = async (first, second) => { const order = keys(h, await gridIds(page))
      return order.indexOf(first) < order.indexOf(second) }
    const before = await gridIds(page)
    await page.hover(`#card-title-${domId(h.ids.get('research'))}`)
    await h.hook('portfolio-site', { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run build' } })
    await until(() => orders.length === 1, { message: 'the reorder to reach the page' })
    await card(page, h.ids.get('portfolio-site')).and(page.locator('.session-card--approval')).waitFor({ timeout: 5000 })
    await page.waitForTimeout(300)
    assert.deepEqual(await gridIds(page), before, 'no card moves while the pointer is over the grid')
    // Leaving applies the held order at once, well before the 5 s cap would.
    await page.mouse.move(5, 5)
    await until(() => ahead('portfolio-site', 'research'), { timeout: 500, message: 'the reorder to apply within 500 ms of the pointer leaving the grid' })

    await page.hover(`#card-title-${domId(h.ids.get('vault-mcp'))}`)
    const held = await gridIds(page)
    assert.equal(await ahead('research', 'discord-audit'), false)
    await h.hook('research', { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'curl https://example.test' } })
    const sent = Date.now()
    await until(() => orders.length === 2, { message: 'the second reorder to reach the page' })
    await page.waitForTimeout(1000)
    assert.deepEqual(await gridIds(page), held, 'still held a second later')
    await until(() => ahead('research', 'discord-audit'), { timeout: 8000, interval: 50, message: 'the reorder to apply within 5 s with the pointer still over the grid' })
    const waited = Date.now() - sent
    assert.ok(waited >= 4500 && waited < 6500, `the held reorder applied ${waited} ms after the event (at most 5 s)`)
  })

  spec('Home AC8 and read-only: observed cards with open requests say "Answer in your terminal" and hold no buttons or inputs', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    for (const key of ['rustot', 'fleetmates', 'discord-audit']) {
      const box = card(page, h.ids.get(key)).locator('.request-box')
      assert.equal(await box.locator('.request-terminal').textContent(), 'Answer in your terminal')
    }
    // Structural, not label matching: the only interactive elements inside cards are links to Focus.
    const controls = await page.$$eval('.home-grid article, .quiet-row article', cards => cards.flatMap(card =>
      [...card.querySelectorAll('button, input, select, textarea, [role="button"], [contenteditable="true"]')].map(el => el.outerHTML.slice(0, 80))))
    assert.deepEqual(controls, [], 'no button or input inside any card')
    const links = await page.$$eval('.home-grid article a, .quiet-row article a', anchors => anchors.map(a => new URL(a.href).pathname))
    assert.ok(links.length > 0 && links.every(href => href.startsWith('/s/')), 'every card link goes to a Focus route')
  })

  spec('Home AC9 and AC10: calm shows the calm headline and no cards, then switches to the grid when a session runs', async t => {
    const h = await startDeck(t, { web: web.dir })
    await h.load('calm')
    const page = await openDeck(browser, h)
    await page.waitForSelector('h1.calm-headline')
    assert.equal(await page.textContent('h1'), 'Calm seas. No ships out.')
    assert.equal(await page.locator('article').count(), 0, 'no session card in calm')
    await h.hook('turbidassist', { e: 'UserPromptSubmit', prompt: 'next order' })
    await page.waitForSelector('.home-grid > article', { timeout: 5000 })
    assert.equal(await page.textContent('h1'), 'Sessions')
  })

  spec('Home AC11 and AC12: crowded12 shows a 7-chip strip and 5 cards, stays crowded at 9 sessions and returns to normal at 8', async t => {
    const h = await startDeck(t, { web: web.dir })
    const data = await h.load('crowded12')
    const page = await openDeck(browser, h)
    await page.waitForSelector('.quiet-strip')
    const strip = await page.$$eval('.quiet-strip .strip-chip', chips => chips.map(chip => new URL(chip.href).pathname.split('/').pop()))
    assert.deepEqual(keys(h, strip.map(decodeURIComponent)), data.expect.strip)
    assert.deepEqual(keys(h, await gridIds(page)), data.expect.grid)
    const end = key => h.hook(key, { e: 'SessionEnd', reason: 'prompt_input_exit' })
    for (const key of ['mast', 'lagoon', 'isle']) await end(key)
    await until(async () => (await page.$$eval('.quiet-strip .strip-chip', chips => chips.length).catch(() => 0)) === 4, { message: 'strip to shrink to 4 chips' })
    assert.equal(await page.locator('.quiet-strip').count(), 1, '9 sessions after crowding stay crowded (hysteresis)')
    // The same 9 sessions on a fresh render, with no crowded history, are normal: the hysteresis carries across renders.
    const fresh = await openDeck(browser, h)
    await fresh.waitForSelector('.home-grid > article')
    assert.equal(await fresh.locator('.quiet-strip').count(), 0, 'a fresh render at 9 sessions is not crowded')
    await end('jetty')
    await page.waitForSelector('.quiet-strip', { state: 'detached', timeout: 5000 })
    assert.ok(await page.locator('.quiet-row > article').count() > 0, 'at 8 the quiet row returns')
  })

  spec('Home AC14: busy at 1280 x 800 has 2 columns and no horizontal scrollbar', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h, '/', { viewport: { width: 1280, height: 800 } })
    await page.waitForSelector('.home-grid > article')
    const columns = await page.$eval('.home-grid', grid => getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length)
    assert.equal(columns, 2)
    assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no horizontal scrollbar')
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('*')].every(el => !(el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)))), 'no element scrolls sideways')
  })

  spec('Home AC14: at 1280 x 800 the fleet scrolls and the header stays', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h, '/', { viewport: { width: 1280, height: 800 } })
    await page.waitForSelector('.home-grid > article')
    const header = await page.$eval('.home-header', el => el.getBoundingClientRect().top)
    await page.mouse.move(700, 600)
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(200)
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('*')].some(el => el.scrollTop > 0) || scrollY > 0), 'something scrolled')
    assert.equal(await page.$eval('.home-header', el => el.getBoundingClientRect().top), header, 'the header does not scroll with the fleet')
  })

  spec('Home AC15 and Failures AC4: with deckd down the banner counts down per attempt and pills keep updating', async t => {
    // The server's attempts run on the wall clock (1 s, 2 s, then 4 s before attempt 4), and the page compares
    // their nextProbeAt with its own clock. Neither may race the test on a loaded machine: deckd's fourth
    // connection attempt is held until teardown, so attempt 3 stays the server's last word, and the page
    // runs on Playwright's clock, paused before the deck loads, so its one-second tick fires only when the
    // test advances it.
    const deckd = fakeDeckd({ up: false, holdFrom: 4 })
    const h = await startDeck(t, { web: web.dir, deckd, deckdTimeoutMs: 3_600_000 })
    await h.load('busy')
    const page = await openDeck(browser, h, '/', { before: async p => {
      const start = Date.now()
      await p.clock.install({ time: start })
      await p.clock.pauseAt(start + 60_000)
    } })
    const text = () => page.textContent('.banner--deckd .banner-text').catch(() => null)
    await until(() => h.deck.link.health().attempt === 3 && deckd.attempts() === 4, { timeout: 15_000, interval: 50, message: 'attempt 3 to fail and attempt 4 to be held' })
    const { nextProbeAt } = h.deck.link.health()
    await until(async () => /\(attempt 3, next in \d+s\)/.test(await text() ?? ''), { timeout: 15_000, interval: 50, message: 'the attempt 3 banner' })
    // Five seconds before the next probe, then one second at a time: each tick must lower the countdown by exactly one.
    await page.clock.setSystemTime(nextProbeAt - 5000)
    const shownSeconds = async () => Number(/\(attempt 3, next in (\d)s\)/.exec(await text() ?? '')?.[1] ?? NaN)
    const seen = []
    for (const expected of [4, 3, 2]) {
      await page.clock.runFor(1000)
      await until(async () => await shownSeconds() === expected, { timeout: 2000, interval: 20, message: `next in ${expected}s` }).catch(() => {})
      seen.push(await shownSeconds())
    }
    assert.deepEqual(seen, [4, 3, 2], `the countdown advances each second: saw ${seen.join(', ')}`)
    await h.hook('research', { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'curl https://example.test' } })
    await card(page, h.ids.get('research')).locator('.pill, .status-pill, [class*="pill"]').filter({ hasText: 'Needs approval' }).first().waitFor({ timeout: 5000 })
  })

  spec('Home AC16 and Rail AC2: Alt 2 jumps to the second session, Alt Shift 2 to Memory', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    await page.keyboard.press('Alt+Digit2')
    await page.waitForFunction(id => location.pathname === `/s/${id}`, h.ids.get(fixture('busy').expect.grid[1]), { timeout: 5000 })
    await page.keyboard.press('Alt+Shift+Digit2')
    await page.waitForFunction(() => location.pathname === '/memory', null, { timeout: 5000 })
  })

  spec('Home AC18 and Failures AC9: with reduced motion nothing animates, skeletons included', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h, '/', { reducedMotion: 'reduce' })
    await page.waitForSelector('.session-card--approval')
    const running = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').map(animation => animation.animationName ?? String(animation)))
    assert.deepEqual(running, [])
    const ring = await page.$eval('.session-card--approval', el => getComputedStyle(el).boxShadow)
    t.diagnostic(`needs-you card ring under reduced motion: ${ring}`)
    assert.match(ring, /\binset\b/, 'needs-you cards keep a static ring drawn inset')
    const loading = await openDeck(browser, h, '/', { reducedMotion: 'reduce', wait: false, init: () => { window.WebSocket = class { constructor() {} close() {} send() {} addEventListener() {} } } })
    await loading.waitForSelector('.skeleton-card')
    assert.deepEqual(await loading.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length), 0)
  })

  spec('Failures AC8: before the first snapshot Home shows 6 skeleton cards, aria-busy and an sr-only loading line', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h, '/', { wait: false, init: () => { window.WebSocket = class { constructor() {} close() {} send() {} addEventListener() {} } } })
    await page.waitForSelector('.skeleton-card')
    assert.equal(await page.locator('.skeleton-card').count(), 6)
    assert.equal(await page.getAttribute('main#main', 'aria-busy'), 'true')
    assert.equal(await page.textContent('.skeleton-grid span.sr-only'), 'Loading sessions')
    assert.equal(await page.textContent('.skeleton-grid h1'), 'Sessions')
  })

  spec('Palette AC1, AC2, AC4, AC9: Alt K opens a focused combobox fast, groups follow the spec, Alt K moves up, Esc returns focus', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    const took = await page.evaluate(() => new Promise(resolve => {
      const start = performance.now()
      const observer = new MutationObserver(() => {
        if (document.activeElement?.matches('.palette-input[role="combobox"]')) { observer.disconnect()
          resolve(performance.now() - start) }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', altKey: true, bubbles: true }))
    }))
    assert.ok(took < 160, `palette focused in ${took.toFixed(1)} ms`)
    assert.equal(await page.locator('[role="dialog"] .palette-input').count(), 1)
    const first = await page.textContent('#palette-opt-0 .palette-row-title')
    assert.equal(first, 'rustot · cargo test --release combat::', 'the first option is the oldest request, rustot, read as its command')
    await page.fill('.palette-input', 'rus')
    // M2 adds the Actions group (palette.md 4.1) after Needs you and Sessions.
    assert.deepEqual(await page.$$eval('.palette-group-title', rows => rows.map(row => row.textContent)), ['Needs you', 'Sessions', 'Actions'])
    const sessions = await page.$$eval('.palette-group--sessions .palette-row--session', rows => rows.map(row => [row.querySelector('.palette-row-title').textContent, row.querySelector('kbd')?.textContent ?? null]))
    const order = fixture('busy').expect.grid.concat(fixture('busy').expect.quiet)
    assert.deepEqual(sessions, [['rustot · combat-tick', `Alt ${order.indexOf('rustot') + 1}`], ['rustot-client · ui/inventory', `Alt ${order.indexOf('rustot-client') + 1}`]])
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.getAttribute('.palette-input', 'aria-activedescendant'), 'palette-opt-1')
    await page.keyboard.press('Alt+KeyK')
    assert.equal(await page.getAttribute('.palette-input', 'aria-activedescendant'), 'palette-opt-0', 'Alt K moves the highlight up one row')
    assert.equal(await page.locator('.palette').count(), 1, 'and the palette stays open')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.palette', { state: 'detached' })
    await page.click('.home-search')
    await page.waitForSelector('.palette-input')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.palette', { state: 'detached' })
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('home-search')), 'focus returns to the search trigger')
  })

  spec('Palette M1 Enter, hover, click and scrim: Enter on a Needs row jumps to its session without answering', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    const posts = []
    page.on('request', request => { if (request.method() !== 'GET') posts.push(request.url()) })
    await page.keyboard.press('Alt+KeyK')
    await page.waitForSelector('.palette-input')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => location.pathname === `/s/${id}`, h.ids.get('rustot'), { timeout: 5000 })
    assert.equal(await page.locator('.palette').count(), 0, 'the palette closes')
    assert.deepEqual(posts, [], 'Enter sends no answer')
    await page.keyboard.press('Alt+KeyK')
    await page.waitForSelector('.palette-input')
    await page.hover('#palette-opt-2')
    assert.equal(await page.getAttribute('.palette-input', 'aria-activedescendant'), 'palette-opt-2', 'hover moves the highlight')
    await page.mouse.click(5, 5)
    await page.waitForSelector('.palette', { state: 'detached' })
    await page.keyboard.press('Alt+KeyK')
    await page.waitForSelector('.palette-input')
    await page.fill('.palette-input', 'research')
    await page.click('.palette-row--session')
    await page.waitForFunction(id => location.pathname === `/s/${id}`, h.ids.get('research'), { timeout: 5000 })
  })

  spec('Palette AC10: 15 sessions show 5 rows and "Show all 15 sessions"; only the first 9 carry Alt N', async t => {
    const h = await startDeck(t, { web: web.dir })
    await h.load('fifteen')
    const page = await openDeck(browser, h)
    await page.keyboard.press('Alt+KeyK')
    await page.waitForSelector('.palette-input')
    assert.equal(await page.locator('.palette-group--sessions .palette-row--session').count(), 5)
    const more = page.locator('.palette-group--sessions .palette-row--more')
    assert.equal(await more.textContent(), 'Show all 15 sessions')
    await more.click()
    const kbds = await page.$$eval('.palette-group--sessions .palette-row--session', rows => rows.map(row => row.querySelector('kbd')?.textContent ?? null))
    assert.equal(kbds.length, 15)
    assert.deepEqual(kbds.slice(0, 9), Array.from({ length: 9 }, (_, i) => `Alt ${i + 1}`))
    assert.deepEqual(kbds.slice(9), Array(6).fill(null))
  })

  spec('Drawer AC1, AC7, AC10: Alt U opens a read-only drawer with spec sections, M1 rows and footer', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    const expect = fixture('busy').expect
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    assert.equal(await page.textContent('#drawer-title'), 'Needs you')
    assert.equal(await page.textContent('.drawer-subtitle'), expect.drawerSubtitle)
    const sections = await page.$$eval('.drawer-section', rows => rows.map(row => [row.className.match(/drawer-section--(\w+)/)[1], row.querySelectorAll('.drawer-row').length]))
    assert.deepEqual(sections, expect.drawerSections)
    assert.ok(await page.evaluate(() => document.activeElement?.matches('.drawer-row a')), 'focus is on the first row\'s Open')
    // Structural read-only check: the drawer's only button is Close, and it has no form controls.
    const buttons = await page.$$eval('.drawer button, .drawer [role="button"]', rows => rows.map(row => row.className))
    assert.deepEqual(buttons, ['drawer-close'])
    assert.equal(await page.locator('.drawer :is(input, select, textarea, [contenteditable="true"])').count(), 0)
    const actions = await page.$$eval('.drawer-row .drawer-actions', rows => rows.map(row => [...row.children].map(child => `${child.tagName}:${child.textContent}`)))
    assert.ok(actions.every(row => JSON.stringify(row) === JSON.stringify(['SPAN:Answer in your terminal', 'A:Open'])), JSON.stringify(actions))
    assert.equal(await page.textContent('.drawer-footer'), 'Answer in your terminal for now. Answering here arrives with approvals.')
  })

  spec('Drawer: Esc and scrim clicks close it and return focus; an unknown tier is listed under Caution', async t => {
    const h = await busyDeck(t)
    // The store's CHECK constraint keeps tiers to safe, caution and destructive; a newer server could send another.
    const rustot = h.ids.get('rustot')
    const page = await openDeck(browser, h, '/', { rewrite: message => message.t === 'snapshot'
      ? { ...message, data: { ...message.data, requests: message.data.requests.map(row => row.sessionId === rustot ? { ...row, tier: 'mystery' } : row) } }
      : message })
    await page.click('.count-chip--needs')
    await page.waitForSelector('.drawer')
    const caution = await page.$$eval('.drawer-section--caution .drawer-row', rows => rows.map(row => row.getAttribute('aria-label')))
    assert.ok(caution.some(label => label.includes('cargo test --release combat::')), 'the unknown-tier request is under Caution')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.drawer', { state: 'detached' })
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('count-chip--needs')), 'focus returns to the opener')
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    await page.mouse.click(10, 500)
    await page.waitForSelector('.drawer', { state: 'detached' })
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    await page.click('.drawer-row a')
    await page.waitForSelector('#focus-title', { timeout: 5000 })
    assert.equal(await page.locator('.drawer').count(), 0, 'Open leaves the drawer for Focus')
  })

  spec('Drawer AC11: with reduced motion the drawer does not slide', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h, '/', { reducedMotion: 'reduce' })
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    const moving = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' &&
      animation.effect?.getKeyframes?.().some(frame => frame.transform && frame.transform !== 'none')).length)
    assert.equal(moving, 0)
  })

  spec('Drawer AC11: with reduced motion the drawer fades in', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h, '/', { reducedMotion: 'reduce' })
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    const fading = await page.evaluate(() => document.querySelector('.drawer').getAnimations({ subtree: true }).some(animation =>
      animation.effect?.getKeyframes?.().some(frame => frame.opacity !== undefined)))
    assert.ok(fading, 'the drawer runs an opacity animation')
  })

  spec('Counts property (qa 1.8, drawer AC2): over 200 random opens and closes the chip, badge and drawer subtitle always agree with the server', async t => {
    const h = await startDeck(t, { web: web.dir })
    const sessions = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
    const now = Date.now()
    await h.send(sessions.flatMap(key => [envelopeFor({ key, fixture: 'prop' }, { e: 'SessionStart', ago: 600 }, now), envelopeFor({ key, fixture: 'prop' }, { e: 'UserPromptSubmit', ago: 590, prompt: `task ${key}` }, now)]))
    const page = await openDeck(browser, h)
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    let seed = 0x2f6b
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff }
    const open = new Map(sessions.map(key => [key, []]))
    let hookTs = Date.now()
    let counter = 0
    // One synchronous read is one rendered frame: chip, badge and subtitle must agree in every one of them.
    const read = async step => {
      const ui = await page.evaluate(() => ({
        chip: document.querySelector('.count-chip--needs .count-label')?.textContent ?? null,
        badge: document.querySelector('.rail-badge')?.textContent ?? null,
        subtitle: document.querySelector('.drawer-subtitle')?.textContent ?? null
      }))
      const chip = ui.chip === null ? 0 : Number(ui.chip.split(' ')[0])
      const badge = ui.badge === null ? 0 : Number(ui.badge)
      const ships = ui.subtitle === null ? 0 : Number(/from (\d+) ships?/.exec(ui.subtitle)?.[1])
      assert.ok(chip === badge && badge === ships, `step ${step}: chip, badge and drawer disagree in one frame: ${JSON.stringify(ui)}`)
      return ui
    }
    for (let step = 0; step < 200; step++) {
      const key = sessions[Math.floor(random() * sessions.length)]
      const list = open.get(key)
      const closing = list.length && random() < 0.45
      hookTs += 5
      const command = closing ? list.shift() : `echo step-${counter++}`
      if (!closing) list.push(command)
      const event = closing ? 'PostToolUse' : 'PermissionRequest'
      h.deck.ingest.receive(JSON.stringify(envelopeFor({ key, fixture: 'prop' }, { e: event, at: hookTs, tool_name: 'Bash', tool_input: { command } }, 0)))
      h.deck.ingest.flush()
      const needs = [...open.values()].filter(rows => rows.length).length
      const requests = [...open.values()].reduce((sum, rows) => sum + rows.length, 0)
      const counts = h.deck.projector.snapshot().counts
      assert.equal(counts.needYouSessions, needs, `server needs-you at step ${step}`)
      assert.equal(counts.openRequests, requests, `server open requests at step ${step}`)
      const want = {
        chip: needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : null,
        badge: needs ? String(needs) : null,
        subtitle: requests ? `${requests} ${requests === 1 ? 'request' : 'requests'} from ${needs} ${needs === 1 ? 'ship' : 'ships'}` : null
      }
      let last
      await until(async () => {
        last = await read(step)
        return last.chip === want.chip && last.badge === want.badge && (last.subtitle?.split(' · ')[0] ?? null) === want.subtitle
      }, { timeout: 5000, message: `step ${step} to reach the page (want ${JSON.stringify(want)}, last ${JSON.stringify(last)})` })
    }
  })

  spec('Focus AC1, AC8, steps and ?tab=facts: the read-only layout loads steps and exposes no input', async t => {
    const h = await busyDeck(t)
    const rustot = h.ids.get('rustot')
    const steps = []
    const page = await openDeck(browser, h, `/s/${rustot}?tab=facts`, { before: tab => tab.on('request', request => { if (request.url().includes('/steps')) steps.push(new URL(request.url()).pathname) }) })
    await page.waitForSelector('#focus-title')
    assert.equal(await page.textContent('#focus-title'), 'combat-tick')
    assert.equal(await page.getAttribute('.focus-list-row[aria-current="page"]', 'href'), `/s/${rustot}`)
    const liveSessions = fixture('busy').expect.grid.length + fixture('busy').expect.quiet.length
    assert.equal(await page.locator('.focus-list-row').count(), liveSessions)
    assert.match(await page.textContent('.focus-header'), /Needs approval · 9m/)
    assert.equal(await page.textContent('.focus-banner--info'), 'Observed session: started as plain claude, read-only here.')
    assert.equal(await page.getAttribute('.focus-tab[aria-selected="true"]', 'id'), 'focus-tab-facts')
    await page.waitForSelector('.focus-steps, .focus-log-empty', { timeout: 5000 })
    assert.deepEqual(steps, [`/api/sessions/${rustot}/steps`], 'Focus fetched the session steps once')
    // Structural read-only check: no form control anywhere in Focus; its only buttons are the tabs (Mark reviewed is for done sessions).
    assert.equal(await page.locator('.focus-screen :is(input, select, textarea, [contenteditable="true"])').count(), 0)
    const buttons = await page.$$eval('.focus-screen button', rows => rows.map(row => row.getAttribute('role') ?? row.className))
    assert.ok(buttons.every(role => role === 'tab'), `only tabs are buttons: ${buttons.join(', ')}`)
    assert.equal(await page.textContent('.focus-request .request-terminal'), 'Answer in your terminal')
    await page.focus('#focus-tab-facts')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.getAttribute('.focus-tab[aria-selected="true"]', 'id'), 'focus-tab-changes')
  })

  // xterm.js adds the class `focus` to its `.xterm` element while the terminal has focus; a screen
  // class of the same name must never style it (bug 1 of docs/plans/2026-10-02-deck-termfix.md).
  spec('Focus terminal: clicking the history terminal keeps .xterm-scrollable-element as wide as .xterm at 1480 and 1280', async t => {
    const h = await busyDeck(t)
    const id = h.ids.get('vault-mcp')
    h.deck.store.run("UPDATE sessions SET origin='launched',pty_id='pty-history' WHERE id=?", id)
    h.deck.store.run('INSERT INTO session_scrollback(session_id,captured_at,text,truncated) VALUES(?,?,?,?)', id, Date.now(), 'history line\r\n', 0)
    const measured = []
    for (const width of [1480, 1280]) {
      const page = await openDeck(browser, h, `/s/${id}`, { viewport: { width, height: 900 } })
      await page.waitForSelector('.terminal-view .xterm-scrollable-element')
      await page.click('.terminal-view .xterm-screen')
      await page.waitForFunction(() => document.querySelector('.terminal-view .xterm')?.classList.contains('focus'), null, { timeout: 5000 })
      const [xterm, scrollable] = await page.$eval('.terminal-view .xterm', root => [root.getBoundingClientRect().width, root.querySelector('.xterm-scrollable-element').getBoundingClientRect().width])
      measured.push({ width, xterm, scrollable })
      // The viewport behind the scrollable element carries the theme background, not xterm.css's black.
      const [viewport, view] = await page.$eval('.terminal-view', root => [getComputedStyle(root.querySelector('.xterm-viewport')).backgroundColor, getComputedStyle(root).backgroundColor])
      assert.equal(viewport, view, `at ${width} px the xterm viewport background`)
      await page.context().close()
    }
    const wrong = measured.filter(row => Math.abs(row.xterm - row.scrollable) > 1)
    assert.deepEqual(wrong, [], wrong.map(row => `at ${row.width} px .xterm is ${row.xterm} px and .xterm-scrollable-element ${row.scrollable} px`).join('; '))
  })

  spec('Focus activity log: steps recorded from tool hooks are listed', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h, `/s/${h.ids.get('rustot')}`)
    await page.waitForSelector('.focus-steps, .focus-log-empty', { timeout: 5000 })
    assert.ok(await page.locator('.focus-step').count() > 0)
  })

  spec('Focus AC11: Mark reviewed turns a done session Reviewed and Home drops the to review chip', async t => {
    const h = await busyDeck(t)
    const id = h.ids.get('vault-mcp')
    const page = await openDeck(browser, h, `/s/${id}`)
    await page.waitForSelector('#focus-title')
    await page.click('.focus-actions button')
    await page.locator('.focus-header').filter({ hasText: 'Reviewed' }).waitFor({ timeout: 5000 })
    assert.equal(h.deck.store.get('SELECT state FROM sessions WHERE id=?', id).state, 'reviewed')
    await page.click('.focus-back')
    await page.waitForSelector('.home-header')
    assert.deepEqual(await chipTexts(page), ['3 need you', '2 running'])
  })

  spec('Rail AC1, AC4, AC5: the Sessions name carries the count; one request is announced once, three in 2 s as a burst; no toast with the drawer open', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    assert.equal(await page.getAttribute('nav[aria-label="Deck sections"] a[aria-current="page"]', 'aria-label'), 'Sessions, 3 need you')
    const live = () => page.textContent('.shell > [aria-live="polite"]')
    await page.evaluate(() => {
      window.__said = []
      new MutationObserver(() => window.__said.push(document.querySelector('.shell > [aria-live="polite"]').textContent))
        .observe(document.querySelector('.shell > [aria-live="polite"]'), { childList: true, characterData: true, subtree: true })
    })
    await h.hook('research', { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'cargo test --release combat::' } })
    await until(async () => (await live()).length > 0, { timeout: 5000, message: 'an announcement' })
    await page.waitForTimeout(2300)
    const said = (await page.evaluate(() => window.__said)).filter(Boolean)
    assert.equal(said.length, 1, `one announcement: ${JSON.stringify(said)}`)
    assert.match(said[0], /^research needs approval: .*cargo test --release combat::/)
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    const toasts = await page.locator('.toast--needs').count()
    // Three separate hook deliveries, each stored before the next is sent, all inside one 2 s window.
    const first = Date.now()
    for (const [i, key] of ['portfolio-site', 'vault-mcp', 'turbidassist'].entries()) await h.hook(key, { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: `make step-${i}` } })
    assert.ok(Date.now() - first < 2000, `the three requests arrived within 2 s (${Date.now() - first} ms)`)
    await until(async () => (await page.evaluate(() => window.__said)).filter(Boolean).length >= 2, { timeout: 5000, message: 'the burst announcement' })
    await page.waitForTimeout(2300)
    const burst = (await page.evaluate(() => window.__said)).filter(Boolean)
    assert.deepEqual(burst.slice(1), ['3 new requests'], 'one burst announcement for the three')
    assert.equal(await page.locator('.toast--needs').count(), toasts, 'no needs toast while the drawer is open')
  })

  spec('Rail AC9: 130 sessions needing you show 99+ and a (130) title', async t => {
    const h = await startDeck(t, { web: web.dir })
    const now = Date.now()
    const envelopes = []
    for (let i = 0; i < 130; i++) {
      const session = { key: `n${i}`, fixture: 'many' }
      envelopes.push(envelopeFor(session, { e: 'SessionStart', ago: 60 }, now), envelopeFor(session, { e: 'PermissionRequest', ago: 30, tool_name: 'Bash', tool_input: { command: `make ${i}` } }, now))
    }
    await h.send(envelopes)
    const page = await openDeck(browser, h)
    assert.equal(await badge(page), '99+')
    await page.waitForFunction(() => document.title.startsWith('(130) '), null, { timeout: 5000 })
  })

  spec('Drawer and cards: a question request reads as its question, not as the tool input', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer-question')
    assert.equal(await page.textContent('.drawer-question'), 'Which export format should the audit use?')
  })

  spec('Failures AC3: deckd drops, the banner shows attempt 1 then 2, and Retry now tries at once and shows attempt 3', async t => {
    const deckd = fakeDeckd()
    const h = await startDeck(t, { web: web.dir, deckd })
    await h.load('busy')
    const page = await openDeck(browser, h)
    assert.equal(await page.locator('.banner--deckd').count(), 0)
    const dropped = Date.now()
    deckd.down()
    await page.locator('.banner--deckd').filter({ hasText: '(attempt 1, next in 1s)' }).waitFor({ timeout: 1000 })
    assert.ok(Date.now() - dropped < 1000 + 200)
    await page.locator('.banner--deckd').filter({ hasText: '(attempt 2, next in 2s)' }).waitFor({ timeout: 3000 })
    const before = deckd.attempts()
    await page.click('.banner--deckd button')
    await page.locator('.banner--deckd').filter({ hasText: '(attempt 3,' }).waitFor({ timeout: 1000 })
    assert.equal(deckd.attempts(), before + 1, 'Retry now makes one immediate attempt')
    deckd.up()
    await page.click('.banner--deckd button')
    await page.waitForSelector('.banner--deckd', { state: 'detached', timeout: 3000 })
  })

  spec('Failures AC3: Retry now during an outage keeps the banner on screen', async t => {
    const deckd = fakeDeckd({ up: false })
    const h = await startDeck(t, { web: web.dir, deckd })
    await h.load('busy')
    const page = await openDeck(browser, h)
    await page.waitForSelector('.banner--deckd')
    await page.evaluate(() => {
      window.__gone = 0
      new MutationObserver(() => { if (!document.querySelector('.banner--deckd')) window.__gone++ }).observe(document.body, { childList: true, subtree: true })
    })
    await page.click('.banner--deckd button')
    await page.waitForTimeout(500)
    assert.equal(await page.evaluate(() => window.__gone), 0, 'the banner never disappears during the retry')
  })

  spec('Failures AC7, restart and reconnect: a server restart keeps the cached view dimmed with "as of", then the new server shows persisted state and new events', async t => {
    const h = await busyDeck(t)
    const page = await openDeck(browser, h)
    // One live event after the snapshot gives the page its last event time.
    await h.hook('vault-mcp', { e: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
    await page.waitForTimeout(300)
    const before = await gridIds(page)
    await h.deck.close()
    await page.waitForSelector('.shell--stale', { timeout: 10_000 })
    assert.equal(await page.locator('.skeleton-card').count(), 0, 'no skeleton with a snapshot cached')
    assert.match(await page.textContent('.banner--server'), /Lost the deck server\..*as of \d\d:\d\d/)
    assert.deepEqual(await gridIds(page), before, 'the cached cards stay')
    await h.restart()
    await page.click('.banner--server button').catch(() => {})
    await page.waitForSelector('.shell--stale', { state: 'detached', timeout: 15_000 })
    assert.deepEqual(await gridIds(page), before, 'the restarted server serves the persisted sessions')
    await h.hook('research', { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })
    await card(page, h.ids.get('research')).and(page.locator('.session-card--approval')).waitFor({ timeout: 5000 })
  })

  spec('First run AC1, AC2, AC3, AC5, AC6: hooks missing redirects to /welcome, Install hooks unblocks Set sail, completion sticks and /welcome then shows Done', async t => {
    const h = await startDeck(t, { web: web.dir, firstRun: true })
    const page = await openDeck(browser, h)
    await page.waitForFunction(() => location.pathname === '/welcome', null, { timeout: 5000 })
    const sail = page.locator('.first-run-sail')
    await sail.filter({ hasText: 'Set sail (needs hooks)' }).waitFor({ timeout: 5000 })
    assert.equal(await sail.getAttribute('aria-disabled'), 'true')
    await page.waitForFunction(() => document.activeElement?.textContent === 'Install hooks', null, { timeout: 5000 })
    await page.click('text=Install hooks')
    await page.locator('.check-row--ok[data-check="hooks"]').waitFor({ timeout: 5000 })
    await sail.filter({ hasText: /^Set sail$/ }).waitFor({ timeout: 5000 })
    assert.equal(await sail.getAttribute('aria-disabled'), null, 'scribed and notifications not ok do not block')
    assert.ok(await page.locator('.check-row[data-check="scribed"]:not(.check-row--ok)').count() === 1)
    await page.click('text=Check again')
    await until(async () => /^\d of 6 checks passed$/.test(await page.textContent('.first-run [aria-live="polite"]')), { timeout: 5000, message: 'the summary announcement' })
    const completing = page.waitForRequest(request => request.url().endsWith('/api/setup/complete') && request.method() === 'POST')
    await sail.click()
    await completing
    await page.waitForFunction(() => location.pathname === '/', null, { timeout: 5000 })
    await page.reload()
    await page.waitForFunction(() => document.querySelector('main#main')?.getAttribute('aria-busy') !== 'true', null, { timeout: 5000 })
    await page.waitForTimeout(300)
    assert.equal(new URL(page.url()).pathname, '/', 'reloading / no longer redirects')
    await page.goto(`${h.base}/welcome`)
    await page.locator('.first-run-sail').filter({ hasText: 'Done' }).waitFor({ timeout: 5000 })
  })

  spec('First run AC4: a check that never answers times out after 10 s with the check name', async t => {
    const h = await startDeck(t, { web: web.dir, firstRun: true, services: { checks: () => new Promise(() => {}) } })
    const page = await openDeck(browser, h, '/welcome')
    await page.locator('.check-row[data-check="hooks"]').filter({ hasText: 'Observation hooks did not answer in 10 s.' }).waitFor({ timeout: 12_000 })
    assert.equal(await page.locator('.check-row--checking').count(), 0)
  })

  spec('First run: a failing GET /api/setup/checks fails every automatic row with the error', async t => {
    const h = await startDeck(t, { web: web.dir, firstRun: true })
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    h.contexts.add(context)
    const page = await context.newPage()
    await page.route('**/api/setup/checks', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Request failed', retryable: false } }) }))
    await page.goto(`${h.base}/welcome#token=${TOKEN}`)
    await page.locator('.check-row--bad[data-check="hooks"]').waitFor({ timeout: 5000 })
    assert.equal(await page.locator('.check-row--checking').count(), 0)
    assert.equal(await page.getAttribute('.first-run-sail', 'aria-disabled'), 'true')
  })

  spec('First run AC7 and AC8: a newer Claude Code warns but does not block; at 1280 x 720 nothing overflows sideways', async t => {
    const h = await startDeck(t, { web: web.dir, firstRun: true, runCommand: (file, args) => file === 'claude' ? { status: 0, stdout: '2.1.999 (Claude Code)', stderr: '' } : { status: file === 'systemctl' && args.includes('is-active') ? 3 : 0, stdout: '', stderr: '' } })
    const page = await openDeck(browser, h, '/welcome', { viewport: { width: 1280, height: 720 } })
    await page.locator('.check-row--warn[data-check="claude"]').filter({ hasText: 'Claude Code 2.1.999 is newer than this deck was tested with' }).waitFor({ timeout: 5000 })
    await page.click('text=Install hooks')
    await page.locator('.first-run-sail').filter({ hasText: /^Set sail$/ }).waitFor({ timeout: 5000 })
    assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no horizontal overflow')
    assert.ok(await page.evaluate(() => document.scrollingElement.scrollHeight > innerHeight || [...document.querySelectorAll('*')].some(el => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))), 'the page scrolls vertically')
  })

  spec('Settings AC8: Send test ping runs notify-send once and updates the status line', async t => {
    const h = await startDeck(t, { web: web.dir })
    const page = await openDeck(browser, h, '/settings/notifications')
    await page.click('text=Send test ping')
    await page.locator('.setting-status--ok').waitFor({ timeout: 5000 })
    assert.equal(h.commands.filter(([file]) => file === 'notify-send').length, 1)
    assert.equal(await page.textContent('.setting-status-text'), 'Desktop notifications work through mako.')
  })

  spec('Settings: preferences save immediately and survive a reload; environment-locked ones are read-only', async t => {
    const h = await startDeck(t, { web: web.dir, env: { VAULT_PATH: '/home/you/vault' } })
    const page = await openDeck(browser, h, '/settings/notifications')
    await page.waitForSelector('#pref-bell')
    assert.equal(await page.isChecked('#pref-bell'), true)
    const saved = page.waitForResponse(response => response.url().endsWith('/api/prefs') && response.request().method() === 'PATCH')
    await page.click('#pref-bell')
    assert.equal((await saved).status(), 200)
    await page.reload()
    await page.waitForSelector('#pref-bell')
    assert.equal(await page.isChecked('#pref-bell'), false, 'the change persisted')
    await page.goto(`${h.base}/settings/connections`)
    await page.waitForSelector('#vault')
    assert.equal(await page.getAttribute('#vault', 'readonly'), '', 'VAULT_PATH from the environment is read-only')
    const form = page.locator('form', { has: page.locator('#vault') })
    assert.equal(await form.locator('button').count(), 0, 'no Save for a locked preference')
    assert.equal(await form.locator('.setting-hint').filter({ hasText: 'Set by the environment' }).count(), 1)
    assert.equal(await page.getAttribute('#pref-scanRoot', 'readonly'), null, 'unlocked preferences stay editable')
  })

  spec('Visual baselines: Home busy, calm, crowded, drawer, palette, Focus, First run and Settings render placeholders only', async t => {
    const out = process.env.DECK_VISUAL_DIR
    const shots = []
    const shoot = async (page, name, deck) => {
      const text = await page.evaluate(() => document.body.innerText)
      for (const forbidden of [process.env.USER, process.env.LOGNAME, process.env.HOME, deck.dir].filter(value => value && value.length > 2 && value !== '/home/you')) {
        assert.ok(!text.includes(forbidden), `${name} shows ${forbidden}`)
      }
      shots.push(name)
      if (out) await page.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' })
    }
    if (out) await mkdir(out, { recursive: true })
    const h = await busyDeck(t)
    // The default vault-mcp command names the maintainer's npm scope; baselines show a placeholder instead.
    h.deck.store.run('INSERT INTO prefs(key,value,updated_at) VALUES(?,?,?)', 'vaultCommand', JSON.stringify(['npx', '-y', 'vault-mcp']), 1000)
    const page = await openDeck(browser, h, '/', { reducedMotion: 'reduce' })
    await page.waitForSelector('.home-grid > article')
    await page.mouse.move(0, 0)
    await shoot(page, 'home-busy', h)
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    await shoot(page, 'drawer-busy', h)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Alt+KeyK')
    await page.waitForSelector('.palette-input')
    await shoot(page, 'palette-busy', h)
    await page.keyboard.press('Escape')
    await page.goto(`${h.base}/s/${h.ids.get('rustot')}?tab=facts`)
    await page.waitForSelector('.focus-steps, .focus-log-empty')
    await shoot(page, 'focus-rustot-facts', h)
    await page.goto(`${h.base}/settings/connections`)
    await page.waitForSelector('#pref-scanRoot')
    await shoot(page, 'settings-connections', h)
    const calm = await startDeck(t, { web: web.dir })
    await calm.load('calm')
    const calmPage = await openDeck(browser, calm, '/', { reducedMotion: 'reduce' })
    await calmPage.waitForSelector('h1.calm-headline')
    await shoot(calmPage, 'home-calm', calm)
    const crowded = await startDeck(t, { web: web.dir })
    await crowded.load('crowded12')
    const crowdedPage = await openDeck(browser, crowded, '/', { reducedMotion: 'reduce' })
    await crowdedPage.waitForSelector('.quiet-strip')
    await shoot(crowdedPage, 'home-crowded12', crowded)
    const first = await startDeck(t, { web: web.dir, firstRun: true })
    const firstPage = await openDeck(browser, first, '/welcome', { reducedMotion: 'reduce' })
    await firstPage.locator('.first-run-sail').filter({ hasText: 'Set sail (needs hooks)' }).waitFor({ timeout: 5000 })
    await shoot(firstPage, 'first-run-hooks-missing', first)
    assert.equal(shots.length, 8)
  })
}
