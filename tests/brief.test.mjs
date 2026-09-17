import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { composeBrief } from '../scripts/brief.mjs'

const TASK = {
  id: 'T4',
  title: 'the SubagentStop handler',
  files: ['hooks/subagent-stop.mjs', 'tests/hook.test.mjs'],
  branch: 'fleetmates/substop/T4',
}

const FULL = {
  task: TASK,
  runId: 'substop',
  planPath: 'docs/plans/2026-08-13-subagent-stop-enforcement.md',
  baseBranch: 'master',
  constraints: ['Node >= 24.2.0', 'Zero new runtime dependencies'],
}

// Ordering assertions read positions off the rendered text rather than a line index, so a
// section that moves between blocks is caught even when its own line is unchanged.
const at = (brief, needle) => {
  const i = brief.indexOf(needle)
  assert.notEqual(i, -1, `expected the brief to contain ${JSON.stringify(needle)}`)
  return i
}

test('a fully supplied brief carries the checkout, baseline, plan, files and constraints', () => {
  const brief = composeBrief(FULL)
  assert.ok(brief.includes('git checkout -B fleetmates/substop/T4 master'))
  assert.ok(brief.includes('IN THE FOREGROUND'))
  assert.ok(brief.includes('docs/plans/2026-08-13-subagent-stop-enforcement.md'))
  assert.ok(brief.includes('You may create or modify ONLY these files:'))
  for (const f of TASK.files) assert.ok(brief.includes(f), `missing declared file ${f}`)
  for (const c of FULL.constraints) assert.ok(brief.includes('- ' + c), `missing constraint ${c}`)
})

// A FIX ROUND cannot be briefed with the ordinary first step. `git checkout -B <branch> <base>`
// resets the task branch to the base, which on a fix round is the work being fixed — the brief
// would destroy exactly what the round exists to repair. Compounding it, a fresh isolation
// worktree cannot check out a branch a dead worktree still holds, so the naive retry is
// blocked-THEN-destructive: the teammate is refused, frees the branch, and then runs the reset.
//
// Both halves are asserted, and the negative one is keyed on a RUNNABLE reset rather than on the
// string: this variant's prose names `git checkout -B` in order to forbid it, so an assertion on
// the substring would refuse the very sentence that closes the hazard. `runnableReset` is the
// existing `runnableCheckout` convention — an indented line beginning with the executable —
// narrowed to the reset spellings.
const runnableReset = /^[ \t]*git[ \t]+(checkout[ \t]+-B|switch[ \t]+-C)\b/m

test('a fix-round brief checks the task branch out without resetting it', () => {
  const brief = composeBrief({ ...FULL, fixRound: true })
  assert.ok(!runnableReset.test(brief), `a fix-round brief must never emit a runnable reset:\n${brief}`)
  // The same pattern must match the variant that DOES reset, or the assertion above proves
  // nothing.
  assert.ok(runnableReset.test(composeBrief(FULL)), 'the runnable-reset pattern fails to match a real reset command')
  assert.ok(brief.includes('git checkout fleetmates/substop/T4'), brief)
  // The teammate must not free the branch itself: the worktree guard blocks a teammate from
  // inspecting or removing another worktree, so that is the orchestrator's job.
  assert.match(brief, /report status\s+"blocked"/, brief)
})

test('a fix-round brief still carries everything else the ordinary brief does', () => {
  const brief = composeBrief({ ...FULL, fixRound: true })
  assert.ok(brief.includes('docs/plans/2026-08-13-subagent-stop-enforcement.md'))
  assert.ok(brief.includes('You may create or modify ONLY these files:'))
  for (const f of TASK.files) assert.ok(brief.includes(f), `missing declared file ${f}`)
  for (const c of FULL.constraints) assert.ok(brief.includes('- ' + c), `missing constraint ${c}`)
})

test('the plan section names the task section by its bare number', () => {
  const brief = composeBrief(FULL)
  assert.ok(brief.includes('the section titled "Task 4:"'))
})

test('the locate command carries the real ids and is rendered before BASELINE', () => {
  const brief = composeBrief(FULL)
  const locate = 'cli.mjs" locate --run substop --task T4'
  assert.ok(brief.includes(locate), 'locate command missing or ids not substituted')
  assert.ok(!brief.includes('$CLAUDE_PLUGIN_ROOT'),
    'the brief should not contain the literal $CLAUDE_PLUGIN_ROOT variable')
  // POSIX `/abs/…/scripts/cli.mjs`, or Windows `C:\\…\\scripts\\cli.mjs` — the brief renders the
  // path through JSON.stringify, which doubles each backslash, so separators may repeat.
  assert.ok(/node "?(?:\/|[A-Za-z]:\\+).*[\\/]+scripts[\\/]+cli\.mjs/.test(brief),
    'the brief should contain an absolute path to scripts/cli.mjs')
  assert.ok(at(brief, locate) < at(brief, 'BASELINE.'),
    'the location record must be written before the baseline work, not after it')
})

test('the locate line is rendered after the checkout it follows', () => {
  const brief = composeBrief(FULL)
  assert.ok(at(brief, 'git checkout -B ') < at(brief, 'locate --run substop'))
})

test('the complete command carries run, task and plan and sits after the constraints', () => {
  const brief = composeBrief(FULL)
  assert.ok(brief.includes('cli.mjs" complete'), 'complete command missing')
  assert.ok(!brief.includes('$CLAUDE_PLUGIN_ROOT'),
    'the brief should not contain the literal $CLAUDE_PLUGIN_ROOT variable')
  assert.ok(brief.includes('--run substop --task T4 --plan ' + FULL.planPath),
    'complete command does not substitute run id, task id and plan path')
  assert.ok(brief.includes('--root "$ROOT"'), 'complete command does not pass --root')
  // Without the assignment, --root "$ROOT" expands to the empty string and the CLI resolves the
  // run branch to the task branch — the wrong question, asked silently.
  assert.ok(brief.includes('ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")'),
    'the ROOT assignment that gives --root its value is missing')
  assert.ok(at(brief, 'ROOT=$(dirname') < at(brief, '--root "$ROOT"'),
    'ROOT must be assigned before it is passed to --root')
  assert.ok(at(brief, 'GLOBAL CONSTRAINTS:') < at(brief, 'cli.mjs" complete'),
    'self-verification must follow the constraints section')
  assert.ok(at(brief, 'cli.mjs" complete') < at(brief, 'Commit your work on'),
    'self-verification must precede the final commit instruction')
})

