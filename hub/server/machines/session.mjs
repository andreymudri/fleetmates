import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { expireRequests, matchKey, toolLine } from './request.mjs'

const maxGitOutput = 1024 * 1024
const maxChangedPaths = 512
const maxScannedPaths = 4096
const maxScannedBytes = 32 * 1024 * 1024

function git(root, args, budget = null, differences = false, input = undefined) {
  if (budget && Date.now() >= budget.deadline) return null
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
      timeout: budget ? Math.max(1, Math.min(1500, budget.deadline - Date.now())) : 1500,
      maxBuffer: maxGitOutput,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore']
    })
  } catch (error) {
    if (differences && error.status === 1 && Buffer.isBuffer(error.stdout)) return error.stdout
    return null
  }
}

function gitHead(root, budget = null) {
  const output = git(root, ['rev-parse', '--verify', 'HEAD'], budget)?.toString('utf8').trim()
  if (/^[0-9a-f]{40,64}$/.test(output ?? '')) return output
  return git(root, ['rev-parse', '--is-inside-work-tree'], budget)?.toString('utf8').trim() === 'true' ? 'unborn' : null
}

function gitBranch(root) {
  const budget = { deadline: Date.now() + 1500 }
  const output = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], budget)
    ?? git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], budget)
  const branch = output?.toString('utf8').trim()
  return branch && branch.length <= 1024 && !/[\x00-\x20\x7f]/.test(branch) ? branch : null
}

function baseline(value) {
  try {
    const parsed = JSON.parse(value)
    return (parsed.head === 'unborn' || /^[0-9a-f]{40,64}$/.test(parsed.head)) && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files) ? parsed : null
  } catch { return null }
}

function scanBudget() {
  return { remaining: maxScannedBytes, remainingPaths: maxScannedPaths, deadline: Date.now() + 1500 }
}

function workingPath(root, name, budget) {
  if (Date.now() >= budget.deadline) throw new Error('scan timeout')
  const boundary = realpathSync(root)
  const file = path.resolve(boundary, name)
  if (!file.startsWith(`${boundary}${path.sep}`)) throw new Error('path outside repository')
  let directory = boundary
  for (const component of path.relative(boundary, path.dirname(file)).split(path.sep).filter(Boolean)) {
    if (Date.now() >= budget.deadline) throw new Error('scan timeout')
    directory = path.join(directory, component)
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error('symlinked repository ancestor')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') break
      throw error
    }
  }
  return file
}

function hashFile(file, normalize, budget, algorithm = 'sha256', blob = false, ident = false) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (Date.now() >= budget.deadline || !before.isFile() || before.size > budget.remaining) throw new Error('scan limit')
    const buffer = Buffer.alloc(64 * 1024)
    const pass = consume => {
      let position = 0
      let pendingCR = false
      let marker = []
      const send = chunk => {
        if (!ident) { consume(chunk); return }
        const output = []
        for (const byte of chunk) {
          if (!marker.length) { if (byte === 36) marker.push(byte); else output.push(byte); continue }
          if (marker.length < 4) {
            if (byte === [36, 73, 100, 58][marker.length]) { marker.push(byte); continue }
            output.push(...marker)
            marker = byte === 36 ? [byte] : []
            if (byte !== 36) output.push(byte)
          } else if (byte === 36) { output.push(36, 73, 100, 36); marker = [] }
          else if (byte === 10) { output.push(...marker, byte); marker = [] }
          else { marker.push(byte); if (marker.length > 4096) throw new Error('ident scan limit') }
        }
        consume(Buffer.from(output))
      }
      while (position < before.size) {
        if (Date.now() > budget.deadline) throw new Error('scan timeout')
        const length = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position)
        if (!length || length > budget.remaining) throw new Error('scan limit')
        budget.remaining -= length
        position += length
        const chunk = buffer.subarray(0, length)
        if (!normalize) { send(chunk); continue }
        const output = Buffer.alloc(length + 1)
        let used = 0
        for (const byte of chunk) {
          if (pendingCR && byte !== 10) output[used++] = 13
          pendingCR = byte === 13
          if (!pendingCR) output[used++] = byte
        }
        send(output.subarray(0, used))
      }
      if (pendingCR) send(Buffer.from([13]))
      if (marker.length) consume(Buffer.from(marker))
    }
    let size = before.size
    if (blob && (normalize || ident)) { size = 0; pass(chunk => { size += chunk.length }) }
    const hash = createHash(algorithm)
    if (blob) hash.update(`blob ${size}\0`)
    pass(chunk => hash.update(chunk))
    const after = fstatSync(fd)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('file changed during scan')
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

