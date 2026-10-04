import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../../server/db/index.mjs'
import { BACKUPS_KEPT, backupDir, listRules, revokeRule, writeRule } from '../../../server/approvals/rules.mjs'

// The settings writer, revoker and mirror (07-approvals 7.2, 7.4 and 9).

const fixtures = new URL('../../fixtures/settings/', import.meta.url)
const fixture = name => readFileSync(new URL(name, fixtures))

function harness(name) {
  const root = mkdtempSync(path.join(tmpdir(), 'deck-rules-write-'))
  const repo = path.join(root, 'rustot')
  mkdirSync(repo)
  const repoId = realpathSync(repo)
  const state = path.join(root, 'state')
  const store = openDeckDb(path.join(state, 'deck.db'))
  store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repoId, 'rustot', 0, 0, 'rustot', 1)
  const file = path.join(repoId, '.claude', 'settings.local.json')
  if (name) {
    mkdirSync(path.dirname(file))
    writeFileSync(file, fixture(name))
  }
  const git = []
  const gitRead = async (cwd, args) => { git.push([cwd, args]); return { code: 1, stdout: Buffer.alloc(0) } }
  const write = (pattern, options = {}) => writeRule(store, { repoId, pattern, source: 'manual', stateDir: state, at: 1_790_000_000_000, gitRead, ...options })
  const revoke = (pattern, options = {}) => revokeRule(store, { repoId, pattern, stateDir: state, at: 1_790_000_100_000, ...options })
  const events = type => store.all('SELECT data FROM events WHERE type = ? ORDER BY seq', type).map(row => JSON.parse(row.data))
  const audit = () => store.all('SELECT pattern, action, actor FROM rule_audit ORDER BY id').map(row => ({ ...row }))
  return { root, repo, repoId, state, store, file, git, write, revoke, events, audit, close() { store.close(); rmSync(root, { recursive: true, force: true }) } }
}

const read = file => JSON.parse(readFileSync(file, 'utf8'))
const rejects = async (promise, code, errno) => {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code)
    if (errno) assert.match(String(error.details?.errno), errno)
    return true
  })
}

// Mutation run for this test: rewrite() rebuilt `permissions` with its keys sorted before writing;
// this test failed.
test('write then revoke leaves every other key byte-identical and the key and array order unchanged', async () => {
  for (const name of [null, 'local-empty.json', 'local-full.json']) {
    const h = harness(name)
    try {
      const before = name ? read(h.file) : {}
      const result = await h.write('Bash(cargo test:*)')
      const after = read(h.file)
      assert.deepEqual(Object.keys(after), Object.keys(before).includes('permissions') ? Object.keys(before) : [...Object.keys(before), 'permissions'], String(name))
      assert.deepEqual(Object.keys(after.permissions), before.permissions ? Object.keys(before.permissions) : ['allow'])
      assert.deepEqual(after.permissions.allow, [...(before.permissions?.allow ?? []), 'Bash(cargo test:*)'])
      for (const key of Object.keys(before)) if (key !== 'permissions') assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]))
      for (const key of Object.keys(before.permissions ?? {})) if (key !== 'allow') assert.equal(JSON.stringify(after.permissions[key]), JSON.stringify(before.permissions[key]))
      assert.ok(readFileSync(h.file, 'utf8').endsWith('}\n'))
      assert.equal(result.rule.pattern, 'Bash(cargo test:*)')
      assert.equal(result.rule.source, 'manual')
      assert.equal(result.rule.createdAt, 1_790_000_000_000)
      assert.equal(result.rule.tracked, false)
      assert.deepEqual(await h.revoke('Bash(cargo test:*)'), { removed: true })
      const revoked = read(h.file)
      assert.deepEqual(Object.keys(revoked), Object.keys(after))
      assert.deepEqual(Object.keys(revoked.permissions), Object.keys(after.permissions))
      assert.deepEqual(revoked.permissions.allow, before.permissions?.allow ?? [])
      for (const key of Object.keys(before)) if (key !== 'permissions') assert.equal(JSON.stringify(revoked[key]), JSON.stringify(before[key]))
      if (name === 'local-full.json') assert.deepEqual(readFileSync(h.file), fixture(name))
    } finally { h.close() }
  }
})

