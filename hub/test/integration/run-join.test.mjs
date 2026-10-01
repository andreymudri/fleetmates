// M2 Task 7: the run join (04-integrations 1.3, state-machines 11). A lead's `scripts/cli.mjs --run` Bash
// call names its run, and a hook from a teammate worktree is attributed to that worktree's task through the
// fleetmates index. Each test drives the real deck server and the real run reader over a temporary git repo.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { startDeckServer } from '../../server/main.mjs'
import { fleetmatesScriptsDir } from '../../server/adapters/fleetmates.mjs'

const rootState = await import(pathToFileURL(path.join(fleetmatesScriptsDir(), 'state.mjs')).href)
const token = 'a'.repeat(43)
const base = JSON.parse(fs.readFileSync(new URL('../fixtures/hooks/2.1.282/PreToolUse.Bash.json', import.meta.url)))
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, stdio: 'pipe' })

/** A git repo with run r1 on disk and a worktree for T2, recorded in the fleetmates index unless `record` is false. */
async function fleetRepo(dir, { record = true } = {}) {
  const repo = path.join(dir, 'dev', 'alpha')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'alpha\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-q', '-m', 'init')
  const real = fs.realpathSync(repo)
  const worktree = path.join(fs.realpathSync(dir), 'wt', 'T2')
  git(real, 'worktree', 'add', '-q', '-b', 'fleetmates/r1/T2', worktree)
  const runDir = path.join(real, '.fleetmates', 'r1')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ runId: 'r1', totalPhases: 1, tasks: [{ id: 'T2', title: 'Second', phase: 1, files: [], deps: [] }] }))
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({ runId: 'r1', tasks: [{ id: 'T2', state: 'in_progress' }] }))
  if (record) await rootState.writeLocation(real, 'r1', 'T2', { worktree, branch: 'fleetmates/r1/T2' })
  return { repo: real, worktree }
}

/** Every path under `.fleetmates/` with its size and mtime. */
function stateTree(repo) {
  const rows = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const info = fs.lstatSync(full)
      rows.push(`${path.relative(repo, full)} ${info.size} ${info.mtimeMs}`)
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(path.join(repo, '.fleetmates'))
  return rows.sort()
}

