// Task 10: the New session form (docs/deck/screens/new-session.md, acceptance criteria 1 to 9, D-68).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, runnerImport } from 'vite'
import { chromium } from 'playwright-core'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const src = path.join(hub, 'web/src')

async function load(name) {
  const { module } = await runnerImport(path.join(src, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))

// Walk a tree of pure components, expanding function components; CrewAvatar (a memo object) is left as is.
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}
const find = (tree, predicate) => {
  const out = []
  walk(tree, node => { if (predicate(node)) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  if (typeof node.type === 'object') return ''
  return textOf(node.props?.children)
}
const buttonNamed = (tree, text) => find(tree, node => node.type === 'button' && textOf(node).startsWith(text))[0]

function fakeApi(responses = {}) {
  const calls = []
  const handle = (method, url, body) => {
    calls.push(body === undefined ? { method, url } : { method, url, body })
    const answer = responses[`${method} ${url}`]
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(typeof answer === 'function' ? answer(body) : answer)
  }
  return { calls, get: url => handle('GET', url), post: (url, body) => handle('POST', url, body), patch: (url, body) => handle('PATCH', url, body) }
}

function memoryStorage() {
  const map = new Map()
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }
}

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 1, 12, 0)

function repo(name, lastSessionAt = null, extra = {}) {
  const id = `/home/you/dev/${name}`
  return { id, repoId: id, repoKey: name, name, crew: { slot: 0, slotShared: false, seed: name, hat: 'none' }, archivedAt: null, lastSessionAt, branch: 'main', ...extra }
}

function session(id, repoName, extra = {}) {
  return { id, repoId: `/home/you/dev/${repoName}`, role: 'solo', state: 'running', alive: true, origin: 'wrapped', task: 'combat-tick', branch: 'combat-tick', ...extra }
}

function deckState({ repos = [], sessions = [], health = [{ dep: 'deckd', state: 'up' }, { dep: 'hooks', state: 'ok' }], deckdOutage = false, prefs = { scanRoot: '~/dev' } } = {}) {
  return { loaded: true, deckdOutage, data: { repos, sessions, requests: [], runs: [], order: [], health, prefs } }
}

function form(extra = {}) {
  return { query: '', repoKey: null, task: '', active: -1, open: true, submitting: false, error: null, fieldError: null, rootMissing: false, focus: 'repo', ...extra }
}

const ns = await load('screens/new-session/NewSession.jsx')

// Seven repos, so the five most recent and the alphabetical rest can both be told apart from a plain sort.
const REPOS = [
  repo('alpha', NOW - 50 * MIN), repo('bravo', NOW - 10 * MIN), repo('charlie', null), repo('delta', NOW - 30 * MIN),
  repo('echo', NOW - 1 * MIN), repo('foxtrot', NOW - 20 * MIN), repo('zulu', NOW - 5 * MIN)
]

test('an empty query lists Recent harbors first, newest session first, then the rest alphabetically (AC1)', () => {
  const model = ns.repoOptions(deckState({ repos: REPOS }), '')
  assert.deepEqual(model.groups.map(group => group.id), ['recent', 'all'])
  assert.equal(model.groups[0].label, 'Recent harbors')
  assert.deepEqual(model.groups[0].rows.map(row => row.repo.name), ['echo', 'zulu', 'bravo', 'foxtrot', 'delta'])
  assert.deepEqual(model.groups[1].rows.map(row => row.repo.name), ['alpha', 'charlie'])
  assert.deepEqual(model.rows.map(row => row.index), [0, 1, 2, 3, 4, 5, 6])
  const html = render(ns.NewSessionView, { state: deckState({ repos: REPOS }), form: form() })
  assert.ok(html.indexOf('Recent harbors') < html.indexOf('>echo<'), 'the recent eyebrow comes before its first option')
  assert.ok(html.indexOf('>echo<') < html.indexOf('>alpha<'), 'the newest repo is listed before the alphabetical rest')
})

