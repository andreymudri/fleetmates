import React, { useState } from 'react'
import { format } from '../i18n/en.js'
import { shown, titleText } from './StatusPill.jsx'

/**
 * Default PromptBar copy, verbatim from the Focus copy deck (docs/deck/screens/focus.md section 9) and, for
 * "Sent · checking…", the Needs-you drawer copy deck. Focus passes its own translated strings in `labels`;
 * a missing key falls back to this English text.
 */
export const PROMPT_LABELS = Object.freeze({
  note: 'Same prompt as the terminal, same keys',
  answerInTheTerminal: 'Answer in the terminal',
  deckdDown: 'deckd is reconnecting',
  guardTyping: 'You are typing in the terminal. Answer there, or try again in a second.',
  sent: 'Sent · checking…',
  didNotLand: 'Your answer did not reach {repo}. The prompt is still open in its terminal.',
  tryAgain: 'Try again',
  replyLabel: 'Reply',
  replyPlaceholder: 'Reply to {repo}',
  reply: 'Reply'
})

const IN_FLIGHT = new Set(['sending', 'verifying'])
const SHORT = 60
const ANSWERABLE = new Set(['safe', 'caution'])

const repoOf = session => String(session?.repoId ?? '').split('/').filter(Boolean).at(-1) ?? ''
const sameChoice = (busy, body) => !!busy && busy.choice === body.choice && (busy.optionKey ?? null) === (body.optionKey ?? null)

/**
 * Shorten a long option label for the bar, keeping its verb and scope (focus.md 5.5): parenthesised asides
 * such as "(shift+tab)" go first, then the text is cut at a word boundary with an ellipsis.
 * @param {string} label
 * @returns {string}
 */
export function shortLabel(label) {
  const full = titleText(label)
  if (full.length <= SHORT) return full
  const bare = full.replace(/\s*\([^()]*\)/g, '').replace(/\s+/g, ' ').trim()
  if (bare.length <= SHORT) return bare
  const cut = bare.slice(0, SHORT)
  const space = cut.lastIndexOf(' ')
  return `${(space > SHORT / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`
}

/**
 * The options the bar mirrors, in screen order, each with the AnswerBody it sends. A permission request shows
 * option 1 (Allow once) and the option whose label starts with "No" (Deny, F17); option 2 (`allow_always`)
 * shows only for a Safe request with `allowAlways` (D-77). A question shows every parsed option. Returns an
 * empty list when the parsed options do not hold both a `1` and a "No" option (never guess, focus.md 5.3).
 * @param {{ kind?: string, tier?: string, options?: { key: string, label: string }[], allowAlways?: boolean }} request
 * @returns {{ key: string, label: string, body: object, role: 'allow' | 'always' | 'deny' | 'option' }[]}
 */
export function promptChoices(request) {
  const options = Array.isArray(request?.options) ? request.options : []
  if (request?.kind === 'question') {
    return options.map(option => ({ key: String(option.key), label: String(option.label ?? ''), body: { choice: 'option', optionKey: String(option.key) }, role: 'option' }))
  }
  const deny = options.find(option => /^No\b/.test(String(option.label ?? '').trim()))
  const allow = options.find(option => String(option.key) === '1')
  if (!deny || !allow || deny === allow) return []
  const always = request.tier === 'safe' && request.allowAlways === true ? options.find(option => String(option.key) === '2') : null
  const out = []
  for (const option of options) {
    const base = { key: String(option.key), label: String(option.label ?? '') }
    if (option === allow) out.push({ ...base, body: request.tier === 'destructive' ? { choice: 'allow', confirm: true } : { choice: 'allow' }, role: 'allow' })
    else if (always && option === always) out.push({ ...base, body: { choice: 'allow_always' }, role: 'always' })
    else if (option === deny) out.push({ ...base, body: { choice: 'deny' }, role: 'deny' })
  }
  return out
}

/**
 * The AnswerBody a `1`, `2` or `3` keydown sends from the Focus bar, or null. Digits act only while the
 * terminal does not have focus, only without modifiers, never from an editable field, never while an answer
 * is in flight or deckd is down, and only on Safe and Caution permission requests: on a Destructive request
 * (and on a question) digits do nothing (state-machines 3.4, keyboard.md 3).
 * @param {{ key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, defaultPrevented?: boolean, target?: any }} event
 * @param {{ request: object | null, terminalFocused: boolean, deckdDown?: boolean }} context
 * @returns {object | null}
 */
