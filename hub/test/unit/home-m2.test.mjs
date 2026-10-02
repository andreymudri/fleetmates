import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const src = path.join(hub, 'web/src')

async function load(name) {
  const { module } = await runnerImport(path.join(src, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const NOW = Date.UTC(2026, 8, 30, 18, 42)
const MIN = 60_000

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

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), map }
}

const repoRow = (name, extra = {}) => ({ id: `/home/you/dev/${name}`, repoId: `/home/you/dev/${name}`, repoKey: name, name, crew: { slot: 1, seed: name, hat: 'none' }, ...extra })

function session(id, name, state, extra = {}) {
  return {
    id, repoId: `/home/you/dev/${name}`, origin: 'launched', ptyId: `p-${id}`, alive: true, task: `task ${id}`, branch: `br-${id}`, state,
    stateSince: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN, startedAt: NOW - 60 * MIN, changedFiles: [], toolCalls: 1, ...extra
  }
}

function stateWith(sessions, extra = {}) {
  const names = [...new Set(sessions.map(row => row.repoId.split('/').at(-1)))]
  return {
    loaded: true,
    connection: { state: 'live', attempt: 0, nextAt: null },
    view: { path: '/', overlay: null },
    data: {
      sessions, requests: [], runs: [], repos: names.map(name => repoRow(name)), order: sessions.map(row => row.id),
      counts: { needYouSessions: 0, running: sessions.length, toReview: 0, openRequests: 0, requestSessions: 0, oldestRequestAt: null, perRun: [] },
      health: [], prefs: {}, tails: {}, inputSources: {}, setup: { firstRunCompletedAt: NOW - 1000 }, ...extra
    }
  }
}

const nine = () => Array.from({ length: 9 }, (_, i) => session(`c${i}`, `repo${i}`, 'running', { stateSince: NOW - i * MIN }))

test('compact renders 9 cards in a 3 x 3 grid and the density survives a reload through the storage helper (home AC13)', async () => {
  const { Home, HomeView, pickDensity } = await load('screens/home/Home.jsx')
  const storage = memoryStorage()
  const state = stateWith(nine())
  // Comfortable by default: a radiogroup with Comfortable checked.
  const first = render(Home, { state, navigate: () => {}, storage })
  assert.match(first, /role="radiogroup" aria-label="Density"/)
  assert.match(first, /role="radio"[^>]*aria-checked="true"[^>]*>Comfortable</)
  assert.doesNotMatch(first, /home-grid--compact/)
  // Picking Compact in the header writes the storage helper's key.
  const picked = []
  const tree = HomeView({ state, now: NOW, navigate: () => {}, density: 'comfortable', onDensity: value => pickDensity(storage, value, v => picked.push(v)) })
  const compactRadio = elements(tree, 'button').find(node => node.props.role === 'radio' && textOf(node) === 'Compact')
  compactRadio.props.onClick()
  assert.deepEqual(picked, ['compact'])
  assert.equal(storage.map.get('deck.density'), 'compact')
  // A reload (a fresh Home on the same storage) comes back compact, 9 compact cards in the 3 x 3 grid.
  const reloaded = render(Home, { state, navigate: () => {}, storage })
  assert.match(reloaded, /role="radio"[^>]*aria-checked="true"[^>]*>Compact</)
  assert.match(reloaded, /<section class="home-grid home-grid--compact"/)
  assert.equal((reloaded.match(/<article class="compact-card/g) ?? []).length, 9)
  assert.doesNotMatch(reloaded, /<article class="session-card/, 'no comfortable card in compact')
})

test('the density radiogroup moves with the arrow keys', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const picked = []
  const tree = HomeView({ state: stateWith(nine()), now: NOW, navigate: () => {}, density: 'comfortable', onDensity: value => picked.push(value) })
  const radios = elements(tree, 'button').filter(node => node.props.role === 'radio')
  assert.deepEqual(radios.map(node => [textOf(node), node.props['aria-checked'], node.props.tabIndex]), [['Comfortable', 'true', 0], ['Compact', 'false', -1]])
  let prevented = false
  radios[0].props.onKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented = true } })
  assert.ok(prevented)
  radios[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} })
  assert.deepEqual(picked, ['compact', 'compact'], 'two options wrap both ways')
})

