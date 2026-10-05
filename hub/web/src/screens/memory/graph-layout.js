/** Default graph clusters; capture and archive folders remain available in Browse. */
export function clusterOf(node) {
  const path = node.path ?? node.id
  const parts = path.split('/')
  if (path === '00-index/index-knowledge.md') return 'index'
  if (parts[0] === '02-wiki') return parts[1]
  if (parts[0] === '03-projects') return 'projects'
  return null
}
export const kindOf = node => clusterOf(node) === 'index' ? 'index' : (node.path ?? node.id).endsWith('-moc.md') ? 'moc' : 'note'
const ends = edge => [edge.from ?? edge.source, edge.to ?? edge.target]
const degreeMap = graph => {
  const map = new Map()
  for (const edge of graph.edges) for (const path of ends(edge)) map.set(path, (map.get(path) ?? 0) + 1)
  return map
}
/** Deterministic phyllotaxis around alphabetically ordered domain centres. */
export function layoutClusters(graph, { width = 900, height = 600 } = {}) {
  const degree = degreeMap(graph)
  const groups = new Map()
  for (const original of graph.nodes) {
    const node = { ...original, path: original.path ?? original.id }
    const cluster = clusterOf(node)
    if (cluster === null) continue
    if (!groups.has(cluster)) groups.set(cluster, [])
    groups.get(cluster).push(node)
  }
  const names = [...groups.keys()].filter(name => name !== 'index').sort()
  const radius = Math.min(width, height) * 0.30
  const centres = names.map((name, i) => ({ name, x: width / 2 + radius * Math.cos(i * 2 * Math.PI / names.length - Math.PI / 2), y: height / 2 + radius * Math.sin(i * 2 * Math.PI / names.length - Math.PI / 2) }))
  const positioned = []
  for (const [name, nodes] of groups) {
    const centre = name === 'index' ? { x: width / 2, y: height / 2 } : centres.find(centre => centre.name === name)
    nodes.sort((a, b) => (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) || a.path.localeCompare(b.path))
    nodes.forEach((node, i) => {
      const distance = name === 'index' ? 0 : 12 * Math.sqrt(i)
      const angle = i * Math.PI * (3 - Math.sqrt(5))
      positioned.push({ ...node, cluster: name, kind: kindOf(node), x: centre.x + distance * Math.cos(angle), y: centre.y + distance * Math.sin(angle) })
    })
  }
  return { nodes: positioned, clusters: centres, edges: graph.edges }
}
/** Two-hop neighbourhood, traversing backlinks as well as outgoing links. */
export function layoutLocal(graph, path, { hops = 2, width = 900, height = 600 } = {}) {
  graph = { ...graph, nodes: graph.nodes.map(node => ({ ...node, path: node.path ?? node.id })) }
  const neighbours = new Map(graph.nodes.map(node => [node.path, []]))
  for (const edge of graph.edges) { const [a, b] = ends(edge); neighbours.get(a)?.push(b); neighbours.get(b)?.push(a) }
  const distance = new Map([[path, 0]])
  const queue = [path]
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i], hop = distance.get(current)
    if (hop >= hops) continue
    for (const next of neighbours.get(current) ?? []) if (!distance.has(next) && neighbours.has(next)) { distance.set(next, hop + 1); queue.push(next) }
  }
  const nodes = []
  for (let hop = 0; hop <= hops; hop++) {
    const ring = graph.nodes.filter(node => distance.get(node.path) === hop).sort((a, b) => a.path.localeCompare(b.path))
    ring.forEach((node, i) => nodes.push({ ...node, kind: kindOf(node), cluster: clusterOf(node), hop,
      x: width / 2 + hop * 95 * Math.cos(i * 2 * Math.PI / ring.length), y: height / 2 + hop * 95 * Math.sin(i * 2 * Math.PI / ring.length) }))
  }
  return { nodes, clusters: [], edges: graph.edges.filter(edge => ends(edge).every(path => distance.has(path))) }
}
export function labelled(node, { total, cited = false, fresh = false, active = false }) {
  return kindOf(node) !== 'note' || cited || (total <= 300 && (fresh || active))
}
export function nearestInDirection(nodes, from, key) {
  const vector = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key]
  if (!vector) return null
  return nodes.filter(node => node.path !== from.path && (node.x - from.x) * vector[0] + (node.y - from.y) * vector[1] > 0)
    .sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y) || a.path.localeCompare(b.path))[0] ?? null
}
export function fingerprint(graph) {
  let hash = 2166136261
  const text = JSON.stringify([graph.nodes.map(node => node.path ?? node.id).sort(), graph.edges.map(ends).sort()])
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16)
}
