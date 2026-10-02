import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SAFE_GIT_FLAGS, allowedCommand, gitEnv, gitRead } from '../../server/adapters/git-read.mjs'
import { MAX_DIFF_BYTES, sessionDiff } from '../../server/adapters/git-diff.mjs'
import { captureReviewBaseline } from '../../server/machines/session.mjs'

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { timeout: 5000 }).toString('utf8')
}

function tempRepo(t, files = {}) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-gitdiff-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q')
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    writeFileSync(path.join(repo, name), content)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'fixture', '--allow-empty')
  return repo
}

function session(repo, review_baseline, names) {
  return { cwd: repo, review_baseline, changed_files: JSON.stringify(names.map(name => ({ path: path.join(repo, name), adds: null, dels: null }))) }
}

async function refused(promise) {
  try { await promise } catch (error) { return error.code }
  return 'resolved'
}

test('sessionDiff shows the hunk of a file edited after the review baseline', async t => {
  const repo = tempRepo(t, { 'a.txt': 'one\ntwo\nthree\n' })
  const value = captureReviewBaseline(repo)
  writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n')
  const result = await sessionDiff(session(repo, value, ['a.txt']), 'a.txt')
  assert.equal(result.path, 'a.txt')
  assert.equal(result.baseline, git(repo, 'rev-parse', 'HEAD').trim())
  assert.equal(result.binary, false)
  assert.equal(result.truncated, false)
  assert.equal(result.diff, '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n')
})

test('sessionDiff diffs a file dirty before the session against its stored content, not HEAD', async t => {
  const repo = tempRepo(t, { 'b.txt': 'base\n' })
  writeFileSync(path.join(repo, 'b.txt'), 'dirty\n')
  const value = captureReviewBaseline(repo)
  writeFileSync(path.join(repo, 'b.txt'), 'session\n')
  const result = await sessionDiff(session(repo, value, ['b.txt']), 'b.txt')
  assert.match(result.diff, /^-dirty$/m)
  assert.match(result.diff, /^\+session$/m)
  assert.doesNotMatch(result.diff, /base/)
})

test('sessionDiff shows a new untracked file against an empty baseline side', async t => {
  const repo = tempRepo(t, {})
  const value = captureReviewBaseline(repo)
  writeFileSync(path.join(repo, 'new.txt'), 'hello\n')
  const result = await sessionDiff(session(repo, value, ['new.txt']), 'new.txt')
  assert.equal(result.diff, '--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n')
})

test('sessionDiff refuses paths that escape the repository with validation_failed', async t => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-outside-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
  const repo = tempRepo(t, { 'a.txt': 'a\n' })
  symlinkSync(outside, path.join(repo, 'link'))
  const value = captureReviewBaseline(repo)
  // Every path below is also listed as changed, so only the escape check can refuse it.
  const listed = { cwd: repo, review_baseline: value, changed_files: JSON.stringify(['/etc/passwd', path.resolve(repo, '../../etc/passwd'), path.join(repo, 'link/secret.txt')].map(name => ({ path: name }))) }
  assert.equal(await refused(sessionDiff(listed, '../../etc/passwd')), 'validation_failed')
  assert.equal(await refused(sessionDiff(listed, '/etc/passwd')), 'validation_failed')
  assert.equal(await refused(sessionDiff(listed, 'link/secret.txt')), 'validation_failed')
  assert.equal(await refused(sessionDiff(listed, 'a.txt\0x')), 'validation_failed')
})

test('sessionDiff answers not_found for a path that is not in changedFiles', async t => {
  const repo = tempRepo(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  const value = captureReviewBaseline(repo)
  writeFileSync(path.join(repo, 'b.txt'), 'B\n')
  assert.equal(await refused(sessionDiff(session(repo, value, ['a.txt']), 'b.txt')), 'not_found')
})

test('sessionDiff cuts a diff over 512 KiB at a line start and marks it truncated', async t => {
  const repo = tempRepo(t, { 'big.txt': 'start\n' })
  const value = captureReviewBaseline(repo)
  const line = `${'x'.repeat(99)}\n`
  writeFileSync(path.join(repo, 'big.txt'), line.repeat(Math.ceil(600 * 1024 / line.length)))
  const result = await sessionDiff(session(repo, value, ['big.txt']), 'big.txt')
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.diff) <= MAX_DIFF_BYTES)
  assert.ok(Buffer.byteLength(result.diff) > MAX_DIFF_BYTES - 200)
  assert.ok(result.diff.endsWith(`+${line}`))
})

