import fs from 'node:fs/promises'
import path from 'node:path'

/** A TurbidAssist session id: local `%Y-%m-%dT%H-%M-%S`, with `-2`, `-3` on collision (contract 2.7). */
export const SESSION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?$/

/** Manifest states the batch writes (contract 2.7); anything else reads as `recorded`. */
export const MANIFEST_STATES = Object.freeze(['recorded', 'transcribed', 'awaiting_names', 'synthesized'])

/** Largest `session.json` read. */
export const MANIFEST_CAP = 64 * 1024
/** Largest transcript file read. */
export const TRANSCRIPT_CAP = 32 * 1024 * 1024
/** Bytes read from the end of `postmeet.log`. */
export const LOG_TAIL_BYTES = 64 * 1024

const HOUR = 60 * 60 * 1000
const QUIET_MS = 10 * 60 * 1000
const LIVE_SPEAKER = Object.freeze({ mic: 'Você', room: 'Sala' })

/**
 * A refused read: a symlink, a path outside its root, a non-regular file or a file over its cap.
 * `code` is `refused` or `too_large`.
 */
export class MeetingFileError extends Error {
  /**
   * @param {'refused'|'too_large'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'MeetingFileError'
    this.code = code
  }
}

const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code)
const inside = (root, target) => target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * Read one file of `<root>/<...parts>` with the 08-security checks: the realpath of the target must sit inside
 * the realpath of `root`, the open uses `O_NOFOLLOW`, the file must be regular and at most `cap` bytes.
 * @param {string} root
 * @param {string[]} parts path segments under root
 * @param {number} cap
 * @param {{ tail?: boolean }} [options] with `tail`, read only the last `cap` bytes instead of refusing a larger file
 * @returns {Promise<{ bytes: Buffer, mtimeMs: number, truncated: boolean } | null>} null when the file does not exist
 * @throws {MeetingFileError}
 */
export async function readInside(root, parts, cap, { tail = false } = {}) {
  let realRoot
  try { realRoot = await fs.realpath(root) } catch (error) { if (missing(error)) return null; throw error }
  const target = path.join(realRoot, ...parts)
  let realTarget
  try { realTarget = await fs.realpath(target) } catch (error) { if (missing(error)) return null; throw error }
  if (!inside(realRoot, realTarget)) throw new MeetingFileError('refused', 'outside its root')
  let handle
  try { handle = await fs.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) } catch (error) {
    if (missing(error)) return null
    if (error?.code === 'ELOOP') throw new MeetingFileError('refused', 'symlink')
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new MeetingFileError('refused', 'not a regular file')
    if (info.size > cap && !tail) throw new MeetingFileError('too_large', 'over the size cap')
    const start = Math.max(0, info.size - cap)
    const bytes = Buffer.alloc(info.size - start)
    let at = 0
    while (at < bytes.length) {
      const { bytesRead } = await handle.read(bytes, at, bytes.length - at, start + at)
      if (!bytesRead) break
      at += bytesRead
    }
    return { bytes: bytes.subarray(0, at), mtimeMs: info.mtimeMs, truncated: start > 0 }
  } finally { await handle.close() }
}

/**
 * Start time of a session id read as local time.
 * @param {string} id
 * @returns {number|null} epoch ms
 */
export function startFromId(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

const parseTime = value => {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

async function readManifest(sessionDir, id) {
  let file
  try { file = await readInside(sessionDir, [id, 'session.json'], MANIFEST_CAP) } catch { return { present: true, data: {} } }
  if (!file) return { present: false, data: null }
  try {
    const data = JSON.parse(file.bytes.toString('utf8'))
    return { present: true, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} }
  } catch { return { present: true, data: {} } }
}

async function newestMtime(dir) {
  let newest = 0
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return newest }
  for (const entry of entries) {
    try {
      const info = await fs.lstat(path.join(dir, entry.name))
      if (info.mtimeMs > newest) newest = info.mtimeMs
    } catch {}
  }
  return newest
}

