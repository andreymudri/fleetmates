import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createIngestor, startHookSocket } from '../../server/ingest/socket.mjs'
import { drainSpool, startSpoolDrain } from '../../server/ingest/spool.mjs'
import { createReorderBuffer } from '../../server/ingest/reorder.mjs'
import { validateEnvelope } from '../../server/ingest/validate.mjs'

const hook = { session_id: 's1', transcript_path: '/home/you/.claude/projects/x/a.jsonl', cwd: '/repo', hook_event_name: 'Stop', stop_hook_active: false }
const line = (hookTs = 1, payload = hook) => JSON.stringify({ v: 1, deckHookVersion: '0.1.0', hookTs, ptyId: null, claudePid: null, pidChain: [], truncated: false, hook: payload }) + '\n'

test('validation accepts fixture shape and rejects drift, unknown events and malformed lines', () => {
  assert.equal(validateEnvelope(line()).ok, true)
  assert.match(validateEnvelope('{').reason, /invalid_json/)
  assert.match(validateEnvelope(line(1, { ...hook, hook_event_name: 'Mystery' })).reason, /unknown_event/)
  assert.match(validateEnvelope(line(1, { ...hook, session_id: 42 })).reason, /session_id/)
  assert.match(validateEnvelope(line(1, { ...hook, stop_hook_active: 'false' })).reason, /stop_hook_active/)
  assert.match(validateEnvelope(line(1).repeat(20000)).reason, /too_large/)
})

test('ingestor deduplicates and keeps hook and receive times separate', () => {
  const accepted = []
  const rejected = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: row => rejected.push(row), reorderMs: 0, now: () => 900 })
  ingest.receive(line(10), 'socket')
  ingest.receive(line(10), 'spool')
  ingest.receive('{', 'socket')
  ingest.flush()
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].hookTs, 10)
  assert.equal(accepted[0].receivedAt, 900)
  assert.equal(accepted[0].via, 'socket')
  assert.equal(rejected[0].reason, 'invalid_json')
  ingest.close()
})

test('reorder buffer sorts timestamps and event rank within one session', () => {
  const output = []
  const buffer = createReorderBuffer(batch => output.push(...batch), { windowMs: 250 })
  for (const [hookTs, event] of [[4, 'Stop'], [3, 'PostToolUse'], [3, 'PreToolUse'], [3, 'SessionStart']]) {
    buffer.push({ hookTs, hook: { session_id: 's1', hook_event_name: event } })
  }
  buffer.flushAll()
  assert.deepEqual(output.map(row => row.hook.hook_event_name), ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'])
  buffer.close()
})

test('socket rejects partial lines and accepts complete lines', async () => {
  const dir = await mkdtemp(path.join('/tmp/hx', 'ingest-'))
  const accepted = []
  const rejected = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: row => rejected.push(row), reorderMs: 0 })
  const server = await startHookSocket({ runtimeDir: dir, ingest })
  try {
    const { connect } = await import('node:net')
    await new Promise(resolve => { const socket = connect(server.path); socket.on('connect', () => socket.end(line())); socket.on('close', resolve) })
    await new Promise(resolve => { const socket = connect(server.path); socket.on('connect', () => socket.end('{')); socket.on('close', resolve) })
    ingest.flush()
    assert.equal(accepted.length, 1)
    assert.equal(rejected.length, 1)
  } finally { await server.close(); ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('spool drain replays sorted lines and retains a new append file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-'))
  const accepted = []
  const rejected = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: row => rejected.push(row), reorderMs: 0 })
  try {
    await writeFile(path.join(dir, 'hooks-20260928.jsonl'), line(3) + line(1, { ...hook, session_id: 's2' }) + '{\n')
    await drainSpool(dir, ingest)
    ingest.flush()
    assert.deepEqual(accepted.map(row => row.hookTs), [1, 3])
    assert.equal(rejected.length, 1)
    assert.deepEqual(await readdir(dir), [])
    await writeFile(path.join(dir, 'hooks-20260928.jsonl'), line(4))
    assert.ok((await readFile(path.join(dir, 'hooks-20260928.jsonl'))).length > 0)
  } finally { ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('spool drain reads an interrupted drain before a newer same-day spool', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-restart-'))
  const accepted = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: () => {}, reorderMs: 0 })
  try {
    await writeFile(path.join(dir, 'hooks-20260928.jsonl.draining'), line(1, { ...hook, session_id: 'old' }))
    await writeFile(path.join(dir, 'hooks-20260928.jsonl'), line(2, { ...hook, session_id: 'new' }))
    await drainSpool(dir, ingest)
    ingest.flush()
    assert.deepEqual(accepted.map(row => row.hook.session_id), ['old', 'new'])
    assert.deepEqual(await readdir(dir), [])
  } finally { ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('startup spool drain applies rows before returning and leaves failed files for retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-start-'))
  try {
    await writeFile(path.join(dir, 'hooks-20260928.jsonl'), line(1))
    const failing = createIngestor({ onEvent: () => { throw Error('store unavailable') }, onRejected: () => {} })
    await assert.rejects(drainSpool(dir, failing), /store unavailable/)
    failing.close()
    assert.deepEqual(await readdir(dir), ['hooks-20260928.jsonl.draining'])
    const accepted = []
    const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: () => {} })
    const watcher = await startSpoolDrain({ dir, ingest, intervalMs: 60_000 })
    try {
      assert.equal(accepted.length, 1)
      assert.deepEqual(await readdir(dir), [])
    } finally { watcher.close(); ingest.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
