import React from 'react'
import { format } from '../i18n/en.js'

/**
 * English copy for the pill labels (docs/deck/02-domain.md section 3, design-system.md 3.4).
 * Keys follow design-system 12.6; a catalog that defines them wins through `t`.
 */
export const STATE_COPY = Object.freeze({
  'state.starting.label': 'Starting',
  'state.running.label': 'Running',
  'state.needs_approval.label': 'Needs approval',
  'state.asked_you.label': 'Asked you',
  'state.done.label': 'Done',
  'state.stale.label': 'No activity {n}m',
  'state.idle.label': 'Idle {duration}',
  'state.reviewed.label': 'Reviewed',
  'state.crashed.exit': 'Crashed · exit {code}',
  'state.crashed.signal': 'Crashed · signal {signal}',
  'state.crashed.lost': 'Crashed · lost',
  'state.ended.label': 'Ended',
  'state.draft.label': 'Draft · not saved'
})

/**
 * Translate with a catalog function, falling back to local English copy when the catalog lacks the key.
 * @param {((key: string, params?: object) => string) | undefined} t
 * @param {Record<string, string>} copy
 * @param {string} key
 * @param {object} [params]
 * @returns {string}
 */
export function translate(t, copy, key, params = {}) {
  const text = t?.(key, params)
  if (typeof text === 'string' && text !== key) return text
  return format(copy[key] ?? key, params)
}

/** Session states in the 02-domain.md order. */
export const SESSION_STATES = Object.freeze(['starting', 'running', 'needs_approval', 'asked_you', 'done', 'stale', 'idle', 'reviewed', 'crashed', 'ended'])

const ICONS = {
  starting: 'loader-circle', needs_approval: 'bell', asked_you: 'bell', done: 'check', stale: 'waves', idle: 'moon',
  reviewed: 'check-check', crashed: 'x', ended: 'square', draft: 'file-pen'
}

// String params (exit code, signal, duration) come from session data; numbers stay numbers for plurals.
const safeParams = params => Object.fromEntries(Object.entries(params ?? {}).map(([key, value]) => [key, typeof value === 'string' ? shown(value) : value]))

/**
 * The literal pill label for a state (never themed). String params pass through `shown`.
 * @param {string} state
 * @param {{ n?: number, duration?: string, code?: number|string, kind?: 'exit'|'signal'|'lost', signal?: string }} [params]
 * @param {(key: string, params?: object) => string} [t]
 * @returns {string}
 */
export function stateLabel(state, raw = {}, t) {
  const params = safeParams(raw)
  if (state === 'crashed') {
    const kind = params.kind ?? (params.signal ? 'signal' : params.code === undefined || params.code === null ? 'lost' : 'exit')
    return translate(t, STATE_COPY, `state.crashed.${kind}`, params)
  }
  const key = `state.${state}.label`
  return STATE_COPY[key] ? translate(t, STATE_COPY, key, params) : String(state)
}

/**
 * Compact duration: `12m`, `1h 12m`, `1h`, `3d` (02-domain.md section 4).
 * @param {number} ms
 * @returns {string}
 */
export function compactDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Label params for a session: stale minutes since `lastActivityAt`, idle duration since `stateSince`, crash kind.
 * @param {{ state: string, lastActivityAt?: number, stateSince?: number, crashKind?: string|null, exitCode?: number|null, exitSignal?: string|null }} session
 * @param {number} now
 * @returns {object}
 */
export function pillParams(session, now) {
  switch (session.state) {
    case 'stale': return { n: Math.max(0, Math.floor((now - (session.lastActivityAt ?? now)) / 60_000)) }
    case 'idle': return { duration: compactDuration(now - (session.stateSince ?? now)) }
    case 'crashed':
      if (session.crashKind === 'signal') return { kind: 'signal', signal: session.exitSignal }
      if (session.crashKind === 'lost' || (session.exitCode == null && !session.exitSignal)) return { kind: 'lost' }
      return { kind: 'exit', code: session.exitCode }
    default: return {}
  }
}

const HIDDEN_BIDI = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/gu
const HIDDEN_ALL = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
const token = ch => `<U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`

/**
 * Command, path and URL displays: controls, format and default-ignorable characters become visible
 * `<U+XXXX>` tokens (docs/deck/08-security.md section 4.5).
 * @param {unknown} text
 * @returns {string}
 */
export function shown(text) {
  return String(text ?? '').replace(HIDDEN_ALL, token)
}

/**
 * Titles and prose: C0 and C1 controls and bidi controls become visible tokens; other text (emoji,
 * RTL scripts) is kept. Render the result inside `<bdi>` so it cannot reorder its neighbours.
 * @param {unknown} text
 * @returns {string}
 */
export function titleText(text) {
  return String(text ?? '').replace(HIDDEN_BIDI, token)
}

/**
 * " · " separated items with the dots hidden from screen readers (design-system 12.5).
 * @param {{ items: React.ReactNode[], className?: string }} props
 */
export function MetaLine({ items, className = 'meta-line' }) {
  const present = items.filter(item => item !== null && item !== undefined && item !== false && item !== '')
  return (
    <span className={className}>
      {present.map((item, index) => (
        <React.Fragment key={index}>
          {index ? <span className="meta-sep" aria-hidden="true"> · </span> : null}
          <span className="meta-item">{item}</span>
        </React.Fragment>
      ))}
    </span>
  )
}

const PATHS = {
  'loader-circle': <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  bell: <><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  'check-check': <><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></>,
  waves: <><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" /><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" /><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" /></>,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  square: <rect width="18" height="18" x="3" y="3" rx="2" />,
  compass: <><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" /><circle cx="12" cy="12" r="10" /></>,
  'file-pen': <><path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M13.378 15.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" /></>,
  play: <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
}

/**
 * A decorative lucide-shaped icon (stroke 2, `currentColor`). Always `aria-hidden`: the label beside it carries the meaning.
 * @param {{ name: string, filled?: boolean, size?: number }} props
 */
export function Icon({ name, filled = false, size = 14 }) {
  return (
    <svg className={`icon icon--${name}`} data-icon={name} viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] ?? null}
    </svg>
  )
}

/**
 * StatePill (docs/deck/design/components.md section 4): icon or live dot plus a literal label. Not a live region.
 * @param {{ state: string, label?: string, params?: object, variant?: 'pill'|'text'|'dot', role?: string, t?: (key: string, params?: object) => string }} props
 */
export function StatusPill({ state, label, params, variant = 'pill', role, t }) {
  const text = label ?? stateLabel(state, params, t)
  const tone = String(state).replace(/_/g, '-')
  let lead
  if (variant === 'dot') lead = <span className={`status-dot${state === 'running' ? ' motion-breathe' : ''}`} aria-hidden="true" />
  else if (state === 'running') lead = role === 'research' ? <Icon name="compass" /> : <span className="status-dot motion-breathe" aria-hidden="true" />
  else lead = <Icon name={ICONS[state] ?? 'square'} />
  return (
    <span className={`status-pill status-pill--${variant} status-pill--${tone}`}>
      {lead}
      <span className="status-label">{text}</span>
    </span>
  )
}