async function isRegular(file) {
  try { return (await fs.lstat(file)).isFile() } catch { return false }
}

/**
 * @typedef {object} SessionEntry
 * @property {string} id session id, the directory name
 * @property {string} dir absolute `<sessionDir>/<id>`
 * @property {string|null} tag
 * @property {number|null} startedAt epoch ms
 * @property {number|null} endedAt epoch ms
 * @property {'recording'|'stopping'|'recorded'|'transcribed'|'awaiting_names'|'synthesized'} state
 * @property {boolean} interrupted no manifest, a live transcript and nothing written for more than 1 h
 */

/**
 * List the sessions of a `session_dir`, newest first. Only real directories whose name is a session id count;
 * symlinks and files are skipped. A directory without `session.json` is `recording` when it is `recordingId`,
 * else `stopping`, and `interrupted` once it holds `transcript.jsonl` and its newest file is more than 1 h old.
 * @param {string} sessionDir
 * @param {{ now?: number, recordingId?: string|null }} [options]
 * @returns {Promise<SessionEntry[]>}
 */
export async function listSessions(sessionDir, { now = Date.now(), recordingId = null } = {}) {
  let entries
  try { entries = await fs.readdir(sessionDir, { withFileTypes: true }) } catch (error) { if (missing(error)) return []; throw error }
  const sessions = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue
    const id = entry.name
    const dir = path.join(sessionDir, id)
    const manifest = await readManifest(sessionDir, id)
    if (manifest.present) {
      const data = manifest.data
      sessions.push({
        id,
        dir,
        tag: typeof data.tag === 'string' ? data.tag : null,
        startedAt: parseTime(data.started_at) ?? startFromId(id),
        endedAt: parseTime(data.ended_at),
        state: MANIFEST_STATES.includes(data.state) ? data.state : 'recorded',
        interrupted: false
      })
      continue
    }
    const recording = id === recordingId
    const interrupted = !recording && await isRegular(path.join(dir, 'transcript.jsonl')) && now - await newestMtime(dir) > HOUR
    sessions.push({ id, dir, tag: null, startedAt: startFromId(id), endedAt: null, state: recording ? 'recording' : 'stopping', interrupted })
  }
  return sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/**
 * Parse `/proc/locks` text into a set of `major:minor:inode` keys (major and minor as numbers).
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseProcLocks(text) {
  const held = new Set()
  for (const line of String(text).split('\n')) {
    const m = /\s([0-9a-f]+):([0-9a-f]+):(\d+)\s/.exec(line)
    if (m) held.add(`${parseInt(m[1], 16)}:${parseInt(m[2], 16)}:${BigInt(m[3])}`)
  }
  return held
}

/**
 * The `major:minor:inode` key of a bigint stat, decoding the Linux `dev_t` the way glibc's `major()` and
 * `minor()` do.
 * @param {import('node:fs').BigIntStats} info
 * @returns {string}
 */
export function lockKey(info) {
  const dev = info.dev
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn)
  return `${major}:${minor}:${info.ino}`
}

const readProcLocks = () => fs.readFile('/proc/locks', 'utf8')
const readMountinfo = () => fs.readFile('/proc/self/mountinfo', 'utf8')

const unescapeMount = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))

/**
 * The `major:minor` (decimal) of the mount that contains `file`, from `/proc/self/mountinfo` text: field 3 of the
 * entry with the longest mount point that is `file` or one of its parents (the later entry on a tie, since a later
 * mount shadows an earlier one). Mount points are decoded from mountinfo's octal escapes.
 * @param {string} text mountinfo text
 * @param {string} file absolute realpath
 * @returns {string|null}
 */
