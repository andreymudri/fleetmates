import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { reviewDepth, renderReviewDepth, DEPTH_LIMITS } from '../scripts/review-depth.mjs'
import { runCli } from '../scripts/cli.mjs'

const depth = (files, lines, coupled = 0) => reviewDepth({ files, lines, coupled }).suggestion

test('the limits are the documented starting values', () => {
  assert.deepEqual({ ...DEPTH_LIMITS }, { smallFiles: 3, smallLines: 60, largeFiles: 15, largeLines: 600, coupledConfidence: 0.5 })
  assert.ok(Object.isFrozen(DEPTH_LIMITS))
})

test('a small, uncoupled change needs the suite only, and each limit is a boundary', () => {
  assert.equal(depth(3, 60, 0), 'tests-only')
  assert.equal(depth(0, 0, 0), 'tests-only')
  assert.equal(depth(4, 60, 0), 'two-lenses')
  assert.equal(depth(3, 61, 0), 'two-lenses')
  assert.equal(depth(3, 60, 1), 'two-lenses')
})

test('a large change gets every lens, whichever limit it crosses', () => {
  assert.equal(depth(15, 600), 'two-lenses')
  assert.equal(depth(16, 1), 'all-lenses')
  assert.equal(depth(1, 601), 'all-lenses')
  // Size outranks coupling: a large change is not downgraded for having no neighbours.
  assert.equal(depth(16, 601, 0), 'all-lenses')
})

test('each suggestion carries the lenses it means and the numbers it was made from', () => {
  assert.deepEqual(reviewDepth({ files: 1, lines: 2, coupled: 0 }), { suggestion: 'tests-only', lenses: [], files: 1, lines: 2, coupled: 0 })
  assert.deepEqual(reviewDepth({ files: 5, lines: 2, coupled: 3 }).lenses, ['correctness', 'tests'])
  assert.equal(reviewDepth({ files: 50, lines: 2, coupled: 0 }).lenses, null)
  for (const bad of [{ files: -1, lines: 0, coupled: 0 }, { files: 1.5, lines: 0, coupled: 0 }, { files: 1, lines: '3', coupled: 0 }, { files: 1, lines: 0 }]) {
    assert.throws(() => reviewDepth(bad), /whole number/)
  }
})

test('the rendering states the numbers, the suggestion and that it is advisory', () => {
  const text = renderReviewDepth(reviewDepth({ files: 1, lines: 1, coupled: 1 }))
  assert.deepEqual(text.split('\n'), [
    'diff: 1 file, 1 changed line, 1 coupled file outside it',
    'suggestion: two-lenses (one review of the whole diff through two lenses: correctness and tests)',
    'advisory: this is a suggestion from size and history; no gate reads it and it never fails anything',
  ])
})

function repo(root) {
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { stdio: 'pipe' })
  git('init', '--quiet', '-b', 'main')
  return git
}
async function cli(args) {
  const lines = []
  const code = await runCli(args, { out: (line) => lines.push(line) })
  return { code, out: lines.join('\n') }
}

test('review-depth measures the branch against its base and exits 0 for every suggestion', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'review-depth-')))
  try {
    const git = repo(root)
    await writeFile(path.join(root, 'a.txt'), 'one\n')
    git('add', '.'); git('commit', '--quiet', '-m', 'base')
    git('checkout', '--quiet', '-b', 'work')
    await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n')
    git('add', '.'); git('commit', '--quiet', '-m', 'small')
    const small = await cli(['review-depth', '--root', root, '--json'])
    assert.equal(small.code, 0)
    assert.deepEqual(JSON.parse(small.out), { suggestion: 'tests-only', lenses: [], files: 1, lines: 1, coupled: 0 })

    for (let i = 0; i < 16; i += 1) await writeFile(path.join(root, `f${i}.txt`), 'x\n')
    git('add', '.'); git('commit', '--quiet', '-m', 'large')
    const large = await cli(['review-depth', '--base', 'main', '--root', root])
    assert.equal(large.code, 0)
    assert.match(large.out, /^diff: 17 files, 17 changed lines, 0 coupled files outside it\nsuggestion: all-lenses /)

    const unknown = await cli(['review-depth', '--base', 'no-such-branch', '--root', root])
    assert.equal(unknown.code, 2)
    assert.match(unknown.out, /^review-depth: --base no-such-branch is not a local branch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a file outside the diff that history couples to it is counted', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'review-depth-')))
  try {
    const git = repo(root)
    // Three commits change src and its test together, so each is coupled to the other.
    for (let i = 0; i < 3; i += 1) {
      await writeFile(path.join(root, 'src.txt'), `${i}\n`)
      await writeFile(path.join(root, 'test.txt'), `${i}\n`)
      git('add', '.'); git('commit', '--quiet', '-m', `pair ${i}`)
    }
    git('checkout', '--quiet', '-b', 'work')
    await writeFile(path.join(root, 'src.txt'), 'changed\n')
    git('add', '.'); git('commit', '--quiet', '-m', 'src only')
    const { code, out } = await cli(['review-depth', '--root', root, '--json'])
    assert.equal(code, 0)
    const result = JSON.parse(out)
    assert.equal(result.coupled, 1)
    assert.equal(result.suggestion, 'two-lenses')
  } finally { await rm(root, { recursive: true, force: true }) }
})
