import React from 'react'
import { CrewAvatar, poseFor } from './CrewAvatar.jsx'
import { MetaLine, StatusPill, compactDuration, pillParams, shown, titleText, translate } from './StatusPill.jsx'
import { linkHandler } from '../shell/Rail.jsx'

/**
 * English copy for the M1 (observe-only) cards: docs/deck/screens/home.md section 9 and
 * failures-and-loading.md section 4.
 */
export const CARD_COPY = Object.freeze({
  'home.card.untitled': 'Untitled',
  'home.card.crashed.title': '{repo} ran aground',
  'home.card.crashed.exit': 'The session exited with code {code}.',
  'home.card.crashed.killed': 'The process ran out of memory or was killed by the system.',
  'home.card.crashed.signal': 'The session was stopped by signal {signal}.',
  'home.card.crashed.lost': 'The deck lost track of this process. It may have been closed outside the deck.',
  'home.card.activity.compacting': 'Compacting context…',
  'home.card.activity.subagents': '{n, plural, one {# subagent working} other {# subagents working}}',
  'home.card.activity.tool': 'Using {tool}',
  'home.card.request.wantsToRun': 'Wants to run',
  'home.card.request.answerInTerminal': 'Answer in your terminal',
  'home.card.request.open': 'Open',
  'home.card.request.more': '{n, plural, one {+# more request} other {+# more requests}}',
  'home.card.files.eyebrow': 'Changed files',
  'home.card.files.more': '+{n} more',
  'home.card.meta.toolCalls': '{n, plural, one {# tool call} other {# tool calls}}',
  'home.card.done.finished': 'Finished {relative}',
  'home.card.done.review': 'Review changes',
  'home.card.joinedLate': 'Joined mid-voyage: changes before {time} are not counted.',
  'home.quiet.stale.line': 'Adrift since {time}: no activity since then.',
  'home.quiet.idle.line': 'Last turn ended at {time}. Waiting for the next order.',
  'home.quiet.reviewed.line': 'Reviewed at {time}. Leaves the grid at midnight.',
  'home.quiet.openTerminal': 'Open terminal',
  'home.quiet.open': 'Open',
  'tier.safe': 'Safe',
  'tier.caution': 'Caution',
  'tier.destructive': 'Destructive',
  'tier.question': 'Question'
})

const QUIET = new Set(['stale', 'idle', 'reviewed'])
const NEEDS = new Set(['needs_approval', 'asked_you'])
const MAX_STEPS = 3
const MAX_FILES = 6

/**
 * Which card presentation a session gets (home.md section 4.2, first match wins). `quiet` sessions
 * belong to the quiet row and `ended` ones to history.
 * @param {{ state: string, role?: string, runRef?: object | null }} session
 * @returns {'team'|'research'|'approval'|'question'|'crashed'|'done'|'solo-running'|'quiet'|'ended'}
 */
export function cardVariant(session) {
  if (session.role === 'lead' && session.runRef) return 'team'
  if (session.role === 'research') return 'research'
  if (session.state === 'needs_approval') return 'approval'
  if (session.state === 'asked_you') return 'question'
  if (session.state === 'crashed') return 'crashed'
  if (session.state === 'done') return 'done'
  if (QUIET.has(session.state)) return 'quiet'
  if (session.state === 'ended') return 'ended'
  return 'solo-running'
}

const sessionHref = id => `/s/${encodeURIComponent(id)}`
const domId = id => `card-title-${String(id).replace(/[^\w-]/g, '_')}`

function repoLabel(repo, session) {
  return repo?.name ?? String(session.repoId ?? '').split('/').filter(Boolean).at(-1) ?? ''
}

function clock(at, lang) {
  return Number.isFinite(at) ? new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at) : ''
}

function relative(ms, lang) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const format = new Intl.RelativeTimeFormat(lang, { numeric: 'always' })
  if (minutes < 60) return format.format(-minutes, 'minute')
  if (minutes < 1440) return format.format(-Math.round(minutes / 60), 'hour')
  return format.format(-Math.round(minutes / 1440), 'day')
}

/**
 * The card's one-line "now doing" from `session.activity` (02-domain.md section 2.2).
 * @param {string | null | undefined} activity
 * @param {(key: string, params?: object) => string} [t]
 * @returns {string | null}
 */
export function activityText(activity, t) {
  if (!activity) return null
  if (activity === 'compacting') return translate(t, CARD_COPY, 'home.card.activity.compacting')
  const subagents = /^subagents:(\d+)$/.exec(activity)
  if (subagents) return translate(t, CARD_COPY, 'home.card.activity.subagents', { n: Number(subagents[1]) })
  if (activity.startsWith('tool:')) return translate(t, CARD_COPY, 'home.card.activity.tool', { tool: shown(activity.slice(5)) })
  return null
}

