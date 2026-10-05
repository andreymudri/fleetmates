/** Export resolved retrieval queries, optionally including still open misses. No writes. */
export function exportMisses(store, { kind = 'retrieval' } = {}) {
  if (!['retrieval', 'all'].includes(kind)) throw new TypeError('invalid export kind')
  return store.all('SELECT question, resolved_by, created_at FROM misses ORDER BY created_at, id')
    .filter(row => row.resolved_by?.startsWith('note:') || (kind === 'all' && row.resolved_by === null))
    .map(row => JSON.stringify({ query: row.question, expectedTopPath: row.resolved_by?.slice(5) ?? null, askedAt: row.created_at }))
    .map(line => `${line}\n`).join('')
}
