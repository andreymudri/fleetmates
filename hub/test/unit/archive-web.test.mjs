// Session archive on the web (docs/plans/2026-10-02-deck-archive.md, Task 5): archived sessions leave Home,
// the Focus list and the palette; Archive, Undo, "Archive all finished", the Archived list and the archived
// Focus view. Pure screens are walked as trees; one headless-Chromium test mounts the real Home route.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { findChromium } from '../helpers/chromium.mjs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, runnerImport } from 'vite'
import { chromium } from 'playwright-core'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load(rel) {
  const { module } = await runnerImport(path.join(hub, 'web/src', rel), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const NOW = Date.UTC(2026, 9, 2, 18, 42)
const MIN = 60_000
const HOUR = 60 * MIN
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))

// Walk a pure tree, expanding function components except those that hold hooks.
const KEEP = new Set(['CrewAvatar', 'TerminalView', 'ConfirmDialog', 'ArchivedSection'])
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    if (KEEP.has(node.type.name)) visit(node)
    else walk(node.type(node.props), visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}
const find = (tree, test) => {
  const out = []
  walk(tree, node => { if (test(node)) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return KEEP.has(node.type.name) ? '' : textOf(node.type(node.props))
  return textOf(node.props?.children)
}
const buttons = (tree, label) => find(tree, node => node.type === 'button' && textOf(node).trim() === label)

function session(id, name, state, extra = {}) {
  return {
    id, repoId: `/home/you/dev/${name}`, origin: 'wrapped', ptyId: `pty-${id}`, alive: true, task: `task ${id}`, branch: `br-${id}`, state,
    stateSince: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN, startedAt: NOW - HOUR, changedFiles: [], cwd: `/home/you/dev/${name}`,
    toolCalls: 2, sessionAliases: [], lastInputFrom: null, lastInputName: null, archivedAt: null, archivedBy: null, ...extra
  }
}

function deck(sessions, { requests = [], archived = 0, path: at = '/' } = {}) {
  const names = [...new Set(sessions.map(row => row.repoId.split('/').at(-1)))]
  return {
    loaded: true, deckdOutage: false,
    connection: { state: 'live', attempt: 0, nextAt: null },
    view: { path: at, overlay: null },
    data: {
      sessions, requests, runs: [], order: sessions.filter(row => row.archivedAt == null && row.state !== 'ended').map(row => row.id),
      repos: names.map((name, i) => ({ id: `/home/you/dev/${name}`, name, crew: { slot: i, seed: name, hat: 'none' } })),
      counts: { needYouSessions: 0, running: 1, toReview: 0, openRequests: 0, requestSessions: 0, oldestRequestAt: null, perRun: [], archived },
      health: [], prefs: {}, inputSources: {}, tails: {}, recap: null, setup: { firstRunCompletedAt: NOW - 1000 }
    }
  }
}

// Records every call in the createApiClient shape; `reply(method, path)` may return a body or throw.
function recordingApi(reply = () => ({})) {
  const calls = []
  const call = method => async (to, body) => {
    calls.push([method, to])
    return reply(method, to, body)
  }
  return { calls, get: call('GET'), post: call('POST'), patch: call('PATCH') }
}

const fleet = () => [
  session('run', 'rustot', 'running'),
  session('arch', 'vault', 'idle', { archivedAt: NOW - 2 * HOUR, archivedBy: 'owner' }),
  session('done', 'web', 'done', { alive: false }),
  session('idle', 'axios', 'idle')
]

test('an archived session is absent from Home, the Focus list and the palette', async () => {
  const Home = await load('screens/home/Home.jsx')
  const Focus = await load('screens/focus/Focus.jsx')
  const Palette = await load('screens/palette/Palette.jsx')
  const state = deck(fleet(), { archived: 1 })
  const layout = Home.homeLayout(state.data.sessions, { order: ['run', 'arch', 'done', 'idle'], now: NOW })
  const ids = [...layout.grid, ...layout.quiet, ...layout.strip].map(row => row.id)
  assert.deepEqual(ids.sort(), ['done', 'idle', 'run'], 'Home skips the archived session even when the order still lists it')
  const crowded = Home.homeLayout([...state.data.sessions, ...Array.from({ length: 10 }, (_, i) => session(`m${i}`, `r${i}`, 'idle'))], { now: NOW })
  assert.ok(crowded.crowded)
  assert.ok(!crowded.strip.some(row => row.id === 'arch'), 'nor does the crowded strip')
  const html = render(Home.HomeView, { state, now: NOW, navigate: () => {} })
  assert.doesNotMatch(html, /task arch/)

  const calm = deck([session('arch', 'vault', 'running', { archivedAt: NOW - HOUR, archivedBy: 'owner' }), session('d', 'web', 'idle')])
  assert.equal(Home.homeLayout(calm.data.sessions, { now: NOW }).calm, true, 'an archived running session does not keep Home out of calm')

  const focus = render(Focus.FocusView, { state, sessionId: 'run', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {} })
  const list = focus.slice(focus.indexOf('focus-list'), focus.indexOf('focus-main'))
  assert.match(list, /rustot/)
  assert.doesNotMatch(list, /vault/, 'the Focus ship list skips the archived session')

  const model = Palette.paletteModel(state, { query: '', now: NOW, expanded: ['sessions'] })
  const rows = model.rows.filter(row => row.kind === 'session').map(row => row.sessionId)
  assert.ok(rows.includes('run'))
  assert.ok(!rows.includes('arch'), 'the palette lists no archived session')
  assert.equal(Palette.paletteModel(state, { query: 'vault', now: NOW }).rows.filter(row => row.kind === 'session').length, 0)
})

test('an archived done session with unreviewed changes is absent from the calm Home open loops', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const changedFiles = [{ path: 'a.js', adds: 1, dels: 0 }]
  const state = deck([
    session('arch', 'vault', 'done', { alive: false, changedFiles, archivedAt: NOW - HOUR, archivedBy: 'owner' }),
    session('open', 'web', 'done', { alive: false, changedFiles })
  ], { archived: 1 })
  const html = render(HomeView, { state, now: NOW, navigate: () => {} })
  assert.match(html, /Calm seas\. No ships out\./, 'Home is calm')
  const loops = html.slice(html.indexOf('calm-loops-title'), html.indexOf('home-archived'))
  assert.match(loops, /web waits in port for review/, 'the unarchived done session is an open loop')
  assert.doesNotMatch(loops, /vault/, 'the archived done session is not an open loop')
  assert.doesNotMatch(html, /vault waits in port for review/)
})

test('Archive posts /archive with the id as one segment and its toast Undo posts /unarchive', async () => {
  const { archiveFlow, CARD_COPY } = await load('components/SessionCard.jsx')
  const api = recordingApi((method, to) => to.endsWith('/archive-finished') ? { ids: ['a', 'b'] } : { session: {} })
  const toasts = []
  const flow = archiveFlow({ api, show: toast => toasts.push(toast) })
  await flow.archive('team/x')
  assert.deepEqual(api.calls.splice(0), [['POST', '/api/sessions/team%2Fx/archive']])
  assert.equal(toasts.at(-1).text, 'Session archived')
  assert.equal(toasts.at(-1).tone, 'success')
  await flow.undo(toasts.at(-1).undo)
  assert.deepEqual(api.calls.splice(0), [['POST', '/api/sessions/team%2Fx/unarchive']], 'Undo calls the opposite helper')
  assert.equal(toasts.at(-1).text, 'Session restored')
  assert.equal(toasts.at(-1).undo, undefined, 'an undo is not itself undoable')

  await flow.unarchive('s1')
  assert.deepEqual(api.calls.splice(0), [['POST', '/api/sessions/s1/unarchive']])
  assert.equal(toasts.at(-1).text, 'Session restored')
  await flow.undo(toasts.at(-1).undo)
  assert.deepEqual(api.calls.splice(0), [['POST', '/api/sessions/s1/archive']])
  assert.equal(toasts.at(-1).text, 'Session archived')

  await flow.archiveFinished()
  assert.deepEqual(api.calls.splice(0), [['POST', '/api/sessions/archive-finished']])
  assert.equal(toasts.at(-1).text, 'Archived 2 finished sessions')
  await flow.undo(toasts.at(-1).undo)
  assert.deepEqual(api.calls.splice(0), [['POST', '/api/sessions/a/unarchive'], ['POST', '/api/sessions/b/unarchive']], 'Undo unarchives exactly those ids')
  assert.equal(Object.isFrozen(CARD_COPY), true)
})

test('a 409 needs_you refusal shows the needs-you text and offers no Undo', async () => {
  const { archiveFlow, ArchiveToast } = await load('components/SessionCard.jsx')
  const api = recordingApi(() => { throw Object.assign(new Error('needs you'), { status: 409, code: 'needs_you' }) })
  const toasts = []
  await archiveFlow({ api, show: toast => toasts.push(toast) }).archive('s1')
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].tone, 'error')
  assert.equal(toasts[0].text, 'This session needs you. Answer it first.')
  assert.equal(toasts[0].undo, undefined)
  const html = render(ArchiveToast, { toast: toasts[0], onUndo: () => {}, onDismiss: () => {} })
  assert.match(html, /role="alert"/)
  assert.match(html, /This session needs you\. Answer it first\./)
  assert.doesNotMatch(html, />Undo</)
})

