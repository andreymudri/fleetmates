// M4 Task 15 steps 2 and 3: Home Calm "Last meeting" (docs/deck/screens/home.md 4.5, 5.2 and 5.3) and the
// Settings > Connections status line under the "TurbidAssist config.yaml" field.
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

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const MIN = 60_000
// Local time, so "today" is the same calendar day as the meetings below in any time zone.
const NOW = new Date(2026, 9, 2, 16, 0).getTime()
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()

// Walk a tree of hook-free function components and collect host elements.
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
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}
const buttonsIn = (tree, label) => {
  const out = []
  walk(tree, node => { if (node.type === 'button' && textOf(node.props.children) === label) out.push(node) })
  return out
}

const meeting = (id, extra) => ({ id, tag: 'pessoal', state: 'synthesized', confidential: false, apps: [], startedAt: at(2, 9), endedAt: at(2, 9, 30),
  title: null, actionItemCount: 0, stuck: false, interrupted: false, ...extra })
const MEETINGS = [
  meeting('m-morning', { title: 'standup', startedAt: at(2, 9), endedAt: at(2, 9, 30), actionItemCount: 1 }),
  meeting('m-sync', { tag: 'client-a', confidential: true, title: 'weekly sync', startedAt: at(2, 14), endedAt: at(2, 14, 42), actionItemCount: 3 }),
  meeting('m-recorded', { state: 'recorded', startedAt: at(2, 15), endedAt: at(2, 15, 20) }),
  meeting('m-yesterday', { startedAt: at(1, 17), endedAt: at(1, 17, 40), title: 'retro' })
]

test('Calm "Last meeting" is the newest synthesized meeting that started today, with its meta', async () => {
  const Home = await load('screens/home/Home.jsx')
  const last = Home.lastMeetingOf(MEETINGS, NOW)
  assert.equal(last?.id, 'm-sync', 'the newest synthesized meeting of today, not the oldest, the recorded one or yesterday\'s')
  const html = render(Home.LastMeetingView, { meeting: last, item: null, now: NOW, navigate: () => {} })
  assert.match(html, /<h2[^>]*>Last meeting<\/h2>/)
  assert.match(html, />Client A · weekly sync</)
  assert.match(html, />Today 14:00 · 42 min · 3 action items</)
  assert.equal(Home.lastMeetingOf(MEETINGS.filter(row => row.id !== 'm-sync' && row.id !== 'm-morning'), NOW), null, 'yesterday and unsynthesized meetings do not count')
})

test('the Last meeting action item row launches a session with the item text as the task', async () => {
  const Home = await load('screens/home/Home.jsx')
  const visits = []
  const item = { key: 'k1', text: 'Ligar o feature flag da 3.2 & testar', owner: 'Você', dismissed: false }
  const tree = Home.LastMeetingView({ meeting: MEETINGS[1], item, now: NOW, navigate: to => visits.push(to) })
  const html = render(Home.LastMeetingView, { meeting: MEETINGS[1], item, now: NOW, navigate: () => {} })
  assert.match(html, /<p[^>]*lang="pt-BR"[^>]*><bdi>Ligar o feature flag da 3.2 &amp; testar<\/bdi><\/p>/, 'the item text is meeting content in pt-BR, rendered as text')
  const [launch] = buttonsIn(tree, 'Launch as session')
  assert.ok(launch, 'the row has "Launch as session"')
  launch.props.onClick()
  assert.deepEqual(visits, ['/new?task=' + encodeURIComponent(item.text)])
})

// M4-T17-F2 on Home (Task 19): bidi and control characters in meeting text become visible tokens inside <bdi>.
const EVIL = 'evil\u202Etxt \u001b[31mred \u0007'
const RAW_CONTROLS = /[\u202E\u001b\u0007]/

