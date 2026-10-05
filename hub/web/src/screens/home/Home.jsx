import React, { useEffect, useRef, useState } from 'react'
import { ArchiveToast, CARD_COPY, QuietCard, SessionCard, archiveFlow, controllable, isArchived, useArchiveToast } from '../../components/SessionCard.jsx'
import { COMPACT_STEPS, CompactCard } from '../../components/CompactCard.jsx'
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx'
import { Counts } from '../../components/Counts.jsx'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { NoteChip } from '../../components/NoteChip.jsx'
import { MetaLine, StatusPill, pillParams, shown, stateLabel, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { addRule, answerRequest, fetchArchived, fetchMeeting, fetchMeetings, fetchCaptures, fetchMisses, nudgeSession, revokeRule, stopSession } from '../../state/actions.js'
import { clockTime, dayLabel, durationText, meetingTitle } from '../meetings/MeetingDetail.jsx'
import { archivedCount, readDensity, writeDensity } from '../../state/deck-store.js'
import { NeedsYouDrawer, deckApi, needsLinkDetail, openOverlay, repoFor } from '../drawer/NeedsYouDrawer.jsx'
import { Palette, openLaunch, orderSessions } from '../palette/Palette.jsx'

/** English copy for Home (docs/deck/screens/home.md section 9): M1 plus the M2 header, compact and Stop keys, and the M4 Calm "Last meeting". */
export const HOME_COPY = Object.freeze({
  'home.header.title': 'Sessions',
  'home.header.search': 'Search, ask or run',
  'home.header.density.label': 'Density',
  'home.header.density.comfortable': 'Comfortable',
  'home.header.density.compact': 'Compact',
  'home.header.launch': 'Launch a ship',
  'home.stop.title': 'Stop {repo} · {task}?',
  'home.stop.body': 'The process gets SIGTERM, then SIGKILL after 5 s. Uncommitted changes stay in the working tree.',
  'home.stop.confirm': 'Stop session',
  'home.stop.cancel': 'Cancel',
  'home.stop.failed': 'Could not stop {repo}: {message}',
  'home.grid.label': 'Active sessions',
  'home.quiet.strip.label': 'Quiet sessions',
  'home.quiet.strip.more': '+{n} more',
  'home.quiet.strip.name': '{repo} · {task}, {state}',
  'home.calm.headline': 'Calm seas. No ships out.',
  'home.calm.subtitle.day': '{weekday} {dayPart}',
  'home.calm.subtitle.state': 'nothing running, nothing adrift',
  'home.calm.subtitle.rest': 'the crew is resting',
  'home.calm.dayPart.morning': 'morning',
  'home.calm.dayPart.afternoon': 'afternoon',
  'home.calm.dayPart.evening': 'evening',
  'home.calm.dayPart.night': 'night',
  'home.calm.log.openLoops': 'Open loops before tomorrow',
  'home.calm.log.waitsForReview': '{repo} waits in port for review',
  'home.calm.log.review': 'Review',
  'home.calm.meeting.title': 'Last meeting',
  'home.calm.meeting.meta': '{day} {time} · {duration} · {n, plural, one {# action item} other {# action items}}',
  'home.calm.meeting.launch': 'Launch as session',
  'home.calm.meeting.empty': 'No meetings today.',
  'home.card.team.pill': '{needs} of {total} need you',
  'home.card.team.tile.lead': 'lead · {taskId}',
  'home.card.team.tile.needs': '{taskId} · needs you',
  'home.card.team.tile.done': '{taskId} · done',
  'home.card.team.tile.running': '{taskId} · running',
  'home.card.team.review': 'Review {n}',
  'home.card.team.moreTiles': '+{n}',
  'home.card.team.phase': 'Phase {n}',
  'home.card.team.tasks': 'Tasks {done}/{total}',
  'home.card.team.gatePassed': 'Gate {n} passed',
  'home.card.team.gateFailed': 'Gate {n} failed',
  'home.card.team.statusUnreadable': 'status.json unreadable, retrying',
  'home.card.team.ask': 'task {taskId} · {summary}',
  'home.card.team.moreRequests': '+{n} more',
  'home.archive.finished': 'Archive all finished',
  'home.archived.toggle': 'Archived ({n})',
  'home.archived.label': 'Archived sessions',
  'home.archived.when': 'archived {relative}',
  'home.archived.auto': 'archived automatically',
  'home.archived.owner': 'archived by you',
  'home.archived.open': 'Open',
  'home.archived.unarchive': 'Unarchive',
  'home.archived.more': 'Show more',
  'home.archived.loading': 'Loading archived sessions',
  'home.archived.failed': 'Could not load archived sessions.'
})

/** Longest a reorder waits while the pointer is over the grid or focus is in a card (home.md 7.2). */
export const HOLD_MS = 5000
/** Crew tiles a team card shows before "+N" (home.md 5). */
export const TEAM_TILES = 5

const sameOrder = (a, b) => a.length === b.length && a.every((id, index) => id === b[index])

/**
 * The order the grid shows (home.md 7.2, 7.3, Home AC4): while `held` (pointer over the grid or focus in a
 * card) a new order waits, for at most {@link HOLD_MS} after it arrived, then applies. Pure: the caller keeps
 * `{ shown, since }` between renders and re-renders at `wakeAt`.
 * @param {string[]} live the store's order
 * @param {{ held: boolean, shown?: string[] | null, since?: number | null }} memo
 * @param {number} now
 * @returns {{ order: string[], shown: string[], since: number | null, wakeAt: number | null }}
 */
export function heldOrder(live, { held, shown = null, since = null }, now) {
  if (!held || !shown || sameOrder(live, shown)) return { order: live, shown: live, since: null, wakeAt: null }
  const start = since ?? now
  if (now - start >= HOLD_MS) return { order: live, shown: live, since: null, wakeAt: null }
  return { order: shown, shown, since: start, wakeAt: start + HOLD_MS }
}

const RANK = { needs_approval: 0, asked_you: 1, crashed: 2, starting: 3, running: 3, done: 4, stale: 5, idle: 6, reviewed: 7, ended: 8 }
const NEEDS = new Set(['needs_approval', 'asked_you'])
const QUIET_TASKS = new Set(['pending', 'skipped', 'cancelled'])
const sameRun = (ref, run) => !!ref && ref.repoId === run.repoId && ref.runId === run.runId

/**
 * One team card per active run in the snapshot (home.md 4.2 `team`, Home AC19): tiles for the lead and the
 * started tasks, the run's open requests, its phase, tasks and latest gate. Requests belong to a run through
 * its lead or teammate sessions; a tile needs you when a request names its task or its teammate needs you.
 * @param {object[]} runs
 * @param {object[]} sessions
 * @param {object[]} requests
 * @returns {object[]}
 */
export function teamCards(runs = [], sessions = [], requests = []) {
  return (runs ?? []).map(run => {
    const members = sessions.filter(row => sameRun(row.runRef, run) || row.id === run.leadSessionId)
    const lead = members.find(row => row.id === run.leadSessionId) ?? members.find(row => row.role === 'lead') ?? null
    const ids = new Set(members.map(row => row.id))
    const open = requests.filter(row => (row.state ?? 'open') === 'open' && ids.has(row.sessionId))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)))
    const needs = taskId => open.some(row => row.taskId === taskId) || members.some(row => row.runRef?.taskId === taskId && row.role !== 'lead' && NEEDS.has(row.state))
    const tiles = []
    if (lead?.runRef?.taskId) tiles.push({ key: 'lead', kind: 'lead', taskId: lead.runRef.taskId })
    for (const mate of run.teammates ?? []) {
      if (needs(mate.taskId)) tiles.push({ key: mate.taskId, kind: 'needs', taskId: mate.taskId })
      else if (mate.state === 'done') tiles.push({ key: mate.taskId, kind: 'done', taskId: mate.taskId })
      else if (!QUIET_TASKS.has(mate.state)) tiles.push({ key: mate.taskId, kind: 'running', taskId: mate.taskId })
    }
    // The lead needs you for its own requests (no task id), or by state when it has no open request at all;
    // requests it carries for a task are counted on that task's tile.
    const leadOpen = lead ? open.filter(row => row.sessionId === lead.id) : []
    const leadNeeds = !!lead && (leadOpen.some(row => !row.taskId) || NEEDS.has(lead.state) && !leadOpen.length)
    const needing = tiles.filter(tile => tile.kind === 'needs').length + (leadNeeds ? 1 : 0)
    const waits = open.length ? open.map(row => row.kind === 'question' ? 'asked_you' : 'needs_approval') : members.filter(row => NEEDS.has(row.state)).map(row => row.state)
    const state = open.length || needing ? (waits.length && !waits.includes('needs_approval') ? 'asked_you' : 'needs_approval')
      : lead?.state === 'crashed' ? 'crashed' : 'running'
    const tasks = run.tasks ?? []
    const gate = Object.values(run.gates ?? {}).filter(row => Number.isFinite(row?.phase)).sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0))[0] ?? null
    return {
      key: `${run.repoId}\u0000${run.runId}`, run, lead, state, tiles, requests: open, needs: needing,
      total: Math.max(tiles.filter(tile => tile.kind !== 'lead').length + (lead ? 1 : 0), 1),
      tasksDone: tasks.filter(task => task.state === 'done').length, tasksTotal: tasks.length, gate
    }
  })
}

