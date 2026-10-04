import React, { useEffect, useRef, useState } from 'react'
import { translate } from '../../components/StatusPill.jsx'
import { TranscriptLine } from '../../components/TranscriptLine.jsx'
import { DegradedCard } from '../../components/DegradedCard.jsx'
import { fetchMeetings, searchMeetings, startMeeting, startScribed, retryScribed } from '../../state/actions.js'
import { MeetingDetail, clockTime, dayLabel, durationText, meetingTitle } from './MeetingDetail.jsx'

/**
 * English copy of the Meetings list and search (docs/deck/screens/meetings.md section 9, failures-and-loading.md
 * 4.5). A catalog that defines a key wins through `t`. `meetings.post.interrupted` is added by M4 Task 13.
 */
export const MEETINGS_COPY = Object.freeze({
  'meetings.title': 'Meetings',
  'meetings.record': 'Record',
  'meetings.recordingOpen': 'Recording · Open',
  'meetings.tag.confidential': 'transcript not stored',
  'meetings.tag.option': '{tag} · {note}',
  'meetings.tag.menuLabel': 'Record with tag',
  'meetings.starting': 'Starting…',
  'meetings.startSlow': 'scribed did not confirm the start. Checking…',
  'meetings.refused': 'scribed refused: {message}',
  'meetings.search.label': 'Search transcripts',
  'meetings.search.helper': '{hits, plural, one {# hit} other {# hits}} in {meetings, plural, one {# meeting} other {# meetings}}',
  'meetings.search.none': 'No hits for "{q}".',
  'meetings.row.meta.items': '{n, plural, one {# action item} other {# action items}}',
  'meetings.post.stopping': 'Saving the session…',
  'meetings.post.recorded': 'Transcribing with {model}…',
  'meetings.post.transcribed': 'Summarizing…',
  'meetings.post.names': 'Needs speaker names',
  'meetings.post.failed': 'Summary failed',
  'meetings.post.interrupted': 'Recording interrupted',
  'meetings.live.recording': 'Recording',
  'meetings.empty': 'No meetings yet. Press Record, or start one with scribe; it shows up here.',
  'meetings.noConfig': 'TurbidAssist is not configured for the deck: config.yaml not found at {path}.',
  'meetings.fixInSettings': 'Fix in Settings',
  'fail.meetings.area': 'Meetings tab',
  'fail.meetings.title': 'No one on the radio',
  'fail.meetings.body': 'scribed is not running: no socket at $XDG_RUNTIME_DIR/turbidassist.sock. Past meetings still load from the vault.',
  'fail.meetings.fix': 'Start scribed',
  'fail.retry': 'Retry',
  'meetings.toast.dismiss': 'Dismiss'
})

/** The search field's debounce, in ms (meetings.md section 6). */
export const SEARCH_DEBOUNCE_MS = 300
/** After this long in `starting`, Record says scribed did not confirm (meetings.md 5.2), in ms. */
export const START_SLOW_MS = 20_000

const text = (t, key, params) => translate(t, MEETINGS_COPY, key, params)

/**
 * The post-processing line that replaces a row's meta while the meeting is not synthesized (meetings.md 4.1), or
 * null. An interrupted recording and a waiting rename rank before the deck-derived `stuck` flag.
 * @param {{ state: string, stuck?: boolean, interrupted?: boolean }} meeting
 * @param {string | null} model the batch ASR model
 * @param {Function} [t]
 * @returns {string | null}
 */
export function postStateLine(meeting, model, t) {
  if (meeting?.interrupted) return text(t, 'meetings.post.interrupted')
  if (meeting?.state === 'awaiting_names') return text(t, 'meetings.post.names')
  if (meeting?.stuck) return text(t, 'meetings.post.failed')
  switch (meeting?.state) {
    case 'recording': return text(t, 'meetings.live.recording')
    case 'stopping': return text(t, 'meetings.post.stopping')
    case 'recorded': return text(t, 'meetings.post.recorded', { model: model ?? '' })
    case 'transcribed': return text(t, 'meetings.post.transcribed')
    default: return null
  }
}

/**
 * A synthesized row's meta: "{apps} · {duration} · {n} action items", leaving out what the meeting lacks.
 * @param {{ apps?: string[], startedAt?: number|null, endedAt?: number|null, actionItemCount?: number|null }} meeting
 * @param {Function} [t]
 * @returns {string}
 */
