import React, { useState } from 'react'
import { format } from '../i18n/en.js'
import { shown, titleText } from './StatusPill.jsx'

/**
 * Default answer copy, verbatim from the Needs-you drawer copy deck (docs/deck/screens/needs-you-drawer.md
 * section 9), plus "Review in Needs you" (home.md) and "Answer in the terminal" (focus.md). Each surface
 * passes its own translated strings in `labels`; a missing key falls back to this English text.
 */
export const ANSWER_LABELS = Object.freeze({
  deny: 'Deny',
  allowOnce: 'Allow once',
  reviewInDrawer: 'Review in Needs you',
  answerInTerminal: 'Answer in your terminal',
  answerInTheTerminal: 'Answer in the terminal',
  open: 'Open',
  openTerminal: 'Open terminal',
  deckdDown: 'deckd is reconnecting. Answer in your terminal for now.',
  queued: 'Queued behind another prompt in this session',
  sent: 'Sent · checking…',
  didNotLand: 'Your answer did not reach {repo}. The prompt is still open in its terminal.',
  tryAgain: 'Try again',
  replyLabel: 'Reply',
  replyPlaceholder: 'Reply to {repo}',
  reply: 'Reply'
})

const IN_FLIGHT = new Set(['sending', 'verifying'])

const repoOf = session => String(session?.repoId ?? '').split('/').filter(Boolean).at(-1) ?? ''

// Whether `busy` (the AnswerBody in flight) is the answer this button sends.
const sameChoice = (busy, body) => !!busy && busy.choice === body.choice && (busy.optionKey ?? null) === (body.optionKey ?? null)

function Reply({ label, placeholder, send, disabled, onSend }) {
  const [text, setText] = useState('')
  const submit = event => {
    event.preventDefault()
    if (!disabled && text.trim()) onSend(text)
  }
  return (
    <form className="answer-reply" onSubmit={submit}>
      <input type="text" className="answer-reply-input" aria-label={label} placeholder={placeholder} value={text} disabled={disabled} onChange={event => setText(event.target.value)} />
      <button type="submit" className="button button--amber button--xs" disabled={disabled}>{send}</button>
    </form>
  )
}

/**
 * The answer controls every M3 surface shares (Home card, Needs-you drawer, Focus prompt bar), rendering the
 * tier rules once, in this order: an observed session gets "Answer in your terminal" and "Open" only; deckd
 * down or a queued prompt disable the buttons with their reason; a PTY permission request without parsed
 * options gets "Answer in the terminal" and no buttons; Destructive on a card gets only "Review in Needs you";
 * Destructive on the drawer and Focus gets a confirm checkbox, "Deny", and "Allow once" disabled until checked;
 * Safe and Caution get "Deny" and "Allow once"; a question gets its option buttons and a Reply field.
 * Delivery: `sending` puts a spinner in the chosen button and disables the others, `verifying` shows
 * "Sent · checking…", `did_not_land` shows the error line with "Try again" (only when the prompt is on screen
 * and `busy` holds the body to resend) and "Open terminal".
 * Every answer button is `type="button"` and none is autofocused; the component has no keyboard handler of its
 * own, because shortcuts belong to each surface. Option labels and the confirm label render as text.
 * The component itself calls no hook, so a test can call it and walk the returned tree.
 * @param {{
 *   request: object, session: object, surface: 'card' | 'drawer' | 'focus', deckd?: { down: boolean },
 *   labels?: Partial<Record<keyof typeof ANSWER_LABELS, string>>, confirmed?: boolean,
 *   onConfirm?: (checked: boolean) => void, onAnswer?: (body: object) => void, onOpen?: () => void,
 *   busy?: { choice: string, optionKey?: string, confirm?: boolean, text?: string } | null
 * }} props `busy` is the AnswerBody in flight, or null
 */
