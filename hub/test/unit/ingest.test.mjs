import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createIngestor, startHookSocket } from '../../server/ingest/socket.mjs'
import { drainSpool, startSpoolDrain } from '../../server/ingest/spool.mjs'
import { createReorderBuffer } from '../../server/ingest/reorder.mjs'
import { validateEnvelope } from '../../server/ingest/validate.mjs'

const hook = { session_id: 's1', transcript_path: '/home/you/.claude/projects/x/a.jsonl', cwd: '/repo', hook_event_name: 'Stop', stop_hook_active: false }
const line = (hookTs = 1, payload = hook) => JSON.stringify({ v: 1, deckHookVersion: '0.1.0', hookTs, ptyId: null, claudePid: null, pidChain: [], truncated: false, hook: payload }) + '\n'
const uniqueSpool = 'hooks-20260928-1790000000000-aabbccddeeff.jsonl'

test('validation accepts fixture shape and rejects drift, unknown events and malformed lines', () => {
  assert.equal(validateEnvelope(line()).ok, true)
  assert.match(validateEnvelope('{').reason, /invalid_json/)
  assert.match(validateEnvelope(line(1, { ...hook, hook_event_name: 'Mystery' })).reason, /unknown_event/)
  assert.match(validateEnvelope(line(1, { ...hook, session_id: 42 })).reason, /session_id/)
  assert.match(validateEnvelope(line(1, { ...hook, stop_hook_active: 'false' })).reason, /stop_hook_active/)
  assert.match(validateEnvelope(line(1).repeat(20000)).reason, /too_large/)
})

test('rejected event diagnostics do not retain raw hook content', () => {
  const rejected = []
  const ingest = createIngestor({ onEvent: () => {}, onRejected: row => rejected.push(row) })
  try {
    const raw = line(1, { ...hook, transcript_path: undefined, tool_response: { content: 'SYNTHETIC_SECRET_456' } })
    assert.equal(ingest.receive(raw), false)
    assert.equal(rejected[0].reason, 'invalid_transcript_path')
    assert.equal(rejected[0].raw.includes('SYNTHETIC_SECRET_456'), false)
  } finally { ingest.close() }
})

test('failed rejection storage does not throw from socket ingestion', () => {
  const accepted = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: () => { throw Error('database busy') }, reorderMs: 0 })
  try {
    assert.equal(ingest.receive('{'), false)
    assert.equal(ingest.receive(line(2)), true)
    ingest.flush()
    assert.equal(accepted.length, 1)
  } finally { ingest.close() }
})

test('deep nested hook input is rejected without crashing ingestion', () => {
  let nested = {}
  for (let depth = 0; depth < 3000; depth++) nested = { x: nested }
  const deep = line(1, { ...hook, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: nested })
  assert.ok(Buffer.byteLength(deep) < 1024 * 1024)
  assert.match(validateEnvelope(deep).reason, /too_deep/)
  const accepted = []
  const rejected = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: row => rejected.push(row), reorderMs: 0 })
  try {
    assert.equal(ingest.receive(deep), false)
    ingest.receive(line(2))
    ingest.flush()
    assert.equal(accepted.length, 1)
    assert.equal(rejected[0].reason, 'too_deep')
  } finally { ingest.close() }
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

test('dedupe identity ignores JSON object key order across transports', () => {
  const accepted = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: () => {}, reorderMs: 0 })
  try {
    const reordered = Object.fromEntries(Object.entries(hook).reverse())
    assert.equal(ingest.receive(line(10, hook), 'socket'), true)
    assert.equal(ingest.receive(line(10, reordered), 'spool'), false)
    ingest.flush()
    assert.equal(accepted.length, 1)
  } finally { ingest.close() }
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

test('unlisted hook events follow SessionStart at equal timestamps', () => {
  const output = []
  const buffer = createReorderBuffer(batch => output.push(...batch.map(row => row.hook.hook_event_name)), { windowMs: 250 })
  try {
    for (const event of ['SubagentStart', 'CwdChanged', 'SessionStart']) {
      buffer.push({ hookTs: 100, hook: { session_id: 's1', hook_event_name: event } })
    }
    buffer.flushAll()
    assert.deepEqual(output, ['SessionStart', 'SubagentStart', 'CwdChanged'])
  } finally { buffer.close() }
})

