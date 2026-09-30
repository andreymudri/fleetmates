import React, { useEffect, useState } from 'react'
import { CARD_COPY } from '../../components/SessionCard.jsx'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { MetaLine, StatusPill, compactDuration, pillParams, shown, stateLabel, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { ObserveOverlays, useMinuteNow } from '../home/Home.jsx'
import { deckApi, repoFor, tierOf } from '../drawer/NeedsYouDrawer.jsx'
import { orderSessions } from '../palette/Palette.jsx'

/** English copy for the M1 read-only Focus (docs/deck/screens/focus.md section 9, MS-O1). */
export const FOCUS_COPY = Object.freeze({
  'focus.list.back': 'All ships',
  'focus.list.label': 'Sessions',
  'focus.header.waiting': '{state} · {duration}',
  'focus.header.openRun': 'Open run',
  'focus.header.markReviewed': 'Mark reviewed',
  'focus.header.reviewFailed': 'Could not mark this session reviewed.',
  'focus.observed.banner': 'Observed session: started as plain claude, read-only here.',
  'focus.prompt.answerInTerminal': 'Answer in your terminal',
  'focus.stale.line': 'Adrift since {time}: no activity since then.',
  'focus.joinedLate': 'Joined mid-voyage: changes before {time} are not counted.',
  'focus.log.label': 'Activity',
  'focus.log.empty': 'No activity recorded yet.',
  'focus.log.loading': 'Loading activity',
  'focus.tabs.label': 'Details',
  'focus.tabs.changes': 'Changes',
  'focus.tabs.facts': 'Facts',
  'focus.changes.label': 'Changed files',
  'focus.facts.origin': 'Started from',
  'focus.facts.origin.wrapped': 'fm claude in a terminal',
  'focus.facts.origin.launched': 'the deck',
  'focus.facts.origin.observed': 'plain claude (observed)',
  'focus.facts.started': 'Started',
  'focus.facts.duration': 'Running for',
  'focus.facts.claudeSession': 'Claude session',
  'focus.facts.branch': 'Branch',
  'focus.facts.cwd': 'Working directory',
  'focus.facts.toolCalls': 'Tool calls',
  'focus.facts.subagents': 'Subagents working',
  'focus.facts.transcript': 'Transcript',
  'focus.notFound.title': 'This session is not on the deck.'
})

const NEEDS = new Set(['needs_approval', 'asked_you'])
const TABS = ['changes', 'facts']
const href = id => `/s/${encodeURIComponent(id)}`

function clock(at, lang) {
  return Number.isFinite(at) ? new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at) : ''
}

/**
 * Mark a `done` session reviewed (05-api.md, `POST /api/sessions/:id/mark-reviewed`, `U.MarkReviewed`).
 * The screen changes no state itself; the new pill comes from the server's events.
 * @param {{ post: (path: string, body?: object) => Promise<any> }} api
 * @param {string} id
 * @returns {Promise<any>}
 */
export function markReviewed(api, id) {
  return api.post(`/api/sessions/${encodeURIComponent(id)}/mark-reviewed`)
}

