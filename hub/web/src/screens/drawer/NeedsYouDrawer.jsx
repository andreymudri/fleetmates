import React, { useEffect, useReducer, useRef, useState } from 'react'
import { AnswerControls } from '../../components/AnswerControls.jsx'
import { CARD_COPY } from '../../components/SessionCard.jsx'
import { requestSummary } from '../../components/Counts.jsx'
import { EmptyState } from '../../components/EmptyState.jsx'
import { Icon, compactDuration, shown, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { addRule, answerBatch, answerRequest, revokeRule, sendFollowup } from '../../state/actions.js'
import { TOKEN_KEY, createApiClient } from '../../state/api.js'
import { needsFilterParam, parseNeedsFilter } from '../../state/deck-store.js'

/**
 * English copy for the Needs-you drawer (docs/deck/screens/needs-you-drawer.md section 9). `drawer.rule.undo`
 * ("Undo") is the toast action the M3 plan, Task 12, quotes; the copy deck gains it with Task 18.
 */
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
  'drawer.row.deny': 'Deny',
  'drawer.row.allowOnce': 'Allow once',
  'drawer.row.reply.label': 'Reply',
  'drawer.row.reply.placeholder': 'Reply to {repo}',
  'drawer.row.reply.send': 'Reply',
  'drawer.row.other': 'Other',
  'drawer.row.openTerminal': 'Open terminal',
  'drawer.row.queued': 'Queued behind another prompt in this session',
  'drawer.row.sent': 'Sent · checking…',
  'drawer.row.didNotLand': 'Your answer did not reach {repo}. The prompt is still open in its terminal.',
  'drawer.row.tryAgain': 'Try again',
  'drawer.row.answeredTerminal': 'Answered in the terminal',
  'drawer.row.movedOn': 'The session moved on',
  'drawer.row.tellInstead': 'Tell Claude what to do instead',
  'drawer.row.tellInstead.send': 'Send',
  'drawer.row.deckdDown': 'deckd is reconnecting. Answer in your terminal for now.',
  'drawer.safe.batch': '{n, plural, =2 {Allow both Safe once} other {Allow all # Safe once}}',
  'drawer.safe.batch.toast': 'Allowed {ok} of {n}',
  'drawer.safe.batch.toastPartial': 'Allowed {ok} of {n}: {failed} did not land',
  'drawer.rule.suggest': 'You allowed {command} in {repo} {n} times. Make it a rule?',
  'drawer.rule.suggest.anyFlags': 'It will allow {command} with any flags.',
  'drawer.rule.added': 'Rule added to {repo}: {pattern}',
  'drawer.rule.undo': 'Undo',
  'drawer.footer': 'Alt A allow focused · Alt D deny · Alt Shift A allow all Safe · rules live in each repo\'s .claude/settings.local.json',
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

// A row's primary action, in this order: the Destructive confirm checkbox, Allow once, the first question
// option, the reply field. A row whose answers are all disabled (deckd down, queued) has none.
const PRIMARY = ['.answer-confirm input:not([disabled])', '.answer-buttons .button--primary:not([disabled])', '.answer-options button:not([disabled])', '.answer-reply-input:not([disabled])']
const primaryIn = row => {
  if (typeof row?.querySelector !== 'function') return null
  for (const selector of PRIMARY) {
    const found = row.querySelector(selector)
    if (found) return found
  }
  return null
}
const rowIn = (panel, requestId) => panel && requestId ? [...panel.querySelectorAll('.drawer-row')].find(row => row.getAttribute('data-request') === requestId) ?? null : null

/**
 * The element the drawer focuses when it opens (needs-you-drawer.md 8): the named request's primary action
 * (the confirm checkbox on a Destructive row, else Allow once, else its first option or reply field), else that
 * row's Open; with no named row, the first row's primary action, else the first row's Open, else Close.
 * @param {ParentNode | null} panel
 * @param {string | null | undefined} requestId
 * @returns {Element | null}
 */
export function drawerFocusTarget(panel, requestId) {
  if (!panel) return null
  const row = rowIn(panel, requestId)
  const named = row ? primaryIn(row) ?? row.querySelector('a') : null
  return named ?? primaryIn(panel.querySelector('.drawer-row')) ?? panel.querySelector('.drawer-row a') ?? panel.querySelector('.drawer-close')
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

/** How long a row that left while visible keeps its note ("Answered in the terminal", needs-you-drawer.md 5). */
export const NOTE_MS = 3000
/** How long a row denied from the deck keeps "Tell Claude what to do instead" (state-machines 2.5). */
export const FOLLOWUP_MS = 30_000
/** How long a drawer toast (batch result, rule added) stays. */
export const TOAST_MS = 6000

const IN_FLIGHT = new Set(['sending', 'verifying'])
const OUTAGE = new Set(['down', 'reconnecting'])
const GONE = new Set(['ended', 'crashed'])

const sessionOf = (state, request) => (state.data.sessions ?? []).find(row => row.id === request.sessionId) ?? null
const observed = session => session?.origin === 'observed'
const openOf = state => (state.data.requests ?? []).filter(row => (row.state ?? 'open') === 'open')

/**
 * Whether deckd is down for answering: the store's outage flag, or a deckd health row that is down or reconnecting.
 * @param {{ deckdOutage?: boolean, data: { health?: object[] } }} state
 * @returns {boolean}
 */
export function deckdDown(state) {
  const deckd = (state.data.health ?? []).find(row => row.dep === 'deckd')
  return !!state.deckdOutage || OUTAGE.has(deckd?.state)
}

/**
 * Whether the drawer may send a permission answer for this request now: a PTY session, deckd up, the prompt
 * not queued, no answer in flight or failed, and options parsed from the screen. The server re-checks all of it.
 * @param {object} request
 * @param {object | null} session
 * @param {boolean} down
 * @returns {boolean}
 */
export function answerable(request, session, down) {
  return request.kind === 'permission' && !observed(session) && !down && request.screenMatch !== 'queued'
    && !IN_FLIGHT.has(request.delivery) && request.delivery !== 'did_not_land' && (request.options?.length ?? 0) > 0
}

/**
 * The ids a Safe batch covers among the given (visible) rows: Safe permission requests of PTY sessions with
 * parsed options and no answer in flight. Caution, Destructive, questions and observed rows never join.
 * @param {object[]} rows
 * @param {object} state
 * @returns {string[]}
 */
export function batchIds(rows, state) {
  const down = deckdDown(state)
  return rows.filter(row => tierOf(row) === 'safe' && row.kind === 'permission' && !observed(sessionOf(state, row)) && !down
    && !IN_FLIGHT.has(row.delivery) && row.delivery !== 'did_not_land' && (row.options?.length ?? 0) > 0).map(row => row.id)
}

/**
 * The command a rule pattern allows, for the suggestion line: `Bash(cargo test:*)` and `Bash(cargo test *)`
 * read "cargo test", `Bash(npm run lint)` reads "npm run lint"; any other pattern is shown as it is.
 * @param {string} pattern
 * @returns {string}
 */
export function ruleCommand(pattern) {
  const text = String(pattern ?? '')
  const match = /^Bash\((.*?)(?::\*| \*)?\)$/s.exec(text)
  return match ? match[1] : text
}

/**
 * What the drawer shows: the sections over the open requests plus the rows still lingering after they left,
 * under the run or task filter; `rows` lists the answerable (not lingering) rows in display order.
 * @param {object} state
 * @param {{ filter?: object | null, lingering?: { request: object, kind: string }[] }} [options]
 * @returns {{ sections: { tier: string, requests: object[] }[], notes: Map<string, string>, rows: object[] }}
 */
export function drawerModel(state, { filter = null, lingering = [] } = {}) {
  const open = openOf(state)
  const openIds = new Set(open.map(row => row.id))
  const kept = lingering.filter(item => !openIds.has(item.request.id))
  const sections = drawerSections(filterRequests([...open, ...kept.map(item => ({ ...item.request, state: 'open' }))], filter, state.data))
  const notes = new Map(kept.map(item => [item.request.id, item.kind]))
  return { sections, notes, rows: sections.flatMap(section => section.requests).filter(row => !notes.has(row.id)) }
}

/**
 * The focused request: the local choice while that row is still shown, else the first row (or null).
 * @param {object} state
 * @param {{ filter?: object | null, local: { focused: string | null, lingering: object[] } }} options
 * @returns {string | null}
 */
export function focusedRequest(state, { filter = null, local }) {
  const { rows } = drawerModel(state, { filter, lingering: local.lingering })
  return rows.some(row => row.id === local.focused) ? local.focused : rows[0]?.id ?? null
}

/**
 * Requests that left the open list while the drawer showed them, with the note each keeps: one the deck denied
 * keeps the follow-up field for {@link FOLLOWUP_MS}; one the deck answered otherwise leaves at once; any other
 * reads "The session moved on" when its session ended or is gone, else "Answered in the terminal", for
 * {@link NOTE_MS}. The closing event's reason is not kept by the store, so the session state decides between
 * the two notes.
 * @param {object[]} before open requests shown before
 * @param {object[]} after open requests now
 * @param {{ busy?: Record<string, object>, sessions?: object[], now: number }} options
 * @returns {{ request: object, kind: 'followup' | 'terminal' | 'movedOn', until: number }[]}
 */
export function departures(before, after, { busy = {}, sessions = [], now }) {
  const still = new Set((after ?? []).map(row => row.id))
  const out = []
  for (const request of before ?? []) {
    if (still.has(request.id)) continue
    const sent = busy[request.id]
    if (sent?.choice === 'deny') out.push({ request, kind: 'followup', until: now + FOLLOWUP_MS })
    else if (!sent) {
      const session = (sessions ?? []).find(row => row.id === request.sessionId)
      out.push({ request, kind: !session || GONE.has(session.state) ? 'movedOn' : 'terminal', until: now + NOTE_MS })
    }
  }
  return out
}

/**
 * The drawer's own state: the focused row, the ticked Destructive checkboxes, the answer in flight per request
 * (the AnswerBody "Try again" re-sends), the rows lingering after they left, and the drawer's toasts.
 * @returns {{ focused: string | null, confirmed: Record<string, true>, busy: Record<string, object>, lingering: object[], toasts: object[], nextToast: number }}
 */
export function initialDrawerLocal() {
  return { focused: null, confirmed: {}, busy: {}, lingering: [], toasts: [], nextToast: 1 }
}

const without = (map, ids) => {
  const next = { ...map }
  for (const id of ids) delete next[id]
  return next
}

/**
 * Reducer for {@link initialDrawerLocal}. `close` resets everything, so every checkbox is unticked the next
 * time the drawer opens (state-machines 2.7 row 8).
 * @param {ReturnType<typeof initialDrawerLocal>} local
 * @param {{ type: string, [key: string]: any }} action
 * @returns {ReturnType<typeof initialDrawerLocal>}
 */
export function drawerLocal(local, action) {
  switch (action.type) {
    case 'focus':
      return { ...local, focused: action.id }
    case 'confirm':
      return { ...local, confirmed: action.checked ? { ...local.confirmed, [action.id]: true } : without(local.confirmed, [action.id]) }
    case 'busy':
      return { ...local, busy: { ...local.busy, [action.id]: action.body } }
    case 'settled':
      return { ...local, busy: without(local.busy, action.ids) }
    case 'linger': {
      const ids = action.items.map(item => item.request.id)
      return { ...local, busy: without(local.busy, ids), lingering: [...local.lingering.filter(item => !ids.includes(item.request.id)), ...action.items] }
    }
    case 'unlinger':
      return { ...local, lingering: local.lingering.filter(item => item.request.id !== action.id) }
    case 'prune':
      return { ...local, lingering: local.lingering.filter(item => item.until > action.now), toasts: local.toasts.filter(item => item.until > action.now) }
    case 'toast':
      return { ...local, toasts: [...local.toasts, { ...action.toast, id: local.nextToast }], nextToast: local.nextToast + 1 }
    case 'untoast':
      return { ...local, toasts: local.toasts.filter(item => item.id !== action.id) }
    case 'close':
      return initialDrawerLocal()
    default:
      return local
  }
}

/**
 * The drawer's answer, batch, rule and follow-up calls over the REST helpers, reporting through `dispatch`
 * ({@link drawerLocal} actions). A single answer gets no toast; a batch gets one ("Allowed {ok} of {n}" or
 * "Allowed {ok} of {n}: {failed} did not land"); an accepted rule toasts "Rule added to {repo}: {pattern}"
 * with an Undo that revokes it. The body of every answer stays in `busy` until the request leaves, except
 * after a refusal, so a row that did not land can resend it.
 * @param {{ api: object, dispatch: (action: object) => void, state: object, t?: Function, now?: () => number }} options
 */
export function drawerActions({ api, dispatch, state, t, now = () => Date.now() }) {
  const tr = (key, params) => translate(t, DRAWER_COPY, key, params)
  const toast = item => dispatch({ type: 'toast', toast: { until: now() + TOAST_MS, ...item } })
  return {
    focus: id => dispatch({ type: 'focus', id }),
    confirm: (id, checked) => dispatch({ type: 'confirm', id, checked }),
    answer(request, body) {
      dispatch({ type: 'busy', id: request.id, body })
      return answerRequest(api, request.id, body).catch(() => dispatch({ type: 'settled', ids: [request.id] }))
    },
    batch(ids) {
      if (!ids.length) return Promise.resolve()
      for (const id of ids) dispatch({ type: 'busy', id, body: { choice: 'allow' } })
      const report = ok => {
        const failed = ids.length - ok
        toast({ text: failed ? tr('drawer.safe.batch.toastPartial', { ok, n: ids.length, failed }) : tr('drawer.safe.batch.toast', { ok, n: ids.length }) })
      }
      return answerBatch(api, ids).then(reply => {
        const results = reply?.results ?? []
        const refused = results.filter(row => !row.ok && row.error?.code !== 'did_not_land').map(row => row.id)
        if (refused.length) dispatch({ type: 'settled', ids: refused })
        report(results.filter(row => row.ok).length)
      }, () => {
        dispatch({ type: 'settled', ids })
        report(0)
      })
    },
    acceptRule(offer) {
      const row = (state.data.repos ?? []).find(item => item.id === offer.repoId)
      const name = repoFor(state.data.repos, offer.repoId).name
      const repoKey = row?.repoKey ?? name
      return addRule(api, { repoKey, pattern: offer.pattern, source: 'suggested' }).then(reply => {
        const pattern = reply?.rule?.pattern ?? offer.pattern
        toast({ text: tr('drawer.rule.added', { repo: shown(name), pattern: shown(pattern) }), undo: { repoKey, pattern } })
      }, () => {})
    },
    undo(item) {
      dispatch({ type: 'untoast', id: item.id })
      return revokeRule(api, item.undo.repoKey, item.undo.pattern).catch(() => {})
    },
    followup(id, text) {
      if (!String(text ?? '').trim()) {
        dispatch({ type: 'unlinger', id })
        return Promise.resolve()
      }
      return sendFollowup(api, id, text).then(() => dispatch({ type: 'unlinger', id }), () => dispatch({ type: 'unlinger', id }))
    }
  }
}

const typing = target => target?.tagName === 'TEXTAREA' || (target?.tagName === 'INPUT' && (target.type ?? 'text') === 'text')

/**
 * The drawer's keys (keyboard.md 3, needs-you-drawer.md 6), over the rows the drawer shows under its filter:
 * Up and Down move the focused request; `Alt A` allows the focused request once, but on a Destructive row only
 * moves focus to its checkbox; `Alt D` denies it; `Alt Shift A` allows every visible Safe row ({@link batchIds})
 * and nothing else. Enter is not handled, so it never presses a disabled Allow once. Matched on `event.code`.
 * @param {KeyboardEvent} event
 * @param {{ state: object, filter?: object | null, local: object, actions: ReturnType<typeof drawerActions>, focusRow?: (id: string) => void, focusConfirm?: (id: string) => void }} context
 * @returns {boolean} whether the key was the drawer's
 */
export function drawerKeyDown(event, { state, filter = null, local, actions, focusRow = () => {}, focusConfirm = () => {} }) {
  if (event.ctrlKey || event.metaKey) return false
  const { rows } = drawerModel(state, { filter, lingering: local.lingering })
  const focused = focusedRequest(state, { filter, local })
  const index = rows.findIndex(row => row.id === focused)
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey && !event.shiftKey) {
    if (!rows.length || typing(event.target)) return false
    event.preventDefault()
    const next = rows[event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1)]
    actions.focus(next.id)
    focusRow(next.id)
    return true
  }
  if (!event.altKey) return false
  if (event.code === 'KeyA' && event.shiftKey) {
    event.preventDefault()
    const ids = batchIds(rows, state)
    if (ids.length) actions.batch(ids)
    return true
  }
  const current = rows[index]
  if (event.shiftKey || !current || (event.code !== 'KeyA' && event.code !== 'KeyD')) return false
  event.preventDefault()
  if (event.code === 'KeyA' && tierOf(current) === 'destructive') {
    actions.focus(current.id)
    focusConfirm(current.id)
    return true
  }
  if (answerable(current, sessionOf(state, current), deckdDown(state))) actions.answer(current, { choice: event.code === 'KeyA' ? 'allow' : 'deny' })
  return true
}

