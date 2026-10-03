import React, { useEffect, useRef, useState } from 'react'
import { CrewAvatar, poseFor } from './CrewAvatar.jsx'
import { MetaLine, StatusPill, compactDuration, pillParams, shown, titleText, translate } from './StatusPill.jsx'
import { AnswerControls } from './AnswerControls.jsx'
import { linkHandler } from '../shell/Rail.jsx'
import { archiveFinished, archiveSession, unarchiveSession } from '../state/actions.js'

/**
 * English copy for the cards: docs/deck/screens/home.md section 9 and failures-and-loading.md section 4,
 * with the M3 answer and rule suggestion keys of home.md section 9.
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
  'home.card.request.deny': 'Deny',
  'home.card.request.allowOnce': 'Allow once',
  'home.card.request.reviewInDrawer': 'Review in Needs you',
  'home.card.request.didNotLand': 'Your answer did not reach {repo}. The prompt is still open in its terminal.',
  'home.card.request.tryAgain': 'Try again',
  'home.card.request.openTerminal': 'Open terminal',
  'home.card.request.deckdDown': 'deckd is reconnecting. Answer in your terminal for now.',
  'home.card.rule.short': 'Allowed {n} times. Always allow in {repo}?',
  'home.card.rule.anyFlags': 'Any flags.',
  'home.card.rule.added': 'Rule added to {repo}: {pattern}',
  'home.card.rule.undo': 'Undo',
  'home.card.question.reply.label': 'Reply to {repo}',
  'home.card.question.reply': 'Reply',
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
  'home.quiet.nudge': 'Nudge (send Enter)',
  'home.quiet.stop': 'Stop…',
  'home.quiet.deckdDown': 'deckd is reconnecting',
  'home.card.archive': 'Archive',
  'archive.toast.archived': 'Session archived',
  'archive.toast.restored': 'Session restored',
  'archive.toast.finished': 'Archived {n} finished sessions',
  'archive.toast.needsYou': 'This session needs you. Answer it first.',
  // No copy deck names a failure other than needs_you; the server's message follows the colon.
  'archive.toast.failed': 'Could not change the archive: {message}',
  'archive.toast.undo': 'Undo',
  'archive.toast.dismiss': 'Dismiss',
  'tier.safe': 'Safe',
  'tier.caution': 'Caution',
  'tier.destructive': 'Destructive',
  'tier.question': 'Question'
})

const QUIET = new Set(['stale', 'idle', 'reviewed'])
const NEEDS = new Set(['needs_approval', 'asked_you'])
const TURN = new Set(['running', 'starting'])
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

/**
 * The answer labels a card hands to {@link AnswerControls}, from the card copy (home.md section 9).
 * @param {(key: string, params?: object) => string} [t]
 * @returns {object}
 */
export function cardAnswerLabels(t) {
  const tr = key => translate(t, CARD_COPY, key)
  return {
    deny: tr('home.card.request.deny'), allowOnce: tr('home.card.request.allowOnce'), reviewInDrawer: tr('home.card.request.reviewInDrawer'),
    answerInTerminal: tr('home.card.request.answerInTerminal'), open: tr('home.card.request.open'), openTerminal: tr('home.card.request.openTerminal'),
    deckdDown: tr('home.card.request.deckdDown'), didNotLand: tr('home.card.request.didNotLand'), tryAgain: tr('home.card.request.tryAgain'),
    replyLabel: tr('home.card.question.reply.label'), replyPlaceholder: tr('home.card.question.reply.label'), reply: tr('home.card.question.reply')
  }
}

/**
 * The request as a card shows it: while the card holds an answer in flight (`busy`) and the server has not
 * reported a delivery yet, it already reads as `sending`, so the chosen button gets its spinner at once.
 * @param {object} request
 * @param {object | null | undefined} busy
 * @returns {object}
 */
export function withLocalDelivery(request, busy) {
  return busy && (request.delivery ?? 'idle') === 'idle' ? { ...request, delivery: 'sending' } : request
}

