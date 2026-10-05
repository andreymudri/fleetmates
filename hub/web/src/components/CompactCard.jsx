import React from 'react'
import { CARD_COPY, controllable, withLocalDelivery } from './SessionCard.jsx'
import { CrewAvatar, poseFor } from './CrewAvatar.jsx'
import { StatusPill, pillParams, shown, titleText, translate } from './StatusPill.jsx'
import { linkHandler } from '../shell/Rail.jsx'

/**
 * English copy for the compact card (docs/deck/screens/home.md section 9, `home.compact.*`). The team strip's
 * "Review {n}" is the team card's `home.card.team.review`.
 */
export const COMPACT_COPY = Object.freeze({
  'home.compact.observed': 'Observed · from hooks',
  'home.compact.team.ask': 'task {taskId} {summary}',
  'home.compact.reply': 'Reply',
  'home.compact.review': 'Review',
  'home.card.team.review': 'Review {n}'
})

/** Skeleton lines a PTY tail shows before its first `screen.tail` and while deckd is down (home.md 5.1). */
export const TAIL_SKELETON = 3
/** Hook steps an observed compact card lists under its muted first line. */
export const COMPACT_STEPS = 5

const NEEDS = new Set(['needs_approval', 'asked_you'])
const sessionHref = id => `/s/${encodeURIComponent(id)}`
const domId = id => `card-title-${String(id).replace(/[^\w-]/g, '_')}`
const IN_FLIGHT = new Set(['sending', 'verifying'])
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
 * The two `xs` buttons of a compact action strip (home.md 4.4), as plain data: a team gets "Open" and
 * "Review {n}"; an observed session "Open" only (it never answers); a question "Open" and "Reply"; a Destructive
 * request "Open" and "Review"; a Safe or Caution permission request of a PTY session with parsed options "Deny" and
 * "Allow once", disabled while deckd is down, the prompt is queued or an answer is in flight. A permission request
 * without parsed options, or whose answer did not land, gets "Open" and "Review" (the drawer explains why).
 * @param {{ session?: object | null, team?: object | null, request: object, deckdDown?: boolean, busy?: object | null }} input
 * @returns {{ kind: 'open' | 'review' | 'reply' | 'teamReview' | 'deny' | 'allow', disabled?: boolean, spinner?: boolean }[]}
 */
export function stripActions({ session = null, team = null, request, deckdDown = false, busy = null }) {
  if (team) return [{ kind: 'open' }, { kind: 'teamReview' }]
  if (!session || session.origin === 'observed') return [{ kind: 'open' }]
  const tier = tierOf(request)
  if (tier === 'question') return [{ kind: 'open' }, { kind: 'reply' }]
  if (tier === 'destructive') return [{ kind: 'open' }, { kind: 'review' }]
  const shownRequest = withLocalDelivery(request, busy)
  const delivery = shownRequest.delivery ?? 'idle'
  if (!(request.options?.length) || delivery === 'did_not_land') return [{ kind: 'open' }, { kind: 'review' }]
  const locked = deckdDown || request.screenMatch === 'queued' || IN_FLIGHT.has(delivery)
  const chosen = choice => delivery === 'sending' && busy?.choice === choice
  return [{ kind: 'deny', disabled: locked, spinner: chosen('deny') }, { kind: 'allow', disabled: locked, spinner: chosen('allow') }]
}

/**
 * CompactCard for Home's compact density (home.md 4.4): a header strip (crew, repo, branch, dot pill), a tail and
 * an action strip. A PTY session's tail is its `screen.tail` lines (`tail`), with skeleton lines until the first
 * one arrives and while `deckdDown`; an observed session lists its last hook `steps` under the muted line
 * "Observed · from hooks" and never a PTY tail. The action strip shows the oldest open request (or, for a team,
 * one ask per open request) and the two buttons of {@link stripActions}: "Allow once" and "Deny" call `onAnswer`
 * with the request and the AnswerBody, "Review", "Reply" and a team's "Review {n}" call `onReview` with the
 * (first) request id, which opens the drawer on it. `answers` holds the AnswerBody in flight per request id.
 * `label` overrides the pill (a team's "{n} of {total} need you"). Every agent-supplied string renders as
 * text through `shown` or `titleText`. Pure: no hooks.
 * @param {{ session?: object | null, team?: object | null, repo: { name: string, crewSeed?: string, crewSlot?: number, hat?: string },
 *   label?: string, requests?: object[], tail?: string[], steps?: { line?: string, text?: string, seq?: number }[], deckdDown?: boolean, now?: number,
 *   t?: (key: string, params?: object) => string, navigate?: (to: string) => void, answers?: Record<string, object>,
 *   onAnswer?: (request: object, body: object) => void, onReview?: (requestId: string) => void }} props
 */
export function CompactCard({ session = null, team = null, label, repo, requests = [], tail, steps, deckdDown = false, now = Date.now(), t, navigate,
  answers = {}, onAnswer = () => {}, onReview = () => {} }) {
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
  const first = open[0]
  const control = action => {
    const xs = 'button button--xs compact-action'
    switch (action.kind) {
      case 'open':
        return <a key="open" className="button button--ghost button--xs compact-open" href={href} onClick={go}>{translate(t, CARD_COPY, 'home.card.request.open')}</a>
      case 'teamReview':
        return <button key="review" type="button" className={`${xs} button--amber-outline`} onClick={() => onReview(first.id)}>{translate(t, COMPACT_COPY, 'home.card.team.review', { n: open.length })}</button>
      case 'review':
        return <button key="review" type="button" className={`${xs} button--amber-outline`} onClick={() => onReview(first.id)}>{translate(t, COMPACT_COPY, 'home.compact.review')}</button>
      case 'reply':
        return <button key="reply" type="button" className={`${xs} button--amber`} onClick={() => onReview(first.id)}>{translate(t, COMPACT_COPY, 'home.compact.reply')}</button>
      default: {
        const allow = action.kind === 'allow'
        return (
          <button key={action.kind} type="button" className={`${xs} ${allow ? 'button--amber' : 'button--amber-outline'}`} disabled={action.disabled} aria-busy={action.spinner ? 'true' : undefined}
            onClick={() => onAnswer(first, { choice: action.kind })}>
            {action.spinner ? <span className="answer-spinner" aria-hidden="true" /> : null}{translate(t, CARD_COPY, allow ? 'home.card.request.allowOnce' : 'home.card.request.deny')}
          </button>
        )
      }
    }
  }
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
          <span className={`tier-badge tier-badge--${tierOf(first)}`}>{translate(t, CARD_COPY, `tier.${tierOf(first)}`)}</span>
          <span className="compact-ask"><bdi>{asks.join(' · ')}</bdi></span>
          {stripActions({ session, team, request: first, deckdDown, busy: answers?.[first.id] ?? null }).map(control)}
        </div>
      ) : null}
    </article>
  )
}