const NOOP_ACTIONS = Object.freeze({ focus() {}, confirm() {}, answer() {}, batch() {}, acceptRule() {}, undo() {}, followup() {} })

function answerLabels(t) {
  const tr = key => translate(t, DRAWER_COPY, key)
  return {
    deny: tr('drawer.row.deny'), allowOnce: tr('drawer.row.allowOnce'), answerInTerminal: tr('drawer.row.answerInTerminal'), open: tr('drawer.row.open'),
    openTerminal: tr('drawer.row.openTerminal'), deckdDown: tr('drawer.row.deckdDown'), queued: tr('drawer.row.queued'), sent: tr('drawer.row.sent'),
    didNotLand: tr('drawer.row.didNotLand'), tryAgain: tr('drawer.row.tryAgain'), replyLabel: tr('drawer.row.reply.label'),
    replyPlaceholder: tr('drawer.row.reply.placeholder'), reply: tr('drawer.row.reply.send')
  }
}

function Followup({ id, t, actions }) {
  const submit = event => {
    event.preventDefault()
    actions.followup(id, String(event.currentTarget?.elements?.followup?.value ?? ''))
  }
  const label = translate(t, DRAWER_COPY, 'drawer.row.tellInstead')
  return (
    <form className="drawer-followup" onSubmit={submit}>
      <label className="drawer-followup-label">{label}
        <input type="text" name="followup" className="answer-reply-input" />
      </label>
      <button type="submit" className="button button--amber button--xs">{translate(t, DRAWER_COPY, 'drawer.row.tellInstead.send')}</button>
    </form>
  )
}