export function rowMeta(meeting, t) {
  const parts = []
  if (Array.isArray(meeting?.apps) && meeting.apps.length) parts.push(meeting.apps.join(', '))
  const duration = durationText(meeting, t)
  if (duration) parts.push(duration)
  if (Number.isFinite(meeting?.actionItemCount)) parts.push(text(t, 'meetings.row.meta.items', { n: meeting.actionItemCount }))
  return parts.join(' · ')
}

/**
 * Meetings newest first, grouped by local day ("Today", "Yesterday", weekday, then dates).
 * @param {object[]} meetings
 * @param {number} now
 * @param {Function} [t]
 * @returns {{ label: string, meetings: object[] }[]}
 */
export function groupMeetings(meetings, now, t) {
  const sorted = [...meetings].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || String(b.id).localeCompare(String(a.id)))
  const groups = []
  for (const meeting of sorted) {
    const label = dayLabel(meeting.startedAt, now, t)
    if (groups.at(-1)?.label === label) groups.at(-1).meetings.push(meeting)
    else groups.push({ label, meetings: [meeting] })
  }
  return groups
}

/**
 * The search helper: "{hits} hits in {meetings} meetings", or "No hits for "{q}"." without hits.
 * @param {{ hits: object[], meetingCount?: number }} result
 * @param {string} q
 * @param {Function} [t]
 * @returns {string}
 */
export function searchHelper(result, q, t) {
  const hits = result?.hits ?? []
  if (!hits.length) return text(t, 'meetings.search.none', { q })
  const meetings = Number.isFinite(result.meetingCount) ? result.meetingCount : new Set(hits.map(hit => hit.meetingId)).size
  return text(t, 'meetings.search.helper', { hits: hits.length, meetings })
}

/**
 * The hits of one meeting.
 * @param {{ hits: object[] } | null} result
 * @param {string} id
 * @returns {object[]}
 */
export function hitsFor(result, id) {
  return (result?.hits ?? []).filter(hit => hit.meetingId === id)
}

/**
 * The tag menu's options in config order with the default preselected; a confidential tag says
 * "{tag} · transcript not stored".
 * @param {{ tag: string, confidential: boolean, isDefault: boolean }[]} tags
 * @param {Function} [t]
 * @returns {{ tag: string, label: string, selected: boolean }[]}
 */
export function tagOptions(tags, t) {
  const list = Array.isArray(tags) ? tags : []
  const preselected = list.find(item => item.isDefault)?.tag ?? list[0]?.tag
  return list.map(item => ({
    tag: item.tag,
    label: item.confidential ? text(t, 'meetings.tag.option', { tag: item.tag, note: text(t, 'meetings.tag.confidential') }) : item.tag,
    selected: item.tag === preselected
  }))
}

/**
 * Start a recording with a tag: `startMeeting`, then `/meetings/live` when scribed answered `recording`
 * (`onStarting` when the server is still waiting for the poll); a refusal shows "scribed refused: {message}"
 * with scribed's message verbatim.
 * A 202 whose recorder is neither `recording` nor `starting` (the server gave up waiting and the recorder is idle)
 * calls `onUnconfirmed`, so Record is usable again and says scribed did not confirm.
 * @param {{ api: object, navigate: (to: string) => void, show: (toast: { message: string, pt: boolean } | null) => void, onStarting?: () => void, onUnconfirmed?: () => void, onFailed?: () => void }} options
 * @returns {(tag: string) => Promise<void>}
 */
export function startWithTag({ api, navigate, show, onStarting = () => {}, onUnconfirmed = () => {}, onFailed = () => {} }) {
  return async tag => {
    show(null)
    try {
      const body = await startMeeting(api, tag)
      const state = body?.recorder?.state
      if (state === 'recording') navigate('/meetings/live')
      else if (state === 'starting') onStarting()
      else onUnconfirmed()
    } catch (error) {
      onFailed()
      if (error?.code === 'scribed_refused') show({ message: String(error.details?.text ?? error.message ?? ''), pt: true })
      else show({ message: String(error?.message ?? error?.code ?? 'failed'), pt: false })
    }
  }
}

/**
 * What Record shows for a start (meetings.md 5.2). `start` is the screen's own start: `pending` while the POST is in
 * flight, `polling` after a 202 `starting`, `unconfirmed` after a 202 that did not start, each with the clock time
 * `at` it began. Record is busy ("Starting…") while the start is pending or polling, or while the recorder is
 * `starting` for another client; after {@link START_SLOW_MS} by `now`, or once unconfirmed, it is usable again and
 * says scribed did not confirm. A recording clears both.
 * @param {{ start: { phase: 'pending'|'polling'|'unconfirmed', at: number } | null, recorder: { state: string, since?: number | null }, now: number }} input
 * @returns {{ busy: boolean, slow: boolean }}
 */
