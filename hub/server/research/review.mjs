import { createHash } from 'node:crypto'
import { apiError } from '../http/router.mjs'
import { validateDraft } from './contract.mjs'

export function reviewRevision (base, review) {
  return createHash('sha256').update(JSON.stringify({ base, review })).digest('hex')
}

export function reviewedOutput (output, review) {
  const rawBody = review?.body ?? output.body
  const excluded = review?.excludedSources ?? []
  const sources = output.draft.sources.filter(source => !excluded.includes(source.n))
  let inSources = false
  const body = rawBody.split('\n').filter(line => {
    if (/^## (?:Sources|Fontes)\s*$/.test(line)) inSources = true
    else if (/^##\s/.test(line)) inSources = false
    const n = inSources ? Number(/^(\d+)\.\s/.exec(line)?.[1]) : NaN
    return !excluded.includes(n)
  }).join('\n')
  const selected = new Set(sources.map(source => source.n))
  const orphans = [...new Set([...body.matchAll(/\[(\d+)\](?!\()/g)].map(match => Number(match[1])).filter(n => !selected.has(n)))]
  return { ...output, rawBody, body, excludedSources: excluded, selectedSources: sources, orphans, revision: reviewRevision(output.revision, review) }
}

export function validateReview (input, current) {
  if (Object.keys(input).some(key => !['revision', 'body', 'excludedSources', 'reset'].includes(key))) throw apiError(422, 'validation_failed')
  if (input.revision !== current.revision) throw apiError(409, 'research_changed')
  if (input.reset === true) return null
  if (current.reviewConflict) throw apiError(409, 'research_changed')
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 200000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.body) ||
    !Array.isArray(input.excludedSources) || input.excludedSources.length > current.draft.sources.length || input.excludedSources.some(n => !current.draft.sources.some(source => source.n === n))) throw apiError(422, 'validation_failed')
  return { body: input.body, excludedSources: [...new Set(input.excludedSources)].sort((a,b) => a-b), baseRevision: current.baseRevision }
}

export function learnParams (current, at) {
  if (current.orphans.length) throw apiError(409, 'orphan_citations', { citations: current.orphans })
  try { validateDraft({ ...current.draft, sources: current.selectedSources }, current.body, { domain: current.request.domain }) } catch { throw apiError(422, 'research_output_invalid') }
  return { titulo: current.draft.title, insight: current.body, contexto: current.draft.contexto, dominio: current.request.domain,
    tags: [...new Set([...current.draft.tags, 'research'])], links: current.draft.links, force_new: true, preview: true, preview_time: at }
}
