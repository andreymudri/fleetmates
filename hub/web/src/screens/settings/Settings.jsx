import React, { useEffect, useState } from 'react'
import { shown, titleText, translate } from '../../components/StatusPill.jsx'
import { linkHandler } from '../../shell/Rail.jsx'
import { deckApi } from '../drawer/NeedsYouDrawer.jsx'
import { Checklist } from '../first-run/FirstRun.jsx'

/** English copy for the M1 Settings sections (docs/deck/screens/settings.md section 9) plus the M1-only rows. */
export const SETTINGS_COPY = Object.freeze({
  'settings.title': 'Settings',
  'settings.nav.label': 'Settings sections',
  'settings.nav.appearance': 'Appearance and language',
  'settings.nav.appearance.sub': 'Density, text size {size}px, motion, EN / PT-BR',
  'settings.nav.rules': 'Approval rules',
  'settings.nav.rules.sub.later': 'Arrives with answering from the deck',
  'settings.nav.notifications': 'Notifications',
  'settings.nav.notifications.sub': 'Ship\'s bell, re-notify {min} min, quiet in meetings',
  'settings.nav.notifications.subNever': 'Ship\'s bell, no re-notify, quiet in meetings',
  'settings.nav.connections': 'Connections',
  'settings.nav.connections.sub': '{root}, vault, scribed, re-run checklist',
  'settings.nav.crew': 'Crew',
  'settings.nav.crew.sub': 'Colors, shapes and hats per repo',
  'settings.later': 'This section arrives in a later milestone.',
  'settings.notify.ok': 'Desktop notifications work through mako.',
  'settings.notify.broken': 'Desktop notifications are not working: notify-send exited {code}.',
  'settings.notify.brokenText': 'Desktop notifications are not working: {error}.',
  'settings.notify.untested': 'Send a test ping to check desktop notifications.',
  'settings.notify.test': 'Send test ping',
  'settings.notify.bell': 'Ship\'s bell when a session needs you',
  'settings.notify.bell.hint': 'Once per session, not repeated.',
  'settings.notify.renotify': 'Re-notify if ignored',
  'settings.notify.renotify.after': 'after {n} min',
  'settings.notify.renotify.never': 'Never',
  'settings.notify.done': 'Notify when a session finishes with changes',
  'settings.notify.quiet': 'Quiet in meetings',
  'settings.notify.quiet.hint': 'While TurbidAssist records: no sound, popups still show.',
  'settings.notify.crash': 'Popup when a session crashes',
  'settings.conn.scanRoot': 'Repos folder',
  'settings.conn.repos': '{n, plural, one {# repo found} other {# repos found}}',
  'settings.conn.rescan': 'Rescan',
  'settings.conn.vault': 'Vault',
  'settings.conn.obsidian': 'Obsidian vault name',
  'settings.conn.turbid': 'TurbidAssist config.yaml',
  'settings.conn.commands': 'Commands the deck runs',
  'settings.conn.claudeCommand': 'Claude Code command',
  'settings.conn.scribedCommand': 'scribed command',
  'settings.conn.vaultCommand': 'vault-mcp command',
  'settings.conn.current': 'Current: {value}',
  'settings.conn.save': 'Save',
  'settings.conn.env': 'Set by the environment',
  'settings.conn.services': 'Services',
  'settings.conn.dep.deckd': 'deckd',
  'settings.conn.dep.scribed': 'scribed',
  'settings.conn.dep.vault-mcp': 'vault-mcp',
  'settings.conn.state.ok': 'running',
  'settings.conn.state.checking': 'checking',
  'settings.conn.state.degraded': 'degraded',
  'settings.conn.state.down': 'down',
  'settings.conn.state.unknown': 'not checked yet',
  'settings.conn.reason': '{dep} {state}: {reason}',
  'settings.conn.status': '{dep} {state}',
  'settings.conn.start.deckd': 'Start deckd',
  'settings.conn.start.scribed': 'Start scribed',
  'settings.conn.startError': 'Could not start {dep}: {error}',
  'settings.conn.checklist': 'Run the setup checklist again',
  'settings.conn.stale': 'A running session counts as adrift after {n} min without activity.',
  'settings.saveError': 'Could not save {setting}: {error}'
})