export function mountDevice(text, file) {
  let best = null
  let bestLength = -1
  for (const line of String(text).split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 5 || !/^\d+:\d+$/.test(fields[2])) continue
    const point = unescapeMount(fields[4])
    const contains = point === '/' || file === point || file.startsWith(point + '/')
    if (contains && point.length >= bestLength) { best = fields[2]; bestLength = point.length }
  }
  return best
}

async function lockHeld(sessionDir, { now, procLocks, mountinfo }) {
  const lock = path.join(sessionDir, 'postmeet.lock')
  let info
  try { info = await fs.lstat(lock, { bigint: true }) } catch { return false }
  if (!info.isFile()) return false
  let text
  try { text = typeof procLocks === 'string' ? procLocks : await procLocks() } catch { text = null }
  if (typeof text !== 'string') return now - Number(info.mtimeMs) < QUIET_MS
  const held = parseProcLocks(text)
  if (held.has(lockKey(info))) return true
  // On btrfs, stat() reports the subvolume's anonymous device while /proc/locks reports the device that
  // mountinfo lists for the mount, so the inode is also matched against that device.
  let device = null
  try { device = mountDevice(typeof mountinfo === 'string' ? mountinfo : await mountinfo(), await fs.realpath(lock)) } catch {}
  return device !== null && held.has(`${device}:${info.ino}`)
}

/**
 * The post-processing state of one session and the deck-derived `stuck` flag (state-machines 6.4): stuck when
 * the session has a manifest, its state is not `synthesized`, `postmeet.log` (or, without a log, `session.json`)
 * has not changed for 10 minutes, and `<sessionDir>/postmeet.lock` is not held. Held means the lock file's
 * inode is listed in `/proc/locks` with the device `stat()` reports or the device `/proc/self/mountinfo` gives for
 * the mount holding it (the two differ on btrfs subvolumes); where `/proc/locks` cannot be read, held means the
 * lock changed within 10 minutes.
 * @param {string} sessionDir
 * @param {string} id
 * @param {{ now?: number, procLocks?: string | (() => string | Promise<string>), mountinfo?: string | (() => string | Promise<string>) }} [options]
 * @returns {Promise<{ state: SessionEntry['state'], stuck: boolean }>}
 */
export async function postState(sessionDir, id, { now = Date.now(), procLocks = readProcLocks, mountinfo = readMountinfo } = {}) {
  if (!SESSION_ID.test(id)) return { state: 'stopping', stuck: false }
  const manifest = await readManifest(sessionDir, id)
  if (!manifest.present) return { state: 'stopping', stuck: false }
  const state = MANIFEST_STATES.includes(manifest.data.state) ? manifest.data.state : 'recorded'
  if (state === 'synthesized') return { state, stuck: false }
  let changed = null
  for (const name of ['postmeet.log', 'session.json']) {
    try { changed = (await fs.lstat(path.join(sessionDir, id, name))).mtimeMs; break } catch {}
  }
  if (changed === null || now - changed < QUIET_MS) return { state, stuck: false }
  return { state, stuck: !await lockHeld(sessionDir, { now, procLocks, mountinfo }) }
}

/**
 * @typedef {{ t0: number, t1: number, speaker: string, text: string }} TranscriptLine
 */

const num = value => typeof value === 'number' && Number.isFinite(value)

function batchSegments(text) {
  const data = JSON.parse(text)
  const segments = Array.isArray(data) ? data : Array.isArray(data?.segments) ? data.segments : null
  if (!segments) throw new Error('no segments')
  const lines = []
  let skipped = 0
  for (const s of segments) {
    if (s && num(s.t0) && num(s.t1) && typeof s.speaker === 'string' && typeof s.text === 'string') lines.push({ t0: s.t0, t1: s.t1, speaker: s.speaker, text: s.text })
    else skipped++
  }
  return { lines, skipped }
}

const MD_LINE = /^\[(\d{2,}):(\d{2}):(\d{2})\] ([^:]+?): (.*)$/

