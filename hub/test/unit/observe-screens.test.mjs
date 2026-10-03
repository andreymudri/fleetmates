import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const screens = path.join(hub, 'web/src/screens')

async function load(name) {
  const { module } = await runnerImport(path.join(screens, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const NOW = Date.UTC(2026, 8, 30, 18, 42)
const MIN = 60_000
const RLO = '‮'
const RAW = /‮/u
const TOKEN = '&lt;U+202E&gt;'

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
const elements = (tree, type) => {
  const out = []
  walk(tree, node => { if (node.type === type) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return node.type.name === 'CrewAvatar' ? '' : textOf(node.type(node.props))
  return textOf(node.props?.children)
}
const click = element => {
  let prevented = false
  element.props.onClick({ button: 0, defaultPrevented: false, preventDefault: () => { prevented = true }, stopPropagation() {} })
  return prevented
}

function repo(name, slot) {
  return { id: `/home/you/dev/${name}`, repoId: `/home/you/dev/${name}`, name, crew: { slot, seed: name, hat: 'none' } }
}

function session(id, name, state, extra = {}) {
  return {
    id, repoId: `/home/you/dev/${name}`, origin: 'observed', task: `task ${id}`, branch: `br-${id}`, state, stateSince: NOW - 10 * MIN,
    lastActivityAt: NOW - 10 * MIN, startedAt: NOW - 60 * MIN, changedFiles: [], cwd: `/home/you/dev/${name}`, toolCalls: 4, alive: true, ...extra
  }
}

function busy() {
  const repos = ['rustot', 'discord', 'web', 'vault', 'turbid', 'axios', 'client', 'old', 'gone'].map((name, i) => repo(name, i))
  const sessions = [
    session('s5', 'turbid', 'idle', { stateSince: NOW - 70 * MIN }),
    session('s3', 'web', 'running'),
    session('s1', 'rustot', 'needs_approval', { task: 'Port the damage formula', branch: 'combat-tick' }),
    session('s4', 'vault', 'done', { stateSince: NOW - 6 * MIN }),
    session('s6', 'axios', 'stale', { lastActivityAt: NOW - 22 * MIN, stateSince: NOW - 2 * MIN }),
    session('s2', 'discord', 'asked_you'),
    session('s7', 'client', 'reviewed', { reviewedAt: NOW - MIN, stateSince: NOW - MIN }),
    session('s8', 'old', 'reviewed', { reviewedAt: NOW - 30 * 60 * MIN, stateSince: NOW - 30 * 60 * MIN }),
    session('s9', 'gone', 'ended')
  ]
  const requests = [
    { id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', toolName: 'Bash', summary: 'cargo test --release combat::', state: 'open', createdAt: NOW - 3 * MIN },
    { id: 'r2', sessionId: 's2', kind: 'question', tier: null, toolName: 'AskUserQuestion', summary: 'Paginate or truncate the logs?', state: 'open', createdAt: NOW - 9 * MIN },
    { id: 'r3', sessionId: 's1', kind: 'permission', tier: 'caution', toolName: 'Bash', summary: 'npm install commander@14', state: 'open', createdAt: NOW - MIN },
    { id: 'r4', sessionId: 's1', kind: 'permission', tier: 'destructive', toolName: 'Bash', summary: 'git push --force', state: 'open', createdAt: NOW - 2 * MIN },
    { id: 'r0', sessionId: 's3', kind: 'permission', tier: 'safe', toolName: 'Bash', summary: 'answered already', state: 'answered', createdAt: NOW - 20 * MIN }
  ]
  return {
    loaded: true,
    connection: { state: 'live', attempt: 0, nextAt: null },
    view: { path: '/', overlay: null },
    data: {
      sessions, requests, repos, runs: [], order: ['s1', 's2', 's3', 's4', 's6', 's5', 's7', 's8'],
      counts: { needYouSessions: 2, running: 1, toReview: 1, openRequests: 4, requestSessions: 2, oldestRequestAt: NOW - 9 * MIN, perRun: [] },
      recap: null, health: [], prefs: {}, setup: { firstRunCompletedAt: NOW - 1000 }
    }
  }
}

const withSessions = (state, sessions, extra = {}) => ({ ...state, data: { ...state.data, sessions, order: sessions.map(row => row.id), requests: [], ...extra } })
const many = (n, stateOf) => Array.from({ length: n }, (_, i) => session(`m${i}`, `r${i}`, stateOf(i), { stateSince: NOW - i * MIN }))

test('Home orders the grid by the server urgency order and the quiet row stale, idle, reviewed', async () => {
  const { homeLayout } = await load('home/Home.jsx')
  const state = busy()
  const layout = homeLayout(state.data.sessions, { order: state.data.order, now: NOW })
  assert.equal(layout.calm, false)
  assert.equal(layout.crowded, false)
  assert.deepEqual(layout.grid.map(row => row.id), ['s1', 's2', 's3', 's4'], 'needs, asked, running, done in server order; ended never shows')
  assert.deepEqual(layout.quiet.map(row => row.id), ['s6', 's5', 's7'], 'stale, idle, reviewed; yesterday\'s reviewed has left the grid')
  assert.deepEqual(layout.strip, [])

  const reversed = homeLayout(state.data.sessions, { order: ['s4', 's3', 's2', 's1'], now: NOW })
  assert.deepEqual(reversed.grid.map(row => row.id), ['s4', 's3', 's2', 's1'], 'the grid follows order, never array position')

  const unordered = homeLayout(state.data.sessions, { order: [], requests: state.data.requests, now: NOW })
  assert.deepEqual(unordered.grid.map(row => row.id), ['s1', 's2', 's3', 's4'], 'without a server order the local urgency rank applies')
  const twoIdle = [session('i1', 'a', 'idle', { stateSince: NOW - 50 * MIN }), session('i2', 'b', 'idle', { stateSince: NOW - 5 * MIN }), session('x', 'c', 'running')]
  assert.deepEqual(homeLayout(twoIdle, { order: [], now: NOW }).quiet.map(row => row.id), ['i2', 'i1'], 'within a quiet state newest stateSince first')
  const teammates = [session('lead', 'fm', 'running', { role: 'lead', runRef: { repoId: 'x', runId: 'r' } }), session('mate', 'fm', 'running', { role: 'teammate', runRef: { repoId: 'x', runId: 'r' } })]
  assert.deepEqual(homeLayout(teammates, { order: ['lead', 'mate'], now: NOW }).grid.map(row => row.id), ['lead'], 'a run\'s teammates never get their own cards')
})

test('crowding thresholds: 10 sessions or more than 3 quiet collapse into the strip, leaving only at 8', async () => {
  const { homeLayout, CROWDED_AT, CROWDED_LEAVE_AT, QUIET_MAX } = await load('home/Home.jsx')
  assert.equal(CROWDED_AT, 10)
  assert.equal(CROWDED_LEAVE_AT, 8)
  assert.equal(QUIET_MAX, 3)
  const crowded12 = [
    ...many(5, i => ['needs_approval', 'running', 'asked_you', 'running', 'crashed'][i]),
    session('d1', 'd1', 'done', { stateSince: NOW - MIN }), session('d2', 'd2', 'done', { stateSince: NOW - 2 * MIN }),
    session('i1', 'i1', 'idle', { stateSince: NOW - MIN }), session('i2', 'i2', 'idle', { stateSince: NOW - 2 * MIN }), session('i3', 'i3', 'idle', { stateSince: NOW - 3 * MIN }),
    session('v1', 'v1', 'reviewed', { reviewedAt: NOW - MIN }), session('st', 'st', 'stale')
  ]
  const order = crowded12.map(row => row.id)
  const layout = homeLayout(crowded12, { order, now: NOW })
  assert.equal(layout.crowded, true)
  assert.equal(layout.grid.length, 5, 'done leaves the grid when crowded')
  assert.deepEqual(layout.strip.map(row => row.id), ['st', 'd1', 'd2', 'i1', 'i2', 'i3', 'v1'], 'strip order: stale, done, idle, reviewed')
  assert.deepEqual(layout.quiet, [])

  const running = n => many(n, () => 'running')
  assert.equal(homeLayout(running(9), { order: [], now: NOW }).crowded, false, '9 sessions stay normal')
  assert.equal(homeLayout(running(10), { order: [], now: NOW }).crowded, true, '10 sessions crowd')
  assert.equal(homeLayout(running(9), { order: [], now: NOW, crowdedBefore: true }).crowded, true, 'hysteresis: 9 stays crowded')
  assert.equal(homeLayout(running(8), { order: [], now: NOW, crowdedBefore: true }).crowded, false, 'at 8 it returns to normal')
  const quiet = count => [session('run', 'run', 'running'), ...many(count, () => 'idle')]
  assert.equal(homeLayout(quiet(3), { order: [], now: NOW }).crowded, false, '3 quiet sessions fit the row')
  assert.equal(homeLayout(quiet(4), { order: [], now: NOW }).crowded, true, 'a fourth quiet session crowds')
  assert.equal(homeLayout(quiet(3), { order: [], now: NOW }).quiet.length, 3)
})

test('calm shows only when nothing runs, needs you, crashed or is adrift', async () => {
  const { homeLayout, HomeView } = await load('home/Home.jsx')
  for (const state of ['starting', 'running', 'needs_approval', 'asked_you', 'crashed', 'stale']) {
    assert.equal(homeLayout([session('a', 'a', state)], { order: [], now: NOW }).calm, false, `${state} blocks calm`)
  }
  for (const state of ['done', 'idle', 'reviewed', 'ended']) {
    assert.equal(homeLayout([session('a', 'a', state, { reviewedAt: NOW })], { order: [], now: NOW }).calm, true, `${state} keeps calm`)
  }
  const base = busy()
  const calmState = withSessions(base, [session('s4', 'vault', 'done')])
  const calm = render(HomeView, { state: calmState, now: NOW, navigate: () => {} })
  assert.match(calm, /<h1[^>]*>Calm seas\. No ships out\.<\/h1>/)
  assert.doesNotMatch(calm, /<article/, 'no session card in calm')
  assert.match(calm, /vault waits in port for review/, 'done sessions are open loops')
  assert.match(calm, /Open loops before tomorrow/)
  const empty = render(HomeView, { state: withSessions(base, [], { repos: [] }), now: NOW, navigate: () => {} })
  assert.match(empty, /<h1 class="empty-title">Calm seas\. No ships out\.<\/h1>/)
  assert.match(empty, /No ships yet\. Launch one, or start claude in a terminal and it shows up here\./, 'first use: no repo seen yet')
  const quietSeas = render(HomeView, { state: withSessions(base, []), now: NOW, navigate: () => {} })
  assert.match(quietSeas, /<h1[^>]*>Calm seas\. No ships out\.<\/h1>/)
  assert.match(quietSeas, /No open loops\./)
  assert.doesNotMatch(quietSeas, /No ships yet/, 'known repos are not a first use')
  const grid = render(HomeView, { state: base, now: NOW, navigate: () => {} })
  assert.match(grid, /<h1[^>]*>Sessions<\/h1>/)
  assert.doesNotMatch(grid, /Calm seas/)
})

test('Home renders cards in order, the quiet row, the strip and the header chips', async () => {
  const { HomeView } = await load('home/Home.jsx')
  const html = render(HomeView, { state: busy(), now: NOW, navigate: () => {} })
  const cards = [...html.matchAll(/<article class="session-card[^"]*" aria-labelledby="card-title-(\w+)"/g)].map(match => match[1])
  assert.deepEqual(cards, ['s1', 's2', 's3', 's4'])
  const quiet = [...html.matchAll(/<article class="quiet-card[^"]*" aria-labelledby="card-title-(\w+)"/g)].map(match => match[1])
  assert.deepEqual(quiet, ['s6', 's5', 's7'])
  assert.match(html, /<h2 class="sr-only"[^>]*>Active sessions<\/h2>/)
  assert.match(html, /<h2 class="sr-only"[^>]*>Quiet sessions<\/h2>/)
  assert.match(html, />2 need you</)
  assert.match(html, />1 running</)
  assert.match(html, />1 to review</)
  assert.match(html, /Answer in your terminal/, 'observed request boxes say answer in your terminal')
  assert.doesNotMatch(html, />(Allow once|Deny|Reply|Nudge \(send Enter\)|Stop…)</, 'no answer or control buttons on observed cards')
  assert.match(html, /Search, ask or run/)

  const crowded = withSessions(busy(), [...many(10, () => 'running'), session('d1', 'd1', 'done'), session('i1', 'i1', 'idle')])
  const strip = render(HomeView, { state: crowded, now: NOW, navigate: () => {} })
  assert.equal((strip.match(/<article class="session-card/g) ?? []).length, 10)
  assert.match(strip, /<ul class="quiet-strip"/)
  assert.match(strip, /<a class="strip-chip"[^>]*href="\/s\/d1\?tab=changes"[^>]*aria-label="d1 · task d1, Done"/, 'done chips open the Changes tab and carry a full name')
  assert.match(strip, /<a class="strip-chip"[^>]*href="\/s\/i1"[^>]*aria-label="i1 · task i1, Idle 10m"/)
})

test('the quiet strip caps its chips and "+N more" opens the palette', async () => {
  const { HomeView, STRIP_MAX } = await load('home/Home.jsx')
  const state = withSessions(busy(), [session('run', 'run', 'running'), ...many(STRIP_MAX + 2, () => 'idle')])
  const calls = []
  const tree = HomeView({ state, now: NOW, navigate: () => {}, onOverlay: overlay => calls.push(overlay) })
  const chips = elements(tree, 'a').filter(node => node.props.className === 'strip-chip')
  assert.equal(chips.length, STRIP_MAX)
  const more = elements(tree, 'button').find(node => node.props.className?.includes('strip-more'))
  assert.equal(textOf(more), '+2 more')
  more.props.onClick()
  assert.deepEqual(calls, ['palette'])
})

test('Home header actions: Needs you opens the drawer, To review opens the oldest done, search opens the palette', async () => {
  const { HomeView } = await load('home/Home.jsx')
  const state = busy()
  state.data.sessions.push(session('s10', 'web', 'done', { stateSince: NOW - 40 * MIN }))
  state.data.counts = { ...state.data.counts, toReview: 2 }
  const overlays = []
  const routes = []
  const focused = []
  const tree = HomeView({ state, now: NOW, navigate: to => routes.push(to), onOverlay: overlay => overlays.push(overlay), onFocusCard: id => focused.push(id) })
  const buttons = elements(tree, 'button')
  const chip = name => buttons.find(node => node.props.className === `count-chip count-chip--${name}`)
  chip('needs').props.onClick()
  assert.deepEqual(overlays, ['drawer'])
  chip('review').props.onClick()
  assert.deepEqual(routes, ['/s/s10?tab=changes'], 'the oldest done session, Changes tab')
  chip('running').props.onClick()
  assert.deepEqual(focused, ['s3'], 'the first running card')
  const search = buttons.find(node => node.props.className?.includes('home-search'))
  search.props.onClick()
  assert.deepEqual(overlays, ['drawer', 'palette'])
})

test('every in-app Home, drawer and Focus link routes through navigate', async () => {
  const { HomeView } = await load('home/Home.jsx')
  const { DrawerView } = await load('drawer/NeedsYouDrawer.jsx')
  const { FocusView } = await load('focus/Focus.jsx')
  const state = busy()
  const crowded = withSessions(busy(), [...many(10, () => 'running'), session('d1', 'd1', 'done')])
  const calm = withSessions(busy(), [session('s4', 'vault', 'done')])
  const trees = [
    ['home grid', navigate => HomeView({ state, now: NOW, navigate })],
    ['home strip', navigate => HomeView({ state: crowded, now: NOW, navigate })],
    ['home calm', navigate => HomeView({ state: calm, now: NOW, navigate })],
    ['drawer', navigate => DrawerView({ state, now: NOW, navigate, onLeave: () => {} })],
    ['focus', navigate => FocusView({ state, sessionId: 's1', now: NOW, navigate, steps: [], tab: 'changes', onTab: () => {} })],
    ['focus missing', navigate => FocusView({ state, sessionId: 'nope', now: NOW, navigate, steps: [], tab: 'changes', onTab: () => {} })]
  ]
  for (const [name, build] of trees) {
    const calls = []
    const links = elements(build(to => calls.push(to)), 'a').filter(link => link.props.href?.startsWith('/'))
    assert.ok(links.length > 0, `${name} has links`)
    for (const link of links) {
      assert.equal(typeof link.props.onClick, 'function', `${name}: ${link.props.href} has a click handler`)
      assert.ok(click(link), `${name}: ${link.props.href} prevents the full page load`)
    }
    assert.deepEqual(calls, links.map(link => link.props.href), `${name}: navigate receives each href`)
  }
})

test('palette search is case and accent insensitive, by substring and by word prefix', async () => {
  const { normalizeText, matchesQuery } = await load('palette/Palette.jsx')
  assert.equal(normalizeText('Ação Été'), 'acao ete')
  assert.ok(matchesQuery('', ['anything']))
  assert.ok(matchesQuery('RUST', ['rustot']), 'case')
  assert.ok(matchesQuery('acao', ['Migração da ação']), 'accents in the text')
  assert.ok(matchesQuery('ação', ['acao lenta']), 'accents in the query')
  assert.ok(matchesQuery('bat-ti', ['combat-tick']), 'substring')
  assert.ok(matchesQuery('com ti', ['rustot', 'combat-tick']), 'every query word prefixes some word')
  assert.ok(!matchesQuery('com ti', ['rustot', 'combat']), 'every query word must prefix a word')
  assert.ok(!matchesQuery('om ic', ['combat-tick']), 'word prefix means the start of a word')
  assert.ok(!matchesQuery('cmbt', ['combat-tick']), 'no fuzzy subsequence')
})

test('palette groups: Needs you then Sessions in urgency order, Alt N for the first 9, capped at 5 with Show all', async () => {
  const { paletteModel, GROUP_MAX } = await load('palette/Palette.jsx')
  assert.equal(GROUP_MAX, 5)
  const state = busy()
  const model = paletteModel(state, { query: '', now: NOW })
  assert.deepEqual(model.groups.map(group => group.id), ['needs', 'sessions', 'actions'])
  const needs = model.groups[0]
  assert.deepEqual(needs.rows.map(row => row.requestId), ['r2', 'r1', 'r4', 'r3'], 'oldest request first; closed requests never show')
  assert.equal(needs.rows[1].title, 'rustot · cargo test --release combat::')
  assert.equal(needs.rows[1].subtitle, 'Safe · Bash · waiting 3m · Answer in your terminal')
  assert.equal(needs.rows[0].subtitle, 'Question · AskUserQuestion · waiting 9m · Answer in your terminal')
  const sessions = model.groups[1]
  assert.deepEqual(sessions.rows.map(row => row.sessionId), ['s1', 's2', 's3', 's4', 's6'])
  assert.equal(sessions.total, 8, 'the palette lists every session that has not ended')
  assert.equal(sessions.rows[0].title, 'rustot · combat-tick')
  assert.deepEqual(sessions.rows.map(row => row.kbd), ['Alt 1', 'Alt 2', 'Alt 3', 'Alt 4', 'Alt 5'])
  assert.equal(model.rows.find(row => row.kind === 'showAll' && row.group === 'sessions').title, 'Show all 8 sessions')
  // M2 (palette.md 4.1): Actions open with Launch a ship and three recent harbors (equal session starts sort
  // by name), then the review action.
  assert.deepEqual(model.groups[2].rows.map(row => row.title),
    ['Launch a ship', 'Launch a ship in axios', 'Launch a ship in client', 'Launch a ship in discord', 'Mark vault · task s4 reviewed'])

  const fifteen = withSessions(busy(), many(15, () => 'running'))
  const expanded = paletteModel(fifteen, { query: '', now: NOW, expanded: ['sessions'] })
  const rows = expanded.groups.find(group => group.id === 'sessions').rows
  assert.equal(rows.length, 15)
  assert.deepEqual(rows.map(row => row.kbd ?? null), [...Array.from({ length: 9 }, (_, i) => `Alt ${i + 1}`), null, null, null, null, null, null])

  const filtered = paletteModel(state, { query: 'RUST', now: NOW })
  assert.deepEqual(filtered.groups.map(group => group.id), ['needs', 'sessions', 'actions'])
  assert.deepEqual(filtered.groups[2].rows.map(row => row.title), ['Launch a ship in rustot'], 'a query offers launch rows for matching repos')
  assert.deepEqual(filtered.groups[1].rows.map(row => [row.sessionId, row.kbd]), [['s1', 'Alt 1']], 'the Kbd keeps the urgency position')
  assert.equal(filtered.active, 0)
  assert.deepEqual(paletteModel(state, { query: 'zzz', now: NOW }).rows, [])
  const emptyHtml = render((await load('palette/Palette.jsx')).PaletteView, { model: paletteModel(state, { query: 'zzz', now: NOW }), query: 'zzz', active: -1 })
  assert.match(emptyHtml, /No matches\./)
})

test('palette keys and rows: arrows and Alt J/K move, Enter jumps to the session, Esc closes', async () => {
  const { paletteKey, runRow, moveActive } = await load('palette/Palette.jsx')
  const key = (code, mods = {}) => paletteKey({ code, key: code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods })
  assert.deepEqual(key('ArrowDown'), { type: 'move', delta: 1 })
  assert.deepEqual(key('ArrowUp'), { type: 'move', delta: -1 })
  assert.deepEqual(key('KeyJ', { altKey: true }), { type: 'move', delta: 1 })
  assert.deepEqual(key('KeyK', { altKey: true }), { type: 'move', delta: -1 })
  assert.deepEqual(key('Enter'), { type: 'run', terminal: false })
  assert.deepEqual(key('Enter', { altKey: true }), { type: 'run', terminal: true })
  assert.deepEqual(key('Escape'), { type: 'close' })
  assert.equal(key('KeyJ'), null, 'plain letters are typing')
  assert.equal(moveActive(0, -1, 4), 3, 'wraps up')
  assert.equal(moveActive(3, 1, 4), 0, 'wraps down')
  assert.equal(moveActive(-1, 1, 0), -1)

  const log = []
  const env = { navigate: to => log.push(['navigate', to]), leave: () => log.push(['leave']), onClose: () => log.push(['close']), expand: group => log.push(['expand', group]),
    api: { post: async to => { log.push(['post', to]) } } }
  await runRow({ kind: 'session', sessionId: 'a b' }, env)
  assert.deepEqual(log.splice(0), [['leave'], ['navigate', '/s/a%20b']])
  await runRow({ kind: 'needs', sessionId: 's1', requestId: 'r1' }, env)
  assert.deepEqual(log.splice(0), [['leave'], ['navigate', '/s/s1']], 'M1 needs rows jump to Focus; nothing is answered')
  await runRow({ kind: 'review', sessionId: 's4' }, env)
  assert.deepEqual(log.splice(0), [['post', '/api/sessions/s4/mark-reviewed'], ['close']])
  await runRow({ kind: 'showAll', group: 'sessions' }, env)
  assert.deepEqual(log.splice(0), [['expand', 'sessions']])
})

test('the palette is a combobox with grouped options and an active descendant', async () => {
  const { PaletteView, paletteModel } = await load('palette/Palette.jsx')
  const html = render(PaletteView, { model: paletteModel(busy(), { query: '', now: NOW }), query: '', active: 1 })
  assert.match(html, /role="dialog"[^>]*aria-modal="true"/)
  assert.match(html, /<input[^>]*role="combobox"[^>]*aria-expanded="true"[^>]*aria-controls="palette-list"[^>]*aria-activedescendant="palette-opt-1"/)
  assert.match(html, /aria-label="Search, ask or run"/)
  assert.match(html, /<ul[^>]*id="palette-list"[^>]*role="listbox"/)
  assert.match(html, /role="group" aria-labelledby="palette-group-needs"/)
  assert.match(html, /<li[^>]*id="palette-opt-1"[^>]*role="option"[^>]*aria-selected="true"/)
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
  assert.match(html, /<kbd class="kbd" aria-hidden="true">Alt 1<\/kbd>/)
})

test('the read-only drawer groups by tier, counts from the server and only says answer in your terminal', async () => {
  const { DrawerView, drawerSections } = await load('drawer/NeedsYouDrawer.jsx')
  const state = busy()
  assert.deepEqual(drawerSections(state.data.requests).map(section => [section.tier, section.requests.map(row => row.id)]),
    [['safe', ['r1']], ['caution', ['r3']], ['question', ['r2']], ['destructive', ['r4']]])
  assert.deepEqual(drawerSections([{ id: 'x', kind: 'permission', tier: 'safe', state: 'open', createdAt: 2 }, { id: 'y', kind: 'permission', tier: 'safe', state: 'open', createdAt: 1 }]).map(section => section.requests.map(row => row.id)), [['y', 'x']], 'oldest first inside a section')
  const html = render(DrawerView, { state, now: NOW, navigate: () => {} })
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="drawer-title"/)
  assert.match(html, /<h2 id="drawer-title"[^>]*>Needs you<\/h2>/)
  assert.match(html, /4 requests from 2 ships · oldest waiting 9m/)
  assert.equal((html.match(/Answer in your terminal</g) ?? []).length, 4, 'every row')
  assert.doesNotMatch(html, />(Allow once|Deny|Reply|Allow both Safe once)</)
  assert.doesNotMatch(html, /<(input|textarea)/, 'no reply field in M1')
  assert.match(html, /Answer in your terminal for now\. Answering here arrives with approvals\./)
  assert.match(html, /rustot · combat-tick · waiting 3m/)
  const order = [...html.matchAll(/<h3 class="drawer-section-title"><span class="tier-badge tier-badge--(\w+)">/g)].map(match => match[1])
  assert.deepEqual(order, ['safe', 'caution', 'question', 'destructive'])

  const empty = render(DrawerView, { state: { ...state, data: { ...state.data, requests: [], counts: { ...state.data.counts, openRequests: 0 } } }, now: NOW, navigate: () => {} })
  assert.match(empty, /Nothing needs you\./)
  const loading = render(DrawerView, { state: { ...state, loaded: false }, now: NOW, navigate: () => {} })
  assert.match(loading, /aria-busy="true"/)
  assert.equal((loading.match(/drawer-skeleton/g) ?? []).length, 3)
})

test('drawer Open leaves the overlay, then jumps to the session; close goes back', async () => {
  const { DrawerView, openOverlay, closeOverlay, leaveOverlay } = await load('drawer/NeedsYouDrawer.jsx')
  const log = []
  const tree = DrawerView({ state: busy(), now: NOW, navigate: to => log.push(['navigate', to]), onLeave: () => log.push(['leave']), onClose: () => log.push(['close']) })
  const open = elements(tree, 'a').find(link => link.props.href === '/s/s1')
  click(open)
  assert.deepEqual(log.splice(0), [['leave'], ['navigate', '/s/s1']])
  const close = elements(tree, 'button').find(node => node.props['aria-label'] === 'Close')
  close.props.onClick()
  assert.deepEqual(log.splice(0), [['close']])

  const env = () => {
    const calls = []
    return {
      calls,
      location: { pathname: '/s/x', search: '?tab=facts' },
      history: { state: null, pushState: (s, _, url) => calls.push(['push', s, url]), replaceState: (s, _, url) => calls.push(['replace', s, url]), back: () => calls.push(['back']) },
      PopStateEvent: class { constructor(type, init) { this.type = type; this.state = init.state } },
      dispatchEvent: event => calls.push(['pop', event.state])
    }
  }
  const a = env()
  openOverlay('drawer', a)
  assert.deepEqual(a.calls, [['push', { overlay: 'drawer' }, '/s/x?tab=facts'], ['pop', { overlay: 'drawer' }]])
  const b = env()
  b.history.state = { overlay: 'drawer' }
  closeOverlay(b)
  assert.deepEqual(b.calls, [['back']], 'an overlay entry is closed with Back')
  const c = env()
  leaveOverlay(c)
  assert.deepEqual(c.calls, [['replace', null, '/s/x?tab=facts'], ['pop', null]])
})

test('read-only Focus: header, observed banner, requests say answer in your terminal, no terminal or controls', async () => {
  const { FocusView } = await load('focus/Focus.jsx')
  const state = busy()
  const steps = [{ seq: 1, at: NOW - 2 * MIN, toolName: 'Read', line: 'Read src/combat.rs', status: 'ok' }, { seq: 2, at: NOW - MIN, toolName: 'Bash', line: 'cargo test', status: 'running' }]
  const html = render(FocusView, { state, sessionId: 's1', now: NOW, navigate: () => {}, steps, tab: 'changes', onTab: () => {} })
  assert.match(html, /<aside[^>]*aria-label="Sessions"/)
  assert.match(html, /<a[^>]*href="\/"[^>]*>[^<]*All ships/)
  assert.match(html, /<a[^>]*aria-current="page"[^>]*href="\/s\/s1"|<a[^>]*href="\/s\/s1"[^>]*aria-current="page"/)
  assert.equal((html.match(/class="focus-list-row"/g) ?? []).length, 8, 'every non-ended session')
  assert.match(html, /<h1 class="focus-title"[^>]*><bdi>Port the damage formula<\/bdi><\/h1>/)
  assert.match(html, /Needs approval · 3m/, 'waiting since the oldest open request')
  assert.match(html, /Observed session: started as plain claude, read-only here\./)
  assert.equal((html.match(/class="focus-request /g) ?? []).length, 3, 'one bar per open request of this session')
  assert.equal((html.match(/Answer in your terminal</g) ?? []).length, 3)
  const log = /<ol class="focus-steps">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? ''
  assert.deepEqual([...log.matchAll(/<span class="focus-step-text">([^<]*)<\/span>/g)].map(match => match[1]), ['Read src/combat.rs', 'cargo test'], 'activity log, newest at the bottom')
  const shuffled = render(FocusView, { state, sessionId: 's1', now: NOW, navigate: () => {}, steps: [...steps].reverse(), tab: 'changes', onTab: () => {} })
  assert.ok(shuffled.indexOf('>Read src/combat.rs<') < shuffled.indexOf('>cargo test<'), 'ordered by seq, not by arrival')
  assert.doesNotMatch(html, /<(input|textarea)|xterm/, 'no terminal and no input')
  assert.doesNotMatch(html, />(Stop…|Nudge \(send Enter\)|Allow once|Deny|Reply|Mark reviewed)</, 'no controls on an observed needs session')
  assert.match(html, /No changes yet\./)

  const done = render(FocusView, { state, sessionId: 's4', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {} })
  assert.match(done, /<button[^>]*>Mark reviewed<\/button>/)
  for (const id of ['s2', 's3', 's5', 's6', 's7']) {
    assert.doesNotMatch(render(FocusView, { state, sessionId: id, now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {} }), />Mark reviewed</, `${id} is not done`)
  }
  const missing = render(FocusView, { state, sessionId: 'nope', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {} })
  assert.match(missing, /This session is not on the deck\./)
})

test('Mark reviewed posts to the session and reports failure', async () => {
  const { FocusView, markReviewed } = await load('focus/Focus.jsx')
  const posts = []
  await markReviewed({ post: async to => { posts.push(to) } }, 'a/b')
  assert.deepEqual(posts, ['/api/sessions/a%2Fb/mark-reviewed'])
  const calls = []
  const tree = FocusView({ state: busy(), sessionId: 's4', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, onMarkReviewed: () => calls.push('review') })
  const button = elements(tree, 'button').find(node => textOf(node) === 'Mark reviewed')
  button.props.onClick()
  assert.deepEqual(calls, ['review'])
  const pending = FocusView({ state: busy(), sessionId: 's4', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, reviewing: true })
  assert.equal(elements(pending, 'button').find(node => textOf(node) === 'Mark reviewed').props.disabled, true)
  const failed = render(FocusView, { state: busy(), sessionId: 's4', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, reviewError: 'invalid_state' })
  assert.match(failed, /Could not mark this session reviewed\./)
})

test('Focus details: changed files, facts tab and tab switching', async () => {
  const { FocusView } = await load('focus/Focus.jsx')
  const state = busy()
  state.data.sessions = state.data.sessions.map(row => row.id === 's3' ? { ...row, changedFiles: [{ path: 'src/a.rs', adds: 3, dels: 1 }], claudeSessionId: 'c-1', transcriptPath: '/home/you/.claude/t.jsonl' } : row)
  const tabs = []
  const tree = FocusView({ state, sessionId: 's3', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: tab => tabs.push(tab) })
  const html = renderToStaticMarkup(tree)
  assert.match(html, /role="tablist"/)
  assert.match(html, /<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Changes 1<\/button>/)
  assert.match(html, /src\/a\.rs/)
  elements(tree, 'button').find(node => node.props.role === 'tab' && textOf(node) === 'Facts').props.onClick()
  assert.deepEqual(tabs, ['facts'])
  const facts = render(FocusView, { state, sessionId: 's3', now: NOW, navigate: () => {}, steps: [], tab: 'facts', onTab: () => {} })
  assert.match(facts, /<dt>Claude session<\/dt><dd>c-1<\/dd>/)
  assert.match(facts, /<dt>Transcript<\/dt><dd>\/home\/you\/\.claude\/t\.jsonl<\/dd>/)
  assert.match(facts, /<dt>Started from<\/dt><dd>plain claude \(observed\)<\/dd>/)
})

test('every agent-supplied string on the observe screens passes through its sanitizer', async () => {
  const { HomeView } = await load('home/Home.jsx')
  const { PaletteView, paletteModel } = await load('palette/Palette.jsx')
  const { DrawerView } = await load('drawer/NeedsYouDrawer.jsx')
  const { FocusView } = await load('focus/Focus.jsx')
  const evil = () => {
    const state = busy()
    state.data.repos = state.data.repos.map(row => ({ ...row, name: `${row.name}${RLO}x` }))
    state.data.sessions = state.data.sessions.map(row => ({ ...row, task: `${row.task}${RLO}t`, branch: `${row.branch}${RLO}b`, cwd: `/home/you/${RLO}c`, claudeSessionId: `id${RLO}`, transcriptPath: `/home/you/${RLO}t.jsonl`, changedFiles: [{ path: `src/${RLO}f.rs`, adds: 1, dels: 0 }] }))
    state.data.requests = state.data.requests.map(row => ({ ...row, summary: `${row.summary}${RLO}s`, toolName: `${row.toolName}${RLO}n` }))
    return state
  }
  const checks = [
    ['home grid', () => render(HomeView, { state: evil(), now: NOW, navigate: () => {} })],
    ['home strip', () => { const s = evil()
      return render(HomeView, { state: withSessions(s, [...many(10, () => 'running'), { ...session('d1', 'rustot', 'done'), task: `t${RLO}`, branch: `b${RLO}` }], { repos: s.data.repos }), now: NOW, navigate: () => {} }) }],
    ['home calm', () => { const s = evil()
      return render(HomeView, { state: withSessions(s, [session('d1', 'rustot', 'done')], { repos: s.data.repos }), now: NOW, navigate: () => {} }) }],
    ['palette', () => { const s = evil()
      return render(PaletteView, { model: paletteModel(s, { query: '', now: NOW, expanded: ['sessions'] }), query: '', active: 0 }) }],
    ['drawer', () => render(DrawerView, { state: evil(), now: NOW, navigate: () => {} })],
    ['focus changes', () => render(FocusView, { state: evil(), sessionId: 's1', now: NOW, navigate: () => {}, steps: [{ seq: 1, at: NOW, toolName: `Ed${RLO}it`, line: `Edit ${RLO}x`, status: 'ok' }], tab: 'changes', onTab: () => {} })],
    ['focus facts', () => render(FocusView, { state: evil(), sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'facts', onTab: () => {} })]
  ]
  for (const [name, build] of checks) {
    const html = build()
    assert.doesNotMatch(html, RAW, `${name} carries a raw RLO`)
    assert.ok(html.includes(TOKEN), `${name} shows the visible token`)
  }
})

test('each agent-supplied field is sanitized on its own', async () => {
  const { HomeView } = await load('home/Home.jsx')
  const { PaletteView, paletteModel } = await load('palette/Palette.jsx')
  const { DrawerView } = await load('drawer/NeedsYouDrawer.jsx')
  const { FocusView } = await load('focus/Focus.jsx')
  // One field at a time, so removing any single sanitizer call fails exactly one case.
  const one = (patch) => {
    const state = busy()
    patch(state)
    return state
  }
  const repoName = s => { s.data.repos = s.data.repos.map(row => ({ ...row, name: `${row.name}${RLO}` })) }
  const task = s => { s.data.sessions = s.data.sessions.map(row => ({ ...row, task: `${row.task}${RLO}` })) }
  const branch = s => { s.data.sessions = s.data.sessions.map(row => ({ ...row, branch: `${row.branch}${RLO}` })) }
  const summary = s => { s.data.requests = s.data.requests.map(row => ({ ...row, summary: `${row.summary}${RLO}` })) }
  const toolName = s => { s.data.requests = s.data.requests.map(row => ({ ...row, toolName: `${row.toolName}${RLO}` })) }
  const field = key => s => { s.data.sessions = s.data.sessions.map(row => ({ ...row, [key]: `v${RLO}` })) }
  const files = s => { s.data.sessions = s.data.sessions.map(row => ({ ...row, changedFiles: [{ path: `src/${RLO}f.rs`, adds: 1, dels: 0 }] })) }
  const focus = (patch, tab = 'changes', steps = [], id = 's1') => render(FocusView, { state: one(patch), sessionId: id, now: NOW, navigate: () => {}, steps, tab, onTab: () => {} })
  const palette = patch => render(PaletteView, { model: paletteModel(one(patch), { query: '', now: NOW, expanded: ['sessions', 'needs'] }), query: '', active: 0 })
  const drawer = patch => render(DrawerView, { state: one(patch), now: NOW, navigate: () => {} })
  const calm = patch => { const s = one(patch)
    return render(HomeView, { state: withSessions(s, s.data.sessions.filter(row => row.id === 's4'), { repos: s.data.repos }), now: NOW, navigate: () => {} }) }
  const strip = patch => { const s = one(patch)
    const sessions = [...many(10, () => 'running'), ...s.data.sessions.filter(row => row.id === 's5')]
    return render(HomeView, { state: withSessions(s, sessions, { repos: s.data.repos }), now: NOW, navigate: () => {} }) }
  const cases = [
    ['palette needs: repo', palette(repoName), 'palette-row-title'],
    ['palette needs: summary', palette(summary), 'palette-row-title'],
    ['palette needs: tool', palette(toolName), 'palette-row-sub'],
    ['palette session: branch', palette(branch), 'palette-row-title'],
    ['palette session: task', palette(s => { branch(s)
      s.data.sessions = s.data.sessions.map(row => ({ ...row, branch: null, task: `${row.task}${RLO}` })) }), 'palette-row-title'],
    ['drawer: summary', drawer(summary), 'drawer-command'],
    ['drawer: question', drawer(s => { s.data.requests = s.data.requests.filter(row => row.kind === 'question').map(row => ({ ...row, summary: `q${RLO}` })) }), 'drawer-question'],
    ['drawer: repo', drawer(repoName), 'drawer-source'],
    ['drawer: teammate task id', drawer(s => { s.data.requests = s.data.requests.map(row => ({ ...row, taskId: `T4${RLO}` })) }), 'drawer-source'],
    ['focus: question summary', focus(summary, 'changes', [], 's2'), 'focus-request-summary'],
    ['focus: facts unknown origin', focus(field('origin'), 'facts'), 'focus-facts'],
    ['drawer: branch', drawer(branch), 'drawer-source'],
    ['focus: title', focus(task), 'focus-title'],
    ['focus: repo', focus(repoName), 'focus-subtitle'],
    ['focus: branch', focus(branch), 'focus-subtitle'],
    ['focus: cwd', focus(field('cwd')), 'focus-subtitle'],
    ['focus: request summary', focus(summary), 'focus-request-summary'],
    ['focus: step line', focus(() => {}, 'changes', [{ seq: 1, at: NOW, toolName: 'Edit', line: `Edit ${RLO}x`, status: 'ok' }]), 'focus-step-text'],
    ['focus: file path', focus(files), 'focus-file-path'],
    ['focus: list repo', focus(repoName), 'focus-list-title'],
    ['focus: facts claude session', focus(field('claudeSessionId'), 'facts'), 'focus-facts'],
    ['focus: facts transcript', focus(field('transcriptPath'), 'facts'), 'focus-facts'],
    ['focus: facts cwd', focus(field('cwd'), 'facts'), 'focus-facts'],
    ['focus: facts branch', focus(branch, 'facts'), 'focus-facts'],
    ['calm: repo', calm(repoName), 'calm-loop'],
    ['strip: repo', strip(repoName), 'strip-chip'],
    ['strip: task', strip(task), 'strip-chip']
  ]
  for (const [name, html, className] of cases) {
    assert.doesNotMatch(html, RAW, `${name}: raw RLO reached the page`)
    const at = html.indexOf(`class="${className}`)
    assert.ok(at >= 0, `${name}: ${className} renders`)
    assert.ok(html.slice(at).includes(TOKEN), `${name}: token shown in or after ${className}`)
  }
})

test('observe screens never inject HTML and their styles use tokens without private motion', async () => {
  const sources = await Promise.all(['home/Home.jsx', 'palette/Palette.jsx', 'drawer/NeedsYouDrawer.jsx', 'focus/Focus.jsx'].map(name => readFile(path.join(screens, name), 'utf8')))
  for (const source of sources) {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    assert.doesNotMatch(code, /dangerouslySetInnerHTML|innerHTML/)
    assert.doesNotMatch(code, /import\s+['"][^'"]+\.css['"]/, 'screens never import CSS (T12 wires styles in main.jsx)')
  }
  const { HomeView } = await load('home/Home.jsx')
  const state = busy()
  state.data.sessions[2] = { ...state.data.sessions[2], task: '<img src=x onerror=alert(1)>' }
  const html = render(HomeView, { state, now: NOW, navigate: () => {} })
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)

  const css = await readFile(path.join(hub, 'web/src/styles/observe.css'), 'utf8')
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(rules, /prefers-reduced-motion/, 'reduced motion is handled once in tokens.css')
  assert.doesNotMatch(rules, /animation\s*:/)
  assert.doesNotMatch(rules, /outline\s*:\s*(none|0)/)
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i, 'no raw colors outside tokens')
  for (const selector of ['.home-grid', '.quiet-row', '.quiet-strip', '.palette', '.drawer', '.focus-screen']) assert.ok(rules.includes(`${selector} {`) || rules.includes(`${selector},`), `${selector} is styled`)
  assert.match(rules, /\.palette-scrim[^{]*\{[^}]*z-index:\s*var\(--z-palette\)/)
  assert.match(rules, /\.drawer-scrim[^{]*\{[^}]*z-index:\s*var\(--z-drawer\)/)
})

test('the overlay focus trap wraps Tab and Shift Tab at the ends and leaves other keys alone', async () => {
  const { trapTab } = await load('drawer/NeedsYouDrawer.jsx')
  const focused = []
  const item = name => ({ name, focus: () => focused.push(name) })
  const first = item('first')
  const middle = item('middle')
  const last = item('last')
  const doc = { activeElement: last }
  const container = { ownerDocument: doc, querySelectorAll: () => [first, middle, last] }
  const press = (key, shiftKey = false) => {
    let prevented = false
    trapTab({ key, shiftKey, preventDefault: () => { prevented = true } }, container)
    return prevented
  }
  assert.equal(press('Tab'), true)
  assert.deepEqual(focused.splice(0), ['first'], 'Tab on the last item wraps to the first')
  doc.activeElement = first
  assert.equal(press('Tab', true), true)
  assert.deepEqual(focused.splice(0), ['last'], 'Shift Tab on the first item wraps to the last')
  doc.activeElement = middle
  assert.equal(press('Tab'), false, 'inside the list Tab moves normally')
  assert.equal(press('Enter'), false)
  assert.deepEqual(focused, [])
})
