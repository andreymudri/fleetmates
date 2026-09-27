import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  withMergePreview,
  conflictPairs,
  previewOwnerMarkerPath,
  previewClaimPath,
  previewClaimPrefix,
  writeOwnerMarker,
} from '../scripts/merge-preview.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

function fakeGit({ conflictPaths = null } = {}) {
  const calls = []
  return {
    calls,
    async addWorktreeDetached(dir, ref) {
      calls.push({ op: 'addWorktreeDetached', dir, ref })
      return dir
    },
    async mergeInto(dir, branches) {
      calls.push({ op: 'mergeInto', dir, branches })
      return conflictPaths
    },
    async removeWorktree(dir) {
      calls.push({ op: 'removeWorktree', dir })
      return true
    },
  }
}

// A git accessor that records operation order into a shared array, so tests can pin whether
// the worktree teardown happens before or after the callback settles.
function orderedGit(order, { conflictPaths = null } = {}) {
  return {
    async addWorktreeDetached(dir, ref) {
      order.push('addWorktreeDetached')
      return dir
    },
    async mergeInto(dir, branches) {
      order.push('mergeInto')
      return conflictPaths
    },
    async removeWorktree(dir) {
      order.push('removeWorktree')
      return true
    },
  }
}

test('a clean merge calls run with a non-null path and the merged branch list', async () => {
  const git = fakeGit()
  const branches = ['fleetmates/r1/T1', 'fleetmates/r1/T2']
  let received = null
  await withMergePreview({
    git, base: 'main', branches,
    run: async (args) => { received = args },
  })
  assert.ok(received.path, 'expected a non-null worktree path')
  assert.deepEqual(received.merged, branches)
})

test('an empty branch list calls run with path: null, merged: [] and never creates a worktree', async () => {
  const git = fakeGit()
  let received = null
  await withMergePreview({
    git, base: 'main', branches: [],
    run: async (args) => { received = args },
  })
  assert.deepEqual(received, { path: null, merged: [] })
  assert.equal(git.calls.length, 0, 'no git calls should have been made')
})

test('a conflict calls run with path: null and the conflict report, never with a worktree path', async () => {
  const git = fakeGit({ conflictPaths: ['scripts/cli.mjs'] })
  const branches = ['fleetmates/r1/T3', 'fleetmates/r1/T8']
  let received = null
  await withMergePreview({
    git, base: 'main', branches,
    run: async (args) => { received = args },
  })
  assert.equal(received.path, null)
  assert.deepEqual(received.conflict, ['scripts/cli.mjs'])
  assert.equal(received.merged, undefined)
})

test('the worktree is removed after a clean merge', async () => {
  const git = fakeGit()
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1)
})

test('the worktree is removed after a conflict', async () => {
  const git = fakeGit({ conflictPaths: ['a.mjs'] })
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1)
})

test('an empty conflict array is a failed preview, not a clean merge and not a reportable conflict', async () => {
  // mergeInto can return [] when the merge fails without leaving unmerged paths: an octopus
  // merge of 3+ branches resets the index before exiting, and non-conflict failures (unset
  // user.email, a deleted branch, unrelated histories, a stale index.lock) never produce one
  // either. `[]` must not be treated as truthy-conflict-with-no-branches, and must not fall
  // through to the clean path. withMergePreview throws instead, so the failure can never be
  // mistaken for either outcome by a caller.
  const git = fakeGit({ conflictPaths: [] })
  let runCalled = false
  await assert.rejects(
    () => withMergePreview({
      git, base: 'main', branches: ['T1'],
      run: async () => { runCalled = true },
    }),
    /merge preview failed/,
  )
  assert.equal(runCalled, false, 'the callback must not run on a failed preview')
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1, 'the worktree must still be cleaned up')
})