// `complete` derives a base itself when none is passed — `main` or `master` — and anchors the
// plan lookup there. On a run whose base is neither (this repository's own run `purge`, based
// on `run/purge`), that derived anchor holds no plan at all, and the failure names the plan
// rather than the base. The fix is not "pass some base": it has to be the SAME value the
// checkout step branched from, or the gate's anchor and the teammate's actual fork point can
// still disagree — so this asserts they are the one value, not two literals that happen to match.
//
// FULL.baseBranch is 'master', which is exactly the value `complete` derives on its own with no
// `--base` at all — so a mutant that hardcodes `--base master` passes against that fixture alone.
// The second case uses a base that is neither `main` nor `master` (`run/purge`, this run's own
// base), so the value has to travel from the checkout step rather than coincide with a guess.
// Verified by mutation: replacing `' --base ' + baseBranch` with the literal `' --base master'`
// turned this test red on the run/purge case while leaving the master case green.
test('the complete invocation carries the same base branch the checkout step used', () => {
  for (const opts of [FULL, { ...FULL, baseBranch: 'run/purge' }]) {
    for (const brief of [composeBrief(opts), composeBrief({ ...opts, caveman: 'full' })]) {
      const checkoutLine = brief.split('\n').find((l) => l.includes('git checkout -B'))
      assert.ok(checkoutLine, 'no checkout line found')
      assert.ok(checkoutLine.endsWith(opts.baseBranch),
        `the checkout line does not end with the base branch: ${checkoutLine}`)
      const completeLine = brief.split('\n').find((l) => l.includes('--plan ' + opts.planPath))
      assert.ok(completeLine, 'no complete invocation line found')
      assert.ok(completeLine.includes('--base ' + opts.baseBranch),
        `the complete invocation does not carry --base ${opts.baseBranch}: ${completeLine}`)
      assert.ok(at(brief, '--plan ' + opts.planPath) < at(brief, '--base ' + opts.baseBranch),
        '--base must follow --plan in the invocation')
      assert.ok(at(brief, '--base ' + opts.baseBranch) < at(brief, '--root "$ROOT"'),
        '--base must precede --root in the invocation')
    }
  }
})

// Scoped to the invocation line itself, not the whole brief: the exit-4 guidance below
// legitimately mentions the literal substring `--base` in prose (the run-branch-collision row),
// regardless of whether this particular invocation carries the flag, so a whole-brief
// `!includes('--base')` would fail on that prose rather than on a real regression.
test('the complete invocation carries no --base when no base branch was supplied', () => {
  for (const brief of [
    composeBrief({ ...FULL, baseBranch: '' }),
    composeBrief({ ...FULL, baseBranch: '', caveman: 'full' }),
  ]) {
    assert.ok(brief.includes('cli.mjs" complete'), 'the verify section should still render: run id and plan path are both present')
    const completeLine = brief.split('\n').find((l) => l.includes('--plan ' + FULL.planPath))
    assert.ok(completeLine, 'no complete invocation line found')
    assert.ok(!completeLine.includes('--base'), 'a --base flag was emitted with no base branch supplied')
  }
})

// Read out of `complete` in scripts/cli.mjs. The rejection is its OWN code now — the printed
// first line no longer has to carry that distinction, because `COMPLETE_REJECTED` does — but the
// guidance attached to each code is unchanged in kind, and it is what this test is about: a brief
// that maps the rejection to "proceed", or the cannot-verify to "fix it", tells a teammate with a
// failing fileset check to return done, or sends a compliant one to clean someone else's tree.
//
// The codes themselves are pinned against cli.mjs's constants further down; here they are written
// out, so that a change to the mapping fails BOTH as a broken cross-file pin and as guidance that
// no longer reads correctly.
test('the verify step attaches the right guidance to the rejection and the cannot-verify codes', () => {
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    assert.ok(/exit 0[^\n]*passes/.test(brief), 'exit 0 is not described as passing')
    // Assert the GUIDANCE inside the rejection row, not the presence of a word the row itself
    // supplies: `/REJECTED/ || /fix/i` short-circuited on its own text and stayed green when the
    // guidance was swapped for "quote it and proceed", which is the inversion again.
    const rejection = brief.slice(at(brief, 'exit 3 — '), at(brief, 'exit 4 — '))
    assert.ok(/Fix exactly the checks it names/.test(rejection),
      'the rejection row does not tell the teammate to fix the checks it names')
    assert.ok(/run the command again/.test(rejection),
      'the rejection row does not tell the teammate to re-run')
    for (const wrong of ['proceed', 'do not loop', 'Quote']) {
      assert.ok(!rejection.includes(wrong),
        `the rejection row tells the teammate to "${wrong}" — that is the cannot-verify guidance`)
    }
    // The cannot-verify row is a DIFFERENT code, and it is the one that proceeds.
    assert.ok(/exit 4 — no check scoped to your task rejected you/.test(brief),
      'the cannot-verify situations are not keyed to exit 4')
    // Scoped to the row rather than to a character distance from a phrase: the row grew when it
    // had to separate three kinds of failure, and a magic gap silently stops reaching.
    const cannotVerify = brief.slice(at(brief, 'exit 4 — '), at(brief, 'exit 2 — '))
    assert.ok(cannotVerify.includes('no gate manifest'),
      'the cannot-verify row does not name the outputs it covers')
    assert.ok(/do not loop on it/i.test(cannotVerify),
      'the cannot-verify row does not tell the teammate to proceed rather than loop')
    assert.ok(at(brief, 'exit 3 — ') < at(brief, 'exit 4 — '),
      'the rejection row must be read before the cannot-verify row')
    // Exit 2 is a malformed manifest AND every argument error on the invocation. Without a
    // discriminator a teammate that drops a flag reads "not your work, do not loop" and
    // proceeds having never run the gate at all.
    assert.ok(/exit 2[^]{0,200}missing required argument:/.test(brief),
      'exit 2 does not name the argument-error output that shares its code')
    assert.ok(brief.includes('unsupported flag spelling:'),
      'exit 2 does not name the refused-spelling output')
    assert.ok(brief.includes('--root must not be empty'),
      'exit 2 does not name the empty-root output')
    // cli.mjs prints `--run <value> escapes the run directory` for a traversal in --run. An
    // unlisted marker falls through to the malformed-manifest line, diagnosing configuration
    // for a rejected invocation on which the gate never ran.
    assert.ok(brief.includes('escapes the run directory'),
      'exit 2 does not name the run-directory-escape output')
    assert.ok(/missing required argument:[^]{0,400}run it again/.test(brief),
      'a malformed invocation is not the teammate\'s own to fix and re-run')
    assert.ok(/missing required argument:[^]{0,400}verified NOTHING/.test(brief),
      'the brief does not say an argument error means the gate never ran')
    assert.ok(/exit 2[^]{0,600}malformed/.test(brief),
      'exit 2 no longer describes a malformed manifest')
    assert.ok(!/exit 2 — fleetmates\.gate\.json is malformed\. Configuration, not your work\./.test(brief),
      'exit 2 still maps every case to configuration')
    // `complete` accepts `--enforcement-only` now, and the brief still must not emit it: the
    // teammate's own verification is the full one. The flag exists for the stop-time hook, which
    // trades command checks for speed and deliberately marks nothing done.
    assert.ok(!brief.includes('--enforcement-only'),
      'the brief emits --enforcement-only, which would have the teammate verify less than it should')
    assert.ok(/exit 1[^]{0,200}status file is missing/.test(brief),
      'exit 1 is not described as missing status bookkeeping')
    // The inverted mapping round 2 shipped must not come back.
    assert.ok(!/exit 2 — the gate ran and rejected/.test(brief),
      'exit 2 is still described as the gate rejecting the task')
    assert.ok(!/exit 4 — it could not verify/.test(brief),
      'exit 4 is still described as only a failure to verify')
    assert.ok(!/Anything else: fix what it names/.test(brief),
      'the brief still treats every non-zero exit as the teammate\'s defect')
  }
})