function RequestBox({ session, open, t, navigate, deckdDown, answers, onAnswer, onReview }) {
  const [request] = open
  const question = request.kind === 'question'
  const tier = question ? 'question' : request.tier ?? 'caution'
  const more = open.length - 1
  const href = sessionHref(session.id)
  const observed = session.origin === 'observed'
  const busy = answers?.[request.id] ?? null
  return (
    <div className={`request-box request-box--${question ? 'question' : 'permission'}`} data-request={request.id}>
      <p className="request-head">
        <span className={`tier-badge tier-badge--${tier}`}>{translate(t, CARD_COPY, `tier.${tier}`)}</span>
        {question ? null : <span className="request-verb">{translate(t, CARD_COPY, 'home.card.request.wantsToRun')}</span>}
      </p>
      {question
        ? <p className="request-question"><bdi>{titleText(request.summary)}</bdi></p>
        : <code className="request-command">{shown(request.summary)}</code>}
      {observed ? (
        <div className="request-actions">
          <span className="request-terminal">{translate(t, CARD_COPY, 'home.card.request.answerInTerminal')}</span>
          <a className="button button--ghost button--xs" href={href} onClick={navigate ? linkHandler(navigate, href) : undefined}>{translate(t, CARD_COPY, 'home.card.request.open')}</a>
        </div>
      ) : (
        <div className="request-answer">
          <AnswerControls request={withLocalDelivery(request, busy)} session={session} surface="card" deckd={{ down: !!deckdDown }} labels={cardAnswerLabels(t)} busy={busy}
            onAnswer={body => onAnswer(request, body)}
            onOpen={() => (!question && request.tier === 'destructive' ? onReview(request.id) : navigate?.(href))} />
        </div>
      )}
      {more > 0 ? <p className="request-more">{translate(t, CARD_COPY, 'home.card.request.more', { n: more })}</p> : null}
    </div>
  )
}