test('a query filters repos by substring and word prefix, with no recent group, and a miss says so', () => {
  const repos = [repo('vault-mcp'), repo('rustot'), repo('fleetmates')]
  const model = ns.repoOptions(deckState({ repos }), 'mcp')
  assert.deepEqual(model.groups.map(group => group.id), ['all'])
  assert.deepEqual(model.rows.map(row => row.repo.name), ['vault-mcp'])
  assert.deepEqual(ns.repoOptions(deckState({ repos }), 'ru').rows.map(row => row.repo.name), ['rustot'])
  const html = render(ns.NewSessionView, { state: deckState({ repos }), form: form({ query: 'zzz' }) })
  assert.match(html, /No repo matches &quot;zzz&quot;\./)
})

test('each option is a named combobox option with the ~ path, branch and active count', () => {
  const state = deckState({ repos: [repo('rustot', NOW, { branch: 'combat-tick' })], sessions: [session('s1', 'rustot')] })
  const html = render(ns.NewSessionView, { state, form: form({ active: 0 }) })
  assert.match(html, /role="combobox"[^>]*aria-activedescendant="new-session-opt-0"|aria-activedescendant="new-session-opt-0"[^>]*role="combobox"/)
  assert.match(html, /role="listbox"/)
  assert.match(html, /id="new-session-opt-0"[^>]*role="option"[^>]*aria-selected="true"[^>]*aria-label="rustot, ~\/dev\/rustot, 1 active session"/)
  assert.match(html, /~\/dev\/rustot · combat-tick/)
  assert.match(html, /1 active/)
})

test('an empty scan says no repos were found and links to Settings, Connections', () => {
  const html = render(ns.NewSessionView, { state: deckState({ repos: [], prefs: { scanRoot: '~/code' } }), form: form() })
  assert.match(html, /No git repos found in ~\/code\./)
  assert.match(html, /href="\/settings\/connections"[^>]*>Change the repos folder/)
  assert.match(html, /placeholder="Search repos in ~\/code"/)
})

test('a missing scan root shows the error banner with Fix in Settings', () => {
  const html = render(ns.NewSessionView, { state: deckState({ repos: [] }), form: form({ rootMissing: true }) })
  assert.match(html, /role="alert"[^>]*>[\s\S]*The repos folder ~\/dev does not exist\./)
  assert.match(html, /Fix in Settings/)
})

test('the form is a labelled modal dialog with the copy deck title and subtitle', () => {
  const html = render(ns.NewSessionView, { state: deckState({ repos: REPOS }), form: form() })
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="new-session-title"[^>]*aria-describedby="new-session-subtitle"/)
  assert.match(html, /id="new-session-title"[^>]*>Launch a ship</)
  assert.match(html, /Pick a repo and say what to do\. The session starts in its own terminal and shows up on the Sessions grid\./)
  assert.match(html, /What should Claude do\? Leave empty to start at the prompt\./)
  assert.match(html, /Alt Enter/)
})

test('?repo= preselects the repo and puts the initial focus on Task; ?task= prefills Task (AC2)', () => {
  const state = deckState({ repos: [repo('rustot'), repo('fleetmates')] })
  const initial = ns.initialForm({ search: '?repo=rustot&task=fix%20the%20tick', state })
  assert.equal(initial.repoKey, 'rustot')
  assert.equal(initial.query, 'rustot')
  assert.equal(initial.task, 'fix the tick')
  assert.equal(initial.focus, 'task')
  const html = render(ns.NewSessionView, { state, form: form(initial) })
  assert.match(html, /<textarea[^>]*data-initial-focus="true"/)
  assert.doesNotMatch(html, /role="combobox"[^>]*data-initial-focus="true"/)
  const blank = ns.initialForm({ search: '', state })
  assert.equal(blank.focus, 'repo')
  assert.match(render(ns.NewSessionView, { state, form: form(blank) }), /role="combobox"[^>]*data-initial-focus="true"/)
})

