import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
    const envelope = makeEnvelope(hook, { hookTs: 100, ptyId: null })
    assert.equal(envelope.hook.session_id, hook.session_id, name)
    assert.equal(envelope.hook.hook_event_name, hook.hook_event_name, name)
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
    const responseHook = JSON.parse(await readFile(path.join(fixtures, 'PostToolUse.Read.json'), 'utf8'))
    responseHook.tool_response = { content: 'SYNTHETIC_CONFIDENTIAL_NOTE_123' }
    const responseChild = spawnSync(process.execPath, [executable], { input: JSON.stringify(responseHook), encoding: 'utf8', env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime') }, timeout: 2000 })
    assert.equal(responseChild.status, 0)
    const spool = await readFile(path.join(dir, names[0]), 'utf8')
    assert.equal(spool.includes('SYNTHETIC_CONFIDENTIAL_NOTE_123'), false)
    assert.equal(spool.trimEnd().split('\n').length, 2)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('hook tightens a preexisting permissive spool file before appending', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deck-hook-mode-'))
  try {
    const dir = path.join(home, 'state/fleetmates/deck/spool')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const file = path.join(dir, `hooks-${day}.jsonl`)
    await writeFile(file, '')
    await chmod(file, 0o644)
    assert.equal((await stat(file)).mode & 0o777, 0o644)
    const hook = JSON.parse(await readFile(path.join(fixtures, 'Stop.json'), 'utf8'))
    const child = spawnSync(process.execPath, [executable], { input: JSON.stringify(hook), encoding: 'utf8', env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime') }, timeout: 2000 })
    assert.equal(child.status, 0)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal(validateEnvelope(await readFile(file, 'utf8')).ok, true)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('malformed stdin does not change hook exit status or write output', () => {
  const child = spawnSync(process.execPath, [executable], { input: '{', encoding: 'utf8', timeout: 2000 })
  assert.equal(child.status, 0)
  assert.equal(child.stdout, '')
  assert.equal(child.stderr, '')
})

test('hook finds a node process running a claude entrypoint in its parent chain', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deck-hook-parent-'))
  try {
    const fakeClaude = path.join(home, 'claude')
    await writeFile(path.join(home, 'package.json'), '{"type":"module"}')
    await writeFile(fakeClaude, "import { spawnSync } from 'node:child_process'\nconst result = spawnSync(process.execPath, [process.argv[2]], { input: process.argv[3], encoding: 'utf8', env: process.env })\nprocess.stdout.write(String(process.pid))\nprocess.exit(result.status ?? 1)\n")
    const hook = JSON.parse(await readFile(path.join(fixtures, 'Stop.json'), 'utf8'))
    const child = spawnSync(process.execPath, [fakeClaude, executable, JSON.stringify(hook)], {
      encoding: 'utf8', env: { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime') }, timeout: 3000,
    })
    assert.equal(child.status, 0)
    const dir = path.join(home, 'state/fleetmates/deck/spool')
    const [name] = await readdir(dir)
    const envelope = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
    assert.equal(envelope.claudePid, Number(child.stdout))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('hook sends one complete line to the runtime socket without creating spool', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'deck-hook-socket-'))
  const runtime = path.join(home, 'runtime')
  const socketDir = path.join(runtime, 'fleetmates-deck')
  const socketPath = path.join(socketDir, 'hooks.sock')
  await mkdir(socketDir, { recursive: true, mode: 0o700 })
  let resolveWire
  const wireDone = new Promise(resolve => { resolveWire = resolve })
  const server = createServer(socket => {
    const chunks = []
    socket.setEncoding('utf8')
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('end', () => resolveWire(chunks.join('')))
  })
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
    const wire = await wireDone
    assert.equal(wire.endsWith('\n'), true)
    assert.equal(wire.indexOf('\n'), wire.length - 1)
    assert.equal(validateEnvelope(wire).ok, true)
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

test('hook envelope excludes unneeded tool responses before socket or spool delivery', () => {
  const envelope = makeEnvelope({
    session_id: 's', transcript_path: '/home/you/t', cwd: '/repo', hook_event_name: 'PostToolUse',
    tool_name: 'Read', tool_input: { file_path: '/repo/a' },
    tool_response: { content: 'SYNTHETIC_CONFIDENTIAL_NOTE_123' },
  }, { hookTs: 1 })
  assert.equal(envelope.hook.tool_response, undefined)
  assert.equal(JSON.stringify(envelope).includes('SYNTHETIC_CONFIDENTIAL_NOTE_123'), false)
  assert.deepEqual(envelope.hook.tool_input, { file_path: '/repo/a' })
})

test('deep tool input reaches validation instead of being dropped by the hook', () => {
  let nested = {}
  for (let depth = 0; depth < 3000; depth++) nested = { x: nested }
  const hook = { session_id: 's', transcript_path: '/home/you/t', cwd: '/repo', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: nested }
  const envelope = makeEnvelope(hook, { hookTs: 1 })
  assert.equal(validateEnvelope(JSON.stringify(envelope)).reason, 'too_deep')
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
