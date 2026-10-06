import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDraft, validateScout } from '../../server/research/contract.mjs'

const scout = () => ({ task: 'T1', question: 'How long is a session lock held?',
  claims: [{ id: 'T1-c1', text: 'Until the session ends.', confidence: 'high', sources: ['T1-s1'] }],
  sources: [{ id: 'T1-s1', url: 'https://example.org/locks', title: 'Lock lifetime', type: 'docs', why: 'Primary reference', backs: ['T1-c1'], accessed: '2026-10-05' }], rejected: [] })
const draft = () => ({ title: 'Session locks', domain: 'concurrency', contexto: 'Synthetic research', tags: ['locks'], links: ['existing-note'],
  sources: [{ n: 1, id: 'T1-s1', url: 'https://example.org/locks', title: 'Lock lifetime', why: 'Primary reference', backs: ['The session owns the lock.'] }], rejected: [] })
const body = 'The session owns the lock. [1]\n\nExtends [[existing-note]].\n\n## Sources\n\n1. [Lock lifetime](https://example.org/locks): primary reference.'
const invalid = fn => assert.throws(fn, error => error.code === 'research_output_invalid')

test('research scouts require bounded reciprocal evidence and safe source URLs', () => {
  const original = scout()
  const accepted = validateScout(original)
  accepted.claims[0].text = 'changed'
  assert.equal(original.claims[0].text, 'Until the session ends.')
  for (const mutate of [
    value => { value.claims[0].sources = ['T1-s99'] },
    value => { value.claims[0].sources.push('T1-s99') },
    value => { value.sources[0].backs = [] },
    value => { value.sources[0].id = 'T2-s1' },
    value => { value.sources[0].url = 'javascript:alert(1)' },
    value => { value.sources[0].url = 'https://user:secret@example.org/' },
    value => { value.claims[0].text = 'a'.repeat(501) },
    value => { value.sources[0].type = 'unknown' },
    value => { value.sources[0].accessed = '2026-02-30' },
    value => { value.rejected = [{ url: 'https://example.org/', title: 'Rejected' }] }
  ]) { const value = scout(); mutate(value); invalid(() => validateScout(value)) }
})

test('research drafts reject orphan and uncited sources, domain changes and frontmatter', () => {
  assert.deepEqual(validateDraft(draft(), body, { domain: 'concurrency' }), { draft: draft(), body })
  invalid(() => validateDraft(draft(), body + '\nUnsupported. [2]'))
  invalid(() => validateDraft(draft(), body.replace(' [1]', '')))
  invalid(() => validateDraft(draft(), body, { domain: 'other' }))
  invalid(() => validateDraft(draft(), '---\ntags: []\n---\n' + body))
  invalid(() => validateDraft(draft(), body.replace('## Sources', '## Other')))
  const duplicate = draft(); duplicate.sources.push({ ...duplicate.sources[0] })
  invalid(() => validateDraft(duplicate, body))
  const unsafe = draft(); unsafe.sources[0].url = 'file:///etc/passwd'
  invalid(() => validateDraft(unsafe, body))
  const linkedLabel = body.replace(' [1]', ' [1](https://example.org/)')
  invalid(() => validateDraft(draft(), linkedLabel))
})
