import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as actions from '../../state/actions.js'
import { memoryQuery, noteLine } from '../../state/deck-store.js'
import { titleText } from '../../components/StatusPill.jsx'
import { KnowledgeGraph } from './KnowledgeGraph.jsx'
import { NotePanel } from './NotePanel.jsx'
import { AskPanel } from './AskPanel.jsx'
import { BrowseView, CapturesView, MissesView } from './MemoryLists.jsx'

const views = ['graph', 'browse', 'captures', 'misses']
const localDay = now => { const date = new Date(now); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export function MemoryView({ graph, notes = [], captures = [], misses = [], note, noteError, route = {}, view = 'graph', day, onDay,
  loading = false, error, vault = {}, memory = {}, navigate = () => {}, filters = {}, onFilters, age = 'all', onAge, onRetry, onSend, onStop, onOpen, onThread, onDelete, onResolve, api, prefill, onPrefill, newThread = false }) {
  const down = ['down', 'unknown'].includes(vault.state), noTool = error?.code === 'vault_tool_missing'
  const threadId = memory.activeThreadId
  const messages = memory.messages?.[threadId] ?? []
  const activeCitations = messages.flatMap(message => message.citations ?? []).map(citation => citation.path)
  const title = route.path?.split('/').at(-1).replace(/\.md$/, '')
  const changeView = next => navigate(`/memory?view=${next}${threadId ? `&thread=${encodeURIComponent(threadId)}` : ''}`)
  const crumb = route.path ? `Local graph · ${title} · 2 hops` : `Clustered by domain · ${graph?.counts?.notes ?? graph?.nodes.length ?? 0} notes · ${graph?.counts?.edges ?? graph?.edges.length ?? 0} links`
  return <main className="memory-screen">
    <header className="page-header"><h1>Memory</h1><a href="/research/new">Research a topic</a></header>
    <nav role="tablist" aria-label="Memory views">{views.map((name, index) => <button key={name} role="tab" aria-selected={view === name} tabIndex={view === name ? 0 : -1} onClick={() => changeView(name)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); changeView(views[(index + (event.key === 'ArrowRight' ? 1 : 3)) % 4]) } }}>
      {name === 'graph' ? 'Graph' : name === 'browse' ? 'Browse by MOC' : name === 'captures' ? `Captures ${captures.length} today` : `Misses ${misses.filter(miss => !miss.resolvedBy).length}`}
    </button>)}</nav>
    <p className="memory-crumb">{crumb}</p>
    <div className="memory-filters"><button aria-pressed={!!route.path} onClick={() => navigate('/memory')}>Whole map</button>
      <label>Tags<input value={filters.tags?.join(', ') ?? ''} onChange={event => onFilters?.({ ...filters, tags: event.target.value.split(',').map(tag => tag.trim()).filter(Boolean) })} /></label>
      <label>Status<select value={filters.status ?? ''} onChange={event => onFilters?.({ ...filters, status: event.target.value || undefined })}><option value="">All</option><option value="ativo">Active</option><option value="rascunho">Draft</option><option value="concluido">Complete</option></select></label>
      <label>Age<select value={age} onChange={event => onAge?.(event.target.value)}><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label>
      <details className="memory-legend"><summary>Legend</summary><span>Index · MOC · Note · Cited · New</span></details>
    </div>
    {down ? <section className="fail-card" aria-label="Memory tab"><h2>The charts are out of reach</h2><p>vault-mcp did not answer on stdio (<bdi>{titleText(vault.reason ?? error?.message ?? 'Unavailable')}</bdi>). Sessions and meetings still work.</p><code>VAULT_PATH={titleText(vault.path ?? '')}</code><a href="/settings/connections#vault">Fix in Settings</a><button onClick={onRetry}>Retry</button></section> : <div className="memory-workspace">
      <section className="memory-main" aria-label="Memory content">
        {view === 'graph' ? loading ? <p aria-busy="true">Loading the graph</p> : noTool ? <p>This vault-mcp version does not provide a graph. <a href="/memory?view=browse">Browse by MOC</a></p> : error ? <p role="alert">{titleText(error.details?.text ?? error.message)}</p> : graph?.nodes.length ? <KnowledgeGraph graph={graph} selectedPath={route.path} cited={activeCitations} fresh={captures.filter(capture => !capture.opened).map(capture => capture.path)} navigate={navigate} /> : <p>No notes yet. Captures and research land here.</p> : null}
        {view === 'browse' ? <BrowseView notes={notes} navigate={navigate} /> : null}
        {view === 'captures' ? <CapturesView captures={captures} day={day} onDay={onDay} navigate={navigate} /> : null}
        {view === 'misses' ? <MissesView misses={misses} navigate={navigate} onResolve={onResolve} api={api} /> : null}
      </section>
      {route.path ? <NotePanel result={note} line={route.line} loading={!note && !noteError} error={noteError} navigate={navigate} onOpen={onOpen} onAsk={onPrefill} /> :
        <AskPanel thread={memory.threads?.[threadId]} threads={Object.values(memory.threads ?? {})} misses={misses} messages={messages} asking={!!memory.asking?.[threadId]} navigate={navigate} prefill={prefill} focusComposer={newThread} onSend={onSend} onStop={onStop} onThread={onThread} onDelete={onDelete} />}
    </div>}
  </main>
}
export function Memory({ state, route: matchedRoute = {}, search = '', api, dispatch = () => {}, navigate = () => {}, now = Date.now }) {
  const parameters = matchedRoute.params ?? matchedRoute
  const route = { ...parameters, line: parameters.line ?? noteLine(globalThis.location?.hash) }
  const query = memoryQuery(search), view = query.view
  const [graph, setGraph] = useState(null), [notes, setNotes] = useState([]), [captures, setCaptures] = useState([]), [misses, setMisses] = useState([])
  const [note, setNote] = useState(null), [noteError, setNoteError] = useState(null), [error, setError] = useState(null), [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({}), [age, setAge] = useState('all'), [day, setDay] = useState(localDay(typeof now === 'function' ? now() : now))
  const prefill = state.memory?.prefill ?? ''
  const vault = state.memory?.vault ?? { state: 'unknown' }, memory = state.memory ?? {}
  const wasDown = useRef(vault.state === 'down')
  const [recovered, setRecovered] = useState(false)
  useEffect(() => {
    if (vault.state === 'down') wasDown.current = true
    else if (['ok', 'degraded'].includes(vault.state) && wasDown.current) {
      wasDown.current = false; setRecovered(true)
      const timer = setTimeout(() => setRecovered(false), 5000)
      return () => clearTimeout(timer)
    }
  }, [vault.state])
  const refresh = useCallback(async () => {
    if (!api || ['down', 'unknown'].includes(vault.state)) { setLoading(false); return }
    const results = await Promise.allSettled([actions.fetchGraph(api, filters), actions.fetchVaultList(api, filters), actions.fetchCaptures(api, day), actions.fetchMisses(api), actions.fetchThreads(api)])
    if (results[0].status === 'fulfilled') { setGraph(results[0].value); setError(null) } else setError(results[0].reason)
    if (results[1].status === 'fulfilled') setNotes(results[1].value.notes)
    if (results[2].status === 'fulfilled') setCaptures(results[2].value.captures)
    if (results[3].status === 'fulfilled') { setMisses(results[3].value.misses); dispatch({ type: 'memory.missesFetched', unresolved: results[3].value.unresolved }) }
    if (results[4].status === 'fulfilled') dispatch({ type: 'memory.threadsListed', threads: results[4].value.threads })
    setLoading(false)
  }, [api, filters, day, vault.state, dispatch])
  useEffect(() => { let active = true; if (active) void refresh(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 60000); return () => { active = false; clearInterval(timer) } }, [refresh])
  useEffect(() => { if (!query.thread || query.thread === 'new') { dispatch({ type: 'memory.activeThread', id: null }); return }
    dispatch({ type: 'memory.activeThread', id: query.thread })
    let active = true; actions.fetchThread(api, query.thread).then(result => { if (active) dispatch({ type: 'memory.threadLoaded', ...result }) }, setError); return () => { active = false }
  }, [api, query.thread, dispatch])
  useEffect(() => { setNote(null); setNoteError(null); if (!route.path || !api) return
    let active = true; actions.fetchNote(api, route.path).then(result => { if (active) setNote(result) }, error => { if (active) setNoteError(error) }); return () => { active = false }
  }, [api, route.path])
  useEffect(() => { if (!api) return; let active = true
    actions.fetchMisses(api).then(result => { if (active) setMisses(result.misses) }, () => {})
    return () => { active = false }
  }, [api, memory.missesUnresolved])
  useEffect(() => { const handler = event => { if (event.key === 'Escape' && route.path) navigate('/memory') }; document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler) }, [route.path, navigate])
  const handle = work => Promise.resolve(work).catch(setError)
  const filteredGraph = age === 'all' || !graph ? graph : { ...graph, nodes: graph.nodes.filter(node => node.mtime_ms >= Date.now() - Number(age) * 86400000) }
  return <><p className="sr-only" role="status" aria-live="polite">{recovered ? 'Memory is back' : ''}</p><MemoryView graph={filteredGraph} notes={notes} captures={captures} misses={misses} note={note} noteError={noteError} route={route} view={view} day={day} onDay={setDay} error={error} loading={loading}
    vault={{ ...vault, path: state.data.prefs.vaultPath }} memory={memory} api={api} navigate={navigate} filters={filters} onFilters={setFilters} age={age} onAge={setAge} prefill={prefill} newThread={query.thread === 'new'}
    onRetry={() => handle(api.post('/api/deps/vault-mcp/retry'))} onSend={text => handle(actions.askVault(api, { ...(memory.activeThreadId ? { threadId: memory.activeThreadId } : {}), text }).then(result => { dispatch({ type: 'memory.askStarted', ...result }); dispatch({ type: 'memory.prefill', text: '' }); navigate(`/memory?thread=${encodeURIComponent(result.thread.id)}`) }))}
    onStop={() => handle(actions.cancelAsk(api, memory.asking[memory.activeThreadId]))} onThread={id => { dispatch({ type: 'memory.prefill', text: '' }); navigate(`/memory?thread=${encodeURIComponent(id)}`) }}
    onDelete={id => handle(actions.deleteThread(api, id).then(() => dispatch({ type: 'memory.threadDeleted', id })))} onResolve={(id, resolvedBy) => handle(actions.resolveMiss(api, id, resolvedBy).then(refresh))}
    onOpen={() => handle(actions.openVaultNote(api, route.path))} onPrefill={text => { dispatch({ type: 'memory.prefill', text }); navigate('/memory?thread=new') }} /></>
}