test('with no run id neither the locate nor the verify section is rendered', () => {
  const brief = composeBrief({ ...FULL, runId: '' })
  assert.ok(!brief.includes('locate --run'), 'locate section rendered without a run id')
  assert.ok(!brief.includes('cli.mjs" complete'), 'verify section rendered without a run id')
  assert.ok(!brief.includes('--run  '), 'a command was emitted with an empty --run value')
  assert.ok(!/--run\s*$/m.test(brief), 'a command was emitted with a trailing empty --run value')
})

test('with no plan path the verify section is dropped rather than emitting an empty --plan', () => {
  const brief = composeBrief({ ...FULL, planPath: '' })
  assert.ok(!brief.includes('cli.mjs" complete'), 'verify section rendered without a plan path')
  assert.ok(!brief.includes('--plan '), 'a complete command was emitted with an empty plan path')
  assert.ok(brief.includes('locate --run substop --task T4'),
    'the locate section does not depend on the plan path')
})

// A runnable command in this brief is an indented line beginning with the executable. The
// prose that quotes a checkout starts with a double quote, so it is not one. Pinning the
// absence of any runnable checkout catches the operand-less `git checkout -B <branch>` the
// module's own comment warns about, in `switch -c` spelling too — the old assertion keyed on
// one exact string with a trailing space and caught neither.
const runnableCheckout = /^[ \t]*git[ \t]+(checkout|switch)\b/m

test('with no base branch the brief refuses to name a starting commit', () => {
  const brief = composeBrief({ ...FULL, baseBranch: '' })
  assert.ok(brief.includes('No base branch was supplied'))
  assert.ok(!runnableCheckout.test(brief),
    'the no-base variant emits a runnable checkout command; it must refuse to name a start point')
  assert.ok(brief.includes('report status "blocked"'))
  // The same regex must match the variant that DOES emit one, or it proves nothing above.
  assert.ok(runnableCheckout.test(composeBrief(FULL)),
    'the runnable-checkout pattern fails to match a real checkout command')
})

test('the no-base caveman variant also emits no runnable checkout', () => {
  const brief = composeBrief({ ...FULL, baseBranch: '', caveman: 'full' })
  assert.ok(!runnableCheckout.test(brief))
  assert.ok(brief.includes('No base branch was supplied'))
})

test('with no constraints the GLOBAL CONSTRAINTS header is not rendered', () => {
  const brief = composeBrief({ ...FULL, constraints: [] })
  assert.ok(!brief.includes('GLOBAL CONSTRAINTS:'))
  assert.ok(brief.includes('cli.mjs" complete'), 'the verify section survives an empty constraint list')
})

test('a blast radius renders every neighbour with its percentage', () => {
  const brief = composeBrief({
    ...FULL,
    task: { ...TASK, neighbours: [{ path: 'scripts/cli.mjs', confidence: 0.82 }, { path: 'scripts/state.mjs', confidence: 0.4 }] },
  })
  assert.ok(brief.includes('BLAST RADIUS.'))
  assert.ok(brief.includes('82%  scripts/cli.mjs'))
  assert.ok(brief.includes('40%  scripts/state.mjs'))
})

test('a task with no neighbours renders no blast radius and no undefined', () => {
  const brief = composeBrief(FULL)
  assert.ok(!brief.includes('BLAST RADIUS.'))
  assert.ok(!brief.includes('undefined'))
})

// An absent key and an empty array are different inputs and the guard must reject both: with
// only the absent-key case pinned, weakening the guard to a truthiness test on the array
// leaves the suite green while an empty list renders a header with nothing under it.
test('an empty neighbours array renders no blast radius header', () => {
  const brief = composeBrief({ ...FULL, task: { ...TASK, neighbours: [] } })
  assert.ok(!brief.includes('BLAST RADIUS.'),
    'an empty neighbours array rendered a header with no files under it')
  assert.ok(!brief.includes('They have changed together'))
  assert.ok(brief.includes('Touching any other file fails the phase gate.'),
    'the section around the blast radius is still rendered')
})

// Anchored to line starts, not matched anywhere in the brief: whole-string assert.match
// survives a wall being DELETED (a mutant that removed wall 3 outright left the unanchored
// assertions green, because /device-code flow/ still matched wall 2) or REWRITTEN to say the
// opposite ("You may freely start an interactive login...", "You may freely run a command that
// pages...") — a substring like /device-code flow/ matches permissive prose just as well as a
// prohibition. Anchoring each wall to its own line start requires that EXACT sentence to open
// that line.
test('the brief states the three environment walls in both variants', () => {
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    assert.match(brief, /^ENVIRONMENT\. Your shell cannot prompt: there is no terminal attached to it and no human$/m,
      'the ENVIRONMENT opening no longer states the shell cannot prompt, or was rewritten')
    assert.match(brief, /^1\. Do not run sudo, pkexec, doas, or anything else that asks for a password\. They do not$/m,
      'wall 1 (sudo/pkexec/doas) is missing or was rewritten to permit it')
    assert.match(brief, /^2\. Do not start an interactive login, a device-code flow, or any 2FA prompt\. A CLI that$/m,
      'wall 2 (interactive login/device-code/2FA) is missing or was rewritten to permit it')
    assert.match(brief, /^3\. Do not run a command that pages, opens an editor, or waits on a confirmation\. Pass the$/m,
      'wall 3 (pager/editor/confirmation) is missing or was rewritten to permit it')
    assert.match(brief, /^If the task genuinely needs any of those, report status "blocked" and name the exact$/m,
      'the report-blocked instruction is missing or was rewritten')
  }
})