test('cards: Archive in the SessionCard footer unless a turn runs, and in the QuietCard actions', async () => {
  const { SessionCard, QuietCard } = await load('components/SessionCard.jsx')
  const archived = []
  const onArchive = row => archived.push(row.id)
  const card = row => SessionCard({ session: row, now: NOW, onArchive })
  const done = card(session('d', 'web', 'done'))
  const [button] = buttons(done, 'Archive')
  assert.ok(button, 'a done card has Archive')
  button.props.onClick()
  assert.deepEqual(archived, ['d'])
  assert.equal(buttons(card(session('c', 'web', 'crashed', { exitCode: 1 })), 'Archive').length, 1, 'a crashed card has Archive')
  assert.equal(buttons(card(session('r', 'web', 'running')), 'Archive').length, 0, 'a running card has none')
  assert.equal(buttons(card(session('s', 'web', 'starting')), 'Archive').length, 0, 'a starting card has none')
  assert.equal(buttons(SessionCard({ session: session('d', 'web', 'done'), now: NOW }), 'Archive').length, 0, 'no handler, no button')
  const quiet = QuietCard({ session: session('q', 'web', 'idle'), now: NOW, onArchive })
  buttons(quiet, 'Archive')[0].props.onClick()
  assert.deepEqual(archived, ['d', 'q'])
})

