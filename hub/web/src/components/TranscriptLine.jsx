import React from 'react'

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
function highlight(text, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return text
  const parts = []
  let at = 0
  const sorted = ranges.filter(range => Array.isArray(range) && range.length === 2).map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)]).sort((a, b) => a[0] - b[0])
  for (const [start, end] of sorted) {
    if (start < at || end <= start) continue
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>)
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/**
 * One transcript line or search hit (components 34): the offset, the speaker and the text, all as text
 * nodes; meeting content carries `lang="pt-BR"`. `ranges` are `[start, end]` offsets into the text (a hit's
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
      <span className="transcript-line-speaker" lang="pt-BR">{String(line?.speaker ?? '')}</span>
      <span className="transcript-line-text" lang="pt-BR">{highlight(text, ranges)}</span>
    </>
  )
  if (onClick) return <button type="button" className={className} aria-pressed={pinned} onClick={onClick}>{body}</button>
  return <div className={className}>{body}</div>
}
