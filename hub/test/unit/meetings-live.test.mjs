// M4 live view, recording bar and Alt P (docs/plans/2026-10-04-deck-m4.md Task 14; screens/meetings.md 3.2, 4.3,
// 5.2, ACs 4, 7, 8 and 13; rail-and-shell.md 4.2). Pure views under renderToStaticMarkup, the pure models with an
// injected clock, and the pin handlers against a recording API double.
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
// Local 14:00, so the formatted start time reads 14:00 in any time zone the suite runs in.
const STARTED = new Date(2026, 9, 4, 14, 0).getTime()
const recorder = (state, extra = {}) => ({
  state, meetingId: 'm-live', tag: 'client-a', confidential: true, elapsedS: 1154, since: STARTED, startedAt: STARTED,
  apps: [], quiet: false, slow: false, lost: false, lastError: null, ...extra
})
const line = (t0, text = `linha ${t0}`, extra = {}) => ({ t0, t1: t0 + 2, speaker: 'Você', text, ...extra })

// Records every call in the createApiClient shape.
function recordingApi() {
  const calls = []
  const call = method => async (to, body) => {
    calls.push(body === undefined ? [method, to] : [method, to, body])
    return {}
  }
  return { calls, get: call('GET'), post: call('POST'), del: call('DELETE') }
}

const barProps = (rec, extra = {}) => ({ recorder: rec, lang: 'en', elapsedS: rec.elapsedS, reduced: false, navigate: () => {}, onPin: () => {}, onStop: () => {}, ...extra })

test('the recording bar shows Recording, the tag and start time as a link, and an aria-hidden MM:SS timer', async () => {
  const { RecBarView } = await load('shell/RecBar.jsx')
  const html = render(RecBarView, barProps(recorder('recording')))
  assert.match(html, />Recording</)
  assert.match(html, /<a [^>]*href="\/meetings\/live"[^>]*>Client A · started 14:00<\/a>/)
  assert.match(html, /<span class="rec-bar-timer" aria-hidden="true">19:14<\/span>/, 'the ticking timer is hidden from screen readers')
  assert.match(html, /<span class="sr-only">Recording, started 14:00<\/span>/, 'a static start time is exposed instead')
  assert.match(html, /Pin moment/)
  assert.match(html, /<kbd class="kbd[^"]*">Alt P<\/kbd>/)
})

test('the quiet note shows only while quiet mode is on', async () => {
  const { RecBarView } = await load('shell/RecBar.jsx')
  const quiet = render(RecBarView, barProps(recorder('recording', { quiet: true })))
  assert.match(quiet, /Sound muted while recording · popups still show/)
  const loud = render(RecBarView, barProps(recorder('recording', { quiet: false })))
  assert.doesNotMatch(loud, /Sound muted/)
  assert.doesNotMatch(loud, /rec-bar-quiet/, 'neither the note nor its 1280 info icon renders')
})

test('stopping shows the neutral saving text, then the still-stopping text once slow', async () => {
  const { RecBarView } = await load('shell/RecBar.jsx')
  const stopping = render(RecBarView, barProps(recorder('stopping')))
  assert.match(stopping, /Stopping… saving the session/)
  assert.doesNotMatch(stopping, /Still stopping/)
  assert.doesNotMatch(stopping, /Stop and summarize|Pin moment/, 'nothing to pin or stop while stopping')
  assert.match(stopping, /rec-bar--stopping/)
  const slow = render(RecBarView, barProps(recorder('stopping', { slow: true })))
  assert.match(slow, /Still stopping, scribed is closing the session/)
  assert.doesNotMatch(slow, /Stopping… saving the session/)
  assert.equal(render(RecBarView, barProps(recorder('idle'))), '', 'no bar while idle')
})

test('Stop and summarize is a plain button that is never focused by default', async () => {
  const { RecBarView } = await load('shell/RecBar.jsx')
  let stopped = 0
  const html = render(RecBarView, barProps(recorder('recording'), { onStop: () => { stopped++ } }))
  const stop = /<button([^>]*)>Stop and summarize<\/button>/.exec(html)
  assert.ok(stop, 'the stop button renders')
  assert.match(stop[1], /type="button"/)
  assert.match(stop[1], /class="button button--danger-confirm button--xs"/)
  assert.doesNotMatch(stop[1], /autofocus/i)
  assert.doesNotMatch(html, /autofocus/i)
  const tree = (await load('shell/RecBar.jsx')).RecBarView(barProps(recorder('recording'), { onStop: () => { stopped++ } }))
  const button = findAll(tree, node => node.type === 'button' && textOf(node) === 'Stop and summarize')[0]
  button.props.onClick()
  assert.equal(stopped, 1)
})