test('a wanted repo the store does not have yet stays pending and resolves once on load, unless the user chose', () => {
  const loading = { ...deckState(), loaded: false }
  const initial = ns.initialForm({ search: '?repo=alpha&task=fix', state: loading })
  assert.equal(initial.repoKey, null)
  assert.equal(initial.pending, 'alpha')
  assert.equal(ns.resolvePending(initial, loading), null, 'nothing happens before the store loads')
  const loaded = deckState({ repos: [repo('alpha')] })
  assert.deepEqual(ns.resolvePending(initial, loaded), { pending: null, repoKey: 'alpha', query: 'alpha', open: false, active: -1, focus: 'task' })
  assert.deepEqual(ns.resolvePending({ ...initial, query: 'bet' }, loaded), { pending: null }, 'a typed query is kept')
  assert.deepEqual(ns.resolvePending({ ...initial, repoKey: 'beta', query: 'beta' }, loaded), { pending: null }, 'a picked repo is kept')
  assert.deepEqual(ns.resolvePending(initial, deckState({ repos: [repo('beta')] })), { pending: null }, 'an unknown repo is dropped')
  assert.equal(ns.resolvePending({ ...initial, pending: null }, loaded), null)
  assert.equal(ns.initialForm({ search: '?repo=alpha', state: loaded }).pending, null)
})

test('a repo with an active plain session shows the conflict banner naming it, and Launch stays enabled (AC3)', () => {
  const state = deckState({ repos: [repo('rustot')], sessions: [session('s1', 'rustot', { state: 'needs_approval' }), session('s2', 'other')] })
  const tree = ns.NewSessionView({ state, form: form({ repoKey: 'rustot', query: 'rustot', open: false }) })
  const html = renderToStaticMarkup(tree)
  assert.match(html, /role="status"[^>]*>[\s\S]*rustot already has an active session: rustot · combat-tick \(Needs approval\)\. Two plain sessions share one working tree, so their changes mix\./)
  assert.match(html, /Run as a fleetmates job/)
  assert.match(html, /Open rustot · combat-tick/)
  const launch = buttonNamed(tree, 'Launch a ship')
  assert.ok(launch, 'Launch button')
  assert.notEqual(launch.props.disabled, true)
  assert.notEqual(launch.props['aria-disabled'], 'true')
})

test('the conflict banner names two sessions then "and {n} more", and ignores ended and team sessions', () => {
  const sessions = [
    session('s1', 'rustot', { task: 'one' }), session('s2', 'rustot', { task: 'two' }), session('s3', 'rustot', { task: 'three' }),
    session('s4', 'rustot', { task: 'four', state: 'ended', alive: false }), session('s5', 'rustot', { task: 'five', role: 'lead' })
  ]
  const others = ns.conflictSessions(deckState({ sessions }).data.sessions, '/home/you/dev/rustot')
  assert.deepEqual(others.map(row => row.id), ['s1', 's2', 's3'])
  const html = render(ns.NewSessionView, { state: deckState({ repos: [repo('rustot')], sessions }), form: form({ repoKey: 'rustot', open: false }) })
  assert.match(html, /rustot · one \(Running\), rustot · two \(Running\) and 1 more\./)
  assert.doesNotMatch(render(ns.NewSessionView, { state: deckState({ repos: [repo('rustot')] }), form: form({ repoKey: 'rustot', open: false }) }), /already has an active session/)
})

test('"Run as a fleetmates job" posts mode fleetmates with the task; "Open" goes to that Focus', async () => {
  const api = fakeApi({ 'POST /api/sessions': { session: { id: 'new-1' } } })
  const routes = []
  const result = await ns.submitLaunch({ api, repoKey: 'rustot', task: 'add a boss', mode: 'fleetmates', navigate: (to, options) => routes.push([to, options]), storage: memoryStorage() })
  assert.deepEqual(api.calls, [{ method: 'POST', url: '/api/sessions', body: { repoKey: 'rustot', task: 'add a boss', mode: 'fleetmates' } }])
  assert.deepEqual(result, { ok: true, id: 'new-1' })
  assert.deepEqual(routes, [['/s/new-1', { replace: true }]])
  const opened = []
  const state = deckState({ repos: [repo('rustot')], sessions: [session('s 1', 'rustot')] })
  const tree = ns.NewSessionView({ state, form: form({ repoKey: 'rustot', open: false }), onOpenSession: id => opened.push(id) })
  const link = find(tree, node => node.type === 'a' && textOf(node) === 'Open rustot · combat-tick')[0]
  assert.equal(link.props.href, '/s/s%201')
  link.props.onClick({ preventDefault() {}, button: 0 })
  assert.deepEqual(opened, ['s 1'])
})

