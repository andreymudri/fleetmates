import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { captureReviewBaseline, refreshSessionChanges, withScanCache } from '../../server/machines/session.mjs'

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { timeout: 5000 })
const store = { run() {} }
const names = session => JSON.parse(refreshSessionChanges(store, session).changed_files).map(file => path.basename(file.path)).sort()

test('withScanCache reuses one scan per root and baseline, and only inside the callback', async t => {
  const repo = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'deck-scancache-')))
  t.after(() => rmSync(repo, RM))
  git(repo, 'init', '-q')
  writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'fixture')
  const session = { id: 's', cwd: repo, review_baseline: captureReviewBaseline(repo, null, false) }
  writeFileSync(path.join(repo, 'a.txt'), 'two\n')

  await withScanCache(async () => {
    assert.deepEqual(names(session), ['a.txt'])
    writeFileSync(path.join(repo, 'b.txt'), 'new\n')
    assert.deepEqual(names(session), ['a.txt'])
  })
  assert.deepEqual(names(session), ['a.txt', 'b.txt'])
})

test('withScanCache clears the cache when the callback throws', async () => {
  await assert.rejects(withScanCache(async () => { throw Error('boom') }), /boom/)
  const repo = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'deck-scancache-')))
  try {
    git(repo, 'init', '-q')
    git(repo, 'commit', '-qm', 'empty', '--allow-empty')
    const session = { id: 's', cwd: repo, review_baseline: captureReviewBaseline(repo, null, false) }
    assert.deepEqual(names(session), [])
    writeFileSync(path.join(repo, 'c.txt'), 'x\n')
    assert.deepEqual(names(session), ['c.txt'])
  } finally { rmSync(repo, RM) }
})
