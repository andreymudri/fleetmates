import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateLinkPaths, linkInto } from './preview-links.mjs'

// The liveness marker a preview's owner HOLDS for as long as it owns the preview.
//
// The leaked-preview reaper in scripts/cli.mjs classifies a preview by name and location alone,
// which cannot tell a preview a gate is using right now from one a killed gate abandoned. That
// is destructive rather than merely untidy: `git worktree remove --force` FOLLOWS a junction and
// deletes the CONTENTS of the link target, and `preview.link` provisions exactly such junctions
// into the repository's real node_modules.
//
// Anything the reaper SAMPLES — an mtime, a registration age — is check-then-act and only
// narrows the window. This marker is different in kind because the owner holds it for a span
// that CONTAINS the span over which the preview is observable at all: written before
// `git worktree add` is called, released only after `removeWorktree` has deregistered the
// worktree. Both ends are load-bearing and both are pinned by tests. A killed gate skips the
// whole `finally`, so its marker survives; the reaper reads the pid out of it and finds nobody
// home.
//
// WHY A SIBLING RATHER THAN A FILE INSIDE THE PREVIEW. `git worktree add` requires its directory
// to be empty or absent, so a marker inside the preview could only be written once the add
// RETURNS — and git registers the worktree in `git worktree list` at the START of the add. On a
// 3000-file fixture the registration was visible at t=83ms and the add returned at t=3868ms:
// for those seconds the preview is listed, unmarked, and reaped as leaked, with its junctions
// followed. A sibling path is not the add's to own, so it can be written first, which is what
// turns "the window is narrow" into "there is no window".
export const PREVIEW_OWNER_MARKER = '.tm-preview-owner'

// Keyed to the preview's own directory name, so concurrent gates hold distinct markers and no
// marker can answer for a preview other than its own. The reaper derives the same path from the
// preview path `git worktree list` reports, which is the only thing the two sides share.
export function previewOwnerMarkerPath(dir) {
  return path.join(path.dirname(dir), `${PREVIEW_OWNER_MARKER}-${path.basename(dir)}`)
}

// A CLAIM is the second kind of holder a preview can have, and it exists because the first
// kind does not survive its own death.
//
// The owner marker answers "which gate created this". A claim answers "is anything still
// RUNNING in it" — and those come apart exactly when it matters: a SIGKILLed gate runs no
// `finally`, so its marker survives naming a pid nobody is at, while the suite it spawned
// is still writing to the tree. Reading the marker alone, the reaper sees an abandoned
// preview and force-removes it under a live process.
//
// ONE FILE PER HOLDER, never one file listing them. A shared file would need
// read-modify-write to release a holder, and two holders releasing at once is a lost
// update — the outcome of which is a claim that outlives every process it names, i.e. a
// preview nothing will ever reap.
//
// Named off the owner marker so a claim sorts next to what it claims, and so the reaper
// derives both from the one thing the two sides share: the preview path git reports.
export function previewClaimPath(dir, pid) {
  return `${previewOwnerMarkerPath(dir)}.${pid}`
}

// What a directory listing has to start with to be a claim on `dir`. The trailing dot is
// load-bearing: without it this prefix also matches the owner marker itself, and a preview
// whose owner is dead would be read as holding a live claim by that same dead pid.
export function previewClaimPrefix(dir) {
  return `${path.basename(previewOwnerMarkerPath(dir))}.`
}