/**
 * Parse `transcript.md` lines `[HH:MM:SS] Speaker: texto`; `t1` is the next line's `t0`, the last line's own `t0`.
 * @param {string} text
 * @returns {{ lines: TranscriptLine[], skipped: number }}
 */
export function parseTranscriptMd(text) {
  const lines = []
  let skipped = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    const m = MD_LINE.exec(line)
    if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) { skipped++; continue }
    lines.push({ t0: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), t1: 0, speaker: m[4], text: m[5] })
  }
  for (let i = 0; i < lines.length; i++) lines[i].t1 = i + 1 < lines.length ? lines[i + 1].t0 : lines[i].t0
  return { lines, skipped }
}

function liveEvents(text) {
  const events = []
  let skipped = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let event
    try { event = JSON.parse(raw) } catch { skipped++; continue }
    if (event && num(event.t0) && num(event.t1) && typeof event.text === 'string' && Object.hasOwn(LIVE_SPEAKER, event.source)) events.push(event)
    else skipped++
  }
  return { events, skipped }
}

/**
 * Read a session's transcript from disk: the batch `transcript.json` segments first, else the batch
 * `transcript.md`, else the live `transcript.jsonl` (`mic` is "Você", `room` is "Sala"). Malformed lines are
 * skipped and counted. Nothing is cached.
 * @param {string} sessionDir
 * @param {string} id
 * @returns {Promise<{ source: 'batch'|'live', lines: TranscriptLine[], skipped: number } | null>} null when the
 *   session has no transcript file
 * @throws {MeetingFileError} for a refused file
 */
export async function readTranscript(sessionDir, id) {
  if (!SESSION_ID.test(id)) return null
  const json = await readInside(sessionDir, [id, 'transcript.json'], TRANSCRIPT_CAP)
  if (json) {
    try { return { source: 'batch', ...batchSegments(json.bytes.toString('utf8')) } } catch {}
  }
  const md = await readInside(sessionDir, [id, 'transcript.md'], TRANSCRIPT_CAP)
  if (md) return { source: 'batch', ...parseTranscriptMd(md.bytes.toString('utf8')) }
  const live = await readInside(sessionDir, [id, 'transcript.jsonl'], TRANSCRIPT_CAP)
  if (!live) return null
  const { events, skipped } = liveEvents(live.bytes.toString('utf8'))
  return { source: 'live', lines: events.map(e => ({ t0: e.t0, t1: e.t1, speaker: LIVE_SPEAKER[e.source], text: e.text })), skipped }
}

/**
 * The live `transcript.jsonl` events whose `t1` is greater than `afterT1`, in file order (the gap fill after a
 * subscription reconnect).
 * @param {string} sessionDir
 * @param {string} id
 * @param {{ afterT1?: number }} [options]
 * @returns {Promise<object[]>}
 * @throws {MeetingFileError} for a refused file
 */
export async function readLiveEvents(sessionDir, id, { afterT1 = -Infinity } = {}) {
  if (!SESSION_ID.test(id)) return []
  const live = await readInside(sessionDir, [id, 'transcript.jsonl'], TRANSCRIPT_CAP)
  if (!live) return []
  return liveEvents(live.bytes.toString('utf8')).events.filter(e => e.t1 > afterT1)
}

/**
 * Number of distinct speakers in a transcript.
 * @param {TranscriptLine[]} lines
 * @returns {number}
 */
export function speakers(lines) {
  return new Set(lines.map(line => line.speaker)).size
}

/**
 * Fold text for search: NFD, combining marks removed, lower case. Returns the folded string and, for each
 * folded code unit, the start and end offsets of the original character it came from.
 * @param {string} text
 * @returns {{ folded: string, starts: number[], ends: number[] }}
 */
export function foldText(text) {
  let folded = ''
  const starts = []
  const ends = []
  let at = 0
  for (const ch of text) {
    const piece = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    for (let i = 0; i < piece.length; i++) { starts.push(at); ends.push(at + ch.length) }
    folded += piece
    at += ch.length
  }
  return { folded, starts, ends }
}