function gitPaths(root, head, budget = scanBudget(), depth = 0) {
  if (depth > 4 || Date.now() >= budget.deadline) return null
  const tree = head === 'unborn' ? Buffer.alloc(0) : git(root, ['ls-tree', '-r', '-z', head], budget)
  const namesOnly = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], budget)
  const indexOutput = git(root, ['ls-files', '--stage', '-t', '-z'], budget)
  if (!tree || !namesOnly || !indexOutput) return null
  const sparse = new Map()
  for (const record of indexOutput.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^S (\d+) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/.exec(record)
    if (match) sparse.set(match[3], { mode: match[1], oid: match[2] })
  }
  const autoCRLF = /^(true|input)$/.test(git(root, ['config', '--get', 'core.autocrlf'], budget)?.toString('utf8').trim() ?? '')
  const fileMode = git(root, ['config', '--bool', '--get', 'core.filemode'], budget)?.toString('utf8').trim() !== 'false'
  const entries = new Map()
  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record)
    if (!match) return null
    entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] })
  }
  if (entries.size > budget.remainingPaths) return null
  const workingNames = new Set([...entries.keys(), ...namesOnly.toString('utf8').split('\0').filter(Boolean)])
  if (workingNames.size > budget.remainingPaths) return null
  try { for (const name of workingNames) workingPath(root, name, budget) }
  catch { return null }
  const listed = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--eol', '-z'], budget)
  if (!listed) return null
  const blobs = [...new Set([...entries.values()].filter(entry => entry.type === 'blob').map(entry => entry.oid).concat([...sparse.values()].filter(entry => entry.mode !== '160000').map(entry => entry.oid)))]
  if (blobs.length) {
    const checked = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], budget, false, `${blobs.join('\n')}\n`)?.toString('utf8').trim().split('\n')
    if (!checked || checked.length !== blobs.length || checked.some((line, index) => line !== `${blobs[index]} blob`)) return null
  }
  const normalization = new Map()
  for (const record of listed.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*?)\s*\t([\s\S]+)$/.exec(record)
    if (!match) return null
    const [, indexEol, worktreeEol, attr, name] = match
    const explicitText = /^text(?: |$)/.test(attr) || /^eol=/.test(attr)
    const autoText = attr.startsWith('text=auto') || !attr && autoCRLF
    normalization.set(name, explicitText || autoText && worktreeEol !== '-text' && !['crlf', 'mixed'].includes(indexEol))
  }
  const names = new Set([...entries.keys(), ...normalization.keys()])
  const ident = new Set()
  if (names.size) {
    const attributes = git(root, ['check-attr', '-z', '--stdin', 'ident'], budget, false, `${[...names].join('\0')}\0`)?.toString('utf8').split('\0')
    if (!attributes) return null
    for (let i = 0; i + 2 < attributes.length; i += 3) if (attributes[i + 2] === 'set') ident.add(attributes[i])
  }
  budget.remainingPaths -= names.size
  if (budget.remainingPaths < 0 || Date.now() >= budget.deadline) return null
  const paths = new Map()
  const gitlinks = new Map()
  for (const name of names) {
    const entry = entries.get(name)
    const skipped = sparse.get(name)
    if (skipped) {
      try { lstatSync(workingPath(root, name, budget)) }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null
        if (!entry || entry.oid !== skipped.oid || entry.mode !== skipped.mode) paths.set(name, { adds: null, dels: null })
        continue
      }
    }
    if (entry?.type === 'commit') {
      let location
      try { location = workingPath(root, name, budget) } catch { return null }
      const link = gitlinkState(location, budget, depth + 1)
      if (!link) return null
      gitlinks.set(name, link)
      if (!link.uninitialized && (link.head !== entry.oid || link.dirty)) paths.set(name, { adds: null, dels: null })
      continue
    }
    let unchanged = false
    if (entry) {
      try {
        const location = workingPath(root, name, budget)
        const stat = lstatSync(location)
        let oid = null
        let mode = null
        const algorithm = entry.oid.length === 64 ? 'sha256' : 'sha1'
        if (stat.isSymbolicLink()) {
          const content = Buffer.from(readlinkSync(location))
          oid = createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex')
          mode = '120000'
        } else if (stat.isFile()) {
          oid = hashFile(location, normalization.get(name) ?? false, budget, algorithm, true, ident.has(name))
          mode = stat.mode & 0o111 ? '100755' : '100644'
        } else return null
        unchanged = oid === entry.oid && (mode === entry.mode || !fileMode && ['100644', '100755'].includes(mode) && ['100644', '100755'].includes(entry.mode))
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null }
    }
    if (!unchanged) paths.set(name, { adds: null, dels: null })
  }
  return paths.size <= maxChangedPaths ? { paths, normalization, ident, sparse, budget, fileMode, gitlinks, depth, entries } : null
}

function fileFingerprint(root, name, scan) {
  const file = workingPath(root, name, scan.budget)
  if (scan.gitlinks?.has(name)) return scan.gitlinks.get(name).fingerprint
  try {
    const stat = lstatSync(file)
    if (stat.isDirectory()) {
      const link = gitlinkState(file, scan.budget, scan.depth + 1)
      if (!link) throw new Error('incomplete submodule scan')
      return link.fingerprint
    }
    if (stat.isSymbolicLink()) return `link:${createHash('sha256').update(readlinkSync(file)).digest('hex')}`
    if (!stat.isFile()) throw new Error('unsupported file')
    const executable = scan.fileMode && stat.mode & 0o111 ? 'x' : '-'
    return `file:${executable}:${hashFile(file, scan.normalization.get(name) ?? false, scan.budget, 'sha256', false, scan.ident?.has(name))}`
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      const skipped = scan.sparse?.get(name)
      return skipped ? `sparse:${skipped.mode}:${skipped.oid}` : null
    }
    throw error
  }
}

function gitlinkState(directory, budget, depth) {
  if (depth > 4 || Date.now() >= budget.deadline) return null
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory()) {
      const fingerprint = stat.isSymbolicLink()
        ? `link:${createHash('sha256').update(readlinkSync(directory)).digest('hex')}`
        : `file:${hashFile(directory, false, budget)}`
      return { head: null, dirty: true, fingerprint }
    }
    try { lstatSync(path.join(directory, '.git')) }
    catch (error) {
      if (error.code === 'ENOENT') return { uninitialized: true, fingerprint: 'uninitialized' }
      return null
    }
    const top = git(directory, ['rev-parse', '--show-toplevel'], budget)?.toString('utf8').trim()
    if (!top || realpathSync(top) !== realpathSync(directory)) return null
    const head = gitHead(directory, budget)
    if (!head || head === 'unborn') return null
    const scan = gitPaths(directory, head, budget, depth)
    if (!scan) return null
    const files = [...scan.paths.keys()].sort().map(name => [name, fileFingerprint(directory, name, scan)])
    const fingerprint = `gitlink:${head}:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`
    return { head, dirty: files.length > 0, fingerprint }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { head: null, dirty: true, fingerprint: null }
    return null
  }
}

function statisticsBudget(scan) {
  return { remaining: 4 * 1024 * 1024, deadline: scan.budget.deadline }
}

