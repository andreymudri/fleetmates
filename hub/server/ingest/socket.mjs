import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import path from 'node:path'
import { createReorderBuffer } from './reorder.mjs'
import { dedupeKey, validateEnvelope } from './validate.mjs'

const maxLine = 1024 * 1024

function staleSocket(socketPath) {
  return new Promise(resolve => {
    const probe = connect(socketPath)
    probe.setTimeout(100, () => { probe.destroy(); resolve(false) })
    probe.once('connect', () => { probe.destroy(); resolve(false) })
    probe.once('error', error => resolve(error.code === 'ECONNREFUSED'))
  })
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve() }) })
}

/** Create a common ingest path for live socket and spool envelopes. */
export function createIngestor({ onEvent, onRejected, reorderMs = 250, now = Date.now }) {
  const seen = new Set()
  const buffer = createReorderBuffer(rows => {
    for (let index = 0; index < rows.length; index++) {
      try { onEvent(rows[index]) } catch (error) {
        for (const unhandled of rows.slice(index)) seen.delete(unhandled.dedupeKey)
        throw error
      }
    }
  }, { windowMs: reorderMs })
  function reject(raw, via, reason) {
    onRejected({ receivedAt: now(), via, reason, raw: raw.slice(0, 16 * 1024) })
  }
  return {
    receive(raw, via = 'socket') {
      const parsed = validateEnvelope(raw)
      if (!parsed.ok) { reject(raw, via, parsed.reason); return false }
      const key = dedupeKey(parsed.value)
      if (seen.has(key)) return false
      seen.add(key)
      if (seen.size > 100_000) seen.delete(seen.values().next().value)
      buffer.push({ ...parsed.value, dedupeKey: key, hookTs: parsed.value.hookTs, receivedAt: now(), via })
      return true
    },
    rejectRaw: reject,
    flush() { buffer.flushAll() },
    close() { buffer.close() }
  }
}

/** Listen for newline-delimited hook envelopes on the private runtime socket. */
export async function startHookSocket({ runtimeDir, ingest }) {
  const dir = path.join(runtimeDir, 'fleetmates-deck')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const socketPath = path.join(dir, 'hooks.sock')
  const server = createServer(socket => {
    let pending = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      pending += chunk
      if (Buffer.byteLength(pending) > maxLine && !pending.includes('\n')) {
        ingest.rejectRaw(pending, 'socket', 'too_large')
        pending = ''
        socket.destroy()
        return
      }
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const raw = pending.slice(0, end)
        pending = pending.slice(end + 1)
        ingest.receive(raw, 'socket')
      }
    })
    socket.on('end', () => { if (pending) ingest.rejectRaw(pending, 'socket', 'partial_line') })
  })
  try {
    await listen(server, socketPath)
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    const before = lstatSync(socketPath)
    if (!before.isSocket() || before.uid !== process.getuid() || !(await staleSocket(socketPath))) throw error
    const after = lstatSync(socketPath)
    if (before.dev !== after.dev || before.ino !== after.ino) throw error
    unlinkSync(socketPath)
    await listen(server, socketPath)
  }
  chmodSync(socketPath, 0o600)
  return { path: socketPath, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