export function startView({ start, recorder, now }) {
  if (recorder?.state === 'recording') return { busy: false, slow: false }
  if (start?.phase === 'unconfirmed') return { busy: false, slow: true }
  if (start) return now - start.at >= START_SLOW_MS ? { busy: false, slow: true } : { busy: true, slow: false }
  if (recorder?.state !== 'starting') return { busy: false, slow: false }
  const slow = Number.isFinite(recorder.since) && now - recorder.since >= START_SLOW_MS
  return { busy: true, slow }
}

/**
 * The tag menu, a listbox of the config tags; Enter or a click starts with that tag, Escape closes.
 * @param {{ options: { tag: string, label: string, selected: boolean }[], t?: Function, onPick: (tag: string) => void, onClose?: () => void }} props
 */
export function TagMenu({ options, t, onPick, onClose }) {
  const onKeyDown = event => {
    const items = [...(event.currentTarget?.querySelectorAll?.('[role="option"]') ?? [])]
    const at = items.indexOf(event.target)
    if (event.key === 'Escape') { event.preventDefault()
      onClose?.() } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const tag = event.target?.dataset?.tag
      if (tag) onPick(tag)
    }
  }
  return (
    <ul className="meetings-tag-menu" role="listbox" aria-label={text(t, 'meetings.tag.menuLabel')} onKeyDown={onKeyDown}>
      {options.map(option => (
        <li key={option.tag} role="option" aria-selected={option.selected} tabIndex={option.selected ? 0 : -1} data-tag={option.tag}
          className={option.selected ? 'meetings-tag meetings-tag--selected' : 'meetings-tag'} onClick={() => onPick(option.tag)}>{option.label}</li>
      ))}
    </ul>
  )
}

function Row({ meeting, model, selected, hit, t, onOpen }) {
  const post = postStateLine(meeting, model, t)
  const href = `/meetings/${encodeURIComponent(meeting.id)}`
  return (
    <li>
      <a className={selected ? 'meetings-row meetings-row--selected' : 'meetings-row'} href={href} aria-current={selected ? 'page' : undefined}
        onClick={event => { event.preventDefault()
          onOpen?.(meeting.id) }}>
        <span className="meetings-row-head">
          <span className="meetings-row-title" lang="pt-BR">{meetingTitle(meeting, t)}</span>
          <span className="meetings-row-time">{clockTime(meeting.startedAt)}</span>
        </span>
        <span className={post ? 'meetings-row-meta meetings-row-meta--post' : 'meetings-row-meta'}>{post ?? rowMeta(meeting, t)}</span>
      </a>
      {hit ? <TranscriptLine line={hit} ranges={hit.ranges} /> : null}
    </li>
  )
}

/**
 * The Meetings list aside without its data wiring (meetings.md 3.1, 4.1, 5.1): h1, the Record area (Record and the
 * tag menu, "Recording · Open", the scribed degraded card or the config notice), the search field and helper, the
 * refusal toast, then the day groups, five skeleton rows while loading, or the empty text. With a search result only
 * meetings with hits are listed, each with its first hit. `starting` and `startSlow` are {@link startView}'s `busy`
 * and `slow`. Pure, so tests can render it and call its handlers.
 * @param {object} props
 */
