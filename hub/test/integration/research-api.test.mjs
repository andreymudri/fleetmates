import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { memoryHarness } from '../helpers/memory-harness.mjs'
import { seedResearch, writeResearchDraft, researchRequest, researchBody } from '../helpers/research.mjs'
import { createResearchService } from '../../server/research/service.mjs'
import { readResearchOutput, readScoutOutput, OUTPUT_MAX } from '../../server/research/output.mjs'

test('research launches through the session path, persists across service recreation and serves validated drafts', async t => {
  const h = await memoryHarness(t)
  const r = await seedResearch(h)
  assert.equal(r.research.state, 'running')
  assert.match(r.launches[0].body.task, /Use 3 scout task/)
  assert.match(r.launches[0].body.task, /Never write to the vault/)
  assert.equal(r.launches[0].body.mode, 'plain')
  assert.equal(h.deck.store.get('SELECT role FROM sessions WHERE id=?', r.research.leadSessionId).role, 'research')
  await writeResearchDraft(r.repo, r.id)
  const detail = await h.request(`/api/research/${r.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.data.research.state, 'drafted')
  assert.equal(detail.data.research.body, researchBody)
  assert.match(detail.data.research.revision, /^[a-f0-9]{64}$/)
  const old = detail.data.research.revision
  await fs.writeFile(path.join(r.repo, 'out', r.id, 'draft.md'), researchBody + '\nEdit.')
  assert.notEqual((await h.request(`/api/research/${r.id}`)).data.research.revision, old)
  await fs.writeFile(path.join(r.repo, 'out', r.id, 'request.json'), JSON.stringify({ domain: 'changed-by-agent', topic: 'wrong' }))
  const recreated = createResearchService({ store: h.deck.store })
  assert.equal((await recreated.detail(r.id)).request.domain, 'concurrency')
  const list = (await h.request('/api/research')).data.research
  assert.equal(list[0].id, r.id)
  assert.equal(list[0].body, undefined)
  await r.service.stop(r.id)
  assert.deepEqual(r.stopped, [r.research.leadSessionId])
  assert.ok(h.events.some(event => event.type === 'research.updated' && !JSON.stringify(event).includes('Session lock lifetime')))
})

test('research refuses saving without preview, validates launch input and cleans up refused launches', async t => {
  const h = await memoryHarness(t)
  const r = await seedResearch(h)
  assert.equal((await h.request(`/api/research/${r.id}/save`, 'POST')).data.error.code, 'preview_required')
  assert.equal((await h.request(`/api/research/${r.id}/preview`, 'POST')).status, 501)
  assert.equal((await h.request(`/api/research/${r.id}/save`, 'POST', { approved: true })).status, 422)
  assert.equal((await h.request('/api/research', 'POST', { ...researchRequest(), sourceTypes: [] })).status, 422)
  assert.equal((await h.request('/api/research', 'POST', { ...researchRequest(), domain: '../escape' })).status, 422)
  assert.equal((await h.request('/api/research', 'POST', { ...researchRequest(), repoKey: {} })).status, 422)
  assert.equal((await h.request('/api/research', 'POST', researchRequest())).status, 503)
  assert.deepEqual(await fs.readdir(path.join(r.repo, 'out')), [r.id])
  assert.equal((await h.request('/api/research/research-not-an-id')).status, 404)
})

test('research output reader refuses oversized files, symlink leaves, redirected parents and mismatched scout identities', async t => {
  const h = await memoryHarness(t)
  const r = await seedResearch(h)
  const dir = path.join(r.repo, 'out', r.id)
  await writeResearchDraft(r.repo, r.id)
  await fs.writeFile(path.join(dir, 'draft.md'), 'a'.repeat(OUTPUT_MAX + 1))
  await assert.rejects(readResearchOutput(r.repo, r.id, 'concurrency'), error => error.code === 'research_output_invalid')
  await fs.rm(path.join(dir, 'draft.md'))
  await fs.writeFile(path.join(h.home, 'outside.md'), researchBody)
  await fs.symlink(path.join(h.home, 'outside.md'), path.join(dir, 'draft.md'))
  await assert.rejects(readResearchOutput(r.repo, r.id, 'concurrency'), error => error.code === 'research_output_invalid')
  await fs.rm(dir, { recursive: true })
  const other = path.join(r.repo, 'other')
  await fs.mkdir(other)
  await fs.writeFile(path.join(other, 'draft.json'), '{}')
  await fs.writeFile(path.join(other, 'draft.md'), researchBody)
  await fs.symlink(other, dir)
  await assert.rejects(readResearchOutput(r.repo, r.id, 'concurrency'), error => error.code === 'research_output_invalid')
  await fs.rm(dir)
  await fs.mkdir(path.join(dir, 'scouts'), { recursive: true })
  await fs.writeFile(path.join(dir, 'scouts/T1.json'), JSON.stringify({ task: 'T2', question: 'Synthetic?', claims: [], sources: [], rejected: [] }))
  await assert.rejects(readScoutOutput(r.repo, r.id, 'T1'), error => error.code === 'research_output_invalid')
  await assert.rejects(readResearchOutput(r.repo, '../escape', 'concurrency'), error => error.code === 'validation_failed')
})
