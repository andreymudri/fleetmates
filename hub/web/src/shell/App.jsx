import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Rail, linkHandler } from './Rail.jsx'
import { messages as en, format } from '../i18n/en.js'
import { bannerFor, createAnnouncer, documentTitle, keyAction, matchRoute, resolveRoute, selectLanguage } from '../state/deck-store.js'

const PAGE_KEYS = {
  home: 'shell.page.home', new: 'shell.page.new', focus: 'shell.page.focus', team: 'shell.page.team', memory: 'shell.page.memory',
  memoryNote: 'shell.page.memory', research: 'shell.page.research', researchNew: 'shell.page.research', meetings: 'shell.page.meetings',
  meeting: 'shell.page.meetings', meetingLive: 'shell.page.meetings', settings: 'shell.page.settings', settingsIndex: 'shell.page.settings',
  crew: 'shell.page.crew', welcome: 'shell.page.welcome', notFound: 'shell.page.notFound'
}
const FATAL = { token_invalid: 'shell.fatal.token', origin_rejected: 'shell.fatal.origin', client_outdated: 'shell.fatal.outdated' }
const MAX_TOASTS = 3
const AUTO_DISMISS_MS = 6000

/**
 * Translator bound to the selected catalog, falling back per key to English.
 * @param {{ lang: string, messages: Record<string, string> }} language
 * @returns {(key: string, params?: object) => string}
 */
export function makeTranslator(language) {
  return (key, params) => format(language.messages[key] ?? en[key] ?? key, params, language.lang)
}

function clock(at, lang) {
  return at ? new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at) : ''
}

function Fatal({ state, t, onReload }) {
  return (
    <main className="fatal" id="main">
      <h1 className="fatal-title">{t('shell.fatal.heading')}</h1>
      <p className="fatal-body">{t(FATAL[state])}</p>
      {state === 'client_outdated' ? <button type="button" className="button button--primary" onClick={onReload}>{t('shell.fatal.reload')}</button> : null}
    </main>
  )
}

function Banner({ banner, t, lastEventAt, lang, onRetry }) {
  const text = banner.kind === 'server' ? t('fail.server.banner', banner) : t('fail.deckd.banner', banner)
  return (
    <div className={`banner banner--connection banner--${banner.kind}`} role="status">
      <span className="banner-text">{text}</span>
      {banner.kind === 'server' && lastEventAt ? <span className="banner-asof">{t('fail.server.asOf', { time: clock(lastEventAt, lang) })}</span> : null}
      <button type="button" className="button button--amber-outline button--xs" onClick={() => onRetry(banner.kind)}>{t('fail.retryNow')}</button>
    </div>
  )
}

function Loading({ route, t }) {
  const cards = route === 'home' ? 6 : 1
  return (
    <div className="skeleton-grid">
      <span className="sr-only">{t('fail.loading', { thing: t('fail.loading.sessions') })}</span>
      {Array.from({ length: cards }, (_, index) => <div key={index} className="skeleton-card motion-shimmer" aria-hidden="true" />)}
    </div>
  )
}

function Screen({ route, path, search, state, t, navigate, screens }) {
  const Custom = screens?.[route.name]
  // Keyed by path so /s/a and /s/b each get their own instance and no local state carries over.
  if (Custom) return <Custom key={path} route={route} search={search} state={state} t={t} navigate={navigate} />
  if (route.name === 'notFound') {
    return (
      <section className="screen screen--not-found">
        <h1 className="page-title">{t('shell.page.notFound')}</h1>
        <p>{t('shell.notFound')}</p>
        <a href="/" onClick={linkHandler(navigate, '/')}>{t('shell.notFound.home')}</a>
      </section>
    )
  }
  return (
    <section className={`screen screen--${route.name}`}>
      <h1 className="page-title">{t(PAGE_KEYS[route.name])}</h1>
      {route.name === 'home' ? null : <p className="screen-pending">{t('shell.page.pending')}</p>}
    </section>
  )
}

function Toast({ toast, t, navigate, dismiss, paused }) {
  useEffect(() => {
    if (!['info', 'success'].includes(toast.tone) || paused) return undefined
    const timer = setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id, toast.tone, paused, dismiss])
  return (
    <li className={`toast toast--${toast.tone}`}>
      <p className="toast-title">{toast.title}</p>
      {toast.body ? <p className="toast-body">{toast.body}</p> : null}
      <div className="toast-actions">
        {toast.sessionId ? <button type="button" className="button button--xs" onClick={() => { dismiss(toast.id)
          navigate(`/s/${encodeURIComponent(toast.sessionId)}`) }}>{t('shell.toast.open')}</button> : null}
        <button type="button" className="button button--ghost button--xs" onClick={() => dismiss(toast.id)}>{t('shell.toast.dismiss')}</button>
      </div>
    </li>
  )
}

function Toasts({ toasts, t, navigate, dismiss }) {
  const [paused, setPaused] = useState(false)
  if (!toasts.length) return null
  const visible = toasts.slice(-MAX_TOASTS)
  const hidden = toasts.length - visible.length
  return (
    <section className="toast-stack" aria-label={t('shell.toast.open')} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      {hidden > 0 ? <p className="toast-more">{t('shell.toast.more', { n: hidden })}</p> : null}
      <ol className="toast-list">{visible.map(toast => <Toast key={toast.id} toast={toast} t={t} navigate={navigate} dismiss={dismiss} paused={paused} />)}</ol>
    </section>
  )
}

