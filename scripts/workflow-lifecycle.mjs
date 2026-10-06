import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
export function discover(cwd) {
  const [common, root] = git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], cwd).split('\n')
  if (!common || !root) throw new Error('Cannot resolve repository')
  return { common, root }
}
function identity(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{M}\p{N}._/-]{1,255}$/u.test(value) || value !== value.normalize('NFC') || /\p{Default_Ignorable_Code_Point}/u.test(value)
      || value.split('/').some(v => !v || v === '.' || v === '..')) throw new Error('Invalid run identity')
  return value
}
function sessionFile(common, session) {
  if (typeof session !== 'string' || !session.trim() || Buffer.byteLength(session) > 512) throw new Error('Invalid session identity')
  return path.join(common, 'fleetmates-sessions', createHash('sha256').update(session).digest('hex') + '.json')
}
export function markerRef(run, state) {
  if (!['suspended', 'abandoned'].includes(state)) throw new Error('Invalid lifecycle state')
  return `refs/fleetmates/${identity(run)}/${state}`
}
function resolve(ref, root) {
  try { return git(['rev-parse', '--verify', '--quiet', '--end-of-options', ref], root) }
  catch (error) { if (error.status === 1) return null; throw error }
}
export function lifecycleStatus(root, run) {
  // Legacy reporting accepts printable labels that Git cannot use in a ref.
  // New transitions still validate their identity before touching any marker.
  try { identity(run) } catch { return { state: 'running', abandoned: null, suspended: null, verifiedComplete: false, markerSupport: 'unsupported-run-identity' } }
  const abandoned = resolve(markerRef(run, 'abandoned'), root)
  const suspended = resolve(markerRef(run, 'suspended'), root)
  return { state: abandoned ? 'abandoned' : suspended ? 'suspended' : 'running', abandoned, suspended,
    verifiedComplete: false }
}
export function transition(root, run, action, branch) {
  identity(run)
  const status = lifecycleStatus(root, run)
  if (status.abandoned) throw new Error('Abandoned run identities cannot be resumed or reused')
  if (!['suspend', 'resume', 'abandon'].includes(action)) throw new Error('Invalid transition')
  const ref = markerRef(run, action === 'abandon' ? 'abandoned' : 'suspended')
  if (action === 'resume') {
    if (status.suspended) git(['update-ref', '-d', ref, status.suspended], root)
  } else {
    const current = git(['symbolic-ref', '--quiet', 'HEAD'], root)
    if (typeof branch !== 'string' || current !== branch || !branch.startsWith('refs/heads/')) throw new Error('Run branch identity mismatch')
    const tip = git(['rev-parse', '--verify', '--end-of-options', branch], root)
    const previous = resolve(ref, root)
    git(['update-ref', '--create-reflog', '-m', `fleetmates ${action}: local Git identity is not authenticated authorization`, ref, tip, previous || ''], root)
  }
  return lifecycleStatus(root, run)
}
export function planHash(root, ref, plan) {
  if (typeof plan !== 'string' || path.isAbsolute(plan) || plan.split('/').some(v => !v || v === '..' || v === '.') || plan.includes('\\')) throw new Error('Plan must be a repository relative path')
  const mode = git(['ls-tree', ref, '--', `:(literal)${plan}`], root).split(' ')[0]
  if (!['100644', '100755'].includes(mode)) throw new Error('Plan must be a tracked regular file')
  const body = execFileSync('git', ['show', `${ref}:${plan}`], { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  return createHash('sha256').update(body).digest('hex')
}
export async function bindSession(root, session, { run, branch, base, plan, anchor }) {
  identity(run)
  const { common, root: top } = discover(root)
  if (git(['symbolic-ref', '--quiet', 'HEAD'], root) !== branch) throw new Error('Run branch identity mismatch')
  const binding = { version: 1, root: top, run, branch, base, plan, planHash: planHash(root, anchor, plan) }
  const file = sessionFile(common, session)
  await mkdir(path.dirname(file), { recursive: true })
  try { await writeFile(file, JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (JSON.stringify(await readBinding(common, session)) !== JSON.stringify(binding)) throw new Error('Session already bound to different run requirements; use a new session')
  }
  return binding
}
export async function readBinding(common, session) {
  try {
    const fd = await open(sessionFile(common, session), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let body
    try {
      const stat = await fd.stat()
      if (!stat.isFile() || stat.size > 8192) throw new Error('Session binding must be a bounded regular file')
      const buffer = Buffer.alloc(8193)
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 8192) throw new Error('Oversized session binding')
      body = buffer.subarray(0, bytesRead).toString('utf8')
    } finally { await fd.close() }
    const value = JSON.parse(body)
    if (value.version !== 1 || typeof value.root !== 'string' || !value.branch?.startsWith('refs/heads/')
        || typeof value.base !== 'string' || !/^[a-f0-9]{64}$/.test(value.planHash)) throw new Error('Malformed session binding')
    identity(value.run)
    return value
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
