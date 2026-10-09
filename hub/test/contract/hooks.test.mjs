import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { validateEnvelope } from '../../server/ingest/validate.mjs'
import { hookEndpoint, makeEnvelope } from '../../hook/deck-hook.mjs'
import { isWindows, posixTest } from '../helpers/platform.mjs'

const fixtures = fileURLToPath(new URL('../fixtures/hooks/2.1.282/', import.meta.url))
const executable = fileURLToPath(new URL('../../hook/deck-hook.mjs', import.meta.url))

/** Captured hook fixture sets: the earlier 2.1.282 regression set and the tested 2.1.285 set. */
const hookSets = ['2.1.282', '2.1.285'].map(v => fileURLToPath(new URL(`../fixtures/hooks/${v}/`, import.meta.url)))

/** Files in a hook set that are not hook payloads: the manifest, and a settings excerpt. */
const NOT_PAYLOADS = new Set(['MANIFEST.json', 'option2-rule.json'])

/**
 * Every hook payload in a captured set: each `.json` file except NOT_PAYLOADS, and each line
 * of a `.jsonl` sequence (a `{ hookTs, payload }` record).
 * @param {string} dir
 * @returns {Promise<{ name: string, hook: any }[]>}
 */
async function hookPayloads (dir) {
  const out = []
  for (const name of (await readdir(dir)).sort()) {
    if (NOT_PAYLOADS.has(name)) continue
    const text = await readFile(path.join(dir, name), 'utf8')
    if (name.endsWith('.json')) out.push({ name, hook: JSON.parse(text) })
    if (name.endsWith('.jsonl')) {
      text.split('\n').filter(Boolean).forEach((line, i) => out.push({ name: `${name}:${i + 1}`, hook: JSON.parse(line).payload }))
    }
  }
  return out
}

test('every committed Claude Code hook fixture validates in an envelope', async () => {
  for (const dir of hookSets) {
    const payloads = await hookPayloads(dir)
    assert.ok(payloads.length > 0, dir)
    for (const { name, hook } of payloads) {
      const label = `${path.basename(dir)}/${name}`
      assert.equal(typeof hook?.hook_event_name, 'string', label)
      const envelope = makeEnvelope(hook, { hookTs: 100, ptyId: null })
      assert.equal(envelope.hook.session_id, hook.session_id, label)
      assert.equal(envelope.hook.hook_event_name, hook.hook_event_name, label)
      assert.equal(validateEnvelope(JSON.stringify(envelope)).ok, true, label)
    }
  }
})

test('the 2.1.285 sequence is read line by line as payloads', async () => {
  const lines = (await hookPayloads(hookSets[1])).filter(({ name }) => name.startsWith('sequence.approve-safe.jsonl:'))
  assert.ok(lines.length > 1, 'the approve-safe sequence holds more than one payload')
})

