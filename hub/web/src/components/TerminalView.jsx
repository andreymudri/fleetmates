import React, { useEffect, useRef, useState } from 'react'
import { titleText, translate } from './StatusPill.jsx'
import { isGlobalChord } from '../state/deck-store.js'
import { pasteNeedsConfirm, pasteSizeText, sanitizePaste } from '../state/terminal.js'

/** English copy for the terminal section (docs/deck/design/components.md section 14). */
export const TERMINAL_COPY = Object.freeze({
  'terminal.label': 'Terminal, {label}',
  // No spec copy deck names this string yet; 08-security 4.6 only requires that the real URL is shown.
  'terminal.link.confirm': 'Open this link from the terminal?\n{url}'
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
export function terminalOptions({ readOnly = false, connected = false, screenReaderMode = false, reducedMotion = false, theme } = {}) {
  return {
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    fontSize: 14,
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
// One below --breakpoint-mobile (768px), the width at which styles/mobile.css lays the deck out as a phone.
const PHONE_QUERY = '(max-width: 767px)'

/**
 * Whether motion is reduced: the OS `prefers-reduced-motion` query, or Settings "Always reduce motion",
 * which the shell writes as `data-motion="reduce"` on the document root.
 * @param {{ matchMedia?: (query: string) => { matches: boolean }, root?: { getAttribute: (name: string) => string|null } | null }} [scope]
 * @returns {boolean}
 */
export function motionReduced({ matchMedia, root } = {}) {
  return !!matchMedia?.(REDUCE_QUERY)?.matches || root?.getAttribute?.('data-motion') === 'reduce'
}

/**
 * Whether this client lays out as a phone, from the viewport and never from a user agent string, the same way
 * `motionReduced` reads its media query.
 * @param {{ matchMedia?: (query: string) => { matches: boolean } }} [scope]
 * @returns {boolean}
 */
export function phoneViewport({ matchMedia } = {}) {
  return !!matchMedia?.(PHONE_QUERY)?.matches
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
        ...terminalOptions({ readOnly: latest.current.readOnly, connected: false, screenReaderMode, reducedMotion: motionReduced(scope), theme: themeFor(section.current) }),
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
        latest.current.onFocusChange?.(true) }
      const onBlur = () => { focused = false
        latest.current.onFocusChange?.(false) }
      textarea?.addEventListener('focus', onFocus)
      textarea?.addEventListener('blur', onBlur)
      cleanups.push(() => { textarea?.removeEventListener('focus', onFocus)
        textarea?.removeEventListener('blur', onBlur) })

      const data = term.onData(input => {
        if (latest.current.readOnly || !(focused || pasting)) return
        handle?.write(input)
      })
      cleanups.push(() => data.dispose())

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
    </section>
  )
}