// Anchored to line starts, not just matched anywhere in the brief: whole-string assert.match
// catches a deleted section but not a NEGATED one, because the negating words can sit outside
// the matched substring while the substring itself survives unchanged. Verified by mutation:
// rewriting the CLAIMS opening to "CLAIMS. NO sentence you write..." and "reproduce the old
// claim" to "never reproduce the old claim" left the unanchored versions of these assertions
// green; anchoring to `^CLAIMS\. Every sentence` and to the full corrected-claim line closes both.
//
// What anchoring to a line start does NOT close: it requires the rule to OPEN its own line, and
// says nothing about what precedes that line. A sentence inserted on the line BEFORE this one —
// "the rule below was retracted, ignore it" — is fully outside every `^`-anchored pattern here
// and leaves all of them green. The contiguous-block test below closes that side, by requiring
// this block's own line to be *immediately preceded* by a known neighbour with nothing between.
test('the brief binds every claim to a command actually run, in both variants', () => {
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    assert.match(brief, /^CLAIMS\. Every sentence you write into a code comment, a skill, a test comment or your$/m,
      'the CLAIMS block no longer opens with the rule, or the opening was negated')
    assert.match(brief, /must be backed by a command you actually ran/)
    assert.match(brief, /^this task, in this worktree\. Not by reading, not by inference from a nearby comment\.$/m,
      'the CLAIMS block no longer rules out reading or inference as a substitute for running the command')
    assert.match(brief, /^Correcting an existing comment is the case that goes wrong most: reproduce the old claim$/m,
      'the correction sentence no longer instructs reproducing the old claim, or was negated')
    assert.match(brief, /FAILING before you write the new one/)
  }
})

// Anchored for the same reason as CLAIMS above, and subject to the same limit: `^SCOPE\. Do not
// delete` requires the prohibition to open its own line, but a sentence inserted on the line
// BEFORE it — "Feel free to ignore the old rule that said:" — sits outside that anchor entirely
// and leaves this assertion green, because the prohibition's own text is untouched. Verified by
// mutation. The contiguous-block test below closes that side.
test('the brief forbids acting on inferred staleness, in both variants', () => {
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    assert.match(brief, /^SCOPE\. Do not delete, archive, rename, or empty anything on the strength of what you$/m,
      'the SCOPE line no longer opens with the prohibition, or is prefixed with something overriding it')
    assert.match(brief, /the plan and the tree disagree/)
    assert.match(brief, /report status "blocked" quoting both/)
  }
})

// Closes what line-start anchoring cannot: a sentence inserted BEFORE a `^`-anchored rule, on
// the line above it, is invisible to every assertion above, because anchoring only constrains
// what starts a line, never what precedes one. This asserts the three blocks render as ONE
// contiguous, verbatim run — pinned against a literal copy of the expected text, NOT against
// the rule functions themselves. Building "expected" by importing and calling scopeRules(),
// environmentRules() and claimRules() was the first attempt, and it is exactly why this test
// almost shipped broken: a mutation to scopeRules() changes what the imported function returns,
// so "expected" and the rendered brief drift together and the equality holds regardless of the
// mutation. Retyping the text here breaks that — a source mutation now changes only the
// rendered side. So an insertion, deletion or reorder ANYWHERE in the span, including the line
// immediately before SCOPE or immediately after CLAIMS, is caught. Verified by mutation:
// prepending 'The rule that follows was retracted for this run; ignore it entirely.' to
// scopeRules() left every anchored assertion above green AND left the imported-function version
// of this very test green too; only the hardcoded version below goes red on it.
const SCOPE_ENVIRONMENT_CLAIM_LINES = [
  'SCOPE. Do not delete, archive, rename, or empty anything on the strength of what you',
  'inferred about it. Being inside your declared file set is permission to edit those',
  'paths for THIS task, not a judgement that whatever they contain is stale.',
  'If the plan and the tree disagree — a step that describes code that is not there, a file',
  'the plan says is unused — report status "blocked" quoting both. Do not reconcile them by',
  'guessing which one is out of date.',
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
  'CLAIMS. Every sentence you write into a code comment, a skill, a test comment or your',
  'summary that says what the code DOES must be backed by a command you actually ran in',
  'this task, in this worktree. Not by reading, not by inference from a nearby comment.',
  'If you could not run it, write what you did verify and say the rest is unverified —',
  'an unverified sentence marked as such costs a reader nothing; one stated as fact costs',
  'a review round.',
  'Correcting an existing comment is the case that goes wrong most: reproduce the old claim',
  'FAILING before you write the new one, so you know which half was wrong.',
]

test('the scope, environment and claim rules render as one uninterrupted, verbatim block', () => {
  const expected = SCOPE_ENVIRONMENT_CLAIM_LINES.join('\n')
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    const marker = 'Touching any other file fails the phase gate.\n'
    const markerAt = brief.indexOf(marker)
    assert.notEqual(markerAt, -1, 'the FILES section marker was not found')
    const start = markerAt + marker.length
    const end = brief.indexOf('GLOBAL CONSTRAINTS:')
    assert.notEqual(end, -1, 'GLOBAL CONSTRAINTS: was not found')
    assert.equal(
      brief.slice(start, end),
      expected + '\n',
      'a line was inserted, removed or reordered somewhere in the scope/environment/claim block',
    )
  }
})