function lineBytes(root, name, scan, budget) {
  let fd
  try {
    const file = workingPath(root, name, budget)
    if (Date.now() >= budget.deadline) return null
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) {
      const bytes = Buffer.from(readlinkSync(file))
      if (bytes.length > budget.remaining) return null
      budget.remaining -= bytes.length
      return bytes
    }
    if (!stat.isFile() || stat.size > maxGitOutput || stat.size > budget.remaining) return null
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size !== stat.size) return null
    const bytes = Buffer.alloc(before.size)
    let at = 0
    while (at < bytes.length) {
      if (Date.now() >= budget.deadline) return null
      const read = readSync(fd, bytes, at, bytes.length - at, at)
      if (!read) return null
      at += read
    }
    budget.remaining -= bytes.length
    const after = fstatSync(fd)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null
    const finish = value => scan.ident?.has(name) ? Buffer.from(value.toString('latin1').replace(/\$Id:[^\n$]*\$/g, '$Id$'), 'latin1') : value
    if (!scan.normalization.get(name)) return finish(bytes)
    const normalized = Buffer.alloc(bytes.length)
    let used = 0
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] === 13 && bytes[index + 1] === 10) continue
      normalized[used++] = bytes[index]
    }
    return finish(normalized.subarray(0, used))
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null
    const skipped = scan.sparse?.get(name)
    if (!skipped) return Buffer.alloc(0)
    const bytes = git(root, ['cat-file', 'blob', skipped.oid], budget)
    if (!bytes || bytes.length > budget.remaining) return null
    budget.remaining -= bytes.length
    return bytes
  } finally { if (fd !== undefined) closeSync(fd) }
}

function lineStatistics(root, name, saved, scan, budget, binary) {
  const unknown = { adds: null, dels: null }
  if (scan.gitlinks.has(name) || binary === undefined || binary === 'unset' || Date.now() >= budget.deadline) return unknown
  let before
  if (Object.hasOwn(saved.files, name)) {
    const content = saved.contents?.[name]
    if (typeof content !== 'string' || content.length > Math.ceil(maxGitOutput / 3) * 4) return unknown
    before = Buffer.from(content, 'base64')
  } else {
    const entry = scan.entries.get(name)
    if (entry?.type === 'commit') return unknown
    before = entry ? git(root, ['cat-file', 'blob', entry.oid], budget) : Buffer.alloc(0)
  }
  if (!before || before.length > budget.remaining) return unknown
  budget.remaining -= before.length
  const after = lineBytes(root, name, scan, budget)
  if (!after || before.includes(0) || after.includes(0)) return unknown
  if (before.equals(after)) return { adds: 0, dels: 0 }
  let directory
  try {
    directory = mkdtempSync(path.join(tmpdir(), 'deck-numstat-'))
    writeFileSync(path.join(directory, 'before'), before, { mode: 0o600 })
    writeFileSync(path.join(directory, 'after'), after, { mode: 0o600 })
    const output = git(directory, ['-c', 'diff.algorithm=myers', 'diff', '--no-index', '--numstat', '--no-ext-diff', '--no-textconv', '--no-renames', '--', 'before', 'after'], budget, true)?.toString('utf8')
    const match = /^(\d+)\t(\d+)\t/.exec(output ?? '')
    return match ? { adds: Number(match[1]), dels: Number(match[2]) } : unknown
  } catch { return unknown }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
}

