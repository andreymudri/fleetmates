import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultExec, runCommandCheck, runChecks } from '../scripts/gate-runner.mjs'

const executeNode = (source, cwd, options) => defaultExec(process.execPath, cwd, {
  ...options, argv: ['-e', source],
})
const cleanupLog = (t, result) => t.after(async () => {
  if (result.log?.path) await rm(path.dirname(result.log.path), { recursive: true, force: true })
})

test('successful commands retain exact raw output in private evidence despite empty summaries', async t => {
  const text = 'first\n' + 'é'.repeat(50000) + '\nlast\n'
  const result = await runCommandCheck({ name: '../unsafe-name', kind: 'command', run: "process.stdout.write('first\\n' + 'é'.repeat(50000) + '\\nlast\\n')" }, { exec: executeNode })
  cleanupLog(t, result)
  assert.equal(result.status, 'pass')
  assert.equal(result.output, '')
  assert.ok(result.log?.path, 'command output must remain retrievable')
  assert.deepEqual(await readFile(result.log.path), Buffer.from(text))
  assert.equal(result.log.complete, true)
  assert.equal(result.log.bytes, Buffer.byteLength(text))
  assert.equal(result.log.observedBytes, Buffer.byteLength(text))
  assert.equal(result.log.sha256, createHash('sha256').update(text).digest('hex'))
  if (process.platform !== 'win32') {
    assert.equal((await stat(result.log.path)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(result.log.path))).mode & 0o777, 0o700)
  }
})

test('failed commands retain complete output outside previews while bounding long-line summaries', async t => {
  const preview = await mkdtemp(path.join(tmpdir(), 'fm-log-preview-'))
  t.after(() => rm(preview, { recursive: true, force: true }))
  const text = 'first-marker\n' + 'x'.repeat(200000) + '\nlast-marker\n'
  const result = await runCommandCheck({ name: 'fail', kind: 'command', run: "process.stdout.write('first-marker\\n' + 'x'.repeat(200000) + '\\nlast-marker\\n'); process.exitCode = 1" }, { cwd: preview, previewDir: preview, exec: executeNode })
  cleanupLog(t, result)
  assert.equal(result.status, 'fail')
  assert.ok(Buffer.byteLength(result.output) <= 64 * 1024)
  assert.match(result.output, /last-marker/)
  assert.doesNotMatch(result.output, /first-marker/)
  await rm(preview, { recursive: true, force: true })
  assert.deepEqual(await readFile(result.log.path), Buffer.from(text))
  assert.equal(result.log.complete, true)
  assert.equal(result.outcome.category, 'unclassified')
})

test('buffered custom executors retain all output without duplicating streamed evidence', async t => {
  const buffered = await runCommandCheck({ name: 'buffered', kind: 'command', run: 'ignored' }, { exec: async () => ({ code: 1, output: 'buffered output' }) })
  cleanupLog(t, buffered)
  assert.equal(await readFile(buffered.log.path, 'utf8'), 'buffered output')
  const streamed = await runCommandCheck({ name: 'streamed', kind: 'command', run: 'ignored' }, { exec: async (_cmd, _cwd, options) => {
    options.onOutput(Buffer.from('actual bytes'))
    return { code: 0, output: 'summary only' }
  } })
  cleanupLog(t, streamed)
  assert.equal(await readFile(streamed.log.path, 'utf8'), 'actual bytes')
  assert.equal(streamed.log.complete, true)
})

test('log truncation preserves its retained-prefix hash and refuses a zero-exit command check', async t => {
  const text = 'x'.repeat(100000)
  const result = await runCommandCheck({ name: 'bounded', kind: 'command', run: "process.stdout.write('x'.repeat(100000))" }, { exec: executeNode, logMaxBytes: 128 })
  cleanupLog(t, result)
  assert.equal(result.exitCode, 0)
  assert.equal(result.status, 'fail')
  assert.equal(result.log.complete, false)
  assert.equal(result.log.truncated, true)
  assert.equal(result.log.bytes, 128)
  assert.equal(result.log.observedBytes, text.length)
  assert.equal(result.log.sha256, createHash('sha256').update(text.slice(0, 128)).digest('hex'))
  assert.equal((await readFile(result.log.path)).length, 128)
  assert.match(result.output, /evidence is incomplete/)
})

test('timed out output remains retrievable and explicitly incomplete', async t => {
  const result = await runCommandCheck({ name: 'timeout', kind: 'command', run: "process.stdout.write('before timeout'); setInterval(() => {}, 1000)", timeoutMs: 1000 }, { exec: (source, cwd, options) => executeNode(source, cwd, { ...options, graceMs: 50 }) })
  cleanupLog(t, result)
  assert.equal(result.status, 'fail')
  assert.equal(result.outcome.category, 'timeout')
  assert.equal(result.log.complete, false)
  assert.equal(await readFile(result.log.path, 'utf8'), 'before timeout')
})

