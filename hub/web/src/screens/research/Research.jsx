import React, { useEffect, useState } from 'react'
import { titleText } from '../../components/StatusPill.jsx'
import { renderMarkdown } from '../team-run/PlanDrawer.jsx'
import { searchVault } from '../../state/actions.js'
import { linkHandler } from '../../shell/Rail.jsx'

/** The form's name for each field the server can refuse (server/research/service.mjs validateRequest). */
const FIELD_LABELS = { topic: 'the topic', domain: 'the target domain (letters, numbers, - and _ only)', sourceTypes: 'the source types', focusNotes: 'the focus notes', relatedNotes: 'the notes to link', sourceUrls: 'the starting sources (public http or https URLs)', preset: 'the depth' }

export function ResearchForm ({ repos = [], initialTopic = '', domains = [], down = false, busy = false, error, api, onSubmit }) {
  const [topic, setTopic] = useState(initialTopic)
  const [repoKey, setRepo] = useState(repos[0]?.name ?? '')
  const [domain, setDomain] = useState(domains[0] ?? '')
  const [preset, setPreset] = useState('standard')
  const [sourceTypes, setSources] = useState(['docs', 'repo'])
  const [focusNotes, setFocus] = useState('')
  const [sourceUrls, setSourceUrls] = useState('')
  const [relatedNotes, setRelated] = useState([]), [hits, setHits] = useState([]), [lookupFailed, setLookupFailed] = useState(false)
  useEffect(() => {
    if (!api || topic.trim().length < 3 || down) { setHits([]); return }
    let active = true
    const timer = setTimeout(() => searchVault(api, topic, 5).then(result => { if (active) { setHits(result.hits ?? []); setLookupFailed(false) } }, () => { if (active) setLookupFailed(true) }), 300)
    return () => { active = false; clearTimeout(timer) }
  }, [api, topic, down])
  useEffect(() => { setDomain(old => old || domains[0] || '') }, [domains.join(',')])
  return <section className="research-form" aria-label="Research a topic"><h1>Send out scouts</h1><p>A fleetmates team researches; you review the draft before anything is saved.</p>
    <form onSubmit={event => { event.preventDefault(); onSubmit?.({ topic, repoKey, domain, preset, sourceTypes, focusNotes, relatedNotes, sourceUrls: sourceUrls.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }) }}>
      <label>Topic<input autoFocus value={topic} onChange={event => setTopic(event.target.value)} required minLength={3} maxLength={500} /></label>
      <label>Starting sources (optional, one public URL per line)<textarea value={sourceUrls} onChange={event => setSourceUrls(event.target.value)} maxLength={20000} /></label>
      <label>Repository<select value={repoKey} onChange={event => setRepo(event.target.value)} required><option value="">Choose a repository</option>{repos.filter(repo => !repo.archivedAt).map(repo => <option key={repo.id} value={repo.name}>{titleText(repo.name)}</option>)}</select></label>
      <label>Target domain<input list="research-domains" value={domain} onChange={event => setDomain(event.target.value)} required maxLength={100} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
      <datalist id="research-domains">{domains.map(name => <option key={name} value={name} />)}</datalist>
      <fieldset><legend>Depth</legend>{['quick', 'standard', 'deep'].map(name => <label key={name}><input type="radio" name="research-preset" checked={preset === name} onChange={() => setPreset(name)} />{name[0].toUpperCase() + name.slice(1)} · {name === 'quick' ? '1 scout' : name === 'standard' ? '3 scouts' : '5 scouts and verification'}</label>)}</fieldset>
      <fieldset><legend>Source types</legend>{['docs', 'repo', 'blog', 'paper'].map(type => <label key={type}><input type="checkbox" checked={sourceTypes.includes(type)} onChange={event => setSources(old => event.target.checked ? [...old, type] : old.filter(item => item !== type))} />{({ docs: 'Official docs', repo: 'Repos', blog: 'Blogs', paper: 'Papers' })[type]}</label>)}</fieldset>
      {!!hits.length && <fieldset><legend>Existing notes to link</legend>{[...new Map(hits.map(hit => [hit.path, hit])).values()].map(hit => { const name = hit.path.split('/').pop().replace(/\.md$/, ''); return <label key={hit.path}><input type="checkbox" checked={relatedNotes.includes(name)} onChange={event => setRelated(old => event.target.checked ? [...old, name] : old.filter(item => item !== name))} />{titleText(hit.title ?? name)}</label> })}<p>Research creates a new linked note and keeps these notes intact.</p></fieldset>}
      {lookupFailed && !down && <p>Could not check existing notes. Research can proceed.</p>}
      <label>Focus notes (optional)<textarea rows={3} maxLength={3000} value={focusNotes} onChange={event => setFocus(event.target.value)} /></label>
      {down && <p>Could not check your vault for existing notes. Research can proceed; saving will wait.</p>}
      {error && <p role="alert">{FIELD_LABELS[error.details?.field] ? `Check ${FIELD_LABELS[error.details.field]}: the deck could not accept it.` : titleText(error.message ?? error.code ?? String(error))}</p>}
      <button type="submit" disabled={busy || !sourceTypes.length || !repoKey}>{busy ? 'Launching…' : 'Send scouts'}</button>
    </form></section>
}

