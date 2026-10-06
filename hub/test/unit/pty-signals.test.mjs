import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signalProcessGroup } from '../../deckd/pty-host.mjs'

test('PTY signals prefer the group, fall back to the owned PID on EPERM, and retain other errors', () => {
  const calls = []
  const error = code => Object.assign(new Error(code), { code })
  signalProcessGroup(123, 'SIGTERM', (pid, signal) => calls.push([pid, signal]))
  assert.deepEqual(calls.splice(0), [[-123, 'SIGTERM']])
  signalProcessGroup(123, 'SIGKILL', (pid, signal) => {
    calls.push([pid, signal])
    if (pid < 0) throw error('EPERM')
  })
  assert.deepEqual(calls.splice(0), [[-123, 'SIGKILL'], [123, 'SIGKILL']])
  signalProcessGroup(123, 'SIGTERM', pid => {
    calls.push(pid)
    throw error('ESRCH')
  })
  assert.deepEqual(calls.splice(0), [-123])
  signalProcessGroup(123, 'SIGTERM', pid => { throw error(pid < 0 ? 'EPERM' : 'ESRCH') })
  assert.throws(() => signalProcessGroup(123, 'SIGTERM', () => { throw error('EACCES') }), { code: 'EACCES' })
  assert.throws(() => signalProcessGroup(123, 'SIGTERM', () => { throw error('EPERM') }), { code: 'EPERM' })
})
