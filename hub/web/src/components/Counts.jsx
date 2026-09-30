import React from 'react'
import { Icon, translate } from './StatusPill.jsx'

/**
 * English copy for count chips and the request summary (docs/deck/screens/home.md section 9,
 * needs-you-drawer.md section 9).
 */
export const COUNT_COPY = Object.freeze({
  'home.header.counts.label': 'Session counts',
  'home.header.needYou': '{n, plural, one {# needs you} other {# need you}}',
  'home.header.needYou.a11y': '{n, plural, one {# session needs you} other {# sessions need you}}. Open Needs you',
  'home.header.running': '{n, plural, other {# running}}',
  'home.header.toReview': '{n, plural, other {# to review}}',
  'drawer.subtitle.requests': '{n, plural, one {# request} other {# requests}} from {s, plural, one {# ship} other {# ships}}'
})

const CHIPS = [
  { id: 'needs', field: 'needYouSessions', key: 'home.header.needYou', a11y: 'home.header.needYou.a11y', icon: 'bell', hideAtZero: true, handler: 'onNeeds' },
  { id: 'running', field: 'running', key: 'home.header.running', icon: 'play', filled: true, hideAtZero: false, handler: 'onRunning' },
  { id: 'review', field: 'toReview', key: 'home.header.toReview', icon: 'check', hideAtZero: true, handler: 'onReview' }
]

/**
 * Visible (or, with `a11y`, accessible) text of one count chip.
 * @param {'needs'|'running'|'review'} id
 * @param {number} n
 * @param {{ a11y?: boolean, t?: (key: string, params?: object) => string }} [options]
 * @returns {string}
 */
export function countLabel(id, n, { a11y = false, t } = {}) {
  const chip = CHIPS.find(row => row.id === id)
  return translate(t, COUNT_COPY, a11y && chip.a11y ? chip.a11y : chip.key, { n })
}

/**
 * Drawer subtitle head, "4 requests from 3 ships", from the same server `counts` as the chips; null when none are open.
 * @param {{ openRequests: number, requestSessions?: number, needYouSessions: number } | null} counts
 * @param {(key: string, params?: object) => string} [t]
 * @returns {string | null}
 */
export function requestSummary(counts, t) {
  if (!counts?.openRequests) return null
  return translate(t, COUNT_COPY, 'drawer.subtitle.requests', { n: counts.openRequests, s: counts.requestSessions ?? counts.needYouSessions })
}

/**
 * The Home header count chips (StatePill `count` variant): buttons with full accessible names. Before the
 * first snapshot (`counts` null) it shows three skeleton blocks instead of guessing zero.
 * @param {{ counts: { needYouSessions: number, running: number, toReview: number } | null, t?: (key: string, params?: object) => string, onNeeds?: () => void, onRunning?: () => void, onReview?: () => void }} props
 */
export function Counts(props) {
  const { counts, t } = props
  if (!counts) {
    return (
      <div className="counts counts--loading" aria-busy="true">
        {CHIPS.map(chip => <span key={chip.id} className="count-skeleton motion-shimmer" aria-hidden="true" />)}
      </div>
    )
  }
  return (
    <div className="counts" role="group" aria-label={translate(t, COUNT_COPY, 'home.header.counts.label')}>
      {CHIPS.map(chip => {
        const n = Number(counts[chip.field] ?? 0)
        if (chip.hideAtZero && n <= 0) return null
        return (
          <button key={chip.id} type="button" className={`count-chip count-chip--${chip.id}`} aria-label={countLabel(chip.id, n, { a11y: true, t })} onClick={props[chip.handler]}>
            <Icon name={chip.icon} filled={chip.filled} />
            <span className="count-label">{countLabel(chip.id, n, { t })}</span>
          </button>
        )
      })}
    </div>
  )
}