function SessionList({ state, sessionId, now, t, navigate }) {
  const live = orderSessions(state.data.sessions.filter(row => row.state !== 'ended'), state.data.order, state.data.requests)
  return (
    <aside className="focus-list" aria-label={translate(t, FOCUS_COPY, 'focus.list.label')}>
      <a className="focus-back" href="/" onClick={linkHandler(navigate, '/')}>{translate(t, FOCUS_COPY, 'focus.list.back')} <kbd className="kbd" aria-hidden="true">Alt Esc</kbd></a>
      <ul className="focus-list-rows">
        {live.map((row, index) => {
          const repo = repoFor(state.data.repos, row.repoId)
          return (
            <li key={row.id}>
              <a className="focus-list-row" href={href(row.id)} aria-current={row.id === sessionId ? 'page' : undefined} onClick={linkHandler(navigate, href(row.id))}>
                <CrewAvatar seed={repo.crewSeed} slot={repo.crewSlot} pose={poseFor(row.state)} hat={repo.hat} size="sm" />
                <span className="focus-list-text">
                  <span className="focus-list-title">{shown(repo.name)}</span>
                  <StatusPill state={row.state} params={pillParams(row, now)} role={row.role} variant="text" t={t} />
                </span>
                {index < 9 ? <kbd className="kbd" aria-hidden="true">{`Alt ${index + 1}`}</kbd> : null}
              </a>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function RequestBar({ request, t }) {
  const tier = tierOf(request)
  const question = tier === 'question'
  return (
    <div className={`focus-request focus-request--${tier}`} role="group" aria-label={question ? titleText(request.summary) : shown(request.summary)}>
      <span className={`tier-badge tier-badge--${tier}`}>{translate(t, CARD_COPY, `tier.${tier}`)}</span>
      {question
        ? <p className="focus-request-summary"><bdi>{titleText(request.summary)}</bdi></p>
        : <code className="focus-request-summary">{shown(request.summary)}</code>}
      <span className="request-terminal">{translate(t, FOCUS_COPY, 'focus.prompt.answerInTerminal')}</span>
    </div>
  )
}

function ActivityLog({ steps, t, lang }) {
  const label = translate(t, FOCUS_COPY, 'focus.log.label')
  if (!steps) {
    return (
      <section className="focus-log" aria-label={label} aria-busy="true">
        <span className="sr-only">{translate(t, FOCUS_COPY, 'focus.log.loading')}</span>
        {[0, 1, 2].map(index => <div key={index} className="focus-log-skeleton motion-shimmer" aria-hidden="true" />)}
      </section>
    )
  }
  const ordered = [...steps].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return (
    <section className="focus-log" aria-label={label}>
      {ordered.length ? (
        <ol className="focus-steps">
          {ordered.map(step => (
            <li key={step.seq} className={`focus-step focus-step--${step.status === 'failed' ? 'error' : step.status === 'running' ? 'waiting' : 'tool'}`}>
              <span className="focus-step-time">{clock(step.at, lang)}</span>
              <span className="focus-step-text">{shown(step.line)}</span>
              {step.adds ? <span className="diff-add">{` +${step.adds}`}</span> : null}
              {step.dels ? <span className="diff-del">{` −${step.dels}`}</span> : null}
            </li>
          ))}
        </ol>
      ) : <p className="focus-log-empty">{translate(t, FOCUS_COPY, 'focus.log.empty')}</p>}
    </section>
  )
}

function Facts({ session, now, t, lang }) {
  const origin = ['wrapped', 'launched', 'observed'].includes(session.origin) ? translate(t, FOCUS_COPY, `focus.facts.origin.${session.origin}`) : shown(session.origin)
  const rows = [
    ['focus.facts.origin', origin],
    ['focus.facts.started', Number.isFinite(session.startedAt) ? clock(session.startedAt, lang) : null],
    ['focus.facts.duration', Number.isFinite(session.startedAt) ? compactDuration((session.endedAt ?? now) - session.startedAt) : null],
    ['focus.facts.claudeSession', session.claudeSessionId ? shown(session.claudeSessionId) : null],
    ['focus.facts.branch', session.branch ? shown(session.branch) : null],
    ['focus.facts.cwd', session.cwd ? shown(session.cwd) : null],
    ['focus.facts.toolCalls', Number.isFinite(session.toolCalls) ? String(session.toolCalls) : null],
    ['focus.facts.subagents', session.subagentsActive ? String(session.subagentsActive) : null],
    ['focus.facts.transcript', session.transcriptPath ? shown(session.transcriptPath) : null]
  ].filter(([, value]) => value !== null && value !== '')
  return (
    <dl className="focus-facts">
      {rows.map(([key, value]) => <React.Fragment key={key}><dt>{translate(t, FOCUS_COPY, key)}</dt><dd>{value}</dd></React.Fragment>)}
    </dl>
  )
}

function Details({ session, tab, onTab, now, t, lang }) {
  const files = session.changedFiles ?? []
  const labels = {
    changes: `${translate(t, FOCUS_COPY, 'focus.tabs.changes')}${files.length ? ` ${files.length}` : ''}`,
    facts: translate(t, FOCUS_COPY, 'focus.tabs.facts')
  }
  const onKeyDown = event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    onTab(TABS[(TABS.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length])
  }
  return (
    <aside className="focus-details" aria-label={translate(t, FOCUS_COPY, 'focus.tabs.label')}>
      <div className="focus-tabs" role="tablist" aria-label={translate(t, FOCUS_COPY, 'focus.tabs.label')} onKeyDown={onKeyDown}>
        {TABS.map(id => (
          <button key={id} type="button" className="focus-tab" role="tab" id={`focus-tab-${id}`} aria-selected={tab === id ? 'true' : 'false'} aria-controls="focus-panel"
            tabIndex={tab === id ? 0 : -1} onClick={() => onTab(id)}>{labels[id]}</button>
        ))}
      </div>
      <div className="focus-panel" role="tabpanel" id="focus-panel" aria-labelledby={`focus-tab-${tab}`}>
        {tab === 'facts' ? <Facts session={session} now={now} t={t} lang={lang} /> : files.length ? (
          <ul className="focus-files" aria-label={translate(t, FOCUS_COPY, 'focus.changes.label')}>
            {files.map(file => (
              <li key={file.path} className="focus-file">
                <span className="focus-file-path">{shown(file.path)}</span>
                {file.adds ? <span className="diff-add">{` +${file.adds}`}</span> : null}
                {file.dels ? <span className="diff-del">{` −${file.dels}`}</span> : null}
              </li>
            ))}
          </ul>
        ) : <EmptyState kind="focusChanges" t={t} />}
      </div>
    </aside>
  )
}

/**
 * The read-only Focus layout of M1 (focus.md 4.4, MS-O1): session list, header, observed banner, the
 * activity log from hook steps, one bar per open request saying "Answer in your terminal", and the
 * Changes and Facts tabs. No terminal, no input, no Stop or Nudge; "Mark reviewed" only for `done`.
 * Pure: no hooks, so tests can walk it.
 * @param {{ state: object, sessionId: string, t?: Function, now?: number, lang?: string, navigate: (to: string) => void, steps: object[] | null, tab: 'changes'|'facts', onTab: (tab: string) => void, onMarkReviewed?: () => void, reviewing?: boolean, reviewError?: string | null }} props
 */
export function FocusView({ state, sessionId, t, now = Date.now(), lang = 'en', navigate, steps, tab, onTab, onMarkReviewed, reviewing = false, reviewError = null }) {
  const session = state.data.sessions.find(row => row.id === sessionId)
  if (!session) {
    return (
      <section className="focus focus--missing">
        <h1 className="page-title">{translate(t, FOCUS_COPY, 'focus.notFound.title')}</h1>
        <a className="button button--ghost" href="/" onClick={linkHandler(navigate, '/')}>{translate(t, FOCUS_COPY, 'focus.list.back')}</a>
      </section>
    )
  }
  const repo = repoFor(state.data.repos, session.repoId)
  const open = (state.data.requests ?? []).filter(row => row.sessionId === session.id && (row.state ?? 'open') === 'open')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const waiting = NEEDS.has(session.state) && open.length
    ? translate(t, FOCUS_COPY, 'focus.header.waiting', { state: stateLabel(session.state, {}, t), duration: compactDuration(now - (open[0].createdAt ?? now)) })
    : undefined
  const title = titleText(session.task || translate(t, CARD_COPY, 'home.card.untitled'))
  const runHref = session.role === 'lead' && session.runRef ? `/runs/${encodeURIComponent(repo.name)}/${encodeURIComponent(session.runRef.runId)}` : null
  return (
    <div className="focus">
      <SessionList state={state} sessionId={session.id} now={now} t={t} navigate={navigate} />
      <section className="focus-main" aria-labelledby="focus-title">
        <header className="focus-header">
          <CrewAvatar seed={repo.crewSeed} slot={repo.crewSlot} pose={poseFor(session.state)} hat={repo.hat} size="md" />
          <div className="focus-heading">
            <h1 className="focus-title" id="focus-title" title={title}><bdi>{title}</bdi></h1>
            <MetaLine className="focus-subtitle" items={[shown(repo.name), session.branch ? shown(session.branch) : null, session.cwd ? shown(session.cwd) : null]} />
          </div>
          <StatusPill state={session.state} label={waiting} params={pillParams(session, now)} role={session.role} t={t} />
          <div className="focus-actions">
            {runHref ? <a className="button button--ghost button--xs" href={runHref} onClick={linkHandler(navigate, runHref)}>{translate(t, FOCUS_COPY, 'focus.header.openRun')}</a> : null}
            {session.state === 'done'
              ? <button type="button" className="button button--purple button--xs" disabled={reviewing} onClick={onMarkReviewed}>{translate(t, FOCUS_COPY, 'focus.header.markReviewed')}</button>
              : null}
          </div>
        </header>
        {reviewError ? <p className="focus-error" role="alert">{translate(t, FOCUS_COPY, 'focus.header.reviewFailed')}</p> : null}
        {session.origin === 'observed' ? <p className="focus-banner focus-banner--info">{translate(t, FOCUS_COPY, 'focus.observed.banner')}</p> : null}
        {session.state === 'stale' ? <p className="focus-banner focus-banner--hint">{translate(t, FOCUS_COPY, 'focus.stale.line', { time: clock(session.lastActivityAt ?? session.stateSince, lang) })}</p> : null}
        {session.joinedMidLife ? <p className="focus-banner focus-banner--info">{translate(t, FOCUS_COPY, 'focus.joinedLate', { time: clock(session.startedAt, lang) })}</p> : null}
        <ActivityLog steps={steps} t={t} lang={lang} />
        {open.map(request => <RequestBar key={request.id} request={request} t={t} />)}
      </section>
      <Details session={session} tab={tab} onTab={onTab} now={now} t={t} lang={lang} />
    </div>
  )
}

/**
 * The Focus route screen for the shell's `screens` map: loads the session's hook steps from
 * `/api/sessions/:id/steps`, keeps the tab, runs {@link markReviewed}, and renders the observe overlays.
 * This browser wiring is not exercised by the unit tests; {@link FocusView} and {@link markReviewed} are.
 * @param {{ route: { params: { sessionId: string } }, state: object, t?: Function, navigate: (to: string) => void, api?: object, search?: string }} props
 */
export function Focus({ route, state, t, navigate, api, search = globalThis.location?.search ?? '' }) {
  const id = route.params.sessionId
  const now = useMinuteNow()
  const client = api ?? deckApi()
  const session = state.data.sessions.find(row => row.id === id)
  const [steps, setSteps] = useState(null)
  const [tab, setTab] = useState(() => new URLSearchParams(search).get('tab') === 'facts' ? 'facts' : 'changes')
  const [reviewing, setReviewing] = useState(false)
  const [reviewError, setReviewError] = useState(null)
  const known = !!session
  const activity = session?.lastActivityAt
  useEffect(() => { setSteps(null) }, [id])
  useEffect(() => {
    if (!known) return undefined
    let current = true
    client.get(`/api/sessions/${encodeURIComponent(id)}/steps`).then(data => { if (current) setSteps(data?.steps ?? []) }).catch(() => { if (current) setSteps([]) })
    return () => { current = false }
  }, [client, id, known, activity])
  const onMarkReviewed = () => {
    setReviewing(true)
    setReviewError(null)
    markReviewed(client, id).catch(error => setReviewError(error?.code ?? 'failed')).finally(() => setReviewing(false))
  }
  return (
    <>
      <FocusView state={state} sessionId={id} t={t} now={now} navigate={navigate} steps={steps} tab={tab} onTab={setTab}
        onMarkReviewed={onMarkReviewed} reviewing={reviewing} reviewError={reviewError} />
      <ObserveOverlays state={state} t={t} navigate={navigate} api={api} />
    </>
  )
}
