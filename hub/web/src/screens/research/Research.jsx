import React, { useEffect, useState } from 'react'
import { titleText } from '../../components/StatusPill.jsx'
import { renderMarkdown } from '../team-run/PlanDrawer.jsx'
import { linkHandler } from '../../shell/Rail.jsx'

export function ResearchForm ({ repos = [], initialTopic = '', domains = [], down = false, busy = false, error, onSubmit }) {
  const [topic, setTopic] = useState(initialTopic)
  const [repoKey, setRepo] = useState(repos[0]?.name ?? '')
  const [domain, setDomain] = useState(domains[0] ?? '')
  const [preset, setPreset] = useState('standard')
  const [sourceTypes, setSources] = useState(['docs', 'repo'])
  const [focusNotes, setFocus] = useState('')
  useEffect(() => { setDomain(old => old || domains[0] || '') }, [domains.join(',')])
  return <section className="research-form" aria-label="Research a topic"><h1>Send out scouts</h1><p>A fleetmates team researches; you review the draft before anything is saved.</p>
    <form onSubmit={event => { event.preventDefault(); onSubmit?.({ topic, repoKey, domain, preset, sourceTypes, focusNotes }) }}>
      <label>Topic<input autoFocus value={topic} onChange={event => setTopic(event.target.value)} required minLength={3} maxLength={500} /></label>
      <label>Repository<select value={repoKey} onChange={event => setRepo(event.target.value)} required><option value="">Choose a repository</option>{repos.filter(repo => !repo.archivedAt).map(repo => <option key={repo.id} value={repo.name}>{titleText(repo.name)}</option>)}</select></label>
      <label>Target domain<input list="research-domains" value={domain} onChange={event => setDomain(event.target.value)} required maxLength={100} /></label>
      <datalist id="research-domains">{domains.map(name => <option key={name} value={name} />)}</datalist>
      <fieldset><legend>Depth</legend>{['quick', 'standard', 'deep'].map(name => <label key={name}><input type="radio" name="research-preset" checked={preset === name} onChange={() => setPreset(name)} />{name[0].toUpperCase() + name.slice(1)} · {name === 'quick' ? '1 scout' : name === 'standard' ? '3 scouts' : '5 scouts and verification'}</label>)}</fieldset>
      <fieldset><legend>Source types</legend>{['docs', 'repo', 'blog', 'paper'].map(type => <label key={type}><input type="checkbox" checked={sourceTypes.includes(type)} onChange={event => setSources(old => event.target.checked ? [...old, type] : old.filter(item => item !== type))} />{({ docs: 'Official docs', repo: 'Repos', blog: 'Blogs', paper: 'Papers' })[type]}</label>)}</fieldset>
      <label>Focus notes (optional)<textarea rows={3} maxLength={3000} value={focusNotes} onChange={event => setFocus(event.target.value)} /></label>
      {down && <p>Could not check your vault for existing notes. Research can proceed; saving will wait.</p>}
      {error && <p role="alert">{titleText(error.message ?? error.code ?? String(error))}</p>}
      <button type="submit" disabled={busy || !sourceTypes.length || !repoKey}>{busy ? 'Launching…' : 'Send scouts'}</button>
    </form></section>
}

export function ResearchReview ({ research, error, navigate, onRefresh, onStop }) {
  if (error) return <section><h1>Research</h1><p role="alert">{titleText(error.message ?? String(error))}</p><button onClick={onRefresh}>Retry</button></section>
  if (!research) return <p aria-busy="true">Loading research…</p>
  const { request = {}, draft, body, state, leadSessionId, save } = research
  return <section className="research-review" aria-label="Research review"><h1>{titleText(draft?.title ?? request.topic ?? 'Research')}</h1><p role="status">{state === 'drafted' ? 'Draft · not saved' : state === 'running' ? 'Scouting' : 'Research was interrupted. Any draft files are kept.'}</p>
    {leadSessionId && <a href={`/s/${encodeURIComponent(leadSessionId)}`} onClick={navigate ? linkHandler(navigate, `/s/${encodeURIComponent(leadSessionId)}`) : undefined}>Open research session</a>}
    {state === 'running' && <button onClick={onStop}>Stop research</button>}
    <button onClick={onRefresh}>Refresh research</button>
    {draft && <><div className="research-body">{renderMarkdown(body)}</div><h2>Sources</h2><ol>{draft.sources.map(source => <li key={source.n} value={source.n}><a href={source.url} target="_blank" rel="noopener noreferrer">{titleText(source.title)}</a><p>Why: {titleText(source.why)}</p><ul aria-label="Backs">{source.backs.map((claim, index) => <li key={index}>{titleText(claim)}</li>)}</ul></li>)}</ol>
      {!!draft.rejected.length && <><h2>Rejected sources</h2><ul>{draft.rejected.map((source, index) => <li key={index}>{titleText(source.title)}: {titleText(source.reason)}</li>)}</ul></>}
      <p id="research-save-reason">{save?.reason ?? 'A current verified preview is required before saving.'}</p><button disabled aria-describedby="research-save-reason">Save to vault</button></>}
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
    const load = () => api.get(`/api/research/${encodeURIComponent(id)}`).then(result => { if (active) { setResearch(result.research); setError(null) } }, err => { if (active) setError(err) })
    load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [id, api, tick])
  if (id) return <ResearchReview research={research} error={error} navigate={navigate} onRefresh={() => refresh(old => old + 1)} onStop={() => api.post(`/api/research/${encodeURIComponent(id)}/stop`).then(() => refresh(old => old + 1), setError)} />
  return <ResearchForm repos={state.data.repos} domains={domains} initialTopic={new URLSearchParams(search).get('topic') ?? ''} down={!(state.data.health ?? []).some(dep => dep.dep === 'vault-mcp' && ['ok', 'degraded'].includes(dep.state))} busy={busy} error={error} onSubmit={body => {
    setBusy(true); setError(null)
    api.post('/api/research', body).then(result => navigate(`/research/${encodeURIComponent(result.research.id)}`), setError).finally(() => setBusy(false))
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
