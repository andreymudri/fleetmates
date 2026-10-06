#!/usr/bin/env node
// SubagentStop handler. Runs the cheap enforcement checks on a teammate's own task at the
// point it tries to stop. Exit 0 allows the stop; exit 2 blocks it and the harness feeds
// stderr back to the teammate as the reason to keep working.
//
// It fires for EVERY subagent on this machine — a reviewer in an unrelated project, this
// plugin's own read-only tm-reviewer, any agent in a repo with no run at all. Everything
// below is arranged so those cases cost one `git rev-parse` and exit 0; the count is pinned
// by a test that traces the git processes this handler starts, because a cost claim nothing
// measures is prose, and every subagent on the machine pays whatever it actually costs.
import { taskBranchName } from './enforce.mjs'
import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTaskByWorktree, normaliseWorktree, readState } from './state.mjs'
import { appendEvent, ledgerPath } from './event-ledger.mjs'

// This handler's own exit statuses, which the harness reads.
const ALLOW = 0
const BLOCK = 2

// The exit status `complete --enforcement-only` returns when a TASK-SCOPED enforcement check
// rejects, and the only status this handler blocks on. It is a DIFFERENT vocabulary from
// ALLOW/BLOCK above, which happens to share small integers with it: REJECTED is a code this
// process reads, BLOCK is a code this process returns. See the contract at the spawn below.
const REJECTED = 3

function payload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim()
  } catch {
    return null
  }
}

