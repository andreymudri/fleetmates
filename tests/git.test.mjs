import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGit, GitError, defaultGitExec, teammateRef, COMMIT_MARKER, classifyHeadRef, fetchTaskBranch, gitDirWritable } from '../scripts/git.mjs'

const recorder = (result = { code: 0, stdout: '', stderr: '' }) => {
  const calls = []
  const exec = async (args) => { calls.push(args); return result }
  return { calls, exec }
}

test('changedFiles diffs the merge base with three dots, NUL-delimited and unquoted', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'a.mjs\0b.mjs\0', stderr: '' })
  const files = await createGit({ cwd: '/x', exec }).changedFiles({ base: 'main', branch: 'tm/1' })
  assert.deepEqual(calls[0], [
    '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z',
    '--end-of-options', 'main...tm/1', '--',
  ])
  assert.deepEqual(files, ['a.mjs', 'b.mjs'])
})

test('changedFiles does not let a leading-dash base reach option position', async () => {
  const { calls, exec } = recorder({ code: 128, stdout: '', stderr: 'bad revision' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: '--output=stolen', branch: 'T1' }),
    GitError,
  )
  assert.deepEqual(calls[0], [
    '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z',
    '--end-of-options', '--output=stolen...T1', '--',
  ])
})

test('changedFiles rejects an empty base string instead of silently diffing against HEAD', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: '', branch: 'task' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('changedFiles rejects an empty branch string instead of silently diffing against HEAD', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: 'main', branch: '' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('changedFiles rejects a non-string branch rather than stringifying it', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: 'main', branch: [] }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('changedFiles rejects a whitespace-only base', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: '   ', branch: 'task' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('changedFiles drops empty NUL-delimited entries', async () => {
  const { exec } = recorder({ code: 0, stdout: 'a.mjs\0\0', stderr: '' })
  assert.deepEqual(await createGit({ exec }).changedFiles({ base: 'm', branch: 'b' }), ['a.mjs'])
})

test('changedFiles does not mangle a non-ASCII path', async () => {
  const { exec } = recorder({ code: 0, stdout: 'café.mjs\0', stderr: '' })
  assert.deepEqual(await createGit({ exec }).changedFiles({ base: 'm', branch: 'b' }), ['café.mjs'])
})

test('changedFiles does not trim a leading-space filename into a different name', async () => {
  const { exec } = recorder({ code: 0, stdout: ' a.mjs\0', stderr: '' })
  assert.deepEqual(await createGit({ exec }).changedFiles({ base: 'm', branch: 'b' }), [' a.mjs'])
})

test('a non-zero exit throws GitError carrying stderr', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'not a git repository' })
  await assert.rejects(
    () => createGit({ exec }).headSha(),
    (err) => err instanceof GitError && /not a git repository/.test(err.message),
  )
})

test('headSha returns the trimmed sha on success', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  assert.equal(await createGit({ exec }).headSha(), 'abc123')
  assert.deepEqual(calls[0], ['rev-parse', 'HEAD'])
})

test('branchExists answers false on exit 1 instead of throwing', async () => {
  const { calls, exec } = recorder({ code: 1, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec }).branchExists('fleetmates/r1/T1'), false)
  assert.deepEqual(calls[0], ['rev-parse', '--verify', '--quiet', 'refs/heads/fleetmates/r1/T1'])
})

test('branchExists throws GitError on exit 128 rather than reporting the branch absent', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'not a git repository' })
  await assert.rejects(
    () => createGit({ exec }).branchExists('fleetmates/r1/T1'),
    (err) => err instanceof GitError && /not a git repository/.test(err.message),
  )
})

test('isDirty is true when porcelain output is non-empty', async () => {
  const { exec } = recorder({ code: 0, stdout: ' M scripts/git.mjs\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), true)
})

test('isDirty is false when porcelain output is empty', async () => {
  const { exec } = recorder({ code: 0, stdout: '\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), false)
})

// The harness creates these for the whole run. Counting them would fail ownership at every
// phase of every fleet, in any repo that has not happened to ignore the path.
test('isDirty ignores the harness worktree directory', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude/\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), false)
})

test('isDirty ignores nested harness worktree paths', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude/worktrees/wf_abc-1/src/x.mjs\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), false)
})

// The exemption is one path, not a licence for untracked files generally.
test('isDirty still reports a stray untracked file alongside harness worktrees', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude/\n?? stray.mjs\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), true)
})

test('isDirty still reports a modified tracked file alongside harness worktrees', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude/\n M scripts/git.mjs\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), true)
})

// A path merely starting with the same letters is not the harness directory.
test('isDirty does not exempt a lookalike path', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude-notes/x.md\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), true)
})

test('currentBranchRef returns the ref HEAD symbolically points at', async () => {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    return { code: 0, stdout: 'refs/heads/run-branch\n', stderr: '' }
  }
  assert.equal(await createGit({ exec }).currentBranchRef(), 'refs/heads/run-branch')
  assert.deepEqual(calls[0], ['symbolic-ref', '--quiet', 'HEAD'])
})

// Verified against the real git installed here (2.55.0): on a detached HEAD, `symbolic-ref
// --quiet HEAD` exits 1 with empty stdout AND empty stderr, while the bare form exits 128
// printing a diagnostic. The empty stderr is what makes detachment distinguishable from a
// failure without parsing any message.
test('currentBranchRef answers null on a detached HEAD rather than throwing', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec }).currentBranchRef(), null)
})

// The stderr here is the real one: running the same command outside a repository was measured
// on that git as exit 128 with `fatal: not a git repository` on stderr.
test('currentBranchRef throws when symbolic-ref fails for a reason that is not detachment', async () => {
  const exec = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository\n' })
  await assert.rejects(() => createGit({ exec }).currentBranchRef(), GitError)
})

// NULL, and specifically not the string `HEAD`. The sentinel this used to assert was a hole:
// `refs/heads/HEAD` is a ref `git update-ref` creates happily, so every caller that prefixed
// `refs/heads/` onto the sentinel resolved a ref an unprivileged teammate can point anywhere.
// The `git branch HEAD` refusal below is what makes the name look reserved when it is not — it
// is `git branch`'s own name check, not a constraint on the ref namespace.
test('currentBranch answers null on a detached HEAD and never a name', async () => {
  const named = async () => ({ code: 0, stdout: 'refs/heads/run-branch\n', stderr: '' })
  assert.equal(await createGit({ exec: named }).currentBranch(), 'run-branch')
  const detached = async () => ({ code: 1, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec: detached }).currentBranch(), null)
})

// The precondition behind that null, measured against real git rather than assumed: the name the
// old sentinel produced denotes a ref that can be CREATED. If this ever starts failing because
// git began rejecting the ref write, the sentinel would still be wrong for the reason above.
test('refs/heads/HEAD is a creatable ref even though git branch refuses the name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    const sha = (await sh(['rev-parse', 'HEAD'])).stdout.trim()
    // `git branch` refuses it, which is the whole reason the name reads as safe.
    assert.notEqual((await sh(['branch', 'HEAD', sha])).code, 0)
    // `update-ref` does not, which is the whole reason it is not.
    assert.equal((await sh(['update-ref', 'refs/heads/HEAD', sha])).code, 0)
    assert.equal((await sh(['rev-parse', '--verify', 'refs/heads/HEAD'])).stdout.trim(), sha)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// A killed process and a detached HEAD are the same three fields once `code` has been defaulted:
// `{code: 1, stdout: '', stderr: ''}`. Measured on this platform, a SIGKILLed child reports
// `code: null, signal: 'SIGKILL'`, so the signal is the only thing that still separates them.
test('currentBranchRef throws rather than reporting detachment when the process was killed', async () => {
  const exec = async () => ({ code: 1, signal: 'SIGKILL', stdout: '', stderr: '' })
  await assert.rejects(() => createGit({ exec }).currentBranchRef(), GitError)
})

// The same collapse in the other reader, and this one is worse: the fallback hands the BARE name
// onward, which git resolves through refs/tags/ before refs/heads/ — reopening the exact
// tag-shadowing hazard qualifyBranch exists to close, for every caller at once.
test('qualifyBranch throws rather than falling back to the bare name when the process was killed', async () => {
  const exec = async (args) => (args[0] === 'rev-parse'
    ? { code: 1, signal: 'SIGKILL', stdout: '', stderr: '' }
    : { code: 0, signal: null, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).addWorktreeDetached('/tmp/whatever', 'run-branch'),
    GitError,
  )
})

// The third reader of the same collapsed shape. `branchExists` reads exit 1 as "no such ref",
// so a killed probe answers a confident false — and callers branch on that to decide a task
// contributed nothing, or to skip a branch entirely.
test('branchExists throws rather than answering false when the process was killed', async () => {
  const exec = async () => ({ code: 1, signal: 'SIGKILL', stdout: '', stderr: '' })
  await assert.rejects(() => createGit({ exec }).branchExists('run-branch'), GitError)
})

// The exact plant from the followups document: three ordinary ref writes, each of which an
// unprivileged teammate can make in its own worktree. Under `--abbrev-ref` they made HEAD's
// name answer `refs/heads/run-branch`, so `refs/heads/` + that name landed on the planted ref
// — the assertions below measure that hijack against the real git rather than assuming it.
// `symbolic-ref` reads HEAD itself, so all three are inert.
test('a tag, a heads/<name> branch and refs/heads/refs/heads/<name> do not redirect the resolved name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  const out = async (args) => (await sh(args)).stdout.trim()
  try {
    await sh(['init', '--initial-branch=run-branch'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    const real = await out(['rev-parse', 'HEAD'])
    // A second commit, then rewound: it gives the plant a sha to redirect the run branch to
    // that is not the sha HEAD actually points at.
    await writeFile(path.join(root, 'other.txt'), 'other\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'other'])
    const planted = await out(['rev-parse', 'HEAD'])
    await sh(['reset', '--hard', real])
    assert.notEqual(planted, real)

    await sh(['tag', 'run-branch', real])
    await sh(['branch', 'heads/run-branch', real])
    await sh(['update-ref', 'refs/heads/refs/heads/run-branch', planted])

    // The plant works against the OLD resolution: abbreviation gives back a name that, once a
    // caller prefixes `refs/heads/`, resolves to the sha the planter chose rather than HEAD's.
    const abbreviated = await out(['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal(abbreviated, 'refs/heads/run-branch')
    assert.equal(await out(['rev-parse', `refs/heads/${abbreviated}`]), planted)

    // Symbolic resolution is unmoved by all three, and its name round-trips back to HEAD.
    assert.equal(await git.currentBranchRef(), 'refs/heads/run-branch')
    assert.equal(await git.currentBranch(), 'run-branch')
    assert.equal(await out(['rev-parse', `refs/heads/${await git.currentBranch()}`]), real)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('against a real repository, changedFiles reports the branch-only change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'task.txt'), 'task\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'task'])

    assert.deepEqual(await git.changedFiles({ base: 'main', branch: 'fleetmates/r1/T1' }), ['task.txt'])
    assert.equal(await git.branchExists('fleetmates/r1/T1'), true)
    assert.equal(await git.branchExists('fleetmates/r1/T9'), false)
    assert.equal(await git.isDirty(), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('changedFiles fails closed instead of resolving the rev string as a pathspec', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])

    // No branch named "ghost" exists, but a file whose name equals the rev string does.
    // Without --end-of-options/--, git resolves "main...ghost" as a pathspec instead of a
    // revision range, exiting 0 with empty output — a silent, false "no changes".
    await writeFile(path.join(root, 'main...ghost'), 'planted\n', 'utf8')

    await assert.rejects(
      () => git.changedFiles({ base: 'main', branch: 'ghost' }),
      GitError,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('changedFiles reports the pre-image path of a rename, not just the post-image', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    // shared.txt belongs to a different task; only mine.txt is in this task's declared set.
    await writeFile(path.join(root, 'shared.txt'), 'shared\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await sh(['mv', 'shared.txt', 'mine.txt'])
    await sh(['commit', '-m', 'rename shared.txt away'])

    const changed = await git.changedFiles({ base: 'main', branch: 'fleetmates/r1/T1' })
    // With rename detection on, git reports only mine.txt (the post-image) and the
    // deletion of shared.txt — a file this task never declared — goes unseen.
    assert.ok(changed.includes('shared.txt'), `pre-image shared.txt missing from ${JSON.stringify(changed)}`)
    assert.ok(changed.includes('mine.txt'), `post-image mine.txt missing from ${JSON.stringify(changed)}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultGitExec rejects with GitError, not a plain Error, when the process cannot be spawned', async () => {
  const missingCwd = path.join(tmpdir(), `tm-git-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await assert.rejects(
    () => defaultGitExec(['status'], missingCwd),
    GitError,
  )
})

// --- mergeBase --------------------------------------------------------------------------

test('mergeBase builds the argv exactly, with no trailing -- (merge-base rejects one)', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  const sha = await createGit({ exec }).mergeBase('a', 'b')
  assert.deepEqual(calls[0], ['merge-base', '--end-of-options', 'a', 'b'])
  assert.equal(sha, 'abc123')
})

test('mergeBase rejects an empty or non-string ref with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).mergeBase('', 'b'), GitError)
  await assert.rejects(() => createGit({ exec }).mergeBase('a', ''), GitError)
  await assert.rejects(() => createGit({ exec }).mergeBase('a', []), GitError)
  assert.deepEqual(calls, [])
})

// The stderr an old git (< 2.24) produces for --end-of-options, which it does not recognise:
// parse-options.c's generic "unknown option" rejection, confirmed against real git by
// substituting an unrecognised long option for --end-of-options and reading its stderr and
// exit code, since the git available to run this suite already accepts --end-of-options and so
// cannot be made to fail this way directly.
const OLD_GIT_STDERR = "error: unknown option `end-of-options'\nusage: git merge-base [-a|--all] <commit> <commit>...\n"

test('mergeBase on a too-old git raises a GitError naming the 2.24 floor, not the raw stderr', async () => {
  const { exec } = recorder({ code: 129, stdout: '', stderr: OLD_GIT_STDERR })
  await assert.rejects(
    () => createGit({ exec }).mergeBase('a', 'b'),
    (err) => err instanceof GitError && /2\.24/.test(err.message) && /too old/.test(err.message),
  )
})

test('a failure unrelated to --end-of-options still reports git\'s raw stderr, not the old-git message', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })
  await assert.rejects(
    () => createGit({ exec }).mergeBase('a', 'b'),
    (err) => err instanceof GitError && !/2\.24/.test(err.message) && /not a git repository/.test(err.message),
  )
})

// --- isAncestor --------------------------------------------------------------------------

test('isAncestor builds the argv exactly, with no trailing --, and returns true on exit 0', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec }).isAncestor('a', 'b'), true)
  assert.deepEqual(calls[0], ['merge-base', '--is-ancestor', '--end-of-options', 'a', 'b'])
})