test('executor errors retain partial output and close evidence before propagation', async t => {
  let evidence
  t.after(async () => { if (evidence) await rm(path.dirname(evidence.path), { recursive: true, force: true }) })
  await assert.rejects(runCommandCheck({ name: 'throwing', kind: 'command', run: 'ignored' }, { exec: async (_cmd, _cwd, options) => {
    options.onOutput(Buffer.from('partial output'))
    throw new Error('executor failed')
  } }), error => {
    evidence = error.commandLog
    assert.ok(evidence?.path)
    assert.equal(evidence.complete, false)
    assert.match(error.message, /executor failed/)
    return true
  })
  assert.equal(await readFile(evidence.path, 'utf8'), 'partial output')
  const [failed] = await runChecks([{ name: 'throwing', kind: 'command', run: 'ignored' }], { exec: async (_cmd, _cwd, options) => {
    options.onOutput(Buffer.from('gate partial output'))
    throw new Error('gate executor failed')
  } })
  cleanupLog(t, failed)
  assert.equal(failed.status, 'fail')
  assert.equal(failed.log?.complete, false, 'the failing gate result must retain the exception evidence')
  assert.equal(await readFile(failed.log.path, 'utf8'), 'gate partial output')
})

test('storage failures remain incomplete and cannot approve a successful command', async t => {
  t.mock.method(fs, 'writeSync', () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }) })
  const result = await runCommandCheck({ name: 'storage', kind: 'command', run: 'ignored' }, { exec: async (_cmd, _cwd, options) => {
    options.onOutput(Buffer.from('lost output'))
    return { code: 0, output: '' }
  } })
  cleanupLog(t, result)
  assert.equal(result.exitCode, 0)
  assert.equal(result.status, 'fail')
  assert.equal(result.log.error, 'EIO')
  assert.equal(result.log.complete, false)
  assert.equal((await readFile(result.log.path)).length, 0)
})

test('binary stderr stays exact in evidence while decoded diagnostics stay within their byte bound', async t => {
  const result = await runCommandCheck({ name: 'binary', kind: 'command', run: 'process.stderr.write(Buffer.alloc(200000, 255)); process.exitCode = 1' }, { exec: executeNode })
  cleanupLog(t, result)
  assert.equal(result.status, 'fail')
  assert.ok(Buffer.byteLength(result.output) <= 64 * 1024, 'decoding invalid UTF-8 must not inflate the diagnostic bound')
  assert.deepEqual(await readFile(result.log.path), Buffer.alloc(200000, 255))
  assert.equal(result.log.complete, true)
})

test('log creation failures refuse execution before launching a command', async t => {
  let directory, executed = false
  t.after(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })
  t.mock.method(fs, 'openSync', file => {
    directory = path.dirname(file)
    throw Object.assign(new Error('storage unavailable'), { code: 'EACCES' })
  })
  await assert.rejects(runCommandCheck({ name: 'creation', kind: 'command', run: 'ignored' }, { exec: async () => {
    executed = true
    return { code: 0, output: '' }
  } }), { code: 'EACCES' })
  assert.equal(executed, false)
})

test('close failures retain available bytes but cannot pass a command', async t => {
  const close = fs.closeSync
  t.mock.method(fs, 'closeSync', fd => {
    close(fd)
    throw Object.assign(new Error('close failed'), { code: 'EIO' })
  })
  const result = await runCommandCheck({ name: 'close', kind: 'command', run: 'ignored' }, { exec: async () => ({ code: 0, output: 'available output' }) })
  cleanupLog(t, result)
  assert.equal(result.status, 'fail')
  assert.equal(result.log.complete, false)
  assert.equal(result.log.error, 'EIO')
  assert.equal(await readFile(result.log.path, 'utf8'), 'available output')
})

test('executor output limits mark retained evidence incomplete even with a zero exit', async t => {
  const result = await runCommandCheck({ name: 'limit', kind: 'command', run: 'ignored' }, { exec: async () => ({ code: 0, output: 'captured prefix', outputLimited: true }) })
  cleanupLog(t, result)
  assert.equal(result.exitCode, 0)
  assert.equal(result.status, 'fail')
  assert.equal(result.log.complete, false)
  assert.equal(result.log.truncated, false)
  assert.equal(await readFile(result.log.path, 'utf8'), 'captured prefix')
  assert.match(result.output, /evidence is incomplete/)
})