test('a new settings file is created 0600 and a write keeps the mode of an existing one', async () => {
  const h = harness(null)
  try {
    await h.write('Bash(cargo test:*)')
    assert.equal(statSync(h.file).mode & 0o777, 0o600)
  } finally { h.close() }
  const g = harness('local-full.json')
  try {
    const { chmodSync } = await import('node:fs')
    chmodSync(g.file, 0o640)
    await g.write('Bash(cargo test:*)')
    assert.equal(statSync(g.file).mode & 0o777, 0o640)
  } finally { g.close() }
})

test('a wrong-typed or unreadable settings file is refused and nothing is written', async () => {
  for (const [name, errno] of [['local-wrong-types.json', /permissions is not an object/], ['local-invalid.json', /not valid JSON/]]) {
    const h = harness(name)
    try {
      await rejects(h.write('Bash(cargo test:*)'), 'settings_io_failed', errno)
      assert.deepEqual(readFileSync(h.file), fixture(name))
      assert.deepEqual(readdirSync(path.dirname(h.file)), ['settings.local.json'])
      assert.equal(existsSync(path.join(h.state, 'backups')), false)
      assert.equal(h.store.get('SELECT COUNT(*) AS n FROM rules').n, 0)
      await rejects(Promise.resolve().then(() => h.revoke('Bash(cargo check:*)')), 'settings_io_failed', errno)
      assert.deepEqual(readFileSync(h.file), fixture(name))
    } finally { h.close() }
  }
  const h = harness(null)
  try {
    mkdirSync(path.dirname(h.file))
    writeFileSync(h.file, '[]\n')
    await rejects(h.write('Bash(cargo test:*)'), 'settings_io_failed', /top level is not an object/)
    writeFileSync(h.file, '{"permissions":{"allow":"Bash(ls)"}}\n')
    await rejects(h.write('Bash(cargo test:*)'), 'settings_io_failed', /permissions.allow is not an array/)
    assert.equal(readFileSync(h.file, 'utf8'), '{"permissions":{"allow":"Bash(ls)"}}\n')
  } finally { h.close() }
})

// Mutation runs for this test: the `.claude` lstat check removed, and separately the target lstat
// check removed, in readSettings; this test failed for each.
test('a symlinked settings file and a symlinked .claude are refused and the target is untouched', async () => {
  const h = harness(null)
  try {
    const outside = path.join(h.root, 'outside')
    mkdirSync(outside)
    const target = path.join(outside, 'settings.json')
    writeFileSync(target, '{"keep":true}\n')
    mkdirSync(path.dirname(h.file))
    symlinkSync(target, h.file)
    await rejects(h.write('Bash(cargo test:*)'), 'settings_io_failed', /not a regular file/)
    assert.equal(readFileSync(target, 'utf8'), '{"keep":true}\n')
    assert.ok(lstatSync(h.file).isSymbolicLink())
    rmSync(path.dirname(h.file), { recursive: true })
    writeFileSync(path.join(outside, 'settings.local.json'), '{"keep":true}\n')
    symlinkSync(outside, path.dirname(h.file))
    await rejects(h.write('Bash(cargo test:*)'), 'settings_io_failed', /not a regular file/)
    assert.equal(readFileSync(path.join(outside, 'settings.local.json'), 'utf8'), '{"keep":true}\n')
    assert.deepEqual(readdirSync(outside).sort(), ['settings.json', 'settings.local.json'])
  } finally { h.close() }
})

