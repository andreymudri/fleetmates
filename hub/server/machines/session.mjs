import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { expireRequests } from './request.mjs'

const maxGitOutput = 1024 * 1024
const maxChangedPaths = 512
const maxScannedPaths = 4096
const maxScannedBytes = 32 * 1024 * 1024

function git(root, args, budget = null) {
  if (budget && Date.now() >= budget.deadline) return null
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      timeout: budget ? Math.max(1, Math.min(1500, budget.deadline - Date.now())) : 1500,
      maxBuffer: maxGitOutput,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch { return null }
}

function gitHead(root, budget = null) {
  const output = git(root, ['rev-parse', '--verify', 'HEAD'], budget)?.toString('utf8').trim()
  if (/^[0-9a-f]{40,64}$/.test(output ?? '')) return output
  return git(root, ['rev-parse', '--is-inside-work-tree'], budget)?.toString('utf8').trim() === 'true' ? 'unborn' : null
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

function hashFile(file, normalize, budget, algorithm = 'sha256', blob = false) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (Date.now() >= budget.deadline || !before.isFile() || before.size > budget.remaining) throw new Error('scan limit')
    const buffer = Buffer.alloc(64 * 1024)
    const pass = consume => {
      let position = 0
      let pendingCR = false
      while (position < before.size) {
        if (Date.now() > budget.deadline) throw new Error('scan timeout')
        const length = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position)
        if (!length || length > budget.remaining) throw new Error('scan limit')
        budget.remaining -= length
        position += length
        const chunk = buffer.subarray(0, length)
        if (!normalize) { consume(chunk); continue }
        const output = Buffer.alloc(length + 1)
        let used = 0
        for (const byte of chunk) {
          if (pendingCR && byte !== 10) output[used++] = 13
          pendingCR = byte === 13
          if (!pendingCR) output[used++] = byte
        }
        consume(output.subarray(0, used))
      }
      if (pendingCR) consume(Buffer.from([13]))
    }
    let size = before.size
    if (blob && normalize) { size = 0; pass(chunk => { size += chunk.length }) }
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
  const listed = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--eol', '-z'], budget)
  if (!tree || !listed) return null
  const autoCRLF = /^(true|input)$/.test(git(root, ['config', '--get', 'core.autocrlf'], budget)?.toString('utf8').trim() ?? '')
  const fileMode = git(root, ['config', '--bool', '--get', 'core.filemode'], budget)?.toString('utf8').trim() !== 'false'
  const entries = new Map()
  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record)
    if (!match) return null
    entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] })
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
  budget.remainingPaths -= names.size
  if (budget.remainingPaths < 0 || Date.now() >= budget.deadline) return null
  const paths = new Map()
  const gitlinks = new Map()
  for (const name of names) {
    const entry = entries.get(name)
    if (entry?.type === 'commit') {
      const location = path.resolve(root, name)
      if (!location.startsWith(`${root}${path.sep}`)) return null
      const link = gitlinkState(location, budget, depth + 1)
      if (!link) return null
      gitlinks.set(name, link)
      if (!link.uninitialized && (link.head !== entry.oid || link.dirty)) paths.set(name, { adds: null, dels: null })
      continue
    }
    let unchanged = false
    if (entry) {
      try {
        const location = path.resolve(root, name)
        if (!location.startsWith(`${root}${path.sep}`)) return null
        const stat = lstatSync(location)
        let oid = null
        let mode = null
        const algorithm = entry.oid.length === 64 ? 'sha256' : 'sha1'
        if (stat.isSymbolicLink()) {
          const content = Buffer.from(readlinkSync(location))
          oid = createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex')
          mode = '120000'
        } else if (stat.isFile()) {
          oid = hashFile(location, normalization.get(name) ?? false, budget, algorithm, true)
          mode = stat.mode & 0o111 ? '100755' : '100644'
        } else return null
        unchanged = oid === entry.oid && (mode === entry.mode || !fileMode && ['100644', '100755'].includes(mode) && ['100644', '100755'].includes(entry.mode))
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null }
    }
    if (!unchanged) paths.set(name, { adds: null, dels: null })
  }
  return paths.size <= maxChangedPaths ? { paths, normalization, budget, fileMode, gitlinks, depth } : null
}

