import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../../server/db/index.mjs'
import { classify, DEFAULT_TIERS, hooksPathCache } from '../../../server/approvals/tiers.mjs'
import { setupPaths } from '../../../server/setup/paths.mjs'
import { canonicalPattern, FLOOR_PROBE_EXEMPT, floorProbes, listRules, probeReaches, PERSISTENCE_DIRS, PERSISTENCE_FILES, RULE_COPY, samePattern, validatePattern, writeRule } from '../../../server/approvals/rules.mjs'

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

// Mutation run for this test: the D-101 tiers-rule check removed from bashVerdict, so only Destructive
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
  // Caution patterns are accepted by hand, with their tier (an exact rule: D-101 refuses other prefixes).
  const caution = validatePattern('Bash(git fetch origin)')
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

// Fix round 1 (phase 5 reviews). A home and a repo of their own, so the deck controls are known paths.
function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'deck-rules-floors-'))
  const home = path.join(root, 'home')
  const repo = path.join(home, 'dev', 'rustot')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q'])
  const repoRoot = realpathSync(repo)
  const homeDir = realpathSync(home)
  const options = { repoRoot, homeDir, env: { HOME: homeDir } }
  return { root, homeDir, repoRoot, options, settle: () => hooksPathCache.load(repoRoot, homeDir), close: () => rmSync(root, { recursive: true, force: true }) }
}