test('Launch a ship shows Alt N and opens /new with history.state.from set', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const { openLaunch } = await load('screens/palette/Palette.jsx')
  let launched = 0
  const tree = HomeView({ state: stateWith(nine()), now: NOW, navigate: () => {}, onLaunch: () => { launched++ } })
  const launch = elements(tree, 'button').find(node => node.props.className?.includes('home-launch'))
  assert.match(textOf(launch), /^\+?\s*Launch a ship\s*Alt N$/)
  launch.props.onClick()
  assert.equal(launched, 1)

  const calls = []
  const env = { location: { pathname: '/', search: '?x=1' }, history: { replaceState: (state, _, url) => calls.push(['replace', state, url]) } }
  openLaunch(to => {
    calls.push(['navigate', to])
    env.location = { pathname: '/new', search: '?repo=rustot' }
  }, '/new?repo=rustot', env)
  assert.deepEqual(calls, [['navigate', '/new?repo=rustot'], ['replace', { from: '/?x=1' }, '/new?repo=rustot']])
})

test('a compact PTY card shows its tail lines and an observed one shows "Observed · from hooks"', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const pty = session('p1', 'rustot', 'running')
  const observed = session('o1', 'vault', 'running', { origin: 'observed', ptyId: null })
  const waiting = session('p2', 'web', 'running')
  const state = stateWith([pty, observed, waiting])
  state.data.tails = { p1: ['$ cargo test', 'test combat ... ok'], o1: ['TAIL FOR OBSERVED'] }
  const steps = { o1: [{ seq: 1, line: 'Read src/lib.rs' }, { seq: 2, line: 'Edit src/main.rs' }] }
  const html = render(HomeView, { state, now: NOW, navigate: () => {}, density: 'compact', steps })
  const card = id => html.slice(html.indexOf(`card-title-${id}"`), html.indexOf('</article>', html.indexOf(`card-title-${id}"`)))
  assert.match(card('p1'), />\$ cargo test</)
  assert.match(card('p1'), />test combat \.\.\. ok</)
  assert.doesNotMatch(card('p1'), /Observed · from hooks/)
  assert.match(card('o1'), /<li class="compact-tail-line compact-tail-line--muted">Observed · from hooks<\/li>/)
  assert.match(card('o1'), />Read src\/lib\.rs</)
  assert.match(card('o1'), />Edit src\/main\.rs</)
  assert.doesNotMatch(card('o1'), /TAIL FOR OBSERVED/, 'observed sessions never show a PTY tail')
  assert.equal((card('p2').match(/compact-tail-skeleton/g) ?? []).length, 3, 'skeleton lines until the first screen.tail')

  const down = stateWith([pty])
  down.data.tails = { p1: ['$ cargo test'] }
  down.data.health = [{ dep: 'deckd', state: 'down' }]
  const outage = render(HomeView, { state: down, now: NOW, navigate: () => {}, density: 'compact' })
  assert.doesNotMatch(outage, /cargo test/, 'deckd down shows skeleton lines, not a stale tail')
  assert.equal((outage.match(/compact-tail-skeleton/g) ?? []).length, 3)
})

test('a compact card asks with its oldest open request and offers Open only', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const state = stateWith([session('a1', 'rustot', 'needs_approval')])
  state.data.requests = [{ id: 'r1', sessionId: 'a1', kind: 'permission', tier: 'caution', toolName: 'Bash', summary: 'npm install <b>x</b>', state: 'open', createdAt: NOW - MIN }]
  const tree = HomeView({ state, now: NOW, navigate: () => {}, density: 'compact' })
  const html = renderToStaticMarkup(tree)
  assert.match(html, /class="compact-strip"/)
  assert.match(html, /npm install &lt;b&gt;x&lt;\/b&gt;/)
  assert.doesNotMatch(html, />(Allow once|Deny|Reply)</, 'answer buttons are M3')
  const strip = elements(tree, 'a').filter(node => node.props.className?.includes('compact-open'))
  assert.deepEqual(strip.map(node => [textOf(node), node.props.href]), [['Open', '/s/a1']])
})