function markOrphans (node, orphans) {
  if (typeof node === 'string') return node.split(/(\[\d+\])/g).map((part, index) => orphans.includes(Number(/^\[(\d+)\]$/.exec(part)?.[1])) ? <mark className="research-orphan" key={index}>{part}</mark> : part)
  if (Array.isArray(node)) return node.map((child, index) => <React.Fragment key={index}>{markOrphans(child, orphans)}</React.Fragment>)
  if (React.isValidElement(node) && node.props.children !== undefined) return React.cloneElement(node, {}, markOrphans(node.props.children, orphans))
  return node
}
const errorCopy = error => ({ research_changed: 'The draft changed. Refresh and review the new output.', preview_stale: 'The vault changed. Prepare a new preview.', unknown_domain: 'This creates a new vault domain. Confirm it before continuing.', orphan_citations: 'Remove or support the highlighted citations.', save_outcome_unknown: 'The save outcome is unknown. Check the vault before trying again.' })[error?.code] ?? error?.message ?? String(error)

export function ResearchReview ({ research, error, busy = false, navigate, onRefresh, onStop, onEdit, onPreview, onSave }) {
  const [editing, setEditing] = useState(false)
  const [editor, setEditor] = useState('')
  useEffect(() => { if (!editing) setEditor(research?.rawBody ?? research?.body ?? '') }, [research?.revision, editing])
  if (!research) return error ? <section><h1>Research</h1><p role="alert">{titleText(errorCopy(error))}</p><button onClick={onRefresh}>Retry</button></section> : <p aria-busy="true">Loading research…</p>
  const { request = {}, draft, body, state, leadSessionId, save, excludedSources = [], orphans = [] } = research
  const readOnly = state === 'saved' || save?.state === 'unknown'
  const edit = change => Promise.resolve(onEdit?.({ revision: research.revision, body: research.rawBody ?? body, excludedSources, ...change })).catch(() => {})
  return <section className="research-review" aria-label="Research review"><h1>{titleText(draft?.title ?? request.topic ?? 'Research')}</h1><p role="status">{state === 'saved' ? 'Saved to vault' : state === 'drafted' ? 'Draft · not saved' : state === 'running' ? 'Scouting' : 'Research was interrupted. Any draft files are kept.'}</p>
    {error && <p role="alert">{titleText(errorCopy(error))}</p>}
    {leadSessionId && <a href={`/s/${encodeURIComponent(leadSessionId)}`} onClick={navigate ? linkHandler(navigate, `/s/${encodeURIComponent(leadSessionId)}`) : undefined}>Open research session</a>}
    {state === 'running' && <button onClick={onStop}>Stop research</button>}
    <button onClick={onRefresh}>Refresh research</button>
    {draft && <>
      {research.reviewConflict && <p role="alert">The team changed its output. Your earlier edits are kept; reset to review the new draft. <button onClick={() => edit({ reset: true })}>Reset review</button></p>}
      {editing ? <><label>Draft markdown<textarea rows={18} maxLength={200000} value={editor} onChange={event => setEditor(event.target.value)} /></label><button disabled={busy} onClick={() => Promise.resolve(onEdit?.({ revision: research.revision, body: editor, excludedSources })).then(() => setEditing(false), () => {})}>Done editing</button><button onClick={() => setEditing(false)}>Cancel editing</button></> : <><div className="research-body">{markOrphans(renderMarkdown(body), orphans)}</div>{!readOnly && <button disabled={busy || research.reviewConflict} onClick={() => setEditing(true)}>Edit first</button>}</>}
      {!!orphans.length && <p role="alert">{orphans.length} unsupported citation{orphans.length === 1 ? '' : 's'} highlighted. Remove the claim or restore its source.</p>}
      <h2>Sources</h2><ol>{draft.sources.map(source => <li key={source.n} value={source.n}>
        {!readOnly && <label><input type="checkbox" aria-label={`Keep source ${source.n}`} checked={!excludedSources.includes(source.n)} disabled={busy || editing || research.reviewConflict} onChange={event => edit({ excludedSources: event.target.checked ? excludedSources.filter(n => n !== source.n) : [...excludedSources, source.n] })} />Keep</label>}
        <a href={source.url} target="_blank" rel="noopener noreferrer">{titleText(source.title)}</a><p>Why: {titleText(source.why)}</p><ul aria-label="Backs">{source.backs.map((claim, index) => <li key={index}>{titleText(claim)}</li>)}</ul></li>)}</ol>
      {!!draft.rejected.length && <><h2>Rejected sources</h2><ul>{draft.rejected.map((source, index) => <li key={index}>{titleText(source.title)}: {titleText(source.reason)}</li>)}</ul></>}
      {save?.preview && <section aria-label="Save preview"><h2>Preview changes</h2><p>{save.preview.action === 'created' ? 'Creates a new linked note' : 'Adds to an existing note'}: <bdi>{titleText(save.preview.path)}</bdi></p>{save.preview.files.map(file => <details key={file.path}><summary>{titleText(file.path)}</summary><pre>{titleText(file.diff)}</pre></details>)}</section>}
      {state === 'saved' ? <><p><bdi>{titleText(save.saved.path)}</bdi></p>{!save.saved.committed && <p role="alert">The note was written, but its commit needs attention. {titleText(save.saved.warning ?? '')}</p>}</> : <><p id="research-save-reason">{save?.reason ?? 'A current verified preview is required before saving.'}</p>
        <button disabled={busy || editing || !save?.canPreview || !!orphans.length || research.reviewConflict} onClick={() => Promise.resolve(onPreview?.(false)).catch(() => {})}>Prepare preview</button>
        {error?.code === 'unknown_domain' && <button disabled={busy} onClick={() => Promise.resolve(onPreview?.(true)).catch(() => {})}>Confirm new domain</button>}
        <button disabled={busy || editing || !save?.available} aria-describedby="research-save-reason" onClick={() => Promise.resolve(onSave?.(save.preview.id)).catch(() => {})}>Save to vault</button></>}
    </>}
  </section>
}