test('submit posts { repoKey, task }, clears the draft and replaces the route with /s/<id> (AC4)', async () => {
  const api = fakeApi({ 'POST /api/sessions': { session: { id: 'abc' } } })
  const storage = memoryStorage()
  ns.writeDraft(storage, { repo: 'rustot', task: 'old' }, NOW)
  const routes = []
  const result = await ns.submitLaunch({ api, repoKey: 'rustot', task: 'fix the tick', navigate: (to, options) => routes.push([to, options]), storage })
  assert.deepEqual(api.calls, [{ method: 'POST', url: '/api/sessions', body: { repoKey: 'rustot', task: 'fix the tick' } }])
  assert.deepEqual(result, { ok: true, id: 'abc' })
  assert.deepEqual(routes, [['/s/abc', { replace: true }]])
  assert.equal(ns.readDraft(storage, NOW), null)
})

test('an empty task is allowed and posts an empty string (AC5); no repo shows "Pick a repo." and posts nothing', async () => {
  const api = fakeApi({ 'POST /api/sessions': { session: { id: 'e1' } } })
  const result = await ns.submitLaunch({ api, repoKey: 'rustot', task: '', navigate() {}, storage: memoryStorage() })
  assert.deepEqual(result, { ok: true, id: 'e1' })
  assert.deepEqual(api.calls[0].body, { repoKey: 'rustot', task: '' })
  const none = fakeApi()
  assert.deepEqual(await ns.submitLaunch({ api: none, repoKey: null, task: 'x', navigate() {}, storage: memoryStorage() }), { fieldError: 'repo' })
  assert.equal(none.calls.length, 0)
  const html = render(ns.NewSessionView, { state: deckState({ repos: [repo('rustot')] }), form: form({ fieldError: 'repo' }) })
  assert.match(html, /Pick a repo\./)
  assert.match(html, /role="combobox"[^>]*aria-invalid="true"/)
})

test('"Run as a fleetmates job" with an empty or blank task posts nothing and marks Task', async () => {
  for (const task of ['', '   \n', null]) {
    const api = fakeApi({ 'POST /api/sessions': { session: { id: 'j1' } } })
    const routes = []
    const result = await ns.submitLaunch({ api, repoKey: 'rustot', task, mode: 'fleetmates', navigate: to => routes.push(to), storage: memoryStorage() })
    assert.deepEqual(result, { fieldError: 'task' }, JSON.stringify(task))
    assert.equal(api.calls.length, 0)
    assert.deepEqual(routes, [])
  }
})