test('subscribeTails gets exactly the visible compact PTY ids, and nothing outside compact', async () => {
  const { homeLayout, tailSubscription, teamCards } = await load('screens/home/Home.jsx')
  const sessions = [
    session('p1', 'rustot', 'running'),
    session('o1', 'vault', 'running', { origin: 'observed', ptyId: null }),
    session('p2', 'web', 'idle'),
    session('gone', 'old', 'ended', { alive: false }),
    session('dead', 'dead', 'crashed', { alive: false })
  ]
  const layout = homeLayout(sessions, { order: sessions.map(row => row.id), now: NOW })
  const teams = teamCards([], sessions, [])
  assert.deepEqual(tailSubscription('compact', layout, teams), ['p1', 'p2'])
  assert.deepEqual(tailSubscription('comfortable', layout, teams), [], 'leaving compact clears the set')
})

test('quiet-row Stop and Nudge render only for alive PTY sessions', async () => {
  const { QuietCard } = await load('components/SessionCard.jsx')
  const repo = { id: '/home/you/dev/turbidassist', name: 'turbidassist', crewSlot: 5 }
  const base = { id: 'q', repoId: repo.id, task: 'Tune the VAD threshold', branch: 'main', origin: 'launched', ptyId: 'p-q', alive: true, changedFiles: [], stateSince: NOW - 30 * MIN, lastActivityAt: NOW - 30 * MIN }
  const calls = []
  const props = session => ({ session, repo, now: NOW, onNudge: row => calls.push(['nudge', row.id]), onStop: row => calls.push(['stop', row.id]) })
  const button = (tree, label) => elements(tree, 'button').find(node => textOf(node) === label)

  const stale = QuietCard(props({ ...base, state: 'stale' }))
  assert.ok(button(stale, 'Nudge (send Enter)'))
  assert.equal(button(stale, 'Stop…'), undefined, 'stale gets Nudge, not Stop')
  button(stale, 'Nudge (send Enter)').props.onClick()
  const idle = QuietCard(props({ ...base, state: 'idle' }))
  assert.ok(button(idle, 'Stop…'))
  assert.equal(button(idle, 'Nudge (send Enter)'), undefined)
  button(idle, 'Stop…').props.onClick()
  assert.deepEqual(calls, [['nudge', 'q'], ['stop', 'q']])

  for (const [name, session] of [
    ['observed', { ...base, origin: 'observed', ptyId: null }],
    ['not alive', { ...base, alive: false }],
    ['no pty', { ...base, ptyId: null }]
  ]) {
    for (const state of ['stale', 'idle']) {
      const html = render(QuietCard, props({ ...session, state }))
      assert.doesNotMatch(html, /Nudge|Stop/, `${name} ${state}: no controls`)
    }
  }
  assert.doesNotMatch(render(QuietCard, props({ ...base, state: 'reviewed', reviewedAt: NOW })), /Nudge|Stop/, 'reviewed keeps Open only')

  const down = QuietCard({ ...props({ ...base, state: 'idle' }), deckdDown: true })
  assert.equal(button(down, 'Stop…').props.disabled, true)
  assert.match(renderToStaticMarkup(down), /deckd is reconnecting/)
})

test('Home wires the quiet-row Stop through a confirm dialog to stopSession and Nudge to nudgeSession', async () => {
  const { homeActions } = await load('screens/home/Home.jsx')
  const posts = []
  const toasts = []
  const api = { post: async path => { posts.push(path)
    if (path.includes('bad')) throw Object.assign(new Error('no such pty'), { code: 'not_found' })
    return {} } }
  let stopping = null
  const actions = homeActions({ api, setStopping: value => { stopping = value }, toast: item => toasts.push(item), repoName: () => 'rustot' })
  actions.openStop({ id: 's1' })
  assert.deepEqual(stopping, { id: 's1' }, 'Stop… only opens the dialog')
  assert.deepEqual(posts, [])
  await actions.confirmStop({ id: 's1' })
  assert.equal(stopping, null)
  await actions.nudge({ id: 's2' })
  assert.deepEqual(posts, ['/api/sessions/s1/stop', '/api/sessions/s2/nudge'])
  await actions.confirmStop({ id: 'bad' })
  assert.deepEqual(toasts, [{ tone: 'error', title: 'Could not stop rustot: no such pty' }])
})

