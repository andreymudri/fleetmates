import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load() {
  const { module } = await runnerImport(path.join(hub, 'web/src/screens/drawer/NeedsYouDrawer.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const NOW = Date.UTC(2026, 9, 2, 12, 0)
const MIN = 60_000

// Walk a tree of pure components, expanding function components, and collect host elements.
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
  return textOf(node.props?.children)
}

// Every <button ...>label</button> as { attrs, text }, nested markup stripped from the text.
const buttons = html => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attrs: match[1], text: match[2].replace(/<[^>]+>/g, '') }))
const button = (html, text) => buttons(html).find(item => item.text === text)
const disabled = item => /\sdisabled=""/.test(item.attrs)
const rowHtml = (html, id) => html.match(new RegExp(`<li[^>]*data-request="${id}"[\\s\\S]*?</li>`))?.[0] ?? ''

const OPTIONS = [{ key: '1', label: 'Yes' }, { key: '2', label: 'Yes, and don\'t ask again for cargo test:*' }, { key: '3', label: 'No' }]

function session(id, name, extra = {}) {
  return { id, repoId: `/home/you/dev/${name}`, origin: 'launched', ptyId: `p-${id}`, alive: true, state: 'needs_approval', branch: `br-${id}`, ...extra }
}

function request(id, sessionId, tier, extra = {}) {
  return {
    id, sessionId, kind: 'permission', tier, toolName: 'Bash', summary: `cmd ${id}`, state: 'open', createdAt: NOW - 5 * MIN,
    delivery: 'idle', screenMatch: 'on_screen', options: OPTIONS, allowAlways: false, confirmLabel: null, ...extra
  }
}

function stateWith({ sessions = [session('s1', 'rustot'), session('s2', 'web')], requests = [], ruleOffers = [], runs = [], health = [] } = {}) {
  const repos = [...new Set(sessions.map(row => row.repoId))].map(id => ({ id, name: id.split('/').at(-1), repoKey: id.split('/').at(-1), crew: { slot: 0, seed: 'x', hat: 'none' } }))
  return {
    loaded: true,
    deckdOutage: false,
    connection: { state: 'live', attempt: 0, nextAt: null },
    data: { sessions, requests, repos, runs, ruleOffers, health, counts: null }
  }
}

// A fake REST client that records every call and answers from `replies` keyed by path.
function fakeApi(replies = {}) {
  const calls = []
  const reply = (method, url, body) => {
    calls.push(body === undefined ? [method, url] : [method, url, body])
    const value = replies[url]
    return typeof value === 'function' ? value(body) : Promise.resolve(value ?? {})
  }
  return {
    calls,
    get: url => reply('GET', url),
    post: (url, body) => reply('POST', url, body),
    patch: (url, body) => reply('PATCH', url, body),
    del: url => reply('DELETE', url)
  }
}

// The drawer's local state driven through its own reducer, as the component's useReducer does.
async function harness(state, { api = fakeApi(), filter = null, now = NOW } = {}) {
  const m = await load()
  let local = m.initialDrawerLocal()
  const dispatch = action => { local = m.drawerLocal(local, action) }
  const actions = m.drawerActions({ api, dispatch, state, now: () => now })
  const focus = { rows: [], confirms: [] }
  const key = (event, extra = {}) => {
    const full = { key: '', code: '', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, target: null, preventDefault() {}, ...event }
    return m.drawerKeyDown(full, { state, filter, local, actions, focusRow: id => focus.rows.push(id), focusConfirm: id => focus.confirms.push(id), ...extra })
  }
  const view = () => render(m.DrawerView, { state, now, navigate: () => {}, filter, local, actions, focused: m.focusedRequest(state, { filter, local }) })
  const tree = () => m.DrawerView({ state, now, navigate: () => {}, filter, local, actions, focused: m.focusedRequest(state, { filter, local }) })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  return { m, api, actions, key, view, tree, focus, settle, get local() { return local }, dispatch }
}