test('timed ingest retries failed delivery without crashing or repeating applied rows', async () => {
  const accepted = []
  let fail = true
  const ingest = createIngestor({
    onEvent: row => {
      if (row.hookTs === 2 && fail) throw Error('database busy')
      accepted.push(row.hookTs)
    },
    onRejected: () => {}, reorderMs: 1,
  })
  try {
    assert.equal(ingest.receive(line(1)), true)
    assert.equal(ingest.receive(line(2)), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(accepted, [1])
    fail = false
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.deepEqual(accepted, [1, 2])
    assert.equal(ingest.receive(line(2)), false)
  } finally { ingest.close() }
})

test('socket rejects partial lines and accepts complete lines', async () => {
  const dir = await mkdtemp(path.join('/tmp/hx', 'ingest-'))
  const accepted = []
  const rejected = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: row => rejected.push(row), reorderMs: 0 })
  const server = await startHookSocket({ runtimeDir: dir, ingest })
  try {
    assert.equal((await stat(server.path)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(server.path))).mode & 0o777, 0o700)
    const { connect } = await import('node:net')
    let nested = {}
    for (let depth = 0; depth < 3000; depth++) nested = { x: nested }
    const deep = line(0, { ...hook, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: nested })
    await new Promise(resolve => { const socket = connect(server.path); socket.on('connect', () => socket.end(deep)); socket.on('close', resolve) })
    await new Promise(resolve => { const socket = connect(server.path); socket.on('connect', () => socket.end(line())); socket.on('close', resolve) })
    await new Promise(resolve => { const socket = connect(server.path); socket.on('connect', () => socket.end('{')); socket.on('close', resolve) })
    ingest.flush()
    assert.equal(accepted.length, 1)
    assert.deepEqual(rejected.map(row => row.reason), ['too_deep', 'partial_line'])
  } finally { await server.close(); ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('socket listener restarts after an unclean exit without replacing a live listener', async () => {
  const dir = await mkdtemp(path.join('/tmp/hx', 'stale-socket-'))
  const moduleUrl = new URL('../../server/ingest/socket.mjs', import.meta.url).href
  const childScript = `import {startHookSocket} from ${JSON.stringify(moduleUrl)}; await startHookSocket({runtimeDir:process.argv[1],ingest:{receive(){},rejectRaw(){}}}); console.log('ready')`
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    let timer
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          child.stdout.once('data', resolve)
          child.once('error', reject)
          child.once('close', code => reject(Error(`socket setup exited before ready: ${code}`)))
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('socket setup did not become ready')), 1000) }),
      ])
    } finally { clearTimeout(timer) }
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('close', resolve))
    const ingest = createIngestor({ onEvent: () => {}, onRejected: () => {} })
    const server = await startHookSocket({ runtimeDir: dir, ingest })
    try { await assert.rejects(startHookSocket({ runtimeDir: dir, ingest }), { code: 'EADDRINUSE' }) } finally { await server.close(); ingest.close() }
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }) }
})

