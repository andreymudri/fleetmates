// M4 Task 15 step 1: the shell's `screens` map (Failures.jsx `deckScreens`) registers the meeting screens, so
// `/meetings`, `/meetings/:id` and `/meetings/live` no longer render the shell's pending placeholder, and the
// scribed degraded card's "Start scribed" and "Retry" reach the scribed dependency routes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load(rel) {
  const { module } = await runnerImport(path.join(hub, 'web/src', rel), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

/** Every element of a React element tree, depth first, without expanding function components. */
function elements(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (!node || typeof node !== 'object' || !node.props) return out
  out.push(node)
  elements(node.props.children, out)
  return out
}

const NOW = Date.UTC(2026, 9, 2, 12, 0)
const state = (recorder = { state: 'idle' }) => ({
  loaded: true, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/meetings' }, toasts: [],
  data: { sessions: [], requests: [], repos: [], runs: [], health: [], prefs: {}, recorder, meetings: {}, meetingPins: {}, live: null, meetingAsk: {} }
})

function fakeApi() {
  const calls = []
  const api = {
    calls,
    async get(to) { calls.push(['GET', to])
      return {} },
    async post(to, body) { calls.push(['POST', to, body])
      return {} },
    async patch() { return {} },
    async del() { return {} }
  }
  return api
}

test('/meetings, /meetings/<id> and /meetings/live render the meeting screens, not the pending placeholder', async () => {
  const failures = await load('screens/failures/Failures.jsx')
  const { Meetings } = await load('screens/meetings/Meetings.jsx')
  const { MeetingLive } = await load('screens/meetings/MeetingLive.jsx')
  const { matchRoute } = await load('state/deck-store.js')
  const api = fakeApi()
  const dispatch = () => {}
  const screens = failures.deckScreens({ api, dispatch, now: () => NOW })
  const cases = [
    ['/meetings', 'meetings', Meetings, { state: 'idle' }],
    ['/meetings/2026-10-02_14-00-00', 'meeting', Meetings, { state: 'idle' }],
    ['/meetings/live', 'meetingLive', MeetingLive, { state: 'recording', meetingId: '2026-10-02_14-00-00', tag: 'pessoal', startedAt: NOW, elapsedS: 0 }]
  ]
  for (const [pathname, name, Component, recorder] of cases) {
    const route = matchRoute(pathname)
    assert.equal(route.name, name)
    const Screen = screens[route.name]
    assert.equal(typeof Screen, 'function', `${pathname}: the screens map registers ${name}`)
    const props = { route, search: '', state: state(recorder), t: undefined, navigate: () => {} }
    const tree = elements(Screen(props))
    const found = tree.find(node => node.type?.name === Component.name)
    assert.ok(found, `${pathname}: renders ${Component.name}`)
    assert.equal(found.props.api, api, `${pathname}: gets the authenticated api`)
    assert.equal(found.props.dispatch, dispatch, `${pathname}: gets the store dispatch`)
    if (name === 'meeting') assert.equal(found.props.route.params.id, '2026-10-02_14-00-00', 'the detail route carries the selected id')
    const html = renderToStaticMarkup(createElement(Screen, props))
    assert.doesNotMatch(html, /screen-pending/, `${pathname}: not the pending placeholder`)
    assert.match(html, name === 'meetingLive' ? />Live transcript</ : /<h1[^>]*>Meetings<\/h1>/, `${pathname}: the meeting screen renders`)
  }
})

test('the degraded card\'s Start scribed posts to /api/deps/scribed/start and Retry to /api/deps/scribed/retry', async () => {
  const failures = await load('screens/failures/Failures.jsx')
  const { Meetings } = await load('screens/meetings/Meetings.jsx')
  const api = fakeApi()
  const screens = failures.deckScreens({ api, now: () => NOW })
  const tree = elements(screens.meetings({ route: { name: 'meetings', params: {} }, search: '', state: state({ state: 'unavailable' }), navigate: () => {} }))
  const meetings = tree.find(node => node.type?.name === Meetings.name)
  assert.equal(typeof meetings.props.onStartScribed, 'function', 'deckScreens wires Start scribed')
  assert.equal(typeof meetings.props.onRetryScribed, 'function', 'deckScreens wires Retry')
  await meetings.props.onStartScribed()
  await meetings.props.onRetryScribed()
  assert.deepEqual(api.calls.filter(call => call[0] === 'POST').map(call => call[1]), ['/api/deps/scribed/start', '/api/deps/scribed/retry'])
})
