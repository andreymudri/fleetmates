import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import { chromium } from 'playwright-core'
import { createDeckStore, initialState, reduce } from '../../web/src/state/deck-store.js'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const src = path.join(hub, 'web/src')

async function load(name) {
  const { module } = await runnerImport(path.join(src, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const NOW = Date.UTC(2026, 8, 30, 18, 42)
const MIN = 60_000
const RLO = '‮'
const RAW = /‮/u
const TOKEN = '&lt;U\\+202E&gt;' // regex source for the visible <U+202E> token
// titleText keeps U+200B but shown tokenizes it, so it pins each `shown` call even under a titleText wrapper.
const HIDDEN = [{ ch: RLO, raw: RAW, token: TOKEN }, { ch: '\u200b', raw: /\u200b/u, token: '&lt;U\\+200B&gt;' }]

// Walk a tree of pure components (no hooks), expanding function components; CrewAvatar is skipped.
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    if (node.type.name !== 'CrewAvatar') walk(node.type(node.props), visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}
const elements = (tree, types) => {
  const out = []
  walk(tree, node => { if (types.includes(node.type)) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return node.type.name === 'CrewAvatar' ? '' : textOf(node.type(node.props))
  return textOf(node.props?.children)
}
const CONTROLS = ['button', 'a', 'input', 'select', 'textarea']
const controls = tree => elements(tree, CONTROLS)

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
const apiError = (code, details = {}, message = code) => Object.assign(new Error(message), { code, details, status: 502 })

const check = (id, state, extra = {}) => ({ id, state, blocking: id === 'hooks', detail: null, error: null, ...extra })
function checks(overrides = {}) {
  const base = { claude: check('claude', 'ok', { detail: 'Claude Code 2.1.282; tested 2.1.282' }), hooks: check('hooks', 'ok'), deckd: check('deckd', 'ok'),
    vault: check('vault', 'ok'), scribed: check('scribed', 'ok'), notify: check('notify', 'ok') }
  return ['claude', 'hooks', 'deckd', 'vault', 'scribed', 'notify'].map(id => ({ ...base[id], ...overrides[id] }))
}

function repo(name, slot) {
  return { id: `/home/you/dev/${name}`, repoId: `/home/you/dev/${name}`, name, crew: { slot, seed: name, hat: 'none' } }
}
function session(id, name, state, extra = {}) {
  return {
    id, repoId: `/home/you/dev/${name}`, origin: 'observed', task: `task ${id}`, branch: `br-${id}`, state, stateSince: NOW - 10 * MIN,
    lastActivityAt: NOW - 10 * MIN, startedAt: NOW - 60 * MIN, changedFiles: [], cwd: `/home/you/dev/${name}`, toolCalls: 4, alive: state !== 'ended', ...extra
  }
}
const counts = { needYouSessions: 0, needYouRequests: 0, running: 1, toReview: 1, sessions: 3, requestsBySession: {} }
function loaded(data = {}, connection = 'live') {
  const snapshot = {
    t: 'snapshot', epoch: 'e1', seq: 1,
    data: { sessions: [], requests: [], runs: [], repos: [], counts, order: [], recap: null, ruleOffers: [], research: [], recorder: { state: 'idle' },
      health: [], prefs: { firstRunCompletedAt: NOW - MIN }, setup: { firstRunCompletedAt: NOW - MIN }, ...data }
  }
  const state = reduce(reduce(initialState(), { type: 'resync' }), { type: 'message', message: snapshot })
  return { ...state, connection: { state: connection, attempt: connection === 'reconnecting' ? 3 : 0, nextAt: connection === 'reconnecting' ? NOW + 4000 : null } }
}

const first = await load('screens/first-run/FirstRun.jsx')
const settings = await load('screens/settings/Settings.jsx')
const failures = await load('screens/failures/Failures.jsx')
const { App } = await load('shell/App.jsx')

// ---------------------------------------------------------------- First run

test('the observation hooks check is the only one that blocks Set sail', () => {
  const { canSetSail, ChecklistView } = first
  assert.equal(canSetSail(checks()), true)
  assert.equal(canSetSail(checks({ hooks: { state: 'failed' } })), false)
  assert.equal(canSetSail(checks({ hooks: { state: 'checking' } })), false)
  assert.equal(canSetSail(checks({ hooks: { state: 'pending' } })), false)
  for (const id of ['claude', 'deckd', 'vault', 'scribed', 'notify']) {
    for (const state of ['failed', 'optional_skipped', 'pending', 'checking']) {
      assert.equal(canSetSail(checks({ [id]: { state } })), true, `${id} ${state} must not block`)
    }
  }
  const sailButton = tree => controls(tree).find(node => /first-run-sail/.test(node.props.className))

  let sailed = 0
  const props = { t: undefined, navigate: () => {}, onAction: () => {}, onCheckAgain: () => {}, onSetSail: () => { sailed++ }, onDone: () => {} }
  const blocked = ChecklistView({ ...props, checks: checks({ hooks: { state: 'failed' } }) })
  const blockedButton = sailButton(blocked)
  assert.equal(textOf(blockedButton), 'Set sail (needs hooks)')
  assert.equal(blockedButton.props['aria-disabled'], 'true')
  assert.equal(blockedButton.props.disabled, undefined, 'the blocked Set sail stays focusable so its reason is readable')
  blockedButton.props.onClick()
  assert.equal(sailed, 0)

  const open = ChecklistView({ ...props, checks: checks({ scribed: { state: 'optional_skipped' }, notify: { state: 'pending' }, deckd: { state: 'failed' }, claude: { state: 'warn', detail: 'Claude Code 2.2.0 is newer than this deck was tested with (2.1.282)' } }) })
  const openButton = sailButton(open)
  assert.equal(textOf(openButton), 'Set sail')
  assert.equal(openButton.props['aria-disabled'], undefined)
  openButton.props.onClick()
  assert.equal(sailed, 1)

  const html = render(ChecklistView, { ...props, checks: checks({ hooks: { state: 'failed' } }) })
  assert.match(html, /<button[^>]*aria-disabled="true"[^>]*>Set sail \(needs hooks\)<\/button>/)
  assert.doesNotMatch(html, /<button[^>]*disabled=""/)
})

test('each check shows its ok, failed, warning and not-checked copy and its fix action', () => {
  const { rowView } = first
  const view = (id, state, extra) => rowView(check(id, state, extra))
  assert.deepEqual(pick(view('claude', 'ok', { detail: 'Claude Code 2.1.282; tested 2.1.282' })), ['ok', 'Claude Code 2.1.282 compatible', 'Matches the pinned hook payload fixtures for this deck release', null])
  assert.deepEqual(pick(view('claude', 'warn', { detail: 'Claude Code 2.2.0 is newer than this deck was tested with (2.1.282)' })), ['warn', 'Claude Code 2.2.0 is newer than this deck was tested with', 'Hooks may differ; sessions can show wrong states.', null])
  assert.deepEqual(pick(view('claude', 'failed', { detail: 'Claude Code 2.1.200; tested 2.1.282' })), ['warn', 'Claude Code', 'Claude Code 2.1.200; tested 2.1.282', null],
    'an older Claude Code is not called newer')
  assert.deepEqual(pick(view('claude', 'failed', { detail: 'Claude Code unavailable; tested 2.1.282' })), ['warn', 'Claude Code was not found', 'Claude Code unavailable; tested 2.1.282', null],
    'the tested version in the detail is not a found version')
  assert.deepEqual(pick(view('claude', 'ok', { detail: 'Claude Code 2.1.282', drift: 3 })), ['warn', 'Claude Code 2.1.282 compatible', '3 hook payloads did not match the pinned fixtures', null])
  assert.equal(view('claude', 'ok', { drift: 1, detail: '2.1.282' }).sub, '1 hook payload did not match the pinned fixtures')
  assert.deepEqual(pick(view('hooks', 'ok')), ['ok', 'Observation hooks installed', 'Every Claude Code session on this machine reports to the deck.', null])
  assert.deepEqual(pick(view('hooks', 'failed')), ['bad', 'Observation hooks not installed', 'Needed to see sessions you start in a terminal. Adds hooks to ~/.claude/settings.json next to fleetmates.', 'firstRun.hooks.fix'])
  assert.deepEqual(pick(view('deckd', 'ok', { pid: 48213, uptime: '2 min' })), ['ok', 'deckd running', 'systemd --user · pid 48213 · up 2 min', null])
  assert.deepEqual(pick(view('deckd', 'failed')), ['bad', 'deckd is not running', 'Sessions can be watched but not launched or answered.', 'firstRun.deckd.fix'])
  assert.deepEqual(pick(view('vault', 'ok', { path: '/home/you/vault', notes: 76 })), ['ok', 'vault-mcp reachable', 'VAULT_PATH=/home/you/vault · 76 notes indexed', null])
  assert.deepEqual(pick(view('vault', 'failed', { error: 'spawn exited 1: VAULT_PATH is not a directory' })), ['bad', 'vault-mcp did not start', 'spawn exited 1: VAULT_PATH is not a directory', 'firstRun.vault.fix'])
  assert.deepEqual(pick(view('scribed', 'ok')), ['ok', 'scribed reachable', null, null])
  assert.deepEqual(pick(view('scribed', 'optional_skipped')), ['warn', 'scribed socket not found (optional)', 'Meetings will work once TurbidAssist is running.', 'firstRun.scribed.fix'])
  assert.deepEqual(pick(view('notify', 'pending')), ['todo', 'Notifications', 'Sends one test popup with the ship\'s bell through mako.', 'firstRun.notify.fix'])
  assert.deepEqual(pick(view('notify', 'ok')), ['ok', 'Test popup sent through mako', null, null])
  assert.deepEqual(pick(view('notify', 'failed', { error: 'no mako' })), ['bad', 'notify-send failed: no mako', null, 'firstRun.notify.fix'])
  assert.equal(view('hooks', 'checking').tone, 'checking')
  assert.equal(view('hooks', 'failed', { error: 'settings_io_failed' }).sub, 'settings_io_failed', 'a failed fix replaces the subtitle with its error')
  assert.equal(view('hooks', 'failed', { error: 'settings_io_failed' }).mono, true)

  const html = render(first.ChecklistRow, { view: rowView(check('scribed', 'failed')), navigate: () => {}, onAction: () => {} })
  assert.match(html, /<span class="sr-only">Warning<\/span>/)
  for (const [state, word] of [['ok', 'Passed'], ['failed', 'Failed'], ['checking', 'Checking']]) {
    assert.match(render(first.ChecklistRow, { view: rowView(check('hooks', state)), navigate: () => {}, onAction: () => {} }), new RegExp(`<span class="sr-only">${word}</span>`))
  }
  assert.match(render(first.ChecklistRow, { view: rowView(check('notify', 'pending')), navigate: () => {}, onAction: () => {} }), /<span class="sr-only">Not checked<\/span>/)
  const longError = 'x'.repeat(300)
  assert.match(render(first.ChecklistRow, { view: rowView(check('hooks', 'failed', { error: longError })), navigate: () => {}, onAction: () => {} }), /<summary>Show full error<\/summary>/)
  assert.doesNotMatch(render(first.ChecklistRow, { view: rowView(check('hooks', 'failed', { error: 'short' })), navigate: () => {}, onAction: () => {} }), /Show full error/)
})
function pick(view) {
  return [view.tone, view.title, view.sub, view.action]
}

test('a check that never answers times out with the 10 s line, and a test ping result survives a re-run', () => {
  const { reduceChecks, initialChecks, rowView, CHECK_TIMEOUT_MS, settled } = first
  assert.equal(CHECK_TIMEOUT_MS, 10_000)
  let rows = initialChecks()
  assert.deepEqual(rows.map(row => row.state), ['checking', 'checking', 'checking', 'checking', 'checking', 'pending'])
  assert.equal(settled(rows), false)
  rows = reduceChecks(rows, { type: 'result', check: check('hooks', 'ok') })
  rows = reduceChecks(rows, { type: 'timeout' })
  assert.equal(settled(rows), true)
  assert.equal(rows.find(row => row.id === 'hooks').state, 'ok', 'an answered check is not timed out')
  assert.equal(rows.find(row => row.id === 'notify').state, 'pending', 'notifications wait for the user, not the clock')
  assert.equal(rowView(rows.find(row => row.id === 'deckd')).sub, 'deckd did not answer in 10 s.')
  assert.equal(rowView(rows.find(row => row.id === 'claude')).sub, 'Claude Code did not answer in 10 s.')

  rows = reduceChecks(rows, { type: 'result', check: check('notify', 'ok') })
  rows = reduceChecks(rows, { type: 'run' })
  assert.equal(rows.find(row => row.id === 'notify').state, 'ok')
  rows = reduceChecks(rows, { type: 'result', check: check('notify', 'pending') })
  assert.equal(rows.find(row => row.id === 'notify').state, 'ok', 'a sent ping stays ok when the server reports notifications as untested')
  rows = reduceChecks(rows, { type: 'result', check: check('hooks', 'failed', { blocking: false }) })
  assert.equal(rows.find(row => row.id === 'hooks').blocking, true, 'hooks stay the blocker whatever the event says')
  rows = reduceChecks(rows, { type: 'result', check: check('deckd', 'ok', { blocking: true }) })
  assert.equal(rows.find(row => row.id === 'deckd').blocking, false, 'no other check can become a blocker')
  assert.equal(first.canSetSail(reduceChecks(rows, { type: 'result', check: check('hooks', 'ok') })), true)
})

test('fix actions call their endpoints through the given api, and a failed fix keeps the error text', async () => {
  const { runFix, reduceChecks, initialChecks, rowView } = first
  const run = async (id, responses) => {
    const api = fakeApi(responses)
    const actions = []
    const routes = []
    let reruns = 0
    await runFix(id, { api, dispatch: action => actions.push(action), navigate: to => routes.push(to), rerun: async () => { reruns++ } })
    return { calls: api.calls, actions, routes, reruns }
  }
  const hooks = await run('hooks', { 'POST /api/setup/hooks': { check: check('hooks', 'ok'), backupPath: '/home/you/.claude/settings.json.deck-backup-1' } })
  assert.deepEqual(hooks.calls, [{ method: 'POST', url: '/api/setup/hooks' }])
  assert.deepEqual(hooks.actions, [{ type: 'fix', id: 'hooks' }, { type: 'result', check: check('hooks', 'ok') }])
  assert.equal(hooks.reruns, 1, 'installing hooks re-checks, so the row resolves even without a response body')
  const after = hooks.actions.reduce(reduceChecks, initialChecks())
  assert.equal(first.canSetSail(after), true, 'installing hooks opens the gate')

  for (const dep of ['deckd', 'scribed']) {
    const started = await run(dep, { [`POST /api/deps/${dep}/start`]: { dep: { dep, state: 'checking' } } })
    assert.deepEqual(started.calls, [{ method: 'POST', url: `/api/deps/${dep}/start` }])
    assert.equal(started.reruns, 1, `${dep} start re-runs the checks`)
  }
  const ping = await run('notify', { 'POST /api/notify/test': { ok: true, via: 'notify-send' } })
  assert.deepEqual(ping.calls, [{ method: 'POST', url: '/api/notify/test' }])
  assert.equal(ping.actions.at(-1).check.state, 'ok')
  const vault = await run('vault', {})
  assert.deepEqual(vault.calls, [])
  assert.deepEqual(vault.routes, ['/settings/connections#vault'])

  const failedStart = await run('deckd', { 'POST /api/deps/deckd/start': apiError('dependency_start_failed', { stderr: 'Unit fleetmates-deckd.service not found.' }) })
  assert.equal(failedStart.reruns, 0)
  assert.deepEqual(failedStart.actions.at(-1), { type: 'fixFailed', id: 'deckd', error: 'Unit fleetmates-deckd.service not found.' })
  const failedPing = await run('notify', { 'POST /api/notify/test': apiError('notify_failed', { exitCode: 1 }) })
  const rows = failedPing.actions.reduce(reduceChecks, initialChecks())
  assert.equal(rowView(rows.find(row => row.id === 'notify')).title, 'notify-send failed: exit 1')
  const failedHooks = await run('hooks', { 'POST /api/setup/hooks': apiError('settings_io_failed', {}, 'Could not write settings') })
  const hookRow = failedHooks.actions.reduce(reduceChecks, initialChecks()).find(row => row.id === 'hooks')
  assert.equal(hookRow.state, 'failed')
  assert.equal(rowView(hookRow).sub, 'Could not write settings')

  let fixed = null
  const tree = first.ChecklistView({ checks: checks({ hooks: { state: 'failed' }, deckd: { state: 'failed' }, scribed: { state: 'failed' }, notify: { state: 'pending' } }),
    navigate: () => {}, onAction: id => { fixed = id }, onCheckAgain: () => {}, onSetSail: () => {}, onDone: () => {} })
  for (const [label, id] of [['Install hooks', 'hooks'], ['Start deckd', 'deckd'], ['Start scribed', 'scribed'], ['Send test ping', 'notify']]) {
    const button = controls(tree).find(node => textOf(node) === label)
    assert.ok(button, label)
    button.props.onClick()
    assert.equal(fixed, id, `${label} runs the ${id} fix`)
  }
  const busy = first.ChecklistView({ checks: checks({ hooks: { state: 'failed' } }), busy: { hooks: true }, navigate: () => {}, onAction: id => { fixed = `again ${id}` }, onCheckAgain: () => {}, onSetSail: () => {}, onDone: () => {} })
  const loading = controls(busy).find(node => textOf(node).includes('Install hooks'))
  assert.equal(loading.props['aria-busy'], 'true')
  loading.props.onClick()
  assert.notEqual(fixed, 'again hooks', 'a running fix is not started twice')
})

test('the checklist offers only its own controls, links through navigate and announces the run summary', () => {
  const { ChecklistView, summaryText } = first
  const noop = () => {}
  const routes = []
  const base = { navigate: to => routes.push(to), onAction: noop, onCheckAgain: noop, onSetSail: noop, onDone: noop }
  const failing = checks({ hooks: { state: 'failed' }, deckd: { state: 'failed' }, vault: { state: 'failed' }, scribed: { state: 'optional_skipped' }, notify: { state: 'pending' } })
  const labels = tree => controls(tree).map(node => `${node.type}:${textOf(node)}`).sort()
  assert.deepEqual(labels(ChecklistView({ ...base, checks: failing })), ['a:Fix in Settings', 'button:Check again', 'button:Install hooks', 'button:Send test ping',
    'button:Set sail (needs hooks)', 'button:Start deckd', 'button:Start scribed'])
  assert.deepEqual(labels(ChecklistView({ ...base, checks: checks() })), ['button:Check again', 'button:Set sail'])
  assert.deepEqual(labels(ChecklistView({ ...base, checks: checks(), mode: 'rerun' })), ['button:Check again', 'button:Done'])
  assert.deepEqual(labels(ChecklistView({ ...base, checks: checks(), mode: 'done' })), ['button:Check again', 'button:Done'])
  const fix = controls(ChecklistView({ ...base, checks: failing })).find(node => node.type === 'a')
  let prevented = false
  fix.props.onClick({ button: 0, defaultPrevented: false, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(routes, ['/settings/connections#vault'])
  assert.equal(fix.props.href, '/settings/connections#vault')

  const fixture = checks({ notify: { state: 'pending' } })
  assert.equal(summaryText(fixture), '5 of 6 checks passed')
  const html = render(ChecklistView, { ...base, checks: fixture, announcement: summaryText(fixture) })
  assert.match(html, /<div class="sr-only" role="status" aria-live="polite">5 of 6 checks passed<\/div>/)
  const welcome = render(ChecklistView, { ...base, checks: failing })
  assert.match(welcome, /<h1 class="first-run-title">Welcome aboard the deck<\/h1>/)
  assert.match(welcome, /Re-run anytime from Settings, Connections/)
  assert.equal((welcome.match(/<li class="check-row/g) ?? []).length, 6)
  assert.doesNotMatch(render(ChecklistView, { ...base, checks: failing, mode: 'rerun' }), /<h1/, 'the inline checklist has no page heading')
})

test('every server string in the checklist is shown with visible tokens, one field at a time', () => {
  const { ChecklistView, ChecklistRow, rowView } = first
  const noop = () => {}
  const row = c => render(ChecklistRow, { view: rowView(c), navigate: noop, onAction: noop })
  const cases = ch => ({
    version: check('claude', 'warn', { detail: `Claude Code 2.2.0${ch} is newer`, version: `2.2.0${ch}` }),
    missingDetail: check('claude', 'failed', { detail: `unavailable ${ch}` }),
    okVersion: check('claude', 'ok', { version: `2.1.282${ch}` }),
    claudeError: check('claude', 'failed', { detail: 'Claude Code 2.2.0', error: `boom ${ch}` }),
    hooksError: check('hooks', 'failed', { error: `EACCES ${ch}` }),
    deckdError: check('deckd', 'failed', { error: `no unit ${ch}` }),
    deckdPid: check('deckd', 'ok', { pid: `48213${ch}`, uptime: '2 min' }),
    deckdUptime: check('deckd', 'ok', { pid: 48213, uptime: `2 min${ch}` }),
    vaultPath: check('vault', 'ok', { path: `/home/you/${ch}vault`, notes: 3 }),
    vaultError: check('vault', 'failed', { error: `spawn ${ch}` }),
    vaultDetail: check('vault', 'failed', { detail: `not a dir ${ch}` }),
    vaultSkipped: check('vault', 'optional_skipped', { detail: `skipped ${ch}` }),
    scribedError: check('scribed', 'failed', { error: `no socket ${ch}` }),
    notifyError: check('notify', 'failed', { error: `stderr ${ch}` }),
    notifyDetail: check('notify', 'failed', { detail: `detail ${ch}` })
  })
  for (const { ch, raw, token } of HIDDEN) {
    for (const [name, c] of Object.entries(cases(ch))) {
      const html = row(c)
      assert.doesNotMatch(html, raw, `${name} leaks a raw hidden character ${token}`)
      assert.match(html, new RegExp(token), `${name} shows ${token} as a visible token`)
    }
  }
  const sail = render(ChecklistView, { checks: checks(), navigate: noop, onAction: noop, onCheckAgain: noop, onSetSail: noop, onDone: noop, sailError: `precondition${RLO}` })
  assert.doesNotMatch(sail, RAW)
  assert.match(sail, new RegExp(`Could not set sail: precondition${TOKEN}`))
})

test('setup.check messages reach the feed while every action still reaches the store', () => {
  const { createSetupFeed, tapSetupChecks } = first
  const store = createDeckStore()
  const feed = createSetupFeed()
  const seen = []
  const off = feed.subscribe(c => seen.push(c))
  const tapped = tapSetupChecks(store, feed)
  tapped.dispatch({ type: 'message', message: { t: 'setup.check', at: 1, data: check('hooks', 'ok') } })
  tapped.dispatch({ type: 'message', message: { t: 'hb', seq: 0, at: 1 } })
  tapped.dispatch({ type: 'connection', state: 'live', attempt: 0, nextAt: null })
  assert.deepEqual(seen, [check('hooks', 'ok')])
  assert.equal(store.getState().connection.state, 'live')
  assert.equal(tapped.getState, store.getState)
  assert.equal(tapped.subscribe, store.subscribe)
  off()
  tapped.dispatch({ type: 'message', message: { t: 'setup.check', at: 2, data: check('deckd', 'ok') } })
  assert.equal(seen.length, 1)
})

// ---------------------------------------------------------------- Settings

const prefs = {
  scanRoot: '~/dev', vaultPath: '/home/you/vault', obsidianVaultName: null, turbidassistConfig: null, claudeCommand: 'claude',
  scribedCommand: 'scribed', vaultCommand: ['npx', '-y', '@andreymudri/vault-mcp'], bell: true, renotifyAfter: 10, notifyDone: true,
  quietInMeetings: true, notifyCrash: false, staleMinutes: 20, textSize: 14
}

test('Settings nav lists the sections with live subtitles and marks the current one', () => {
  const { SettingsView, settingsNav } = settings
  const routes = []
  assert.deepEqual(settingsNav(prefs).map(row => [row.id, row.title, row.sub, row.href]), [
    ['appearance', 'Appearance and language', 'Density, text size 14px, motion, EN / PT-BR', '/settings/appearance'],
    ['rules', 'Approval rules', 'Arrives with answering from the deck', '/settings/rules'],
    ['notifications', 'Notifications', 'Ship\'s bell, re-notify 10 min, quiet in meetings', '/settings/notifications'],
    ['connections', 'Connections', '~/dev, vault, scribed, re-run checklist', '/settings/connections'],
    ['crew', 'Crew', 'Colors, shapes and hats per repo', '/settings/crew']
  ])
  assert.equal(settingsNav({ ...prefs, renotifyAfter: null })[2].sub, 'Ship\'s bell, no re-notify, quiet in meetings')
  const tree = SettingsView({ section: 'notifications', prefs, navigate: to => routes.push(to), children: 'BODY' })
  const links = controls(tree)
  assert.deepEqual(links.filter(node => node.props['aria-current'] === 'page').map(node => node.props.href), ['/settings/notifications'])
  links[3].props.onClick({ button: 0, defaultPrevented: false, preventDefault() {} })
  assert.deepEqual(routes, ['/settings/connections'])
  const html = render(SettingsView, { section: 'notifications', prefs, navigate: () => {}, children: 'BODY' })
  assert.match(html, /<nav class="settings-nav" aria-label="Settings sections"><h1 class="settings-title">Settings<\/h1>/)
  assert.match(html, /BODY/)
  const later = render(SettingsView, { section: 'rules', prefs, navigate: () => {}, children: 'BODY' })
  assert.doesNotMatch(later, /BODY/)
  assert.match(later, /This section arrives in a later milestone\./)
  const loading = render(SettingsView, { section: 'notifications', prefs, loading: true, navigate: () => {}, children: 'BODY' })
  assert.match(loading, /aria-busy="true"/)
  assert.equal((loading.match(/class="skeleton-panel/g) ?? []).length, 3)
  assert.doesNotMatch(loading, /BODY/)
})

test('Notifications controls are bound to prefs, save each change immediately and lock environment-set values', async () => {
  const { NotificationsSection, notifyStatus, savePref, NOTIFY_PREFS } = settings
  assert.deepEqual(NOTIFY_PREFS.map(pref => pref.key), ['bell', 'renotifyAfter', 'notifyDone', 'quietInMeetings', 'notifyCrash'])
  const changes = []
  let pinged = 0
  const tree = NotificationsSection({ prefs, t: undefined, status: notifyStatus(null), onChange: (key, value) => changes.push([key, value]), onTestPing: () => { pinged++ } })
  const inputs = controls(tree)
  const byId = id => inputs.find(node => node.props.id === id)
  assert.equal(byId('pref-bell').props.checked, true)
  assert.equal(byId('pref-notifyCrash').props.checked, false)
  assert.equal(byId('pref-renotifyAfter').props.value, '10')
  byId('pref-bell').props.onChange({ target: { checked: false } })
  byId('pref-notifyDone').props.onChange({ target: { checked: false } })
  byId('pref-quietInMeetings').props.onChange({ target: { checked: false } })
  byId('pref-notifyCrash').props.onChange({ target: { checked: true } })
  byId('pref-renotifyAfter').props.onChange({ target: { value: 'never' } })
  byId('pref-renotifyAfter').props.onChange({ target: { value: '20' } })
  assert.deepEqual(changes, [['bell', false], ['notifyDone', false], ['quietInMeetings', false], ['notifyCrash', true], ['renotifyAfter', null], ['renotifyAfter', 20]])
  inputs.find(node => textOf(node) === 'Send test ping').props.onClick()
  assert.equal(pinged, 1)
  const html = render(NotificationsSection, { prefs, status: notifyStatus(null), onChange() {}, onTestPing() {} })
  for (const label of ['Ship\'s bell when a session needs you', 'Once per session, not repeated.', 'Re-notify if ignored', 'Notify when a session finishes with changes',
    'Quiet in meetings', 'While TurbidAssist records: no sound, popups still show.', 'Popup when a session crashes', 'after 5 min', 'after 10 min', 'after 20 min', '>Never<']) {
    assert.ok(html.includes(label.replace(/'/g, '&#x27;')), label)
  }
  const locked = controls(NotificationsSection({ prefs, sources: { bell: 'env' }, status: notifyStatus(null), onChange() {}, onTestPing() {} }))
  assert.equal(locked.find(node => node.props.id === 'pref-bell').props.disabled, true)
  assert.equal(locked.find(node => node.props.id === 'pref-notifyDone').props.disabled, false)

  assert.deepEqual(notifyStatus({ state: 'ok' }), { tone: 'ok', text: 'Desktop notifications work through mako.' })
  assert.deepEqual(notifyStatus({ state: 'failed', exitCode: 1 }), { tone: 'bad', text: 'Desktop notifications are not working: notify-send exited 1.' })
  assert.deepEqual(notifyStatus({ state: 'down', reason: 'notify-send missing' }), { tone: 'bad', text: 'Desktop notifications are not working: notify-send missing.' })
  assert.equal(notifyStatus({ state: 'unknown' }).tone, 'todo')

  const api = fakeApi({ 'PATCH /api/prefs': { prefs: {}, sources: {} } })
  await savePref(api, 'renotifyAfter', null)
  assert.deepEqual(api.calls, [{ method: 'PATCH', url: '/api/prefs', body: { renotifyAfter: null } }])
})

test('Connections edits folders and the commands the server runs only through its save handler, and parses them back', () => {
  const { ConnectionsSection, parsePref, prefText, depStatus, COMMAND_PREFS } = settings
  assert.deepEqual(COMMAND_PREFS.map(pref => pref.key), ['claudeCommand', 'scribedCommand', 'vaultCommand'])
  const saved = []
  const started = []
  let rescans = 0
  let checklist = 0
  const health = [{ dep: 'deckd', state: 'down', reason: 'deckd_unavailable' }, { dep: 'scribed', state: 'ok' }, { dep: 'vault-mcp', state: 'unknown' }]
  const tree = ConnectionsSection({ prefs, health, onSave: (key, value) => saved.push([key, value]), onRescan: () => { rescans++ }, onStart: dep => started.push(dep), onChecklist: () => { checklist++ } })
  const forms = elements(tree, ['form'])
  assert.deepEqual(forms.map(form => elements(form, ['input'])[0].props.name), ['scanRoot', 'vaultPath', 'obsidianVaultName', 'turbidassistConfig', 'claudeCommand', 'scribedCommand', 'vaultCommand'])
  const submit = (name, value) => {
    const form = forms.find(node => elements(node, ['input'])[0].props.name === name)
    form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value }) } } })
  }
  submit('claudeCommand', ' /opt/claude/bin/claude ')
  submit('vaultCommand', 'node  /home/you/vault-mcp/index.mjs')
  submit('vaultPath', '')
  submit('obsidianVaultName', '')
  submit('scanRoot', '')
  submit('scribedCommand', 'scribed')
  submit('turbidassistConfig', 'bad\0path')
  assert.deepEqual(saved, [['claudeCommand', '/opt/claude/bin/claude'], ['vaultCommand', ['node', '/home/you/vault-mcp/index.mjs']], ['vaultPath', null]],
    'unchanged, empty non-nullable and NUL values are never sent')
  assert.equal(elements(tree, ['input']).find(node => node.props.name === 'vaultCommand').props.defaultValue, 'npx -y @andreymudri/vault-mcp')
  assert.equal(elements(tree, ['input']).find(node => node.props.name === 'vaultPath').props.id, 'vault', 'the vault field is the #vault anchor')
  const buttons = controls(tree).filter(node => node.type === 'button')
  buttons.find(node => textOf(node) === 'Rescan').props.onClick()
  buttons.find(node => textOf(node) === 'Start deckd').props.onClick()
  buttons.find(node => textOf(node) === 'Run the setup checklist again').props.onClick()
  assert.equal(rescans, 1)
  assert.deepEqual(started, ['deckd'])
  assert.equal(checklist, 1)
  assert.equal(buttons.some(node => textOf(node) === 'Start scribed'), false, 'a running scribed has no start button')
  assert.deepEqual(buttons.map(node => textOf(node)).sort(), ['Rescan', 'Run the setup checklist again', 'Save', 'Save', 'Save', 'Save', 'Save', 'Save', 'Save', 'Start deckd'])

  const env = ConnectionsSection({ prefs, sources: { vaultPath: 'env' }, onSave() {}, onRescan() {}, onStart() {}, onChecklist() {} })
  const vault = elements(env, ['form']).find(form => elements(form, ['input'])[0].props.name === 'vaultPath')
  assert.equal(elements(vault, ['input'])[0].props.readOnly, true)
  assert.equal(elements(vault, ['button']).length, 0)
  assert.match(textOf(vault), /Set by the environment/)

  assert.deepEqual(parsePref({ key: 'vaultCommand', argv: true }, ' a  b\tc '), ['a', 'b', 'c'])
  assert.deepEqual(parsePref({ key: 'vaultCommand', argv: true }, 'node \'/home/you/my vault/x.mjs\''), ['node', '/home/you/my vault/x.mjs'])
  assert.equal(parsePref({ key: 'vaultCommand', argv: true }, 'node "/home/you/x.mjs'), undefined)
  assert.equal(parsePref({ key: 'scanRoot' }, '   '), undefined)
  assert.equal(parsePref({ key: 'vaultPath', nullable: true }, ''), null)
  assert.equal(parsePref({ key: 'claudeCommand' }, 'cl\0aude'), undefined)
  assert.equal(prefText(['npx', '-y']), 'npx -y')
  assert.equal(prefText(null), '')
  assert.deepEqual(depStatus({ dep: 'deckd', state: 'down', reason: 'socket refused' }, 'deckd'), { tone: 'bad', text: 'deckd down: socket refused' })
  assert.deepEqual(depStatus({ dep: 'deckd', state: 'ok' }, 'deckd'), { tone: 'ok', text: 'deckd running' })
  assert.deepEqual(depStatus(undefined, 'vault-mcp'), { tone: 'todo', text: 'vault-mcp not checked yet' })
  const html = render(ConnectionsSection, { prefs, onSave() {}, onRescan() {}, onStart() {}, onChecklist() {}, found: 2 })
  assert.match(html, /2 repos found/)
  assert.match(html, /A running session counts as adrift after 20 min without activity\./)
})

test('Save on a Connections field always answers: saved, no change, or why the text was not sent', () => {
  const { ConnectionsSection, refusalKey } = settings
  const saved = []
  const noted = []
  const section = (notes = {}, errors = {}) => ConnectionsSection({ prefs, notes, errors, onSave: (key, value) => saved.push([key, value]), onNote: (key, note) => noted.push([key, note]), onRescan() {}, onStart() {}, onChecklist() {} })
  const formOf = (tree, name) => elements(tree, ['form']).find(node => elements(node, ['input'])[0].props.name === name)
  const submit = (name, value) => formOf(section(), name).props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value }) } } })

  submit('scanRoot', '~/dev')
  submit('scanRoot', ' ~/dev ')
  submit('scanRoot', '  ')
  submit('claudeCommand', 'cl\0aude')
  submit('vaultCommand', 'node "/home/you/x.mjs')
  submit('scanRoot', '/home/you/Work')
  assert.deepEqual(noted, [['scanRoot', 'settings.conn.unchanged'], ['scanRoot', 'settings.conn.unchanged'], ['scanRoot', 'settings.conn.empty'],
    ['claudeCommand', 'settings.conn.nul'], ['vaultCommand', 'settings.conn.quote']], 'every Save that sends nothing says why')
  assert.deepEqual(saved, [['scanRoot', '/home/you/Work']], 'a real edit goes to onSave and is not noted here')
  assert.equal(refusalKey({ key: 'scanRoot' }, '/home/you/Work'), null)

  const lines = (notes, errors) => elements(formOf(section(notes, errors), 'scanRoot'), ['p']).filter(node => node.props.role === 'status').map(node => [node.props.className, textOf(node)])
  assert.deepEqual(lines({ scanRoot: 'settings.conn.saved' }), [['setting-hint setting-saved', 'Saved.']])
  assert.deepEqual(lines({ scanRoot: 'settings.conn.unchanged' }), [['setting-hint', 'No change to save.']])
  assert.deepEqual(lines({ scanRoot: 'settings.conn.empty' }), [['setting-error', 'Not saved: this field cannot be empty.']])
  assert.deepEqual(lines({ scanRoot: 'settings.conn.saved' }, { scanRoot: 'Could not save scanRoot: settings_io_failed' }), [['setting-error', 'Could not save scanRoot: settings_io_failed']], 'a server error replaces the note')
  assert.deepEqual(lines({}), [])

  noted.length = 0
  elements(formOf(section({ scanRoot: 'settings.conn.saved' }), 'scanRoot'), ['input'])[0].props.onInput()
  elements(formOf(section(), 'scanRoot'), ['input'])[0].props.onInput()
  assert.deepEqual(noted, [['scanRoot', null]], 'typing again clears the note, and only when there is one')
})

test('every server string in Settings is shown with visible tokens, one field at a time', () => {
  const { ConnectionsSection, NotificationsSection, SettingsView, notifyStatus } = settings
  const noop = () => {}
  for (const { ch, raw, token } of HIDDEN) {
    for (const key of ['scanRoot', 'vaultPath', 'obsidianVaultName', 'turbidassistConfig', 'claudeCommand', 'scribedCommand']) {
      const html = render(ConnectionsSection, { prefs: { ...prefs, [key]: `x${ch}y` }, onSave: noop, onRescan: noop, onStart: noop, onChecklist: noop })
      assert.doesNotMatch(html, raw, `${key} leaks a raw hidden character`)
      assert.match(html, new RegExp(`x${token}y`), `${key} shows ${token} as a visible token`)
    }
    const navHtml = render(SettingsView, { section: 'rules', prefs: { ...prefs, scanRoot: `~/d${ch}ev` }, navigate: noop })
    assert.doesNotMatch(navHtml, raw, 'nav subtitle')
    assert.match(navHtml, new RegExp(`~/d${token}ev, vault`))
  }
  const argv = render(ConnectionsSection, { prefs: { ...prefs, vaultCommand: ['npx', `x${RLO}y`] }, onSave: noop, onRescan: noop, onStart: noop, onChecklist: noop })
  assert.doesNotMatch(argv, RAW, 'vaultCommand leaks a raw bidi control')
  assert.match(argv, new RegExp(`npx x${TOKEN}y`))
  const reason = render(ConnectionsSection, { prefs, health: [{ dep: 'deckd', state: 'down', reason: `refused${RLO}` }], onSave: noop, onRescan: noop, onStart: noop, onChecklist: noop })
  assert.doesNotMatch(reason, RAW, 'health reason')
  assert.match(reason, new RegExp(`refused${TOKEN}`))
  const start = render(ConnectionsSection, { prefs, startErrors: { deckd: `no unit${RLO}` }, onSave: noop, onRescan: noop, onStart: noop, onChecklist: noop })
  assert.doesNotMatch(start, RAW, 'start error')
  assert.match(start, new RegExp(`Could not start deckd: no unit${TOKEN}`))
  const nav = render(SettingsView, { section: 'rules', prefs: { ...prefs, scanRoot: `~/d${RLO}ev` }, navigate: noop })
  assert.doesNotMatch(nav, RAW, 'nav subtitle')
  assert.match(nav, new RegExp(`~/d${TOKEN}ev, vault`))
  for (const status of [{ state: 'down', reason: `gone${RLO}` }, { state: 'failed', exitCode: `1${RLO}` }]) {
    const html = render(NotificationsSection, { prefs, status: notifyStatus(status), onChange: noop, onTestPing: noop })
    assert.doesNotMatch(html, RAW, `notify status ${JSON.stringify(Object.keys(status))}`)
    assert.match(html, new RegExp(TOKEN))
  }
})

// ---------------------------------------------------------------- Failures and the mounted shell

const fixture = () => ({
  repos: [repo('rustot', 0), repo('vault', 1), repo('web', 2)],
  sessions: [session('s1', 'rustot', 'running'), session('s2', 'vault', 'done', { stateSince: NOW - 3 * MIN }), session('s3', 'web', 'ended', { endedAt: NOW - 30 * MIN, task: `old ${RLO}task` }),
    session('s4', 'rustot', 'reviewed', { stateSince: NOW - 5 * MIN, reviewedAt: NOW - 5 * MIN })]
})

test('the failure model tells fatal, loading, server-lost, deckd-down and notifier states apart and keeps completed history', () => {
  const { failureModel } = failures
  const base = loaded(fixture())
  const live = failureModel(base, NOW)
  assert.deepEqual([live.fatal, live.loading, live.server, live.deckd, live.notify], [null, false, false, null, null])
  assert.deepEqual(live.history.map(row => row.id), ['s2', 's4', 's3'], 'completed sessions, newest first; running ones are not history')
  for (const state of ['token_invalid', 'origin_rejected', 'client_outdated']) {
    const model = failureModel({ ...initialState(), connection: { state, attempt: 0, nextAt: null } }, NOW)
    assert.equal(model.fatal, state)
    assert.equal(model.loading, false)
  }
  assert.equal(failureModel(initialState(), NOW).loading, true)
  assert.equal(failureModel(loaded(fixture(), 'reconnecting'), NOW).server, true)
  for (const state of ['down', 'reconnecting']) {
    const model = failureModel(loaded({ ...fixture(), health: [{ dep: 'deckd', state, reason: 'socket refused', attempt: 2 }] }), NOW)
    assert.deepEqual(model.deckd, { state, reason: 'socket refused', attempt: 2 })
  }
  assert.equal(failureModel(loaded({ health: [{ dep: 'deckd', state: 'ok' }] }), NOW).deckd, null)
  assert.equal(failureModel(loaded({ health: [{ dep: 'deckd', state: 'checking' }] }), NOW).deckd, null)
  assert.deepEqual(failureModel(loaded({ health: [{ dep: 'notify', state: 'down', exitCode: 1 }] }), NOW).notify, { code: 1 })
})

function mounted(state, pathname, api = fakeApi()) {
  const screens = failures.deckScreens({ api, now: () => NOW })
  return renderToStaticMarkup(createElement(App, { store: createDeckStore(state), path: pathname, navigate: () => {}, onRetry: () => {}, now: NOW, screens }))
}

test('with deckd down the mounted shell keeps completed session history visible, names the socket error and still renders Home', () => {
  const down = loaded({ ...fixture(), health: [{ dep: 'deckd', state: 'down', reason: `ECONNREFUSED deckd.sock${RLO}`, attempt: 3, nextProbeAt: NOW + 4000 }] })
  const html = mounted(down, '/')
  assert.match(html, /Radio silence from deckd\./, 'the shell banner')
  assert.match(html, /deckd is unavailable/)
  assert.match(html, /Sessions keep running and hooks keep reporting\./)
  assert.match(html, new RegExp(`Last error: ECONNREFUSED deckd\\.sock${TOKEN}`))
  assert.doesNotMatch(html, RAW)
  assert.match(html, /<h2 class="fail-history-title" id="fail-history-title">Completed sessions<\/h2>/)
  for (const id of ['s2', 's3', 's4']) assert.match(html, new RegExp(`href="/s/${id}"`), `completed ${id} stays listed`)
  assert.match(html, new RegExp(`old ${TOKEN}task`))
  assert.match(html, /class="home-grid"/, 'Home still renders under the notice')

  const live = mounted(loaded(fixture()), '/')
  assert.doesNotMatch(live, /deckd is unavailable|Completed sessions/)
  const focus = mounted(down, '/s/s2')
  assert.match(focus, /deckd is unavailable/)
  assert.doesNotMatch(focus, /Completed sessions/, 'Focus shows the notice without the history list')
  const lost = mounted(loaded(fixture(), 'reconnecting'), '/')
  assert.match(lost, /class="shell shell--stale"/)
  assert.match(lost, /Lost the deck server\./)
  assert.match(lost, /class="home-grid"/, 'the last snapshot stays, dimmed, instead of skeletons')
  assert.doesNotMatch(lost, /skeleton-card/)
})

test('the mounted shell shows skeletons before a snapshot and the full-page message for an invalid token, on every M1 route', () => {
  for (const pathname of ['/', '/welcome', '/settings/connections', '/s/s1']) {
    const empty = mounted(initialState(), pathname)
    assert.match(empty, /aria-busy="true"/, pathname)
    assert.match(empty, /Loading sessions/, pathname)
    assert.doesNotMatch(empty, /first-run|settings-nav|home-grid/, `${pathname} renders no screen before the snapshot`)
    const invalid = mounted({ ...loaded(fixture()), connection: { state: 'token_invalid', attempt: 0, nextAt: null } }, pathname)
    assert.match(invalid, /This tab&#x27;s key no longer matches the deck\./, pathname)
    assert.doesNotMatch(invalid, /<nav|first-run|settings-nav|home-grid|fail-notices/, `${pathname} shows only the fatal page`)
  }
  const welcome = mounted(loaded({ ...fixture(), setup: { firstRunCompletedAt: null }, prefs: {} }), '/welcome')
  assert.match(welcome, /Welcome aboard the deck/)
  assert.equal((welcome.match(/<li class="check-row check-row--checking"/g) ?? []).length, 5, 'automatic checks open as checking')
  assert.match(welcome, /Set sail \(needs hooks\)/)
  const settingsHtml = mounted(loaded(fixture()), '/settings/notifications')
  assert.match(settingsHtml, /aria-label="Settings sections"/)
  assert.match(settingsHtml, /class="settings-content" aria-busy="true"/, 'Settings waits for preference sources')
})

test('deckScreens hands every screen the authenticated api it was given, and the deckd notice starts deckd through it', async () => {
  const api = fakeApi({ 'POST /api/deps/deckd/start': { dep: { dep: 'deckd', state: 'checking' } } })
  const feed = { subscribe: () => () => {} }
  const screens = failures.deckScreens({ api, feed, now: () => NOW })
  assert.deepEqual(Object.keys(screens).sort(), ['focus', 'home', 'settings', 'welcome'])
  const down = loaded({ ...fixture(), health: [{ dep: 'deckd', state: 'down', reason: null }] })
  const props = { route: { name: 'x', params: { sessionId: 's2', section: 'connections' } }, state: down, t: undefined, navigate: () => {} }
  const expected = { home: ['Home'], focus: ['Focus'], welcome: ['FirstRun'], settings: ['Settings', 'ObserveOverlays'] }
  for (const [name, components] of Object.entries(expected)) {
    const tree = screens[name](props)
    const found = []
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'function' && components.includes(node.type.name)) found.push(node)
      visit(node.props?.children)
    }
    visit(tree)
    assert.deepEqual(found.map(node => node.type.name), components, name)
    for (const node of found) assert.equal(node.props.api, api, `${name} passes the real api to ${node.type.name}`)
    if (name === 'welcome' || name === 'settings') assert.equal(found[0].props.feed, feed, `${name} gets the setup feed`)
  }
  const notices = []
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type.name === 'FailureNotices') notices.push(node)
    visit(node.props?.children)
  }
  visit(screens.home(props))
  const start = controls(notices[0].type(notices[0].props)).find(node => textOf(node) === 'Start deckd')
  start.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(api.calls, [{ method: 'POST', url: '/api/deps/deckd/start' }])
  const welcomeNotices = []
  const walkWelcome = node => {
    if (Array.isArray(node)) return node.forEach(walkWelcome)
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type.name === 'FailureNotices') welcomeNotices.push(node)
    walkWelcome(node.props?.children)
  }
  walkWelcome(screens.welcome(props))
  assert.equal(welcomeNotices.length, 0, 'First run is full-bleed, without failure notices')
})