/** Every Settings section in nav order; M1 fills Notifications and Connections. */
export const SECTIONS = Object.freeze(['appearance', 'rules', 'notifications', 'connections', 'crew'])
/** Sections with content in M1. */
export const M1_SECTIONS = Object.freeze(['notifications', 'connections'])
/** Notification preferences edited in M1, with their control type (settings.md 4.4). */
export const NOTIFY_PREFS = Object.freeze([
  { key: 'bell', control: 'checkbox', label: 'settings.notify.bell', hint: 'settings.notify.bell.hint' },
  { key: 'renotifyAfter', control: 'select', label: 'settings.notify.renotify', options: [5, 10, 20, null] },
  { key: 'notifyDone', control: 'checkbox', label: 'settings.notify.done' },
  { key: 'quietInMeetings', control: 'checkbox', label: 'settings.notify.quiet', hint: 'settings.notify.quiet.hint' },
  { key: 'notifyCrash', control: 'checkbox', label: 'settings.notify.crash' }
])
/** Connection text preferences (settings.md 4.5); the three commands are executed by the server. */
export const CONNECTION_PREFS = Object.freeze([
  { key: 'scanRoot', label: 'settings.conn.scanRoot' },
  { key: 'vaultPath', label: 'settings.conn.vault', id: 'vault', nullable: true },
  { key: 'obsidianVaultName', label: 'settings.conn.obsidian', nullable: true },
  { key: 'turbidassistConfig', label: 'settings.conn.turbid', nullable: true }
])
/** Command preferences the server executes; shown only through `shown`, sent only through the authenticated api. */
export const COMMAND_PREFS = Object.freeze([
  { key: 'claudeCommand', label: 'settings.conn.claudeCommand' },
  { key: 'scribedCommand', label: 'settings.conn.scribedCommand' },
  { key: 'vaultCommand', label: 'settings.conn.vaultCommand', argv: true }
])

/**
 * Nav rows with their live subtitles (settings.md 4.1). Server values pass through `shown`.
 * @param {object} prefs
 * @param {Function} [t]
 * @returns {{ id: string, title: string, sub: string, href: string }[]}
 */
export function settingsNav(prefs = {}, t) {
  const tr = (key, params) => translate(t, SETTINGS_COPY, key, params)
  const subs = {
    appearance: tr('settings.nav.appearance.sub', { size: Number(prefs.textSize ?? 14) }),
    rules: tr('settings.nav.rules.sub.later'),
    notifications: prefs.renotifyAfter === null ? tr('settings.nav.notifications.subNever') : tr('settings.nav.notifications.sub', { min: Number(prefs.renotifyAfter ?? 10) }),
    connections: tr('settings.nav.connections.sub', { root: shown(prefs.scanRoot ?? '~/dev') }),
    crew: tr('settings.nav.crew.sub')
  }
  return SECTIONS.map(id => ({ id, title: tr(`settings.nav.${id}`), sub: subs[id], href: `/settings/${id}` }))
}

/**
 * Text a preference shows in its field: argv arrays join with spaces; controls and hidden characters become visible tokens.
 * @param {unknown} value
 * @returns {string}
 */
export function prefText(value) {
  if (value === null || value === undefined) return ''
  return shown(Array.isArray(value) ? value.join(' ') : value)
}

/**
 * Parse a field back into a preference value, or `undefined` when it cannot be sent
 * (empty for a non-nullable key, or a NUL character, which the server refuses).
 * @param {{ key: string, argv?: boolean, nullable?: boolean }} pref
 * @param {string} text
 * @returns {unknown}
 */
export function parsePref(pref, text) {
  const value = String(text ?? '').trim()
  if (value.includes('\0')) return undefined
  if (!value) return pref.nullable ? null : undefined
  if (pref.argv) return value.split(/\s+/)
  return value
}

/**
 * Persist one preference through the authenticated api (`PATCH /api/prefs`, applied immediately, no Save button).
 * @param {{ patch: Function }} api
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<any>}
 */
export function savePref(api, key, value) {
  return api.patch('/api/prefs', { [key]: value })
}

/**
 * Notification status line from the `notify` health row or the last test ping.
 * @param {{ state?: string, reason?: string | null, exitCode?: number } | null} status
 * @param {Function} [t]
 * @returns {{ tone: 'ok'|'bad'|'todo', text: string }}
 */
export function notifyStatus(status, t) {
  const tr = (key, params) => translate(t, SETTINGS_COPY, key, params)
  if (status?.state === 'ok') return { tone: 'ok', text: tr('settings.notify.ok') }
  if (status?.state === 'down' || status?.state === 'degraded' || status?.state === 'failed') {
    if (status.exitCode !== undefined && status.exitCode !== null) return { tone: 'bad', text: tr('settings.notify.broken', { code: shown(status.exitCode) }) }
    return { tone: 'bad', text: tr('settings.notify.brokenText', { error: shown(status.reason ?? 'failed') }) }
  }
  return { tone: 'todo', text: tr('settings.notify.untested') }
}

