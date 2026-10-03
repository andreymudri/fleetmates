import React from 'react'
import { format } from '../i18n/en.js'
import { shown } from './StatusPill.jsx'

/**
 * Default DiffView copy, verbatim from the Focus copy deck (docs/deck/screens/focus.md section 9) and the
 * DiffView states of docs/deck/design/components.md 40. Focus passes its own translated strings in `labels`.
 */
export const DIFF_LABELS = Object.freeze({
  caption: '{path} · unified (panel is narrow)',
  error: 'Could not read the diff: {message}',
  retry: 'Retry',
  binary: 'Binary file, {size}. Open in editor.',
  truncated: 'Diff truncated: too large to show in full.',
  empty: 'No changes in this file.',
  loading: 'Loading the diff'
})

/**
 * A byte count as the DiffView binary line shows it ("2.1 MB").
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024
    unit += 1 }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Split unified diff text into typed lines (components.md 40 `DiffLine`): the header lines before the first
 * hunk are `meta`, `@@` lines are `hunk`, then `+` is `add`, `-` is `del` and the rest is `context`.
 * @param {string} text
 * @returns {{ kind: 'meta' | 'hunk' | 'add' | 'del' | 'context', text: string }[]}
 */
export function diffLines(text) {
  const rows = String(text ?? '').split('\n')
  if (rows.at(-1) === '') rows.pop()
  let inHunk = false
  return rows.map(row => {
    if (row.startsWith('@@')) { inHunk = true
      return { kind: 'hunk', text: row } }
    if (!inHunk || row.startsWith('diff --git ')) { inHunk = false
      return { kind: 'meta', text: row } }
    if (row.startsWith('+')) return { kind: 'add', text: row }
    if (row.startsWith('-')) return { kind: 'del', text: row }
    return { kind: 'context', text: row }
  })
}

/**
 * The Changes tab diff, `unified` (the details panel is narrower than 720 px, Decided). Lines render as text
 * (tabs kept, other control characters as visible tokens) with add and delete classes and keep their `+` and `-` prefix; loading shows skeleton lines; a failed read
 * shows "Could not read the diff: {message}" with "Retry"; a binary file shows "Binary file, {size}. Open in
 * editor."; a truncated diff carries a note. The component calls no hook.
 * @param {{
 *   path: string, state: { status: 'loading' | 'error' | 'ready', data?: { diff: string, binary: boolean, truncated: boolean, size?: number }, message?: string },
 *   onRetry?: () => void, labels?: Partial<Record<keyof typeof DIFF_LABELS, string>>
 * }} props
 */
export function DiffView({ path, state, onRetry = () => {}, labels }) {
  const copy = { ...DIFF_LABELS, ...labels }
  const caption = <figcaption className="diff-caption">{format(copy.caption, { path: shown(path) })}</figcaption>
  const status = state?.status ?? 'loading'
  if (status === 'loading') {
    return (
      <figure className="diff-view diff-view--loading" aria-busy="true">
        {caption}
        <span className="sr-only">{copy.loading}</span>
        {[0, 1, 2, 3].map(index => <div key={index} className="diff-skeleton motion-shimmer" aria-hidden="true" />)}
      </figure>
    )
  }
  if (status === 'error') {
    return (
      <figure className="diff-view diff-view--error">
        {caption}
        <p className="diff-note diff-note--error" role="alert">{format(copy.error, { message: shown(state.message ?? '') })}</p>
        <button type="button" className="button button--secondary button--xs" onClick={() => onRetry()}>{copy.retry}</button>
      </figure>
    )
  }
  const data = state.data ?? {}
  if (data.binary) {
    return (
      <figure className="diff-view diff-view--binary">
        {caption}
        <p className="diff-note">{format(copy.binary, { size: formatSize(data.size) })}</p>
      </figure>
    )
  }
  const lines = diffLines(data.diff)
  // Tabs are layout in source code, so they stay; every other control or invisible character becomes a token.
  const visible = text => text.split('\t').map(shown).join('\t')
  return (
    <figure className="diff-view">
      {caption}
      {lines.length ? (
        <pre className="diff-lines">
          {lines.map((line, index) => <span key={index} className={`diff-line diff-line--${line.kind}`}>{visible(line.text)}{'\n'}</span>)}
        </pre>
      ) : <p className="diff-note">{copy.empty}</p>}
      {data.truncated ? <p className="diff-note">{copy.truncated}</p> : null}
    </figure>
  )
}
