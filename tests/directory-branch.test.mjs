import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shippedPaths, buildDirectoryCommit } from '../tools/directory-branch.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function repo(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fm-dirbranch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  // The configured identity is a bot, and only the commit author is the person, so the identity
  // test fails if the builder falls back to git config.
  git(dir, 'config', 'user.name', 'CI Bot')
  git(dir, 'config', 'user.email', 'bot@example.com')
  const put = async (rel, body) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), body)
  }
  await put('package.json', JSON.stringify({ name: 'x', files: ['skills/', 'README.md'] }))
  await put('skills/a/SKILL.md', 'a')
  await put('README.md', 'readme')
  await put('hub/big.js', 'not shipped')
  await put('skillsets/other.md', 'prefix lookalike, not shipped')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'one', '--author', 'Source Author <author@example.com>')
  return { dir, put }
}

const treeOf = (dir, rev) => git(dir, 'ls-tree', '-r', '--name-only', rev).split('\n').sort()

test('the directory commit holds exactly the package.json files entries plus package.json', async (t) => {
  const { dir } = await repo(t)
  const sha = buildDirectoryCommit({ cwd: dir, ref: 'HEAD' })
  assert.deepEqual(treeOf(dir, sha), ['README.md', 'package.json', 'skills/a/SKILL.md'])
})

test('the directory commit carries the source commit author, never a bot identity', async (t) => {
  const { dir } = await repo(t)
  const sha = buildDirectoryCommit({ cwd: dir, ref: 'HEAD' })
  assert.equal(git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', sha),
    'Source Author <author@example.com>|Source Author <author@example.com>')
})

test('an unchanged tree returns null instead of an empty commit, and a change chains on the parent', async (t) => {
  const { dir, put } = await repo(t)
  const first = buildDirectoryCommit({ cwd: dir, ref: 'HEAD' })
  assert.equal(buildDirectoryCommit({ cwd: dir, ref: 'HEAD', parent: first }), null)
  await put('hub/big.js', 'changed, still not shipped')
  git(dir, 'commit', '-qam', 'two')
  assert.equal(buildDirectoryCommit({ cwd: dir, ref: 'HEAD', parent: first }), null)
  await put('skills/a/SKILL.md', 'b')
  git(dir, 'commit', '-qam', 'three')
  const next = buildDirectoryCommit({ cwd: dir, ref: 'HEAD', parent: first })
  assert.equal(git(dir, 'rev-parse', `${next}^`), first)
})

test('building leaves the working tree, the index and HEAD untouched', async (t) => {
  const { dir } = await repo(t)
  const head = git(dir, 'rev-parse', 'HEAD')
  buildDirectoryCommit({ cwd: dir, ref: 'HEAD' })
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head)
  assert.equal(git(dir, 'status', '--porcelain'), '')
})

test('a glob in package.json files is refused rather than silently matched wrong', () => {
  assert.throws(() => shippedPaths(['a.md'], ['scripts/*.mjs']), /glob/)
})

test('the real package.json resolves to a tree with the plugin manifest and no hub, docs or tests', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const root = fileURLToPath(new URL('..', import.meta.url))
  const tracked = git(root, 'ls-files').split('\n')
  const paths = shippedPaths(tracked, pkg.files)
  assert.ok(paths.includes('.claude-plugin/plugin.json'))
  assert.ok(paths.includes('package.json'))
  assert.equal(paths.filter((p) => /^(hub|docs|tests)\//.test(p)).length, 0)
})
