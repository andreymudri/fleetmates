import React, { useEffect, useRef, useState } from 'react'
import { translate } from '../../components/StatusPill.jsx'
import { TranscriptLine, formatOffset } from '../../components/TranscriptLine.jsx'
import { ArchiveToast, useArchiveToast } from '../../components/SessionCard.jsx'
import { renderMarkdown } from '../team-run/PlanDrawer.jsx'
import { trapTab } from '../drawer/NeedsYouDrawer.jsx'
import { fetchMeeting, fetchMeetingTranscript, fetchMeetingLog, dismissItem, undismissItem } from '../../state/actions.js'

/**
 * English copy of the meeting detail (docs/deck/screens/meetings.md section 9). A catalog that defines a key
 * wins through `t`. `meetings.drawer.close` and `meetings.duration` are added by this screen (M4 Task 13).
 */
export const MEETING_DETAIL_COPY = Object.freeze({
  'meetings.day.today': 'Today',
  'meetings.day.yesterday': 'Yesterday',
  'meetings.row.title': '{tag} · {title}',
  'meetings.duration': '{n} min',
  'meetings.detail.meta.speakers': 'Você + {n, plural, one {# speaker} other {# speakers}} on Sala',
  'meetings.detail.meta.model': 'transcribed with {model}',
  'meetings.detail.openNote': 'Open note in Obsidian',
  'meetings.detail.transcript': 'Full transcript',
  'meetings.detail.summary': 'Summary',
  'meetings.detail.decisions': 'Decisions',
  'meetings.detail.pinned': 'Pinned moments',
  'meetings.detail.hits': '"{q}" in this meeting · {n, plural, one {# hit} other {# hits}}',
  'meetings.detail.actions': 'Action items',
  'meetings.detail.launch': 'Launch as session',
  'meetings.detail.dismiss': 'Dismiss',
  'meetings.detail.dismissed': 'Dismissed',
  'meetings.detail.undo': 'Undo',
  'meetings.detail.confidentialNote': 'Transcript not stored by the deck for {tag}',
  'meetings.post.namesHint': 'Needs speaker names. Run: postmeet name {session}',
  'meetings.post.failed': 'Summary failed',
  'meetings.post.failedBody': 'Summary failed. The batch log stopped at {time}.',
  'meetings.post.openLog': 'Open log',
  'meetings.copy': 'Copy',
  'meetings.drawer.close': 'Close'
})

/** The empty-decisions line postmeet writes; the detail shows it muted when the note has no decisions. */
export const NO_DECISIONS = 'Nenhuma decisão registrada.'

/** How long a dismissed action item fades before it leaves the list, in ms (meetings.md section 6). */
export const ITEM_FADE_MS = 160

const pad = n => String(n).padStart(2, '0')

/**
 * A tag shown as a name: each `-`, `_` or space separated word capitalised ("client-a" gives "Client A").
 * @param {string | null | undefined} tag
 * @returns {string}
 */
