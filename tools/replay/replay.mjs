#!/usr/bin/env node
// Controlled replay tool (docs/plans/2026-09-24-mid-tier-to-opus.md, Task 1; usage in
// tools/replay/README.md). Re-runs already-landed tasks from local fleet runs at every tier
// (cheap, mid, capable) with a real, headless `claude -p` session, so each tier's cost,
// wall-clock and pass rate are MEASURED rather than assumed. Every cell:
//   - materializes ONLY the task's base tree into a scratch directory under `$TMPDIR` — `git
//     archive <baseSha>` extracted into a fresh `git init`, single commit, no parent, no other
//     ref. A plain `git clone` was tried first and rejected: it copies every ref the source repo
//     has — the task's own already-solved branch, the run branch, a default branch that already
//     contains the merged work — so a session in that clone could simply read the answer. A
//     fresh, single-commit repository cannot: there is nothing else in it to read;
//   - gets a prompt built directly from the task's own section of the plan AS COMMITTED AT THE
//     BASE COMMIT, plus its declared files and the plan's global constraints — never a live
//     `scripts/cli.mjs brief`, which tells a session to `git checkout -B <branch> <base>` (a
//     branch this materialized tree does not have) and to run `locate`/`complete` against
//     `.fleetmates/` run state, which is gitignored and absent from it;
//   - is graded by the task's OWN phase's `command` gate checks (read from the manifest as
//     committed at the base commit) plus a fileset check requiring a non-empty change that
//     touches at least one declared file — a no-op session does not pass — with at most one fix
//     round (a second `claude -p --resume` turn) if the first attempt fails;
//   - gets the manifest's `preview.link` entries (e.g. `node_modules`) COPIED in from the source
//     repo — never symlinked. A symlink was tried first and is unsafe here specifically:
//     `scripts/preview-links.mjs`'s own `linkInto` creates a real filesystem symlink from the
//     cell into the SOURCE repo's own directory, and a `claude -p` session graded in that cell is
//     an ordinary process with the user's own filesystem permissions — nothing about `cwd`
//     confines it. Reproduced directly: a session that wrote through a linked
//     `node_modules/dep/index.js` changed the source repo's real file, surviving teardown; and
//     `realpath(cell/node_modules)/../.git/refs/heads` resolved straight into the source repo's
//     own `.git`, exposing its already-solved branches — the same answer-leakage class Finding A
//     exists to prevent, reopened by a different door. A copy has no such door: the cell's
//     `node_modules` becomes a real, independent, writable directory inside the isolated clone,
//     torn down (and, either way, removed again with the whole clone) before the cell finishes.
//     It is excluded from the fileset check, so each session (the fix round too) runs between two
//     fingerprints of the copied trees — path, type, size, mode, content sha256, symlink target —
//     with the trees read-only only for the session itself (see lockLinkTrees). Any difference
//     fails the cell as `link-modified`, with no fix round after it. The read-only lock alone is
//     no guard (a bypassPermissions session can `chmod -R u+w`); the fingerprint is. Gate
//     commands run after the unlock, on the writable trees, as the real gate's links are;
//   - is removed afterward, regardless of outcome.
// NOT isolated by any of this, and nothing here claims otherwise: the `claude -p` child process
// itself is an ordinary process running with the operator's own OS permissions, no sandbox and no
// container. `cwd` confinement is a convention the session is expected to honor, not an enforced
// boundary — a session can `cd` anywhere its own user account can reach, read or write any file
// that account owns outside the cell entirely, and open a network connection. Copying
// `preview.link` closes the one door this tool itself was building into the cell's own working
// tree; it closes nothing else.
// PERMISSIONS — read this before running `--execute`, `--smoke` or `--preflight`. Every session is
// spawned with `--permission-mode bypassPermissions` (the operator chose this mode so a
// replay session has the same freedom a fleet teammate had). That means each session runs
// UNATTENDED: every tool call it makes — Write, Edit, Bash, anything — is carried out without
// asking anyone, with the operator's own OS permissions. The `$TMPDIR` clone is NOT a sandbox: it
// is only the session's starting directory, and nothing stops a session from acting outside it.
// Without a permission mode, the first real replay recorded that `claude -p` denied every Write/Edit,
// still exited 0, and reported the denials only in `permission_denials` — so a whole replay run
// graded 90 of 90 no-op cells as `fail`. Two guards follow from that:
//   - a session result with a non-empty `permission_denials` makes the cell INVALID, not `fail`:
//     nothing is appended for it, the run stops naming the denied tools and the count, and the
//     next invocation re-runs the cell;
//   - `--execute` always runs `--preflight` first: one real session in a scratch git repo under
//     `$TMPDIR` that must create a file and run `git status` with zero permission denials, or the
//     whole run is aborted before any cell starts.
// Every `fail` record carries a `failReason` from a fixed set — `no-op`, `fileset`,
// `command:<check name>`, `session-error`, `link-modified` — never task text, a path or command output, plus
// `permissionDenials` (a count) and `turns`. A `preview.link` copy refusal is recorded as
// `invalid` with failReason `preview-copy` and a null cost, wall-clock and turns (no session ran),
// and computeLoss leaves `invalid` records out.
// Selection is restricted to LANDED tasks, located one of two ways because `prune-run` deletes a
// task's own branch once its run integrates — on a real fleet history, that branch is gone by the
// time this tool runs, so a scheme that depends on it existing finds nothing:
//   - if the task's branch still exists AND is itself an ancestor of the repository's default
//     branch, its own reflog gives the base directly (see resolveBaseSha below);
//   - otherwise, the task's integration merge is located directly in the default branch's history:
//     a merge commit M whose subject names the task id as a whole token, whose second parent's
//     diff against merge-base(M^1, M^2) is non-empty, touches only the task's declared files, and
//     whose plan text is readable at that base. A squash merge leaves no such M (no 2-parent
//     commit at all) and is correctly reported unlocatable, not silently skipped. A bare task id
//     is not unique across runs — reproduced directly, two runs that both had a "T1" resolved one
//     run's T1 to the OTHER run's merge — so a candidate whose subject names another run is
//     rejected, and ties are broken by the run id, next, as a whole token (hyphens included) in
//     the same subject (see resolveBaseByMerge); if more than one candidate still remains, the
//     task is `unlocatable` with every remaining merge's short sha named, never guessed at by
//     "earliest" or anything else.
// A task still pending, sitting on a run that never merged, or whose plan text is not readable at
// the resolved base, is excluded and reported with a reason rather than guessed at.
// Only a cell's hashed key (`sha256(repo realpath, run id, task id)`, pseudonymous and guessable —
// see hashCellKey) and its metrics are ever committed to `replay-results.jsonl` — never a task's
// title, brief or file paths. The tool is
// resumable: a usage-limit error stops the whole run cleanly with nothing written for the
// unfinished cell, and the next invocation with the same arguments picks up at the first missing
// (key, tier) pair.
//
// CLI: `node tools/replay/replay.mjs --roots <dir1,dir2,...> [--count 30] [--seed N]
// [--dry-run | --execute | --smoke] [--models '{"cheap":"...","mid":"...","capable":"..."}']`, or
// `node tools/replay/replay.mjs --preflight [--models ...]` on its own. `--roots` is required
// except for a bare `--preflight`. `--dry-run` is the default and only prints the planned cells —
// it never needs a model mapping. `--execute`, `--smoke` and `--preflight` do, and read it from
// `--models` when given, otherwise from `harnesses.claude.tierModels` in this tool's own
// `fleetmates.local.json`. `--preflight` runs the permission preflight alone, with the `cheap`
// model. `--smoke` runs exactly one cell at the `capable` tier on the first selected task, prints
// its status, `failReason`, cost and turns, and appends nothing. `--execute` reads and appends
// `replay-results.jsonl` and writes `loss.json` in `--out <dir>` when given, else in this tool's
// own `data/` directory.
// `node tools/replay/replay.mjs --recompute-loss --out <dir> [--seed N]` rewrites `loss.json`
// from the `replay-results.jsonl` already in `<dir>` alone — it runs no cell and spawns no
// process, and `replay-results.jsonl` itself is never modified. It exits 2 without writing
// `loss.json` when `replay-results.jsonl` is absent or holds no record, and records the bootstrap
// seed it used in `loss.json`. Used whenever the cost-matrix formula in `computeLoss` changes but
// the underlying replay data has not.
import {
  mkdtemp, mkdir, rm, readFile, writeFile, appendFile, realpath, readdir, cp, lstat, chmod,
  readlink,
} from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readState } from '../../scripts/state.mjs'
import { taskBranchName, filesetViolations, normalizePath } from '../../scripts/enforce.mjs'
import { defaultGitExec, createGit } from '../../scripts/git.mjs'
import { loadGateConfig, checksForPhase, previewLinks } from '../../scripts/gate-config.mjs'
import { runCommandCheck } from '../../scripts/gate-runner.mjs'
import { validateLinkPaths } from '../../scripts/preview-links.mjs'
import { parsePlan } from '../../scripts/plan-parser.mjs'
import { bulletSection } from '../../scripts/plan-sections.mjs'
import { NAMES } from '../../scripts/names.mjs'

export const DEFAULT_TIERS = ['cheap', 'mid', 'capable']
export const DEFAULT_COUNT = 30
// Any fixed integer works as the default; what matters is that it never changes on its own, so
// two operators who never pass --seed still get the same sample.
export const DEFAULT_SEED = 20260922
export const DEFAULT_BOOTSTRAP_SAMPLES = 2000
// See the PERMISSIONS paragraph in the header: sessions run unattended with this mode.
export const PERMISSION_MODE = 'bypassPermissions'
// The file the preflight session is asked to create in its scratch repository.
export const PREFLIGHT_FILE = 'fleetmates-preflight.txt'

function dataDirDefault() {
  return fileURLToPath(new URL('./data', import.meta.url))
}

// ---------------------------------------------------------------------------------------------
// Pseudonymous cell identity: sha256(realpath, runId, taskId), unsalted. It exists for dedupe and
// resume, not secrecy: anyone who can guess the repository path, the run slug and the task id can
// recompute it and so reverse it by dictionary (11 of the 30 keys in data/replay-results.jsonl
// were recovered that way from this repository's own run list). What the committed data never
// holds is task text: a title, brief, file path or code is never written, only this key and
// metrics. Changing the formula would orphan every committed key, so it stays as is.
// ---------------------------------------------------------------------------------------------
export function hashCellKey(realRoot, runId, taskId) {
  return createHash('sha256').update(`${realRoot}\u0000${runId}\u0000${taskId}`).digest('hex')
}

// ---------------------------------------------------------------------------------------------
// A small, seedable PRNG (mulberry32) and a Fisher-Yates shuffle built on it. Deterministic across
// runs and platforms: only integer arithmetic and IEEE-754 division, no Math.random.
// ---------------------------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededShuffle(list, seed) {
  const rng = mulberry32(seed)
  const arr = list.slice()
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