test('isAncestor returns false on exit 1', async () => {
  const { exec } = recorder({ code: 1, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec }).isAncestor('a', 'b'), false)
})

test('isAncestor throws GitError on exit 128 rather than reporting false', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'bad revision' })
  await assert.rejects(() => createGit({ exec }).isAncestor('a', 'b'), GitError)
})

test('isAncestor on a too-old git raises a GitError naming the 2.24 floor', async () => {
  const { exec } = recorder({ code: 129, stdout: '', stderr: OLD_GIT_STDERR })
  await assert.rejects(
    () => createGit({ exec }).isAncestor('a', 'b'),
    (err) => err instanceof GitError && /2\.24/.test(err.message),
  )
})

test('isAncestor rejects an empty or non-string ref with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).isAncestor('', 'b'), GitError)
  await assert.rejects(() => createGit({ exec }).isAncestor('a', ''), GitError)
  assert.deepEqual(calls, [])
})

// --- mergedBranchTips ----------------------------------------------------------------------

// One walk, unfiltered by --min-parents: the same output has to carry both the range membership
// and the merge parents, because a parent counts only if it is itself inside the range.
test('mergedBranchTips builds the argv with a bounded range and a trailing --', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await createGit({ exec }).mergedBranchTips({ runSha: 'run', anchorSha: 'anchor' })
  assert.deepEqual(calls[0], ['rev-list', '--parents', '--end-of-options', 'anchor..run', '--'])
})

test('mergedBranchTips keeps every parent past the first and drops the merge commit itself', async () => {
  const { exec } = recorder({
    code: 0,
    stdout: 'mergeSha firstParent secondParent\nsecondParent older\nfirstParent older\n\n',
    stderr: '',
  })
  const tips = await createGit({ exec }).mergedBranchTips({ runSha: 'run', anchorSha: 'anchor' })
  assert.deepEqual([...tips].sort(), ['secondParent'])
})

// A parent that the walk never printed as a commit of its own is outside anchor..run, which is
// exactly "reachable from the anchor" — the base tip a plan amendment merge names, and every
// older base tip behind it.
test('mergedBranchTips drops a parent that lies outside the walked range', async () => {
  const { exec } = recorder({ code: 0, stdout: 'mergeSha firstParent anchorSha\nfirstParent older\n', stderr: '' })
  const tips = await createGit({ exec }).mergedBranchTips({ runSha: 'run', anchorSha: 'anchorSha' })
  assert.deepEqual([...tips], [])
})

test('mergedBranchTips rejects an empty or non-string ref with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).mergedBranchTips({ runSha: '', anchorSha: 'a' }), GitError)
  await assert.rejects(() => createGit({ exec }).mergedBranchTips({ runSha: 'r', anchorSha: '' }), GitError)
  await assert.rejects(() => createGit({ exec }).mergedBranchTips({ runSha: 'r', anchorSha: [] }), GitError)
  assert.deepEqual(calls, [])
})

test('against a real repository, mergedBranchTips names what the run branch merged in', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-merged-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  const revParse = async (ref) => (await sh(['rev-parse', ref])).stdout.trim()
  try {
    await sh(['init', '--initial-branch=run'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    const anchorSha = await revParse('HEAD')

    // T1 is integrated with --no-ff: the merge commit names T1's tip as its second parent.
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 't1.txt'), 't1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 't1'])
    const t1Sha = await revParse('HEAD')
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'merge: T1', 'fleetmates/r1/T1'])
    const mergeSha = await revParse('HEAD')

    // T2 is integrated by FAST-FORWARD: no merge commit exists, so no secondary parent does.
    await sh(['checkout', '-b', 'fleetmates/r1/T2'])
    await writeFile(path.join(root, 't2.txt'), 't2\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 't2'])
    const t2Sha = await revParse('HEAD')
    await sh(['checkout', 'run'])
    await sh(['merge', '--ff-only', 'fleetmates/r1/T2'])

    // An octopus merge contributes every parent past the first.
    await sh(['checkout', '-b', 'fleetmates/r1/T3', anchorSha])
    await writeFile(path.join(root, 't3.txt'), 't3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 't3'])
    const t3Sha = await revParse('HEAD')
    await sh(['checkout', '-b', 'fleetmates/r1/T4', anchorSha])
    await writeFile(path.join(root, 't4.txt'), 't4\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 't4'])
    const t4Sha = await revParse('HEAD')
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'merge: T3 and T4', 'fleetmates/r1/T3', 'fleetmates/r1/T4'])
    const runSha = await revParse('HEAD')

    const tips = await git.mergedBranchTips({ runSha, anchorSha })
    assert.ok(tips.has(t1Sha), 'a --no-ff merged branch tip is in the set')
    assert.ok(tips.has(t3Sha) && tips.has(t4Sha), 'every octopus parent past the first is in the set')
    assert.ok(!tips.has(t2Sha), 'a fast-forwarded branch tip leaves no secondary parent')
    assert.ok(!tips.has(mergeSha), 'a commit on the run branch that is not a merge parent is not in the set')
    assert.ok(!tips.has(runSha), 'the run tip itself is not in the set')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// The set has to answer "which BRANCHES did the run branch merge in", and a plan amendment
// merges the BASE into the run branch — so the base tip is a secondary parent of a merge inside
// the range. For a run whose amendments have all landed, merge-base(base, run) IS that base tip,
// which would put the anchor itself in the set. A task branch parked at the anchor (a teammate
// that committed on another ref and left the conventional ref where `git checkout -B <task>
// <base>` put it) would then read as merged, and the emptiness complaint it exists for would be
// suppressed. Anything reachable from the anchor is likewise not a branch this run carried: an
// older base tip reaches the set the same way, via a task branch that merged the base into
// itself. The range bounds which MERGE COMMITS are walked; it does not filter their parents,
// which is why the parents are filtered explicitly.
test('against a real repository, mergedBranchTips excludes the anchor and everything behind it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-amend-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  const revParse = async (ref) => (await sh(['rev-parse', ref])).stdout.trim()
  try {
    await sh(['init', '--initial-branch=master'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'c1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'c1'])
    const c1 = await revParse('HEAD')

    // The run forks here, so neither later base commit is an ancestor of it.
    await sh(['checkout', '-b', 'run'])
    await writeFile(path.join(root, 'run.txt'), 'r1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'r1'])

    await sh(['checkout', 'master'])
    await writeFile(path.join(root, 'base.txt'), 'c2\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'c2'])
    const c2 = await revParse('HEAD')
    await writeFile(path.join(root, 'base.txt'), 'c3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'c3'])
    const c3 = await revParse('HEAD')

    // A task branch that merged the base into itself: c2 becomes a printed secondary parent of
    // a merge that is itself inside the range.
    await sh(['checkout', '-b', 'fleetmates/r1/T1', 'run'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['merge', '--no-ff', '-m', 'merge base into T1', c2])
    const t1Sha = await revParse('HEAD')
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'merge: T1', 'fleetmates/r1/T1'])

    // The plan amendment: the base is merged into the run branch, so the base tip is a
    // secondary parent and the anchor lands exactly on it.
    await sh(['merge', '--no-ff', '-m', 'merge: plan amendment', 'master'])
    const runSha = await revParse('HEAD')
    const anchorSha = (await sh(['merge-base', 'master', 'run'])).stdout.trim()
    assert.equal(anchorSha, c3, 'fixture: the anchor is the base tip once the amendment has landed')

    const tips = await git.mergedBranchTips({ runSha, anchorSha })
    assert.ok(tips.has(t1Sha), 'a genuinely merged task branch is still in the set')
    assert.ok(!tips.has(anchorSha), 'the anchor is not a branch this run merged in')
    assert.ok(!tips.has(c2), 'an older base tip, reachable from the anchor, is not either')
    assert.ok(!tips.has(c1), 'nor is anything further behind it')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- commitsBetween ------------------------------------------------------------------------

test('commitsBetween builds the argv with a trailing --, and drops blank lines', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'sha1\nsha2\n\n', stderr: '' })
  const shas = await createGit({ exec }).commitsBetween({ from: 'a', to: 'b' })
  assert.deepEqual(calls[0], ['rev-list', '--end-of-options', 'a..b', '--'])
  assert.deepEqual(shas, ['sha1', 'sha2'])
})

test('commitsBetween rejects an empty or non-string from/to with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitsBetween({ from: '', to: 'b' }), GitError)
  await assert.rejects(() => createGit({ exec }).commitsBetween({ from: 'a', to: '' }), GitError)
  assert.deepEqual(calls, [])
})

// --- commitParents ------------------------------------------------------------------------

test('commitParents builds the argv with a trailing --, and slices the sha off the front', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'child parent1 parent2\n', stderr: '' })
  const parents = await createGit({ exec }).commitParents('child')
  assert.deepEqual(calls[0], ['rev-list', '--parents', '-n', '1', '--end-of-options', 'child', '--'])
  assert.deepEqual(parents, ['parent1', 'parent2'])
})

test('commitParents rejects an empty or non-string sha with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitParents(''), GitError)
  await assert.rejects(() => createGit({ exec }).commitParents([]), GitError)
  assert.deepEqual(calls, [])
})

