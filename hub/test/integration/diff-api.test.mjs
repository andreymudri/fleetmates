// GET /api/sessions/:id/diff (docs/deck/05-api.md 2.3; M3 Task 16) against the real server with deckd offline:
// the hunk of a file changed after the review baseline, and the refusals of an escaping, unknown or missing path.
// git runs with HOME and XDG_CONFIG_HOME pointed at a temporary directory, so no owner config is read.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startDeckServer } from '../../server/main.mjs'
import { captureReviewBaseline } from '../../server/machines/session.mjs'

const token = 'a'.repeat(43)

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { timeout: 5000 }).toString('utf8')
}

test('the diff route returns the hunk of a changed file and refuses an escaping, unknown or missing path', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dif-')))
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    fs.rmSync(dir, { recursive: true, force: true })
  })
  process.env.HOME = dir
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(state, 'token'), token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const repo = path.join(dir, 'harbor')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'same\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'fixture')
  const baseline = captureReviewBaseline(repo)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n')

  const deck = await startDeckServer({ env, port: 0, staticDir, notifications: false, connectDeckd: async () => { throw Error('fake offline') },
    runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(() => deck.close())
  const now = Date.now()
  deck.store.run("INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?, 'harbor', 0, 1, 'harbor', 0)", repo)
  deck.store.run('INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at,changed_files,review_baseline) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    's-diff', 'observed', repo, repo, 'done', now, now, now, 0, now, JSON.stringify([{ path: path.join(repo, 'a.txt'), adds: 1, dels: 1 }]), baseline)
  const origin = `http://127.0.0.1:${deck.address().port}`
  const get = async route => {
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}`, Origin: origin } })
    return { status: response.status, data: await response.json() }
  }

  const ok = await get('/api/sessions/s-diff/diff?path=a.txt')
  assert.equal(ok.status, 200)
  assert.equal(ok.data.path, 'a.txt')
  assert.equal(ok.data.baseline, git(repo, 'rev-parse', 'HEAD').trim())
  assert.equal(ok.data.diff, '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n')
  assert.equal(ok.data.binary, false)
  assert.equal(ok.data.truncated, false)
  for (const escaping of ['../../etc/passwd', '/etc/passwd', 'a.txt\0']) {
    const refused = await get(`/api/sessions/s-diff/diff?path=${encodeURIComponent(escaping)}`)
    assert.equal(refused.status, 422, JSON.stringify(escaping))
    assert.equal(refused.data.error.code, 'validation_failed')
    assert.deepEqual(refused.data.error.details.fields, ['path'])
  }
  const unchanged = await get('/api/sessions/s-diff/diff?path=b.txt')
  assert.equal(unchanged.status, 404, 'a path not in changedFiles')
  assert.equal(unchanged.data.error.code, 'not_found')
  const missing = await get('/api/sessions/s-diff/diff')
  assert.equal(missing.status, 422)
  assert.equal((await get('/api/sessions/nope/diff?path=a.txt')).status, 404)
})