/**
 * One dependency status line for Connections from its health row; the reason is server text and goes through `shown`.
 * @param {object | undefined} row a Health row
 * @param {string} dep
 * @param {Function} [t]
 * @returns {{ tone: string, text: string }}
 */
export function depStatus(row, dep, t) {
  const tr = (key, params) => translate(t, SETTINGS_COPY, key, params)
  const state = ['ok', 'checking', 'degraded', 'down'].includes(row?.state) ? row.state : 'unknown'
  const params = { dep: tr(`settings.conn.dep.${dep}`), state: tr(`settings.conn.state.${state}`) }
  const text = row?.reason && state !== 'ok' ? tr('settings.conn.reason', { ...params, reason: shown(row.reason) }) : tr('settings.conn.status', params)
  return { tone: state === 'ok' ? 'ok' : state === 'down' || state === 'degraded' ? 'bad' : 'todo', text }
}

function Field({ hint, children, error }) {
  return (
    <div className="setting-row">
      {children}
      {hint ? <p className="setting-hint">{hint}</p> : null}
      {error ? <p className="setting-error" role="status"><bdi>{error}</bdi></p> : null}
    </div>
  )
}

/**
 * Notifications section, pure (settings.md 4.4).
 * @param {{ prefs: object, sources?: object, t?: Function, status: ReturnType<typeof notifyStatus>, pinging?: boolean, errors?: Record<string, string>, onChange: (key: string, value: unknown) => void, onTestPing: () => void }} props
 */
export function NotificationsSection({ prefs, sources = {}, t, status, pinging = false, errors = {}, onChange, onTestPing }) {
  const tr = (key, params) => translate(t, SETTINGS_COPY, key, params)
  return (
    <section className="settings-section" aria-labelledby="settings-notifications-title">
      <h2 className="settings-heading" id="settings-notifications-title">{tr('settings.nav.notifications')}</h2>
      <div className={`setting-status setting-status--${status.tone}`}>
        <p className="setting-status-text" role="status"><bdi>{status.text}</bdi></p>
        <button type="button" className="button button--secondary" aria-busy={pinging ? 'true' : undefined} onClick={() => { if (!pinging) onTestPing() }}>{tr('settings.notify.test')}</button>
      </div>
      {NOTIFY_PREFS.map(pref => {
        const id = `pref-${pref.key}`
        const locked = sources[pref.key] === 'env'
        const control = pref.control === 'checkbox'
          ? <label className="setting-check" htmlFor={id}><input id={id} type="checkbox" checked={!!prefs[pref.key]} disabled={locked} onChange={event => onChange(pref.key, event.target.checked)} /> {tr(pref.label)}</label>
          : (
            <label className="setting-select" htmlFor={id}>{tr(pref.label)}
              <select id={id} value={prefs[pref.key] === null ? 'never' : String(prefs[pref.key] ?? 10)} disabled={locked}
                onChange={event => onChange(pref.key, event.target.value === 'never' ? null : Number(event.target.value))}>
                {pref.options.map(option => option === null
                  ? <option key="never" value="never">{tr('settings.notify.renotify.never')}</option>
                  : <option key={option} value={String(option)}>{tr('settings.notify.renotify.after', { n: option })}</option>)}
              </select>
            </label>
          )
        return <Field key={pref.key} hint={pref.hint ? tr(pref.hint) : null} error={errors[pref.key]}>{control}</Field>
      })}
    </section>
  )
}

function TextPref({ pref, value, locked, t, error, onSave }) {
  const tr = (key, params) => translate(t, SETTINGS_COPY, key, params)
  const id = pref.id ?? `pref-${pref.key}`
  const current = prefText(value)
  const submit = event => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem(pref.key)
    const next = parsePref(pref, input?.value)
    if (next === undefined || prefText(next) === current) return
    onSave(pref.key, next)
  }
  return (
    <form className="setting-row setting-text" onSubmit={submit}>
      <label className="setting-label" htmlFor={id}>{tr(pref.label)}</label>
      <div className="setting-field">
        <input id={id} name={pref.key} className="text-input" type="text" defaultValue={current} key={current} readOnly={locked} spellCheck={false} autoComplete="off" />
        {locked ? null : <button type="submit" className="button button--secondary button--xs">{tr('settings.conn.save')}</button>}
      </div>
      {pref.argv || COMMAND_PREFS.some(item => item.key === pref.key) ? <p className="setting-hint">{tr('settings.conn.current', { value: current })}</p> : null}
      {locked ? <p className="setting-hint">{tr('settings.conn.env')}</p> : null}
      {error ? <p className="setting-error" role="status"><bdi>{error}</bdi></p> : null}
    </form>
  )
}