test('"Archive all finished" shows only when a session qualifies and never counts one with changed files', async () => {
  const Home = await load('screens/home/Home.jsx')
  const requests = [{ id: 'r1', sessionId: 'asking', kind: 'permission', state: 'open', createdAt: NOW - MIN }]
  const sessions = [
    session('run', 'rustot', 'running'),
    session('changed', 'web', 'done', { alive: false, changedFiles: [{ path: 'a.js', adds: 1, dels: 0 }] }),
    session('asking', 'vault', 'needs_approval', { alive: false }),
    session('gone', 'axios', 'idle', { alive: false, archivedAt: NOW - HOUR, archivedBy: 'auto' }),
    session('alive', 'turbid', 'done')
  ]
  assert.deepEqual(Home.finishedIds(sessions, requests), [], 'live, changed, needing and archived sessions do not qualify')
  const none = Home.HomeView({ state: deck(sessions, { requests }), now: NOW, navigate: () => {}, onArchiveFinished: () => {} })
  assert.equal(buttons(none, 'Archive all finished').length, 0)

  const clean = [...sessions, session('clean', 'client', 'done', { alive: false })]
  assert.deepEqual(Home.finishedIds(clean, requests), ['clean'])
  const pressed = []
  const tree = Home.HomeView({ state: deck(clean, { requests }), now: NOW, navigate: () => {}, onArchiveFinished: () => pressed.push(1) })
  const [all] = buttons(tree, 'Archive all finished')
  assert.ok(all)
  all.props.onClick()
  assert.deepEqual(pressed, [1])
})

