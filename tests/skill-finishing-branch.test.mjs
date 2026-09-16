import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertClaim, parseDoc, splitFrontmatter, statementsOf } from './md-contract.mjs'

const body = async () => readFile(new URL('../skills/finishing-a-development-branch/SKILL.md', import.meta.url), 'utf8')

// Structural model of the skill, used by the cleanup-section assertions below instead of a
// whole-body regex: a regex over the raw text is satisfied by tokens drawn from anywhere in the
// document, so a sentence that inverts a claim can sit right next to (or in place of) the
// original and the old assertions never noticed. `assertClaim` binds a claim to one statement,
// optionally to its very next statement (`then`), which an inserted or reworded sentence cannot
// satisfy by accident. See tests/md-contract.mjs for what this can and cannot detect.
//
// One asymmetry in that model has already cost this file a hole, so it is written down here
// rather than left to be rediscovered: `allow:` is permissive-only. It subtracts a statement
// from the `subject:` inventory and never asserts that the statement is present. Rewrite a
// pinned sentence and leave its entry behind, and the entry matches nothing, fails nothing,
// and silently re-admits the very sentence it was written to review — `claim:` and `then:`
// both go red when their sentence changes, and an `allow` entry never does. So whenever a
// sentence in this section is rewritten, its `allow` entry must be re-checked alongside them.
// Measured in this task, on this file: appending a previously deleted sentence about `--yes`
// back into the prose while its now-stale entry was still listed left this file at 14 pass /
// 0 fail and the full suite green; removing the stale entry turned that same sentence into a
// failure of the --yes inventory test below, reported as an unreviewed statement about the
// pinned subject, while the clean tree stayed at 14 pass / 0 fail. Every remaining entry was
// then matched against the parsed statements of the section it is scoped to: each matches
// exactly one, so none of them is dead today.
const doc = async () => {
  const { body: text } = splitFrontmatter(await body(), 'finishing-a-development-branch')
  return parseDoc(text, 'finishing-a-development-branch/SKILL.md')
}
const cleanup = async () => (await doc()).section(/^Worktree and branch cleanup$/)
const taxonomy = async () => (await doc()).section(/^Branch taxonomy$/)

// Mirrors tests/agents.test.mjs's helper of the same name: `subject:` is a vocabulary lock, and a
// sentence appended in a register the lexicon does not name still ships green; the statement
// COUNT of the bound block cannot be dodged by wording at all, because any appended sentence
// changes it regardless of what it says. Measured against this tree before relying on it: printed
// via `statementsOf` on each paragraph in the cleanup section (see the two applications below).
//
// Applied only where the bound block is a small, closed enumeration, not to the two cleanup-flag
// paragraphs those `then:` chains above sit inside. Both of those hold five statements spanning
// several sub-topics (the junction hazard, the dry-run gloss, the ancestry proof, the `-D`
// contrast, the never-touches-main-worktree carve-out), and the run-branch-name sentence inside
// the second one has already been rewritten three times across this and the prior task working
// the same hazard — recorded in `scripts/cli.mjs`'s own `WHAT REMAINS OPEN` list. A hard count on
// either paragraph would fail on the next legitimate revision of that still-active analysis
// exactly as readily as on a regression, so `subject:` alone stays the guard there.
function assertBlockStatementCount(hit, expected, message) {
  const count = statementsOf(hit.block.text).length
  assert.equal(
    count,
    expected,
    `${message}\n  expected exactly ${expected} statement(s) in the bound block, found ${count}: ` +
      JSON.stringify(statementsOf(hit.block.text)),
  )
}

test('requires a recorded gate PASS before presenting work as finished', async () => {
  const b = await body()
  assert.match(b, /status\.gates|recorded PASS/i)
})

test('distinguishes teammate branches from the run branch', async () => {
  const b = await body()
  assert.match(b, /teammate branch/i)
  assert.match(b, /run branch/i)
})

test('names tm-integrator as the sole writer of the run branch', async () => {
  assert.match(await body(), /tm-integrator/)
})

