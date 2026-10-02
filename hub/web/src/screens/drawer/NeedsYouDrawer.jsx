import React, { useEffect, useRef, useState } from 'react'
import { CARD_COPY } from '../../components/SessionCard.jsx'
import { requestSummary } from '../../components/Counts.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { Icon, compactDuration, shown, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { TOKEN_KEY, createApiClient } from '../../state/api.js'
import { needsFilterParam, parseNeedsFilter } from '../../state/deck-store.js'

/** English copy for the read-only M1 drawer (docs/deck/screens/needs-you-drawer.md section 9). */
export const DRAWER_COPY = Object.freeze({
  'drawer.title': 'Needs you',
  'drawer.subtitle.oldest': 'oldest waiting {duration}',
  'drawer.close': 'Close',
  'drawer.safe.desc': 'Reads, tests, builds',
  'drawer.caution.desc': 'Network, installs, outside the repo · one at a time',
  'drawer.destructive.desc': 'Never batched, never a rule, never from a popup',
  'drawer.row.source.session': '{repo} · {branch} · waiting {duration}',
  'drawer.row.source.plain': '{repo} · waiting {duration}',
  'drawer.row.source.teammate': '{repo} · {taskId} teammate · waiting {duration}',
  'drawer.row.answerInTerminal': 'Answer in your terminal',
  'drawer.row.open': 'Open',
  'drawer.filter.task': 'Requests for {taskId}',
  'drawer.filter.run': 'Requests for run {runId}',
  'drawer.filter.showAll': 'Show all',
  'drawer.footer.m1': 'Answer in your terminal for now. Answering here arrives with approvals.'
})

/** Drawer section order (needs-you-drawer.md section 3). */
export const TIERS = Object.freeze(['safe', 'caution', 'question', 'destructive'])

const win = () => globalThis.window
const here = env => env.location.pathname + env.location.search

/**
 * Open an overlay the way the shell's `Alt K` and `Alt U` do: push a history entry that carries it, then
 * tell the shell through a `popstate` event so Back closes it. `detail.request` names the drawer row to focus
 * (a team card's "Review N", home.md 5 and Drawer AC9); `detail.filter` (a run or task filter, D-69) rides in
 * the history state as its `needs=` parameter, where {@link drawerFilterFrom} reads it back.
 * @param {'palette'|'drawer'} overlay
 * @param {Window} [env]
 * @param {{ request?: string, filter?: { kind: string, id?: string, runId?: string, taskId?: string } | null }} [detail]
 */
export function openOverlay(overlay, env = win(), detail = {}) {
  const state = { overlay }
  if (detail.request) state.request = detail.request
  if (detail.filter) state.filter = needsFilterParam(detail.filter)
  env.history.pushState(state, '', here(env))
  env.dispatchEvent(new env.PopStateEvent('popstate', { state }))
}

/**
 * The run or task filter a drawer history entry carries ({@link openOverlay}); a request filter or none is null.
 * @param {{ filter?: string } | null | undefined} historyState
 * @returns {{ kind: 'run', runId: string } | { kind: 'task', runId: string, taskId: string } | null}
 */
export function drawerFilterFrom(historyState) {
  const filter = typeof historyState?.filter === 'string' ? parseNeedsFilter(historyState.filter) : null
  return filter && (filter.kind === 'run' || filter.kind === 'task') ? filter : null
}

/**
 * The drawer detail a `?needs=` deep link asks for on load (needs-you-drawer.md section 2): a bare request id
 * or `request:<id>` focuses that request, `run:` and `task:` filter the drawer. Anything else is null.
 * @param {string | null | undefined} search
 * @returns {{ request: string } | { filter: object } | null}
 */
export function needsLinkDetail(search) {
  let value
  try { value = new URLSearchParams(String(search ?? '')).get('needs') } catch { return null }
  if (!value) return null
  if (!value.includes(':')) return { request: value }
  const filter = parseNeedsFilter(search)
  if (!filter) return null
  return filter.kind === 'request' ? { request: filter.id } : { filter }
}

