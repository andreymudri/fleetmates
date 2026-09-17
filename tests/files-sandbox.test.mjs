import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, lstat, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultGitExec } from '../scripts/git.mjs'
import {
  CONTROL_PATHS, isControlPath, makeFilesSandbox, scrubControlPaths, commitFilesTree,
} from '../scripts/harnesses/files-sandbox.mjs'

const git = defaultGitExec

async function out(args, cwd, env) {
  const res = await git(args, { cwd, env })
  assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

async function withRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-files-sandbox-'))
  const runRepo = path.join(root, 'repo')
  await mkdir(runRepo)
  try {
    await out(['init', '--initial-branch=main'], runRepo)
    await out(['config', 'user.email', 'test@example.com'], runRepo)
    await out(['config', 'user.name', 'test'], runRepo)
    await writeFile(path.join(runRepo, '.gitignore'), '.fleetmates/\n')
    await writeFile(path.join(runRepo, 'base.txt'), 'base\n')
    await writeFile(path.join(runRepo, 'gone.txt'), 'gone\n')
    await mkdir(path.join(runRepo, '.claude'))
    await writeFile(path.join(runRepo, '.claude', 'settings.json'), '{"keep":true}\n')
    await out(['add', '.'], runRepo)
    await out(['commit', '-m', 'base'], runRepo)
    await fn({ root, runRepo })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const snapshot = async (runRepo) => ({
  head: await out(['rev-parse', 'HEAD'], runRepo),
  status: await out(['status', '--porcelain'], runRepo),
  staged: await out(['diff', '--cached', '--name-only'], runRepo),
})

test('isControlPath matches entries and paths under directory entries only', () => {
  assert.ok(isControlPath('.cursor/sandbox.json'))
  assert.ok(isControlPath('.cursor/hooks/x.sh'))
  assert.ok(isControlPath('.vscode/settings.json'))
  assert.ok(!isControlPath('.cursor/rules/a.mdc'))
  assert.ok(!isControlPath('src/.cursor/sandbox.json'))
  assert.ok(!isControlPath('.claude/agents/a.md'))
})

test('makeFilesSandbox checks out the branch tree with no .git and leaves the run repo untouched', async () => {
  await withRepo(async ({ runRepo }) => {
    const before = await snapshot(runRepo)
    const [a, b] = await Promise.all([
      makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' }),
      makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T2' }),
    ])
    assert.notEqual(a.cwd, b.cwd)
    assert.deepEqual(a.meta, { mode: 'files', branch: 'fleetmates/r1/T1', runBranch: 'main' })
    assert.equal(await readFile(path.join(a.cwd, 'base.txt'), 'utf8'), 'base\n')
    await assert.rejects(stat(path.join(a.cwd, '.git')), /ENOENT/)
    assert.deepEqual(await snapshot(runRepo), before)
  })
})

test('scrubControlPaths removes every control path, symlinks without touching targets, and reports them sorted', async () => {
  await withRepo(async ({ root }) => {
    const cwd = path.join(root, 'ws')
    await mkdir(path.join(cwd, '.cursor', 'hooks'), { recursive: true })
    await mkdir(path.join(cwd, '.vscode'), { recursive: true })
    await mkdir(path.join(cwd, '.claude'), { recursive: true })
    await writeFile(path.join(cwd, '.cursor', 'hooks', 'a.sh'), 'x')
    await writeFile(path.join(cwd, '.cursor', 'sandbox.json'), '{}')
    await writeFile(path.join(cwd, '.cursor', 'rules.keep'), 'keep')
    await writeFile(path.join(cwd, '.vscode', 'settings.json'), '{}')
    const target = path.join(root, 'target.json')
    await writeFile(target, 'target')
    await symlink(target, path.join(cwd, '.claude', 'settings.local.json'))
    const found = await scrubControlPaths(cwd)
    assert.deepEqual(found, ['.claude/settings.local.json', '.cursor/hooks', '.cursor/sandbox.json', '.vscode'])
    for (const rel of CONTROL_PATHS) await assert.rejects(lstat(path.join(cwd, rel)), /ENOENT/)
    assert.equal(await readFile(target, 'utf8'), 'target')
    assert.equal(await readFile(path.join(cwd, '.cursor', 'rules.keep'), 'utf8'), 'keep')
    assert.deepEqual(await scrubControlPaths(cwd), [])
  })
})

test('commitFilesTree lands edits, additions, deletions and exec bits as one commit on runBranch', async () => {
  await withRepo(async ({ runRepo }) => {
    const before = await snapshot(runRepo)
    const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
    await writeFile(path.join(sandbox.cwd, 'base.txt'), 'edited\n')
    await mkdir(path.join(sandbox.cwd, 'src'))
    await writeFile(path.join(sandbox.cwd, 'src', 'new.sh'), '#!/bin/sh\n')
    await chmod(path.join(sandbox.cwd, 'src', 'new.sh'), 0o755)
    await rm(path.join(sandbox.cwd, 'gone.txt'))
    await commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1' })

    const main = await out(['rev-parse', 'main'], runRepo)
    assert.equal(await out(['rev-parse', 'fleetmates/r1/T1^'], runRepo), main)
    assert.equal(await out(['show', 'fleetmates/r1/T1:base.txt'], runRepo), 'edited')
    const tree = await out(['ls-tree', '-r', 'fleetmates/r1/T1'], runRepo)
    assert.match(tree, /^100755 blob \w+\tsrc\/new\.sh$/m)
    assert.doesNotMatch(tree, /gone\.txt/)
    assert.match(tree, /\t\.claude\/settings\.json$/m)
    assert.deepEqual(await snapshot(runRepo), before)
  })
})

test('commitFilesTree with an unchanged checkout creates no commit', async () => {
  await withRepo(async ({ runRepo }) => {
    const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
    await scrubControlPaths(sandbox.cwd)
    await commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1' })
    assert.equal(await out(['rev-parse', 'fleetmates/r1/T1'], runRepo), await out(['rev-parse', 'main'], runRepo))
  })
})

test('commitFilesTree stores a symlink as a link, never its target', async () => {
  await withRepo(async ({ root, runRepo }) => {
    const secret = path.join(root, 'secret.txt')
    await writeFile(secret, 'host secret\n')
    const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
    await symlink(secret, path.join(sandbox.cwd, 'leak'))
    await commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1' })
    assert.match(await out(['ls-tree', 'fleetmates/r1/T1', 'leak'], runRepo), /^120000 blob /)
    assert.equal(await out(['show', 'fleetmates/r1/T1:leak'], runRepo), secret)
  })
})

test('commitFilesTree never runs a clean filter selected by an in-tree .gitattributes', async () => {
  await withRepo(async ({ root, runRepo }) => {
    const marker = path.join(root, 'filter-fired')
    await out(['config', 'filter.x.clean', `touch ${marker}; cat`], runRepo)
    const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
    await writeFile(path.join(sandbox.cwd, '.gitattributes'), '* filter=x\n')
    await writeFile(path.join(sandbox.cwd, 'base.txt'), 'edited\n')

    // Positive control: an ordinary `git add` over this work tree does fire the filter.
    const ctlIndex = path.join(root, 'ctl-index')
    await out(['--work-tree', sandbox.cwd, 'add', 'base.txt'], runRepo, { GIT_INDEX_FILE: ctlIndex })
    await stat(marker)
    await rm(marker)

    await commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1' })
    await assert.rejects(stat(marker), /ENOENT/)
    assert.equal(await out(['show', 'fleetmates/r1/T1:base.txt'], runRepo), 'edited')
  })
})

test('commitFilesTree keeps runBranch control files and never adds planted ones', async () => {
  await withRepo(async ({ runRepo }) => {
    const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
    await scrubControlPaths(sandbox.cwd)
    await mkdir(path.join(sandbox.cwd, '.cursor'), { recursive: true })
    await writeFile(path.join(sandbox.cwd, '.cursor', 'sandbox.json'), '{"additionalReadwritePaths":["/"]}')
    await writeFile(path.join(sandbox.cwd, 'base.txt'), 'edited\n')
    await commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1' })
    assert.equal(
      await out(['rev-parse', 'fleetmates/r1/T1:.claude/settings.json'], runRepo),
      await out(['rev-parse', 'main:.claude/settings.json'], runRepo),
    )
    const tree = await out(['ls-tree', '-r', '--name-only', 'fleetmates/r1/T1'], runRepo)
    assert.doesNotMatch(tree, /\.cursor/)
  })
})

// Review finding 1: a symlinked control ANCESTOR (`.claude -> ~/.claude`) must never be followed.
test('scrubControlPaths removes a symlinked or non-directory control ancestor without touching its target', async () => {
  await withRepo(async ({ root }) => {
    const cwd = path.join(root, 'ws')
    const home = path.join(root, 'home-claude')
    await mkdir(cwd, { recursive: true })
    await mkdir(home)
    await writeFile(path.join(home, 'settings.json'), 'user')
    await writeFile(path.join(home, 'settings.local.json'), 'user-local')
    await symlink(home, path.join(cwd, '.claude'))
    await writeFile(path.join(cwd, '.cursor'), 'a file, not a dir')
    const found = await scrubControlPaths(cwd)
    assert.deepEqual(found, ['.claude', '.cursor'])
    await assert.rejects(lstat(path.join(cwd, '.claude')), /ENOENT/)
    await assert.rejects(lstat(path.join(cwd, '.cursor')), /ENOENT/)
    assert.equal(await readFile(path.join(home, 'settings.json'), 'utf8'), 'user')
    assert.equal(await readFile(path.join(home, 'settings.local.json'), 'utf8'), 'user-local')
  })
})

// Review finding 2: a file or symlink at a control ancestor must not displace the run branch's
// protected entries beneath it.
test('commitFilesTree keeps protected entries when the checkout replaces their directory with a file or symlink', async () => {
  for (const plant of [
    async (cwd) => writeFile(path.join(cwd, '.claude'), 'file'),
    async (cwd) => symlink('nowhere', path.join(cwd, '.claude')),
  ]) {
    await withRepo(async ({ runRepo }) => {
      const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
      await rm(path.join(sandbox.cwd, '.claude'), { recursive: true, force: true })
      await plant(sandbox.cwd)
      await commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1' })
      const tree = await out(['ls-tree', '-r', 'fleetmates/r1/T1'], runRepo)
      assert.match(tree, /\t\.claude\/settings\.json$/m)
      assert.doesNotMatch(tree, /\t\.claude$/m)
    })
  }
})

test('commitFilesTree never commits a symlinked control ancestor absent from the run branch', async () => {
  await withRepo(async ({ runRepo }) => {
    const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
    await symlink('cfg', path.join(sandbox.cwd, '.cursor'))
    await commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1' })
    assert.doesNotMatch(await out(['ls-tree', '-r', '--name-only', 'fleetmates/r1/T1'], runRepo), /^\.cursor/m)
  })
})

// Review finding 5: a harness that does not scrub (Codex) must not have control-path edits dropped
// silently — `refuseControlChanges` turns them into a refusal naming the paths.
test('commitFilesTree with refuseControlChanges refuses a changed, added or removed control path and commits nothing', async () => {
  for (const [label, change] of [
    ['changed', async (cwd) => writeFile(path.join(cwd, '.claude', 'settings.json'), '{"changed":true}\n')],
    ['added', async (cwd) => { await mkdir(path.join(cwd, '.vscode')); await writeFile(path.join(cwd, '.vscode', 'settings.json'), '{}') }],
    ['removed', async (cwd) => rm(path.join(cwd, '.claude', 'settings.json'))],
  ]) {
    await withRepo(async ({ runRepo }) => {
      const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
      await change(sandbox.cwd)
      await assert.rejects(
        commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1', refuseControlChanges: true }),
        /control-path: /, label,
      )
      const ref = await git(['rev-parse', '--verify', '--quiet', 'refs/heads/fleetmates/r1/T1'], { cwd: runRepo })
      assert.notEqual(ref.code, 0, label)
    })
  }
})

test('commitFilesTree with refuseControlChanges commits when control paths are untouched', async () => {
  await withRepo(async ({ runRepo }) => {
    const sandbox = await makeFilesSandbox(git, { runRepo, runBranch: 'main', runId: 'r1', taskId: 'T1' })
    await writeFile(path.join(sandbox.cwd, 'base.txt'), 'edited\n')
    await commitFilesTree(git, { runRepo, runBranch: 'main', sandbox, branch: 'fleetmates/r1/T1', refuseControlChanges: true })
    assert.equal(await out(['show', 'fleetmates/r1/T1:base.txt'], runRepo), 'edited')
  })
})
