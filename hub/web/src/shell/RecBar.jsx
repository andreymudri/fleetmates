import React, { useEffect, useRef, useState } from 'react'
import { linkHandler } from './Rail.jsx'
import { titleText, translate } from '../components/StatusPill.jsx'
import { formatOffset } from '../components/TranscriptLine.jsx'
import { motionReduced } from '../components/TerminalView.jsx'

/** The recording bar copy (screens/meetings.md section 9, `meetings.live.*`). */
export const REC_COPY = Object.freeze({
  'meetings.live.recording': 'Recording',
  'meetings.live.title': '{tag} · started {time}',
  'meetings.live.quiet': 'Sound muted while recording · popups still show',
  'meetings.live.pin': 'Pin moment',
  'meetings.live.stop': 'Stop and summarize',
  'meetings.live.stopping': 'Stopping… saving the session',
  'meetings.live.stillStopping': 'Still stopping, scribed is closing the session',
  'meetings.live.static.a11y': 'Recording, started {time}'
})

/**
 * A config tag as a title: each word capitalised, `-` and `_` read as spaces ("client-a" gives "Client A").
 * @param {unknown} tag
 * @returns {string}
 */
export function tagTitle(tag) {
  return String(tag ?? '').split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
}

/**
 * A local `HH:MM` clock time, empty without a time.
 * @param {number | null | undefined} at ms since the epoch
 * @param {string} [lang]
 * @returns {string}
 */
export function clockTime(at, lang = 'en') {
  return Number.isFinite(at) ? new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at) : ''
}

/**
 * Whether the bar shows: while the recorder is `recording` or `stopping` (screens/meetings.md 5.2).
 * @param {{ state?: string } | null | undefined} recorder
 * @returns {boolean}
 */
export function recBarShown(recorder) {
  return recorder?.state === 'recording' || recorder?.state === 'stopping'
}

/**
 * The recording bar without state (screens/meetings.md 4.3): the dot (static under reduced motion), "Recording",
 * the "{Tag} · started {time}" link to the live view, the aria-hidden timer with a static screen reader start
 * time, the quiet note (text, or an info icon with a tooltip at 1280 wide), "Pin moment" with Alt P and "Stop and
 * summarize". While stopping it shows only the neutral stopping text. Renders nothing otherwise. `skipLink`, when
 * given, renders first inside the bar's labelled region, so the shell's skip link stays the first focusable element
 * and sits inside a landmark while the bar shows.
 * @param {{ recorder: object, t?: Function, lang?: string, elapsedS: number, reduced?: boolean, navigate: Function, onPin: () => void, onStop: () => void, skipLink?: import('react').ReactNode }} props
 */
export function RecBarView({ recorder, t, lang = 'en', elapsedS, reduced = false, navigate, onPin, onStop, skipLink = null }) {
  if (!recBarShown(recorder)) return null
  const say = (key, params) => translate(t, REC_COPY, key, params)
  const label = say('meetings.live.recording')
  if (recorder.state === 'stopping') {
    return (
      <div className="rec-bar rec-bar--stopping" role="region" aria-label={label}>
        {skipLink}
        <span className="rec-bar-text">{say(recorder.slow ? 'meetings.live.stillStopping' : 'meetings.live.stopping')}</span>
      </div>
    )
  }
  const time = clockTime(recorder.startedAt, lang)
  const quiet = say('meetings.live.quiet')
  return (
    <div className="rec-bar rec-bar--recording" role="region" aria-label={label}>
      {skipLink}
      <span className={reduced ? 'rec-bar-dot' : 'rec-bar-dot motion-rec-pulse'} aria-hidden="true" />
      <span className="rec-bar-label">{label}</span>
      <a className="rec-bar-title" href="/meetings/live" onClick={linkHandler(navigate, '/meetings/live')}><bdi>{titleText(say('meetings.live.title', { tag: tagTitle(recorder.tag), time }))}</bdi></a>
      <span className="rec-bar-timer" aria-hidden="true">{formatOffset(elapsedS)}</span>
      <span className="sr-only">{say('meetings.live.static.a11y', { time })}</span>
      {recorder.quiet
        ? (
          <>
            <span className="rec-bar-quiet">{quiet}</span>
            <span className="rec-bar-quiet-info" tabIndex={0} aria-label={quiet}>
              <span aria-hidden="true">i</span>
              <span className="rec-bar-quiet-tip" role="tooltip">{quiet}</span>
            </span>
          </>
          )
        : null}
      <span className="rec-bar-actions">
        <button type="button" className="button button--ghost button--xs rec-bar-pin" onClick={onPin}>
          {say('meetings.live.pin')} <kbd className="kbd kbd--on-primary">Alt P</kbd>
        </button>
        <button type="button" className="button button--danger-confirm button--xs" onClick={onStop}>{say('meetings.live.stop')}</button>
      </span>
    </div>
  )
}

/**
 * The recording bar the shell renders first on every screen (rail-and-shell.md 4.2). The timer starts from the
 * recorder's `elapsedS` and ticks locally each second, because `meeting.status` is not resent when only
 * `elapsedS` changes. Reduced motion follows the OS query and Settings (`data-motion="reduce"`).
 * @param {{ recorder: object, t?: Function, lang?: string, navigate: Function, onPin: () => void, onStop: () => void, skipLink?: import('react').ReactNode }} props
 */
export function RecBar({ recorder, t, lang, navigate, onPin, onStop, skipLink }) {
  const recording = recorder?.state === 'recording'
  const base = useRef({ meetingId: null, elapsedS: 0, at: 0 })
  if (base.current.meetingId !== recorder?.meetingId || base.current.elapsedS !== recorder?.elapsedS) {
    base.current = { meetingId: recorder?.meetingId ?? null, elapsedS: Number(recorder?.elapsedS) || 0, at: Date.now() }
  }
  const [now, setNow] = useState(() => Date.now())
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (!recording) return undefined
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [recording])
  useEffect(() => {
    if (!recording) return undefined
    const read = () => setReduced(motionReduced({ matchMedia: query => window.matchMedia?.(query), root: document.documentElement }))
    read()
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    query?.addEventListener?.('change', read)
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(read) : null
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
    return () => {
      query?.removeEventListener?.('change', read)
      observer?.disconnect()
    }
  }, [recording])
  const elapsedS = base.current.elapsedS + Math.max(0, Math.floor((now - base.current.at) / 1000))
  return <RecBarView recorder={recorder} t={t} lang={lang} elapsedS={elapsedS} reduced={reduced} navigate={navigate} onPin={onPin} onStop={onStop} skipLink={skipLink} />
}