function fileFingerprint(root, name, scan) {
  const file = path.resolve(root, name)
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('path outside repository')
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
    return `file:${executable}:${hashFile(file, scan.normalization.get(name) ?? false, scan.budget)}`
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
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

/** Capture the current Git changes as a review boundary. */
export function captureReviewBaseline(root, previous = null, includeExisting = true) {
  const head = baseline(previous)?.head ?? gitHead(root)
  if (!head) return null
  const scan = includeExisting ? gitPaths(root, head) : { paths: new Map(), normalization: new Map(), budget: scanBudget() }
  if (!scan) return null
  try {
    return JSON.stringify({ head, files: Object.fromEntries([...scan.paths.keys()].map(name => [name, fileFingerprint(root, name, scan)])) })
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
    return [...paths].filter(([name]) => !Object.hasOwn(saved.files, name) || saved.files[name] !== fileFingerprint(root, name, scan)).map(([name, diff]) => ({ path: path.resolve(root, name), ...diff }))
  } catch { return null }
}

/** Refresh final Git changes, retaining known changes if the bounded scan is incomplete. */
export function refreshSessionChanges(store, session) {
  const boundary = session.review_baseline ?? captureReviewBaseline(session.repo_id, null, false)
  const files = gitChangedFiles(session.repo_id, boundary)
  if (files === null) return session
  const changedFiles = JSON.stringify(files)
  store.run('UPDATE sessions SET changed_files=?,review_baseline=? WHERE id=?', changedFiles, boundary, session.id)
  return { ...session, changed_files: changedFiles, review_baseline: boundary }
}

function repo(store, cwd, at) {
  let id = cwd || '/unknown'
  let current
  try { current = realpathSync(id) } catch { current = null }
  for (let depth = 0; current && depth < 32; depth++) {
    const marker = path.join(current, '.git')
    try {
      const stat = statSync(marker)
      if (stat.isDirectory() || stat.isFile() && stat.size <= 4096 && readFileSync(marker, 'utf8').startsWith('gitdir:')) { id = current; break }
    } catch {}
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  store.run('INSERT OR IGNORE INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', id, id, 0, 1, id, at)
  return id
}

function editedPath(hook) {
  if (hook.hook_event_name !== 'PostToolUse' || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(hook.tool_name)) return null
  const file = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path
  if (typeof file !== 'string' || !file) return null
  return path.resolve(hook.cwd, file)
}

function sameKnownProcess(store, row, envelope) {
  if (envelope.ptyId && row.pty_id && envelope.ptyId !== row.pty_id) return false
  if (envelope.claudePid) {
    const knownPid = row.pty_id
      ? store.get('SELECT claude_pid FROM hook_events WHERE session_id = ? AND claude_pid IS NOT NULL ORDER BY hook_ts DESC, id DESC LIMIT 1', row.id)?.claude_pid
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

/** Record a current process conversation without changing its activity or state. */
export function recordSessionIdentity(store, session, envelope) {
  const hook = envelope.hook
  if (!session.alive || hook.session_id === session.claude_session_id || !sameKnownProcess(store, session, envelope)) return session
  const processMatches = envelope.ptyId && envelope.ptyId === session.pty_id
    || envelope.claudePid && (session.pty_id || String(envelope.claudePid) === session.process_key)
  if (!processMatches) return session
  const boundary = store.get('SELECT MAX(replaced_at) AS at FROM session_aliases WHERE session_id=?', session.id).at ?? session.started_at
  if (envelope.hookTs < boundary) return session
  const oldAlias = store.get('SELECT claude_session_id FROM session_aliases WHERE session_id=? AND claude_session_id=?', session.id, hook.session_id)
  if (oldAlias && !(hook.hook_event_name === 'SessionStart' && ['clear', 'resume', 'fork'].includes(hook.source) && envelope.hookTs >= session.since_ts)) return session
  const source = hook.hook_event_name === 'SessionStart' && ['clear', 'resume', 'fork', 'compact'].includes(hook.source) ? hook.source : 'heuristic'
  store.run('INSERT OR IGNORE INTO session_aliases(claude_session_id,session_id,replaced_at,source) VALUES(?,?,?,?)', session.claude_session_id, session.id, envelope.hookTs, source)
  store.run('UPDATE sessions SET claude_session_id=?,transcript_path=? WHERE id=?', hook.session_id, hook.transcript_path ?? session.transcript_path, session.id)
  return store.get('SELECT * FROM sessions WHERE id=?', session.id)
}

/** Identify hooks that leave session state and activity unchanged. */
export function ignoresSessionHook(store, session, hook) {
  if (!session) return false
  const event = hook.hook_event_name
  if (['WorktreeCreate', 'WorktreeRemove'].includes(event)) return true
  if (event === 'Notification' && hook.notification_type === 'agent_completed') return true
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
    store.run('INSERT INTO sessions(id,claude_session_id,origin,pty_id,process_key,repo_id,cwd,task,state,state_since,since_ts,last_activity_at,alive,joined_mid_life,started_at,transcript_path,subagents_active,activity,changed_files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, hook.session_id, origin, envelope.ptyId, envelope.ptyId ?? (envelope.claudePid ? String(envelope.claudePid) : null), repoId, hook.cwd, task, initial, at, at, at, 1, event === 'SessionStart' ? 0 : 1, at, hook.transcript_path, event === 'SubagentStart' ? 1 : 0, event === 'PreCompact' ? 'compacting' : null, JSON.stringify(edited ? [{ path: edited, adds: null, dels: null }] : []))
    const reviewBaseline = captureReviewBaseline(repoId, null, event !== 'SessionStart')
    if (reviewBaseline) store.run('UPDATE sessions SET review_baseline = ? WHERE id = ?', reviewBaseline, id)
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
  let processKey = existing.process_key
  let ptyId = existing.pty_id
  let changedFiles = JSON.parse(existing.changed_files)
  let reviewBaseline = existing.review_baseline
  if (['SessionStart', 'CwdChanged'].includes(event)) {
    cwd = hook.cwd
    repoId = repo(store, cwd, at)
    if (repoId !== existing.repo_id) {
      reviewBaseline = captureReviewBaseline(repoId, null, false)
      changedFiles = []
    }
  }
  const edited = editedPath(hook)
  if (edited && !changedFiles.some(file => file.path === edited)) changedFiles.push({ path: edited, adds: null, dels: null })
  if (event === 'Stop' || event === 'SessionEnd' || event === 'Notification' && hook.notification_type === 'idle_prompt' || event === 'PostToolUse' && hook.tool_name === 'Bash' || event === 'SessionStart' && ['clear', 'resume', 'fork'].includes(hook.source)) {
    reviewBaseline ??= captureReviewBaseline(repoId, null, false)
    const detected = gitChangedFiles(repoId, reviewBaseline)
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
  else if (event === 'SubagentStart') { subagents++; if (!['needs_approval', 'asked_you'].includes(state)) state = 'running' }
  else if (event === 'SubagentStop') {
    subagents = Math.max(0, subagents - 1)
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
  const since = at
  store.run('UPDATE sessions SET claude_session_id=?,state=?,state_since=?,since_ts=?,last_activity_at=?,alive=?,activity=?,subagents_active=?,end_reason=?,end_announced=?,ended_at=?,task=?,transcript_path=?,cwd=?,repo_id=?,review_baseline=?,process_key=?,pty_id=?,changed_files=? WHERE id=?', claudeId, state, state !== existing.state ? at : stateSince, since, Math.max(at, existing.last_activity_at), alive, activity, subagents, endReason, endAnnounced, endedAt, task, hook.transcript_path ?? existing.transcript_path, cwd, repoId, reviewBaseline, processKey, ptyId, JSON.stringify(changedFiles), existing.id)
  return store.get('SELECT * FROM sessions WHERE id = ?', existing.id)
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
      outcome=excluded.outcome,exit_code=excluded.exit_code,exit_signal=excluded.exit_signal,
      duration_ms=excluded.duration_ms,reviewed_at=excluded.reviewed_at,
      files_changed=CASE WHEN excluded.ended_at > session_summaries.ended_at THEN excluded.files_changed ELSE session_summaries.files_changed END,
      adds=CASE WHEN excluded.ended_at > session_summaries.ended_at THEN excluded.adds ELSE session_summaries.adds END,
      dels=CASE WHEN excluded.ended_at > session_summaries.ended_at THEN excluded.dels ELSE session_summaries.dels END,
      ended_at=excluded.ended_at,claude_session_ids=excluded.claude_session_ids`,
  row.id, row.repo_id, repository.name, row.branch, row.task, row.origin, row.role, outcome, row.exit_code, row.exit_signal, row.started_at, row.ended_at, Math.max(0, row.ended_at - row.started_at), row.reviewed_at, row.run_id, row.run_task_id, ['PASS', 'FAIL'].includes(verdict) ? verdict : null, files.length, files.reduce((sum, file) => sum + (file.adds ?? 0), 0), files.reduce((sum, file) => sum + (file.dels ?? 0), 0), JSON.stringify(ids), row.transcript_path)
}