// FNV-1a over a string, folded into a 32-bit unsigned int — used only to derive a per-bucket seed
// offset from a bucket's own key, so two different bucket keys shuffle differently even under the
// same run seed. Not a security hash; collisions here only cost a little shuffle diversity.
function fnv1a(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

// ---------------------------------------------------------------------------------------------
// Task selection: merges tasks from every `.fleetmates/<run>/plan.json` under the given roots,
// keeps only LANDED tasks (see filterLandedTasks below), then picks a diverse sample. "Diverse"
// here means stratified by (root, tier) bucket, so one prolific root or one over-represented tier
// cannot crowd out the others; each bucket, and the order buckets are drawn from, is shuffled
// with the same fixed seed, so the sample is reproducible and does not depend on the order tasks
// happened to be merged in.
// ---------------------------------------------------------------------------------------------
export async function listRunPlans(roots, { readdirFn = readdir, readStateFn = readState } = {}) {
  const out = []
  for (const root of roots) {
    let entries
    try {
      entries = await readdirFn(path.join(root, '.fleetmates'), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const runId = entry.name
      const plan = await readStateFn(root, runId, 'plan')
      if (plan) out.push({ root, runId, plan })
    }
  }
  return out
}

// Deliberately carries no title, brief or deps text — only what routes and grades a cell
// (identity, declared files, tier and phase) and what locates its base commit (planPath). No
// longer carries runBranch: base resolution no longer needs it (see locateTasks below), and a
// stale or absent runBranch in an older plan.json must not be able to exclude a task that git
// evidence alone can still locate.
export function poolFromPlans(plans) {
  const pool = []
  for (const { root, runId, plan } of plans) {
    if (!plan || !Array.isArray(plan.tasks)) continue
    for (const task of plan.tasks) {
      if (!task || typeof task.id !== 'string') continue
      pool.push({
        root,
        runId,
        taskId: task.id,
        files: Array.isArray(task.files) ? task.files : [],
        tier: task.tier ?? null,
        phase: Number.isInteger(task.phase) ? task.phase : null,
        planPath: typeof plan.planPath === 'string' ? plan.planPath : null,
      })
    }
  }
  return pool
}

// The repository's default/base branch, by the same convention `scripts/cli.mjs`'s
// `resolveBaseBranch` uses when no `--base` is given: exactly one of `main`/`master` present.
// Ambiguous (both) or absent (neither) both answer null — a run cannot be confirmed landed
// against a base this cannot name.
async function resolveDefaultBranch(root, gitExecFn) {
  const git = createGit({ cwd: root, exec: gitExecFn })
  const present = []
  for (const candidate of ['main', 'master']) {
    try {
      if (await git.branchExists(candidate)) present.push(candidate)
    } catch {
      // treated as absent
    }
  }
  return present.length === 1 ? present[0] : null
}

// A dry run over a run still in progress selected pending tasks — nothing had landed anywhere,
// so replaying them measured nothing about a real outcome. "Landed" is checked in git, never
// inferred from status.json (written by the very agents being measured, and — measured directly
// across 101 tasks in 15 real runs — wrong for most of them even when the work is in fact on the
// default branch): a task's branch, live or not, only counts once it is (or its integration merge
// is) an ancestor of the repository's default branch.
async function isAncestorOf(root, candidate, ancestorOf, gitExecFn) {
  const git = createGit({ cwd: root, exec: gitExecFn })
  try {
    return await git.isAncestor(candidate, ancestorOf)
  } catch {
    return false
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A run id as a whole token. Run ids are hyphenated slugs and `\b` treats '-' as a boundary, so
// `\bfoo\b` matched inside "foo-bar": run foo's squash-merged T1 resolved to run foo-bar's merge.
// The anchors here treat '-' as part of the id.
function runIdPattern(runId) {
  return new RegExp(`(?<![\\w-])${escapeRegExp(runId)}(?![\\w-])`)
}

// The run a merge subject may name: `prefixed` from a leading `merge(<run>):`, which always names
// a run; else `trailing` from a trailing single-token `(<x>)`, which is only a CANDIDATE — the
// caller counts it as a run id only when x is a known run (see knownRunIdsForRoots), because an
// integrator also titles its own merges "... (parser)", "(#12)" or "(wip)". Each is null when
// absent.
function runNamedInSubject(subject) {
  const prefixed = /^merge\(([^()\s]+)\)/i.exec(subject)
  if (prefixed) return { prefixed: prefixed[1], trailing: null }
  const trailing = /\(([^()\s]+)\)\s*$/.exec(subject)
  return { prefixed: null, trailing: trailing ? trailing[1] : null }
}

// Every run id any root knows of: a `.fleetmates/<run>` or `.teammates/<run>` state directory that
// holds a `plan.json` or `status.json` (so a non-run directory such as `.fleetmates/index` never
// counts; neither file is parsed), or a `run/<run>` branch. Read from the whole set of roots, so a run whose state lives in another
// checkout still counts. Only the trailing `(<x>)` form consults this.
async function knownRunIdsForRoots(roots, { gitExecFn, readdirFn = readdir }) {
  const ids = new Set()
  for (const root of roots) {
    for (const stateDir of ['.fleetmates', '.teammates']) {
      const entries = await readdirFn(path.join(root, stateDir), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dir = path.join(root, stateDir, entry.name)
        const isRun = await lstat(path.join(dir, 'plan.json')).then(() => true, () => false)
          || await lstat(path.join(dir, 'status.json')).then(() => true, () => false)
        if (isRun) ids.add(entry.name)
      }
    }
    const res = await gitExecFn(['for-each-ref', '--format=%(refname)', 'refs/heads/run/'], root)
    if (res.code !== 0) continue
    for (const ref of res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      ids.add(ref.slice('refs/heads/run/'.length))
    }
  }
  return ids
}

// Every merge commit reachable from the default branch, subject included — fetched once per root
// (see mergeCache in locateTasks) rather than once per task, since a root with many tasks would
// otherwise re-walk the same history for each one.
async function listMergeSubjects(root, defaultBranch, gitExecFn) {
  const res = await gitExecFn(['log', defaultBranch, '--merges', '--format=%H%x09%s'], root)
  if (res.code !== 0) return []
  return res.stdout.split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t')
    return tab === -1 ? { sha: line, subject: '' } : { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
  })
}

async function commitParents(root, sha, gitExecFn) {
  const res = await gitExecFn(['log', '-1', '--format=%P', sha], root)
  if (res.code !== 0) return []
  return res.stdout.trim().split(/\s+/).filter(Boolean)
}

// Locates a task's integration merge M directly in the default branch's history, for when the
// task's own branch is gone (pruned after integration — the common case on a real fleet history).
// A bare task id is not unique across runs — reproduced directly: two runs that both had a "T1"
// resolved run B's T1 to run A's merge, because the id alone matched and an old "earliest in
// history" tiebreak just picked whichever run happened to land first. That tiebreak is GONE. The
// rule, applied strictly in this order, never falling back to a guess once it runs out:
//   (a) a candidate M must: name the task id as a whole token in its subject (`\bT<n>\b`, so "T3"
//       matches inside "teammates/reporting/T3" — bounded by '/' and the surrounding punctuation,
//       not just whitespace — but never inside "T30"); have a second parent whose diff against
//       merge-base(M^1, M^2) is non-empty and touches only the task's declared files; and have
//       the task's own planPath readable at that base. A squash merge produces no 2-parent commit
//       at all, so `--merges` never surfaces one.
//   (b) a candidate whose subject never names THIS run's own id, and names a DIFFERENT run —
//       either a known run id (one with `.fleetmates/<run>/plan.json` under the roots) as a whole
//       token, or any run in a leading `merge(<run>):`, or a trailing single-token `(<x>)` when x
//       is a known run (a `.fleetmates`/`.teammates` state dir holding plan.json or status.json,
//       or a `run/<x>` branch, in any root — see knownRunIdsForRoots) — is rejected outright,
//       even when it is the only candidate left. A trailing `(<x>)` that is not a known run
//       ("(parser)", "(#12)", "(index)") is an ordinary word. A whole token treats '-' as
//       part of the id (see runIdPattern). A merge whose subject names no run in those ways is a
//       neutral candidate, and a sole neutral candidate is accepted.
//       Reproduced directly: run A's T1, squash-merged (leaving no valid merge of its own), still
//       had exactly one OTHER candidate left after (a) — run B's own, unrelated "T1" — and the old
//       code accepted whatever was left standing regardless of whose subject it actually was. If
//       every surviving candidate belongs to another run, the task is unlocatable, not guessed at.
//   (c) of what is left, if any surviving candidate's subject ALSO names OUR OWN run id as a whole
//       token, only those survive — this is what tells run A's "T1" apart from run B's "T1" when
//       the integrator's own merge subject says which run it was.
//   (d) exactly one candidate left is the answer. More than one is reported unlocatable, every
//       remaining candidate's short sha named in the reason.
async function resolveBaseByMerge({
  root, runId, taskId, declaredFiles, planPath, defaultBranch, gitExecFn, mergeCache, knownRunIds = [],
  subjectRunIds = new Set(),
}) {
  let merges = mergeCache.get(root)
  if (!merges) {
    merges = await listMergeSubjects(root, defaultBranch, gitExecFn)
    mergeCache.set(root, merges)
  }
  const taskPattern = new RegExp(`\\b${escapeRegExp(taskId)}\\b`)
  const subjectMatches = merges.filter((m) => taskPattern.test(m.subject))
  if (subjectMatches.length === 0) {
    return { baseSha: null, reason: `no integration merge in ${defaultBranch}'s history mentions ${taskId}` }
  }
  let passing = []
  for (const m of subjectMatches) {
    const parents = await commitParents(root, m.sha, gitExecFn)
    if (parents.length < 2) continue
    const [p1, p2] = parents
    const mergeBaseRes = await gitExecFn(['merge-base', p1, p2], root)
    if (mergeBaseRes.code !== 0) continue
    const base = mergeBaseRes.stdout.trim()
    const diffRes = await gitExecFn(['diff', '--name-only', '--no-renames', base, p2, '--'], root)
    if (diffRes.code !== 0) continue
    const changed = diffRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    if (changed.length === 0) continue
    if (filesetViolations(changed, declaredFiles).length > 0) continue
    if (!planPath) continue
    const existsRes = await gitExecFn(['cat-file', '-e', `${base}:${planPath}`], root)
    if (existsRes.code !== 0) continue
    passing.push({ sha: m.sha, subject: m.subject, base })
  }
  if (passing.length === 0) {
    return {
      baseSha: null,
      reason: `${subjectMatches.length} merge(s) in ${defaultBranch}'s history mention ${taskId}, `
        + `but none change only its declared files with ${planPath ?? 'its plan'} readable at that `
        + 'base (a squash merge, or a different task\'s merge)',
    }
  }
  const runPattern = runIdPattern(runId)
  const otherRunIds = knownRunIds.filter((r) => r !== runId)
  const otherRunPatterns = otherRunIds.map(runIdPattern)
  const belongsToAnotherRun = (subject) => {
    if (runPattern.test(subject)) return false
    if (otherRunPatterns.some((p) => p.test(subject))) return true
    // A subject naming our own run already returned above, so a run named here is another's.
    const { prefixed, trailing } = runNamedInSubject(subject)
    if (prefixed !== null) return true
    return trailing !== null && subjectRunIds.has(trailing)
  }
  const notOtherRuns = passing.filter((p) => !belongsToAnotherRun(p.subject))
  if (notOtherRuns.length === 0) {
    return {
      baseSha: null,
      reason: `only other runs' merges match ${taskId} (every surviving candidate's subject names `
        + 'a different run)',
    }
  }
  passing = notOtherRuns

  if (passing.length > 1) {
    const runMatches = passing.filter((p) => runPattern.test(p.subject))
    if (runMatches.length > 0) passing = runMatches
  }
  if (passing.length === 1) {
    return { baseSha: passing[0].base }
  }
  const shas = passing.map((p) => p.sha.slice(0, 12)).join(', ')
  return {
    baseSha: null,
    reason: `ambiguous: ${passing.length} integration merges match ${taskId} (${shas})`,
  }
}

// The single entry point for base resolution: for every pooled task, tries the branch's own
// reflog first (only accepted once the branch itself is confirmed landed — an ancestor of the
// default branch — so a live but never-merged branch is not mistaken for a finished one), falls
// back to the merge-search above when the branch is gone or never landed, and finally confirms the
// plan text this task needs is actually readable at whichever base was found. Every task in `pool`
// is returned exactly once, either `{ ...item, located: true, method, baseSha }` or
// `{ ...item, located: false, reason }` — nothing is silently dropped, so a caller can report full
// per-root counts (see main's --dry-run output) rather than just a smaller, unexplained pool.
export async function locateTasks(pool, { gitExecFn = defaultGitExec } = {}) {
  const defaultBranchCache = new Map()
  const mergeCache = new Map()
  // Every distinct run id seen for a root, so resolveBaseByMerge can tell "this candidate's
  // subject names some OTHER run in the same repo" apart from "this candidate's subject names no
  // run at all" — the latter stays a neutral, still-ambiguous candidate; the former is rejected
  // outright, even as the sole survivor.
  const runIdsByRoot = new Map()
  for (const item of pool) {
    if (!runIdsByRoot.has(item.root)) runIdsByRoot.set(item.root, new Set())
    runIdsByRoot.get(item.root).add(item.runId)
  }
  const subjectRunIds = await knownRunIdsForRoots([...runIdsByRoot.keys()], { gitExecFn })
  for (const ids of runIdsByRoot.values()) for (const id of ids) subjectRunIds.add(id)
  const out = []
  for (const item of pool) {
    if (!defaultBranchCache.has(item.root)) {
      defaultBranchCache.set(item.root, await resolveDefaultBranch(item.root, gitExecFn))
    }
    const defaultBranch = defaultBranchCache.get(item.root)
    let baseSha = null
    let method = null
    let reason = null
    if (!defaultBranch) {
      reason = 'no default branch (main or master) could be resolved'
    } else {
      const taskBranch = taskBranchName(item.runId, item.taskId)
      const reflogSha = await resolveBaseSha({
        root: item.root, runId: item.runId, taskId: item.taskId, gitExecFn,
      })
      if (reflogSha && await isAncestorOf(item.root, taskBranch, defaultBranch, gitExecFn)) {
        baseSha = reflogSha
        method = 'reflog'
      }
      if (!baseSha) {
        const merged = await resolveBaseByMerge({
          root: item.root,
          runId: item.runId,
          taskId: item.taskId,
          declaredFiles: item.files,
          planPath: item.planPath,
          defaultBranch,
          gitExecFn,
          mergeCache,
          knownRunIds: [...(runIdsByRoot.get(item.root) ?? [])],
          subjectRunIds,
        })
        if (merged.baseSha) {
          baseSha = merged.baseSha
          method = 'merge'
        } else {
          reason = merged.reason
        }
      }
    }
    if (!baseSha) {
      out.push({ ...item, located: false, reason: reason ?? 'could not resolve a base commit' })
      continue
    }
    if (!item.planPath) {
      out.push({ ...item, located: false, reason: 'no planPath recorded for this run' })
      continue
    }
    const existsRes = await gitExecFn(['cat-file', '-e', `${baseSha}:${item.planPath}`], item.root)
    if (existsRes.code !== 0) {
      out.push({ ...item, located: false, reason: `${item.planPath} does not exist at the resolved base commit` })
      continue
    }
    out.push({
      ...item, located: true, method, baseSha,
    })
  }
  return out
}

export function selectDiverseSample(pool, { count, seed }) {
  if (!Number.isInteger(count) || count <= 0 || pool.length === 0) return []
  const bucketsMap = new Map()
  for (const item of pool) {
    const bucketKey = `${item.root}\u0000${item.tier ?? 'unknown'}`
    if (!bucketsMap.has(bucketKey)) bucketsMap.set(bucketKey, [])
    bucketsMap.get(bucketKey).push(item)
  }
  // Sorted before shuffling so the result depends only on the SET of (root, tier) buckets and
  // their contents, never on the order the caller happened to hand tasks in.
  const bucketOrder = [...bucketsMap.keys()].sort()
  const orderedKeys = seededShuffle(bucketOrder, seed)
  const stableItemKey = (item) => `${item.root}\u0000${item.runId}\u0000${item.taskId}`
  const buckets = orderedKeys.map((key) => {
    const items = [...bucketsMap.get(key)].sort((a, b) => (stableItemKey(a) < stableItemKey(b) ? -1 : 1))
    return seededShuffle(items, seed + fnv1a(key))
  })
  const picked = []
  let round = 0
  while (picked.length < count) {
    let addedThisRound = 0
    for (const bucket of buckets) {
      if (picked.length >= count) break
      if (round < bucket.length) {
        picked.push(bucket[round])
        addedThisRound += 1
      }
    }
    if (addedThisRound === 0) break
    round += 1
  }
  return picked
}

// ---------------------------------------------------------------------------------------------
// Base commit resolution, from the task branch's OWN reflog rather than from any ancestry query.
// `git checkout -B <branch> <base>` writes exactly one reflog entry for the branch's creation,
// whose value IS the base commit — and nothing that happens afterward (more commits, a rebase, or
// exactly the merge `filterLandedTasks` now requires before a task is even selected) removes that
// entry. A plain `merge-base(taskBranch, runBranch)` was tried first and is WRONG for a landed
// task specifically: once the run branch has merged the task branch in, the task branch is an
// ANCESTOR of the run branch, and merge-base of an ancestor and its descendant is the ancestor
// itself — the task's own finished tip, not what it started from. Confirmed directly, not
// inferred: a fixture merging a task branch into its run branch with `--no-ff` and then diffing
// `merge-base(taskBranch, runBranch)` against the branch's own oldest reflog entry showed the
// former landing on the task's finished commit and the latter on the true fork point.
// `--walk-reflogs`, oldest entry first: confirmed against this very repository's own task
// branches (`git reflog show fleetmates/<run>/<task>`), whose oldest line reads
// "branch: Created from <base>" and names the true starting commit even after later commits, a
// merge, and a rebase.
// Returns null (never throws) when the branch has no reflog to read (deleted, or its history
// predates git's reflog retention) — the caller skips the task rather than guessing a base.
export async function resolveBaseSha({ root, runId, taskId, gitExecFn = defaultGitExec }) {
  const taskBranch = taskBranchName(runId, taskId)
  const res = await gitExecFn(['log', '--walk-reflogs', '--format=%H', taskBranch], root)
  if (res.code !== 0) return null
  const shas = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  return shas.length > 0 ? shas[shas.length - 1] : null
}

// ---------------------------------------------------------------------------------------------
// Isolation. `git archive <baseSha>` reads out exactly the tree at that one commit; extracted
// into a fresh directory and committed as a single, parentless commit via `git init`, the result
// has no other ref, no reflog beyond its own creation, and no object reachable that was not
// already part of the base tree. Nothing here writes to `root` at any point — `git archive` only
// reads. Returns the NEW commit's own sha (a different object from `baseSha`, since it has no
// parent and different metadata, even though its tree content is identical): every later diff in
// this cell must be taken against THIS sha, not the source repository's `baseSha`.
// ---------------------------------------------------------------------------------------------
function execCapture(bin, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (err) => resolve({ code: 1, stdout: '', stderr: String(err?.message ?? err) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

export async function materializeBaseTree({
  root, baseSha, tmpRoot = tmpdir(), gitExecFn = defaultGitExec, tarBin = 'tar',
}) {
  await mkdir(tmpRoot, { recursive: true })
  const cloneDir = await mkdtemp(path.join(tmpRoot, 'fleetmates-replay-'))
  const tarPath = `${cloneDir}.tar`
  // core.autocrlf off: git archive applies the operator's eol conversion, and on Windows that
  // rewrote every text file to CRLF, so the cell no longer matched the base commit's bytes.
  const archiveRes = await gitExecFn(['-c', 'core.autocrlf=false', 'archive', '--format=tar', '-o', tarPath, baseSha], root)
  if (archiveRes.code !== 0) {
    throw new Error(`git archive ${baseSha} failed: ${(archiveRes.stderr || archiveRes.stdout).trim()}`)
  }
  try {
    const extractRes = await execCapture(tarBin, ['-xf', tarPath, '-C', cloneDir], tmpRoot)
    if (extractRes.code !== 0) {
      throw new Error(`tar -xf failed while materializing ${baseSha}: ${(extractRes.stderr || extractRes.stdout).trim()}`)
    }
  } finally {
    await rm(tarPath, { force: true })
  }
  const initRes = await gitExecFn(['init', '--quiet'], cloneDir)
  if (initRes.code !== 0) {
    throw new Error(`git init failed while materializing ${baseSha}: ${(initRes.stderr || initRes.stdout).trim()}`)
  }
  const addRes = await gitExecFn(['add', '-A'], cloneDir)
  if (addRes.code !== 0) {
    throw new Error(`git add failed while materializing ${baseSha}: ${(addRes.stderr || addRes.stdout).trim()}`)
  }
  const commitRes = await gitExecFn(
    ['-c', 'user.email=replay@fleetmates.invalid', '-c', 'user.name=fleetmates-replay',
      'commit', '--quiet', '--allow-empty', '-m', 'base'],
    cloneDir,
  )
  if (commitRes.code !== 0) {
    throw new Error(`git commit failed while materializing ${baseSha}: ${(commitRes.stderr || commitRes.stdout).trim()}`)
  }
  const headRes = await gitExecFn(['rev-parse', 'HEAD'], cloneDir)
  if (headRes.code !== 0) {
    throw new Error(`could not read the materialized commit for ${baseSha}: ${(headRes.stderr || headRes.stdout).trim()}`)
  }
  return { cloneDir, baseSha: headRes.stdout.trim() }
}

export async function removeClone(cloneDir) {
  await rm(cloneDir, { recursive: true, force: true })
}

function isOutsideDir(root, target) {
  const rel = path.relative(root, target)
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}

// Recursive byte total of a real directory on disk (not the git tree — `preview.link` entries
// like `node_modules` are typically gitignored, so this has to read the filesystem). `lstat`, not
// `stat`: counts a symlink's own small size rather than following it, matching what
// `verbatimSymlinks` below actually copies.
export async function directoryByteSize(target) {
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) {
      total += await directoryByteSize(full)
    } else {
      try {
        total += (await lstat(full)).size
      } catch {
        // Vanished between readdir and lstat — nothing left to count.
      }
    }
  }
  return total
}

// `cp -a --reflink=auto` semantics: try the real `cp` binary first (cheap — copy-on-write on a
// filesystem that supports it, ordinary otherwise, and coreutils' `--reflink=auto` already falls
// back on its own when reflink is not supported), and fall back to `fs.cp` — slower, but built in
// and needs no external binary — whenever the external command is missing or fails outright.
async function copyWithReflinkAttempt(target, dst, execFn = execCapture) {
  const res = await execFn('cp', ['-a', '--reflink=auto', target, dst], path.dirname(dst))
  if (res.code === 0) return true
  await rm(dst, { recursive: true, force: true })
  return false
}

// Copies (never symlinks — see the file header) the manifest's `preview.link` entries from the
// source repo into the materialized cell, under the same path-safety rule `linkInto` applies (a
// link target or destination may not resolve outside the repository / the cell): resolved via
// `realpath` on both sides, since a textual check alone misses an in-repo `node_modules` that is
// ITSELF a symlink into a shared store (pnpm's default) pointing outside the repository.
// `verbatimSymlinks: true` preserves any symlinks already inside the copied directory as
// symlinks (matching `cp -a`, which real dependency trees rely on, e.g. pnpm's own internal
// linking) rather than silently dereferencing them — the residual, narrow case this does NOT
// close: an inner symlink already pointing at an absolute path outside the tree, present before
// the copy, is copied as-is and still points there afterward. `preview.link` entries observed in
// this codebase (`node_modules`) do not do that; a manifest whose declared build input does is not
// protected by this function, only by the copy replacing the OUTER symlink this tool itself used
// to create.
export async function copyPreviewPaths(dir, repoRoot, paths = []) {
  const created = []
  const teardown = async () => {
    for (const dst of created.reverse()) {
      await makeTreeWritable(dst).catch(() => {})
      await rm(dst, { recursive: true, force: true }).catch(() => {})
    }
  }
  const realRepoRoot = await realpath(repoRoot).catch(() => repoRoot)
  // Resolved once, and dst below is built from THIS, not `dir` — a `dst` built from `dir` and
  // compared against `realpath(dir)` throws "outside the preview tree" for every entry when `dir`
  // itself sits under a symlink (a symlinked TMPDIR, or macOS's default /var -> /private/var):
  // the two sides of that comparison were never the same string to begin with. Building `dst` from
  // the resolved root from the start keeps the check and the actual copy destination consistent.
  const realDir = await realpath(dir).catch(() => dir)
  for (const entry of paths) {
    const target = path.resolve(repoRoot, entry)
    const realTarget = await realpath(target).catch(() => null)
    if (realTarget === null) {
      // Missing build input: the same best-effort contract the caller already has around this —
      // the command checks that needed it fail on their own, honestly, rather than the whole
      // cell aborting for one absent manifest entry.
      continue
    }
    if (isOutsideDir(realRepoRoot, realTarget)) {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)} resolves outside the repository`)
    }
    const info = await lstat(realTarget)
    if (!info.isDirectory()) {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)}: not a directory`)
    }
    const dst = path.resolve(realDir, entry)
    // The textual check alone missed a nested entry under a directory the base tree holds as a
    // symlink: `vendor/nm` with `vendor -> /elsewhere` is inside the cell as text, and the copy
    // landed in /elsewhere/nm. The deepest existing ancestor of `dst` is resolved as well.
    if (isOutsideDir(realDir, dst) || isOutsideDir(realDir, await realpathOfDeepestExisting(dst))) {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)} would be copied outside the preview tree`)
    }
    const alreadyThere = await lstat(dst).then(() => true, () => false)
    if (alreadyThere) {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)} is already present in the materialized `
        + 'tree; copying over it would shadow it')
    }
    await mkdir(path.dirname(dst), { recursive: true })
    // Copy FROM realTarget, not target: `cp -a`/`fs.cp(..., { verbatimSymlinks: true })` copy a
    // symlink argument AS a symlink, not its content. If the top-level manifest entry (e.g.
    // `node_modules`) is itself a symlink — an in-repo one is common (pnpm's own store layout) —
    // copying `target` verbatim would land a SYMLINK in the cell that still points back into the
    // source repo, exactly the write-through door this function exists to close. `realTarget` is
    // already fully resolved, so this dereferences ONLY the top-level entry; a symlink found
    // somewhere INSIDE the copied tree is still preserved as a symlink, unchanged from before.
    const reflinked = await copyWithReflinkAttempt(realTarget, dst)
    if (!reflinked) {
      await cp(realTarget, dst, { recursive: true, verbatimSymlinks: true })
    }
    created.push(dst)
  }
  return teardown
}

