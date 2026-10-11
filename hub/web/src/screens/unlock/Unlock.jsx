import React, { useCallback, useEffect, useRef, useState } from 'react'
import { messages as en, format } from '../../i18n/en.js'
import { BUSY_AFTER_MS, SUCCESS_MS, UNLOCK_COMMAND, exchangePassphrase, waitMessage } from '../../state/unlock.js'

/** One 16px lucide-shaped glyph, the stroke 2 family the Rail and the pills use. */
const icon = (paths, size = 16) => (
  <svg className="unlock-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths}</svg>
)
const ICONS = {
  error: icon(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>),
  wait: icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  ok: icon(<path d="M20 6 9 17l-5-5" />),
  info: icon(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>),
  eye: icon(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>, 20),
  eyeOff: icon(<><path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8" /><path d="M6.2 7.2A17 17 0 0 0 2 13s3.6 7 10 7a9.6 9.6 0 0 0 4.4-1" /><path d="m2 2 20 20" /></>, 20)
}
/** The Rail anchor, at the size the Unlock screen shows it. Decorative: the heading carries the name. */
const MARK = (
  <svg className="unlock-mark" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 3v15" /><path d="M5 10h14" /><path d="M4 15a8 8 0 0 0 16 0" />
  </svg>
)
const t = (key, params) => format(en[key] ?? key, params)

/**
 * The status region (design 3): one node that changes its role, never several live regions, or Android TalkBack
 * announces nothing.
 * @param {{ kind: 'error' | 'wait' | 'ok' | 'info', text: string, hint?: React.ReactNode }} props
 */
function Status({ kind, text, hint }) {
  return (
    <p id="unlock-status" className={`unlock-status unlock-status--${kind}`} role={kind === 'error' || kind === 'wait' ? 'alert' : 'status'}>
      {ICONS[kind]}
      <span>{text}{hint}</span>
    </p>
  )
}

/**
 * The block that replaces the form when the deck has no remote access passphrase (design 4.4). There is nothing to
 * type, so a disabled field would read as a bug.
 * @param {{ onRetry: () => void }} props
 */
function Unset({ onRetry }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(UNLOCK_COMMAND).then(() => setCopied(true), () => {})
  }
  return (
    <div className="unlock-status unlock-status--info unlock-unset" role="status">
      {ICONS.info}
      <div>
        <p className="unlock-unset-title">{t('unlock.unset.title')}</p>
        <p className="unlock-unset-body">{t('unlock.unset.body')}</p>
        <p className="unlock-command"><code>{UNLOCK_COMMAND}</code>
          <button type="button" className="unlock-copy" onClick={copy}>{t(copied ? 'unlock.copied' : 'unlock.copy')}</button>
        </p>
        <button type="button" className="button button--block" onClick={onRetry}>{t('unlock.unset.retry')}</button>
      </div>
    </div>
  )
}

/**
 * Unlock (design `/workspace/design/pairing-screen.md`): the screen a device without a token sees. It takes the
 * remote access passphrase the owner set with `fleetmates-deck remote-pass`, trades it for the deck token and
 * hands that token to `onUnlocked`. It replaces the whole shell: no Rail, no banners, no toasts.
 * @param {{ fetch?: typeof fetch, host?: string, onUnlocked: (token: string) => void }} props
 */
