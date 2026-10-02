import React from 'react'
import { CARD_COPY, controllable } from './SessionCard.jsx'
import { CrewAvatar, poseFor } from './CrewAvatar.jsx'
import { StatusPill, pillParams, shown, titleText, translate } from './StatusPill.jsx'
import { linkHandler } from '../shell/Rail.jsx'

/** English copy for the compact card (docs/deck/screens/home.md section 9, `home.compact.*`). */
export const COMPACT_COPY = Object.freeze({
  'home.compact.observed': 'Observed · from hooks',
  'home.compact.team.ask': 'task {taskId} {summary}'
})

/** Skeleton lines a PTY tail shows before its first `screen.tail` and while deckd is down (home.md 5.1). */
export const TAIL_SKELETON = 3
/** Hook steps an observed compact card lists under its muted first line. */
export const COMPACT_STEPS = 5

const NEEDS = new Set(['needs_approval', 'asked_you'])
const sessionHref = id => `/s/${encodeURIComponent(id)}`
const domId = id => `card-title-${String(id).replace(/[^\w-]/g, '_')}`
const tierOf = request => request.kind === 'question' ? 'question' : ['safe', 'caution', 'destructive'].includes(request.tier) ? request.tier : 'caution'

function openRequests(session, requests) {
  if (!session) return []
  return (requests ?? []).filter(row => row.sessionId === session.id && (row.state ?? 'open') === 'open')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)))
}

function Tail({ session, tail, steps, deckdDown, t }) {
  if (session && session.origin === 'observed') {
    const rows = (steps ?? []).slice(-COMPACT_STEPS)
    return (
      <ol className="compact-tail compact-tail--observed">
        <li className="compact-tail-line compact-tail-line--muted">{translate(t, COMPACT_COPY, 'home.compact.observed')}</li>
        {rows.map((step, index) => <li key={step.seq ?? index} className="compact-tail-line">{shown(step.line ?? step.text)}</li>)}
      </ol>
    )
  }
  if (!Array.isArray(tail) || deckdDown || !session || !controllable(session)) {
    return (
      <div className="compact-tail compact-tail--loading" aria-hidden="true">
        {Array.from({ length: TAIL_SKELETON }, (_, index) => <span key={index} className="compact-tail-skeleton motion-shimmer" />)}
      </div>
    )
  }
  return (
    <ol className="compact-tail">
      {tail.map((line, index) => <li key={index} className="compact-tail-line">{shown(line)}</li>)}
    </ol>
  )
}

/**
 * CompactCard for Home's compact density (home.md 4.4): a header strip (crew, repo, branch, dot pill), a tail and
 * an action strip. A PTY session's tail is its `screen.tail` lines (`tail`), with skeleton lines until the first
 * one arrives and while `deckdDown`; an observed session lists its last hook `steps` under the muted line
 * "Observed · from hooks" and never a PTY tail. The action strip shows the oldest open request (or, for a team,
 * one ask per open request) and "Open"; answer buttons arrive in M3. `label` overrides the pill (a team's "{n} of {total}
 * need you"). Every agent-supplied string renders as
 * text through `shown` or `titleText`. Pure: no hooks.
 * @param {{ session?: object | null, team?: object | null, repo: { name: string, crewSeed?: string, crewSlot?: number, hat?: string },
 *   label?: string, requests?: object[], tail?: string[], steps?: { line?: string, text?: string, seq?: number }[], deckdDown?: boolean, now?: number,
 *   t?: (key: string, params?: object) => string, navigate?: (to: string) => void }} props
 */
export function CompactCard({ session = null, team = null, label, repo, requests = [], tail, steps, deckdDown = false, now = Date.now(), t, navigate }) {
  const subject = team ? team.lead : session
  const state = team ? team.state : session.state
  const href = team ? `/runs/${encodeURIComponent(repo.name)}/${encodeURIComponent(team.run.runId)}` : sessionHref(session.id)
  const id = team ? `card-title-team-${`${team.run.repoId}-${team.run.runId}`.replace(/[^\w-]/g, '_')}` : domId(session.id)
  const title = titleText(team ? team.lead?.task || team.run.runId : session.task || translate(t, CARD_COPY, 'home.card.untitled'))
  const open = team ? team.requests : openRequests(session, requests)
  const asks = team
    ? open.map(row => row.taskId ? translate(t, COMPACT_COPY, 'home.compact.team.ask', { taskId: shown(row.taskId), summary: shown(row.summary) }) : shown(row.summary))
    : open.slice(0, 1).map(row => tierOf(row) === 'question' ? titleText(row.summary) : shown(row.summary))
  const showAsk = asks.length > 0 && (team || NEEDS.has(state))
  const branch = subject?.branch
  const classes = ['compact-card', `compact-card--${String(state).replace(/_/g, '-')}`]
  if (team) classes.push('compact-card--team')
  if (NEEDS.has(state)) classes.push('motion-pulse')
  const go = navigate ? linkHandler(navigate, href) : undefined
  return (
    <article className={classes.join(' ')} aria-labelledby={id}>
      <header className="compact-header">
        <CrewAvatar seed={repo.crewSeed ?? repo.name} slot={repo.crewSlot} pose={poseFor(state)} hat={repo.hat ?? 'none'} team={!!team} size="sm" />
        <h3 className="compact-title" id={id}>
          <a className="card-link compact-repo" href={href} title={title} onClick={go}><bdi>{shown(repo.name)}</bdi><span className="sr-only">{` · ${title}`}</span></a>
        </h3>
        {branch ? <span className="compact-branch">{shown(branch)}</span> : null}
        <StatusPill state={state} label={label} params={subject ? pillParams(subject, now) : undefined} variant="dot" t={t} />
      </header>
      <Tail session={subject} tail={tail} steps={steps} deckdDown={deckdDown} t={t} />
      {showAsk ? (
        <div className="compact-strip">
          <span className={`tier-badge tier-badge--${tierOf(open[0])}`}>{translate(t, CARD_COPY, `tier.${tierOf(open[0])}`)}</span>
          <span className="compact-ask"><bdi>{asks.join(' · ')}</bdi></span>
          <a className="button button--ghost button--xs compact-open" href={href} onClick={go}>{translate(t, CARD_COPY, 'home.card.request.open')}</a>
        </div>
      ) : null}
    </article>
  )
}
