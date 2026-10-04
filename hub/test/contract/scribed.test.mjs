import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import {
  decodeEvent,
  defaultSocketPath,
  encodeCommand,
  ProtocolError,
  status,
  subscribe
} from '../../server/adapters/scribed.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '..', 'fixtures', 'scribed', 'd4ffb9d')

/**
 * @param {string} name
 * @returns {string[]}
 */
function lines (name) {
  return readFileSync(path.join(fixtures, name), 'utf8').split('\n').filter((l) => l !== '')
}

const JSON_PARSE_PREFIX = 'linha não é JSON válido: '

test('every events.jsonl line decodes to the object the daemon wrote', () => {
  const events = lines('events.jsonl')
  assert.ok(events.length > 0)
  for (const line of events) {
    assert.deepEqual(decodeEvent(line), JSON.parse(line), line)
    assert.deepEqual(decodeEvent(Buffer.from(line + '\n', 'utf8')), JSON.parse(line), line)
  }
})

test('every invalid.jsonl event line throws with the daemon message', () => {
  const invalid = lines('invalid.jsonl').map((l) => JSON.parse(l))
  const eventSide = invalid.filter((r) => r.side === 'event')
  assert.ok(eventSide.length > 0)
  for (const { line, message } of eventSide) {
    assert.throws(() => decodeEvent(line), (err) => {
      assert.ok(err instanceof Error)
      if (message.startsWith(JSON_PARSE_PREFIX)) {
        assert.ok(err.message.startsWith(JSON_PARSE_PREFIX), err.message)
      } else {
        assert.equal(err.message, message)
      }
      return true
    }, line)
  }
})

test('encodeCommand refuses every invalid.jsonl command line that is valid JSON', () => {
  const invalid = lines('invalid.jsonl').map((l) => JSON.parse(l))
  const commandSide = invalid.filter((r) => r.side === 'command')
  assert.ok(commandSide.length > 0)
  let checked = 0
  for (const { line, message } of commandSide) {
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    checked++
    assert.throws(() => encodeCommand(parsed), { message }, line)
  }
  assert.ok(checked > 0)
})

test('encodeCommand output for each commands.jsonl line parses deep-equal, raw UTF-8', () => {
  const commands = lines('commands.jsonl')
  assert.ok(commands.length > 0)
  for (const line of commands) {
    const encoded = encodeCommand(JSON.parse(line))
    assert.ok(encoded.endsWith('\n'))
    assert.equal(encoded.indexOf('\n'), encoded.length - 1)
    assert.deepEqual(JSON.parse(encoded), JSON.parse(line))
    assert.ok(!encoded.includes('\\u'), encoded)
  }
  const accented = encodeCommand({ cmd: 'ask', question: 'e a sessão já começou?' })
  assert.ok(!accented.includes('\\u'), accented)
  assert.ok(accented.includes('sessão já começou'))
})

const PLACEHOLDER_TAGS = ['pessoal', 'client-a', 'client-b', 'acme']

/**
 * Push every string `tag` value found anywhere inside `value` onto `out`.
 * @param {unknown} value
 * @param {string[]} out
 */
function collectTags (value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectTags(item, out)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'tag' && typeof inner === 'string') out.push(inner)
      else collectTags(inner, out)
    }
  }
}

test('fixtures use placeholder tags only', () => {
  /** @type {string[]} */
  const tags = []
  for (const line of [...lines('commands.jsonl'), ...lines('events.jsonl')]) {
    collectTags(JSON.parse(line), tags)
  }
  for (const { line, message } of lines('invalid.jsonl').map((l) => JSON.parse(l))) {
    try { collectTags(JSON.parse(line), tags) } catch {}
    for (const m of message.matchAll(/tag desconhecida: '([^']*)'/g)) tags.push(m[1])
  }
  assert.ok(tags.length > 0)
  for (const tag of tags) assert.ok(PLACEHOLDER_TAGS.includes(tag), `tag ${JSON.stringify(tag)} is not a placeholder`)
})

test('decodeEvent throws a ProtocolError with code unknown_type for a type outside the closed list', () => {
  assert.throws(() => decodeEvent('{"type": "pin", "t": 1}'), (err) => {
    assert.ok(err instanceof ProtocolError)
    assert.equal(/** @type {any} */ (err).code, 'unknown_type')
    assert.match(/** @type {Error} */ (err).message, /^type desconhecido: 'pin'/)
    return true
  })
})

test('encodeCommand keeps only the keys of the command', () => {
  assert.equal(encodeCommand({ cmd: 'status', extra: 1 }), '{"cmd":"status"}\n')
})

test('decodeEvent ignores unknown keys and rejects booleans in number fields', () => {
  assert.deepEqual(
    decodeEvent('{"type":"tail","text":"x","later":true}'),
    { type: 'tail', text: 'x' }
  )
  assert.throws(
    () => decodeEvent('{"type":"status","recording":false,"session_id":null,"tag":null,"elapsed_s":true,"routed_apps":[]}'),
    { message: 'status.elapsed_s: esperado número, veio bool' }
  )
  assert.throws(
    () => decodeEvent('{"type":"history","asks":[{"t":1,"question":"q","answer":"a","context_minutes":true}]}'),
    { message: 'AskRecord.context_minutes: esperado número, veio bool' }
  )
  assert.throws(() => decodeEvent(''), { message: 'linha vazia' })
  assert.throws(() => decodeEvent(Buffer.from([0x7b, 0xff, 0x7d])), /^ProtocolError: linha não é UTF-8 válido/)
})