test('the Archived toggle shows N and is hidden at zero; the open state is kept under deck.archivedOpen', async () => {
  const Home = await load('screens/home/Home.jsx')
  const state = deck(fleet(), { archived: 3 })
  const section = find(Home.HomeView({ state, now: NOW, navigate: () => {} }), node => node.type?.name === 'ArchivedSection')
  assert.equal(section.length, 1)
  assert.equal(section[0].props.count, 3)
  const html = render(Home.HomeView, { state, now: NOW, navigate: () => {} })
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>Archived \(3\)<\/button>/)
  const zero = Home.HomeView({ state: deck(fleet(), { archived: 0 }), now: NOW, navigate: () => {} })
  assert.equal(find(zero, node => node.type?.name === 'ArchivedSection').length, 0)
  const calm = deck([session('i', 'web', 'idle')], { archived: 2 })
  assert.match(render(Home.HomeView, { state: calm, now: NOW, navigate: () => {} }), />Archived \(2\)</, 'calm Home keeps the toggle')

  const store = new Map()
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  assert.equal(Home.readArchivedOpen(storage), false)
  Home.writeArchivedOpen(storage, true)
  assert.equal(store.get('deck.archivedOpen'), 'open')
  assert.equal(Home.readArchivedOpen(storage), true)
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(Home.readArchivedOpen(broken), false, 'a throwing storage reads as closed')
  Home.writeArchivedOpen(broken, true)
})

test('Focus on an archived live session: banner, Unarchive, read-only terminal, no Stop or Nudge', async () => {
  const Focus = await load('screens/focus/Focus.jsx')
  const client = { attach: () => ({ write: () => true, resize: () => true, detach() {} }) }
  const unarchived = []
  const archivedLive = session('s1', 'rustot', 'stale', { archivedAt: NOW - HOUR, archivedBy: 'owner' })
  const state = deck([archivedLive, session('s2', 'web', 'running')], { archived: 1 })
  const props = { state, sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client,
    onArchive: () => {}, onUnarchive: () => unarchived.push('s1') }
  const tree = Focus.FocusView(props)
  const html = render(Focus.FocusView, props)
  assert.match(html, /Archived\. Unarchive to bring it back to Home\./)
  assert.doesNotMatch(html, />Stop…</, 'no Stop while archived, even live')
  assert.doesNotMatch(html, />Nudge \(send Enter\)</, 'no Nudge while archived')
  const terminal = find(tree, node => node.type?.name === 'TerminalView')
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].props.readOnly, true, 'the live terminal is read-only while archived')
  const unarchive = buttons(tree, 'Unarchive')
  assert.equal(unarchive.length, 2, 'the header and the banner both offer Unarchive')
  unarchive[0].props.onClick()
  assert.deepEqual(unarchived, ['s1'])
  assert.equal(buttons(tree, 'Archive').length, 0)

  const live = Focus.FocusView({ ...props, sessionId: 's2' })
  assert.equal(buttons(live, 'Archive').length, 1, 'a session that is not archived offers Archive in the header')
  assert.equal(buttons(live, 'Stop…').length, 1)
  assert.equal(find(live, node => node.type?.name === 'TerminalView')[0].props.readOnly, false)
  assert.doesNotMatch(render(Focus.FocusView, { ...props, sessionId: 's2' }), /Archived\. Unarchive/)
})

