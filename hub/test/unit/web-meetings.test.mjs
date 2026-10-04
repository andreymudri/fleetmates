// M4 web client plumbing (docs/plans/2026-10-04-deck-m4.md Task 12): the TranscriptLine and DegradedCard
// components under renderToStaticMarkup, the meeting reducers of deck-store.js and the Alt P key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import { reduce, initialState, keyAction, isGlobalChord, LIVE_LINE_CAP } from '../../web/src/state/deck-store.js'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const components = path.join(hub, 'web/src/components')

async function load(name) {
  const { module } = await runnerImport(path.join(components, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))
const message = msg => ({ type: 'message', message: msg })
const recorder = (state, meetingId = 'm1', extra = {}) => ({ state, meetingId, tag: 'pessoal', confidential: false, elapsedS: 0, apps: [], quiet: false, ...extra })
const snapshot = (seq, extra = {}) => message({
  t: 'snapshot', seq, epoch: 'e1', data: {
    sessions: [], requests: [], runs: [], repos: [], counts: null, order: [], recap: null, ruleOffers: [], research: [],
    recorder: recorder('recording'), health: [], prefs: { lang: 'en', firstRunCompletedAt: 1 }, setup: { firstRunCompletedAt: 1 }, ...extra
  }
})
const line = (t0, text = `linha ${t0}`) => ({ t0, t1: t0 + 1, speaker: 'Você', text })
const transcript = (meetingId, l) => message({ t: 'meeting.transcript', data: { meetingId, line: l, ephemeral: true } })
const loaded = (extra = {}) => reduce(initialState(), snapshot(1, extra))

test('formatOffset writes MM:SS counting total minutes', async () => {
  const { formatOffset } = await load('TranscriptLine.jsx')
  assert.equal(formatOffset(3725), '62:05')
  assert.equal(formatOffset(0), '00:00')
  assert.equal(formatOffset(1060.7), '17:40')
  assert.equal(formatOffset(59), '00:59')
})

test('a transcript line renders its text literally in a pt-BR node and its ranges as mark elements', async () => {
  const { TranscriptLine } = await load('TranscriptLine.jsx')
  const html = render(TranscriptLine, { line: { t0: 1060, t1: 1064, speaker: 'Sala', text: '<b>x</b>' } })
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, 'the text is escaped, never parsed as HTML')
  assert.doesNotMatch(html, /<b>/)
  assert.match(html, /<span[^>]*class="transcript-line-text"[^>]*lang="pt-BR"[^>]*>&lt;b&gt;/, 'the text node carries lang="pt-BR"')
  assert.match(html, />17:40</)
  assert.match(html, />Sala</)

  const hit = render(TranscriptLine, { line: { t0: 5, t1: 9, speaker: 'Você', text: 'o feature flag liga o feature flag' }, ranges: [[2, 14], [22, 34]] })
  const marks = [...hit.matchAll(/<mark>([^<]*)<\/mark>/g)].map(match => match[1])
  assert.deepEqual(marks, ['feature flag', 'feature flag'])
  assert.match(hit, /lang="pt-BR">o <mark>feature flag<\/mark> liga o <mark>feature flag<\/mark><\/span>/)

  const snippet = render(TranscriptLine, { line: { t0: 5, speaker: 'Você', snippet: 'a <i>b</i>' }, ranges: [[2, 5]] })
  assert.match(snippet, /a <mark>&lt;i&gt;<\/mark>b&lt;\/i&gt;/, 'a search hit snippet is marked as text too')

  const pinned = render(TranscriptLine, { line: line(3), pinned: true, live: true, onClick: () => {} })
  assert.match(pinned, /class="transcript-line transcript-line--live transcript-line--pinned"/)
  assert.match(pinned, /<button type="button"[^>]*aria-pressed="true"/, 'a clickable line is a toggle button')
})

test('DegradedCard is a region named by its title with the cause, the command well and both actions', async () => {
  const { DegradedCard } = await load('DegradedCard.jsx')
  const html = render(DegradedCard, {
    area: 'Meetings tab', title: 'No one on the radio', body: 'scribed is not running: no socket at $XDG_RUNTIME_DIR/turbidassist.sock. Past meetings still load from the vault.',
    code: 'scribed', fixLabel: 'Start scribed', onFix: () => {}, retryLabel: 'Retry', onRetry: () => {}
  })
  const labelled = /<section class="degraded-card" role="region" aria-labelledby="([^"]+)"/.exec(html)
  assert.ok(labelled, html)
  assert.match(html, new RegExp(`<h2 class="degraded-card-title" id="${labelled[1]}">No one on the radio</h2>`))
  assert.match(html, /<p class="eyebrow">Meetings tab<\/p>/)
  assert.match(html, /<code class="degraded-card-command">scribed<\/code>/)
  assert.match(html, /<button type="button" class="button button--primary button--sm">Start scribed<\/button>/)
  assert.match(html, /<button type="button" class="button button--secondary button--sm">Retry<\/button>/)
  const bare = render(DegradedCard, { area: 'Memory tab', title: 'The charts are out of reach', body: 'x', retryLabel: 'Retry', onRetry: () => {} })
  assert.doesNotMatch(bare, /degraded-card-command|button--primary/, 'no command and no fix render nothing')
})

