import { constants } from 'node:fs'
import { mkdir, open, lstat, realpath, opendir, link, unlink, rename, rm } from 'node:fs/promises'
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
    if (lockEntry(entry.name)) continue
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
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TEMPORARY = new RegExp(`^\\.${UUID}\\.tmp$`)
// `.lock.<pid>.<uuid>.new` is a lock process <pid> is creating and `.lock.<pid>.<uuid>.stale` one
// it is deleting. Readers skip them; a writer holding the lock removes those whose pid is dead.
const LOCK_ENTRY = new RegExp(`^\\.lock\\.([1-9][0-9]{0,9})\\.${UUID}\\.(new|stale)$`)
export const lockEntry = name => name === '.lock' || LOCK_ENTRY.test(name)
const MAX_RECLAIM_CHAIN = 8
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const lockEntryName = kind => `.lock.${process.pid}.${randomUUID()}.${kind}`
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
async function readPid(file) {
  let handle
  try {
    handle = await open(file, readFlags())
    const buffer = Buffer.alloc(16), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('latin1')
    return /^[1-9][0-9]{0,9}\n$/.test(text) ? Number(text.trim()) : null
  } catch (error) { if (['ENOENT', 'ELOOP', 'EISDIR'].includes(error.code)) return null; throw error }
  finally { if (handle) await handle.close() }
}
async function writePid(file) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(`${process.pid}\n`) } finally { await handle.close() }
}
async function lockHolder(lock) {
  let info
  try { info = await lstat(lock) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe storage lock')
  return { pid: await readPid(path.join(lock, 'pid')), at: info.mtimeMs, ino: info.ino }
}
// A holder whose pid is not alive is dead. Locks are created with their pid already inside, so a
// pid-less lock was left by a crashed or older writer; it is reclaimed once older than STALE_TEMPORARY_MS.
function abandoned(holder) {
  if (holder.pid !== null) return alive(holder.pid) ? null : 'dead-lock-holder'
  return Date.now() - holder.at > STALE_TEMPORARY_MS ? 'abandoned-lock-without-pid' : null
}
// The lock appears with its pid already written: a staging directory holding `pid` is renamed into
// place. A rename onto a non-empty directory fails, and every lock this code creates is non-empty.
async function createLock(dir, lock) {
  const staging = path.join(dir, lockEntryName('new'))
  await mkdir(staging, { mode: 0o700 })
  try {
    await writePid(path.join(staging, 'pid'))
    // An empty directory would be replaced by the rename, so an existing (pid-less) lock is left alone.
    if (await lockHolder(lock)) return false
    try { await rename(staging, lock); return true }
    catch (error) { if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return false; throw error }
  } finally { await rm(staging, { recursive: true, force: true }) }
}
// Creates `<lock>/<name>` holding this pid, atomically: false when the name already exists.
async function claimToken(lock, name) {
  const temporary = path.join(lock, `.${randomUUID()}.token`)
  await writePid(temporary)
  try { await link(temporary, path.join(lock, name)); return true }
  catch (error) { if (error.code === 'EEXIST') return false; throw error }
  finally { await unlink(temporary).catch(() => {}) }
}
// One reclaimer per dead lock instance: the token `reclaim.<dead pid>` is created inside that
// instance, so only its holder may remove it. The holder then re-reads the lock and removes it only
// if it is still the same directory with the same dead holder; anything else is left untouched.
// A token whose own holder died is superseded by `<token>.<its pid>`, up to MAX_RECLAIM_CHAIN links.
async function reclaimLock(dir, lock, holder) {
  let name = `reclaim.${holder.pid ?? 'none'}`
  try {
    for (let step = 0; step < MAX_RECLAIM_CHAIN; step++) {
      if (!await claimToken(lock, name)) {
        const owner = await readPid(path.join(lock, name))
        if (owner === null || alive(owner)) return false
        name += '.' + owner
        continue
      }
      const current = await lockHolder(lock)
      if (!current || current.ino !== holder.ino || current.pid !== holder.pid || current.pid !== null && alive(current.pid)) {
        await unlink(path.join(lock, name)).catch(() => {})
        return false
      }
      const moved = path.join(dir, lockEntryName('stale'))
      await rename(lock, moved)
      await rm(moved, { recursive: true, force: true })
      return true
    }
    return false
  } catch (error) { if (error.code === 'ENOENT') return false; throw error } // the lock went away meanwhile
}
export async function withStorageLock(dir, busy, action) {
  const lock = path.join(dir, '.lock'), reconciled = [], deadline = Date.now() + LOCK_WAIT_MS
  for (let delay = LOCK_BACKOFF_MS.first; ;) {
    if (await createLock(dir, lock)) break
    const holder = await lockHolder(lock)
    if (!holder) continue
    const reason = abandoned(holder)
    if (reason && await reclaimLock(dir, lock, holder)) { reconciled.push({ path: '.lock', reason }); continue }
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(busy)
    await sleep(Math.min(delay, left))
    delay = Math.min(delay * 2, LOCK_BACKOFF_MS.max)
  }
  try { return await action(reconciled) }
  finally {
    const moved = path.join(dir, lockEntryName('stale'))
    await rename(lock, moved)
    await rm(moved, { recursive: true, force: true })
  }
}
// Called while holding the storage lock, so no live writer owns a temporary file; the age
// threshold still leaves young ones in place for the caller's storage check to refuse.
export async function reconcileTemporaries(dir, reconciled) {
  const found = []
  for await (const entry of await opendir(dir)) if (TEMPORARY.test(entry.name) || LOCK_ENTRY.test(entry.name)) found.push(entry.name)
  for (const entry of found.sort()) {
    const file = path.join(dir, entry)
    let info
    try { info = await lstat(file) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const owner = LOCK_ENTRY.exec(entry)
    if (owner) {
      if (!info.isDirectory() || alive(Number(owner[1]))) continue
      await rm(file, { recursive: true, force: true })
      reconciled.push({ path: entry, reason: owner[2] === 'new' ? 'interrupted-lock-creation' : 'interrupted-lock-removal' })
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
      retentionExceeded: { artifactBytes: false, runBytes: false, age: false, count: false } }
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
    // Oldest first, live content is never removed. With an empty live set all content is non-live
    // and goes. Otherwise non-live content goes when it is past the age or artifact bound, while the
    // run is over its byte bound, or while the store is full, so a later retain has room.
    let count = files.length
    const everything = live.size === 0
    for (const file of files) {
      if (!live.has(file.name) && (everything || count >= MAX_FILES || at - file.at > retention.maxAgeMs
          || file.size > retention.maxArtifactBytes || bytes > retention.maxRunBytes)) {
        await unlink(file.file); bytes -= file.size; count--; removed.push({ name: file.name, bytes: file.size })
      } else remaining.push(file)
    }
    if (removed.length) await syncDirectory(dir)
    const retentionExceeded = { artifactBytes: remaining.some(file => file.size > retention.maxArtifactBytes), runBytes: bytes > retention.maxRunBytes,
      age: remaining.some(file => at - file.at > retention.maxAgeMs), count: remaining.length >= MAX_FILES }
    return { removed, kept: remaining.map(file => ({ name: file.name, bytes: file.size, live: live.has(file.name) })), bytes, reconciled, unresolvedReferences, limitsSatisfied: !Object.values(retentionExceeded).some(Boolean), retentionExceeded }
  })
}
