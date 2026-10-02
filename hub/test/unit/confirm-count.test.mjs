import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

test('countFor reset_files counts git status --porcelain lines', async t => {
  const repo = tempRepo(t)
  writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
  writeFileSync(path.join(repo, 'new.txt'), 'new\n')
  assert.equal(await countFor('reset_files', ['git', 'reset', '--hard'], repo), 2)
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
