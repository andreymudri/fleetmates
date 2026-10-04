import React from 'react'
import { titleText } from './StatusPill.jsx'

/**
 * Multi-line meeting text (a summary, an ask answer) with every control and bidi character but the line break shown
 * as a visible `<U+XXXX>` token through `titleText`, so markdown and `white-space: pre-wrap` keep their lines.
 * @param {unknown} text
 * @returns {string}
 */
export function proseText(text) {
  return String(text ?? '').split(/\r?\n/).map(titleText).join('\n')
}

/**
 * A transcript offset as `MM:SS`, minutes counting past 59 (3725 s is "62:05").
 * @param {number} seconds
 * @returns {string}
 */
export function formatOffset(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// Split text at `[start, end]` ranges into strings and `mark` elements; overlapping or out-of-range parts are skipped.
// The ranges index the server's text, so each part is cut first and neutralised by `titleText` after.
function highlight(text, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return titleText(text)
  const parts = []
  let at = 0
  const sorted = ranges.filter(range => Array.isArray(range) && range.length === 2).map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)]).sort((a, b) => a[0] - b[0])
  for (const [start, end] of sorted) {
    if (start < at || end <= start) continue
    if (start > at) parts.push(titleText(text.slice(at, start)))
    parts.push(<mark key={start}>{titleText(text.slice(start, end))}</mark>)
    at = end
  }
  if (at < text.length) parts.push(titleText(text.slice(at)))
  return parts
}

/**
 * One transcript line or search hit (components 34): the offset, the speaker and the text, all as text
 * nodes; meeting content carries `lang="pt-BR"`, shows its control and bidi characters as `<U+XXXX>` tokens through
 * `titleText`, and is a bidi isolate (the speaker inside a `bdi`, the text a `dir="auto"` span). `ranges` are `[start, end]` offsets into the text (a hit's
 * `snippet` when the line has no `text`) and render as `mark` elements. With `onClick` the line is a toggle
 * button pressed when `pinned`.
 * @param {{ line: { t0: number, speaker?: string, text?: string, snippet?: string }, pinned?: boolean, ranges?: [number, number][], live?: boolean, onClick?: () => void }} props
 */
export function TranscriptLine({ line, pinned = false, ranges, live = false, onClick }) {
  const text = String(line?.text ?? line?.snippet ?? '')
  const className = ['transcript-line', live ? 'transcript-line--live' : 'transcript-line--hit', pinned ? 'transcript-line--pinned' : null].filter(Boolean).join(' ')
  const body = (
    <>
      <span className="transcript-line-offset">{formatOffset(line?.t0)}</span>
      <span className="transcript-line-speaker" lang="pt-BR"><bdi>{titleText(line?.speaker)}</bdi></span>
      <span className="transcript-line-text" dir="auto" lang="pt-BR">{highlight(text, ranges)}</span>
    </>
  )
  if (onClick) return <button type="button" className={className} aria-pressed={pinned} onClick={onClick}>{body}</button>
  return <div className={className}>{body}</div>
}