test('the shell pin action pins the recorder meeting once, not the meeting the route shows', async () => {
  const { pinFromKey } = await load('shell/App.jsx')
  const api = recordingApi()
  const state = { view: { path: '/meetings/m-old', overlay: null }, data: { recorder: recorder('recording') } }
  await pinFromKey(api, state)
  assert.deepEqual(api.calls, [['POST', '/api/meetings/m-live/pins']])
  const idle = recordingApi()
  await pinFromKey(idle, { view: { path: '/' }, data: { recorder: recorder('idle', { meetingId: null }) } })
  assert.deepEqual(idle.calls, [], 'no pin without a recording')
})

test('the shell renders the bar first inside .shell with shell--recording', async () => {
  const { App } = await load('shell/App.jsx')
  const { reduce, initialState } = await load('state/deck-store.js')
  const snapshot = rec => reduce(initialState(), {
    type: 'message', message: {
      t: 'snapshot', seq: 1, epoch: 'e1', data: {
        sessions: [], requests: [], runs: [], repos: [], counts: null, order: [], recap: null, ruleOffers: [], research: [],
        recorder: rec, health: [], prefs: { lang: 'en' }, setup: { firstRunCompletedAt: 1 }
      }
    }
  })
  const store = state => ({ subscribe: () => () => {}, getState: () => state, dispatch: () => {} })
  const on = render(App, { store: store(snapshot(recorder('recording'))), path: '/', navigate: () => {}, onRetry: () => {}, now: STARTED })
  assert.match(on, /^<div class="shell shell--recording"[^>]*><div class="rec-bar/, 'the bar is the first child of the shell')
  const off = render(App, { store: store(snapshot(recorder('idle'))), path: '/', navigate: () => {}, onRetry: () => {}, now: STARTED })
  assert.doesNotMatch(off, /shell--recording|rec-bar/)
})

test('the live meta reads the ASR model as "medium · int8", the language and the lag', async () => {
  const { liveMeta, asrLabel } = await load('screens/meetings/MeetingLive.jsx')
  assert.equal(asrLabel('medium-int8'), 'medium · int8')
  assert.equal(asrLabel('large-v3-float16'), 'large-v3 · float16')
  const lines = [line(10, 'a', { asrModel: 'medium-int8', lang: 'pt' }), line(20, 'b', { asrModel: 'medium-int8', lang: 'pt' })]
  // Newest t1 is 22 s; now is 23.2 s after the start, so the lag is 1.2 s.
  assert.equal(liveMeta({ lines, startedAt: STARTED, now: STARTED + 23_200 }), 'medium · int8 · PT-BR · ~1.2s behind')
  assert.equal(liveMeta({ lines: [], startedAt: STARTED, now: STARTED }), 'PT-BR', 'no model and no lag before the first line')
})

test('a line delivered by REST and again by the stream shows once', async () => {
  const { liveItems, MeetingLiveView } = await load('screens/meetings/MeetingLive.jsx')
  const rest = [line(1, 'um'), line(3, 'dois')]
  const live = { meetingId: 'm-live', lines: [line(3, 'dois'), line(5, 'três')], recovered: [{ at: 1, count: 2 }] }
  const items = liveItems(rest, live)
  assert.deepEqual(items.filter(item => item.kind === 'line').map(item => item.line.text), ['um', 'dois', 'três'])
  assert.deepEqual(items.map(item => item.kind), ['line', 'line', 'divider', 'line'], 'the recovered divider sits where the gap was filled')
  const html = render(MeetingLiveView, viewProps({ items }))
  assert.equal(html.match(/>dois</g).length, 1)
  assert.match(html, /Reconnected · 2 lines recovered/)
})

test('"Listening…" appears once 5 s pass without a new line', async () => {
  const { listening, MeetingLiveView } = await load('screens/meetings/MeetingLive.jsx')
  const at = STARTED + 60_000
  assert.equal(listening({ state: 'recording', lastLineAt: at, now: at + 4_999 }), false)
  assert.equal(listening({ state: 'recording', lastLineAt: at, now: at + 5_000 }), true)
  assert.equal(listening({ state: 'stopping', lastLineAt: at, now: at + 60_000 }), false, 'only while recording')
  assert.match(render(MeetingLiveView, viewProps({ listening: true })), /Listening…/)
  assert.doesNotMatch(render(MeetingLiveView, viewProps({ listening: false })), /Listening…/)
})

test('the ask eyebrow says it uses the transcript only and no citation renders', async () => {
  const { MeetingLiveView } = await load('screens/meetings/MeetingLive.jsx')
  const thread = [{ id: 'a1', question: 'quem liga o flag?', answer: 'Você liga na quarta.', state: 'done', error: null }]
  const html = render(MeetingLiveView, viewProps({ thread }))
  assert.match(html, /<p class="eyebrow">Ask · uses the transcript<\/p>/)
  assert.doesNotMatch(html, /your vault/)
  assert.doesNotMatch(html, /citation/i)
  assert.doesNotMatch(html, /Save answer to meeting note/)
  assert.match(html, /<p class="live-ask-answer" lang="pt-BR">Você liga na quarta\.<\/p>/)
  assert.match(html, /placeholder="Ask without leaving the call"/)
  assert.match(html, /<aside[^>]*aria-label="Ask during the meeting"/)
})

test('the auto-saved line shows for a stored tag and not for a confidential one', async () => {
  const { MeetingLiveView } = await load('screens/meetings/MeetingLive.jsx')
  const saved = 'Answers are added to the meeting note when it is summarized.'
  assert.ok(render(MeetingLiveView, viewProps({ recorder: recorder('recording', { tag: 'pessoal', confidential: false }) })).includes(saved))
  assert.ok(!render(MeetingLiveView, viewProps({ recorder: recorder('recording', { tag: 'client-a', confidential: true }) })).includes(saved))
})

test('AC13 under reduced motion the dot is static and Recording and the timer stay', async () => {
  const { RecBarView } = await load('shell/RecBar.jsx')
  const moving = render(RecBarView, barProps(recorder('recording')))
  assert.match(moving, /<span class="rec-bar-dot motion-rec-pulse" aria-hidden="true"><\/span>/)
  const still = render(RecBarView, barProps(recorder('recording'), { reduced: true }))
  assert.match(still, /<span class="rec-bar-dot" aria-hidden="true"><\/span>/)
  assert.doesNotMatch(still, /motion-rec-pulse/)
  assert.match(still, />Recording</)
  assert.match(still, />19:14</)
})

test('a line click pins its t0, and a click on a pinned line removes its pins', async () => {
  const { toggleLinePin, pinnedLines } = await load('screens/meetings/MeetingLive.jsx')
  const lines = [line(10), line(20), line(30)]
  const pins = [{ id: 'p1', t: 21, label: null }]
  assert.deepEqual([...pinnedLines(lines, pins)], ['20:22'], 'a pin marks the newest line at or before its time')
  const api = recordingApi()
  await toggleLinePin(api, 'm-live', lines[0], lines, pins)
  await toggleLinePin(api, 'm-live', lines[1], lines, pins)
  assert.deepEqual(api.calls, [['POST', '/api/meetings/m-live/pins', { t: 10 }], ['DELETE', '/api/meetings/m-live/pins/p1']])
})

test('live content renders literally in pt-BR nodes and the transcript is a quiet log', async () => {
  const { MeetingLiveView, liveItems } = await load('screens/meetings/MeetingLive.jsx')
  const items = liveItems([line(1, '<b>x</b>')], null)
  const html = render(MeetingLiveView, viewProps({ items, pins: [{ id: 'p', t: 1, label: '<i>y</i>' }], lost: true }))
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/)
  assert.doesNotMatch(html, /<b>|<i>/)
  assert.match(html, /role="log"[^>]*aria-live="off"/)
  assert.match(html, /<h1[^>]*>Live transcript<\/h1>/)
  assert.match(html, /Pins · 1/)
  assert.match(html, /<span class="live-pin-label" lang="pt-BR">&lt;i&gt;y&lt;\/i&gt;<\/span>/)
  assert.match(html, /Connection to scribed lost/)
  assert.match(html, /Read new lines aloud/)
  assert.match(render(MeetingLiveView, viewProps({ readAloud: true })), /role="log"[^>]*aria-live="polite"/)
  assert.match(render(MeetingLiveView, viewProps({ atBottom: false })), /Jump to live/)
  assert.doesNotMatch(render(MeetingLiveView, viewProps({ atBottom: true })), /Jump to live/)
})

