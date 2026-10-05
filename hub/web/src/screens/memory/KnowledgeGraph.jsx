import React, { useMemo, useRef, useState } from 'react'
import { titleText } from '../../components/StatusPill.jsx'
import { noteHref } from '../../components/NoteChip.jsx'
import { fingerprint, labelled, layoutClusters, layoutLocal, nearestInDirection } from './graph-layout.js'

export function KnowledgeGraph({ graph, selectedPath, cited = [], fresh = [], navigate = () => {}, width = 900, height = 600 }) {
  const layout = useMemo(() => {
    const key = `deck.graph.${fingerprint(graph)}.${selectedPath ?? ''}.${width}.${height}`
    try { const cached = JSON.parse(sessionStorage.getItem(key)); if (cached) return cached } catch {}
    const result = selectedPath ? layoutLocal(graph, selectedPath, { width, height }) : layoutClusters(graph, { width, height })
    try { sessionStorage.setItem(key, JSON.stringify(result)) } catch {}
    return result
  }, [graph, selectedPath, width, height])
  const first = selectedPath ?? layout.nodes.find(node => node.kind === 'index')?.path ?? layout.nodes[0]?.path
  const [focus, setFocus] = useState(first), [hover, setHover] = useState(null), [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef(null), refs = useRef(new Map())
  const byPath = new Map(layout.nodes.map(node => [node.path, node]))
  const activeFocus = byPath.has(focus) ? focus : first
  const changeZoom = delta => setZoom(value => Math.max(0.3, Math.min(4, value + delta)))
  return <section className="knowledge-graph" aria-label="Knowledge graph">
    <a className="sr-only" href="/memory?view=browse">A list view of the same notes is in Browse by MOC</a>
    <div className="graph-tools"><button aria-label="Zoom in" onClick={() => changeZoom(.2)}>+</button><button aria-label="Zoom out" onClick={() => changeZoom(-.2)}>−</button><button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>Fit</button></div>
    <svg viewBox={`0 0 ${width} ${height}`} aria-label="Notes and their links" onWheel={event => { event.preventDefault(); changeZoom(event.deltaY < 0 ? .1 : -.1) }}
      onPointerDown={event => { if (event.target === event.currentTarget) { drag.current = { x: event.clientX, y: event.clientY, pan }; event.currentTarget.setPointerCapture(event.pointerId) } }}
      onPointerMove={event => { if (drag.current) { const bounds = event.currentTarget.getBoundingClientRect(); setPan({ x: drag.current.pan.x + (event.clientX - drag.current.x) * width / bounds.width, y: drag.current.pan.y + (event.clientY - drag.current.y) * height / bounds.height }) } }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <g transform={`translate(${pan.x} ${pan.y}) translate(${width / 2} ${height / 2}) scale(${zoom}) translate(${-width / 2} ${-height / 2})`}>
        {layout.edges.map((edge, i) => { const a = byPath.get(edge.source ?? edge.from), b = byPath.get(edge.target ?? edge.to); return a && b ? <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={a.path === hover || b.path === hover || a.path === activeFocus || b.path === activeFocus ? 'graph-edge graph-edge--active' : 'graph-edge'} /> : null })}
        {layout.clusters.map(cluster => <text key={cluster.name} className="graph-cluster" x={cluster.x} y={cluster.y - 75}>{titleText(cluster.name)}</text>)}
        {layout.nodes.map(node => <g key={node.path} ref={element => { if (element) refs.current.set(node.path, element); else refs.current.delete(node.path) }} role="button" tabIndex={node.path === activeFocus ? 0 : -1}
          aria-label={titleText(node.title ?? node.path)} data-domain={node.cluster} className={`graph-node graph-node--${node.kind}${cited.includes(node.path) ? ' graph-node--cited' : ''}${fresh.includes(node.path) ? ' motion-arrive' : ''}`}
          transform={`translate(${node.x} ${node.y})`} onFocus={() => setFocus(node.path)} onMouseEnter={() => setHover(node.path)} onMouseLeave={() => setHover(null)} onClick={() => navigate(noteHref(node.path))}
          onKeyDown={event => { if (event.key === 'Enter') navigate(noteHref(node.path)); else if (event.key === '+' || event.key === '-') changeZoom(event.key === '+' ? .2 : -.2); else if (event.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }) } else { const next = nearestInDirection(layout.nodes, node, event.key); if (next) { event.preventDefault(); setFocus(next.path); refs.current.get(next.path)?.focus() } } }}>
          <circle r={node.kind === 'index' ? 10 : node.kind === 'moc' ? 7 : 4} />
          {labelled(node, { total: layout.nodes.length, cited: cited.includes(node.path), fresh: fresh.includes(node.path), active: node.path === hover || node.path === activeFocus }) ? <text x="10" y="4">{titleText(node.title ?? node.path.split('/').at(-1))}</text> : null}
        </g>)}
      </g>
    </svg>
    <p className="setting-hint">Select a note to explore its links. Arrow keys move between notes.</p>
    {graph.truncated ? <p>Showing {graph.nodes.length} of {graph.counts?.notes ?? graph.nodes.length} notes</p> : null}
  </section>
}
