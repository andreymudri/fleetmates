import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readlinkSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { baselineContent, baselineHead, workingRoot } from '../machines/session.mjs'
import { gitRead } from './git-read.mjs'

/** Diff text is cut at a line start above this many bytes (docs/deck/05-api.md 2.3). */
export const MAX_DIFF_BYTES = 512 * 1024
/** Either side above this many bytes is not diffed; the result is empty and truncated. */
export const MAX_SIDE_BYTES = 8 * 1024 * 1024

/** An error carrying an API error code (`validation_failed` or `not_found`). */
export class DiffError extends Error {
  /** @param {'validation_failed'|'not_found'} code */
  constructor(code) {
    super(code)
    this.code = code
  }
}

function changedPaths(session) {
  const value = session.changed_files ?? session.changedFiles ?? '[]'
  try {
    const files = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(files) ? files.map(file => file?.path).filter(name => typeof name === 'string') : []
  } catch { return [] }
}

function inside(boundary, file) {
  return file === boundary || file.startsWith(`${boundary}${path.sep}`)
}

/** The deepest existing ancestor of `file`, resolved through symlinks, must stay inside the repository. */
function resolvesInside(root, file) {
  let boundary
  try { boundary = realpathSync(root) } catch { return false }
  let current = path.dirname(file)
  while (true) {
    try { return inside(boundary, realpathSync(current)) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return false
    }
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function readCurrent(file) {
  let stat
  try { stat = lstatSync(file) } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { kind: 'missing', bytes: Buffer.alloc(0), size: 0 }
    throw error
  }
  if (stat.isSymbolicLink()) {
    const bytes = Buffer.from(readlinkSync(file))
    return { kind: 'symlink', bytes, size: bytes.length }
  }
  if (!stat.isFile()) return { kind: 'special', bytes: null, size: 0 }
  if (stat.size > MAX_SIDE_BYTES) return { kind: 'file', bytes: null, size: stat.size }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) return { kind: 'special', bytes: null, size: 0 }
    if (before.size > MAX_SIDE_BYTES) return { kind: 'file', bytes: null, size: before.size }
    const bytes = Buffer.alloc(before.size)
    let at = 0
    while (at < bytes.length) {
      const read = readSync(fd, bytes, at, bytes.length - at, at)
      if (!read) break
      at += read
    }
    return { kind: 'file', bytes: bytes.subarray(0, at), size: at }
  } finally { closeSync(fd) }
}

async function headContent(root, head, name) {
  if (!head || head === 'unborn') return Buffer.alloc(0)
  const found = await gitRead(root, ['rev-parse', '--verify', '--quiet', `${head}:${name}`])
  const oid = found?.code === 0 ? found.stdout.toString('utf8').trim() : ''
  if (!/^[0-9a-f]{40,64}$/.test(oid)) return Buffer.alloc(0)
  const type = await gitRead(root, ['cat-file', '-t', oid])
  if (type?.code !== 0 || type.stdout.toString('utf8').trim() !== 'blob') return Buffer.alloc(0)
  const shown = await gitRead(root, ['show', '--no-textconv', oid], { maxBuffer: MAX_SIDE_BYTES })
  return shown?.code === 0 ? shown.stdout : null
}

function binary(bytes) {
  return bytes.subarray(0, 8000).includes(0)
}

function cut(text) {
  if (text.length <= MAX_DIFF_BYTES) return { diff: text.toString('utf8'), truncated: false }
  const end = text.lastIndexOf(10, MAX_DIFF_BYTES - 1)
  return { diff: text.subarray(0, end + 1).toString('utf8'), truncated: true }
}

/**
 * The unified diff of one changed file of a session against its review baseline (GET
 * /api/sessions/:id/diff). The baseline side is the content the review baseline stored for the path,
 * else the blob at the baseline head, else empty; the current side is the working file, where a symlink
 * is read as its target text and never followed and any other non-regular file is reported by `kind`
 * without being read. Throws a DiffError `validation_failed` when `name` is absolute, holds NUL, escapes
 * the repository or resolves outside it, and `not_found` when it is not one of the session's
 * `changedFiles`.
 * @param {{ cwd: string, review_baseline?: string|null, changed_files?: string, changedFiles?: Array<{ path: string }> }} session
 * @param {string} name repository-relative path
 * @returns {Promise<{ path: string, baseline: string|null, diff: string, binary: boolean, truncated: boolean, kind: 'file'|'symlink'|'missing'|'special', size?: number }>}
 */
export async function sessionDiff(session, name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || path.isAbsolute(name)) throw new DiffError('validation_failed')
  const relative = path.posix.normalize(name.replaceAll('\\', '/'))
  if (relative === '..' || relative.startsWith('../') || relative === '.' || relative.endsWith('/')) throw new DiffError('validation_failed')
  const root = workingRoot(session.cwd)
  const file = path.resolve(root, relative)
  if (!inside(root, file) || file === root || !resolvesInside(root, file)) throw new DiffError('validation_failed')
  if (!changedPaths(session).includes(file)) throw new DiffError('not_found')
  const value = session.review_baseline ?? null
  const head = baselineHead(value)
  const result = { path: relative, baseline: head && head !== 'unborn' ? head : null, diff: '', binary: false, truncated: false }
  const current = readCurrent(file)
  const before = baselineContent(value, relative) ?? await headContent(root, head, relative)
  if (current.bytes === null || before === null || before.length > MAX_SIDE_BYTES) {
    return { ...result, kind: current.kind, truncated: current.kind !== 'special' }
  }
  if (binary(before) || binary(current.bytes)) return { ...result, kind: current.kind, binary: true, size: current.size }
  if (before.equals(current.bytes)) return { ...result, kind: current.kind }
  let directory
  try {
    directory = mkdtempSync(path.join(tmpdir(), 'deck-diff-'))
    writeFileSync(path.join(directory, 'before'), before, { mode: 0o600 })
    writeFileSync(path.join(directory, 'after'), current.bytes, { mode: 0o600 })
    const output = await gitRead(directory, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '-U3', '--', 'before', 'after'], { maxBuffer: 2 * MAX_SIDE_BYTES + 1024 * 1024 })
    if (!output || output.code !== 1) throw new Error('git diff failed')
    const hunk = output.stdout.indexOf('\n@@')
    const body = hunk < 0 ? Buffer.alloc(0) : output.stdout.subarray(hunk + 1)
    const text = Buffer.concat([Buffer.from(`--- a/${relative}\n+++ b/${relative}\n`), body])
    return { ...result, kind: current.kind, ...cut(text) }
  } finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
}
