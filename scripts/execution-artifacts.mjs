import { constants } from 'node:fs'
import { mkdir, open, lstat, realpath, opendir, link, unlink, rmdir, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { markerRef } from './workflow-lifecycle.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
export const RETENTION_LIMITS = Object.freeze({ maxArtifactBytes: 16 * 1024 * 1024, maxRunBytes: 256 * 1024 * 1024, maxAgeMs: 365 * 24 * 60 * 60 * 1000 })
const UPPER = RETENTION_LIMITS
const MAX_FILES = 4096
const TRUST = 'Private modes and no-follow checks do not isolate hostile processes with the same UID. Live recovery references must be independently reconciled by the caller.'

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
      || keys.some(key => { const d = Object.getOwnPropertyDescriptor(value, key); return !d.enumerable || !Object.hasOwn(d, 'value') })) throw new Error(`Invalid ${label} fields`)
}
function policy(raw) {
  exact(raw, Object.keys(UPPER), 'retention')
  for (const key of Object.keys(UPPER)) if (!Number.isSafeInteger(raw[key]) || raw[key] <= 0 || raw[key] > UPPER[key]) throw new Error(`Invalid retention ${key} bound`)
  return { ...raw }
}
function kindIdentity(kind) {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(kind)) throw new Error('Invalid artifact kind')
}
function referenceIdentity(raw, runId) {
  markerRef(runId, 'suspended')
  exact(raw, ['version', 'runId', 'kind', 'sha256', 'byteLength'], 'artifact reference')
  if (raw.version !== 1 || raw.runId !== runId || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)
      || !Number.isSafeInteger(raw.byteLength) || raw.byteLength < 0 || raw.byteLength > UPPER.maxArtifactBytes) throw new Error('Invalid artifact reference identity')
  kindIdentity(raw.kind)
  return Object.freeze({ version: 1, runId, kind: raw.kind, sha256: raw.sha256, byteLength: raw.byteLength })
}
function clock(now) {
  const at = typeof now === 'function' ? now() : now
  if (!Number.isSafeInteger(at) || at < 0 || at > 8640000000000000) throw new Error('Invalid artifact time')
  return at
}
function readFlags() {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error('No-follow nonblocking artifact reads are unsupported')
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
}
async function safeDirectory(dir, create) {
  if (create) {
    try { await mkdir(dir, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || await realpath(dir) !== dir) throw new Error('Unsafe private artifact directory')
}
async function storage(common, runId, create = false, allowMissing = false) {
  markerRef(runId, 'suspended')
  if (typeof common !== 'string' || !path.isAbsolute(common)) throw new Error('Common Git storage must be absolute')
  const canonical = await realpath(common)
  if (!(await lstat(canonical)).isDirectory()) throw new Error('Common Git storage must be a directory')
  const base = path.join(canonical, 'fleetmates-artifacts'), dir = path.join(base, hash(runId))
  try { await safeDirectory(base, create); await safeDirectory(dir, create) }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error }
  return dir
}
const name = reference => hash(JSON.stringify(reference)) + '.bin'
function regular(info) {
  if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077) throw new Error('Artifact must be a private regular file without links')
}
async function readBytes(file, reference, retention, sync = false) {
  if (reference.byteLength > retention.maxArtifactBytes) throw new Error('Artifact byte bound exceeded')
  regular(await lstat(file))
  const handle = await open(file, readFlags())
  try {
    const before = await handle.stat()
    regular(before)
    if (await realpath(file) !== file) throw new Error('Artifact path contains a link')
    if (before.size > retention.maxArtifactBytes) throw new Error('Artifact byte bound exceeded')
    if (before.size !== reference.byteLength) throw new Error('Artifact byte length mismatch')
    const buffer = Buffer.alloc(reference.byteLength + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat(), current = await lstat(file)
    regular(after); regular(current)
    if (offset !== reference.byteLength || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.dev !== after.dev || current.ino !== after.ino || hash(buffer.subarray(0, offset)) !== reference.sha256) throw new Error('Artifact changed or content hash mismatch')
    if (sync) await handle.sync()
    return buffer.subarray(0, offset)
  } finally { await handle.close() }
}
async function inventory(dir) {
  const files = []
  for await (const entry of await opendir(dir)) {
    if (entry.name === '.lock') continue
    if (!/^[a-f0-9]{64}\.bin$/.test(entry.name)) throw new Error('Incomplete or unrecognized artifact storage')
    if (files.length >= MAX_FILES) throw new Error('Artifact count bound exceeded')
    const file = path.join(dir, entry.name), info = await lstat(file)
    regular(info)
    if (info.size > UPPER.maxArtifactBytes || await realpath(file) !== file) throw new Error('Unsafe artifact storage byte bound or link')
    files.push({ name: entry.name, file, size: info.size, at: info.mtimeMs })
  }
  return files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
}
// Interrupted-write reconciliation shared with the execution journal. A storage lock is a private
// directory `<dir>/.lock` holding `pid`, the decimal pid of the process that created it.
export const LOCK_WAIT_MS = 5000, STALE_TEMPORARY_MS = 60000
const LOCK_BACKOFF_MS = { first: 10, max: 250 }
const TEMPORARY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/
const REMOVED_LOCK = /^\.lock\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.stale$/
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
async function lockHolder(lock) {
  let info
  try { info = await lstat(lock) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe storage lock')
  let pid = null, handle
  try {
    handle = await open(path.join(lock, 'pid'), readFlags())
    const buffer = Buffer.alloc(16), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('latin1')
    if (/^[1-9][0-9]{0,9}\n$/.test(text)) pid = Number(text.trim())
  } catch (error) { if (!['ENOENT', 'ELOOP', 'EISDIR'].includes(error.code)) throw error }
  finally { if (handle) await handle.close() }
  return { pid, at: info.mtimeMs }
}
// A holder whose pid is not alive is dead. A lock without a readable pid is a creator that has not
// written it yet, so it is treated as held until it is older than STALE_TEMPORARY_MS.
function abandoned(holder) {
  if (holder.pid !== null) return alive(holder.pid) ? null : 'dead-lock-holder'
  return Date.now() - holder.at > STALE_TEMPORARY_MS ? 'abandoned-lock-without-pid' : null
}
async function removeAbandonedLock(dir, lock, holder) {
  const moved = path.join(dir, `.lock.${randomUUID()}.stale`)
  try { await rename(lock, moved) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  const current = await lockHolder(moved)
  if (current.pid !== holder.pid) { // another writer replaced the lock in between; hand it back
    await rename(moved, lock).catch(() => {})
    return false
  }
  await rm(moved, { recursive: true, force: true })
  return true
}
export async function withStorageLock(dir, busy, action) {
  const lock = path.join(dir, '.lock'), reconciled = [], deadline = Date.now() + LOCK_WAIT_MS
  for (let delay = LOCK_BACKOFF_MS.first; ;) {
    try {
      await mkdir(lock, { mode: 0o700 })
      try {
        const handle = await open(path.join(lock, 'pid'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await handle.writeFile(`${process.pid}\n`) } finally { await handle.close() }
      } catch (error) { await rm(lock, { recursive: true, force: true }); throw error }
      break
    } catch (error) { if (error.code !== 'EEXIST') throw error }
    const holder = await lockHolder(lock)
    if (holder) {
      const reason = abandoned(holder)
      if (reason && await removeAbandonedLock(dir, lock, holder)) { reconciled.push({ path: '.lock', reason }); continue }
      if (!reason) {
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(busy)
        await sleep(Math.min(delay, left))
        delay = Math.min(delay * 2, LOCK_BACKOFF_MS.max)
      }
    }
  }
  try { return await action(reconciled) }
  finally { await unlink(path.join(lock, 'pid')); await rmdir(lock) }
}
// Called while holding the storage lock, so no live writer owns a temporary file; the age
// threshold still leaves young ones in place for the caller's storage check to refuse.
export async function reconcileTemporaries(dir, reconciled) {
  const found = []
  for await (const entry of await opendir(dir)) if (TEMPORARY.test(entry.name) || REMOVED_LOCK.test(entry.name)) found.push(entry.name)
  for (const entry of found.sort()) {
    const file = path.join(dir, entry), info = await lstat(file)
    if (REMOVED_LOCK.test(entry)) {
      if (!info.isDirectory()) continue
      await rm(file, { recursive: true, force: true }); reconciled.push({ path: entry, reason: 'interrupted-lock-removal' })
    } else if (info.isFile() && Date.now() - info.mtimeMs > STALE_TEMPORARY_MS) {
      await unlink(file); reconciled.push({ path: entry, reason: 'stale-temporary' })
    }
  }
  return reconciled
}
const BUSY = 'Artifact storage is busy or an interrupted write requires reconciliation'
async function syncDirectory(dir) {
  let handle
  try {
    handle = await open(dir, readFlags())
    await handle.sync()
    return true
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code) || process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return false
    throw error
  } finally { if (handle) await handle.close() }
}
async function retained(dir, reference, reconciled) {
  return { reference, reconciled, durability: { fileSynced: true, directorySynced: await syncDirectory(dir), powerLossGuaranteed: false,
    limitation: 'Completed fsync calls do not guarantee recovery after power loss on every filesystem, storage device or platform.' }, trust: TRUST }
}

export async function retainExecutionArtifact({ common, runId, kind, bytes, retention: raw, now = Date.now }) {
  const retention = policy(raw), at = clock(now)
  readFlags()
  markerRef(runId, 'suspended'); kindIdentity(kind)
  if (!(bytes instanceof Uint8Array)) throw new Error('Artifact bytes must be a Buffer or Uint8Array')
  if (bytes.byteLength > retention.maxArtifactBytes) throw new Error('Artifact byte bound exceeded')
  const content = Buffer.from(bytes)
  const reference = referenceIdentity({ version: 1, runId, kind, sha256: hash(content), byteLength: content.length }, runId)
  const dir = await storage(common, runId, true)
  // Only the new content is measured against the bounds: old or oversized content already stored
  // is pruneExecutionArtifacts' concern, which needs the caller's live references.
  if (content.length > retention.maxRunBytes) throw new Error('Artifact run byte bound exceeded')
  return withStorageLock(dir, BUSY, async reconciled => {
    await reconcileTemporaries(dir, reconciled)
    const files = await inventory(dir), existing = files.find(file => file.name === name(reference))
    if (existing) {
      await readBytes(existing.file, reference, retention, true)
      return retained(dir, reference, reconciled)
    }
    if (files.length >= MAX_FILES) throw new Error('Artifact count bound exceeded')
    const temporary = path.join(dir, '.' + randomUUID() + '.tmp')
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      try { await handle.writeFile(content); await handle.utimes(at / 1000, at / 1000); await handle.sync() }
      finally { await handle.close() }
      await link(temporary, path.join(dir, name(reference)))
    } finally { await unlink(temporary) }
    return retained(dir, reference, reconciled)
  })
}

export async function readExecutionArtifact({ common, runId, reference: rawReference, retention: raw }) {
  const retention = policy(raw), reference = referenceIdentity(rawReference, runId)
  const dir = await storage(common, runId)
  return readBytes(path.join(dir, name(reference)), reference, retention)
}

export async function pruneExecutionArtifacts({ common, runId, retention: raw, liveReferences, now = Date.now }) {
  const retention = policy(raw), at = clock(now)
  markerRef(runId, 'suspended')
  if (!(Array.isArray(liveReferences) || liveReferences instanceof Set) || (liveReferences.size ?? liveReferences.length) > MAX_FILES) throw new Error('An explicit bounded live recovery reference set is required')
  const live = new Map()
  for (const rawReference of liveReferences) { const reference = referenceIdentity(rawReference, runId); live.set(name(reference), reference) }
  const dir = await storage(common, runId, false, true)
  if (!dir) {
    return { removed: [], kept: [], bytes: 0, reconciled: [], unresolvedReferences: [...live.values()], limitsSatisfied: true,
      retentionExceeded: { artifactBytes: false, runBytes: false, age: false } }
  }
  return withStorageLock(dir, BUSY, async reconciled => {
    await reconcileTemporaries(dir, reconciled)
    const files = await inventory(dir), unresolvedReferences = []
    for (const [fileName, reference] of live) {
      try { await readBytes(path.join(dir, fileName), reference, retention) }
      catch { unresolvedReferences.push(reference) }
    }
    let bytes = files.reduce((sum, file) => sum + file.size, 0)
    const remaining = [], removed = []
    // Oldest first: non-live content goes when it is past the age or artifact bound, or while the
    // run is over its byte bound. Live content is never removed.
    for (const file of files) {
      if (!live.has(file.name) && (at - file.at > retention.maxAgeMs || file.size > retention.maxArtifactBytes || bytes > retention.maxRunBytes)) {
        await unlink(file.file); bytes -= file.size; removed.push({ name: file.name, bytes: file.size })
      } else remaining.push(file)
    }
    if (removed.length) await syncDirectory(dir)
    const retentionExceeded = { artifactBytes: remaining.some(file => file.size > retention.maxArtifactBytes), runBytes: bytes > retention.maxRunBytes,
      age: remaining.some(file => at - file.at > retention.maxAgeMs) }
    return { removed, kept: remaining.map(file => ({ name: file.name, bytes: file.size, live: live.has(file.name) })), bytes, reconciled, unresolvedReferences, limitsSatisfied: !Object.values(retentionExceeded).some(Boolean), retentionExceeded }
  })
}