test('the notifier failure notice links to Settings through navigate and shows the exit code as text', () => {
  const { FailureNotices, failureModel } = failures
  const routes = []
  const model = failureModel(loaded({ health: [{ dep: 'notify', state: 'down', exitCode: `1${RLO}` }] }), NOW)
  const tree = FailureNotices({ model, navigate: to => routes.push(to) })
  const link = controls(tree).find(node => node.type === 'a')
  assert.equal(link.props.href, '/settings/notifications')
  let prevented = false
  link.props.onClick({ button: 0, defaultPrevented: false, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(routes, ['/settings/notifications'])
  const html = render(FailureNotices, { model, navigate: () => {} })
  assert.match(html, new RegExp(`notify-send exited 1${TOKEN}\\.`))
  assert.doesNotMatch(html, RAW)
  const history = render(failures.SessionHistory, { sessions: [session('s9', `we${RLO}b`, 'done')], repos: [], navigate: () => {} })
  assert.doesNotMatch(history, RAW, 'repo names in the history')
})

// ---------------------------------------------------------------- Build and browser

async function findChromium() {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (!candidate) continue
    try { await access(candidate)
      return candidate } catch {}
  }
  return null
}

// Class names used by rules that declare something (a minifier drops empty rules).
const classesOf = css => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => body.trim()).flatMap(([, selector]) => [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1])))