test('defaultSocketPath follows XDG_RUNTIME_DIR and has no fallback', () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: '/run/user/4242' }), '/run/user/4242/turbidassist.sock')
  assert.throws(() => defaultSocketPath({}), /XDG_RUNTIME_DIR/)
  assert.throws(() => defaultSocketPath({ XDG_RUNTIME_DIR: '' }), /XDG_RUNTIME_DIR/)
})

/**
 * Start a fake scribed on a socket inside a private runtime dir.
 * @param {(socket: net.Socket, cmd: any) => void} onCommand
 */
async function fakeScribed (onCommand) {
  const rt = await makeRuntimeDir()
  const socketPath = path.join(rt.dir, 'turbidassist.sock')
  /** @type {any[]} */
  const received = []
  const server = net.createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const cmd = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        received.push(cmd)
        onCommand(socket, cmd)
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(socketPath, () => resolve(undefined)))
  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await rt.cleanup()
  }
  return { socketPath, received, server, close }
}

const IDLE = '{"type": "status", "recording": false, "session_id": null, "tag": null, "elapsed_s": 0, "routed_apps": []}\n'
const REC = '{"type": "status", "recording": true, "session_id": "2026-09-08T14-00-12", "tag": "acme", "elapsed_s": 812, "routed_apps": ["Chromium"]}\n'

test('status sends one status command and resolves with the decoded answer', async () => {
  const fake = await fakeScribed((socket, cmd) => {
    if (cmd.cmd === 'status') socket.write(REC)
  })
  try {
    const got = await status({ socketPath: fake.socketPath })
    assert.deepEqual(got, JSON.parse(REC))
    assert.deepEqual(fake.received, [{ cmd: 'status' }])
  } finally {
    await fake.close()
  }
})

test('status rejects with the daemon error message', async () => {
  const fake = await fakeScribed((socket) => {
    socket.write('{"type": "error", "cmd": "?", "message": "cmd desconhecido"}\n')
  })
  try {
    await assert.rejects(status({ socketPath: fake.socketPath }), (err) => {
      assert.equal(/** @type {any} */ (err).name, 'ScribedError')
      assert.equal(/** @type {any} */ (err).cmd, '?')
      assert.equal(/** @type {Error} */ (err).message, 'cmd desconhecido')
      return true
    })
  } finally {
    await fake.close()
  }
})

test('status times out when the daemon never answers', async () => {
  const fake = await fakeScribed(() => {})
  try {
    await assert.rejects(status({ socketPath: fake.socketPath, timeoutMs: 100 }), { name: 'ScribedTimeout' })
  } finally {
    await fake.close()
  }
})

test('status rejects as unavailable when nothing listens', async () => {
  const rt = await makeRuntimeDir()
  try {
    await assert.rejects(status({ socketPath: path.join(rt.dir, 'turbidassist.sock') }), { name: 'ScribedUnavailable' })
  } finally {
    await rt.cleanup()
  }
})

test('subscribe delivers the status then two transcript lines in order', async () => {
  const t1 = '{"type": "transcript", "event": {"t0": 12.48, "t1": 15.9, "source": "mic", "text": "vou subir o fix"}}\n'
  const t2 = '{"type": "transcript", "event": {"t0": 16.0, "t1": 18.2, "source": "room", "text": "então tá, sessão já começou"}}\n'
  const fake = await fakeScribed((socket, cmd) => {
    if (cmd.cmd !== 'subscribe') return
    // split mid-line and inside a multibyte character to exercise the framing
    const all = Buffer.from(IDLE + t1 + t2, 'utf8')
    const cut = all.indexOf(Buffer.from('ã', 'utf8')) + 1
    socket.write(all.subarray(0, cut))
    setTimeout(() => socket.write(all.subarray(cut)), 20)
  })
  try {
    /** @type {any[]} */
    const got = []
    const closed = new Promise((resolve) => {
      const sub = subscribe({
        socketPath: fake.socketPath,
        onEvent: (evt) => {
          got.push(evt)
          if (got.length === 3) sub.close()
        },
        onClose: (err) => resolve(err)
      })
    })
    assert.equal(await closed, null)
    assert.deepEqual(got, [JSON.parse(IDLE), JSON.parse(t1), JSON.parse(t2)])
    assert.deepEqual(fake.received, [{ cmd: 'subscribe' }])
  } finally {
    await fake.close()
  }
})

test('subscribe reports the daemon closing the stream', async () => {
  const fake = await fakeScribed((socket, cmd) => {
    if (cmd.cmd === 'subscribe') socket.end(IDLE)
  })
  try {
    /** @type {any[]} */
    const got = []
    const err = await new Promise((resolve) => {
      subscribe({ socketPath: fake.socketPath, onEvent: (e) => got.push(e), onClose: resolve })
    })
    assert.equal(err, null)
    assert.deepEqual(got, [JSON.parse(IDLE)])
  } finally {
    await fake.close()
  }
})

test('subscribe closes with an error on a line that does not decode', async () => {
  const fake = await fakeScribed((socket, cmd) => {
    if (cmd.cmd === 'subscribe') socket.write('{"type": "boom"}\n')
  })
  try {
    const err = await new Promise((resolve) => {
      subscribe({ socketPath: fake.socketPath, onEvent: () => {}, onClose: resolve })
    })
    assert.ok(err instanceof Error)
    assert.match(err.message, /^type desconhecido: 'boom'/)
  } finally {
    await fake.close()
  }
})
