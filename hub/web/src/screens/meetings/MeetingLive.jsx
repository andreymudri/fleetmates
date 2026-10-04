import React, { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '../../components/StatusPill.jsx'
import { TranscriptLine, formatOffset } from '../../components/TranscriptLine.jsx'
import { askMeeting, fetchMeeting, fetchMeetingTranscript, pinMoment, unpinMoment } from '../../state/actions.js'

/** The live view copy (screens/meetings.md section 9), plus the ask Stop strings this plan quotes (Task 14). */
export const LIVE_COPY = Object.freeze({
  'meetings.live.heading': 'Live transcript',
  'meetings.live.meta.lag': '~{seconds}s behind',
  'meetings.live.listening': 'Listening…',
  'meetings.live.lost': 'Connection to scribed lost',
  'meetings.live.recovered': 'Reconnected · {n, plural, one {# line recovered} other {# lines recovered}}',
  'meetings.live.jump': 'Jump to live',
  'meetings.live.readAloud': 'Read new lines aloud',
  'meetings.ask.eyebrow.transcript': 'Ask · uses the transcript',
  'meetings.ask.placeholder': 'Ask without leaving the call',
  'meetings.ask.label': 'Ask during the meeting',
  'meetings.ask.asking': 'Asking…',
  'meetings.ask.stop': 'Stop',
  'meetings.ask.stopped': 'Stopped here; the answer may still be saved to the meeting',
  'meetings.ask.error': 'The ask did not finish: {message}.',
  'meetings.ask.retry': 'Try again',
  'meetings.ask.copy': 'Copy',
  'meetings.ask.autoSaved': 'Answers are added to the meeting note when it is summarized.',
  'meetings.pins.title': 'Pins · {n}'
})

/** How long without a new line before "Listening…" shows (MEET-O5). */
export const LISTENING_AFTER_MS = 5000

const lineKey = line => `${line?.t0}:${line?.t1}`

/**
 * An ASR model id as the meta shows it: the compute type after the last `-` ("medium-int8" gives "medium · int8").
 * @param {unknown} model
 * @returns {string}
 */
export function asrLabel(model) {
  const text = typeof model === 'string' ? model : ''
  const cut = text.lastIndexOf('-')
  return cut > 0 && cut < text.length - 1 ? `${text.slice(0, cut)} · ${text.slice(cut + 1)}` : text
}

// The configured transcript language of scribed ("pt") as the meta label; PT-BR when unknown.
function langLabel(lang) {
  if (typeof lang !== 'string' || !lang || /^pt(-br)?$/i.test(lang)) return 'PT-BR'
  return lang.toUpperCase()
}

/**
 * The transcript meta "{model} · PT-BR · ~{seconds}s behind": the newest line's ASR model and language, and the lag
 * now minus (meeting start plus the newest `t1`), one decimal. Model and lag are left out until a line carries them.
 * @param {{ lines: object[], startedAt: number | null | undefined, now: number, t?: Function }} input
 * @returns {string}
 */
export function liveMeta({ lines, startedAt, now, t }) {
  const newest = lines.at(-1)
  const model = [...lines].reverse().find(line => typeof line?.asrModel === 'string')?.asrModel
  const parts = []
  if (model) parts.push(asrLabel(model))
  parts.push(langLabel([...lines].reverse().find(line => typeof line?.lang === 'string')?.lang))
  if (newest && Number.isFinite(startedAt) && Number.isFinite(newest.t1)) {
    const seconds = Math.max(0, (now - (startedAt + newest.t1 * 1000)) / 1000)
    parts.push(translate(t, LIVE_COPY, 'meetings.live.meta.lag', { seconds: seconds.toFixed(1) }))
  }
  return parts.join(' · ')
}

/**
 * The rows of the live transcript: the REST lines the stream does not also carry, then the stream's lines with
 * their "lines recovered" dividers where each gap was filled. A line is the same line when `t0` and `t1` match.
 * @param {object[] | null | undefined} rest lines from `GET /api/meetings/:id/transcript`
 * @param {{ lines: object[], recovered: { at: number, count: number }[] } | null | undefined} live `data.live`
 * @returns {({ kind: 'line', key: string, line: object } | { kind: 'divider', key: string, count: number })[]}
 */
export function liveItems(rest, live) {
  const streamed = Array.isArray(live?.lines) ? live.lines : []
  const seen = new Set(streamed.map(lineKey))
  const items = []
  const restSeen = new Set()
  for (const line of Array.isArray(rest) ? rest : []) {
    const key = lineKey(line)
    if (seen.has(key) || restSeen.has(key)) continue
    restSeen.add(key)
    items.push({ kind: 'line', key, line })
  }
  items.sort((a, b) => a.line.t0 - b.line.t0)
  const dividers = Array.isArray(live?.recovered) ? live.recovered : []
  const lineSeen = new Set()
  streamed.forEach((line, index) => {
    dividers.forEach((divider, n) => { if (divider.at === index) items.push({ kind: 'divider', key: `d${n}`, count: divider.count }) })
    const key = lineKey(line)
    if (lineSeen.has(key)) return
    lineSeen.add(key)
    items.push({ kind: 'line', key, line })
  })
  dividers.forEach((divider, n) => { if (divider.at >= streamed.length) items.push({ kind: 'divider', key: `d${n}`, count: divider.count }) })
  return items
}

/**
 * Whether "Listening…" shows: recording, and no new line for 5 s.
 * @param {{ state?: string, lastLineAt: number, now: number }} input
 * @returns {boolean}
 */
export function listening({ state, lastLineAt, now }) {
  return state === 'recording' && now - lastLineAt >= LISTENING_AFTER_MS
}

/**
 * The lines the pins mark, as `t0:t1` keys: each pin marks the newest line that starts at or before its time.
 * @param {object[]} lines in transcript order
 * @param {{ t?: number }[]} pins
 * @returns {Set<string>}
 */
export function pinnedLines(lines, pins) {
  const marked = new Set()
  for (const pin of pins) {
    const line = lineFor(lines, pin)
    if (line) marked.add(lineKey(line))
  }
  return marked
}

function lineFor(lines, pin) {
  let found = null
  for (const line of lines) if (Number(line.t0) <= Number(pin.t)) found = line
  return found
}

/**
 * A transcript line click: pins the line at its `t0`, or removes the pins that mark it when it is pinned.
 * @param {{ post: Function, del: Function }} api
 * @param {string} meetingId
 * @param {object} line
 * @param {object[]} lines every line shown, in order
 * @param {{ id: string, t: number }[]} pins
 * @returns {Promise<unknown>}
 */
export function toggleLinePin(api, meetingId, line, lines, pins) {
  const key = lineKey(line)
  const marking = pins.filter(pin => { const at = lineFor(lines, pin)
    return at && lineKey(at) === key })
  if (marking.length) return Promise.all(marking.map(pin => unpinMoment(api, meetingId, pin.id)))
  return pinMoment(api, meetingId, { t: line.t0 })
}

function AskEntry({ entry, say, onStop, onRetry, onCopy }) {
  return (
    <li className="live-ask-entry">
      <p className="live-ask-question" lang="pt-BR">{entry.question}</p>
      {entry.answer ? <p className="live-ask-answer" lang="pt-BR">{entry.answer}</p> : null}
      {entry.state === 'streaming'
        ? (
          <p className="live-ask-status">
            <span>{say('meetings.ask.asking')}</span>
            <button type="button" className="button button--ghost button--xs" onClick={() => onStop(entry)}>{say('meetings.ask.stop')}</button>
          </p>
          )
        : null}
      {entry.state === 'stopped' ? <p className="live-ask-note">{say('meetings.ask.stopped')}</p> : null}
      {entry.state === 'error'
        ? (
          <p className="live-ask-error" role="alert">
            {splitMessage(say('meetings.ask.error', { message: '\u0000' }), entry.error)}
            <button type="button" className="button button--ghost button--xs" onClick={() => onRetry(entry)}>{say('meetings.ask.retry')}</button>
          </p>
          )
        : null}
      {entry.state === 'done' && entry.answer
        ? <button type="button" className="button button--ghost button--xs" onClick={() => onCopy(entry)}>{say('meetings.ask.copy')}</button>
        : null}
    </li>
  )
}

// The error sentence with scribed's message (Portuguese, verbatim) in its own pt-BR node.
function splitMessage(sentence, message) {
  const [before, after = ''] = sentence.split('\u0000')
  return <>{before}<span lang="pt-BR">{String(message ?? '')}</span>{after}</>
}

/**
 * The live view without state (screens/meetings.md 3.2, 4.3, 5.2): the transcript section (`role="log"`, quiet
 * unless "Read new lines aloud" is on) with its meta, lines, recovered dividers, "Listening…", the lost banner and
 * "Jump to live"; the ask aside (transcript-only eyebrow, no citations, no Save button, the auto-saved line for a
 * stored tag), the composer and the Pins list. Meeting content renders as text in `lang="pt-BR"` nodes.
 * @param {object} props
 */
export function MeetingLiveView({
  t, recorder, items, pins, meta, listening: showListening, lost, atBottom, readAloud, thread, draft, busy, logRef,
  onReadAloud, onLineClick, onJump, onScroll, onDraft, onAsk, onStopAsk, onRetry, onCopy
}) {
  const say = (key, params) => translate(t, LIVE_COPY, key, params)
  const lines = items.filter(item => item.kind === 'line').map(item => item.line)
  const marked = pinnedLines(lines, pins)
  return (
    <div className="meeting-live">
      <section className="live-transcript" aria-label={say('meetings.live.heading')}>
        <header className="live-transcript-head">
          <h1 className="page-title">{say('meetings.live.heading')}</h1>
          <p className="live-meta">{meta}</p>
          <label className="live-read-aloud">
            <input type="checkbox" checked={readAloud} onChange={event => onReadAloud(event.target.checked)} />
            {say('meetings.live.readAloud')}
          </label>
        </header>
        {lost ? <p className="live-lost" role="alert">{say('meetings.live.lost')}</p> : null}
        <div className="live-log" role="log" aria-live={readAloud ? 'polite' : 'off'} ref={logRef} onScroll={onScroll}>
          {items.map(item => item.kind === 'divider'
            ? <p key={item.key} className="live-divider">{say('meetings.live.recovered', { n: item.count })}</p>
            : <TranscriptLine key={item.key} line={item.line} live pinned={marked.has(item.key)} onClick={() => onLineClick(item.line)} />)}
          {showListening ? <p className="live-listening">{say('meetings.live.listening')}</p> : null}
        </div>
        {atBottom ? null : <button type="button" className="button button--secondary button--xs live-jump" onClick={onJump}>{say('meetings.live.jump')}</button>}
      </section>
      <aside className="live-ask" aria-label={say('meetings.ask.label')}>
        <p className="eyebrow">{say('meetings.ask.eyebrow.transcript')}</p>
        <ol className="live-ask-thread">
          {thread.map(entry => <AskEntry key={entry.id} entry={entry} say={say} onStop={onStopAsk} onRetry={onRetry} onCopy={onCopy} />)}
        </ol>
        {recorder?.confidential ? null : <p className="live-ask-saved">{say('meetings.ask.autoSaved')}</p>}
        <form className="live-ask-composer" onSubmit={event => { event.preventDefault()
          onAsk(draft) }}>
          <input className="live-ask-input" type="text" lang="pt-BR" value={draft} disabled={busy} aria-label={say('meetings.ask.label')}
            placeholder={say('meetings.ask.placeholder')} onChange={event => onDraft(event.target.value)} />
        </form>
        <section className="live-pins" aria-label={say('meetings.pins.title', { n: pins.length })}>
          <p className="eyebrow">{say('meetings.pins.title', { n: pins.length })}</p>
          <ol className="live-pin-list">
            {pins.map(pin => (
              <li key={pin.id} className="live-pin">
                <span className="live-pin-time">{formatOffset(pin.t)}</span>
                {pin.label ? <span className="live-pin-label" lang="pt-BR">{pin.label}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </div>
  )
}

// One store ask record as a thread entry; a locally stopped record keeps the text it had when stopped.
function entryOf(record, stopped) {
  if (!record) return null
  const frozen = stopped[record.threadId]
  const error = record.error ? String(record.error.details?.text ?? record.error.message ?? '') : null
  return {
    id: record.threadId, question: record.question ?? '', answer: frozen ?? record.text ?? '',
    state: frozen !== undefined ? 'stopped' : record.state, error
  }
}

function mergePins(rest, removed, stored) {
  const byId = new Map()
  for (const pin of rest) if (!removed.has(pin.id)) byId.set(pin.id, pin)
  for (const pin of stored) byId.set(pin.id, pin)
  return [...byId.values()].sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
}

/**
 * The live view of the meeting being recorded (`/meetings/live`): loads the transcript so far, the deck pins and
 * any ask history scribed returned with the meeting (`asks` on `GET /api/meetings/:id`, when present), then follows
 * `data.live`, `data.meetingPins` and `data.meetingAsk` from the store.
 * @param {{ state: Record<string, any>, t?: Function, api: object, dispatch?: Function, now?: () => number, clipboard?: { writeText: (text: string) => Promise<void> } }} props
 */
export function MeetingLive({ state, t, api, dispatch, now = Date.now, clipboard }) {
  const recorder = state.data.recorder ?? {}
  const meetingId = recorder.meetingId ?? null
  const [rest, setRest] = useState([])
  const [restPins, setRestPins] = useState([])
  const [removed, setRemoved] = useState(() => new Set())
  const [history, setHistory] = useState([])
  const [earlier, setEarlier] = useState([])
  const [stopped, setStopped] = useState({})
  const [failed, setFailed] = useState(null)
  const [draft, setDraft] = useState('')
  const [readAloud, setReadAloud] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [tick, setTick] = useState(() => now())
  const lastLine = useRef({ count: 0, at: now() })
  const logRef = useRef(null)

  useEffect(() => {
    if (!meetingId || !api) return undefined
    let live = true
    fetchMeetingTranscript(api, meetingId).then(body => { if (live) setRest(Array.isArray(body?.lines) ? body.lines : []) }).catch(() => {})
    fetchMeeting(api, meetingId).then(body => {
      if (!live) return
      setRestPins(Array.isArray(body?.pins) ? body.pins : [])
      const asks = Array.isArray(body?.asks) ? body.asks : []
      setHistory(asks.map((ask, index) => ({ id: `h${index}`, question: String(ask?.question ?? ''), answer: String(ask?.answer ?? ''), state: 'done', error: null })))
    }).catch(() => {})
    return () => { live = false }
  }, [api, meetingId])

  useEffect(() => {
    const interval = window.setInterval(() => setTick(now()), 1000)
    return () => window.clearInterval(interval)
  }, [now])

  const items = liveItems(rest, state.data.live?.meetingId === meetingId ? state.data.live : null)
  const lines = items.filter(item => item.kind === 'line').map(item => item.line)
  if (lines.length !== lastLine.current.count) lastLine.current = { count: lines.length, at: now() }

  useEffect(() => {
    const node = logRef.current
    if (node && atBottom) node.scrollTop = node.scrollHeight
  }, [lines.length, atBottom])

  const onScroll = useCallback(event => {
    const node = event.currentTarget
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 8)
  }, [])
  const onJump = useCallback(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
    setAtBottom(true)
  }, [])

  const stored = meetingId ? state.data.meetingPins?.[meetingId] ?? [] : []
  const pins = mergePins(restPins, removed, stored)
  const onLineClick = line => {
    if (!meetingId) return
    const unpinning = pins.filter(pin => { const at = lineFor(lines, pin)
      return at && lineKey(at) === lineKey(line) }).map(pin => pin.id)
    toggleLinePin(api, meetingId, line, lines, pins).then(() => {
      if (unpinning.length) setRemoved(previous => new Set([...previous, ...unpinning]))
    }).catch(error => dispatch?.({ type: 'toast.push', tone: 'error', title: String(error?.message ?? error) }))
  }

  const record = meetingId ? state.data.meetingAsk?.[meetingId] : null
  const current = entryOf(record, stopped)
  const thread = [...history, ...earlier, ...(current ? [current] : []), ...(failed ? [failed] : [])]
  const busy = current?.state === 'streaming'
  const ask = text => {
    const question = String(text ?? '').trim()
    if (!question || !meetingId || busy) return
    if (current) setEarlier(previous => [...previous, current])
    setFailed(null)
    setDraft('')
    askMeeting(api, meetingId, question).then(answer => dispatch?.({ type: 'meeting.ask', ...answer })).catch(error => {
      setFailed({ id: `f${Date.now()}`, question, answer: '', state: 'error', error: String(error?.details?.text ?? error?.message ?? error) })
    })
  }

  return (
    <MeetingLiveView t={t} recorder={recorder} items={items} pins={pins}
      meta={liveMeta({ lines, startedAt: recorder.startedAt, now: tick, t })}
      listening={listening({ state: recorder.state, lastLineAt: lastLine.current.at, now: tick })}
      lost={!!recorder.lost} atBottom={atBottom} readAloud={readAloud} thread={thread} draft={draft} busy={busy} logRef={logRef}
      onReadAloud={setReadAloud} onLineClick={onLineClick} onJump={onJump} onScroll={onScroll} onDraft={setDraft} onAsk={ask}
      onStopAsk={entry => setStopped(previous => ({ ...previous, [entry.id]: entry.answer }))}
      onRetry={entry => ask(entry.question)}
      onCopy={entry => { (clipboard ?? globalThis.navigator?.clipboard)?.writeText(entry.answer)?.catch?.(() => {}) }} />
  )
}