// The substring-plus-ordering assertions above pin that a fallback exists and where it sits,
// but not the INSTRUCTION itself — the clause telling a teammate the workaround is expected and
// a "blocked" report over it is not. That clause was entirely unasserted, so inverting it stayed
// green. Reproduced by mutation: rewording 'that way is expected; reporting "blocked" over it is
// not.' to 'that way is NOT expected; report status "blocked" over it instead of running the
// gate.' left the whole suite passing while telling every implementer the opposite of what the
// sentence exists to say. Line-anchored rather than folded into the SCOPE/ENVIRONMENT/CLAIMS
// block-equality test below: that block is one contiguous span of fully static text, while this
// clause sits inside verifyStep among lines that interpolate runId, task.id, planPath and
// baseBranch — hardcoding that whole span would duplicate the fixture's dynamic values a second
// time in this file for one clause, which is more surface to drift than the single anchor below.
test('the brief names the script-file fallback for a shell that refuses the complete invocation', () => {
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    const fallback = 'write the two lines to a file'
    assert.ok(brief.includes(fallback), 'the fallback sentence is missing')
    assert.ok(at(brief, 'cli.mjs" complete') < at(brief, fallback),
      'the fallback must sit after the complete invocation')
    assert.ok(at(brief, fallback) < at(brief, 'ROOT must be the MAIN worktree'),
      'the fallback must sit before the ROOT must be the MAIN worktree line')
    assert.match(brief, /^that way is expected; reporting "blocked" over it is not\.$/m,
      'the fallback no longer says working around the refusal is expected, or the instruction was inverted')
    for (const inverted of ['is NOT expected', 'instead of running the gate']) {
      assert.ok(!brief.includes(inverted),
        `the fallback instruction reads as inverted — found the phrase "${inverted}"`)
    }
  }
})

test('the caveman variant keeps every load-bearing instruction', () => {
  const brief = composeBrief({ ...FULL, caveman: 'full' })
  assert.ok(brief.includes('git checkout -B fleetmates/substop/T4 master'))
  assert.ok(brief.includes('locate --run substop --task T4'))
  assert.ok(brief.includes('cli.mjs" complete'))
  assert.ok(brief.includes('--run substop --task T4 --plan ' + FULL.planPath))
  assert.ok(brief.includes('IN THE FOREGROUND'))
  assert.ok(brief.includes(FULL.planPath))
  for (const f of TASK.files) assert.ok(brief.includes(f), `missing declared file ${f}`)
  // The constraints were the one clause the module's own "survives compression unchanged"
  // comment named and nothing checked: emptying them in `terse` alone left the suite green.
  assert.ok(brief.includes('GLOBAL CONSTRAINTS:'),
    'the compressed variant dropped the GLOBAL CONSTRAINTS header')
  for (const c of FULL.constraints) {
    assert.ok(brief.includes('- ' + c), `the compressed variant dropped the constraint: ${c}`)
  }
})

// The comment above `terse` claims parity with `full` on the load-bearing clauses. Assert it
// clause by clause rather than trusting the prose, so compression cannot silently lose one.
// Every clause is matched by its own instruction text: matching a plan path or a file name
// instead would be satisfied by an incidental occurrence elsewhere in the brief — the `--plan`
// argument of the complete command already contains the plan path, so `includes(planPath)`
// stays green with the whole PLAN clause deleted.
const SPEC_CLAUSES = [
  'MANDATORY FIRST STEP.',
  'git checkout -B fleetmates/substop/T4 master',
  'RECORD YOUR WORKTREE.',
  'locate --run substop --task T4',
  // The plan pointer, by its instruction rather than by the path.
  'PLAN. Read ' + FULL.planPath + ' and implement the section titled "Task 4:"',
  'every numbered step, in order. The plan is the spec.',
  // The baseline, all three steps. Steps 1 and 2 are what make step 3 meaningful: without
  // them a teammate runs the suite in an uninstalled worktree, sees the RED the next sentence
  // warns it cannot distinguish from a real failure, and reports blocked.
  '1. Install the project\'s dependencies as the project requires.',
  '2. Copy over any untracked config the project needs (for example .env).',
  '3. Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.',
  'Never background it: nothing notifies you when a backgrounded command finishes.',
  'You may create or modify ONLY these files:',
  'Touching any other file fails the phase gate.',
  'BLAST RADIUS. These files are not yours and you may not edit them.',
  '82%  scripts/cli.mjs',
  'BEFORE YOU RETURN "done".',
  'ROOT=$(dirname',
  '--run substop --task T4 --plan ' + FULL.planPath,
  // The exit-code guidance, by the row that tells the teammate its work was rejected. This used
  // to be the phrase `gate does not pass for phase`, because the code alone could not separate a
  // rejection from a cannot-verify and only the printed line could. A distinct code replaced
  // that, so the clause worth pinning is the row keyed to it.
  'exit 3 — a check scoped to your task REJECTED it',
  'GLOBAL CONSTRAINTS:',
  ...FULL.constraints.map((c) => '- ' + c),
]

test('the compressed variant carries the same specification clauses as the full one', () => {
  const withNeighbours = {
    ...FULL,
    task: { ...TASK, neighbours: [{ path: 'scripts/cli.mjs', confidence: 0.82 }] },
  }
  const full = composeBrief(withNeighbours)
  const terse = composeBrief({ ...withNeighbours, caveman: 'full' })
  for (const clause of SPEC_CLAUSES) {
    assert.ok(full.includes(clause), `the full variant is missing: ${clause}`)
    assert.ok(terse.includes(clause), `compression dropped a specification clause: ${clause}`)
  }
})

// Which variant a caller gets by default is a behavioural choice nothing pinned: flipping the
// signature default to a caveman level sent every ordinary dispatch the compressed spec plus a
// STYLE directive no caller asked for, undetected.
test('an omitted caveman key renders the full variant, not the compressed one', () => {
  const brief = composeBrief(FULL)
  assert.ok(brief.includes('BASELINE. Then bootstrap the worktree, before writing anything'),
    'the default render is not the full variant')
  assert.ok(!brief.includes('STYLE.'), 'the default render carries the caveman STYLE directive')
  assert.ok(!brief.includes('caveman-terse'), 'the default render asks for caveman-terse output')
  assert.ok(!brief.includes('use it at level'), 'the default render names a caveman level')
  // ...and the compressed variant really is different, so the assertions above can fail.
  const terse = composeBrief({ ...FULL, caveman: 'full' })
  assert.ok(terse.includes('STYLE.') && !terse.includes('BASELINE. Then bootstrap'),
    'the two variants are indistinguishable, so the default cannot be pinned')
})

// Rendered at two distinct levels, because asserting `level full` against `caveman: 'full'`
// passes just as well when the level is hardcoded — the assertion has to see the value change.
test('the caveman level is substituted rather than hardcoded', () => {
  const asFull = composeBrief({ ...FULL, caveman: 'full' })
  const asUltra = composeBrief({ ...FULL, caveman: 'ultra' })
  assert.ok(asFull.includes('use it at level full'), 'level full is not substituted')
  assert.ok(asUltra.includes('use it at level ultra'), 'level ultra is not substituted')
  assert.ok(!asUltra.includes('level full'),
    'a brief asked for level ultra still names level full — the level is hardcoded')
  assert.ok(!asFull.includes('level ultra'))
})