/** Capture the current Git changes as a review boundary. */
export function captureReviewBaseline(root, previous = null, includeExisting = true) {
  const head = baseline(previous)?.head ?? gitHead(root)
  if (!head) return null
  const scan = includeExisting ? gitPaths(root, head) : { paths: new Map(), normalization: new Map(), budget: scanBudget() }
  if (!scan) return null
  try {
    const files = Object.fromEntries([...scan.paths.keys()].map(name => [name, fileFingerprint(root, name, scan)]))
    const budget = statisticsBudget(scan)
    const contents = Object.fromEntries(Object.keys(files).map(name => {
      const bytes = lineBytes(root, name, scan, budget)
      const digest = bytes && createHash('sha256').update(bytes).digest('hex')
      const skipped = scan.sparse?.get(name)
      const sparseContent = skipped && bytes && files[name] === `sparse:${skipped.mode}:${skipped.oid}` && createHash(skipped.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === skipped.oid
      const consistent = files[name] === null && bytes?.length === 0 || files[name]?.endsWith(digest ?? '-') || sparseContent
      return [name, bytes && consistent ? bytes.toString('base64') : null]
    }))
    return JSON.stringify({ head, files, contents })
  } catch { return null }
}

function gitChangedFiles(root, value) {
  const saved = baseline(value)
  if (!saved) return null
  const scan = gitPaths(root, saved.head)
  if (!scan) return null
  const { paths } = scan
  for (const name of Object.keys(saved.files)) if (!paths.has(name)) paths.set(name, { adds: null, dels: null })
  if (paths.size > maxChangedPaths) return null
  try {
    const changed = [...paths.keys()].filter(name => !Object.hasOwn(saved.files, name) || saved.files[name] !== fileFingerprint(root, name, scan))
    if (!changed.length) return []
    const attributes = git(root, ['check-attr', '-z', 'diff', '--', ...changed], scan.budget)?.toString('utf8').split('\0')
    const binary = new Map()
    if (attributes) for (let index = 0; index + 2 < attributes.length; index += 3) binary.set(attributes[index], attributes[index + 2])
    const budget = statisticsBudget(scan)
    return changed.map(name => ({ path: path.resolve(root, name), ...lineStatistics(root, name, saved, scan, budget, binary.get(name)) }))
  } catch { return null }
}

/** Refresh final Git changes, retaining known changes if the bounded scan is incomplete. */
export function refreshSessionChanges(store, session) {
  const boundary = session.review_baseline ?? captureReviewBaseline(workingRoot(session.cwd), null, false)
  const files = gitChangedFiles(workingRoot(session.cwd), boundary)
  if (files === null) return session
  const changedFiles = JSON.stringify(files)
  store.run('UPDATE sessions SET changed_files=?,review_baseline=? WHERE id=?', changedFiles, boundary, session.id)
  return { ...session, changed_files: changedFiles, review_baseline: boundary }
}

/** Resolve the bounded canonical working tree used for filesystem observations. */
export function workingRoot(cwd) {
  let root = cwd || '/unknown'
  try { root = realpathSync(root) } catch {}
  let current = root
  for (let depth = 0; depth < 32; depth++) {
    const marker = path.join(current, '.git')
    try {
      const stat = statSync(marker)
      if (stat.isDirectory() || stat.isFile() && stat.size <= 4096 && readFileSync(marker, 'utf8').startsWith('gitdir:')) return current
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return root
}

function repo(store, cwd, at) {
  const root = workingRoot(cwd)
  let id = root
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.toString('utf8').trim()
  if (common && path.isAbsolute(common) && path.basename(common) === '.git') {
    try { id = realpathSync(path.dirname(common)) } catch {}
  }
  if (store.get('SELECT id FROM repos WHERE id=?', id)) return id
  let name = path.basename(id) || id
  const collisions = store.all('SELECT id,name,crew_seed FROM repos WHERE archived_at IS NULL').filter(row => path.basename(row.id) === name)
  if (collisions.length) {
    const group = [...collisions, { id }]
    let depth = 2
    const display = value => value.split(path.sep).filter(Boolean).slice(-depth).join('/')
    while (depth < 32 && new Set(group.map(row => display(row.id))).size !== group.length) depth++
    for (const row of collisions) store.run('UPDATE repos SET name=?,crew_seed=? WHERE id=?', display(row.id), row.crew_seed === row.name ? display(row.id) : row.crew_seed, row.id)
    name = display(id)
  }
  const used = new Set(store.all('SELECT crew_slot FROM repos WHERE archived_at IS NULL').map(row => row.crew_slot))
  let slot = Array.from({ length: 9 }, (_, i) => i).find(i => !used.has(i))
  const shared = slot === undefined
  if (shared) {
    let hash = 2166136261
    for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619) >>> 0
    slot = hash % 9
  }
  store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', id, name, slot, shared ? 1 : 0, name, at)
  return id
}

function sessionActivity(store, session, envelope) {
  if (!session.alive) return null
  const history = store.all('SELECT payload,hook_ts,pty_id,claude_pid FROM hook_events WHERE session_id=? AND applied=1 ORDER BY hook_ts DESC,id DESC LIMIT 512', session.id)
    .map(row => ({ hook: JSON.parse(row.payload), hookTs: row.hook_ts, ptyId: row.pty_id, claudePid: row.claude_pid }))
    .filter(item => sameKnownProcess(store, session, item))
  const tools = []
  let compacting = false
  for (const { hook } of [...history.reverse(), envelope].sort((a, b) => a.hookTs - b.hookTs)) {
    const event = hook.hook_event_name
    if (['SessionStart', 'UserPromptSubmit', 'SessionEnd'].includes(event)) { tools.length = 0; compacting = false }
    if (event === 'PreCompact') compacting = true
    if (event === 'PostCompact') compacting = false
    if (event === 'Stop' || event === 'Notification' && hook.notification_type === 'idle_prompt') tools.length = 0
    if (event === 'PreToolUse' && hook.tool_name) tools.push({ id: hook.tool_use_id, name: hook.tool_name, input: JSON.stringify(hook.tool_input ?? {}) })
    if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) {
      const index = tools.findIndex(tool => hook.tool_use_id ? tool.id === hook.tool_use_id : tool.name === hook.tool_name && tool.input === JSON.stringify(hook.tool_input ?? {}))
      if (index >= 0) tools.splice(index, 1)
    }
  }
  if (!compacting && ['SubagentStart', 'SubagentStop'].includes(envelope.hook.hook_event_name) && session.activity?.startsWith('tool:')) return session.activity
  return compacting ? 'compacting' : tools.length ? `tool:${tools.at(-1).name}` : session.subagents_active ? `subagents:${session.subagents_active}` : null
}

function editedPath(hook) {
  if (hook.hook_event_name !== 'PostToolUse' || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(hook.tool_name)) return null
  const file = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path
  if (typeof file !== 'string' || !file) return null
  return path.resolve(hook.cwd, file)
}

/** Check whether supplied PTY and PID identities conflict with the session's process. */
export function sameKnownProcess(store, row, envelope) {
  if (envelope.ptyId && row.pty_id && envelope.ptyId !== row.pty_id) return false
  if (envelope.claudePid) {
    const knownPid = row.pty_id
      ? store.get('SELECT claude_pid FROM hook_events WHERE session_id = ? AND claude_pid IS NOT NULL AND applied=1 ORDER BY hook_ts DESC, id DESC LIMIT 1', row.id)?.claude_pid
      : row.process_key
    if (knownPid && String(envelope.claudePid) !== String(knownPid)) return false
  }
  return true
}

/** Resolve a hook by PTY, process, current conversation, aliases, then end/start path fallback. */
export function resolveSession(store, envelope) {
  const hook = envelope.hook
  const pty = envelope.ptyId
  const identity = envelope.claudePid ?? pty
  if (identity && ['SubagentStart', 'SubagentStop'].includes(hook.hook_event_name)) {
    const column = envelope.claudePid ? 'claude_pid' : 'pty_id'
    const previous = store.get(`SELECT s.* FROM sessions s JOIN hook_events e ON e.session_id=s.id
      WHERE e.${column}=? AND e.applied=1 AND e.hook_ts<=? ORDER BY e.hook_ts DESC,e.id DESC LIMIT 1`, identity, envelope.hookTs)
    if (previous && !sameKnownProcess(store, previous, envelope)) return previous
  }
  if (identity) {
    const column = envelope.claudePid ? 'claude_pid' : 'pty_id'
    const previous = store.get(`SELECT s.* FROM sessions s JOIN hook_events e ON e.session_id = s.id
      WHERE e.${column} = ? AND e.hook_ts <= ? AND s.since_ts > ?
      ORDER BY e.hook_ts DESC LIMIT 1`, identity, envelope.hookTs, envelope.hookTs)
    if (previous) return previous
  }
  const historical = store.all('SELECT DISTINCT s.* FROM sessions s LEFT JOIN session_aliases a ON a.session_id = s.id WHERE s.alive = 0 AND s.started_at <= ? AND COALESCE(s.ended_at, s.since_ts) >= ? AND (s.claude_session_id = ? OR a.claude_session_id = ? OR s.pty_id = ? OR s.process_key = ?) ORDER BY s.started_at DESC', envelope.hookTs, envelope.hookTs, hook.session_id, hook.session_id, pty ?? null, envelope.claudePid ? String(envelope.claudePid) : null).find(row => sameKnownProcess(store, row, envelope))
  if (historical) return historical
  if (pty) {
    const found = store.get('SELECT * FROM sessions WHERE pty_id = ? AND alive = 1', pty)
    if (found) return found
  }
  if (envelope.claudePid) {
    const found = store.get('SELECT * FROM sessions WHERE process_key = ? AND alive = 1', String(envelope.claudePid))
    if (found) return found
  }
  const direct = store.all('SELECT * FROM sessions WHERE claude_session_id = ? AND alive = 1 ORDER BY started_at DESC', hook.session_id).find(row => sameKnownProcess(store, row, envelope))
  if (direct) return direct
  const alias = store.all('SELECT s.* FROM sessions s JOIN session_aliases a ON a.session_id = s.id WHERE a.claude_session_id = ? AND s.alive = 1 ORDER BY s.started_at DESC', hook.session_id).find(row => sameKnownProcess(store, row, envelope))
  if (alias) return alias
  if (hook.hook_event_name === 'SessionStart' && hook.source === 'resume') {
    const ended = store.get('SELECT * FROM sessions WHERE claude_session_id = ? AND alive = 0 ORDER BY ended_at DESC LIMIT 1', hook.session_id)
      ?? store.get('SELECT s.* FROM sessions s JOIN session_aliases a ON a.session_id = s.id WHERE a.claude_session_id = ? AND s.alive = 0 ORDER BY s.ended_at DESC LIMIT 1', hook.session_id)
    if (ended) return ended
  }
  if (hook.hook_event_name === 'SessionStart' && ['clear', 'resume', 'fork'].includes(hook.source)) {
    const dirname = hook.transcript_path?.slice(0, hook.transcript_path.lastIndexOf('/'))
    const rows = store.all('SELECT * FROM sessions WHERE cwd = ? AND alive = 1 AND end_reason IN (?, ?) ORDER BY state_since DESC', hook.cwd, 'clear', 'resume')
    return rows.find(row => row.transcript_path?.slice(0, row.transcript_path.lastIndexOf('/')) === dirname && envelope.hookTs - row.state_since <= 5000) ?? null
  }
  return null
}

function acceptsDelayedAliasResume(store, session, envelope) {
  if (envelope.hook.source !== 'resume' || !['clear', 'resume'].includes(session.end_reason)) return false
  const processMatches = envelope.ptyId && envelope.ptyId === session.pty_id
    || envelope.claudePid && (session.pty_id || String(envelope.claudePid) === session.process_key)
  if (!processMatches || !sameKnownProcess(store, session, envelope)) return false
  const pendingEnd = store.get('SELECT hook_ts,claude_session_id FROM hook_events WHERE session_id=? AND event=? AND applied=1 ORDER BY hook_ts DESC,id DESC LIMIT 1', session.id, 'SessionEnd')
  if (!pendingEnd || pendingEnd.claude_session_id !== session.claude_session_id || envelope.hookTs <= pendingEnd.hook_ts) return false
  const activity = store.get(`SELECT claude_session_id,claude_pid,pty_id FROM hook_events
    WHERE session_id=? AND applied=1 AND hook_ts>=? AND event IN ('UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest')
    ORDER BY hook_ts DESC,id DESC LIMIT 1`, session.id, envelope.hookTs)
  if (!activity || activity.claude_session_id !== envelope.hook.session_id) return false
  if (envelope.claudePid && activity.claude_pid) return envelope.claudePid === activity.claude_pid
  return !!envelope.ptyId && envelope.ptyId === activity.pty_id
}

/** Recognize starts from obsolete conversations or conflicting live processes. */
export function isObsoleteSessionStart(store, session, envelope) {
  if (!session?.alive || envelope.hook.hook_event_name !== 'SessionStart') return false
  if (!sameKnownProcess(store, session, envelope)) return true
  if (envelope.hook.session_id === session.claude_session_id) return false
  const alias = store.get('SELECT claude_session_id FROM session_aliases WHERE session_id=? AND claude_session_id=?', session.id, envelope.hook.session_id)
  return !!alias && (envelope.hook.source !== 'resume' || envelope.hookTs < session.since_ts && !acceptsDelayedAliasResume(store, session, envelope))
}

/** Record a current process conversation without changing its activity or state. */
export function recordSessionIdentity(store, session, envelope) {
  const hook = envelope.hook
  if (!session.alive || isObsoleteSessionStart(store, session, envelope) || !sameKnownProcess(store, session, envelope)) return session
  const processMatches = envelope.ptyId && envelope.ptyId === session.pty_id
    || envelope.claudePid && (session.pty_id || String(envelope.claudePid) === session.process_key)
  if (!processMatches) return session
  const replacement = hook.hook_event_name === 'SessionStart' && ['clear', 'resume', 'fork'].includes(hook.source) && ['clear', 'resume'].includes(session.end_reason)
  const pendingEnd = replacement ? store.get('SELECT hook_ts FROM hook_events WHERE session_id=? AND event=? AND applied=1 ORDER BY hook_ts DESC,id DESC LIMIT 1', session.id, 'SessionEnd') : null
  if (replacement && (!pendingEnd || envelope.hookTs < pendingEnd.hook_ts)) return session
  if (hook.session_id !== session.claude_session_id) {
    const boundary = store.get('SELECT MAX(replaced_at) AS at FROM session_aliases WHERE session_id=?', session.id).at ?? session.started_at
    if (envelope.hookTs < boundary) return session
    const oldAlias = store.get('SELECT claude_session_id FROM session_aliases WHERE session_id=? AND claude_session_id=?', session.id, hook.session_id)
    if (oldAlias && !(hook.hook_event_name === 'SessionStart' && ['clear', 'resume', 'fork'].includes(hook.source) && (envelope.hookTs >= session.since_ts || acceptsDelayedAliasResume(store, session, envelope)))) return session
    const source = hook.hook_event_name === 'SessionStart' && ['clear', 'resume', 'fork', 'compact'].includes(hook.source) ? hook.source : 'heuristic'
    store.run('INSERT OR IGNORE INTO session_aliases(claude_session_id,session_id,replaced_at,source) VALUES(?,?,?,?)', session.claude_session_id, session.id, envelope.hookTs, source)
    store.run('UPDATE sessions SET claude_session_id=?,transcript_path=? WHERE id=?', hook.session_id, hook.transcript_path ?? session.transcript_path, session.id)
  }
  if (replacement) {
    store.run('UPDATE sessions SET end_reason=NULL WHERE id=?', session.id)
    store.run('UPDATE requests SET state=?,expired_reason=? WHERE session_id=? AND state=? AND created_at < ?', 'expired', 'session_replaced', session.id, 'open', envelope.hookTs)
  }
  return store.get('SELECT * FROM sessions WHERE id=?', session.id)
}

/** Reconcile accepted agent lifecycles while retaining newer session clocks. */
export function applySubagentLifecycle(store, session, envelope, late = false) {
  const hook = envelope.hook
  const unchanged = { session, accepted: false, changed: false }
  if (!session.alive || !sameKnownProcess(store, session, envelope)) return unchanged
  if (hook.session_id !== session.claude_session_id && !store.get('SELECT claude_session_id FROM session_aliases WHERE session_id=? AND claude_session_id=? AND source=?', session.id, hook.session_id, 'compact')) return unchanged
  const boundary = Math.max(session.joined_mid_life ? 0 : session.started_at, store.get(`SELECT COALESCE(MAX(hook_ts),0) AS at FROM hook_events
    WHERE session_id=? AND applied=1 AND (event='SessionEnd' OR event='SessionStart' AND COALESCE(json_extract(payload,'$.source'),'startup')<>'compact')`, session.id).at)
  if (envelope.hookTs < boundary) return unchanged
  const history = store.all("SELECT event,hook_ts,payload,pty_id,claude_pid FROM hook_events WHERE session_id=? AND applied=1 AND hook_ts>=? AND event IN ('SubagentStart','SubagentStop') ORDER BY hook_ts,id", session.id, boundary)
  const agents = new Map()
  const anonymous = new Map()
  const record = (event, at, id) => {
    if (!id) { anonymous.set(`${at}:${event}`, { event, at }); return }
    const previous = agents.get(id)
    if (!previous || at > previous.at || at === previous.at && event === 'SubagentStop') agents.set(id, { event, at })
  }
  for (const row of history) {
    if (sameKnownProcess(store, session, { ptyId: row.pty_id, claudePid: row.claude_pid })) record(row.event, row.hook_ts, JSON.parse(row.payload).agent_id)
  }
  record(hook.hook_event_name, envelope.hookTs, hook.agent_id)
  let active = 0
  for (const event of [...anonymous.values()].sort((a, b) => a.at - b.at || (a.event === 'SubagentStart' ? -1 : 1))) active = event.event === 'SubagentStart' ? active + 1 : Math.max(0, active - 1)
  active += [...agents.values()].filter(event => event.event === 'SubagentStart').length
  const state = late && active && ['idle', 'done', 'reviewed', 'stale'].includes(session.state) ? 'running' : session.state
  const activity = sessionActivity(store, { ...session, subagents_active: active }, envelope)
  const changed = active !== session.subagents_active || state !== session.state || activity !== session.activity
  if (changed) store.run('UPDATE sessions SET subagents_active=?,state=?,activity=? WHERE id=?', active, state, activity, session.id)
  return { session: changed ? store.get('SELECT * FROM sessions WHERE id=?', session.id) : session, accepted: true, changed }
}

/** Identify hooks that leave session state and activity unchanged. */
export function ignoresSessionHook(store, session, hook) {
  if (!session) return false
  const event = hook.hook_event_name
  if (['WorktreeCreate', 'WorktreeRemove'].includes(event)) return true
  if (event === 'Notification' && ['agent_completed', 'agent_needs_input'].includes(hook.notification_type)) return true
  if (event === 'Stop' && ['idle', 'done', 'reviewed'].includes(session.state)) return true
  if (event === 'Notification' && hook.notification_type === 'idle_prompt') {
    if (['idle', 'done', 'reviewed'].includes(session.state)) return true
    if (session.state === 'asked_you' && store.get('SELECT id FROM requests WHERE session_id = ? AND state = ? AND source = ? LIMIT 1', session.id, 'open', 'stop_question')) return true
  }
  return false
}

/** Apply an observed hook to a session inside the caller's transaction. */
export function applySessionHook(store, envelope, existing, requestChanged) {
  const hook = envelope.hook
  const event = hook.hook_event_name
  const at = envelope.hookTs
  if (!existing) {
    if (event === 'SessionEnd') return null
    const id = randomUUID()
    const initial = event === 'SessionStart' || event === 'Stop' || hook.notification_type === 'idle_prompt' ? 'idle' : event === 'PermissionRequest' || hook.notification_type === 'permission_prompt' ? 'needs_approval' : event === 'PreToolUse' && hook.tool_name === 'AskUserQuestion' || hook.notification_type === 'elicitation_dialog' ? 'asked_you' : 'running'
    const origin = envelope.ptyId ? 'wrapped' : 'observed'
    const edited = editedPath(hook)
    const task = event === 'UserPromptSubmit' ? hook.prompt?.split('\n')[0].slice(0, 120) || 'Untitled' : 'Untitled'
    const repoId = repo(store, hook.cwd, at)
    store.run('INSERT INTO sessions(id,claude_session_id,origin,pty_id,process_key,repo_id,cwd,branch,task,state,state_since,since_ts,last_activity_at,alive,joined_mid_life,started_at,transcript_path,subagents_active,activity,changed_files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, hook.session_id, origin, envelope.ptyId, envelope.ptyId ?? (envelope.claudePid ? String(envelope.claudePid) : null), repoId, hook.cwd, gitBranch(workingRoot(hook.cwd)), task, initial, at, at, at, 1, event === 'SessionStart' ? 0 : 1, at, hook.transcript_path, 0, event === 'PreCompact' ? 'compacting' : null, JSON.stringify(edited ? [{ path: edited, adds: null, dels: null }] : []))
    const reviewBaseline = captureReviewBaseline(workingRoot(hook.cwd), null, event !== 'SessionStart')
    if (reviewBaseline) store.run('UPDATE sessions SET review_baseline = ? WHERE id = ?', reviewBaseline, id)
    if (event === 'UserPromptSubmit') store.run('UPDATE sessions SET last_input_from=? WHERE id=?', 'terminal', id)
    if (event === 'PreToolUse' && hook.tool_name) store.run('UPDATE sessions SET activity=? WHERE id=?', `tool:${hook.tool_name}`, id)
    return store.get('SELECT * FROM sessions WHERE id = ?', id)
  }
  if (at < existing.since_ts) return existing
  if (ignoresSessionHook(store, existing, hook)) return existing
  let state = existing.state
  let stateSince = existing.state_since
  let alive = existing.alive
  let activity = existing.activity
  let subagents = existing.subagents_active
  let endReason = existing.end_reason
  let endAnnounced = existing.end_announced
  let endedAt = existing.ended_at
  let claudeId = existing.claude_session_id
  let task = existing.task
  let cwd = existing.cwd
  let repoId = existing.repo_id
  let branch = existing.branch
  let processKey = existing.process_key
  let ptyId = existing.pty_id
  let changedFiles = JSON.parse(existing.changed_files)
  let reviewBaseline = existing.review_baseline
  if (['SessionStart', 'CwdChanged'].includes(event)) {
    cwd = hook.cwd
    repoId = repo(store, cwd, at)
    branch = gitBranch(workingRoot(cwd))
    if (repoId !== existing.repo_id || workingRoot(cwd) !== workingRoot(existing.cwd)) {
      reviewBaseline = captureReviewBaseline(workingRoot(cwd), null, false)
      changedFiles = []
    }
  }
  const edited = editedPath(hook)
  if (edited && !changedFiles.some(file => file.path === edited)) changedFiles.push({ path: edited, adds: null, dels: null })
  if (event === 'Stop' || event === 'SessionEnd' || event === 'Notification' && hook.notification_type === 'idle_prompt' || event === 'PostToolUse' && hook.tool_name === 'Bash' || event === 'SessionStart' && ['clear', 'resume', 'fork'].includes(hook.source)) {
    reviewBaseline ??= captureReviewBaseline(workingRoot(cwd), null, false)
    const detected = gitChangedFiles(workingRoot(cwd), reviewBaseline)
    if (detected) changedFiles = detected
  }
  if (event === 'SessionStart') {
    if (!alive && hook.source === 'resume') {
      alive = 1
      endedAt = null
      endAnnounced = 0
      store.run('UPDATE sessions SET crash_kind=NULL,exit_code=NULL,exit_signal=NULL,user_stop_requested=0 WHERE id=?', existing.id)
      processKey = envelope.ptyId ?? (envelope.claudePid ? String(envelope.claudePid) : null)
      ptyId = envelope.ptyId ?? null
    }
    if (hook.session_id !== claudeId) {
      store.run('INSERT OR IGNORE INTO session_aliases(claude_session_id,session_id,replaced_at,source) VALUES(?,?,?,?)', claudeId, existing.id, at, hook.source === 'compact' ? 'compact' : ['clear', 'resume', 'fork'].includes(hook.source) ? hook.source : 'heuristic')
      claudeId = hook.session_id
      if (hook.source !== 'compact') expireRequests(store, existing.id, 'session_replaced')
    }
    if (hook.source === 'clear' || hook.source === 'resume' || hook.source === 'fork') { state = changedFiles.length ? 'done' : 'idle'; subagents = 0; endReason = null }
    if (hook.source === 'compact') activity = null
  } else if (event === 'UserPromptSubmit') {
    state = 'running'
    if (task === 'Untitled') task = hook.prompt?.split('\n')[0].slice(0, 120) || task
  } else if (event === 'PermissionRequest' || event === 'Notification' && hook.notification_type === 'permission_prompt') state = 'needs_approval'
  else if (event === 'PreToolUse' && hook.tool_name === 'AskUserQuestion' || event === 'Notification' && hook.notification_type === 'elicitation_dialog') state = 'asked_you'
  else if (event === 'SubagentStart') { if (!['needs_approval', 'asked_you'].includes(state)) state = 'running' }
  else if (event === 'SubagentStop') {
    if (['running', 'stale', 'idle', 'done', 'reviewed'].includes(state)) state = 'running'
  }
  else if (event === 'PreCompact') { activity = 'compacting'; state = 'running' }
  else if (event === 'PostCompact') { activity = null; state = 'running' }
  else if (event === 'Stop' && !subagents && !['needs_approval', 'asked_you'].includes(state)) state = changedFiles.length ? 'done' : 'idle'
  else if (event === 'Notification' && hook.notification_type === 'idle_prompt') state = changedFiles.length ? 'done' : 'idle'
  else if (event === 'SessionEnd') {
    endReason = hook.reason
    if (['clear', 'resume'].includes(hook.reason)) stateSince = at
    else if (existing.origin !== 'observed') endAnnounced = 1
    if (!['clear', 'resume'].includes(hook.reason) && existing.origin === 'observed') { state = changedFiles.length ? 'done' : 'ended'; alive = 0; endedAt = at; expireRequests(store, existing.id, 'process_ended') }
  } else if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event) && !requestChanged && !['needs_approval', 'asked_you'].includes(state)) state = 'running'
  const open = store.all('SELECT kind FROM requests WHERE session_id = ? AND state = ?', existing.id, 'open')
  if (open.some(row => row.kind === 'permission')) state = 'needs_approval'
  else if (open.some(row => row.kind === 'question')) state = 'asked_you'
  else if (['needs_approval', 'asked_you'].includes(state)) state = event === 'Notification' && hook.notification_type === 'idle_prompt' ? 'idle' : 'running'
  activity = sessionActivity(store, { ...existing, alive, subagents_active: subagents, process_key: processKey, pty_id: ptyId }, envelope)
  const terminalAnswer = requestChanged && store.get("SELECT id FROM requests WHERE session_id=? AND state='answered' AND answered_at=? AND json_extract(answer,'$.via')='terminal' LIMIT 1", existing.id, at)
  const lastInputFrom = event === 'UserPromptSubmit' || terminalAnswer ? 'terminal' : existing.last_input_from
  const since = at
  store.run('UPDATE sessions SET claude_session_id=?,state=?,state_since=?,since_ts=?,last_activity_at=?,alive=?,activity=?,last_input_from=?,subagents_active=?,end_reason=?,end_announced=?,ended_at=?,task=?,transcript_path=?,cwd=?,repo_id=?,branch=?,review_baseline=?,process_key=?,pty_id=?,changed_files=? WHERE id=?', claudeId, state, state !== existing.state ? at : stateSince, since, Math.max(at, existing.last_activity_at), alive, activity, lastInputFrom, subagents, endReason, endAnnounced, endedAt, task, hook.transcript_path ?? existing.transcript_path, cwd, repoId, branch, reviewBaseline, processKey, ptyId, JSON.stringify(changedFiles), existing.id)
  return store.get('SELECT * FROM sessions WHERE id = ?', existing.id)
}

