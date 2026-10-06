import React from 'react'
import { titleText } from '../../components/StatusPill.jsx'
import { NoteChip } from '../../components/NoteChip.jsx'
import { renderMarkdown } from '../team-run/PlanDrawer.jsx'

/** Return the section containing a cited line, or the first level-two section. */
export function noteExcerpt(body, line = null) {
  const lines = String(body ?? '').split('\n')
  const headings = lines.flatMap((text, i) => /^##\s/.test(text) ? [i] : [])
  if (!headings.length) return lines.join('\n').slice(0, 20000)
  const at = line ? Math.min(lines.length - 1, line - 1) : headings[0]
  const start = headings.filter(index => index <= at).at(-1) ?? 0
  const end = headings.find(index => index > start) ?? lines.length
  return lines.slice(start, end).join('\n').slice(0, 20000)
}
export function NotePanel({ result, line, loading = false, error, navigate = () => {}, onOpen, onAsk }) {
  if (loading) return <aside aria-label="Note preview" aria-busy="true"><p>Loading note…</p></aside>
  if (error) return <aside aria-label="Note preview"><p>{error.code === 'vault_error' && /not found/.test(error.details?.text ?? '') ? 'This note is not in your vault anymore.' : titleText(error.details?.text ?? error.message ?? String(error))}</p><a href="/memory">Whole map</a></aside>
  if (!result) return null
  const { note, backlinks = [], linksOut = [], usage = {} } = result
  const fm = note.frontmatter ?? {}
  const tags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === 'string' ? fm.tags.split(',').map(tag => tag.trim()).filter(Boolean) : []
  // The text contract flattens YAML. Use its block-frontmatter convention unless the server gives an offset.
  const bodyStartLine = note.bodyStartLine ?? (Object.keys(fm).length ? 3 + Object.keys(fm).length + tags.length : 1)
  const excerpt = noteExcerpt(note.body, line ? Math.max(1, line - bodyStartLine + 1) : null)
  // Wiki links use visible note names; they never become unvalidated URLs.
  const markdown = excerpt.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path, title) => title ?? path.split('/').at(-1))
  return <aside className="memory-note" aria-label="Note preview">
    <code><bdi>{titleText(note.path)}</bdi></code><h2><bdi lang="pt-BR">{titleText(note.title ?? fm.titulo ?? note.path)}</bdi></h2>
    <div className="note-meta">{[...tags, fm.tipo, fm.atualizado].filter(Boolean).map((tag, i) => <span key={i}>{titleText(String(tag))}</span>)}</div>
    <div lang="pt-BR" className="note-excerpt">{renderMarkdown(markdown)}</div>
    <button onClick={onOpen}>Open in Obsidian</button><button onClick={() => onAsk?.(`About ${note.title ?? fm.titulo ?? note.path} (${note.path}): `)}>Ask about this note</button>
    <h3>Backlinks · {backlinks.length}</h3><ul>{backlinks.map(row => <li key={row.path}><NoteChip {...row} title={`${row.title ?? row.path}${row.path.endsWith('-moc.md') ? ' (MOC)' : ''}`} navigate={navigate} /></li>)}</ul>
    <h3>Links out · {linksOut.length}</h3><ul>{linksOut.map(row => <li key={row.path}><NoteChip {...row} navigate={navigate} /></li>)}</ul>
    <h3>Recently used</h3><ul>{(usage.citedIn ?? []).map(row => <li key={row.threadId}>Cited today in the thread "<bdi>{titleText(row.title)}</bdi>"</li>)}{(usage.readBy ?? []).map((row, i) => <li key={i}>Read by the <bdi>{titleText(row.repoName ?? 'unknown')}</bdi> session at {new Date(row.at).toLocaleTimeString()} ({titleText(row.tool)})</li>)}</ul>
  </aside>
}