test('the caveman variant keeps the locate before BASELINE and complete before the commit line', () => {
  const brief = composeBrief({ ...FULL, caveman: 'full' })
  assert.ok(at(brief, 'locate --run substop') < at(brief, 'BASELINE.'))
  assert.ok(at(brief, 'cli.mjs" complete') < at(brief, 'Commit your work on'))
})

test('the caveman variant drops the same sections when inputs are omitted', () => {
  const brief = composeBrief({ task: TASK, caveman: 'full' })
  assert.ok(!brief.includes('locate --run'))
  assert.ok(!brief.includes('cli.mjs" complete'))
  assert.ok(!brief.includes('--run  '))
  assert.ok(brief.includes('No base branch was supplied'))
})

test('composeBrief throws when task.id is missing', () => {
  assert.throws(() => composeBrief({ task: { files: [], branch: 'b' } }), /task\.id is required/)
  assert.throws(() => composeBrief({}), /task\.id is required/)
})

test('composeBrief throws when task.files is not an array', () => {
  assert.throws(
    () => composeBrief({ task: { id: 'T1', files: 'a,b', branch: 'b' } }),
    /T1 has no files array/,
  )
})

test('composeBrief throws when task.branch is empty', () => {
  assert.throws(
    () => composeBrief({ task: { id: 'T1', files: [], branch: '' } }),
    /T1 has no branch/,
  )
})

// The realistic shape for a task read out of a plan is an ABSENT branch key, not an empty
// string. With only the empty-string case pinned, narrowing the guard to `=== ''` renders
// `git checkout -B undefined <base>` and the teammate commits to a branch named `undefined`,
// which no gate check can find.
test('composeBrief throws when task.branch is absent or not a string', () => {
  for (const branch of [undefined, null, 42, {}]) {
    const task = { id: 'T1', files: [] }
    if (branch !== undefined) task.branch = branch
    assert.throws(() => composeBrief({ task }), /T1 has no branch/,
      `a branch of ${JSON.stringify(branch) ?? 'undefined'} was accepted`)
  }
})

test('no rendered line is empty of content yet claims a value it does not have', () => {
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    for (const flag of ['run', 'task', 'plan', 'root']) {
      assert.ok(!new RegExp('--' + flag + '\\s*$', 'm').test(brief),
        `a --${flag} flag ends a line with no value`)
      assert.ok(!brief.includes('--' + flag + '  '),
        `a --${flag} flag is followed by an empty value`)
      assert.ok(!brief.includes('--' + flag + ' ""'),
        `a --${flag} flag is given an empty literal`)
    }
  }
})

// Strips comments and string contents, leaving executable source. Almost every line of
// brief.mjs is brief prose held in a string literal, so scanning raw text confuses a word in
// the prose ("respawn", "process.") with a call. Template substitutions are KEPT — `${...}`
// holds real code — while the literal text around them is dropped. Regex literals are not
// tracked; brief.mjs contains one (`/^T/`) and it holds no quote, so it does not perturb the
// scan.
function executableSource(src) {
  let out = ''
  let i = 0
  const stack = []
  while (i < src.length) {
    const c = src[i]
    const two = src.slice(i, i + 2)
    if (two === '//') { i = src.indexOf('\n', i); if (i === -1) break; continue }
    if (two === '/*') { i = src.indexOf('*/', i) + 2; continue }
    if (c === "'" || c === '"') {
      const q = c
      i += 1
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1
      i += 1
      out += ' '
      continue
    }
    if (c === '`') {
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '`') { i += 1; break }
        if (src.slice(i, i + 2) === '${') {
          i += 2
          let depth = 1
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth += 1
            else if (src[i] === '}') depth -= 1
            if (depth > 0) out += src[i]
            i += 1
          }
          out += ' '
          continue
        }
        i += 1
      }
      out += ' '
      continue
    }
    out += c
    i += 1
  }
  return out
}

// Cross-file, source-level check. The module's purity is a claim about what it does NOT do:
// an unused `node:fs` import or a `process.env` read changes no rendered output, so no
// behavioural assertion over composeBrief's return value can fail on it. This repository
// already uses cross-file source checks for exactly this shape of claim.
test('scripts/brief.mjs executable source imports nothing and touches no host state', async () => {
  const src = await readFile(new URL('../scripts/brief.mjs', import.meta.url), 'utf8')
  const code = executableSource(src)
  // This module may import from node:* (built-in modules) to compute the CLI path at load time,
  // but must not import from third-party modules, require, or touch process state. The check on
  // executable code (with comments and strings stripped) catches imports from external modules
  // and dynamic requires, but allows node:* imports used to compute constants.
  const hasNodeImport = /\bimport\s+(?:{[^}]*}|[a-z]+)\s+from\s+['"]node:[^'"]+['"]/.test(code)
  const hasExternalImport = /\bimport\s+(?:{[^}]*}|[a-z]+)\s+from\s+['"](?!node:)[^'"]+['"]/.test(code)
  assert.ok(!hasExternalImport, 'scripts/brief.mjs must not import from third-party modules')
  assert.ok(!/\bexport\b[^;\n]*\bfrom\b/.test(code), 'scripts/brief.mjs must not re-export from a module')
  assert.ok(!/\brequire\s*\(/.test(code), 'scripts/brief.mjs must not require anything')
  assert.ok(!/\bprocess\b/.test(code), 'scripts/brief.mjs must not touch process')
  assert.ok(!/\bglobalThis\b/.test(code), 'scripts/brief.mjs must not reach through globalThis')
  assert.ok(!/\b(eval|Function)\s*\(/.test(code),
    'scripts/brief.mjs must not construct code at runtime')
  // The stripper is the load-bearing half of this check, so pin it against both directions of
  // the mistake it exists to prevent.
  assert.equal(/\bprocess\b/.test(executableSource("const a = 'process.env is prose here'")), false)
  assert.equal(/\bimport\b/.test(executableSource("const a = 'do not import a neighbour file'")), false)
  assert.equal(/\bimport\b/.test(executableSource('await import(\'node:\' + \'fs\')')), true)
  assert.equal(/\bimport\b/.test(executableSource('import "node:fs"')), true)
  assert.equal(/\bimport\b/.test(executableSource("import{readFileSync}from'node:fs'")), true)
  assert.equal(/\bexport\b[^;\n]*\bfrom\b/.test(executableSource("export * from 'node:fs'")), true)
  assert.equal(/\bprocess\b/.test(executableSource('const a = `x${process.env.Y}z`')), true)
})

