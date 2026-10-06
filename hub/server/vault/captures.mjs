import { capturesOn, learnCallsSince, upsertCapture } from '../ask/store.mjs'
import { domainOf } from '../adapters/vault-text.mjs'

/**
 * Refresh one local day's captures through MCP, with at most 50 candidate note reads.
 * @param {{ service: object, store: object, day: string, now?: () => number }} options
 * @returns {Promise<object[]>} captures enriched with their current titles and domains
 */
export async function refreshCaptures ({ service, store, day, now = Date.now }) {
  const [year, month, date] = day.split('-').map(Number)
  const start = new Date(year, month - 1, date).getTime()
  const end = new Date(year, month - 1, date + 1).getTime()
  const dailyPath = `04-daily/${day}.md`
  let daily = null
  try { daily = await service.readNote(dailyPath) } catch (error) {
    if (error.code !== 'vault_error' || !/note not found:/i.test(error.details?.text ?? '')) throw error
  }
  const notes = await service.list()
  const refs = new Map(notes.map(note => [note.path, note]))
  let candidates
  try {
    const graph = await service.graph()
    candidates = graph.nodes.filter(node => node.mtime_ms >= start && node.mtime_ms < end).map(node => node.id)
  } catch (error) {
    if (error.code !== 'vault_tool_missing') throw error
    candidates = daily?.links ?? []
  }
  for (const path of [...new Set(candidates)].slice(0, 50)) {
    const note = path === dailyPath && daily ? daily : await service.readNote(path)
    if (String(note.frontmatter?.criado) === day) upsertCapture(store, { path, day, capturedAt: now(), via: 'frontmatter', sessionId: null, repoId: null })
  }
  const lines = []
  let inCaptures = false
  for (const line of (daily?.body ?? '').split('\n')) {
    if (/^##\s/.test(line)) { inCaptures = /^## Capturas\s*$/.test(line); continue }
    if (!inCaptures) continue
    const match = /^- (\d{2}):(\d{2}) \[\[([^\]]+)\]\] \([^)]+\)/.exec(line)
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) continue
    const slug = match[3].split('|')[0].split('#')[0].split('/').pop().replace(/\.md$/, '')
    lines.push({ slug, at: new Date(year, month - 1, date, Number(match[1]), Number(match[2])).getTime() })
  }
  for (const call of learnCallsSince(store, start).filter(call => call.at < end)) {
    const line = lines.find(line => line.slug === call.slug && line.at >= call.at && line.at - call.at <= 120000)
    const matches = notes.filter(note => note.path.split('/').pop().replace(/\.md$/, '') === call.slug)
    if (line && matches.length === 1) upsertCapture(store, { path: matches[0].path, day, capturedAt: line.at, via: 'vault_learn', sessionId: call.sessionId, repoId: call.repoId })
  }
  return capturesOn(store, day).map(capture => ({ ...capture, title: refs.get(capture.path)?.title ?? capture.path, domain: domainOf(capture.path) }))
}