// --- branchSha -----------------------------------------------------------------------------

test('branchSha prefixes refs/heads/ and adds a trailing --', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  const sha = await createGit({ exec }).branchSha('fleetmates/r1/T1')
  assert.deepEqual(calls[0], ['rev-parse', '--verify', '--end-of-options', 'refs/heads/fleetmates/r1/T1', '--'])
  assert.equal(sha, 'abc123')
})

test('branchSha rejects an empty or non-string name with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).branchSha(''), GitError)
  await assert.rejects(() => createGit({ exec }).branchSha(null), GitError)
  assert.deepEqual(calls, [])
})

// --- fileAtCommit ----------------------------------------------------------------------------

test('fileAtCommit builds the argv with a trailing --', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'file contents\n', stderr: '' })
  const contents = await createGit({ exec }).fileAtCommit('sha1', 'docs/plan.md')
  assert.deepEqual(calls[0], ['show', '--end-of-options', 'sha1:docs/plan.md', '--'])
  assert.equal(contents, 'file contents\n')
})

test('fileAtCommit rejects an empty or non-string sha/path with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).fileAtCommit('', 'a.md'), GitError)
  await assert.rejects(() => createGit({ exec }).fileAtCommit('sha1', ''), GitError)
  assert.deepEqual(calls, [])
})

test('fileAtCommit on a too-old git raises a GitError naming the 2.24 floor', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'fatal: unrecognized argument: --end-of-options\n' })
  await assert.rejects(
    () => createGit({ exec }).fileAtCommit('sha1', 'docs/plan.md'),
    (err) => err instanceof GitError && /2\.24/.test(err.message) && /too old/.test(err.message),
  )
})

test('a failure unrelated to --end-of-options in the "unrecognized argument" family still reports git\'s raw stderr', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'fatal: bad object sha1' })
  await assert.rejects(
    () => createGit({ exec }).fileAtCommit('sha1', 'docs/plan.md'),
    (err) => err instanceof GitError && !/2\.24/.test(err.message) && /bad object sha1/.test(err.message),
  )
})

// --- fileModeAtCommit ------------------------------------------------------------------------

test('fileModeAtCommit builds the argv with the path after -- and returns the six-digit mode', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '100755 blob ceec3a7\thooks/run-hook.cmd\n', stderr: '' })
  const mode = await createGit({ exec }).fileModeAtCommit('sha1', 'hooks/run-hook.cmd')
  assert.deepEqual(calls[0], ['ls-tree', '--end-of-options', 'sha1', '--', 'hooks/run-hook.cmd'])
  assert.equal(mode, '100755')
})

// `ls-tree` exits 0 with empty output for a path that is not in the tree, so absence has to be
// read off the output rather than caught as a GitError. null, never '' — an empty string would
// compare equal to a real answer nowhere, but it reads as "a mode I found" to a caller.
test('fileModeAtCommit returns null when the path is absent at that commit', async () => {
  const { exec } = recorder({ code: 0, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec }).fileModeAtCommit('sha1', 'gone.md'), null)
})

test('fileModeAtCommit rejects an empty or non-string sha/path with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).fileModeAtCommit('', 'a.md'), GitError)
  await assert.rejects(() => createGit({ exec }).fileModeAtCommit('sha1', ''), GitError)
  assert.deepEqual(calls, [])
})

test('fileModeAtCommit on a too-old git raises a GitError naming the 2.24 floor', async () => {
  const { exec } = recorder({ code: 129, stdout: '', stderr: "error: unknown option `end-of-options'\n" })
  await assert.rejects(
    () => createGit({ exec }).fileModeAtCommit('sha1', 'a.md'),
    (err) => err instanceof GitError && /2\.24/.test(err.message) && /too old/.test(err.message),
  )
})

// --- resolveRef ------------------------------------------------------------------------------

test('resolveRef builds the argv exactly and returns the trimmed sha', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  const sha = await createGit({ exec }).resolveRef('refs/heads/fleetmates/r1/T1')
  assert.deepEqual(calls[0], ['rev-parse', '--verify', '--end-of-options', 'refs/heads/fleetmates/r1/T1', '--'])
  assert.equal(sha, 'abc123')
})

test('resolveRef rejects a ref that is not fully qualified', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).resolveRef('fleetmates/r1/T1'), GitError)
  await assert.rejects(() => createGit({ exec }).resolveRef(''), GitError)
  await assert.rejects(() => createGit({ exec }).resolveRef(null), GitError)
  assert.deepEqual(calls, [])
})

// --- fetchRefspec ----------------------------------------------------------------------------

test('fetchRefspec builds the argv with --no-tags and returns the resolved dst sha', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  const sha = await createGit({ exec }).fetchRefspec({
    from: '/path/to/clone',
    src: 'refs/heads/fleetmates/r1/T1',
    dst: 'refs/fleetmates/r1/T1',
  })
  assert.deepEqual(calls[0], [
    'fetch', '--no-tags', '--end-of-options', '/path/to/clone',
    '+refs/heads/fleetmates/r1/T1:refs/fleetmates/r1/T1',
  ])
  assert.deepEqual(calls[1], ['rev-parse', '--verify', '--end-of-options', 'refs/fleetmates/r1/T1', '--'])
  assert.equal(sha, 'abc123')
})