function openRequestsOf(session, requests) {
  return requests
    .filter(request => request.sessionId === session.id && (request.state ?? 'open') === 'open')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

function CardHeader({ session, repo, title, t, now, navigate, size, pillVariant }) {
  const href = sessionHref(session.id)
  const shownTitle = titleText(title)
  return (
    <header className="card-header">
      <CrewAvatar seed={repo?.crewSeed ?? repoLabel(repo, session)} slot={repo?.crewSlot} pose={poseFor(session.state)} hat={repo?.hat ?? 'none'} size={size} />
      <div className="card-heading">
        <h3 className="card-title" id={domId(session.id)}>
          <a className="card-link" href={href} title={shownTitle} onClick={navigate ? linkHandler(navigate, href) : undefined}><bdi>{shownTitle}</bdi></a>
        </h3>
        <MetaLine className="card-meta" items={[shown(repoLabel(repo, session)), session.branch ? shown(session.branch) : null]} />
      </div>
      <StatusPill state={session.state} params={pillParams(session, now)} role={session.role} variant={pillVariant} t={t} />
    </header>
  )
}

function Steps({ steps }) {
  if (!steps?.length) return null
  return (
    <ol className="card-steps">
      {steps.slice(-MAX_STEPS).map((step, index) => (
        <li key={index} className={`card-step card-step--${step.tone ?? 'tool'}`}>
          <span className="card-step-glyph" aria-hidden="true">{step.glyph ?? '●'}</span>
          <span className="card-step-text">{shown(step.text)}</span>
        </li>
      ))}
    </ol>
  )
}

function RequestBox({ session, open, t, navigate }) {
  const [request] = open
  const question = request.kind === 'question'
  const tier = question ? 'question' : request.tier ?? 'caution'
  const more = open.length - 1
  const href = sessionHref(session.id)
  return (
    <div className={`request-box request-box--${question ? 'question' : 'permission'}`} data-request={request.id}>
      <p className="request-head">
        <span className={`tier-badge tier-badge--${tier}`}>{translate(t, CARD_COPY, `tier.${tier}`)}</span>
        {question ? null : <span className="request-verb">{translate(t, CARD_COPY, 'home.card.request.wantsToRun')}</span>}
      </p>
      {question
        ? <p className="request-question"><bdi>{titleText(request.summary)}</bdi></p>
        : <code className="request-command">{shown(request.summary)}</code>}
      <div className="request-actions">
        <span className="request-terminal">{translate(t, CARD_COPY, 'home.card.request.answerInTerminal')}</span>
        <a className="button button--ghost button--xs" href={href} onClick={navigate ? linkHandler(navigate, href) : undefined}>{translate(t, CARD_COPY, 'home.card.request.open')}</a>
      </div>
      {more > 0 ? <p className="request-more">{translate(t, CARD_COPY, 'home.card.request.more', { n: more })}</p> : null}
    </div>
  )
}

function FileChips({ session, t, navigate }) {
  const files = session.changedFiles ?? []
  if (!files.length) return null
  const base = `${sessionHref(session.id)}?tab=changes`
  return (
    <div className="card-files">
      <p className="eyebrow">{translate(t, CARD_COPY, 'home.card.files.eyebrow')}</p>
      <ul className="file-chips">
        {files.slice(0, MAX_FILES).map(file => {
          const href = `${base}&file=${encodeURIComponent(file.path)}`
          return (
            <li key={file.path}>
              <a className="file-chip" href={href} title={shown(file.path)} onClick={navigate ? linkHandler(navigate, href) : undefined}>
                <span className="file-name">{shown(String(file.path).split('/').at(-1))}</span>
                {file.adds ? <> <span className="diff-add">{`+${file.adds}`}</span></> : null}
                {file.dels ? <> <span className="diff-del">{`−${file.dels}`}</span></> : null}
              </a>
            </li>
          )
        })}
        {files.length > MAX_FILES ? <li><a className="file-chip file-chip--more" href={base} onClick={navigate ? linkHandler(navigate, base) : undefined}>{translate(t, CARD_COPY, 'home.card.files.more', { n: files.length - MAX_FILES })}</a></li> : null}
      </ul>
    </div>
  )
}

function crashLine(session, t) {
  const params = pillParams(session, 0)
  if (params.kind === 'lost') return translate(t, CARD_COPY, 'home.card.crashed.lost')
  if (params.kind === 'signal' && params.signal === 'SIGKILL') return translate(t, CARD_COPY, 'home.card.crashed.killed')
  if (params.kind === 'signal') return translate(t, CARD_COPY, 'home.card.crashed.signal', { signal: shown(params.signal) })
  return translate(t, CARD_COPY, 'home.card.crashed.exit', { code: shown(params.code) })
}

/**
 * SessionCard, comfortable density, observe-only (docs/deck/design/components.md section 10, home.md 4.2).
 * Every agent-supplied string renders as a text node: titles through `titleText` inside `<bdi>`,
 * commands, paths and branches through `shown`. Open requests say "Answer in your terminal"; M1 never answers.
 * @param {{ session: object, repo?: { name: string, crewSeed?: string, crewSlot?: number, hat?: string }, requests?: object[], steps?: { text: string, tone?: string, glyph?: string }[], now?: number, lang?: string, t?: (key: string, params?: object) => string, navigate?: (to: string) => void }} props
 */
export function SessionCard({ session, repo, requests = [], steps, now = Date.now(), lang = 'en', t, navigate }) {
  const variant = cardVariant(session)
  const tone = String(session.state).replace(/_/g, '-')
  const open = openRequestsOf(session, requests)
  const title = variant === 'crashed'
    ? translate(t, CARD_COPY, 'home.card.crashed.title', { repo: repoLabel(repo, session) })
    : session.task || translate(t, CARD_COPY, 'home.card.untitled')
  const now_ = activityText(session.activity, t)
  const changesHref = `${sessionHref(session.id)}?tab=changes`
  const classes = ['session-card', `session-card--${variant}`, `session-card--${tone}`]
  if (NEEDS.has(session.state)) classes.push('motion-pulse')
  return (
    <article className={classes.join(' ')} aria-labelledby={domId(session.id)}>
      <CardHeader session={session} repo={repo} title={title} t={t} now={now} navigate={navigate} size="md" pillVariant="pill" />
      <Steps steps={steps} />
      {now_ ? <p className="card-now">{now_}</p> : null}
      {open.length && NEEDS.has(session.state) ? <RequestBox session={session} open={open} t={t} navigate={navigate} /> : null}
      {variant === 'crashed' ? <p className="card-hint">{crashLine(session, t)}</p> : null}
      {variant === 'solo-running' || variant === 'done' ? <FileChips session={session} t={t} navigate={navigate} /> : null}
      {session.joinedMidLife ? <p className="card-note">{translate(t, CARD_COPY, 'home.card.joinedLate', { time: clock(session.startedAt, lang) })}</p> : null}
      {variant === 'solo-running' ? (
        <footer className="card-footer">
          <MetaLine className="card-footer-meta" items={[
            Number.isFinite(session.startedAt) ? compactDuration(now - session.startedAt) : null,
            Number.isFinite(session.toolCalls) ? translate(t, CARD_COPY, 'home.card.meta.toolCalls', { n: session.toolCalls }) : null
          ]} />
        </footer>
      ) : null}
      {variant === 'done' ? (
        <footer className="card-footer">
          <span className="card-footer-meta">{translate(t, CARD_COPY, 'home.card.done.finished', { relative: relative(now - (session.stateSince ?? now), lang) })}</span>
          <a className="button button--purple button--xs" href={changesHref} onClick={navigate ? linkHandler(navigate, changesHref) : undefined}>{translate(t, CARD_COPY, 'home.card.done.review')}</a>
        </footer>
      ) : null}
    </article>
  )
}

const QUIET_LINES = {
  stale: session => ['home.quiet.stale.line', session.lastActivityAt ?? session.stateSince],
  idle: session => ['home.quiet.idle.line', session.stateSince],
  reviewed: session => ['home.quiet.reviewed.line', session.reviewedAt ?? session.stateSince]
}

/**
 * QuietCard for the quiet row (components.md section 11, home.md 4.3): stale, idle or reviewed, one line, Open.
 * Observed sessions never get Nudge or Stop.
 * @param {{ session: object, repo?: object, now?: number, lang?: string, t?: (key: string, params?: object) => string, navigate?: (to: string) => void }} props
 */
export function QuietCard({ session, repo, now = Date.now(), lang = 'en', t, navigate }) {
  const line = QUIET_LINES[session.state]?.(session)
  const href = sessionHref(session.id)
  const openLabel = session.state === 'stale' && session.origin !== 'observed' ? 'home.quiet.openTerminal' : 'home.quiet.open'
  return (
    <article className={`quiet-card quiet-card--${session.state}`} aria-labelledby={domId(session.id)}>
      <CardHeader session={session} repo={repo} title={session.task || translate(t, CARD_COPY, 'home.card.untitled')} t={t} now={now} navigate={navigate} size="sm" pillVariant="text" />
      {line ? <p className="quiet-line">{translate(t, CARD_COPY, line[0], { time: clock(line[1], lang) })}</p> : null}
      <div className="quiet-actions">
        <a className="button button--ghost button--xs" href={href} onClick={navigate ? linkHandler(navigate, href) : undefined}>{translate(t, CARD_COPY, openLabel)}</a>
      </div>
    </article>
  )
}