test('the palette lists Actions after Sessions with Launch a ship and the three recent harbors', async () => {
  const { paletteModel, PaletteView } = await load('screens/palette/Palette.jsx')
  const state = stateWith([session('s1', 'rustot', 'running')])
  state.data.repos = [
    repoRow('rustot', { lastSessionAt: NOW - 1 * MIN }),
    repoRow('vault', { lastSessionAt: NOW - 3 * MIN }),
    repoRow('web', { lastSessionAt: NOW - 2 * MIN }),
    repoRow('axios', { lastSessionAt: NOW - 9 * MIN }),
    repoRow('never'),
    repoRow('archived', { lastSessionAt: NOW, archivedAt: NOW })
  ]
  const model = paletteModel(state, { query: '', now: NOW })
  assert.deepEqual(model.groups.map(group => group.id), ['sessions', 'actions'])
  const actions = model.groups.find(group => group.id === 'actions')
  assert.deepEqual(actions.rows.map(row => [row.title, row.subtitle ?? null, row.repoKey ?? null]), [
    ['Launch a ship', null, null],
    ['Launch a ship in rustot', 'Recent harbor', 'rustot'],
    ['Launch a ship in web', 'Recent harbor', 'web'],
    ['Launch a ship in vault', 'Recent harbor', 'vault']
  ])
  const html = render(PaletteView, { model, query: '', active: 0, now: NOW })
  assert.ok(html.indexOf('palette-group--sessions') < html.indexOf('palette-group--actions'))
  assert.match(html, /Recent harbor/)

  const queried = paletteModel(state, { query: 'ax', now: NOW })
  assert.deepEqual(queried.groups.find(group => group.id === 'actions').rows.map(row => row.title), ['Launch a ship in axios'], 'with a query, matching repos only')
})

test('Enter on a launch row and "> launch rustot" route to /new?repo=rustot; an unknown command says so', async () => {
  const { paletteModel, runRow, PaletteView } = await load('screens/palette/Palette.jsx')
  const state = stateWith([session('s1', 'rustot', 'running')])
  state.data.repos = [repoRow('rustot', { lastSessionAt: NOW }), repoRow('rust-tools')]
  const routes = []
  const env = { navigate: to => routes.push(to), leave: () => routes.push('leave'), onClose: () => {}, expand: () => {}, api: { post: async () => {} } }

  const command = paletteModel(state, { query: '> launch rustot', now: NOW })
  assert.deepEqual(command.groups.map(group => group.id), ['actions'])
  assert.equal(command.rows[0].title, 'Launch a ship in rustot', 'the exact repo name first')
  await runRow(command.rows[0], env)
  assert.deepEqual(routes, ['leave', '/new?repo=rustot'])

  routes.length = 0
  const recent = paletteModel(state, { query: '', now: NOW }).rows.find(row => row.kind === 'launch' && row.repoKey === 'rustot')
  await runRow(recent, env)
  const plain = paletteModel(state, { query: '', now: NOW }).rows.find(row => row.kind === 'launch' && !row.repoKey)
  await runRow(plain, env)
  assert.deepEqual(routes, ['leave', '/new?repo=rustot', 'leave', '/new'])

  const unknown = paletteModel(state, { query: '> deploy now', now: NOW })
  assert.deepEqual(unknown.rows, [])
  assert.equal(unknown.message, 'No command named "deploy". Try research or launch.')
  const html = render(PaletteView, { model: unknown, query: '> deploy now', active: -1 })
  assert.match(html, /No command named &quot;deploy&quot;\. Try research or launch\./)
  assert.doesNotMatch(html, /No matches\./)
})

