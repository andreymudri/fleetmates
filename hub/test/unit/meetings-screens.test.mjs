// M4 Task 13: the Meetings list, detail and search (docs/deck/screens/meetings.md 3.1, 4.1, 4.2, 5.1 and 6,
// ACs 1 to 3, 5, 10 to 12) rendered with the Task 6 meetings5 tree read through the server's own readers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import { writeMeetingsTree, meetings5 } from '../helpers/meetings-tree.mjs'
import { listSessions, postState, readTranscript, searchTranscripts, speakers } from '../../server/meetings/history.mjs'
import { parseNote, readNote } from '../../server/meetings/note.mjs'
import { readConfig, policyFor } from '../../server/meetings/config.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load(file) {
  const { module } = await runnerImport(path.join(hub, 'web/src/screens/meetings', file), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))

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
const plain = html => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

function fakeApi({ post } = {}) {
  const calls = []
  const reply = (method, url, body) => {
    calls.push(body === undefined ? [method, url] : [method, url, body])
    return post && method === 'POST' ? post(url, body) : Promise.resolve({})
  }
  return { calls, get: url => reply('GET', url), post: (url, body) => reply('POST', url, body), del: url => reply('DELETE', url) }
}

// The meetings5 tree under a temporary HOME, read the way GET /api/meetings and GET /api/meetings/:id read it.
async function fixture(t, variants = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mtg-screens-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tree = await writeMeetingsTree(root, meetings5, { variants })
  const config = readConfig(tree.configPath, { home: root })
  assert.equal(config.ok, true, 'the fixture config parses')
  const keyOf = Object.fromEntries(Object.entries(tree.ids).filter(([key]) => key !== 'meetings').map(([key, id]) => [id, key]))
  const sessionOf = key => meetings5.sessions.find(item => item.key === key) ?? meetings5.variants[key]
  const sessions = await listSessions(tree.sessionDir, { now: tree.now })
  const meetings = []
  const details = {}
  for (const entry of sessions) {
    const key = keyOf[entry.id]
    const notePath = tree.notes[key] ?? null
    const note = notePath ? parseNote(await readNote({ vaultPath: tree.vaultPath, notePath })) : null
    const { stuck } = await postState(tree.sessionDir, entry.id, { now: tree.now, procLocks: '' })
    const meeting = {
      id: entry.id, tag: entry.tag ?? sessionOf(key).tag, confidential: policyFor(config, entry.tag).confidential, state: entry.state,
      startedAt: entry.startedAt, endedAt: entry.endedAt, notePath, apps: sessionOf(key).apps, stuck, interrupted: entry.interrupted
    }
    meetings.push({ ...meeting, title: note?.title ?? null, actionItemCount: note ? note.actionItems.length : null })
    const transcript = await readTranscript(tree.sessionDir, entry.id)
    details[key] = {
      meeting, note: note ? { ...note, actionItems: note.actionItems.map(item => ({ ...item, dismissed: false })) } : null,
      pins: [], speakers: transcript ? speakers(transcript.lines) : null, model: config.batchModel
    }
  }
  const list = { meetings, recorder: { state: 'idle', meetingId: null }, tags: config.tags, configError: null, model: config.batchModel }
  return { tree, config, sessions, list, details, now: tree.now }
}