// ---------------------------------------------------------------------------
// The exit-code table is part of the contract, and it is pinned ACROSS FILES.
// ---------------------------------------------------------------------------
//
// The brief's table is the only place a teammate learns what a code means. When the rejection
// moved from 4 to 3 the table stayed behind, and a teammate hitting 3 would have found no row at
// all — while the nearest "gate does not pass" row sat under exit 4 next to a sibling telling it
// exit 4 was a configuration problem to quote and proceed past. That is an instruction to ignore
// its own rejection, and no test in either file would have caught it, because each file was
// internally consistent.
//
// So these read the numbers out of `scripts/cli.mjs` itself. Change the mapping there and this
// fails here, which is the only arrangement that makes the rendered table trustworthy. Source
// scanning rather than an import, for the same reason the purity check above scans: `brief.mjs`
// may not import anything, so the two cannot be wired together at runtime.
const CODE_RE = (name) => new RegExp(`^const ${name} = (\\d+)$`, 'm')

function cliExitCode(source, name) {
  const found = CODE_RE(name).exec(source)
  assert.ok(found, `scripts/cli.mjs no longer declares ${name} — this pin is reading the wrong thing`)
  return Number(found[1])
}

// The rendered rows, keyed by the code each one documents. A row runs from its own `exit <n> —`
// line to the start of the next one, so the continuation lines belong to the row they explain.
function exitRows(brief) {
  const starts = [...brief.matchAll(/^ {2}exit (\d+) — /gm)]
  assert.ok(starts.length > 0, 'the brief renders no exit-code rows at all')
  const rows = new Map()
  starts.forEach((match, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : brief.length
    rows.set(Number(match[1]), brief.slice(match.index, end))
  })
  return rows
}

test('the brief documents the exit codes scripts/cli.mjs actually returns', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const rejected = cliExitCode(cli, 'COMPLETE_REJECTED')
  const cannotVerify = cliExitCode(cli, 'COMPLETE_CANNOT_VERIFY')
  assert.notEqual(rejected, cannotVerify, 'the two codes must stay distinct or the hook cannot decide')

  const rows = exitRows(composeBrief(FULL))
  // Every code the CLI can return has a row: a teammate that hits an undocumented code has
  // nothing to act on, which is exactly the gap this pin closes.
  for (const code of [0, 1, 2, rejected, cannotVerify]) {
    assert.ok(rows.has(code), `the brief documents no exit ${code}`)
  }
  assert.match(rows.get(rejected), /REJECTED it/)
  assert.match(rows.get(rejected), /not a configuration problem/)
  assert.match(rows.get(cannotVerify), /no check scoped to your task rejected you/)

  // Exit 0 is UNREACHABLE on a manifest that declares a check this CLI has no runner for — such a
  // check is a non-optional pending on every invocation, so the verdict is never PASS. This
  // repository's own manifest is one, so a teammate following the brief here will never see 0 and
  // must not read its absence as a rejection. Both rows have to say so or the table is a trap.
  assert.match(rows.get(0), /never reach 0/)
  assert.match(rows.get(cannotVerify), /4 with no other complaint IS your pass/)
})

test('the brief attributes a run-wide check to the code that does not block', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const rejected = cliExitCode(cli, 'COMPLETE_REJECTED')
  const cannotVerify = cliExitCode(cli, 'COMPLETE_CANNOT_VERIFY')

  // The kinds cli.mjs treats as scoped to the calling task. `ownership` must not be among them:
  // it reads every commit on the run branch and the main worktree's cleanliness, so a teammate
  // blocked on it is blocked by work that is not its own.
  const declared = /^const TASK_SCOPED_KINDS = new Set\(\[([^\]]*)\]\)$/m.exec(cli)
  assert.ok(declared, 'scripts/cli.mjs no longer declares TASK_SCOPED_KINDS')
  const kinds = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(kinds.slice().sort(), ['fileset', 'merge'])
  assert.ok(!kinds.includes('ownership'), 'ownership is run-wide and must never be task-scoped')

  const rows = exitRows(composeBrief(FULL))
  // Named where it can happen, and not where it cannot.
  assert.match(rows.get(cannotVerify), /ownership/)
  assert.ok(!rows.get(rejected).includes('ownership'),
    'the rejection row names a run-wide check, which would send a teammate to fix another\'s work')
  // And the two instructions a teammate must NOT follow are ruled out in words, because both
  // were reachable from the old table: cleaning a worktree it may not touch, and cherry-picking
  // a foreign commit onto its own branch, which then fails its own file set.
  assert.match(rows.get(cannotVerify), /Do NOT clean the main worktree/)
  assert.match(rows.get(cannotVerify), /cherry-pick/)
  // The row must NOT wave everything through: a `command` check earns this code too, and it
  // tests the merged tree. A teammate told "not your work" here returns done on a red suite.
  assert.match(rows.get(cannotVerify), /this project's test command/)
  assert.match(rows.get(cannotVerify), /That one you do fix/)
  // ...and equally must not sweep a check that NEVER RAN into that same "you do fix" bucket.
  // `complete` reports one under this exact marker, and this repository's own manifest declares
  // an `agent` review check, so it is the default outcome rather than an edge case.
  assert.match(rows.get(cannotVerify), /"could not run:"/)
  assert.match(rows.get(cannotVerify), /do not try to make it pass/i)
  // The distinction is load-bearing, so the row must say the two are different things: a check
  // that ran and failed is qualified as such, not left as a bare "any other check".
  assert.match(rows.get(cannotVerify), /a check that RAN and failed/)
  // Every quoted marker the row tells a teammate to look for must appear WHOLE on one line —
  // wrapped across two, the string it would search its own output for is not in the brief.
  for (const marker of ['"no gate manifest"', '"cannot verify completion"', `"no task ${TASK.id} in the plan"`]) {
    assert.ok(
      rows.get(cannotVerify).split('\n').some((line) => line.includes(marker)),
      `the marker ${marker} is split across lines and could never be matched`,
    )
  }
})