function runState() {
  const runRef = taskId => ({ repoId: '/home/you/dev/fm', runId: 'r1', taskId })
  const state = stateWith([
    session('lead', 'fm', 'running', { role: 'lead', runRef: runRef('T6') }),
    session('t4', 'fm', 'needs_approval', { role: 'teammate', runRef: runRef('T4') }),
    session('solo', 'web', 'needs_approval')
  ])
  state.data.runs = [{ repoId: '/home/you/dev/fm', runId: 'r1', leadSessionId: 'lead', teammates: [], tasks: [] }]
  state.data.requests = [
    { id: 'q4', sessionId: 'lead', kind: 'permission', tier: 'caution', summary: 'npm install commander@14', state: 'open', createdAt: NOW - 3 * MIN, taskId: 'T4' },
    { id: 'q5', sessionId: 'lead', kind: 'permission', tier: 'safe', summary: 'npm test', state: 'open', createdAt: NOW - 2 * MIN, taskId: 'T5' },
    { id: 'qs', sessionId: 'solo', kind: 'permission', tier: 'safe', summary: 'ls -la', state: 'open', createdAt: NOW - MIN }
  ]
  return state
}

test('the drawer with a task filter shows only that task\'s request and Show all restores the full list', async () => {
  const { DrawerView } = await load('screens/drawer/NeedsYouDrawer.jsx')
  const state = runState()
  const ids = html => [...html.matchAll(/data-request="(\w+)"/g)].map(match => match[1])
  let cleared = 0
  const props = { state, now: NOW, navigate: () => {}, onShowAll: () => { cleared++ } }
  const task = render(DrawerView, { ...props, filter: { kind: 'task', runId: 'r1', taskId: 'T4' } })
  assert.deepEqual(ids(task), ['q4'])
  assert.match(task, /Requests for T4/)
  const run = render(DrawerView, { ...props, filter: { kind: 'run', runId: 'r1' } })
  assert.deepEqual(ids(run).sort(), ['q4', 'q5'])
  assert.match(run, /Requests for run r1/)
  const all = render(DrawerView, props)
  assert.deepEqual(ids(all).sort(), ['q4', 'q5', 'qs'])
  assert.doesNotMatch(all, /Requests for|Show all/)

  const tree = DrawerView({ ...props, filter: { kind: 'task', runId: 'r1', taskId: 'T4' } })
  const showAll = elements(tree, 'button').find(node => textOf(node) === 'Show all')
  showAll.props.onClick()
  assert.equal(cleared, 1)
})

test('openOverlay carries the filter in the history state and a ?needs= link names the drawer detail', async () => {
  const { openOverlay, drawerFilterFrom, needsLinkDetail } = await load('screens/drawer/NeedsYouDrawer.jsx')
  const calls = []
  const env = {
    location: { pathname: '/s/lead', search: '' },
    history: { pushState: (state, _, url) => calls.push(['push', state, url]) },
    PopStateEvent: class { constructor(type, init) { this.state = init.state } },
    dispatchEvent: event => calls.push(['pop', event.state])
  }
  openOverlay('drawer', env, { filter: { kind: 'task', runId: 'r1', taskId: 'T4' } })
  const pushed = calls[0][1]
  assert.deepEqual(pushed, { overlay: 'drawer', filter: 'needs=task%3Ar1%3AT4' })
  assert.deepEqual(drawerFilterFrom(pushed), { kind: 'task', runId: 'r1', taskId: 'T4' })
  assert.equal(drawerFilterFrom({ overlay: 'drawer' }), null)
  assert.equal(drawerFilterFrom({ overlay: 'drawer', filter: 'needs=request%3Aq4' }), null, 'a request is focused, not filtered')

  assert.deepEqual(needsLinkDetail('?needs=q4'), { request: 'q4' })
  assert.deepEqual(needsLinkDetail('?needs=request:q4'), { request: 'q4' })
  assert.deepEqual(needsLinkDetail('?needs=run:r1'), { filter: { kind: 'run', runId: 'r1' } })
  assert.equal(needsLinkDetail('?tab=changes'), null)
  assert.equal(needsLinkDetail(''), null)
})