function teamDomId(team) {
  return `card-title-team-${`${team.run.repoId}-${team.run.runId}`.replace(/[^\w-]/g, '_')}`
}

function TeamCard({ team, repo, t, navigate, onReview }) {
  const { run, lead } = team
  const title = titleText(lead?.task || run.runId)
  const href = `/runs/${encodeURIComponent(repo.name)}/${encodeURIComponent(run.runId)}`
  const tiles = team.tiles.length > TEAM_TILES ? team.tiles.slice(0, TEAM_TILES - 1) : team.tiles
  const hidden = team.tiles.length - tiles.length
  const pill = team.needs
    ? translate(t, HOME_COPY, 'home.card.team.pill', { needs: team.needs, total: team.total })
    : undefined
  const gate = team.gate ? translate(t, HOME_COPY, team.gate.verdict === 'PASS' ? 'home.card.team.gatePassed' : 'home.card.team.gateFailed', { n: team.gate.phase }) : null
  const classes = ['session-card', 'session-card--team', `session-card--${String(team.state).replace(/_/g, '-')}`]
  if (NEEDS.has(team.state)) classes.push('motion-pulse')
  return (
    <article className={classes.join(' ')} aria-labelledby={teamDomId(team)}>
      <header className="card-header">
        <CrewAvatar seed={repo.crewSeed} slot={repo.crewSlot} pose={poseFor(team.state)} team size="md" />
        <div className="card-heading">
          <h3 className="card-title" id={teamDomId(team)}>
            <a className="card-link" href={href} title={title} onClick={linkHandler(navigate, href)}><bdi>{title}</bdi></a>
          </h3>
          <p className="card-meta">{shown(repo.name)}</p>
        </div>
        <StatusPill state={team.state} label={pill} t={t} />
      </header>
      {run.readError ? <p className="card-hint">{translate(t, HOME_COPY, 'home.card.team.statusUnreadable')}</p> : (
        <>
          <ul className="team-tiles">
            {tiles.map(tile => <li key={tile.key} className={`team-tile team-tile--${tile.kind}`}>{translate(t, HOME_COPY, `home.card.team.tile.${tile.kind}`, { taskId: shown(tile.taskId) })}</li>)}
            {hidden > 0 ? <li className="team-tile team-tile--more">{translate(t, HOME_COPY, 'home.card.team.moreTiles', { n: hidden })}</li> : null}
          </ul>
          {Number.isFinite(run.derivedPhase) ? <p className="team-phase">{translate(t, HOME_COPY, 'home.card.team.phase', { n: run.derivedPhase })}</p> : null}
        </>
      )}
      {team.requests.length ? (
        <div className="request-box request-box--team">
          <ul className="team-asks">
            {team.requests.slice(0, 2).map(request => (
              <li key={request.id} className="team-ask">
                <span className={`tier-badge tier-badge--${request.kind === 'question' ? 'question' : request.tier ?? 'caution'}`}>{translate(t, CARD_COPY, `tier.${request.kind === 'question' ? 'question' : ['safe', 'caution', 'destructive'].includes(request.tier) ? request.tier : 'caution'}`)}</span>
                <code className="request-command">{request.taskId ? translate(t, HOME_COPY, 'home.card.team.ask', { taskId: shown(request.taskId), summary: shown(request.summary) }) : shown(request.summary)}</code>
              </li>
            ))}
          </ul>
          {team.requests.length > 2 ? <p className="request-more">{translate(t, HOME_COPY, 'home.card.team.moreRequests', { n: team.requests.length - 2 })}</p> : null}
          <button type="button" className="button button--amber-outline button--xs" onClick={() => onReview(team.requests[0].id)}>{translate(t, HOME_COPY, 'home.card.team.review', { n: team.requests.length })}</button>
        </div>
      ) : null}
      <footer className="card-footer">
        <MetaLine className="card-footer-meta" items={[translate(t, HOME_COPY, 'home.card.team.tasks', { done: team.tasksDone, total: team.tasksTotal }), gate]} />
      </footer>
    </article>
  )
}

// Team cards take their place in the urgency order by their aggregate state, ahead of equal-rank sessions.
function withTeams(grid, teams) {
  const items = grid.map(session => ({ session }))
  for (const team of teams) {
    const index = items.findIndex(item => (RANK[item.session?.state ?? item.team.state] ?? 9) > (RANK[team.state] ?? 9) || item.session && (RANK[item.session.state] ?? 9) === (RANK[team.state] ?? 9))
    items.splice(index < 0 ? items.length : index, 0, { team })
  }
  return items
}

/** Home sessions at which crowded mode starts (D-18). */
export const CROWDED_AT = 10
/** Crowded mode ends only at this many Home sessions or fewer (hysteresis, HOME-O7). */
export const CROWDED_LEAVE_AT = 8
/** Quiet sessions the quiet row holds before the strip takes over. */
export const QUIET_MAX = 3
/** Chips the quiet strip shows before "+N more". */
export const STRIP_MAX = 12

const QUIET = ['stale', 'idle', 'reviewed']
const CALM_BLOCKERS = new Set(['starting', 'running', 'needs_approval', 'asked_you', 'crashed', 'stale'])
const STRIP = ['stale', 'done', 'idle', 'reviewed']

