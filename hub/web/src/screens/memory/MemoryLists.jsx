import React, { useEffect, useState } from 'react'
import { NoteChip, domainOf } from '../../components/NoteChip.jsx'
import { titleText } from '../../components/StatusPill.jsx'
import { searchVault } from '../../state/actions.js'

export function browseGroups(notes) {
  const groups = new Map()
  for (const note of notes) { const domain = note.domain ?? domainOf(note.path) ?? 'Other'; if (!groups.has(domain)) groups.set(domain, []); groups.get(domain).push(note) }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([domain, rows]) => ({ domain, notes: rows.sort((a, b) => a.path.localeCompare(b.path)) }))
}
export function BrowseView({ notes = [], navigate }) {
  return <section aria-label="Browse by MOC">{browseGroups(notes).map(group => <section key={group.domain}><h2 className="eyebrow">{titleText(group.domain)} · {group.notes.length}</h2><ul>{group.notes.map(note => <li key={note.path}><NoteChip {...note} navigate={navigate} /><code><bdi>{titleText(note.path)}</bdi></code><span>{titleText(note.atualizado ?? '')}</span></li>)}</ul></section>)}</section>
}
export function CapturesView({ captures = [], day, onDay, navigate }) {
  return <section aria-label="Captures"><label>Day <input type="date" value={day ?? ''} onChange={event => onDay?.(event.target.value)} /></label>
    {captures.length ? <ul>{captures.map(row => <li key={row.path}><NoteChip {...row} navigate={navigate} />{row.sessionId ? <span>from <bdi>{titleText(row.repoName ?? 'unknown')}</bdi> · {new Date(row.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}</li>)}</ul> : <p>Nothing captured today.</p>}
  </section>
}
export function MissesView({ misses = [], navigate = () => {}, onResolve, api }) {
  const [picker, setPicker] = useState(null), [query, setQuery] = useState(''), [hits, setHits] = useState([]), [error, setError] = useState(null)
  useEffect(() => { if (!picker || !query.trim() || !api) { setHits([]); return }
    let current = true
    const timer = setTimeout(() => { searchVault(api, query, 10).then(result => { if (current) { setHits(result.hits); setError(null) } }, error => { if (current) setError(error.message) }) }, 150)
    return () => { current = false; clearTimeout(timer) }
  }, [picker, query, api])
  const row = miss => <li key={miss.id}><p><bdi>{titleText(miss.question)}</bdi></p><p>{miss.searchedTerms?.map(titleText).join(' · ')} · {new Date(miss.createdAt).toLocaleDateString()}</p>
    {miss.threadId ? <a href={`/memory?thread=${encodeURIComponent(miss.threadId)}`}>Thread</a> : null}
    {miss.resolvedBy ? <p>{titleText(miss.resolvedBy)}</p> : <><button onClick={() => navigate(`/research/new?topic=${encodeURIComponent(miss.question)}&miss=${encodeURIComponent(miss.id)}`)}>Research this</button><button onClick={() => { setPicker(miss.id); setQuery('') }}>The vault has this</button><button onClick={() => onResolve?.(miss.id, 'dismissed')}>Dismiss</button></>}
    {picker === miss.id ? <div><label>Pick the note that answers it<input value={query} onChange={event => setQuery(event.target.value)} /></label>{error ? <p role="alert">{titleText(error)}</p> : null}<ul>{hits.map(hit => <li key={`${hit.path}:${hit.line}`}><button onClick={() => { onResolve?.(miss.id, `note:${hit.path}`); setPicker(null) }}><bdi>{titleText(hit.title ?? hit.path)}</bdi></button></li>)}</ul></div> : null}
  </li>
  const open = misses.filter(miss => !miss.resolvedBy), resolved = misses.filter(miss => miss.resolvedBy)
  return <section aria-label="Misses">{open.length ? <ul>{open.map(row)}</ul> : <p>No misses. Every question found an answer.</p>}{resolved.length ? <details><summary>Resolved</summary><ul>{resolved.map(row)}</ul></details> : null}</section>
}