// ---------------------------------------------------------------------------------------------
// Guarding the copied link trees during a session. They are excluded from the fileset check (see
// verifyCell), so an edit a session made under one went unseen. runTierCell fingerprints them,
// locks them read-only only while a session runs, unlocks them and fingerprints again; any
// difference fails the cell as `link-modified`. The lock alone stops only an accidental write —
// a bypassPermissions session can `chmod -R u+w` and edit — so the fingerprint is the check. Gate
// commands run after the unlock, on the writable tree, the way the real gate's linked directories
// are writable (a check that writes node_modules/.cache must not fail here and pass there).
// ---------------------------------------------------------------------------------------------

// Each declared link path under `dir` (resolved via realpath, as copyPreviewPaths builds them).
async function linkTreeRoots(dir, paths) {
  const realDir = await realpath(dir).catch(() => dir)
  return paths.map((entry) => ({ entry, abs: path.resolve(realDir, entry) }))
}

// One line per path under each declared link, sorted: relative path, type, size, mode, and a
// sha256 of a file's content or a symlink's target text. A declared link that is absent adds no
// line, so a session creating one adds lines and changes the fingerprint.
export async function fingerprintLinkTrees(dir, paths = []) {
  const lines = []
  const walk = async (abs, rel) => {
    let info
    try {
      info = await lstat(abs)
    } catch {
      return
    }
    const mode = (info.mode & 0o7777).toString(8)
    if (info.isSymbolicLink()) {
      lines.push(`${rel}\u0000symlink\u0000${mode}\u0000${await readlink(abs)}`)
    } else if (info.isDirectory()) {
      lines.push(`${rel}\u0000dir\u0000${mode}`)
      for (const name of (await readdir(abs)).sort()) await walk(path.join(abs, name), `${rel}/${name}`)
    } else if (info.isFile()) {
      const sha = createHash('sha256').update(await readFile(abs)).digest('hex')
      lines.push(`${rel}\u0000file\u0000${info.size}\u0000${mode}\u0000${sha}`)
    } else {
      lines.push(`${rel}\u0000other\u0000${mode}`)
    }
  }
  for (const { entry, abs } of await linkTreeRoots(dir, paths)) await walk(abs, entry)
  return lines.join('\n')
}