test('a run filter keeps the open requests of the run\'s lead even when the lead carries no runRef', async () => {
  const { DrawerView, filterRequests } = await load('screens/drawer/NeedsYouDrawer.jsx')
  const state = stateWith([
    session('lead', 'fm', 'running', { role: 'lead', runRef: null }),
    session('solo', 'web', 'needs_approval')
  ])
  state.data.runs = [{ runId: 'r1', leadSessionId: 'lead' }]
  state.data.requests = [
    { id: 'ql', sessionId: 'lead', kind: 'permission', tier: 'safe', summary: 'npm test', state: 'open', createdAt: NOW - 2 * MIN },
    { id: 'qs', sessionId: 'solo', kind: 'permission', tier: 'safe', summary: 'ls -la', state: 'open', createdAt: NOW - MIN }
  ]
  const filter = { kind: 'run', runId: 'r1' }
  assert.deepEqual(filterRequests(state.data.requests, filter, state.data).map(row => row.id), ['ql'])
  const html = render(DrawerView, { state, now: NOW, navigate: () => {}, onShowAll: () => {}, filter })
  assert.deepEqual([...html.matchAll(/data-request="(\w+)"/g)].map(match => match[1]), ['ql'])
})

test('Home\'s quiet-row Stop… opens a dialog with the home.stop copy; Confirm stops that session and Cancel does not', async () => {
  const { HomeView, HomeStopDialog, homeActions } = await load('screens/home/Home.jsx')
  const idle = session('q1', 'rustot', 'idle', { task: 'Tune the VAD threshold' })
  const state = stateWith([session('busy', 'web', 'running'), idle])
  const posts = []
  let stopping = null
  const api = { post: async path => { posts.push(path)
    return {} } }
  const actions = homeActions({ api, setStopping: value => { stopping = value }, toast: () => {}, repoName: () => 'rustot' })
  const tree = HomeView({ state, now: NOW, navigate: () => {}, onNudge: actions.nudge, onStop: actions.openStop })
  const stop = elements(tree, 'button').find(node => textOf(node) === 'Stop…')
  assert.ok(stop, 'an idle live PTY session in the quiet row offers Stop…')
  assert.equal(HomeStopDialog({ stopping, repos: state.data.repos, actions }), null, 'no dialog before Stop…')
  stop.props.onClick()
  assert.equal(stopping, idle)
  assert.deepEqual(posts, [], 'Stop… alone posts nothing')

  const dialog = HomeStopDialog({ stopping, repos: state.data.repos, actions })
  assert.equal(dialog.props.title, 'Stop rustot · Tune the VAD threshold?')
  assert.equal(dialog.props.confirmLabel, 'Stop session')
  const html = renderToStaticMarkup(dialog)
  assert.match(html, /role="dialog"/)
  assert.match(html, />Stop rustot · Tune the VAD threshold\?</)
  assert.match(html, />Stop session<\/button>/)

  dialog.props.onCancel()
  assert.equal(stopping, null)
  assert.deepEqual(posts, [], 'Cancel does not stop the session')
  stopping = idle
  await dialog.props.onConfirm()
  assert.deepEqual(posts, ['/api/sessions/q1/stop'], 'Confirm stops that session')
  assert.equal(stopping, null)
})

test('Launch a ship is disabled with the visible reason "deckd is reconnecting" while deckd is down', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const launchOf = tree => elements(tree, 'button').find(node => node.props.className?.includes('home-launch'))
  const down = stateWith(nine())
  down.data.health = [{ dep: 'deckd', state: 'down' }]
  const tree = HomeView({ state: down, now: NOW, navigate: () => {} })
  const launch = launchOf(tree)
  assert.equal(launch.props.disabled, true)
  const reasonId = launch.props['aria-describedby']
  assert.ok(reasonId, 'the disabled button names its reason')
  const reason = elements(tree, 'p').find(node => node.props.id === reasonId)
  assert.equal(textOf(reason), 'deckd is reconnecting')
  assert.match(render(HomeView, { state: down, now: NOW, navigate: () => {} }), /deckd is reconnecting/)

  const up = HomeView({ state: stateWith(nine()), now: NOW, navigate: () => {} })
  assert.notEqual(launchOf(up).props.disabled, true)
  assert.equal(launchOf(up).props['aria-describedby'], undefined)
  assert.doesNotMatch(render(HomeView, { state: stateWith(nine()), now: NOW, navigate: () => {} }), /deckd is reconnecting/)
})

