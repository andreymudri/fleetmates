import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { countFor } from '../../server/approvals/confirm-count.mjs'

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { timeout: 5000 }).toString('utf8').trim()
}

function tempRepo(t) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-count-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'one')
  return repo
}

test('countFor push_overwritten counts the remote-tracking commits a force push overwrites', async t => {
  const repo = tempRepo(t)
  const local = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'two')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'three')
  const remote = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'update-ref', 'refs/remotes/origin/main', remote)
  git(repo, 'update-ref', 'refs/heads/main', local)
  // A ref literally named after the unexpanded variable: only the literal-word check keeps it from counting.
  git(repo, 'update-ref', 'refs/remotes/$REMOTE/main', remote)
  assert.equal(await countFor('push_overwritten', ['git', 'push', '--force', 'origin', 'main'], repo), 2)
  assert.equal(await countFor('push_overwritten', ['git', 'push', '-f', 'origin', '+main:main'], repo), 2)
  assert.equal(await countFor('push_overwritten', ['git', 'push', '--force', '"$REMOTE"'], repo), null)
  assert.equal(await countFor('push_overwritten', ['git', 'push', '--force', '$REMOTE', 'main'], repo), null)
  assert.equal(await countFor('push_overwritten', ['git', 'push', '--force', 'origin', 'nope'], repo), null)
  assert.equal(git(repo, 'rev-parse', 'refs/heads/main'), local)
})

test('countFor reset_files counts tracked changes a reset discards and never untracked files', async t => {
  const repo = tempRepo(t)
  writeFileSync(path.join(repo, 'u1'), 'u\n')
  writeFileSync(path.join(repo, 'u2'), 'u\n')
  // Only untracked files: git reset --hard discards nothing.
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], repo), 0)
  for (const name of ['b.txt', 'c.txt', 'd.txt', 'e.txt']) writeFileSync(path.join(repo, name), `${name}\n`)
  git(repo, 'add', 'b.txt', 'c.txt', 'd.txt', 'e.txt')
  git(repo, 'commit', '-qm', 'two')
  writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
  writeFileSync(path.join(repo, 'b.txt'), 'staged\n')
  git(repo, 'add', 'b.txt')
  rmSync(path.join(repo, 'c.txt'))
  git(repo, 'rm', '-q', '--cached', 'd.txt')
  writeFileSync(path.join(repo, 'added.txt'), 'added\n')
  git(repo, 'add', 'added.txt')
  // Same content, new mtime: not a change.
  utimesSync(path.join(repo, 'e.txt'), new Date('2001-01-01'), new Date('2001-01-01'))
  // a.txt modified, b.txt staged, c.txt deleted, d.txt removed from the index, added.txt staged; d.txt
  // is now untracked in the work tree and u1, u2 always were.
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], repo), 5)
  // From a subdirectory the count still covers the whole repository, as a reset does.
  mkdirSync(path.join(repo, 'sub'))
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], path.join(repo, 'sub')), 5)
})

/** Points HOME and XDG_CONFIG_HOME at a fresh temporary directory and sets GIT_CONFIG_NOSYSTEM=1 for the rest of the test. */
function isolatedHome(t) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-home-')))
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    rmSync(home, { recursive: true, force: true })
  })
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = path.join(home, '.config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
}

test('countFor reset_files counts a work-tree executable-bit change that git status lists', async t => {
  isolatedHome(t)
  const repo = tempRepo(t)
  chmodSync(path.join(repo, 'a.txt'), 0o755)
  assert.equal(git(repo, 'status', '--porcelain'), 'M a.txt')
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], repo), 1)
  // With core.filemode off git ignores the bit, and so does the count.
  git(repo, 'config', 'core.filemode', 'false')
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], repo), 0)
})

test('countFor reset_files counts a staged mode change whose content and work tree match the index', async t => {
  isolatedHome(t)
  const repo = tempRepo(t)
  chmodSync(path.join(repo, 'a.txt'), 0o755)
  git(repo, 'add', 'a.txt')
  assert.equal(git(repo, 'status', '--porcelain'), 'M  a.txt')
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], repo), 1)
})