// Removes every write bit from each declared link tree — files and directories; symlinks are
// skipped, never chmod'ed, since chmod follows a symlink and an inner one kept verbatim by the
// copy may point outside the cell. Returns `unlock`, which restores each path's exact prior mode
// only while it is still the same file: a path the session removed, or replaced (by a symlink
// that chmod would follow out of the cell, or by another inode), is skipped.
export async function lockLinkTrees(dir, paths = []) {
  const modes = []
  const walk = async (abs) => {
    const info = await lstat(abs).catch(() => null)
    if (!info || info.isSymbolicLink()) return
    const mode = info.mode & 0o7777
    modes.push({ abs, mode, dev: info.dev, ino: info.ino })
    if (info.isDirectory()) {
      for (const name of await readdir(abs)) await walk(path.join(abs, name))
    }
    await chmod(abs, mode & ~0o222)
  }
  const unlock = async () => {
    for (const { abs, mode, dev, ino } of modes) {
      const now = await lstat(abs).catch(() => null)
      if (!now || now.isSymbolicLink() || now.dev !== dev || now.ino !== ino) continue
      await chmod(abs, mode).catch(() => {})
    }
  }
  try {
    for (const { abs } of await linkTreeRoots(dir, paths)) await walk(abs)
  } catch (err) {
    await unlock()
    throw err
  }
  return unlock
}