test('subscribeTails includes a team lead that is a live PTY session in compact', async () => {
  const { homeLayout, tailSubscription, teamCards } = await load('screens/home/Home.jsx')
  const runRef = taskId => ({ repoId: '/home/you/dev/fm', runId: 'r1', taskId })
  const sessions = [
    session('lead', 'fm', 'running', { role: 'lead', runRef: runRef('T6') }),
    session('solo', 'web', 'running')
  ]
  const runs = [{ repoId: '/home/you/dev/fm', runId: 'r1', leadSessionId: 'lead', teammates: [], tasks: [] }]
  const layout = homeLayout(sessions, { order: sessions.map(row => row.id), now: NOW })
  const teams = teamCards(runs, sessions, [])
  assert.equal(teams.length, 1)
  assert.deepEqual(tailSubscription('compact', layout, teams).sort(), ['lead', 'solo'])
})

test('quiet-row Stop and Nudge never render for an observed session, even one carrying a live PTY id', async () => {
  const { QuietCard, controllable } = await load('components/SessionCard.jsx')
  const repo = { id: '/home/you/dev/vault', name: 'vault', crewSlot: 2 }
  const observed = { id: 'q', repoId: repo.id, task: 'Observe me', branch: 'main', origin: 'observed', ptyId: 'p-q', alive: true, changedFiles: [], stateSince: NOW - 30 * MIN, lastActivityAt: NOW - 30 * MIN }
  assert.equal(controllable({ ...observed, state: 'idle' }), false)
  for (const state of ['idle', 'stale']) {
    const html = render(QuietCard, { session: { ...observed, state }, repo, now: NOW, onNudge: () => {}, onStop: () => {} })
    assert.doesNotMatch(html, /Nudge|Stop/, `observed ${state}: no controls`)
  }
})

test('every agent-supplied compact line renders U+202E as a visible token: PTY tail, observed step and team ask', async () => {
  const { CompactCard } = await load('components/CompactCard.jsx')
  const RLO = '‮'
  const repo = { name: 'rustot', crewSlot: 1 }
  const check = (html, what) => {
    assert.match(html, /&lt;U\+202E&gt;/, `${what}: the token is shown`)
    assert.ok(!html.includes(RLO), `${what}: no raw U+202E`)
  }
  const pty = session('p1', 'rustot', 'running', { task: 'plain', branch: 'main' })
  check(render(CompactCard, { session: pty, repo, now: NOW, tail: [`tail ${RLO}evil`] }), 'PTY tail')
  const observed = session('o1', 'rustot', 'running', { origin: 'observed', ptyId: null, task: 'plain', branch: 'main' })
  check(render(CompactCard, { session: observed, repo, now: NOW, steps: [{ seq: 1, line: `step ${RLO}evil` }] }), 'observed step')
  const lead = session('lead', 'rustot', 'running', { task: 'plain', branch: 'main' })
  const team = {
    key: 'team-r1', lead, state: 'needs_approval', run: { repoId: lead.repoId, runId: 'r1' },
    requests: [{ id: 'q4', sessionId: 'lead', kind: 'permission', tier: 'caution', summary: `ask ${RLO}evil`, state: 'open', createdAt: NOW - MIN, taskId: 'T4' }]
  }
  check(render(CompactCard, { team, repo, now: NOW, tail: [] }), 'team ask')
  const asking = session('a1', 'rustot', 'needs_approval', { task: 'plain', branch: 'main' })
  const ask = { id: 'q1', sessionId: 'a1', kind: 'permission', tier: 'caution', summary: `rm ${RLO}evil`, state: 'open', createdAt: NOW - MIN }
  check(render(CompactCard, { session: asking, repo, now: NOW, tail: [], requests: [ask] }), 'single-session ask summary')
  const branched = session('b1', 'rustot', 'needs_approval', { task: 'plain', branch: `feat/${RLO}evil` })
  check(render(CompactCard, { session: branched, repo, now: NOW, tail: [], requests: [{ ...ask, sessionId: 'b1', summary: 'plain' }] }), 'branch')
  const taskTeam = { ...team, requests: [{ ...team.requests[0], summary: 'plain', taskId: `T${RLO}4` }] }
  check(render(CompactCard, { team: taskTeam, repo, now: NOW, tail: [] }), 'team ask task id')
})
