// The brief IS the task specification. This module exists to become the single composer, so
// that the plan pointer, the mandatory checkout, the location record, the baseline run, the
// declared file set, the global constraints and the self-verification stop being present on
// one dispatch path and missing on another.
//
// That unification has landed. `scripts/workflow-gen.mjs` imports `composeBrief` and calls it per
// task, substituting the finished text into the generated script, so both dispatch paths render the
// same brief from this module and a Workflow-dispatched implementer is told to run `cli.mjs locate`
// like any other. `templates/phase-workflow.js` carries no copy of its own and says so in its own
// header, and a cross-file test pins the embedded brief byte-identical to `composeBrief` called
// directly — a check that lives in the test file rather than here, because a module cannot verify
// its own inlining.
//
// The CLI surface it emits exists: `cli.mjs` has `locate`, and `complete` takes
// `--enforcement-only`.
//
// Pure: no I/O, no filesystem, no process access. That is what lets the generator substitute
// finished text into generated workflow scripts, which run without filesystem or module access
// and so could never import this at workflow runtime.
//
// What actually pins it, exactly: a source-level test in tests/brief.test.mjs strips comments
// and string literals — keeping `${...}` substitutions, which are code — and asserts the
// remaining executable source contains no static import, no dynamic `import(`, no `require(`,
// no `process` or `globalThis` reference, and no `eval`/`Function` constructor. A behavioural
// assertion cannot do this: an unused import changes no rendered output. The check bounds the
// named routes to the host; it is not a proof of purity in general.

import { fileURLToPath } from 'node:url'
import path from 'node:path'

// scripts/brief.mjs -> scripts/ -> <fleetmates root>/scripts/cli.mjs
const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs')

// With a base branch, the brief opens with a checkout that has an explicit start point and a
// log line the teammate can check against a named ref. With no base there is nothing to branch
// from: emitting `git checkout -B <branch>` with a missing operand would silently create the
// branch at the stale worktree HEAD while the brief claimed the base was verified, so the
// no-base variant states the gap and refuses to name a starting commit.
//
// A FIX ROUND takes neither of those. The work being fixed is already ON the task branch, so a
// reset to the base destroys exactly what the round exists to repair — and the naive retry is
// worse than useless: a fresh isolation worktree cannot check out a branch a dead worktree still
// holds, so the teammate is refused first and destroys the work second. It is told to check the
// branch out as it stands, and that freeing a branch another worktree holds is not its job — the
// worktree guard blocks a teammate from inspecting or removing another worktree at all.
const fixRoundSteps = (task) => [
  'MANDATORY FIRST STEP. This is a FIX ROUND. The work you are fixing is ALREADY on',
  task.branch + ', and resetting that branch would destroy it. Do NOT run "git checkout -B".',
  'Run exactly:',
  '',
  '    git checkout ' + task.branch,
  '    git log --oneline -1',
  '',
  'The log must show the commit your round is fixing. If it shows the base instead, the branch',
  'has already been reset and the work is gone: STOP and report status "blocked".',
  'If git refuses the checkout because another worktree still holds ' + task.branch + ', STOP and',
  'report status "blocked" — freeing a branch a dead worktree holds is the orchestrator\'s job,',
  'and you are blocked from inspecting or removing another worktree in any case.',
  'Every file you read before this command has stale content and must be re-read after it.',
]

const checkoutSteps = (task, baseBranch, fixRound = false) => (fixRound ? fixRoundSteps(task) : baseBranch ? [
  'MANDATORY FIRST STEP. Your worktree does not start on this run\'s base. Run exactly:',
  '',
  '    git checkout -B ' + task.branch + ' ' + baseBranch,
  '    git log --oneline -1',
  '',
  'If the log does not show the tip of ' + baseBranch + ', STOP and report status "blocked".',
  'Every file you read before this command has stale content and must be re-read after it.',
] : [
  'MANDATORY FIRST STEP. No base branch was supplied for this phase, so the commit your worktree',
  'starts on is UNVERIFIED and is probably stale. Do not guess a base, and do not run',
  '"git checkout -B ' + task.branch + '" without a start point — that would branch from whatever',
  'HEAD your worktree happens to be on. Ask the orchestrator which commit to start from, then',
  'check out ' + task.branch + ' at that commit. If you cannot get an answer, report status "blocked".',
  'Every file you read before that checkout has stale content and must be re-read after it.',
])

