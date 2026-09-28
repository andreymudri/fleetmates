import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { validateEnvelope } from '../../server/ingest/validate.mjs'
import { makeEnvelope } from '../../hook/deck-hook.mjs'

const fixtures = fileURLToPath(new URL('../fixtures/hooks/2.1.282/', import.meta.url))
const executable = fileURLToPath(new URL('../../hook/deck-hook.mjs', import.meta.url))

test('every committed Claude Code hook fixture validates in an envelope', async () => {
  for (const name of (await readdir(fixtures)).filter(name => name.endsWith('.json') && name !== 'MANIFEST.json')) {
    const hook = JSON.parse(await readFile(path.join(fixtures, name), 'utf8'))
    const envelope = { v: 1, deckHookVersion: '0.1.0', hookTs: 100, ptyId: null, claudePid: null, pidChain: [], truncated: false, hook }
    assert.equal(validateEnvelope(JSON.stringify(envelope)).ok, true, name)
  }
})

test('hook without a socket spools privately and exits silently', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deck-hook-'))
  try {
    const hook = JSON.parse(await readFile(path.join(fixtures, 'Stop.json'), 'utf8'))
    const child = spawnSync(process.execPath, [executable], { input: JSON.stringify(hook), encoding: 'utf8', env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime') }, timeout: 2000 })
    assert.equal(child.status, 0)
    assert.equal(child.stdout, '')
    assert.equal(child.stderr, '')
    const dir = path.join(home, 'state/fleetmates/deck/spool')
    const names = await readdir(dir)
    assert.equal(names.length, 1)
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.equal((await stat(path.join(dir, names[0]))).mode & 0o777, 0o600)
    const envelope = validateEnvelope(await readFile(path.join(dir, names[0]), 'utf8'))
    assert.equal(envelope.ok, true)
    assert.equal(envelope.value.hook.hook_event_name, 'Stop')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('malformed stdin does not change hook exit status or write output', () => {
  const child = spawnSync(process.execPath, [executable], { input: '{', encoding: 'utf8', timeout: 2000 })
  assert.equal(child.status, 0)
  assert.equal(child.stdout, '')
  assert.equal(child.stderr, '')
})

test('hook sends one complete line to the runtime socket without creating spool', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deck-hook-socket-'))
  const runtime = path.join(home, 'runtime')
  const socketDir = path.join(runtime, 'fleetmates-deck')
  const socketPath = path.join(socketDir, 'hooks.sock')
  await mkdir(socketDir, { recursive: true, mode: 0o700 })
  const received = []
  const server = createServer(socket => { socket.setEncoding('utf8'); socket.on('data', chunk => received.push(chunk)) })
  try {
    await new Promise(resolve => server.listen(socketPath, resolve))
    await chmod(socketPath, 0o600)
    const hook = JSON.parse(await readFile(path.join(fixtures, 'Stop.json'), 'utf8'))
    const child = spawn(process.execPath, [executable], { env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: runtime }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(JSON.stringify(hook))
    const output = []
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.on('data', chunk => output.push(chunk))
    const exit = await new Promise(resolve => child.on('close', resolve))
    assert.equal(exit, 0)
    assert.equal(Buffer.concat(output).length, 0)
    assert.equal(received.length, 1)
    assert.equal(validateEnvelope(received[0]).ok, true)
    await assert.rejects(readdir(path.join(home, 'state/fleetmates/deck/spool')), { code: 'ENOENT' })
  } finally { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }) }
})

test('hook truncates long tool input and stays within the line limit', () => {
  const envelope = makeEnvelope({ session_id: 's', transcript_path: '/home/you/t', cwd: '/repo', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: 'x'.repeat(70 * 1024) } }, { hookTs: 1 })
  assert.equal(envelope.truncated, true)
  assert.match(envelope.hook.tool_input.content, /truncated 6144 bytes/)
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 1024 * 1024)
  const hugeInput = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`part${index}`, 'x'.repeat(60 * 1024)]))
  const huge = makeEnvelope({ session_id: 's', transcript_path: '/home/you/t', cwd: '/repo', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: hugeInput }, { hookTs: 1 })
  assert.equal(huge.truncated, true)
  assert.equal(huge.hook.tool_input, undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) < 1024 * 1024)
  assert.equal(validateEnvelope(JSON.stringify(huge)).ok, true)
})

test('hook exits silently when stdin never finishes', async () => {
  const child = spawn(process.execPath, [executable], { stdio: ['pipe', 'pipe', 'pipe'] })
  const output = []
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => output.push(chunk))
  const started = Date.now()
  const code = await new Promise(resolve => child.on('close', resolve))
  assert.equal(code, 0)
  assert.equal(Buffer.concat(output).length, 0)
  assert.ok(Date.now() - started < 1000)
})