function midnight(now) {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

const byStateThenNewest = states => (a, b) => states.indexOf(a.state) - states.indexOf(b.state) || (b.stateSince ?? 0) - (a.stateSince ?? 0) || String(a.id).localeCompare(String(b.id))

/**
 * Split sessions into the Home presentation (home.md 4, 5.6, 5.7): calm or grid, normal or crowded, the
 * main grid in urgency order, the quiet row (stale, idle, reviewed; at most {@link QUIET_MAX}) or, when
 * crowded, the strip (stale, done, idle, reviewed). Ended and archived sessions, a run's teammates and sessions
 * reviewed before local midnight never show.
 * @param {object[]} sessions
 * @param {{ order?: string[], requests?: object[], now?: number, crowdedBefore?: boolean }} [options]
 * @returns {{ calm: boolean, crowded: boolean, grid: object[], quiet: object[], strip: object[], count: number }}
 */
export function homeLayout(sessions, { order = [], requests = [], now = Date.now(), crowdedBefore = false } = {}) {
  const start = midnight(now)
  const visible = orderSessions(sessions, order, requests).filter(row => row.state !== 'ended' && !isArchived(row) && row.role !== 'teammate' &&
    !(row.state === 'reviewed' && (row.reviewedAt ?? row.stateSince ?? now) < start))
  const quietAll = visible.filter(row => QUIET.includes(row.state))
  const count = visible.length
  const crowded = count >= CROWDED_AT || quietAll.length > QUIET_MAX || (crowdedBefore && count > CROWDED_LEAVE_AT)
  const calm = !visible.some(row => CALM_BLOCKERS.has(row.state))
  const active = visible.filter(row => !QUIET.includes(row.state))
  if (!crowded) return { calm, crowded, grid: active, quiet: quietAll.sort(byStateThenNewest(QUIET)).slice(0, QUIET_MAX), strip: [], count }
  return { calm, crowded, grid: active.filter(row => row.state !== 'done'), quiet: [], strip: visible.filter(row => STRIP.includes(row.state)).sort(byStateThenNewest(STRIP)), count }
}

/**
 * Part of day for the calm subtitle (home.md 5.10).
 * @param {number} hour local hour 0 to 23
 * @returns {'morning'|'afternoon'|'evening'|'night'}
 */
export function dayPart(hour) {
  if (hour >= 5 && hour <= 11) return 'morning'
  if (hour >= 12 && hour <= 17) return 'afternoon'
  if (hour >= 18 && hour <= 22) return 'evening'
  return 'night'
}

/** Home card densities, in the order the header's radiogroup lists them (home.md 4.1). */
export const DENSITIES = Object.freeze(['comfortable', 'compact'])
// deckd health states that are an outage (the rule `bannerFor` and Focus use).
const OUTAGE = new Set(['down', 'reconnecting'])

/**
 * Pick a density: remember it through the storage helper (`deck.density`) and show it.
 * @param {Storage | undefined} storage
 * @param {'comfortable' | 'compact'} value
 * @param {(value: string) => void} set
 */
export function pickDensity(storage, value, set) {
  writeDensity(storage, value)
  set(value)
}

/**
 * Whether deckd is in an outage, from its health row: a down state, or a probe in flight while an outage lasts.
 * @param {object} state
 * @returns {boolean}
 */
export function deckdDownOf(state) {
  const row = (state.data.health ?? []).find(item => item.dep === 'deckd')
  return !!row && (OUTAGE.has(row.state) || row.state === 'checking' && !!state.deckdOutage)
}

/**
 * The compact grid's cards in urgency order: every Home session (the grid, then the quiet row or strip) with each
 * run's team card in place of its lead.
 * @param {ReturnType<typeof homeLayout>} shape
 * @param {object[]} teams from {@link teamCards}
 * @returns {({ session: object } | { team: object })[]}
 */
export function compactEntries(shape, teams) {
  const leads = new Set(teams.map(team => team.lead?.id).filter(Boolean))
  const rest = shape.crowded ? shape.strip : shape.quiet
  return withTeams([...shape.grid, ...rest.filter(row => !shape.grid.includes(row))].filter(row => !leads.has(row.id)), teams)
}

/**
 * The session ids Home subscribes to with `subscribeTails`: the controllable PTY sessions (and team leads) of the
 * compact grid; none outside compact, which clears the set.
 * @param {'comfortable' | 'compact'} density
 * @param {ReturnType<typeof homeLayout>} shape
 * @param {object[]} teams
 * @returns {string[]}
 */
export function tailSubscription(density, shape, teams) {
  if (density !== 'compact') return []
  return compactEntries(shape, teams).map(item => item.session ?? item.team.lead).filter(row => row && controllable(row)).map(row => row.id)
}

/**
 * The quiet-row actions, kept out of the component so their order is testable: "Stop…" only opens the dialog,
 * confirming closes it and posts the stop (a failure toasts "Could not stop {repo}: {message}"), and Nudge posts
 * at once.
 * @param {{ api: { post: Function }, setStopping: (session: object | null) => void, toast: (toast: { tone: string, title: string }) => void,
 *   repoName: (session: object) => string, t?: Function }} options
 * @returns {{ openStop: (session: object) => void, cancelStop: () => void, confirmStop: (session: object) => Promise<void>, nudge: (session: object) => Promise<void> }}
 */
export function homeActions({ api, setStopping, toast, repoName, t }) {
  return {
    openStop: session => setStopping(session),
    cancelStop: () => setStopping(null),
    async confirmStop(session) {
      setStopping(null)
      try {
        await stopSession(api, session.id)
      } catch (error) {
        toast({ tone: 'error', title: translate(t, HOME_COPY, 'home.stop.failed', { repo: shown(repoName(session)), message: error?.message ?? error?.code ?? 'failed' }) })
      }
    },
    nudge: session => nudgeSession(api, session.id).then(() => {}, () => {})
  }
}

/**
 * The card answer and rule calls Home holds (home.md 6): `answer` keeps the AnswerBody in flight for the card
 * through `setAnswers` (so the chosen button shows its spinner) and posts it with `answerRequest`; a refused
 * answer drops it again. `acceptRule` adds the offered rule with `source: 'suggested'` and shows
 * "Rule added to {repo}: {pattern}" with an Undo; `undo` removes that rule as an undo (`?undo=1`).
 * @param {{ api: object, setAnswers: (next: Record<string, object> | ((map: Record<string, object>) => Record<string, object>)) => void,
 *   show: (toast: { tone: string, text: string, undo?: { repoKey: string, pattern: string } } | null) => void, repos?: object[], t?: Function }} options
 * @returns {{ answer: (request: object, body: object) => Promise<void>, acceptRule: (offer: object) => Promise<void>, undo: (undo: { repoKey: string, pattern: string }) => Promise<void> }}
 */
export function homeAnswerActions({ api, setAnswers, show, repos = [], t }) {
  const drop = id => setAnswers(map => {
    const next = { ...map }
    delete next[id]
    return next
  })
  return {
    answer(request, body) {
      setAnswers(map => ({ ...map, [request.id]: body }))
      return answerRequest(api, request.id, body).then(() => {}, () => drop(request.id))
    },
    acceptRule(offer) {
      const row = (repos ?? []).find(item => item.id === offer.repoId)
      const name = repoFor(repos, offer.repoId).name
      const repoKey = row?.repoKey ?? name
      return addRule(api, { repoKey, pattern: offer.pattern, source: 'suggested' }).then(reply => {
        const pattern = reply?.rule?.pattern ?? offer.pattern
        show({ tone: 'success', text: translate(t, CARD_COPY, 'home.card.rule.added', { repo: shown(name), pattern: shown(pattern) }), undo: { repoKey, pattern } })
      }, () => {})
    },
    undo(undo) {
      show(null)
      return revokeRule(api, undo.repoKey, undo.pattern, { undo: true }).then(() => {}, () => {})
    }
  }
}

/**
 * The answers in flight that still matter: those of requests that are still open (a request that did not land
 * stays open, so its body is kept for "Try again").
 * @param {Record<string, object>} answers
 * @param {object[]} requests
 * @returns {Record<string, object>}
 */
export function pruneAnswers(answers, requests) {
  const open = new Set((requests ?? []).filter(row => (row.state ?? 'open') === 'open').map(row => row.id))
  return Object.fromEntries(Object.entries(answers ?? {}).filter(([id]) => open.has(id)))
}

/**
 * The quiet-row Stop dialog Home holds: null while nothing is `stopping`, else a danger {@link ConfirmDialog}
 * titled "Stop {repo} · {task}?" whose Confirm calls `actions.confirmStop` for that session and whose Cancel
 * calls `actions.cancelStop`. Pure: it returns the element and runs no hooks itself.
 * @param {{ stopping: object | null, repos?: object[], actions: ReturnType<typeof homeActions>, t?: Function }} props
 */
export function HomeStopDialog({ stopping, repos, actions, t }) {
  if (!stopping) return null
  const repo = repoFor(repos, stopping.repoId).name
  return (
    <ConfirmDialog title={translate(t, HOME_COPY, 'home.stop.title', { repo: shown(repo), task: stopping.task || translate(t, CARD_COPY, 'home.card.untitled') })}
      body={translate(t, HOME_COPY, 'home.stop.body')} confirmLabel={translate(t, HOME_COPY, 'home.stop.confirm')} cancelLabel={translate(t, HOME_COPY, 'home.stop.cancel')}
      tone="danger" onConfirm={() => actions.confirmStop(stopping)} onCancel={actions.cancelStop} t={t} />
  )
}

function DensityControl({ density, onDensity, t }) {
  const label = translate(t, HOME_COPY, 'home.header.density.label')
  const pick = value => { if (value !== density) onDensity(value) }
  return (
    <div className="segmented home-density" role="radiogroup" aria-label={label}>
      {DENSITIES.map((value, index) => (
        <button key={value} type="button" role="radio" className="segmented-option" aria-checked={value === density ? 'true' : 'false'} tabIndex={value === density ? 0 : -1}
          onClick={() => pick(value)}
          onKeyDown={event => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
            if (!step) return
            event.preventDefault()
            const next = (index + step + DENSITIES.length) % DENSITIES.length
            pick(DENSITIES[next])
            globalThis.document?.activeElement?.parentElement?.children?.[next]?.focus?.()
          }}>{translate(t, HOME_COPY, `home.header.density.${value}`)}</button>
      ))}
    </div>
  )
}