// Files that have historically changed alongside this task's declared set. They are OUTSIDE the
// set, so the teammate may not edit them — the point is the opposite: they are what its change
// is most likely to break without touching. Rendered only when the caller supplied a NON-EMPTY
// list, so a repository with no history, or a task whose files are new, shows no section rather
// than a header with nothing under it — the `.length` test is what distinguishes an empty array
// from an absent key, and both cases are pinned in tests/brief.test.mjs.
const blastRadius = (task) => (task.neighbours && task.neighbours.length ? [
  'BLAST RADIUS. These files are not yours and you may not edit them. They have changed together',
  'with your files in the past, so they are where your change is most likely to break something:',
  ...task.neighbours.map((n) => '  ' + Math.round(n.confidence * 100) + '%  ' + n.path),
  'This is a statistic about history, not a dependency list: it can be wrong in both directions.',
  'Read the ones that look relevant. If your task cannot be done without editing one, that is a',
  'file-set problem — report status "blocked" naming it rather than editing it.',
  '',
] : [])

// Written before the work, not after. The stop-time hook maps a cwd back to a task through
// this record; resolving through the checked-out branch instead would miss a teammate that
// never created its branch, which is the failure the hook exists to catch. With no run id
// there is no record to write, so the section disappears rather than emitting `--run ` empty.
//
// `cli.mjs locate` exists as of the same commit that corrected the exit-code table below, so the
// text can now describe the interface rather than demand it. It takes no path arguments on
// purpose: it reads the worktree TOP LEVEL from git, so running it from a subdirectory records
// the same path the hook will later ask about. The "blocked" fallback stays — this module is
// still dispatched by a generator that may run against an older CLI on a user's machine, and an
// unrecognised command must be reported, never worked around.
const locateStep = (task, runId) => (runId ? [
  'RECORD YOUR WORKTREE. Immediately after the checkout above, run:',
  '',
  `    node ${JSON.stringify(CLI_PATH)} locate --run ${runId} --task ${task.id}`,
  '',
  'It takes no path arguments: it reads your worktree and branch from where you run it, so it',
  'is safe to run from any directory inside your worktree. This is how your work is identified',
  'if you stop before finishing, so do not skip it.',
  'If the CLI answers that it does not know the command, that command has not landed yet:',
  'report status "blocked" naming it rather than inventing a substitute or skipping the step.',
  '',
] : [])

