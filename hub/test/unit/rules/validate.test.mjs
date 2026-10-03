import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../../server/db/index.mjs'
import { classify, hooksPathCache } from '../../../server/approvals/tiers.mjs'
import { canonicalPattern, RULE_COPY, samePattern, validatePattern, writeRule } from '../../../server/approvals/rules.mjs'

// Pattern validation for rules (07-approvals 7.3, F13, D-76, D-86).

const DESTRUCTIVE = 'Destructive commands can never become rules.'

test('the refusal copy is the Decided text', () => {
  assert.equal(RULE_COPY.destructive, DESTRUCTIVE)
  assert.equal(RULE_COPY.script, 'Script rules name one script exactly.')
})

// Mutation run for this test: the D-86 script prefix check removed from bashVerdict; this test failed.
test('an npm or pnpm script prefix is invalid_pattern; the exact script rule is accepted', () => {
  for (const pattern of ['Bash(npm run test:*)', 'Bash(npm run test *)', 'Bash(pnpm run lint:*)', 'Bash(npm run:*)', 'Bash(npm run-script test:*)']) {
    assert.deepEqual(validatePattern(pattern), { ok: false, code: 'invalid_pattern', message: 'Script rules name one script exactly.' }, pattern)
  }
  for (const pattern of ['Bash(npm run test)', 'Bash(npm run test:unit)', 'Bash(pnpm run lint)']) {
    const verdict = validatePattern(pattern)
    assert.equal(verdict.ok, true, pattern)
    assert.equal(verdict.warning, null)
  }
})

// Mutation run for this test: the runsPayload check removed from bashVerdict, so only Destructive
// entries refuse a prefix (7.3 read literally); this test failed.
test('every F13 pattern is refused with destructive_rule', () => {
  const refused = [
    'Bash(rm:*)', 'Bash(git push:*)', 'Bash(git:*)', 'Bash(docker compose:*)', 'Bash(terraform:*)', 'Bash', 'Bash(*)',
    'Bash(env:*)', 'Bash(xargs:*)', 'Bash(timeout:*)', 'Bash(uv run:*)', 'Bash(npx:*)', 'Bash(bash:*)', 'Bash(python:*)',
    'Bash(make:*)', 'Bash(sed:*)', 'Bash(just:*)', 'Bash(awk:*)', 'Bash(find:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(git -c:*)',
    'Bash(sudo:*)', 'Bash(nohup:*)', 'Bash(python3.12:*)', 'Bash(node:*)', 'Bash(sh:*)', 'Bash(uv:*)', 'Bash(pnpm exec:*)', 'Bash(npm exec:*)',
    'Bash(docker exec:*)', 'Bash(git branch:*)', 'Bash(git push origin:*)', 'Bash(rm -rf build)', 'Bash(/usr/bin/env:*)',
    'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
    'Read(~/.claude/settings.json)', 'Bash(cat .claude/settings.local.json)', 'Read(~/.config/fleetmates/deck/**)', 'WebFetch(domain:localhost)',
    'mcp__vault__vault_delete', 'mcp__vault'
  ]
  for (const pattern of refused) assert.deepEqual(validatePattern(pattern), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, pattern)
})

test('WebFetch(domain:...) and Bash(cargo test:*) are accepted; WebFetch carries the tool-wide warning', () => {
  const fetch = validatePattern('WebFetch(domain:docs.nestjs.com)')
  assert.deepEqual(fetch, { ok: true, pattern: 'WebFetch(domain:docs.nestjs.com)', tool: 'WebFetch', tier: 'caution', warning: null })
  const cargo = validatePattern('Bash(cargo test:*)')
  assert.equal(cargo.ok, true)
  assert.equal(cargo.warning, null)
  assert.equal(validatePattern('Bash(cargo test *)').ok, true)
  assert.deepEqual(validatePattern('WebFetch'), { ok: true, pattern: 'WebFetch', tool: 'WebFetch', tier: 'caution', warning: 'toolWide' })
  assert.equal(validatePattern('WebSearch').warning, 'toolWide')
  assert.deepEqual(validatePattern('mcp__vault__vault_search'), { ok: true, pattern: 'mcp__vault__vault_search', tool: 'mcp__vault__vault_search', tier: 'safe', warning: null })
  assert.equal(validatePattern('Read(src/**)').ok, true)
  // Caution patterns are accepted by hand, with their tier.
  const caution = validatePattern('Bash(git fetch:*)')
  assert.equal(caution.ok, true)
  assert.equal(caution.tier, 'caution')
})

test('patterns outside the syntax are invalid_pattern', () => {
  for (const pattern of ['', ' Bash(ls)', 'Bash(ls', 'Bash()', 'Bash(git * push)', 'Edit(src/**)', 'WebFetch(https://x.y/)', 'WebFetch(domain:)', 'Read()', 'Frobnicate(x)', 'mcp__', 'not a pattern', 42, null]) {
    const verdict = validatePattern(pattern)
    assert.equal(verdict.ok, false, String(pattern))
    assert.equal(verdict.code, 'invalid_pattern', String(pattern))
  }
})

test('the reader treats Bash(x:*) and Bash(x *) as the same rule', () => {
  assert.equal(canonicalPattern('Bash(cargo test:*)'), 'Bash(cargo test *)')
  assert.equal(samePattern('Bash(cargo test:*)', 'Bash(cargo test *)'), true)
  assert.equal(samePattern('Bash(cargo  test :*)', 'Bash(cargo test *)'), true)
  assert.equal(samePattern('Bash(cargo test)', 'Bash(cargo test *)'), false)
  assert.equal(samePattern('WebFetch', 'WebSearch'), false)
})

function git(cwd, args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  return execFileSync('git', args, { cwd, env, stdio: 'ignore' })
}

test('a suggestion written for npm run test:unit writes exactly Bash(npm run test:unit)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'deck-rules-validate-'))
  const store = openDeckDb(path.join(root, 'state', 'deck.db'))
  try {
    const repo = path.join(root, 'web')
    mkdirSync(repo)
    git(repo, ['init', '-q'])
    const repoId = realpathSync(repo)
    writeFileSync(path.join(repoId, 'package.json'), '{"scripts":{"test:unit":"node --test"}}\n')
    await hooksPathCache.load(repoId, process.env.HOME && path.isAbsolute(process.env.HOME) ? process.env.HOME : homedir())
    const classified = classify({ toolName: 'Bash', toolInput: { command: 'npm run test:unit' }, cwd: repoId, repoRoot: repoId })
    assert.equal(classified.tier, 'safe')
    assert.equal(classified.ruleCandidate, 'Bash(npm run test:unit)')
    assert.equal(validatePattern(classified.ruleCandidate, { repoRoot: repoId }).ok, true)
    store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repoId, 'web', 0, 0, 'web', 1)
    await writeRule(store, { repoId, pattern: classified.ruleCandidate, source: 'suggested', stateDir: path.join(root, 'state'), at: 1, gitRead: async () => null })
    assert.deepEqual(JSON.parse(readFileSync(path.join(repoId, '.claude', 'settings.local.json'), 'utf8')), { permissions: { allow: ['Bash(npm run test:unit)'] } })
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
