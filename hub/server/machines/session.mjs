import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { expireRequests } from './request.mjs'

const maxGitOutput = 1024 * 1024
const maxChangedPaths = 512
const maxHashedFile = 8 * 1024 * 1024
const maxScannedPaths = 4096
const maxScannedBytes = 32 * 1024 * 1024

function git(root, args) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      timeout: 1500,
      maxBuffer: maxGitOutput,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch { return null }
}

function gitHead(root) {
  const output = git(root, ['rev-parse', '--verify', 'HEAD'])?.toString('utf8').trim()
  if (/^[0-9a-f]{40,64}$/.test(output ?? '')) return output
  return git(root, ['rev-parse', '--is-inside-work-tree'])?.toString('utf8').trim() === 'true' ? 'unborn' : null
}

function baseline(value) {
  try {
    const parsed = JSON.parse(value)
    return (parsed.head === 'unborn' || /^[0-9a-f]{40,64}$/.test(parsed.head)) && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files) ? parsed : null
  } catch { return null }
}

function gitPaths(root, head) {
  const tree = head === 'unborn' ? Buffer.alloc(0) : git(root, ['ls-tree', '-r', '-z', head])
  const listed = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  if (!tree || !listed) return null
  const entries = new Map()
  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record)
    if (!match) return null
    entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] })
  }
  const names = new Set([...entries.keys(), ...listed.toString('utf8').split('\0').filter(Boolean)])
  if (names.size > maxScannedPaths) return null
  const paths = new Map()
  let scannedBytes = 0
  for (const name of names) {
    const entry = entries.get(name)
    if (entry?.type === 'commit') continue
    let unchanged = false
    if (entry) {
      try {
        const location = path.resolve(root, name)
        if (!location.startsWith(`${root}${path.sep}`)) return null
        const stat = lstatSync(location)
        let content = null
        let mode = null
        if (stat.isSymbolicLink()) { content = Buffer.from(readlinkSync(location)); mode = '120000' }
        else if (stat.isFile() && stat.size <= maxHashedFile) {
          scannedBytes += stat.size
          if (scannedBytes > maxScannedBytes) return null
          content = readFileSync(location)
          mode = stat.mode & 0o111 ? '100755' : '100644'
        }
        if (content) {
          const oid = createHash(entry.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
          unchanged = oid === entry.oid && mode === entry.mode
        }
      } catch {}
    }
    if (!unchanged) paths.set(name, { adds: null, dels: null })
  }
  return paths.size <= maxChangedPaths ? paths : null
}

function fileFingerprint(root, name) {
  const file = path.resolve(root, name)
  if (!file.startsWith(`${root}${path.sep}`)) return null
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) return `link:${createHash('sha256').update(readlinkSync(file)).digest('hex')}`
    if (!stat.isFile()) return `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`
    const executable = stat.mode & 0o111 ? 'x' : '-'
    if (stat.size > maxHashedFile) return `large:${executable}:${stat.size}:${stat.mtimeMs}`
    return `file:${executable}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
  } catch { return null }
}

/** Capture the current Git changes as a review boundary. */
export function captureReviewBaseline(root, previous = null, includeExisting = true) {
  const head = baseline(previous)?.head ?? gitHead(root)
  if (!head) return null
  const paths = includeExisting ? gitPaths(root, head) : new Map()
  if (!paths) return null
  return JSON.stringify({ head, files: Object.fromEntries([...paths.keys()].map(name => [name, fileFingerprint(root, name)])) })
}

function gitChangedFiles(root, value) {
  const saved = baseline(value)
  if (!saved) return null
  const paths = gitPaths(root, saved.head)
  if (!paths) return null
  for (const name of Object.keys(saved.files)) if (!paths.has(name)) paths.set(name, { adds: null, dels: null })
  if (paths.size > maxChangedPaths) return null
  return [...paths].filter(([name]) => !Object.hasOwn(saved.files, name) || saved.files[name] !== fileFingerprint(root, name)).map(([name, diff]) => ({ path: path.resolve(root, name), ...diff }))
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
      ? store.get('SELECT claude_pid FROM hook_events WHERE session_id = ? AND claude_pid IS NOT NULL ORDER BY id DESC LIMIT 1', row.id)?.claude_pid
      : row.process_key
    if (knownPid && String(envelope.claudePid) !== String(knownPid)) return false
  }
  return true
}

/** Resolve a hook by PTY, process, current conversation, aliases, then end/start path fallback. */
export function resolveSession(store, envelope) {
  const hook = envelope.hook
  const pty = envelope.ptyId
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
    if (state === 'stale') state = 'running'
  }
  else if (event === 'PreCompact') { activity = 'compacting'; state = 'running' }
  else if (event === 'PostCompact') { activity = null; state = 'running' }
  else if (event === 'CwdChanged') {
    cwd = hook.cwd
    repoId = repo(store, cwd, at)
    if (repoId !== existing.repo_id) { reviewBaseline = captureReviewBaseline(repoId); changedFiles = [] }
  }
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