/**
 * Open requests the drawer shows under a filter: a run filter keeps requests of sessions in that run (its
 * `runRef.runId`, or the run's lead), a task filter also needs `request.taskId` to match. No filter keeps all.
 * @param {object[]} requests
 * @param {{ kind: string, runId?: string, taskId?: string } | null | undefined} filter
 * @param {{ sessions?: object[], runs?: object[] }} data
 * @returns {object[]}
 */
export function filterRequests(requests, filter, { sessions = [], runs = [] } = {}) {
  if (!filter || (filter.kind !== 'run' && filter.kind !== 'task')) return requests ?? []
  const ids = new Set((sessions ?? []).filter(row => row.runRef?.runId === filter.runId).map(row => row.id))
  for (const run of runs ?? []) if (run.runId === filter.runId && run.leadSessionId) ids.add(run.leadSessionId)
  return (requests ?? []).filter(row => ids.has(row.sessionId) && (filter.kind === 'run' || row.taskId === filter.taskId))
}

/**
 * The element the drawer focuses when it opens: the named request's Open, else the first row's Open, else Close.
 * @param {ParentNode | null} panel
 * @param {string | null | undefined} requestId
 * @returns {Element | null}
 */
export function drawerFocusTarget(panel, requestId) {
  if (!panel) return null
  const named = requestId ? [...panel.querySelectorAll('.drawer-row')].find(row => row.getAttribute('data-request') === requestId)?.querySelector('a') : null
  return named ?? panel.querySelector('.drawer-row a') ?? panel.querySelector('.drawer-close')
}

/**
 * Drop the overlay without leaving the page, so a following `navigate` does not carry it along.
 * @param {Window} [env]
 */
export function leaveOverlay(env = win()) {
  env.history.replaceState(null, '', here(env))
  env.dispatchEvent(new env.PopStateEvent('popstate', { state: null }))
}

/**
 * Close an overlay: Back when the current history entry is the overlay's own, else {@link leaveOverlay}.
 * @param {Window} [env]
 */
export function closeOverlay(env = win()) {
  if (env.history.state?.overlay) env.history.back()
  else leaveOverlay(env)
}

let client = null
/**
 * The REST client the observe screens use when none is passed in: same-origin `/api/*` with this tab's token.
 * @returns {ReturnType<typeof createApiClient>}
 */
export function deckApi() {
  client ??= createApiClient({ token: globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? null, fetch: (url, init) => globalThis.fetch(url, init) })
  return client
}

/**
 * Card-ready repo fields for a session's repo, from the snapshot `repos` rows.
 * @param {object[]} repos
 * @param {string} repoId
 * @returns {{ name: string, crewSeed: string, crewSlot?: number, hat: string }}
 */
export function repoFor(repos, repoId) {
  const row = (repos ?? []).find(item => item.id === repoId)
  const name = row?.name ?? String(repoId ?? '').split('/').filter(Boolean).at(-1) ?? ''
  return { name, crewSeed: row?.crew?.seed ?? name, crewSlot: row?.crew?.slot ?? undefined, hat: row?.crew?.hat ?? 'none' }
}

/**
 * The tier a request is listed under: questions by kind, permissions by tier (unknown tiers as caution).
 * @param {{ kind?: string, tier?: string | null }} request
 * @returns {'safe'|'caution'|'question'|'destructive'}
 */
export function tierOf(request) {
  if (request.kind === 'question') return 'question'
  return TIERS.includes(request.tier) ? request.tier : 'caution'
}

/**
 * Open requests grouped into the non-empty drawer sections, oldest first inside each.
 * @param {object[]} requests
 * @returns {{ tier: string, requests: object[] }[]}
 */
export function drawerSections(requests) {
  const open = (requests ?? []).filter(row => (row.state ?? 'open') === 'open')
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)))
  return TIERS.map(tier => ({ tier, requests: open.filter(row => tierOf(row) === tier) })).filter(section => section.requests.length)
}