test('meeting.transcript keeps the newest 10,000 lines of the recorder meeting and ignores other meetings', () => {
  assert.equal(LIVE_LINE_CAP, 10000)
  let state = loaded()
  state = reduce(state, transcript('m2', line(0, 'outra')))
  assert.equal(state.data.live, null, 'a line of another meeting is ignored')
  for (let i = 0; i < 10001; i++) state = reduce(state, transcript('m1', line(i)))
  assert.equal(state.data.live.meetingId, 'm1')
  assert.equal(state.data.live.lines.length, 10000)
  assert.equal(state.data.live.lines[0].t0, 1, 'the oldest line is dropped')
  assert.equal(state.data.live.lines.at(-1).t0, 10000)
  assert.equal(state.seq, 1, 'ephemeral lines never move seq')
  const before = state
  state = reduce(state, transcript('m2', line(20000)))
  assert.equal(state, before, 'another meeting leaves the store untouched')
})

test('meeting.recovered records a divider at the current end; leaving the meeting clears the live data', () => {
  let state = loaded()
  state = reduce(state, transcript('m1', line(1)))
  state = reduce(state, transcript('m1', line(2)))
  state = reduce(state, message({ t: 'meeting.recovered', data: { meetingId: 'm1', count: 2, ephemeral: true } }))
  state = reduce(state, transcript('m1', line(3)))
  assert.deepEqual(state.data.live.recovered, [{ at: 2, count: 2 }])
  state = reduce(state, message({ t: 'meeting.recovered', data: { meetingId: 'm9', count: 4, ephemeral: true } }))
  assert.deepEqual(state.data.live.recovered, [{ at: 2, count: 2 }], 'a divider of another meeting is ignored')

  state = reduce(state, message({ t: 'meeting.status', seq: 2, data: recorder('stopping') }))
  assert.equal(state.data.live.lines.length, 3, 'stopping the same meeting keeps its lines')
  state = reduce(state, message({ t: 'meeting.status', seq: 3, data: recorder('idle', null) }))
  assert.equal(state.data.live, null)
})

test('meeting.updated merges by id keeping a known title, and pins are added and removed per meeting', () => {
  let state = loaded()
  state = reduce(state, { type: 'meetings.fetched', meetings: [{ id: 'm1', tag: 'client-a', state: 'recorded', title: 'weekly sync' }] })
  state = reduce(state, message({ t: 'meeting.updated', seq: 2, data: { id: 'm1', tag: 'client-a', state: 'synthesized', stuck: false } }))
  assert.deepEqual(state.data.meetings.m1, { id: 'm1', tag: 'client-a', state: 'synthesized', title: 'weekly sync', stuck: false })
  state = reduce(state, message({ t: 'meeting.updated', seq: 3, data: { id: 'm1', state: 'synthesized', title: null } }))
  assert.equal(state.data.meetings.m1.title, 'weekly sync', 'a null title does not erase a known one')
  state = reduce(state, message({ t: 'meeting.updated', seq: 4, data: { id: 'm2', tag: 'pessoal', state: 'recording' } }))
  assert.deepEqual(Object.keys(state.data.meetings).sort(), ['m1', 'm2'])

  state = reduce(state, message({ t: 'meeting.pin.added', seq: 5, data: { meetingId: 'm1', id: 'p2', t: 90, label: null, createdAt: 2 } }))
  state = reduce(state, message({ t: 'meeting.pin.added', seq: 6, data: { meetingId: 'm1', id: 'p1', t: 30, label: 'oi', createdAt: 1 } }))
  assert.deepEqual(state.data.meetingPins.m1.map(pin => pin.id), ['p1', 'p2'], 'pins in time order')
  state = reduce(state, message({ t: 'meeting.pin.removed', seq: 7, data: { meetingId: 'm1', id: 'p1' } }))
  state = reduce(state, message({ t: 'meeting.pin.removed', seq: 8, data: { meetingId: 'm1', id: 'p2' } }))
  assert.deepEqual(state.data.meetingPins.m1, [], 'pin added then removed leaves no pin')
})