test('the Last meeting title and action item neutralise U+202E, ESC and BEL inside bdi, and launch the raw item text', async () => {
  const Home = await load('screens/home/Home.jsx')
  const visits = []
  const evilMeeting = { ...MEETINGS[1], title: EVIL, tag: EVIL }
  const item = { key: 'k-evil', text: EVIL, owner: null, dismissed: false }
  const html = render(Home.LastMeetingView, { meeting: evilMeeting, item, now: NOW, navigate: () => {} })
  assert.doesNotMatch(html, RAW_CONTROLS, 'no raw U+202E, ESC or BEL reaches the markup')
  assert.match(html, /<a [^>]*class="calm-meeting-title"[^>]*><bdi>[^<]*evil&lt;U\+202E&gt;txt &lt;U\+001B&gt;\[31mred &lt;U\+0007&gt;<\/bdi><\/a>/, 'the title shows the visible tokens inside bdi')
  assert.match(html, /<p class="calm-loop-text"[^>]*><bdi>evil&lt;U\+202E&gt;txt &lt;U\+001B&gt;\[31mred &lt;U\+0007&gt;<\/bdi><\/p>/, 'the item shows the visible tokens inside bdi')
  const [launch] = buttonsIn(Home.LastMeetingView({ meeting: evilMeeting, item, now: NOW, navigate: to => visits.push(to) }), 'Launch as session')
  launch.props.onClick()
  assert.deepEqual(visits, ['/new?task=' + encodeURIComponent(EVIL)], 'the task is the raw item text: data, not display')
})

test('Calm says "No meetings today." without a synthesized meeting of today, and Calm places the section', async () => {
  const Home = await load('screens/home/Home.jsx')
  const html = render(Home.LastMeetingView, { meeting: null, item: null, now: NOW, navigate: () => {} })
  assert.match(html, /<h2[^>]*>Last meeting<\/h2>/)
  assert.match(html, />No meetings today\.</)
  assert.doesNotMatch(html, /Launch as session/)
  const repo = { id: '/home/you/dev/vault', name: 'vault', crewSeed: 'vault', crewSlot: 1 }
  const state = { loaded: true, view: { path: '/' }, data: { sessions: [], requests: [], runs: [], order: [], repos: [repo], health: [], prefs: {},
    counts: { needYouSessions: 0, running: 0, toReview: 0, openRequests: 0, requestSessions: 0, oldestRequestAt: null, perRun: [], archived: 0 } } }
  const calm = render(Home.HomeView, { state, now: NOW, navigate: () => {},
    lastMeeting: createElement(Home.LastMeetingView, { meeting: MEETINGS[1], item: null, now: NOW, navigate: () => {} }) })
  assert.match(calm, /Calm seas\. No ships out\./)
  assert.ok(calm.indexOf('Open loops before tomorrow') < calm.indexOf('>Last meeting<'), 'Calm renders Last meeting under the open loops section')
  assert.match(calm, />Client A · weekly sync</)
})

test('loadLastMeeting reads the list from disk with scribed down and picks the first undismissed action item', async () => {
  const Home = await load('screens/home/Home.jsx')
  const gets = []
  const api = {
    async get(to) {
      gets.push(to)
      if (to.startsWith('/api/meetings/')) {
        return { meeting: MEETINGS[1], note: { actionItems: [{ key: 'a', text: 'feito', dismissed: true }, { key: 'b', text: 'Enviar a ata', owner: 'Você', dismissed: false }] } }
      }
      return { meetings: MEETINGS, recorder: { state: 'unavailable' }, tags: [], configError: null }
    }
  }
  const fetched = []
  const result = await Home.loadLastMeeting(api, NOW, action => fetched.push(action))
  assert.equal(result.meeting?.id, 'm-sync', 'scribed down does not hide the past meetings')
  assert.equal(result.item?.key, 'b', 'a dismissed item is skipped')
  assert.deepEqual(gets, ['/api/meetings', '/api/meetings/m-sync'])
  assert.deepEqual(fetched.map(action => action.type), ['meetings.fetched'])
  const none = await Home.loadLastMeeting({ async get() { return { meetings: [MEETINGS[3]] } } }, NOW)
  assert.deepEqual(none, { meeting: null, item: null })
})

test('Settings Connections shows the TurbidAssist config status from GET /api/meetings', async () => {
  const Settings = await load('screens/settings/Settings.jsx')
  const missing = Settings.turbidStatus({ meetings: [], tags: [], configError: { code: 'not_found', path: '/home/you/dev/turbidassist/config.yaml' } }, null)
  assert.equal(missing.text, 'config.yaml not found at /home/you/dev/turbidassist/config.yaml.')
  assert.equal(missing.tone, 'bad')
  const read = Settings.turbidStatus({ meetings: [], tags: [{ tag: 'pessoal' }, { tag: 'client-a' }, { tag: 'client-b' }], configError: null }, '/home/you/turbid/config.yaml')
  assert.equal(read.text, 'Read 3 tags from /home/you/turbid/config.yaml.')
  assert.equal(Settings.turbidStatus(null, null), null, 'nothing before the list loads')
  const html = render(Settings.ConnectionsSection, { prefs: { scanRoot: '/home/you/dev', turbidassistConfig: null }, health: [], turbid: missing,
    onSave: () => {}, onRescan: () => {}, onStart: () => {}, onChecklist: () => {} })
  const field = html.indexOf('TurbidAssist config.yaml')
  const line = html.indexOf('config.yaml not found at /home/you/dev/turbidassist/config.yaml.')
  assert.ok(field >= 0 && line > field && line < html.indexOf('Commands the deck runs'), 'the status sits under the TurbidAssist field')
})