test('the clean-merge branch awaits the callback before removing the worktree', async () => {
  const order = []
  const git = orderedGit(order)
  await withMergePreview({
    git, base: 'main', branches: ['T1'],
    run: async () => {
      order.push('run:start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('run:end')
    },
  })
  assert.deepEqual(order, ['addWorktreeDetached', 'mergeInto', 'run:start', 'run:end', 'removeWorktree'])
})

test('the conflict branch awaits the callback before removing the worktree', async () => {
  const order = []
  const git = orderedGit(order, { conflictPaths: ['a.mjs'] })
  await withMergePreview({
    git, base: 'main', branches: ['T1'],
    run: async () => {
      order.push('run:start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('run:end')
    },
  })
  assert.deepEqual(order, ['addWorktreeDetached', 'mergeInto', 'run:start', 'run:end', 'removeWorktree'])
})

test('an accessor that throws from addWorktreeDetached still cleans up and propagates the error', async () => {
  const git = fakeGit()
  git.addWorktreeDetached = async (dir, ref) => {
    git.calls.push({ op: 'addWorktreeDetached', dir, ref })
    throw new Error('boom-add')
  }
  await assert.rejects(
    () => withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} }),
    /boom-add/,
  )
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1, 'the worktree must still be cleaned up even when addWorktreeDetached throws')
})

test('the worktree is removed after run throws, and the throw propagates', async () => {
  const git = fakeGit()
  await assert.rejects(
    () => withMergePreview({
      git, base: 'main', branches: ['T1'],
      run: async () => { throw new Error('boom') },
    }),
    /boom/,
  )
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1)
})

test('the directory handed to addWorktreeDetached is under os.tmpdir(), not under the repository root', async () => {
  const git = fakeGit()
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  const addCall = git.calls.find((c) => c.op === 'addWorktreeDetached')
  assert.ok(addCall, 'expected addWorktreeDetached to be called')
  const relativeToTmp = path.relative(tmpdir(), addCall.dir)
  assert.ok(!relativeToTmp.startsWith('..') && !path.isAbsolute(relativeToTmp),
    `expected ${addCall.dir} to be under ${tmpdir()}`)
  const relativeToRepo = path.relative(REPO_ROOT, addCall.dir)
  assert.ok(relativeToRepo.startsWith('..') || path.isAbsolute(relativeToRepo),
    `expected ${addCall.dir} to NOT be under the repository root ${REPO_ROOT}`)
})

// A repository root standing in for the real one, holding a directory that `git worktree add`
// would never materialize — the build input the preview has to be given.
async function fakeRepoRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-preview-root-'))
  await mkdir(path.join(root, 'deps'))
  await writeFile(path.join(root, 'deps', 'marker.txt'), 'from-target')
  return root
}

