import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
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

// One temporary repository per case: `main` holds what `setup` commits, `work` what `change` does.
async function measured(setup, change, sub = '') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'review-depth-')))
  try {
    const git = repo(root)
    const commit = (message) => { git('add', '-A'); git('commit', '--quiet', '-m', message) }
    await setup({ root, git, commit })
    git('checkout', '--quiet', '-b', 'work')
    await change({ root, git, commit })
    const { code, out } = await cli(['review-depth', '--json', '--root', path.join(root, sub)])
    assert.equal(code, 0, out)
    return JSON.parse(out)
  } finally { await rm(root, { recursive: true, force: true }) }
}
const write = (root, name, text) => writeFile(path.join(root, name), text)

test('removed lines count as changed lines', async () => {
  const result = await measured(
    async ({ root, commit }) => { await write(root, 'a.txt', '1\n2\n3\n4\n5\n'); commit('base') },
    async ({ root, commit }) => { await write(root, 'a.txt', '1\n5\n'); commit('remove three') },
  )
  assert.equal(result.files, 1)
  assert.equal(result.lines, 3)
})

test('the diff is measured from the merge base, so work that landed on the base is not counted', async () => {
  const result = await measured(
    async ({ root, commit }) => { await write(root, 'a.txt', 'one\n'); commit('base') },
    async ({ root, git, commit }) => {
      await write(root, 'a.txt', 'one\ntwo\n'); commit('branch work')
      git('checkout', '--quiet', 'main')
      await write(root, 'landed.txt', 'x\n'.repeat(700)); commit('landed on base')
      git('checkout', '--quiet', 'work')
    },
  )
  assert.deepEqual([result.files, result.lines, result.suggestion], [1, 1, 'tests-only'])
})

test('a binary file is one changed file and no changed lines, and a rename is a removal and an addition', async () => {
  const binary = await measured(
    async ({ root, commit }) => { await write(root, 'a.txt', 'one\n'); commit('base') },
    async ({ root, commit }) => { await writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0])); commit('binary') },
  )
  assert.deepEqual([binary.files, binary.lines], [1, 0])
  const renamed = await measured(
    async ({ root, commit }) => { await write(root, 'old.txt', 'a\nb\n'); commit('base') },
    async ({ git, commit }) => { git('mv', 'old.txt', 'new.txt'); commit('rename') },
  )
  assert.deepEqual([renamed.files, renamed.lines], [2, 4])
})

test('a neighbour below the confidence floor, or one deleted since, is not counted as coupled', async () => {
  // `rare.txt` changed with `src.txt` in 1 of the 4 commits that touched src: below one half.
  const rare = await measured(
    async ({ root, commit }) => {
      await write(root, 'src.txt', '0\n'); await write(root, 'rare.txt', '0\n'); commit('together once')
      for (const i of [1, 2]) { await write(root, 'src.txt', `${i}\n`); commit(`src alone ${i}`) }
    },
    async ({ root, commit }) => { await write(root, 'src.txt', 'changed\n'); commit('src') },
  )
  assert.deepEqual([rare.coupled, rare.suggestion], [0, 'tests-only'])
  // `gone.txt` always changed with src, and no longer exists; `kept.txt` did too and does.
  const gone = await measured(
    async ({ root, git, commit }) => {
      for (const i of [0, 1, 2]) {
        for (const name of ['src.txt', 'gone.txt', 'kept.txt']) await write(root, name, `${i}\n`)
        commit(`all three ${i}`)
      }
      git('rm', '--quiet', 'gone.txt'); commit('remove gone')
    },
    async ({ root, commit }) => { await write(root, 'src.txt', 'changed\n'); commit('src') },
  )
  assert.equal(gone.coupled, 1)
})

test('--root in a subdirectory measures the same repository-wide diff and still finds coupled files', async () => {
  const result = await measured(
    async ({ root, commit }) => {
      await mkdir(path.join(root, 'sub'))
      for (const i of [0, 1, 2]) { await write(root, 'sub/src.txt', `${i}\n`); await write(root, 'top.txt', `${i}\n`); commit(`pair ${i}`) }
    },
    async ({ root, commit }) => { await write(root, 'sub/src.txt', 'changed\n'); commit('src') },
    'sub',
  )
  assert.deepEqual([result.files, result.lines, result.coupled], [1, 2, 1])
})