/**
 * Connections section, pure (settings.md 4.5): folders, vault, TurbidAssist, the commands the deck runs,
 * dependency statuses with their start actions, the inline checklist and the stale threshold.
 * @param {{ prefs: object, sources?: object, health?: object[], t?: Function, errors?: Record<string, string>, found?: number | null, busy?: Record<string, boolean>, startErrors?: Record<string, string>, checklist?: React.ReactNode, onSave: (key: string, value: unknown) => void, onRescan: () => void, onStart: (dep: string) => void, onChecklist: () => void }} props
 */
export function ConnectionsSection({ prefs, sources = {}, health = [], t, errors = {}, found = null, busy = {}, startErrors = {}, checklist = null, onSave, onRescan, onStart, onChecklist }) {
  const tr = (key, params) => translate(t, SETTINGS_COPY, key, params)
  const text = pref => <TextPref key={pref.key} pref={pref} value={prefs[pref.key]} locked={sources[pref.key] === 'env'} t={t} error={errors[pref.key]} onSave={onSave} />
  return (
    <section className="settings-section" aria-labelledby="settings-connections-title">
      <h2 className="settings-heading" id="settings-connections-title">{tr('settings.nav.connections')}</h2>
      {text(CONNECTION_PREFS[0])}
      <div className="setting-row setting-inline">
        <button type="button" className="button button--secondary button--xs" aria-busy={busy.rescan ? 'true' : undefined} onClick={() => { if (!busy.rescan) onRescan() }}>{tr('settings.conn.rescan')}</button>
        {found === null ? null : <span className="setting-hint" role="status">{tr('settings.conn.repos', { n: found })}</span>}
      </div>
      {CONNECTION_PREFS.slice(1).map(text)}
      <h3 className="settings-subheading">{tr('settings.conn.commands')}</h3>
      {COMMAND_PREFS.map(text)}
      <h3 className="settings-subheading">{tr('settings.conn.services')}</h3>
      <ul className="dep-list">
        {['deckd', 'scribed', 'vault-mcp'].map(dep => {
          const status = depStatus(health.find(row => row.dep === dep), dep, t)
          const startable = dep !== 'vault-mcp' && status.tone !== 'ok'
          return (
            <li key={dep} className={`dep-row dep-row--${status.tone}`}>
              <span className="dep-text"><bdi>{status.text}</bdi></span>
              {startable ? <button type="button" className="button button--secondary button--xs" aria-busy={busy[dep] ? 'true' : undefined}
                onClick={() => { if (!busy[dep]) onStart(dep) }}>{tr(`settings.conn.start.${dep}`)}</button> : null}
              {startErrors[dep] ? <p className="setting-error" role="status"><bdi>{tr('settings.conn.startError', { dep: tr(`settings.conn.dep.${dep}`), error: shown(startErrors[dep]) })}</bdi></p> : null}
            </li>
          )
        })}
      </ul>
      {checklist ?? <button type="button" className="button button--secondary" onClick={onChecklist}>{tr('settings.conn.checklist')}</button>}
      <p className="setting-hint settings-stale">{tr('settings.conn.stale', { n: Number(prefs.staleMinutes ?? 20) })}</p>
    </section>
  )
}

/**
 * Settings frame, pure: nav (links with `aria-current`), and the section, a skeleton while preferences load,
 * or the later-milestone note.
 * @param {{ section: string, prefs: object, loading?: boolean, t?: Function, navigate: (to: string) => void, children?: React.ReactNode }} props
 */
