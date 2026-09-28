import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector } from '../../server/machines/projector.mjs'

const fixtureDir = new URL('../fixtures/hooks/2.1.282/', import.meta.url)
function fixture(name, changes = {}) {
  const hook = JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8'))
  return { v: 1, hook: { ...hook, ...changes }, hookTs: 1000, ptyId: null, claudePid: 42, pidChain: [42], truncated: false, receivedAt: 1000, via: 'socket' }
}
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-machines-'))
  const file = path.join(dir, 'deck.db')
  const store = openDeckDb(file)
  const projector = createProjector({ store, now: () => 1000 })
  return { store, projector, file, close() { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('first SessionStart is idle and not joined mid-life; later first hook is joined', () => {
  const h = harness()
  try {
    h.projector.applyHooks([fixture('SessionStart.startup.json')])
    const started = h.projector.snapshot().sessions[0]
    assert.equal(started.state, 'idle')
    assert.equal(started.joinedMidLife, false)
    const later = fixture('UserPromptSubmit.json', { session_id: 'late-session' })
    later.claudePid = 99
    h.projector.applyHooks([later])
    const joined = h.projector.snapshot().sessions.find(row => row.claudeSessionId === 'late-session')
    assert.equal(joined.state, 'running')
    assert.equal(joined.joinedMidLife, true)
  } finally { h.close() }
})

test('observed hook opens and closes a request, and restart keeps the projection', () => {
  const h = harness()
  try {
    const request = fixture('PermissionRequest.AskUserQuestion.json')
    h.projector.applyHooks([request])
    let view = h.projector.snapshot()
    assert.equal(view.sessions[0].state, 'needs_approval')
    assert.equal(view.sessions[0].joinedMidLife, true)
    assert.equal(view.counts.needYouSessions, 1)
    assert.equal(view.counts.openRequests, 1)
    h.projector.applyHooks([request])
    assert.equal(h.projector.snapshot().counts.openRequests, 1)
    const outcome = fixture('PostToolUse.AskUserQuestion.json', { session_id: request.hook.session_id, tool_input: request.hook.tool_input })
    outcome.hookTs = 1001
    h.projector.applyHooks([outcome])
    view = h.projector.snapshot()
    assert.equal(view.requests[0].state, 'answered')
    assert.equal(view.counts.needYouSessions, 0)
    h.store.close()
    const reopened = openDeckDb(h.file)
    try { assert.equal(createProjector({ store: reopened }).snapshot().requests[0].state, 'answered') } finally { reopened.close() }
  } finally { rmSync(path.dirname(h.file), { recursive: true, force: true }) }
})

test('process alias, stale and counts across repos', () => {
  const h = harness()
  try {
    const first = fixture('UserPromptSubmit.json', { session_id: 'one', cwd: '/home/you/a' })
    const second = fixture('UserPromptSubmit.json', { session_id: 'two', cwd: '/home/you/b' })
    second.claudePid = 43
    h.projector.applyHooks([first, second])
    assert.equal(h.projector.snapshot().counts.running, 2)
    h.projector.tick(1_201_000)
    assert.equal(h.projector.snapshot().sessions.filter(row => row.state === 'stale').length, 2)
    assert.equal(h.projector.snapshot().home.quiet.length, 2)
    assert.equal(h.projector.snapshot().home.grid.length, 0)
    const clear = fixture('SessionStart.clear.json', { session_id: 'one-new', cwd: '/home/you/a' })
    clear.hookTs = 1_201_001
    h.projector.applyHooks([clear])
    assert.equal(h.projector.snapshot().sessions.length, 2)
    assert.equal(h.projector.snapshot().sessions.find(row => row.claudeSessionId === 'one-new').state, 'idle')
  } finally { h.close() }
})

test('clear expires requests, resume reuses process, and late outcomes do not move state', () => {
  const h = harness()
  try {
    const opened = fixture('PermissionRequest.AskUserQuestion.json', { session_id: 'old' })
    h.projector.applyHooks([opened])
    const clear = fixture('SessionStart.clear.json', { session_id: 'new' })
    clear.hookTs = 2000
    h.projector.applyHooks([clear])
    assert.equal(h.projector.snapshot().sessions.length, 1)
    assert.equal(h.projector.snapshot().requests[0].expiredReason, 'session_replaced')
    assert.equal(h.projector.snapshot().sessions[0].state, 'idle')
    const late = fixture('PostToolUse.AskUserQuestion.json', { session_id: 'old', tool_input: opened.hook.tool_input })
    late.hookTs = 1500
    h.projector.applyHooks([late])
    assert.equal(h.projector.snapshot().sessions[0].state, 'idle')
    const resume = fixture('SessionStart.clear.json', { session_id: 'third', source: 'resume' })
    resume.hookTs = 3000
    h.projector.applyHooks([resume])
    assert.equal(h.projector.snapshot().sessions[0].claudeSessionId, 'third')
  } finally { h.close() }
})

test('observed end and lost process expire requests and leave no needs-you count', () => {
  const h = harness()
  try {
    const opened = fixture('PermissionRequest.AskUserQuestion.json')
    h.projector.applyHooks([opened])
    const id = h.projector.snapshot().sessions[0].id
    h.projector.signal(id, { type: 'pid_gone' }, 2000)
    assert.equal(h.projector.snapshot().sessions[0].state, 'crashed')
    assert.equal(h.projector.snapshot().requests[0].expiredReason, 'process_ended')
    assert.equal(h.projector.snapshot().counts.needYouSessions, 0)
    const other = fixture('UserPromptSubmit.json', { session_id: 'other' })
    other.claudePid = 99
    h.projector.applyHooks([other])
    const end = fixture('SessionEnd.prompt_input_exit.json', { session_id: 'other' })
    end.claudePid = 99
    end.hookTs = 2000
    h.projector.applyHooks([end])
    assert.equal(h.projector.snapshot().sessions.find(row => row.claudeSessionId === 'other').state, 'ended')
  } finally { h.close() }
})

test('published sequences are committed and a failed batch rolls back', () => {
  const h = harness()
  const reader = openDeckDb(h.file)
  try {
    const published = []
    const projector = createProjector({ store: h.store, now: () => 1000, publish: event => {
      assert.ok(Number(reader.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq) >= event.seq)
      published.push(event.seq)
    } })
    projector.applyHooks([fixture('UserPromptSubmit.json')])
    assert.deepEqual(published, [1, 2])
    const before = projector.snapshot()
    const bad = fixture('UserPromptSubmit.json', { session_id: 'bad', hook_event_name: null })
    bad.claudePid = 90
    bad.hookTs = 2000
    assert.throws(() => projector.applyHooks([bad]))
    assert.equal(projector.snapshot().seq, before.seq)
    assert.equal(projector.snapshot().sessions.length, before.sessions.length)
    assert.deepEqual(published, [1, 2])
  } finally { reader.close(); h.close() }
})

test('observed clear without a new start ends after alias wait', () => {
  const h = harness()
  try {
    h.projector.applyHooks([fixture('UserPromptSubmit.json')])
    const end = fixture('SessionEnd.clear.json')
    end.hookTs = 2000
    h.projector.applyHooks([end])
    assert.equal(h.projector.snapshot().sessions[0].state, 'running')
    h.projector.tick(7001)
    assert.equal(h.projector.snapshot().sessions[0].state, 'ended')
  } finally { h.close() }
})

test('two teammates in one run count as one Home chip', () => {
  const h = harness()
  try {
    const one = fixture('UserPromptSubmit.json', { session_id: 'run-one' })
    const two = fixture('UserPromptSubmit.json', { session_id: 'run-two' })
    two.claudePid = 43
    h.projector.applyHooks([one, two])
    h.store.run('UPDATE sessions SET run_repo_id = repo_id, run_id = ? WHERE claude_session_id IN (?, ?)', 'run-1', 'run-one', 'run-two')
    assert.equal(h.projector.snapshot().counts.running, 1)
    assert.deepEqual(h.projector.snapshot().counts.perRun.map(run => [run.total, run.needYou]), [[2, 0]])
  } finally { h.close() }
})

test('request open and close are published after commit', () => {
  const h = harness()
  try {
    const events = []
    const projector = createProjector({ store: h.store, publish: event => events.push(event) })
    const opened = fixture('PermissionRequest.AskUserQuestion.json')
    projector.applyHooks([opened])
    assert.ok(events.some(event => event.type === 'request.opened'))
    const outcome = fixture('PostToolUse.AskUserQuestion.json', { tool_input: opened.hook.tool_input })
    outcome.hookTs = 2000
    projector.applyHooks([outcome])
    assert.ok(events.some(event => event.type === 'request.closed'))
    assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1))
  } finally { h.close() }
})