// `path` itself when it exists, else its nearest existing ancestor, resolved via `realpath`.
async function realpathOfDeepestExisting(target) {
  let current = target
  for (;;) {
    try {
      return await realpath(current)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

// Adds the owner write bit throughout a copied tree before teardown removes it: a directory
// without write permission cannot have its entries unlinked, and a tree can still be locked (see
// lockLinkTrees) when a session throws before its unlock. Symlinks are skipped, never chmod'ed:
// chmod follows a symlink, and an inner symlink kept verbatim by the copy may point outside the cell.
async function makeTreeWritable(target) {
  const info = await lstat(target)
  if (info.isSymbolicLink()) return
  await chmod(target, (info.mode & 0o7777) | 0o200)
  if (info.isDirectory()) {
    for (const entry of await readdir(target)) await makeTreeWritable(path.join(target, entry))
  }
}

// ---------------------------------------------------------------------------------------------
// The prompt: built directly from the task's own section of the plan AS COMMITTED at the base
// commit — never a live `scripts/cli.mjs brief`, which assumes a branch, a run and a completion
// command this isolated, single-commit cell has none of.
// ---------------------------------------------------------------------------------------------
export async function planMarkdownAtBase({ root, baseSha, planPath, gitExecFn = defaultGitExec }) {
  const res = await gitExecFn(['show', `${baseSha}:${planPath}`], root)
  if (res.code !== 0) {
    throw new Error(`could not read ${planPath} at ${baseSha}: ${(res.stderr || res.stdout).trim()}`)
  }
  return res.stdout
}

export function buildReplayPrompt({ markdown, taskId }) {
  const tasks = parsePlan(markdown)
  const task = tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`task ${taskId} is not in the plan at the base commit`)
  const constraints = bulletSection(markdown, 'Global Constraints').map((entry) => entry.text)
  const lines = [
    `You are implementing task ${task.id}: ${task.title}.`,
    '',
    'TASK. Implement the following, exactly as specified, working directly in the current',
    'directory. There is no branch to check out, no run to record and no completion command to',
    'run here — this is an isolated cell with no other history in it. Just do the work and finish.',
    '',
    task.brief,
    '',
    `FILES. You may create or modify ONLY these files: ${task.files.join(', ')}.`,
    'Touching any other file fails verification.',
    '',
  ]
  if (constraints.length > 0) {
    lines.push('GLOBAL CONSTRAINTS:')
    for (const c of constraints) lines.push(`- ${c}`)
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Parsing a `claude -p --output-format json` turn. `--output-format json` (not `stream-json`)
// prints exactly one JSON object summarising the whole turn. Three failure shapes are told apart
// on purpose, because they are handled differently by the caller:
//   - malformed: the text is not a JSON object at all — there is no session to resume and no
//     cost to report.
//   - usageLimit: well-formed, `is_error: true`, and the result text names a usage limit — the
//     caller must stop the whole run, not just fail this cell.
//   - an ordinary result, whose `total_cost_usd` may be ABSENT. Absence is recorded as
//     `costMissing: true` / `totalCostUsd: null`, never defaulted to 0 — a missing figure and a
//     free turn are different facts and must not collapse into the same number.
// It also reads `permission_denials` (as a count plus the sorted, distinct tool names — never the
// denied tool's input) and `num_turns`, which is `turns: null` when absent, never 0.
// ---------------------------------------------------------------------------------------------
function malformedOutput() {
  return {
    malformed: true,
    totalCostUsd: null,
    costMissing: true,
    sessionId: null,
    usageLimit: false,
    isError: false,
    permissionDenials: 0,
    deniedTools: [],
    turns: null,
  }
}

function distinctToolNames(denials) {
  const names = new Set()
  for (const d of denials) {
    names.add(typeof d?.tool_name === 'string' && d.tool_name !== '' ? d.tool_name : 'unknown')
  }
  return [...names].sort()
}

export function parseClaudeOutput(raw) {
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return malformedOutput()
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return malformedOutput()
  }
  const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials : []
  const turns = Number.isInteger(obj.num_turns) && obj.num_turns >= 0 ? obj.num_turns : null
  const totalCostUsd = typeof obj.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd)
    ? obj.total_cost_usd
    : null
  const isError = obj.is_error === true
  const resultText = typeof obj.result === 'string' ? obj.result : ''
  const sessionId = typeof obj.session_id === 'string' && obj.session_id !== '' ? obj.session_id : null
  return {
    malformed: false,
    totalCostUsd,
    costMissing: totalCostUsd === null,
    isError,
    resultText,
    sessionId,
    usageLimit: isError && /usage limit/i.test(resultText),
    permissionDenials: denials.length,
    deniedTools: distinctToolNames(denials),
    turns,
  }
}

// One headless turn: writes `prompt` to the child's stdin, waits for exit, and parses its stdout.
// Always spawned with `--permission-mode bypassPermissions` — see PERMISSIONS in the header — and
// with `--strict-mcp-config`, so a measured session never loads the operator's own global MCP
// servers (`~/.claude.json` and similar): those are per-operator, unrelated to the task under
// replay, and would make the measured cost/turns depend on whatever happens to be configured on
// the machine running the replay rather than on the tier alone.
function attemptOnce({
  cwd, prompt, model, claudeBin, resumeSessionId, spawnFn = spawn, env,
}) {
  return new Promise((resolve) => {
    const args = [
      '-p', '--model', model, '--output-format', 'json', '--permission-mode', PERMISSION_MODE,
      '--strict-mcp-config',
    ]
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    const startedAt = performance.now()
    const child = spawnFn(claudeBin, args, { cwd, env: env ? { ...process.env, ...env } : process.env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    const finish = () => {
      resolve({ stdout, stderr, wallClockMs: performance.now() - startedAt, parsed: parseClaudeOutput(stdout) })
    }
    child.on('error', (err) => {
      stderr += String(err?.message ?? err)
      resolve({
        stdout: '', stderr, wallClockMs: performance.now() - startedAt, parsed: malformedOutput(),
      })
    })
    child.on('close', finish)
    child.stdin?.write(prompt ?? '')
    child.stdin?.end()
  })
}

function fixMessage(failures) {
  return [
    'The previous attempt did not pass verification:',
    '',
    ...failures.map((f) => `- ${f}`),
    '',
    'Fix these issues, then finish.',
  ].join('\n')
}

// Runs the task's OWN phase's `command` gate checks (read from `config`, already loaded from the
// materialized clone — which IS the manifest as committed at the base commit) plus a fileset
// check. `agent`, `fileset` and `ownership` manifest checks are not run here: `agent` needs a
// reviewer this tool does not dispatch, and `fileset`/`ownership` are replaced by the direct
// comparison below, which is what a single-task, no-siblings replay cell actually needs from
// them. `links` (this cell's `preview.link` entries, already copied in) are excluded from staging
// via a `:(exclude)` pathspec — a plain `git add -A` would stage the whole copied tree as
// undeclared new files and fail every cell that needed one.
async function verifyCell({
  cloneDir, baseSha, declaredFiles, config, phaseName, links = [], runCheckFn = runCommandCheck,
  gitExecFn = defaultGitExec,
}) {
  const failures = []
  // One reason kind per failure, in the order found — `failures` above carries command output for
  // the fix-round message; these never do (see pickFailReason).
  const reasons = []
  const checks = config ? checksForPhase(config, phaseName).filter((c) => c?.kind === 'command') : []
  for (const check of checks) {
    const result = await runCheckFn(check, { cwd: cloneDir })
    if (result.status !== 'pass') {
      failures.push(`${check.name}: ${result.output || `exit ${result.exitCode}`}`)
      reasons.push(`command:${check.name}`)
    }
  }
  // `git diff <base> --` never reports an UNTRACKED file — and a session graded here is never
  // asked to commit, only to leave files in the working tree — so everything is staged first.
  // Confirmed directly: with only the base flag and no `--cached`, a freshly `writeFileSync`'d
  // file that was never `git add`ed does not appear in `git diff --name-only <base> --` at all,
  // which would have made the fileset check silently pass any undeclared file a cell's session
  // left lying around.
  const pathspec = ['.', ...links.map((l) => `:(exclude)${l}`)]
  const add = await gitExecFn(['add', '-A', '--', ...pathspec], cloneDir)
  if (add.code !== 0) {
    failures.push(`could not stage the working tree for the fileset check: ${(add.stderr || add.stdout).trim()}`)
    reasons.push('fileset')
  }
  const diff = await gitExecFn(['diff', '--name-only', '--no-renames', '--cached', baseSha, '--'], cloneDir)
  if (diff.code !== 0) {
    failures.push(`could not compute the changed files: ${(diff.stderr || diff.stdout).trim()}`)
    reasons.push('fileset')
  } else {
    const changed = diff.stdout.split(/\r?\n/).filter(Boolean)
    const violations = filesetViolations(changed, declaredFiles)
    if (violations.length > 0) {
      failures.push(`fileset: changes outside the declared files: ${violations.join(', ')}`)
      reasons.push('fileset')
    }
    // A session that changes nothing — or changes only files outside its declared set — is not a
    // pass: the gate's own command checks may not depend on the declared files at all (a project
    // whose whole suite already passes at the base commit), so this is the one check standing
    // between "did the work" and "did nothing and got graded pass anyway".
    const declaredSet = new Set((declaredFiles ?? []).map(normalizePath))
    const touchedDeclared = changed.some((f) => declaredSet.has(normalizePath(f)))
    if (changed.length === 0 || !touchedDeclared) {
      failures.push('no declared file changed — a no-op session is not a pass')
      reasons.push('no-op')
    }
  }
  return { passed: failures.length === 0, failures, reasons }
}

// The one `failReason` a failed cell records, from a fixed set: `link-modified` when a session
// changed a copied preview.link tree (see lockLinkTrees — it outranks everything, since no gate
// command ran against that tree); `session-error` when the last
// session's output was malformed or an error result; otherwise `fileset` (something outside the
// declared files changed — the session acted, just in the wrong place), then `no-op` (nothing
// declared changed, which usually explains any failing command check too), then the FIRST failing
// command check as `command:<check name>`. The check name comes from the gate manifest; command output
// never reaches it.
// A failed verification always records at least one reason (every `failures.push` in verifyCell
// has a matching `reasons.push`), so running out of reasons is a bug here, not a session outcome:
// it throws rather than defaulting to a label that would hide which branch was missed.
export function pickFailReason(verification, lastParsed) {
  const reasons = verification.reasons ?? []
  if (reasons.includes('link-modified')) return 'link-modified'
  if (lastParsed.malformed) return 'session-error'
  if (lastParsed.isError) return 'session-error'
  if (reasons.includes('fileset')) return 'fileset'
  if (reasons.includes('no-op')) return 'no-op'
  const command = reasons.find((r) => r.startsWith('command:'))
  if (command) return command
  throw new Error('a failed verification has no recorded reason')
}

// ---------------------------------------------------------------------------------------------
// One cell: materialize the base tree, link `preview.link` entries in, one `claude -p` attempt,
// verify, at most one fix round (`claude -p --resume`) if verification failed and the first
// attempt left a session to resume, verify again, tear the links down, then remove the clone.
// Malformed output on the first attempt has no session to resume, so it fails the cell outright
// rather than spending a fix round on nothing. A usage-limit error at any point stops the CELL
// with no result at all — the caller is expected to stop the whole run and never write a line
// for it, so a resume redoes it in full. A session that reports any permission denial makes the
// cell `invalid` (no status at all, no fix round) the same way: the caller stops the run and writes
// nothing, because a session that could not edit measured the permission setup, not the tier.
// ---------------------------------------------------------------------------------------------
function invalidCell(parsed) {
  return { usageLimit: false, invalid: true, permissionDenials: parsed.permissionDenials, deniedTools: parsed.deniedTools }
}

export async function runTierCell({
  root, baseSha, tmpRoot = tmpdir(), prompt, model, claudeBin = 'claude', declaredFiles, phase,
  env, spawnFn = spawn, gitExecFn = defaultGitExec, loadConfigFn = loadGateConfig,
  runCheckFn = runCommandCheck, previewLinksFn = previewLinks, validateLinkPathsFn = validateLinkPaths,
  copyPreviewPathsFn = copyPreviewPaths,
}) {
  const materialized = await materializeBaseTree({ root, baseSha, tmpRoot, gitExecFn })
  const { cloneDir } = materialized
  const cloneBaseSha = materialized.baseSha
  let teardownLinks = null
  let links = []
  try {
    const config = await loadConfigFn(cloneDir)
    const phaseName = phase !== null && phase !== undefined ? String(phase) : 'default'

    const declaredLinks = config ? previewLinksFn(config) : []
    if (declaredLinks.length > 0 && validateLinkPathsFn(declaredLinks) === null) {
      // A MISSING build input never reaches here as a throw — copyPreviewPathsFn itself skips an
      // absent entry, best-effort, and the command checks that needed it fail on their own,
      // honestly. What DOES throw here is one of copyPreviewPaths' own safety refusals (outside
      // the repository, not a directory, outside the cell, already present) or a genuine I/O
      // error — and swallowing THAT silently graded the cell as though its dependencies were
      // there when they were not. The cell is `invalid` instead, with the refusal's own reason,
      // rather than continuing as if nothing were declared. Not `fail`: no session ran, so the
      // cell says nothing about the tier, and a `fail` with cost 0 read as a free failed attempt
      // in the loss. Cost, wall-clock and turns are unknown (null), never 0.
      try {
        teardownLinks = await copyPreviewPathsFn(cloneDir, root, declaredLinks)
        links = declaredLinks
      } catch (err) {
        return {
          usageLimit: false,
          invalid: true,
          status: 'invalid',
          totalCostUsd: null,
          costMissing: true,
          wallClockMs: null,
          fixRound: false,
          sessionId: null,
          previewLinkError: err.message,
          failReason: 'preview-copy',
          permissionDenials: 0,
          deniedTools: [],
          turns: null,
        }
      }
    }

    // Every session runs with the copied link trees locked and fingerprinted around it (see
    // lockLinkTrees). Both fingerprints are taken while locked — right after the lock and right
    // after the session, before the unlock — so `linkModified` also catches a change of mode alone,
    // which the unlock would otherwise restore unseen. The gate commands in verifyCell run after
    // the unlock, on the writable tree.
    const guardedAttempt = async (options) => {
      if (links.length === 0) return { attempt: await attemptOnce(options), linkModified: false }
      const unlock = await lockLinkTrees(cloneDir, links)
      let attempt
      let before
      let after = null
      try {
        before = await fingerprintLinkTrees(cloneDir, links)
        attempt = await attemptOnce(options)
        after = await fingerprintLinkTrees(cloneDir, links).catch(() => null)
      } finally {
        await unlock()
      }
      return { attempt, linkModified: after !== before }
    }
    const linkModifiedVerification = {
      passed: false,
      failures: ['a preview.link directory was modified during the session'],
      reasons: ['link-modified'],
    }

    const first = await guardedAttempt({ cwd: cloneDir, prompt, model, claudeBin, spawnFn, env })
    const attempt1 = first.attempt
    if (attempt1.parsed.usageLimit) return { usageLimit: true }
    if (attempt1.parsed.permissionDenials > 0) return invalidCell(attempt1.parsed)

    const attempts = [attempt1]
    let verification
    if (first.linkModified) verification = linkModifiedVerification
    else if (attempt1.parsed.malformed) verification = { passed: false, failures: ['claude produced output that was not valid JSON'] }
    else {
      verification = await verifyCell({
        cloneDir, baseSha: cloneBaseSha, declaredFiles, config, phaseName, links, runCheckFn, gitExecFn,
      })
    }

    // No fix round after a link modification: the tree the gate commands would run against is
    // no longer the one copied in, so nothing a second turn does could be graded fairly.
    if (!verification.passed && !first.linkModified && !attempt1.parsed.malformed && attempt1.parsed.sessionId) {
      const second = await guardedAttempt({
        cwd: cloneDir,
        prompt: fixMessage(verification.failures),
        model,
        claudeBin,
        resumeSessionId: attempt1.parsed.sessionId,
        spawnFn,
        env,
      })
      const attempt2 = second.attempt
      attempts.push(attempt2)
      if (attempt2.parsed.usageLimit) return { usageLimit: true }
      if (attempt2.parsed.permissionDenials > 0) return invalidCell(attempt2.parsed)
      if (second.linkModified) verification = linkModifiedVerification
      else if (attempt2.parsed.malformed) verification = { passed: false, failures: ['the fix round produced output that was not valid JSON'] }
      else {
        verification = await verifyCell({
          cloneDir, baseSha: cloneBaseSha, declaredFiles, config, phaseName, links, runCheckFn, gitExecFn,
        })
      }
    }

    const anyCostMissing = attempts.some((a) => a.parsed.costMissing)
    const totalCostUsd = anyCostMissing ? null : attempts.reduce((sum, a) => sum + a.parsed.totalCostUsd, 0)
    const wallClockMs = attempts.reduce((sum, a) => sum + a.wallClockMs, 0)
    // Like cost: one attempt with an unknown turn count makes the total unknown, never a partial sum.
    const turns = attempts.some((a) => a.parsed.turns === null)
      ? null
      : attempts.reduce((sum, a) => sum + a.parsed.turns, 0)
    return {
      usageLimit: false,
      status: verification.passed ? 'pass' : 'fail',
      failReason: verification.passed ? null : pickFailReason(verification, attempts.at(-1).parsed),
      permissionDenials: 0,
      turns,
      totalCostUsd,
      costMissing: anyCostMissing,
      wallClockMs,
      fixRound: attempts.length > 1,
      sessionId: attempt1.parsed.sessionId ?? null,
    }
  } finally {
    if (teardownLinks) await teardownLinks().catch(() => {})
    await removeClone(cloneDir)
  }
}

// ---------------------------------------------------------------------------------------------
// Preflight: one session in a fresh, empty scratch git repository under `tmpRoot`, spawned exactly
// like a cell's session (same argv, permission mode included). It is asked to create
// PREFLIGHT_FILE and run `git status`; it passes only when the file exists afterwards AND the
// session reported zero permission denials AND its output parsed. The scratch repository is
// removed either way. This touches no source repository at all.
// ---------------------------------------------------------------------------------------------
export function preflightPrompt() {
  return [
    `Create a file named ${PREFLIGHT_FILE} in the current directory containing the single line: ok`,
    'Then run `git status` in the current directory and report its output.',
    'Do nothing else.',
  ].join('\n')
}

export async function runPreflight({
  tmpRoot = tmpdir(), model, claudeBin = 'claude', env, spawnFn = spawn, gitExecFn = defaultGitExec,
}) {
  await mkdir(tmpRoot, { recursive: true })
  const dir = await mkdtemp(path.join(tmpRoot, 'fleetmates-preflight-'))
  try {
    const initRes = await gitExecFn(['init', '--quiet'], dir)
    if (initRes.code !== 0) {
      throw new Error(`git init failed for the preflight repository: ${(initRes.stderr || initRes.stdout).trim()}`)
    }
    const attempt = await attemptOnce({ cwd: dir, prompt: preflightPrompt(), model, claudeBin, spawnFn, env })
    const fileExists = await lstat(path.join(dir, PREFLIGHT_FILE)).then((s) => s.isFile(), () => false)
    const { parsed } = attempt
    return {
      ok: fileExists && parsed.permissionDenials === 0 && !parsed.malformed && !parsed.usageLimit,
      fileExists,
      permissionDenials: parsed.permissionDenials,
      deniedTools: parsed.deniedTools,
      malformed: parsed.malformed,
      usageLimit: parsed.usageLimit,
      isError: parsed.isError,
      totalCostUsd: parsed.totalCostUsd,
      turns: parsed.turns,
      wallClockMs: attempt.wallClockMs,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function formatPreflight(result, model) {
  const cost = result.totalCostUsd ?? 'missing'
  const turns = result.turns ?? 'unknown'
  const detail = `model=${model} file-created=${result.fileExists} `
    + `${result.permissionDenials} permission denial(s)${result.deniedTools.length > 0 ? ` (${result.deniedTools.join(', ')})` : ''} `
    + `cost=${cost} turns=${turns}`
  if (result.ok) return `preflight: ok — ${detail}`
  let why = 'the session could not create the file with zero permission denials'
  if (result.usageLimit) why = 'usage limit'
  else if (result.malformed) why = 'the session output was not valid JSON (did claude start?)'
  return `preflight: FAILED (${why}) — ${detail}`
}

function formatPreviewCopy(key, tier, cell) {
  return `  ${key.slice(0, 12)} ${tier}: INVALID (preview-copy), preview.link copy: ${cell.previewLinkError}`
}

function formatInvalid(key, tier, cell) {
  return `INVALID: ${key.slice(0, 12)} ${tier}: the session reported ${cell.permissionDenials} permission denial(s) `
    + `(${cell.deniedTools.join(', ')}); nothing was recorded for this cell`
}

// ---------------------------------------------------------------------------------------------
// loss.json — underOverRatio (with a bootstrap 95% interval), the wall-clock ratio, the
// tier-model mapping and the date. Per "Cost measurement": for a task whose outcome tier is t*,
// the under-tier cost at a cheaper t is cost(t) + cost(t*); the over-tier cost at a pricier t is
// cost(t) - cost(t*). A task where no tier passed is unresolved and excluded. A cell whose own
// cost is missing contributes nothing to either list — never a silent 0.
//
// `underOverRatio` alone stopped being a usable loss WEIGHT once the first real replay showed
// tier cost is not monotonic (opus averaged cheaper AND faster than sonnet — see the per-tier
// means table in tools/replay/README.md): a single scalar ratio assumes the tiers are ordered by cost, and a
// difference built on that assumption goes negative and meaningless exactly when it is not. The
// operator's fix is a 3x3 `costMatrix` (and a `wallClockMatrix`, report-only) built from the
// replay's own PER-TIER MEANS rather than from per-task under/over differences:
//   - m(t) = the mean usage-weighted cost of every FINISHED cell at tier t, pass or fail. A cell
//     whose own cost is missing is excluded from this mean too, never counted as 0 — the same
//     rule `underCosts`/`overCosts` above already follow.
//   - the floor is 0.05 x the smallest of the three tier means, so an over-tier cell is never
//     reported as free (or negative) even when the pricier tier happened to run cheaper overall.
//   - cost[predicted][true] = 0 on the diagonal, m(predicted) + m(true) when predicted is CHEAPER
//     than true (under-tier: the failed cheap attempt plus the escalation), and
//     max(m(predicted) - m(true), floor) when predicted is PRICIER (over-tier: the extra spend).
// `wallClockMatrix` is built by the identical formula from mean wall-clock instead of mean cost.
// `underOverRatio`, its interval and `wallClockRatio` are kept exactly as before — reported only,
// never as a weight. `seed` is the bootstrap seed that interval was drawn with.
// ---------------------------------------------------------------------------------------------
export const LOSS_VERSION = 2

function mean(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}

// The per-tier mean of `field` (totalCostUsd or wallClockMs) over every record at that tier,
// pass or fail alike — a record whose own value is missing (null/non-finite) contributes nothing
// to the mean rather than being treated as a silent 0.
function tierMean(records, tier, field) {
  const values = records
    .filter((r) => r.tier === tier && typeof r[field] === 'number' && Number.isFinite(r[field]))
    .map((r) => r[field])
  return mean(values)
}

// costMatrix[predicted][true] per "Cost measurement (controlled replay)": 0 on the diagonal,
// m(predicted)+m(true) when predicted is the cheaper tier (under), max(m(predicted)-m(true),
// floor) when predicted is the pricier tier (over). Returns null for a cell whose own mean (or
// the one it is compared against) is unknown, rather than propagating a NaN silently.
function buildCostMatrix(means) {
  const known = DEFAULT_TIERS.map((t) => means[t]).filter((v) => typeof v === 'number' && Number.isFinite(v))
  const floor = known.length > 0 ? 0.05 * Math.min(...known) : null
  const matrix = {}
  for (const predicted of DEFAULT_TIERS) {
    matrix[predicted] = {}
    const predictedIdx = DEFAULT_TIERS.indexOf(predicted)
    for (const trueTier of DEFAULT_TIERS) {
      if (predicted === trueTier) {
        matrix[predicted][trueTier] = 0
        continue
      }
      const mp = means[predicted]
      const mt = means[trueTier]
      if (typeof mp !== 'number' || typeof mt !== 'number' || floor === null) {
        matrix[predicted][trueTier] = null
        continue
      }
      const trueIdx = DEFAULT_TIERS.indexOf(trueTier)
      matrix[predicted][trueTier] = predictedIdx < trueIdx ? mp + mt : Math.max(mp - mt, floor)
    }
  }
  return matrix
}

function bootstrapRatioInterval(unders, overs, { seed, samples }) {
  if (unders.length === 0 || overs.length === 0) return null
  const rng = mulberry32(seed)
  const pick = (arr) => arr[Math.floor(rng() * arr.length)]
  const ratios = []
  for (let i = 0; i < samples; i += 1) {
    let underSum = 0
    for (let j = 0; j < unders.length; j += 1) underSum += pick(unders)
    let overSum = 0
    for (let j = 0; j < overs.length; j += 1) overSum += pick(overs)
    const overMean = overSum / overs.length
    if (overMean !== 0) ratios.push((underSum / unders.length) / overMean)
  }
  if (ratios.length === 0) return null
  ratios.sort((a, b) => a - b)
  const at = (p) => ratios[Math.min(ratios.length - 1, Math.max(0, Math.round(p * (ratios.length - 1))))]
  return { low: at(0.025), high: at(0.975) }
}

export function computeLoss(records, {
  models, seed = DEFAULT_SEED, bootstrapSamples = DEFAULT_BOOTSTRAP_SAMPLES, now = () => new Date().toISOString(),
} = {}) {
  // An `invalid` record (a preview-copy refusal: no session ran) says nothing about any tier, so
  // it is left out of everything below — not a failed attempt, and not an unresolved task.
  records = records.filter((r) => r.status !== 'invalid')
  const byKey = new Map()
  for (const record of records) {
    if (!byKey.has(record.key)) byKey.set(record.key, {})
    byKey.get(record.key)[record.tier] = record
  }
  const underCosts = []
  const overCosts = []
  const underWall = []
  const overWall = []
  let resolvedTaskCount = 0
  let unresolvedTaskCount = 0

  for (const tiers of byKey.values()) {
    const outcomeTier = DEFAULT_TIERS.find((t) => tiers[t]?.status === 'pass')
    if (!outcomeTier) {
      unresolvedTaskCount += 1
      continue
    }
    resolvedTaskCount += 1
    const outcomeIdx = DEFAULT_TIERS.indexOf(outcomeTier)
    const starCost = tiers[outcomeTier].totalCostUsd
    const starWall = tiers[outcomeTier].wallClockMs
    for (const tier of DEFAULT_TIERS) {
      const cell = tiers[tier]
      if (!cell || tier === outcomeTier) continue
      const idx = DEFAULT_TIERS.indexOf(tier)
      if (idx < outcomeIdx) {
        if (typeof cell.totalCostUsd === 'number' && typeof starCost === 'number') {
          underCosts.push(cell.totalCostUsd + starCost)
        }
        if (typeof cell.wallClockMs === 'number' && typeof starWall === 'number') {
          underWall.push(cell.wallClockMs + starWall)
        }
      } else {
        if (typeof cell.totalCostUsd === 'number' && typeof starCost === 'number') {
          overCosts.push(cell.totalCostUsd - starCost)
        }
        if (typeof cell.wallClockMs === 'number' && typeof starWall === 'number') {
          overWall.push(cell.wallClockMs - starWall)
        }
      }
    }
  }

  const underMean = mean(underCosts)
  const overMean = mean(overCosts)
  const underWallMean = mean(underWall)
  const overWallMean = mean(overWall)

  const usageMeans = Object.fromEntries(DEFAULT_TIERS.map((t) => [t, tierMean(records, t, 'totalCostUsd')]))
  const wallClockMeans = Object.fromEntries(DEFAULT_TIERS.map((t) => [t, tierMean(records, t, 'wallClockMs')]))

  return {
    lossVersion: LOSS_VERSION,
    underOverRatio: underMean !== null && overMean ? underMean / overMean : null,
    underOverRatioInterval: bootstrapRatioInterval(underCosts, overCosts, { seed, samples: bootstrapSamples }),
    wallClockRatio: underWallMean !== null && overWallMean ? underWallMean / overWallMean : null,
    tierModels: models ?? null,
    resolvedTaskCount,
    unresolvedTaskCount,
    tierMeans: { usage: usageMeans, wallClock: wallClockMeans },
    costMatrix: buildCostMatrix(usageMeans),
    wallClockMatrix: buildCostMatrix(wallClockMeans),
    seed,
    date: now(),
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
// A value-taking flag with no value — last on the line, or followed by another `--flag` — throws
// naming the flag, and main exits 2. It used to parse as `true`: a bare `--seed` became
// Number(true) === 1 and was accepted, and a bare `--out` fell back to the committed data
// directory and rewrote its loss.json.
function parseArgs(argv) {
  const flags = {}
  const VALUELESS = new Set(['execute', 'dry-run', 'smoke', 'preflight', 'recompute-loss'])
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    if (VALUELESS.has(name)) {
      flags[name] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${token} needs a value`)
    } else {
      flags[name] = next
      i += 1
    }
  }
  return flags
}

// `--models` is optional on the command line, matching the README's own example invocations (neither
// its `--dry-run` nor its `--execute` example needs it): when absent, `harnesses.claude.
// tierModels` from this tool's own `fleetmates.local.json` — the same untracked, per-operator
// config layer `dispatch`/`review-dispatch` read their tier-to-model mapping from — is tried
// instead. Required only for `--execute`; a dry run never spawns `claude` and so never needs one.
function validateModels(parsed, sourceLabel) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${sourceLabel} must be a JSON object mapping tiers to model names`)
  }
  for (const tier of DEFAULT_TIERS) {
    if (typeof parsed[tier] !== 'string' || parsed[tier].trim() === '') {
      throw new Error(`${sourceLabel} must include a non-empty model name for '${tier}'`)
    }
  }
  return parsed
}

function parseModelsFlag(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('--models must be valid JSON')
  }
  return validateModels(parsed, '--models')
}

async function readLocalTierModels(configRoot, readFileFn = readFile) {
  let raw
  try {
    raw = await readFileFn(path.join(configRoot, NAMES.localFile), 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const tierModels = parsed?.harnesses?.claude?.tierModels
  return tierModels && typeof tierModels === 'object' && !Array.isArray(tierModels) ? tierModels : null
}

async function readExistingResults(resultsPath) {
  let raw
  try {
    raw = await readFile(resultsPath, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

function buildResumeCommand(argv) {
  const args = argv.includes('--execute') ? argv : [...argv, '--execute']
  return `node tools/replay/replay.mjs ${args.join(' ')}`
}

// How many bytes `copyPreviewPaths` will copy for one located task, for the --dry-run report
// (requirement: "prints the total bytes that will be copied per cell"). Reads the manifest AS
// COMMITTED at the task's own resolved base (never the source repo's current HEAD, which may
// have moved on) but sizes the linked directories from the REAL filesystem — `preview.link`
// entries like `node_modules` are typically gitignored, so there is no git tree to size them
// from. `byteCache` is keyed on the (root, entry) pair, not the base sha: the byte count is
// about the CURRENT state of a filesystem directory, not git history, so two tasks in the same
// root that both link `node_modules` share one measurement rather than re-walking it twice.
async function previewCopyBytesForItem(item, { gitExecFn = defaultGitExec, byteCache } = {}) {
  const configRes = await gitExecFn(['show', `${item.baseSha}:${NAMES.gateFile}`], item.root)
  if (configRes.code !== 0) return 0
  let config
  try {
    config = JSON.parse(configRes.stdout)
  } catch {
    return 0
  }
  const links = previewLinks(config)
  let total = 0
  for (const entry of links) {
    const cacheKey = `${item.root}\u0000${entry}`
    if (byteCache && byteCache.has(cacheKey)) {
      total += byteCache.get(cacheKey)
      continue
    }
    const bytes = await directoryByteSize(path.resolve(item.root, entry))
    if (byteCache) byteCache.set(cacheKey, bytes)
    total += bytes
  }
  return total
}

async function resolveModels(flags, { configRoot, readFileFn, io, modeLabel }) {
  try {
    if (flags.models !== undefined) {
      return parseModelsFlag(flags.models === true ? '' : flags.models)
    }
    const local = await readLocalTierModels(configRoot, readFileFn)
    if (!local) {
      io.out(
        `${modeLabel} needs a model for each tier: pass --models '{"cheap":...,"mid":...,"capable":...}' `
        + `or set harnesses.claude.tierModels in ${NAMES.localFile}`,
      )
      return null
    }
    return validateModels(local, `harnesses.claude.tierModels in ${NAMES.localFile}`)
  } catch (err) {
    io.out(err.message)
    return null
  }
}

// Best-effort read of a previously written loss.json, used only by `--recompute-loss` to carry
// its `tierModels` mapping forward — recomputing from `replay-results.jsonl` alone has no way to
// know which model name each tier used. Never throws: an absent or unparsable file just means
// there is no mapping to preserve.
async function readExistingLoss(lossPath, readFileFn) {
  try {
    return JSON.parse(await readFileFn(lossPath, 'utf8'))
  } catch {
    return null
  }
}

export async function main(argv, io = { out: (s) => process.stdout.write(`${s}\n`) }, deps = {}) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (err) {
    io.out(err.message)
    return 2
  }
  const execute = flags.execute === true
  const smoke = flags.smoke === true
  const recomputeLoss = flags['recompute-loss'] === true
  const preflightOnly = flags.preflight === true && !execute && !smoke && !recomputeLoss

  const {
    listRunPlansFn = listRunPlans,
    locateTasksFn = locateTasks,
    realpathFn = realpath,
    tmpRoot = tmpdir(),
    outDir = dataDirDefault(),
    configRoot = process.cwd(),
    readFileFn = readFile,
    claudeBin = 'claude',
    claudeEnv,
    spawnFn = spawn,
    gitExecFn = defaultGitExec,
    loadConfigFn = loadGateConfig,
    runCheckFn = runCommandCheck,
    now = () => new Date().toISOString(),
    bootstrapSamples = DEFAULT_BOOTSTRAP_SAMPLES,
    previewCopyBytesFn = previewCopyBytesForItem,
    runPreflightFn = runPreflight,
  } = deps
  // Every mode that reads or writes replay-results.jsonl / loss.json (`--recompute-loss` and
  // `--execute`) uses `--out` when given, else the tool's own data directory.
  const dataDir = typeof flags.out === 'string' ? flags.out : outDir

  // `--recompute-loss --out <dir>`: reads the already-committed `replay-results.jsonl` in <dir>,
  // spawns nothing and touches no cell, and rewrites `loss.json` from `computeLoss` alone.
  if (recomputeLoss) {
    const dir = dataDir
    const resultsPath = path.join(dir, 'replay-results.jsonl')
    const lossPath = path.join(dir, 'loss.json')
    const recomputeSeed = flags.seed !== undefined ? Number(flags.seed) : DEFAULT_SEED
    if (!Number.isInteger(recomputeSeed)) {
      io.out('--seed must be an integer')
      return 2
    }
    // An absent or empty results file refuses instead of rewriting loss.json from zero records.
    let resultsText
    try {
      resultsText = await readFile(resultsPath, 'utf8')
    } catch {
      io.out(`recompute-loss: ${resultsPath} does not exist; loss.json was not written`)
      return 2
    }
    const existingRecords = resultsText.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    if (existingRecords.length === 0) {
      io.out(`recompute-loss: ${resultsPath} has no records; loss.json was not written`)
      return 2
    }
    const existingLoss = await readExistingLoss(lossPath, readFileFn)
    const models = existingLoss?.tierModels ?? await readLocalTierModels(configRoot, readFileFn)
    const loss = computeLoss(existingRecords, {
      models, seed: recomputeSeed, bootstrapSamples, now,
    })
    await writeFile(lossPath, `${JSON.stringify(loss, null, 2)}\n`)
    io.out(`recompute-loss: wrote ${lossPath} from ${existingRecords.length} record(s)`)
    return 0
  }

  const preflight = async (models) => {
    const result = await runPreflightFn({
      tmpRoot, model: models.cheap, claudeBin, env: claudeEnv, spawnFn, gitExecFn,
    })
    io.out(formatPreflight(result, models.cheap))
    return result.ok
  }

  if (preflightOnly) {
    const models = await resolveModels(flags, { configRoot, readFileFn, io, modeLabel: '--preflight' })
    if (!models) return 2
    return (await preflight(models)) ? 0 : 1
  }

  const roots = typeof flags.roots === 'string'
    ? flags.roots.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  if (roots.length === 0) {
    io.out('--roots must name at least one directory (comma-separated)')
    return 2
  }
  const count = flags.count !== undefined ? Number(flags.count) : DEFAULT_COUNT
  if (!Number.isInteger(count) || count <= 0) {
    io.out('--count must be a positive integer')
    return 2
  }
  const seed = flags.seed !== undefined ? Number(flags.seed) : DEFAULT_SEED
  if (!Number.isInteger(seed)) {
    io.out('--seed must be an integer')
    return 2
  }

  const plans = await listRunPlansFn(roots)
  const rawPool = poolFromPlans(plans)
  const located = await locateTasksFn(rawPool, { gitExecFn })
  const locatedItems = located.filter((i) => i.located)
  const pool = []
  for (const item of locatedItems) {
    const real = await realpathFn(item.root).catch(() => item.root)
    pool.push({ ...item, realRoot: real, key: hashCellKey(real, item.runId, item.taskId) })
  }
  const sample = selectDiverseSample(pool, { count, seed })

  if (!execute && !smoke) {
    io.out(`dry run: ${locatedItems.length} task(s) located, ${sample.length} selected for --count ${count}, ${sample.length * DEFAULT_TIERS.length} planned cell(s) across tiers ${DEFAULT_TIERS.join(', ')}`)
    io.out(locatedItems.length >= count
      ? `--count ${count} is reachable`
      : `--count ${count} is NOT reachable: only ${locatedItems.length} task(s) are located across ${roots.length} root(s)`)
    for (const root of roots) {
      const items = located.filter((i) => i.root === root)
      const reflogCount = items.filter((i) => i.located && i.method === 'reflog').length
      const mergeCount = items.filter((i) => i.located && i.method === 'merge').length
      const unlocatable = items.filter((i) => !i.located)
      io.out(`  root ${root}: ${items.length} found, ${reflogCount} via reflog, ${mergeCount} via merge, ${unlocatable.length} unlocatable`)
      for (const u of unlocatable) io.out(`    ${u.taskId}: ${u.reason}`)
    }
    const byteCache = new Map()
    for (const item of sample) {
      const previewBytes = await previewCopyBytesFn(item, { gitExecFn, byteCache })
      io.out(`  ${item.key.slice(0, 12)}  run=${item.runId}  tiers=${DEFAULT_TIERS.join(',')}  preview-copy-bytes=${previewBytes}`)
    }
    return 0
  }

  const models = await resolveModels(flags, {
    configRoot, readFileFn, io, modeLabel: smoke ? '--smoke' : '--execute',
  })
  if (!models) return 2

  const runCell = (item, baseSha, prompt, tier) => runTierCell({
    root: item.root,
    baseSha,
    tmpRoot,
    prompt,
    model: models[tier],
    claudeBin,
    declaredFiles: item.files,
    phase: item.phase,
    env: claudeEnv,
    spawnFn,
    gitExecFn,
    loadConfigFn,
    runCheckFn,
  })

  const promptFor = async (item) => {
    const markdown = await planMarkdownAtBase({ root: item.root, baseSha: item.baseSha, planPath: item.planPath, gitExecFn })
    return buildReplayPrompt({ markdown, taskId: item.taskId })
  }

  if (smoke) {
    const tier = 'capable'
    const item = sample[0]
    if (!item) {
      io.out('smoke: no task was selected, nothing to run')
      return 1
    }
    let prompt
    try {
      prompt = await promptFor(item)
    } catch (err) {
      io.out(`smoke: cannot build the prompt for ${item.key.slice(0, 12)}: ${err.message}`)
      return 1
    }
    const cell = await runCell(item, item.baseSha, prompt, tier)
    if (cell.usageLimit) {
      io.out('BLOCKED: usage limit during --smoke')
      return 1
    }
    if (cell.previewLinkError) {
      io.out(formatPreviewCopy(item.key, tier, cell))
      return 1
    }
    if (cell.invalid) {
      io.out(formatInvalid(item.key, tier, cell))
      return 1
    }
    io.out(`smoke: ${item.key.slice(0, 12)} tier=${tier} status=${cell.status} failReason=${cell.failReason ?? 'none'} `
      + `cost=${cell.totalCostUsd ?? 'missing'} turns=${cell.turns ?? 'unknown'}`)
    return cell.status === 'pass' ? 0 : 1
  }

  await mkdir(dataDir, { recursive: true })
  const resultsPath = path.join(dataDir, 'replay-results.jsonl')
  const lossPath = path.join(dataDir, 'loss.json')
  const existing = await readExistingResults(resultsPath)
  const done = new Set(existing.map((r) => `${r.key}:${r.tier}`))
  const allRecords = [...existing]

  // The preflight runs before the first cell session. With no cell left to run, no session
  // starts at all, so there is nothing for it to guard.
  const anyPending = sample.some((item) => DEFAULT_TIERS.some((tier) => !done.has(`${item.key}:${tier}`)))
  if (anyPending && !(await preflight(models))) {
    io.out('aborting: the preflight failed, so no cell was run')
    return 1
  }

  for (const item of sample) {
    const remainingTiers = DEFAULT_TIERS.filter((tier) => !done.has(`${item.key}:${tier}`))
    if (remainingTiers.length === 0) continue

    // item.baseSha was already resolved (and its planPath's existence there already confirmed) by
    // locateTasksFn above — nothing in `sample` reaches this loop without both, so there is no
    // "could not resolve the base commit" branch left to skip on here.
    const { baseSha } = item

    let prompt
    try {
      prompt = await promptFor(item)
    } catch (err) {
      io.out(`skipping ${item.key.slice(0, 12)}: ${err.message}`)
      continue
    }

    for (const tier of remainingTiers) {
      const cell = await runCell(item, baseSha, prompt, tier)
      if (cell.usageLimit) {
        io.out(`BLOCKED: usage limit, resume with ${buildResumeCommand(argv)}`)
        return 1
      }
      // A preview-copy refusal is recorded as `invalid` and the run goes on: it is a property of the
      // task's manifest and the source checkout, so re-running the cell would only repeat it.
      if (cell.previewLinkError) {
        io.out(formatPreviewCopy(item.key, tier, cell))
      } else if (cell.invalid) {
        io.out(`${formatInvalid(item.key, tier, cell)}; fix the permission setup, then resume with ${buildResumeCommand(argv)}`)
        return 1
      }
      const record = {
        key: item.key,
        tier,
        status: cell.status,
        failReason: cell.failReason,
        permissionDenials: cell.permissionDenials,
        turns: cell.turns,
        totalCostUsd: cell.totalCostUsd,
        costMissing: cell.costMissing,
        wallClockMs: cell.wallClockMs,
        fixRound: cell.fixRound,
        timestamp: now(),
      }
      // Append-only, one cell at a time: a usage-limit stop on the NEXT cell never loses this one.
      await appendFile(resultsPath, `${JSON.stringify(record)}\n`)
      done.add(`${item.key}:${tier}`)
      allRecords.push(record)
    }
  }

  const loss = computeLoss(allRecords, { models, seed, bootstrapSamples, now })
  await writeFile(lossPath, `${JSON.stringify(loss, null, 2)}\n`)
  io.out(`replay complete: ${allRecords.length} cell(s) recorded`)
  return 0
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