test('the palette offers "Archive session" for the focused session and runs it through env.archive', async () => {
  const Palette = await load('screens/palette/Palette.jsx')
  const state = deck(fleet(), { path: '/s/run' })
  const model = Palette.paletteModel(state, { query: '', now: NOW })
  const row = model.rows.find(item => item.kind === 'archive')
  assert.ok(row)
  assert.equal(row.title, 'Archive session')
  assert.equal(row.sessionId, 'run')
  assert.equal(row.group, 'actions')
  assert.equal(Palette.paletteModel(deck(fleet()), { query: '', now: NOW }).rows.some(item => item.kind === 'archive'), false, 'not on Home')
  assert.equal(Palette.paletteModel(deck(fleet(), { path: '/s/arch' }), { query: '', now: NOW }).rows.some(item => item.kind === 'archive'), false, 'not for an archived session')
  const log = []
  await Palette.runRow(row, { navigate: () => {}, leave: () => {}, onClose: () => log.push('close'), expand: () => {}, api: {}, archive: id => { log.push(id)
    return Promise.resolve() } })
  assert.deepEqual(log, ['run', 'close'])
})

test('observe.css styles the archive rows, toggle and banner with tokens only', async () => {
  const css = await readFile(path.join(hub, 'web/src/styles/observe.css'), 'utf8')
  for (const selector of ['.home-archived', '.home-archived-toggle', '.archived-row', '.archive-toast', '.focus-banner--archived']) {
    assert.ok(css.includes(selector), `observe.css styles ${selector}`)
  }
  const block = css.slice(css.indexOf('/* Archive'))
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|\brgba?\(/i, 'tokens only, no literal colors')
  for (const file of ['screens/home/Home.jsx', 'components/SessionCard.jsx', 'screens/focus/Focus.jsx', 'screens/palette/Palette.jsx']) {
    const source = await readFile(path.join(hub, 'web/src', file), 'utf8')
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
    assert.doesNotMatch(source, /import\s+['"][^'"]+\.css['"]/)
  }
})

// The real Home route with a recording API double. The archived list serves `window.h.archived` and Unarchive
// drops the row server-side, so the row leaves the page only when Home fetches the list again.
const HOME_HARNESS = `import React from 'react'
import { createRoot } from 'react-dom/client'
import { Home } from '@hub/web/src/screens/home/Home.jsx'

const h = window.h = { calls: [], archived: [] }
const now = Date.now()
const row = (id, extra) => ({ id, repoId: '/home/you/dev/rustot', origin: 'wrapped', ptyId: 'pty-' + id, alive: true, task: 'task ' + id, branch: 'b',
  state: 'running', stateSince: now, lastActivityAt: now, startedAt: now, changedFiles: [], cwd: '/home/you/dev/rustot', toolCalls: 0,
  sessionAliases: [], archivedAt: null, archivedBy: null, ...extra })
h.archived = [row('a1', { state: 'ended', alive: false, archivedAt: now - 3600000, archivedBy: 'auto' }),
  row('a2', { state: 'idle', alive: false, archivedAt: now - 7200000, archivedBy: 'owner' })]
const api = {
  async get(to) { h.calls.push('GET ' + to)
    if (to.startsWith('/api/sessions?archived=1')) return { sessions: h.archived.slice(), nextBefore: null }
    return {} },
  async post(to) { h.calls.push('POST ' + to)
    const id = decodeURIComponent(to.split('/')[3])
    if (to.endsWith('/unarchive')) h.archived = h.archived.filter(item => item.id !== id)
    return { session: {} } }
}
const state = {
  loaded: true, deckdOutage: false, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/', overlay: null },
  data: { sessions: [row('s1', {}), row('d1', { state: 'done', alive: false })], requests: [], runs: [], order: ['s1', 'd1'], health: [], prefs: {}, tails: {}, inputSources: {},
    repos: [{ id: '/home/you/dev/rustot', name: 'rustot', crew: { slot: 0, seed: 'rustot', hat: 'none' } }],
    counts: { needYouSessions: 0, running: 1, toReview: 1, openRequests: 0, requestSessions: 0, oldestRequestAt: null, perRun: [], archived: 2 },
    recap: null, setup: { firstRunCompletedAt: 1 } }
}
createRoot(document.getElementById('root')).render(<Home state={state} navigate={() => {}} api={api} storage={window.localStorage} search="" dispatch={() => {}} onOverlay={() => {}} />)
`

