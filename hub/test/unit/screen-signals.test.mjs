// The SM-O6 screen-idle debounce (docs/deck/spikes/m0.md 3.2) on a fake clock: a PTY fires idle once after two
// consecutive idle screens, or after 500 ms of an idle last screen; a busy screen re-arms it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIdleTracker, isCountedOutput } from '../../server/pty/screen-signals.mjs'

/** A manual clock with setTimeout and clearTimeout that run only when `advance` passes their due time. */
function fakeClock() {
  let at = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => at,
    setTimeout(fn, ms) { const id = nextId++
      timers.set(id, { fn, due: at + ms })
      return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const end = at + ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
        if (!due) break
        timers.delete(due[0])
        at = due[1].due
        due[1].fn()
      }
      at = end
    },
    pending: () => timers.size
  }
}

function tracker() {
  const clock = fakeClock()
  const fired = []
  const idle = createIdleTracker({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  idle.onIdle(event => fired.push(event))
  return { clock, fired, idle }
}

test('idle, busy, idle within 100 ms fires nothing', () => {
  const { clock, fired, idle } = tracker()
  idle.screen('pty_a', true)
  clock.advance(40)
  idle.screen('pty_a', false)
  clock.advance(40)
  idle.screen('pty_a', true)
  clock.advance(20)
  assert.deepEqual(fired, [])
})

test('two consecutive idle screens fire once, and further idle screens or time fire nothing more', () => {
  const { clock, fired, idle } = tracker()
  idle.screen('pty_a', true)
  clock.advance(250)
  idle.screen('pty_a', true)
  assert.deepEqual(fired, [{ ptyId: 'pty_a', at: 250 }])
  idle.screen('pty_a', true)
  clock.advance(5000)
  assert.equal(fired.length, 1)
  assert.equal(clock.pending(), 0, 'no timer is left armed after firing')
})

test('one idle screen then 500 ms fires once', () => {
  const { clock, fired, idle } = tracker()
  idle.screen('pty_a', true)
  clock.advance(499)
  assert.deepEqual(fired, [], 'not before 500 ms')
  clock.advance(1)
  assert.deepEqual(fired, [{ ptyId: 'pty_a', at: 500 }])
  clock.advance(5000)
  assert.equal(fired.length, 1)
})

test('a busy screen re-arms a PTY that already fired, and PTYs are tracked apart', () => {
  const { clock, fired, idle } = tracker()
  idle.screen('pty_a', true)
  idle.screen('pty_a', true)
  idle.screen('pty_b', true)
  idle.screen('pty_a', false)
  idle.screen('pty_a', true)
  clock.advance(500)
  assert.deepEqual(fired.map(event => event.ptyId), ['pty_a', 'pty_b', 'pty_a'])
  idle.forget('pty_b')
  idle.screen('pty_c', true)
  idle.close()
  clock.advance(1000)
  assert.equal(fired.length, 3, 'close cancels the pending timers')
})

test('counted output is a changed row outside the status region', () => {
  assert.equal(isCountedOutput([3, 34], [34, 35, 36]), true)
  assert.equal(isCountedOutput([34, 36], [34, 35, 36]), false, 'a spinner or input box redraw is not activity')
  assert.equal(isCountedOutput([], []), false)
  assert.equal(isCountedOutput(undefined, []), false)
})