export function promptKeyBody(event, { request, terminalFocused, deckdDown = false }) {
  if (!request || terminalFocused || deckdDown || !event || event.defaultPrevented) return null
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  if (!/^[123]$/.test(event.key)) return null
  const target = event.target
  const tag = String(target?.tagName ?? '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return null
  if (request.kind === 'question' || !ANSWERABLE.has(request.tier)) return null
  if (request.screenMatch !== 'on_screen' || IN_FLIGHT.has(request.delivery ?? 'idle') || request.delivery === 'did_not_land') return null
  return promptChoices(request).find(choice => choice.key === event.key)?.body ?? null
}

/** The question bar's Reply field; it holds its own text, so tree walkers keep it as an element. */
export function PromptReply({ label, placeholder, send, disabled, onSend }) {
  const [text, setText] = useState('')
  const submit = event => {
    event.preventDefault()
    if (!disabled && text.trim()) onSend(text)
  }
  return (
    <form className="answer-reply prompt-reply" onSubmit={submit}>
      <input type="text" className="answer-reply-input" aria-label={label} placeholder={placeholder} value={text} disabled={disabled} onChange={event => setText(event.target.value)} />
      <button type="submit" className="button button--amber button--xs" disabled={disabled}>{send}</button>
    </form>
  )
}

/**
 * The Focus prompt bar (focus.md 4.3, 5.3, 5.4, 8; components.md 41): a mirror of the prompt on the PTY screen
 * for the session's on-screen request, `role="group"` named after the command. Options keep their printed
 * digits and labels (long labels shortened, full text in `title`): Safe shows 1 and 3, plus 2 only with
 * `request.allowAlways`; Caution shows 1 and 3; Destructive shows the confirm checkbox, option 1 as
 * `danger-confirm` disabled until it is ticked, and 3, without digit hints; a question shows its option
 * buttons and a Reply field. Delivery and guard states follow the AnswerControls rules: `did_not_land` shows
 * the error line and "Try again" (when the prompt is on screen and `busy` holds the body to resend),
 * `verifying` shows "Sent · checking…", deckd down disables the buttons with its reason, `guard: 'typing'`
 * shows the typing guard line, and options that cannot be read show "Answer in the terminal" and no buttons.
 * Every label renders as text. The component calls no hook (PromptReply holds the reply text).
 * @param {{
 *   request: object, session: object, deckd?: { down: boolean }, labels?: Partial<Record<keyof typeof PROMPT_LABELS, string>>,
 *   confirmed?: boolean, onConfirm?: (checked: boolean) => void, onAnswer?: (body: object) => void,
 *   busy?: object | null, guard?: 'typing' | null, badge?: any
 * }} props
 */
export function PromptBar({ request, session, deckd, labels, confirmed = false, onConfirm = () => {}, onAnswer = () => {}, busy = null, guard = null, badge = null }) {
  const copy = { ...PROMPT_LABELS, ...labels }
  const repo = shown(repoOf(session))
  const question = request.kind === 'question'
  const tier = question ? 'question' : request.tier === 'safe' || request.tier === 'destructive' ? request.tier : 'caution'
  const destructive = tier === 'destructive'
  const name = question ? titleText(request.summary) : shown(request.summary)
  const line = (text, tone = 'muted', role) => <p className={`answer-line answer-line--${tone}`} role={role}>{text}</p>
  const delivery = request.delivery ?? 'idle'
  const choices = promptChoices(request)

  let body
  if (delivery === 'did_not_land') {
    const retry = request.screenMatch === 'on_screen' && busy
    body = (
      <>
        {line(format(copy.didNotLand, { repo }), 'error', 'alert')}
        {retry ? <div className="answer-buttons"><button type="button" className="button button--xs" onClick={() => onAnswer(busy)}>{copy.tryAgain}</button></div> : null}
      </>
    )
  } else if (delivery === 'verifying') {
    body = line(copy.sent)
  } else if (!question && choices.length === 0) {
    body = line(copy.answerInTheTerminal)
  } else {
    const locked = !!deckd?.down || IN_FLIGHT.has(delivery)
    const sending = delivery === 'sending'
    const option = choice => {
      const short = shortLabel(choice.label)
      const full = titleText(choice.label)
      const chosen = sending && sameChoice(busy, choice.body)
      const variant = choice.role === 'allow' ? (destructive ? 'button--danger prompt-option--danger-confirm' : 'button--amber') : 'button--amber-outline'
      return (
        <button key={choice.key} type="button" className={`button button--xs prompt-option ${variant}`} title={short === full ? undefined : full}
          disabled={locked || (destructive && choice.role === 'allow' && !confirmed)} aria-busy={chosen ? 'true' : undefined} onClick={() => onAnswer(choice.body)}>
          {chosen ? <span className="answer-spinner" aria-hidden="true" /> : null}
          {destructive ? null : <><kbd className="kbd prompt-digit">{choice.key}</kbd>{' '}</>}
          <bdi>{short}</bdi>
        </button>
      )
    }
    body = (
      <>
        {destructive ? null : <p className="prompt-bar-note">{copy.note}</p>}
        {destructive ? (
          <label className="answer-confirm">
            <input type="checkbox" checked={!!confirmed} disabled={locked} onChange={event => onConfirm(event.target.checked)} />
            <span className="answer-confirm-text"><bdi>{titleText(request.confirmLabel)}</bdi></span>
          </label>
        ) : null}
        {choices.length ? <div className="answer-buttons prompt-options">{choices.map(option)}</div> : null}
        {question ? <PromptReply label={copy.replyLabel} placeholder={format(copy.replyPlaceholder, { repo })} send={copy.reply} disabled={locked} onSend={text => onAnswer({ choice: 'reply', text })} /> : null}
        {deckd?.down ? line(copy.deckdDown) : guard === 'typing' ? line(copy.guardTyping, 'muted', 'status') : guard ? line(copy.answerInTheTerminal) : null}
      </>
    )
  }
  return (
    <div className={`prompt-bar prompt-bar--${tier}`} role="group" aria-label={name}>
      <div className="prompt-bar-head">
        {badge}
        {question ? <p className="prompt-bar-summary"><bdi>{name}</bdi></p> : <code className="prompt-bar-summary">{name}</code>}
      </div>
      {body}
    </div>
  )
}