test('sessionDiff reports a binary file with binary: true, no diff text and its size', async t => {
  const repo = tempRepo(t, { 'bin.dat': Buffer.from([1, 2, 0, 3]) })
  const value = captureReviewBaseline(repo)
  writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4, 5]))
  const result = await sessionDiff(session(repo, value, ['bin.dat']), 'bin.dat')
  assert.equal(result.binary, true)
  assert.equal(result.diff, '')
  assert.equal(result.size, 6)
})

test('sessionDiff reports a symlink by its target text and never follows it', async t => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-target-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(path.join(outside, 'target.txt'), 'followed\n')
  const repo = tempRepo(t, {})
  const value = captureReviewBaseline(repo)
  symlinkSync(path.join(outside, 'target.txt'), path.join(repo, 'l'))
  const result = await sessionDiff(session(repo, value, ['l']), 'l')
  assert.equal(result.kind, 'symlink')
  assert.doesNotMatch(result.diff, /followed/)
  assert.ok(result.diff.includes(`+${path.join(outside, 'target.txt')}`))
})

test('a repo config diff.external and core.fsmonitor pointing at a marker script never runs it', async t => {
  const repo = tempRepo(t, { 'a.txt': 'one\n' })
  const marker = path.join(repo, '..', `${path.basename(repo)}-marker`)
  t.after(() => rmSync(marker, { force: true }))
  const script = path.join(repo, 'hook.sh')
  writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`)
  chmodSync(script, 0o755)
  git(repo, 'config', 'diff.external', script)
  git(repo, 'config', 'core.fsmonitor', script)
  const value = captureReviewBaseline(repo)
  writeFileSync(path.join(repo, 'a.txt'), 'two\n')
  // gitRead refuses a work-tree diff and status outright, so the safe flags are run here by hand: without
  // --no-ext-diff on the command itself, only the -c flags keep the script away. The empty diff.external
  // makes git refuse ("cannot run"), and the status still succeeds without starting the fsmonitor script.
  assert.equal(await gitRead(repo, ['diff']), null)
  assert.equal(await gitRead(repo, ['status', '--porcelain']), null)
  const run = args => spawnSync('git', [...SAFE_GIT_FLAGS, ...args], { cwd: repo, env: gitEnv(), timeout: 5000 })
  assert.notEqual(run(['diff']).status, 0)
  const diff = run(['diff', '--no-ext-diff'])
  assert.equal(diff.status, 0)
  assert.match(diff.stdout.toString('utf8'), /^\+two$/m)
  assert.equal(run(['status', '--porcelain']).status, 0)
  await sessionDiff(session(repo, value, ['a.txt']), 'a.txt')
  assert.equal(existsSync(marker), false)
})

/** A repository whose in-tree and info attributes select clean, smudge, textconv and diff drivers that touch `marker`. */
function filterRepo(t) {
  const repo = tempRepo(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const marker = path.join(repo, '..', `${path.basename(repo)}-filter-marker`)
  t.after(() => rmSync(marker, { force: true }))
  const script = path.join(repo, '..', `${path.basename(repo)}-filter.sh`)
  t.after(() => rmSync(script, { force: true }))
  writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\nif [ -n "$1" ]; then cat "$1"; else cat; fi\n`)
  chmodSync(script, 0o755)
  writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil diff=evil\n')
  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil diff=evil\n')
  for (const key of ['filter.evil.clean', 'filter.evil.smudge', 'filter.evil.process', 'diff.evil.textconv', 'diff.evil.command']) git(repo, 'config', key, script)
  // Stat-dirty with unchanged content: git status would re-hash a.txt through the clean filter.
  utimesSync(path.join(repo, 'a.txt'), new Date('2001-01-01'), new Date('2001-01-01'))
  writeFileSync(path.join(repo, 'before'), 'x\n')
  writeFileSync(path.join(repo, 'after'), 'y\n')
  return { repo, marker }
}