function sourceLine(request, session, repo, now, t) {
  const params = { repo: shown(repo.name), duration: compactDuration(now - (request.createdAt ?? now)) }
  if (request.taskId) return translate(t, DRAWER_COPY, 'drawer.row.source.teammate', { ...params, taskId: shown(request.taskId) })
  if (session?.branch) return translate(t, DRAWER_COPY, 'drawer.row.source.session', { ...params, branch: shown(session.branch) })
  return translate(t, DRAWER_COPY, 'drawer.row.source.plain', params)
}

function Row({ request, state, now, t, go }) {
  const session = state.data.sessions.find(row => row.id === request.sessionId)
  const repo = repoFor(state.data.repos, session?.repoId)
  const href = `/s/${encodeURIComponent(request.sessionId)}`
  const question = tierOf(request) === 'question'
  return (
    <li className={`drawer-row drawer-row--${tierOf(request)}`} aria-label={question ? titleText(request.summary) : shown(request.summary)} data-request={request.id}>
      {question
        ? <p className="drawer-question"><bdi>{titleText(request.summary)}</bdi></p>
        : <code className="drawer-command">{shown(request.summary)}</code>}
      <p className="drawer-source">{sourceLine(request, session, repo, now, t)}</p>
      <div className="drawer-actions">
        <span className="request-terminal">{translate(t, DRAWER_COPY, 'drawer.row.answerInTerminal')}</span>
        <a className="button button--ghost button--xs" href={href} onClick={linkHandler(go, href)}>{translate(t, DRAWER_COPY, 'drawer.row.open')}</a>
      </div>
    </li>
  )
}

/**
 * The read-only Needs-you drawer body: every open request, by tier, with "Answer in your terminal" and
 * "Open". It never renders Allow, Deny or Reply. A run or task `filter` (D-69) keeps only that run's or task's
 * requests under the line "Requests for {taskId}" or "Requests for run {runId}" with a "Show all" button
 * calling `onShowAll`. Pure: no hooks, so it can be walked in tests.
 * @param {{ state: object, t?: (key: string, params?: object) => string, now?: number, navigate: (to: string) => void, onClose?: () => void, onLeave?: () => void, onKeyDown?: Function, panelRef?: object,
 *   filter?: { kind: 'run', runId: string } | { kind: 'task', runId: string, taskId: string } | null, onShowAll?: () => void }} props
 */