/** Steps kept per session; older ones are trimmed after each insert (06-storage `session_steps`). */
export const STEP_LIMIT = 200
const STEP_LABELS = { Edit: 'Update', MultiEdit: 'Update' }
const STEP_OUTCOMES = { PostToolUse: 'ok', PostToolUseFailure: 'failed', PermissionDenied: 'failed' }

function patchCounts(response) {
  const patch = Array.isArray(response?.structuredPatch) ? response.structuredPatch : null
  if (!patch) return { adds: null, dels: null }
  let adds = 0
  let dels = 0
  for (const hunk of patch) for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
    if (typeof line !== 'string') continue
    if (line.startsWith('+')) adds++
    else if (line.startsWith('-')) dels++
  }
  return { adds, dels }
}

/**
 * Record a tool step inside the caller's transaction: `PreToolUse` opens a `running` step; `PostToolUse`,
 * `PostToolUseFailure` and `PermissionDenied` settle the oldest running step with the same match key, or
 * record one settled step when its `PreToolUse` was never seen; that `PreToolUse`, if it arrives later with
 * an earlier or equal hook time, adds nothing. Keeps the newest {@link STEP_LIMIT}.
 * @param {object} store
 * @param {object | null} session the sessions row
 * @param {{ hook: object, hookTs: number }} envelope
 * @returns {boolean} whether a step was written
 */