const sessionHref = id => `/s/${encodeURIComponent(id)}`
const cardDomId = id => `card-title-${String(id).replace(/[^\w-]/g, '_')}`

function focusCard(id) {
  const link = globalThis.document?.getElementById(cardDomId(id))?.querySelector('a')
  link?.scrollIntoView?.({ block: 'nearest' })
  link?.focus()
}

function StripChip({ session, repo, now, t, navigate }) {
  const href = session.state === 'done' ? `${sessionHref(session.id)}?tab=changes` : sessionHref(session.id)
  const task = titleText(session.task || translate(t, CARD_COPY, 'home.card.untitled'))
  const name = translate(t, HOME_COPY, 'home.quiet.strip.name', { repo: shown(repo.name), task, state: stateLabel(session.state, pillParams(session, now), t) })
  return (
    <li>
      <a className="strip-chip" href={href} aria-label={name} onClick={linkHandler(navigate, href)}>
        <CrewAvatar seed={repo.crewSeed} slot={repo.crewSlot} pose={poseFor(session.state)} hat={repo.hat} size="sm" />
        <span className="strip-chip-text"><bdi>{`${shown(repo.name)} · ${task}`}</bdi></span>
        <StatusPill state={session.state} params={pillParams(session, now)} variant="text" t={t} />
      </a>
    </li>
  )
}

/**
 * The sessions "Archive all finished" would archive, as the client sees them. Finished: `alive` is false and the
 * session has no open request; it also has no unreviewed changes (an empty `changedFiles`) and is not archived.
 * @param {object[]} sessions
 * @param {object[]} [requests]
 * @returns {string[]}
 */
export function finishedIds(sessions = [], requests = []) {
  const asking = new Set((requests ?? []).filter(row => (row.state ?? 'open') === 'open').map(row => row.sessionId))
  return (sessions ?? []).filter(row => !row.alive && !asking.has(row.id) && !(row.changedFiles?.length) && !isArchived(row)).map(row => row.id)
}

const ARCHIVED_OPEN_KEY = 'deck.archivedOpen'
/** Archived sessions one page of the Archived list fetches. */
export const ARCHIVED_PAGE = 20

/**
 * Whether the Archived list is expanded in this browser, from `localStorage` `deck.archivedOpen` (closed by
 * default; a storage that throws reads as closed).
 * @param {Storage | undefined} storage
 * @returns {boolean}
 */
export function readArchivedOpen(storage) {
  try {
    return storage?.getItem(ARCHIVED_OPEN_KEY) === 'open'
  } catch {
    return false
  }
}

/**
 * Remember whether the Archived list is expanded; storage errors are ignored.
 * @param {Storage | undefined} storage
 * @param {boolean} open
 */
export function writeArchivedOpen(storage, open) {
  try { storage?.setItem(ARCHIVED_OPEN_KEY, open ? 'open' : 'closed') } catch {}
}

function ago(ms, lang) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const format = new Intl.RelativeTimeFormat(lang, { numeric: 'always' })
  if (minutes < 60) return format.format(-minutes, 'minute')
  if (minutes < 1440) return format.format(-Math.round(minutes / 60), 'hour')
  return format.format(-Math.round(minutes / 1440), 'day')
}

function ArchivedRow({ row, repos, now, lang, t, navigate, onUnarchive }) {
  const href = sessionHref(row.id)
  const title = titleText(row.task || translate(t, CARD_COPY, 'home.card.untitled'))
  const by = row.archivedBy === 'auto' ? 'home.archived.auto' : 'home.archived.owner'
  return (
    <li className="archived-row">
      <span className="archived-row-text">
        <span className="archived-row-title"><bdi>{title}</bdi></span>
        <MetaLine className="archived-row-meta" items={[shown(repoFor(repos, row.repoId).name),
          Number.isFinite(row.archivedAt) ? translate(t, HOME_COPY, 'home.archived.when', { relative: ago(now - row.archivedAt, lang) }) : null,
          translate(t, HOME_COPY, by)]} />
      </span>
      <a className="button button--ghost button--xs" href={href} onClick={navigate ? linkHandler(navigate, href) : undefined}>{translate(t, HOME_COPY, 'home.archived.open')}</a>
      <button type="button" className="button button--secondary button--xs" onClick={() => onUnarchive(row)}>{translate(t, HOME_COPY, 'home.archived.unarchive')}</button>
    </li>
  )
}

/**
 * "Archived (N)" at the bottom of the Home list: a toggle that expands an in-place list fetched with
 * `fetchArchived` ({@link ARCHIVED_PAGE} a page, "Show more" while a page comes back full). Each row shows the
 * session's task, repo, when it was archived and by whom, an Open link and Unarchive; the list is fetched again
 * after an Unarchive and whenever N changes. The expanded state is kept in `deck.archivedOpen`.
 * @param {{ count: number, api?: { get: Function }, storage?: Storage, repos?: object[], now: number, lang?: string, t?: Function,
 *   navigate?: (to: string) => void, onUnarchive: (id: string) => Promise<unknown> }} props
 */
