import React, { useEffect, useRef, useState } from 'react'
import { titleText, translate } from './StatusPill.jsx'
import { PHONE_QUERY, isGlobalChord, phoneViewport } from '../state/deck-store.js'
import { KEY_BAR, keystroke, pasteNeedsConfirm, pasteSizeText, sanitizePaste } from '../state/terminal.js'

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

/** How far a pointer may travel on a key and still count as a press rather than a scroll of the bar. */
const PRESS_SLOP = 10

/**
 * The phone key bar (mobile-focus-mockup): the keys a touch keyboard has no way to send, above the keyboard and
 * only while the terminal has focus.
 *
 * A key fires on `pointerup`, not on `pointerdown`: ten 44px keys are wider than the screen, so the bar scrolls
 * sideways and almost every draggable pixel is a key. Firing on the way down would send Esc to a real PTY every
 * time someone swipes to reach `~`. `pointerdown` still prevents its default, which is what keeps the focus (and
 * the keyboard) on the terminal. `click` is the path assistive technology and a Bluetooth keyboard take, and it
 * acts only when the pointer path did not already.
 * @param {{ ctrl: boolean, t?: Function, onKey: (key: object) => void }} props
 */
function KeyBar({ ctrl, t, onKey }) {
  const origin = useRef(null)
  const handled = useRef(false)
  const down = event => {
    event.preventDefault()
    origin.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
  }
  const up = key => event => {
    const from = origin.current
    origin.current = null
    if (!from || from.id !== event.pointerId) return
    // The pointer path has decided this interaction either way, so the click that follows must not act: a drag
    // across the bar is a scroll, and a browser that still fires click after it would send the key anyway.
    handled.current = true
    if (Math.abs(event.clientX - from.x) > PRESS_SLOP || Math.abs(event.clientY - from.y) > PRESS_SLOP) return
    onKey(key)
  }
  const click = key => () => {
    if (handled.current) { handled.current = false
      return }
    onKey(key)
  }
  return (
    <div className="terminal-keys" role="toolbar" aria-label={translate(t, TERMINAL_COPY, 'terminal.keys.label')}>
      {KEY_BAR.map(key => (
        <button key={key.id} type="button" className="terminal-key" onPointerDown={down} onPointerUp={up(key)}
          onPointerCancel={() => { origin.current = null }} onClick={click(key)} onMouseDown={event => event.preventDefault()}
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
  // Followed, not read once: the key bar's styles live inside the phone media query, so a turn to landscape
  // has to take the bar away with them. The resize guard keeps its own flag, read when the PTY is attached.
  const [phone, setPhone] = useState(() => phoneViewport({ matchMedia: globalThis.matchMedia?.bind(globalThis) }))
  /** One keystroke through the sticky modifier. Every path into the PTY goes through this, bar keys included. */
  const stroke = input => {
    const next = keystroke(input, sticky.current)
    if (sticky.current) { sticky.current = false
      setCtrl(false) }
    return next.send
  }
  /** A key bar press: Ctrl arms or disarms the modifier, every other key goes through `stroke` like a keystroke. */
  const onBarKey = key => {
    if (key.id === 'ctrl') { sticky.current = !sticky.current
      setCtrl(sticky.current)
      return }
    send.current?.(key.send)
  }
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
    // A new session (or client) starts with no modifier armed and no focus: an armed Ctrl must never survive
    // into another session's PTY. Focus.jsx keys this component by session id today, so the effect re-runs on a
    // fresh instance, but the component's own contract is that `sessionId` may change.
    sticky.current = false
    setCtrl(false)
    setHasFocus(false)
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
      // Dismissing the keyboard disarms Ctrl: an armed modifier that waits through a blur would silently
      // modify the first key typed after coming back.
      const onBlur = () => { focused = false
        setHasFocus(false)
        sticky.current = false
        setCtrl(false)
        latest.current.onFocusChange?.(false) }
      textarea?.addEventListener('focus', onFocus)
      textarea?.addEventListener('blur', onBlur)
      cleanups.push(() => { textarea?.removeEventListener('focus', onFocus)
        textarea?.removeEventListener('blur', onBlur) })

      const data = term.onData(input => {
        if (latest.current.readOnly || !(focused || pasting)) return
        // The key bar's Ctrl is sticky: it transforms the next keystroke the phone keyboard produces, which is
        // the only way to reach Ctrl+C on a touch keyboard that has no modifier of its own.
        handle?.write(stroke(input))
      })
      cleanups.push(() => data.dispose())
      send.current = text => {
        if (latest.current.readOnly) return
        handle?.write(stroke(text))
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
      const phoneAtAttach = phoneViewport(scope)
      const refit = () => {
        try { fit.fit() } catch {}
        if (!phoneAtAttach) handle?.resize(term.cols, term.rows)
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

  useEffect(() => {
    const query = globalThis.matchMedia?.(PHONE_QUERY)
    if (!query?.addEventListener) return undefined
    const onChange = () => setPhone(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

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
      {phone && !readOnly && hasFocus ? <KeyBar ctrl={ctrl} t={t} onKey={onBarKey} /> : null}
    </section>
  )
}