test('deletes a teammate branch only for a worktree it removes, once the run branch provably contains it — a whole-section deletion lexicon, not a lock on one sentence', async () => {
  const scope = await taxonomy()
  assertClaim(scope, {
    claim: /^Each teammate does its work on its own branch, inside its own worktree, and that branch is deleted by prune-run for each worktree it removes, once the run branch provably contains it\.$/,
    // Wide on purpose: `claim:` alone only guards the sentence it is bound to, so a second,
    // unreviewed sentence about deleting a teammate branch — by any verb form, or a hand-run
    // `git branch -D` — could sit right next to it. `subject:` makes every such sentence in this
    // section go through `allow`, the way T8's inventory lock does for its own section.
    subject: /branch -D|delet(e|es|ed|ing)|disposable/i,
  })
})

test('states the --yes flag is destructive before showing the command, with the Windows-junction companion adjacent, and the section carries exactly one code block', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^The --yes flag runs git worktree remove --force on every worktree it lists as prunable, and that discards uncommitted and untracked changes in it without asking\.$/,
    then: /^On Windows, it also follows a junction a worktree holds, so a worktree provisioned with a junction back into the repository — the kind a fresh worktree's own dependency install might use as a shortcut, such as a junction into the repository's real node_modules — has that target's contents deleted too, not just the worktree's own\.$/,
    // Anchored to the WHOLE code block, not a substring: `pattern.test(code)` alone is satisfied
    // by the pinned line sitting anywhere inside a bigger block, including one sandwiched between
    // an `rm -rf` line above it and a `git branch -D $(...)` line below it. `^...$` refuses both.
    introduces: /^node "<fleetmates root>\/scripts\/cli\.mjs" prune-run --run <runId> --plan <planPath> --root <project root> \[--yes\]$/,
    subject: /--yes|--force/i,
    allow: [
      /^Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above/,
      /^Without --yes the command removes nothing, and it prints the worktrees and branches it would act on if nothing changes before the --yes run/,
      /^Run it first without --yes to read the plan, then add --yes to remove what it lists:/,
    ],
  })
  // `introduces` only checks the block immediately after the claim's block — a SECOND code block
  // sitting anywhere else in the section, unattached to any claim (e.g. a hand-sweep block a few
  // lines below), would otherwise go unreviewed. A section meant to show exactly one command must
  // not be able to carry a second one.
  assert.equal(scope.code.length, 1, `${scope.label}: expected exactly one code block, found ${scope.code.length}`)
})

test('the Windows-junction limit leads into the dry-run sentence, which no longer overstates what the dry run shows, and into instructions the single shown command can actually carry out', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^On Windows, it also follows a junction a worktree holds, so a worktree provisioned with a junction back into the repository — the kind a fresh worktree's own dependency install might use as a shortcut, such as a junction into the repository's real node_modules — has that target's contents deleted too, not just the worktree's own\.$/,
    then: /^Without --yes the command removes nothing, and it prints the worktrees and branches it would act on if nothing changes before the --yes run — both runs recompute the gate from scratch, but not which of those branches would actually be deleted — that verdict is computed only inside the removal itself\.$/,
  })
})