// The instruction the stop-time hook backstops. It needs both a run id and a plan path; with
// either missing the command could not run, so the section is dropped rather than rendered
// with an empty flag value.
//
// The exit codes below are read out of `complete` in scripts/cli.mjs, not inferred:
//   0  the task passes. The brief's own invocation carries no `--enforcement-only`, so it is
//      also marked done in status.json; the hook's invocation does carry it and deliberately
//      does not mark anything, because a stopping teammate may be mid-work.
//
//      UNREACHABLE on some manifests, including this repository's own: it declares
//      `{"name":"review","kind":"agent"}`, no runner answers to `agent`, so that check is a
//      non-optional `pending` on every invocation and the verdict is never PASS. The exit-4 row
//      says so rather than leaving a teammate to conclude its compliant work was rejected.
//   1  the gate passed but status.json is missing or does not list the task — bookkeeping
//   2  TWO unrelated things: fleetmates.gate.json is present and MALFORMED (configuration), or
//      the invocation itself was rejected — a missing required argument, an unknown flag, a
//      refused flag spelling, an empty --root, a --run escaping .fleetmates/ (which prints
//      `--run <value> escapes the run directory`). The argument errors are the teammate's own
//      to fix, and on one it has verified nothing at all, so the brief discriminates all five
//      by the printed line the same way it does for exit 4. The escape case is narrow — a
//      runId carrying a traversal cannot come from `init-run`, so it reaches a teammate only
//      through a caller composing a brief with an unvalidated runId — but it is listed in the
//      rendered text because this comment claims it is, and an unlisted marker falls through
//      to the malformed-manifest line: a false configuration diagnosis for a rejected
//      invocation on which nothing was verified.
//   3  a check SCOPED TO THIS TASK rejected it — `fileset` or `merge`. This is the one code
//      that is a verdict about the teammate's own work, and the only one the stop-time hook
//      blocks on.
//   4  everything else that is not a PASS: no gate manifest, an underivable context, a task the
//      plan does not contain, a merge preview that could not be built at all, a RUN-WIDE check
//      failing (`ownership`, which sees every commit on the run branch and the main worktree's
//      cleanliness — neither of them this teammate's), and a `command` check failing. The last
//      one is why the row below does not say "not your work": a command check tests the MERGED
//      tree and a teammate told to ignore it would return done on a red suite. It earns 4 rather
//      than 3 because the stop-time hook skips command checks entirely, so a code that could
//      mean "your tests failed" would mean something the hook never measured.
//
// THIS TABLE IS PART OF THE CONTRACT, not commentary on it. It is the only place a teammate
// learns what a code means, so a stale row here is worse than a stale test: when the rejection
// moved from 4 to 3, a teammate hitting 3 found no row, and the nearest "gate does not pass" row
// sat under exit 4 beside a sibling telling it exit 4 was a configuration problem to quote and
// proceed past — an instruction to ignore its own rejection. `tests/brief.test.mjs` pins the
// rendered rows against `scripts/cli.mjs`'s own constants for exactly that reason: if the mapping
// moves again, the rows fail rather than quietly lying.
//
// The split is now by CODE, which is what changed. It used to be by printed line, because 4
// conflated a rejection with a cannot-verify and only the text could separate them; 3 separates
// them programmatically, which is what the hook needed and what makes this table simple enough
// for a teammate to act on.
// `--base` carries the SAME value `checkoutSteps` branched from, not a second guess at it. The
// contract this rests on: `baseBranch` names the run's base branch, and under `checkoutSteps`'
// own wording ("Your worktree does not start on this run's base") that is also the commit the
// teammate's own branch forks from — one value, not two that happen to agree.
//
// `complete` derives a base itself when none is given — `main` or `master` — and anchors the
// plan lookup there; on a run whose base is neither, that derived anchor holds no plan at all.
// The plan-not-found failure DOES name a base — `${baseBranch}` is interpolated verbatim into
// "confirm the plan is committed on <base>" in scripts/cli.mjs — so what misled three teammates
// in run `purge` was not an absent base in the message, it was the WRONG one: `master`, the
// derived default, standing in for `run/purge`, the run's actual base. Passing the checkout's
// own base closes that: the anchor `complete` derives is now the ref the teammate's branch
// actually forked from, and the base a failure names is the real one.
//
// NOT closed by this in every topology: docs/plans/2026-08-09-gaps-followups.md's Task 2
// ("diff each task branch from its own fork point, not from the run anchor") reproduction
// stages a run where task branches fork straight off the RUN branch itself (`git checkout -B
// fleetmates/r/T5 run/r`, no separate base ahead of it). There `baseBranch` and the run branch
// are the same name, so this line's `--base` sets the gate's base equal to its own run branch,
// and `complete` refuses with "the run branch and the base branch are both '<name>'" — one
// exit-4 non-verdict traded for another. `composeBrief` is pure and receives only `baseBranch`,
// with nothing that distinguishes the two topologies, so it cannot detect the collision itself
// — that message is named in the exit 4 guidance below, so a teammate who hits it reads a
// dispatch error rather than something in its own worktree to fix.
//
// Omitted when no base branch was supplied — the same case `checkoutSteps` already refuses to
// name a starting commit for. Inventing one here would assert a base the checkout step itself
// would not commit to.
const verifyStep = (task, runId, planPath, baseBranch) => (runId && planPath ? [
  'BEFORE YOU RETURN "done". Run the task gate on your own work, in the FOREGROUND:',
  '',
  '    ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")',
  `    node ${JSON.stringify(CLI_PATH)} complete \\`,
  '      --run ' + runId + ' --task ' + task.id + ' --plan ' + planPath
    + (baseBranch ? ' --base ' + baseBranch : '') + ' --root "$ROOT"',
  '',
  'If your shell refuses that invocation — some sandboxes reject a multi-line command or a',
  'string containing an absolute path they did not authorise — write the two lines to a file',
  'and run that file. The refusal is your shell\'s, not the gate\'s, and working around it',
  'that way is expected; reporting "blocked" over it is not.',
  '',
  'ROOT must be the MAIN worktree, which is what that command computes — run from inside your',
  'own worktree the CLI would resolve the run branch to your task branch and answer the wrong',
  'question. Read the exit code first: 3 is the only one that is a verdict about YOUR work.',
  '  exit 0 — your task passes. Return "done". Note that a manifest declaring a check this CLI',
  '           has no runner for can never reach 0; see exit 4.',
  '  exit 3 — a check scoped to your task REJECTED it: your branch changed files outside your',
  '           declared set, your branch does not exist or is empty, or your work does not merge.',
  '           That is your work, not a configuration problem. Fix exactly the checks it names,',
  '           then run the command again. Returning "done" on this wastes the phase: the phase',
  '           gate recomputes the same thing and will reject it.',
  '  exit 4 — no check scoped to your task rejected you. Read the names it printed; they are not',
  '           all the same kind of problem, and only the last one is yours:',
  '             "ownership" — every commit on the run branch, and whether the MAIN worktree is',
  '                clean. Neither is yours. Do NOT clean the main worktree, and do NOT',
  '                cherry-pick another task\'s commit onto your branch to make it go away —',
  '                that lands their files on your branch and fails your own file set.',
  // A check with no runner is reported under this exact marker by `complete`. It needed its own
  // row: routed in with "any other check", a teammate is told to fix a review check it cannot
  // run, and this repository's own manifest declares one, so that is the DEFAULT outcome.
  '             "could not run:" — a check whose kind this CLI has no runner for, such as an',
  '                "agent" review check, or a mistyped kind in the manifest. It never executed.',
  '                Nothing on your branch can change it, so do not try to make it pass.',
  // Thrown when the base this invocation resolves to collides with the run branch — see the
  // comment above verifyStep. Worded to hold whether that base arrived as an explicit --base
  // above or was left to complete's own derived default: `cli.mjs brief` renders no --base at
  // all when none was passed to it — grep scripts/cli.mjs's `brief` command for the literal
  // `flags.base === true ? '' : (flags.base ?? '')`, no resolveBaseBranch fallback beside it —
  // so a row that presupposed the flag would be false exactly there. No line number: that file
  // is under active edit elsewhere in this run, so a number written today is wrong tomorrow.
  // Named here so a teammate reads it as a dispatch error, not something wrong in its own
  // worktree that checking out a different branch would fix.
  '             "the run branch and the base branch are both" — the base this run resolved to',
  '                (an explicit --base above, or complete\'s own derived default when none is',
  '                shown) is the same as your own run branch. That is a dispatch error: the',
  '                collision existed before this brief was ever composed. Report it and',
  '                proceed; nothing in your worktree produced it.',
  // Each quoted marker stays whole on its own line. Wrapped mid-phrase, the very string a
  // teammate would search its own output for does not appear in the brief that told it to.
  '             "no gate manifest", "cannot verify completion",',
  '             "no task ' + task.id + ' in the plan", or a merge preview that could not be',
  '                built — the run cannot be verified from here. That is the run',
  '                configuration, not your work.',
  '             a check that RAN and failed, including this project\'s test command — the MERGED',
  '                tree failed it. That one you do fix: correct it and run the command again.',
  '           For everything except that last one, quote what it printed in your summary and',
  '           proceed. Do not loop on it, and do not report "blocked" when the work is finished.',
  '           A fully compliant task can legitimately exit 4 and never 0 — on a manifest that',
  '           declares a check this CLI cannot run, 4 with no other complaint IS your pass.',
  '  exit 2 — read the printed line here too: two unrelated things share this code.',
  '           Output naming an argument means YOUR INVOCATION was wrong, not the configuration:',
  '             "missing required argument:"   "unsupported flag spelling:"',
  '             "complete does not take"       "--root must not be empty"',
  '             "escapes the run directory"',
  '           None of those mention the manifest, and on any of them you have verified NOTHING',
  '           yet — the gate never ran. Fix the command you typed and run it again.',
  '           Any other exit 2 means fleetmates.gate.json itself is malformed. That one is',
  '           configuration, not your work: quote it and report it; do not loop.',
  '  exit 1 — the gate passed, but the run\'s status file is missing or does not list your task.',
  '           Your work is verified; quote the message and report it.',
  '',
] : [])