async function harness(t, { runPollMs = 3_600_000, record = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-'))
  const place = await fleetRepo(dir, { record })
  const env = { HOME: dir, PATH: process.env.PATH }
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const deck = await startDeckServer({ env, port: 0, staticDir, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') }, reconnectMs: 60_000, runPollMs,
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(async () => { await deck.close()
    fs.rmSync(dir, { recursive: true, force: true }) })
  let at = 1_790_000_000_000
  let tool = 0
  const send = (sessionId, cwd, hook, hookTs = at += 1000) => {
    deck.ingest.receive(JSON.stringify({ v: 1, hookTs, ptyId: null, claudePid: null, pidChain: [], truncated: false,
      hook: { ...base, session_id: sessionId, cwd, tool_use_id: `toolu_${++tool}`, ...hook } }))
    deck.ingest.flush()
  }
  const start = (sessionId, cwd) => send(sessionId, cwd, { hook_event_name: 'SessionStart', source: 'startup', tool_name: undefined, tool_input: undefined })
  const bash = (sessionId, cwd, command) => send(sessionId, cwd, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
  const request = async route => {
    const origin = `http://127.0.0.1:${deck.address().port}`
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}`, Origin: origin } })
    return { status: response.status, data: await response.json() }
  }
  const sessionFor = claudeId => deck.projector.snapshot().sessions.find(row => row.claudeSessionId === claudeId)
  const events = []
  deck.subscribe(event => events.push(event))
  // A further task worktree with no index record until `locate` writes one, as a teammate's own first act does.
  const addWorktree = taskId => {
    const worktree = path.join(fs.realpathSync(dir), 'wt', taskId)
    git(place.repo, 'worktree', 'add', '-q', '-b', `fleetmates/r1/${taskId}`, worktree)
    return worktree
  }
  const locate = (taskId, worktree) => rootState.writeLocation(place.repo, 'r1', taskId, { worktree, branch: `fleetmates/r1/${taskId}` })
  const lastTs = () => at
  return { deck, ...place, send, start, bash, request, sessionFor, events, addWorktree, locate, lastTs }
}

test('a lead running scripts/cli.mjs --run from the repo root becomes the run lead on GET /api/runs', async t => {
  const h = await harness(t)
  h.start('lead-1', h.repo)
  const lead = h.sessionFor('lead-1')
  assert.equal(lead.role, 'solo')
  const before = await h.request('/api/runs')
  assert.equal(before.data.runs.find(run => run.runId === 'r1').leadSessionId, null)
  h.bash('lead-1', h.repo, 'node scripts/cli.mjs dispatch --run r1 --phase 1')
  const joined = h.sessionFor('lead-1')
  assert.equal(joined.role, 'lead')
  assert.deepEqual(joined.runRef, { repoId: h.repo, runId: 'r1', taskId: null })
  const row = h.deck.store.get('SELECT * FROM runs WHERE repo_id=? AND run_id=?', h.repo, 'r1')
  assert.equal(row.lead_session_id, lead.id)
  assert.equal(typeof row.first_seen_at, 'number')
  assert.equal(row.last_seen_at >= row.first_seen_at, true)
  const runs = await h.request('/api/runs')
  assert.equal(runs.data.runs.find(run => run.runId === 'r1').leadSessionId, lead.id)
  const one = await h.request('/api/runs/alpha/r1')
  assert.equal(one.status, 200)
  assert.equal(one.data.run.leadSessionId, lead.id)
  // `--run=<id>` and a quoted cli path are the same call.
  h.start('lead-2', h.repo)
  h.bash('lead-2', h.repo, `node "${path.join(h.repo, 'scripts', 'cli.mjs')}" gate --plan p.md --run=r1 --phase 1`)
  assert.equal(h.sessionFor('lead-2').role, 'lead')
})

test('a run id failing the root name rules, or a call away from the repo root, joins nothing', async t => {
  const h = await harness(t)
  fs.mkdirSync(path.join(h.repo, 'sub'))
  h.start('solo-1', h.repo)
  h.bash('solo-1', h.repo, 'node scripts/cli.mjs dispatch --run ../escape --phase 1')
  h.bash('solo-1', h.repo, 'node scripts/cli.mjs dispatch --run -rf --phase 1')
  h.bash('solo-1', h.repo, 'node scripts/other.mjs --run r1')
  assert.equal(h.sessionFor('solo-1').role, 'solo')
  h.start('solo-2', path.join(h.repo, 'sub'))
  h.bash('solo-2', path.join(h.repo, 'sub'), 'node ../scripts/cli.mjs dispatch --run r1 --phase 1')
  assert.equal(h.sessionFor('solo-2').role, 'solo')
  // A teammate subagent's own `locate --run` inside the lead's process comes from the worktree.
  h.start('solo-3', h.repo)
  h.bash('solo-3', h.worktree, 'node /x/scripts/cli.mjs locate --run r1 --task T2')
  assert.equal(h.sessionFor('solo-3').role, 'solo')
  assert.equal(h.deck.store.all('SELECT * FROM runs').length, 0)
})

test('hooks from a teammate worktree carry the task id and leave the session in the main repo', async t => {
  const h = await harness(t)
  const before = stateTree(h.repo)
  h.start('lead-1', h.repo)
  h.bash('lead-1', h.repo, 'node scripts/cli.mjs dispatch --run r1 --phase 1')
  const lead = h.sessionFor('lead-1')
  h.send('lead-1', h.worktree, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  const requests = await h.request('/api/requests?taskId=T2')
  assert.equal(requests.data.requests.length, 1)
  assert.equal(requests.data.requests[0].sessionId, lead.id)
  assert.equal(requests.data.requests[0].taskId, 'T2')
  h.send('lead-1', h.worktree, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(h.worktree, 'README.md') } })
  h.send('lead-1', h.repo, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(h.repo, 'README.md') } })
  const steps = (await h.request(`/api/sessions/${lead.id}/steps`)).data.steps
  assert.deepEqual(steps.map(step => [step.toolName, step.taskId]), [['Bash', null], ['Read', 'T2'], ['Read', null]])
  assert.deepEqual((await h.request(`/api/sessions/${lead.id}/steps?taskId=T2`)).data.steps.map(step => step.toolName), ['Read'])
  const after = h.sessionFor('lead-1')
  assert.equal(after.repoId, h.repo, 'the session stays in the main repo')
  assert.equal(after.cwd, h.repo)
  assert.equal(after.role, 'lead')
  assert.deepEqual(after.runRef, { repoId: h.repo, runId: 'r1', taskId: null })
  assert.deepEqual(stateTree(h.repo), before, 'nothing under .fleetmates/ changes')
})

test('a SessionStart inside a teammate worktree makes a teammate session with the task runRef', async t => {
  const h = await harness(t)
  h.start('mate-1', h.worktree)
  const mate = h.sessionFor('mate-1')
  assert.equal(mate.role, 'teammate')
  assert.equal(mate.repoId, h.repo)
  assert.deepEqual(mate.runRef, { repoId: h.repo, runId: 'r1', taskId: 'T2' })
  h.send('mate-1', h.worktree, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(h.worktree, 'README.md') } })
  assert.deepEqual((await h.request(`/api/sessions/${mate.id}/steps`)).data.steps.map(step => step.taskId), ['T2'])
})

test('an index record that is a FIFO or over 64 KiB is ignored without blocking the projector', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-'))
  try {
    const { repo, worktree } = await fleetRepo(dir)
    const record = path.join(rootState.indexDir(repo), `${rootState.worktreeKey(worktree)}.json`)
    const valid = fs.readFileSync(record, 'utf8')
    // In a child process, so a blocking open on the FIFO becomes a timeout here rather than a hung runner.
    const project = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { openDeckDb } = await import(${JSON.stringify(new URL('../../server/db/index.mjs', import.meta.url).href)})
      const { createProjector } = await import(${JSON.stringify(new URL('../../server/machines/projector.mjs', import.meta.url).href)})
      const { createTaskLocator } = await import(${JSON.stringify(new URL('../../server/adapters/fleetmates.mjs', import.meta.url).href)})
      const store = openDeckDb(${JSON.stringify(path.join(dir, 'db', `deck-${Math.random().toString(36).slice(2)}.db`))})
      const projector = createProjector({ store, locateTask: createTaskLocator().taskForCwd })
      const hook = ${JSON.stringify({ ...base, session_id: 'lead-1' })}
      const send = (at, extra) => projector.applyHooks([{ v: 1, hookTs: at, ptyId: null, claudePid: null, pidChain: [], truncated: false, hook: { ...hook, ...extra } }])
      send(1000, { cwd: ${JSON.stringify(repo)}, hook_event_name: 'SessionStart', source: 'startup' })
      send(2000, { cwd: ${JSON.stringify(worktree)}, tool_use_id: 'toolu_w', tool_name: 'Read', tool_input: { file_path: 'README.md' } })
      send(3000, { session_id: 'mate-1', cwd: ${JSON.stringify(worktree)}, hook_event_name: 'SessionStart', source: 'startup' })
      process.stdout.write(JSON.stringify({ steps: store.all('SELECT task_id FROM session_steps').map(row => row.task_id),
        roles: store.all('SELECT role FROM sessions ORDER BY started_at').map(row => row.role) }))
      store.close()`], { encoding: 'utf8', timeout: 20_000 })
    const run = () => {
      const result = project()
      assert.equal(result.signal, null, 'the projector returned instead of blocking on the record')
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }
    assert.deepEqual(run(), { steps: ['T2'], roles: ['solo', 'teammate'] }, 'the valid record attributes')
    fs.writeFileSync(record, valid.trimEnd() + ' '.repeat(64 * 1024))
    assert.deepEqual(run(), { steps: [null], roles: ['solo', 'solo'] }, 'over 64 KiB')
    fs.rmSync(record)
    execFileSync('mkfifo', [record])
    assert.deepEqual(run(), { steps: [null], roles: ['solo', 'solo'] }, 'a FIFO')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the run.updated poll carries the lead once the run join records it', async t => {
  const h = await harness(t, { runPollMs: 20 })
  const updated = () => h.events.filter(event => event.type === 'run.updated' && event.data.runId === 'r1')
  h.start('lead-1', h.repo)
  await waitFor(() => updated().length === 1)
  assert.equal(updated()[0].data.leadSessionId, null)
  h.bash('lead-1', h.repo, 'node scripts/cli.mjs dispatch --run r1 --phase 1')
  await waitFor(() => updated().length === 2)
  assert.equal(updated()[1].data.leadSessionId, h.sessionFor('lead-1').id)
})

test('a worktree hook before its index record exists does not hide the task once locate has written it', async t => {
  const h = await harness(t, { record: false })
  h.start('lead-1', h.repo)
  h.bash('lead-1', h.repo, 'node scripts/cli.mjs dispatch --run r1 --phase 1')
  const lead = h.sessionFor('lead-1')
  // The teammate's first act: `locate` from its worktree, whose own PreToolUse arrives before the record exists.
  h.bash('lead-1', h.worktree, 'node /x/scripts/cli.mjs locate --run r1 --task T2')
  await h.locate('T2', h.worktree)
  h.send('lead-1', h.worktree, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(h.worktree, 'README.md') } })
  h.send('lead-1', h.worktree, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  const steps = (await h.request(`/api/sessions/${lead.id}/steps`)).data.steps
  assert.deepEqual(steps.map(step => [step.toolName, step.taskId]), [['Bash', null], ['Bash', null], ['Read', 'T2']])
  const requests = (await h.request('/api/requests?taskId=T2')).data.requests
  assert.deepEqual(requests.map(row => [row.sessionId, row.taskId]), [[lead.id, 'T2']])
})