export function tagLabel(tag) {
  return String(tag ?? '').split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Local `HH:MM` of an epoch ms.
 * @param {number | null | undefined} at
 * @returns {string}
 */
export function clockTime(at) {
  if (!Number.isFinite(at)) return ''
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const startOfDay = at => {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * The local day of `at` relative to `now`: "Today", "Yesterday", the weekday within the last week, then the date.
 * @param {number} at epoch ms
 * @param {number} now epoch ms
 * @param {Function} [t]
 * @returns {string}
 */
export function dayLabel(at, now, t) {
  if (!Number.isFinite(at)) return ''
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days === 0) return translate(t, MEETING_DETAIL_COPY, 'meetings.day.today')
  if (days === 1) return translate(t, MEETING_DETAIL_COPY, 'meetings.day.yesterday')
  if (days > 1 && days < 7) return new Intl.DateTimeFormat('en', { weekday: 'long' }).format(at)
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat('en', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(at)
}

/**
 * A meeting's duration in whole minutes as text, or null when it has not ended.
 * @param {{ startedAt?: number | null, endedAt?: number | null }} meeting
 * @param {Function} [t]
 * @returns {string | null}
 */
export function durationText(meeting, t) {
  const { startedAt, endedAt } = meeting ?? {}
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null
  return translate(t, MEETING_DETAIL_COPY, 'meetings.duration', { n: Math.round((endedAt - startedAt) / 60_000) })
}

/**
 * The title of a meeting (meetings.md 4.1.1): "{Tag} · {note title}" once synthesized, else "{Tag} · {start time}".
 * @param {{ tag: string, title?: string | null, startedAt?: number | null }} meeting
 * @param {Function} [t]
 * @returns {string}
 */
export function meetingTitle(meeting, t) {
  const title = typeof meeting?.title === 'string' && meeting.title.trim() ? meeting.title : clockTime(meeting?.startedAt)
  return translate(t, MEETING_DETAIL_COPY, 'meetings.row.title', { tag: tagLabel(meeting?.tag), title })
}

// Room speakers of the detail payload: a count that includes "Você", or the list of names.
function roomSpeakers(speakers) {
  if (Array.isArray(speakers)) return speakers.filter(name => name !== 'Você').length
  return Number.isFinite(speakers) && speakers > 0 ? speakers - 1 : null
}

/**
 * The detail MetaLine: "{day} {time} · {duration} · Você + {n} speakers on Sala · transcribed with {model}",
 * leaving out what the meeting does not have.
 * @param {{ meeting: object, speakers?: number | string[] | null, model?: string | null }} detail
 * @param {number} now
 * @param {Function} [t]
 * @returns {string}
 */
export function detailMeta({ meeting, speakers, model }, now, t) {
  const parts = []
  if (Number.isFinite(meeting?.startedAt)) parts.push(`${dayLabel(meeting.startedAt, now, t)} ${clockTime(meeting.startedAt)}`)
  const duration = durationText(meeting, t)
  if (duration) parts.push(duration)
  const room = roomSpeakers(speakers)
  if (room !== null) parts.push(translate(t, MEETING_DETAIL_COPY, 'meetings.detail.meta.speakers', { n: room }))
  if (model) parts.push(translate(t, MEETING_DETAIL_COPY, 'meetings.detail.meta.model', { model }))
  return parts.join(' · ')
}

/**
 * The action-item calls of the detail: "Launch as session" opens the new-session form with the item text as its
 * task; "Dismiss" posts the dismissal, then shows the "Dismissed" toast whose `undo` posts the opposite call.
 * @param {{ api: object, meetingId: string, navigate: (to: string) => void, show: (toast: object | null) => void, setDismissed: Function, t?: Function }} options
 * @returns {{ launch: (item: { text: string }) => void, dismiss: (item: { key: string }) => Promise<void>, undo: (undo: { key: string }) => Promise<void> }}
 */
export function itemActions({ api, meetingId, navigate, show, setDismissed, t }) {
  const mark = (key, value) => setDismissed(current => ({ ...current, [key]: value }))
  return {
    launch: item => navigate('/new?task=' + encodeURIComponent(item.text)),
    dismiss: async item => {
      mark(item.key, true)
      try {
        await dismissItem(api, meetingId, item.key)
        show({ tone: 'success', text: translate(t, MEETING_DETAIL_COPY, 'meetings.detail.dismissed'), undo: { key: item.key } })
      } catch (error) {
        mark(item.key, false)
        show({ tone: 'error', text: String(error?.message ?? error?.code ?? 'failed') })
      }
    },
    undo: async ({ key }) => {
      show(null)
      try {
        await undismissItem(api, meetingId, key)
        mark(key, false)
      } catch (error) {
        show({ tone: 'error', text: String(error?.message ?? error?.code ?? 'failed') })
      }
    }
  }
}

/**
 * The modal drawer of a meeting's full transcript or `postmeet.log` tail: a dialog with a title, Close and a body.
 * @param {{ title: string, onClose: () => void, onKeyDown?: Function, panelRef?: object, t?: Function, children?: any }} props
 */
export function MeetingDrawer({ title, onClose, onKeyDown, panelRef, t, children }) {
  return (
    <div className="meeting-drawer-scrim">
      <section ref={panelRef} className="meeting-drawer" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        <header className="meeting-drawer-header">
          <h2 className="meeting-drawer-title">{title}</h2>
          <button type="button" className="button button--ghost button--xs" data-initial-focus="true" onClick={onClose}>{translate(t, MEETING_DETAIL_COPY, 'meetings.drawer.close')}</button>
        </header>
        <div className="meeting-drawer-body">{children}</div>
      </section>
    </div>
  )
}

/**
 * The Full transcript drawer body: every line as a TranscriptLine (text only, `lang="pt-BR"`), the confidential
 * note, and the line at `focusT` marked as the target to scroll to.
 * @param {{ meeting: object, transcript: { lines: object[] } | null, error?: string | null, focusT?: number | null, t?: Function }} props
 */
export function TranscriptBody({ meeting, transcript, error = null, focusT = null, t }) {
  const lines = transcript?.lines ?? []
  let target = -1
  if (Number.isFinite(focusT)) target = lines.findIndex(line => line.t0 >= focusT - 0.001)
  return (
    <>
      {meeting?.confidential ? <p className="meeting-muted">{translate(t, MEETING_DETAIL_COPY, 'meetings.detail.confidentialNote', { tag: meeting.tag })}</p> : null}
      {error ? <p className="meeting-error" role="alert">{error}</p> : null}
      {transcript ? (
        <ol className="meeting-transcript">
          {lines.map((line, index) => <li key={`${line.t0}-${index}`} data-target={index === target ? 'true' : undefined}><TranscriptLine line={line} /></li>)}
        </ol>
      ) : error ? null : <div className="meeting-skeleton motion-shimmer" aria-hidden="true" />}
    </>
  )
}

/**
 * The meeting detail without its data wiring (meetings.md 4.2): h2 title, MetaLine, Open note, Full transcript,
 * the awaiting-names and summary-failed banners, Summary (markdown, `html: false`), Decisions, Pinned moments,
 * in-meeting hits and Action items. Every content node carries `lang="pt-BR"`. Pure, so tests can render it and
 * call its handlers.
 * @param {{ detail: { meeting: object, note: object | null, pins?: object[], speakers?: any, model?: string | null } | null,
 *   q?: string, hits?: object[], dismissed?: Record<string, boolean>, leaving?: Record<string, boolean>, now: number, t?: Function,
 *   onOpenNote?: () => void, onTranscript?: (t0?: number) => void, onOpenLog?: () => void, onCopy?: (text: string) => void,
 *   onLaunch?: (item: object) => void, onDismiss?: (item: object) => void }} props
 */
export function MeetingDetailView({ detail, q = '', hits = [], dismissed = {}, leaving = {}, now, t, onOpenNote, onTranscript, onOpenLog, onCopy, onLaunch, onDismiss }) {
  const text = (key, params) => translate(t, MEETING_DETAIL_COPY, key, params)
  if (!detail) {
    return (
      <div className="meeting-detail" aria-busy="true">
        <div className="meeting-skeleton meeting-skeleton--title motion-shimmer" aria-hidden="true" />
        {[0, 1, 2].map(index => <div key={index} className="meeting-skeleton motion-shimmer" aria-hidden="true" />)}
      </div>
    )
  }
  const { meeting, note } = detail
  const pins = detail.pins ?? []
  const command = `postmeet name ${meeting.id}`
  const names = meeting.state === 'awaiting_names'
  const failed = meeting.stuck && !names
  const items = (note?.actionItems ?? []).filter(item => !item.dismissed && !dismissed[item.key])
  return (
    <div className="meeting-detail">
      <header className="meeting-detail-header">
        <h2 className="meeting-detail-title">{meetingTitle(meeting, t)}</h2>
        <p className="meeting-meta">{detailMeta(detail, now, t)}</p>
        <div className="meeting-detail-actions">
          {note ? <button type="button" className="button button--secondary button--sm" onClick={onOpenNote}>{text('meetings.detail.openNote')}</button> : null}
          <button type="button" className="button button--secondary button--sm" onClick={() => onTranscript?.()}>{text('meetings.detail.transcript')}</button>
        </div>
      </header>
      {names ? (
        <div className="meeting-banner meeting-banner--hint" role="status">
          <p className="meeting-banner-text">{text('meetings.post.namesHint', { session: meeting.id })}</p>
          <button type="button" className="button button--secondary button--xs" onClick={() => onCopy?.(command)}>{text('meetings.copy')}</button>
        </div>
      ) : null}
      {failed ? (
        <div className="meeting-banner meeting-banner--error" role="alert">
          <p className="meeting-banner-text">{Number.isFinite(meeting.logAt) ? text('meetings.post.failedBody', { time: clockTime(meeting.logAt) }) : text('meetings.post.failed')}</p>
          <button type="button" className="button button--secondary button--xs" onClick={onOpenLog}>{text('meetings.post.openLog')}</button>
        </div>
      ) : null}
      <div className="meeting-detail-grid">
        <div className="meeting-detail-main">
          {note?.summary ? (
            <section className="meeting-section" aria-label={text('meetings.detail.summary')}>
              <h3 className="eyebrow">{text('meetings.detail.summary')}</h3>
              <div className="meeting-summary" lang="pt-BR">{renderMarkdown(note.summary)}</div>
            </section>
          ) : null}
          {note ? (
            <section className="meeting-section" aria-label={text('meetings.detail.decisions')}>
              <h3 className="eyebrow">{text('meetings.detail.decisions')}</h3>
              {note.decisions?.length ? (
                <ul className="meeting-decisions">{note.decisions.map((decision, index) => <li key={index} lang="pt-BR">{decision}</li>)}</ul>
              ) : <p className="meeting-muted" lang="pt-BR">{NO_DECISIONS}</p>}
            </section>
          ) : null}
          {pins.length ? (
            <section className="meeting-section" aria-label={text('meetings.detail.pinned')}>
              <h3 className="eyebrow">{text('meetings.detail.pinned')}</h3>
              <ul className="meeting-pins">
                {pins.map(pin => (
                  <li key={pin.id} className="meeting-pin">
                    <span className="meeting-pin-time">{formatOffset(pin.t)}</span>
                    {!meeting.confidential && pin.label ? <q className="meeting-pin-label" lang="pt-BR">{pin.label}</q> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {q && hits.length ? (
            <section className="meeting-section" aria-label={text('meetings.detail.hits', { q, n: hits.length })}>
              <h3 className="eyebrow">{text('meetings.detail.hits', { q, n: hits.length })}</h3>
              <ul className="meeting-hits">
                {hits.map((hit, index) => <li key={`${hit.t0}-${index}`}><TranscriptLine line={hit} ranges={hit.ranges} onClick={() => onTranscript?.(hit.t0)} /></li>)}
              </ul>
            </section>
          ) : null}
        </div>
        {note ? (
          <section className="meeting-section meeting-detail-side" aria-label={text('meetings.detail.actions')}>
            <h3 className="eyebrow">{text('meetings.detail.actions')}</h3>
            <ul className="meeting-items">
              {items.map(item => (
                <li key={item.key} className={leaving[item.key] ? 'meeting-item meeting-item--leaving' : 'meeting-item'}>
                  <p className="meeting-item-text" lang="pt-BR">{item.text}</p>
                  {item.owner ? <p className="meeting-item-owner" lang="pt-BR">{item.owner}</p> : null}
                  <div className="meeting-item-actions">
                    <button type="button" className="button button--primary button--sm" onClick={() => onLaunch?.(item)}>{text('meetings.detail.launch')}</button>
                    <button type="button" className="button button--ghost button--sm" onClick={() => onDismiss?.(item)}>{text('meetings.detail.dismiss')}</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}

// Escape closes, Tab stays inside, focus starts on Close and returns to the opener.
function useDrawerKeys(onClose) {
  const panel = useRef(null)
  useEffect(() => {
    const opener = globalThis.document?.activeElement
    panel.current?.querySelector('[data-initial-focus="true"]')?.focus()
    return () => opener?.focus?.()
  }, [])
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else trapTab(event, panel.current)
  }
  return { panel, onKeyDown }
}

function TranscriptDrawer({ api, meeting, focusT, t, onClose }) {
  const { panel, onKeyDown } = useDrawerKeys(onClose)
  const [transcript, setTranscript] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let current = true
    fetchMeetingTranscript(api, meeting.id).then(body => { if (current) setTranscript(body) }).catch(failure => { if (current) setError(String(failure?.message ?? 'failed')) })
    return () => { current = false }
  }, [api, meeting.id])
  useEffect(() => {
    if (transcript) panel.current?.querySelector('[data-target="true"]')?.scrollIntoView?.({ block: 'center' })
  }, [transcript])
  return (
    <MeetingDrawer title={translate(t, MEETING_DETAIL_COPY, 'meetings.detail.transcript')} onClose={onClose} onKeyDown={onKeyDown} panelRef={panel} t={t}>
      <TranscriptBody meeting={meeting} transcript={transcript} error={error} focusT={focusT} t={t} />
    </MeetingDrawer>
  )
}

function LogDrawer({ api, meetingId, t, onClose }) {
  const { panel, onKeyDown } = useDrawerKeys(onClose)
  const [log, setLog] = useState(null)
  useEffect(() => {
    let current = true
    fetchMeetingLog(api, meetingId).then(body => { if (current) setLog(String(body?.text ?? '')) }).catch(failure => { if (current) setLog(String(failure?.message ?? 'failed')) })
    return () => { current = false }
  }, [api, meetingId])
  return (
    <MeetingDrawer title={translate(t, MEETING_DETAIL_COPY, 'meetings.post.openLog')} onClose={onClose} onKeyDown={onKeyDown} panelRef={panel} t={t}>
      {log === null ? <div className="meeting-skeleton motion-shimmer" aria-hidden="true" /> : <pre className="meeting-log" lang="pt-BR">{log}</pre>}
    </MeetingDrawer>
  )
}

/**
 * The meeting detail with its data: reads the meeting with `fetchMeeting` (once per mount; `detail` seeds it),
 * opens the note in Obsidian through `POST /api/open { kind: 'meetingNote' }`, the Full transcript drawer (fetched on
 * each open, scrolled to a hit's offset) and the Open log drawer, copies the `postmeet name` command, and runs the
 * action-item calls of {@link itemActions} with the "Dismissed" toast and its 6 s Undo.
 * @param {{ id: string, api: object, t?: Function, navigate: (to: string) => void, now?: number, q?: string, hits?: object[], detail?: object | null, listItem?: object | null }} props
 */
export function MeetingDetail({ id, api, t, navigate, now = Date.now(), q = '', hits = [], detail: seed, listItem = null }) {
  const [detail, setDetail] = useState(seed ?? null)
  const [dismissed, setDismissed] = useState({})
  const [leaving, setLeaving] = useState({})
  const [drawer, setDrawer] = useState(null)
  const [toast, show] = useArchiveToast()
  useEffect(() => {
    if (seed !== undefined) return undefined
    let current = true
    fetchMeeting(api, id).then(body => { if (current) setDetail(body) }).catch(() => {})
    return () => { current = false }
  }, [api, id])
  const shown = detail ? { ...detail, meeting: { ...listItem, ...detail.meeting, title: detail.meeting?.title ?? detail.note?.title ?? listItem?.title ?? null } } : null
  const actions = itemActions({ api, meetingId: id, navigate, show, setDismissed, t })
  const onDismiss = item => {
    setLeaving(current => ({ ...current, [item.key]: true }))
    setTimeout(() => {
      setLeaving(current => ({ ...current, [item.key]: false }))
      actions.dismiss(item)
    }, ITEM_FADE_MS)
  }
  const onCopy = value => { globalThis.navigator?.clipboard?.writeText?.(value)?.catch?.(() => {}) }
  const onOpenNote = () => { api.post('/api/open', { kind: 'meetingNote', ref: id }).catch(failure => show({ tone: 'error', text: String(failure?.message ?? 'failed') })) }
  return (
    <>
      <MeetingDetailView detail={shown} q={q} hits={hits} dismissed={dismissed} leaving={leaving} now={now} t={t}
        onOpenNote={onOpenNote} onTranscript={t0 => setDrawer({ kind: 'transcript', t0: t0 ?? null })} onOpenLog={() => setDrawer({ kind: 'log' })}
        onCopy={onCopy} onLaunch={actions.launch} onDismiss={onDismiss} />
      {drawer?.kind === 'transcript' && shown ? <TranscriptDrawer api={api} meeting={shown.meeting} focusT={drawer.t0} t={t} onClose={() => setDrawer(null)} /> : null}
      {drawer?.kind === 'log' ? <LogDrawer api={api} meetingId={id} t={t} onClose={() => setDrawer(null)} /> : null}
      <ArchiveToast toast={toast} t={t} onUndo={actions.undo} onDismiss={() => show(null)} />
    </>
  )
}
