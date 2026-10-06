import { domainOf, parseBacklinks, parseList, parseNote, parseSearch } from '../adapters/vault-text.mjs'
import { MAX_BOUND_CHARS, noteLineBound } from '../ask/answer.mjs'
import { markOpened, noteUsage, sessionMemory as storedMemory } from '../ask/store.mjs'

/** A vault operation failure, carrying the HTTP contract's code and details. */
export class VaultServiceError extends Error {
  /** @param {string} code @param {object} details */
  constructor (code, details = {}) {
    super(code)
    this.code = code
    this.details = details
  }
}

/** The local day and midnight used for captures and note usage. @param {number} at */
export function localDate (at) {
  const date = new Date(at)
  const pad = n => String(n).padStart(2, '0')
  return { day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, midnight: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() }
}

/**
 * Read-only vault access through MCP; no vault file is opened by the deck.
 * @param {{ client: object, store: object, now?: () => number, log?: Function }} options
 * @returns {object} graph, list, readNote, note, search, lineBound, knownPaths and sessionMemory
 */
export function createVaultService ({ client, store, now = Date.now, log = () => {} }) {
  const lists = new Map()
  const bounds = new Map()
  let graphPaths = new Set()
  const fresh = entry => entry && now() - entry.at < 60000
  const ref = note => ({ ...note, domain: domainOf(note.path) })
  async function call (tool, args = {}, timeoutMs = 10000) {
    let result
    try { result = await client.call(tool, args, { timeoutMs }) } catch {
      log({ event: 'vault.unavailable', tool })
      throw new VaultServiceError('vault_unavailable', { tool })
    }
    if (result.isError) throw new VaultServiceError('vault_error', { tool, text: result.text })
    return result
  }
  const malformed = tool => new VaultServiceError('vault_error', { tool, text: 'Invalid vault response' })
  async function list (filters = {}) {
    const args = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null))
    const key = JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))
    if (fresh(lists.get(key))) return lists.get(key).notes.map(note => ({ ...note, tags: [...note.tags] }))
    const result = await call('vault_list', args)
    const notes = (result.structured?.notes ?? parseList(result.text).notes).map(ref)
    lists.set(key, { at: now(), notes })
    return notes.map(note => ({ ...note, tags: [...note.tags] }))
  }
  async function readNote (path, offset = 0) {
    const result = await call('vault_get_note', { path, ...(offset ? { offset } : {}) })
    const note = result.structured?.note ?? parseNote(result.text)
    if (!note) throw malformed('vault_get_note')
    return note
  }
  async function search (q, limit = 5) {
    const result = await call('vault_search', { query: q, limit: Math.max(1, Math.min(20, limit)) })
    const notes = await list()
    const titles = new Map(notes.map(note => [note.path, note.title]))
    return (result.structured?.hits ?? parseSearch(result.text).hits).map(hit => ({
      path: hit.path, title: titles.get(hit.path) ?? hit.path, line: hit.line, snippet: hit.snippet, viaGraph: hit.viaGraph
    }))
  }
  return {
    async graph ({ tags, status, folder, maxNodes } = {}) {
      const health = client.health()
      if (!['ok', 'degraded'].includes(health.state)) throw new VaultServiceError('vault_unavailable', { tool: 'vault_graph' })
      if (!health.capabilities.includes('graph')) throw new VaultServiceError('vault_tool_missing', { tool: 'vault_graph' })
      const args = Object.fromEntries(Object.entries({ tags, status, folder, max_nodes: maxNodes }).filter(([, value]) => value !== undefined))
      const result = await call('vault_graph', args, 10000)
      if (!result.structured || !Array.isArray(result.structured.nodes)) throw malformed('vault_graph')
      graphPaths = new Set(result.structured.nodes.map(node => node.id))
      return result.structured
    },
    list,
    readNote,
    async note (path) {
      const [note, result, notes] = await Promise.all([readNote(path), call('vault_backlinks', { path }), list()])
      const refs = new Map(notes.map(note => [note.path, note]))
      const backlinks = (result.structured?.notes ?? parseBacklinks(result.text).notes).map(note => refs.get(note.path) ?? ref({ ...note, tipo: null, status: null, tags: [] }))
      const { day, midnight } = localDate(now())
      markOpened(store, path, day, now())
      return {
        note: { path: note.path, title: note.title, frontmatter: note.frontmatter, body: note.body, truncated: note.truncated, total: note.total, ...(note.bodyStartLine ? { bodyStartLine: note.bodyStartLine } : {}) },
        backlinks, linksOut: (note.links ?? []).map(path => refs.get(path)).filter(Boolean),
        usage: noteUsage(store, path, { since: midnight })
      }
    },
    search,
    async lineBound (path) {
      if (fresh(bounds.get(path))) return bounds.get(path).value
      const first = await readNote(path)
      let value = Infinity
      if (first.total <= MAX_BOUND_CHARS) {
        let body = first.body
        let page = first
        let complete = true
        const offsets = new Set([0])
        while (page.truncated) {
          if (!Number.isInteger(page.nextOffset) || page.nextOffset <= (page.offset ?? 0) || offsets.has(page.nextOffset) || page.nextOffset > MAX_BOUND_CHARS) { complete = false; break }
          offsets.add(page.nextOffset)
          page = await readNote(path, page.nextOffset)
          if (page.total !== first.total) { complete = false; break }
          body += page.body
          if (body.length > MAX_BOUND_CHARS) { complete = false; break }
        }
        if (complete) value = noteLineBound({ ...first, body, truncated: false })
      }
      bounds.set(path, { at: now(), value })
      return value
    },
    knownPaths () {
      return new Set([...graphPaths, ...[...lists.values()].filter(fresh).flatMap(entry => entry.notes.map(note => note.path))])
    },
    async sessionMemory (sessionId, task) {
      const memory = storedMemory(store, sessionId)
      let related = null
      let relatedError = null
      let notes = []
      try { notes = await list(); related = task ? (await search(task, 3)).map(({ path, title, line, snippet }) => ({ path, title, line, snippet })) : [] } catch (error) { relatedError = { code: error.code ?? 'vault_unavailable', details: error.details ?? {} } }
      const titles = new Map(notes.map(note => [note.path, note.title]))
      return { related, relatedError, read: memory.read, learned: memory.learned.map(note => ({ ...note, title: titles.get(note.path) ?? note.path })) }
    }
  }
}