const answers = api => api.calls.filter(call => call[0] === 'POST' && /^\/api\/requests\//.test(call[1]))

test('AC3: Enter and Alt A on a Destructive row send nothing; the checkbox enables Allow once; closing clears it', async () => {
  const state = stateWith({ requests: [request('d1', 's1', 'destructive', { summary: 'git push --force', confirmLabel: 'I checked the 3 commits that will be overwritten' })] })
  const h = await harness(state)

  const before = h.view()
  const allow = button(rowHtml(before, 'd1'), 'Allow once')
  assert.ok(allow && disabled(allow), 'Allow once starts disabled')
  assert.doesNotMatch(before, /autofocus|type="submit"/i, 'never autofocused, never the default button')

  assert.equal(h.key({ key: 'Enter', code: 'Enter' }), false, 'Enter is not a drawer shortcut')
  h.key({ key: 'a', code: 'KeyA', altKey: true })
  await h.settle()
  assert.deepEqual(answers(h.api), [], 'Alt A sends nothing on a Destructive row')
  assert.deepEqual(h.focus.confirms, ['d1'], 'Alt A moves focus to the checkbox instead')
  h.key({ key: 'd', code: 'KeyD', altKey: true, shiftKey: true })
  await h.settle()
  assert.deepEqual(answers(h.api), [], 'no other Alt chord answers it either')

  // Space on a checkbox fires its change event; the drawer keeps the tick per request.
  const checkbox = find(h.tree(), node => node.type === 'input' && node.props.type === 'checkbox')[0]
  checkbox.props.onChange({ target: { checked: true } })
  const ticked = h.view()
  assert.ok(!disabled(button(rowHtml(ticked, 'd1'), 'Allow once')), 'ticking enables Allow once')
  assert.match(rowHtml(ticked, 'd1'), /<input type="checkbox"[^>]*checked=""/)
  h.key({ key: 'a', code: 'KeyA', altKey: true })
  await h.settle()
  assert.deepEqual(answers(h.api), [], 'even when ticked, Alt A never answers a Destructive row')

  h.dispatch({ type: 'close' })
  assert.deepEqual(h.local.confirmed, {}, 'closing the drawer clears every checkbox')
  assert.ok(disabled(button(rowHtml(h.view(), 'd1'), 'Allow once')), 'reopened unticked')
  assert.deepEqual(h.m.initialDrawerLocal().confirmed, {}, 'a fresh drawer starts unticked')
})

test('AC4: Alt Shift A with 2 Safe and 1 Caution sends exactly the 2 Safe ids', async () => {
  const state = stateWith({ requests: [request('a', 's1', 'safe'), request('c', 's1', 'caution'), request('b', 's2', 'safe'), request('q', 's2', 'question', { kind: 'question', tier: null })] })
  const api = fakeApi({ '/api/requests/answer-batch': { results: [{ id: 'a', ok: true }, { id: 'b', ok: true }] } })
  const h = await harness(state, { api })
  assert.equal(h.key({ key: 'A', code: 'KeyA', altKey: true, shiftKey: true }), true)
  await h.settle()
  assert.deepEqual(api.calls, [['POST', '/api/requests/answer-batch', { ids: ['a', 'b'], choice: 'allow' }]])
  assert.ok(h.view().includes('Allowed 2 of 2'), 'one toast for the batch')

  const html = h.view()
  assert.ok(button(html, 'Allow both Safe once'), 'the batch button names both Safe rows')
  const three = await harness(stateWith({ requests: ['x', 'y', 'z'].map(id => request(id, 's1', 'safe')) }))
  assert.ok(button(three.view(), 'Allow all 3 Safe once'))
  const one = await harness(stateWith({ requests: [request('x', 's1', 'safe'), request('c', 's1', 'caution')] }))
  assert.doesNotMatch(one.view(), /Safe once</, 'no batch button for a single Safe row')
})

test('a filtered drawer for run r1 answers only r1 rows: the batch button and Alt Shift A never reach a hidden r2 request', async () => {
  const runRef = runId => ({ repoId: '/home/you/dev/fm', runId, taskId: 'T1' })
  const sessions = [session('l1', 'fm', { role: 'lead', runRef: runRef('r1') }), session('l2', 'fm', { role: 'lead', runRef: runRef('r2') })]
  const state = stateWith({ sessions, requests: [request('one', 'l1', 'safe'), request('two', 'l1', 'safe'), request('hidden', 'l2', 'safe')] })
  const api = fakeApi({ '/api/requests/answer-batch': { results: [] } })
  const filter = { kind: 'run', runId: 'r1' }
  const h = await harness(state, { api, filter })
  const html = h.view()
  assert.deepEqual([...html.matchAll(/data-request="(\w+)"/g)].map(match => match[1]), ['one', 'two'])
  h.key({ key: 'A', code: 'KeyA', altKey: true, shiftKey: true })
  const batch = find(h.tree(), node => node.type === 'button' && textOf(node) === 'Allow both Safe once')[0]
  batch.props.onClick()
  await h.settle()
  assert.deepEqual(api.calls.map(call => call[2].ids), [['one', 'two'], ['one', 'two']])
})

test('AC5: a partial batch gives one toast "Allowed 1 of 2: 1 did not land" and the failed row offers Try again', async () => {
  const requests = [request('a', 's1', 'safe'), request('b', 's2', 'safe')]
  const state = stateWith({ requests })
  const api = fakeApi({ '/api/requests/answer-batch': { results: [{ id: 'a', ok: true }, { id: 'b', ok: false, error: { code: 'did_not_land' } }] } })
  const h = await harness(state, { api })
  h.key({ key: 'A', code: 'KeyA', altKey: true, shiftKey: true })
  await h.settle()
  const html = h.view()
  assert.equal((html.match(/Allowed \d of \d/g) ?? []).length, 1, 'exactly one toast')
  assert.ok(html.includes('Allowed 1 of 2: 1 did not land'))

  // The server then reports b as not landed; the kept batch body lets the row resend it.
  requests[1] = { ...requests[1], delivery: 'did_not_land' }
  const after = h.view()
  assert.ok(button(rowHtml(after, 'b'), 'Try again'), 'the failed row shows Try again')
  find(h.tree(), node => node.type === 'button' && textOf(node) === 'Try again')[0].props.onClick()
  await h.settle()
  assert.deepEqual(api.calls.at(-1), ['POST', '/api/requests/b/answer', { choice: 'allow' }])
})

test('AC6: a request answered in the terminal while visible shows "Answered in the terminal" for 3 s, then leaves', async () => {
  const requests = [request('a', 's1', 'safe'), request('b', 's1', 'caution')]
  const state = stateWith({ requests })
  const h = await harness(state)
  const before = state.data.requests
  state.data.requests = [requests[1]]
  const gone = h.m.departures(before, state.data.requests, { busy: h.local.busy, sessions: state.data.sessions, now: NOW })
  assert.deepEqual(gone.map(item => [item.request.id, item.kind, item.until]), [['a', 'terminal', NOW + 3000]])
  h.dispatch({ type: 'linger', items: gone })
  const shown = rowHtml(h.view(), 'a')
  assert.ok(shown.includes('Answered in the terminal'), shown)
  assert.equal(buttons(shown).length, 0, 'a leaving row has nothing left to answer')
  h.dispatch({ type: 'prune', now: NOW + 2999 })
  assert.ok(h.view().includes('Answered in the terminal'), 'still there before 3 s')
  h.dispatch({ type: 'prune', now: NOW + 3000 })
  assert.doesNotMatch(h.view(), /Answered in the terminal|data-request="a"/, 'gone after 3 s')

  // A request the deck answered leaves without a note; an ended session's request "moved on".
  const deck = h.m.departures([requests[1]], [], { busy: { b: { choice: 'allow' } }, sessions: state.data.sessions, now: NOW })
  assert.deepEqual(deck, [])
  const ended = h.m.departures([requests[1]], [], { busy: {}, sessions: [session('s1', 'rustot', { state: 'ended' })], now: NOW })
  assert.deepEqual(ended.map(item => item.kind), ['movedOn'])
})

test('AC7: an observed session\'s row has no Allow, Deny or Reply, only "Answer in your terminal" and "Open"', async () => {
  const sessions = [session('o1', 'vault', { origin: 'observed', ptyId: null }), session('s1', 'rustot')]
  const state = stateWith({ sessions, requests: [request('o', 'o1', 'safe'), request('oq', 'o1', 'question', { kind: 'question', tier: null }), request('p', 's1', 'safe')] })
  const api = fakeApi()
  const h = await harness(state, { api })
  const html = h.view()
  for (const id of ['o', 'oq']) {
    const row = rowHtml(html, id)
    assert.doesNotMatch(row, />(Allow once|Deny|Reply)</, id)
    assert.doesNotMatch(row, /<input/, `${id}: no reply field`)
    assert.ok(row.includes('Answer in your terminal'), id)
    assert.match(row, /<a [^>]*href="\/s\/o1"[^>]*>Open<\/a>/, id)
  }
  assert.ok(button(rowHtml(html, 'p'), 'Allow once'), 'a PTY row still answers')
  assert.doesNotMatch(html, /Safe once</, 'an observed Safe row never joins a batch')
  h.dispatch({ type: 'focus', id: 'o' })
  h.key({ key: 'a', code: 'KeyA', altKey: true })
  h.key({ key: 'd', code: 'KeyD', altKey: true })
  await h.settle()
  assert.deepEqual(answers(api), [], 'Alt A and Alt D never answer an observed row')
})

test('Alt A and Alt D never answer a focused question of a PTY session, though they answer its permission row', async () => {
  const state = stateWith({ requests: [request('q', 's1', null, { kind: 'question' }), request('p', 's1', 'safe')] })
  const api = fakeApi()
  const h = await harness(state, { api })
  h.dispatch({ type: 'focus', id: 'q' })
  h.key({ key: 'a', code: 'KeyA', altKey: true })
  h.key({ key: 'd', code: 'KeyD', altKey: true })
  await h.settle()
  assert.deepEqual(answers(api), [], 'Alt A and Alt D send nothing for a focused PTY question')
  h.dispatch({ type: 'focus', id: 'p' })
  h.key({ key: 'a', code: 'KeyA', altKey: true })
  await h.settle()
  assert.deepEqual(answers(api).map(call => call[1]), ['/api/requests/p/answer'], 'the same keys still answer a PTY permission row')
})

test('the rule suggestion line, its any-flags line, accepting with a toast and Undo', async () => {
  const offers = [
    { repoId: '/home/you/dev/rustot', pattern: 'Bash(cargo test:*)', count: 5, threshold: 5, ruleNote: 'anyFlags' },
    { repoId: '/home/you/dev/web', pattern: 'Bash(npm run lint)', count: 3, threshold: 3 }
  ]
  const state = stateWith({ requests: [request('a', 's1', 'safe')], ruleOffers: offers })
  const api = fakeApi({ '/api/rules': { rule: { repoId: '/home/you/dev/rustot', pattern: 'Bash(cargo test:*)' } } })
  const h = await harness(state, { api })
  const html = h.view()
  assert.ok(html.includes('You allowed cargo test in rustot 5 times. Make it a rule?'))
  assert.ok(html.includes('It will allow cargo test with any flags.'), 'anyFlags adds its line')
  assert.ok(html.includes('You allowed npm run lint in web 3 times. Make it a rule?'))
  assert.equal((html.match(/with any flags/g) ?? []).length, 1, 'only the anyFlags offer carries the extra line')
  assert.ok(html.indexOf('drawer-section--safe') < html.indexOf('Make it a rule?'), 'under the Safe section')

  find(h.tree(), node => node.type === 'button' && textOf(node).startsWith('You allowed cargo test'))[0].props.onClick()
  await h.settle()
  assert.deepEqual(api.calls, [['POST', '/api/rules', { repoKey: 'rustot', pattern: 'Bash(cargo test:*)', source: 'suggested' }]])
  assert.ok(h.view().includes('Rule added to rustot: Bash(cargo test:*)'))
  find(h.tree(), node => node.type === 'button' && textOf(node) === 'Undo')[0].props.onClick()
  await h.settle()
  assert.deepEqual(api.calls.at(-1), ['DELETE', '/api/rules/rustot/Bash(cargo%20test%3A*)?undo=1'], 'the toast Undo revokes as an undo, like the Home toast')
  assert.doesNotMatch(h.view(), /Rule added to/, 'Undo dismisses the toast')
})

test('T17-F2: when the focused row leaves, focus moves to the next row, else the previous row, else Close', async () => {
  const { refocusTarget } = await load()
  const element = name => ({ name })
  const fakeRow = (id, { leaving = false } = {}) => ({
    getAttribute: () => id,
    matches: selector => selector === '.drawer-row--leaving' && leaving,
    querySelector: selector => selector === '.answer-buttons .button--primary:not([disabled])' ? element(`allow-${id}`) : null
  })
  const panelOf = rows => ({ querySelectorAll: () => rows, querySelector: selector => selector === '.drawer-close' ? element('close') : null })
  assert.equal(refocusTarget(panelOf([fakeRow('a'), fakeRow('c')]), ['a', 'b', 'c'], 'b').name, 'allow-c', 'the next row first')
  assert.equal(refocusTarget(panelOf([fakeRow('a')]), ['a', 'c'], 'c').name, 'allow-a', 'the previous row when none follows')
  assert.equal(refocusTarget(panelOf([fakeRow('a'), fakeRow('b')]), ['a', 'b', 'c'], 'c').name, 'allow-b', 'the nearest previous row, not the first')
  assert.equal(refocusTarget(panelOf([]), ['a'], 'a').name, 'close', 'Close when no row is left')
  assert.equal(refocusTarget(panelOf([fakeRow('a'), fakeRow('c', { leaving: true })]), ['a', 'b', 'c'], 'b').name, 'allow-a', 'a row that is itself leaving is skipped')
})

test('T17-F3: each drawer section is named by its tier title and count, the text of its heading, so equal counts stay distinct', async () => {
  const state = stateWith({ requests: [request('a', 's1', 'safe'), request('c', 's2', 'caution')] })
  const h = await harness(state)
  const html = h.view()
  for (const [tier, name] of [['safe', 'Safe · 1'], ['caution', 'Caution · 1']]) {
    const section = html.match(new RegExp(`<section class="drawer-section drawer-section--${tier}"([^>]*)>\\s*<h3[^>]*>([\\s\\S]*?)</h3>`))
    assert.ok(section, `${tier}: a section with its heading`)
    assert.doesNotMatch(section[1], /aria-labelledby/, `${tier}: named by its own label, not by the count span alone`)
    assert.equal(/aria-label="([^"]*)"/.exec(section[1])?.[1], name, `${tier}: the accessible name`)
    assert.equal(section[2].replace(/<[^>]+>/g, ''), name, `${tier}: the same text as its heading`)
  }
})