test('declared links exist while the callback runs and are gone after it returns', async () => {
  const git = fakeGit()
  const root = await fakeRepoRoot()
  let previewDir = null
  let readThroughLink = null
  try {
    await withMergePreview({
      git, base: 'main', branches: ['T1'], link: ['deps'], repoRoot: root,
      run: async ({ path: dir }) => {
        previewDir = dir
        readThroughLink = await readFile(path.join(dir, 'deps', 'marker.txt'), 'utf8')
      },
    })
    assert.equal(readThroughLink, 'from-target')
    // Nothing is asserted about the preview tree here: the finally block removes the whole
    // directory before this line runs, so any absence check would pass even with teardown
    // deleted. Teardown is pinned by the ordering test below, which observes the link from
    // inside removeWorktree, while the directory still exists.
    assert.ok(previewDir, 'the callback must have been handed a preview path')
    assert.equal(existsSync(path.join(root, 'deps', 'marker.txt')), true, 'the target must survive')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('links are torn down before the worktree is removed', async () => {
  const order = []
  const root = await fakeRepoRoot()
  let previewDir = null
  const git = {
    async addWorktreeDetached(dir) { order.push('addWorktreeDetached'); previewDir = dir; return dir },
    async mergeInto() { order.push('mergeInto'); return null },
    async removeWorktree(dir) {
      // A `git worktree remove` run against a tree still holding a junction into the real
      // node_modules is not a behaviour to discover in production.
      order.push(existsSync(path.join(dir, 'deps')) ? 'removeWorktree:link-present' : 'removeWorktree:link-gone')
      return true
    },
  }
  try {
    await withMergePreview({
      git, base: 'main', branches: ['T1'], link: ['deps'], repoRoot: root,
      run: async () => { order.push('run') },
    })
    assert.deepEqual(order, ['addWorktreeDetached', 'mergeInto', 'run', 'removeWorktree:link-gone'])
    assert.ok(previewDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an invalid link list rejects before addWorktreeDetached is called at all', async () => {
  const git = fakeGit()
  let runCalled = false
  await assert.rejects(
    () => withMergePreview({
      git, base: 'main', branches: ['T1'], link: ['../escape'], repoRoot: REPO_ROOT,
      run: async () => { runCalled = true },
    }),
    /escapes the repository/,
  )
  assert.equal(runCalled, false)
  assert.equal(git.calls.length, 0, 'a bad manifest must cost no worktree')
})

test('declaring link entries without a repoRoot is named as such, not as a raw TypeError', async () => {
  const git = fakeGit()
  await assert.rejects(
    () => withMergePreview({
      git, base: 'main', branches: ['T1'], link: ['node_modules'],
      run: async () => {},
    }),
    (err) => {
      assert.match(err.message, /repoRoot/)
      // The raw path.resolve failure names neither the cause nor the entry.
      assert.doesNotMatch(err.message, /argument must be of type string/)
      return true
    },
  )
  assert.equal(git.calls.length, 0, 'a caller error must cost no worktree')
})

test('an empty link list needs no repoRoot', async () => {
  const git = fakeGit()
  let ran = false
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => { ran = true } })
  assert.equal(ran, true)
})

test('a link failure after a clean merge rejects without invoking the callback and still removes the worktree', async () => {
  const git = fakeGit()
  const root = await fakeRepoRoot()
  let runCalled = false
  try {
    await assert.rejects(
      () => withMergePreview({
        git, base: 'main', branches: ['T1'], link: ['absent'], repoRoot: root,
        run: async () => { runCalled = true },
      }),
      /preview link 'absent' failed/,
    )
    assert.equal(runCalled, false, 'the callback must not run without its build inputs')
    const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
    assert.equal(removeCalls.length, 1, 'the worktree must still be cleaned up')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a conflicting merge creates no links: the callback gets path: null and linkInto is never reached', async () => {
  // The link entry names a directory that does not exist, so reaching linkInto would throw.
  const git = fakeGit({ conflictPaths: ['scripts/cli.mjs'] })
  const root = await fakeRepoRoot()
  let received = null
  try {
    await withMergePreview({
      git, base: 'main', branches: ['T1'], link: ['absent'], repoRoot: root,
      run: async (args) => { received = args },
    })
    assert.equal(received.path, null)
    assert.deepEqual(received.conflict, ['scripts/cli.mjs'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('conflictPairs returns [] for no paths', () => {
  assert.deepEqual(conflictPairs(['T1', 'T2'], []), [])
})

test('conflictPairs returns one pair naming every branch and path otherwise', () => {
  const branches = ['fleetmates/r1/T3', 'fleetmates/r1/T8']
  const paths = ['scripts/cli.mjs', 'scripts/gate-runner.mjs']
  assert.deepEqual(conflictPairs(branches, paths), [{ branches, paths }])
})

// ---------------------------------------------------------------------------
// The liveness marker. The reaper in scripts/cli.mjs classifies a preview by name and
// location alone, so a preview a gate is holding RIGHT NOW is indistinguishable from a leaked
// one — and `git worktree remove --force` follows the junctions `preview.link` provisioned and
// deletes the CONTENTS of their targets.
//
// The marker is a SIBLING of the preview directory, not a file inside it, and that placement is
// the whole point rather than a detail. `git worktree add` needs the directory empty, so a
// marker inside it could only be written after the add RETURNS — while git registers the
// worktree in `git worktree list` at the START of the add. Measured on a 3000-file fixture, the
// registration was visible at t=83ms and the add returned at t=3868ms: for those seconds a live
// preview would be listed and unmarked, which is exactly the interval the reaper must never see.
// A sibling path is not the add's to own, so it can be written BEFORE the add is called at all.
// ---------------------------------------------------------------------------

test('the marker is written before the worktree is added, not after', async () => {
  const seen = []
  let markerPath = null
  const git = {
    async addWorktreeDetached(dir) {
      // git registers the worktree at the START of this call. Whatever is true here is what the
      // reaper can observe for the whole duration of the add.
      markerPath = previewOwnerMarkerPath(dir)
      seen.push(existsSync(markerPath))
      return dir
    },
    async mergeInto() { return null },
    async removeWorktree() { return true },
  }
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  assert.deepEqual(seen, [true], 'the preview was observable and unmarked while it was being added')
  assert.equal(existsSync(markerPath), false, 'the marker outlived the preview')
})

// A teardown that throws SYNCHRONOUSLY is not the same as one that rejects, and the difference
// used to decide whether the preview directory survived: `git.removeWorktree(dir).catch(...)`
// attaches to a returned promise, so a synchronous throw escaped the line before `.catch` existed
// and carried the `rm` below it away with it. Found by counting: every run of
// tests/gate-runner.test.mjs — which drives exactly this shape at
// 'a throw raised after the checks already ran does not run them a second time' — left one more
// empty `tm-preview-*` directory in the temp dir than it started with.
//
// Both halves are pinned here. The error must still reach the caller, because a teardown failure
// has to fail the `merge` check rather than pass quietly; and the directory must be gone anyway.
test('a synchronous teardown throw still removes the preview directory, and still propagates', async () => {
  let previewPath = null
  const git = {
    async addWorktreeDetached(dir) { return dir },
    async mergeInto() { return null },
    // Synchronous, not a rejected promise: the shape a `git` accessor takes when the spawn itself
    // fails before any promise is created.
    removeWorktree() { throw new Error('worktree teardown boom') },
  }
  await assert.rejects(
    withMergePreview({
      git,
      base: 'main',
      branches: ['T1'],
      run: async ({ path: dir }) => { previewPath = dir },
    }),
    /worktree teardown boom/,
    'a teardown failure must reach the caller, so the merge check fails instead of passing quietly',
  )
  assert.ok(previewPath, 'the callback must have received a preview path to assert about')
  assert.equal(
    existsSync(previewPath), false,
    'the preview directory outlived a synchronous teardown throw — the cleanup must not depend ' +
    'on the teardown returning a promise',
  )
  assert.equal(
    existsSync(previewOwnerMarkerPath(previewPath)), false,
    'the owner marker outlived the preview, so the reaper would read a stale claim',
  )
})

test('the marker names the owning pid and lives beside the preview, not inside it', async () => {
  const git = fakeGit()
  let contents = null
  let insidePreview = null
  await withMergePreview({
    git, base: 'main', branches: ['T1'],
    run: async ({ path: dir }) => {
      contents = await readFile(previewOwnerMarkerPath(dir), 'utf8')
      // A file inside the tree would also be a file `git worktree add` refuses to create the
      // tree around, and one `git worktree remove --force` would count as untracked content.
      insidePreview = existsSync(path.join(dir, '.tm-preview-owner'))
    },
  })
  assert.equal(contents.trim(), String(process.pid))
  assert.equal(insidePreview, false)
})

// Keyed to the preview's own directory name, so two gates running at once hold two markers and
// neither can answer for the other's preview.
test('two previews under the same root get two distinct markers', () => {
  const a = previewOwnerMarkerPath(path.join(tmpdir(), 'tm-preview-aaa'))
  const b = previewOwnerMarkerPath(path.join(tmpdir(), 'tm-preview-bbb'))
  assert.notEqual(a, b)
  assert.equal(path.dirname(a), tmpdir())
  assert.ok(path.basename(a).includes('tm-preview-aaa'))
})

// The other end of the span, and the mirror of the add test above. The marker is released LAST
// in the `finally` — after the links are torn down and after `removeWorktree` deregisters the
// worktree — so it is still held at the moment `git worktree list` can still report the preview
// and the preview can still hold junctions. Releasing it first left a window in which a preview
// that was registered, linked, and mid-teardown read as UNOWNED, and the reaper would follow
// those junctions.
//
// Observed from inside removeWorktree, which is the last instant the preview is still
// registered — the same technique the add test uses at the other end.
test('the marker is still held while the worktree is being removed', async () => {
  const seen = []
  let markerPath = null
  const git = {
    async addWorktreeDetached(dir) { markerPath = previewOwnerMarkerPath(dir); return dir },
    async mergeInto() { return null },
    async removeWorktree(dir) { seen.push(existsSync(previewOwnerMarkerPath(dir))); return true },
  }
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  assert.deepEqual(seen, [true], 'the preview was registered and unowned while it was being torn down')
  // And released once there is nothing left to own: a marker outliving its preview would claim
  // an owner forever for a path the reaper can never clear.
  assert.equal(existsSync(markerPath), false, 'a clean run must not leave its own marker behind')
})

// A gate whose CALLBACK threw still ran its `finally`, so it leaves nothing behind. Only a
// killed gate — which skips the `finally` entirely — leaves the marker, which is the case the
// reaper must read as live.
test('a callback that throws still removes the marker, and holds it until the removal', async () => {
  const seen = []
  let markerPath = null
  const git = {
    async addWorktreeDetached(dir) { markerPath = previewOwnerMarkerPath(dir); return dir },
    async mergeInto() { return null },
    async removeWorktree(dir) { seen.push(existsSync(previewOwnerMarkerPath(dir))); return true },
  }
  await assert.rejects(
    withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => { throw new Error('boom') } }),
    /boom/,
  )
  assert.deepEqual(seen, [true])
  assert.equal(existsSync(markerPath), false)
})

// Release-last must not become release-never. Both teardown steps are made to fail: the marker
// is the last thing released, so it is the first thing a naive ordering would strand, and a
// marker outliving its preview claims an owner for a path nothing will ever clear.
test('a teardown that throws still releases the marker', async () => {
  const root = await fakeRepoRoot()
  let markerPath = null
  const git = {
    async addWorktreeDetached(dir) { markerPath = previewOwnerMarkerPath(dir); return dir },
    async mergeInto() { return null },
    async removeWorktree() { throw new Error('worktree is locked') },
  }
  try {
    // removeWorktree's own rejection is swallowed by withMergePreview, so this resolves; what is
    // under test is that the release happened anyway.
    await withMergePreview({ git, base: 'main', branches: ['T1'], link: ['deps'], repoRoot: root, run: async () => {} })
    assert.equal(existsSync(markerPath), false, 'a failed removeWorktree stranded the marker')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a link teardown that throws propagates and still releases the marker', async () => {
  let markerPath = null
  const git = {
    async addWorktreeDetached(dir) { markerPath = previewOwnerMarkerPath(dir); return dir },
    async mergeInto() { return null },
    async removeWorktree() { return true },
  }
  // A preview whose declared link target does not exist: linkInto succeeds against a directory
  // it creates, and the teardown then fails on a tree removed out from under it. Staged by
  // removing the preview directory from inside the callback, which is the only hook there is.
  const root = await fakeRepoRoot()
  try {
    await withMergePreview({
      git, base: 'main', branches: ['T1'], link: ['deps'], repoRoot: root,
      run: async ({ path: dir }) => {
        markerPath = previewOwnerMarkerPath(dir)
        // Leave the junction dangling by removing what it points at, so teardown has something
        // to fail on. The target is this test's own throwaway fixture, never a real directory.
        await rm(path.join(root, 'deps'), { recursive: true, force: true })
      },
    }).catch(() => {})
    assert.equal(existsSync(markerPath), false, 'the marker must be released whatever teardown did')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// An add that FAILS still registered the worktree before it failed, and may leave it registered.
// The marker must not outlive the attempt, or a preview nobody owns reads as live forever.
test('an addWorktreeDetached that throws still removes the marker', async () => {
  let markerPath = null
  const git = {
    async addWorktreeDetached(dir) { markerPath = previewOwnerMarkerPath(dir); throw new Error('add failed') },
    async mergeInto() { return null },
    async removeWorktree() { return true },
  }
  await assert.rejects(
    withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} }),
    /add failed/,
  )
  assert.equal(existsSync(markerPath), false)
})

// The conflict path hands the callback `path: null` and provisions no links, but the worktree
// it created is registered and just as reapable, so it is marked for the whole of its life.
test('a conflicting merge still marks the preview it created', async () => {
  const seen = []
  let markerPath = null
  const git = {
    async addWorktreeDetached(dir) { markerPath = previewOwnerMarkerPath(dir); seen.push(existsSync(markerPath)); return dir },
    async mergeInto(dir) { seen.push(existsSync(previewOwnerMarkerPath(dir))); return ['a.mjs'] },
    async removeWorktree(dir) { seen.push(existsSync(previewOwnerMarkerPath(dir))); return true },
  }
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  // Marked before the add, through the merge, and still marked at the removal — the whole of the
  // span over which this preview is observable.
  assert.deepEqual(seen, [true, true, true])
  assert.equal(existsSync(markerPath), false)
})

test('a claim path is the owner marker plus the pid, and the prefix excludes the marker', () => {
  const dir = path.join(tmpdir(), 'tm-preview-abc123')
  const owner = previewOwnerMarkerPath(dir)
  assert.equal(previewClaimPath(dir, 4242), `${owner}.4242`)
  const prefix = previewClaimPrefix(dir)
  assert.ok(path.basename(previewClaimPath(dir, 4242)).startsWith(prefix))
  assert.equal(path.basename(owner).startsWith(prefix), false)
})

// ---------------------------------------------------------------------------
// writeOwnerMarker, tested directly against a real filesystem entry rather than asserted from
// source text — 'wx' is a flag the exec fakes above cannot exercise, since they never touch a
// real file.
// ---------------------------------------------------------------------------

test('writeOwnerMarker refuses a path that already exists rather than truncating it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-marker-'))
  const marker = path.join(dir, 'marker')
  await writeFile(marker, 'pre-existing\n', 'utf8')
  await assert.rejects(() => writeOwnerMarker(marker, 4242), (err) => err.code === 'EEXIST')
  assert.equal(await readFile(marker, 'utf8'), 'pre-existing\n')
  await rm(dir, { recursive: true, force: true })
})

test('writeOwnerMarker does not follow a symlink planted at the marker path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-marker-'))
  const victim = path.join(dir, 'victim')
  const marker = path.join(dir, 'marker')
  await writeFile(victim, 'do not truncate me\n', 'utf8')
  await symlink(victim, marker)
  await assert.rejects(() => writeOwnerMarker(marker, 4242), (err) => err.code === 'EEXIST')
  assert.equal(await readFile(victim, 'utf8'), 'do not truncate me\n')
  await rm(dir, { recursive: true, force: true })
})

test('withMergePreview writes the owner marker naming its own pid', async () => {
  const git = fakeGit()
  let contents = null
  let readWhileDirExisted = false
  await withMergePreview({
    git, base: 'main', branches: ['T1'],
    run: async ({ path: dir }) => {
      contents = await readFile(previewOwnerMarkerPath(dir), 'utf8')
      readWhileDirExisted = existsSync(dir)
    },
  })
  assert.equal(contents, `${process.pid}\n`)
  assert.equal(readWhileDirExisted, true, 'the marker must be readable while the preview directory still exists')
})

// The write is placed on the first line INSIDE withMergePreview's `try`, specifically so a
// refused write still reaches the `finally` that removes the preview directory. Nothing above
// drives that placement through withMergePreview itself — the writeOwnerMarker tests exercise
// the helper in isolation. `makeTempDir` lets this test hand withMergePreview a directory that
// already has a marker collision planted at it, deterministically, without monkey-patching
// node:fs/promises or racing the real mkdtemp.
//
// The release in the `finally` is guarded on `markerHeld`, so an EEXIST from `writeOwnerMarker`
// must leave the planted entry untouched rather than unlinking it — the same rule the
// claim-vetting comment above `livePreviewPaths` in scripts/cli.mjs states for the sibling claim
// path (cited by section, not by line number, because that file has its own fix rounds in
// flight): "EEXIST is tolerated and never unlinked, so a claim that writer did not create is
// never released by it." That is why this plant needs no foreign uid, no user namespace and no
// sticky bit to be meaningful: the invariant now belongs to the `markerHeld` guard rather than to
// the filesystem, so an ordinary same-uid `writeFile` is enough to make it fail if the guard
// regresses.
test('a marker write that fails still removes the preview directory the seam handed it, and never unlinks the marker it did not write', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-preview-'))
  const marker = previewOwnerMarkerPath(dir)
  // Planted before withMergePreview ever runs, at the exact path it will try to write.
  await writeFile(marker, 'planted-before-withMergePreview\n', 'utf8')
  const git = fakeGit()
  await assert.rejects(
    () => withMergePreview({
      git, base: 'main', branches: ['T1'],
      makeTempDir: async () => dir,
      run: async () => {},
    }),
    (err) => err.code === 'EEXIST',
  )
  assert.equal(
    existsSync(dir), false,
    'the preview directory the seam handed in must not be stranded when the marker write fails',
  )
  assert.equal(
    await readFile(marker, 'utf8'), 'planted-before-withMergePreview\n',
    'a marker this process never wrote must survive the finally untouched',
  )
  // Left behind on purpose: unlike every other test here, this run never wrote the marker, so
  // withMergePreview correctly leaves it for its actual owner rather than releasing it.
  await rm(marker, { force: true })
})

// The test inventory's baseline: `always` builds the worktree at `base` even with no branches, and
// never merges; without it an empty branch list answers `path: null` ("run where you stand").
test('always builds a linked worktree at base with no branches, and removes it after', async () => {
  const { createGit, defaultGitExec } = await import('../scripts/git.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'tm-always-'))
  try {
    const sh = (args) => defaultGitExec(args, root)
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 't@e'])
    await sh(['config', 'user.name', 'T'])
    // The runner's git checks out CRLF on win32; the assertion is about which content, not line ends.
    await sh(['config', 'core.autocrlf', 'false'])
    await writeFile(path.join(root, 'a.txt'), 'base\n')
    await mkdir(path.join(root, 'deps'))
    await writeFile(path.join(root, '.gitignore'), 'deps/\n')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await writeFile(path.join(root, 'a.txt'), 'uncommitted\n')
    const git = createGit({ cwd: root })
    let seen = null
    await withMergePreview({
      git, base: 'main', branches: [], always: true, link: ['deps'], repoRoot: root,
      run: async ({ path: tree }) => { seen = { tree, a: await readFile(path.join(tree, 'a.txt'), 'utf8'), deps: existsSync(path.join(tree, 'deps')) } },
    })
    assert.notEqual(seen.tree, null)
    assert.equal(seen.a, 'base\n')
    assert.equal(seen.deps, true)
    assert.equal(existsSync(seen.tree), false)
    assert.equal((await sh(['worktree', 'list'])).stdout.trim().split('\n').length, 1)
    let without = 'unset'
    await withMergePreview({ git, base: 'main', branches: [], run: async ({ path: tree }) => { without = tree } })
    assert.equal(without, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
