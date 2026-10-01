import React, { useEffect, useId, useRef } from 'react'
import { titleText, translate } from './StatusPill.jsx'
import { trapTab } from '../screens/drawer/NeedsYouDrawer.jsx'

/** Default copy for the confirm dialog (docs/deck/screens/focus.md section 9, `focus.stop.cancel`). */
export const CONFIRM_COPY = Object.freeze({
  'confirm.cancel': 'Cancel'
})

/**
 * A modal confirm dialog: `role="dialog"` with `aria-modal`, labelled by its title and described by its
 * body. Cancel comes first and takes the initial focus; Esc cancels; Tab wraps inside the dialog with
 * {@link trapTab}; focus returns to the element that had it when the dialog opened.
 * @param {{
 *   title: string, body: string, confirmLabel: string, cancelLabel?: string, tone?: 'danger' | 'default',
 *   onConfirm: () => void, onCancel: () => void, t?: Function
 * }} props
 */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, tone = 'default', onConfirm, onCancel, t }) {
  const panel = useRef(null)
  const id = useId()
  const titleId = `${id}-title`
  const bodyId = `${id}-body`
  useEffect(() => {
    const opener = globalThis.document?.activeElement
    panel.current?.querySelector('[data-initial-focus="true"]')?.focus()
    return () => opener?.focus?.()
  }, [])
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    } else trapTab(event, panel.current)
  }
  const danger = tone === 'danger'
  return (
    <div className="confirm-backdrop">
      <div ref={panel} className={`confirm-dialog${danger ? ' confirm-dialog--danger' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="confirm-title"><bdi>{titleText(title)}</bdi></h2>
        <p id={bodyId} className="confirm-body">{titleText(body)}</p>
        <div className="confirm-actions">
          <button type="button" className="button" data-initial-focus="true" onClick={onCancel}>{cancelLabel ?? translate(t, CONFIRM_COPY, 'confirm.cancel')}</button>
          <button type="button" className={`button ${danger ? 'button--danger' : 'button--primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
