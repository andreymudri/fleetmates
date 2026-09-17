import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RESULT_SCHEMA, validateResult } from '../scripts/result-schema.mjs'

test('RESULT_SCHEMA is an object describing the teammate result contract', () => {
  assert.equal(typeof RESULT_SCHEMA, 'object')
  assert.equal(RESULT_SCHEMA.type, 'object')
})

test('required is exactly the five contract fields, in order', () => {
  assert.deepEqual(RESULT_SCHEMA.required, [
    'status',
    'branch',
    'filesChanged',
    'summary',
    'blockers',
  ])
})

test('the status enum is exactly done, blocked, failed', () => {
  assert.deepEqual(RESULT_SCHEMA.properties.status.enum, ['done', 'blocked', 'failed'])
})

test('additionalProperties is false, as Codex --output-schema requires', () => {
  assert.equal(RESULT_SCHEMA.additionalProperties, false)
})

const good = () => ({ status: 'done', branch: 'b', filesChanged: ['a'], summary: 's', blockers: [] })

test('validateResult accepts a well-formed result', () => {
  assert.equal(validateResult(good()), true)
})

test('validateResult rejects non-objects and arrays', () => {
  for (const v of [null, undefined, 'x', 3, [], [good()]]) assert.equal(validateResult(v), false)
})

test('validateResult rejects a missing required key', () => {
  for (const key of RESULT_SCHEMA.required) {
    const v = good()
    delete v[key]
    assert.equal(validateResult(v), false, key)
  }
})

test('validateResult rejects wrong types, an out-of-enum status and non-string entries', () => {
  const cases = [
    { status: 1 }, { status: 'maybe' }, { branch: null }, { summary: [] },
    { filesChanged: 'a' }, { filesChanged: [1] }, { blockers: {} }, { blockers: [null] },
  ]
  for (const patch of cases) assert.equal(validateResult({ ...good(), ...patch }), false, JSON.stringify(patch))
})

test('validateResult rejects an extra key', () => {
  assert.equal(validateResult({ ...good(), extra: true }), false)
})