test('fetchRefspec rejects an unqualified src or dst', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(
    () => createGit({ exec }).fetchRefspec({ from: '/x', src: 'fleetmates/r1/T1', dst: 'refs/fleetmates/r1/T1' }),
    GitError,
  )
  await assert.rejects(
    () => createGit({ exec }).fetchRefspec({ from: '/x', src: 'refs/heads/fleetmates/r1/T1', dst: 'fleetmates/r1/T1' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('fetchRefspec rejects an empty from/src/dst', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(
    () => createGit({ exec }).fetchRefspec({ from: '', src: 'refs/heads/a', dst: 'refs/fleetmates/a' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

// --- teammateRef -------------------------------------------------------------------------

test('teammateRef names the orchestrator-only namespace', () => {
  assert.equal(teammateRef('r1', 'T1'), 'refs/fleetmates/r1/T1')
})

// --- real-git regression: tag shadowing ---------------------------------------------------

test('resolveRef reads the branch tip even when a tag of the same name shadows it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-shadow-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    const baseSha = (await git.headSha())

    // The branch under test carries a real, honest change.
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'task.txt'), 'task\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'task'])
    const branchSha = (await git.headSha())

    // A teammate plants a tag with the SAME NAME as its branch, pointing at the earlier,
    // unchanged commit. A bare-name lookup ("fleetmates/r1/T1") resolves through refs/tags/
    // BEFORE refs/heads/, so `git diff <anchor>...fleetmates/r1/T1` would report NO changes
    // — the pass signal — while the branch itself still carries the honest task.txt change.
    await sh(['tag', 'fleetmates/r1/T1', baseSha])

    // A bare-name diff is fooled by the tag: it reports no changes at all.
    const shadowedDiff = await defaultGitExec(
      ['diff', '--name-only', 'main...fleetmates/r1/T1'], root,
    )
    assert.equal(shadowedDiff.stdout.trim(), '', 'expected the bare-name diff to be shadowed by the tag')

    // resolveRef, given the fully-qualified branch ref, is immune: it must resolve to the
    // branch's real tip, not the tag's, and a diff by that resolved sha must see task.txt.
    const resolved = await git.resolveRef('refs/heads/fleetmates/r1/T1')
    assert.equal(resolved, branchSha, 'resolveRef must report the honest branch tip, not the shadowing tag')
    assert.notEqual(resolved, baseSha)

    const changed = await git.changedFiles({ base: 'main', branch: resolved })
    assert.deepEqual(changed, ['task.txt'], 'diffing by the resolved sha must see the branch change the tag hid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- addWorktreeDetached --------------------------------------------------------------------

test('addWorktreeDetached resolves the name through refs/heads/ before worktree add', async () => {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaa111\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const dir = await createGit({ exec }).addWorktreeDetached('/tmp/wt', 'fleetmates/r1/T1')
  assert.deepEqual(calls[0], [
    'rev-parse', '--verify', '--quiet', '--end-of-options', 'refs/heads/fleetmates/r1/T1', '--',
  ])
  // The sha, never the bare name: a tag named fleetmates/r1/T1 must not be what gets checked out.
  assert.deepEqual(calls[1], ['worktree', 'add', '--detach', '--end-of-options', '/tmp/wt', 'aaaa111'])
  assert.equal(dir, '/tmp/wt')
})

test('addWorktreeDetached falls back to the given ref when no such branch exists', async () => {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  await createGit({ exec }).addWorktreeDetached('/tmp/wt', 'deadbeef')
  assert.deepEqual(calls[1], ['worktree', 'add', '--detach', '--end-of-options', '/tmp/wt', 'deadbeef'])
})

test('addWorktreeDetached passes an already-qualified ref through untouched', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await createGit({ exec }).addWorktreeDetached('/tmp/wt', 'refs/fleetmates/r1/T1')
  assert.deepEqual(calls[0], [
    'worktree', 'add', '--detach', '--end-of-options', '/tmp/wt', 'refs/fleetmates/r1/T1',
  ])
})

test('addWorktreeDetached rejects an empty or non-string dir/ref with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).addWorktreeDetached('', 'ref'), GitError)
  await assert.rejects(() => createGit({ exec }).addWorktreeDetached('dir', ''), GitError)
  await assert.rejects(() => createGit({ exec }).addWorktreeDetached('dir', []), GitError)
  assert.deepEqual(calls, [])
})

// --- removeWorktree ----------------------------------------------------------------------

test('removeWorktree issues worktree remove --force --end-of-options <dir>', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  const ok = await createGit({ exec }).removeWorktree('/tmp/wt')
  assert.deepEqual(calls[0], ['worktree', 'remove', '--force', '--end-of-options', '/tmp/wt'])
  assert.equal(ok, true)
})

test('removeWorktree rejects an empty dir with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).removeWorktree(''), GitError)
  assert.deepEqual(calls, [])
})

// --- deleteBranch --------------------------------------------------------------------------

test('deleteBranch removes a branch and reports a name that is not there', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-delbranch-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['branch', 'scratch'])

    await git.deleteBranch('scratch')
    assert.equal(await git.branchExists('scratch'), false)
    await assert.rejects(() => git.deleteBranch('scratch'), (err) => err instanceof GitError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deleteBranch refuses an empty name without asking git', async () => {
  const git = createGit({ cwd: '.', exec: async () => { throw new Error('git must not be called') } })
  await assert.rejects(() => git.deleteBranch(''), (err) => err instanceof GitError)
})

// The case the -D exists for, which the test above cannot see: `task` is merged into the run
// branch and `isAncestor` says so — that is the entire authorisation the caller has — but HEAD
// is parked on `main`, which does not contain it. `git branch -d task` answers "not fully
// merged" there (asserted below, not assumed), so a `-d` here would refuse every branch
// prune-run just proved merged whenever the operator stands anywhere but the run branch.
test('deleteBranch deletes a branch merged into the run branch while HEAD sits on another', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-delbranch-force-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'runbr'])
    await sh(['checkout', '-b', 'task'])
    await writeFile(path.join(root, 'task.txt'), 'task\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'task work'])
    await sh(['checkout', 'runbr'])
    await sh(['merge', '--no-ff', '-m', 'merge task', 'task'])
    // HEAD ends up anywhere but the run branch — the operator's own checkout, which prune-run
    // does not control.
    await sh(['checkout', 'main'])

    // The caller's proof holds: task IS merged into the run branch.
    assert.equal(await git.isAncestor('task', 'runbr'), true)
    // And `-d` refuses it anyway, measuring against HEAD instead. Without this the assertion
    // below proves nothing about the flag.
    const refused = await sh(['branch', '-d', '--end-of-options', 'task'])
    assert.notEqual(refused.code, 0)
    assert.equal(await git.branchExists('task'), true)

    // Bare names only, the cost of skipping qualifyBranch: the argument reaches `git branch -D`
    // as written, and an already-qualified ref is simply not found.
    await assert.rejects(() => git.deleteBranch('refs/heads/task'), (err) => err instanceof GitError)
    assert.equal(await git.branchExists('task'), true)

    assert.equal(await git.deleteBranch('task'), true)
    assert.equal(await git.branchExists('task'), false)
    // -D deletes the ref, not the work: the merge commit on runbr still carries it.
    assert.equal(await git.branchExists('runbr'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// The limit of that force, pinned so the comment cannot outgrow it: -D is not omnipotent. A
// branch still checked out in a worktree is refused by git itself, and deleteBranch surfaces
// that as a GitError rather than reporting a deletion that did not happen.
test('deleteBranch still fails on a branch checked out in another worktree', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-delbranch-wt-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['branch', 'parked'])
    await sh(['worktree', 'add', path.join(root, 'wt'), 'parked'])

    await assert.rejects(() => git.deleteBranch('parked'), (err) => err instanceof GitError)
    assert.equal(await git.branchExists('parked'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- mergeInto -----------------------------------------------------------------------------

// One merge per branch, each resolved through refs/heads/ first. Handing git three or more
// heads at once selects the octopus strategy, which resets the index before exiting and so
// destroys the conflicted set the gate has to report.
const mergeMock = ({ mergeResults = {}, unmerged = '', resolve = (n) => `sha-${n}` } = {}) => {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    if (args.includes('rev-parse')) {
      const ref = args[args.length - 2]
      const name = ref.replace(/^refs\/heads\//, '')
      const sha = resolve(name)
      return sha ? { code: 0, stdout: `${sha}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
    }
    if (args.includes('merge')) return mergeResults[args[args.length - 1]] ?? { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: unmerged, stderr: '' }
  }
  return { calls, exec }
}

test('mergeInto merges one branch at a time and returns null when each exits 0', async () => {
  const { calls, exec } = mergeMock()
  const result = await createGit({ exec }).mergeInto('/tmp/wt', ['fleetmates/r1/T1', 'fleetmates/r1/T2'])
  assert.equal(result, null)
  assert.deepEqual(calls[0], [
    '-C', '/tmp/wt', 'rev-parse', '--verify', '--quiet', '--end-of-options',
    'refs/heads/fleetmates/r1/T1', '--',
  ])
  assert.deepEqual(calls[1], [
    '-C', '/tmp/wt', 'merge', '--no-ff', '-m', 'gate merge preview', '--end-of-options',
    'sha-fleetmates/r1/T1',
  ])
  assert.deepEqual(calls[3], [
    '-C', '/tmp/wt', 'merge', '--no-ff', '-m', 'gate merge preview', '--end-of-options',
    'sha-fleetmates/r1/T2',
  ])
})

test('mergeInto rejects an empty or non-string dir with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).mergeInto('', ['b']), GitError)
  assert.deepEqual(calls, [])
})

test('mergeInto rejects a missing or non-string branch list with GitError', async () => {
  const { calls, exec } = recorder()
  const git = createGit({ exec })
  await assert.rejects(() => git.mergeInto('/tmp/wt'), GitError)
  await assert.rejects(() => git.mergeInto('/tmp/wt', []), GitError)
  await assert.rejects(() => git.mergeInto('/tmp/wt', ['a', '']), GitError)
  await assert.rejects(() => git.mergeInto('/tmp/wt', 'a'), GitError)
  assert.deepEqual(calls, [])
})

test('mergeInto returns the conflicted paths instead of throwing when the merge exits non-zero', async () => {
  const { calls, exec } = mergeMock({
    mergeResults: { 'sha-a': { code: 1, stdout: '', stderr: 'CONFLICT' } },
    unmerged: 'shared.txt\nother.txt\n',
  })
  const result = await createGit({ exec }).mergeInto('/tmp/wt', ['a', 'b'])
  assert.deepEqual(result, ['shared.txt', 'other.txt'])
  assert.deepEqual(calls[2], ['-C', '/tmp/wt', 'diff', '--name-only', '--diff-filter=U'])
})

test('mergeInto throws a GitError carrying stderr when a merge fails with nothing unmerged', async () => {
  const { exec } = mergeMock({
    mergeResults: { 'sha-a': { code: 128, stdout: '', stderr: '*** Please tell me who you are.\nCommitter identity unknown' } },
    unmerged: '',
  })
  // An empty array is truthy: reporting one here would name a conflict with no paths and no
  // reason. The failure must surface as a failure, with git's own words.
  await assert.rejects(
    () => createGit({ exec }).mergeInto('/tmp/wt', ['a', 'b']),
    (err) => {
      assert.ok(err instanceof GitError)
      assert.match(err.message, /Committer identity unknown/)
      assert.match(err.message, /\ba\b/)
      return true
    },
  )
})

test('mergeInto on a too-old git raises a GitError naming the 2.24 floor instead of a bare merge failure', async () => {
  const { exec } = mergeMock({
    mergeResults: { 'sha-a': { code: 129, stdout: '', stderr: OLD_GIT_STDERR } },
    unmerged: '',
  })
  await assert.rejects(
    () => createGit({ exec }).mergeInto('/tmp/wt', ['a', 'b']),
    (err) => err instanceof GitError && /2\.24/.test(err.message) && /too old/.test(err.message),
  )
})

// --- real-repository: mergeInto -------------------------------------------------------------

test('against a real repository, mergeInto merges cleanly across different files and reports conflicts on the same line', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-merge-'))
  const wtCleanDir = await mkdtemp(path.join(tmpdir(), 'tm-git-merge-wt-clean-'))
  const wtConflictDir = await mkdtemp(path.join(tmpdir(), 'tm-git-merge-wt-conflict-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'shared.txt'), 'base\n', 'utf8')
    await writeFile(path.join(root, 'other.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])

    // Two branches that touch different files merge cleanly.
    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'a.txt'), 'a\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'add a.txt'])
    await sh(['checkout', 'main'])

    await sh(['checkout', '-b', 'fleetmates/r1/T2'])
    await writeFile(path.join(root, 'b.txt'), 'b\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'add b.txt'])
    await sh(['checkout', 'main'])

    await sh(['worktree', 'add', '--detach', '--end-of-options', wtCleanDir, 'main'])
    const cleanResult = await git.mergeInto(wtCleanDir, ['fleetmates/r1/T1', 'fleetmates/r1/T2'])
    assert.equal(cleanResult, null)
    await sh(['worktree', 'remove', '--force', '--end-of-options', wtCleanDir])

    // Two branches that edit the same line conflict, and reporting that must not throw.
    await sh(['checkout', '-b', 'fleetmates/r1/T3'])
    await writeFile(path.join(root, 'shared.txt'), 'from-t3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'edit shared.txt on T3'])
    await sh(['checkout', 'main'])

    await sh(['checkout', '-b', 'fleetmates/r1/T4'])
    await writeFile(path.join(root, 'shared.txt'), 'from-t4\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'edit shared.txt on T4'])
    await sh(['checkout', 'main'])

    await sh(['worktree', 'add', '--detach', '--end-of-options', wtConflictDir, 'main'])
    const conflictResult = await git.mergeInto(wtConflictDir, ['fleetmates/r1/T3', 'fleetmates/r1/T4'])
    assert.deepEqual(conflictResult, ['shared.txt'])
  } finally {
    await rm(wtCleanDir, { recursive: true, force: true })
    await rm(wtConflictDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// --- real-git regression: a tag must not shadow a branch on the way into the preview -------

test('against a real repository, mergeInto and addWorktreeDetached take the branch tip even when a tag of the same name shadows it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-mshadow-'))
  const mergeDir = await mkdtemp(path.join(tmpdir(), 'tm-git-mshadow-wt-'))
  const checkoutDir = await mkdtemp(path.join(tmpdir(), 'tm-git-mshadow-co-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  const present = async (dir, file) => {
    try {
      await readFile(path.join(dir, file), 'utf8')
      return true
    } catch {
      return false
    }
  }
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    const forkPoint = (await git.headSha())

    await sh(['checkout', '-b', 'fleetmates/r1/T1'])
    await writeFile(path.join(root, 'work.txt'), 'work\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'the teammate work'])
    await sh(['checkout', 'main'])

    // One ordinary command inside the teammate's own worktree. --end-of-options stops flag
    // injection but not namespace precedence: git resolves a bare name through refs/tags/
    // BEFORE refs/heads/, warns on stderr only, and exits 0.
    await sh(['tag', 'fleetmates/r1/T1', forkPoint])

    // The trap, demonstrated: a bare-name merge takes the tag and reports "Already up to date",
    // so the preview would be built from a tree with none of the teammate's work in it.
    await sh(['worktree', 'add', '--detach', '--end-of-options', mergeDir, 'main'])
    const bare = await defaultGitExec(
      ['-C', mergeDir, 'merge', '--no-ff', '-m', 'bare', '--end-of-options', 'fleetmates/r1/T1'], root,
    )
    assert.equal(bare.code, 0, 'the bare-name merge is expected to succeed against the tag')
    assert.equal(await present(mergeDir, 'work.txt'), false, 'the bare name is expected to merge the tag, not the branch')
    await sh(['worktree', 'remove', '--force', '--end-of-options', mergeDir])

    // mergeInto must be immune: it resolves the branch name through refs/heads/ first, so the
    // preview really does carry the teammate's commit and `npm test` runs against their code.
    await git.addWorktreeDetached(mergeDir, 'main')
    const result = await git.mergeInto(mergeDir, ['fleetmates/r1/T1'])
    assert.equal(result, null)
    assert.equal(await present(mergeDir, 'work.txt'), true, 'mergeInto must merge the branch tip the tag hid')

    // addWorktreeDetached must resolve the same way when it checks the branch out directly.
    await git.addWorktreeDetached(checkoutDir, 'fleetmates/r1/T1')
    assert.equal(await present(checkoutDir, 'work.txt'), true, 'addWorktreeDetached must check out the branch tip, not the tag')
  } finally {
    await rm(mergeDir, { recursive: true, force: true })
    await rm(checkoutDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// --- real-git regression: three or more branches (the octopus reset) -----------------------

test('against a real repository, a conflict across three branches reports the conflicted paths rather than an empty list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-octopus-'))
  const wtDir = await mkdtemp(path.join(tmpdir(), 'tm-git-octopus-wt-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'shared.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])

    for (const id of ['T1', 'T2', 'T3']) {
      await sh(['checkout', 'main'])
      await sh(['checkout', '-b', `fleetmates/r1/${id}`])
      await writeFile(path.join(root, 'shared.txt'), `from-${id}\n`, 'utf8')
      await sh(['add', '.'])
      await sh(['commit', '-m', `edit shared.txt on ${id}`])
    }
    await sh(['checkout', 'main'])

    // Handing git all three heads at once selects the octopus strategy, which resets the
    // working tree and index BEFORE exiting: nothing is left carrying U status, so a
    // --diff-filter=U reading of that failure comes back empty and the gate reports a
    // conflict that names nothing.
    await sh(['worktree', 'add', '--detach', '--end-of-options', wtDir, 'main'])
    const octopus = await defaultGitExec(
      ['-C', wtDir, 'merge', '--no-ff', '-m', 'octopus', '--end-of-options',
        'fleetmates/r1/T1', 'fleetmates/r1/T2', 'fleetmates/r1/T3'], root,
    )
    assert.notEqual(octopus.code, 0)
    const afterOctopus = await defaultGitExec(['-C', wtDir, 'diff', '--name-only', '--diff-filter=U'], root)
    assert.equal(afterOctopus.stdout.trim(), '', 'the octopus failure is expected to leave no unmerged paths')

    const result = await git.mergeInto(wtDir, ['fleetmates/r1/T1', 'fleetmates/r1/T2', 'fleetmates/r1/T3'])
    assert.deepEqual(result, ['shared.txt'], 'a three-branch conflict must still name the file it conflicted on')
  } finally {
    await rm(wtDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// --- real-git regression: a merge failure is not a conflict --------------------------------

test('against a real repository, a merge that fails without conflicting throws instead of reporting an empty conflict', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-mfail-'))
  const wtDir = await mkdtemp(path.join(tmpdir(), 'tm-git-mfail-wt-'))
  const otherRoot = await mkdtemp(path.join(tmpdir(), 'tm-git-mfail-other-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['worktree', 'add', '--detach', '--end-of-options', wtDir, 'main'])

    // A branch that no longer exists: git exits non-zero with "not something we can merge"
    // and leaves nothing unmerged. Reported as a conflict it would be an empty list and a
    // discarded reason; it has to arrive as a failure carrying git's own words.
    await assert.rejects(
      () => git.mergeInto(wtDir, ['fleetmates/r1/deleted']),
      (err) => {
        assert.ok(err instanceof GitError)
        assert.match(err.message, /not something we can merge|did not match any|unknown revision/i)
        return true
      },
    )

    // An unrelated-histories merge fails the same way and must not read as a conflict either.
    const shOther = (args) => defaultGitExec(args, otherRoot)
    await shOther(['init', '--initial-branch=main'])
    await shOther(['config', 'user.email', 'test@example.com'])
    await shOther(['config', 'user.name', 'test'])
    await writeFile(path.join(otherRoot, 'elsewhere.txt'), 'elsewhere\n', 'utf8')
    await shOther(['add', '.'])
    await shOther(['commit', '-m', 'unrelated base'])
    await sh(['fetch', '--no-tags', '--end-of-options', otherRoot, '+refs/heads/main:refs/heads/unrelated'])

    await assert.rejects(
      () => git.mergeInto(wtDir, ['unrelated']),
      (err) => {
        assert.ok(err instanceof GitError)
        assert.match(err.message, /unrelated histories/i)
        return true
      },
    )
  } finally {
    await rm(wtDir, { recursive: true, force: true })
    await rm(otherRoot, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// --- doctor primitives ----------------------------------------------------------------------

test('worktrees parses the porcelain listing into path, branch and detached state', async () => {
  const { calls, exec } = recorder({
    code: 0,
    stdout: [
      'worktree C:/repo', 'HEAD abc123', 'branch refs/heads/run/r1', '',
      'worktree C:/repo/.claude/worktrees/agent-1', 'HEAD def456', 'branch refs/heads/fleetmates/r1/T1', '',
      'worktree C:/tmp/preview', 'HEAD 999999', 'detached', '',
    ].join('\n'),
    stderr: '',
  })
  const list = await createGit({ cwd: '/x', exec }).worktrees()
  assert.deepEqual(calls[0], ['worktree', 'list', '--porcelain'])
  assert.deepEqual(list, [
    { path: 'C:/repo', head: 'abc123', branch: 'run/r1', detached: false },
    { path: 'C:/repo/.claude/worktrees/agent-1', head: 'def456', branch: 'fleetmates/r1/T1', detached: false },
    { path: 'C:/tmp/preview', head: '999999', branch: null, detached: true },
  ])
})

// The main worktree's own entry has no trailing blank line when it is the only one, and git
// emits `bare` instead of a HEAD for a bare repository. Neither may drop an entry or invent one.
test('worktrees handles a single entry with no trailing blank line', async () => {
  const { exec } = recorder({ code: 0, stdout: 'worktree C:/repo\nHEAD abc123\nbranch refs/heads/main\n', stderr: '' })
  const list = await createGit({ exec }).worktrees()
  assert.deepEqual(list, [{ path: 'C:/repo', head: 'abc123', branch: 'main', detached: false }])
})

// isDirty answers yes/no for the ownership check; the diagnostic needs to say WHICH paths, or
// the operator is left running `git status` by hand — the thing this command exists to replace.
// The same `.claude/` exemption applies, for the same reason: the plugin chose that location.
test('dirtyPaths lists the porcelain entries and exempts the harness worktree directory', async () => {
  const { calls, exec } = recorder({
    code: 0,
    stdout: ' M scripts/cli.mjs\n?? .claude/worktrees/agent-1/x.txt\n?? stray.txt\n',
    stderr: '',
  })
  const paths = await createGit({ exec }).dirtyPaths()
  assert.deepEqual(calls[0], ['-c', 'core.quotePath=false', 'status', '--porcelain'])
  assert.deepEqual(paths, [
    { status: ' M', path: 'scripts/cli.mjs' },
    { status: '??', path: 'stray.txt' },
  ])
})

test('commitSubject returns the short sha and subject of a ref', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc1234 fix(gate): something\n', stderr: '' })
  const subject = await createGit({ exec }).commitSubject('refs/heads/fleetmates/r1/T1')
  assert.deepEqual(calls[0], [
    'log', '-n', '1', '--format=%h %s', '--end-of-options', 'refs/heads/fleetmates/r1/T1', '--',
  ])
  assert.equal(subject, 'abc1234 fix(gate): something')
})

test('commitSubject rejects an empty ref rather than reporting HEAD', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitSubject(''), GitError)
  assert.deepEqual(calls, [])
})

// The stderr an old git (< 2.24) produces for --end-of-options on `log` and `show` specifically:
// not the "unknown option" line merge-base/fetch/worktree/merge use, but parse-options.c's
// other rejection shape, `fatal: unrecognized argument: <name>`, exit 128 — confirmed against
// real git the same way as OLD_GIT_STDERR, substituting an unrecognised long option into `git
// log` and `git show` at this module's exact call shape and reading the real result.
const OLD_GIT_LOG_SHOW_STDERR = 'fatal: unrecognized argument: --end-of-options\n'

test('commitSubject on a too-old git raises a GitError naming the 2.24 floor', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: OLD_GIT_LOG_SHOW_STDERR })
  await assert.rejects(
    () => createGit({ exec }).commitSubject('refs/heads/fleetmates/r1/T1'),
    (err) => err instanceof GitError && /2\.24/.test(err.message) && /too old/.test(err.message),
  )
})

test('commitTime returns the committer date in milliseconds for a resolved sha', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '1700000000\n', stderr: '' })
  const at = await createGit({ exec }).commitTime('abc1234abc1234abc1234abc1234abc1234abcd')
  assert.deepEqual(calls[0], [
    'log', '-n', '1', '--format=%ct', '--end-of-options', 'abc1234abc1234abc1234abc1234abc1234abcd', '--',
  ])
  assert.equal(at, 1700000000000)
})

test('commitTime rejects an empty sha rather than reporting HEAD', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitTime(''), GitError)
  assert.deepEqual(calls, [])
})

test('commitTime rejects a non-string sha rather than stringifying it', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitTime(null), GitError)
  await assert.rejects(() => createGit({ exec }).commitTime(['refs/heads/x']), GitError)
  assert.deepEqual(calls, [])
})

// An unparseable date must not become NaN and travel on: a caller subtracting it from the clock
// gets NaN, which compares false against every threshold, so a stall would read as fresh.
test('commitTime rejects a non-numeric committer date instead of returning NaN', async () => {
  const { exec } = recorder({ code: 0, stdout: 'not-a-date\n', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).commitTime('abc1234'),
    (err) => err instanceof GitError && /non-numeric committer date/.test(err.message),
  )
})

// The non-numeric guard above does NOT cover the empty string: `Number('')` is `0`, which is
// finite, so an empty `%ct` slipped through and returned epoch 0. `livenessRows` subtracts that
// from the clock and reports a tip roughly fifty-six years stale — a `stalled` row and exit 1 for
// a teammate that is fine. Whitespace-only output is the same shape after `.trim()`.
test('commitTime rejects an empty committer date instead of dating the commit to the epoch', async () => {
  for (const stdout of ['\n', '   \n']) {
    const { exec } = recorder({ code: 0, stdout, stderr: '' })
    await assert.rejects(
      () => createGit({ exec }).commitTime('abc1234'),
      (err) => err instanceof GitError && /non-numeric committer date/.test(err.message),
      `empty %ct output ${JSON.stringify(stdout)} must not resolve`,
    )
  }
})

test('commitTime on a too-old git raises a GitError naming the 2.24 floor', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: OLD_GIT_LOG_SHOW_STDERR })
  await assert.rejects(
    () => createGit({ exec }).commitTime('abc1234'),
    (err) => err instanceof GitError && /2\.24/.test(err.message) && /too old/.test(err.message),
  )
})

