import fs from 'node:fs/promises'
import path from 'node:path'
import { apiError } from './router.mjs'
import { SESSION_ID } from '../meetings/history.mjs'
import { openNoFollow } from '../../platform/index.mjs'

/** Largest plan the API returns; the rest is cut and `truncated` is set (05-api 2.8). */
export const PLAN_CAP = 256 * 1024

const notAllowed = () => apiError(403, 'path_not_allowed')
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code)

/**
 * Resolve a run's `planPath` inside its repo root with the 08-security 4.9 checks: the realpath must stay
 * inside the repo root's realpath, be a regular file, carry no execute bit, and end in `.md`.
 * @param {{ planPath?: string | null }} run a Run from the fleetmates reader
 * @param {string} repoRoot the repo root (the run's repoId)
 * @returns {Promise<string>} the absolute realpath of the plan
 * @throws 404 `not_found` with no planPath or no file; 403 `path_not_allowed` for any refused path
 */
export async function resolveRunPlan(run, repoRoot) {
  const planPath = run?.planPath
  if (typeof planPath !== 'string' || !planPath) throw apiError(404, 'not_found')
  if (planPath.includes('\0') || typeof repoRoot !== 'string' || repoRoot.includes('\0')) throw notAllowed()
  let root
  try { root = await fs.realpath(repoRoot) } catch (error) { throw missing(error) ? apiError(404, 'not_found') : notAllowed() }
  let target
  try { target = await fs.realpath(path.resolve(root, planPath)) } catch (error) { throw missing(error) ? apiError(404, 'not_found') : notAllowed() }
  if (!target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw notAllowed()
  const info = await fs.stat(target)
  if (!info.isFile() || (info.mode & 0o111) !== 0 || path.extname(target).toLowerCase() !== '.md') throw notAllowed()
  return target
}

/**
 * Read a resolved plan without following a swapped-in symlink or blocking on a FIFO, cut at PLAN_CAP bytes
 * on a UTF-8 character boundary.
 * @param {string} file absolute path from resolveRunPlan
 * @returns {Promise<{ markdown: string, truncated: boolean }>}
 */
export async function readRunPlan(file) {
  let handle
  try { handle = await openNoFollow(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)) }
  catch (error) { throw missing(error) ? apiError(404, 'not_found') : notAllowed() }
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o111) !== 0) throw notAllowed()
    const buffer = Buffer.alloc(PLAN_CAP + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    const truncated = size > PLAN_CAP
    let end = Math.min(size, PLAN_CAP)
    if (truncated) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
    return { markdown: buffer.subarray(0, end).toString('utf8'), truncated }
  } finally { await handle.close() }
}

const meetingKinds = new Set(['meetingNote', 'postmeetLog'])

/**
 * Validate a `POST /api/open` body. `runPlan` takes `{ repoId, runId }`; `meetingNote` and `postmeetLog` (M4) take a
 * meeting id string. `vaultNote` takes a vault-relative Markdown path. Unknown kinds or malformed refs are 422.
 * @param {object} body the parsed request body
 * @returns {{ kind: 'runPlan', ref: { repoId: string, runId: string } } | { kind: 'meetingNote' | 'postmeetLog', ref: string }}
 */
export function parseOpenRequest(body) {
  const keys = Object.keys(body)
  if (keys.some(key => !['kind', 'ref'].includes(key))) throw apiError(422, 'validation_failed', { fields: keys.filter(key => !['kind', 'ref'].includes(key)) })
  const { kind, ref } = body
  const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
  if (kind === 'vaultNote') return { kind, ref: vaultNotePath(ref) }
  if (meetingKinds.has(kind)) {
    if (!text(ref)) throw apiError(422, 'validation_failed', { fields: ['ref'] })
    return { kind, ref }
  }
  if (kind !== 'runPlan') throw apiError(422, 'validation_failed', { fields: ['kind'] })
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(key => !['repoId', 'runId'].includes(key)) || !text(ref.repoId) || !text(ref.runId)) {
    throw apiError(422, 'validation_failed', { fields: ['ref'] })
  }
  return { kind, ref: { repoId: ref.repoId, runId: ref.runId } }
}

