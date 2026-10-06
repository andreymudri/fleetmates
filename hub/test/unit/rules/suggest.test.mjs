import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../../server/db/index.mjs'
import { createProjector } from '../../../server/machines/projector.mjs'
import { matchKey } from '../../../server/machines/request.mjs'
import { applyThreshold, createRules, dismissOffer, offers, recordAllow, ruleThreshold } from '../../../server/approvals/rules.mjs'

// The rule suggestion machine (07-approvals 6, state-machines 2.8, D-73, D-74, D-78, F16).

function harness() {
  const root = mkdtempSync(path.join(tmpdir(), 'deck-rules-suggest-'))
  const repo = path.join(root, 'rustot')
  mkdirSync(repo)
  const repoId = realpathSync(repo)
  const store = openDeckDb(path.join(root, 'state', 'deck.db'))
  store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repoId, 'rustot', 0, 0, 'rustot', 1)
  store.run("INSERT INTO sessions(id,origin,repo_id,cwd,state,state_since,since_ts,last_activity_at,alive,started_at) VALUES('s1','wrapped',?,?,'running',1,1,1,1,1)", repoId, repoId)
  let n = 0
  // An allowed (by default) Safe permission request with a rule candidate.
  const request = ({ tier = 'safe', pattern = 'Bash(npm run test)', choice = 'allow', kind = 'permission' } = {}) => {
    const id = `r${++n}`
    store.run('INSERT INTO requests(id,session_id,kind,tier,rule_pattern,tool_name,summary,state,source,match_key,answer,created_at,answered_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, 's1', kind, tier, pattern, 'Bash', 'cargo test', 'answered', 'permission_request', `key-${id}`, JSON.stringify({ via: 'browser', choice }), 100 + n, 200 + n)
    return { id }
  }
  const allow = (options = {}, threshold = 5) => store.tx(() => recordAllow(store, request(options), { via: 'browser', at: 1000 + n, threshold }))
  const counter = (pattern = 'Bash(npm run test)') => store.get('SELECT count, state FROM rule_counters WHERE repo_id = ? AND pattern = ?', repoId, pattern)
  const events = type => store.all('SELECT data FROM events WHERE type = ? ORDER BY seq', type).map(row => JSON.parse(row.data))
  return { root, repo, repoId, store, request, allow, counter, events, close() { store.close(); rmSync(root, { recursive: true, force: true }) } }
}

// Mutation run for this test: `count >= threshold` changed to `count > threshold` in recordAllow; this
// test failed.
test('the offer appears on the 5th Safe allow with threshold 5, on the 3rd with 3, and never with Never', () => {
  for (const threshold of [5, 3]) {
    const h = harness()
    try {
      for (let i = 1; i < threshold; i++) {
        const result = h.allow({}, threshold)
        assert.deepEqual(result, { counted: true, offered: false, count: i })
      }
      assert.deepEqual({ ...h.counter() }, { count: threshold - 1, state: 'counting' })
      assert.equal(h.events('rule.offered').length, 0)
      assert.deepEqual(h.allow({}, threshold), { counted: true, offered: true, count: threshold })
      assert.deepEqual({ ...h.counter() }, { count: threshold, state: 'offered' })
      const [offer] = h.events('rule.offered')
      assert.deepEqual(offer, { repoId: h.repoId, repoKey: 'rustot', pattern: 'Bash(npm run test)', count: threshold, threshold, ruleNote: null })
      assert.deepEqual(offers(h.store, { threshold }), [offer])
    } finally { h.close() }
  }
  const h = harness()
  try {
    for (let i = 0; i < 8; i++) assert.deepEqual(h.allow({}, null), { counted: false, offered: false, reason: 'never' })
    assert.equal(h.counter(), undefined)
    assert.equal(h.events('rule.offered').length, 0)
    assert.deepEqual(offers(h.store), [])
  } finally { h.close() }
})

test('Caution and Destructive allows, a Safe request with no rule pattern, a deny and a question never count', () => {
  const h = harness()
  try {
    for (let i = 0; i < 6; i++) {
      assert.equal(h.allow({ tier: 'caution' }).reason, 'not_safe')
      assert.equal(h.allow({ tier: 'destructive' }).reason, 'not_safe')
      assert.equal(h.allow({ pattern: null }).reason, 'no_pattern')
      assert.equal(h.allow({ choice: 'deny' }).reason, 'not_allowed')
      assert.equal(h.allow({ kind: 'question' }).reason, 'not_permission')
    }
    assert.equal(h.store.get('SELECT COUNT(*) AS n FROM rule_counters').n, 0)
    assert.equal(h.events('rule.offered').length, 0)
    // allow_always (option 2) is an allow too.
    assert.equal(h.allow({ choice: 'allow_always' }).counted, true)
  } finally { h.close() }
})