test('the ask thread shows Asking with Stop, the stopped note and the error with Try again', async () => {
  const { MeetingLiveView } = await load('screens/meetings/MeetingLive.jsx')
  const asking = render(MeetingLiveView, viewProps({ thread: [{ id: 'a', question: 'q', answer: '', state: 'streaming', error: null }] }))
  assert.match(asking, /Asking…/)
  assert.match(asking, />Stop</)
  const stopped = render(MeetingLiveView, viewProps({ thread: [{ id: 'a', question: 'q', answer: 'parcial', state: 'stopped', error: null }] }))
  assert.match(stopped, /Stopped here; the answer may still be saved to the meeting/)
  const failed = render(MeetingLiveView, viewProps({ thread: [{ id: 'a', question: 'q', answer: '', state: 'error', error: 'sessão não encontrada' }] }))
  assert.match(failed, /The ask did not finish: <span lang="pt-BR">sessão não encontrada<\/span>\./)
  assert.match(failed, /Try again/)
  const done = render(MeetingLiveView, viewProps({ thread: [{ id: 'a', question: 'q', answer: 'r', state: 'done', error: null }] }))
  assert.match(done, />Copy</)
})

test('after Stop the composer stays disabled until the stopped ask ends, and ask_in_progress reads as still answering', async () => {
  const { askView, askFailure, MeetingLiveView } = await load('screens/meetings/MeetingLive.jsx')
  const record = { threadId: 'th1', question: 'quem liga?', text: 'Você liga na', state: 'streaming', error: null }
  const stopped = { th1: 'Você liga' }
  const waiting = askView({ history: [], earlier: [], record, stopped, local: null })
  assert.equal(waiting.current.state, 'stopped')
  assert.equal(waiting.busy, true, 'Stop does not reach the server, so the composer waits for the stopped answer to end')
  const html = render(MeetingLiveView, viewProps({ thread: waiting.thread, busy: waiting.busy }))
  assert.match(html, /Stopped here; the answer may still be saved to the meeting/)
  assert.match(html, /<input class="live-ask-input"[^>]*disabled=""/)
  const ended = askView({ history: [], earlier: [], record: { ...record, state: 'done', text: 'Você liga na quarta.' }, stopped, local: null })
  assert.equal(ended.busy, false, 'the ask.done of the stopped ask frees the composer')
  assert.equal(ended.thread[0].answer, 'Você liga', 'the stopped answer stays frozen')

  const local = askFailure('de novo?', Object.assign(new Error('ask_in_progress'), { status: 409, code: 'ask_in_progress' }), 'f1')
  assert.equal(local.state, 'waiting')
  const inProgress = askView({ history: [], earlier: [], record: null, stopped: {}, local })
  assert.equal(inProgress.busy, true)
  const busyHtml = render(MeetingLiveView, viewProps({ thread: inProgress.thread, busy: true }))
  assert.match(busyHtml, /Asking…/)
  assert.doesNotMatch(busyHtml, /did not finish/, 'a 409 ask_in_progress is not shown as a failed ask')
  assert.equal(askFailure('q', Object.assign(new Error('scribed_refused'), { code: 'scribed_refused', details: { text: 'sem sessão' } }), 'f2').error, 'sem sessão')
})