test('a session started in a worktree before its record exists joins as teammate on a later hook, keeping its repo', async t => {
  const h = await harness(t)
  const worktree = h.addWorktree('T3')
  h.start('mate-3', worktree)
  assert.equal(h.sessionFor('mate-3').role, 'solo')
  await h.locate('T3', worktree)
  h.send('mate-3', worktree, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(worktree, 'README.md') } })
  const mate = h.sessionFor('mate-3')
  assert.equal(mate.role, 'teammate')
  assert.equal(mate.repoId, h.repo, 'the repo never moves')
  assert.deepEqual(mate.runRef, { repoId: h.repo, runId: 'r1', taskId: 'T3' })
  assert.deepEqual((await h.request(`/api/sessions/${mate.id}/steps`)).data.steps.map(step => step.taskId), ['T3'])
})

test('a late worktree PermissionRequest reconciled behind newer activity carries the task id', async t => {
  const h = await harness(t)
  h.start('lead-1', h.repo)
  const started = h.lastTs()
  h.send('lead-1', h.repo, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(h.repo, 'README.md') } })
  h.send('lead-1', h.worktree, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } }, started + 500)
  const requests = (await h.request('/api/requests')).data.requests
  assert.deepEqual(requests.map(row => [row.state, row.createdAt, row.taskId]), [['open', started + 500, 'T2']])
})

