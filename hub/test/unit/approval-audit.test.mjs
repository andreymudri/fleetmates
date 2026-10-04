// The approvals audit (docs/deck/07-approvals.md 11): each kind `record` writes, the 08-security 4.10
// redaction of `summary`, and retention of request rows (30 days) against rule rows (kept).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDeckDb } from '../../server/db/index.mjs'
import { runRetention } from '../../server/db/retention.mjs'
import { AUDIT_KINDS, record, redact } from '../../server/approvals/audit.mjs'
import { DEFAULT_TIERS, tiersSha256 } from '../../server/approvals/tiers.mjs'

const DAY = 24 * 60 * 60 * 1000

function withStore(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-audit-'))
  const store = openDeckDb(path.join(dir, 'deck.db'))
  try { return fn(store) } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('redact hides the 08-security 4.10 secret shapes and keeps ordinary text', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz'
  const cases = [
    ['git clone https://you:hunter2@example.com/r.git', 'git clone https://***@example.com/r.git'],
    ['curl -H "Authorization: Bearer abc.def-123" x', 'curl -H "Authorization: Bearer ***" x'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNz" x', 'curl -H "Authorization: Basic ***" x'],
    ['DB_PASSWORD=hunter2 npm run test', 'DB_PASSWORD=*** npm run test'],
    ['export API_KEY: "s3cr3t value"', 'export API_KEY: ***'],
    ['echo token=abc123 && ls', 'echo token=*** && ls'],
    [`gh auth ghp_${'a1'.repeat(18)}`, 'gh auth ***'],
    [`x github_pat_${'B2'.repeat(20)}`, 'x ***'],
    [`x sk-ant-${'c3'.repeat(20)}`, 'x ***'],
    [`x sk-${'d4'.repeat(12)}`, 'x ***'],
    [`x xoxb-${'1234-'.repeat(4)}abc`, 'x ***'],
    ['x AKIAABCDEFGHIJKLMNOP y', 'x *** y'],
    [`x hf_${'e5'.repeat(12)}`, 'x ***'],
    [`curl -d ${jwt}`, 'curl -d ***'],
    [`echo ${'f0'.repeat(25)}`, 'echo ***'],
    ['cat /home/you/projects/fleetmates/hub/server/approvals/deliver.mjs', 'cat /home/you/projects/fleetmates/hub/server/approvals/deliver.mjs'],
    ['npm run test', 'npm run test']
  ]
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input)
  assert.equal(redact(null), null)
})

test('record writes each kind with the redacted summary, entry ids, tiers sha and the Destructive confirm label', () => withStore(store => {
  for (const kind of AUDIT_KINDS) {
    record(store, { kind, at: 1000, requestId: `r-${kind}`, sessionId: 's1', repoId: '/home/you/repo', tier: 'destructive',
      reasons: [{ entryId: 'destructive.shell.rm', tier: 'destructive' }, 'floor.m1'], via: 'browser', choice: 'allow', code: 'confirm_required',
      optionLabel: 'Yes', confirmLabel: 'I checked what this command will change', summary: 'rm -rf build && curl https://you:pw@example.com' })
  }
  const rows = store.all('SELECT * FROM approval_audit ORDER BY id')
  assert.deepEqual(rows.map(row => row.kind), [...AUDIT_KINDS])
  for (const row of rows) {
    assert.equal(row.summary, 'rm -rf build && curl https://***@example.com', row.kind)
    assert.deepEqual(JSON.parse(row.reasons), ['destructive.shell.rm', 'floor.m1'])
    assert.equal(row.confirm_label, 'I checked what this command will change')
    assert.equal(row.tiers_sha256, tiersSha256(DEFAULT_TIERS))
    assert.equal(row.choice, row.kind === 'refused' ? 'confirm_required' : 'allow')
  }
  assert.throws(() => record(store, { kind: 'rule_added' }), /unknown audit kind/)
  assert.throws(() => record(store, { kind: 'answered', via: 'keyboard' }), /unknown audit via/)
}))

test('retention drops request audit rows older than 30 days and keeps rule and tiers rows', () => withStore(store => {
  const now = 100 * DAY
  const old = now - 31 * DAY
  const recent = now - DAY
  for (const kind of ['answered', 'refused', 'did_not_land', 'expired']) {
    record(store, { kind, at: old, requestId: `old-${kind}`, summary: 'npm run test' })
    record(store, { kind, at: recent, requestId: `new-${kind}`, summary: 'npm run test' })
  }
  record(store, { kind: 'tiers_loaded', at: old })
  record(store, { kind: 'tiers_rejected', at: old })
  for (const kind of ['rule_added', 'rule_revoked', 'rule_found']) store.run('INSERT INTO approval_audit(at, kind) VALUES(?, ?)', old, kind)
  runRetention(store, { now })
  const left = store.all('SELECT kind, request_id FROM approval_audit ORDER BY id')
  assert.deepEqual(left.filter(row => row.request_id).map(row => row.request_id), ['new-answered', 'new-refused', 'new-did_not_land', 'new-expired'])
  assert.deepEqual(left.filter(row => !row.request_id).map(row => row.kind), ['tiers_loaded', 'tiers_rejected', 'rule_added', 'rule_revoked', 'rule_found'])
}))