export function Unlock({ fetch: fetcher = (...args) => globalThis.fetch(...args), host = globalThis.location?.host ?? '', onUnlocked }) {
  const [value, setValue] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [state, setState] = useState('idle')
  const [wait, setWait] = useState(0)
  const field = useRef(null)
  const busy = state === 'verifying'
  const pending = useRef(false)
  useEffect(() => { document.title = t('shell.title', { page: t('shell.page.unlock') }) }, [])
  // The countdown ticks once a second and, at zero, leaves the plain wrong-passphrase error behind (design 3.3).
  useEffect(() => {
    if (state !== 'rate_limited' || wait <= 0) return undefined
    const timer = setTimeout(() => setWait(seconds => seconds - 1), 1000)
    return () => clearTimeout(timer)
  }, [state, wait])
  useEffect(() => { if (state === 'rate_limited' && wait <= 0) setState('wrong') }, [state, wait])

  const submit = useCallback(async event => {
    event?.preventDefault()
    // Read the DOM node, not only the controlled state: a password manager can fill the field and the user can
    // press Go before React has seen a change event (design 5.2).
    const typed = field.current?.value ?? value
    if (pending.current || !typed || (state === 'rate_limited' && wait > 0)) return
    pending.current = true
    setValue(typed)
    // Blur first, so the keyboard retracts and the status region is visible when it changes (design 5.1).
    field.current?.blur()
    const slow = setTimeout(() => { if (pending.current) setState('verifying') }, BUSY_AFTER_MS)
    const result = await exchangePassphrase({ fetch: fetcher, passphrase: typed })
    clearTimeout(slow)
    pending.current = false
    if (result.ok) {
      setState('success')
      setTimeout(() => onUnlocked(result.token), SUCCESS_MS)
      return
    }
    if (result.reason === 'rate_limited' && result.retryAfterS) { setWait(result.retryAfterS)
      setState('rate_limited')
      return }
    setState(result.reason === 'rate_limited' ? 'wrong' : result.reason)
    // A typo in a long passphrase is the common case: keep the value and select it, never clear it (design 5.3).
    if (result.reason === 'wrong') field.current?.select()
  }, [fetcher, onUnlocked, state, value, wait])

  const change = next => {
    setValue(next)
    if (['wrong', 'offline'].includes(state)) setState('idle')
  }
  const status = () => {
    if (state === 'success') return <Status kind="ok" text={t('unlock.success')} />
    if (state === 'verifying') return null
    if (state === 'rate_limited') {
      const message = waitMessage(Math.max(wait, 0))
      return <Status kind="wait" text={t(message.key, message.params)} />
    }
    if (state === 'offline') return <Status kind="error" text={t('unlock.error.offline')} />
    if (state === 'wrong') return <Status kind="error" text={t('unlock.error.wrong')} hint={<span className="unlock-hint-command"> {t('unlock.error.wrong.hint', { command: UNLOCK_COMMAND })}</span>} />
    return null
  }
  if (state === 'unset') {
    return (
      <div className="unlock">
        <main className="unlock-card">
          {MARK}
          <h1 className="unlock-title">{t('unlock.title')}</h1>
          <Unset onRetry={() => { setState('idle')
            pending.current = false }} />
        </main>
      </div>
    )
  }
  const blocked = busy || !value || (state === 'rate_limited' && wait > 0)
  return (
    <div className="unlock">
      <main className="unlock-card">
        {MARK}
        <h1 className="unlock-title">{t('unlock.title')}</h1>
        <p className="unlock-subtitle">{t('unlock.subtitle')}</p>
        <form className="unlock-form" onSubmit={submit} noValidate>
          {/* A hidden username gives iOS Passwords and Android Autofill a stable identity to save under; without
              it both save under an ambiguous one and stop offering the entry later (design 2). */}
          <input type="text" name="username" autoComplete="username" value={host} readOnly hidden />
          <label className="unlock-label" htmlFor="unlock-pass">{t('unlock.field.label')}</label>
          <div className="unlock-field">
            <input id="unlock-pass" ref={field} name="password" type={revealed ? 'text' : 'password'} autoComplete="current-password"
              enterKeyHint="go" autoCapitalize="off" autoCorrect="off" spellCheck="false" autoFocus readOnly={busy}
              aria-describedby="unlock-hint unlock-status" aria-invalid={state === 'wrong'} value={value}
              onChange={event => change(event.target.value)} />
            <button type="button" className="unlock-reveal" aria-pressed={revealed} aria-label={t(revealed ? 'unlock.reveal.hide' : 'unlock.reveal.show')}
              onClick={() => setRevealed(!revealed)}>{revealed ? ICONS.eyeOff : ICONS.eye}</button>
          </div>
          <p id="unlock-hint" className="unlock-hint">{t('unlock.field.hint')}</p>
          {status()}
          <button type="submit" className="button button--primary button--block" aria-disabled={blocked} aria-busy={busy}
            aria-describedby="unlock-status" onClick={event => { if (blocked) event.preventDefault() }}>
            {t(busy ? 'unlock.submit.busy' : state === 'offline' ? 'unlock.retry' : 'unlock.submit')}
          </button>
          <p className="unlock-remember">{t('unlock.remember')}</p>
        </form>
        <p className="unlock-tailnet">{t('unlock.tailnet')}</p>
      </main>
    </div>
  )
}
