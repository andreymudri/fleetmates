import fs from 'node:fs/promises'
import path from 'node:path'
import { apiError } from './router.mjs'

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
  try { handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW) }
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

const laterKinds = new Set(['vaultNote', 'meetingNote', 'postmeetLog'])

/**
 * Validate a `POST /api/open` body. Only `runPlan` is served in M2; the later kinds are refused with
 * `details.reason: 'kind_not_available'`, and an unknown kind or malformed ref is a plain 422.
 * @param {object} body the parsed request body
 * @returns {{ kind: 'runPlan', ref: { repoId: string, runId: string } }}
 */
export function parseOpenRequest(body) {
  const keys = Object.keys(body)
  if (keys.some(key => !['kind', 'ref'].includes(key))) throw apiError(422, 'validation_failed', { fields: keys.filter(key => !['kind', 'ref'].includes(key)) })
  const { kind, ref } = body
  if (laterKinds.has(kind)) throw apiError(422, 'validation_failed', { fields: ['kind'], reason: 'kind_not_available' })
  if (kind !== 'runPlan') throw apiError(422, 'validation_failed', { fields: ['kind'] })
  const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(key => !['repoId', 'runId'].includes(key)) || !text(ref.repoId) || !text(ref.runId)) {
    throw apiError(422, 'validation_failed', { fields: ['ref'] })
  }
  return { kind, ref: { repoId: ref.repoId, runId: ref.runId } }
}