// THE THREE WALLS, stated before the work rather than discovered during it. Each one cost
// a teammate in run `purge` a long stretch of retrying, and each is a property of the
// harness rather than of the task: a subagent has no terminal, so nothing it runs can
// prompt, and a command that waits for a prompt waits forever rather than failing.
//
// Named as a REPORT, not as a prohibition alone: "do not run sudo" without "report blocked
// naming the command" leaves a teammate that genuinely needs privilege with no move.
const environmentRules = () => [
  'ENVIRONMENT. Your shell cannot prompt: there is no terminal attached to it and no human',
  'watching it. Three consequences, and none of them is worth retrying:',
  '1. Do not run sudo, pkexec, doas, or anything else that asks for a password. They do not',
  '   fail fast — they wait for input that can never arrive.',
  '2. Do not start an interactive login, a device-code flow, or any 2FA prompt. A CLI that',
  '   opens a browser or waits for a code is the same wall in a different shape.',
  '3. Do not run a command that pages, opens an editor, or waits on a confirmation. Pass the',
  '   non-interactive flag the tool provides, or do not run it.',
  'If the task genuinely needs any of those, report status "blocked" and name the exact',
  'command and what it asked for. That is a finished answer, not a failure.',
  '',
]

// WHY THIS IS IN THE BRIEF AND NOT ONLY IN THE AGENT DEFINITION: the defect it addresses
// was not a teammate ignoring a rule, it was a teammate writing a sentence about code it
// had not run and no step asking it to. In run `purge` one residual bullet was rewritten
// wrongly three times in a row, each version reproduced-and-refuted a round later, because
// the claim read plausibly and nothing in the dispatch bound it to an execution.
const claimRules = () => [
  'CLAIMS. Every sentence you write into a code comment, a skill, a test comment or your',
  'summary that says what the code DOES must be backed by a command you actually ran in',
  'this task, in this worktree. Not by reading, not by inference from a nearby comment.',
  'If you could not run it, write what you did verify and say the rest is unverified —',
  'an unverified sentence marked as such costs a reader nothing; one stated as fact costs',
  'a review round.',
  'Correcting an existing comment is the case that goes wrong most: reproduce the old claim',
  'FAILING before you write the new one, so you know which half was wrong.',
  '',
]

