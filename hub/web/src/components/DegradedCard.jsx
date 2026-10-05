import React, { useId } from 'react'

/**
 * The card that replaces the part of a tab whose backend is down (failures-and-loading 4.5, components 31):
 * the area eyebrow, the title, the literal cause, an optional command well, the fix and Retry. A region
 * named by its title. Every string comes from the caller's copy; all of it renders as text.
 * @param {{ area: string, title: string, body: string, code?: string | null, fixLabel?: string, onFix?: () => void, retryLabel: string, onRetry: () => void }} props
 */
export function DegradedCard({ area, title, body, code, fixLabel, onFix, retryLabel, onRetry }) {
  const titleId = useId()
  return (
    <section className="degraded-card" role="region" aria-labelledby={titleId}>
      <p className="eyebrow">{area}</p>
      <h2 className="degraded-card-title" id={titleId}>{title}</h2>
      <p className="degraded-card-body">{body}</p>
      {code ? <code className="degraded-card-command">{code}</code> : null}
      <div className="degraded-card-actions">
        {fixLabel && onFix ? <button type="button" className="button button--primary button--sm" onClick={onFix}>{fixLabel}</button> : null}
        <button type="button" className="button button--secondary button--sm" onClick={onRetry}>{retryLabel}</button>
      </div>
    </section>
  )
}