export function Research ({ state, route, search, api, navigate }) {
  const id = route?.params?.id ?? route?.id
  const [research, setResearch] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [domains, setDomains] = useState([])
  const [tick, refresh] = useState(0)
  useEffect(() => {
    let active = true
    if (!id) { api.get('/api/vault/list').then(result => { if (active) setDomains([...new Set(result.notes.map(note => note.path.startsWith('02-wiki/') ? note.path.split('/')[1] : null).filter(Boolean))].sort()) }, () => {}); return () => { active = false } }
    const load = () => api.get(`/api/research/${encodeURIComponent(id)}`).then(result => { if (active) { setResearch(result.research) } }, err => { if (active) setError(err) })
    load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [id, api, tick])
  const act = promise => { setBusy(true); setError(null); return promise.then(result => { setResearch(result.research); return result }, error => { setError(error); throw error }).finally(() => setBusy(false)) }
  if (id) return <ResearchReview research={research} error={error} busy={busy} navigate={navigate} onEdit={body => act(api.patch(`/api/research/${encodeURIComponent(id)}`, body))} onPreview={confirmNewDomain => act(api.post(`/api/research/${encodeURIComponent(id)}/preview`, { confirmNewDomain }))} onSave={previewId => act(api.post(`/api/research/${encodeURIComponent(id)}/save`, { previewId }))} onRefresh={() => refresh(old => old + 1)} onStop={() => api.post(`/api/research/${encodeURIComponent(id)}/stop`).then(() => refresh(old => old + 1), setError)} />
  return <ResearchForm api={api} repos={state.data.repos} domains={domains} initialTopic={new URLSearchParams(search).get('topic') ?? ''} down={!(state.data.health ?? []).some(dep => dep.dep === 'vault-mcp' && ['ok', 'degraded'].includes(dep.state))} busy={busy} error={error} onSubmit={body => {
    setBusy(true); setError(null)
    api.post('/api/research', { ...body, ...(new URLSearchParams(search).get('miss') ? { missId: new URLSearchParams(search).get('miss') } : {}) }).then(result => navigate(`/research/${encodeURIComponent(result.research.id)}`), setError).finally(() => setBusy(false))
  }} />
}

export function ResearchCards ({ items = [], navigate }) {
  if (!items.length) return null
  return <section className="research-cards" aria-label="Research"><h2>Research</h2>{items.map(item => <article key={item.id}><h3>{titleText(item.request?.topic ?? item.id)}</h3><p>{item.state === 'drafted' ? 'Draft ready for review' : item.state === 'running' ? 'Scouting' : 'Research needs attention'}</p><a href={`/research/${encodeURIComponent(item.id)}`} onClick={navigate ? linkHandler(navigate, `/research/${encodeURIComponent(item.id)}`) : undefined}>{item.state === 'drafted' ? 'Review draft' : 'Open research'}</a></article>)}</section>
}

export function ResearchHome ({ items = [], api, navigate }) {
  const [rows, setRows] = useState(items)
  useEffect(() => {
    let active = true
    const load = () => api.get('/api/research').then(result => { if (active) setRows(result.research ?? []) }, () => {})
    load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, 10000)
    return () => { active = false; clearInterval(timer) }
  }, [api])
  return <ResearchCards items={rows} navigate={navigate} />
}