test('countFor reset_files skips skip-worktree, assume-unchanged and submodule entries', async t => {
  isolatedHome(t)
  const repo = tempRepo(t)
  for (const name of ['skip.txt', 'assumed.txt']) writeFileSync(path.join(repo, name), `${name}\n`)
  git(repo, 'add', 'skip.txt', 'assumed.txt')
  // A gitlink entry with an empty directory in the work tree, as an uninitialised submodule has.
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${git(repo, 'rev-parse', 'HEAD')},sub`)
  mkdirSync(path.join(repo, 'sub'))
  git(repo, 'commit', '-qm', 'two')
  git(repo, 'update-index', '--skip-worktree', 'skip.txt')
  git(repo, 'update-index', '--assume-unchanged', 'assumed.txt')
  writeFileSync(path.join(repo, 'skip.txt'), 'changed\n')
  writeFileSync(path.join(repo, 'assumed.txt'), 'changed\n')
  // git status lists none of the three, so a reset count of them would overstate the label.
  assert.equal(git(repo, 'status', '--porcelain'), '')
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], repo), 0)
})

test('countFor reset_files in a repo with a marker clean filter never runs the filter', async t => {
  const repo = tempRepo(t)
  writeFileSync(path.join(repo, 'b.txt'), 'b\n')
  git(repo, 'add', 'b.txt')
  git(repo, 'commit', '-qm', 'two')
  const marker = path.join(repo, '..', `${path.basename(repo)}-marker`)
  t.after(() => rmSync(marker, { force: true }))
  const script = path.join(repo, '..', `${path.basename(repo)}-filter.sh`)
  t.after(() => rmSync(script, { force: true }))
  writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`)
  chmodSync(script, 0o755)
  writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n')
  writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n')
  git(repo, 'config', 'filter.evil.clean', script)
  const stale = () => utimesSync(path.join(repo, 'a.txt'), new Date('2001-01-01'), new Date('2001-01-01'))
  // The fixture is live: a plain git status re-hashes the stat-dirty a.txt through the filter.
  stale()
  execFileSync('git', ['-C', repo, 'status', '--porcelain'], { timeout: 5000 })
  assert.equal(existsSync(marker), true)
  rmSync(marker)
  stale()
  const unchanged = await countFor('reset_files', ['git', 'reset', '--hard'], repo)
  assert.equal(existsSync(marker), false)
  assert.equal(unchanged, 0)
  writeFileSync(path.join(repo, 'b.txt'), 'B\n')
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], repo), 1)
  assert.equal(existsSync(marker), false)
})

test('countFor clean_files runs git clean -n with the literal flags minus -f and deletes nothing', async t => {
  const repo = tempRepo(t)
  mkdirSync(path.join(repo, 'build'))
  writeFileSync(path.join(repo, 'build', 'out.o'), 'o\n')
  writeFileSync(path.join(repo, 'loose.txt'), 'l\n')
  writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n')
  writeFileSync(path.join(repo, 'ignored.log'), 'i\n')
  assert.equal(await countFor('clean_files', ['git', 'clean', '-f'], repo), 2)
  assert.equal(await countFor('clean_files', ['git', 'clean', '-fd'], repo), 3)
  assert.equal(await countFor('clean_files', ['git', 'clean', '-fdx'], repo), 4)
  assert.equal(await countFor('clean_files', ['git', 'clean', '-f', '$DIR'], repo), null)
  for (const name of ['build/out.o', 'loose.txt', 'ignored.log']) assert.equal(existsSync(path.join(repo, name)), true)
})

test('countFor rm_paths counts literal operands and returns null for a glob', async () => {
  assert.equal(await countFor('rm_paths', ['rm', '-rf', 'build', 'dist'], '/nonexistent'), 2)
  assert.equal(await countFor('rm_paths', ['rm', '-rf', 'build/*'], '/nonexistent'), null)
  assert.equal(await countFor('rm_paths', ['rm', '-f', '$HOME/x'], '/nonexistent'), null)
})

test('countFor returns null for an unknown kind or a failing git call', async t => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'deck-nogit-')))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  assert.equal(await countFor('sql', ['psql'], outside), null)
  assert.equal(await countFor('push_overwritten', ['git', 'push', '--force', 'origin', 'main'], outside), null)
})