export function DrawerView({ state, t, now = Date.now(), navigate, onClose = () => closeOverlay(), onLeave = () => leaveOverlay(), onKeyDown, panelRef, filter = null, onShowAll = () => {} }) {
  const go = to => {
    onLeave()
    navigate(to)
  }
  const active = filter && (filter.kind === 'run' || filter.kind === 'task') ? filter : null
  const sections = state.loaded ? drawerSections(filterRequests(state.data.requests, active, state.data)) : []
  const counts = state.data.counts
  const summary = requestSummary(counts, t)
  const oldest = counts?.oldestRequestAt
  const subtitle = summary && Number.isFinite(oldest)
    ? `${summary} · ${translate(t, DRAWER_COPY, 'drawer.subtitle.oldest', { duration: compactDuration(now - oldest) })}`
    : summary
  let body
  if (!state.loaded) {
    body = <div className="drawer-body" aria-busy="true">{[0, 1, 2].map(index => <div key={index} className="drawer-skeleton motion-shimmer" aria-hidden="true" />)}</div>
  } else if (!sections.length) {
    body = <div className="drawer-body"><EmptyState kind="drawer" t={t} /></div>
  } else {
    body = (
      <div className="drawer-body">
        {sections.map(section => (
          <section key={section.tier} className={`drawer-section drawer-section--${section.tier}`} aria-labelledby={`drawer-section-${section.tier}`}>
            <h3 className="drawer-section-title"><span className={`tier-badge tier-badge--${section.tier}`}>{translate(t, CARD_COPY, `tier.${section.tier}`)}</span>
              <span className="drawer-section-count" id={`drawer-section-${section.tier}`}>{` · ${section.requests.length}`}</span></h3>
            {DRAWER_COPY[`drawer.${section.tier}.desc`] ? <p className="drawer-section-desc">{translate(t, DRAWER_COPY, `drawer.${section.tier}.desc`)}</p> : null}
            <ul className="drawer-rows">
              {section.requests.map(request => <Row key={request.id} request={request} state={state} now={now} t={t} go={go} />)}
            </ul>
          </section>
        ))}
      </div>
    )
  }
  return (
    <div className="drawer-scrim" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onKeyDown={onKeyDown} ref={panelRef}>
        <header className="drawer-header">
          <div className="drawer-heading">
            <h2 id="drawer-title" className="drawer-title">{translate(t, DRAWER_COPY, 'drawer.title')}</h2>
            {subtitle ? <p className="drawer-subtitle">{subtitle}</p> : null}
            {active ? (
              <p className="drawer-filter">
                <span className="drawer-filter-text">{active.kind === 'task'
                  ? translate(t, DRAWER_COPY, 'drawer.filter.task', { taskId: shown(active.taskId) })
                  : translate(t, DRAWER_COPY, 'drawer.filter.run', { runId: shown(active.runId) })}</span>
                {' '}<button type="button" className="button button--ghost button--xs drawer-show-all" onClick={onShowAll}>{translate(t, DRAWER_COPY, 'drawer.filter.showAll')}</button>
              </p>
            ) : null}
          </div>
          <button type="button" className="drawer-close" aria-label={translate(t, DRAWER_COPY, 'drawer.close')} onClick={onClose}><Icon name="x" size={16} /></button>
        </header>
        {body}
        <footer className="drawer-footer">{translate(t, DRAWER_COPY, 'drawer.footer.m1')}</footer>
      </section>
    </div>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keep Tab inside a modal container (design-system 11.2).
 * @param {KeyboardEvent} event
 * @param {HTMLElement | null} container
 */
export function trapTab(event, container) {
  if (event.key !== 'Tab' || !container) return
  const items = [...container.querySelectorAll(FOCUSABLE)]
  if (!items.length) return
  const first = items[0]
  const last = items.at(-1)
  const active = container.ownerDocument.activeElement
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

/**
 * The Needs-you drawer overlay: {@link DrawerView} wired to Esc, the {@link trapTab} focus trap, initial
 * focus from {@link drawerFocusTarget} (the request the history entry names, else the first request's Open,
 * else Close), focus returned to the opener on close, and the history entry's filter ({@link drawerFilterFrom}),
 * which "Show all" drops from the entry while the drawer stays open.
 * This browser wiring is not exercised by the unit tests; {@link DrawerView}, {@link drawerFilterFrom} and
 * {@link trapTab} are.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, onClose?: () => void, onLeave?: () => void, history?: History }} props
 */
export function NeedsYouDrawer({ history = globalThis.history, ...props }) {
  const panel = useRef(null)
  const [filter, setFilter] = useState(() => drawerFilterFrom(history?.state))
  const onShowAll = () => {
    setFilter(null)
    const { filter: _drop, ...rest } = history?.state ?? {}
    history?.replaceState(rest, '', here(globalThis.window))
  }
  useEffect(() => {
    const opener = globalThis.document?.activeElement
    const target = drawerFocusTarget(panel.current, history?.state?.request)
    target?.scrollIntoView?.({ block: 'nearest' })
    target?.focus()
    return () => opener?.focus?.()
  }, [])
  const onClose = props.onClose ?? (() => closeOverlay())
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else trapTab(event, panel.current)
  }
  return <DrawerView {...props} onClose={onClose} now={Date.now()} onKeyDown={onKeyDown} panelRef={panel} filter={filter} onShowAll={onShowAll} />
}
