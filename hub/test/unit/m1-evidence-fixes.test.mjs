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

test('reorder buffer flushes a session early when Stop, PermissionRequest or Notification is its latest event', async () => {
  for (const attention of ['Stop', 'PermissionRequest', 'Notification']) {
    const batches = []
    const buffer = createReorderBuffer(batch => batches.push(batch.map(item => item.hook.hook_event_name)), { windowMs: 10_000 })
    try {
      buffer.push(row(1, 'PreToolUse'))
      buffer.push(row(2, attention))
      buffer.push(row(1, 'UserPromptSubmit', 'other'))
      await tick(20)
      assert.deepEqual(batches, [['PreToolUse', attention]], `${attention} flushes its own session only, well inside the window`)
    } finally { buffer.close() }
  }
})

test('the early flush keeps hook-time order for rows that arrive together and waits when the attention event is not the latest', async () => {
  const batches = []
  const buffer = createReorderBuffer(batch => batches.push(batch.map(item => `${item.hookTs}:${item.hook.hook_event_name}`)), { windowMs: 60 })
  try {
    buffer.push(row(5, 'Stop'))
    buffer.push(row(4, 'PostToolUse'))
    buffer.push(row(4, 'PreToolUse'))
    await tick(20)
    assert.deepEqual(batches, [['4:PreToolUse', '4:PostToolUse', '5:Stop']], 'rows pushed in the same turn flush as one sorted batch')
    buffer.push(row(10, 'PermissionRequest'))
    buffer.push(row(11, 'PostToolUse'))
    await tick(20)
    assert.equal(batches.length, 1, 'a later hook-time event after the attention event keeps the 250 ms window')
    await tick(80)
    assert.deepEqual(batches[1], ['10:PermissionRequest', '11:PostToolUse'])
    buffer.push(row(20, 'PreToolUse'))
    await tick(20)
    assert.equal(batches.length, 2, 'other events wait for the window')
    await tick(80)
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
  const notifier = createNotifier({ run: async (command, args) => { calls.push(args)
    return { ok: true, exitCode: 0, stdout: '7\n' } } })
  const popup = async (title, body) => {
    calls.length = 0
    await notifier.popup({ title, body })
    assert.equal(calls[0].at(-3), '--', '-- ends option parsing before title and body')
    return calls[0].slice(-2)
  }
  let [title, body] = await popup('a‮b⁦c\x1b[31m\r\nd\u0085e<i>&"\'', 'ok')
  assert.equal(title, 'abc[31mde&lt;i&gt;&amp;&quot;&#39;', 'title: C0 (line breaks too), C1 and bidi removed, markup escaped')
  ;[title, body] = await popup('t', 'one\r\n\x1b[2Ktwo\u0085‏<b>‪')
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
  lead.task = 'Phase‮2'
  lead.state = 'needs_approval'
  state.data.requests.push({ id: 'q0', sessionId: 'lead', kind: 'permission', tier: 'caution', summary: 'rm‮ -rf', state: 'open', createdAt: 1 })
  const html = render(HomeView, { state, now: 1000, navigate: () => {} })
  assert.match(html, /<bdi>Phase&lt;U\+202E&gt;2<\/bdi>/, 'the team title renders its bidi control as a token')
  assert.match(html, /<code class="request-command">rm&lt;U\+202E&gt; -rf<\/code>/, 'a summary without a task id renders its control as a token')
  assert.doesNotMatch(html, /‮/u)
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
  assert.equal(notificationText('a؜b‎c', TITLE_MAX), 'abc')
  assert.equal(notificationText('a؜b‎c\nd', BODY_MAX, { keepLineFeeds: true }), 'abc\nd')
})

test('a done or crash popup keeps its own words after a long task', async () => {
  const { terminalPopupTitle } = await import('../../server/machines/notification.mjs')
  const task = 'y'.repeat(88)
  assert.equal(terminalPopupTitle(task, 'done'), `${'y'.repeat(69)}… made port`)
  assert.equal(terminalPopupTitle(task, 'crash'), `${'y'.repeat(71)}… crashed`)
  assert.equal(terminalPopupTitle('short', 'done'), 'short made port')
})

test('a tool path outside the working directory stays absolute', async () => {
  const { toolLine } = await import('../../server/machines/request.mjs')
  assert.equal(toolLine('Read', { file_path: '/etc/passwd' }, '/home/you/proj'), 'Read /etc/passwd')
  assert.equal(toolLine('Read', { file_path: '/home/you/project2/a.txt' }, '/home/you/proj'), 'Read /home/you/project2/a.txt')
  assert.equal(toolLine('Read', { file_path: '/home/you/proj/src/a.txt' }, '/home/you/proj'), 'Read src/a.txt')
})