test('ask.delta text accumulates in order on a meeting thread, then ask.done and ask.error settle it', () => {
  let state = loaded()
  const thread = { id: 'th1', title: 'q', scope: 'meeting:m1', createdAt: 1, persisted: false }
  const delta = text => message({ t: 'ask.delta', data: { threadId: 'th1', messageId: 'a1', text, ephemeral: true } })
  // The first delta can beat the POST /api/ask answer to the browser.
  state = reduce(state, delta('Ficou '))
  state = reduce(state, { type: 'meeting.ask', thread, userMessage: { id: 'u1', role: 'user', text: 'q', persisted: false }, assistantMessageId: 'a1' })
  state = reduce(state, delta('decidido '))
  state = reduce(state, delta('o beta.'))
  assert.equal(state.data.meetingAsk.m1.text, 'Ficou decidido o beta.')
  assert.equal(state.data.meetingAsk.m1.state, 'streaming')
  state = reduce(state, message({ t: 'ask.done', data: { threadId: 'th1', message: { id: 'a1', role: 'assistant', text: 'Ficou decidido o beta interno.', citations: [], persisted: false }, ephemeral: true } }))
  assert.equal(state.data.meetingAsk.m1.state, 'done')
  assert.equal(state.data.meetingAsk.m1.text, 'Ficou decidido o beta interno.')

  state = reduce(state, { type: 'meeting.ask', thread: { ...thread, id: 'th2' }, userMessage: { id: 'u2', role: 'user', text: 'q2' }, assistantMessageId: 'a2' })
  state = reduce(state, message({ t: 'ask.error', data: { threadId: 'th2', messageId: 'a2', error: { code: 'scribed_refused', message: 'scribed_refused', retryable: false, details: { text: 'sem sessão' } }, ephemeral: true } }))
  assert.equal(state.data.meetingAsk.m1.state, 'error')
  assert.equal(state.data.meetingAsk.m1.error.details.text, 'sem sessão')

  const vault = reduce(state, { type: 'meeting.ask', thread: { id: 'v1', scope: 'vault' }, assistantMessageId: 'x' })
  assert.equal(vault.data.meetingAsk, state.data.meetingAsk, 'a thread outside a meeting scope is not a meeting ask')
})

test('a late delta from an earlier ask never lands in the meeting\'s newer ask', () => {
  let state = loaded()
  state = reduce(state, { type: 'meeting.ask', thread: { id: 'th1', scope: 'meeting:m1' }, userMessage: { text: 'q1' }, assistantMessageId: 'a1' })
  state = reduce(state, { type: 'meeting.ask', thread: { id: 'th2', scope: 'meeting:m1' }, userMessage: { text: 'q2' }, assistantMessageId: 'a2' })
  state = reduce(state, message({ t: 'ask.delta', data: { threadId: 'th1', messageId: 'a1', text: 'STALE', ephemeral: true } }))
  assert.equal(state.data.meetingAsk.m1.threadId, 'th2')
  assert.equal(state.data.meetingAsk.m1.text, '')
  assert.equal(state.data.meetingAsk.m1.state, 'streaming')
})

test('Alt P is the pin action only while recording and never from inside a terminal', () => {
  const inside = { closest: selector => selector === '.terminal-view' ? {} : null }
  const outside = { closest: () => null }
  const altP = target => ({ code: 'KeyP', altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, target })
  const recording = loaded()
  assert.deepEqual(keyAction(altP(outside), recording), { type: 'pin' })
  assert.deepEqual(keyAction(altP(undefined), recording), { type: 'pin' })
  assert.equal(keyAction(altP(inside), recording), null, 'a focused terminal keeps Alt P')
  assert.equal(keyAction(altP(outside), loaded({ recorder: recorder('idle', null) })), null)
  assert.equal(keyAction(altP(outside), loaded({ recorder: recorder('stopping') })), null)
  assert.equal(keyAction({ ...altP(outside), shiftKey: true }, recording), null)
  assert.equal(keyAction({ ...altP(outside), ctrlKey: true }, recording), null)
  assert.equal(keyAction({ ...altP(outside), metaKey: true }, recording), null)
  assert.equal(isGlobalChord(altP(inside)), false, 'the terminal still receives Alt P')
})

test('no meeting reducer touches sessionStorage, localStorage or IndexedDB', () => {
  const names = ['sessionStorage', 'localStorage', 'indexedDB']
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  const touched = []
  const trap = name => new Proxy({}, { get: (_, key) => { touched.push(`${name}.${String(key)}`)
    return () => {} } })
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { value: trap(name), configurable: true, writable: true })
    let state = loaded()
    state = reduce(state, { type: 'meetings.fetched', meetings: [{ id: 'm1', title: 't' }] })
    state = reduce(state, message({ t: 'meeting.updated', seq: 2, data: { id: 'm1', state: 'recording' } }))
    state = reduce(state, message({ t: 'meeting.pin.added', seq: 3, data: { meetingId: 'm1', id: 'p1', t: 1, label: 'x' } }))
    state = reduce(state, transcript('m1', line(1, 'sentinel-transcript')))
    state = reduce(state, message({ t: 'meeting.recovered', data: { meetingId: 'm1', count: 1 } }))
    state = reduce(state, { type: 'meeting.ask', thread: { id: 'th', scope: 'meeting:m1' }, userMessage: { text: 'q' }, assistantMessageId: 'a' })
    state = reduce(state, message({ t: 'ask.delta', data: { threadId: 'th', messageId: 'a', text: 'sentinel-answer' } }))
    state = reduce(state, message({ t: 'ask.done', data: { threadId: 'th', message: { id: 'a', text: 'sentinel-answer' } } }))
    state = reduce(state, message({ t: 'meeting.pin.removed', seq: 4, data: { meetingId: 'm1', id: 'p1' } }))
    state = reduce(state, message({ t: 'meeting.status', seq: 5, data: recorder('idle', null) }))
    assert.equal(state.data.live, null)
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
  assert.deepEqual(touched, [])
})