test('the real Home route: Archived (N) fetches archived=1 on expand, Unarchive refetches without the row, Archive and Undo post', async t => {
  const executablePath = findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the Home browser test')
  const dir = await mkdtemp(path.join(tmpdir(), 'archive-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div id="root" style="width:1600px;height:900px"></div><script type="module" src="./entry.jsx"></script></body></html>')
  await writeFile(path.join(dir, 'entry.jsx'), HOME_HARNESS)
  const out = path.join(dir, 'dist')
  await build({
    root: dir, base: './', configFile: false, logLevel: 'silent',
    resolve: { alias: { '@hub': hub, react: path.join(hub, 'node_modules/react'), 'react-dom': path.join(hub, 'node_modules/react-dom') } },
    build: { outDir: out, emptyOutDir: true }
  })
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://x').pathname
    try {
      const body = await readFile(path.join(out, name === '/' ? 'index.html' : path.normalize(name)))
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }).end(body)
    } catch { res.writeHead(404).end() }
  }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => server.close())
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const toggle = page.getByRole('button', { name: 'Archived (2)' })
  await toggle.waitFor({ timeout: 10_000 })
  const calls = () => page.evaluate(() => window.h.calls.splice(0))
  assert.deepEqual(await calls(), ['GET /api/research'], 'Home checks research while the closed archived list is not fetched')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')

  await toggle.click()
  await page.locator('.archived-row').nth(1).waitFor({ timeout: 5000 })
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  assert.deepEqual(await calls(), ['GET /api/sessions?archived=1&limit=20'])
  assert.equal(await page.evaluate(() => localStorage.getItem('deck.archivedOpen')), 'open')
  const first = await page.locator('.archived-row').first().textContent()
  assert.match(first, /task a1/)
  assert.match(first, /archived automatically/)
  assert.match(await page.locator('.archived-row').nth(1).textContent(), /archived by you/)
  assert.equal(await page.locator('.archived-row a', { hasText: 'Open' }).first().getAttribute('href'), '/s/a1')

  await page.locator('.archived-row').first().getByRole('button', { name: 'Unarchive' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.archived-row').length === 1, null, { timeout: 5000 })
  assert.deepEqual(await calls(), ['POST /api/sessions/a1/unarchive', 'GET /api/sessions?archived=1&limit=20'], 'Unarchive posts, then the list is fetched again')
  await page.locator('.archive-toast', { hasText: 'Session restored' }).waitFor({ timeout: 5000 })

  await page.locator('.session-card', { hasText: 'task d1' }).getByRole('button', { name: 'Archive' }).click()
  await page.locator('.archive-toast', { hasText: 'Session archived' }).waitFor({ timeout: 5000 })
  assert.deepEqual(await calls(), ['POST /api/sessions/d1/archive'])
  await page.locator('.archive-toast').getByRole('button', { name: 'Undo' }).click()
  await page.locator('.archive-toast', { hasText: 'Session restored' }).waitFor({ timeout: 5000 })
  const undo = await calls()
  assert.equal(undo[0], 'POST /api/sessions/d1/unarchive', 'Undo posts the opposite action')

  await page.reload()
  await page.locator('.archived-row').first().waitFor({ timeout: 10_000 })
  assert.equal(await page.getByRole('button', { name: /^Archived \(/ }).getAttribute('aria-expanded'), 'true', 'the open list survives a reload')
  assert.deepEqual(errors, [])
})