const SNIPPET = 160

function matchesIn(text, needle) {
  const { folded, starts, ends } = foldText(text)
  const found = []
  let from = 0
  for (;;) {
    const i = folded.indexOf(needle, from)
    if (i < 0) break
    found.push([starts[i], ends[i + needle.length - 1]])
    from = i + needle.length
  }
  return found
}

function snippetAround(text, [start, end], all) {
  if (text.length <= SNIPPET) return { snippet: text, ranges: all.map(r => [...r]) }
  let from = Math.max(0, start - Math.floor((SNIPPET - (end - start)) / 2))
  const to = Math.min(text.length, from + SNIPPET)
  from = Math.max(0, to - SNIPPET)
  const ranges = all.filter(([a, b]) => a >= from && b <= to).map(([a, b]) => [a - from, b - from])
  return { snippet: text.slice(from, to), ranges }
}

/**
 * Search the transcripts of the given sessions, newest first, case and accent insensitive. Every match is one
 * hit; its `snippet` is at most 160 characters of the line around that match and `ranges` holds the
 * `[start, end]` offsets of every match inside the snippet. Every session is searched whatever its tag (MEET-O7),
 * read from disk on each call with nothing cached. Stops with `partial: true` when the clock passes `budgetMs`
 * or `maxHits` is reached.
 * @param {SessionEntry[]} sessions entries of listSessions (`id`, `dir`, `startedAt`)
 * @param {string} q at least 2 characters after folding and trimming
 * @param {{ budgetMs?: number, maxHits?: number, now?: () => number }} [options]
 * @returns {Promise<{ hits: { meetingId: string, t0: number, speaker: string, snippet: string, ranges: [number, number][] }[], meetingCount: number, partial: boolean }>}
 * @throws {Error} with `code: 'validation_failed'` for a query under 2 characters
 */
export async function searchTranscripts(sessions, q, { budgetMs = 2000, maxHits = 200, now = Date.now } = {}) {
  const needle = foldText(String(q ?? '').trim()).folded
  if (needle.length < 2) throw Object.assign(new Error('query under 2 characters'), { code: 'validation_failed' })
  const ordered = [...sessions].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const started = now()
  const hits = []
  const meetings = new Set()
  let partial = false
  outer: for (const session of ordered) {
    if (now() - started > budgetMs) { partial = true; break }
    let transcript
    try { transcript = await readTranscript(path.dirname(session.dir), session.id) } catch { continue }
    if (!transcript) continue
    for (const line of transcript.lines) {
      const found = matchesIn(line.text, needle)
      for (const match of found) {
        if (hits.length >= maxHits) { partial = true; break outer }
        hits.push({ meetingId: session.id, t0: line.t0, speaker: line.speaker, ...snippetAround(line.text, match, found) })
        meetings.add(session.id)
      }
    }
  }
  return { hits, meetingCount: meetings.size, partial }
}

/**
 * The last `lines` lines of a session's `postmeet.log`, read from its last 64 KiB (realpath inside
 * `sessionDir`, `O_NOFOLLOW`, regular file). A first line cut by the 64 KiB window is dropped.
 * @param {string} sessionDir
 * @param {string} id
 * @param {number} [lines]
 * @returns {Promise<string|null>} null when there is no log
 * @throws {MeetingFileError} for a refused file
 */
export async function logTail(sessionDir, id, lines = 200) {
  if (!SESSION_ID.test(id)) return null
  const file = await readInside(sessionDir, [id, 'postmeet.log'], LOG_TAIL_BYTES, { tail: true })
  if (!file) return null
  let all = file.bytes.toString('utf8').split('\n')
  if (file.truncated) all = all.slice(1)
  if (all.length && all[all.length - 1] === '') all.pop()
  return all.slice(-Math.max(1, Math.floor(lines))).join('\n')
}
