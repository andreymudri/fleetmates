// Delivery recovery at server start (M3 Task 16 step d): a crash or restart can leave a request with the
// deck's attempt in flight. `recover(store)` puts an open request in `sending` or `verifying` back to
// `idle` with its earlier answer, settles an answered row that still carries a `pending` verdict or an
// unsettled `sending` attempt as a terminal answer with one audit row, and clears the attempt of an expired
// row. No key is ever retried. The server runs it before it accepts answers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDeckDb } from '../../server/db/index.mjs'
import { recover } from '../../server/approvals/deliver.mjs'
import { ensureRepo } from '../../server/adapters/repos.mjs'
import { startDeckServer } from '../../server/main.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

const NOW = Date.UTC(2026, 9, 4, 12, 0)

function seeded(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcv-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  t.after(() => { store.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  ensureRepo(store, '/home/you/dev/web', () => NOW)
  store.run('INSERT INTO sessions(id,origin,pty_id,process_key,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    's1', 'wrapped', 'pty-1', 'k1', '/home/you/dev/web', '/home/you/dev/web', 'needs_approval', NOW, NOW, NOW, 1, NOW)
  const request = (id, fields) => {
    store.run("INSERT INTO requests(id,session_id,kind,tier,tool_name,summary,detail,state,source,match_key,created_at) VALUES(?,?,'permission','safe','Bash','npm run test','{}','open','permission_request',?,?)", id, 's1', `m-${id}`, NOW)
    const names = Object.keys(fields)
    if (names.length) store.run(`UPDATE requests SET ${names.map(name => `${name} = ?`).join(', ')} WHERE id = ?`, ...names.map(name => fields[name]), id)
  }
  return { store, request, row: id => store.get('SELECT * FROM requests WHERE id = ?', id), audits: id => store.all('SELECT * FROM approval_audit WHERE request_id = ? ORDER BY id', id) }
}

const attempt = extra => JSON.stringify({ via: 'browser', choice: 'allow', label: 'Yes', until: NOW + 10_000, ...extra })

test('recover: an open request left sending or verifying goes back to idle with its earlier answer, and nothing is audited', t => {
  const s = seeded(t)
  s.request('fresh', { delivery: 'sending', answer: attempt() })
  s.request('verifying', { delivery: 'verifying', answer: attempt() })
  const prior = { via: 'browser', choice: 'allow', label: 'Yes', until: NOW }
  s.request('again', { delivery: 'sending', answer: attempt({ prior }) })
  s.request('quiet', { delivery: 'did_not_land', answer: JSON.stringify(prior) })
  const before = Number(s.store.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').seq)
  const result = recover(s.store, { now: () => NOW })
  assert.deepEqual(result.reset.sort(), ['again', 'fresh', 'verifying'])
  for (const id of ['fresh', 'verifying']) {
    assert.equal(s.row(id).state, 'open')
    assert.equal(s.row(id).delivery, 'idle')
    assert.equal(s.row(id).answer, null, `${id}: no earlier answer`)
  }
  assert.equal(s.row('again').delivery, 'idle')
  assert.deepEqual(JSON.parse(s.row('again').answer), prior, 'the earlier did_not_land answer comes back')
  assert.equal(s.row('quiet').delivery, 'did_not_land', 'a settled did_not_land is left alone')
  assert.deepEqual(s.audits('fresh'), [])
  const events = s.store.all('SELECT type, entity_id FROM events WHERE seq > ? ORDER BY seq', before)
  assert.deepEqual(events.map(event => `${event.type} ${event.entity_id}`).sort(), ['request.updated again', 'request.updated fresh', 'request.updated verifying'])
})

test('recover: a closed row with a pending verdict or an unsettled attempt is settled as a terminal answer with one audit row', t => {
  const s = seeded(t)
  s.request('pending', { state: 'answered', answered_at: NOW, delivery: 'sending',
    answer: JSON.stringify({ via: 'terminal', choice: 'allow', pending: { via: 'browser', choice: 'allow', label: 'Yes' } }) })
  s.request('unsettled', { state: 'answered', answered_at: NOW, delivery: 'sending', answer: attempt({ choice: 'deny' }) })
  s.request('expired', { state: 'expired', expired_reason: 'process_ended', delivery: 'sending', answer: attempt() })
  s.request('done', { state: 'answered', answered_at: NOW, delivery: 'verifying', answer: JSON.stringify({ via: 'browser', choice: 'allow' }) })
  const result = recover(s.store, { now: () => NOW })
  assert.deepEqual(result.settled.sort(), ['expired', 'pending', 'unsettled'])
  assert.deepEqual(JSON.parse(s.row('pending').answer), { via: 'terminal', choice: 'allow' })
  assert.equal(s.row('pending').delivery, 'idle')
  assert.deepEqual(JSON.parse(s.row('unsettled').answer), { via: 'terminal', choice: 'deny' })
  for (const id of ['pending', 'unsettled']) {
    const rows = s.audits(id)
    assert.equal(rows.length, 1, `${id}: one audit row`)
    assert.equal(rows[0].kind, 'answered')
    assert.equal(rows[0].via, 'terminal')
  }
  assert.equal(s.row('expired').state, 'expired')
  assert.equal(s.row('expired').delivery, 'idle')
  assert.equal(s.row('expired').answer, null, 'an expired attempt is cleared, not an answer')
  assert.deepEqual(s.audits('expired'), [])
  assert.deepEqual(JSON.parse(s.row('done').answer), { via: 'browser', choice: 'allow' }, 'a settled deck answer is left alone')
  // A second start finds nothing left to recover.
  assert.deepEqual(recover(s.store, { now: () => NOW }), { reset: [], settled: [] })
  assert.equal(s.audits('pending').length, 1)
})

test('the server recovers at start: a seeded sending row is idle once it listens', async t => {
  const s = seeded(t)
  s.request('stuck', { delivery: 'sending', answer: attempt() })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rcv-home-'))
  let deck
  t.after(async () => { await deck?.close()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const env = { HOME: home }
  // Where the server reads its state for this env on this platform.
  const { state } = setupPaths(env)
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), 'a'.repeat(43), { mode: 0o600 })
  deck = await startDeckServer({ env, store: s.store, port: 0, staticDir: home, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') }, runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  assert.equal(s.row('stuck').delivery, 'idle')
  assert.equal(s.row('stuck').answer, null)
})