test('Alt Enter submits, Enter alone does not, Esc cancels', () => {
  assert.deepEqual(ns.formKey({ key: 'Enter', code: 'Enter', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), { type: 'submit' })
  assert.equal(ns.formKey({ key: 'Enter', code: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }), null)
  assert.deepEqual(ns.formKey({ key: 'Escape', code: 'Escape', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }), { type: 'cancel' })
})

test('while submitting Launch is loading and the fields are read-only', () => {
  const tree = ns.NewSessionView({ state: deckState({ repos: [repo('rustot')] }), form: form({ repoKey: 'rustot', task: 't', submitting: true, open: false }) })
  const launch = buttonNamed(tree, 'Launch a ship')
  assert.equal(launch.props['aria-busy'], 'true')
  const fields = find(tree, node => node.type === 'input' || node.type === 'textarea')
  assert.equal(fields.length, 2)
  for (const field of fields) assert.equal(field.props.readOnly, true)
})

test('deckd down disables Launch with the visible reason (AC6)', () => {
  const state = deckState({ repos: [repo('rustot')], deckdOutage: true, health: [{ dep: 'deckd', state: 'down' }, { dep: 'hooks', state: 'ok' }] })
  const tree = ns.NewSessionView({ state, form: form({ repoKey: 'rustot', open: false }) })
  const launch = buttonNamed(tree, 'Launch a ship')
  assert.equal(launch.props.disabled, true)
  const html = renderToStaticMarkup(tree)
  assert.match(html, /id="new-session-launch-reason"[^>]*>deckd is reconnecting\. Launching needs deckd\.</)
  assert.equal(launch.props['aria-describedby'], 'new-session-launch-reason')
  const up = renderToStaticMarkup(ns.NewSessionView({ state: deckState({ repos: [repo('rustot')] }), form: form({ repoKey: 'rustot', open: false }) }))
  assert.doesNotMatch(up, /deckd is reconnecting/)
})

test('a spawn error shows the error banner with the message, keeps the inputs and is focusable (AC7)', async () => {
  const error = Object.assign(new Error('spawn_failed'), { status: 502, code: 'spawn_failed', details: { stderr: 'claude: not found' } })
  const api = fakeApi({ 'POST /api/sessions': error })
  const routes = []
  const result = await ns.submitLaunch({ api, repoKey: 'rustot', task: 'fix the tick', navigate: to => routes.push(to), storage: memoryStorage() })
  assert.deepEqual(result, { error: { code: 'spawn_failed', message: 'claude: not found' } })
  assert.deepEqual(routes, [])
  const html = render(ns.NewSessionView, { state: deckState({ repos: [repo('rustot')] }), form: form({ repoKey: 'rustot', query: 'rustot', task: 'fix the tick', error: result.error, open: false }) })
  assert.match(html, /role="alert"[^>]*tabindex="-1"[^>]*>[\s\S]*Could not start claude in rustot: claude: not found\./)
  assert.match(html, /value="rustot"/)
  assert.match(html, /<textarea[^>]*>fix the tick<\/textarea>/)
})

const NO_HOOKS_TEXT = 'Observation hooks are not installed, so the deck will only see this session through its terminal.'
const HOOKS_OUTDATED_TEXT = 'Hooks are from an older deck release. Run fleetmates-deck init.'

test('hooks_missing and hook_script_missing show the noHooks hint with Launch enabled; ok or no row shows neither hint', () => {
  for (const reason of ['hooks_missing', 'hook_script_missing']) {
    const down = deckState({ repos: [repo('rustot')], health: [{ dep: 'deckd', state: 'up' }, { dep: 'hooks', state: 'down', reason }] })
    const tree = ns.NewSessionView({ state: down, form: form({ repoKey: 'rustot', open: false }) })
    const html = renderToStaticMarkup(tree)
    assert.ok(html.includes(NO_HOOKS_TEXT), `${reason} shows the noHooks hint`)
    assert.ok(!html.includes(HOOKS_OUTDATED_TEXT), `${reason} does not show the outdated hint`)
    assert.notEqual(buttonNamed(tree, 'Launch a ship').props.disabled, true)
  }
  const ok = deckState({ repos: [repo('rustot')], health: [{ dep: 'deckd', state: 'down' }, { dep: 'hooks', state: 'ok' }] })
  const okHtml = render(ns.NewSessionView, { state: ok, form: form() })
  assert.ok(!okHtml.includes(NO_HOOKS_TEXT), 'an ok hooks row shows no hint, whatever deckd says')
  assert.ok(!okHtml.includes(HOOKS_OUTDATED_TEXT), 'an ok hooks row shows no outdated hint')
  const missing = deckState({ repos: [repo('rustot')], health: [{ dep: 'deckd', state: 'down' }] })
  const missingHtml = render(ns.NewSessionView, { state: missing, form: form() })
  assert.ok(!missingHtml.includes(NO_HOOKS_TEXT), 'a snapshot without the hooks row shows no hint')
  assert.ok(!missingHtml.includes(HOOKS_OUTDATED_TEXT), 'a snapshot without the hooks row shows no outdated hint')
})

test('a hooks_outdated row shows the outdated hint, not the noHooks hint, with Launch enabled', () => {
  assert.equal(ns.NEW_SESSION_COPY['newSession.hooksOutdated'], HOOKS_OUTDATED_TEXT)
  const outdated = deckState({ repos: [repo('rustot')], health: [{ dep: 'deckd', state: 'up' }, { dep: 'hooks', state: 'warn', reason: 'hooks_outdated' }] })
  const tree = ns.NewSessionView({ state: outdated, form: form({ repoKey: 'rustot', open: false }) })
  const html = renderToStaticMarkup(tree)
  assert.ok(html.includes(HOOKS_OUTDATED_TEXT), 'the outdated hint renders')
  assert.ok(!html.includes(NO_HOOKS_TEXT), 'installed but older hooks are not called missing')
  assert.notEqual(buttonNamed(tree, 'Launch a ship').props.disabled, true)
})

test('a hooks row that is not ok with an unknown reason shows neither hint, with Launch enabled', () => {
  const odd = deckState({ repos: [repo('rustot')], health: [{ dep: 'deckd', state: 'up' }, { dep: 'hooks', state: 'warn', reason: 'something_else' }] })
  const tree = ns.NewSessionView({ state: odd, form: form({ repoKey: 'rustot', open: false }) })
  const html = renderToStaticMarkup(tree)
  assert.ok(!html.includes(NO_HOOKS_TEXT), 'an unknown reason is not called missing')
  assert.ok(!html.includes(HOOKS_OUTDATED_TEXT), 'an unknown reason is not called outdated')
  assert.notEqual(buttonNamed(tree, 'Launch a ship').props.disabled, true)
})

test('the draft restores within 10 minutes and not after (AC8)', () => {
  const storage = memoryStorage()
  ns.writeDraft(storage, { repo: 'rustot', task: 'fix the tick' }, NOW)
  assert.deepEqual(JSON.parse(storage.getItem('deck.newSession')), { repo: 'rustot', task: 'fix the tick', savedAt: NOW })
  assert.deepEqual(ns.readDraft(storage, NOW + 9 * MIN), { repo: 'rustot', task: 'fix the tick', savedAt: NOW })
  assert.equal(ns.readDraft(storage, NOW + 11 * MIN), null)
  const state = deckState({ repos: [repo('rustot')] })
  const restored = ns.initialForm({ search: '', state, draft: ns.readDraft(storage, NOW + 9 * MIN) })
  assert.equal(restored.repoKey, 'rustot')
  assert.equal(restored.task, 'fix the tick')
  const expired = ns.initialForm({ search: '', state, draft: ns.readDraft(storage, NOW + 11 * MIN) })
  assert.equal(expired.repoKey, null)
  assert.equal(expired.task, '')
  storage.setItem('deck.newSession', JSON.stringify({ repo: 'rustot', task: 'x' }))
  assert.equal(ns.readDraft(storage, NOW), null, 'a draft without savedAt is not restored')
})

test('a repo named with markup renders as text (AC9)', () => {
  const evil = '<img src=x onerror=alert(1)>'
  const state = deckState({ repos: [repo(evil)], sessions: [session('s1', evil)] })
  const html = render(ns.NewSessionView, { state, form: form({ repoKey: evil, query: '', open: true }) })
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('close returns to history.state.from when it names a route, else Home', () => {
  assert.equal(ns.returnRoute({ from: '/s/abc' }), '/s/abc')
  assert.equal(ns.returnRoute({ from: '/new' }), '/')
  assert.equal(ns.returnRoute({ from: 'https://evil.example/' }), '/')
  assert.equal(ns.returnRoute(null), '/')
})

test('the scan root reads as missing only when the rescan fails with settings_io_failed', async () => {
  const missing = Object.assign(new Error('settings_io_failed'), { status: 500, code: 'settings_io_failed', details: {} })
  const api = fakeApi({ 'POST /api/repos/rescan': missing })
  assert.equal(await ns.probeScanRoot(api), true)
  assert.deepEqual(api.calls, [{ method: 'POST', url: '/api/repos/rescan' }])
  assert.equal(await ns.probeScanRoot(fakeApi({ 'POST /api/repos/rescan': { found: 0 } })), false)
  const other = Object.assign(new Error('internal'), { status: 500, code: 'internal', details: {} })
  assert.equal(await ns.probeScanRoot(fakeApi({ 'POST /api/repos/rescan': other })), false)
})

async function findChromium() {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (!candidate) continue
    try { await access(candidate)
      return candidate } catch {}
  }
  return null
}

// A page that mounts the stateful NewSession with a recording api; `window.h.load(repos)` delivers the snapshot.
const HARNESS = `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NewSession } from '@hub/web/src/screens/new-session/NewSession.jsx'

const h = window.h = { posts: [], routes: [] }
const map = new Map()
const storage = { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }
const api = {
  get: () => Promise.resolve({}),
  post: (url, body) => {
    h.posts.push({ url, body })
    return url === '/api/sessions' ? Promise.resolve({ session: { id: 'new1' } }) : Promise.resolve({ found: 0 })
  }
}
const empty = { loaded: false, deckdOutage: false, data: { repos: [], sessions: [], requests: [], runs: [], order: [], health: [], prefs: { scanRoot: '~/dev' } } }
function App() {
  const [state, setState] = useState(empty)
  h.load = repos => setState({ ...empty, loaded: true, data: { ...empty.data, repos } })
  return <NewSession search={new URLSearchParams(location.hash.slice(1)).toString() ? '?' + location.hash.slice(1) : ''} state={state} api={api}
    navigate={(to, options) => h.routes.push([to, options ?? null])} storage={storage} history={{ state: null, back() {} }} />
}
createRoot(document.getElementById('root')).render(<App />)
`

test('a ?repo= that arrives before the repos resolves once they load, and never overrides a repo the user typed', async t => {
  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the New session browser test')
  const dir = await mkdtemp(path.join(tmpdir(), 'newsess-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div id="root"></div><script type="module" src="./entry.jsx"></script></body></html>')
  await writeFile(path.join(dir, 'entry.jsx'), HARNESS)
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
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => { await browser.close()
    server.close() })
  const repos = [repo('alpha'), repo('beta')]
  const errors = []
  const open = async hash => {
    const page = await browser.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/#${hash}`)
    await page.waitForFunction(() => window.h?.load && document.querySelector('.launch-submit'), null, { timeout: 10_000 })
    return page
  }

  const page = await open('repo=alpha&task=fix')
  await page.evaluate(list => window.h.load(list), repos)
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 5000 })
  assert.equal(await page.inputValue('#new-session-repo'), 'alpha')
  assert.equal(await page.locator('.launch-list').count(), 0, 'the resolved repo closes the list')
  assert.equal(await page.inputValue('#new-session-task'), 'fix')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'new-session-task', 'the resolved repo moves focus to Task')
  await page.click('.launch-submit')
  await page.waitForFunction(() => window.h.routes.length > 0 || document.querySelector('.launch-field-error'), null, { timeout: 5000 })
  assert.deepEqual(await page.evaluate(() => window.h.posts), [{ url: '/api/sessions', body: { repoKey: 'alpha', task: 'fix' } }])
  assert.deepEqual(await page.evaluate(() => window.h.routes), [['/s/new1', { replace: true }]])

  const typed = await open('repo=alpha')
  await typed.fill('#new-session-repo', 'bet')
  await typed.evaluate(list => window.h.load(list), repos)
  await typed.waitForSelector('.launch-option', { timeout: 5000 })
  assert.equal(await typed.inputValue('#new-session-repo'), 'bet', 'the typed query stays')
  await typed.click('.launch-submit')
  await typed.waitForSelector('.launch-field-error', { timeout: 5000 })
  assert.deepEqual(await typed.evaluate(() => window.h.posts.filter(post => post.url === '/api/sessions')), [], 'no repo was chosen for the user')
  assert.deepEqual(errors, [])
})
