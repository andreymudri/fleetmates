import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { memoryHarness } from '../helpers/memory-harness.mjs'
import { seedResearch, writeResearchDraft, researchBody } from '../helpers/research.mjs'

function fixtureVault () {
  const calls = []
  let outcome = 'ok', target = 'synthetic-vault', changeTarget = false
  const result = { preview: true, action: 'created', path: '02-wiki/concurrency/session-locks.md', committed: false, revision: 'a'.repeat(64), files: [{ path: '02-wiki/concurrency/session-locks.md', before: '', after: '# Session locks', diff: '+# Session locks' }] }
  return { calls, result, changeTargetOnPreview: () => { changeTarget = true }, setOutcome: value => { outcome = value }, health: () => ({ state: 'ok', capabilities: ['preview'], version: '0.5.0' }), identity: () => target, supportsApproval: () => true,
    async call (name, params) { calls.push({ name, params }); if (params.preview) { if (changeTarget) target = 'other-vault'; return { structured: result } }; if (outcome === 'throw') throw Error('transport lost'); if (outcome === 'stale') return { isError: true, structured: { error: { code: 'preview_stale' } } }; return { structured: { action: 'created', path: result.path, committed: true } } } }
}

test('research review persists edits, rejects stale revisions and blocks orphaned citations before MCP', async t => {
  const h = await memoryHarness(t), vault = fixtureVault(), r = await seedResearch(h, { vault })
  await writeResearchDraft(r.repo, r.id)
  let current = await r.service.detail(r.id)
  const edited = await h.request(`/api/research/${r.id}`, 'PATCH', { revision: current.revision, body: researchBody, excludedSources: [1] })
  assert.equal(edited.status, 200)
  assert.deepEqual(edited.data.research.orphans, [1])
  assert.ok(!edited.data.research.body.includes('1. [Lock lifetime]'))
  assert.equal((await h.request(`/api/research/${r.id}`, 'PATCH', { revision: current.revision, body: researchBody, excludedSources: [] })).status, 409)
  await assert.rejects(r.service.preview(r.id), e => e.code === 'orphan_citations')
  assert.equal(vault.calls.length, 0)
  current = await r.service.detail(r.id)
  await r.service.edit(r.id, { revision: current.revision, body: researchBody + '\nOwner edit.', excludedSources: [] })
  assert.match((await r.service.detail(r.id)).body, /Owner edit/)
  await fs.writeFile(path.join(r.repo, 'out', r.id, 'draft.md'), researchBody + '\nTeam edit.')
  current = await r.service.detail(r.id)
  assert.equal(current.reviewConflict, true)
  await assert.rejects(r.service.preview(r.id), e => e.code === 'invalid_state')
  await r.service.edit(r.id, { revision: current.revision, reset: true })
  assert.equal((await r.service.detail(r.id)).reviewConflict, false)
  vault.changeTargetOnPreview()
  await assert.rejects(r.service.preview(r.id), e => e.code === 'research_changed')
  assert.equal((await r.service.detail(r.id)).save.available, false)
})

test('research save requires the exact reviewed preview, persists attribution and freezes saved output', async t => {
  const h = await memoryHarness(t), vault = fixtureVault(), r = await seedResearch(h, { vault })
  h.deck.store.run("INSERT INTO misses(id,question,created_at) VALUES('synthetic-miss','Locks?',1)")
  const req = JSON.parse(h.deck.store.get('SELECT request FROM research WHERE id=?', r.id).request)
  h.deck.store.run('UPDATE research SET request=? WHERE id=?', JSON.stringify({ ...req, missId: 'synthetic-miss', relatedNotes: ['owner-selected-note'] }), r.id)
  await writeResearchDraft(r.repo, r.id)
  let current = (await r.service.preview(r.id)).data.research
  assert.equal(current.save.available, true)
  assert.equal(vault.calls[0].params.force_new, true)
  assert.equal(vault.calls[0].params.insight, researchBody)
  assert.ok(vault.calls[0].params.links.includes('owner-selected-note'))
  await assert.rejects(r.service.save(r.id, 'wrong'), e => e.code === 'preview_required')
  assert.equal(vault.calls.length, 1)
  const { preview, ...approved } = vault.calls[0].params
  current = (await r.service.save(r.id, current.save.preview.id)).data.research
  assert.deepEqual(vault.calls[1].params, { ...approved, expected_revision: vault.result.revision })
  assert.equal(current.state, 'saved')
  assert.equal(h.deck.store.get("SELECT resolved_by FROM misses WHERE id='synthetic-miss'").resolved_by, `research:${r.id}`)
  assert.equal(h.deck.store.get('SELECT via,research_id FROM captures WHERE path=?', vault.result.path).research_id, r.id)
  await fs.writeFile(path.join(r.repo, 'out', r.id, 'draft.md'), 'Agent replaced saved output')
  assert.equal((await r.service.detail(r.id)).body, researchBody)
  await assert.rejects(r.service.save(r.id, current.save.preview?.id), e => e.code === 'already_saved')
  const summary = (await r.service.list())[0]
  assert.equal(summary.rawBody, undefined)
  assert.equal(summary.save, undefined)
})

test('stale previews allow a new review while uncertain saves prohibit retries', async t => {
  const h = await memoryHarness(t), vault = fixtureVault(), r = await seedResearch(h, { vault })
  await writeResearchDraft(r.repo, r.id)
  let current = (await r.service.preview(r.id)).data.research
  vault.setOutcome('stale')
  await assert.rejects(r.service.save(r.id, current.save.preview.id), e => e.code === 'preview_stale')
  assert.equal((await r.service.detail(r.id)).save.state, 'unsaved')
  current = (await r.service.preview(r.id)).data.research
  vault.setOutcome('throw')
  await assert.rejects(r.service.save(r.id, current.save.preview.id), e => e.code === 'save_outcome_unknown')
  assert.equal((await r.service.detail(r.id)).save.state, 'unknown')
  const calls = vault.calls.length
  await assert.rejects(r.service.save(r.id, current.save.preview.id), e => e.code === 'save_outcome_unknown')
  assert.equal(vault.calls.length, calls)
})
