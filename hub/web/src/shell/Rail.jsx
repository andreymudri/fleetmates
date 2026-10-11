import React from 'react'
import { badgeText, matchRoute } from '../state/deck-store.js'

const icon = paths => (
  <svg className="rail-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {paths}
  </svg>
)

const ICONS = {
  sessions: icon(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>),
  memory: icon(<><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></>),
  meetings: icon(<><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></>),
  settings: icon(<><path d="M10 5H3" /><path d="M12 19H3" /><path d="M14 3v4" /><path d="M16 17v4" /><path d="M21 12h-9" /><path d="M21 19h-5" /><path d="M21 5h-7" /><path d="M8 10v4" /><path d="M8 12H3" /></>)
}

const GROUPS = {
  sessions: ['home', 'new', 'focus', 'team', 'welcome'],
  memory: ['memory', 'memoryNote', 'research', 'researchNew'],
  meetings: ['meetings', 'meeting', 'meetingLive'],
  settings: ['settings', 'settingsIndex', 'crew']
}

/**
 * Follow a same-origin link through the SPA router unless the user asked for a new tab.
 * @param {(to: string) => void} navigate
 * @param {string} to
 */
export function linkHandler(navigate, to) {
  return event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
}

/**
 * The Rail (docs/deck/screens/rail-and-shell.md section 4.1): sections, needs-you badge, rec dot.
 * @param {{ t: (key: string, params?: object) => string, path: string, counts: { needYouSessions: number } | null, recording: boolean, navigate: (to: string) => void }} props
 */
export function Rail({ t, path, counts, recording, navigate }) {
  const route = matchRoute(path).name
  const badge = badgeText(counts?.needYouSessions ?? 0, t)
  const items = [
    { id: 'sessions', href: '/', label: badge ? t('shell.rail.sessions.needs', { n: counts.needYouSessions }) : t('shell.rail.sessions'), section: t('shell.rail.sessions'), keys: 'Alt Shift 1' },
    { id: 'memory', href: '/memory', label: t('shell.rail.memory'), section: t('shell.rail.memory'), keys: 'Alt Shift 2' },
    { id: 'meetings', href: '/meetings', label: recording ? t('shell.rail.meetings.recording') : t('shell.rail.meetings'), section: t('shell.rail.meetings'), keys: 'Alt Shift 3' },
    { id: 'settings', href: '/settings/rules', label: t('shell.rail.settings'), section: t('shell.rail.settings'), keys: 'Alt Shift 4' }
  ]
  const link = item => (
    <li key={item.id} className={`rail-item rail-item--${item.id}`}>
      <a
        href={item.href}
        className="rail-link"
        aria-current={GROUPS[item.id].includes(route) ? 'page' : undefined}
        aria-label={item.label}
        aria-describedby={`rail-tip-${item.id}`}
        onClick={linkHandler(navigate, item.href)}
      >
        {ICONS[item.id]}
        {/* The phone bottom bar shows this label under the icon (styles/mobile.css); on a desktop it is
            display:none and the hover tooltip beside the icon carries the same text plus its shortcut. */}
        <span className="rail-label" aria-hidden="true">{item.section}</span>
        {item.id === 'sessions' && badge ? <span className="rail-badge" aria-hidden="true">{badge}</span> : null}
        {item.id === 'meetings' && recording ? <span className="rail-rec motion-rec-pulse" aria-hidden="true" /> : null}
      </a>
      <span role="tooltip" id={`rail-tip-${item.id}`} className="rail-tooltip">{t('shell.rail.tooltip', { section: item.section, keys: item.keys })}</span>
    </li>
  )
  return (
    <nav aria-label={t('shell.rail.label')} className="rail">
      <a href="/" className="rail-logo" aria-label={t('shell.rail.logo')} onClick={linkHandler(navigate, '/')}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v15" /><path d="M5 10h14" /><path d="M4 15a8 8 0 0 0 16 0" />
        </svg>
      </a>
      <ul className="rail-list">{items.slice(0, 3).map(link)}</ul>
      <ul className="rail-list rail-list--bottom">{items.slice(3).map(link)}</ul>
    </nav>
  )
}
