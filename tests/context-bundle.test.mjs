import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextBundle, contextIsCurrent } from '../scripts/context-bundle.mjs'
const item = (id, text, mandatory = false) => ({ id, text, mandatory, source: 'guide.md', startLine: 1, endLine: 2, reason: 'task-owned interface' })
const options = { task: 'T1', role: 'implementer', commit: 'a'.repeat(40), maxBytes: 7, items: [item('optional', 'abcdef'), item('mandatory', 'rule', true), item('small', 'é')] }
test('context budget always preserves mandatory instructions and records bounded optional omissions', () => {
  const bundle = buildContextBundle(options)
  assert.deepEqual(bundle.selected.map(v => v.id), ['mandatory', 'small'])
  assert.equal(bundle.bytes, 6)
  assert.equal(bundle.omitted[0].id, 'optional')
  assert.match(bundle.selected[0].hash, /^[a-f0-9]{64}$/)
  assert.throws(() => buildContextBundle({ ...options, maxBytes: 3 }), /Mandatory context/)
  assert.equal(buildContextBundle({ ...options, items: [], maxBytes: 0 }).bytes, 0)
})
test('context identities invalidate changed commits, contents, provenance, roles and capabilities', () => {
  const bundle = buildContextBundle(options)
  assert.equal(contextIsCurrent(bundle, options), true)
  for (const altered of [ { commit: 'b'.repeat(40) }, { role: 'reviewer' }, { vault: 'available' },
    { items: options.items.map(i => ({ ...i, text: i.text + 'x' })) },
    { items: options.items.map(i => ({ ...i, startLine: 2 })) } ]) {
    assert.equal(contextIsCurrent(bundle, { ...options, ...altered }), false)
  }
  assert.throws(() => buildContextBundle({ ...options, vault: 'required-missing' }), /Required Vault/)
  assert.throws(() => buildContextBundle({ ...options, items: [options.items[0], options.items[0]] }), /provenance/)
})
