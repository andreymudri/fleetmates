import { recordLearnCall, recordNoteRead } from '../ask/store.mjs'

/** Fold a learning title into the slug written by vault-mcp. @param {string} title */
export function slugify (title) {
  return title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Store only a read's path or a learn's slug, never the rest of the hook's tool input.
 * @param {object} store
 * @param {{ session: object, hook: object, at: number }} event
 * @returns {boolean} whether an observation was recorded
 */
export function observeToolUse (store, { session, hook, at }) {
  if (hook.hook_event_name !== 'PreToolUse') return false
  if (/^mcp__.+__vault_get_note$/.test(hook.tool_name ?? '')) {
    const path = hook.tool_input?.path
    if (typeof path !== 'string' || !path || path.length > 512 || !path.endsWith('.md') || path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[a-z]:/i.test(path) || path.split('/').some(part => ['..', '.', ''].includes(part))) return false
    recordNoteRead(store, { sessionId: session.id, path, at })
    return true
  }
  if (/^mcp__.+__vault_learn$/.test(hook.tool_name ?? '')) {
    const title = hook.tool_input?.titulo
    if (typeof title !== 'string' || title.length > 512) return false
    const slug = slugify(title)
    if (!slug) return false
    recordLearnCall(store, { sessionId: session.id, repoId: session.repo_id ?? null, slug, at })
    return true
  }
  return false
}
