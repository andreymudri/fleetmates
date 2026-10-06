// Parsers for the plain-text answers of vault-mcp 0.3.0 (docs/deck/10-memory-and-research.md 4.3,
// docs/deck/reference/vault-turbid-contract.md 1.5 and 1.6). vault-mcp prints its labels in the
// language of VAULT_LANG, so both the EN and the PT label of each line are accepted. The separator
// inside those lines is U+2014, matched from the EM constant and never typed. A line that does not
// parse is skipped and counted in `skipped`; no parser throws on vault-mcp text.

/** The separator vault-mcp prints between a path and a title (U+2014). */
export const EM = '\u2014'

const ELLIPSIS = '\u2026'
const NONE = new Set(['(none)', '(nenhum)'])

/**
 * Escape a string for use inside a RegExp source.
 * @param {string} s
 * @returns {string}
 */
function esc (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SEP = ` ${esc(EM)} `
const LIST_LINE = new RegExp(`^- (.+?)${SEP}(.*) \\(tipo: (.*?), status: (.*?), tags: (.*)\\)$`)
const LIST_HEAD = /^\d+ (?:note|nota)\(s\):$/
const LIST_EMPTY = /^(?:No notes match those filters\.|Nenhuma nota com os filtros informados\.)$/
const BACKLINK_LINE = new RegExp(`^- (.+?)${SEP}(.*)$`)
const BACKLINK_HEAD = /^\d+ (?:note\(s\) point to|nota\(s\) apontam para) .*:$/
const BACKLINK_EMPTY = /^(?:No notes point to|Nenhuma nota aponta para) /
const NOTE_HEAD = new RegExp(`^(.+?)${SEP}(.*)$`)
const NOTE_SLICE = /^\[(?:slice starting at character|trecho a partir do caractere) (\d+) (?:of|de) (\d+)\]$/
const NOTE_CUT = new RegExp(`^\\[${ELLIPSIS}(?:note cut at|nota cortada em) (\\d+) (?:of|de) (\\d+) (?:characters|caracteres); continue (?:with|com) offset: (\\d+)\\]$`)
const LINKS = /^Links: (.*)$/
const BROKEN = /^(?:Broken links|Links quebrados): (.*)$/
const SEARCH_HEAD = /^\d+ (?:result\(s\) for|resultado\(s\) para) "/
const SEARCH_EMPTY = /^(?:No results for|Nenhum resultado para) "/
const SEARCH_SIMILAR = /^(?:Similar terms found in the vault|Sugestões de termos parecidos no vault): (.*)$/
const SEARCH_HIT = new RegExp(`^(.+?):(\\d+)(?:${SEP}(.*))? \\(score (-?\\d+(?:\\.\\d+)?)((?:, [^,()]+)*)\\)$`)
const VIA_GRAPH = new Set(['via graph', 'via grafo'])
const SNIPPET_CUT = new Set(['snippet truncated', 'trecho truncado'])
const DIAGNOSTICS = /(?:^|\n\n)(?:Warning|Aviso): (\d+) (?:file\(s\) with an indexing problem|arquivo\(s\) com problema de indexação)((?:\n {2}.*)*)\n?$/

/**
 * @typedef {{ path: string, title: string, tipo: string | null, status: string | null, tags: string[],
 *   domain: string | null }} NoteRef
 */

/**
 * The domain of a vault path: `<d>` for `02-wiki/<d>/...`, else null.
 * @param {string} path
 * @returns {string | null}
 */
export function domainOf (path) {
  const m = /^02-wiki\/([^/]+)\//.exec(path)
  return m ? m[1] : null
}

/**
 * Remove the diagnostics footer `vault_search` and `vault_list` append when the scanner has problems.
 * @param {string} text
 * @returns {{ text: string, diagnostics: { count: number, lines: string[] } | null }}
 */
export function stripDiagnostics (text) {
  const m = DIAGNOSTICS.exec(text)
  if (!m) return { text, diagnostics: null }
  const lines = m[2] ? m[2].split('\n').slice(1).map(l => l.slice(2)) : []
  return { text: text.slice(0, m.index), diagnostics: { count: Number(m[1]), lines } }
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function orNull (value) {
  return value === EM ? null : value
}

/**
 * Parse a `vault_list` answer (`- <path> <U+2014> <title> (tipo: .., status: .., tags: ..)` lines).
 * A lone U+2014 reads as null for `tipo` and `status` and as no tags.
 * @param {string} text
 * @returns {{ notes: NoteRef[], skipped: number }}
 */
export function parseList (text) {
  /** @type {NoteRef[]} */
  const notes = []
  let skipped = 0
  for (const line of stripDiagnostics(text).text.split('\n')) {
    if (line === '' || LIST_HEAD.test(line) || LIST_EMPTY.test(line)) continue
    const m = LIST_LINE.exec(line)
    if (!m) { skipped++; continue }
    const tags = m[5] === EM ? [] : m[5].split(', ')
    notes.push({ path: m[1], title: m[2], tipo: orNull(m[3]), status: orNull(m[4]), tags, domain: domainOf(m[1]) })
  }
  return { notes, skipped }
}

/**
 * Parse a `vault_backlinks` answer (`- <path> <U+2014> <title>` lines).
 * @param {string} text
 * @returns {{ notes: { path: string, title: string }[], skipped: number }}
 */
export function parseBacklinks (text) {
  const notes = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line === '' || BACKLINK_HEAD.test(line) || BACKLINK_EMPTY.test(line)) continue
    const m = BACKLINK_LINE.exec(line)
    if (!m) { skipped++; continue }
    notes.push({ path: m[1], title: m[2] })
  }
  return { notes, skipped }
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function pathList (value) {
  return NONE.has(value) ? [] : value.split(', ')
}

/**
 * @typedef {{
 *   path: string, title: string,
 *   frontmatter: Record<string, string> | null, frontmatterCut: boolean,
 *   links: string[] | null, brokenLinks: string[] | null,
 *   body: string, offset: number, truncated: boolean, total: number, nextOffset: number | null,
 *   skipped: number
 * }} ParsedNote
 *   `frontmatter`, `links` and `brokenLinks` are null on a continuation page, which does not
 *   repeat them; frontmatter values are the text vault-mcp printed (a list prints as `a, b`)
 */

/**
 * Parse a `vault_get_note` answer: a first page (offset 0) or a continuation page.
 * The body is relayed raw by vault-mcp and returned as is, without the continuation marker.
 * @param {string} text
 * @returns {ParsedNote | null} null when the text is not a note answer (an error text, for example)
 */
export function parseNote (text) {
  const lines = text.split('\n')
  const head = NOTE_HEAD.exec(lines[0] ?? '')
  if (!head) return null
  let skipped = 0
  let i = 1
  /** @type {Record<string, string> | null} */
  let frontmatter = null
  let frontmatterCut = false
  /** @type {string[] | null} */
  let links = null
  /** @type {string[] | null} */
  let brokenLinks = null
  let offset = 0
  /** @type {number | null} */
  let sliceTotal = null
  if (lines[1] === 'Frontmatter:') {
    frontmatter = {}
    for (i = 2; i < lines.length && lines[i].startsWith('  '); i++) {
      const entry = lines[i].slice(2)
      if (NONE.has(entry)) continue
      if (entry.startsWith(`[${ELLIPSIS}`)) { frontmatterCut = true; continue }
      const colon = entry.indexOf(': ')
      if (colon > 0) frontmatter[entry.slice(0, colon)] = entry.slice(colon + 2)
      else if (entry.endsWith(':') && entry.length > 1) frontmatter[entry.slice(0, -1)] = ''
      else skipped++
    }
    const l = LINKS.exec(lines[i] ?? '')
    const b = BROKEN.exec(lines[i + 1] ?? '')
    if (!l || !b) return null
    links = pathList(l[1])
    brokenLinks = pathList(b[1])
    i += 2
  } else {
    const s = NOTE_SLICE.exec(lines[1] ?? '')
    if (!s) return null
    offset = Number(s[1])
    sliceTotal = Number(s[2])
    i = 2
  }
  if (i < lines.length && lines[i] === '') i++
  const bodyLines = lines.slice(i)
  let truncated = false
  /** @type {number | null} */
  let nextOffset = null
  /** @type {number | null} */
  let cutTotal = null
  const cut = NOTE_CUT.exec(bodyLines[bodyLines.length - 1] ?? '')
  if (cut) {
    bodyLines.pop()
    truncated = true
    cutTotal = Number(cut[2])
    nextOffset = Number(cut[3])
  }
  const body = bodyLines.join('\n')
  const total = cutTotal ?? sliceTotal ?? body.length
  return {
    path: head[1],
    title: head[2],
    frontmatter,
    frontmatterCut,
    links,
    brokenLinks,
    body,
    offset,
    truncated,
    total,
    nextOffset,
    skipped
  }
}

/**
 * @typedef {{ path: string, line: number, trail: string | null, score: number, viaGraph: boolean,
 *   truncated: boolean, snippet: string }} SearchHit
 */

/**
 * Parse a `vault_search` answer. Snippet lines lose their `> ` prefix; a server line that is
 * neither a hit header nor a snippet line is skipped and counted.
 * @param {string} text
 * @returns {{ hits: SearchHit[], empty: boolean, similar: string[], skipped: number }}
 */
export function parseSearch (text) {
  const lines = stripDiagnostics(text).text.split('\n')
  if (SEARCH_EMPTY.test(lines[0] ?? '')) {
    let similar = []
    let skipped = 0
    for (const line of lines.slice(1)) {
      if (line === '') continue
      const m = SEARCH_SIMILAR.exec(line)
      if (m) similar = m[1].split(', ')
      else skipped++
    }
    return { hits: [], empty: true, similar, skipped }
  }
  /** @type {SearchHit[]} */
  const hits = []
  /** @type {string[] | null} */
  let snippet = null
  let skipped = 0
  const flush = () => {
    if (snippet && hits.length) hits[hits.length - 1].snippet = snippet.join('\n')
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === 0 && SEARCH_HEAD.test(line)) continue
    if (line.startsWith('> ') || line === '>') {
      if (snippet) snippet.push(line.slice(2))
      else skipped++
      continue
    }
    if (line === '') continue
    const m = SEARCH_HIT.exec(line)
    if (!m) { skipped++; continue }
    flush()
    const flags = m[5] ? m[5].slice(2).split(', ') : []
    hits.push({
      path: m[1],
      line: Number(m[2]),
      trail: m[3] ?? null,
      score: Number(m[4]),
      viaGraph: flags.some(f => VIA_GRAPH.has(f)),
      truncated: flags.some(f => SNIPPET_CUT.has(f)),
      snippet: ''
    })
    snippet = []
  }
  flush()
  return { hits, empty: hits.length === 0, similar: [], skipped }
}