// Mutation runs for this test: recordAllow counted on from an `accepted` counter's count, and
// separately dropped `counter?.state === 'offered' ||` from the offered check; this test failed for each.
test('an accepted counter restarts from 0, and an offered counter stays offered when the threshold rises', () => {
  const h = harness()
  try {
    // The rule was accepted, then left the file by hand: counting restarts at 1.
    h.store.run("INSERT INTO rule_counters(repo_id,pattern,count,state,updated_at) VALUES(?,'Bash(npm run test)',7,'accepted',1)", h.repoId)
    assert.deepEqual(h.allow(), { counted: true, offered: false, count: 1 })
    assert.deepEqual({ ...h.counter() }, { count: 1, state: 'counting' })
    // An offer made at threshold 3 stays offered after the threshold goes to 5.
    for (let i = 0; i < 2; i++) h.allow({}, 3)
    assert.equal(h.counter().state, 'offered')
    assert.deepEqual(h.allow({}, 5), { counted: true, offered: true, count: 4 })
    assert.deepEqual({ ...h.counter() }, { count: 4, state: 'offered' })
  } finally { h.close() }
})

test('a pattern already in the settings file does not count and sets the machine to accepted', () => {
  const h = harness()
  try {
    mkdirSync(path.join(h.repo, '.claude'))
    writeFileSync(path.join(h.repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm  run  test)'] } }))
    assert.deepEqual(h.allow(), { counted: false, offered: false, reason: 'in_settings' })
    assert.deepEqual({ ...h.counter() }, { count: 0, state: 'accepted' })
  } finally { h.close() }
})

// Mutation run for this test: dismissOffer no longer reset `count` to 0; this test failed.
test('dismiss restarts the count; the offer comes back after another threshold of allows', () => {
  const h = harness()
  try {
    for (let i = 0; i < 5; i++) h.allow()
    assert.equal(h.counter().state, 'offered')
    assert.equal(h.store.tx(() => dismissOffer(h.store, h.repoId, 'Bash(npm run test)', { at: 5000 })), true)
    assert.deepEqual({ ...h.counter() }, { count: 0, state: 'counting' })
    assert.deepEqual(h.events('rule.withdrawn'), [{ repoId: h.repoId, pattern: 'Bash(npm run test)' }])
    assert.equal(h.store.tx(() => dismissOffer(h.store, h.repoId, 'Bash(npm run test)')), false)
    for (let i = 0; i < 4; i++) assert.equal(h.allow().offered, false)
    assert.equal(h.allow().offered, true)
    assert.equal(h.events('rule.offered').length, 2)
  } finally { h.close() }
})

test('a threshold change to Never freezes the counters and withdraws the offers', () => {
  const h = harness()
  try {
    for (let i = 0; i < 5; i++) h.allow()
    for (let i = 0; i < 2; i++) h.allow({ pattern: 'Bash(npm run lint)' })
    assert.equal(h.store.tx(() => applyThreshold(h.store, null, { at: 6000 })), 1)
    assert.deepEqual(h.events('rule.withdrawn'), [{ repoId: h.repoId, pattern: 'Bash(npm run test)' }])
    assert.deepEqual(offers(h.store), [])
    assert.deepEqual({ ...h.counter() }, { count: 5, state: 'counting' })
    for (let i = 0; i < 3; i++) h.allow({ pattern: 'Bash(npm run lint)' }, null)
    assert.deepEqual({ ...h.counter('Bash(npm run lint)') }, { count: 2, state: 'counting' })
  } finally { h.close() }
})

test('ruleThreshold reads ruleSuggestAfter: 5 by default, 3, and null for Never', () => {
  const h = harness()
  try {
    assert.equal(ruleThreshold(h.store), 5)
    h.store.run("INSERT INTO prefs(key,value,updated_at) VALUES('ruleSuggestAfter','3',1)")
    assert.equal(ruleThreshold(h.store), 3)
    h.store.run("UPDATE prefs SET value='null' WHERE key='ruleSuggestAfter'")
    assert.equal(ruleThreshold(h.store), null)
  } finally { h.close() }
})

// D-103 left no ruleNote in the default tiers, so a user tiers table carries one here.
test('createRules publishes what dismissOffer and setThreshold append, and offers() carries ruleNote', () => {
  const h = harness()
  try {
    const published = []
    const tiers = () => ({ entries: [{ id: 'user.npm-test', tier: 'safe', tool: 'Bash', cmd: 'npm run test', rule: 'Bash(npm run test)', ruleNote: 'anyFlags' }] })
    const rules = createRules({ store: h.store, paths: { state: path.join(h.root, 'state') }, publish: event => published.push(event), now: () => 7000, tiers })
    for (let i = 0; i < 5; i++) h.allow()
    assert.deepEqual(rules.offers().map(offer => offer.ruleNote), ['anyFlags'])
    assert.equal(rules.dismissOffer(h.repoId, 'Bash(npm run test)'), true)
    assert.deepEqual(published.map(event => [event.type, event.data]), [['rule.withdrawn', { repoId: h.repoId, pattern: 'Bash(npm run test)' }]])
    assert.ok(Number.isInteger(published[0].seq))
  } finally { h.close() }
})

// The terminal path through the projector (D-73, F16): applyRequestHook counts a PostToolUse allow
// only when the PermissionRequest and the PostToolUse came from the same Claude process.
const fixtureDir = new URL('../../fixtures/hooks/2.1.285/', import.meta.url)
function envelope(name, changes, hookTs, claudePid) {
  const hook = { ...JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8')), ...changes }
  return { v: 1, hook, hookTs, ptyId: 'pty-rules', claudePid, pidChain: claudePid ? [claudePid] : [], truncated: false, receivedAt: hookTs, via: 'socket' }
}

// Mutation runs for this test: the `opened !== closed` comparison removed from recordAllow (the null
// checks kept), and separately the recordAllow call removed from applyRequestHook; this test failed
// for each.
test('a terminal allow counts only when both hook rows carry the same claude_pid', () => {
  const tool = { tool_name: 'mcp__vault__vault_search', tool_input: { query: 'rules' } }
  for (const [opened, closed, counts] of [[42, 42, true], [42, 43, false], [null, 42, false], [42, null, false]]) {
    const h = harness()
    try {
      const projector = createProjector({ store: h.store, now: () => 1000 })
      projector.applyHooks([envelope('SessionStart.startup.json', { cwd: h.repo }, 1000, 42)])
      projector.applyHooks([envelope('PermissionRequest.Bash.json', { cwd: h.repo, ...tool }, 2000, opened)])
      const request = h.store.get("SELECT tier, rule_pattern, state FROM requests WHERE tool_name = 'mcp__vault__vault_search'")
      assert.deepEqual({ ...request }, { tier: 'safe', rule_pattern: 'mcp__vault__vault_search', state: 'open' })
      projector.applyHooks([envelope('PostToolUse.Bash.json', { cwd: h.repo, ...tool, tool_response: { ok: true } }, 3000, closed)])
      assert.equal(h.store.get("SELECT state FROM requests WHERE tool_name = 'mcp__vault__vault_search'").state, 'answered')
      const session = h.store.get("SELECT repo_id FROM sessions WHERE claude_session_id IS NOT NULL")
      const row = h.store.get('SELECT count FROM rule_counters WHERE repo_id = ? AND pattern = ?', session.repo_id, 'mcp__vault__vault_search')
      assert.equal(row?.count ?? 0, counts ? 1 : 0, `opened ${opened}, closed ${closed}`)
    } finally { h.close() }
  }
})

test('recordAllow reads both pids from hook_events rows when no closing pid is passed', () => {
  const hook = { tool_name: 'Bash', tool_input: { command: 'cargo test' } }
  for (const [opened, closed, counts] of [[42, 42, true], [42, 7, false], [null, null, false]]) {
    const h = harness()
    try {
      const { id } = h.request()
      h.store.run('UPDATE requests SET match_key = ?, created_at = 2000 WHERE id = ?', matchKey(hook), id)
      let n = 0
      const row = (event, at, pid) => h.store.run('INSERT INTO hook_events(dedupe_key,session_id,claude_session_id,event,hook_ts,received_at,via,claude_pid,applied,payload) VALUES(?,?,?,?,?,?,?,?,?,?)',
        `k${++n}`, 's1', 'c1', event, at, at, 'socket', pid, 1, JSON.stringify({ hook_event_name: event, ...hook }))
      row('PermissionRequest', 2000, opened)
      row('PostToolUse', 3000, closed)
      const result = h.store.tx(() => recordAllow(h.store, { id }, { via: 'terminal', at: 3000, threshold: 5 }))
      assert.equal(result.counted, counts, `opened ${opened}, closed ${closed}`)
      if (!counts) assert.equal(result.reason, 'process_mismatch')
    } finally { h.close() }
  }
})
