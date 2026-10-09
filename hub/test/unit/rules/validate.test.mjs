import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openDeckDb } from '../../../server/db/index.mjs'
import { classify, DEFAULT_TIERS, hooksPathCache } from '../../../server/approvals/tiers.mjs'
import { setupPaths } from '../../../server/setup/paths.mjs'
import { canonicalPattern, FLOOR_PROBE_EXEMPT, floorProbes, listRules, probeReaches, PERSISTENCE_DIRS, PERSISTENCE_FILES, RULE_COPY, samePattern, validatePattern as validateOn, writeRule } from '../../../server/approvals/rules.mjs'

// Pattern validation for rules (07-approvals 7.3, F13, D-76, D-86).

const DESTRUCTIVE = 'Destructive commands can never become rules.'

// validatePattern refuses every rule on win32 (docs/deck/16-platforms.md section 6), so the tests that
// pin what it accepts or refuses on POSIX pass `platform: 'linux'`; a test may pass another platform.
const validatePattern = (pattern, options = {}) => validateOn(pattern, { platform: 'linux', ...options })
// A test that validates against a sandbox of real temp directories needs POSIX paths for them.
const hostPaths = { skip: process.platform === 'win32' && 'validatePattern classifies for the host' }

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

test('WebFetch(domain:...) and an exact Bash rule are accepted; WebFetch carries the tool-wide warning', () => {
  const fetch = validatePattern('WebFetch(domain:docs.nestjs.com)')
  assert.deepEqual(fetch, { ok: true, pattern: 'WebFetch(domain:docs.nestjs.com)', tool: 'WebFetch', tier: 'caution', warning: null })
  const script = validatePattern('Bash(npm run test)')
  assert.equal(script.ok, true)
  assert.equal(script.warning, null)
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

test('a suggestion written for npm run test:unit writes exactly Bash(npm run test:unit)', hostPaths, async () => {
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
test('a Read or file-tool glob whose root is, holds or lies inside a deck control or protected path is refused', hostPaths, async () => {
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

// D-103 took every prefix rule out of the default tiers. A user tiers table can still carry one, so
// this table puts the three removed rules back as the accepted control for the checks below.
const D103_RULES = { 'safe.python.mypy': 'Bash(mypy:*)', 'safe.go.golangci-lint': 'Bash(golangci-lint run:*)', 'safe.terraform.validate': 'Bash(terraform validate:*)' }
const PREFIX_TIERS = { entries: DEFAULT_TIERS.entries.map(entry => Object.hasOwn(D103_RULES, entry.id) ? { ...entry, rule: D103_RULES[entry.id] } : entry) }

// Mutation run for this test: `own` forced to false in bashVerdict; this test failed on the accepted
// control. Under D-101 the refused prefixes here are no tiers rules, so disabling the floor probes
// leaves this test green; the Safe-entry test further down fails for that mutation instead.
test('a Bash prefix whose arguments can reach a Destructive floor is refused; a user tiers prefix rule stays accepted', hostPaths, async () => {
  const s = sandbox()
  try {
    await s.settle()
    for (const pattern of ['Bash(git config:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(tee:*)', 'Bash(git config --global:*)', 'Bash(cp -r:*)']) {
      assert.deepEqual(validatePattern(pattern, s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, pattern)
    }
    for (const pattern of Object.values(D103_RULES)) assert.equal(validatePattern(pattern, { ...s.options, tiers: PREFIX_TIERS }).ok, true, pattern)
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
// applied to Safe entry rules again; this test failed for each (on the PREFIX_TIERS pass).
test('every Safe tiers rule validates ok with tier safe and lists with destructive false', hostPaths, async () => {
  const s = sandbox()
  const store = openDeckDb(path.join(s.root, 'state', 'deck.db'))
  try {
    await s.settle()
    store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', s.repoRoot, 'rustot', 0, 0, 'rustot', 1)
    mkdirSync(path.join(s.repoRoot, '.claude'))
    // D-98, D-103: the default table has no Bash rule other than the script templates; the user
    // table with the D-103 rules put back has those three.
    for (const [tiers, bash] of [[DEFAULT_TIERS, []], [PREFIX_TIERS, Object.values(D103_RULES).sort()]]) {
      const rules = tiers.entries.filter(entry => entry.tier === 'safe' && typeof entry.rule === 'string' && !entry.rule.includes('{'))
      assert.deepEqual(rules.filter(entry => entry.tool === 'Bash').map(entry => entry.rule).sort(), bash)
      for (const { rule } of rules) {
        const verdict = validatePattern(rule, { ...s.options, tiers })
        assert.deepEqual({ ok: verdict.ok, tier: verdict.tier, warning: verdict.warning }, { ok: true, tier: 'safe', warning: null }, rule)
      }
      writeFileSync(path.join(s.repoRoot, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: rules.map(entry => entry.rule) } }))
      const listed = listRules(store, s.repoRoot, { at: 1, tiers })
      assert.equal(listed.rules.length, rules.length)
      for (const rule of listed.rules) assert.equal(rule.destructive, false, rule.pattern)
    }
  } finally { store.close(); s.close() }
})

// Mutation runs for this test: the `rule` field restored on safe.python.ruff-check, and separately on
// safe.terraform.fmt, in tiers.default.json; this test failed for each.
test('D-98: classify suggests no rule for ruff check or terraform fmt', hostPaths, async () => {
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
  // D-102: npm test has noneArg options, so Bash(npm test:*) is no tiers rule and is refused (D-101).
  assert.equal(validatePattern('Bash(npm test:*)').code, 'destructive_rule')
  // D-101: a prefix that is not a tiers rule is refused, so `pnpm ls:*` no longer passes.
  assert.equal(validatePattern('Bash(pnpm ls:*)').code, 'destructive_rule')
})

// Fix round 2 (phase 5 round 1 reviews).

// D-102: the entries whose prefix rule was removed because a noneArg or output option lets a written
// rule run code or write paths unclassified.
const D102_REMOVED = ['safe.cargo.build', 'safe.cargo.check', 'safe.cargo.test', 'safe.cargo.nextest-run', 'safe.cargo.clippy', 'safe.cargo.fmt', 'safe.npm.test',
  'safe.node.test', 'safe.go.build', 'safe.go.test', 'safe.go.vet', 'safe.python.pytest', 'safe.python.pytest-module']
// D-103: the last three prefix rules, removed because an option of a future version is approved too.
const D103_REMOVED = Object.keys(D103_RULES)

// Mutation runs for this test: `"rule":"Bash(cargo build:*)","ruleNote":"anyFlags"` restored on
// safe.cargo.build in tiers.default.json, and separately `"rule":"Bash(mypy:*)"` on
// safe.python.mypy; this test failed for each.
test('D-102, D-103: each entry that lost its rule stays Safe and gives no rule candidate', hostPaths, async () => {
  const s = sandbox()
  try {
    await s.settle()
    const byId = new Map(DEFAULT_TIERS.entries.map(entry => [entry.id, entry]))
    for (const id of [...D102_REMOVED, ...D103_REMOVED]) {
      const entry = byId.get(id)
      assert.equal(entry.tier, 'safe', id)
      assert.equal(entry.rule, undefined, id)
      assert.equal(entry.ruleNote, undefined, id)
      const result = classify({ toolName: 'Bash', toolInput: { command: entry.cmd }, cwd: s.repoRoot, repoRoot: s.repoRoot, homeDir: s.homeDir })
      assert.equal(result.ruleCandidate, null, id)
      assert.equal(result.ruleNote, null, id)
    }
    // A command the entry rates Safe, so a restored rule would show up as a candidate here.
    assert.equal(classify({ toolName: 'Bash', toolInput: { command: 'cargo build' }, cwd: s.repoRoot, repoRoot: s.repoRoot, homeDir: s.homeDir }).tier, 'safe')
    assert.equal(byId.get('safe.python.ruff-check').ruleNote, undefined)
  } finally { s.close() }
})

// Mutation run for this test: `"rule":"Bash(mypy:*)"` restored on safe.python.mypy in
// tiers.default.json; this test failed.
test('D-103: no Safe Bash entry carries a prefix rule; the exact script templates keep theirs', () => {
  const bash = DEFAULT_TIERS.entries.filter(entry => entry.tier === 'safe' && entry.tool === 'Bash' && typeof entry.rule === 'string')
  assert.deepEqual(bash.filter(entry => entry.rule.includes(':*') || / \*\)$/.test(entry.rule)).map(entry => entry.id), [])
  assert.deepEqual(bash.map(entry => entry.rule).sort(), ['Bash(npm run {script})', 'Bash(pnpm run {script})'])
})

// Mutation run for this test: the same restore of the mypy rule; this test failed.
test('D-103: the three removed prefix rules are refused, in either form', hostPaths, async () => {
  const s = sandbox()
  try {
    await s.settle()
    for (const rule of Object.values(D103_RULES)) {
      for (const pattern of [rule, rule.replace(':*)', ' *)')]) assert.deepEqual(validatePattern(pattern, s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, pattern)
    }
  } finally { s.close() }
})

// Mutation run for this test: the reachesDestructive line deleted from bashVerdict; this test failed.
test('a user Safe entry whose prefix rule reaches a Destructive entry is refused by reachesDestructive', hostPaths, async () => {
  const s = sandbox()
  try {
    await s.settle()
    // Each prefix is a user tiers rule (so D-101 passes), is not Destructive on its own and reaches no
    // floor probe; only its Destructive subcommands (kubectl delete, terraform destroy, docker rm)
    // refuse it.
    for (const cmd of ['kubectl', 'terraform', 'docker']) {
      const rule = `Bash(${cmd}:*)`
      const tiers = { entries: [...DEFAULT_TIERS.entries, { id: `user.${cmd}`, tier: 'safe', tool: 'Bash', cmd, rule }] }
      assert.deepEqual(validatePattern(rule, { ...s.options, tiers }), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, rule)
    }
  } finally { s.close() }
})

// Mutation run for this test: the D-101 refusal of a prefix that is not a tiers rule removed from
// bashVerdict, so any prefix the other checks pass was accepted again; this test failed.
test('D-101: a Bash prefix rule is accepted only as the rule of a Safe tiers entry', hostPaths, async () => {
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
test('a Safe tiers entry whose rule reaches a Destructive entry or floor is still refused', hostPaths, async () => {
  const s = sandbox()
  try {
    await s.settle()
    const tiers = { entries: [...DEFAULT_TIERS.entries, { id: 'safe.test.git', tier: 'safe', tool: 'Bash', cmd: 'git', rule: 'Bash(git:*)' }, { id: 'safe.test.cp', tier: 'safe', tool: 'Bash', cmd: 'cp', rule: 'Bash(cp:*)' }] }
    for (const pattern of ['Bash(git:*)', 'Bash(cp:*)']) assert.equal(validatePattern(pattern, { ...s.options, tiers }).code, 'destructive_rule', pattern)
  } finally { s.close() }
})

// Mutation runs for this test: related() returned inside(down) only, and separately pathVerdict
// dropped `...roots.map(realExisting)`; this test failed for each.
test('a glob root inside a protected path, or reaching one through a symlink, is refused', hostPaths, async () => {
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
test('a /p glob is read as absolute, repo-relative and .claude-relative', hostPaths, async () => {
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

// docs/deck/16-platforms.md section 6: nothing is auto-approved on Windows, and a written rule would
// auto-approve inside Claude Code, so validatePattern and writeRule refuse every rule there. Runs on
// every host: the platform is injected.
// Mutation run for this test: the win32 refusal removed from validatePattern; this test failed.
test('on win32 every rule is refused with rules_unsupported_on_win32 and writeRule writes nothing', async () => {
  const unsupported = { ok: false, code: 'rules_unsupported_on_win32', message: RULE_COPY.unsupported }
  assert.equal(typeof RULE_COPY.unsupported, 'string')
  for (const pattern of ['mcp__vault__vault_search', 'Bash(npm run test)', 'WebFetch(domain:docs.nestjs.com)', 'WebSearch', 'Read(src/**)', 'Bash(rm:*)', 'not a pattern']) {
    assert.deepEqual(validatePattern(pattern, { platform: 'win32' }), unsupported, pattern)
  }
  // The control: the same pattern is accepted off Windows.
  assert.equal(validatePattern('mcp__vault__vault_search', { platform: 'linux' }).ok, true)
  assert.equal(validatePattern('mcp__vault__vault_search', { platform: 'darwin' }).ok, true)
  const root = mkdtempSync(path.join(tmpdir(), 'deck-rules-win32-'))
  const store = openDeckDb(path.join(root, 'state', 'deck.db'))
  try {
    const repoId = realpathSync(root)
    store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repoId, 'web', 0, 0, 'web', 1)
    await assert.rejects(writeRule(store, { repoId, pattern: 'mcp__vault__vault_search', source: 'manual', stateDir: path.join(root, 'state'), at: 1, gitRead: async () => null, platform: 'win32' }),
      error => error.code === 'rules_unsupported_on_win32' && error.status === 422)
    assert.equal(existsSync(path.join(repoId, '.claude', 'settings.local.json')), false)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM rules').n, 0)
  } finally { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// The T8 deferral: the deck's launchd agents are part of the persistence floor for rules too, so no
// rule may read or write them, hold them, or name them in any case.
// Mutation run for this test: the LaunchAgents check removed from pathVerdict; this test failed.
test('a path rule reaching ~/Library/LaunchAgents/io.fleetmates.deck.* is refused', hostPaths, async () => {
  const s = sandbox()
  try {
    await s.settle()
    for (const pattern of ['Read(~/Library/LaunchAgents/io.fleetmates.deck.web.plist)', 'Write(~/Library/LaunchAgents/io.fleetmates.deck.deckd.plist)',
      'Read(~/library/launchagents/IO.FLEETMATES.DECK.web.plist)', 'Read(~/Library/LaunchAgents/io.fleetmates.deck.*)', 'Read(~/Library/LaunchAgents/**)',
      'Read(~/Library/**)', `Read(/${s.homeDir}/Library/LaunchAgents/io.fleetmates.deck.web.plist)`]) {
      assert.deepEqual(validatePattern(pattern, s.options), { ok: false, code: 'destructive_rule', message: DESTRUCTIVE }, pattern)
    }
    // Another agent in the same directory is not the deck's.
    assert.equal(validatePattern('Read(~/Library/LaunchAgents/com.example.agent.plist)', s.options).ok, true)
  } finally { s.close() }
})

// The mirror judges rules found in a settings file with the checks of validatePattern but without its
// win32 refusal, so a hand-added Destructive rule still lists as Destructive on Windows. Runs on every
// host: the platform is injected.
// Mutation run for this test: ruleView calling validatePattern instead of judgePattern; this test failed.
test('on win32 listRules still marks a hand-added Destructive rule destructive', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-rules-list-')))
  const store = openDeckDb(path.join(root, 'state', 'deck.db'))
  try {
    const repoId = path.join(root, 'web')
    mkdirSync(path.join(repoId, '.claude'), { recursive: true })
    store.run('INSERT INTO repos(id,name,crew_slot,crew_slot_shared,crew_seed,first_seen_at) VALUES(?,?,?,?,?,?)', repoId, 'web', 0, 0, 'web', 1)
    writeFileSync(path.join(repoId, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(rm:*)', 'mcp__vault__vault_search'] } }))
    const listed = listRules(store, repoId, { at: 1, platform: 'win32' })
    assert.deepEqual(listed.rules.map(rule => [rule.pattern, rule.destructive]), [['Bash(rm:*)', true], ['mcp__vault__vault_search', false]])
  } finally { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
