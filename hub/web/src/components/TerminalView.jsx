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
 * link opens only when `confirmLink(uri)` returns true, and localhost opens at once. Opening uses
 * `open(uri, '_blank', 'noopener,noreferrer')`.
 * @param {string} uri
 * @param {{ confirmLink: (uri: string) => boolean, open: (url: string, target: string, features: string) => unknown }} options
 * @returns {boolean} whether the link was opened
 */
export function handleLink(uri, { confirmLink, open }) {
  const decision = linkDecision(uri)
  if (decision === 'refuse') return false
  if (decision === 'confirm' && !confirmLink(uri)) return false
  open(uri, '_blank', 'noopener,noreferrer')
  return true
}

/**
 * The live xterm for one session (components.md section 14). xterm and the fit addon load with dynamic
 * `import()` inside an effect, so the component renders its labelled section and skeleton lines under
 * `renderToStaticMarkup` in Node without loading them. A snapshot frame resets the terminal; output frames
 * are written as they come; keystrokes reach `client` only while the terminal has focus. Global chords
 * (keyboard.md section 2) are left to the shell. Pastes are sanitized and confirmed above 4 KB, then
 * handed to xterm's bracketed paste. Links open only for `http:` and `https:`.
 * @param {{
 *   sessionId: string, label: string, readOnly?: boolean, screenReaderMode?: boolean,
 *   client?: ReturnType<import('../state/terminal.js').createTerminalClient> | null, initialText?: string,
 *   autoFocus?: boolean, onFocusChange?: (focused: boolean) => void,
 *   confirmPaste?: (sizeText: string) => boolean | Promise<boolean>, confirmLink?: (url: string) => boolean,
 *   t?: Function
 * }} props
 */
export function TerminalView({
  sessionId, label, readOnly = false, screenReaderMode = false, client = null, initialText = '', autoFocus = false,
  onFocusChange, confirmPaste, confirmLink, t
}) {
  const section = useRef(null)
  const host = useRef(null)
  const termRef = useRef(null)
  const latest = useRef({})
  const [painted, setPainted] = useState(!!initialText)
  const [connected, setConnected] = useState(false)
  latest.current = { readOnly, connected, onFocusChange, confirmPaste, confirmLink, t }

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
    const reducedMotion = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // A new session (or client) starts detached and unpainted, so the stdin effect re-runs on its attach.
    setConnected(false)
    setPainted(!!initialText)

    ;(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      if (disposed) return
      term = new Terminal({
        ...terminalOptions({ readOnly: latest.current.readOnly, connected: false, screenReaderMode, reducedMotion, theme: themeFor(section.current) }),
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

      const refit = () => {
        try { fit.fit() } catch {}
        handle?.resize(term.cols, term.rows)
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

      if (client) {
        handle = client.attach(sessionId, { cols: term.cols, rows: term.rows }, {
          onAttached: () => setConnected(true),
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
          onError: () => setConnected(false)
        })
      }
      if (autoFocus) term.focus()
    })()

    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      observer?.disconnect()
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

  const ariaLabel = translate(t, TERMINAL_COPY, 'terminal.label', { label: titleText(label) })
  return (
    <section ref={section} className="terminal-view" aria-label={ariaLabel} data-readonly={readOnly ? 'true' : undefined}>
      {!painted && (
        <div className="terminal-skeleton" aria-hidden="true">
          {Array.from({ length: SKELETON_LINES }, (_, index) => <span key={index} className="terminal-skeleton-line motion-shimmer" />)}
        </div>
      )}
      <div ref={host} className="terminal-host" />
    </section>
  )
}