// `'wx'` is `O_CREAT|O_EXCL|O_WRONLY`: it refuses an entry that already exists instead of
// opening it. Plain `'w'` is `O_CREAT|O_WRONLY|O_TRUNC` and FOLLOWS a symlink — verified in this
// task with a throwaway symlink pointing at a sibling file: a plain `'w'` write through the link
// truncated the target to the new contents, and the same write with `'wx'` instead rejected with
// `EEXIST` and left the target untouched. The window between `mkdtemp` and this write is tight —
// measured in this task at a median of 0.116 ms and a maximum of 0.926 ms over 200 samples, with
// a six-character suffix nothing can guess (an earlier reviewer's run of the same measurement
// reported a median of 0.138 ms and a maximum of 1.127 ms; both runs agree it is sub-millisecond)
// — so it needs an inotify watcher on the temp root, but it is retryable forever at no cost to
// whoever holds the watcher, and the same remedy was already applied to the CLAIM write in
// scripts/gate-runner.mjs — the marker was simply never covered.
//
// Impact is bounded to files this user can already write, so nothing here is a privilege gain.
// What it prevents is this process destroying one of its own files on a path it did not choose.
//
// EEXIST here is not a race to retry: the marker's parent is the world-writable system temp
// root, not the 0700 preview directory (see `:22-28` above — the marker is a SIBLING, precisely
// so it can be written before `git worktree add` creates that directory at all). Verified in
// this task: `mkdtemp('/tmp/tm-preview-…')` made a directory mode 700, but `previewOwnerMarkerPath`
// resolves to a sibling of it under `/tmp` itself, mode 1777. What makes a collision improbable
// is `mkdtemp`'s unguessable six-character suffix, not directory permissions, so an entry already
// sitting at that path may well be one another local user planted on purpose — and that is
// exactly why it must be refused rather than unlinked and retried. It is raised INSIDE
// withMergePreview's `try`, so the `finally` still cleans the directory up.
export async function writeOwnerMarker(marker, pid) {
  await writeFile(marker, `${pid}\n`, { encoding: 'utf8', flag: 'wx' })
}

