import React, { useEffect, useRef, useState } from 'react'
import { CARD_COPY, QuietCard, SessionCard } from '../../components/SessionCard.jsx'
import { Counts } from '../../components/Counts.jsx'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { MetaLine, StatusPill, pillParams, shown, stateLabel, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { NeedsYouDrawer, openOverlay, repoFor } from '../drawer/NeedsYouDrawer.jsx'
import { Palette, orderSessions } from '../palette/Palette.jsx'

/** English copy for the M1 Home (docs/deck/screens/home.md section 9). */
export const HOME_COPY = Object.freeze({
  'home.header.title': 'Sessions',
  'home.header.search': 'Search, ask or run',
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
  'home.card.team.moreRequests': '+{n} more'
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
    const needing = tiles.filter(tile => tile.kind === 'needs').length + (lead && NEEDS.has(lead.state) && !open.some(row => row.taskId) ? 1 : 0)
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
 * crowded, the strip (stale, done, idle, reviewed). Ended sessions, a run's teammates and sessions
 * reviewed before local midnight never show.
 * @param {object[]} sessions
 * @param {{ order?: string[], requests?: object[], now?: number, crowdedBefore?: boolean }} [options]
 * @returns {{ calm: boolean, crowded: boolean, grid: object[], quiet: object[], strip: object[], count: number }}
 */
export function homeLayout(sessions, { order = [], requests = [], now = Date.now(), crowdedBefore = false } = {}) {
  const start = midnight(now)
  const visible = orderSessions(sessions, order, requests).filter(row => row.state !== 'ended' && row.role !== 'teammate' &&
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

function Calm({ state, layout, now, t, navigate, lang }) {
  const sessions = state.data.sessions.filter(row => row.state !== 'ended')
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
    return <section className="home home--calm"><EmptyState kind="home" as="h1" t={t} crew={crew} /></section>
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
        <p className="calm-subtitle">{[day, translate(t, HOME_COPY, 'home.calm.subtitle.state'), translate(t, HOME_COPY, 'home.calm.subtitle.rest')].join(' · ')}</p>
      </div>
      <section className="calm-section" aria-labelledby="calm-loops-title">
        <h2 className="calm-section-title" id="calm-loops-title">{translate(t, HOME_COPY, 'home.calm.log.openLoops')}</h2>
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
    </section>
  )
}

/**
 * Home, M1 (home.md): header with count chips and the search trigger, the comfortable grid, the quiet row
 * or quiet strip, team cards from the snapshot's runs, and the calm presentation. The fleet (grid and quiet
 * row) scrolls under a fixed header. `onHold` reports the pointer over the grid and focus inside a card, which
 * hold reorders. Pure: no hooks, so tests can walk it.
 * @param {{ state: object, t?: (key: string, params?: object) => string, now?: number, navigate: (to: string) => void, layout?: ReturnType<typeof homeLayout>, onOverlay?: (overlay: 'palette'|'drawer', detail?: object) => void, onFocusCard?: (id: string) => void, onHold?: (kind: 'pointer'|'focus', held: boolean) => void, lang?: string }} props
 */
export function HomeView({ state, t, now = Date.now(), navigate, layout, onOverlay = (overlay, detail) => openOverlay(overlay, undefined, detail), onFocusCard = focusCard, onHold = () => {}, lang = 'en' }) {
  const { sessions, requests, repos, order, counts, runs } = state.data
  const shape = layout ?? homeLayout(sessions, { order, requests, now })
  const teams = teamCards(runs, sessions, requests)
  if (shape.calm && !teams.length) return <Calm state={state} layout={shape} now={now} t={t} navigate={navigate} lang={lang} />
  const leads = new Set(teams.map(team => team.lead?.id).filter(Boolean))
  const items = withTeams(shape.grid.filter(row => !leads.has(row.id)), teams)
  const inCard = target => !!target?.closest?.('.home article')
  const repo = session => repoFor(repos, session.repoId)
  const oldestDone = shape.grid.concat(shape.strip).filter(row => row.state === 'done').sort((a, b) => (a.stateSince ?? 0) - (b.stateSince ?? 0))[0]
  const firstRunning = shape.grid.find(row => row.state === 'running' || row.state === 'starting')
  const hidden = shape.strip.length - STRIP_MAX
  return (
    <section className="home" onFocus={event => onHold('focus', inCard(event.target))} onBlur={event => onHold('focus', inCard(event.relatedTarget))}>
      <header className="home-header">
        <h1 className="page-title">{translate(t, HOME_COPY, 'home.header.title')}</h1>
        <Counts counts={counts} t={t} onNeeds={() => onOverlay('drawer')}
          onRunning={() => { if (firstRunning) onFocusCard(firstRunning.id) }}
          onReview={() => { if (oldestDone) navigate(`${sessionHref(oldestDone.id)}?tab=changes`) }} />
        <button type="button" className="button button--secondary home-search" onClick={() => onOverlay('palette')}>
          {translate(t, HOME_COPY, 'home.header.search')} <kbd className="kbd" aria-hidden="true">Alt K</kbd>
        </button>
      </header>
      <div className="home-fleet">
        <section className="home-grid" aria-labelledby="home-grid-title" onPointerEnter={() => onHold('pointer', true)} onPointerLeave={() => onHold('pointer', false)}>
          <h2 className="sr-only" id="home-grid-title">{translate(t, HOME_COPY, 'home.grid.label')}</h2>
          {items.map(item => item.team
            ? <TeamCard key={item.team.key} team={item.team} repo={repoFor(repos, item.team.run.repoId)} t={t} navigate={navigate} onReview={id => onOverlay('drawer', { request: id })} />
            : <SessionCard key={item.session.id} session={item.session} repo={repo(item.session)} requests={requests} now={now} lang={lang} t={t} navigate={navigate} />)}
        </section>
        {shape.quiet.length || shape.strip.length ? (
          <section className="quiet-row" aria-labelledby="home-quiet-title">
            <h2 className="sr-only" id="home-quiet-title">{translate(t, HOME_COPY, 'home.quiet.strip.label')}</h2>
            {shape.crowded ? (
              <ul className="quiet-strip">
                {shape.strip.slice(0, STRIP_MAX).map(session => <StripChip key={session.id} session={session} repo={repo(session)} now={now} t={t} navigate={navigate} />)}
                {hidden > 0 ? <li><button type="button" className="button button--ghost button--xs strip-more" onClick={() => onOverlay('palette')}>{translate(t, HOME_COPY, 'home.quiet.strip.more', { n: hidden })}</button></li> : null}
              </ul>
            ) : shape.quiet.map(session => <QuietCard key={session.id} session={session} repo={repo(session)} now={now} lang={lang} t={t} navigate={navigate} />)}
          </section>
        ) : null}
      </div>
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
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, api?: object }} props
 */
export function ObserveOverlays({ state, t, navigate, api }) {
  const overlay = state.view?.overlay
  if (overlay === 'palette') return <Palette state={state} t={t} navigate={navigate} api={api} />
  if (overlay === 'drawer') return <NeedsYouDrawer state={state} t={t} navigate={navigate} />
  return null
}

/**
 * The Home route screen for the shell's `screens` map: {@link HomeView} with crowding hysteresis carried
 * between renders, reorders held by {@link heldOrder} while the pointer is over the grid or focus is in a
 * card, a minute tick and the observe overlays. This browser wiring is exercised by the e2e suite
 * (`hub/test/e2e/observe.spec.mjs`, Home AC3 and AC4), not by the unit tests; {@link homeLayout},
 * {@link heldOrder} and {@link HomeView} are unit tested.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, api?: object }} props
 */
export function Home({ state, t, navigate, api }) {
  const now = useMinuteNow()
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
  return (
    <>
      <HomeView state={{ ...state, data: { ...state.data, order: held.order } }} t={t} now={now} navigate={navigate} layout={layout} onHold={onHold} />
      <ObserveOverlays state={state} t={t} navigate={navigate} api={api} />
    </>
  )
}