function RuleLines({ session, repo, offers, t, onAcceptRule }) {
  const mine = (offers ?? []).filter(offer => offer.repoId === session.repoId)
  if (!mine.length) return null
  return (
    <ul className="card-rules">
      {mine.map(offer => (
        <li key={offer.pattern} className="card-rule">
          <button type="button" className="card-rule-accept" onClick={() => onAcceptRule(offer)}>
            {translate(t, CARD_COPY, 'home.card.rule.short', { n: offer.count, repo: shown(repoLabel(repo, session)) })}
            {offer.ruleNote === 'anyFlags' ? <span className="card-rule-note">{` ${translate(t, CARD_COPY, 'home.card.rule.anyFlags')}`}</span> : null}
          </button>
        </li>
      ))}
    </ul>
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
 * SessionCard, comfortable density (docs/deck/design/components.md section 10, home.md 4.2).
 * Every agent-supplied string renders as a text node: titles through `titleText` inside `<bdi>`,
 * commands, paths and branches through `shown`. The oldest open request of a deck PTY session answers through
 * {@link AnswerControls} (`surface: 'card'`): Safe and Caution get "Deny" and "Allow once" (`onAnswer` with the
 * request and the AnswerBody), a question its options and Reply, and Destructive only "Review in Needs you",
 * which calls `onReview` with the request id. `answers` holds the AnswerBody in flight per request id;
 * `deckdDown` disables the buttons with "deckd is reconnecting. Answer in your terminal for now.". An observed
 * session keeps "Answer in your terminal" and an Open link, with no button. An approval card of a PTY session lists
 * the rule suggestions of its repo from `ruleOffers` ("Allowed {n} times. Always allow in {repo}?", plus
 * "Any flags." for `anyFlags`); a click calls `onAcceptRule` with the offer.
 * With `onArchive`, a session that is not running a turn (`running` or `starting`) gets "Archive" in its footer.
 * Pure: no hooks.
 * @param {{ session: object, repo?: { name: string, crewSeed?: string, crewSlot?: number, hat?: string }, requests?: object[], steps?: { text: string, tone?: string, glyph?: string }[], now?: number, lang?: string, t?: (key: string, params?: object) => string, navigate?: (to: string) => void, onArchive?: (session: object) => void,
 *   deckdDown?: boolean, answers?: Record<string, object>, onAnswer?: (request: object, body: object) => void, onReview?: (requestId: string) => void,
 *   ruleOffers?: { repoId: string, pattern: string, count: number, ruleNote?: string | null }[], onAcceptRule?: (offer: object) => void }} props
 */
export function SessionCard({ session, repo, requests = [], steps, now = Date.now(), lang = 'en', t, navigate, onArchive,
  deckdDown = false, answers = {}, onAnswer = () => {}, onReview = () => {}, ruleOffers = [], onAcceptRule = () => {} }) {
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
  const archive = onArchive && !TURN.has(session.state)
    ? <button type="button" className="button button--ghost button--xs card-archive" onClick={() => onArchive(session)}>{translate(t, CARD_COPY, 'home.card.archive')}</button>
    : null
  return (
    <article className={classes.join(' ')} aria-labelledby={domId(session.id)}>
      <CardHeader session={session} repo={repo} title={title} t={t} now={now} navigate={navigate} size="md" pillVariant="pill" />
      <Steps steps={steps} />
      {now_ ? <p className="card-now">{now_}</p> : null}
      {open.length && NEEDS.has(session.state) ? <RequestBox session={session} open={open} t={t} navigate={navigate} deckdDown={deckdDown} answers={answers} onAnswer={onAnswer} onReview={onReview} /> : null}
      {variant === 'approval' && session.origin !== 'observed' ? <RuleLines session={session} repo={repo} offers={ruleOffers} t={t} onAcceptRule={onAcceptRule} /> : null}
      {variant === 'crashed' ? <p className="card-hint">{crashLine(session, t)}</p> : null}
      {variant === 'solo-running' || variant === 'done' ? <FileChips session={session} t={t} navigate={navigate} /> : null}
      {session.joinedMidLife ? <p className="card-note">{translate(t, CARD_COPY, 'home.card.joinedLate', { time: clock(session.startedAt, lang) })}</p> : null}
      {variant === 'solo-running' ? (
        <footer className="card-footer">
          <MetaLine className="card-footer-meta" items={[
            Number.isFinite(session.startedAt) ? compactDuration(now - session.startedAt) : null,
            Number.isFinite(session.toolCalls) ? translate(t, CARD_COPY, 'home.card.meta.toolCalls', { n: session.toolCalls }) : null
          ]} />
          {archive}
        </footer>
      ) : null}
      {variant === 'done' ? (
        <footer className="card-footer">
          <span className="card-footer-meta">{translate(t, CARD_COPY, 'home.card.done.finished', { relative: relative(now - (session.stateSince ?? now), lang) })}</span>
          {archive}
          <a className="button button--purple button--xs" href={changesHref} onClick={navigate ? linkHandler(navigate, changesHref) : undefined}>{translate(t, CARD_COPY, 'home.card.done.review')}</a>
        </footer>
      ) : null}
      {archive && variant !== 'solo-running' && variant !== 'done' ? <footer className="card-footer card-footer--archive">{archive}</footer> : null}
    </article>
  )
}

const QUIET_LINES = {
  stale: session => ['home.quiet.stale.line', session.lastActivityAt ?? session.stateSince],
  idle: session => ['home.quiet.idle.line', session.stateSince],
  reviewed: session => ['home.quiet.reviewed.line', session.reviewedAt ?? session.stateSince]
}

/**
 * Whether a session runs in a live deckd PTY the deck can control: not observed, alive, with a PTY id.
 * @param {{ origin?: string, alive?: boolean, ptyId?: string | null }} session
 * @returns {boolean}
 */
export function controllable(session) {
  return session.origin !== 'observed' && !!session.alive && !!session.ptyId
}

/**
 * QuietCard for the quiet row (components.md section 11, home.md 4.3): stale, idle or reviewed, one line, Open.
 * A {@link controllable} session adds "Nudge (send Enter)" when stale and "Stop…" when idle, calling `onNudge`
 * or `onStop` with the session; both are disabled with the visible reason "deckd is reconnecting" while
 * `deckdDown`. Observed sessions never get Nudge or Stop. With `onArchive`, every quiet card adds "Archive".
 * @param {{ session: object, repo?: object, now?: number, lang?: string, t?: (key: string, params?: object) => string, navigate?: (to: string) => void,
 *   onNudge?: (session: object) => void, onStop?: (session: object) => void, deckdDown?: boolean, onArchive?: (session: object) => void }} props
 */
export function QuietCard({ session, repo, now = Date.now(), lang = 'en', t, navigate, onNudge = () => {}, onStop = () => {}, deckdDown = false, onArchive }) {
  const line = QUIET_LINES[session.state]?.(session)
  const href = sessionHref(session.id)
  const openLabel = session.state === 'stale' && session.origin !== 'observed' ? 'home.quiet.openTerminal' : 'home.quiet.open'
  const live = controllable(session)
  const control = live && session.state === 'stale' ? ['home.quiet.nudge', onNudge, 'button--amber-outline']
    : live && session.state === 'idle' ? ['home.quiet.stop', onStop, 'button--ghost'] : null
  const reasonId = `quiet-reason-${String(session.id).replace(/[^\w-]/g, '_')}`
  return (
    <article className={`quiet-card quiet-card--${session.state}`} aria-labelledby={domId(session.id)}>
      <CardHeader session={session} repo={repo} title={session.task || translate(t, CARD_COPY, 'home.card.untitled')} t={t} now={now} navigate={navigate} size="sm" pillVariant="text" />
      {line ? <p className="quiet-line">{translate(t, CARD_COPY, line[0], { time: clock(line[1], lang) })}</p> : null}
      <div className="quiet-actions">
        <a className="button button--ghost button--xs" href={href} onClick={navigate ? linkHandler(navigate, href) : undefined}>{translate(t, CARD_COPY, openLabel)}</a>
        {control ? (
          <button type="button" className={`button ${control[2]} button--xs`} disabled={deckdDown} aria-describedby={deckdDown ? reasonId : undefined}
            onClick={() => control[1](session)}>{translate(t, CARD_COPY, control[0])}</button>
        ) : null}
        {onArchive ? <button type="button" className="button button--ghost button--xs card-archive" onClick={() => onArchive(session)}>{translate(t, CARD_COPY, 'home.card.archive')}</button> : null}
      </div>
      {control && deckdDown ? <p className="quiet-reason" id={reasonId}>{translate(t, CARD_COPY, 'home.quiet.deckdDown')}</p> : null}
    </article>
  )
}

/** How long an archive toast stays, with its Undo, in ms (the crew sheet's Undo toast also lasts 6 s). */
export const ARCHIVE_TOAST_MS = 6000

/**
 * Whether a session is archived. Archived: `sessions.archived_at` is not null.
 * @param {{ archivedAt?: number | null }} session
 * @returns {boolean}
 */
export function isArchived(session) {
  return session?.archivedAt != null
}

/**
 * The archive actions behind every Archive and Unarchive button: each calls its helper from `actions.js`, then
 * shows a toast through `show`. "Session archived" and "Session restored" carry an `undo` that calls the opposite
 * helper; "Archived {n} finished sessions" carries one that unarchives exactly the ids the server archived. The
 * toast an undo shows has no undo of its own. A 409 `needs_you` shows "This session needs you. Answer it first."
 * and changes nothing. No confirm dialog: archive is reversible.
 * @param {{ api: { post: Function }, show: (toast: { tone: 'success'|'error', text: string, undo?: { action: 'archive'|'unarchive', ids: string[] } }) => void, t?: Function }} options
 * @returns {{ archive: (id: string) => Promise<void>, unarchive: (id: string) => Promise<void>, archiveFinished: () => Promise<void>, undo: (undo: { action: string, ids: string[] }) => Promise<void> }}
 */
export function archiveFlow({ api, show, t }) {
  const text = (key, params) => translate(t, CARD_COPY, key, params)
  const fail = error => show({ tone: 'error', text: error?.status === 409 && error?.code === 'needs_you'
    ? text('archive.toast.needsYou')
    : text('archive.toast.failed', { message: error?.message ?? error?.code ?? 'failed' }) })
  const run = (work, toast) => work().then(result => show(toast(result)), fail)
  return {
    archive: id => run(() => archiveSession(api, id), () => ({ tone: 'success', text: text('archive.toast.archived'), undo: { action: 'unarchive', ids: [id] } })),
    unarchive: id => run(() => unarchiveSession(api, id), () => ({ tone: 'success', text: text('archive.toast.restored'), undo: { action: 'archive', ids: [id] } })),
    archiveFinished: () => run(() => archiveFinished(api), body => {
      const ids = Array.isArray(body?.ids) ? body.ids : []
      return { tone: 'success', text: text('archive.toast.finished', { n: ids.length }), undo: { action: 'unarchive', ids } }
    }),
    undo: ({ action, ids }) => run(async () => {
      for (const id of ids) await (action === 'archive' ? archiveSession : unarchiveSession)(api, id)
    }, () => ({ tone: 'success', text: text(action === 'archive' ? 'archive.toast.archived' : 'archive.toast.restored') }))
  }
}

/**
 * The archive toast a screen holds: the latest toast from {@link archiveFlow}, cleared after {@link ARCHIVE_TOAST_MS}.
 * @returns {[object | null, (toast: object | null) => void]}
 */
export function useArchiveToast() {
  const [toast, setToast] = useState(null)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = next => {
    clearTimeout(timer.current)
    setToast(next)
    if (next) timer.current = setTimeout(() => setToast(null), ARCHIVE_TOAST_MS)
  }
  return [toast, show]
}

/**
 * The archive toast: its text, Undo when it has one, and Dismiss. An error is an alert, a success a status.
 * @param {{ toast: { tone: string, text: string, undo?: object } | null, t?: Function, onUndo: (undo: object) => void, onDismiss: () => void }} props
 */
export function ArchiveToast({ toast, t, onUndo, onDismiss }) {
  if (!toast) return null
  return (
    <div className={`archive-toast archive-toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <p className="archive-toast-text">{toast.text}</p>
      {toast.undo ? <button type="button" className="button button--xs" onClick={() => onUndo(toast.undo)}>{translate(t, CARD_COPY, 'archive.toast.undo')}</button> : null}
      <button type="button" className="button button--ghost button--xs" onClick={onDismiss}>{translate(t, CARD_COPY, 'archive.toast.dismiss')}</button>
    </div>
  )
}