test('routes worktree removal through the recomputed phase gate and branch deletion through the ancestry proof, immediately bounded by the refusal derive makes before a run branch is ever resolved', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^It removes a task's worktree only where that task's phase gate recomputes to PASS, and it deletes the worktree's branch only where git merge-base --is-ancestor proves the run branch already contains it\.$/,
    // The resolution above is what this sentence now rests on: scripts/git.mjs's
    // `classifyHeadRef` refuses three HEAD states outright — detached, pointing outside
    // `refs/heads/`, and a stripped name that is itself a ref path — before `derive` ever hands
    // anything downstream a name to resolve, so the ancestry proof always runs against the ref
    // `derive` took HEAD's name from, never a reconstructed one. Verified in this worktree: a
    // throwaway repository detached at HEAD reports `classifyHeadRef` as
    // `{ok:false,kind:'detached',...}` and `currentBranch()` as `null`; symref'ing HEAD at
    // `refs/heads/refs/heads/run-branch` (the plant this section used to describe) reports
    // `{ok:false,kind:'ref-path-name',...}`. Three tests in `tests/git.test.mjs` hold the same
    // refusals as fixtures — "classifyHeadRef reports a detached HEAD as on no branch, with
    // no name", "classifyHeadRef rejects a HEAD pointing outside refs/heads/ and yields no
    // name", and "classifyHeadRef refuses a branch whose name is itself a ref path" — and three
    // tests in `tests/cli.test.mjs` drive them through the `prune-run` command: "prune-run
    // refuses to act on a detached HEAD rather than deriving from an unresolvable name", "the
    // three-ref plant no longer redirects the run branch: prune-run resolves the real one",
    // and "the refs/heads/HEAD plant does not make a detached HEAD look like a run branch".
    // All six are named by test rather than by line, because `tests/cli.test.mjs`'s own header
    // rules line citations out: a sibling task editing either file shifts every number under
    // such a citation, so it is invalidated exactly by a merge — which is precisely when
    // nobody re-reads it. "No sibling shifts it this time" is not that property, which is why
    // the range that used to stand here was replaced even though it was still accurate today:
    // naming the three is also tighter than the range, which held nine tests in all.
    then: /^That proof is against the ref derive takes directly off git symbolic-ref --quiet HEAD, not off an abbreviated name, and derive refuses to produce a run branch at all when HEAD is detached, when HEAD points outside refs\/heads\/, or when the name that ref strips to is itself a ref path — so nothing a teammate can plant under refs\/heads\/ changes which ref this proof or the deletion it authorises runs against\.$/,
    // The third alternative names a phrase that appears NOWHERE in the document, and that is
    // deliberate: it is the wording e9891ff deleted as wrong, not the wording it wrote. A
    // sentence is only finished being removed once its return is pinned, and the lock that
    // pins it must keep naming the phrasing that was removed — the replacement phrasing
    // cannot, since a reinstated sentence does not use it. This inverts the `allow` rule in
    // the header above, so the two are easy to confuse: an `allow` pattern matching nothing
    // is dead and silently WIDENS what may be said, while a `subject:` alternative matching
    // nothing is load-bearing and NARROWS it. Do not prune this for being unmatched.
    // Measured in this task, on this tree: with only the two surviving commands listed, an
    // abbrev-ref pre-flight sentence appended to the paragraph this claim opens passed at
    // 14 pass / 0 fail with the whole suite green; with this alternative added the same
    // sentence fails this test as an unreviewed statement, and the clean tree stays at
    // 14 pass / 0 fail. The verbatim sentence e9891ff removed fails twice over, here and
    // in the --yes inventory above, because it also names the flag.
    subject: /merge-base --is-ancestor|symbolic-ref --quiet HEAD|rev-parse --abbrev-ref HEAD/i,
  })
})

test('the run-branch-name caveat leads into what a bare git branch -D actually does — refusing a checked-out branch, never proving ancestry', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^That proof is against the ref derive takes directly off git symbolic-ref --quiet HEAD, not off an abbreviated name, and derive refuses to produce a run branch at all when HEAD is detached, when HEAD points outside refs\/heads\/, or when the name that ref strips to is itself a ref path — so nothing a teammate can plant under refs\/heads\/ changes which ref this proof or the deletion it authorises runs against\.$/,
    then: /^That proof is not something a bare git branch -D makes on its own: -D deletes whatever branch it is given without asking whether the run branch contains it — it refuses only a branch a registered worktree still holds checked out, which is why prune-run removes the worktree first — and the plain -d measures "merged" against the branch's upstream or your current HEAD, never against the run branch\.$/,
    subject: /git branch -D|-d measures/i,
    allow: [/^Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above/],
  })
})

test('never touches the main worktree or another run\'s task worktree, but does reap a leaked merge-preview worktree from any run', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^It never touches the main worktree, and it never removes another run's task worktree, but it does force-remove a leaked merge-preview worktree — a scratch worktree under the system temp directory — regardless of which run's gate created it, because a killed gate cannot run its own cleanup\.$/,
    then: /^Every worktree it examines and declines to remove is printed with the reason; it examines worktrees, not bare branches, so a task branch whose worktree is already gone is not reported either way\.$/,
    subject: /main worktree|another run's task worktree|merge-preview worktree/i,
  })
})