test('a worktree PermissionRequest that upgrades a notification fallback carries the task id', async t => {
  const h = await harness(t)
  h.start('lead-1', h.repo)
  h.send('lead-1', h.repo, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?', tool_name: undefined, tool_input: undefined })
  const opened = (await h.request('/api/requests')).data.requests
  assert.deepEqual(opened.map(row => [row.source, row.taskId]), [['notification', null]])
  h.send('lead-1', h.worktree, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pwd' } }, h.lastTs() + 1)
  const requests = (await h.request('/api/requests')).data.requests
  assert.deepEqual(requests.map(row => [row.id, row.source, row.taskId]), [[opened[0].id, 'permission_request', 'T2']])
})

test('a --run in a later command segment does not make a lead', async t => {
  const h = await harness(t)
  h.start('solo-1', h.repo)
  for (const command of ['node scripts/cli.mjs status; git log --run r1', 'node scripts/cli.mjs status && git log --run r1',
    'node scripts/cli.mjs status | other --run r1', 'node scripts/cli.mjs status\nother --run r1']) {
    h.bash('solo-1', h.repo, command)
    assert.equal(h.sessionFor('solo-1').role, 'solo', command)
  }
  assert.equal(h.deck.store.all('SELECT * FROM runs').length, 0)
})

test('a lead that names another run moves its runRef and becomes that run\'s lead', async t => {
  const h = await harness(t)
  h.start('lead-1', h.repo)
  h.bash('lead-1', h.repo, 'node scripts/cli.mjs dispatch --run r1 --phase 1')
  h.bash('lead-1', h.repo, 'node scripts/cli.mjs dispatch --run r2 --phase 1')
  const lead = h.sessionFor('lead-1')
  assert.equal(lead.role, 'lead')
  assert.deepEqual(lead.runRef, { repoId: h.repo, runId: 'r2', taskId: null })
  assert.equal(h.deck.store.get('SELECT lead_session_id FROM runs WHERE repo_id=? AND run_id=?', h.repo, 'r2')?.lead_session_id, lead.id)
})

/** Await a condition the server reaches on its own; the deadline only turns a hang into a failure. */
async function waitFor(fn) {
  const until = Date.now() + 5000
  while (!fn()) { assert.ok(Date.now() < until, 'timed out')
    await new Promise(resolve => setTimeout(resolve, 10)) }
}