function Row({ request, state, now, t, go, focused, note, local, actions, down }) {
  const session = sessionOf(state, request)
  const repo = repoFor(state.data.repos, session?.repoId)
  const href = `/s/${encodeURIComponent(request.sessionId)}`
  const question = tierOf(request) === 'question'
  const open = <a className="button button--ghost button--xs" href={href} onClick={linkHandler(go, href)}>{translate(t, DRAWER_COPY, 'drawer.row.open')}</a>
  let body
  if (note === 'followup') body = <Followup id={request.id} t={t} actions={actions} />
  else if (note) body = <p className="drawer-note">{translate(t, DRAWER_COPY, note === 'movedOn' ? 'drawer.row.movedOn' : 'drawer.row.answeredTerminal')}</p>
  else if (observed(session)) {
    body = (
      <div className="drawer-actions">
        <span className="request-terminal">{translate(t, DRAWER_COPY, 'drawer.row.answerInTerminal')}</span>
        {open}
      </div>
    )
  } else {
    body = (
      <>
        <div className={`drawer-answer${question ? ' drawer-answer--question' : ''}`}>
          <AnswerControls request={request} session={session} surface="drawer" deckd={{ down }} labels={answerLabels(t)} confirmed={!!local.confirmed[request.id]}
            onConfirm={checked => actions.confirm(request.id, checked)} onAnswer={answer => actions.answer(request, answer)} onOpen={() => go(href)} busy={local.busy[request.id] ?? null} />
          {question ? <span className="drawer-other">{translate(t, DRAWER_COPY, 'drawer.row.other')}</span> : null}
        </div>
        <div className="drawer-actions drawer-actions--open">{open}</div>
      </>
    )
  }
  return (
    <li className={`drawer-row drawer-row--${tierOf(request)}${note ? ' drawer-row--leaving' : ''}`} aria-label={question ? titleText(request.summary) : shown(request.summary)} data-request={request.id}
      aria-current={focused ? 'true' : undefined}>
      {question
        ? <p className="drawer-question"><bdi>{titleText(request.summary)}</bdi></p>
        : <code className="drawer-command">{shown(request.summary)}</code>}
      <p className="drawer-source">{sourceLine(request, session, repo, now, t)}</p>
      {body}
    </li>
  )
}