// The FILES line says which paths may change. This says what may not be INFERRED, which is
// a different failure: a teammate that decides a project is dormant, a file is dead, or a
// record is stale, and acts on it. Nothing in the file set stops that, because archiving
// or deleting inside your own declared paths is inside the set.
const scopeRules = () => [
  'SCOPE. Do not delete, archive, rename, or empty anything on the strength of what you',
  'inferred about it. Being inside your declared file set is permission to edit those',
  'paths for THIS task, not a judgement that whatever they contain is stale.',
  'If the plan and the tree disagree — a step that describes code that is not there, a file',
  'the plan says is unused — report status "blocked" quoting both. Do not reconcile them by',
  'guessing which one is out of date.',
  '',
]

const full = ({ task, runId, planPath, baseBranch, constraints, fixRound }) => [
  'You are tm-implementer for task ' + task.id + ': ' + task.title + '.',
  '',
  ...checkoutSteps(task, baseBranch, fixRound),
  '',
  ...locateStep(task, runId),
  'BASELINE. Then bootstrap the worktree, before writing anything, in this order:',
  '1. Install the project\'s dependencies as the project requires.',
  '2. Copy over any untracked config the project needs (for example .env).',
  '3. Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.',
  '   Never background it: nothing notifies you when a backgrounded command finishes.',
  'A fresh worktree starts with none of that in place, and a failure caused by a missing',
  'dependency looks exactly like a RED test, which the gate cannot tell apart from a real one.',
  'Report status "blocked" only if the baseline cannot be made green.',
  '',
  planPath ? 'PLAN. Read ' + planPath + ' and implement the section titled "Task '
    + task.id.replace(/^T/, '') + ':" — every numbered step, in order. The plan is the spec.' : '',
  '',
  'FILES. You may create or modify ONLY these files: ' + task.files.join(', ') + '.',
  'Touching any other file fails the phase gate.',
  '',
  ...blastRadius(task),
  ...scopeRules(),
  ...environmentRules(),
  ...claimRules(),
  constraints.length ? 'GLOBAL CONSTRAINTS:' : '',
  ...constraints.map((c) => '- ' + c),
  '',
  ...verifyStep(task, runId, planPath, baseBranch),
  'Commit your work on ' + task.branch + ' and return the structured result.',
].filter((line) => line !== '').join('\n')

