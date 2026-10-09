import React, { useEffect, useRef, useState } from 'react'
import { titleText, translate } from './StatusPill.jsx'
import { isGlobalChord, phoneViewport } from '../state/deck-store.js'
import { pasteNeedsConfirm, pasteSizeText, sanitizePaste } from '../state/terminal.js'

/** English copy for the terminal section (docs/deck/design/components.md section 14). */
export const TERMINAL_COPY = Object.freeze({
  'terminal.label': 'Terminal, {label}',
  // No spec copy deck names this string yet; 08-security 4.6 only requires that the real URL is shown.
  'terminal.link.confirm': 'Open this link from the terminal?\n{url}',
  // The phone key bar (mobile-focus-mockup): the keys a touch keyboard cannot send.
  'terminal.keys.label': 'Terminal keys'
})

const SKELETON_LINES = 6
const RESIZE_MS = 100
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * What a terminal link may do (docs/deck/08-security.md section 4.6): `http:` and `https:` only;
 * localhost opens directly, any other host asks first; every other scheme is refused.
 * @param {string} uri
 * @returns {'open' | 'confirm' | 'refuse'}
 */
export function linkDecision(uri) {
  let url
  try { url = new URL(uri) } catch { return 'refuse' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'refuse'
  return LOCAL_HOSTS.has(url.hostname) ? 'open' : 'confirm'
}

/**
 * xterm options from components.md section 14. Input is disabled when read-only or disconnected.
 * @param {{ readOnly?: boolean, connected?: boolean, screenReaderMode?: boolean, reducedMotion?: boolean, theme?: object }} options
 * @returns {Record<string, any>}
 */
export function terminalOptions({ readOnly = false, connected = false, screenReaderMode = false, reducedMotion = false, phone = false, theme } = {}) {
  return {
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    // A phone never resizes the PTY (see the refit below), so the buffer keeps the machine's column count and
    // scrolls sideways. A smaller glyph is then simply more of the line on screen, and costs the desktop nothing.
    fontSize: phone ? 12 : 14,
    lineHeight: 1.2,
    scrollback: 5000,
    cursorBlink: !reducedMotion,
    cursorInactiveStyle: readOnly ? 'none' : 'outline',
    allowProposedApi: false,
    customGlyphs: true,
    screenReaderMode: !!screenReaderMode,
    disableStdin: !!readOnly || !connected,
    ...(theme ? { theme } : {})
  }
}

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Whether motion is reduced: the OS `prefers-reduced-motion` query, or Settings "Always reduce motion",
 * which the shell writes as `data-motion="reduce"` on the document root.
 * @param {{ matchMedia?: (query: string) => { matches: boolean }, root?: { getAttribute: (name: string) => string|null } | null }} [scope]
 * @returns {boolean}
 */
export function motionReduced({ matchMedia, root } = {}) {
  return !!matchMedia?.(REDUCE_QUERY)?.matches || root?.getAttribute?.('data-motion') === 'reduce'
}

function cssVar(element, name, fallback) {
  try {
    const value = globalThis.getComputedStyle?.(element).getPropertyValue(name).trim()
    return value || fallback
  } catch {
    return fallback
  }
}

function themeFor(element) {
  return {
    background: cssVar(element, '--bg-sunken', '#0f1016'),
    foreground: cssVar(element, '--text-default', '#c0caf5'),
    cursor: cssVar(element, '--focus-ring', '#7fe3e3'),
    selectionBackground: cssVar(element, '--bg-mark', '#1d3b3b')
  }
}

/**
 * Activate a terminal link through {@link linkDecision}: refused schemes do nothing, a non-localhost
 * link opens only when `confirmLink(href)` returns true, and localhost opens at once. `href` is the parsed
 * `new URL(uri).href` (punycode host, backslashes normalized), so the confirm shows the URL the browser
 * will open (docs/deck/08-security.md 4.6). Opening uses `open(href, '_blank', 'noopener,noreferrer')`.
 * @param {string} uri
 * @param {{ confirmLink: (uri: string) => boolean, open: (url: string, target: string, features: string) => unknown }} options
 * @returns {boolean} whether the link was opened
 */
export function handleLink(uri, { confirmLink, open }) {
  const decision = linkDecision(uri)
  if (decision === 'refuse') return false
  const href = new URL(uri).href
  if (decision === 'confirm' && !confirmLink(href)) return false
  open(href, '_blank', 'noopener,noreferrer')
  return true
}

/**
 * The control code one keystroke becomes while the key bar's sticky Ctrl is held: a letter or one of the few
 * punctuation keys that have a control code, as a terminal's own Ctrl would produce. Anything else (an arrow
 * sequence, a multi-character paste) passes through, so holding Ctrl never swallows a key.
 * @param {string} input one keystroke as xterm reports it
 * @returns {string}
 */
export function controlOf(input) {
  if (typeof input !== 'string' || input.length !== 1) return input
  const code = input.toUpperCase().charCodeAt(0)
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  if (input === ' ') return '\x00'
  if (input === '/') return '\x1f'
  if (input === '?') return '\x7f'
  return input
}

/** The key bar's keys, in the order the design puts them (mobile-focus-mockup). `ctrl` is the sticky modifier. */
export const KEY_BAR = Object.freeze([
  { id: 'esc', label: 'Esc', send: '\x1b' },
  { id: 'tab', label: 'Tab', send: '\t' },
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'up', label: '\u2191', send: '\x1b[A' },
  { id: 'down', label: '\u2193', send: '\x1b[B' },
  { id: 'left', label: '\u2190', send: '\x1b[D' },
  { id: 'right', label: '\u2192', send: '\x1b[C' },
  { id: 'slash', label: '/', send: '/' },
  { id: 'pipe', label: '|', send: '|' },
  { id: 'tilde', label: '~', send: '~' }
])