test('AC1: day groups read Today, Yesterday, Thursday and the newest row is selected with "Client A · weekly sync"', async t => {
  const { Meetings } = await load('Meetings.jsx')
  const f = await fixture(t)
  const html = render(Meetings, {
    route: { name: 'meetings', params: {} }, search: '', state: { data: { recorder: { state: 'idle' }, meetings: {} } }, navigate: () => {},
    api: fakeApi(), now: f.now, initial: { list: f.list, detail: f.details.weekly }
  })
  const groups = [...html.matchAll(/<h2 class="eyebrow">([^<]*)<\/h2>/g)].map(match => match[1])
  assert.deepEqual(groups, ['Today', 'Yesterday', 'Thursday'])
  const rows = [...html.matchAll(/<a class="meetings-row[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map(match => ({ tag: match[0], text: plain(match[1]) }))
  assert.equal(rows.length, 5)
  assert.match(rows[0].tag, /aria-current="page"/, 'the newest meeting is selected on /meetings')
  assert.match(rows[0].text, /^Client A · weekly sync14:00Teams · 42 min · 3 action items$/)
  assert.equal(rows.filter(row => /aria-current/.test(row.tag)).length, 1)
  assert.match(html, /<h2 class="meeting-detail-title"><bdi>Client A · weekly sync<\/bdi><\/h2>/)
  assert.match(html, /<p class="meeting-meta">Today 14:00 · 42 min · Você \+ 3 speakers on Sala · transcribed with large-v3<\/p>/)
  assert.match(html, /<aside class="meetings-list" aria-label="Meetings"><header class="meetings-list-header"><h1 class="meetings-list-title">Meetings<\/h1>/)
})

test('AC2: "feature flag" gives "4 hits in 2 meetings", hits as mark elements, and the detail counts its own hits', async t => {
  const { MeetingsListView } = await load('Meetings.jsx')
  const { MeetingDetailView } = await load('MeetingDetail.jsx')
  const f = await fixture(t)
  const result = await searchTranscripts(f.sessions, 'feature flag')
  const html = render(MeetingsListView, { meetings: f.list.meetings, q: 'feature flag', result, now: f.now })
  assert.match(html, /<p class="meetings-search-helper" role="status">4 hits in 2 meetings<\/p>/)
  const titles = [...html.matchAll(/class="meetings-row-title" lang="pt-BR">([^<]*)</g)].map(match => match[1])
  assert.deepEqual(titles, ['Client A · weekly sync', 'Pessoal · retrospectiva do sprint'], 'only meetings with hits are listed')
  assert.ok([...html.matchAll(/<mark>([^<]*)<\/mark>/g)].every(match => /^feature flag$/i.test(match[1])))
  assert.ok(html.includes('<mark>'), 'hits render with mark elements')
  const weekly = f.details.weekly
  const own = result.hits.filter(hit => hit.meetingId === weekly.meeting.id)
  const detail = render(MeetingDetailView, { detail: weekly, q: 'feature flag', hits: own, now: f.now })
  assert.match(plain(detail), /"feature flag" in this meeting · 2 hits/)
  assert.equal([...detail.matchAll(/<mark>/g)].length, 2)
  const none = render(MeetingsListView, { meetings: f.list.meetings, q: 'zebra', result: { hits: [], meetingCount: 0 }, now: f.now })
  assert.match(plain(none), /No hits for "zebra"\./)
})

test('AC3: the tag menu lists pessoal, client-a, client-b with pessoal selected and the confidential ones say "transcript not stored"', async t => {
  const { MeetingsListView } = await load('Meetings.jsx')
  const f = await fixture(t)
  const html = render(MeetingsListView, { meetings: f.list.meetings, tags: f.config.tags, menuOpen: true, now: f.now })
  assert.match(html, /<ul class="meetings-tag-menu" role="listbox" aria-label="Record with tag">/)
  const options = [...html.matchAll(/<li role="option" aria-selected="(true|false)"[^>]*><bdi>([^<]*)<\/bdi><\/li>/g)].map(match => [match[2], match[1]])
  assert.deepEqual(options, [['pessoal', 'true'], ['client-a · transcript not stored', 'false'], ['client-b · transcript not stored', 'false']])
})

test('AC5: a refusal toasts "scribed refused: {message}" with the message in a pt-BR node; an ok start opens the live view', async () => {
  const { startWithTag, MeetingsListView } = await load('Meetings.jsx')
  const refusal = 'sessão já ativa; pare a atual antes'
  const api = fakeApi({ post: () => Promise.reject(Object.assign(new Error('scribed refused the command'), { status: 409, code: 'scribed_refused', details: { text: refusal } })) })
  let toast = null
  const went = []
  await startWithTag({ api, navigate: to => went.push(to), show: next => { toast = next } })('client-a')
  assert.deepEqual(api.calls, [['POST', '/api/meetings/start', { tag: 'client-a' }]])
  assert.deepEqual(went, [])
  const html = render(MeetingsListView, { meetings: [], toast, now: 0 })
  assert.match(html, /role="alert"><p class="archive-toast-text">scribed refused: <bdi lang="pt-BR">sessão já ativa; pare a atual antes<\/bdi><\/p>/)

  const ok = fakeApi({ post: () => Promise.resolve({ recorder: { state: 'recording', meetingId: 'm1' } }) })
  await startWithTag({ api: ok, navigate: to => went.push(to), show: () => {} })('pessoal')
  assert.deepEqual(went, ['/meetings/live'])
})

test('a start answered 202 without recording stops "Starting…" and says scribed did not confirm; the wait is bounded by the clock', async () => {
  const { startWithTag, startView, MeetingsListView, START_SLOW_MS } = await load('Meetings.jsx')
  const outcomes = []
  const answer = state => fakeApi({ post: () => Promise.resolve({ recorder: { state, meetingId: null } }) })
  const handlers = { navigate: to => outcomes.push(to), show: () => {}, onStarting: () => outcomes.push('starting'), onUnconfirmed: () => outcomes.push('unconfirmed'), onFailed: () => outcomes.push('failed') }
  await startWithTag({ api: answer('idle'), ...handlers })('pessoal')
  await startWithTag({ api: answer('starting'), ...handlers })('pessoal')
  assert.deepEqual(outcomes, ['unconfirmed', 'starting'], 'an idle recorder after the 202 is not a start in progress')

  const idle = { state: 'idle' }
  assert.deepEqual(startView({ start: { phase: 'unconfirmed', at: 0 }, recorder: idle, now: 1 }), { busy: false, slow: true })
  assert.deepEqual(startView({ start: { phase: 'pending', at: 1000 }, recorder: idle, now: 1000 + START_SLOW_MS - 1 }), { busy: true, slow: false })
  assert.deepEqual(startView({ start: { phase: 'pending', at: 1000 }, recorder: idle, now: 1000 + START_SLOW_MS }), { busy: false, slow: true }, 'the injected clock bounds the wait')
  assert.deepEqual(startView({ start: { phase: 'polling', at: 1000 }, recorder: { state: 'starting', since: 1000 }, now: 1000 + START_SLOW_MS }), { busy: false, slow: true })
  assert.deepEqual(startView({ start: { phase: 'unconfirmed', at: 0 }, recorder: { state: 'recording' }, now: 1 }), { busy: false, slow: false })
  assert.deepEqual(startView({ start: null, recorder: idle, now: 1 }), { busy: false, slow: false })

  const view = startView({ start: { phase: 'unconfirmed', at: 0 }, recorder: idle, now: 1 })
  const html = render(MeetingsListView, { meetings: [], recorder: idle, starting: view.busy, startSlow: view.slow, now: 0 })
  const record = /<button type="button" class="button button--secondary button--sm meetings-record"([^>]*)>([\s\S]*?)<\/button>/.exec(html)
  assert.doesNotMatch(record[1], /disabled/, 'Record is usable again')
  assert.equal(plain(record[2]), 'Record')
  assert.match(html, /<p class="meeting-muted" role="status">scribed did not confirm the start\. Checking…<\/p>/)
})

test('AC10: with scribed down the list still renders and the degraded card replaces Record', async t => {
  const { MeetingsListView } = await load('Meetings.jsx')
  const f = await fixture(t)
  const html = render(MeetingsListView, { meetings: f.list.meetings, recorder: { state: 'unavailable' }, tags: f.config.tags, now: f.now,
    onStartScribed: () => {}, onRetryScribed: () => {} })
  assert.equal([...html.matchAll(/class="meetings-row[ "]/g)].length, 5, 'the five meetings still list')
  assert.match(html, /<section class="degraded-card" role="region"/)
  assert.match(plain(html), /Meetings tabNo one on the radioscribed is not running/)
  assert.match(html, />Start scribed<\/button>/)
  assert.match(html, />Retry<\/button>/)
  assert.doesNotMatch(html, /meetings-record"/, 'no Record button')
  const idle = render(MeetingsListView, { meetings: f.list.meetings, recorder: { state: 'idle' }, now: f.now })
  assert.match(idle, /class="button button--secondary button--sm meetings-record"/)
  const recording = render(MeetingsListView, { meetings: f.list.meetings, recorder: { state: 'recording' }, now: f.now })
  assert.match(recording, /<a class="meetings-recording-link" href="\/meetings\/live">.*Recording · Open<\/a>/)
  assert.doesNotMatch(recording, /meetings-record"/, 'Record is hidden while recording')
})

test('a missing config shows the notice with "Fix in Settings" and disables Record; loading and empty states', async () => {
  const { MeetingsListView } = await load('Meetings.jsx')
  const went = []
  const props = { meetings: [], configError: { code: 'not_found', path: '/home/you/dev/turbidassist/config.yaml' }, now: 0, onFixConfig: () => went.push('/settings/connections') }
  const html = render(MeetingsListView, props)
  assert.match(plain(html), /TurbidAssist is not configured for the deck: config\.yaml not found at \/home\/you\/dev\/turbidassist\/config\.yaml\./)
  assert.match(html, /<button type="button" class="button button--secondary button--sm meetings-record"[^>]*disabled=""/)
  const fix = buttonsIn(MeetingsListView(props), 'Fix in Settings')
  assert.equal(fix.length, 1)
  fix[0].props.onClick()
  assert.deepEqual(went, ['/settings/connections'])
  assert.match(plain(render(MeetingsListView, { meetings: [], now: 0 })), /No meetings yet\. Press Record, or start one with scribe; it shows up here\./)
  const loading = render(MeetingsListView, { meetings: null, now: 0 })
  assert.equal([...loading.matchAll(/meeting-skeleton--row/g)].length, 5, 'five skeleton rows while loading')
})

test('AC11: an awaiting_names meeting reads "Needs speaker names" and its detail shows the postmeet command with Copy', async t => {
  const { MeetingsListView } = await load('Meetings.jsx')
  const { MeetingDetailView } = await load('MeetingDetail.jsx')
  const f = await fixture(t, ['awaitingNames', 'interrupted'])
  const id = f.tree.ids.awaitingNames
  const html = render(MeetingsListView, { meetings: f.list.meetings, now: f.now })
  const row = new RegExp(`href="/meetings/${id}"[^>]*>[\\s\\S]*?class="meetings-row-meta meetings-row-meta--post">Needs speaker names</span>`)
  assert.match(html, row)
  assert.match(html, new RegExp(`href="/meetings/${f.tree.ids.interrupted}"[^>]*>[\\s\\S]*?meetings-row-meta--post">Recording interrupted</span>`))
  const copied = []
  const props = { detail: f.details.awaitingNames, now: f.now, onCopy: value => copied.push(value) }
  assert.match(plain(render(MeetingDetailView, props)), new RegExp(`Needs speaker names\\. Run: postmeet name ${id}`))
  const copy = buttonsIn(MeetingDetailView(props), 'Copy')
  assert.equal(copy.length, 1)
  copy[0].props.onClick()
  assert.deepEqual(copied, [`postmeet name ${id}`])
})

test('AC12: <b> in a summary, a decision and an action item renders as literal text in pt-BR nodes', async () => {
  const { MeetingDetailView } = await load('MeetingDetail.jsx')
  const note = parseNote(['# x', '', '## Resumo', 'Resumo com <b>negrito</b> aqui.', '', '## Decisões', '- Decidir <b>isto</b>.', '',
    '## Action items', '- [ ] Você: fazer <b>aquilo</b>', ''].join('\n'))
  const detail = { meeting: { id: 'm1', tag: 'pessoal', confidential: false, state: 'synthesized', startedAt: 0, endedAt: 60_000, apps: [], stuck: false },
    note: { ...note, actionItems: note.actionItems.map(item => ({ ...item, dismissed: false })) }, pins: [] }
  const html = render(MeetingDetailView, { detail, now: 0 })
  assert.doesNotMatch(html, /<b>/)
  assert.match(html, /<div class="meeting-summary" lang="pt-BR"><p>Resumo com &lt;b&gt;negrito&lt;\/b&gt; aqui\.<\/p><\/div>/)
  assert.match(html, /<li lang="pt-BR"><bdi>Decidir &lt;b&gt;isto&lt;\/b&gt;\.<\/bdi><\/li>/)
  assert.match(html, /<p class="meeting-item-text" lang="pt-BR"><bdi>fazer &lt;b&gt;aquilo&lt;\/b&gt;<\/bdi><\/p>/)
  assert.match(html, /<p class="meeting-item-owner" lang="pt-BR"><bdi>Você<\/bdi><\/p>/)
})

test('"Launch as session" opens /new with the encoded item text, and no "Research first" renders', async t => {
  const { MeetingDetailView, itemActions } = await load('MeetingDetail.jsx')
  const f = await fixture(t)
  const went = []
  const actions = itemActions({ api: fakeApi(), meetingId: 'x', navigate: to => went.push(to), show: () => {}, setDismissed: () => {} })
  const props = { detail: f.details.weekly, now: f.now, onLaunch: actions.launch }
  const launch = buttonsIn(MeetingDetailView(props), 'Launch as session')
  assert.equal(launch.length, 3)
  launch[0].props.onClick()
  assert.deepEqual(went, ['/new?task=' + encodeURIComponent('ligar o feature flag da 3.2 no beta interno até quarta')])
  assert.ok(went[0].includes('%20') && went[0].includes('%C3%A9'), went[0])
  const html = render(MeetingDetailView, props)
  assert.doesNotMatch(html, /Research first/)
  assert.equal(buttonsIn(MeetingDetailView(props), 'Dismiss').length, 3)
})

test('Dismiss then Undo calls dismissItem then undismissItem, and the item hides while dismissed', async t => {
  const { MeetingDetailView, itemActions } = await load('MeetingDetail.jsx')
  const f = await fixture(t)
  const api = fakeApi()
  let dismissed = {}
  let toast = null
  const actions = itemActions({ api, meetingId: 'm/1', navigate: () => {}, show: next => { toast = next },
    setDismissed: next => { dismissed = typeof next === 'function' ? next(dismissed) : next } })
  const item = f.details.weekly.note.actionItems[0]
  await actions.dismiss(item)
  assert.equal(toast.text, 'Dismissed')
  assert.ok(toast.undo, 'the toast carries Undo')
  assert.equal(dismissed[item.key], true)
  assert.doesNotMatch(render(MeetingDetailView, { detail: f.details.weekly, dismissed, now: f.now }), /ligar o feature flag/)
  await actions.undo(toast.undo)
  assert.deepEqual(api.calls, [['POST', `/api/meetings/m%2F1/items/${item.key}/dismiss`], ['DELETE', `/api/meetings/m%2F1/items/${item.key}/dismiss`]])
  assert.equal(dismissed[item.key], false)
  assert.match(render(MeetingDetailView, { detail: f.details.weekly, dismissed, now: f.now }), /ligar o feature flag/)
})

test('the post-state line for recorded names the configured batch model', async t => {
  const { postStateLine, MeetingsListView } = await load('Meetings.jsx')
  assert.equal(postStateLine({ state: 'recorded' }, 'large-v3'), 'Transcribing with large-v3…')
  assert.equal(postStateLine({ state: 'recorded' }, 'medium'), 'Transcribing with medium…')
  assert.equal(postStateLine({ state: 'transcribed' }, 'medium'), 'Summarizing…')
  assert.equal(postStateLine({ state: 'stopping' }, null), 'Saving the session…')
  assert.equal(postStateLine({ state: 'transcribed', stuck: true }, null), 'Summary failed')
  assert.equal(postStateLine({ state: 'awaiting_names', stuck: true }, null), 'Needs speaker names')
  assert.equal(postStateLine({ state: 'synthesized' }, null), null)
  const f = await fixture(t)
  const recorded = { ...f.list.meetings[0], state: 'recorded', title: null }
  const html = render(MeetingsListView, { meetings: [recorded], model: 'distil-v9', now: f.now })
  assert.match(html, /meetings-row-meta--post">Transcribing with distil-v9…<\/span>/)
  assert.match(html, /meetings-row-title" lang="pt-BR">Client A · 14:00</, 'before synthesis the title is the start time')
})

test('a confidential detail shows pins by time only and the transcript drawer says the deck stores no transcript', async t => {
  const { MeetingDetailView, TranscriptBody } = await load('MeetingDetail.jsx')
  const f = await fixture(t)
  const weekly = f.details.weekly
  assert.equal(weekly.meeting.confidential, true)
  const pins = [{ id: 'p1', t: 1091, label: 'Cinco por cento no beta', createdAt: 0 }]
  const html = render(MeetingDetailView, { detail: { ...weekly, pins }, now: f.now })
  assert.match(html, /<li class="meeting-pin"><span class="meeting-pin-time">18:11<\/span><\/li>/)
  assert.doesNotMatch(html, /Cinco por cento no beta<\/q>/)
  const open = render(MeetingDetailView, { detail: { ...f.details.planning, pins }, now: f.now })
  assert.match(open, /<q class="meeting-pin-label" lang="pt-BR"><bdi>Cinco por cento no beta<\/bdi><\/q>/)
  assert.doesNotMatch(render(MeetingDetailView, { detail: weekly, now: f.now }), /Pinned moments/, 'hidden without pins')
  const lines = (await readTranscript(f.tree.sessionDir, weekly.meeting.id)).lines
  const body = render(TranscriptBody, { meeting: weekly.meeting, transcript: { lines }, focusT: 1500 })
  assert.match(body, /Transcript not stored by the deck for client-a/)
  assert.match(body, /<li data-target="true"><div class="transcript-line transcript-line--hit"><span class="transcript-line-offset">25:00<\/span>/)
  assert.doesNotMatch(render(TranscriptBody, { meeting: f.details.planning.meeting, transcript: { lines } }), /Transcript not stored/)
})

test('the meeting screens render text only, import no CSS, and meetings.css styles their classes with tokens', async () => {
  const css = await readFile(path.join(hub, 'web/src/styles/meetings.css'), 'utf8')
  for (const file of ['Meetings.jsx', 'MeetingDetail.jsx']) {
    const source = await readFile(path.join(hub, 'web/src/screens/meetings', file), 'utf8')
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
    assert.doesNotMatch(source, /import\s+['"][^'"]+\.css['"]/)
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
      for (const [name] of (match[1] ?? match[2]).matchAll(/\bmeetings?-[\w-]+/g)) {
        assert.ok(new RegExp(`\\.${name}(?![\\w-])`).test(css), `meetings.css styles .${name} (${file})`)
      }
    }
  }
  const start = css.indexOf('/* Meetings list')
  assert.ok(start >= 0, 'meetings.css has the Meetings list block')
  const block = css.slice(start)
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|\brgba?\(/i, 'tokens only, no literal colors')
})

// M4 Task 20 (finding M4-T17-F2, qa-checklist 1.7, 08-security 4.5): escape, bell and bidi override characters in
// server-provided meeting text show as visible <U+XXXX> tokens on every meeting surface, never raw.
test('ESC, BEL and U+202E in meeting text render as visible tokens on the list, detail, transcript drawer and live view', async () => {
  const { MeetingsListView } = await load('Meetings.jsx')
  const { MeetingDetailView, TranscriptBody } = await load('MeetingDetail.jsx')
  const { MeetingLiveView, liveItems } = await load('MeetingLive.jsx')
  const evil = 'evil\u202etxt.exe \u001b[31mred\u001b[0m \u0007'
  const tokens = ['evil<U+202E>txt.exe', '<U+001B>[31mred<U+001B>[0m', '<U+0007>']
  const meeting = { id: 'm1', tag: `acme${evil}`, confidential: false, state: 'synthesized', startedAt: 0, endedAt: 60_000, apps: [evil], stuck: false, title: evil }
  const line = { t0: 1, t1: 4, speaker: evil, text: evil }
  const hit = { meetingId: 'm1', t0: 1, speaker: evil, snippet: `x ${evil}`, ranges: [[2, 6]] }
  const surfaces = {
    list: render(MeetingsListView, { meetings: [meeting], q: 'evil', result: { hits: [hit], meetingCount: 1 }, menuOpen: true,
      tags: [{ tag: `acme${evil}`, confidential: true, isDefault: true }], toast: { message: evil, pt: true }, now: 0 }),
    detail: render(MeetingDetailView, {
      detail: { meeting, note: { title: evil, summary: `${evil}\n\n- ${evil}`, decisions: [evil], actionItems: [{ key: 'k', text: evil, owner: evil, dismissed: false }] },
        pins: [{ id: 'p', t: 1, label: evil }], speakers: [evil], model: evil }, q: 'evil', hits: [hit], now: 0
    }),
    drawer: render(TranscriptBody, { meeting: { ...meeting, confidential: true }, transcript: { lines: [line, line] }, error: evil }),
    live: render(MeetingLiveView, {
      t: undefined, recorder: { state: 'recording', meetingId: 'm1', confidential: false }, items: liveItems([line], null), pins: [{ id: 'p', t: 1, label: evil }],
      meta: `${evil} · PT-BR`, listening: false, lost: false, atBottom: true, readAloud: false, draft: '', busy: false,
      thread: [{ id: 'a', question: evil, answer: `${evil}\n${evil}`, state: 'done', error: null }, { id: 'b', question: evil, answer: '', state: 'error', error: evil }],
      onReadAloud: () => {}, onLineClick: () => {}, onJump: () => {}, onScroll: () => {}, onDraft: () => {}, onAsk: () => {},
      onStopAsk: () => {}, onRetry: () => {}, onCopy: () => {}
    })
  }
  for (const [where, html] of Object.entries(surfaces)) {
    // A tag option's data-tag is the key Record starts with, never shown, so it keeps the tag as the config wrote it.
    assert.doesNotMatch(html.replace(/ data-tag="[^"]*"/g, ''), /[\u001b\u0007\u202e]/, `${where}: no raw escape, bell or bidi override`)
    for (const token of tokens) assert.ok(plain(html).includes(token), `${where}: shows ${token}`)
  }
  assert.match(surfaces.list, /<mark>evil<\/mark>&lt;U\+202E&gt;txt/, 'search-hit highlighting still marks the neutralised text')
  assert.match(surfaces.live, /<p class="live-ask-answer" lang="pt-BR">evil&lt;U\+202E&gt;txt\.exe [^<]*\nevil/, 'a multi-line answer keeps its line break')
  assert.match(surfaces.detail, /<div class="meeting-summary" lang="pt-BR"><p>evil&lt;U\+202E&gt;txt\.exe [^<]*<\/p>\s*<ul>\s*<li>evil/, 'the summary is still markdown')
})

// M4 Task 20: hit ranges index the server's text, so a control character before the hit must not shift the mark,
// and the text span is a bidi isolate through dir="auto" (an inner bdi would break the markup web-meetings pins).
test('a hit after control characters marks exactly its range and the transcript text span is a dir="auto" isolate', async () => {
  const { TranscriptLine } = await load('../../components/TranscriptLine.jsx')
  const html = render(TranscriptLine, { line: { t0: 1, speaker: 'Você', snippet: '\u202e\u001b x hit y' }, ranges: [[5, 8]] })
  assert.match(html, /<span class="transcript-line-text" dir="auto" lang="pt-BR">&lt;U\+202E&gt;&lt;U\+001B&gt; x <mark>hit<\/mark> y<\/span>/)
})

// M4 Task 20 (finding M4-T17-F3, axe landmark-no-duplicate-main): the shell's main#main is the only main, so the
// Meetings screen renders no main element of its own.
test('the Meetings screen renders no main landmark of its own', async t => {
  const { Meetings } = await load('Meetings.jsx')
  const f = await fixture(t)
  const html = render(Meetings, {
    route: { name: 'meetings', params: {} }, search: '', state: { data: { recorder: { state: 'idle' }, meetings: {} } }, navigate: () => {},
    api: fakeApi(), now: f.now, initial: { list: f.list, detail: f.details.weekly }
  })
  assert.match(html, /class="meetings-detail-pane"/, 'the detail pane renders')
  assert.match(html, /meeting-detail-title/, 'with the selected meeting in it')
  assert.doesNotMatch(html, /<main\b/)
})
