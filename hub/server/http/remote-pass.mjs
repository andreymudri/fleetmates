import fs from 'node:fs'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { openNoFollowSync, privateFileProblem } from '../../platform/index.mjs'
// The remote access passphrase (08-security 4.2, remote access): the one secret a phone on the tailnet types to
// get the deck token. It is chosen by the owner and it persists; nothing here generates or expires it.
/** Shortest passphrase the deck accepts. A phone types this once, so length is cheaper here than anywhere else. */
export const MIN_LENGTH = 10
/** Passphrases refused outright, whatever their length. */
const OBVIOUS = new Set(['password', 'passphrase', 'fleetmates', 'fleetmatesdeck', 'changeme', 'letmein', '1234567890', '12345678901234567890', 'qwertyuiop', 'deckdeckdeck'])
/**
 * scrypt parameters stored with every record, so a record written under older ones keeps verifying. `cost` is the
 * current OWASP recommendation for a human-chosen secret; 128 * cost * blockSize is 128 MiB of working memory,
 * which `maxmem` has to allow.
 */
const PARAMS = { cost: 131072, blockSize: 8, parallelization: 1, keyLength: 64 }
const MAXMEM = 320 * 1024 * 1024
/** Derive the scrypt key of one passphrase under the record's own parameters. */
function derive(passphrase, salt, params) {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFKC'), salt, params.keyLength, { N: params.cost, r: params.blockSize, p: params.parallelization, maxmem: MAXMEM },
      (error, key) => error ? reject(error) : resolve(key))
  })
}
/**
 * Refuse a passphrase the owner should not be allowed to set: too short, blank, or one of the obvious ones.
 * @param {string} passphrase
 * @returns {string} the passphrase, unchanged
 */
export function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.trim() === '') throw Error('remote access passphrase must not be empty')
  if (passphrase.length < MIN_LENGTH) throw Error(`remote access passphrase must be at least ${MIN_LENGTH} characters`)
  if (OBVIOUS.has(passphrase.toLowerCase().replace(/[\s-]/g, ''))) throw Error('remote access passphrase is too easy to guess')
  return passphrase
}
/** Hash one checked passphrase into the record written to disk; the passphrase itself is never stored. */
export async function hashPassphrase(passphrase, salt = randomBytes(16)) {
  const key = await derive(passphrase, salt, PARAMS)
  return { v: 1, ...PARAMS, salt: salt.toString('base64url'), hash: key.toString('base64url') }
}
/**
 * Read the passphrase record, in the shape the endpoint keys use (`{ secret } | { missing } | { bad }`), so a deck
 * with no passphrase and a deck with an unusable one are two different answers rather than one silent refusal.
 *
 * The file is opened once with `openNoFollowSync`, which refuses a symbolic link on Windows too, and both the
 * privacy check and the read go through that descriptor: a path checked and then reopened leaves a window for the
 * file to be swapped underneath. On POSIX it must be owned by `uid` and have mode 0600; on win32 there is no mode
 * to check and the owner's profile ACLs are what keep it private.
 * @param {string} file
 * @param {{ platform?: string, uid?: number | null }} [opts]
 * @returns {{ record: object } | { missing: true } | { bad: string }}
 */
export function readRemotePass(file, { platform = process.platform, uid = process.getuid?.() ?? null } = {}) {
  let fd
  try { fd = openNoFollowSync(file, fs.constants.O_RDONLY, { platform }) } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { missing: true }
    return { bad: error.code === 'ELOOP' ? 'a symbolic link' : 'unreadable' }
  }
  let text
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile()) return { bad: 'not a regular file' }
    const problem = privateFileProblem(info, { platform, uid })
    if (problem) return { bad: problem }
    text = fs.readFileSync(fd, 'utf8')
  } finally { fs.closeSync(fd) }
  let record
  try { record = JSON.parse(text) } catch { return { bad: 'not JSON' } }
  if (record?.v !== 1 || !/^[A-Za-z0-9_-]+$/.test(record.salt ?? '') || !/^[A-Za-z0-9_-]+$/.test(record.hash ?? '')
    || ![record.cost, record.blockSize, record.parallelization, record.keyLength].every(value => Number.isInteger(value) && value > 0)) return { bad: 'not a passphrase record' }
  return { record }
}
/**
 * Write the record as a private file, replacing any previous one in one rename. The temporary name carries random
 * bytes and is created with `O_EXCL` through `openNoFollowSync`, as `platform/index.mjs` publishes an endpoint key,
 * so a predictable name cannot be waiting for it. The content is flushed before the rename.
 * @param {string} file
 * @param {object} record
 * @param {{ platform?: string, random?: (size: number) => Buffer }} [opts]
 */