test('permission notification before tool request leaves one approval that closes on outcome', () => {
  const h = harness()
  try {
    const notification = fixture('PermissionRequest.AskUserQuestion.json', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' })
    const request = fixture('PermissionRequest.AskUserQuestion.json', { tool_name: 'Bash', tool_input: { command: 'pwd' } })
    request.hookTs = 1001
    const outcome = fixture('PostToolUse.Bash.json', { tool_input: request.hook.tool_input })
    outcome.hookTs = 1002
    h.projector.applyHooks([notification, request])
    assert.equal(h.projector.snapshot().counts.openRequests, 1)
    h.projector.applyHooks([outcome])
    assert.equal(h.projector.snapshot().counts.openRequests, 0)
    assert.equal(h.projector.snapshot().sessions[0].state, 'running')
  } finally { h.close() }
})

test('process exit publishes closure for every expired request', () => {
  const h = harness()
  try {
    const events = []
    const projector = createProjector({ store: h.store, publish: event => events.push(event) })
    projector.applyHooks([fixture('PermissionRequest.AskUserQuestion.json')])
    const id = projector.snapshot().sessions[0].id
    events.length = 0
    projector.signal(id, { type: 'exit', code: 1 }, 2000)
    assert.equal(projector.snapshot().requests[0].state, 'expired')
    assert.equal(events.filter(event => event.type === 'request.closed').length, 1)
    assert.equal(events.find(event => event.type === 'request.closed').data.expiredReason, 'process_ended')
  } finally { h.close() }
})

test('CwdChanged moves the session to its new repository', () => {
  const h = harness()
  try {
    h.projector.applyHooks([fixture('SessionStart.startup.json', { cwd: '/home/you/old' })])
    const changed = fixture('SessionStart.startup.json', { hook_event_name: 'CwdChanged', cwd: '/home/you/new' })
    changed.hookTs = 2000
    h.projector.applyHooks([changed])
    const session = h.projector.snapshot().sessions[0]
    assert.equal(session.cwd, '/home/you/new')
    assert.equal(session.repoId, '/home/you/new')
    assert.equal(h.store.get('SELECT COUNT(*) AS count FROM repos').count, 2)
  } finally { h.close() }
})

test('announced PTY end with nonzero exit is ended', () => {
  const h = harness()
  try {
    const start = fixture('SessionStart.startup.json')
    start.ptyId = 'pty-two'
    h.projector.applyHooks([start])
    const end = fixture('SessionEnd.prompt_input_exit.json', { reason: 'logout' })
    end.ptyId = 'pty-two'
    end.hookTs = 2000
    h.projector.applyHooks([end])
    const id = h.projector.snapshot().sessions[0].id
    h.projector.signal(id, { type: 'exit', code: 1 }, 3000)
    assert.equal(h.projector.snapshot().sessions[0].state, 'ended')
    assert.equal(h.store.get('SELECT end_announced FROM sessions WHERE id = ?', id).end_announced, 1)
  } finally { h.close() }
})