export function ArchivedSection({ count, api, storage, repos = [], now, lang = 'en', t, navigate, onUnarchive }) {
  const [open, setOpen] = useState(() => readArchivedOpen(storage))
  const [list, setList] = useState({ rows: [], full: false, next: null, loading: false, failed: false })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!open || !api) return undefined
    let current = true
    setList(value => ({ ...value, loading: true, failed: false }))
    fetchArchived(api, { limit: ARCHIVED_PAGE }).then(body => {
      if (!current) return
      const rows = body?.sessions ?? []
      setList({ rows, full: rows.length >= ARCHIVED_PAGE, next: body?.nextBefore ?? rows.at(-1)?.archivedAt ?? null, loading: false, failed: false })
    }, () => { if (current) setList(value => ({ ...value, loading: false, failed: true })) })
    return () => { current = false }
  }, [open, api, count, version])
  const toggle = () => {
    writeArchivedOpen(storage, !open)
    setOpen(!open)
  }
  const more = () => {
    setList(value => ({ ...value, loading: true }))
    fetchArchived(api, { before: list.next, limit: ARCHIVED_PAGE }).then(body => {
      const rows = body?.sessions ?? []
      setList(value => ({ rows: [...value.rows, ...rows], full: rows.length >= ARCHIVED_PAGE, next: body?.nextBefore ?? rows.at(-1)?.archivedAt ?? null, loading: false, failed: false }))
    }, () => setList(value => ({ ...value, loading: false, failed: true })))
  }
  const unarchive = row => Promise.resolve(onUnarchive(row.id)).then(() => setVersion(n => n + 1))
  return (
    <section className="home-archived" aria-label={translate(t, HOME_COPY, 'home.archived.label')}>
      <button type="button" className="button button--ghost button--xs home-archived-toggle" aria-expanded={open ? 'true' : 'false'} aria-controls="home-archived-list"
        onClick={toggle}>{translate(t, HOME_COPY, 'home.archived.toggle', { n: count })}</button>
      {open ? (
        <div className="home-archived-body" id="home-archived-list" aria-busy={list.loading ? 'true' : undefined}>
          {list.rows.length ? (
            <ul className="archived-rows">
              {list.rows.map(row => <ArchivedRow key={row.id} row={row} repos={repos} now={now} lang={lang} t={t} navigate={navigate} onUnarchive={unarchive} />)}
            </ul>
          ) : null}
          {list.loading && !list.rows.length ? <p className="archived-status">{translate(t, HOME_COPY, 'home.archived.loading')}</p> : null}
          {list.failed ? <p className="archived-status" role="alert">{translate(t, HOME_COPY, 'home.archived.failed')}</p> : null}
          {list.full && !list.loading ? <button type="button" className="button button--ghost button--xs archived-more" onClick={more}>{translate(t, HOME_COPY, 'home.archived.more')}</button> : null}
        </div>
      ) : null}
    </section>
  )
}

function ArchiveAllButton({ ids, t, onArchiveFinished }) {
  if (!ids.length || !onArchiveFinished) return null
  return <button type="button" className="button button--ghost button--xs home-archive-finished" onClick={() => onArchiveFinished()}>{translate(t, HOME_COPY, 'home.archive.finished')}</button>
}

const sameLocalDay = (a, b) => {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/**
 * The meeting Calm's "Last meeting" shows (home.md 4.5): the newest `synthesized` meeting that started on the local
 * day of `now`, or null.
 * @param {object[] | null | undefined} meetings `GET /api/meetings` rows
 * @param {number} now epoch ms
 * @returns {object | null}
 */
export function lastMeetingOf(meetings, now) {
  const today = (Array.isArray(meetings) ? meetings : [])
    .filter(row => row?.state === 'synthesized' && Number.isFinite(row.startedAt) && sameLocalDay(row.startedAt, now))
  today.sort((a, b) => b.startedAt - a.startedAt || String(b.id).localeCompare(String(a.id)))
  return today[0] ?? null
}

/**
 * Read the Calm "Last meeting": the list with `fetchMeetings` (served from disk, so it loads with scribed down),
 * dispatching `meetings.fetched` when `dispatch` is given, then that meeting's note with `fetchMeeting` for its first
 * action item that is not dismissed. A failed detail read leaves the item out.
 * @param {{ get: Function }} api
 * @param {number} now epoch ms
 * @param {(action: object) => void} [dispatch]
 * @returns {Promise<{ meeting: object | null, item: { key: string, text: string, owner?: string | null } | null }>}
 */
export async function loadLastMeeting(api, now, dispatch) {
  const list = await fetchMeetings(api)
  const rows = Array.isArray(list?.meetings) ? list.meetings : []
  dispatch?.({ type: 'meetings.fetched', meetings: rows })
  const meeting = lastMeetingOf(rows, now)
  if (!meeting) return { meeting: null, item: null }
  const detail = await fetchMeeting(api, meeting.id).catch(() => null)
  const items = Array.isArray(detail?.note?.actionItems) ? detail.note.actionItems : []
  return { meeting, item: items.find(item => item && !item.dismissed && typeof item.text === 'string') ?? null }
}

/**
 * The Calm "Last meeting" CalmSection, pure: the meeting's title and the meta "{day} {time} · {duration} · {n} action
 * items", its first open action item as an ActionItemCard row with "Launch as session" (the new-session form with
 * the item text as the task), or "No meetings today.". Meeting content carries `lang="pt-BR"`.
 * @param {{ meeting: object | null, item?: { text: string, owner?: string | null } | null, now: number, t?: Function, navigate: (to: string) => void, loading?: boolean }} props
 */
export function LastMeetingView({ meeting, item = null, now, t, navigate, loading = false }) {
  const tr = (key, params) => translate(t, HOME_COPY, key, params)
  let body = null
  if (loading) body = null
  else if (!meeting) body = <p className="setting-hint calm-meeting-empty">{tr('home.calm.meeting.empty')}</p>
  else {
    const meta = tr('home.calm.meeting.meta', {
      day: dayLabel(meeting.startedAt, now, t), time: clockTime(meeting.startedAt), duration: durationText(meeting, t) ?? '',
      n: Number.isFinite(meeting.actionItemCount) ? meeting.actionItemCount : 0
    }).split(' · ').filter(part => part.trim()).join(' · ')
    const href = `/meetings/${encodeURIComponent(meeting.id)}`
    body = (
      <>
        <a className="calm-meeting-title" href={href} onClick={linkHandler(navigate, href)} lang="pt-BR"><bdi>{titleText(meetingTitle(meeting, t))}</bdi></a>
        <p className="meeting-meta calm-meeting-meta">{meta}</p>
        {item ? (
          <div className="calm-loop calm-meeting-item">
            <p className="calm-loop-text" lang="pt-BR"><bdi>{titleText(item.text)}</bdi></p>
            {/* The task stays the raw item text: it is data for the new-session form, not display. */}
            <button type="button" className="button button--ghost button--xs" onClick={() => navigate('/new?task=' + encodeURIComponent(item.text))}>{tr('home.calm.meeting.launch')}</button>
          </div>
        ) : null}
      </>
    )
  }
  return (
    <section className="calm-section calm-meeting" aria-labelledby="calm-meeting-title" aria-busy={loading ? 'true' : undefined}>
      <h2 className="calm-section-title" id="calm-meeting-title">{tr('home.calm.meeting.title')}</h2>
      {body}
    </section>
  )
}

/**
 * The Calm "Last meeting" with its data: {@link loadLastMeeting} once when it mounts, then {@link LastMeetingView}.
 * @param {{ api: { get: Function }, now: number, t?: Function, navigate: (to: string) => void, dispatch?: (action: object) => void }} props
 */
export function LastMeetingSection({ api, now, t, navigate, dispatch }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let current = true
    loadLastMeeting(api, Date.now(), dispatch).then(value => { if (current) setData(value) }, () => { if (current) setData({ meeting: null, item: null }) })
    return () => { current = false }
  }, [])
  return <LastMeetingView meeting={data?.meeting ?? null} item={data?.item ?? null} now={now} t={t} navigate={navigate} loading={data === null} />
}

