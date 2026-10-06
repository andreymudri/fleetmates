#!/usr/bin/env node
// Fake vault-mcp for deck tests: newline-delimited JSON-RPC 2.0 over stdio, answering the read
// tools in the EN text formats of docs/deck/reference/vault-turbid-contract.md 1.6 and `vault_graph`
// with the 1.11 structured content, built from a scenario file. Tests start it by absolute path as
// `[process.execPath, <this file>]`.
//
// Environment:
//   FAKE_VAULT_SCENARIO  scenario JSON (default: ../fixtures/vault-mcp/vault22.json beside this file)
//   FAKE_VAULT_MODE      ok | exit1 | no-graph | slow | hang | huge (default ok)
//                        exit1: prints `VAULT_PATH is not a directory: /home/you/vault` on stderr, exits 1
//                        no-graph: the 0.3.0 tool list (no vault_graph)
//                        slow: answers tools/call after FAKE_VAULT_DELAY_MS (default 6000)
//                        hang: never answers tools/call
//                        huge: answers tools/call with one line of 17 MiB
//   FAKE_VAULT_PROTOCOL  protocol version to answer in initialize (default: the one asked for)
//   FAKE_VAULT_VERSION   serverInfo.version (default 0.4.0, or 0.3.0 with no-graph)
//   FAKE_VAULT_LOG       file to append `<method>[ <tool>]` per request to; never arguments.
//                        A write tool is refused with isError and also logs `write:<tool>`.
//
// Imported (not run) it exports the scenario loader and the note file renderer, so a test can write
// the same vault to disk.

import { readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Default scenario: the canvas vault. */
export const DEFAULT_SCENARIO = path.join(HERE, '..', 'fixtures', 'vault-mcp', 'vault22.json')
const EM = '\u2014'
const ELLIPSIS = '\u2026'
const MAX_NOTE_CHARS = 20000
const SEARCH_BUDGET = 8000
const FM_KEYS = ['tipo', 'tags', 'status', 'criado', 'atualizado']
const WRITE_TOOLS = new Set(['vault_write_note', 'vault_edit_note', 'vault_learn', 'vault_move', 'vault_delete'])
const STOPWORDS = new Set(['a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'um', 'uma', 'com', 'para',
  'por', 'que', 'os', 'as', 'se', 'the', 'and', 'of', 'to', 'in', 'is', 'how', 'what'])

/**
 * Local calendar day as YYYY-MM-DD.
 * @param {Date} [d]
 * @returns {string}
 */
export function localDay (d = new Date()) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * The file text of a scenario note: block YAML frontmatter (one line per key, one per tag) then the body.
 * @param {{ frontmatter: Record<string, unknown>, body: string[] }} note
 * @returns {string}
 */
export function renderNoteFile (note) {
  return `${frontmatterLines(note.frontmatter).join('\n')}\n${note.body.join('\n')}\n`
}

/**
 * @param {Record<string, unknown>} fm
 * @returns {string[]}
 */
function frontmatterLines (fm) {
  const keys = [...FM_KEYS.filter(k => k in fm), ...Object.keys(fm).filter(k => !FM_KEYS.includes(k))]
  const lines = ['---']
  for (const k of keys) {
    const v = fm[k]
    if (Array.isArray(v)) {
      lines.push(`${k}:`)
      for (const item of v) lines.push(`  - ${item}`)
    } else {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push('---')
  return lines
}

/**
 * @param {string} s
 * @returns {string}
 */
function fold (s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * @param {string} s
 * @returns {string[]}
 */
function tokens (s) {
  return fold(s).split(/[^a-z0-9]+/).filter(t => t.length > 0 && !STOPWORDS.has(t))
}

/**
 * Resolve a wiki-link target against the note paths, in vault-mcp's order: relative to the note's
 * folder, then vault-relative, then by basename.
 * @param {string} raw
 * @param {string} from
 * @param {Map<string, unknown>} byPath
 * @returns {string | null}
 */
function resolveLink (raw, from, byPath) {
  let target = raw.split('|')[0].split('#')[0].trim()
  if (!target) return null
  if (!target.endsWith('.md')) target += '.md'
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), target))
  if (byPath.has(rel)) return rel
  const abs = path.posix.normalize(target)
  if (byPath.has(abs)) return abs
  const base = path.posix.basename(target)
  const hits = [...byPath.keys()].filter(p => path.posix.basename(p) === base)
  hits.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
  return hits[0] ?? null
}

/**
 * @typedef {{
 *   path: string, title: string, frontmatter: Record<string, unknown>, body: string,
 *   bodyStartLine: number, mtimeMs: number, links: string[], brokenLinks: string[], tags: string[]
 * }} FakeNote
 */

/**
 * Load a scenario, replacing `$TODAY` with the local day, and resolve its links.
 * @param {string} [file]
 * @param {Date} [now]
 * @returns {{ notes: FakeNote[], byPath: Map<string, FakeNote> }}
 */
export function loadScenario (file = DEFAULT_SCENARIO, now = new Date()) {
  const today = localDay(now)
  const raw = JSON.parse(readFileSync(file, 'utf8').replaceAll('$TODAY', today))
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  /** @type {Map<string, FakeNote>} */
  const byPath = new Map()
  for (const n of raw.notes) {
    const h1 = n.body.find((/** @type {string} */ l) => /^# /.test(l))
    const [y, m, d] = String(n.mtime).split('-').map(Number)
    const mtimeMs = n.mtime === today
      ? Math.max(startOfDay, now.getTime() - 60000)
      : new Date(y, m - 1, d, 12).getTime()
    byPath.set(n.path, {
      path: n.path,
      title: h1 ? h1.slice(2).trim() : path.posix.basename(n.path, '.md'),
      frontmatter: n.frontmatter,
      body: `${n.body.join('\n')}\n`,
      bodyStartLine: frontmatterLines(n.frontmatter).length + 1,
      mtimeMs,
      links: [],
      brokenLinks: [],
      tags: Array.isArray(n.frontmatter.tags) ? n.frontmatter.tags.map(String) : []
    })
  }
  for (const note of byPath.values()) {
    const links = new Set()
    const broken = new Set()
    for (const m of note.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const to = resolveLink(m[1], note.path, byPath)
      if (to && to !== note.path) links.add(to)
      else if (!to) broken.add(m[1].split('|')[0])
    }
    note.links = [...links]
    note.brokenLinks = [...broken]
  }
  const notes = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
  return { notes, byPath }
}

/**
 * @param {FakeNote} note
 * @param {string} key
 * @returns {string | null}
 */
function field (note, key) {
  const v = note.frontmatter[key]
  return typeof v === 'string' ? v : null
}

/**
 * @param {string} p
 * @param {string} folder
 * @returns {boolean}
 */
function inFolder (p, folder) {
  const f = folder.replace(/\/+$/, '')
  return p === f || p.startsWith(`${f}/`)
}

/**
 * @param {FakeNote} note
 * @param {Record<string, any>} args
 * @returns {boolean}
 */
function matches (note, args) {
  if (args.tipo !== undefined && field(note, 'tipo') !== args.tipo) return false
  if (args.status !== undefined && field(note, 'status') !== args.status) return false
  if (args.folder !== undefined && !inFolder(note.path, args.folder)) return false
  if (!args.include_raw && note.path.startsWith('01-raw/') && args.folder === undefined) return false
  const have = new Set(note.tags.map(t => t.toLowerCase()))
  return (args.tags ?? []).every((/** @type {string} */ t) => have.has(String(t).toLowerCase()))
}

/**
 * @param {Map<string, FakeNote>} byPath
 * @param {string} target
 * @returns {string[]}
 */
function backlinksOf (byPath, target) {
  return [...byPath.values()].filter(n => n.links.includes(target)).map(n => n.path).sort()
}

/**
 * Chunks of a note body split on `##`/`###` headings, numbered by file line.
 * @param {FakeNote} note
 * @returns {{ path: string, lineStart: number, trail: string[], text: string }[]}
 */
function chunks (note) {
  const lines = note.body.replace(/\n$/, '').split('\n')
  const out = []
  let trail = /** @type {string[]} */ ([])
  let current = /** @type {string[]} */ ([])
  let start = note.bodyStartLine
  const flush = () => {
    const text = current.join('\n')
    if (text.trim()) out.push({ path: note.path, lineStart: start, trail: [...trail], text })
  }
  lines.forEach((line, i) => {
    const m = /^(#{2,3})\s+(.*)$/.exec(line)
    if (m) {
      flush()
      trail = m[1].length === 2 ? [m[2].trim()] : [...trail.slice(0, 1), m[2].trim()]
      current = [line]
      start = note.bodyStartLine + i
    } else {
      current.push(line)
    }
  })
  flush()
  return out
}

/**
 * @param {{ byPath: Map<string, FakeNote>, notes: FakeNote[] }} vault
 * @param {Record<string, any>} args
 * @returns {{ text: string, isError?: boolean }}
 */
function vaultSearch (vault, args) {
  const query = typeof args.query === 'string' ? args.query : ''
  if (!query) return { text: 'invalid input for vault_search: query: query cannot be empty', isError: true }
  const limit = Number.isInteger(args.limit) ? args.limit : 6
  const terms = [...new Set(tokens(query))]
  const scored = []
  for (const note of vault.notes) {
    if (!matches(note, args)) continue
    const tipo = field(note, 'tipo')
    const weight = tipo === 'moc' || tipo === 'daily' ? 0.3 : 1
    const tagTokens = note.tags.flatMap(tokens)
    for (const c of chunks(note)) {
      const heading = c.trail.flatMap(tokens)
      const text = tokens(c.text)
      let score = 0
      for (const t of terms) {
        score += 3 * heading.filter(x => x === t).length + 2 * tagTokens.filter(x => x === t).length +
          text.filter(x => x === t).length
      }
      if (score > 0) scored.push({ chunk: c, score: score * weight, viaGraph: false })
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.chunk.path < b.chunk.path ? -1 : a.chunk.path > b.chunk.path ? 1 : a.chunk.lineStart - b.chunk.lineStart))
  const direct = scored.slice(0, 8)
  const seen = new Set(direct.map(h => h.chunk.path))
  const expanded = []
  for (const hit of direct) {
    const note = vault.byPath.get(hit.chunk.path)
    if (!note) continue
    for (const other of [...note.links, ...backlinksOf(vault.byPath, note.path)]) {
      if (seen.has(other)) continue
      const n = vault.byPath.get(other)
      if (!n || !matches(n, args)) continue
      const first = chunks(n)[0]
      if (!first) continue
      seen.add(other)
      expanded.push({ chunk: first, score: hit.score * 0.4, viaGraph: true })
    }
  }
  const all = [...direct, ...expanded]
    .sort((a, b) => b.score - a.score || (a.chunk.path < b.chunk.path ? -1 : a.chunk.path > b.chunk.path ? 1 : a.chunk.lineStart - b.chunk.lineStart))
    .slice(0, limit)
  if (all.length === 0) {
    const words = new Set(vault.notes.flatMap(n => tokens(n.body)))
    const similar = [...words].filter(w => terms.some(t => t.length >= 3 && w !== t && w.startsWith(t.slice(0, 3)))).sort().slice(0, 3)
    const head = `No results for "${query}".`
    return { text: similar.length ? `${head}\nSimilar terms found in the vault: ${similar.join(', ')}` : head }
  }
  let budget = SEARCH_BUDGET
  const rendered = all.map(h => {
    let text = h.chunk.text
    let cut = false
    if (text.length > budget) { text = text.slice(0, Math.max(budget, 0)); cut = true }
    budget -= text.length
    const trail = h.chunk.trail.length ? ` ${EM} ${h.chunk.trail.join(' > ')}` : ''
    const flags = [`score ${h.score.toFixed(2)}`, h.viaGraph ? 'via graph' : null, cut ? 'snippet truncated' : null]
      .filter(Boolean).join(', ')
    return `${h.chunk.path}:${h.chunk.lineStart}${trail} (${flags})\n${text.split('\n').map(l => `> ${l}`).join('\n')}`
  })
  const head = `${all.length} result(s) for "${query}". Cite \`path:line\` when using any snippet below. ` +
    'Each snippet from a note is prefixed with `> `; lines without that prefix come from this server, never vault content.'
  return { text: [head, ...rendered].join('\n\n') }
}

/**
 * @param {{ byPath: Map<string, FakeNote> }} vault
 * @param {Record<string, any>} args
 * @returns {{ text: string, isError?: boolean }}
 */
function vaultGetNote (vault, args) {
  const note = vault.byPath.get(args.path)
  if (!note) return { text: `note not found: ${args.path}`, isError: true }
  const asked = Number.isInteger(args.offset) ? args.offset : 0
  if (asked > 0 && asked >= note.body.length) {
    return { text: `offset ${asked} past the end of ${note.path}: the note has ${note.body.length} characters`, isError: true }
  }
  const rest = note.body.slice(asked)
  const shown = rest.slice(0, MAX_NOTE_CHARS)
  const body = shown.length === rest.length
    ? shown
    : `${shown}\n[${ELLIPSIS}note cut at ${MAX_NOTE_CHARS} of ${note.body.length} characters; continue with offset: ${asked + shown.length}]`
  const fm = Object.entries(note.frontmatter).map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
  const head = asked === 0
    ? [
        `${note.path} ${EM} ${note.title}`,
        'Frontmatter:',
        fm.length ? fm.join('\n') : '  (none)',
        `Links: ${note.links.length ? note.links.join(', ') : '(none)'}`,
        `Broken links: ${note.brokenLinks.length ? note.brokenLinks.join(', ') : '(none)'}`
      ]
    : [`${note.path} ${EM} ${note.title}`, `[slice starting at character ${asked} of ${note.body.length}]`]
  return { text: [...head, '', body].join('\n') }
}

/**
 * @param {FakeNote} note
 * @returns {string}
 */
function noteLine (note) {
  const tipo = field(note, 'tipo') ?? EM
  const status = field(note, 'status') ?? EM
  const tags = note.tags.join(', ') || EM
  return `- ${note.path} ${EM} ${note.title} (tipo: ${tipo}, status: ${status}, tags: ${tags})`
}

/**
 * @param {{ notes: FakeNote[] }} vault
 * @param {Record<string, any>} args
 * @returns {{ text: string }}
 */
function vaultList (vault, args) {
  const notes = vault.notes.filter(n => matches(n, { ...args, include_raw: true }))
  if (notes.length === 0) return { text: 'No notes match those filters.' }
  return { text: [`${notes.length} note(s):`, ...notes.map(noteLine)].join('\n') }
}

/**
 * @param {{ byPath: Map<string, FakeNote> }} vault
 * @param {Record<string, any>} args
 * @returns {{ text: string, isError?: boolean }}
 */
function vaultBacklinks (vault, args) {
  const note = vault.byPath.get(args.path)
  if (!note) return { text: `note not found: ${args.path}`, isError: true }
  const back = backlinksOf(vault.byPath, note.path)
  if (back.length === 0) return { text: `No notes point to ${note.path}.` }
  const lines = back.map(p => `- ${p} ${EM} ${vault.byPath.get(p)?.title}`)
  return { text: [`${back.length} note(s) point to ${note.path}:`, ...lines].join('\n') }
}

/**
 * @param {{ notes: FakeNote[] }} vault
 * @param {Record<string, any>} args
 * @returns {{ text: string, structuredContent: Record<string, unknown> }}
 */
function vaultGraph (vault, args) {
  const max = Number.isInteger(args.max_nodes) ? args.max_nodes : 2000
  const selected = vault.notes.filter(n => matches(n, args))
  const kept = selected.slice(0, max)
  const ids = new Set(kept.map(n => n.path))
  const edges = kept.flatMap(n => n.links.filter(t => ids.has(t)).map(t => ({ source: n.path, target: t })))
  const broken = kept.flatMap(n => n.brokenLinks.map(t => ({ source: n.path, target: t })))
  const nodes = kept.map(n => ({
    id: n.path,
    title: n.title,
    tipo: field(n, 'tipo'),
    status: field(n, 'status'),
    tags: n.tags,
    area: n.path.split('/')[0],
    domain: /^02-wiki\/([^/]+)\//.exec(n.path)?.[1] ?? null,
    in_degree: edges.filter(e => e.target === n.path).length,
    out_degree: edges.filter(e => e.source === n.path).length,
    mtime_ms: n.mtimeMs
  }))
  const orphans = nodes.filter(n => n.in_degree === 0 && n.out_degree === 0).length
  const graph = {
    nodes,
    edges,
    ...(args.include_broken ? { broken } : {}),
    truncated: selected.length > kept.length,
    counts: { notes: selected.length, edges: edges.length, orphans, broken: broken.length }
  }
  const text = [`${nodes.length} note(s), ${edges.length} link(s), ${orphans} orphan(s).`,
    ...edges.map(e => `- ${e.source} -> ${e.target}`)].join('\n')
  return { text, structuredContent: graph }
}

const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }
const bool = { type: 'boolean' }
/**
 * @param {Record<string, unknown>} properties
 * @param {string[]} [required]
 * @returns {Record<string, unknown>}
 */
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

/**
 * The tool list: the nine 0.3.0 tools, plus `vault_graph` with an `outputSchema` unless `noGraph`.
 * @param {boolean} noGraph
 * @returns {Record<string, unknown>[]}
 */
export function toolList (noGraph) {
  const filters = { tipo: str, tags: strs, status: str, folder: str }
  const tools = [
    { name: 'vault_search', description: 'Search the vault.', inputSchema: schema({ query: str, limit: { type: 'integer', minimum: 1, maximum: 50 }, ...filters, include_raw: bool }, ['query']) },
    { name: 'vault_get_note', description: 'Read one note.', inputSchema: schema({ path: str, offset: { type: 'integer', minimum: 0 } }, ['path']) },
    { name: 'vault_list', description: 'List notes.', inputSchema: schema(filters) },
    { name: 'vault_backlinks', description: 'Notes pointing to a note.', inputSchema: schema({ path: str }, ['path']) },
    { name: 'vault_write_note', description: 'Write a note.', inputSchema: schema({ path: str, content: str, frontmatter: { type: 'object' } }, ['path', 'content']) },
    { name: 'vault_edit_note', description: 'Edit a note.', inputSchema: schema({ path: str, old_text: str, new_text: str }, ['path', 'old_text', 'new_text']) },
    { name: 'vault_learn', description: 'Record a learning.', inputSchema: schema({ titulo: str, insight: str, contexto: str, dominio: str, projeto: str, tags: strs, links: strs, confirm_novo_dominio: bool }, ['titulo', 'insight', 'contexto', 'dominio']) },
    { name: 'vault_move', description: 'Move a note.', inputSchema: schema({ from: str, to: str, confirm_novo_dominio: bool }, ['from', 'to']) },
    { name: 'vault_delete', description: 'Delete a note.', inputSchema: schema({ path: str, confirm: bool }, ['path']) }
  ]
  if (!noGraph) {
    tools.push({
      name: 'vault_graph',
      description: 'The link graph of the vault.',
      inputSchema: schema({ ...filters, include_raw: bool, include_broken: bool, max_nodes: { type: 'integer', minimum: 1, maximum: 5000 } }),
      outputSchema: schema({
        nodes: { type: 'array', items: { type: 'object' } },
        edges: { type: 'array', items: { type: 'object' } },
        broken: { type: 'array', items: { type: 'object' } },
        truncated: bool,
        counts: { type: 'object' }
      }, ['nodes', 'edges', 'truncated', 'counts'])
    })
  }
  return tools
}

function main () {
  const mode = process.env.FAKE_VAULT_MODE || 'ok'
  if (mode === 'exit1') {
    process.stderr.write('VAULT_PATH is not a directory: /home/you/vault\n')
    process.exit(1)
  }
  const noGraph = mode === 'no-graph'
  const vault = loadScenario(process.env.FAKE_VAULT_SCENARIO || DEFAULT_SCENARIO)
  const logFile = process.env.FAKE_VAULT_LOG
  const log = (/** @type {string} */ line) => { if (logFile) appendFileSync(logFile, `${line}\n`) }
  const send = (/** @type {Record<string, unknown>} */ msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
  const tools = toolList(noGraph)
  /** @type {Record<string, (vault: any, args: Record<string, any>) => Record<string, any>>} */
  const handlers = { vault_search: vaultSearch, vault_get_note: vaultGetNote, vault_list: vaultList, vault_backlinks: vaultBacklinks }
  if (!noGraph) handlers.vault_graph = vaultGraph

  /** @param {any} msg */
  const answerCall = (msg) => {
    const name = msg.params?.name
    const args = msg.params?.arguments ?? {}
    if (WRITE_TOOLS.has(name)) {
      log(`write:${name}`)
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `${name} is refused by the fake vault-mcp` }], isError: true } })
      return
    }
    const handler = handlers[name]
    if (!handler) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `MCP error -32602: Tool ${name} not found` } })
      return
    }
    const { text, isError, structuredContent } = handler(vault, args)
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError: true } : {}) }
    })
  }

  /** @param {any} msg */
  const handle = (msg) => {
    const method = msg.method
    if (typeof method !== 'string') return
    log(method === 'tools/call' ? `${method} ${msg.params?.name}` : method)
    if (msg.id === undefined) return
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: process.env.FAKE_VAULT_PROTOCOL || msg.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'vault-mcp', version: process.env.FAKE_VAULT_VERSION || (noGraph ? '0.3.0' : '0.4.0') }
        }
      })
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } })
    } else if (method === 'tools/call') {
      if (mode === 'hang') return
      if (mode === 'huge') {
        process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":{"content":[{"type":"text","text":"${'x'.repeat(17 * 1024 * 1024)}"}]}}\n`)
        return
      }
      if (mode === 'slow') {
        setTimeout(() => answerCall(msg), Number(process.env.FAKE_VAULT_DELAY_MS || 6000))
        return
      }
      answerCall(msg)
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  }

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      handle(msg)
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

if (import.meta.main) main()