export function SettingsView({ section, prefs, loading = false, t, navigate, children }) {
  const tr = key => translate(t, SETTINGS_COPY, key)
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={tr('settings.nav.label')}>
        <h1 className="settings-title">{tr('settings.title')}</h1>
        <ul className="settings-nav-list">
          {settingsNav(prefs, t).map(row => (
            <li key={row.id}>
              <a className="settings-nav-link" href={row.href} aria-current={row.id === section ? 'page' : undefined} onClick={linkHandler(navigate, row.href)}>
                <span className="settings-nav-title">{row.title}</span>
                <span className="settings-nav-sub"><bdi>{titleText(row.sub)}</bdi></span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-content" aria-busy={loading ? 'true' : undefined}>
        {loading
          ? <>{[0, 1, 2].map(index => <div key={index} className="skeleton-panel motion-shimmer" aria-hidden="true" />)}</>
          : M1_SECTIONS.includes(section) ? children : <section className="settings-section"><h2 className="settings-heading">{tr(`settings.nav.${SECTIONS.includes(section) ? section : 'rules'}`)}</h2><p className="setting-hint">{tr('settings.later')}</p></section>}
      </div>
    </div>
  )
}

function failure(error) {
  return String(error?.details?.stderr ?? error?.message ?? error?.code ?? 'failed')
}

/**
 * The `/settings/:section` route screen: loads preference sources, saves each control immediately through the
 * authenticated api, reverts on failure with "Could not save {setting}: {error}", and embeds the checklist in
 * Connections. Browser wiring; the pure sections and {@link savePref} carry the tested behavior.
 * @param {{ route: { params: { section?: string } }, state: object, t?: Function, navigate: (to: string) => void, api?: object, feed?: object }} props
 */
export function Settings({ route, state, t, navigate, api, feed }) {
  const client = api ?? deckApi()
  const section = route.params.section ?? 'rules'
  const tr = (key, params) => translate(t, SETTINGS_COPY, key, params)
  const [sources, setSources] = useState(null)
  const [pending, setPending] = useState({})
  const [errors, setErrors] = useState({})
  const [ping, setPing] = useState(null)
  const [pinging, setPinging] = useState(false)
  const [found, setFound] = useState(null)
  const [busy, setBusy] = useState({})
  const [startErrors, setStartErrors] = useState({})
  const [checklist, setChecklist] = useState(false)
  useEffect(() => {
    let current = true
    client.get('/api/prefs').then(data => { if (current) setSources(data?.sources ?? {}) }).catch(() => { if (current) setSources({}) })
    return () => { current = false }
  }, [client])
  useEffect(() => {
    if (section !== 'connections' || !globalThis.location?.hash) return
    globalThis.document?.getElementById(globalThis.location.hash.slice(1))?.focus()
  }, [section, sources])
  const prefs = { ...state.data.prefs, ...pending }
  const known = { ...(sources ?? {}), ...state.data.sources }
  const onSave = (key, value) => {
    setPending(map => ({ ...map, [key]: value }))
    setErrors(map => ({ ...map, [key]: undefined }))
    savePref(client, key, value).then(() => {}, error => setErrors(map => ({ ...map, [key]: tr('settings.saveError', { setting: key, error: shown(failure(error)) }) })))
      .finally(() => setPending(map => { const next = { ...map }
        delete next[key]
        return next }))
  }
  const onTestPing = () => {
    setPinging(true)
    client.post('/api/notify/test').then(() => setPing({ state: 'ok' }), error => setPing({ state: 'failed', exitCode: error?.details?.exitCode, reason: failure(error) }))
      .finally(() => setPinging(false))
  }
  const onRescan = () => {
    setBusy(map => ({ ...map, rescan: true }))
    client.post('/api/repos/rescan').then(data => setFound(Number.isInteger(data?.found) ? data.found : null), () => setFound(null)).finally(() => setBusy(map => ({ ...map, rescan: false })))
  }
  const onStart = dep => {
    setBusy(map => ({ ...map, [dep]: true }))
    setStartErrors(map => ({ ...map, [dep]: undefined }))
    client.post(`/api/deps/${dep}/start`).catch(error => setStartErrors(map => ({ ...map, [dep]: failure(error) }))).finally(() => setBusy(map => ({ ...map, [dep]: false })))
  }
  const notifyRow = ping ?? state.data.health.find(row => row.dep === 'notify') ?? null
  let body = null
  if (section === 'notifications') {
    body = <NotificationsSection prefs={prefs} sources={known} t={t} status={notifyStatus(notifyRow, t)} pinging={pinging} errors={errors} onChange={onSave} onTestPing={onTestPing} />
  } else if (section === 'connections') {
    body = <ConnectionsSection prefs={prefs} sources={known} health={state.data.health} t={t} errors={errors} found={found} busy={busy} startErrors={startErrors}
      checklist={checklist ? <Checklist state={state} t={t} navigate={navigate} api={client} feed={feed} mode="rerun" onDone={() => setChecklist(false)} /> : null}
      onSave={onSave} onRescan={onRescan} onStart={onStart} onChecklist={() => setChecklist(true)} />
  }
  return <SettingsView section={section} prefs={prefs} loading={sources === null} t={t} navigate={navigate}>{body}</SettingsView>
}