export function recordToolStep(store, session, envelope) {
  const hook = envelope.hook
  const event = hook.hook_event_name
  if (!session || !hook.tool_name || (event !== 'PreToolUse' && !STEP_OUTCOMES[event])) return false
  const key = matchKey(hook)
  const counts = event === 'PostToolUse' ? patchCounts(hook.tool_response) : { adds: null, dels: null }
  // A PreToolUse delivered after its outcome (the early flush on Stop can send PostToolUse and Stop first):
  // the outcome already recorded the step, at the same or a later hook time, so open no second one.
  if (event === 'PreToolUse' && store.get('SELECT seq FROM session_steps WHERE session_id=? AND match_key=? AND status<>? AND at>=? LIMIT 1', session.id, key, 'running', envelope.hookTs)) return false
  if (event !== 'PreToolUse') {
    const open = store.get('SELECT seq FROM session_steps WHERE session_id=? AND status=? AND match_key=? ORDER BY seq LIMIT 1', session.id, 'running', key)
    if (open) {
      store.run('UPDATE session_steps SET status=?,adds=?,dels=? WHERE session_id=? AND seq=?', STEP_OUTCOMES[event], counts.adds, counts.dels, session.id, open.seq)
      return true
    }
  }
  const seq = store.get('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM session_steps WHERE session_id=?', session.id).seq
  store.run('INSERT INTO session_steps(session_id,seq,at,tool_name,line,adds,dels,status,match_key,task_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
    session.id, seq, envelope.hookTs, String(hook.tool_name), toolLine(hook.tool_name, hook.tool_input, hook.cwd ?? session.cwd, STEP_LABELS),
    counts.adds, counts.dels, event === 'PreToolUse' ? 'running' : STEP_OUTCOMES[event], key, session.run_task_id ?? null)
  store.run('DELETE FROM session_steps WHERE session_id=? AND seq<=?', session.id, seq - STEP_LIMIT)
  return true
}