// The compressed variant reuses checkoutSteps verbatim and compresses only the connective
// prose. The MANDATORY FIRST STEP block, the checkout commands, the locate and complete
// commands, the BASELINE steps, the FILES list and the constraints all survive unchanged: a
// brief is the task specification, and compressing a specification drops the wording the gate
// then enforces. A command line is not connective prose.
const terse = ({ task, runId, planPath, baseBranch, constraints, caveman, fixRound }) => [
  'You are tm-implementer. Task ' + task.id + ': ' + task.title + '.',
  '',
  ...checkoutSteps(task, baseBranch, fixRound),
  '',
  ...locateStep(task, runId),
  'BASELINE. Before writing anything, in order:',
  '1. Install the project\'s dependencies as the project requires.',
  '2. Copy over any untracked config the project needs (for example .env).',
  '3. Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.',
  '   Never background it: nothing notifies you when a backgrounded command finishes.',
  'Fresh worktree has none of that. Missing dep looks exactly like RED test; gate cannot tell',
  'them apart. Report status "blocked" only if baseline cannot be made green.',
  '',
  planPath ? 'PLAN. Read ' + planPath + ' and implement the section titled "Task '
    + task.id.replace(/^T/, '') + ':" — every numbered step, in order. The plan is the spec.' : '',
  '',
  'FILES. You may create or modify ONLY these files: ' + task.files.join(', ') + '.',
  'Touching any other file fails the phase gate.',
  '',
  ...blastRadius(task),
  ...scopeRules(),
  ...environmentRules(),
  ...claimRules(),
  constraints.length ? 'GLOBAL CONSTRAINTS:' : '',
  ...constraints.map((c) => '- ' + c),
  '',
  ...verifyStep(task, runId, planPath, baseBranch),
  'STYLE. Write summary and blockers caveman-terse: drop articles and filler, keep every',
  'technical term, file path and error string exact. If skill caveman:caveman is available,',
  'use it at level ' + caveman + '. If not available, apply the style directly — its absence',
  'is not a blocker.',
  '',
  'Commit your work on ' + task.branch + ' and return the structured result.',
].filter((line) => line !== '').join('\n')

export function composeBrief({ task, runId = '', planPath = '', baseBranch = '', constraints = [], caveman = false, fixRound = false }) {
  if (!task || typeof task.id !== 'string') throw new Error('composeBrief: task.id is required')
  if (!Array.isArray(task.files)) throw new Error(`composeBrief: task ${task.id} has no files array`)
  if (typeof task.branch !== 'string' || task.branch === '') {
    throw new Error(`composeBrief: task ${task.id} has no branch`)
  }
  const options = { task, runId, planPath, baseBranch, constraints, caveman, fixRound }
  return caveman ? terse(options) : full(options)
}