test('ignoredPaths asks the worktree’s own ignore rules and returns only the ignored entries', async () => {
  const { calls, exec } = recorder({
    code: 0,
    stdout: 'A  .gitignore\0A  src/main.js\0!! dist/\0!! node_modules/\0!! src/debug.log\0',
    stderr: '',
  })
  const ignored = await createGit({ exec }).ignoredPaths('/repo/wt')
  assert.deepEqual(calls[0], [
    '-C', '/repo/wt', '-c', 'core.quotePath=false', 'status', '--porcelain', '--ignored', '-z',
  ])
  // A wholly ignored directory comes back once, with its trailing slash, rather than as its
  // contents — which is what makes it usable as a prefix to prune a walk at.
  assert.deepEqual(ignored, ['dist/', 'node_modules/', 'src/debug.log'])
})

// Measured against real git 2.53, not assumed: `git status --porcelain --ignored -z
// --end-of-options --` prints NOTHING and exits 0. Carrying this module's usual belt-and-braces
// on this one command would silently turn "every ignored path" into "no ignored path", so the
// argv above deliberately omits both. Pinned here so a later sweep that adds them for consistency
// fails rather than quietly emptying the result.
test('ignoredPaths passes neither --end-of-options nor a trailing -- to git status', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await createGit({ exec }).ignoredPaths('/repo/wt')
  assert.equal(calls[0].includes('--end-of-options'), false)
  assert.equal(calls[0].includes('--'), false)
})

