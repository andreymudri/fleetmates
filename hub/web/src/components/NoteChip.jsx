import React from 'react'
import { titleText } from './StatusPill.jsx'
import { linkHandler } from '../shell/Rail.jsx'

/**
 * The SPA route of a vault note (`/memory/note/<path>`, each path segment encoded), with `#L<line>` when a line is
 * given (screens/memory.md 1).
 * @param {string} path vault-relative
 * @param {number | null} [line]
 * @returns {string}
 */
export function noteHref(path, line = null) {
  const encoded = String(path ?? '').split('/').map(encodeURIComponent).join('/')
  const at = Number.isInteger(line) && line > 0 ? `#L${line}` : ''
  return `/memory/note/${encoded}${at}`
}

/**
 * The domain of a vault path: `<d>` for `02-wiki/<d>/...`, `projects` for `03-projects/...`, else null.
 * @param {string} path
 * @returns {string | null}
 */
export function domainOf(path) {
  const parts = String(path ?? '').split('/')
  if (parts[0] === '02-wiki' && parts.length > 2 && parts[1]) return parts[1]
  if (parts[0] === '03-projects') return 'projects'
  return null
}

// The note name a path shows when no title is known: the last segment without `.md`.
const baseTitle = path => String(path ?? '').split('/').at(-1).replace(/\.md$/, '')

/**
 * A link to a vault note named by its title (components 21). `inline` sits in prose; `learned` is the teal
 * "learned" chip. The title is untrusted text: it goes through `titleText` inside a `bdi` and carries `lang="pt-BR"`.
 * The dot reads its colour from `data-domain`. With `navigate` a plain click routes inside the deck.
 * Pure: no CSS import, no storage.
 * @param {{ path: string, title?: string, domain?: string | null, variant?: 'inline' | 'learned', href?: string, navigate?: (to: string) => void }} props
 */
export function NoteChip({ path, title, domain, variant = 'inline', href, navigate }) {
  const target = href ?? noteHref(path)
  const name = title ? String(title) : baseTitle(path)
  return (
    <a className={`note-chip note-chip--${variant === 'learned' ? 'learned' : 'inline'}`} href={target} onClick={navigate ? linkHandler(navigate, target) : undefined}>
      <span className="note-chip-dot" data-domain={domain ?? domainOf(path) ?? undefined} aria-hidden="true" />
      <bdi className="note-chip-title" lang="pt-BR">{titleText(name)}</bdi>
    </a>
  )
}
