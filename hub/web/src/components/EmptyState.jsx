import React from 'react'
import { CrewAvatar } from './CrewAvatar.jsx'
import { translate } from './StatusPill.jsx'
import { linkHandler } from '../shell/Rail.jsx'

/**
 * English copy for the M1 empty states: Home calm first use (home.md 4.5 and 5.2), the Needs-you drawer
 * (needs-you-drawer.md 9), the palette before M5 (palette.md 9), Focus tabs (focus.md 5.2),
 * calm open loops (components CalmSection) and Settings rules (settings.md).
 */
export const EMPTY_COPY = Object.freeze({
  'empty.home.title': 'Calm seas. No ships out.',
  'empty.home.body': 'No ships yet. Launch one, or start claude in a terminal and it shows up here.',
  'empty.drawer.title': 'Nothing needs you.',
  'empty.drawer.body': 'New requests show up here and on the Sessions grid.',
  'empty.palette.title': 'No matches.',
  'empty.openLoops.title': 'No open loops.',
  'empty.focusChanges.title': 'No changes yet.',
  'empty.focusMemory.title': 'Nothing in your vault matches this task yet.',
  'empty.rules.title': 'No approval rules yet. Rules you accept from suggestions, or add by hand, show up here.'
})

/** Every empty state kind this component knows. */
export const EMPTY_KINDS = Object.freeze(['home', 'drawer', 'palette', 'openLoops', 'focusChanges', 'focusMemory', 'rules'])

/**
 * An empty region: a title (a heading when `as` names one), an optional muted body line, optional calm
 * crew and one optional action link. Static text only; announcing is the shell's job.
 * @param {{ kind: string, as?: 'h1'|'h2'|'h3'|'p', t?: (key: string, params?: object) => string, crew?: { seed: string, slot?: number, color?: string }[], action?: { label: string, href: string, kbd?: string[] }, navigate?: (to: string) => void }} props
 */
export function EmptyState({ kind, as: Title = 'p', t, crew, action, navigate }) {
  const bodyKey = `empty.${kind}.body`
  return (
    <div className={`empty-state empty-state--${kind}`}>
      {crew?.length ? <div className="empty-crew">{crew.map(member => <CrewAvatar key={member.seed} seed={member.seed} slot={member.slot} color={member.color} pose="idle" size="xl" />)}</div> : null}
      <Title className="empty-title">{translate(t, EMPTY_COPY, `empty.${kind}.title`)}</Title>
      {EMPTY_COPY[bodyKey] ? <p className="empty-body">{translate(t, EMPTY_COPY, bodyKey)}</p> : null}
      {action ? (
        <a className="button button--primary button--hero" href={action.href} onClick={navigate ? linkHandler(navigate, action.href) : undefined}>
          {action.kbd ? `${action.label} ` : action.label}
          {action.kbd ? <kbd className="kbd kbd--on-primary">{action.kbd.join(' ')}</kbd> : null}
        </a>
      ) : null}
    </div>
  )
}