function RuleOffers({ offers, state, t, actions }) {
  if (!offers.length) return null
  return (
    <ul className="drawer-rules">
      {offers.map(offer => {
        const command = shown(ruleCommand(offer.pattern))
        const repo = shown(repoFor(state.data.repos, offer.repoId).name)
        return (
          <li key={`${offer.repoId}\n${offer.pattern}`} className="drawer-rule">
            <button type="button" className="drawer-rule-accept" onClick={() => actions.acceptRule(offer)}>
              {translate(t, DRAWER_COPY, 'drawer.rule.suggest', { command, repo, n: offer.count })}
            </button>
            {offer.ruleNote === 'anyFlags' ? <p className="drawer-rule-note">{translate(t, DRAWER_COPY, 'drawer.rule.suggest.anyFlags', { command })}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The Needs-you drawer body: every open request, by tier. A PTY session's row answers through
 * `AnswerControls` (`surface: 'drawer'`) and keeps "Open"; an observed session's row keeps the M1 actions,
 * "Answer in your terminal" and "Open", and nothing that answers. The Safe section carries the batch button
 * for 2 or more batchable Safe rows ({@link batchIds}) and the rule suggestion lines of `data.ruleOffers`
 * (with no Safe section they lead the body). Rows that left while shown keep their note or the follow-up field
 * (`local.lingering`); the drawer's toasts render above the footer. A run or task `filter` (D-69) keeps only
 * that run's or task's requests, and only those rows can be answered or batched, under the line
 * "Requests for {taskId}" or "Requests for run {runId}" with a "Show all" button calling `onShowAll`.
 * Pure: no hooks, so it can be walked in tests; `local` and `actions` come from {@link drawerLocal} and
 * {@link drawerActions}.
 * @param {{ state: object, t?: (key: string, params?: object) => string, now?: number, navigate: (to: string) => void, onClose?: () => void, onLeave?: () => void, onKeyDown?: Function, onFocus?: Function, panelRef?: object,
 *   filter?: { kind: 'run', runId: string } | { kind: 'task', runId: string, taskId: string } | null, onShowAll?: () => void,
 *   local?: ReturnType<typeof initialDrawerLocal>, actions?: ReturnType<typeof drawerActions>, focused?: string | null }} props
 */
export function DrawerView({ state, t, now = Date.now(), navigate, onClose = () => closeOverlay(), onLeave = () => leaveOverlay(), onKeyDown, onFocus, panelRef, filter = null, onShowAll = () => {},
  local = initialDrawerLocal(), actions = NOOP_ACTIONS, focused = local.focused }) {
  const go = to => {
    onLeave()
    navigate(to)
  }
  const active = filter && (filter.kind === 'run' || filter.kind === 'task') ? filter : null
  const model = state.loaded ? drawerModel(state, { filter: active, lingering: local.lingering }) : { sections: [], notes: new Map(), rows: [] }
  const { sections, notes } = model
  const down = state.loaded && deckdDown(state)
  const shownRepos = new Set(sections.flatMap(section => section.requests).map(row => sessionOf(state, row)?.repoId))
  const offers = (state.data.ruleOffers ?? []).filter(offer => !active || shownRepos.has(offer.repoId))
  const offersNode = <RuleOffers offers={offers} state={state} t={t} actions={actions} />
  const batch = batchIds(model.rows, state)
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
        {sections.some(section => section.tier === 'safe') ? null : offersNode}
        {sections.map(section => (
          <section key={section.tier} className={`drawer-section drawer-section--${section.tier}`} aria-labelledby={`drawer-section-${section.tier}`}>
            <h3 className="drawer-section-title"><span className={`tier-badge tier-badge--${section.tier}`}>{translate(t, CARD_COPY, `tier.${section.tier}`)}</span>
              <span className="drawer-section-count" id={`drawer-section-${section.tier}`}>{` · ${section.requests.length}`}</span></h3>
            {DRAWER_COPY[`drawer.${section.tier}.desc`] ? <p className="drawer-section-desc">{translate(t, DRAWER_COPY, `drawer.${section.tier}.desc`)}</p> : null}
            <ul className="drawer-rows">
              {section.requests.map(request => <Row key={request.id} request={request} state={state} now={now} t={t} go={go} focused={request.id === focused}
                note={notes.get(request.id) ?? null} local={local} actions={actions} down={down} />)}
            </ul>
            {section.tier === 'safe' && batch.length >= 2 ? (
              <div className="drawer-batch">
                <button type="button" className="button button--teal-outline button--xs" onClick={() => actions.batch(batch)}>{translate(t, DRAWER_COPY, 'drawer.safe.batch', { n: batch.length })}</button>
              </div>
            ) : null}
            {section.tier === 'safe' ? offersNode : null}
          </section>
        ))}
      </div>
    )
  }
  return (
    <div className="drawer-scrim" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onKeyDown={onKeyDown} onFocus={onFocus} ref={panelRef}>
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
        {local.toasts.length ? (
          <div className="drawer-toasts" role="status">
            {local.toasts.map(item => (
              <p key={item.id} className="drawer-toast">
                <span className="drawer-toast-text">{item.text}</span>
                {item.undo ? <button type="button" className="button button--ghost button--xs" onClick={() => actions.undo(item)}>{translate(t, DRAWER_COPY, 'drawer.rule.undo')}</button> : null}
              </p>
            ))}
          </div>
        ) : null}
        <footer className="drawer-footer">{translate(t, DRAWER_COPY, 'drawer.footer')}</footer>
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
 * The Needs-you drawer overlay: {@link DrawerView} wired to its local state ({@link drawerLocal}), the answer
 * calls ({@link drawerActions}, over `api` or {@link deckApi}), the drawer keys ({@link drawerKeyDown}), Esc,
 * the {@link trapTab} focus trap, initial focus from {@link drawerFocusTarget} (the request the history entry
 * names, else the first request's primary action, else its Open, else Close), focus returned to the opener on
 * close, and the history entry's filter ({@link drawerFilterFrom}), which "Show all" drops from the entry while
 * the drawer stays open. Requests that leave while shown are kept by {@link departures}; a timer prunes them and
 * the toasts. Closing (Esc, scrim, close button) resets the local state, so no checkbox stays ticked.
 * This browser wiring is not exercised by the unit tests; {@link DrawerView}, {@link drawerLocal},
 * {@link drawerActions}, {@link drawerKeyDown}, {@link departures}, {@link drawerFilterFrom} and {@link trapTab} are.
 * @param {{ state: object, t?: Function, navigate: (to: string) => void, onClose?: () => void, onLeave?: () => void, history?: History, api?: object }} props
 */
export function NeedsYouDrawer({ history = globalThis.history, api, ...props }) {
  const panel = useRef(null)
  const [filter, setFilter] = useState(() => drawerFilterFrom(history?.state))
  const [local, dispatch] = useReducer(drawerLocal, undefined, initialDrawerLocal)
  const { state } = props
  const http = api ?? deckApi()
  const actions = drawerActions({ api: http, dispatch, state, t: props.t })
  const focused = focusedRequest(state, { filter, local })
  const onShowAll = () => {
    setFilter(null)
    const { filter: _drop, ...rest } = history?.state ?? {}
    history?.replaceState(rest, '', here(globalThis.window))
  }
  useEffect(() => {
    const opener = globalThis.document?.activeElement
    const target = drawerFocusTarget(panel.current, history?.state?.request)
    const row = target?.closest?.('.drawer-row')?.getAttribute('data-request')
    if (row) dispatch({ type: 'focus', id: row })
    target?.scrollIntoView?.({ block: 'nearest' })
    target?.focus()
    return () => opener?.focus?.()
  }, [])
  const previous = useRef(null)
  const busy = useRef(local.busy)
  busy.current = local.busy
  useEffect(() => {
    const open = openOf(state)
    if (previous.current) {
      const items = departures(previous.current, open, { busy: busy.current, sessions: state.data.sessions, now: Date.now() })
      if (items.length) dispatch({ type: 'linger', items })
    }
    previous.current = open
  }, [state.data.requests])
  const timed = local.lingering.length + local.toasts.length > 0
  useEffect(() => {
    if (!timed) return undefined
    const timer = setInterval(() => dispatch({ type: 'prune', now: Date.now() }), 250)
    return () => clearInterval(timer)
  }, [timed])
  const close = props.onClose ?? (() => closeOverlay())
  const onClose = () => {
    dispatch({ type: 'close' })
    close()
  }
  const focusIn = (id, selector) => {
    const row = rowIn(panel.current, id)
    const target = selector ? row?.querySelector(selector) : primaryIn(row) ?? row?.querySelector('a')
    target?.scrollIntoView?.({ block: 'nearest' })
    target?.focus()
  }
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (drawerKeyDown(event, { state, filter, local, actions, focusRow: id => focusIn(id), focusConfirm: id => focusIn(id, '.answer-confirm input') })) return
    trapTab(event, panel.current)
  }
  const onFocus = event => {
    const id = event.target?.closest?.('.drawer-row')?.getAttribute('data-request')
    if (id && id !== local.focused) dispatch({ type: 'focus', id })
  }
  return <DrawerView {...props} onClose={onClose} now={Date.now()} onKeyDown={onKeyDown} onFocus={onFocus} panelRef={panel} filter={filter} onShowAll={onShowAll}
    local={local} actions={actions} focused={focused} />
}