// Mutation run for this test: the protected-root check removed from pathVerdict (only the text match
// kept, as before this fix); this test failed.
test('a Read or file-tool glob whose root is, holds or lies inside a deck control or protected path is refused', async () => {
  const s = sandbox()
  try {
    await s.settle()
    const home = s.homeDir
    for (const pattern of ['Read(~/**)', 'Read(~/.local/state/**)', `Read(/${home}/.local/**)`, 'Read(/**)', 'Edit(~/.config/**)',
      'Read(~/.local/state/fleetmates/deck/token)', 'Read(.git/**)', 'Read(**)', 'Read(.claude/settings.json)', 'Read(~/.claude/**)',
      'Read(~/.bashrc)', 'Write(~/.config/hypr/**)', 'Read(../**)', 'Read(~)', `Read(/${s.repoRoot}/.git/config)`, 'Read(sub/.git/**)', 'Read(/.claude/settings.local.json)']) {
      assert.deepEqual(validatePattern(pattern, s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, pattern)
    }
    const src = validatePattern('Read(src/**)', s.options)
    assert.equal(src.ok, true)
    assert.equal(validatePattern('Read(~/notes/**)', s.options).ok, true)
    // A file-tool rule that reaches nothing protected stays outside the accepted syntax.
    assert.equal(validatePattern('Edit(src/**)', s.options).code, 'invalid_pattern')
  } finally { s.close() }
})

// Mutation run for this test: the floor probes removed from bashVerdict; this test failed.
test('a Bash prefix whose arguments can reach a Destructive floor is refused; npm test stays accepted', async () => {
  const s = sandbox()
  try {
    await s.settle()
    for (const pattern of ['Bash(git config:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(tee:*)', 'Bash(git config --global:*)', 'Bash(cp -r:*)']) {
      assert.deepEqual(validatePattern(pattern, s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, pattern)
    }
    for (const pattern of ['Bash(npm test:*)', 'Bash(cargo test:*)', 'Bash(go vet:*)', 'Bash(mypy:*)']) assert.equal(validatePattern(pattern, s.options).ok, true, pattern)
  } finally { s.close() }
})

// Every Destructive floor tiers.mjs can emit has a probe, or a stated reason why none is needed, so a
// new floor fails here until it is covered. Comments are stripped before the ids are read.
test('the floor probes cover every Destructive floor of tiers.mjs and each probe reaches its floor', async () => {
  const source = readFileSync(new URL('../../../server/approvals/tiers.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const floors = [...new Set([...source.matchAll(/reason\('(floor\.[a-z0-9-]+)', 'destructive'/g)].map(match => match[1]))].sort()
  assert.ok(floors.length >= 9, floors.join(','))
  const s = sandbox()
  try {
    await s.settle()
    const probes = floorProbes(s.options)
    for (const floor of floors) assert.ok(probes.some(probe => probe.floor === floor) || Object.hasOwn(FLOOR_PROBE_EXEMPT, floor), `no probe for ${floor}`)
    const paths = setupPaths(s.options.env)
    const deckPaths = { config: paths.config, state: paths.state, runtime: paths.runtime, token: paths.token, port: 47800 }
    const run = command => classify({ toolName: 'Bash', toolInput: { command }, cwd: s.repoRoot, repoRoot: s.repoRoot, homeDir: s.homeDir, deckPaths })
    for (const probe of probes) {
      // The carrier reaches the probe's floor, and the argument text alone (`true <args>`) does not.
      const result = run(`${probe.carrier} ${probe.args}`)
      const baseline = run(`true ${probe.args}`)
      assert.ok(result.reasons.some(item => item.entryId === probe.floor && item.tier === 'destructive'), `${probe.carrier} ${probe.args} -> ${result.reasons.map(item => item.entryId)}`)
      assert.equal(probeReaches(run, probe.carrier, probe.args), true, `${probe.carrier} ${probe.args} vs ${baseline.reasons.map(item => item.entryId)}`)
    }
  } finally { s.close() }
})

test('the persistence lists match the floor lists in tiers.mjs', () => {
  const source = readFileSync(new URL('../../../server/approvals/tiers.mjs', import.meta.url), 'utf8')
  const list = name => JSON.parse(new RegExp(`const ${name} = Object\\.freeze\\((\\[[^\\]]*\\])\\)`).exec(source)[1].replace(/'/g, '"'))
  assert.deepEqual([...PERSISTENCE_FILES], list('PERSISTENCE_FILES'))
  assert.deepEqual([...PERSISTENCE_DIRS], list('PERSISTENCE_DIRS'))
})

// Mutation runs for this test: `own` forced to false in bashVerdict, and separately the word list
// applied to Safe entry rules again; this test failed for each.
test('every Safe tiers rule validates ok with tier safe and lists with destructive false', async () => {
  const s = sandbox()
  const store = openDeckDb(path.join(s.root, 'state', 'deck.db'))
  try {
    await s.settle()
    // D-98: no exceptions; the path-operand writers (ruff check, terraform fmt) carry no rule.
    const rules = DEFAULT_TIERS.entries.filter(entry => entry.tier === 'safe' && typeof entry.rule === 'string' && !entry.rule.includes('{'))
    assert.ok(rules.some(entry => entry.rule === 'Bash(node --test:*)'))
    assert.ok(rules.some(entry => entry.rule === 'Bash(python -m pytest:*)'))
    for (const { rule } of rules) {
      const verdict = validatePattern(rule, s.options)
      assert.deepEqual({ ok: verdict.ok, tier: verdict.tier, warning: verdict.warning }, { ok: true, tier: 'safe', warning: null }, rule)
    }
    store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', s.repoRoot, 'rustot', 0, 0, 'rustot', 1)
    mkdirSync(path.join(s.repoRoot, '.claude'))
    writeFileSync(path.join(s.repoRoot, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: rules.map(entry => entry.rule) } }))
    const listed = listRules(store, s.repoRoot, { at: 1 })
    assert.equal(listed.rules.length, rules.length)
    for (const rule of listed.rules) assert.equal(rule.destructive, false, rule.pattern)
  } finally { store.close(); s.close() }
})

// Mutation runs for this test: the `rule` field restored on safe.python.ruff-check, and separately on
// safe.terraform.fmt, in tiers.default.json; this test failed for each.
test('D-98: classify suggests no rule for ruff check or terraform fmt', async () => {
  const s = sandbox()
  try {
    await s.settle()
    mkdirSync(path.join(s.repoRoot, 'src'))
    // Bare `terraform fmt` rewrites files, so it is Caution (D-90) and has no candidate either way;
    // `-check` is its Safe form, the one a restored `rule` would show up on.
    for (const command of ['ruff check src', 'terraform fmt -check']) {
      const result = classify({ toolName: 'Bash', toolInput: { command }, cwd: s.repoRoot, repoRoot: s.repoRoot, homeDir: s.homeDir })
      assert.equal(result.tier, 'safe', command)
      assert.equal(result.ruleCandidate, null, command)
      assert.equal(result.ruleNote, null, command)
    }
  } finally { s.close() }
})

// Mutation run for this test: the npm and pnpm option scan reverted to looking at words[1] only; this
// test failed.
test('an npm or pnpm prefix with options before run, or a pnpm prefix naming a script, is refused', () => {
  for (const pattern of ['Bash(npm -s run test:*)', 'Bash(pnpm --silent run test:*)', 'Bash(npm --prefix . run build:*)', 'Bash(pnpm -C . run build:*)', 'Bash(pnpm build:*)', 'Bash(pnpm test:*)', 'Bash(npm rum test:*)', 'Bash(pnpm -s:*)']) {
    assert.deepEqual(validatePattern(pattern), { ok: false, code: 'invalid_pattern', message: 'Script rules name one script exactly.' }, pattern)
  }
  assert.equal(validatePattern('Bash(npm run test)').ok, true)
  assert.equal(validatePattern('Bash(npm -s run test)').ok, true)
  assert.equal(validatePattern('Bash(npm test:*)').ok, true)
  // D-101: a prefix that is not a tiers rule is refused, so `pnpm ls:*` no longer passes.
  assert.equal(validatePattern('Bash(pnpm ls:*)').code, 'destructive_rule')
})

// Fix round 2 (phase 5 round 1 reviews).

// Mutation run for this test: the D-101 refusal of a prefix that is not a tiers rule removed from
// bashVerdict, so any prefix the other checks pass was accepted again; this test failed.
test('D-101: a Bash prefix rule is accepted only as the rule of a Safe tiers entry', async () => {
  const s = sandbox()
  const store = openDeckDb(path.join(s.root, 'state', 'deck.db'))
  try {
    await s.settle()
    const refused = ['sort', 'git log', 'git show', 'git grep', 'go env', 'yq', 'git status', 'ls', 'cat', 'head', 'grep', 'tail', 'wc -l', 'git log --oneline',
      'flock', 'watch', 'watch -n1', 'script', 'script -qc', 'runuser', 'chroot', 'FOO=1 bash', '"bash"', "'bash'", '\\bash', 'b""ash',
      'ls && bash', 'ls | bash', 'ls; bash', 'uvx', 'pipx run', 'tmux', 'screen', 'git submodule', 'git submodule foreach', 'git rebase', 'git bisect',
      'git bisect run', 'git fetch', 'git clone', 'git -C /tmp push', 'ls ../..', 'git --git-dir=x status', 'ls $HOME', 'ls ~', 'ls `id`']
    for (const prefix of refused) {
      for (const pattern of [`Bash(${prefix}:*)`, `Bash(${prefix} *)`]) assert.deepEqual(validatePattern(pattern, s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, pattern)
    }
    // Exact rules keep their checks: accepted at their tier with no warning, or refused when Destructive.
    for (const pattern of ['Bash(cat README.md)', 'Bash(git fetch origin)']) assert.deepEqual([validatePattern(pattern, s.options).ok, validatePattern(pattern, s.options).warning], [true, null], pattern)
    assert.deepEqual(validatePattern('Bash(rm -rf x)', s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE })
    // A hand-added prefix rule found in the file shows as Destructive; an exact one does not.
    store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', s.repoRoot, 'rustot', 0, 0, 'rustot', 1)
    mkdirSync(path.join(s.repoRoot, '.claude'))
    writeFileSync(path.join(s.repoRoot, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(cat:*)', 'Bash(cat README.md)'] } }))
    const listed = listRules(store, s.repoRoot, { at: 1 })
    assert.deepEqual(listed.rules.map(rule => [rule.pattern, rule.destructive, rule.warning]), [['Bash(cat:*)', true, null], ['Bash(cat README.md)', false, null]])
  } finally { store.close(); s.close() }
})

// Mutation run for this test: bashVerdict returned ok as soon as `own` held, skipping
// reachesDestructive, classify and the floor probes; this test failed.
test('a Safe tiers entry whose rule reaches a Destructive entry or floor is still refused', async () => {
  const s = sandbox()
  try {
    await s.settle()
    const tiers = { entries: [...DEFAULT_TIERS.entries, { id: 'safe.test.git', tier: 'safe', tool: 'Bash', cmd: 'git', rule: 'Bash(git:*)' }, { id: 'safe.test.cp', tier: 'safe', tool: 'Bash', cmd: 'cp', rule: 'Bash(cp:*)' }] }
    for (const pattern of ['Bash(git:*)', 'Bash(cp:*)']) assert.equal(validatePattern(pattern, { ...s.options, tiers }).code, 'destructive_rule', pattern)
  } finally { s.close() }
})

// Mutation runs for this test: related() returned inside(down) only, and separately pathVerdict
// dropped `...roots.map(realExisting)`; this test failed for each.
test('a glob root inside a protected path, or reaching one through a symlink, is refused', async () => {
  const s = sandbox()
  try {
    await s.settle()
    mkdirSync(path.join(s.homeDir, '.claude'))
    const { symlinkSync } = await import('node:fs')
    symlinkSync(path.join(s.homeDir, '.claude'), path.join(s.repoRoot, 'cl'))
    for (const pattern of ['Read(~/.claude/.credentials.json)', 'Read(~/.claude/projects/**)', 'Read(~/.config/systemd/user/x.service)', 'Read(cl/**)']) {
      assert.deepEqual(validatePattern(pattern, s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, pattern)
    }
  } finally { s.close() }
})

// Mutation run for this test: globRoots kept only path.resolve('/', rest) for a `/p` glob; this test failed.
test('a /p glob is read as absolute, repo-relative and .claude-relative', async () => {
  const s = sandbox()
  try {
    await s.settle()
    assert.deepEqual(validatePattern('Read(/hooks/**)', s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE })
  } finally { s.close() }
})

// Mutation runs for this test: the `/^127\./` test removed, and separately the `..` host check
// removed, from the WebFetch branch; this test failed for each.
test('WebFetch refuses any 127.x host and a host with an empty label', () => {
  assert.deepEqual(validatePattern('WebFetch(domain:127.0.0.2)'), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE })
  assert.equal(validatePattern('WebFetch(domain:docs..rs)').code, 'invalid_pattern')
})
