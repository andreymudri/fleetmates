import { test } from 'node:test'
import assert from 'node:assert/strict'
import { learnedStaleMinutes, addSample, ENVELOPE_MAX_SAMPLES } from '../scripts/watch-envelope.mjs'

const MIN = 60000

test('fewer than 5 samples falls back to the configured window', () => {
  assert.deepEqual(learnedStaleMinutes([8 * MIN, 8 * MIN, 8 * MIN, 8 * MIN], 20), { minutes: 20, learned: false, samples: 4 })
  assert.deepEqual(learnedStaleMinutes(undefined, 20), { minutes: 20, learned: false, samples: 0 })
})

test('5 samples of 8 minutes learn 12 minutes (8 x 1.5)', () => {
  assert.deepEqual(learnedStaleMinutes(Array(5).fill(8 * MIN), 20), { minutes: 12, learned: true, samples: 5 })
})

test('10 samples whose p90 is 30 minutes learn 45 minutes', () => {
  // Sorted, the 9th of 10 is the p90: eight short samples, then 30, then an outlier above it.
  const samples = [12, 1, 2, 3, 4, 5, 6, 7, 30, 59].map((m) => m * MIN)
  assert.deepEqual(learnedStaleMinutes(samples, 20), { minutes: 45, learned: true, samples: 10 })
})

test('tiny samples clamp up to the 10 minute floor', () => {
  assert.equal(learnedStaleMinutes(Array(5).fill(1000), 20).minutes, 10)
})

test('huge samples clamp down to the 60 minute cap', () => {
  assert.equal(learnedStaleMinutes(Array(5).fill(600 * MIN), 20).minutes, 60)
})

test('non-finite and negative samples are dropped before counting', () => {
  const samples = [8 * MIN, 8 * MIN, 8 * MIN, 8 * MIN, NaN, Infinity, -5, null, '8']
  assert.deepEqual(learnedStaleMinutes(samples, 20), { minutes: 20, learned: false, samples: 4 })
  assert.deepEqual(learnedStaleMinutes([...samples, 8 * MIN], 20), { minutes: 12, learned: true, samples: 5 })
})

test('addSample keeps only the last 50 samples', () => {
  let s = []
  for (let i = 0; i < 60; i++) s = addSample(s, i)
  assert.equal(ENVELOPE_MAX_SAMPLES, 50)
  assert.equal(s.length, 50)
  assert.equal(s[0], 10)
  assert.equal(s.at(-1), 59)
  assert.deepEqual(addSample(undefined, 7), [7])
})