export function chartRecap(recap) {
  const n = recap?.chartsAdded
  return n > 0 ? `${n} chart${n === 1 ? '' : 's'} added` : null
}
export function HomeMemoryView({ captures = [], misses = [], down = false, navigate, onRetry }) {
  return <><section className="calm-section"><h2>Charts added to your vault</h2>
    {down ? <><p>Your vault is not reachable right now.</p><button onClick={onRetry}>Retry</button></> : captures.length ? <ul>{captures.map(row => <li key={row.path}><NoteChip {...row} navigate={navigate} /></li>)}</ul> : <p>Nothing new in your vault today.</p>}
    <a href="/memory" onClick={navigate ? linkHandler(navigate, '/memory') : undefined}>Open Memory</a></section>
    <section className="calm-section"><h2>Unanswered questions</h2><ul>{misses.filter(miss => !miss.resolvedBy).map(miss => <li key={miss.id}><bdi>{titleText(miss.question)}</bdi> <a href={`/research/new?topic=${encodeURIComponent(miss.question)}&miss=${encodeURIComponent(miss.id)}`}>Research this</a></li>)}</ul></section></>
}
function HomeMemorySection({ api, state, navigate }) {
  const [captures, setCaptures] = useState([]), [misses, setMisses] = useState([])
  const down = ['down', 'unknown'].includes(state.memory?.vault.state ?? 'unknown')
  useEffect(() => {
    let active = true
    fetchMisses(api).then(result => { if (active) setMisses(result.misses) }, () => {})
    if (!down) fetchCaptures(api).then(result => { if (active) setCaptures(result.captures) }, () => {})
    return () => { active = false }
  }, [api, down, state.memory?.missesUnresolved, state.data.recap?.chartsAdded])
  return <HomeMemoryView captures={captures} misses={misses} down={down} navigate={navigate} onRetry={() => api.post('/api/deps/vault-mcp/retry').catch(() => {})} />
}
function Calm({ state, layout, now, t, navigate, lang, archiveAll = null, archived = null, lastMeeting = null, vaultSections = null }) {
  const sessions = state.data.sessions.filter(row => row.state !== 'ended' && !isArchived(row))
  const recent = [...state.data.sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  const seen = new Set()
  const crew = []
  for (const row of recent) {
    if (seen.has(row.repoId) || crew.length >= 3) continue
    seen.add(row.repoId)
    const repo = repoFor(state.data.repos, row.repoId)
    crew.push({ seed: repo.crewSeed, slot: repo.crewSlot })
  }
  if (!sessions.length && !state.data.repos?.length) {
    return <section className="home home--calm"><EmptyState kind="home" as="h1" t={t} crew={crew} />{vaultSections}{archived}</section>
  }
  const date = new Date(now)
  const day = translate(t, HOME_COPY, 'home.calm.subtitle.day', {
    weekday: new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(date),
    dayPart: translate(t, HOME_COPY, `home.calm.dayPart.${dayPart(date.getHours())}`)
  })
  const loops = orderSessions(sessions.filter(row => row.state === 'done'), state.data.order)
  return (
    <section className="home home--calm">
      <div className="calm-hero">
        {crew.length ? <div className="empty-crew">{crew.map(member => <CrewAvatar key={member.seed} seed={member.seed} slot={member.slot} pose="idle" size="xl" />)}</div> : null}
        <h1 className="calm-headline">{translate(t, HOME_COPY, 'home.calm.headline')}</h1>
        <p className="calm-subtitle">{[day, translate(t, HOME_COPY, 'home.calm.subtitle.state'), chartRecap(state.data.recap), translate(t, HOME_COPY, 'home.calm.subtitle.rest')].filter(Boolean).join(' · ')}</p>
      </div>
      <section className="calm-section" aria-labelledby="calm-loops-title">
        <h2 className="calm-section-title" id="calm-loops-title">{translate(t, HOME_COPY, 'home.calm.log.openLoops')}</h2>
        {archiveAll}
        {loops.length ? (
          <ul className="calm-loops">
            {loops.map(row => {
              const href = `${sessionHref(row.id)}?tab=changes`
              return (
                <li key={row.id} className="calm-loop">
                  <span className="calm-loop-text">{translate(t, HOME_COPY, 'home.calm.log.waitsForReview', { repo: shown(repoFor(state.data.repos, row.repoId).name) })}</span>
                  <a className="button button--ghost button--xs" href={href} onClick={linkHandler(navigate, href)}>{translate(t, HOME_COPY, 'home.calm.log.review')}</a>
                </li>
              )
            })}
          </ul>
        ) : <EmptyState kind="openLoops" t={t} />}
      </section>
      {lastMeeting}
      {vaultSections}
      {archived}
    </section>
  )
}

/**
 * Home (home.md): header with count chips, the Density radiogroup, the search trigger and "Launch a ship"
 * (`Alt N`, disabled with the visible reason "deckd is reconnecting" while deckd is down), then the comfortable grid with the quiet row or quiet strip, or in compact density a grid of
 * {@link CompactCard}s with PTY tails (`state.data.tails`) or observed hook `steps`; team cards from the
 * snapshot's runs, and the calm presentation. The quiet row offers Nudge and Stop… for controllable PTY
 * sessions through `onNudge` and `onStop`. The fleet scrolls under a fixed header. `onHold` reports the pointer
 * over the grid and focus inside a card, which hold reorders. Comfortable cards and quiet cards offer "Archive"
 * through `onArchive`; "Archive all finished" (`onArchiveFinished`) shows next to the title while
 * {@link finishedIds} is not empty; {@link ArchivedSection} ends the list while `counts.archived` is above
 * zero, also on the calm Home. Cards answer inline (M3): `answers` and `onAnswer` drive the answer buttons of
 * comfortable and compact cards, `onReview` (by default the drawer on that request) backs "Review in Needs you",
 * "Review" and "Reply", and `onAcceptRule` the rule suggestion lines of `data.ruleOffers`; the cards get the deckd
 * outage from {@link deckdDownOf}. The calm presentation places `lastMeeting` (the Calm "Last meeting" section,
 * {@link LastMeetingSection} from {@link Home}) under the open loops. Pure apart from ArchivedSection, which holds the
 * list's hooks.
 * @param {{ state: object, t?: (key: string, params?: object) => string, now?: number, navigate: (to: string) => void, layout?: ReturnType<typeof homeLayout>, onOverlay?: (overlay: 'palette'|'drawer', detail?: object) => void, onFocusCard?: (id: string) => void, onHold?: (kind: 'pointer'|'focus', held: boolean) => void, lang?: string,
 *   density?: 'comfortable' | 'compact', onDensity?: (value: string) => void, onLaunch?: () => void, steps?: Record<string, object[]>, onNudge?: (session: object) => void, onStop?: (session: object) => void,
 *   onArchive?: (session: object) => void, onArchiveFinished?: () => void, onUnarchive?: (id: string) => Promise<unknown>, api?: { get: Function }, storage?: Storage,
 *   answers?: Record<string, object>, onAnswer?: (request: object, body: object) => void, onReview?: (requestId: string) => void, onAcceptRule?: (offer: object) => void,
 *   lastMeeting?: React.ReactNode }} props
 */
export function HomeView({ state, t, now = Date.now(), navigate, layout, onOverlay = (overlay, detail) => openOverlay(overlay, undefined, detail), onFocusCard = focusCard, onHold = () => {}, lang = 'en',
  density = 'comfortable', onDensity = () => {}, onLaunch = () => openLaunch(navigate), steps = {}, onNudge, onStop, onArchive, onArchiveFinished, onUnarchive = () => Promise.resolve(), api, storage,
  answers = {}, onAnswer = () => {}, onReview = id => onOverlay('drawer', { request: id }), onAcceptRule = () => {}, lastMeeting = null, vaultSections = null }) {
  const { sessions, requests, repos, order, counts, runs } = state.data
  const shape = layout ?? homeLayout(sessions, { order, requests, now })
  const teams = teamCards(runs, sessions, requests)
  const archivedN = archivedCount(state)
  const archived = archivedN > 0
    ? <ArchivedSection count={archivedN} api={api} storage={storage} repos={repos} now={now} lang={lang} t={t} navigate={navigate} onUnarchive={onUnarchive} />
    : null
  const archiveAll = <ArchiveAllButton ids={finishedIds(sessions, requests)} t={t} onArchiveFinished={onArchiveFinished} />
  if (shape.calm && !teams.length) return <Calm state={state} layout={shape} now={now} t={t} navigate={navigate} lang={lang} archiveAll={archiveAll} archived={archived} lastMeeting={lastMeeting} vaultSections={vaultSections} />
  const leads = new Set(teams.map(team => team.lead?.id).filter(Boolean))
  const items = withTeams(shape.grid.filter(row => !leads.has(row.id)), teams)
  const inCard = target => !!target?.closest?.('.home article')
  const repo = session => repoFor(repos, session.repoId)
  const oldestDone = shape.grid.concat(shape.strip).filter(row => row.state === 'done').sort((a, b) => (a.stateSince ?? 0) - (b.stateSince ?? 0))[0]
  const firstRunning = shape.grid.find(row => row.state === 'running' || row.state === 'starting')
  const hidden = shape.strip.length - STRIP_MAX
  const compact = density === 'compact'
  const deckdDown = deckdDownOf(state)
  const tails = state.data.tails ?? {}
  const answering = { deckdDown, answers, onAnswer, onReview }
  return (
    <section className="home" onFocus={event => onHold('focus', inCard(event.target))} onBlur={event => onHold('focus', inCard(event.relatedTarget))}>
      <header className="home-header">
        <h1 className="page-title">{translate(t, HOME_COPY, 'home.header.title')}</h1>
        {archiveAll}
        <Counts counts={counts} t={t} onNeeds={() => onOverlay('drawer')}
          onRunning={() => { if (firstRunning) onFocusCard(firstRunning.id) }}
          onReview={() => { if (oldestDone) navigate(`${sessionHref(oldestDone.id)}?tab=changes`) }} />
        <DensityControl density={compact ? 'compact' : 'comfortable'} onDensity={onDensity} t={t} />
        <button type="button" className="button button--secondary home-search" onClick={() => onOverlay('palette')}>
          {translate(t, HOME_COPY, 'home.header.search')} <kbd className="kbd" aria-hidden="true">Alt K</kbd>
        </button>
        <button type="button" className="button button--primary home-launch" onClick={() => onLaunch()} disabled={deckdDown} aria-describedby={deckdDown ? 'home-launch-reason' : undefined}>
          <span aria-hidden="true">+</span> {translate(t, HOME_COPY, 'home.header.launch')} <kbd className="kbd" aria-hidden="true">Alt N</kbd>
        </button>
        {deckdDown ? <p className="home-launch-reason" id="home-launch-reason">{translate(t, CARD_COPY, 'home.quiet.deckdDown')}</p> : null}
      </header>
      {compact ? (
        <div className="home-fleet">
          <section className="home-grid home-grid--compact" aria-labelledby="home-grid-title" onPointerEnter={() => onHold('pointer', true)} onPointerLeave={() => onHold('pointer', false)}>
            <h2 className="sr-only" id="home-grid-title">{translate(t, HOME_COPY, 'home.grid.label')}</h2>
            {compactEntries(shape, teams).map(item => item.team
              ? <CompactCard key={item.team.key} team={item.team} repo={repoFor(repos, item.team.run.repoId)} t={t} now={now} navigate={navigate} {...answering}
                label={item.team.needs ? translate(t, HOME_COPY, 'home.card.team.pill', { needs: item.team.needs, total: item.team.total }) : undefined}
                tail={item.team.lead ? tails[item.team.lead.id] : undefined} steps={item.team.lead ? steps[item.team.lead.id] : undefined} />
              : <CompactCard key={item.session.id} session={item.session} repo={repo(item.session)} requests={requests} t={t} now={now} navigate={navigate} {...answering}
                tail={tails[item.session.id]} steps={steps[item.session.id]} />)}
          </section>
          {archived}
        </div>
      ) : (
      <div className="home-fleet">
        <section className="home-grid" aria-labelledby="home-grid-title" onPointerEnter={() => onHold('pointer', true)} onPointerLeave={() => onHold('pointer', false)}>
          <h2 className="sr-only" id="home-grid-title">{translate(t, HOME_COPY, 'home.grid.label')}</h2>
          {items.map(item => item.team
            ? <TeamCard key={item.team.key} team={item.team} repo={repoFor(repos, item.team.run.repoId)} t={t} navigate={navigate} onReview={id => onOverlay('drawer', { request: id })} />
            : <SessionCard key={item.session.id} session={item.session} repo={repo(item.session)} requests={requests} now={now} lang={lang} t={t} navigate={navigate} onArchive={onArchive}
              {...answering} ruleOffers={state.data.ruleOffers ?? []} onAcceptRule={onAcceptRule} />)}
        </section>
        {shape.quiet.length || shape.strip.length ? (
          <section className="quiet-row" aria-labelledby="home-quiet-title">
            <h2 className="sr-only" id="home-quiet-title">{translate(t, HOME_COPY, 'home.quiet.strip.label')}</h2>
            {shape.crowded ? (
              <ul className="quiet-strip">
                {shape.strip.slice(0, STRIP_MAX).map(session => <StripChip key={session.id} session={session} repo={repo(session)} now={now} t={t} navigate={navigate} />)}
                {hidden > 0 ? <li><button type="button" className="button button--ghost button--xs strip-more" onClick={() => onOverlay('palette')}>{translate(t, HOME_COPY, 'home.quiet.strip.more', { n: hidden })}</button></li> : null}
              </ul>
            ) : shape.quiet.map(session => <QuietCard key={session.id} session={session} repo={repo(session)} now={now} lang={lang} t={t} navigate={navigate}
              onNudge={onNudge} onStop={onStop} deckdDown={deckdDown} onArchive={onArchive} />)}
          </section>
        ) : null}
        {archived}
      </div>
      )}
    </section>
  )
}

/**
 * Re-render once a minute so ticking values (stale minutes, idle duration, waiting) stay current.
 * @returns {number}
 */
export function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * The palette or the Needs-you drawer, whichever overlay the shell's view names.
 * `onArchive` runs the palette's "Archive session" so the screen under it shows the toast; `onToast` shows the
 * palette's "Allowed {summary} in {repo}" once it has closed.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, api?: object, onArchive?: (id: string) => Promise<unknown>, onToast?: (toast: { tone: string, title: string }) => void }} props
 */
export function ObserveOverlays({ state, t, navigate, api, onArchive, onToast }) {
  const overlay = state.view?.overlay
  if (overlay === 'palette') return <Palette state={state} t={t} navigate={navigate} api={api} onArchive={onArchive} onToast={onToast} />
  if (overlay === 'drawer') return <NeedsYouDrawer state={state} t={t} navigate={navigate} />
  return null
}

/**
 * The Home route screen for the shell's `screens` map: {@link HomeView} with crowding hysteresis carried
 * between renders, reorders held by {@link heldOrder} while the pointer is over the grid or focus is in a
 * card, a minute tick and the observe overlays. It keeps the density from `storage` through `readDensity`
 * ({@link pickDensity} writes it), subscribes `terminals.subscribeTails` to {@link tailSubscription} (cleared on
 * leaving compact and on unmount), loads the last hook steps of observed compact sessions, holds the Stop
 * dialog of {@link homeActions} in {@link HomeStopDialog}, and opens the Needs-you drawer once for a `?needs=` link
 * ({@link needsLinkDetail}). Card answers run through {@link homeAnswerActions}, with the answers in flight pruned by
 * {@link pruneAnswers} as requests close and the rule toast (with its Undo) held like the archive toast. The calm
 * presentation gets {@link LastMeetingSection}, which reads the meetings when it mounts.
 * The effects are browser wiring the unit tests do not run; the static render,
 * {@link homeLayout}, {@link heldOrder}, {@link tailSubscription}, {@link homeActions}, {@link homeAnswerActions},
 * {@link pruneAnswers}, {@link HomeStopDialog} and {@link HomeView} are unit tested.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, api?: object, terminals?: { subscribeTails: (ids: string[]) => boolean } | null,
 *   storage?: Storage, search?: string, dispatch?: (action: object) => void, onOverlay?: (overlay: 'palette'|'drawer', detail?: object) => void }} props
 */
export function Home({ state, t, navigate, api, terminals = null, storage = globalThis.localStorage, search = globalThis.location?.search ?? '', dispatch,
  onOverlay = (overlay, detail) => openOverlay(overlay, globalThis.window, detail) }) {
  const now = useMinuteNow()
  const [density, setDensity] = useState(() => readDensity(storage))
  const [stopping, setStopping] = useState(null)
  const [steps, setSteps] = useState({})
  const needsOpened = useRef(false)
  const http = api ?? deckApi()
  const crowded = useRef(false)
  const hold = useRef({ pointer: false, focus: false })
  const memo = useRef({ shown: null, since: null })
  const [, wake] = useState(0)
  const held = heldOrder(state.data.order, { held: hold.current.pointer || hold.current.focus, ...memo.current }, Date.now())
  memo.current = { shown: held.shown, since: held.since }
  const layout = homeLayout(state.data.sessions, { order: held.order, requests: state.data.requests, now, crowdedBefore: crowded.current })
  useEffect(() => { crowded.current = layout.crowded })
  useEffect(() => {
    if (held.wakeAt === null) return undefined
    const timer = setTimeout(() => wake(n => n + 1), Math.max(0, held.wakeAt - Date.now()))
    return () => clearTimeout(timer)
  }, [held.wakeAt])
  const onHold = (kind, value) => {
    if (hold.current[kind] === value) return
    hold.current = { ...hold.current, [kind]: value }
    if (!value) wake(n => n + 1)
  }
  const teams = teamCards(state.data.runs, state.data.sessions, state.data.requests)
  const tailIds = tailSubscription(density, layout, teams)
  const tailKey = tailIds.join('\u0000')
  useEffect(() => {
    terminals?.subscribeTails(tailIds)
  }, [terminals, tailKey])
  useEffect(() => () => { terminals?.subscribeTails([]) }, [terminals])
  // Observed compact cards list their last hook steps; they reload when the session's activity moves.
  const observed = density === 'compact'
    ? compactEntries(layout, teams).map(item => item.session ?? item.team.lead).filter(row => row && row.origin === 'observed')
    : []
  const observedKey = observed.map(row => `${row.id}@${row.lastActivityAt ?? ''}`).join('\u0000')
  useEffect(() => {
    let current = true
    for (const row of observed) {
      http.get(`/api/sessions/${encodeURIComponent(row.id)}/steps?limit=${COMPACT_STEPS}`)
        .then(data => { if (current) setSteps(map => ({ ...map, [row.id]: data?.steps ?? [] })) }, () => {})
    }
    return () => { current = false }
  }, [http, observedKey])
  useEffect(() => {
    if (needsOpened.current) return
    needsOpened.current = true
    const detail = needsLinkDetail(search)
    if (detail) onOverlay('drawer', detail)
  }, [])
  const toast = item => { if (dispatch) dispatch({ type: 'toast.push', ...item }) }
  const actions = homeActions({ api: http, setStopping, toast, repoName: session => repoFor(state.data.repos, session.repoId).name, t })
  const [archiveToast, showArchiveToast] = useArchiveToast()
  const flow = archiveFlow({ api: http, show: showArchiveToast, t })
  const [answers, setAnswers] = useState({})
  useEffect(() => {
    setAnswers(map => {
      const next = pruneAnswers(map, state.data.requests)
      return Object.keys(next).length === Object.keys(map).length ? map : next
    })
  }, [state.data.requests])
  const [ruleToast, showRuleToast] = useArchiveToast()
  const answering = homeAnswerActions({ api: http, setAnswers, show: showRuleToast, repos: state.data.repos, t })
  return (
    <>
      <HomeView state={{ ...state, data: { ...state.data, order: held.order } }} t={t} now={now} navigate={navigate} layout={layout} onHold={onHold}
        density={density} onDensity={value => pickDensity(storage, value, setDensity)} steps={steps} onNudge={actions.nudge} onStop={actions.openStop}
        onArchive={session => flow.archive(session.id)} onArchiveFinished={flow.archiveFinished} onUnarchive={flow.unarchive} api={http} storage={storage}
        answers={answers} onAnswer={answering.answer} onReview={id => onOverlay('drawer', { request: id })} onAcceptRule={answering.acceptRule}
        lastMeeting={<LastMeetingSection api={http} now={now} t={t} navigate={navigate} dispatch={dispatch} />} vaultSections={<HomeMemorySection api={http} state={state} navigate={navigate} />} />
      <HomeStopDialog stopping={stopping} repos={state.data.repos} actions={actions} t={t} />
      <ArchiveToast toast={archiveToast} t={t} onUndo={flow.undo} onDismiss={() => showArchiveToast(null)} />
      <ArchiveToast toast={ruleToast} t={t} onUndo={answering.undo} onDismiss={() => showRuleToast(null)} />
      <ObserveOverlays state={state} t={t} navigate={navigate} api={api} onArchive={flow.archive} onToast={toast} />
    </>
  )
}