test('ignoredPaths returns an empty list when the worktree ignores nothing', async () => {
  const { exec } = recorder({ code: 0, stdout: 'A  src/main.js\0', stderr: '' })
  assert.deepEqual(await createGit({ exec }).ignoredPaths('/repo/wt'), [])
})

test('ignoredPaths rejects an empty dir rather than reading the wrong worktree', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).ignoredPaths(''), GitError)
  assert.deepEqual(calls, [])
})

// The worktree a stale `git worktree list` entry names is gone; the caller has to be able to tell
// that apart from "this worktree ignores nothing".
test('ignoredPaths raises a GitError when the directory is gone', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: "fatal: cannot change to '/gone': No such file or directory\n" })
  await assert.rejects(() => createGit({ exec }).ignoredPaths('/gone'), GitError)
})

test('tracks reports whether the repository has any tracked file under a path', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'scripts/cli.mjs\nscripts/git.mjs\n', stderr: '' })
  const yes = await createGit({ exec }).tracks('scripts')
  assert.deepEqual(calls[0], ['ls-files', '--error-unmatch', '-z', '--', 'scripts'])
  assert.equal(yes, true)
})

// `ls-files --error-unmatch` exits 1 for a path the index does not carry. That is an answer,
// not a failure, and must not surface as a GitError the caller reports as a broken repository.
test('tracks returns false on the exit code git uses for an unmatched path', async () => {
  const { exec } = recorder({ code: 1, stdout: '', stderr: "did not match any file(s) known to git" })
  assert.equal(await createGit({ exec }).tracks('node_modules'), false)
})

test('tracks rejects an empty pathspec rather than asking about the whole repository', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).tracks(''), GitError)
  assert.deepEqual(calls, [])
})

test('listFiles returns every tracked path, NUL-delimited and unquoted', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'src/a.ts\0src/b b.ts\0', stderr: '' })
  const files = await createGit({ exec }).listFiles()
  assert.deepEqual(calls[0], ['-c', 'core.quotePath=false', 'ls-files', '-z'])
  assert.deepEqual(files, ['src/a.ts', 'src/b b.ts'])
})

// Reconstructs the exact byte stream `git log -z --name-only --format=%x00<marker>%x00` produces
// for a sequence of commits (newest first), each given as its list of changed paths. Verified
// against real git (git 2.53.0, both a Linux checkout and this Windows one): the %x00<marker>%x00
// format renders as a literal NUL, the marker, NUL, followed by ONE MORE NUL that is always
// present — the -z stand-in for the blank line that would otherwise separate the commit header
// from its file list. Only when the commit touched at least one file does more follow: a single
// leading "\n" (a second, path-list-specific separator), then the paths themselves NUL-delimited
// (never newline-delimited — this is the part the original implementation got wrong), then one
// more terminating NUL. An empty commit contributes nothing past that first extra NUL.
const realNameOnlyStdout = (commitsNewestFirst) => commitsNewestFirst
  .map((files) => `\0${COMMIT_MARKER}\0\0` + (files.length ? `\n${files.join('\0')}\0` : ''))
  .join('')

test('realNameOnlyStdout matches real git output byte for byte (regression fixture)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-nameonly-'))
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await sh(['commit', '--allow-empty', '-m', 'empty commit'])
    await writeFile(path.join(root, 'a.ts'), 'a\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'one file'])
    await writeFile(path.join(root, 'a.ts'), 'a2\n', 'utf8')
    await writeFile(path.join(root, 'b.ts'), 'b\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'two files'])

    const real = await sh([
      '-c', 'core.quotePath=false', 'log', '--max-count=10',
      '--no-renames', '--name-only', `--format=%x00${COMMIT_MARKER}%x00`, '-z', 'HEAD', '--',
    ])
    const expected = realNameOnlyStdout([['a.ts', 'b.ts'], ['a.ts'], []])
    assert.equal(real.stdout, expected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commitFileSets returns one path list per commit, newest first', async () => {
  const stdout = realNameOnlyStdout([['src/a.ts', 'src/b.ts'], ['src/a.ts']])
  const { calls, exec } = recorder({ code: 0, stdout, stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 10 })
  assert.deepEqual(calls[0], [
    '-c', 'core.quotePath=false', 'log', '--max-count=10',
    '--no-renames', '--name-only', `--format=%x00${COMMIT_MARKER}%x00`, '-z', 'HEAD', '--',
  ])
  assert.deepEqual(sets, [['src/a.ts', 'src/b.ts'], ['src/a.ts']])
})

// A commit that touched nothing is a real commit and must keep its slot: dropping it would
// shift every support count computed from the list.
test('commitFileSets keeps an empty commit as an empty set', async () => {
  const stdout = realNameOnlyStdout([[], ['src/a.ts']])
  const { exec } = recorder({ code: 0, stdout, stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 5 })
  assert.deepEqual(sets, [[], ['src/a.ts']])
})

// The defect this pins: splitting each token on newlines and trimming every line means a
// tracked path with a leading or trailing space comes back differently from commitFileSets than
// from listFiles, so the two never key together and that file's coupling is invisible. Only the
// synthetic leading "\n" git inserts before the first path of a commit may be stripped — never
// whitespace that is part of the path itself.
test('commitFileSets preserves a leading space in a path rather than trimming it away', async () => {
  const stdout = realNameOnlyStdout([[' lead.ts']])
  const { exec } = recorder({ code: 0, stdout, stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 5 })
  assert.deepEqual(sets, [[' lead.ts']])
})

test('commitFileSets preserves a trailing space in a path rather than trimming it away', async () => {
  const stdout = realNameOnlyStdout([['trail.ts ']])
  const { exec } = recorder({ code: 0, stdout, stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 5 })
  assert.deepEqual(sets, [['trail.ts ']])
})

// A leading/trailing space on a SECOND path in the same commit must survive too: only the first
// path of a commit ever carries git's synthetic leading "\n", so a naive "strip one leading char
// from every token" fix would silently corrupt this one.
test('commitFileSets preserves a leading space on a non-first path in the same commit', async () => {
  const stdout = realNameOnlyStdout([['a.ts', ' lead.ts', 'trail.ts ']])
  const { exec } = recorder({ code: 0, stdout, stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 5 })
  assert.deepEqual(sets, [['a.ts', ' lead.ts', 'trail.ts ']])
})

// A path containing an embedded newline must stay one entry, not split into phantom paths that
// inflate that commit's file count and its pair matrix.
test('commitFileSets does not split a path on an embedded newline', async () => {
  const stdout = realNameOnlyStdout([['weird\nname.ts']])
  const { exec } = recorder({ code: 0, stdout, stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 5 })
  assert.deepEqual(sets, [['weird\nname.ts']])
})

test('commitFileSets rejects a non-positive limit rather than asking git for every commit', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitFileSets({ limit: 0 }), GitError)
  assert.deepEqual(calls, [])
})

// The record separator must be a token no tracked path can ever equal. Git tree entry names
// cannot contain "/" at all, so no path git reports ever ends with one: a marker with a trailing
// slash is unforgeable by construction. A bare word like "commit" is not — see the two tests
// below, which are the reason this marker exists.
test('commitFileSets separates commits with a marker no tracked path can equal', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await createGit({ exec }).commitFileSets({ limit: 10 })
  const format = calls[0].find((a) => a.startsWith('--format='))
  assert.equal(format, `--format=%x00${COMMIT_MARKER}%x00`)
  assert.ok(COMMIT_MARKER.endsWith('/'), 'the marker must end with "/" so no path can forge it')
})

