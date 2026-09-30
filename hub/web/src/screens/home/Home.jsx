import React, { useEffect, useRef, useState } from 'react'
import { CARD_COPY, QuietCard, SessionCard } from '../../components/SessionCard.jsx'
import { Counts } from '../../components/Counts.jsx'
import { CrewAvatar, poseFor } from '../../components/CrewAvatar.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { StatusPill, pillParams, shown, stateLabel, titleText, translate } from '../../components/StatusPill.jsx'
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
  'home.calm.log.review': 'Review'
})

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
 * or quiet strip, and the calm presentation. Pure: no hooks, so tests can walk it.
 * @param {{ state: object, t?: (key: string, params?: object) => string, now?: number, navigate: (to: string) => void, layout?: ReturnType<typeof homeLayout>, onOverlay?: (overlay: 'palette'|'drawer') => void, onFocusCard?: (id: string) => void, lang?: string }} props
 */
export function HomeView({ state, t, now = Date.now(), navigate, layout, onOverlay = overlay => openOverlay(overlay), onFocusCard = focusCard, lang = 'en' }) {
  const { sessions, requests, repos, order, counts } = state.data
  const shape = layout ?? homeLayout(sessions, { order, requests, now })
  if (shape.calm) return <Calm state={state} layout={shape} now={now} t={t} navigate={navigate} lang={lang} />
  const repo = session => repoFor(repos, session.repoId)
  const oldestDone = shape.grid.concat(shape.strip).filter(row => row.state === 'done').sort((a, b) => (a.stateSince ?? 0) - (b.stateSince ?? 0))[0]
  const firstRunning = shape.grid.find(row => row.state === 'running' || row.state === 'starting')
  const hidden = shape.strip.length - STRIP_MAX
  return (
    <section className="home">
      <header className="home-header">
        <h1 className="page-title">{translate(t, HOME_COPY, 'home.header.title')}</h1>
        <Counts counts={counts} t={t} onNeeds={() => onOverlay('drawer')}
          onRunning={() => { if (firstRunning) onFocusCard(firstRunning.id) }}
          onReview={() => { if (oldestDone) navigate(`${sessionHref(oldestDone.id)}?tab=changes`) }} />
        <button type="button" className="button button--secondary home-search" onClick={() => onOverlay('palette')}>
          {translate(t, HOME_COPY, 'home.header.search')} <kbd className="kbd" aria-hidden="true">Alt K</kbd>
        </button>
      </header>
      <section className="home-grid" aria-labelledby="home-grid-title">
        <h2 className="sr-only" id="home-grid-title">{translate(t, HOME_COPY, 'home.grid.label')}</h2>
        {shape.grid.map(session => <SessionCard key={session.id} session={session} repo={repo(session)} requests={requests} now={now} lang={lang} t={t} navigate={navigate} />)}
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
 * between renders, a minute tick and the observe overlays. This browser wiring is not exercised by the
 * unit tests; {@link homeLayout} (including `crowdedBefore`) and {@link HomeView} are.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, api?: object }} props
 */
export function Home({ state, t, navigate, api }) {
  const now = useMinuteNow()
  const crowded = useRef(false)
  const layout = homeLayout(state.data.sessions, { order: state.data.order, requests: state.data.requests, now, crowdedBefore: crowded.current })
  useEffect(() => { crowded.current = layout.crowded })
  return (
    <>
      <HomeView state={state} t={t} now={now} navigate={navigate} layout={layout} />
      <ObserveOverlays state={state} t={t} navigate={navigate} api={api} />
    </>
  )
}