test('after a verified Deny the row keeps "Tell Claude what to do instead" and Send for 30 s', async () => {
  const requests = [request('a', 's1', 'caution')]
  const state = stateWith({ requests })
  const api = fakeApi()
  const h = await harness(state, { api })
  h.dispatch({ type: 'focus', id: 'a' })
  h.key({ key: 'd', code: 'KeyD', altKey: true })
  await h.settle()
  assert.deepEqual(answers(api), [['POST', '/api/requests/a/answer', { choice: 'deny' }]], 'Alt D denies the focused row')
  const gone = h.m.departures(requests, [], { busy: h.local.busy, sessions: state.data.sessions, now: NOW })
  assert.deepEqual(gone.map(item => [item.kind, item.until]), [['followup', NOW + 30_000]])
  state.data.requests = []
  h.dispatch({ type: 'linger', items: gone })
  const row = rowHtml(h.view(), 'a')
  assert.ok(row.includes('Tell Claude what to do instead'), row)
  assert.ok(button(row, 'Send'))
  const form = find(h.tree(), node => node.type === 'form' && node.props.className === 'drawer-followup')[0]
  form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { followup: { value: 'use the staging db' } } } })
  await h.settle()
  assert.deepEqual(api.calls.at(-1), ['POST', '/api/requests/a/followup', { text: 'use the staging db' }])
  assert.doesNotMatch(h.view(), /Tell Claude/, 'sent, the field leaves')
  h.dispatch({ type: 'linger', items: gone })
  h.dispatch({ type: 'prune', now: NOW + 30_000 })
  assert.doesNotMatch(h.view(), /Tell Claude/, 'and it leaves on its own after 30 s')
})

