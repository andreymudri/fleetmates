// Task 16 server fixes for the defects the M1 evidence suites recorded: order.changed, session_steps and
// readable request summaries. Each test drives the real deck server through its ingest path.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startDeckServer } from '../../server/main.mjs'

const token = 'a'.repeat(43)
const fixtures = new URL('../fixtures/hooks/2.1.282/', import.meta.url)
const base = JSON.parse(fs.readFileSync(new URL('SessionStart.startup.json', fixtures)))
const pinned = name => JSON.parse(fs.readFileSync(new URL(name, fixtures)))

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1e-'))
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const deck = await startDeckServer({ env, port: 0, staticDir, notifications: false,
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }) })
  t.after(async () => { await deck.close()
    fs.rmSync(dir, { recursive: true, force: true }) })
  const request = async route => {
    const origin = `http://127.0.0.1:${deck.address().port}`
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}`, Origin: origin } })
    return { status: response.status, data: await response.json() }
  }
  const send = (session, event, at, extra = {}) => {
    deck.ingest.receive(JSON.stringify({ v: 1, hookTs: at, ptyId: null, claudePid: null, pidChain: [], truncated: false,
      hook: { ...base, session_id: session, cwd: dir, hook_event_name: event, ...extra } }))
    deck.ingest.flush()
  }
  const idOf = session => deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', session).id
  const orders = () => deck.store.all('SELECT data FROM events WHERE type=? ORDER BY seq', 'order.changed').map(row => JSON.parse(row.data).order)
  return { deck, dir, request, send, idOf, orders }
}

test('order.changed is published whenever the urgency order changes, and only then', async t => {
  const h = await harness(t)
  h.send('a', 'SessionStart', 1000)
  h.send('a', 'UserPromptSubmit', 1100, { prompt: 'first' })
  const a = h.idOf('a')
  assert.deepEqual(h.orders(), [[a]], 'the first session enters the order')
  h.send('b', 'SessionStart', 2000)
  const b = h.idOf('b')
  assert.deepEqual(h.orders().at(-1), [a, b], 'a new idle session joins after the running one')
  const count = h.orders().length
  h.send('a', 'PreToolUse', 2100, { tool_name: 'Read', tool_input: { file_path: path.join(h.dir, 'x.txt') } })
  h.send('a', 'PostToolUse', 2200, { tool_name: 'Read', tool_input: { file_path: path.join(h.dir, 'x.txt') }, tool_response: {} })
  assert.equal(h.orders().length, count, 'tool events that keep the order publish no order.changed')
  h.send('b', 'UserPromptSubmit', 3000, { prompt: 'second' })
  assert.deepEqual(h.orders().at(-1), [b, a], 'the newer running session moves first')
  h.send('a', 'PermissionRequest', 4000, { tool_name: 'Bash', tool_input: { command: 'npm test' } })
  assert.deepEqual(h.orders().at(-1), [a, b], 'the session that needs you moves ahead')
  assert.deepEqual(h.orders().at(-1), h.deck.projector.snapshot().home.order, 'the published order is the snapshot order')
  const published = h.orders().length
  h.send('b', 'SessionEnd', 5000, { reason: 'prompt_input_exit' })
  assert.equal(h.deck.store.get('SELECT state FROM sessions WHERE id=?', b).state, 'ended')
  assert.equal(h.orders().length, published, 'a session that only leaves the order reorders nobody, so no event')
  assert.deepEqual(h.deck.projector.snapshot().home.order, [a])
})

test('tool hooks write session_steps: PreToolUse opens a step, PostToolUse, PostToolUseFailure and PermissionDenied settle it by match key', async t => {
  const h = await harness(t)
  h.send('s', 'SessionStart', 1000)
  h.send('s', 'UserPromptSubmit', 1100, { prompt: 'work' })
  const id = h.idOf('s')
  const file = path.join(h.dir, 'src/notes.txt')
  const edit = pinned('PostToolUse.Edit.json')
  h.send('s', 'PreToolUse', 2000, { tool_name: 'Edit', tool_input: { ...edit.tool_input, file_path: file } })
  h.send('s', 'PreToolUse', 2100, { tool_name: 'Bash', tool_input: { command: 'npm test' } })
  h.send('s', 'PreToolUse', 2200, { tool_name: 'Bash', tool_input: { command: 'npm run lint' } })
  h.send('s', 'PreToolUse', 2300, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  let steps = (await h.request(`/api/sessions/${id}/steps`)).data.steps
  assert.deepEqual(steps.map(step => [step.toolName, step.line, step.status]), [
    ['Edit', 'Update src/notes.txt', 'running'],
    ['Bash', 'Bash npm test', 'running'],
    ['Bash', 'Bash npm run lint', 'running'],
    ['Bash', 'Bash rm -rf build', 'running']
  ])
  h.send('s', 'PostToolUse', 2400, { tool_name: 'Bash', tool_input: { command: 'npm run lint' }, tool_response: {} })
  h.send('s', 'PostToolUse', 2500, { tool_name: 'Edit', tool_input: { ...edit.tool_input, file_path: file }, tool_response: edit.tool_response })
  h.send('s', 'PostToolUseFailure', 2600, { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'exit 1' })
  h.send('s', 'PermissionDenied', 2700, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  steps = (await h.request(`/api/sessions/${id}/steps`)).data.steps
  assert.deepEqual(steps.map(step => [step.line, step.status, step.adds, step.dels]), [
    ['Update src/notes.txt', 'ok', 1, 0],
    ['Bash npm test', 'failed', null, null],
    ['Bash npm run lint', 'ok', null, null],
    ['Bash rm -rf build', 'failed', null, null]
  ], 'each outcome settles the step with its own match key, not the newest one')
  assert.deepEqual(steps.map(step => step.seq), [1, 2, 3, 4])
  // A PostToolUse whose PreToolUse the deck never saw (joined mid-turn) still records one settled step.
  h.send('s', 'PostToolUse', 2800, { tool_name: 'Read', tool_input: { file_path: file }, tool_response: {} })
  steps = (await h.request(`/api/sessions/${id}/steps`)).data.steps
  assert.deepEqual(steps.at(-1).line, 'Read src/notes.txt')
  assert.equal(steps.at(-1).status, 'ok')
  assert.equal(h.deck.projector.snapshot().sessions.find(row => row.id === id).toolCalls, 5)
  const focus = (await h.request(`/api/sessions/${id}`)).data
  assert.equal(focus.steps.length, 5, 'Focus reads the same steps')
})

test('session_steps keeps the newest 200 steps per session', async t => {
  const h = await harness(t)
  h.send('s', 'SessionStart', 1000)
  const id = h.idOf('s')
  for (let i = 1; i <= 205; i++) h.send('s', 'PreToolUse', 1000 + i, { tool_name: 'Bash', tool_input: { command: `echo ${i}` } })
  const rows = h.deck.store.all('SELECT seq,line FROM session_steps WHERE session_id=? ORDER BY seq', id)
  assert.equal(rows.length, 200)
  assert.deepEqual([rows[0].seq, rows.at(-1).seq], [6, 205])
  assert.equal(rows.at(-1).line, 'Bash echo 205')
  assert.equal(h.deck.projector.snapshot().sessions.find(row => row.id === id).toolCalls, 200)
})

test('request summaries read as one line: the question for AskUserQuestion, the command or target for other tools', async t => {
  const h = await harness(t)
  h.send('s', 'SessionStart', 1000)
  h.send('s', 'UserPromptSubmit', 1100, { prompt: 'work' })
  const ask = pinned('PreToolUse.AskUserQuestion.json')
  h.send('s', 'PreToolUse', 2000, { tool_name: 'AskUserQuestion', tool_input: ask.tool_input, tool_use_id: ask.tool_use_id })
  h.send('s', 'PermissionRequest', 2100, { tool_name: 'Bash', tool_input: { command: 'cargo test \\\n  --release combat::' } })
  h.send('s', 'PermissionRequest', 2200, { tool_name: 'Edit', tool_input: { file_path: path.join(h.dir, 'src/main.rs'), old_string: 'a', new_string: 'b' } })
  h.send('s', 'PermissionRequest', 2300, { tool_name: 'WebFetch', tool_input: { url: 'https://example.test/a', prompt: 'read it' } })
  h.send('s', 'PermissionRequest', 2400, { tool_name: 'mcp__vault__vault_search', tool_input: { query: 'reorder window' } })
  const { requests } = (await h.request('/api/requests')).data
  assert.deepEqual(requests.map(row => [row.kind, row.summary]), [
    ['question', 'Which do you pick, A or B?'],
    ['permission', 'cargo test \\ ↵ --release combat::'],
    ['permission', 'Edit src/main.rs'],
    ['permission', 'WebFetch https://example.test/a'],
    ['permission', 'mcp__vault__vault_search reorder window']
  ])
  assert.ok(requests.every(row => !row.summary.includes('{')), 'no summary is raw JSON')
  assert.equal(requests[0].detail.questions[0].question, 'Which do you pick, A or B?', 'the detail keeps the full tool input')
})