// The exit codes were cross-checked against cli.mjs from the start; the MARKERS were not, and a
// marker the brief tells a teammate to look for is worth exactly as much as a code — it is how
// the teammate routes itself to the right row. `could not run:` is emitted by `complete` as a
// literal, so the brief must quote the literal `complete` actually prints.
test('the brief quotes the could-not-run marker that scripts/cli.mjs actually prints', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  // The emitting template literal, read out of the source rather than restated here.
  const emitted = /`(could not run: )\$\{printable\(r\.name\)\}/.exec(cli)
  assert.ok(emitted, 'scripts/cli.mjs no longer emits a could-not-run line — this pin is stale')
  // Trailing space trimmed: it is the separator before the check name, not part of the phrase a
  // teammate would search its own output for. The phrase is what has to match.
  const marker = emitted[1].trimEnd()

  const rows = exitRows(composeBrief(FULL))
  const cannotVerify = cliExitCode(cli, 'COMPLETE_CANNOT_VERIFY')
  assert.ok(
    rows.get(cannotVerify).includes(`"${marker}"`),
    `the brief does not quote the marker complete prints (${JSON.stringify(marker)})`,
  )
  // And it belongs to that row alone: quoted under the rejection row it would tell a teammate to
  // fix a check that never ran.
  assert.ok(!rows.get(cliExitCode(cli, 'COMPLETE_REJECTED')).includes(marker))
})

// Same shape as the could-not-run pin above: the message this row tells a teammate to search
// for is read out of scripts/cli.mjs's own template literal, not restated by hand, so the two
// cannot silently drift apart. This is the message a --base collision with the run branch
// produces (see the comment above verifyStep in scripts/brief.mjs) — reproduced in
// docs/plans/2026-08-09-gaps-followups.md's Task 2 ("diff each task branch from its own fork
// point, not from the run anchor") topology, where task branches fork straight off the run
// branch and this brief's own --base then equals it.
test('the brief quotes the run-branch/base-branch collision marker scripts/cli.mjs actually prints, and calls it a dispatch error', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const emitted = /`(the run branch and the base branch are both )'\$\{runBranch\}'/.exec(cli)
  assert.ok(emitted, 'scripts/cli.mjs no longer emits this collision message — this pin is stale')
  const marker = emitted[1].trimEnd()

  const rows = exitRows(composeBrief(FULL))
  const cannotVerify = cliExitCode(cli, 'COMPLETE_CANNOT_VERIFY')
  assert.ok(
    rows.get(cannotVerify).includes(`"${marker}"`),
    `the brief does not quote the run-branch/base-branch collision marker (${JSON.stringify(marker)})`,
  )
  // Told as a dispatch error, not the teammate's own worktree to fix — the same distinction the
  // "ownership" bullet already draws for a different run-wide cause.
  assert.match(rows.get(cannotVerify), /dispatch error/)
  assert.match(rows.get(cannotVerify), /nothing in your worktree produced it/)
  assert.ok(!rows.get(cliExitCode(cli, 'COMPLETE_REJECTED')).includes(marker))

  // The row must hold whether or not THIS invocation carries --base at all: scripts/cli.mjs's
  // own `brief` command reads `flags.base === true ? '' : (flags.base ?? '')` with no
  // resolveBaseBranch fallback beside it — grep-able by that literal expression rather than by a
  // line number, since scripts/cli.mjs is under active edit elsewhere in this run — so
  // `cli.mjs brief` with no --base renders a complete line that omits the flag entirely, while
  // the collision this row describes is still reachable through complete's own derived default.
  //
  // A round-3 fix here ruled out one presupposing phrasing by excluding the literal substring
  // 'the --base value in this'. That pins a WORDING, not the row: rewording lines 208-212 to a
  // DIFFERENT presupposing form — "the --base flag shown in the command above names your own
  // run branch" — still passed, because it contains neither the excluded substring nor any word
  // the earlier assertions require absent, while being just as false in the no-flag rendering.
  // Verbatim-pinning the row closes the class instead of one phrasing, the same instrument this
  // file already uses for SCOPE_ENVIRONMENT_CLAIM_LINES and for the identical reason.
  //
  // Lines 208-212 are fully static — no interpolation of task.id, runId, planPath or baseBranch,
  // unlike the fallback clause pinned by line-anchor last round, which sits among lines that DO
  // interpolate those and so could not be pinned whole. Checked here, not assumed: read straight
  // off scripts/brief.mjs, there is no `+` concatenation or `${...}` anywhere in these five
  // lines. That is what makes a full verbatim pin possible rather than another anchor.
  //
  // The literal below is retyped by hand, not derived by calling anything in scripts/brief.mjs.
  // Deriving "expected" from the code under test is the tautology round 2 caught on this exact
  // task, and a verbatim pin is precisely where the temptation returns.
  const COLLISION_ROW_LINES = [
    '             "the run branch and the base branch are both" — the base this run resolved to',
    '                (an explicit --base above, or complete\'s own derived default when none is',
    '                shown) is the same as your own run branch. That is a dispatch error: the',
    '                collision existed before this brief was ever composed. Report it and',
    '                proceed; nothing in your worktree produced it.',
  ]
  const expectedCollisionRow = COLLISION_ROW_LINES.join('\n')
  const rowStartMarker = 'Nothing on your branch can change it, so do not try to make it pass.\n'
  const rowEndMarker = '\n             "no gate manifest"'

  // Checked on both a with-base and a no-base brief, because the row's own text is unconditional
  // prose that must read the same in either — the round-3 defect was reachable only in the
  // no-base rendering, where the with-base check alone would have stayed green.
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, baseBranch: '' })]) {
    const noBaseRows = exitRows(brief)
    const row = noBaseRows.get(cannotVerify)
    const startAt = row.indexOf(rowStartMarker)
    assert.notEqual(startAt, -1, 'the "could not run:" bullet that precedes the collision row was not found')
    const start = startAt + rowStartMarker.length
    const end = row.indexOf(rowEndMarker)
    assert.notEqual(end, -1, 'the "no gate manifest" bullet that follows the collision row was not found')
    assert.equal(
      row.slice(start, end),
      expectedCollisionRow,
      'the collision row no longer matches the expected text verbatim — a wording change, however phrased, must fail here',
    )
  }
})

// The specific regression, stated as itself: no row may describe a gate rejection as the code
// that the handler ALLOWS on.
test('no brief row calls a gate rejection the cannot-verify code', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const cannotVerify = cliExitCode(cli, 'COMPLETE_CANNOT_VERIFY')
  const rows = exitRows(composeBrief(FULL))
  assert.ok(!/REJECTED it/.test(rows.get(cannotVerify)),
    `the exit ${cannotVerify} row still describes a rejection`)
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    assert.ok(!/exit 4, output beginning "gate does not pass for phase"/.test(brief),
      'the superseded exit-4 rejection row is still rendered')
  }
})