export function MeetingsListView({ meetings = null, selectedId = null, recorder = { state: 'idle' }, tags = [], configError = null, model = null,
  q = '', result = null, menuOpen = false, starting = false, startSlow = false, toast = null, now, t,
  onRecord, onPick, onCloseMenu, onQuery, onOpen, onOpenLive, onFixConfig, onStartScribed, onRetryScribed, onDismissToast }) {
  const state = recorder?.state ?? 'idle'
  let record
  if (state === 'unavailable') {
    record = <DegradedCard area={text(t, 'fail.meetings.area')} title={text(t, 'fail.meetings.title')} body={text(t, 'fail.meetings.body')}
      fixLabel={text(t, 'fail.meetings.fix')} onFix={onStartScribed} retryLabel={text(t, 'fail.retry')} onRetry={onRetryScribed} />
  } else if (state === 'recording') {
    record = <a className="meetings-recording-link" href="/meetings/live" onClick={event => { event.preventDefault()
      onOpenLive?.() }}><span className="meetings-rec-dot meetings-rec-dot--on" aria-hidden="true" />{text(t, 'meetings.recordingOpen')}</a>
  } else {
    const busy = starting
    record = (
      <div className="meetings-record-area">
        <button type="button" className="button button--secondary button--sm meetings-record" aria-haspopup="listbox" aria-expanded={menuOpen}
          aria-busy={busy || undefined} disabled={!!configError || state === 'stopping' || busy} onClick={onRecord}>
          <span className="meetings-rec-dot" aria-hidden="true" />{busy ? text(t, 'meetings.starting') : text(t, 'meetings.record')}
        </button>
        {startSlow ? <p className="meeting-muted" role="status">{text(t, 'meetings.startSlow')}</p> : null}
        {menuOpen && !configError ? <TagMenu options={tagOptions(tags, t)} t={t} onPick={onPick} onClose={onCloseMenu} /> : null}
      </div>
    )
  }
  const searching = q.trim().length >= 2 && result
  const shown = meetings && searching ? meetings.filter(meeting => hitsFor(result, meeting.id).length) : meetings
  return (
    <aside className="meetings-list" aria-label={text(t, 'meetings.title')}>
      <header className="meetings-list-header">
        <h1 className="meetings-list-title">{text(t, 'meetings.title')}</h1>
        {record}
      </header>
      {configError ? (
        <div className="meeting-banner meeting-banner--error" role="alert">
          <p className="meeting-banner-text">{text(t, 'meetings.noConfig', { path: configError.path ?? '' })}</p>
          <button type="button" className="button button--secondary button--xs" onClick={onFixConfig}>{text(t, 'meetings.fixInSettings')}</button>
        </div>
      ) : null}
      {toast ? (
        <div className="archive-toast archive-toast--error" role="alert">
          <p className="archive-toast-text">{toast.pt ? text(t, 'meetings.refused', { message: '' }) : null}<span lang={toast.pt ? 'pt-BR' : undefined}>{toast.message}</span></p>
          <button type="button" className="button button--ghost button--xs" onClick={onDismissToast}>{text(t, 'meetings.toast.dismiss')}</button>
        </div>
      ) : null}
      <div className="meetings-search">
        <label className="sr-only" htmlFor="meetings-search">{text(t, 'meetings.search.label')}</label>
        <input id="meetings-search" className="text-input meetings-search-input" type="search" placeholder={text(t, 'meetings.search.label')}
          value={q} onChange={event => onQuery?.(event.target.value)} />
        {searching ? <p className="meetings-search-helper" role="status">{searchHelper(result, q, t)}</p> : null}
      </div>
      {shown === null ? (
        <ul className="meetings-groups" aria-busy="true">{[0, 1, 2, 3, 4].map(index => <li key={index} className="meeting-skeleton meeting-skeleton--row motion-shimmer" aria-hidden="true" />)}</ul>
      ) : !meetings.length ? <p className="meeting-muted meetings-empty">{text(t, 'meetings.empty')}</p> : (
        <div className="meetings-groups">
          {groupMeetings(shown, now, t).map(group => (
            <section key={group.label} className="meetings-group" aria-label={group.label}>
              <h2 className="eyebrow">{group.label}</h2>
              <ul className="meetings-rows">
                {group.meetings.map(meeting => <Row key={meeting.id} meeting={meeting} model={meeting.model ?? model} selected={meeting.id === selectedId}
                  hit={searching ? hitsFor(result, meeting.id)[0] : null} t={t} onOpen={onOpen} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  )
}

// List rows merged with the store's meeting.updated rows, keeping REST titles; store rows the list lacks are added.
function mergeRows(list, live) {
  const known = new Map((list ?? []).map(row => [row.id, row]))
  for (const [id, row] of Object.entries(live ?? {})) {
    const base = known.get(id)
    known.set(id, base ? { ...base, ...row, title: row.title ?? base.title ?? null } : row)
  }
  return [...known.values()]
}

const queryOf = search => {
  try {
    return new URLSearchParams(String(search ?? '')).get('q') ?? ''
  } catch {
    return ''
  }
}

/**
 * The Meetings screen (`/meetings`, `/meetings/:id`, `?q=`): the list aside and the selected meeting's detail.
 * Reads `GET /api/meetings` once per mount (dispatching `meetings.fetched` when `dispatch` is given), merges the
 * store's `meeting.updated` rows, searches 300 ms after typing, starts recordings from the tag menu, and selects the
 * newest meeting on `/meetings`. `initial` seeds the reads (`{ list, result }`) for rendering without a server.
 * @param {{ route: { name: string, params: object }, search?: string, state: object, t?: Function, navigate: (to: string) => void, api: object,
 *   now?: number, clock?: () => number, dispatch?: Function, initial?: { list?: object, result?: object, detail?: object }, onStartScribed?: Function,
 *   onRetryScribed?: Function }} props `clock` times the start wait of {@link startView} (default `Date.now`).
 */
export function Meetings({ route, search = '', state, t, navigate, api, now = Date.now(), clock = Date.now, dispatch, initial, onStartScribed, onRetryScribed }) {
  const [list, setList] = useState(initial?.list ?? null)
  const [q, setQ] = useState(() => queryOf(search))
  const [result, setResult] = useState(initial?.result ?? null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [start, setStart] = useState(null)
  const [toast, setToast] = useState(null)
  const [, setTick] = useState(0)
  const debounce = useRef(null)
  useEffect(() => {
    if (initial?.list) return undefined
    let current = true
    fetchMeetings(api).then(body => {
      if (!current) return
      setList(body)
      dispatch?.({ type: 'meetings.fetched', meetings: body?.meetings ?? [] })
    }).catch(() => { if (current) setList({ meetings: [], tags: [], configError: null }) })
    return () => { current = false }
  }, [api])
  useEffect(() => {
    if (initial?.result && q === queryOf(search)) return undefined
    clearTimeout(debounce.current)
    if (q.trim().length < 2) { setResult(null)
      return undefined }
    let current = true
    debounce.current = setTimeout(() => {
      searchMeetings(api, q.trim()).then(body => { if (current) setResult(body) }).catch(() => { if (current) setResult({ hits: [], meetingCount: 0 }) })
    }, SEARCH_DEBOUNCE_MS)
    return () => { current = false
      clearTimeout(debounce.current) }
  }, [api, q])
  const recorder = state?.data?.recorder ?? list?.recorder ?? { state: 'idle' }
  const recordingNow = recorder.state === 'recording'
  useEffect(() => {
    if (start && start.phase !== 'unconfirmed' && recordingNow) navigate('/meetings/live')
    if (start && recordingNow) setStart(null)
  }, [start, recordingNow])
  const startedAt = start && start.phase !== 'unconfirmed' ? start.at : recorder.state === 'starting' && Number.isFinite(recorder.since) ? recorder.since : null
  useEffect(() => {
    if (startedAt === null) return undefined
    const timer = setTimeout(() => setTick(n => n + 1), Math.max(0, startedAt + START_SLOW_MS - clock()) + 10)
    return () => clearTimeout(timer)
  }, [startedAt])
  const view = startView({ start, recorder, now: clock() })
  const meetings = list ? mergeRows(list.meetings, state?.data?.meetings) : null
  const newest = meetings ? groupMeetings(meetings, now, t)[0]?.meetings[0]?.id ?? null : null
  const selectedId = route?.name === 'meeting' ? route.params?.id ?? null : newest
  const selected = meetings?.find(meeting => meeting.id === selectedId) ?? null
  const pick = startWithTag({ api, navigate, show: setToast, onStarting: () => setStart(current => current && { ...current, phase: 'polling' }),
    onUnconfirmed: () => setStart(current => current && { ...current, phase: 'unconfirmed' }), onFailed: () => setStart(null) })
  const onPick = tag => {
    setMenuOpen(false)
    setStart({ phase: 'pending', at: clock() })
    pick(tag)
  }
  const withQ = q.trim().length >= 2 ? `?q=${encodeURIComponent(q.trim())}` : ''
  return (
    <div className="meetings-screen">
      <MeetingsListView meetings={meetings} selectedId={selectedId} recorder={recorder} tags={list?.tags ?? []} configError={list?.configError ?? null}
        model={list?.model ?? null} q={q} result={result} menuOpen={menuOpen} starting={view.busy}
        startSlow={view.slow} toast={toast} now={now} t={t}
        onRecord={() => setMenuOpen(open => !open)} onPick={onPick} onCloseMenu={() => setMenuOpen(false)} onQuery={setQ}
        onOpen={id => navigate(`/meetings/${encodeURIComponent(id)}${withQ}`)} onOpenLive={() => navigate('/meetings/live')}
        onFixConfig={() => navigate('/settings/connections')} onDismissToast={() => setToast(null)}
        onStartScribed={() => { (onStartScribed ?? (() => startScribed(api)))()?.catch?.(() => {}) }}
        onRetryScribed={() => { (onRetryScribed ?? (() => retryScribed(api)))()?.catch?.(() => {}) }} />
      <main className="meetings-detail-pane">
        {selectedId ? <MeetingDetail key={selectedId} id={selectedId} api={api} t={t} navigate={navigate} now={now} q={result ? q.trim() : ''}
          hits={hitsFor(result, selectedId)} listItem={selected} detail={initial?.detail} /> : null}
      </main>
    </div>
  )
}