test('option2-rule.json is a settings excerpt, not a hook payload, and is skipped', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deck-hook-set-'))
  try {
    await writeFile(path.join(dir, 'Stop.json'), await readFile(path.join(fixtures, 'Stop.json'), 'utf8'))
    await writeFile(path.join(dir, 'option2-rule.json'), JSON.stringify({ allow: ['Bash(node --test:*)'] }))
    assert.deepEqual((await hookPayloads(dir)).map(({ name }) => name), ['Stop.json'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

posixTest('hook without a socket spools privately and exits silently', { reason: 'spool file and directory modes' }, async () => {
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
    const after = await readdir(dir)
    assert.equal(after.length, 2)
    const responseFile = after.find(name => name !== names[0])
    const spool = await readFile(path.join(dir, responseFile), 'utf8')
    assert.equal(spool.includes('SYNTHETIC_CONFIDENTIAL_NOTE_123'), false)
    assert.equal(spool.trimEnd().split('\n').length, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

posixTest('hook tightens a preexisting permissive spool file before appending', { reason: 'spool file modes' }, async () => {
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
    const created = (await readdir(dir)).find(name => name !== path.basename(file))
    assert.match(created, /^hooks-\d{8}-\d{13}-[a-f0-9]{12}\.jsonl$/)
    assert.equal(validateEnvelope(await readFile(path.join(dir, created), 'utf8')).ok, true)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('malformed stdin does not change hook exit status or write output', () => {
  const child = spawnSync(process.execPath, [executable], { input: '{', encoding: 'utf8', timeout: 2000 })
  assert.equal(child.status, 0)
  assert.equal(child.stdout, '')
  assert.equal(child.stderr, '')
})

posixTest('hook finds a node process running a claude entrypoint in its parent chain', { reason: 'the hook reads /proc or ps, which win32 does not have' }, async () => {
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
  const hookEnv = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: runtime }
  // The hook's own endpoint rule: <runtime>/fleetmates-deck/hooks.sock here, a named pipe on win32.
  const socketPath = hookEndpoint(hookEnv)
  if (!isWindows) assert.equal(socketPath, path.join(socketDir, 'hooks.sock'))
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
    if (!isWindows) await chmod(socketPath, 0o600)
    const hook = JSON.parse(await readFile(path.join(fixtures, 'Stop.json'), 'utf8'))
    // The 200 ms budget is the hook script's own run, which its in-script timer bounds. Node's
    // interpreter boot comes before the script and grows with machine load, so the clock is read
    // inside the child: a preload writes performance.now() to fd 3 once before the hook module
    // loads and once at process exit.
    const clock = path.join(home, 'clock.mjs')
    await writeFile(clock, "import { writeSync } from 'node:fs'\nwriteSync(3, `${performance.now()}\\n`)\nprocess.on('exit', () => { writeSync(3, `${performance.now()}\\n`) })\n")
    const child = spawn(process.execPath, ['--import', clock, executable], { env: hookEnv, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    child.stdin.end(JSON.stringify(hook))
    const output = []
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.on('data', chunk => output.push(chunk))
    let clockText = ''
    let childTimer
    let startTimer
    let exit
    try {
      exit = await Promise.race([
        new Promise(resolve => child.on('close', resolve)),
        new Promise((_, reject) => {
          // The 500 ms timer below is armed by the preload's first clock line, so a child that
          // hangs before the preload writes would never meet it. This startup bound is generous
          // because it covers Node's boot under load, which the 200 ms budget deliberately leaves out.
          startTimer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('socket hook never started its clock')) }, 10_000)
          child.stdio[3].setEncoding('utf8')
          child.stdio[3].on('data', chunk => {
            const first = !clockText.includes('\n')
            clockText += chunk
            if (first && clockText.includes('\n')) {
              clearTimeout(startTimer)
              childTimer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('socket hook did not exit')) }, 500)
            }
          })
        }),
      ])
    } finally { clearTimeout(startTimer); clearTimeout(childTimer) }
    const [scriptStart, scriptExit] = clockText.trim().split('\n').map(Number)
    assert.ok(Number.isFinite(scriptStart) && Number.isFinite(scriptExit), 'socket hook clock did not report')
    assert.ok(scriptExit - scriptStart < 200, 'socket hook exceeded its 200 ms budget')
    assert.equal(exit, 0)
    assert.equal(Buffer.concat(output).length, 0)
    let wireTimer
    let wire
    try {
      wire = await Promise.race([
        wireDone,
        new Promise((_, reject) => { wireTimer = setTimeout(() => reject(Error('socket hook did not deliver a line')), 300) }),
      ])
    } finally { clearTimeout(wireTimer) }
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
    api_key: 'SYNTHETIC_API_KEY_456',
  }, { hookTs: 1 })
  assert.equal(envelope.hook.tool_response, undefined)
  assert.equal(envelope.hook.api_key, undefined)
  assert.equal(JSON.stringify(envelope).includes('SYNTHETIC_CONFIDENTIAL_NOTE_123'), false)
  assert.equal(JSON.stringify(envelope).includes('SYNTHETIC_API_KEY_456'), false)
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
  let timer
  let code
  try {
    code = await Promise.race([
      new Promise(resolve => child.on('close', resolve)),
      new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('hook exceeded its exit budget')) }, 1000) }),
    ])
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL') }
  assert.equal(code, 0)
  assert.equal(Buffer.concat(output).length, 0)
  assert.ok(Date.now() - started < 1000)
})