export function AnswerControls({ request, session, surface, deckd, labels, confirmed = false, onConfirm = () => {}, onAnswer = () => {}, onOpen = () => {}, busy = null }) {
  const copy = { ...ANSWER_LABELS, ...labels }
  const repo = shown(repoOf(session))
  const line = (text, tone = 'muted') => <p className={`answer-line answer-line--${tone}`}>{text}</p>
  const openButton = text => <button type="button" className="button button--ghost button--xs" onClick={() => onOpen()}>{text}</button>

  if (session?.origin === 'observed') {
    return <div className="answer-controls answer-controls--observed">{line(copy.answerInTerminal)}{openButton(copy.open)}</div>
  }

  const delivery = request.delivery ?? 'idle'
  if (delivery === 'did_not_land') {
    const retry = request.screenMatch === 'on_screen' && busy
    return (
      <div className="answer-controls answer-controls--error">
        <p className="answer-line answer-line--error" role="alert">{format(copy.didNotLand, { repo })}</p>
        <div className="answer-buttons">
          {retry ? <button type="button" className="button button--xs" onClick={() => onAnswer(busy)}>{copy.tryAgain}</button> : null}
          {openButton(copy.openTerminal)}
        </div>
      </div>
    )
  }
  if (delivery === 'verifying') return <div className="answer-controls answer-controls--verifying">{line(copy.sent)}</div>

  const reason = deckd?.down ? copy.deckdDown : request.screenMatch === 'queued' ? copy.queued : null
  const options = request.options ?? []
  const question = request.kind === 'question'
  if (!reason && !question && options.length === 0) {
    return <div className="answer-controls answer-controls--terminal">{line(copy.answerInTheTerminal)}</div>
  }
  const destructive = !question && request.tier === 'destructive'
  if (destructive && surface === 'card') {
    return <div className="answer-controls answer-controls--review">{openButton(copy.reviewInDrawer)}</div>
  }

  const sending = delivery === 'sending'
  const locked = !!reason || IN_FLIGHT.has(delivery)
  const answer = (body, text, className, extra = false) => {
    const chosen = sending && sameChoice(busy, body)
    return (
      <button type="button" className={`button button--xs ${className}`} disabled={locked || extra} aria-busy={chosen ? 'true' : undefined} onClick={() => onAnswer(body)}>
        {chosen ? <span className="answer-spinner" aria-hidden="true" /> : null}{text}
      </button>
    )
  }

  let body
  if (question) {
    body = (
      <>
        <div className="answer-buttons answer-options">
          {options.map(option => <React.Fragment key={option.key}>{answer({ choice: 'option', optionKey: option.key }, <bdi>{titleText(option.label)}</bdi>, 'button--ghost')}</React.Fragment>)}
        </div>
        <Reply label={copy.replyLabel} placeholder={format(copy.replyPlaceholder, { repo })} send={copy.reply} disabled={locked} onSend={text => onAnswer({ choice: 'reply', text })} />
      </>
    )
  } else if (destructive) {
    body = (
      <>
        <label className="answer-confirm">
          <input type="checkbox" checked={!!confirmed} disabled={locked} onChange={event => onConfirm(event.target.checked)} />
          <span className="answer-confirm-text"><bdi>{titleText(request.confirmLabel)}</bdi></span>
        </label>
        <div className="answer-buttons">
          {answer({ choice: 'deny' }, copy.deny, 'button--ghost')}
          {answer({ choice: 'allow', confirm: true }, copy.allowOnce, 'button--danger', !confirmed)}
        </div>
      </>
    )
  } else {
    body = (
      <div className="answer-buttons">
        {answer({ choice: 'deny' }, copy.deny, 'button--ghost')}
        {answer({ choice: 'allow' }, copy.allowOnce, 'button--primary')}
      </div>
    )
  }
  return (
    <div className={`answer-controls answer-controls--${surface}${destructive ? ' answer-controls--destructive' : ''}`}>
      {body}
      {reason ? line(reason) : null}
    </div>
  )
}