async function main() {
  const input = payload()
  // `!input` carries this line; the type half is defence in depth and is NOT load-bearing
  // today — measured, by weakening it to `!input` alone and finding the suite still green.
  // A bare number or string parses fine and reaches here, but it has no `cwd` property, so
  // the guard below already answers it. Kept because every later line reads properties off
  // this object, and cheap; described exactly so nobody reads the cases below as pinning it.
  if (!input || typeof input !== 'object') return ALLOW

  // The harness caps consecutive blocks at 8 and asks Stop/SubagentStop handlers to return
  // success while this is set. Honouring it makes one stop cost one forced retry: the
  // teammate gets the failure text, works again, and is not blocked a second time for the
  // same stop. The count lives in the harness process, so unlike anything under
  // .fleetmates/ the teammate cannot reset it.
  if (input.stop_hook_active === true) return ALLOW

  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  if (cwd === '') return ALLOW

  // One git call in the common case, answering three questions at once. A cwd outside any
  // repository stops here.
  const dirs = git([
    'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel',
  ], cwd)
  if (!dirs) return ALLOW
  const [commonDir, gitDir, toplevel] = dirs.split('\n').map((line) => line.trim())
  // An unexpected output shape means this git does not answer the question the way the checks
  // below read it, and a guess either way is worse than not enforcing.
  if (!commonDir || !gitDir || !toplevel) return ALLOW
  // `--git-common-dir` is `<main>/.git` for a linked worktree and the repository's own `.git`
  // otherwise, so its parent is the MAIN worktree in both cases — which is where the run's
  // state lives, and the only root at which a teammate's record can be found. Both halves are
  // covered: a case runs the handler from inside a real linked worktree, because that is the
  // only configuration a dispatched teammate is ever in, and `--git-dir` — the plausible
  // wrong answer — resolves there to `<main>/.git/worktrees/<name>`, under which no record is
  // ever found and every teammate in the run would stop unchallenged.
  const root = path.dirname(commonDir)

  // A stop ANYWHERE IN the MAIN worktree is never a teammate's. Teammates are dispatched into
  // their own worktrees, so the only things that stop here are the orchestrator's own subagents
  // — a reviewer, a helper — which have no task, no brief, and no business being handed a
  // branch name to commit to. Without this, a record aimed at a directory in the main worktree
  // (writable directly, which no guard on `locate` can prevent) makes the next unrelated
  // subagent to stop there the victim: it is blocked and told about a task that is not its own.
  //
  // This closes records aimed at THIS repository's directories. It does not close the case
  // where the directory is made to belong to a DIFFERENT, fabricated repository — see the
  // residual documented at the location check below, which is open.
  //
  // The test is the pair of directories git just printed, not a path comparison. Measured at
  // four depths: in the main worktree, and in ANY subdirectory of it, `--git-common-dir` and
  // `--git-dir` are the same path; in a linked worktree, and in any subdirectory of one, the
  // second is `<common>/worktrees/<name>`. Comparing CWD to the root instead — which is what
  // this line did first — closes the root and nothing below it, so a session started with
  // `cd packages/app && claude`, which is ordinary use, was still a victim. Note that "cwd
  // under root" is a different and always-wrong test: this plugin puts teammate worktrees at
  // `<main>/.claude/worktrees/agent-*`, inside the main worktree, so it would answer yes for
  // every teammate and switch enforcement off everywhere.
  //
  // REDUNDANT with the git-dir location check below, and kept as the explicit statement of the
  // main-worktree case rather than as a barrier: no path can satisfy both, since a git dir
  // equal to the common dir cannot also sit two levels under it, and deleting this line was
  // measured to change no verdict in the suite. It is stated here because a reader who finds
  // the main worktree answered only by "not a linked worktree" would reasonably wonder whether
  // that was intended.
  //
  // The trade-off, stated rather than hidden: in a run dispatched WITHOUT worktree isolation
  // every teammate shares the main worktree, and this makes enforcement inert for that run.
  // That configuration already misresolves — one record per directory means the last teammate
  // to run `locate` answers for all of them — so this turns "enforced against the wrong task"
  // into "not enforced", which is the safer of the two. It is not free, and it is not nothing.
  if (commonDir === gitDir) return ALLOW

  // The pair being unequal is necessary and NOT sufficient, because a `.git` FILE makes any
  // directory report a foreign git dir, and the directory it names is the planter's to build.
  // Measured end to end: four hand-written text files — `<main>/packages/app/.git` naming
  // `<main>/.fleetmates/fakewt`, and `commondir`, `gitdir` and `HEAD` inside that directory —
  // make a tracked subdirectory of the MAIN worktree answer `rev-parse` like a linked
  // worktree of this repository. None of it is inside `.git`, and
  // `git status --untracked-files=all` reports none of it, because git excludes a subtree
  // once it sees a `.git` file there.
  //
  // So the discriminator is WHERE the git dir sits relative to the common dir git reported
  // alongside it. A real linked worktree's git dir is two levels under its common dir
  // (`<common>/worktrees/<name>`, the middle component observed to be `worktrees` in every
  // shape measured). Measured: equal for the main worktree at any depth, contained for a real
  // linked worktree and any subdirectory of one, and neither for the plant above, which is
  // answered by falling through to ALLOW.
  //
  // An earlier version asked the git dir to point back at this toplevel and called that
  // unforgeable. It is not: the pointer file lives in the directory the planted `.git` names,
  // so the planter writes both ends and the round trip closes. That claim is deleted rather
  // than weakened, and with it the file read — there is no longer any file whose contents
  // this decision trusts.
  //
  // WHAT THIS ESTABLISHES, and it is narrower than "the directory is genuine": that this is a
  // linked worktree of the repository THE CWD RESOLVES TO. It does not establish that that
  // repository is the one this run belongs to, or that it was created by git at all.
  //
  // OPEN RESIDUAL, measured and left open deliberately. A plant that supplies its own
  // repository satisfies this check honestly: `git init` a second repo anywhere the attacker
  // can write — the victim's own gitignored `.fleetmates/` will do — hand-write
  // `<evil>/.git/worktrees/fake/commondir` naming `<evil>/.git`, and point
  // `<victim-dir>/.git` at that metadata directory. `rev-parse` then reports a common dir and
  // a git dir that are genuinely two levels apart, so the pair is contained, and
  // `root = dirname(commonDir)` makes the ATTACKER's directory the store this handler reads.
  // A subagent stopping there is blocked over a task from a store that has nothing to do with
  // this repository. `git status --porcelain --untracked-files=all` prints nothing, because
  // `.fleetmates/` is gitignored and git excludes a subtree once it sees a `.git` file in it.
  //
  // Two discriminators were built and measured against it, and neither is worth taking:
  //
  //   - Ask the PARENT of the toplevel which repository encloses it, and refuse when that
  //     differs from the resolved common dir. It does catch the plant — measured, the parent
  //     resolves to the victim's real `.git`. It is then defeated by ONE more file: planting
  //     a second `.git` at that parent makes the enclosing answer the attacker's repo too,
  //     also measured. Walking further up costs a git process per ancestor and still ends at
  //     "the attacker plants one level higher than we look" until the walk reaches a `.git`
  //     the attacker cannot replace.
  //   - Walk all the way to the real repository root. That does catch it, but it refuses a
  //     configuration two reviewers verified as legitimate and working — a real linked
  //     worktree of repository B living inside repository A's tree — turning enforcement off
  //     there to close an attack whose ceiling is one forced retry.
  //
  // A global stop hook has no expected repository to compare against: it legitimately adopts
  // whatever repository the stopping cwd resolves to, and a plant fabricates exactly that.
  // So this is accepted rather than closed, and the ceiling is stated below PER PATH, because
  // twice now a bound true of one path has been written as a property of the handler — first
  // "the plant must move inside `.git`", then "the text names no command", which held only on
  // the missing-branch path while the rejection path forwarded whatever it was given.
  //
  // Both blocking paths: the cost is one forced retry per stop, since `stop_hook_active`
  // allows the next one; no gate verdict is influenced, because the gate recomputes everything
  // from git and reads nothing here; and every variable interpolated into either message is an
  // id constrained by the allowlist described at the rejection path below.
  //
  // Missing-branch path: the branch named is the conventional `fleetmates/<runId>/<taskId>`,
  // because the record's own `branch` field is clamped to that or dropped by
  // `findTaskByWorktree`; the text names no command and sends the teammate to its brief.
  //
  // Rejection path: nothing from `complete`'s output reaches the agent at all — see the fixed
  // form at the bottom of this function, and the `--enforcement-only` coupling noted with it.
  //
  // What is genuinely new against the residual disclosed further up is that the victim need
  // not be a teammate and the store need not belong to this repository. Pinned by cases that
  // assert these bounds on BOTH paths, each reaching the path it claims to describe.
  //
  // It does not defend against a writer who already owns `.git` either; nobody at that level
  // needs to bother with this handler, and no stop-time check could stop them.
  if (normaliseWorktree(path.dirname(path.dirname(gitDir))) !== normaliseWorktree(commonDir)) {
    return ALLOW
  }

  // Looked up by the worktree's TOP LEVEL, not by the raw payload cwd. `locate` records the
  // top level, so a teammate that stops with its cwd in a subdirectory of its own worktree
  // would otherwise resolve to nothing and be waved through — enforcement silently off for
  // that stop. Whether the harness can deliver such a cwd is not something this file can
  // observe; using the top level removes the dependence rather than betting on it, and it is
  // free here because git printed the value in the same call.
  const found = await findTaskByWorktree(root, toplevel)
  if (!found) return ALLOW

  // Recorded by `init-run`. Without it `complete` cannot run, and a teammate must never be
  // blocked by state it did not write. Deliberately NOT wrapped in a local catch: a plan.json
  // that is unreadable or malformed is also state the teammate did not write, and the terminal
  // handler at the bottom of this file turns any throw into an allow. One fail-open path,
  // tested through this one.
  const plan = await readState(root, found.runId, 'plan')
  const planPath = plan?.planPath
  if (typeof planPath !== 'string' || planPath === '') return ALLOW

  // The cheap precheck: a missing task branch is the do-nothing case, and it is the reason
  // resolution goes through the location record rather than the checked-out branch. It is
  // decided before anything more expensive runs.
  const branch = found.branch ?? taskBranchName(found.runId, found.taskId)
  if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)) {
    // The text NAMES the missing ref and directs the teammate to its brief. It deliberately
    // carries no command and interpolates nothing into one: a ref derived from a record is
    // only as trustworthy as the record, and the record's runId and taskId are chosen by
    // whoever wrote it, so the honest construction above can resolve to ANOTHER task's
    // branch. A teammate that obeyed a create-and-commit instruction would put its commits
    // there, where `fileset` and `ownership` read them as that task's work. The brief carries
    // the branch name from the dispatch, which is the source that cannot be planted.
    //
    // A teammate that is legitimately `blocked` before creating its branch reaches this too,
    // and that is correct as designed rather than a case to exclude: this handler cannot tell
    // "did nothing" from "could not proceed", the two are indistinguishable from outside, and
    // the cost is bounded at one forced retry because `stop_hook_active` allows the next stop.
    // What it must not do is tell that teammate to commit work it does not have, so the text
    // names the other way out. Saying so costs nothing that is not already available — the
    // second stop is allowed whatever the teammate does — and a message that fits only one of
    // the two readers is how a truthful "blocked" gets turned into a fabricated commit.
    process.stderr.write(
      `Task ${found.taskId} has no branch ${branch}. Your work is not on a branch this run can `
      + `merge, so nothing you did is visible to the gate. Your brief names the branch for this `
      + `task and the step that creates it; follow that step, commit your work there, then `
      + `finish. If you have no work to commit because you are blocked, report status "blocked" `
      + `with the reason and stop again — this check does not run twice for one stop.\n`,
    )
    return BLOCK
  }

  // --enforcement-only on purpose: fileset, ownership and merge answer "did you stray
  // outside your file set, is your branch empty, will this merge" in seconds. The full
  // gate's command checks are the project's test suite, and running that inside a stop
  // hook means the usual outcome is a timeout — which is a non-blocking error, i.e.
  // enforcement that looks installed and does nothing. The phase gate still runs it all.
  //
  // SECOND REASON, and stated as exactly what it is rather than as a barrier: the manifest this
  // reads is the MAIN worktree's `fleetmates.gate.json`, which any teammate can write, and a
  // `command` check in it is a shell command. `--enforcement-only` filters with
  // `c.kind !== 'command'`, so it excludes checks whose kind IS THE STRING `command`, and that
  // much is real — dropping the flag runs those, inside a hook that fires for every subagent on
  // this machine. So the flag still belongs in the argv below and the test that asserts it is
  // there should be read as a security check rather than an argument-shape check.
  //
  // What it is NOT is a barrier against everything that could run a shell command, and the
  // reason is that the filter compares strings. `['command'] !== 'command'`, so a manifest
  // entry spelling its kind as an array rather than a string is not among the entries this
  // flag removes — the flag is scoped to the string, and that is the whole of what it claims.
  // The spelling is worth naming because nothing else in the argv narrows by name either: the
  // enforced-kind sets are `Set`s, and `Set` membership does not coerce, so an array-spelled
  // kind matches no set entry by that route.
  //
  // What becomes of such an entry is not decided in this file and not decided by this flag. It
  // is decided at the runner lookup in `scripts/gate-runner.mjs` (`runCheckList`), the single
  // place that chooses between handing a check to a runner and refusing it, and rejecting a
  // non-string kind belongs there rather than in a filter — a filter-only fix would narrow one
  // path and leave every other one open, including a forged
  // `{"kind":["fileset"],"optional":true}` aimed at an always-enforced kind — one a manifest
  // may legitimately declare, which is what makes the `optional: true` spelling worth a
  // forger's while (see `ALWAYS_ENFORCED_KINDS` there, and note it is a wider set than
  // `GATE_COMPUTED_KINDS`, which holds `merge` alone). This file can neither
  // see nor constrain what that lookup does with a non-string kind, so no sentence here asserts
  // an outcome for it in either direction; treat the lookup, not this filter, as the record of
  // what a non-string kind gets. Nothing here depends on that answer: the fixed-form message
  // below holds whatever the spawned process printed or did.
  //
  // Block on REJECTED and on nothing else, because a stop may only be refused over something
  // this teammate did and can fix from its own worktree. The contract `complete` is being
  // built to, which this file consumes and does not implement:
  //
  //   3  a TASK-SCOPED check rejected — fileset, merge. This teammate's own work.
  //   4  cannot-verify, OR a run-wide check that failed for reasons outside this task.
  //   2  a malformed manifest or an argv error.
  //
  // The split matters in one direction: several run-wide conditions are indistinguishable
  // from a task rejection at the level of "did the checks pass" — a manifest typo leaving a
  // non-optional check pending, uncommitted changes in the MAIN worktree failing `ownership`,
  // someone committing straight to the run branch. Blocking on those tells a compliant
  // teammate to fix something it does not own and cannot reach. Blocking on 2 costs it a turn
  // for the orchestrator's typo. So 3 is the only code that may cost a teammate a turn, and
  // it is narrowed on the `complete` side to mean exactly that.
  //
  // What this handler does is the whole of what it promises: read one integer, block on 3.
  // It has no way to tell an honest rejection from a rejection produced by the wrong base, so
  // the meaning of these codes is `complete`'s to keep, and the note below is an observation
  // about a neighbour rather than a property relied on here.
  //
  // OBSERVED IN THE MERGE, not guaranteed by this file: `complete` derives the run branch from
  // whatever the MAIN worktree has checked out, which is wrong whenever the operator is on
  // another branch. Run against a tree parked on an unrelated branch it exits 4 —
  // "cannot verify completion: this repository has hotfix checked out, not run r1's branch" —
  // and this handler allows the stop. The mechanism is `complete`'s: `init-run` records the
  // run branch, `--enforcement-only` compares it to HEAD, and an absent record counts as
  // cannot-confirm. An earlier version of this comment claimed the opposite outcome and named
  // it a live hazard; that was measured against a tree where the fix had not yet landed, and
  // restating it after the merge would have left the only in-repo record of a residual that
  // no longer exists.
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs')
  const result = spawnSync(process.execPath, [
    cli, 'complete',
    '--run', found.runId,
    '--task', found.taskId,
    '--plan', planPath,
    '--root', root,
    '--enforcement-only',
  ], { encoding: 'utf8', timeout: 60_000 })
  try {
    await appendEvent(ledgerPath(root, found.runId, found.taskId), { kind: 'gate-result', at: Date.now(),
      result: result.status === 0 ? 'pass' : result.status === REJECTED ? 'fail' : 'unknown' })
    if (result.status === 0) await appendEvent(ledgerPath(root, found.runId, found.taskId), { kind: 'handoff', at: Date.now(), result: 'done' })
  } catch { /* Observation does not decide enforcement. */ }

  if (result.status === REJECTED) {
    // FIXED FORM. `complete`'s stdout is NOT forwarded, and the reason is not verbosity: under
    // `--enforcement-only` that output carries gate-manifest CHECK NAMES, which are arbitrary
    // strings from `fleetmates.gate.json`. This handler spawns `complete` with `--root <main
    // worktree>`, so the manifest read is the main worktree's — a file any teammate can write —
    // and forwarding it would put chosen text into the context of every sibling blocked at stop
    // time, in a hook that runs for every subagent on this machine. Reproduced before this was
    // changed: a check named to look like an orchestrator instruction, carrying a shell command,
    // arrived at the agent verbatim. `printable` strips control characters and is documented as
    // not constraining content, so it does not help here.
    //
    // Sanitising is the weaker answer and was not taken: any delimiter or escape scheme is
    // itself content an attacker can imitate, and the agent reading this has no way to tell a
    // quoted region from a real one. What removes the vector is re-derivation — name the task
    // and let the teammate run the check itself, reading the output as command output rather
    // than as something this hook said.
    //
    // The two ids ARE interpolated, and the bound on them is exact rather than assumed: both
    // are validated by `findTaskByWorktree` against an allowlist of letters, marks, numbers,
    // `.`, `_` and `-`, with invisible code points refused and no leading `-`. So neither can
    // contain whitespace, quotes, newlines or control characters — no id can forge a sentence
    // or a second line. An id can still BE a chosen word, which is why the surrounding text
    // never presents them as instructions.
    //
    // No command is spelled here for the same reason as the missing-branch path above: the
    // brief carries the verification step for this task, and the brief comes from the dispatch
    // rather than from any file a teammate can write. `planPath` in particular is a plain
    // string out of the run's `plan.json` and is deliberately not printed.
    process.stderr.write(
      `Task ${found.taskId} in run ${found.runId} did not pass the enforcement checks that the `
      + `phase gate will recompute. The reasons are deliberately not repeated here, because they `
      + `come from a file in the repository and would reach you as if this hook had said them. `
      + `Your brief names the verification command for this task: run it yourself, in the `
      + `foreground, and read its output directly. Fix what it reports, then finish.\n`,
    )
    return BLOCK
  }
  return ALLOW
}

// Nothing may escape as an unhandled rejection: a handler that crashes is a hook that fails,
// and this one fails open.
main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(ALLOW))
