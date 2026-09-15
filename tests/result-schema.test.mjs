import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RESULT_SCHEMA } from '../scripts/result-schema.mjs'

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