test('names the phase gate and ancestry proof, not junction-following, as the reason to avoid a hand-run remove, and covers an rm -rf escape hatch too', async () => {
  const scope = await cleanup()
  const hit = assertClaim(scope, {
    claim: /^Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above — it only does what the flag itself says, on whatever you point it at\.$/,
    // `rm -rf`/`rm -fr` added: an escape-hatch paragraph recommending it instead of the two named
    // commands is exactly the kind of insertion `by hand` alone would miss, since it names
    // neither `git worktree remove` nor `git branch -D`.
    subject: /sweep by hand|by hand|rm -rf|rm -fr/i,
  })
  // This paragraph is the claim and nothing else — `statementsOf` on its own block returns one
  // entry today. `subject:` above already catches a second sentence naming the lexicon it locks;
  // this catches a second sentence appended in ANY register, including one that names neither
  // "hand" nor `rm -rf`/`rm -fr` at all.
  assertBlockStatementCount(hit, 1, 'the hand-sweep paragraph must hold exactly its one warning, nothing appended after it')
})

test('says .fleetmates is kept deliberately, and the very next statement distinguishes what resume and rebuild-state each do with it rather than listing or delisting either', async () => {
  const scope = await cleanup()
  const hit = assertClaim(scope, {
    claim: /^What this does not clean up: \.fleetmates\/<run-id>\/ stays on disk on purpose\.$/,
    // `resume` reads it to continue a run. `rebuild-state` reads it TWICE, for two different
    // reasons: `readState` refuses when the run's status file exists — that refusal is what the
    // directory-already-gone case exists to bypass — and then, inside `writePlan`, it reads
    // `.fleetmates/<runId>/plan.json` again and carries forward whatever `runBranch` was already
    // recorded there. Verified in this worktree: mutating `writePlan`'s `carried` to always be
    // `null` turns `tests/cli.test.mjs`'s "rebuild-state keeps the recorded run branch rather
    // than adopting the checkout" red — named, not numbered, for the reason given above —
    // along with exactly four other tests pinning the same carry-forward: "a base-valued
    // record is left alone rather than replaced by the current checkout", "a correct run
    // branch survives a gate whose --base names it", "a lifecycle command never overwrites a
    // run branch that is already recorded", and "re-running init-run from another branch
    // keeps the recorded run branch". Re-measured in this task: that mutation fails those
    // five and nothing else in the file. Deleting the directory before a `rebuild-state` run
    // from a different checkout has nothing to carry forward, so that run's own checkout is
    // what gets recorded — permanently, since fill-if-absent then protects it from every
    // later writer.
    then: /^Delete it yourself when you no longer want the record: resume reads it to continue a run, while rebuild-state reads it twice: once to refuse when it exists, since it exists for the case where the directory is already gone, and once to keep the run branch it recorded — delete the directory and a later rebuild-state run from any other checkout records that checkout as the run branch, permanently, and complete --enforcement-only can no longer verify completion for the rest of the run\.$/,
  })
  // Three closed facts about one narrow topic — what is not cleaned up, how `resume` and
  // `rebuild-state` each read it, and that it is gitignored — not prose meant to accumulate a
  // fourth. `then:` above already pins the second against insertion before or after it; this
  // pins the whole paragraph, so a fourth statement appended after "It is gitignored." (which
  // `then:`'s adjacency check cannot see, since it only binds the claim's immediate next
  // statement) fails too.
  assertBlockStatementCount(hit, 3, 'the .fleetmates paragraph must hold exactly its three statements, nothing appended after "It is gitignored."')
})

test('is original and carries no upstream attribution', async () => {
  assert.doesNotMatch(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})

test('handles an inline run with no recorded gates by running the test suite fresh', async () => {
  const b = await body()
  assert.match(b, /gates.*(?:absent|empty)|(?:absent|empty).*gates/i)
  assert.match(b, /full test suite/i)
})

test('handles the case where no run directory exists at all', async () => {
  assert.match(await body(), /no run directory/i)
})
