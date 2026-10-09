// The rule routes over HTTP (docs/deck/05-api.md 2.5; M3 Task 16) against the real server with deckd offline:
// add, list and revoke on a temp repo's .claude/settings.local.json keeping every other key, the Decided
// refusal of a Destructive rule, the suggestion threshold read again on every prefs change, the `tracked` flag of
// GET, the toast Undo of DELETE and the retryable `settings_changed`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startDeckServer } from '../../server/main.mjs'
import { createApi } from '../../server/http/api.mjs'
import { apiError } from '../../server/http/router.mjs'
import { openDeckDb } from '../../server/db/index.mjs'
import { createProjector } from '../../server/machines/projector.mjs'
import { createRules } from '../../server/approvals/rules.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

const token = 'a'.repeat(43)
const hooks = new URL('../fixtures/hooks/2.1.285/', import.meta.url)
const fixture = name => JSON.parse(fs.readFileSync(new URL(`${name}.json`, hooks)))

/** A server over a fresh home, and one repo (with a package.json whose `test` script makes `npm run test` Safe). */
async function harness(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rul-')))
  let deck = null
  // One hook, so the server (and its SQLite file) is closed before its directory is removed: Windows
  // cannot remove an open file.
  t.after(async () => {
    await deck?.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  // Where the server looks for its state and token on this host (the win32 layout differs).
  const paths = setupPaths(env)
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(paths.token, token, { mode: 0o600 })
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  const repo = path.join(dir, 'shipyard')
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  deck = await startDeckServer({ env, port: 0, staticDir, notifications: false, connectDeckd: async () => { throw Error('fake offline') },
    runPollMs: 3_600_000, runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  const origin = () => `http://127.0.0.1:${deck.address().port}`
  const request = async (route, init = {}) => {
    const response = await fetch(origin() + route, { ...init, headers: { Authorization: `Bearer ${token}`, Origin: origin(), 'Content-Type': 'application/json', ...init.headers } })
    const text = await response.text()
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }
  let at = Date.now()
  /** One hook of the observed session in `repo`, stamped with Claude process 4242. */
  const send = (name, fields = {}) => {
    at += 10
    deck.ingest.receive(JSON.stringify({ v: 1, hookTs: at, ptyId: null, claudePid: 4242, pidChain: [], truncated: false,
      hook: { ...fixture(name), session_id: 'claude-rules', cwd: repo, ...fields } }))
    deck.ingest.flush()
  }
  send('SessionStart.startup')
  const name = deck.store.get('SELECT name FROM repos WHERE id = ?', repo)?.name
  assert.equal(name, 'shipyard', 'the session hook registered the repo')
  return { deck, repo, request, send }
}

test('POST, GET and DELETE /api/rules round trip on a temp repo keeps the other keys of the settings file', { skip: process.platform === 'win32' && 'rule writes are refused on win32 (docs/deck/16-platforms.md section 6)' }, async t => {
  const h = await harness(t)
  const file = path.join(h.repo, '.claude/settings.local.json')
  const original = { env: { FOO: '1' }, permissions: { deny: ['Read(./secrets/**)'], allow: ['mcp__vault__vault_search'] }, theme: 'dark' }
  fs.writeFileSync(file, JSON.stringify(original, null, 2) + '\n')
  const added = await h.request('/api/rules', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'Bash(npm run test)', source: 'manual' }) })
  assert.equal(added.status, 201, JSON.stringify(added.data))
  assert.equal(added.data.rule.pattern, 'Bash(npm run test)')
  assert.equal(added.data.rule.source, 'manual')
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(written), ['env', 'permissions', 'theme'], 'key order is kept')
  assert.deepEqual(written, { ...original, permissions: { deny: ['Read(./secrets/**)'], allow: ['mcp__vault__vault_search', 'Bash(npm run test)'] } })
  const again = await h.request('/api/rules', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'Bash(npm run test)', source: 'manual' }) })
  assert.equal(again.status, 409)
  assert.equal(again.data.error.code, 'rule_exists')

  const listed = await h.request('/api/rules')
  assert.equal(listed.status, 200)
  assert.equal(listed.data.threshold, 5)
  assert.equal(listed.data.tiersError, null)
  const repo = listed.data.repos.find(item => item.repoKey === 'shipyard')
  assert.equal(repo.repoId, h.repo)
  assert.equal(repo.settingsPath, file)
  assert.deepEqual(repo.rules.map(rule => [rule.pattern, rule.source, rule.createdAt === null]).sort(), [['Bash(npm run test)', 'manual', false], ['mcp__vault__vault_search', 'manual', true]])
  const one = await h.request('/api/rules?repoKey=shipyard')
  assert.deepEqual(one.data.repos.map(item => item.repoKey), ['shipyard'])

  const removed = await h.request(`/api/rules/shipyard/${encodeURIComponent('Bash(npm run test)')}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.data, { removed: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original, 'only the rule left the file')
  const gone = await h.request(`/api/rules/shipyard/${encodeURIComponent('Bash(npm run test)')}`, { method: 'DELETE' })
  assert.deepEqual(gone.data, { removed: false, reason: 'already_removed' })
  const unknown = await h.request('/api/rules/nowhere/x', { method: 'DELETE' })
  assert.equal(unknown.status, 404)
})

test('Bash(rm:*) is refused 422 destructive_rule and nothing is written; a body with an unknown key is validation_failed', { skip: process.platform === 'win32' && 'rule writes are refused on win32 (docs/deck/16-platforms.md section 6)' }, async t => {
  const h = await harness(t)
  const file = path.join(h.repo, '.claude/settings.local.json')
  const refused = await h.request('/api/rules', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'Bash(rm:*)', source: 'manual' }) })
  assert.equal(refused.status, 422)
  assert.equal(refused.data.error.code, 'destructive_rule')
  assert.equal(fs.existsSync(file), false)
  const extra = await h.request('/api/rules', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'Bash(npm run test)', source: 'manual', force: true }) })
  assert.equal(extra.status, 422)
  assert.equal(extra.data.error.code, 'validation_failed')
  assert.deepEqual(extra.data.error.details.fields, ['force'])
  const source = await h.request('/api/rules', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'Bash(npm run test)', source: 'auto' }) })
  assert.equal(source.status, 422)
  assert.equal(fs.existsSync(file), false)
})

test('the threshold set to 3 through PATCH /api/prefs makes the third Safe terminal approval an offer in the snapshot', { skip: process.platform === 'win32' && 'on win32 nothing is Safe, so no rule is offered (docs/deck/16-platforms.md section 6)' }, async t => {
  const h = await harness(t)
  const patched = await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ ruleSuggestAfter: 3 }) })
  assert.equal(patched.status, 200)
  const input = { tool_name: 'Bash', tool_input: { command: 'npm run test', description: 'Run the tests' } }
  const approve = () => {
    h.send('PermissionRequest.Bash', input)
    h.send('PostToolUse.Bash', input)
  }
  approve()
  approve()
  const request = h.deck.store.get("SELECT * FROM requests WHERE summary = 'npm run test' ORDER BY created_at LIMIT 1")
  assert.equal(request.tier, 'safe')
  assert.equal(request.rule_pattern, 'Bash(npm run test)')
  assert.deepEqual((await h.deck.snapshot()).data.ruleOffers, [], 'two approvals are below the threshold')
  approve()
  const offers = (await h.deck.snapshot()).data.ruleOffers
  assert.deepEqual(offers.map(offer => ({ ...offer })), [{ repoId: h.repo, repoKey: 'shipyard', pattern: 'Bash(npm run test)', count: 3, threshold: 3, ruleNote: null }])
  assert.equal((await h.request('/api/rules')).data.threshold, 3)
  // Dismiss withdraws the offer; a second dismiss finds none.
  const dismissed = await h.request('/api/rules/suggestions/dismiss', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'Bash(npm run test)' }) })
  assert.equal(dismissed.status, 204)
  assert.deepEqual((await h.deck.snapshot()).data.ruleOffers, [])
  const none = await h.request('/api/rules/suggestions/dismiss', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'Bash(npm run test)' }) })
  assert.equal(none.status, 404)
  // Never (null) withdraws every offer and stops suggesting.
  for (let i = 0; i < 3; i++) approve()
  assert.equal((await h.deck.snapshot()).data.ruleOffers.length, 1)
  await h.request('/api/prefs', { method: 'PATCH', body: JSON.stringify({ ruleSuggestAfter: null }) })
  assert.deepEqual((await h.deck.snapshot()).data.ruleOffers, [])
  assert.equal((await h.request('/api/rules')).data.threshold, null)
})

/** Point this process's git at a temporary home for the rest of the test, so no owner config is read. */
function isolatedGit(t, home) {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = path.join(home, '.config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
}
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { timeout: 5000 })

test('GET /api/rules marks each rule tracked when git tracks the settings file, as POST does', { skip: process.platform === 'win32' && 'rule writes are refused on win32 (docs/deck/16-platforms.md section 6)' }, async t => {
  const h = await harness(t)
  isolatedGit(t, path.dirname(h.repo))
  const file = path.join(h.repo, '.claude/settings.local.json')
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['mcp__vault__vault_search'] } }) + '\n')
  git(h.repo, 'init', '-q')
  const before = (await h.request('/api/rules?repoKey=shipyard')).data.repos[0].rules
  assert.deepEqual(before.map(rule => [rule.pattern, rule.tracked]), [['mcp__vault__vault_search', false]], 'an untracked file')
  git(h.repo, 'add', '-f', '.claude/settings.local.json')
  git(h.repo, 'commit', '-qm', 'settings')
  const after = (await h.request('/api/rules?repoKey=shipyard')).data.repos[0].rules
  assert.deepEqual(after.map(rule => [rule.pattern, rule.tracked]), [['mcp__vault__vault_search', true]], 'a committed file')
  const added = await h.request('/api/rules', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'Bash(npm run test)', source: 'manual' }) })
  assert.equal(added.data.rule.tracked, true, 'POST answers the same')
})

test('DELETE with ?undo=1 is the toast Undo: rule_audit records undo, and any other undo value is refused', { skip: process.platform === 'win32' && 'rule writes are refused on win32 (docs/deck/16-platforms.md section 6)' }, async t => {
  const h = await harness(t)
  const added = await h.request('/api/rules', { method: 'POST', body: JSON.stringify({ repoKey: 'shipyard', pattern: 'mcp__vault__vault_search', source: 'suggested' }) })
  assert.equal(added.status, 201)
  const bad = await h.request('/api/rules/shipyard/mcp__vault__vault_search?undo=yes', { method: 'DELETE' })
  assert.equal(bad.status, 422)
  assert.deepEqual(bad.data.error.details.fields, ['undo'])
  const undone = await h.request('/api/rules/shipyard/mcp__vault__vault_search?undo=1', { method: 'DELETE' })
  assert.deepEqual(undone.data, { removed: true })
  const actions = h.deck.store.all('SELECT action, actor FROM rule_audit WHERE pattern = ? ORDER BY id', 'mcp__vault__vault_search').map(row => ({ ...row }))
  assert.deepEqual(actions, [{ action: 'added', actor: 'suggestion' }, { action: 'undo', actor: 'manual' }])
})

test('settings_changed answers 409 with retryable true (05-api section 4)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rul-api-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  // The store is closed before its directory is removed: Windows cannot remove an open SQLite file.
  t.after(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  store.run("INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES('/home/you/dev/web','web',0,1,'web',0)")
  const rules = { write: async () => { throw apiError(409, 'settings_changed', { path: '/home/you/dev/web/.claude/settings.local.json' }) } }
  const api = createApi({ store, projector: createProjector({ store }), paths: { config: dir, state: dir }, services: {}, runReader: { list: async () => [] },
    health: () => [], approvals: { rules, deliverer: {}, threshold: () => 5, tiersStatus: () => ({ ok: true }), ruleOffers: () => [] } })
  const result = await api.route({ method: 'POST', segments: ['api', 'rules'], query: new URLSearchParams(), body: { repoKey: 'web', pattern: 'mcp__vault__vault_search', source: 'manual' } })
  assert.equal(result.status, 409)
  assert.equal(result.data.error.code, 'settings_changed')
  assert.equal(result.data.error.retryable, true)
  api.close()
})

// docs/deck/16-platforms.md section 6: on win32 POST /api/rules refuses every rule and writes nothing,
// through the real rules service with the platform injected, so it runs on every host.
// Mutation run for this test: the win32 refusal removed from validatePattern; this test failed.
test('on win32 POST /api/rules answers 422 rules_unsupported_on_win32 and writes nothing', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rul-w32-')))
  const store = openDeckDb(path.join(dir, 'state', 'deck.db'))
  let api = null
  t.after(() => {
    api?.close()
    store.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const repo = path.join(dir, 'web')
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repo, 'web', 0, 1, 'web', 0)
  const paths = { config: dir, state: path.join(dir, 'state') }
  const rules = createRules({ store, paths, gitRead: async () => null, platform: 'win32' })
  api = createApi({ store, projector: createProjector({ store }), paths, services: {}, runReader: { list: async () => [] },
    health: () => [], approvals: { rules, deliverer: {}, threshold: () => 5, tiersStatus: () => ({ ok: true }), ruleOffers: () => [] } })
  for (const pattern of ['mcp__vault__vault_search', 'Bash(npm run test)', 'Bash(rm:*)']) {
    // The code is not in the api's status table, so api.route throws it on to the HTTP router.
    await assert.rejects(api.route({ method: 'POST', segments: ['api', 'rules'], query: new URLSearchParams(), body: { repoKey: 'web', pattern, source: 'manual' } }),
      error => error.status === 422 && error.code === 'rules_unsupported_on_win32', pattern)
  }
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'settings.local.json')), false)
  assert.equal(store.get('SELECT COUNT(*) AS n FROM rules').n, 0)
})