// The worktree lives under the system temp directory, never inside the repository. An
// in-repo worktree is untracked, so `git status --porcelain` reports it and the ownership
// check reads the main worktree as dirty for the whole run — the deadlock that cost run
// `fixloop` an entire phase gate.
export async function withMergePreview({
  git, base, branches = [], link = [], repoRoot, run,
  // Build the worktree even with no branches to merge: the test inventory's baseline is `base`'s
  // own tree, linked, claimed and torn down exactly like a preview. Without it an empty branch
  // list answers `path: null`, meaning "run where you stand".
  always = false,
  // Injectable so a test can hand withMergePreview a directory it already controls — with a
  // marker collision already planted at previewOwnerMarkerPath(dir) — without monkey-patching
  // node:fs/promises or racing the real mkdtemp. The same seam livePreviewPaths in
  // scripts/cli.mjs already takes for read/list/stat/probe, and for the same reason: some
  // branches cannot be staged end to end without one. Production never passes this; the default
  // is the only path it takes.
  makeTempDir = () => mkdtemp(path.join(tmpdir(), 'tm-preview-')),
}) {
  // Validated before the worktree exists, so a bad manifest costs nothing.
  const invalid = validateLinkPaths(link)
  if (invalid) throw new Error(invalid)
  // Without this, an undefined repoRoot reaches path.resolve inside linkInto and the `merge`
  // check reports `The "paths[0]" argument must be of type string`, naming neither the cause
  // nor the entry. A caller that declares link entries and forgets the root it resolves them
  // against should be told exactly that.
  if (link.length > 0 && typeof repoRoot !== 'string') {
    throw new Error('merge preview cannot resolve preview.link entries: no repoRoot was given')
  }
  if (branches.length === 0 && !always) return run({ path: null, merged: [] })
  const dir = await makeTempDir()
  // Claimed BEFORE the worktree is added, because git registers the worktree at the start of the
  // add and not at its end (see previewOwnerMarkerPath). Inside the `try`, so a write that fails
  // still reaches the `finally` that cleans the directory up.
  const marker = previewOwnerMarkerPath(dir)
  let teardownLinks = null
  // Only set once writeOwnerMarker actually wrote the marker. EEXIST means it did not, and
  // the finally below must not unlink an entry this process never created — see the guard
  // there for why.
  let markerHeld = false
  try {
    await writeOwnerMarker(marker, process.pid)
    markerHeld = true
    await git.addWorktreeDetached(dir, base)
    const conflict = branches.length === 0 ? null : await git.mergeInto(dir, branches)
    if (conflict) {
      // An empty array is not a clean merge and not a reportable conflict: an octopus merge
      // of three or more branches resets the index before exiting, and non-conflict failures
      // (unset user.email, a deleted branch, unrelated histories, a stale index.lock) never
      // produce unmerged paths either. Passing `[]` through would let a caller mistake it for
      // a conflict naming no branches, or silently fall back to the raw worktree. Throw instead
      // so the failure cannot be confused with either outcome.
      if (conflict.length === 0) {
        throw new Error('merge preview failed: mergeInto reported a conflict with no paths')
      }
      return await run({ path: null, conflict })
    }
    // Links are created only on the clean-merge path: the conflict path hands the callback
    // `path: null`, so there is no preview tree to provision.
    teardownLinks = await linkInto(dir, repoRoot, link)
    return await run({ path: dir, merged: branches })
  } finally {
    // Links gone, then worktree gone, then MARKER gone — released last, and that order is the
    // guarantee rather than a detail.
    //
    // Releasing the marker first left a window with teeth: between the release and
    // `removeWorktree`, the preview is still registered in `git worktree list` and still holds
    // its junctions, so the reaper would see a live preview reading as unowned and follow those
    // junctions into the repository's real node_modules. Measured by instrumenting
    // removeWorktree: one candidate, LIVE=1 during the callback, LIVE=0 at that instant.
    //
    // Held to the end, the owner's claim covers a span that CONTAINS the span over which the
    // preview is observable at all — marked before `git worktree add` registers it, still marked
    // when the removal deregisters it. That is what lets scripts/cli.mjs say the destructive
    // direction is closed rather than narrowed.
    try {
      // Before removeWorktree: `git worktree remove` run against a tree still containing a
      // junction into the repository's real node_modules is not a behaviour to discover in
      // production.
      if (teardownLinks) await teardownLinks()
      // The directory removal is in a `finally` of its own because `.catch()` guards a REJECTED
      // promise and nothing else: a `removeWorktree` that throws SYNCHRONOUSLY never returns a
      // promise for `.catch` to attach to, so the throw escaped this line and skipped the `rm`
      // below it, leaking an empty preview directory into the temp dir. Measured before the fix:
      // one `tm-preview-*` directory left behind per run of `tests/gate-runner.test.mjs`, which
      // drives exactly that shape.
      //
      // Which failures actually propagate, stated as what the code does rather than as what
      // would be reassuring: only a SYNCHRONOUS throw from `removeWorktree` does. The `.catch`
      // below swallows its rejection, and the real accessor's `removeWorktree` is `async`, so
      // with real git a teardown failure never reaches the caller and never fails the `merge`
      // check — the gate-runner test that pins propagation drives a synchronous-throwing double,
      // and says so itself. An earlier version of this comment claimed the throw propagates
      // generally; it does not. Only the cleanup is unconditional. `rm` keeps its own `.catch`
      // because a directory that cannot be removed (a handle still open, a permission) must not
      // replace the teardown error with its own.
      try {
        await git.removeWorktree(dir).catch(() => {})
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    } finally {
      // Its own `finally`, so release-last never becomes release-never: `teardownLinks()`
      // propagates its failures on purpose, and a marker stranded by one would claim an owner
      // forever for a preview nothing will clear.
      //
      // Guarded on `markerHeld`, not unconditional: an EEXIST from `writeOwnerMarker` means
      // this process never wrote the entry at `marker`, so releasing it anyway would unlink
      // whatever is actually there — including a marker another local process is holding.
      // Named by section rather than by line number, because that file has its own fix rounds
      // in flight: see the claim-vetting comment above `livePreviewPaths` in scripts/cli.mjs,
      // which states the same rule for the sibling claim path — "EEXIST is tolerated and never
      // unlinked, so a claim that writer did not create is never released by it."
      if (markerHeld) await rm(marker, { force: true }).catch(() => {})
    }
  }
}

// A conflict belongs to a pair of branches, not to one task: no single teammate can fix it.
// The gate reports it that way so the fix loop escalates instead of retrying one owner.
export function conflictPairs(branches, paths) {
  if (paths.length === 0) return []
  return [{ branches: [...branches], paths: [...paths] }]
}
