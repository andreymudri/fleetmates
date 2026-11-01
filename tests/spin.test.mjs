import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spinState, DEFAULT_SPIN_FAILURES } from '../scripts/spin.mjs'

const MIN = 60 * 1000
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)
const windowMs = 30 * MIN
const opts = { now: NOW, windowMs }

function run(fingerprint, result, at) {
  return { kind: 'command-run', at, fingerprint, result }
}
function fails(fingerprint, n, start = NOW - 10 * MIN) {
  return Array.from({ length: n }, (_, i) => run(fingerprint, 'fail', start + i * 1000))
}

test('the default threshold is 5 failures', () => {
  assert.equal(DEFAULT_SPIN_FAILURES, 5)
})

test('5 failures of one fingerprint inside the window is spinning', () => {
  assert.deepEqual(spinState(fails('fp-a', 5), opts), { spinning: true, fingerprint: 'fp-a', fails: 5 })
})

test('4 failures is not spinning', () => {
  assert.deepEqual(spinState(fails('fp-a', 4), opts), { spinning: false })
})

test('a pass after the third failure resets the count (3 + 2 is not spinning)', () => {
  const start = NOW - 10 * MIN
  const events = [...fails('fp-a', 3, start), run('fp-a', 'pass', start + 3500), ...fails('fp-a', 2, start + 4000)]
  assert.deepEqual(spinState(events, opts), { spinning: false })
})

test('failures older than now - windowMs are ignored', () => {
  const events = [...fails('fp-a', 3, NOW - windowMs - 10 * MIN), ...fails('fp-a', 4)]
  assert.deepEqual(spinState(events, opts), { spinning: false })
  // The same seven failures all inside the window do spin, so the old three are what was dropped.
  assert.equal(spinState([...fails('fp-a', 3, NOW - 20 * MIN), ...fails('fp-a', 4)], opts).spinning, true)
})

test('failures spread over two fingerprints (3 + 3) are not spinning', () => {
  assert.deepEqual(spinState([...fails('fp-a', 3), ...fails('fp-b', 3)], opts), { spinning: false })
})

test('unknown results neither count nor reset', () => {
  const start = NOW - 10 * MIN
  const events = [...fails('fp-a', 3, start), run('fp-a', 'unknown', start + 3500), ...fails('fp-a', 2, start + 4000)]
  assert.deepEqual(spinState(events, opts), { spinning: true, fingerprint: 'fp-a', fails: 5 })
  const onlyUnknown = Array.from({ length: 6 }, (_, i) => run('fp-a', 'unknown', start + i))
  assert.deepEqual(spinState(onlyUnknown, opts), { spinning: false })
})

test('events of other kinds are ignored', () => {
  const others = Array.from({ length: 6 }, (_, i) => ({ kind: 'hook-fired', at: NOW - MIN + i, fingerprint: 'fp-a', result: 'fail' }))
  assert.deepEqual(spinState(others, opts), { spinning: false })
  assert.deepEqual(spinState([...others, ...fails('fp-a', 4)], opts), { spinning: false })
})

test('when two fingerprints reach the threshold the one with more failures is reported', () => {
  assert.deepEqual(spinState([...fails('fp-a', 5), ...fails('fp-b', 7)], opts), { spinning: true, fingerprint: 'fp-b', fails: 7 })
  assert.deepEqual(spinState([...fails('fp-b', 7), ...fails('fp-a', 5)], opts), { spinning: true, fingerprint: 'fp-b', fails: 7 })
})

test('a custom failures threshold is honoured', () => {
  assert.equal(spinState(fails('fp-a', 2), { ...opts, failures: 2 }).spinning, true)
})

test('spinState refuses a non-finite clock or window', () => {
  assert.throws(() => spinState([], { now: NaN, windowMs }), /numeric clock/)
  assert.throws(() => spinState([], { now: NOW }), /numeric clock/)
})
