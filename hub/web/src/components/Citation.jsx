import React from 'react'
import { titleText, translate } from './StatusPill.jsx'
import { proseText } from './TranscriptLine.jsx'
import { noteHref } from './NoteChip.jsx'
import { linkHandler } from '../shell/Rail.jsx'

/** Citation copy (screens/memory.md 9). */
export const CITATION_COPY = Object.freeze({
  'memory.ask.viaGraph': 'via graph'
})

/**
 * A vault citation (components 22): a link to `/memory/note/<path>#L<line>` reading `<path>:<line>`, plus
 * " · via graph" when the hit came through a graph hop. `source` is the teal chip of an answer's citation list;
 * `callout` adds the note title above and the snippet below (Focus "Related memory"). The path and title are
 * untrusted text shown through `titleText` inside a `bdi`; the title and snippet carry `lang="pt-BR"`.
 * With `navigate` a plain click routes inside the deck. Pure: no CSS import, no storage.
 * @param {{ variant?: 'source' | 'callout', path: string, line?: number | null, viaGraph?: boolean, title?: string, snippet?: string, href?: string, navigate?: (to: string) => void, t?: (key: string, params?: object) => string }} props
 */
export function Citation({ variant = 'source', path, line = null, viaGraph = false, title, snippet, href, navigate, t }) {
  const target = href ?? noteHref(path, line)
  const ref = (
    <span className="citation-ref">
      <bdi>{titleText(path)}</bdi>{Number.isInteger(line) && line > 0 ? `:${line}` : null}
      {viaGraph ? <span className="citation-via"><span aria-hidden="true"> · </span>{translate(t, CITATION_COPY, 'memory.ask.viaGraph')}</span> : null}
    </span>
  )
  const callout = variant === 'callout'
  return (
    <a className={`citation citation--${callout ? 'callout' : 'source'}`} href={target} onClick={navigate ? linkHandler(navigate, target) : undefined}>
      {callout ? null : <span className="citation-dot" aria-hidden="true" />}
      {callout && title ? <bdi className="citation-title" lang="pt-BR">{titleText(title)}</bdi> : null}
      {ref}
      {callout && snippet ? <span className="citation-snippet" lang="pt-BR" dir="auto">{proseText(snippet)}</span> : null}
    </a>
  )
}