/**
 * The phone key bar (mobile-focus-mockup): the keys a touch keyboard has no way to send, above the keyboard and
 * only while the terminal has focus. Every press is a `pointerdown` with its default prevented, so the terminal
 * keeps focus and the keyboard stays up; a bar that blurred the terminal would unmount itself on first use.
 * @param {{ ctrl: boolean, t?: Function, onCtrl: () => void, onKey: (text: string) => void }} props
 */
function KeyBar({ ctrl, t, onCtrl, onKey }) {
  const press = key => event => {
    event.preventDefault()
    if (key.id === 'ctrl') onCtrl()
    else onKey(key.send)
  }
  return (
    <div className="terminal-keys" role="toolbar" aria-label={translate(t, TERMINAL_COPY, 'terminal.keys.label')}>
      {KEY_BAR.map(key => (
        <button key={key.id} type="button" className="terminal-key" onPointerDown={press(key)} onMouseDown={event => event.preventDefault()}
          {...(key.id === 'ctrl' ? { 'aria-pressed': ctrl ? 'true' : 'false' } : {})}>{key.label}</button>
      ))}
    </div>
  )
}

/**
 * The live xterm for one session (components.md section 14). xterm and the fit addon load with dynamic
 * `import()` inside an effect, so the component renders its labelled section and skeleton lines under
 * `renderToStaticMarkup` in Node without loading them. A snapshot frame resets the terminal; output frames
 * are written as they come; keystrokes reach `client` only while the terminal has focus. Global chords
 * (keyboard.md section 2) are left to the shell. Pastes are sanitized and confirmed above 4 KB, then
 * handed to xterm's bracketed paste. Links open only for `http:` and `https:`. A `deckd_unavailable` error that
 * arrives before the first `onAttached` (the server dropped the pending attach) leaves the view waiting, and it
 * attaches again once `deckdUp` turns true after being false; after an attach the server re-attaches the tab itself.
 * @param {{
 *   sessionId: string, label: string, readOnly?: boolean, screenReaderMode?: boolean,
 *   client?: ReturnType<import('../state/terminal.js').createTerminalClient> | null, initialText?: string,
 *   autoFocus?: boolean, onFocusChange?: (focused: boolean) => void,
 *   confirmPaste?: (sizeText: string) => boolean | Promise<boolean>, confirmLink?: (url: string) => boolean,
 *   deckdUp?: boolean, t?: Function
 * }} props
 */