test('Alt A allows the focused Safe row once, Up and Down move the focus, and the footer lists the shortcuts', async () => {
  const state = stateWith({ requests: [request('a', 's1', 'safe'), request('c', 's2', 'caution')] })
  const api = fakeApi()
  const h = await harness(state, { api })
  assert.equal(h.m.focusedRequest(state, { local: h.local }), 'a', 'the first row is focused by default')
  h.key({ key: 'ArrowDown', code: 'ArrowDown' })
  assert.deepEqual(h.focus.rows, ['c'])
  assert.match(h.view(), /data-request="c" aria-current="true"/)
  h.key({ key: 'a', code: 'KeyA', altKey: true })
  await h.settle()
  assert.deepEqual(answers(api), [['POST', '/api/requests/c/answer', { choice: 'allow' }]])
  h.key({ key: 'ArrowUp', code: 'ArrowUp' })
  assert.deepEqual(h.focus.rows, ['c', 'a'])
  assert.ok(h.view().replace(/&#x27;/g, '\'').includes('Alt A allow focused · Alt D deny · Alt Shift A allow all Safe · rules live in each repo\'s .claude/settings.local.json'))
  assert.doesNotMatch(h.view(), /Answering here arrives with approvals/)
})

test('initial focus is the first row\'s primary action, or its checkbox when the first request is Destructive', async () => {
  const { drawerFocusTarget } = await load()
  const element = name => ({ name })
  const fakeRow = (id, matches) => ({ getAttribute: () => id, querySelector: selector => matches[selector] ?? null })
  const panelOf = rows => ({ querySelectorAll: () => rows, querySelector: selector => selector === '.drawer-row' ? rows[0] : selector === '.drawer-close' ? element('close') : null })
  const destructive = fakeRow('d', { '.answer-confirm input:not([disabled])': element('checkbox'), 'a': element('open-d') })
  const safe = fakeRow('s', { '.answer-buttons .button--primary:not([disabled])': element('allow'), 'a': element('open-s') })
  assert.equal(drawerFocusTarget(panelOf([destructive, safe]), null).name, 'checkbox')
  assert.equal(drawerFocusTarget(panelOf([safe, destructive]), null).name, 'allow')
  assert.equal(drawerFocusTarget(panelOf([safe, destructive]), 'd').name, 'checkbox', 'a named request gets its own primary action')
  const down = fakeRow('x', { 'a': element('open-x') })
  assert.equal(drawerFocusTarget(panelOf([down]), 'x').name, 'open-x', 'a row with every answer disabled falls back to Open')
})

test('Alt Shift A and the batch button leave out a Safe permission row with no parsed options', async () => {
  for (const [why, extra] of [['empty options', { options: [] }], ['options missing', { options: undefined }]]) {
    const requests = [request('a', 's1', 'safe'), request('b', 's2', 'safe', extra), request('c', 's2', 'safe')]
    const state = stateWith({ requests, health: [{ dep: 'deckd', state: 'up' }] })
    const api = fakeApi({ '/api/requests/answer-batch': { results: [] } })
    const h = await harness(state, { api })
    assert.deepEqual(h.m.batchIds(requests, state), ['a', 'c'], `${why}: batchIds skips b`)
    h.key({ key: 'A', code: 'KeyA', altKey: true, shiftKey: true })
    await h.settle()
    assert.deepEqual(answers(api), [['POST', '/api/requests/answer-batch', { ids: ['a', 'c'], choice: 'allow' }]], `${why}: Alt Shift A does not send b`)
    const batch = find(h.tree(), node => node.type === 'button' && textOf(node) === 'Allow both Safe once')[0]
    assert.ok(batch, `${why}: the batch button counts only the 2 rows with options`)
    batch.props.onClick()
    await h.settle()
    assert.deepEqual(answers(api).at(-1), ['POST', '/api/requests/answer-batch', { ids: ['a', 'c'], choice: 'allow' }], `${why}: the batch button does not send b`)
  }
})

test('Alt A and Alt D send nothing while deckd is down, the prompt is queued, an answer is in flight, one did not land, or no options were parsed', async () => {
  const blocked = [
    ['deckd outage flag', {}, state => ({ ...state, deckdOutage: true })],
    ['deckd health down', {}, state => ({ ...state, data: { ...state.data, health: [{ dep: 'deckd', state: 'down' }] } })],
    ['deckd health reconnecting', {}, state => ({ ...state, data: { ...state.data, health: [{ dep: 'deckd', state: 'reconnecting' }] } })],
    ['prompt queued', { screenMatch: 'queued' }],
    ['answer sending', { delivery: 'sending' }],
    ['answer verifying', { delivery: 'verifying' }],
    ['answer did not land', { delivery: 'did_not_land' }],
    ['no options parsed, deckd up', { options: [] }, state => ({ ...state, data: { ...state.data, health: [{ dep: 'deckd', state: 'up' }] } })],
    ['options missing, deckd up', { options: undefined }, state => ({ ...state, data: { ...state.data, health: [{ dep: 'deckd', state: 'up' }] } })]
  ]
  for (const tier of ['safe', 'caution']) {
    for (const [why, extra, shape = state => state] of blocked) {
      const api = fakeApi()
      const h = await harness(shape(stateWith({ requests: [request('r', 's1', tier, extra)] })), { api })
      h.key({ key: 'a', code: 'KeyA', altKey: true })
      h.key({ key: 'd', code: 'KeyD', altKey: true })
      await h.settle()
      assert.deepEqual(answers(api), [], `${tier}, ${why}: Alt A and Alt D send nothing`)
    }
    const api = fakeApi()
    const h = await harness(stateWith({ requests: [request('r', 's1', tier)], health: [{ dep: 'deckd', state: 'up' }] }), { api })
    h.key({ key: 'd', code: 'KeyD', altKey: true })
    await h.settle()
    assert.deepEqual(answers(api), [['POST', '/api/requests/r/answer', { choice: 'deny' }]], `${tier}: the same row answers once nothing blocks it`)
  }
})
