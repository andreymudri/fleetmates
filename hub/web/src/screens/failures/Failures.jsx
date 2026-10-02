import React from 'react'
import { StatusPill, pillParams, shown, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { repoFor } from '../drawer/NeedsYouDrawer.jsx'
import { Focus } from '../focus/Focus.jsx'
import { Home, ObserveOverlays } from '../home/Home.jsx'
import { FirstRun } from '../first-run/FirstRun.jsx'
import { Settings } from '../settings/Settings.jsx'
import { NewSession } from '../new-session/NewSession.jsx'
import { TeamRun } from '../team-run/TeamRun.jsx'
import { CrewSheet } from '../crew/CrewSheet.jsx'

/** English copy for the M1 failure patterns the screens place (docs/deck/screens/failures-and-loading.md section 9). */
export const FAIL_COPY = Object.freeze({
  'fail.deckd.title': 'deckd is unavailable',
  'fail.deckd.works': 'Sessions keep running and hooks keep reporting. Launching, answering and terminals wait for deckd.',
  'fail.deckd.reason': 'Last error: {reason}',
  'fail.deckd.start': 'Start deckd',
  'fail.history.title': 'Completed sessions',
  'fail.history.empty': 'No completed sessions yet.',
  'fail.notify.settings': 'Desktop notifications are not working: notify-send exited {code}.',
  'fail.notify.toast': 'Desktop notifications are not working.',
  'fail.notify.open': 'Open settings'
})

/** Session states kept in the completed history while deckd is away. */
export const HISTORY_STATES = Object.freeze(['done', 'reviewed', 'ended', 'crashed'])
/** Rows the completed history shows. */
export const HISTORY_MAX = 8

const FATAL = new Set(['token_invalid', 'origin_rejected', 'client_outdated'])

/**
 * Classify what the deck can show right now (failures-and-loading.md sections 2 and 4).
 * `fatal` replaces the page; `loading` means no snapshot yet (skeletons); `server` is the lost web-server link
 * with the last data kept; `deckd` is the PTY daemon down or reconnecting (its `reason` is server text, shown as is
 * through `shown` by the views); `notify` is a failing desktop notifier; `history` lists completed sessions, newest first.
 * @param {object} state deck store state
 * @param {number} [now]
 * @returns {{ fatal: string | null, loading: boolean, server: boolean, deckd: { state: string, reason: string | null, attempt: number } | null, notify: { code: unknown } | null, history: object[] }}
 */
export function failureModel(state, now = Date.now()) {
  const connection = state.connection.state
  const fatal = FATAL.has(connection) ? connection : null
  const loaded = !!state.loaded
  const deckdRow = state.data.health.find(row => row.dep === 'deckd')
  const deckd = loaded && deckdRow && ['down', 'reconnecting'].includes(deckdRow.state) ? { state: deckdRow.state, reason: deckdRow.reason ?? null, attempt: deckdRow.attempt ?? 0 } : null
  const notifyRow = state.data.health.find(row => row.dep === 'notify')
  const notify = loaded && notifyRow && ['down', 'degraded'].includes(notifyRow.state) ? { code: notifyRow.exitCode ?? notifyRow.reason ?? '' } : null
  const history = state.data.sessions.filter(row => HISTORY_STATES.includes(row.state))
    .sort((a, b) => (b.endedAt ?? b.stateSince ?? 0) - (a.endedAt ?? a.stateSince ?? 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, HISTORY_MAX)
  return { fatal, loading: !loaded && !fatal, server: connection === 'reconnecting', deckd, notify, history, now }
}

/**
 * Completed session history, kept visible while deckd is unavailable: repo, task and final state, each a link to Focus.
 * @param {{ sessions: object[], repos?: object[], t?: Function, navigate: (to: string) => void, now?: number }} props
 */
export function SessionHistory({ sessions, repos = [], t, navigate, now = Date.now() }) {
  const tr = key => translate(t, FAIL_COPY, key)
  return (
    <section className="fail-history" aria-labelledby="fail-history-title">
      <h2 className="fail-history-title" id="fail-history-title">{tr('fail.history.title')}</h2>
      {sessions.length ? (
        <ul className="fail-history-list">
          {sessions.map(row => {
            const href = `/s/${encodeURIComponent(row.id)}`
            return (
              <li key={row.id} className="fail-history-row">
                <a href={href} onClick={linkHandler(navigate, href)}>
                  <bdi className="fail-history-repo">{shown(repoFor(repos, row.repoId).name)}</bdi>
                  <span className="meta-sep" aria-hidden="true"> · </span>
                  <bdi className="fail-history-task">{titleText(row.task ?? '')}</bdi>
                </a>
                <StatusPill state={row.state} params={pillParams(row, now)} variant="text" t={t} />
              </li>
            )
          })}
        </ul>
      ) : <p className="setting-hint">{tr('fail.history.empty')}</p>}
    </section>
  )
}

/**
 * The failure notices a screen places above its content: deckd unavailable (what still works, the last error,
 * "Start deckd", and optionally the completed history) and failing desktop notifications with "Open settings".
 * The connection banner, skeletons and fatal pages belong to the shell.
 * @param {{ model: ReturnType<typeof failureModel>, repos?: object[], t?: Function, navigate: (to: string) => void, history?: boolean, onStartDeckd?: () => void }} props
 */
export function FailureNotices({ model, repos = [], t, navigate, history = false, onStartDeckd }) {
  const tr = (key, params) => translate(t, FAIL_COPY, key, params)
  if (!model.deckd && !model.notify) return null
  return (
    <div className="fail-notices">
      {model.deckd ? (
        <section className="fail-card fail-card--deckd" aria-labelledby="fail-deckd-title">
          <h2 className="fail-card-title" id="fail-deckd-title">{tr('fail.deckd.title')}</h2>
          <p className="fail-card-body">{tr('fail.deckd.works')}</p>
          {model.deckd.reason ? <p className="fail-card-reason"><bdi>{tr('fail.deckd.reason', { reason: shown(model.deckd.reason) })}</bdi></p> : null}
          {onStartDeckd ? <button type="button" className="button button--secondary button--xs" onClick={onStartDeckd}>{tr('fail.deckd.start')}</button> : null}
          {history ? <SessionHistory sessions={model.history} repos={repos} t={t} navigate={navigate} now={model.now} /> : null}
        </section>
      ) : null}
      {model.notify ? (
        <p className="fail-card fail-card--notify" role="status">
          <bdi>{tr('fail.notify.settings', { code: shown(model.notify.code) })}</bdi>{' '}
          <a href="/settings/notifications" onClick={linkHandler(navigate, '/settings/notifications')}>{tr('fail.notify.open')}</a>
        </p>
      ) : null}
    </div>
  )
}

/**
 * The shell's `screens` map: Home, Focus, First run and Settings from M1, and New session, Team run and the Crew sheet
 * from M2, each given the real authenticated `api` (so a 401 from any of them reaches the shell's fatal state through
 * the api's `onFatal`). Home, Focus, Settings, Team run and the Crew sheet place the failure notices; First run is
 * full-bleed, and New session shows deckd down in its own form over the screen it renders beneath it. Home and Focus
 * get the terminal client (`terminals`) and the store's `dispatch` for their toasts; New session gets this map itself.
 * The route components are plain functions without hooks, so tests can call them.
 * @param {{ api: object, feed?: object, terminals?: object | null, dispatch?: (action: object) => void, now?: () => number }} options
 * @returns {Record<string, Function>}
 */
export function deckScreens({ api, feed, terminals = null, dispatch, now = Date.now }) {
  const notices = (props, history) => (
    <FailureNotices model={failureModel(props.state, now())} repos={props.state.data.repos} t={props.t} navigate={props.navigate} history={history}
      onStartDeckd={() => { api.post('/api/deps/deckd/start').catch(() => {}) }} />
  )
  const screens = {
    home: function HomeScreen(props) {
      return <>{notices(props, true)}<Home state={props.state} t={props.t} navigate={props.navigate} api={api} terminals={terminals} dispatch={dispatch} /></>
    },
    focus: function FocusScreen(props) {
      return (
        <>
          {notices(props, false)}
          <Focus route={props.route} state={props.state} t={props.t} navigate={props.navigate} api={api} client={terminals} dispatch={dispatch} />
        </>
      )
    },
    new: function NewSessionScreen(props) {
      return <NewSession search={props.search} state={props.state} t={props.t} navigate={props.navigate} api={api} screens={screens} />
    },
    team: function TeamRunScreen(props) {
      return <>{notices(props, false)}<TeamRun route={props.route} search={props.search} state={props.state} t={props.t} navigate={props.navigate} api={api} /></>
    },
    crew: function CrewScreen(props) {
      return <>{notices(props, false)}<CrewSheet route={props.route} search={props.search} state={props.state} t={props.t} navigate={props.navigate} api={api} /></>
    },
    welcome: function WelcomeScreen(props) {
      return <FirstRun state={props.state} t={props.t} navigate={props.navigate} api={api} feed={feed} />
    },
    settings: function SettingsScreen(props) {
      return (
        <>
          {notices(props, false)}
          <Settings route={props.route} state={props.state} t={props.t} navigate={props.navigate} api={api} feed={feed} />
          <ObserveOverlays state={props.state} t={props.t} navigate={props.navigate} api={api} />
        </>
      )
    }
  }
  return screens
}