// Mutation run for this test: WRITE_ATTEMPTS set to 1 (one attempt only); this test failed.
test('a change between read and rename restarts the write; a change on every attempt gives settings_changed', async () => {
  const h = harness('local-full.json')
  try {
    let calls = 0
    const result = await h.write('Bash(cargo test:*)', {
      beforeRename: () => {
        if (++calls > 1) return
        const data = read(h.file)
        data.permissions.allow.push('Bash(go test:*)')
        writeFileSync(h.file, `${JSON.stringify(data, null, 2)}\n`)
      }
    })
    assert.equal(calls, 2)
    assert.equal(result.rule.pattern, 'Bash(cargo test:*)')
    assert.deepEqual(read(h.file).permissions.allow, ['Bash(cargo check:*)', 'WebFetch(domain:docs.rs)', 'Bash(go test:*)', 'Bash(cargo test:*)'])
    assert.equal(readdirSync(path.dirname(h.file)).some(entry => entry.includes('deck-tmp')), false)
  } finally { h.close() }
  const g = harness('local-full.json')
  try {
    let calls = 0
    await rejects(g.write('Bash(cargo test:*)', { beforeRename: () => { calls++; writeFileSync(g.file, `${JSON.stringify({ ...read(g.file), touched: calls }, null, 2)}\n`) } }), 'settings_changed')
    assert.equal(calls, 3)
    const data = read(g.file)
    assert.equal(data.touched, 3)
    assert.equal(data.permissions.allow.includes('Bash(cargo test:*)'), false)
    assert.equal(readdirSync(path.dirname(g.file)).some(entry => entry.includes('deck-tmp')), false)
    assert.equal(g.store.get('SELECT COUNT(*) AS n FROM rules').n, 0)
  } finally { g.close() }
})

// Mutation run for this test: the backup moved back after the re-read compare in rewrite(); this test
// failed.
test('the backup is taken before the re-read compare, and a change landing after it restarts the write', async () => {
  const h = harness('local-full.json')
  try {
    const dir = backupDir(h.state, h.repoId)
    const seen = []
    let calls = 0
    const result = await h.write('Bash(cargo test:*)', {
      beforeRename: () => {
        seen.push(existsSync(dir) ? readdirSync(dir).length : 0)
        if (++calls > 1) return
        const data = read(h.file)
        data.permissions.allow.push('Bash(go test:*)')
        writeFileSync(h.file, `${JSON.stringify(data, null, 2)}\n`)
      }
    })
    // Each attempt had its backup on disk when the concurrent writer ran; the stale one is dropped.
    assert.deepEqual(seen, [1, 1])
    assert.deepEqual(read(h.file).permissions.allow, ['Bash(cargo check:*)', 'WebFetch(domain:docs.rs)', 'Bash(go test:*)', 'Bash(cargo test:*)'])
    assert.equal(readdirSync(dir).length, 1)
    assert.ok(readFileSync(result.backupPath, 'utf8').includes('Bash(go test:*)'))
  } finally { h.close() }
})

// Mutation run for this test: the uid comparison removed from readSettings; this test failed.
test('a settings file owned by another user is refused and left unchanged', async () => {
  const h = harness('local-full.json')
  const getuid = process.getuid
  try {
    process.getuid = () => getuid.call(process) + 1
    await rejects(h.write('Bash(cargo test:*)'), 'settings_io_failed', /^not a regular file$/)
    await rejects(Promise.resolve().then(() => h.revoke('Bash(cargo check:*)')), 'settings_io_failed', /^not a regular file$/)
    process.getuid = getuid
    assert.deepEqual(readFileSync(h.file), fixture('local-full.json'))
    assert.equal(existsSync(path.join(h.state, 'backups')), false)
  } finally { process.getuid = getuid; h.close() }
})