export function writeRemotePass(file, record, { platform = process.platform, random = randomBytes } = {}) {
  const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants
  const temp = `${file}.${random(6).toString('hex')}.tmp`
  try {
    const fd = openNoFollowSync(temp, O_WRONLY | O_CREAT | O_EXCL, { platform, mode: 0o600 })
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    fs.renameSync(temp, file)
  } finally { try { fs.unlinkSync(temp) } catch {} }
}
/** Compare a typed passphrase against a stored record in constant time, as `sameToken` compares token carriers. */
export async function verifyPassphrase(passphrase, record) {
  if (typeof passphrase !== 'string' || passphrase === '') return false
  const expected = Buffer.from(record.hash, 'base64url')
  const key = await derive(passphrase, Buffer.from(record.salt, 'base64url'), record)
  return key.length === expected.length && timingSafeEqual(key, expected)
}
/**
 * The passphrase exchange, with the three properties that make a token-free surface safe to expose on a tailnet.
 *
 * **Serialized.** Every attempt runs in a queue of one. Without it the window check and the counter increment sat
 * on either side of an `await`, so a burst of concurrent POSTs all read an empty counter and all reached scrypt:
 * no limit at all, and a thousand 128 MiB derivations queued on the libuv threadpool would starve the API and the
 * WebSocket hub, which run in this same process. `maxPending` caps how many may wait, and anything beyond it is
 * refused without touching scrypt, so the work a peer can queue is bounded whatever it sends.
 *
 * **The right passphrase always gets through.** A full window refuses wrong answers, never a correct one. Counting
 * before verifying would let anyone on the tailnet lock the owner's own phone out with ten cheap wrong guesses,
 * which is a worse failure than the one the counter exists to prevent. What throttles a guesser instead is the
 * queue of one plus a delay that doubles to 4 s, so sustained guessing settles at well under one per second.
 *
 * **Only real guesses count.** An empty or too-short passphrase is refused before scrypt and is not counted, so
 * free requests cannot fill the window.
 *
 * The limit is global, not per client address: behind `tailscale serve` every request reaches the deck from
 * 127.0.0.1, so a per-address key would only look like a limit, and `X-Forwarded-For` or `Tailscale-User-Login`
 * are proxy headers this surface must not trust. The tailnet is the primary perimeter; all of this is defence in
 * depth behind it.
 * @param {{ file: string, platform?: string, uid?: number | null, now?: () => number, maxAttempts?: number, maxPending?: number, windowMs?: number, sleep?: (ms: number) => Promise<void>, compare?: (passphrase: string, record: object) => Promise<boolean>, log?: (line: string) => void }} options
 * @returns {{ enabled: () => boolean, verify: (passphrase: string) => Promise<{ ok: boolean, code?: string, retryAfterMs?: number }> }}
 */
export function createRemoteAccess({ file, platform = process.platform, uid = process.getuid?.() ?? null, now = Date.now, maxAttempts = 10, maxPending = 3, windowMs = 300_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), compare = verifyPassphrase, log = line => { try { process.stderr.write(`deck: ${line}\n`) } catch {} } }) {
  let failures = []
  let reported = null
  let pending = 0
  let queue = Promise.resolve()
  const current = () => {
    failures = failures.filter(at => at > now() - windowMs)
    return failures
  }
  // How long the client is told to wait: what is left of the window when the counter is full, and a short busy
  // wait when nothing is counted yet and the refusal is only the queue being full.
  const waitMs = () => {
    const oldest = current()[0]
    return oldest === undefined ? 5000 : Math.max(0, oldest + windowMs - now())
  }
  // A file that exists but cannot be used is reported once per distinct reason, as the tiers store reports a
  // rejected tiers.json, and is answered as "no passphrase set": there is nothing the phone can type against it.
  const record = () => {
    const result = readRemotePass(file, { platform, uid })
    if (result.bad !== undefined && result.bad !== reported) { reported = result.bad
      log(`remote_pass.rejected ${result.bad}`) }
    if (result.record) reported = null
    return result.record ?? null
  }
  /** One attempt, with the queue held: at most one scrypt derivation runs in this process at a time. */
  const attempt = async (passphrase, stored) => {
    if (await compare(passphrase, stored)) {
      failures = []
      return { ok: true }
    }
    failures.push(now())
    const full = current().length >= maxAttempts
    // A wrong answer costs more each time within the window: 0.25 s, 0.5 s, 1 s, up to 4 s. The queue is held
    // throughout, so this is the rate limit, not only a delay for the client that earned it.
    await sleep(Math.min(250 * 2 ** (failures.length - 1), 4000))
    return full ? { ok: false, code: 'too_many_attempts', retryAfterMs: waitMs() } : { ok: false, code: 'unauthorized' }
  }
  return {
    enabled: () => record() !== null,
    async verify(passphrase) {
      const stored = record()
      if (!stored) return { ok: false, code: 'pairing_unavailable' }
      // Refused before the queue and before scrypt, and not counted: no passphrase this short can be the right one.
      if (typeof passphrase !== 'string' || passphrase.length < MIN_LENGTH) return { ok: false, code: 'unauthorized' }
      if (pending >= maxPending) return { ok: false, code: 'too_many_attempts', retryAfterMs: waitMs() }
      pending++
      const run = queue.then(() => attempt(passphrase, stored))
      queue = run.then(() => {}, () => {})
      try { return await run } finally { pending-- }
    }
  }
}
