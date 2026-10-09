import fs from 'node:fs'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { openNoFollowSync, privateFileProblem } from '../../platform/index.mjs'
// The remote access passphrase (08-security 4.2, remote access): the one secret a phone on the tailnet types to
// get the deck token. It is chosen by the owner and it persists; nothing here generates or expires it.
/** Shortest passphrase the deck accepts. A phone types this once, so length is cheaper here than anywhere else. */
export const MIN_LENGTH = 10
/** Passphrases refused outright, whatever their length. */
const OBVIOUS = new Set(['password', 'passphrase', 'fleetmates', 'fleetmatesdeck', 'changeme', 'letmein', '1234567890', '12345678901234567890', 'qwertyuiop', 'deckdeckdeck'])
/** scrypt parameters stored with every record, so an older file keeps verifying after they change. */
const PARAMS = { cost: 16384, blockSize: 8, parallelization: 1, keyLength: 64 }
/** Derive the scrypt key of one passphrase under the record's own parameters. */
function derive(passphrase, salt, params) {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFKC'), salt, params.keyLength, { N: params.cost, r: params.blockSize, p: params.parallelization, maxmem: 256 * 1024 * 1024 },
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
 * On POSIX the file must be owned by `uid` and have mode 0600; on win32 it has no mode to check and the owner's
 * profile ACLs are what keep it private, exactly as `readToken` now reads the deck token.
 * @param {string} file
 * @param {{ platform?: string, uid?: number | null }} [opts]
 * @returns {{ record: object } | { missing: true } | { bad: string }}
 */
export function readRemotePass(file, { platform = process.platform, uid = process.getuid?.() ?? null } = {}) {
  let info
  try { info = fs.lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { missing: true }
    return { bad: 'unreadable' }
  }
  if (!info.isFile()) return { bad: 'not a regular file' }
  const problem = privateFileProblem(info, { platform, uid })
  if (problem) return { bad: problem }
  let record
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { bad: 'not JSON' } }
  if (record?.v !== 1 || !/^[A-Za-z0-9_-]+$/.test(record.salt ?? '') || !/^[A-Za-z0-9_-]+$/.test(record.hash ?? '')
    || ![record.cost, record.blockSize, record.parallelization, record.keyLength].every(value => Number.isInteger(value) && value > 0)) return { bad: 'not a passphrase record' }
  return { record }
}
/**
 * Write the record as a private file, replacing any previous one in one rename. The temporary file is opened with
 * `openNoFollowSync`, which refuses a symbolic link on Windows too, where `O_NOFOLLOW` does not exist.
 * @param {string} file
 * @param {object} record
 * @param {{ platform?: string }} [opts]
 */
export function writeRemotePass(file, record, { platform = process.platform } = {}) {
  const temp = `${file}.${process.pid}.tmp`
  try {
    const fd = openNoFollowSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, { platform, mode: 0o600 })
    try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`) } finally { fs.closeSync(fd) }
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
 * The passphrase exchange with its rate limit.
 *
 * The limit is global, not per client address: behind `tailscale serve` every request reaches the deck from
 * 127.0.0.1, so a per-address key would only look like a limit, and `X-Forwarded-For` or `Tailscale-User-Login`
 * are proxy headers this token-free surface must not trust. The tailnet is the primary perimeter; this counter and
 * the growing delay are defence in depth against a device already inside it guessing a human-chosen passphrase.
 * @param {{ file: string, platform?: string, uid?: number | null, now?: () => number, maxAttempts?: number, windowMs?: number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void }} options
 * @returns {{ enabled: () => boolean, verify: (passphrase: string) => Promise<{ ok: boolean, code?: string, retryAfterMs?: number }> }}
 */
export function createRemoteAccess({ file, platform = process.platform, uid = process.getuid?.() ?? null, now = Date.now, maxAttempts = 10, windowMs = 300_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = line => { try { process.stderr.write(`deck: ${line}\n`) } catch {} } }) {
  let failures = []
  let reported = null
  const current = () => {
    failures = failures.filter(at => at > now() - windowMs)
    return failures
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
  return {
    enabled: () => record() !== null,
    async verify(passphrase) {
      const stored = record()
      if (!stored) return { ok: false, code: 'pairing_unavailable' }
      const recent = current()
      if (recent.length >= maxAttempts) return { ok: false, code: 'too_many_attempts', retryAfterMs: Math.max(0, recent[0] + windowMs - now()) }
      if (await verifyPassphrase(passphrase, stored)) {
        failures = []
        return { ok: true }
      }
      failures.push(now())
      // A wrong answer costs more each time within the window: 0.25 s, 0.5 s, 1 s, up to 4 s.
      await sleep(Math.min(250 * 2 ** (failures.length - 1), 4000))
      return { ok: false, code: 'unauthorized' }
    }
  }
}
