// Initial M6 output contract: docs/deck/10-memory-and-research.md 8.6 and 8.7.
// Pure validation only. No child processes, filesystem access or vault writes.

export class ResearchContractError extends Error {
  constructor (field) { super(`Invalid research output: ${field}`); this.code = 'research_output_invalid'; this.field = field }
}

const fail = field => { throw new ResearchContractError(field) }
function object (value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field)
  return value
}
function text (value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(field)
  return value
}
function list (value, field, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(field)
  return value
}
function url (value, field) {
  text(value, field, 2000)
  let parsed
  try { parsed = new URL(value) } catch { fail(field) }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(field)
}
function unique (values, field) {
  if (new Set(values).size !== values.length) fail(field)
}
function rejected (entries) {
  list(entries, 'rejected', 100).forEach((source, index) => {
    object(source, `rejected.${index}`)
    url(source.url, `rejected.${index}.url`)
    text(source.title, `rejected.${index}.title`, 300)
    text(source.reason, `rejected.${index}.reason`, 500)
  })
}

/** Validate bounded scout output with reciprocal claim/source references. */
export function validateScout (value) {
  object(value, 'scout')
  if (typeof value.task !== 'string' || !/^T[1-9]\d{0,3}$/.test(value.task)) fail('task')
  text(value.question, 'question', 1000)
  const claims = list(value.claims, 'claims', 40)
  const sources = list(value.sources, 'sources', 30)
  list(value.rejected, 'rejected', 20)
  rejected(value.rejected)
  for (const [entries, suffix] of [[claims, 'c'], [sources, 's']]) {
    for (const entry of entries) {
      object(entry, suffix)
      if (typeof entry.id !== 'string' || !new RegExp(`^${value.task}-${suffix}[1-9]\\d{0,3}$`).test(entry.id)) fail(`${suffix}.id`)
    }
    unique(entries.map(entry => entry.id), `${suffix}.ids`)
  }
  const claimById = new Map(claims.map(claim => [claim.id, claim]))
  const sourceById = new Map(sources.map(source => [source.id, source]))
  for (const claim of claims) {
    text(claim.text, 'claim.text', 500)
    if (!['high', 'medium', 'low'].includes(claim.confidence)) fail('claim.confidence')
    list(claim.sources, 'claim.sources', 30, 1)
    unique(claim.sources, 'claim.sources')
    for (const id of claim.sources) {
      const backs = sourceById.get(id)?.backs
      if (!Array.isArray(backs) || !backs.includes(claim.id)) fail('claim.sources')
    }
  }
  for (const source of sources) {
    url(source.url, 'source.url')
    text(source.title, 'source.title', 300)
    text(source.why, 'source.why', 300)
    if (source.quote !== undefined) text(source.quote, 'source.quote', 300)
    const accessed = new Date(source.accessed)
    if (typeof source.accessed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.accessed) || !Number.isFinite(accessed.getTime()) || accessed.toISOString().slice(0, 10) !== source.accessed) fail('source.accessed')
    if (source.publishedAt !== undefined && source.publishedAt !== null) {
      const date = new Date(source.publishedAt)
      if (typeof source.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.publishedAt) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== source.publishedAt || date > accessed) fail('source.publishedAt')
    }
    if (source.engagement !== undefined && source.engagement !== null && (!Number.isSafeInteger(source.engagement) || source.engagement < 0 || source.engagement > 1000000000)) fail('source.engagement')
    if (!['docs', 'repo', 'blog', 'paper'].includes(source.type)) fail('source.type')
    list(source.backs, 'source.backs', 40, 1)
    unique(source.backs, 'source.backs')
    for (const id of source.backs) if (!claimById.get(id)?.sources?.includes(source.id)) fail('source.backs')
  }
  return structuredClone(value)
}

/** Validate the review payload and body. The form's target domain is authoritative. */
export function validateDraft (value, body, { domain } = {}) {
  object(value, 'draft')
  text(value.title, 'title', 200)
  text(value.domain, 'domain', 100)
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(value.domain) || (domain !== undefined && value.domain !== domain)) fail('domain')
  text(value.contexto, 'contexto', 2000)
  list(value.tags, 'tags', 50).forEach(tag => text(tag, 'tag', 100))
  list(value.links, 'links', 100).forEach(link => {
    text(link, 'link', 300)
    if (/[\[\]\r\n]/.test(link)) fail('link')
  })
  unique(value.tags, 'tags')
  unique(value.links, 'links')
  text(body, 'body', 200000)
  if (/^\s*---(?:\r?\n|$)/.test(body)) fail('body.frontmatter')
  if (!/^## (?:Sources|Fontes)\s*$/m.test(body)) fail('body.sources')
  const sources = list(value.sources, 'sources', 150, 1)
  unique(sources.map(source => object(source, 'source').n), 'source.n')
  unique(sources.map(source => source.id), 'source.id')
  const cited = new Set([...body.matchAll(/\[(\d+)\](?!\()/g)].map(match => Number(match[1])))
  const numbers = new Set()
  for (const source of sources) {
    if (!Number.isSafeInteger(source.n) || source.n < 1 || source.n > 1000) fail('source.n')
    numbers.add(source.n)
    if (!/^T[1-9]\d{0,3}-s[1-9]\d{0,3}$/.test(source.id)) fail('source.id')
    url(source.url, 'source.url')
    text(source.title, 'source.title', 300)
    text(source.why, 'source.why', 300)
    list(source.backs, 'source.backs', 40, 1).forEach(claim => text(claim, 'source.backs', 500))
    if (!cited.has(source.n)) fail('source.uncited')
  }
  for (const n of cited) if (!numbers.has(n)) fail('body.orphan_citation')
  rejected(value.rejected)
  return { draft: structuredClone(value), body }
}