// The defect this pins: with the literal token "commit" as the separator, a tracked file named
// exactly "commit" read as a commit boundary. One commit was reported as two, the path "commit"
// vanished, and the path following it lost its first character ("zzz.txt" -> "zz.txt") — a name
// that appears in no listFiles() output, so its coupling could never key against anything.
test('commitFileSets treats a tracked file named "commit" as a path, not a commit boundary', async () => {
  const stdout = realNameOnlyStdout([['aaa.txt', 'commit', 'zzz.txt']])
  const { exec } = recorder({ code: 0, stdout, stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 5 })
  assert.deepEqual(sets, [['aaa.txt', 'commit', 'zzz.txt']])
})

// Real git, not a fixture: a repository that actually tracks a file named "commit" must come
// back with all three paths in one commit, in order, none truncated.
test('commitFileSets survives a real repository tracking a file named "commit"', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-marker-'))
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'aaa.txt'), 'a\n', 'utf8')
    await writeFile(path.join(root, 'commit'), 'c\n', 'utf8')
    await writeFile(path.join(root, 'zzz.txt'), 'z\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'three files, one of them named commit'])
    await writeFile(path.join(root, 'commit'), 'c2\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'touch commit only'])

    const sets = await createGit({ cwd: root }).commitFileSets({ limit: 10 })
    assert.deepEqual(sets, [['commit'], ['aaa.txt', 'commit', 'zzz.txt']])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// The default is what every real caller gets: codemap asks for coupling without naming a limit,
// so a shrunken default would silently compute the blast radius from a handful of commits while
// every explicit-limit test above stayed green.
test('commitFileSets defaults to 500 commits when no limit is given', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await createGit({ exec }).commitFileSets()
  assert.ok(calls[0].includes('--max-count=500'), `expected --max-count=500 in ${JSON.stringify(calls[0])}`)
})

// THE LAYER ALL THE SIGNAL GUARDS STAND ON, asserted on a REAL git call rather than through a
// double. Every other signal test hands the guard `signal: 'SIGKILL'` itself, so all of them stay
// green if `defaultGitExec` quietly stops surfacing the field — measured: reverting the close
// handler to `resolve({ code: code ?? 1, stdout, stderr })` left the entire suite passing while
// making all five guards dead code in production. This is the one test that notices.
test('defaultGitExec surfaces a signal field on an ordinary successful call', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  try {
    await defaultGitExec(['init', '--initial-branch=main'], root)
    await defaultGitExec(['config', 'user.email', 'test@example.com'], root)
    await defaultGitExec(['config', 'user.name', 'test'], root)
    await writeFile(path.join(root, 'f.txt'), 'x\n', 'utf8')
    await defaultGitExec(['add', '.'], root)
    await defaultGitExec(['commit', '-m', 'one'], root)
    const result = await defaultGitExec(['rev-parse', 'HEAD'], root)
    assert.equal(result.code, 0)
    // Present, and null rather than absent: the guards test `if (signal)`, so an `undefined`
    // would behave the same here and differ nowhere except in what a reader can rely on.
    assert.ok('signal' in result, 'defaultGitExec must surface `signal`; every signal guard reads it')
    assert.equal(result.signal, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// A killed `ls-files --error-unmatch` must not read as "untracked": `preview-check` treats false
// as permission to link the path into a preview worktree.
test('tracks throws rather than answering false when the process was killed', async () => {
  const exec = async () => ({ code: 1, signal: 'SIGKILL', stdout: '', stderr: '' })
  await assert.rejects(() => createGit({ exec }).tracks('some/path'), GitError)
})

// A killed `merge-base --is-ancestor` must not read as "not an ancestor": that is the permissive
// answer in the side-door check and in prune-run's containment proof alike.
test('isAncestor throws rather than answering false when the process was killed', async () => {
  const exec = async () => ({ code: 1, signal: 'SIGKILL', stdout: '', stderr: '' })
  await assert.rejects(() => createGit({ exec }).isAncestor('aaa', 'bbb'), GitError)
})

// `branchExists` interpolated its argument with no type guard, so a null asked git about
// `refs/heads/null` — false in an ordinary repository, and TRUE in one carrying a branch of that
// name. Both measured against real git before the guard was added.
test('branchExists refuses a non-string instead of asking git about refs/heads/null', async () => {
  const git = createGit({ exec: async () => ({ code: 0, signal: null, stdout: 'sha\n', stderr: '' }) })
  await assert.rejects(() => git.branchExists(null), GitError)
  await assert.rejects(() => git.branchExists(undefined), GitError)
  await assert.rejects(() => git.branchExists(''), GitError)
})

// The consequence that made the missing guard worth a test rather than a comment: a repository
// really can carry a branch named `null`, and there the un-guarded form answered TRUE.
test('a repository can hold a branch named null, which is why branchExists must not interpolate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'f.txt'), 'x\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'one'])
    assert.equal((await sh(['branch', 'null'])).code, 0, 'git really does accept a branch named null')
    const git = createGit({ cwd: root })
    assert.equal(await git.branchExists('null'), true, 'the string is a real branch here')
    // The null itself is refused rather than colliding with it.
    await assert.rejects(() => git.branchExists(null), GitError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// THE SHARED RULE, tested once because it is now stated once. Four call sites used to carry their
// own conditional and three of them only ever tested for null, which is how each review round
// closed one site and left the next.
test('classifyHeadRef accepts a branch and reports both spellings of it', () => {
  const r = classifyHeadRef('refs/heads/run-branch')
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'branch')
  assert.equal(r.name, 'run-branch')
  assert.equal(r.ref, 'refs/heads/run-branch')
  // A branch name may itself contain slashes; only the first `refs/heads/` is the prefix.
  assert.equal(classifyHeadRef('refs/heads/fleetmates/r1/T1').name, 'fleetmates/r1/T1')
})

test('classifyHeadRef reports a detached HEAD as on no branch, with no name', () => {
  for (const v of [null, undefined]) {
    const r = classifyHeadRef(v)
    assert.equal(r.ok, false)
    assert.equal(r.kind, 'detached')
    assert.equal(r.name, null)
    assert.match(r.reason, /detached/)
  }
})

// The case three call sites missed. `git symbolic-ref HEAD refs/tags/x` exits 0, and a
// `refs/heads/` strip is a no-op on the result — so a classifier that only tested for null handed
// back the whole ref string as though it were a branch name.
test('classifyHeadRef rejects a HEAD pointing outside refs/heads/ and yields no name', () => {
  for (const ref of ['refs/tags/x', 'refs/mine/run-branch', 'refs/remotes/origin/main', 'refs/heads/']) {
    const r = classifyHeadRef(ref)
    assert.equal(r.ok, false, `${ref} must not be accepted`)
    assert.equal(r.kind, 'not-a-branch')
    // The name is null rather than the ref string: a caller that ignores `ok` gets an absence,
    // never something it could prefix `refs/heads/` onto.
    assert.equal(r.name, null, `${ref} must not yield a name`)
    assert.match(r.reason, /not a branch/)
  }
})

// `currentBranch` is now defined over the classifier, so the same rejection reaches every legacy
// caller as a null rather than as a hostile string.
test('currentBranch answers null for a HEAD pointing outside refs/heads/', async () => {
  const exec = async () => ({ code: 0, signal: null, stdout: 'refs/tags/x\n', stderr: '' })
  const git = createGit({ exec })
  assert.equal(await git.currentBranch(), null)
  const classified = await git.headBranch()
  assert.equal(classified.ok, false)
  assert.equal(classified.ref, 'refs/tags/x')
})

// The refname is chosen by whoever wrote HEAD, and this sentence is printed verbatim by nine
// commands. git accepts U+2028, U+0085 and the C1 range in a refname (measured on 2.55.0), and
// U+2028 is a hard line break (UAX#14 class BK) in the `pre` block a transcript is rendered in --
// so an unwrapped ref forges a whole line under the CLI's own name with no escape sequence at all.
// Every control character below is written as an ESCAPE on purpose, and there are TWO reasons,
// measured on node v26.7.0 one construct at a time.
//
//   - A REGEX literal REJECTS it: `SyntaxError: Invalid regular expression: missing /`. This file
//     asserts through regex literals, so that alone would force the escapes.
//   - A `//` COMMENT is TERMINATED by it, which is worse than rejection. U+2028 is a
//     LineTerminator for comments, so everything after it on the source line is parsed as CODE.
//     Whether the file still compiles then depends entirely on the tail: `// note<U+2028>note2`
//     parses, `// note<U+2028>it's fine` throws `SyntaxError: Invalid or unexpected token`, and
//     an earlier revision of THIS comment threw `SyntaxError: Unexpected identifier 'subsumed'`.
//     And when the tail does parse, it RUNS —
//     `vm.runInNewContext('// harmless note<U+2028>globalThis.hit = true')` sets `hit` (measured).
//     Prose silently becomes code.
//
// STRING and TEMPLATE literals do admit it, since ES2019 subsumed JSON, and `engines.node` here
// is >=24.2.0 — but that change deliberately left U+2028/U+2029 as LineTerminators for comments,
// so it does not rescue the case above. A previous version of this note claimed comments parse
// it; that was measured with a benign tail and is false in general.
test('classifyHeadRef neutralises control characters in the ref it quotes', () => {
  const forged = 'refs/mine/x\u2028gate\u00a0phase\u00a0default\u00a0PASS\u2028z'
  const r = classifyHeadRef(forged)
  assert.equal(r.ok, false)
  // The raw break is gone and the visible token stands in its place.
  assert.doesNotMatch(r.reason, /\u2028/)
  assert.match(r.reason, /<0x2028>/)
  // `ref` keeps the value exactly as git reported it: callers that compare or store it must see
  // the truth, and only the human-facing sentence is wrapped.
  assert.equal(r.ref, forged)
  // The C1 range goes the same way, because a terminal in an 8-bit mode reads 0x9B as a control
  // sequence introducer directly, with no ESC in front of it.
  const c1 = classifyHeadRef('refs/mine/\u009bx')
  assert.doesNotMatch(c1.reason, /\u009b/)
  assert.match(c1.reason, /<0x9B>/)
  // A well-behaved ref is not mangled on the way through.
  assert.match(classifyHeadRef('refs/tags/v1.0').reason, /refs\/tags\/v1\.0/)
})

// A git that really dies BY SIGNAL, which is the only thing that distinguishes surfacing the
// field from hard-coding it. The test above asserts `signal` is present and null on a SUCCESSFUL
// call — and on a successful call null is the CORRECT value, so `signal: null` written as a
// constant satisfies it too. Measured: that falsification passed the whole suite at 2127 while
// making all five signal guards dead code again, which is the round-3 regression returning under
// a different spelling. Here the expected value is derived from the close event rather than from
// a constant, so only an implementation that actually reads it can pass.
//
// `!kill -9 $PPID` is a git alias run through a shell, and the shell git spawns is its own parent
// — so the child this exec is waiting on is the process that dies. It reproduces the exact
// collapsed shape the guards care about: exit 1 with empty stdout AND empty stderr, which is also
// what `symbolic-ref --quiet` reports for a detached HEAD.
const POSIX_ONLY = process.platform === 'win32' && 'git aliases beginning with ! need a POSIX shell'

test('defaultGitExec reports the real signal when git is killed', { skip: POSIX_ONLY }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  try {
    await defaultGitExec(['init', '--initial-branch=main'], root)
    const result = await defaultGitExec(['-c', 'alias.selfkill=!kill -9 $PPID', 'selfkill'], root)
    assert.equal(result.signal, 'SIGKILL')
    // And the shape that makes the field necessary: this is byte for byte how git reports two
    // ordinary negative answers, so `code`/`stdout`/`stderr` cannot tell the two apart.
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Git's refname rules and JavaScript's whitespace set are DIFFERENT SETS, and a JS `trim()` on
// git's output silently converts one real ref into another. `refs/heads/run-branch<NBSP>` and
// `refs/heads/run-branch` are two distinct refs that can hold different commits; trimming made
// the first answer the name of the second, so `doctor` reported the main worktree as being on a
// branch it was not on. Only the trailing newline git appends may be stripped.
test('currentBranchRef strips git\'s newline without trimming whitespace git allows in a refname', async () => {
  const exec = async () => ({ code: 0, signal: null, stdout: 'refs/heads/run-branch\u00a0\n', stderr: '' })
  const git = createGit({ exec })
  assert.equal(await git.currentBranchRef(), 'refs/heads/run-branch\u00a0')
  // And the name carried forward keeps it, so it cannot be mistaken for the neighbouring ref.
  const head = await git.headBranch()
  assert.equal(head.ok, true)
  assert.equal(head.name, 'run-branch\u00a0')
  assert.notEqual(head.name, 'run-branch')
})

// A CRLF platform still gets the newline removed, and a name with no trailing whitespace is
// unchanged -- so the narrower strip does not become a no-op.
test('currentBranchRef removes a CRLF terminator and leaves an ordinary name alone', async () => {
  const crlf = async () => ({ code: 0, signal: null, stdout: 'refs/heads/run-branch\r\n', stderr: '' })
  assert.equal(await createGit({ exec: crlf }).currentBranchRef(), 'refs/heads/run-branch')
  const plain = async () => ({ code: 0, signal: null, stdout: 'refs/heads/run-branch\n', stderr: '' })
  assert.equal(await createGit({ exec: plain }).currentBranchRef(), 'refs/heads/run-branch')
})

// The name a consumer would re-qualify differently. `qualifyBranch` returns any `refs/`-prefixed
// string unchanged, so a name that is itself a ref path resolves to a DIFFERENT ref than the one
// HEAD points at -- while `refs/heads/${name}` still reconstructs HEAD's ref byte for byte, which
// is why the round trip cannot see it. Refused here, at the single point, rather than at each
// consumer.
test('classifyHeadRef refuses a branch whose name is itself a ref path', () => {
  const r = classifyHeadRef('refs/heads/refs/heads/run-branch')
  assert.equal(r.ok, false)
  // Its OWN kind: this ref IS a branch — git lists it and `git status -sb` prints it as current —
  // so folding it in with `not-a-branch` made two consumers contradict git in the same repository.
  assert.equal(r.kind, 'ref-path-name')
  assert.equal(r.name, null, 'no name may escape, or a consumer will re-qualify it')
  assert.match(r.reason, /is itself a ref path/)
  // The ref is still reported, because an operator has to know which ref to go and fix.
  assert.equal(r.ref, 'refs/heads/refs/heads/run-branch')
  // Any refs/ prefix, not just the doubled-heads spelling.
  assert.equal(classifyHeadRef('refs/heads/refs/tags/v1').ok, false)
  // NEUTRALISED HERE TOO. This return builds its own sentence, so the neutralisation test above
  // does not reach it -- that one's input takes the FIRST not-a-branch return. Measured: swapping
  // both `printable()` calls on this return for raw values left the whole suite green.
  const forged = classifyHeadRef('refs/heads/refs/heads/x\u2028forged')
  assert.doesNotMatch(forged.reason, /\u2028/)
  assert.match(forged.reason, /<0x2028>/)
  // And an ordinary name containing slashes is still perfectly fine.
  assert.equal(classifyHeadRef('refs/heads/fleetmates/r1/T1').name, 'fleetmates/r1/T1')
  assert.equal(classifyHeadRef('refs/heads/feature/refs-cleanup').name, 'feature/refs-cleanup')
})

// `currentBranch` must stay DEFINED OVER the classifier rather than re-implementing its rule.
// Re-inlining the older two-rejection form -- null when detached, otherwise strip `refs/heads/` --
// left the whole suite green while being plainly observable: `doctor` then printed
// `run branch refs/heads/run-branch` where it now prints `(none recorded)`. Every other test here
// drives the classifier directly, so nothing noticed the wrapper drifting away from it.
test('currentBranch answers null for every state the classifier rejects, not just detachment', async () => {
  const at = (out) => createGit({ exec: async () => ({ code: 0, signal: null, stdout: out, stderr: '' }) })
  // The state a re-inlined strip would get WRONG: a real branch whose name is itself a ref path.
  assert.equal(await at('refs/heads/refs/heads/run-branch\n').currentBranch(), null)
  // And the two it would get right, so the assertion above is the discriminating one.
  assert.equal(await at('refs/tags/x\n').currentBranch(), null)
  assert.equal(await at('refs/heads/run-branch\n').currentBranch(), 'run-branch')
  const detached = createGit({ exec: async () => ({ code: 1, signal: null, stdout: '', stderr: '' }) })
  assert.equal(await detached.currentBranch(), null)
})

// Task 3: hardened local fetch. The argv-and-env assertion runs against a fake exec that records
// what it was called with, so the neutralising flags are proven present without a repository.
test('fetchTaskBranch disables hooks/fsmonitor, fetches ff-only into refs/heads, and sets GIT_OPTIONAL_LOCKS=0', async () => {
  const calls = []
  const exec = async (args, opts) => { calls.push({ args, opts }); return { code: 0, signal: null, stdout: '', stderr: '' } }
  await fetchTaskBranch(exec, { fromGitDir: '/some/teammate/.git', branch: 'fleetmates/r1/T7' })
  assert.equal(calls.length, 1)
  const { args, opts } = calls[0]
  // The two -c overrides that keep a planted config from executing on the host.
  assert.ok(args.includes('core.hooksPath=/dev/null'), 'hooksPath must be nulled')
  assert.ok(args.includes('core.fsmonitor=false'), 'fsmonitor must be disabled')
  // A fetch that carries no tags and does not write FETCH_HEAD.
  assert.equal(args[4], 'fetch')
  assert.ok(args.includes('--no-tags'))
  assert.ok(args.includes('--no-write-fetch-head'))
  // The git dir sits right after --end-of-options, and the refspec has no leading '+', so the
  // fetch is fast-forward-only rather than a forced overwrite.
  const eoo = args.indexOf('--end-of-options')
  assert.equal(args[eoo + 1], '/some/teammate/.git')
  assert.equal(args[eoo + 2], 'refs/heads/fleetmates/r1/T7:refs/heads/fleetmates/r1/T7')
  assert.ok(!args[eoo + 2].startsWith('+'), 'no leading + keeps the fetch fast-forward only')
  // Optional locks off, layered into env rather than replacing it.
  assert.deepEqual(opts.env, { GIT_OPTIONAL_LOCKS: '0' })
})

// End-to-end: a second repo with a commit on a branch, fetched into a first repo by fetchTaskBranch.
test('against real repositories, fetchTaskBranch brings a teammate branch in', async () => {
  const host = await mkdtemp(path.join(tmpdir(), 'tm-git-fetch-host-'))
  const mate = await mkdtemp(path.join(tmpdir(), 'tm-git-fetch-mate-'))
  const shHost = (args) => defaultGitExec(args, host)
  const shMate = (args) => defaultGitExec(args, mate)
  try {
    for (const [sh, root] of [[shHost, host], [shMate, mate]]) {
      await sh(['init', '--initial-branch=main'])
      await sh(['config', 'user.email', 'test@example.com'])
      await sh(['config', 'user.name', 'test'])
      await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
      await sh(['add', '.'])
      await sh(['commit', '-m', 'base'])
    }
    // The teammate commits on its own task branch.
    await shMate(['checkout', '-b', 'fleetmates/r1/T7'])
    await writeFile(path.join(mate, 'task.txt'), 'work\n', 'utf8')
    await shMate(['add', '.'])
    await shMate(['commit', '-m', 'task work'])
    const mateTip = (await shMate(['rev-parse', 'fleetmates/r1/T7'])).stdout.trim()
    // Before the fetch the host has no such branch.
    assert.notEqual((await shHost(['rev-parse', '--verify', 'refs/heads/fleetmates/r1/T7'])).code, 0)
    const res = await fetchTaskBranch((args, opts) => defaultGitExec(args, { cwd: host, ...opts }), {
      fromGitDir: path.join(mate, '.git'),
      branch: 'fleetmates/r1/T7',
    })
    assert.equal(res.code, 0, res.stderr)
    // The branch now resolves in the host to the teammate's tip.
    assert.equal((await shHost(['rev-parse', 'refs/heads/fleetmates/r1/T7'])).stdout.trim(), mateTip)
  } finally {
    await rm(host, { recursive: true, force: true })
    await rm(mate, { recursive: true, force: true })
  }
})

// Task 3: writability preflight. The positive leg on a normal repo.
test('gitDirWritable returns ok on a normal temp repo', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-writable-'))
  try {
    await defaultGitExec(['init', '--initial-branch=main'], root)
    const res = await gitDirWritable((args, opts) => defaultGitExec(args, { cwd: root, ...opts }), root)
    assert.equal(res.ok, true)
    assert.ok(res.dir.endsWith('.git'), res.dir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// The negative leg: making the common dir unwritable is detected as { ok: false } with a code.
// chmod 0500 is ignored for the owner when running as root, so this leg is skipped there.
test('gitDirWritable reports not-ok with a code when the git dir is unwritable', { skip: process.getuid && process.getuid() === 0 ? 'chmod is ignored for root' : false }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-unwritable-'))
  const gitDir = path.join(root, '.git')
  try {
    await defaultGitExec(['init', '--initial-branch=main'], root)
    await chmod(gitDir, 0o500)
    const res = await gitDirWritable((args, opts) => defaultGitExec(args, { cwd: root, ...opts }), root)
    assert.equal(res.ok, false)
    assert.ok(typeof res.code === 'string' && res.code.length > 0, `expected an error code, got ${res.code}`)
    assert.ok(res.dir.endsWith('.git'), res.dir)
  } finally {
    await chmod(gitDir, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