export function TerminalView({
  sessionId, label, readOnly = false, screenReaderMode = false, client = null, initialText = '', autoFocus = false,
  onFocusChange, confirmPaste, confirmLink, deckdUp = true, t
}) {
  const section = useRef(null)
  const host = useRef(null)
  const termRef = useRef(null)
  const latest = useRef({})
  const [painted, setPainted] = useState(!!initialText)
  const [connected, setConnected] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const reattach = useRef(null)
  const sawDown = useRef(false)
  const send = useRef(null)
  const sticky = useRef(false)
  const [ctrl, setCtrl] = useState(false)
  const [hasFocus, setHasFocus] = useState(false)
  // Read once, at mount, as the resize guard reads it: a phone gets the key bar, a desktop never does.
  const [phone] = useState(() => phoneViewport({ matchMedia: globalThis.matchMedia?.bind(globalThis) }))
  latest.current = { readOnly, connected, onFocusChange, confirmPaste, confirmLink, deckdUp, t }

  useEffect(() => {
    const element = host.current
    if (!element) return undefined
    let disposed = false
    let term = null
    let handle = null
    let observer = null
    let timer = null
    let pending = false
    let focused = false
    let pasting = false
    const cleanups = []
    const scope = { matchMedia: globalThis.matchMedia?.bind(globalThis), root: globalThis.document?.documentElement ?? null }
    // A new session (or client) starts detached and unpainted, so the stdin effect re-runs on its attach.
    setConnected(false)
    setWaiting(false)
    sawDown.current = !latest.current.deckdUp
    setPainted(!!initialText)

    ;(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      if (disposed) return
      // Motion is read here, after the import: the shell can set data-motion while xterm loads.
      term = new Terminal({
        ...terminalOptions({ readOnly: latest.current.readOnly, connected: false, screenReaderMode, reducedMotion: motionReduced(scope), phone: phoneViewport(scope), theme: themeFor(section.current) }),
        linkHandler: {
          allowNonHttpProtocols: false,
          activate: (_event, uri) => handleLink(uri, {
            confirmLink: url => latest.current.confirmLink
              ? latest.current.confirmLink(url)
              : globalThis.confirm?.(translate(latest.current.t, TERMINAL_COPY, 'terminal.link.confirm', { url })) === true,
            open: (...args) => globalThis.open?.(...args)
          })
        }
      })
      termRef.current = term
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(element)
      try { fit.fit() } catch {}
      term.attachCustomKeyEventHandler(event => !isGlobalChord(event))
      if (initialText) term.write(initialText)

      // The caret blink follows both motion preferences as they change, without a remount.
      const syncMotion = () => { term.options.cursorBlink = !motionReduced(scope) }
      const query = scope.matchMedia?.(REDUCE_QUERY)
      query?.addEventListener?.('change', syncMotion)
      cleanups.push(() => query?.removeEventListener?.('change', syncMotion))
      if (scope.root && globalThis.MutationObserver) {
        const motion = new MutationObserver(syncMotion)
        motion.observe(scope.root, { attributes: true, attributeFilter: ['data-motion'] })
        cleanups.push(() => motion.disconnect())
      }

      const textarea = term.textarea
      const onFocus = () => { focused = true
        setHasFocus(true)
        latest.current.onFocusChange?.(true) }
      const onBlur = () => { focused = false
        setHasFocus(false)
        latest.current.onFocusChange?.(false) }
      textarea?.addEventListener('focus', onFocus)
      textarea?.addEventListener('blur', onBlur)
      cleanups.push(() => { textarea?.removeEventListener('focus', onFocus)
        textarea?.removeEventListener('blur', onBlur) })

      const data = term.onData(input => {
        if (latest.current.readOnly || !(focused || pasting)) return
        // The key bar's Ctrl is sticky: it transforms the next keystroke the phone keyboard produces, which is
        // the only way to reach Ctrl+C on a touch keyboard that has no modifier of its own.
        if (sticky.current) { sticky.current = false
          setCtrl(false)
          handle?.write(controlOf(input))
          return }
        handle?.write(input)
      })
      cleanups.push(() => data.dispose())
      send.current = text => {
        if (latest.current.readOnly) return
        handle?.write(text)
      }
      cleanups.push(() => { send.current = null })

      const onPaste = async event => {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (latest.current.readOnly || !latest.current.connected) return
        const clean = sanitizePaste(event.clipboardData?.getData('text/plain') ?? '')
        if (!clean) return
        if (pasteNeedsConfirm(clean)) {
          const ok = await latest.current.confirmPaste?.(pasteSizeText(clean))
          if (!ok || disposed) return
        }
        pasting = true
        try { term.paste(clean) } finally { pasting = false }
      }
      element.addEventListener('paste', onPaste, true)
      cleanups.push(() => element.removeEventListener('paste', onPaste, true))

      // The local fit always runs, so the browser shows whole lines. Sending the new size to the server is what a
      // phone must not do: the PTY is the one the owner is working in on the machine, so a resize from a phone
      // reflows their desktop terminal under them. Decided for remote access: full control from the phone, except
      // this. The viewport decides, not the user agent.
      const phone = phoneViewport(scope)
      const refit = () => {
        try { fit.fit() } catch {}
        if (!phone) handle?.resize(term.cols, term.rows)
      }
      const scheduleResize = () => {
        if (timer !== null) { pending = true
          return }
        refit()
        const tick = () => {
          if (pending) {
            pending = false
            refit()
            timer = setTimeout(tick, RESIZE_MS)
          } else timer = null
        }
        timer = setTimeout(tick, RESIZE_MS)
      }
      if (globalThis.ResizeObserver) {
        observer = new ResizeObserver(scheduleResize)
        observer.observe(element)
      }

      let attachedOnce = false
      const attach = () => {
        handle = client.attach(sessionId, { cols: term.cols, rows: term.rows }, handlers)
      }
      const handlers = {
        onAttached: () => {
          attachedOnce = true
          sawDown.current = false
          setWaiting(false)
          setConnected(true)
        },
        onSnapshot: bytes => {
          term.reset()
          term.write(bytes)
          setPainted(true)
        },
        onOutput: bytes => {
          term.write(bytes)
          setPainted(true)
        },
        onExit: () => setConnected(false),
        onError: error => {
          setConnected(false)
          if (error?.code === 'deckd_unavailable' && !attachedOnce) setWaiting(true)
        }
      }
      if (client) {
        reattach.current = () => { if (!disposed) attach() }
        attach()
      }
      if (autoFocus) term.focus()
    })()

    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      observer?.disconnect()
      reattach.current = null
      handle?.detach()
      for (const cleanup of cleanups) cleanup()
      term?.dispose()
      termRef.current = null
    }
  }, [sessionId, client])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.disableStdin = !!readOnly || !connected
    term.options.cursorInactiveStyle = readOnly ? 'none' : 'outline'
    term.options.screenReaderMode = !!screenReaderMode
  }, [readOnly, connected, screenReaderMode])

  // The server forgot an attach deckd never completed; ask again once deckd is back. "Back" is a return to up
  // after down, so a health row that still reads up when the error arrives does not start an attach loop.
  useEffect(() => {
    if (!deckdUp) {
      sawDown.current = true
      return
    }
    if (!waiting || !sawDown.current) return
    sawDown.current = false
    setWaiting(false)
    reattach.current?.()
  }, [waiting, deckdUp])

  const ariaLabel = translate(t, TERMINAL_COPY, 'terminal.label', { label: titleText(label) })
  return (
    <section ref={section} className="terminal-view" aria-label={ariaLabel} data-readonly={readOnly ? 'true' : undefined}
      data-waiting={waiting ? 'deckd' : undefined}>
      {!painted && (
        <div className="terminal-skeleton" aria-hidden="true">
          {Array.from({ length: SKELETON_LINES }, (_, index) => <span key={index} className="terminal-skeleton-line motion-shimmer" />)}
        </div>
      )}
      <div ref={host} className="terminal-host" />
      {phone && !readOnly && hasFocus ? (
        <KeyBar ctrl={ctrl} t={t} onCtrl={() => { sticky.current = !sticky.current
          setCtrl(sticky.current) }} onKey={text => send.current?.(text)} />
      ) : null}
    </section>
  )
}
