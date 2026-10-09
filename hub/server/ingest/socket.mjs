import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import path from 'node:path'
import { createReorderBuffer } from './reorder.mjs'
import { dedupeKey, validateEnvelope } from './validate.mjs'
import { endpoint, ensurePrivateDir, isPipe } from '../../platform/index.mjs'

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
  const buffer = createReorderBuffer((rows, fromTimer) => {
    while (rows.length) {
      try { onEvent(rows[0]) } catch (error) {
        if (!fromTimer) for (const unhandled of rows) seen.delete(unhandled.dedupeKey)
        throw error
      }
      rows.shift()
    }
  }, { windowMs: reorderMs })
  function reject(raw, via, reason) {
    try { onRejected({ receivedAt: now(), via, reason, raw: '' }) } catch { /* A rejected hook must not stop live ingestion. */ }
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

/**
 * Listen for newline-delimited hook envelopes on `endpoint(runtimeDir, 'hooks')`: a 0600 Unix socket in a 0700
 * directory on POSIX, a named pipe on win32. On POSIX a runtime base or socket directory owned by another uid, or with
 * any group or world permission bit, is refused with ensurePrivateDir's error. A pipe has no file, so nothing is created, checked, chmodded or
 * unlinked for it; a pipe name already in use fails with EADDRINUSE. `fsOps` replaces the file system calls in tests.
 * @param {{ runtimeDir: string, ingest: object, platform?: string, uid?: number | null,
 *   fsOps?: { mkdirSync: typeof mkdirSync, chmodSync: typeof chmodSync, lstatSync: typeof lstatSync, unlinkSync: typeof unlinkSync } }} opts
 */
export async function startHookSocket({ runtimeDir, ingest, platform = process.platform, uid = process.getuid?.() ?? null,
  fsOps = { mkdirSync, chmodSync, lstatSync, unlinkSync } }) {
  const socketPath = endpoint(runtimeDir, 'hooks', { platform, uid })
  const pipe = isPipe(socketPath)
  if (!pipe) {
    // The base (XDG_RUNTIME_DIR, or a shared fallback such as /tmp/fleetmates-deck-<uid>) must be this user's and
    // private, as deckd requires; the socket's own directory is made 0700, then held to the same rule.
    await ensurePrivateDir(runtimeDir, { platform, uid })
    const dir = path.posix.dirname(socketPath)
    fsOps.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fsOps.chmodSync(dir, 0o700)
    await ensurePrivateDir(dir, { platform, uid })
  }
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
    if (error.code !== 'EADDRINUSE' || pipe) throw error
    // A socket file that is gone when inspected was closed by its listener in between: the path is free, listen again.
    const inspect = () => {
      try { return fsOps.lstatSync(socketPath) } catch (lstatError) { if (lstatError.code === 'ENOENT') return null
        throw lstatError }
    }
    const before = inspect()
    if (before) {
      if (!before.isSocket() || (uid !== null && before.uid !== uid) || !(await staleSocket(socketPath))) throw error
      const after = inspect()
      if (after && (before.dev !== after.dev || before.ino !== after.ino)) throw error
      if (after) fsOps.unlinkSync(socketPath)
    }
    await listen(server, socketPath)
  }
  if (!pipe) fsOps.chmodSync(socketPath, 0o600)
  return { path: socketPath, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
