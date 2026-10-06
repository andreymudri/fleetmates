import test from 'node:test'
import assert from 'node:assert/strict'
import { probeCommand } from '../scripts/harnesses/probe-command.mjs'

test('authentication status preserves ordinary success without a shell', async () => {
  const result = await probeCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$HOME; echo injected'], process.env)
  assert.equal(result.code, 0)
  assert.equal(result.text, '$HOME; echo injected')
})

test('authentication status cannot pass after its deadline', async () => {
  const result = await probeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, { timeoutMs: 100 })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.code, 0)
})

test('authentication status bounds output even when the producer exits successfully', async () => {
  const result = await probeCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000))"], process.env, { maxOutputBytes: 128 })
  assert.equal(result.outputLimited, true)
  assert.notEqual(result.code, 0)
  assert.ok(Buffer.byteLength(result.text) < 300)
})