/** Validate a vault-relative Markdown path before sending it to MCP. @param {unknown} ref */
export function vaultNotePath(ref) {
  if (typeof ref !== 'string' || !ref.endsWith('.md') || ref.length > 512 || ref.startsWith('/') || ref.includes('\\') || ref.includes('\0') || /^[a-z]:/i.test(ref) || ref.split('/').some(part => ['', '.', '..'].includes(part))) throw apiError(422, 'validation_failed', { fields: ['path'] })
  return ref
}

/** Check existence through MCP and construct the decided Obsidian URL, without vault filesystem access. */
export async function resolveVaultNote(service, ref, { vaultPath, obsidianVaultName }) {
  const relative = vaultNotePath(ref)
  await service.note(relative)
  const vault = obsidianVaultName || path.basename(vaultPath)
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(relative)}`
}

/**
 * The realpath of `target` when it sits inside the realpath of `root` and is a regular file with no execute bit and
 * the extension `ext` (08-security 4.9).
 * @param {string} root
 * @param {string} target absolute, or relative to `root`
 * @param {string} ext lower-case extension with its dot
 * @returns {Promise<{ root: string, file: string }>}
 * @throws 404 `not_found` when the root or the file does not exist; 403 `path_not_allowed` for any refused path
 */
async function resolveInside(root, target, ext) {
  if (typeof root !== 'string' || !root || root.includes('\0') || typeof target !== 'string' || target.includes('\0')) throw notAllowed()
  let realRoot
  try { realRoot = await fs.realpath(root) } catch (error) { throw missing(error) ? apiError(404, 'not_found') : notAllowed() }
  let file
  try { file = await fs.realpath(path.resolve(realRoot, target)) } catch (error) { throw missing(error) ? apiError(404, 'not_found') : notAllowed() }
  if (!file.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) throw notAllowed()
  const info = await fs.stat(file)
  if (!info.isFile() || (info.mode & 0o111) !== 0 || path.extname(file).toLowerCase() !== ext) throw notAllowed()
  return { root: realRoot, file }
}

/**
 * The `obsidian://open` URL of a meeting note (kind `meetingNote`): `notePath` is vault-relative; its realpath must
 * stay inside the vault's, be a regular `.md` file and carry no execute bit.
 * @param {{ vaultPath: string, notePath: string, vaultName?: string | null }} where `vaultName` defaults to the
 *   basename of the vault directory's realpath
 * @returns {Promise<string>} `obsidian://open?vault=<name>&file=<encoded vault-relative path>`
 * @throws 404 `not_found` or 403 `path_not_allowed`
 */
export async function resolveMeetingNote({ vaultPath, notePath, vaultName = null }) {
  if (typeof notePath !== 'string' || !notePath || path.isAbsolute(notePath)) throw notAllowed()
  const { root, file } = await resolveInside(vaultPath, notePath, '.md')
  const name = typeof vaultName === 'string' && vaultName ? vaultName : path.basename(root)
  return `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(path.relative(root, file))}`
}

/**
 * The absolute realpath of a meeting's `postmeet.log` (kind `postmeetLog`): `<sessionDir>/<id>/postmeet.log`, its
 * realpath inside `sessionDir`'s, a regular `.log` file with no execute bit.
 * @param {string} sessionDir
 * @param {string} id a session id
 * @returns {Promise<string>}
 * @throws 404 `not_found` or 403 `path_not_allowed`
 */
export async function resolvePostmeetLog(sessionDir, id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw apiError(404, 'not_found')
  return (await resolveInside(sessionDir, path.join(id, 'postmeet.log'), '.log')).file
}