/**
 * The shell for one route: skip link, Rail, banners, main, toasts and the live region.
 * Renders without a window so it can be tested with `renderToStaticMarkup`.
 * @param {{ store: object, path: string, search?: string, navigate: (to: string) => void, onRetry: (kind: string) => void, onReload?: () => void, announcement?: string, now?: number, screens?: Record<string, Function> }} props
 */
export function App({ store, path, search = '', navigate, onRetry, onReload = () => {}, announcement = '', now, screens }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const language = selectLanguage(state.data.prefs)
  const t = makeTranslator(language)
  const connection = state.connection.state
  const dismiss = useCallback(id => store.dispatch({ type: 'toast.dismiss', id }), [store])
  if (FATAL[connection]) return <Fatal state={connection} t={t} onReload={onReload} />
  const route = matchRoute(path)
  const banner = bannerFor(state, now ?? Date.now())
  const stale = state.loaded && connection === 'reconnecting'
  return (
    <div className={`shell${stale ? ' shell--stale' : ''}`} lang={language.lang}>
      <a className="sr-only-focusable sr-only skip-link" href="#main">{t('shell.skip')}</a>
      <Rail t={t} path={path} counts={state.loaded ? state.data.counts : null} recording={state.data.recorder?.state === 'recording'} navigate={navigate} />
      <main id="main" aria-busy={state.loaded ? undefined : 'true'} tabIndex={-1} className="shell-main">
        {banner ? <Banner banner={banner} t={t} lastEventAt={state.lastEventAt} lang={language.lang} onRetry={onRetry} /> : null}
        {language.fallback ? <p className="shell-notice" role="note">{t('shell.lang.fallback')}</p> : null}
        <div className="shell-content">
          {state.loaded ? <Screen route={route} path={path} search={search} state={state} t={t} navigate={navigate} screens={screens} /> : <Loading route={route.name} t={t} />}
        </div>
      </main>
      <Toasts toasts={state.toasts} t={t} navigate={navigate} dismiss={dismiss} />
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    </div>
  )
}

/**
 * Browser wiring around {@link App}: history routing, redirects, the capture-phase keyboard layer,
 * document title, live-region batching, countdown ticks and tab visibility.
 * @param {{ store: object, connection: { retryNow: () => void, visible: () => void }, api?: { post: Function }, screens?: Record<string, Function> }} props
 */
export function Shell({ store, connection, api, screens }) {
  const [path, setPath] = useState(() => window.location.pathname)
  const [search, setSearch] = useState(() => window.location.search)
  const [announcement, setAnnouncement] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const overlayRef = useRef(null)

  const navigate = useCallback((to, { replace = false } = {}) => {
    if (replace) window.history.replaceState(null, '', to)
    else window.history.pushState(null, '', to)
    setPath(window.location.pathname)
    setSearch(window.location.search)
  }, [])

  useEffect(() => {
    const onPop = event => {
      overlayRef.current = event.state?.overlay ?? null
      setPath(window.location.pathname)
      setSearch(window.location.search)
      store.dispatch({ type: 'view', path: window.location.pathname, overlay: overlayRef.current })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [store])

  useEffect(() => {
    store.dispatch({ type: 'view', path, overlay: overlayRef.current })
  }, [store, path])

  const target = resolveRoute(path, state)
  useEffect(() => {
    if (target) navigate(target, { replace: true })
  }, [target, navigate])

  useEffect(() => {
    if (!state.navigateTo) return
    store.dispatch({ type: 'navigated' })
    navigate(state.navigateTo)
  }, [state.navigateTo, store, navigate])

  useEffect(() => {
    const onKey = event => {
      const action = keyAction(event, store.getState())
      if (!action) return
      // An overlay that is already open handles its own chord (Alt K moves the palette highlight, palette.md 4).
      if (action.type === 'overlay' && store.getState().view.overlay === action.overlay) return
      event.preventDefault()
      event.stopPropagation()
      if (action.type === 'navigate') navigate(action.to)
      else if (action.type === 'overlay') {
        overlayRef.current = action.overlay
        window.history.pushState({ overlay: action.overlay }, '', window.location.pathname + window.location.search)
        store.dispatch({ type: 'view', path: window.location.pathname, overlay: action.overlay })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [store, navigate])

  const language = selectLanguage(state.data.prefs)
  const t = useMemo(() => makeTranslator(language), [language.lang, language.messages])
  const announcer = useMemo(() => createAnnouncer({ setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: id => window.clearTimeout(id), emit: setAnnouncement, t }), [t])
  useEffect(() => () => announcer.close(), [announcer])
  useEffect(() => {
    if (!state.announcements.length) return
    for (const item of state.announcements) announcer.push(item)
    store.dispatch({ type: 'announce.taken', ids: state.announcements.map(item => item.id) })
  }, [state.announcements, announcer, store])

  const route = matchRoute(path)
  useEffect(() => {
    document.title = documentTitle(t(PAGE_KEYS[route.name]), state.loaded ? state.data.counts : null, t)
    document.documentElement.lang = language.lang
  }, [route.name, state.loaded, state.data.counts, t, language.lang])

  const ticking = state.connection.state === 'reconnecting' || !!bannerFor(state, now)
  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [ticking])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') connection.visible() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [connection])

  const onRetry = useCallback(kind => {
    if (kind === 'server') connection.retryNow()
    else api?.post('/api/deps/deckd/retry').catch(() => {})
  }, [connection, api])
  return <App store={store} path={path} navigate={navigate} onRetry={onRetry} onReload={() => window.location.reload()} announcement={announcement} now={now} screens={screens} search={search} />
}