/** Persist ended process history independently of retained session detail. */
export function persistSessionSummary(store, row) {
  if (row.alive || row.ended_at === null) return
  const repository = store.get('SELECT name FROM repos WHERE id = ?', row.repo_id)
  const files = JSON.parse(row.changed_files)
  const ids = [...new Set([...store.all('SELECT claude_session_id FROM session_aliases WHERE session_id = ? ORDER BY replaced_at', row.id).map(alias => alias.claude_session_id), row.claude_session_id].filter(Boolean))]
  const gate = row.run_id ? store.get('SELECT last_gate FROM runs WHERE repo_id = ? AND run_id = ?', row.run_repo_id, row.run_id) : null
  const verdict = gate?.last_gate ? JSON.parse(gate.last_gate).verdict : null
  const outcome = row.crash_kind === 'lost' ? 'lost' : row.crash_kind ? 'crashed' : row.user_stop_requested ? 'stopped' : 'ended'
  store.run(`INSERT INTO session_summaries(session_id,repo_id,repo_name,branch,task,origin,role,outcome,exit_code,exit_signal,started_at,ended_at,duration_ms,reviewed_at,run_id,run_task_id,gate_result,files_changed,adds,dels,claude_session_ids,transcript_path)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      repo_id=excluded.repo_id,repo_name=excluded.repo_name,branch=excluded.branch,
      task=excluded.task,origin=excluded.origin,role=excluded.role,started_at=excluded.started_at,
      run_id=excluded.run_id,run_task_id=excluded.run_task_id,gate_result=excluded.gate_result,
      transcript_path=excluded.transcript_path,
      outcome=excluded.outcome,exit_code=excluded.exit_code,exit_signal=excluded.exit_signal,
      duration_ms=excluded.duration_ms,reviewed_at=excluded.reviewed_at,
      files_changed=CASE WHEN excluded.ended_at > session_summaries.ended_at THEN excluded.files_changed ELSE session_summaries.files_changed END,
      adds=CASE WHEN excluded.ended_at > session_summaries.ended_at THEN excluded.adds ELSE session_summaries.adds END,
      dels=CASE WHEN excluded.ended_at > session_summaries.ended_at THEN excluded.dels ELSE session_summaries.dels END,
      ended_at=excluded.ended_at,claude_session_ids=excluded.claude_session_ids`,
  row.id, row.repo_id, repository.name, row.branch, row.task, row.origin, row.role, outcome, row.exit_code, row.exit_signal, row.started_at, row.ended_at, Math.max(0, row.ended_at - row.started_at), row.reviewed_at, row.run_id, row.run_task_id, ['PASS', 'FAIL'].includes(verdict) ? verdict : null, files.length, files.reduce((sum, file) => sum + (file.adds ?? 0), 0), files.reduce((sum, file) => sum + (file.dels ?? 0), 0), JSON.stringify(ids), row.transcript_path)
}
