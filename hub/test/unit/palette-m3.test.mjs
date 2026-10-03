// M3 Task 13: answering from the palette (docs/deck/screens/palette.md 5, 6, 7, ACs 5 and 6, D-85).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load() {
  const { module } = await runnerImport(path.join(hub, 'web/src/screens/palette/Palette.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const NOW = Date.UTC(2026, 9, 2, 12, 0)
const MIN = 60_000
const OPTIONS = [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }]

function session(id, name, extra = {}) {
  return { id, repoId: `/home/you/dev/${name}`, origin: 'launched', ptyId: `p-${id}`, alive: true, task: `task ${id}`, branch: `br-${id}`, state: 'needs_approval', stateSince: NOW - MIN, ...extra }
}

function request(id, sessionId, tier, extra = {}) {
  return { id, sessionId, kind: 'permission', tier, toolName: 'Bash', summary: `cmd ${id}`, state: 'open', createdAt: NOW - 3 * MIN,
    delivery: 'idle', screenMatch: 'on_screen', options: OPTIONS, ...extra }
}

function stateWith(requests, { sessions = [session('s1', 'rustot'), session('s2', 'web', { origin: 'observed', ptyId: null })], health = [], deckdOutage = false } = {}) {
  const repos = [...new Set(sessions.map(row => row.repoId))].map(id => ({ id, name: id.split('/').at(-1) }))
  return { loaded: true, deckdOutage, view: { path: '/' }, data: { sessions, requests, repos, order: sessions.map(row => row.id), health } }
}

// Run a needs row the way Enter does, with every side effect recorded.
async function enter(m, state, requestId) {
  const row = m.paletteModel(state, { now: NOW }).rows.find(item => item.requestId === requestId)
  const log = []
  const env = {
    navigate: to => log.push(['navigate', to]),
    leave: () => log.push(['leave']),
    onClose: () => log.push(['close']),
    expand: () => {},
    api: { post: (url, body) => { log.push(['post', url, body])
      return Promise.resolve({}) } },
    openDrawer: id => log.push(['drawer', id])
  }
  await m.runRow(row, env)
  return { row, log, posts: log.filter(item => item[0] === 'post') }
}

test('palette AC5: Enter on a Safe row of a PTY session sends U.Allow for that id; the row reads "{repo} · Allow {summary}"', async () => {
  const m = await load()
  const state = stateWith([request('r1', 's1', 'safe')])
  const { row, log } = await enter(m, state, 'r1')
  assert.equal(row.title, 'rustot · Allow cmd r1')
  assert.deepEqual(log, [['post', '/api/requests/r1/answer', { choice: 'allow' }]], 'the palette stays open until request.closed')
  assert.equal(row.subtitle, 'Safe · Bash · waiting 3m', 'a PTY row no longer says "Answer in your terminal"')
})

test('palette AC6: Enter on a Destructive row sends nothing and opens the drawer on it', async () => {
  const m = await load()
  const { row, log, posts } = await enter(m, stateWith([request('r1', 's1', 'destructive')]), 'r1')
  assert.deepEqual(posts, [])
  assert.deepEqual(log, [['leave'], ['drawer', 'r1']])
  assert.doesNotMatch(row.title, /Allow/)
})

test('D-85: Enter on a Caution row sends nothing, keeps a title without "Allow" and opens the drawer on it', async () => {
  const m = await load()
  const { row, log, posts } = await enter(m, stateWith([request('r1', 's1', 'caution')]), 'r1')
  assert.deepEqual(posts, [])
  assert.deepEqual(log, [['leave'], ['drawer', 'r1']])
  assert.equal(row.title, 'rustot · cmd r1')
})

test('Enter on a question row opens the drawer on it', async () => {
  const m = await load()
  const { log, posts } = await enter(m, stateWith([request('r1', 's1', null, { kind: 'question', options: [], summary: 'Paginate?' })]), 'r1')
  assert.deepEqual(posts, [])
  assert.deepEqual(log, [['leave'], ['drawer', 'r1']])
})

test('an observed row of any tier opens Focus and keeps the M1 subtitle', async () => {
  const m = await load()
  for (const tier of ['safe', 'caution', 'destructive']) {
    const { row, log } = await enter(m, stateWith([request('r2', 's2', tier)]), 'r2')
    assert.deepEqual(log, [['leave'], ['navigate', '/s/s2']], tier)
    assert.doesNotMatch(row.title, /Allow/, tier)
    assert.match(row.subtitle, / · Answer in your terminal$/, tier)
  }
})

test('while deckd is down a Safe row opens the drawer instead of answering, and says so', async () => {
  const m = await load()
  for (const state of [stateWith([request('r1', 's1', 'safe')], { health: [{ dep: 'deckd', state: 'down' }] }), stateWith([request('r1', 's1', 'safe')], { deckdOutage: true })]) {
    const { row, log, posts } = await enter(m, state, 'r1')
    assert.deepEqual(posts, [])
    assert.deepEqual(log, [['leave'], ['drawer', 'r1']])
    assert.equal(row.title, 'rustot · cmd r1')
    assert.equal(row.subtitle, 'Safe · Bash · waiting 3m · deckd is reconnecting')
  }
  // A queued prompt or one without parsed options is not answered from the palette either.
  for (const extra of [{ screenMatch: 'queued' }, { options: [] }]) {
    const { posts } = await enter(m, stateWith([request('r1', 's1', 'safe', extra)]), 'r1')
    assert.deepEqual(posts, [], JSON.stringify(extra))
  }
})

test('the allowed row shows a spinner; the palette closes on request.closed and toasts "Allowed {summary} in {repo}"', async () => {
  const m = await load()
  const state = stateWith([request('r1', 's1', 'safe')])
  const model = m.paletteModel(state, { now: NOW })
  const html = renderToStaticMarkup(createElement(m.PaletteView, { model, query: '', active: 0, now: NOW, pending: 'r1' }))
  assert.match(html, /<li class="palette-row palette-row--needs"[^>]*aria-busy="true"[^>]*>[\s\S]*?<span class="answer-spinner" aria-hidden="true"><\/span>/)
  const idle = renderToStaticMarkup(createElement(m.PaletteView, { model, query: '', active: 0, now: NOW }))
  assert.doesNotMatch(idle, /answer-spinner/)

  const pending = { requestId: 'r1', summary: 'cmd r1', repo: 'rustot' }
  assert.equal(m.allowSettled(pending, state.data.requests), null, 'still open: keep waiting')
  assert.equal(m.allowSettled(pending, [request('r1', 's1', 'safe', { delivery: 'did_not_land' })]), 'failed')
  assert.equal(m.allowSettled(pending, [request('r1', 's1', 'safe', { state: 'closed' })]), 'closed')
  assert.equal(m.allowSettled(pending, []), 'closed')
  assert.equal(m.allowedToast(pending), 'Allowed cmd r1 in rustot')
})

test('a highlighted row answered elsewhere moves the highlight to the next row and announces "Request answered elsewhere"', async () => {
  const m = await load()
  const before = m.paletteModel(stateWith([request('r1', 's1', 'safe'), request('r2', 's1', 'caution', { createdAt: NOW - 2 * MIN })]), { now: NOW }).rows
  const after = m.paletteModel(stateWith([request('r2', 's1', 'caution', { createdAt: NOW - 2 * MIN })]), { now: NOW }).rows
  assert.equal(before[0].requestId, 'r1')
  const moved = m.followHighlight(before, 0, after, null)
  assert.equal(after[moved.active].requestId, 'r2', 'the next row, not the first row of another group')
  assert.equal(moved.announce, 'Request answered elsewhere')
  assert.equal(m.followHighlight(before, 0, after, 'r1').announce, null, 'the palette\'s own answer is not "elsewhere"')
  assert.deepEqual(m.followHighlight(before, 1, before, null), { active: 1, announce: null })
  const html = renderToStaticMarkup(createElement(m.PaletteView, { model: m.paletteModel(stateWith([]), { now: NOW }), query: '', active: 0, now: NOW, announce: 'Request answered elsewhere' }))
  assert.match(html, /<p class="sr-only" role="status" aria-live="polite">Request answered elsewhere<\/p>/)
})