test('a failed ask or a retry never repeats the previous question and answer', async () => {
  const { askView, askFailure, MeetingLiveView } = await load('screens/meetings/MeetingLive.jsx')
  const record = { threadId: 'th1', question: 'primeira?', text: 'resposta', state: 'done', error: null }
  const { current } = askView({ history: [], earlier: [], record, stopped: {}, local: null })
  // Two asks failed in turn: each pushed the current ask into `earlier` before the POST was refused.
  const earlier = [current, current]
  const local = askFailure('segunda?', new Error('boom'), 'f2')
  const { thread } = askView({ history: [], earlier, record, stopped: {}, local })
  assert.deepEqual(thread.map(entry => entry.id), ['th1', 'f2'])
  const html = render(MeetingLiveView, viewProps({ thread }))
  assert.equal(html.match(/>primeira\?</g).length, 1)
})

test('a confidential meeting shows pin times without labels', async () => {
  const { MeetingLiveView } = await load('screens/meetings/MeetingLive.jsx')
  const pins = [{ id: 'p', t: 65, label: 'segredo do cliente' }]
  const secret = render(MeetingLiveView, viewProps({ pins, recorder: recorder('recording', { tag: 'client-a', confidential: true }) }))
  assert.match(secret, />01:05</)
  assert.doesNotMatch(secret, /segredo do cliente/)
  assert.doesNotMatch(secret, /live-pin-label/)
  const open = render(MeetingLiveView, viewProps({ pins, recorder: recorder('recording', { tag: 'pessoal', confidential: false }) }))
  assert.match(open, /<span class="live-pin-label" lang="pt-BR">segredo do cliente<\/span>/)
})

function viewProps(extra = {}) {
  return {
    t: undefined, recorder: recorder('recording', { tag: 'pessoal', confidential: false }), items: [], pins: [], meta: 'PT-BR',
    listening: false, lost: false, atBottom: true, readAloud: false, thread: [], draft: '', busy: false,
    onReadAloud: () => {}, onLineClick: () => {}, onJump: () => {}, onScroll: () => {}, onDraft: () => {}, onAsk: () => {},
    onStopAsk: () => {}, onRetry: () => {}, onCopy: () => {}, ...extra
  }
}

function findAll(node, match, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function') return findAll(node.type(node.props), match, out)
  if (match(node)) out.push(node)
  findAll(node.props?.children, match, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}