test('the production build carries the component, observe and setup stylesheets, and the built deck runs First run end to end', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'setup-'))
  const out = path.join(dir, 'web')
  execFileSync('npm', ['run', 'build', '--', '--outDir', out], { cwd: hub, stdio: 'pipe' })
  const assets = await readdir(path.join(out, 'assets'))
  const built = (await Promise.all(assets.filter(name => name.endsWith('.css')).map(name => readFile(path.join(out, 'assets', name), 'utf8')))).join('\n')
  const sheets = {}
  for (const name of ['tokens', 'shell', 'components', 'observe', 'setup']) sheets[name] = classesOf(await readFile(path.join(src, 'styles', `${name}.css`), 'utf8'))
  const builtClasses = classesOf(built)
  for (const name of ['components', 'observe', 'setup']) {
    const own = [...sheets[name]].filter(cls => Object.entries(sheets).every(([other, set]) => other === name || !set.has(cls)))
    assert.ok(own.length > 3, `${name}.css defines its own classes`)
    const missing = own.filter(cls => !builtClasses.has(cls))
    assert.deepEqual(missing, [], `the built CSS carries ${name}.css`)
  }

  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the First run browser test')
  const { startDeckServer } = await import('../../server/main.mjs')
  const token = 'c'.repeat(43)
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  await mkdir(state, { recursive: true, mode: 0o700 })
  await writeFile(path.join(state, 'token'), token, { mode: 0o600 })
  const hookDir = path.join(dir, '.local/share/fleetmates-deck/hook')
  await mkdir(hookDir, { recursive: true })
  await writeFile(path.join(hookDir, 'deck-hook.mjs'), '// fake hook\n')
  const deck = await startDeckServer({ env, port: 0, staticDir: out, notifications: false, connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }) })
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => { await browser.close()
    await deck.close()
    await rm(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${deck.address().port}`
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/#token=${token}`)
  await page.waitForFunction(() => location.pathname === '/welcome', null, { timeout: 5000 })
  await page.waitForSelector('text=Welcome aboard the deck', { timeout: 5000 })
  const sail = page.locator('button.first-run-sail')
  await page.waitForSelector('li[data-check="hooks"].check-row--bad', { timeout: 5000 })
  assert.equal(await sail.textContent(), 'Set sail (needs hooks)')
  assert.equal(await sail.getAttribute('aria-disabled'), 'true')
  await page.waitForFunction(() => document.querySelectorAll('li.check-row--checking').length === 0, null, { timeout: 5000 })
  await page.waitForFunction(() => document.activeElement?.textContent === 'Install hooks', null, { timeout: 5000 })
  assert.match(await page.locator('.first-run [role="status"][aria-live="polite"]').textContent(), /^\d of 6 checks passed$/)
  assert.equal(await page.locator('nav[aria-label="Deck sections"]').isVisible(), false, 'First run is full-bleed')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'nothing overflows horizontally at 1280')
  await sail.click({ force: true })
  await page.waitForTimeout(200)
  assert.equal(new URL(page.url()).pathname, '/welcome', 'a blocked Set sail does nothing')

  await page.getByRole('button', { name: 'Install hooks' }).click()
  await page.waitForSelector('li[data-check="hooks"].check-row--ok', { timeout: 5000 })
  assert.match(await readFile(path.join(dir, '.claude/settings.json'), 'utf8'), /deck-hook\.mjs/)
  assert.equal(await sail.textContent(), 'Set sail')
  assert.equal(await sail.getAttribute('aria-disabled'), null)
  await sail.click()
  await page.waitForFunction(() => location.pathname === '/', null, { timeout: 5000 })
  await page.waitForSelector('nav[aria-label="Deck sections"]', { timeout: 5000 })
  await page.reload()
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') !== 'true', null, { timeout: 5000 })
  await page.waitForTimeout(300)
  assert.equal(new URL(page.url()).pathname, '/', 'reloading / no longer redirects')

  await page.goto(`${base}/settings/notifications`)
  const bell = page.getByLabel('Ship\'s bell when a session needs you')
  await bell.waitFor({ timeout: 5000 })
  assert.equal(await bell.isChecked(), true)
  await bell.click()
  await page.waitForFunction(() => document.getElementById('pref-bell')?.checked === false, null, { timeout: 5000 })
  const saved = await page.evaluate(async key => (await fetch('/api/prefs', { headers: { Authorization: `Bearer ${sessionStorage.getItem(key)}`, 'X-Deck-Api': '1' } })).json(), 'fleetmates-deck.token')
  assert.equal(saved.prefs.bell, false, 'the change is saved through the authenticated api')
  await page.route('**/api/prefs', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'settings_io_failed', message: 'disk full', retryable: false } }) })
    : route.continue())
  await page.getByLabel('Popup when a session crashes').click()
  await page.waitForSelector('text=Could not save notifyCrash: disk full', { timeout: 5000 })
  assert.equal(await page.getByLabel('Popup when a session crashes').isChecked(), true, 'a failed save reverts the control')
  await page.unroute('**/api/prefs')
  await page.route('**/api/prefs', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unauthorized', message: 'no', retryable: false } }) })
    : route.continue())
  await page.getByLabel('Quiet in meetings').click()
  await page.waitForSelector('text=This tab\'s key no longer matches the deck.', { timeout: 5000 })
  assert.equal(await page.locator('nav').count(), 0, 'a 401 from Settings flips the shell to its fatal page')
  assert.deepEqual(errors, [])
})
