import { randomUUID } from 'node:crypto'
import { apiError } from '../http/router.mjs'
import { vaultNotePath } from '../http/open.mjs'
import { localDate } from '../vault/service.mjs'
import { learnParams } from './review.mjs'

/** Only this service may invoke the MCP write tool, after a current stored preview. */
export function createResearchApproval ({ store, detail, vault, now, publish = () => {} }) {
  const busy = new Set()
  store.run("UPDATE research SET save_state='unknown',preview=NULL WHERE save_state='saving'")
  const record = id => store.get('SELECT * FROM research WHERE id=?', id)
  const identity = () => vault?.identity?.() ?? vault?.health?.().version ?? null
  function supported () {
    const health = vault?.health?.()
    return ['ok', 'degraded'].includes(health?.state) && health.capabilities.includes('preview') && vault.supportsApproval?.() === true
  }
  const stale = (preview, current) => !preview || preview.reviewRevision !== current.revision || preview.identity !== identity() || current.reviewConflict
  async function withLock (id, fn) {
    if (busy.has(id)) throw apiError(409, 'research_busy')
    busy.add(id)
    try { return await fn() } finally { busy.delete(id) }
  }
  const changed = id => publish({ type: 'research.updated', at: now(), data: { id, ephemeral: true } })
  return {
    withLock,
    availability (row, current) {
      const preview = row.preview && JSON.parse(row.preview)
      const available = supported() && !stale(preview, current) && row.save_state === 'unsaved' && !current.orphans?.length
      return { available, canPreview: supported() && row.save_state === 'unsaved',
        reason: !supported() ? 'This vault-mcp version does not provide a verified preview. Nothing can be saved yet.' : current.orphans?.length ? 'Remove or support the highlighted citations before saving.' : current.reviewConflict ? 'The team changed the draft. Review the new output first.' : row.save_state === 'unknown' ? 'The previous save outcome is unknown. Check the vault before trying again.' : 'Review a current preview before saving.',
        preview: stale(preview, current) ? null : { ...preview.result, id: preview.id }, saved: row.saved && JSON.parse(row.saved), state: row.save_state }
    },
    async preview (id, { confirmNewDomain = false } = {}) {
      return withLock(id, async () => {
        if (!supported()) throw apiError(501, 'vault_tool_missing', { tool: 'vault_learn.preview' })
        const current = await detail(id)
        if (current.state !== 'drafted' || current.reviewConflict || record(id).save_state !== 'unsaved') throw apiError(409, 'invalid_state')
        const targetIdentity = identity()
        store.run('UPDATE research SET preview=NULL WHERE id=?', id)
        const params = { ...learnParams(current, new Date(now()).toISOString()), ...(confirmNewDomain ? { confirm_novo_dominio: true } : {}) }
        const response = await vault.call('vault_learn', params, { timeoutMs: 120000 })
        if (response.isError) {
          store.run('UPDATE research SET preview=NULL WHERE id=?', id)
          throw apiError(422, /learn.unknownDomain|confirm_novo_dominio/.test(response.text) ? 'unknown_domain' : 'research_preview_failed')
        }
        const result = response.structured
        if (!result?.preview || result.action !== 'created' || result.committed !== false || !/^[a-f0-9]{64}$/.test(result.revision) || !Array.isArray(result.files) || !result.files.length || JSON.stringify(result).length > 2 * 1024 * 1024) throw apiError(502, 'research_preview_invalid')
        vaultNotePath(result.path)
        if (new Set(result.files.map(file => file.path)).size !== result.files.length || !result.files.some(file => file.path === result.path && file.before === '')) throw apiError(502, 'research_preview_invalid')
        for (const file of result.files) {
          vaultNotePath(file.path)
          if (typeof file.diff !== 'string' || typeof file.before !== 'string' || typeof file.after !== 'string') throw apiError(502, 'research_preview_invalid')
        }
        if (identity() !== targetIdentity || (await detail(id)).revision !== current.revision) throw apiError(409, 'research_changed')
        const preview = { id: randomUUID(), reviewRevision: current.revision, identity: targetIdentity, params, result }
        store.run('UPDATE research SET preview=? WHERE id=?', JSON.stringify(preview), id)
        changed(id)
        return { data: { research: await detail(id) } }
      })
    },
    async save (id, previewId) {
      return withLock(id, async () => {
        const current = await detail(id)
        const row = record(id)
        if (row.save_state === 'saved') throw apiError(409, 'already_saved')
        if (row.save_state !== 'unsaved') throw apiError(409, 'save_outcome_unknown')
        const preview = row.preview && JSON.parse(row.preview)
        if (!supported() || stale(preview, current) || preview.id !== previewId || current.orphans.length) throw apiError(409, 'preview_required')
        store.run("UPDATE research SET save_state='saving' WHERE id=?", id)
        const { preview: ignored, ...params } = preview.params
        let response
        try { response = await vault.call('vault_learn', { ...params, expected_revision: preview.result.revision }, { timeoutMs: 120000 }) } catch {
          store.run("UPDATE research SET save_state='unknown',preview=NULL WHERE id=?", id)
          throw apiError(502, 'save_outcome_unknown')
        }
        if (response.isError) {
          const safe = response.structured?.error?.code === 'preview_stale'
          store.run('UPDATE research SET save_state=?,preview=NULL WHERE id=?', safe ? 'unsaved' : 'unknown', id)
          throw apiError(safe ? 409 : 502, safe ? 'preview_stale' : 'save_outcome_unknown')
        }
        const saved = response.structured
        if (!saved || saved.path !== preview.result.path || !['created', 'appended'].includes(saved.action) || typeof saved.committed !== 'boolean') {
          store.run("UPDATE research SET save_state='unknown',preview=NULL WHERE id=?", id)
          throw apiError(502, 'save_outcome_unknown')
        }
        const at = now(), day = localDate(at).day
        store.tx(() => {
          store.run("UPDATE research SET saved=?,save_state='saved',preview=NULL WHERE id=?", JSON.stringify({ ...saved, body: current.body, draft: { ...current.draft, sources: current.selectedSources }, savedAt: at }), id)
          store.run("INSERT INTO captures(path,day,captured_at,via,session_id,repo_id,research_id) VALUES(?,?,?,'research',?,?,?) ON CONFLICT(path,day) DO UPDATE SET via='research',research_id=excluded.research_id,session_id=excluded.session_id,repo_id=excluded.repo_id", saved.path, day, at, row.lead_session_id, row.repo_id, id)
          const request = JSON.parse(row.request)
          if (request.missId) store.run('UPDATE misses SET resolved_by=? WHERE id=? AND resolved_by IS NULL', `research:${id}`, request.missId)
        })
        changed(id)
        publish({ type: 'misses.changed', at, data: { ephemeral: true } })
        return { data: { research: await detail(id) } }
      })
    }
  }
}