test('spool drain replays sorted lines and retains a new append file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-'))
  const accepted = []
  const rejected = []
  let replaced = false
  const ingest = createIngestor({ onEvent: row => {
    accepted.push(row)
    if (!replaced) { writeFileSync(path.join(dir, uniqueSpool), line(4)); replaced = true }
  }, onRejected: row => rejected.push(row), reorderMs: 0 })
  try {
    await writeFile(path.join(dir, uniqueSpool), line(3) + line(1, { ...hook, session_id: 's2' }) + '{\n')
    await drainSpool(dir, ingest)
    ingest.flush()
    assert.deepEqual(accepted.map(row => row.hookTs), [1, 3])
    assert.equal(rejected.length, 1)
    assert.deepEqual(await readdir(dir), [uniqueSpool])
    assert.equal(await readFile(path.join(dir, uniqueSpool), 'utf8'), line(4))
  } finally { ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('spool drain reads an interrupted drain before a newer same-day spool', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-restart-'))
  const accepted = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: () => {}, reorderMs: 0 })
  try {
    await writeFile(path.join(dir, `${uniqueSpool}.draining`), line(1, { ...hook, session_id: 'old' }))
    await writeFile(path.join(dir, uniqueSpool), line(2, { ...hook, session_id: 'new' }))
    await drainSpool(dir, ingest)
    ingest.flush()
    assert.deepEqual(accepted.map(row => row.hook.session_id), ['old', 'new'])
    assert.deepEqual(await readdir(dir), [])
  } finally { ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('spool drain reads a line appended through a descriptor opened before rename', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-open-'))
  const file = path.join(dir, 'hooks-20260928.jsonl')
  await writeFile(file, line(1))
  const fd = openSync(file, 'a')
  const accepted = []
  const ingest = createIngestor({ onEvent: row => { accepted.push(row.hookTs); if (row.hookTs === 1) writeSync(fd, line(2)) }, onRejected: () => {}, reorderMs: 0 })
  try {
    await drainSpool(dir, ingest)
    assert.deepEqual(accepted, [1, 2])
    assert.deepEqual(await readdir(dir), ['hooks-20260928.jsonl.draining'])
  } finally { closeSync(fd); ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('spool drain can replay a late write through an open legacy descriptor', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-late-'))
  const file = path.join(dir, 'hooks-20260928.jsonl')
  const accepted = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row.hookTs), onRejected: () => {}, reorderMs: 0 })
  let fd
  try {
    await writeFile(file, line(1))
    fd = openSync(file, 'a')
    await drainSpool(dir, ingest)
    writeSync(fd, line(2))
    closeSync(fd)
    fd = null
    await drainSpool(dir, ingest)
    assert.deepEqual(accepted, [1, 2])
  } finally { if (fd !== undefined && fd !== null) closeSync(fd); ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('atomic spool files replay together in event order without per-file delay', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-atomic-'))
  const accepted = []
  const ingest = createIngestor({ onEvent: row => accepted.push(row.hook.hook_event_name), onRejected: () => {}, reorderMs: 0 })
  try {
    const prefix = 'hooks-20260928-1790000000000-'
    await writeFile(path.join(dir, `${prefix}aaaaaaaaaaaa.jsonl`), line(1, hook))
    await writeFile(path.join(dir, `${prefix}bbbbbbbbbbbb.jsonl`), line(1, { ...hook, hook_event_name: 'SessionStart', source: 'startup' }))
    await writeFile(path.join(dir, `${prefix}cccccccccccc.jsonl`), line(2, { ...hook, hook_event_name: 'SessionEnd', reason: 'exit' }))
    await writeFile(path.join(dir, `${prefix}dddddddddddd.jsonl`), line(3, { ...hook, hook_event_name: 'UserPromptSubmit', prompt: 'next' }))
    const started = Date.now()
    await drainSpool(dir, ingest)
    assert.ok(Date.now() - started < 650, 'atomic files should not wait for legacy append grace periods')
    assert.deepEqual(accepted, ['SessionStart', 'Stop', 'SessionEnd', 'UserPromptSubmit'])
    assert.deepEqual(await readdir(dir), [])
  } finally { ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('mixed legacy and atomic spool files replay in hook-time order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-mixed-'))
  const accepted = []
  const ingest = createIngestor({ onEvent: row => accepted.push(`${row.hookTs}:${row.hook.hook_event_name}`), onRejected: () => {}, reorderMs: 0 })
  try {
    await writeFile(path.join(dir, 'hooks-20260928.jsonl'), line(2, { ...hook, hook_event_name: 'UserPromptSubmit', prompt: 'next' }))
    await writeFile(path.join(dir, 'hooks-20260928-0000000000001-aaaaaaaaaaaa.jsonl'), line(1, { ...hook, hook_event_name: 'SessionStart', source: 'startup' }))
    await drainSpool(dir, ingest)
    assert.deepEqual(accepted, ['1:SessionStart', '2:UserPromptSubmit'])
  } finally { ingest.close(); await rm(dir, { recursive: true, force: true }) }
})

test('startup spool drain applies rows before returning and leaves failed files for retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-start-'))
  try {
    await writeFile(path.join(dir, uniqueSpool), line(1))
    const failing = createIngestor({ onEvent: () => { throw Error('store unavailable') }, onRejected: () => {} })
    await assert.rejects(drainSpool(dir, failing), /store unavailable/)
    failing.close()
    assert.deepEqual(await readdir(dir), [`${uniqueSpool}.draining`])
    const accepted = []
    const ingest = createIngestor({ onEvent: row => accepted.push(row), onRejected: () => {} })
    const watcher = await startSpoolDrain({ dir, ingest, intervalMs: 60_000 })
    try {
      assert.equal(accepted.length, 1)
      assert.deepEqual(await readdir(dir), [])
    } finally { watcher.close(); ingest.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a failed spool apply can retry on the same ingestor without losing its dedupe key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-spool-retry-'))
  let fail = true
  const accepted = []
  const ingest = createIngestor({ onEvent: row => { if (fail) throw Error('store unavailable'); accepted.push(row.hookTs) }, onRejected: () => {} })
  try {
    await writeFile(path.join(dir, uniqueSpool), line(1))
    await assert.rejects(drainSpool(dir, ingest), /store unavailable/)
    fail = false
    await drainSpool(dir, ingest)
    assert.deepEqual(accepted, [1])
    assert.deepEqual(await readdir(dir), [])
  } finally { ingest.close(); await rm(dir, { recursive: true, force: true }) }
})