test('a status-like gitRead in a repo with a marker clean filter is refused and never runs the filter', async t => {
  const { repo, marker } = filterRepo(t)
  // The fixture itself is live: plain git status runs the filter.
  spawnSync('git', ['status', '--porcelain'], { cwd: repo, env: gitEnv(), timeout: 5000 })
  assert.equal(existsSync(marker), true)
  rmSync(marker)
  utimesSync(path.join(repo, 'a.txt'), new Date('2001-01-01'), new Date('2001-01-01'))
  for (const args of [['status', '--porcelain'], ['diff-files', '--name-only'], ['diff-index', '--name-only', 'HEAD'], ['ls-files', '-m'], ['ls-files', '--modified'], ['ls-files', '-dm'], ['show', 'HEAD'], ['log', '-p'], ['diff', '--no-ext-diff', '--no-textconv'], ['cat-file', '--filters', 'HEAD:a.txt'], ['clean', '-f'], ['clean', '-nf'], ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['-c', 'x=y', 'rev-parse', 'HEAD'], ['add', 'a.txt']]) {
    const output = await gitRead(repo, args)
    assert.equal(existsSync(marker), false, args.join(' '))
    assert.equal(output, null, args.join(' '))
    assert.equal(allowedCommand(args), false, args.join(' '))
  }
})

test('every command gitRead allows runs in a repo with marker filter and diff drivers without starting them', async t => {
  const { repo, marker } = filterRepo(t)
  const allowed = [
    ['rev-parse', '--show-toplevel'], ['rev-list', '--count', 'HEAD'], ['ls-tree', '-r', '-z', 'HEAD'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'], ['cat-file', 'blob', 'HEAD:a.txt'], ['ls-files', '--stage', '--debug', '-z'],
    ['ls-files', '--eol', '-t', '--cached', '--others'], ['ls-files', '--error-unmatch', 'a.txt'], ['clean', '-n', '-d'],
    ['worktree', 'list', '--porcelain'], ['config', '--bool', '--get', 'core.filemode'],
    ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'before', 'after']
  ]
  for (const args of allowed) {
    const output = await gitRead(repo, args)
    assert.equal(existsSync(marker), false, args.join(' '))
    assert.ok(output && output.code <= 1, args.join(' '))
    assert.equal(allowedCommand(args), true, args.join(' '))
  }
  const diff = await gitRead(repo, allowed.at(-1))
  assert.match(diff.stdout.toString('utf8'), /^-x\n\+y$/m)
})

test('gitRead starts git with the 4.8 flags and environment, without credential or GIT_ variables', async t => {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-fakegit-')))
  t.after(() => rmSync(bin, { recursive: true, force: true }))
  const record = path.join(bin, 'record')
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}.argv'\nenv | cut -d= -f1 > '${record}.env'\nprintf '%s' "$GIT_TERMINAL_PROMPT$GIT_OPTIONAL_LOCKS$GIT_CONFIG_NOSYSTEM $GIT_ASKPASS"\n`)
  chmodSync(path.join(bin, 'git'), 0o755)
  const saved = { PATH: process.env.PATH, FLEETMATES_DECK_TOKEN: process.env.FLEETMATES_DECK_TOKEN, GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF }
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.FLEETMATES_DECK_TOKEN = 'placeholder'
  process.env.GIT_EXTERNAL_DIFF = '/bin/false'
  const output = await gitRead(bin, ['rev-parse', 'HEAD'])
  assert.equal(output.stdout.toString('utf8'), '001 /bin/false')
  assert.deepEqual(readFileSync(`${record}.argv`, 'utf8').trim().split('\n'), [...SAFE_GIT_FLAGS, 'rev-parse', 'HEAD'])
  const names = readFileSync(`${record}.env`, 'utf8').split('\n')
  assert.equal(names.includes('FLEETMATES_DECK_TOKEN'), false)
  assert.equal(names.includes('GIT_EXTERNAL_DIFF'), false)
})

test('gitRead resolves null when git outlives its timeout', async t => {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-slowgit-')))
  t.after(() => rmSync(bin, { recursive: true, force: true }))
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n')
  chmodSync(path.join(bin, 'git'), 0o755)
  const saved = process.env.PATH
  t.after(() => { process.env.PATH = saved })
  process.env.PATH = `${bin}:${saved}`
  const started = Date.now()
  assert.equal(await gitRead(bin, ['rev-parse', 'HEAD'], { timeoutMs: 200 }), null)
  assert.ok(Date.now() - started < 2000)
})