// Mutation run for this test: the BACKUPS_KEPT pruning removed from backup(); this test failed.
test('a backup of the previous bytes appears (0600) and the 21st write keeps 20', async () => {
  const h = harness('local-full.json')
  try {
    const first = await h.write('Bash(cargo test:*)')
    const dir = backupDir(h.state, h.repoId)
    assert.equal(path.dirname(first.backupPath), dir)
    assert.match(path.basename(first.backupPath), /^\d{8}-\d{6}\.json$/)
    assert.deepEqual(readFileSync(first.backupPath), fixture('local-full.json'))
    assert.equal(statSync(first.backupPath).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.match(first.beforeSha256, /^[0-9a-f]{64}$/)
    for (let i = 2; i <= 21; i++) await h.write(`Bash(echo rule-${i})`)
    const kept = readdirSync(dir)
    assert.equal(kept.length, BACKUPS_KEPT)
    assert.equal(kept.some(entry => readFileSync(path.join(dir, entry)).equals(fixture('local-full.json'))), false, 'the oldest backup is the one dropped')
    assert.equal(read(h.file).permissions.allow.length, 23)
  } finally { h.close() }
  const g = harness(null)
  try {
    assert.equal((await g.write('Bash(cargo test:*)')).backupPath, null)
  } finally { g.close() }
})

test('an equivalent Bash(x *) is not added twice', async () => {
  const h = harness(null)
  try {
    mkdirSync(path.dirname(h.file))
    writeFileSync(h.file, `${JSON.stringify({ permissions: { allow: ['Bash(cargo test *)'] } }, null, 2)}\n`)
    const bytes = readFileSync(h.file)
    await rejects(h.write('Bash(cargo test:*)'), 'rule_exists')
    await rejects(h.write('Bash(cargo  test *)'), 'rule_exists')
    assert.deepEqual(readFileSync(h.file), bytes)
    // Revoke removes the exact string found in the file, in either form.
    assert.deepEqual(await h.revoke('Bash(cargo test:*)'), { removed: true })
    assert.deepEqual(read(h.file).permissions.allow, [])
  } finally { h.close() }
})

test('revoke reports already_removed, resets the counter and audits revoked or undo', async () => {
  const h = harness('local-full.json')
  try {
    h.store.run("INSERT INTO rule_counters(repo_id,pattern,count,state,updated_at) VALUES(?,'Bash(cargo test:*)',5,'offered',1)", h.repoId)
    const written = await writeRule(h.store, { repoId: h.repoId, pattern: 'Bash(cargo test:*)', source: 'suggested', stateDir: h.state, at: 5, gitRead: async () => ({ code: 0, stdout: Buffer.alloc(0) }) })
    assert.equal(written.rule.source, 'suggested')
    assert.equal(written.rule.approvalsBefore, 5)
    assert.equal(written.rule.tracked, true)
    assert.equal(h.store.get('SELECT state FROM rule_counters WHERE repo_id = ?', h.repoId).state, 'accepted')
    assert.deepEqual(h.events('rule.withdrawn'), [{ repoId: h.repoId, pattern: 'Bash(cargo test:*)' }])
    assert.deepEqual(await h.revoke('Bash(cargo test:*)', { undo: true }), { removed: true })
    assert.deepEqual({ ...h.store.get('SELECT count, state FROM rule_counters WHERE repo_id = ?', h.repoId) }, { count: 0, state: 'counting' })
    assert.equal(h.store.get('SELECT COUNT(*) AS n FROM rules WHERE pattern = ?', 'Bash(cargo test:*)').n, 0)
    assert.deepEqual(await h.revoke('Bash(cargo test:*)'), { removed: false, reason: 'already_removed' })
    assert.deepEqual(h.audit(), [
      { pattern: 'Bash(cargo test:*)', action: 'added', actor: 'suggestion' },
      { pattern: 'Bash(cargo test:*)', action: 'undo', actor: 'manual' }
    ])
    assert.deepEqual(h.events('rule.removed'), [{ repoId: h.repoId, pattern: 'Bash(cargo test:*)' }])
    await h.write('Bash(go test:*)')
    await h.revoke('Bash(go test:*)')
    assert.deepEqual(h.audit().at(-1), { pattern: 'Bash(go test:*)', action: 'revoked', actor: 'manual' })
  } finally { h.close() }
})

// Mutation run for this test: the validatePattern call removed from writeRule; this test failed.
test('writeRule validates the pattern itself and writes nothing for a refused one', async () => {
  const h = harness('local-full.json')
  try {
    for (const [pattern, code] of [['Bash(rm:*)', 'destructive_rule'], ['Bash(bash:*)', 'destructive_rule'], ['Bash(npm run test:*)', 'invalid_pattern'], ['Edit', 'destructive_rule'], ['not a rule', 'invalid_pattern']]) {
      await rejects(h.write(pattern), code)
    }
    assert.deepEqual(readFileSync(h.file), fixture('local-full.json'))
    assert.equal(existsSync(path.join(h.state, 'backups')), false)
    assert.equal(h.store.get('SELECT COUNT(*) AS n FROM rules').n, 0)
  } finally { h.close() }
})

test('tracked asks git ls-files --error-unmatch for the settings file', async () => {
  const h = harness(null)
  try {
    await h.write('Bash(cargo test:*)')
    assert.deepEqual(h.git, [[h.repoId, ['ls-files', '--error-unmatch', '.claude/settings.local.json']]])
  } finally { h.close() }
})

// Mutation run for this test: listRules inserted found rules as source 'suggested' with the read time
// as created_at; this test failed.
test('a rule added to the file by hand shows as manual with null createdAt; a vanished rule is removed', async () => {
  const h = harness('local-full.json')
  try {
    await h.write('Bash(cargo test:*)')
    const data = read(h.file)
    data.permissions.allow.push('Bash(git push:*)')
    writeFileSync(h.file, `${JSON.stringify(data, null, 2)}\n`)
    const listed = listRules(h.store, h.repoId, { at: 9000 })
    assert.equal(listed.settingsPath, h.file)
    const by = Object.fromEntries(listed.rules.map(rule => [rule.pattern, rule]))
    assert.deepEqual(Object.keys(by), ['Bash(cargo check:*)', 'WebFetch(domain:docs.rs)', 'Bash(cargo test:*)', 'Bash(git push:*)'])
    for (const pattern of ['Bash(cargo check:*)', 'WebFetch(domain:docs.rs)', 'Bash(git push:*)']) {
      assert.equal(by[pattern].source, 'manual')
      assert.equal(by[pattern].createdAt, null)
      assert.equal(by[pattern].approvalsBefore, null)
    }
    assert.equal(by['Bash(cargo test:*)'].createdAt, 1_790_000_000_000)
    assert.equal(by['Bash(git push:*)'].destructive, true)
    assert.equal(by['Bash(cargo check:*)'].destructive, false)
    assert.deepEqual(h.audit().filter(row => row.action === 'found').map(row => row.pattern), ['Bash(cargo check:*)', 'WebFetch(domain:docs.rs)', 'Bash(git push:*)'])
    assert.equal(h.events('rule.upserted').length, 4)
    // A second read finds nothing new.
    listRules(h.store, h.repoId, { at: 9100 })
    assert.equal(h.audit().filter(row => row.action === 'found').length, 3)
    data.permissions.allow = data.permissions.allow.filter(item => item !== 'WebFetch(domain:docs.rs)')
    writeFileSync(h.file, `${JSON.stringify(data, null, 2)}\n`)
    const again = listRules(h.store, h.repoId, { at: 9200 })
    assert.equal(again.rules.some(rule => rule.pattern === 'WebFetch(domain:docs.rs)'), false)
    assert.deepEqual(h.audit().at(-1), { pattern: 'WebFetch(domain:docs.rs)', action: 'vanished', actor: 'external' })
    assert.deepEqual(h.events('rule.removed'), [{ repoId: h.repoId, pattern: 'WebFetch(domain:docs.rs)' }])
    writeFileSync(h.file, '{ broken')
    const broken = listRules(h.store, h.repoId, { at: 9300 })
    assert.match(broken.readError.message, /not valid JSON/)
    assert.equal(broken.rules.length, 3)
  } finally { h.close() }
})
