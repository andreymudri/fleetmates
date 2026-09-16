import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/cli.mjs'
import { collectReviewResults } from '../scripts/reviews.mjs'
import {
  assertClaim,
  assertCorpusInventory,
  claimSites,
  statementsOf,
  assertCode,
  assertNoStatement,
  assertStatement,
  parseDoc,
  splitFrontmatter,
} from './md-contract.mjs'

const dir = new URL('../skills/', import.meta.url)

// The prose assertions in this file run against the structural model in md-contract.mjs —
// sections, blocks, statements — instead of regexes over a whitespace-normalised whole document.
// Read that module's header before trusting a green run here: it states precisely which insertions
// it detects and which it cannot, and contradiction detection in general is not one of them.

export async function allSkills() {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export async function skill(name) {
  const text = await readFile(new URL(`${name}/SKILL.md`, dir), 'utf8')
  const { fields, body } = splitFrontmatter(text, name)
  return { fields, body, doc: parseDoc(body, `${name}/SKILL.md`) }
}

test('every skill directory contains a SKILL.md with valid frontmatter', async () => {
  const names = await allSkills()
  assert.ok(names.length >= 5, 'expected at least the five fleet skills')
  for (const name of names) {
    const { fields } = await skill(name)
    assert.equal(fields.name, name, `${name}: frontmatter name must match folder`)
    assert.match(fields.description, /^Use when/, `${name}: description must start with "Use when"`)
  }
})

test('no skill invokes the CLI by a relative path', async () => {
  for (const name of await allSkills()) {
    const { body } = await skill(name)
    // Every CLI call names `<fleetmates root>/scripts/cli.mjs`. `<fleetmates root>` is defined by
    // using-fleetmates as `$CLAUDE_PLUGIN_ROOT` when set and the skill's own directory otherwise,
    // so the older `$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs` literal stays accepted too. Strip both
    // rooted forms, then any surviving `cli.mjs` is a relative invocation.
    const stripped = body
      .replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?\/scripts\/cli\.mjs/g, 'OK')
      .replace(/<fleetmates root>\/scripts\/cli\.mjs/g, 'OK')
    assert.ok(
      !/cli\.mjs/.test(stripped),
      `${name}: invokes cli.mjs without the <fleetmates root>/scripts prefix`,
    )
  }
})

test('using-fleetmates defines <fleetmates root> in terms of $CLAUDE_PLUGIN_ROOT and the skill directory', async () => {
  const { body } = await skill('using-fleetmates')
  assert.match(body, /<fleetmates root>/, 'using-fleetmates must define the <fleetmates root> token')
  assert.match(body, /\$CLAUDE_PLUGIN_ROOT/, 'the definition must name $CLAUDE_PLUGIN_ROOT as the Claude Code case')
  assert.match(
    body,
    /dirname\(dirname\(/,
    'the definition must give the skill-directory fallback (dirname(dirname(<skill dir>)))',
  )
})

test('adapted skills credit the upstream project', async () => {
  const ADAPTED = ['brainstorming', 'executing-plans', 'receiving-code-review', 'systematic-debugging', 'test-driven-development', 'writing-skills']
  const present = await allSkills()
  for (const name of ADAPTED.filter((n) => present.includes(n))) {
    const { doc } = await skill(name)
    assertStatement(doc, /Adapted from the MIT-licensed superpowers plugin/, `${name}: missing attribution line`)
  }
})

test('parallel-execution documents all three model tiers and the --models flag', async () => {
  const { doc } = await skill('parallel-execution')
  assert.match(doc.text, /\bcheap\b/)
  assert.match(doc.text, /\bmid\b/)
  assert.match(doc.text, /\bcapable\b/)
  assert.match(doc.text, /--models/)
})

// A respawn on a fix round needs a brief, and the ORDINARY brief opens with
// `git checkout -B <branch> <base>` — which resets the task branch to the base and destroys the
// work the round was convened to repair. The flag that suppresses that reset is useless if
// nothing tells the orchestrator to pass it, so the skill has to name it where it tells the
// orchestrator to respawn.
test('parallel-execution tells a fix-round respawn to brief with --fix-round', async () => {
  const { doc } = await skill('parallel-execution')
  assert.match(doc.text, /--fix-round/, 'the skill never names the flag a fix-round respawn needs')
  assert.match(
    doc.text,
    /checkout -B[\s\S]{0,200}destroy|destroy[\s\S]{0,200}checkout -B/,
    'the skill names the flag without saying what passing the ordinary brief instead would do',
  )
})

test('phase-gate documents the fix decision and the cost-bound framing', async () => {
  const { doc } = await skill('phase-gate')
  const onFail = doc.section('On FAIL')
  assertStatement(onFail, /fix decision/, 'phase-gate must name the fix decision')
  assertStatement(
    onFail,
    /one of three decisions — none, retry, or escalate —/i,
    'phase-gate must document all three decisions in one statement',
  )
  assertClaim(onFail, {
    label: 'round budget',
    // One statement: the splitter does not break `... security bound. fixRounds lives in ...`
    // because the next word is lowercase once the backticks are normalised away, and
    // under-splitting is the safe direction. The pattern therefore spans both halves.
    claim: /^The round budget is a cost bound, not a security bound\. fixRounds lives in status\.json, which is written by the agents the gate enforces\b/i,
    then: /A teammate that rewrites its own count buys itself more retries — wasted tokens, not a false PASS/i,
    subject: /cost bound|security bound|tamper-evident/i,
    allow: [/Do not describe the loop as tamper-evident; only fileset and ownership carry that property/i],
  })
})

// `unableToVerify` and `unprobed` are the two `claims` results that are not findings. An
// orchestrator that never learns of them reads a bounded, or an unrun, review as a clean one —
// which is the same class of defect the lens exists to catch, one level up.
test('phase-gate documents the two claims results that are not findings', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertStatement(
    section,
    /collect-reviews acts on both/i,
    'phase-gate must say collect-reviews acts on both keys, since it now does',
  )
  assertStatement(
    section,
    /reads `?lens`?, `?stamp`?, `?findings`?, `?unableToVerify`? and `?unprobed`?, and ignores every other key/i,
    'phase-gate must say what collectReviewResults reads, in the verb that is true of it',
  )
  assertStatement(
    section,
    /`?stamp`? is consumed to reject a stale file and then dropped from the emitted result/i,
    'phase-gate must not let "reads" be misread as "keeps" for stamp',
  )
  assertStatement(
    section,
    /unableToVerify means the reviewer could not build the phase.s tree or get a green baseline/i,
    'phase-gate must say what unableToVerify means',
  )
  // The replacement for "collected today as a pass". The refusal is the whole point of the
  // change, so the skill has to name all three of its observable parts — refused like a missing
  // lens, nothing emitted, exit 4 naming the lens and its reason — or an orchestrator reading
  // only this section would still not know what to do when it happens.
  assertStatement(
    section,
    /refused exactly like a lens with no file at all/i,
    'phase-gate must say an unableToVerify lens is refused the way a missing one is',
  )
  assertStatement(
    section,
    /nothing is emitted, `?collect-reviews`? names the lens and its reason and exits 4/i,
    'phase-gate must say what the refusal looks like from the CLI, including the exit code',
  )
  // The empty-string carve-out is behaviour a reader would otherwise have to guess at, and
  // guessing it the other way would have them respawn a lens that did its work.
  assertStatement(
    section,
    /an empty string is not a report of failure and collects normally/i,
    'phase-gate must say that the key\'s mere presence is not what refuses a lens',
  )
  // The third route is behaviour an orchestrator meets only when something is already wrong, so
  // the section has to say the key is read as a string and nothing else — otherwise the response
  // to it is guessed at, and both guesses are wrong.
  assertStatement(
    section,
    /the key is read only as a reason string/i,
    'phase-gate must say which shape of unableToVerify is actually read',
  )
  assertStatement(
    section,
    /the fix is to the file rather than a respawn/i,
    'phase-gate must say a malformed key is not answered by respawning the review',
  )
  assertStatement(
    section,
    /unprobed lists claims it enumerated and did not reach/i,
    'phase-gate must say what unprobed lists',
  )
  assertStatement(
    section,
    /the count is surfaced in the emitted check.s `?output`?/i,
    'phase-gate must say where unprobed reaches the operator, now that it does',
  )
  // The two keys fail the same way, so the section must not document a shape rule for one and
  // leave the other looking permissive — that asymmetry is what let `unprobed: 32` be counted as
  // nothing while `unableToVerify: 32` was refused.
  assertStatement(
    section,
    /it is read only in its documented shape, a list/i,
    'phase-gate must say unprobed is read only as a list, as it says of unableToVerify',
  )
  assertStatement(
    section,
    /an empty list is a review that reached everything it enumerated, and collects silently/i,
    'phase-gate must say an empty unprobed is not the malformed case',
  )
})

// The five sentences that tell an operator where the results actually are. Each is DEFINED ONCE
// and anchored END TO END, and each has exactly ONE use below: the `assertStatement` that requires
// it. They are named constants for readability and for the anchoring, not to be shared between two
// call sites the way the `CLEANUP_*` regexes are — the second use two of these briefly had was an
// `allow` entry, and the document-scoped inventory further down does that job for all five now.
//
// Anchoring is what stops a sentence being REWRITTEN into its own negation: measured on this tree,
// with the bare `/head -n -1/i` token in place, rewriting the remedy to "a plain redirect of those
// bytes is enough, and do not bother with `head -n -1`" — the exact thing the pin's own message
// says it forbids — left the suite fully green, because the token survives the inversion.
//
// Anchoring is NOT what stops a sentence being CONTRADICTED by a new one beside it. Three such
// insertions were measured green here, and the inventory below is what closes them; see its own
// comment for the scope decision and what remains open.
const PG_WRITES_FILE = /^It also writes that same document to \.fleetmates\/<runId>\/reviews\/results-<phase>\.json and prints that path last, so the gate --results <path> that follows names a file that exists — run without a redirect and without this, the review check stays pending forever while the gate reports FAIL with an empty failed list, naming nothing to fix\.$/i
const PG_DEAD_REDIRECT = /^Pass the written path, not a capture of stdout: a > results\.json redirect no longer round-trips, because the trailing path line is inside the captured bytes and gate --results on that capture exits 2 on --results must be a readable JSON file shaped \{ "results": \[\.\.\.\] \}, while the file the same command wrote exits 0 with verdict PASS — both measured on this tree\.$/i
const PG_RESIDUAL_CLASSES = /^Two classes of refusal sit above it and leave the earlier round's file where it was\.$/i
const PG_RESULTS_PATH_RULE = /^After any refusal, hand gate --results nothing at all: only a path printed on a results written to … line is this command's answer, and no refusal prints one — least of all the clear failure above, which names that very path while refusing to stand behind what is at it\.$/i
const PG_WRITE_FAILURE = /^A third condition exits 4 and does print something usable: when the collection succeeded and only the write failed, the complete results go to stdout above cannot write the results file at …, so keep those bytes rather than re-running the reviews — but drop that last line before passing them on, because a plain redirect captures it and gate --results then exits 2 for exactly the reason above; head -n -1 is enough, and with it the gate exits 0 with verdict PASS, measured on this tree\.$/i

// `collect-reviews` now writes its results file and refuses an omitted `--phase` on a multi-phase
// plan. Both are BREAKING changes to what this section used to tell an operator to do — the
// capture-and-pass workflow it described no longer reaches a verdict — so the skill has to say so
// or it teaches a sequence the CLI answers with an exit code.
test('phase-gate documents the results file collect-reviews writes and the redirect that no longer round-trips', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')

  // A bracketed flag reads as optional, and for these two commands the omission is refused rather
  // than defaulted. Measured on a scratch run whose plan carries two integer phases:
  // `review-dispatch --run r1 --root <root>` exits 2 naming both, where `--phase 1` exits 0.
  //
  // Read off PARSED CODE BLOCKS with their continuations joined, never off raw body lines. This
  // whole file exists because assertions measured in characters of raw markdown break on
  // meaning-preserving edits (see tests/md-contract.mjs) — and an earlier version of this loop had
  // exactly that defect: splitting an invocation across a trailing backslash would have left the flag on
  // a continuation line, failed `must show --phase <name>`, and asserted the opposite of what the
  // document said. Joining continuations first makes the reflow invisible and leaves the real
  // guard intact.
  const documented = new Set()
  for (const block of section.code) {
    const joined = block.code.replace(/\\\s*\r?\n\s*/g, ' ')
    for (const line of joined.split(/\r?\n/)) {
      const hit = /cli\.mjs["']?\s+(review-dispatch|collect-reviews)\b/.exec(line)
      if (!hit) continue
      documented.add(hit[1])
      assert.ok(
        !line.includes('[--phase'),
        `phase-gate shows --phase as optional on a command whose omission the CLI refuses: ${line.trim()}`,
      )
      assert.ok(
        line.includes('--phase <name>'),
        `phase-gate must show --phase <name> on this invocation: ${line.trim()}`,
      )
    }
  }
  // WHICH commands, not HOW MANY invocations, because the message says "both commands" and a
  // count cannot check that. Measured on this tree, both directions green under a count: replacing
  // the `collect-reviews` invocation with a second `review-dispatch`, and replacing the
  // `review-dispatch` one with a second `collect-reviews`. Each keeps the tally at two while the
  // document stops naming a command it must name, and nothing else in the suite requires
  // phase-gate to document `review-dispatch` at all. A count also cannot say whether a THIRD
  // correct invocation is a defect; a set has no opinion about it, which is the right one.
  for (const name of ['review-dispatch', 'collect-reviews']) {
    assert.ok(
      documented.has(name),
      `precondition: phase-gate must document the ${name} invocation, and names only `
        + `${[...documented].join(', ') || 'none'}`,
    )
  }

  assertStatement(
    section,
    /--phase is not optional on a plan with more than one phase/i,
    'phase-gate must say the flag is required rather than leaving the reader to infer it from the invocation',
  )
  assertStatement(
    section,
    /it names the manifest key default, which scopes the review to every task branch in the run/i,
    'phase-gate must say what the omitted flag actually widens to, not merely that it is refused',
  )
  assertStatement(
    section,
    /the CLI refuses that with exit 2 rather than reviewing it/i,
    'phase-gate must name the exit code, since an orchestrator branches on it',
  )
  // The guard used to count INTEGER phases only, and this pinned that bound beside it. The bound
  // is gone, so what is pinned now is that the section says so: a reader who remembers the old
  // paragraph otherwise has nothing telling them a `"2"` beside a `1` is refused too.
  assertStatement(
    section,
    /the guard counts every distinct phase value, integer or not/i,
    'phase-gate must say a non-integer phase counts toward the ambiguity refusal',
  )

  assertStatement(
    section,
    PG_WRITES_FILE,
    'phase-gate must name the file collect-reviews writes, or the gate --results below names a path nobody created',
  )
  assertStatement(
    section,
    PG_DEAD_REDIRECT,
    'phase-gate must retract the capture-and-pass workflow it used to invite: the captured bytes now '
      + 'carry the trailing path line, and gate --results on them exits 2',
  )
  assertStatement(
    section,
    /the file's existence is itself the claim/i,
    'phase-gate must state the fail-closed property — a results file exists only where the round that '
      + 'wrote it succeeded — since that is what stops a stale pass being read back',
  )
  // PINNED AGAINST RETRACTION, not merely required. This sentence scopes itself to two named
  // conditions with `while … or when …`; the write-failure path is a third, and it was twice
  // reported as making this sentence false. It does not. The correction is the sentence below it,
  // and an edit that rewrites this one instead is the defect this anchor catches.
  assertStatement(
    section,
    /^It exits 4 and prints nothing usable while any lens has no file, or when a file exists and does not parse — respawn those lenses instead\.$/i,
    'the two conditions this sentence names are still true, so it must be added to rather than rewritten',
  )
  // The clear is upstream of every refusal that JUDGES the round, and downstream of two that do
  // not. Both leave the earlier round's file on disk, and both were reproduced on this tree: the
  // file and its reviews directory owned by another uid under ordinary 755/644 modes, and the
  // reviews directory replaced by a symlink. In each the file survived byte-identical still saying
  // `"status": "pass"`, and `gate --results` on it returned verdict PASS at exit 0. Without this
  // sentence the section promises a fail-closed property the command does not deliver in either.
  assertStatement(
    section,
    PG_RESIDUAL_CLASSES,
    'phase-gate must bound the fail-closed claim, since a surviving results file is read back as this round\'s verdict',
  )
  // SCOPED TO THE SUCCESS LINE, and the narrower wording is the whole of it. "a path this run did
  // not print" was the earlier form and it forbids nothing here, because the clear-failure refusal
  // PRINTS the results path — it is in the message. Measured on this tree: round 1 collects clean
  // and writes its document; the findings file is replaced with one carrying a blocking high; the
  // clear is made to fail; round 2 exits 4 naming that path; and `gate --results` on exactly the
  // path that refusal printed exits 0 with verdict PASS over round 1's document, while the round
  // that was refused held a blocking high. The two residual shapes differ exactly here: the
  // symlink refusal names no results file at all, so its survivor is reachable only by a path
  // carried over from an earlier run, which either wording forbids.
  assertStatement(
    section,
    PG_RESULTS_PATH_RULE,
    'phase-gate must scope the operative rule to the success line: a refusal prints the results path too, '
      + 'and handing the gate that printed path returns PASS over the superseded document',
  )
  assertStatement(
    section,
    PG_WRITE_FAILURE,
    'phase-gate must name the write-failure path, where the complete results are on stdout and re-running the reviews would waste them',
  )
})

// SCOPE: THE WHOLE phase-gate DOCUMENT, and the choice was measured rather than argued. Three
// contradictions were planted, each leaving the full suite green under the section-scoped subject
// inventory this replaces:
//
//   1. after `SKILL.md:106`, inside the locked section — "In practice the file at that path is the
//      same document either way, so passing it back after a refusal is fine." A section-scoped
//      inventory reaches this one, but only if the lexicon names something in it, and the earlier
//      lexicon named nothing: no `redirect`, no `capture`, no `--results`.
//   2. inside the section — "In practice, piping stdout into results.json with `>` and handing the
//      gate that file works fine, so use whichever is convenient." Missed for the same reason:
//      `stdout` and `pipe` were not in the lexicon.
//   3. under `## On FAIL`, ONE HEADING AWAY — "When collect-reviews exits 4 saying it could not
//      clear the previous results file, it still names that path: pass that path to gate --results
//      to get the phase verdict without re-running the reviews." No section-scoped lock can ever
//      reach this, whatever its lexicon.
//
// Each walks the operator into the bypass measured at the results-path pin above: the clear-failure
// refusal prints that path, and handing it to `gate --results` exits 0 with verdict PASS over the
// previous round's document while this round held a blocking high.
//
// THE DOCUMENT IS THE NARROWEST SCOPE THAT CLOSES ALL THREE, and at this lexicon it is free:
// measured, the lexicon matches the same TEN statements whether scoped to `Finish the pending
// checks` or to the whole document, so widening the scope locks not one additional sentence today
// while making (3) impossible. `\b(that|this) path\b` is deliberately narrower than `\bpaths?\b`,
// which reaches the same three escapes but drags in two unrelated statements — the `preview.link`
// entry rule and the merge-conflict sentence — that have nothing to do with where the results are.
//
// NOT WIDER THAN ONE DOCUMENT. The rule from the hand-sweep lock still holds: widening to other
// skills would pin prose nobody has reviewed for this purpose. Within this document the argument is
// different, because every sentence here is about this command's own output.
//
// WHAT STAYS OPEN, and it is the same pair every lexicon lock in this file leaves: a contradiction
// written in vocabulary none of these alternatives names is invisible, and so is one written as a
// CODE BLOCK, because `claimSites` reads statements and headings and never code. Neither is closed
// by scope, and neither is closed here.
const PG_RESULTS_PATH_LEXICON =
  /--results|results file|results\.json|results-<phase>|results written to|redirect|captur(e|es|ing|ed)|head -n -1|round-trip|stdout|pip(e|es|ing|ed)|\b(that|this) path\b/i

const PG_RESULTS_PATH_CORPUS = [
  "phase-gate :: To rebuild the results file from those drops rather than by hand:",
  "phase-gate :: It prints a --results file with source: \"file\", applying the manifest's own blockOn.",
  "phase-gate :: It also writes that same document to .fleetmates/<runId>/reviews/results-<phase>.json and prints that path last, so the gate --results <path> that follows names a file that exists — run without a redirect and without this, the review check stays pending forever while the gate reports FAIL with an empty failed list, naming nothing to fix.",
  "phase-gate :: Pass the written path, not a capture of stdout: a > results.json redirect no longer round-trips, because the trailing path line is inside the captured bytes and gate --results on that capture exits 2 on --results must be a readable JSON file shaped { \"results\": [...] }, while the file the same command wrote exits 0 with verdict PASS — both measured on this tree.",
  "phase-gate :: The file's existence is itself the claim: the previous results-<phase>.json is removed at the start of the command body, before the manifest is read and before any findings file is opened, so every refusal that judges this round's work is downstream of the clear and leaves no results file behind — measured, by making a second round refuse on a stale stamp and watching the first round's file go with it.",
  "phase-gate :: And the clear itself can fail: a previous file that can be neither unlinked nor emptied exits 4 with could not clear the previous results file at …, and a reviews directory that is a symlink exits 4 with … must be a real directory before the clear is even attempted; either way the earlier round's file is still on disk saying what that round said.",
  "phase-gate :: After any refusal, hand gate --results nothing at all: only a path printed on a results written to … line is this command's answer, and no refusal prints one — least of all the clear failure above, which names that very path while refusing to stand behind what is at it.",
  "phase-gate :: Scoping to the success line is what closes a bypass, and the bypass was measured too: a round-2 collection refused at the clear over findings carrying a blocking high, and gate --results on the path that refusal itself printed exited 0 with verdict PASS over round 1's document.",
  "phase-gate :: A third condition exits 4 and does print something usable: when the collection succeeded and only the write failed, the complete results go to stdout above cannot write the results file at …, so keep those bytes rather than re-running the reviews — but drop that last line before passing them on, because a plain redirect captures it and gate --results then exits 2 for exactly the reason above; head -n -1 is enough, and with it the gate exits 0 with verdict PASS, measured on this tree.",
  "phase-gate :: Where a line quotes a value an agent wrote — a lens, a stamp or a reason out of a findings file; a check name, kind or preview.link entry out of the gate manifest, whose contents this CLI validates for shape and not for content; the bytes a JSON parse error quotes back out of a --results file or the verdict file fix is handed below — the value is printed with its control bytes and line separators replaced by a visible <0x1B>-style token.",
]

test('every sentence in phase-gate about where the results file is, in any section, is one a human locked', async () => {
  const { doc } = await skill('phase-gate')
  assertCorpusInventory(
    [{ label: 'phase-gate', doc }],
    PG_RESULTS_PATH_LEXICON,
    PG_RESULTS_PATH_CORPUS,
    'a refusal prints the results path too, so prose telling an operator to reuse it walks them into '
      + 'a measured PASS over a superseded document — and no section lock spans this document',
  )
})

// The statements above are claims about code, so they are pinned against the code rather than
// only against themselves. If `collectReviewResults` ever stops refusing an `unableToVerify`
// lens, this fails and the skill sentences saying it does have to be rewritten — which is the
// direction of drift that produced this finding in the first place.
test('collect-reviews really does refuse an unableToVerify claims review rather than passing it', async () => {
  // The stamp has to EXIST for the refusal to be an assertion about the key rather than about
  // staleness. Without it the file would be rejected before `unableToVerify` was ever consulted,
  // and the test would pass whatever the code did with that key — which is this project's
  // signature defect committed one level up, inside the test written to close an instance of it.
  // `expected` matches, so the file is current and reaches the point where the key decides.
  const stamp = { phase: '1', lens: 'claims', branches: ['fleetmates/r1/T1@abc123'] }
  const out = collectReviewResults({
    lenses: ['claims'],
    expected: { phase: '1', branches: ['fleetmates/r1/T1@abc123'] },
    files: [{ lens: 'claims', stamp, findings: [], unableToVerify: 'the baseline suite was red', unprobed: ['a.mjs:1'] }],
  })
  assert.deepEqual(out.stale, [], 'the fixture must not be rejected as stale, or it proves nothing')
  assert.deepEqual(out.results, [], 'a lens that verified nothing must emit no result at all')
  assert.deepEqual(out.unverified, [{ lens: 'claims', reason: 'the baseline suite was red' }])
  // Unaccounted for in the same sense a lens with no file is, which is what the skill says.
  assert.deepEqual(out.missing, ['claims'])
})

// The other half of the same contract, and the reason the fixture above proves anything: with the
// one key removed, the identical file collects. Without this, "refused because of
// `unableToVerify`" would be indistinguishable from "refused for some unrelated reason", and the
// three key-absence assertions below would have nowhere left to live once the result went away.
test('the same claims file without unableToVerify collects, and keeps none of the three read keys', async () => {
  const stamp = { phase: '1', lens: 'claims', branches: ['fleetmates/r1/T1@abc123'] }
  const out = collectReviewResults({
    lenses: ['claims'],
    expected: { phase: '1', branches: ['fleetmates/r1/T1@abc123'] },
    files: [{ lens: 'claims', stamp, findings: [], unprobed: ['a.mjs:1'] }],
  })
  assert.deepEqual(out.stale, [], 'the fixture must not be rejected as stale, or it proves nothing')
  assert.deepEqual(out.unverified, [])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].status, 'pass')
  // Read, and then not kept: neither key survives into the emitted result as a key, so nothing
  // downstream of the CLI can recover the list. What survives of `unprobed` is a count in
  // `output`, which is what the skill says and is asserted here rather than merely described.
  assert.equal('unableToVerify' in out.results[0], false)
  assert.equal('unprobed' in out.results[0], false)
  assert.match(out.results[0].output, /1 enumerated claim\(s\) NOT reached/)
  // `stamp` is read — `reviewStale` consumes it — and then dropped from the result just like the
  // two keys above. The skill said "keeps lens, stamp and findings", which overstated by one key
  // in the very sentence written to correct an overstatement. This is what makes the corrected
  // wording checkable rather than merely more careful.
  assert.equal('stamp' in out.results[0], false)
})

test('phase-gate says plainly what a none decision means and does not mean', async () => {
  const { doc } = await skill('phase-gate')
  const onFail = doc.section('On FAIL')
  // `none` and its disclaimer must be adjacent statements of the same paragraph, and every other
  // sentence in the section that mentions `none` has to be one of the two listed below. A new
  // sentence about `none` fails whatever it says — no vocabulary of negations is consulted.
  assertClaim(onFail, {
    label: 'the none decision',
    // Both `claim:` and `then:` are anchored end-to-end for the same reason as the `allow`
    // entries below: `assertClaim`'s subject screen exempts BOTH the claim statement and its
    // `then` consequence from the inventory check (it would otherwise flag itself), so an
    // unanchored pattern on either one is the one place a clause appended to that exact sentence
    // — e.g. turning "it is never permission to integrate" into "... unless the gate already ran
    // once" — goes unscreened everywhere else in this test.
    claim: /^On none, the decision engine found no failing check in the verdict you handed it\.$/i,
    then: /^This does not mean "the failure needs no fix" and it is never permission to integrate\.$/i,
    subject: /\bnone\b/i,
    // Every entry below is anchored end-to-end (^...$), not just at the front or not at all.
    // An unanchored — or front-only-anchored — pattern waives any statement that merely CONTAINS
    // or STARTS WITH the approved text, so a mutated tail appended to an otherwise-approved
    // sentence (e.g. "... never on `none` unless the gate already ran once, in which case none
    // is enough to integrate on.") would still match and sail through, admitting the exact
    // inversion this lock exists to catch. Anchoring forces the whole statement to equal what
    // was reviewed.
    allow: [
      /^Hand it the run, the failing phase, the run root, and the verdict JSON you just produced; it prints one of three decisions — none, retry, or escalate — and exits 0 for all three, so read the decision field rather than the exit status\.$/i,
      /^Feeding that record in today degenerates harmlessly, because the persisted object carries no results key and the decision comes back none; that is incidental, not guaranteed\.$/i,
      /^You reached this section because the gate failed, so a none decision means the verdict you passed is not the one that failed — a stale file, the wrong phase, the wrong run root, or a verdict written before the last check completed\.$/i,
      /^Integrate only on a freshly recomputed PASS, never on none\.$/i,
      // Reviewed: this documents the `fix` exit-code contract (Exit 0 covers all three
      // decisions), not the semantics of a `none` decision itself — unrelated to the claim above.
      /^Exit 0 covers none, retry, and escalate alike, so the exit status never tells them apart — only the decision field does\.$/i,
    ],
  })
  assertStatement(
    onFail,
    /Re-derive the verdict by running the gate again from scratch and ask again/i,
    '`none` must say to re-derive the verdict',
  )
  assertStatement(
    onFail,
    /Integrate only on a freshly recomputed PASS, never on none/i,
    '`none` is never permission to integrate',
  )
})

// A subcommand exists only if the CLI dispatches on it. Matching any quoted token in cli.mjs
// is too loose: `'status'` appears there several times as a state-file key, so a doc naming
// `cli.mjs status` would pass while describing a subcommand the CLI never routes to.
function dispatchedSubcommands(cli) {
  const subs = new Set()
  const usage = /usage:\s*cli\.mjs\s*<([^>]+)>/.exec(cli)
  if (usage) for (const sub of usage[1].split('|')) subs.add(sub.trim())
  for (const [, sub] of cli.matchAll(/command\s*===\s*'([a-z-]+)'/g)) subs.add(sub)
  return subs
}

test('the subcommand check reads dispatch sites, not every quoted token', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const subs = dispatchedSubcommands(cli)
  assert.ok(subs.has('gate'), 'gate is dispatched and must be recognised')
  assert.ok(!subs.has('fix-decision'), 'an unimplemented subcommand must not be recognised')
  assert.ok(cli.includes("'status'"), 'precondition: status appears quoted in cli.mjs')
  assert.ok(!subs.has('status'), 'status is a state-file key, not a dispatched subcommand')
})

test('phase-gate names no cli subcommand that scripts/cli.mjs does not dispatch', async () => {
  const { body } = await skill('phase-gate')
  const subs = dispatchedSubcommands(await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8'))
  for (const [, sub] of body.matchAll(/cli\.mjs["']?\s+([a-z-]+)/g)) {
    assert.ok(subs.has(sub), `phase-gate documents undispatched subcommand ${sub}`)
  }
})

test('phase-gate requires the fix decision to use this pass’s verdict, never the on-disk record', async () => {
  const { doc } = await skill('phase-gate')
  // One statement carries the whole rule: the source of the verdict, the prohibition, and the
  // path it forbids. Three independent regexes over the section could each match while the text
  // between them said the opposite.
  assertClaim(doc.section('On FAIL'), {
    label: 'verdict provenance',
    claim: /The verdict you hand it must be the JSON this gate printed in this same pass, and must never be read back from \.fleetmates\//i,
    then: /The only verdict persisted on disk lives in status\.gates\[<phase>\]/i,
    subject: /status\.gates/i,
  })
})

test('phase-gate documents the real fix invocation and its exit-code contract', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('On FAIL')
  assertCode(section, /fix --run <runId> --phase <n> --verdict <path>/, 'phase-gate must show the fix invocation')
  assertClaim(section, {
    label: 'fix exit codes',
    // Anchored end-to-end, both patterns: the subject screen exempts the claim statement AND its
    // `then` consequence from the inventory check, so leaving either open at the end lets a
    // clause appended to that exact sentence pass unscreened, the same hole the `allow` entry
    // below was fixed for.
    claim: /^--verdict names a file holding that same JSON, and --phase must match its own phase field — a mismatch exits 2 rather than adjudicating the wrong phase's findings, and so does a malformed fleetmates\.gate\.json\.$/i,
    then: /^Exit 1 means the run has no plan at all or the verdict file could not be read: an argument error, not a decision\.$/i,
    subject: /\bexit 0\b|\bexit 1\b|\bexit 2\b/i,
    allow: [
      /^Exit 0 covers none, retry, and escalate alike, so the exit status never tells them apart — only the decision field does\.$/i,
    ],
  })
})

// The skill's exit-1 sentence names two distinct causes ("no plan at all" and "the verdict file
// could not be read"); the other two documented codes (0 and 2) are pinned by `decideFix`'s own
// unit tests and by the derived-context / gateConfig plumbing elsewhere, but nothing previously
// ran `fix` through the CLI itself to pin exit 1. Invoking `runCli` directly, the same pattern
// `tests/cli.test.mjs` uses, so a rename of either `return 1` in scripts/cli.mjs's `fix` handler
// breaks this test rather than only the prose.
test('the CLI actually exits 1 for both causes phase-gate documents under exit 1 for fix', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-skill-fix-'))
  const io = { out: () => {}, err: () => {} }
  try {
    // No `init-run` has happened for this run id at all: no plan exists.
    const noPlanCode = await runCli(
      ['fix', '--run', 'ghost-run', '--phase', '1', '--verdict', path.join(root, 'verdict.json'), '--root', root],
      io,
    )
    assert.equal(noPlanCode, 1, 'fix must exit 1 when the run has no plan')

    // A run WITH a plan, but a --verdict path that cannot be read.
    const planPath = path.join(root, 'plan.md')
    await writeFile(planPath, '### Task 1: A\n\n**Files:**\n- Create: `a.mjs`\n', 'utf8')
    assert.equal(await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io), 0)
    const badVerdictCode = await runCli(
      ['fix', '--run', 'r1', '--phase', '1', '--verdict', path.join(root, 'missing-verdict.json'), '--root', root],
      io,
    )
    assert.equal(badVerdictCode, 1, 'fix must exit 1 when the verdict file cannot be read')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tm-implementer forbids weakening a test to satisfy a fix-round finding', async () => {
  const text = await readFile(new URL('../agents/tm-implementer.md', import.meta.url), 'utf8')
  const { body } = splitFrontmatter(text, 'tm-implementer.md')
  assertStatement(
    parseDoc(body, 'tm-implementer.md'),
    /do not weaken or delete a test/i,
    'tm-implementer must forbid weakening a test',
  )
})

test('phase-gate documents --results flag and rejects computed checks', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertCode(section, /--results/, 'phase-gate must document the --results flag on the gate command')
  // One statement, not three loose matches: `--results`, `command.*fileset.*ownership` and
  // `entry is rejected` all still match text that inverts the rule ("only an agent or mcp entry
  // is rejected"), because nothing ties their sense together. The sentence boundary does.
  assertClaim(section, {
    label: 'supplied results',
    claim: /^Only agent and mcp checks may be supplied; a command, fileset, or ownership entry is rejected\b/i,
    then: /The verdict is recomputed from the merged set, so a recorded PASS is always CLI-computed/i,
    subject: /may be supplied|entry is rejected/i,
  })
})

// Naming a subcommand the CLI dispatches is not enough: a flag can be renamed (e.g.
// `flags.results` -> `flags.supplied`) without touching the subcommand list, and the skill's
// invocation would then be silently wrong — the CLI would parse the renamed flag as a boolean
// and swallow the next token as a positional. Bind the flags the skill documents for `gate` to
// the flags scripts/cli.mjs actually declares for `gate` in its own USAGE string.
function gateUsageFlags(cli) {
  const usage = /const USAGE = `([\s\S]*?)`/.exec(cli)
  assert.ok(usage, 'cli.mjs must define a USAGE string')
  const gateLine = usage[1].split(/\r?\n/).find((l) => l.trim().startsWith('gate '))
  assert.ok(gateLine, 'cli.mjs USAGE must document the gate subcommand')
  return new Set([...gateLine.matchAll(/--[a-z-]+/g)].map((m) => m[0]))
}

test('phase-gate names no cli.mjs flag for gate that scripts/cli.mjs does not declare', async () => {
  const { body } = await skill('phase-gate')
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const acceptedFlags = gateUsageFlags(cli)

  let checked = 0
  for (const line of body.split(/\r?\n/)) {
    if (!/cli\.mjs["']?\s+gate\b/.test(line)) continue
    for (const [flag] of line.matchAll(/--[a-z-]+/g)) {
      checked++
      assert.ok(acceptedFlags.has(flag), `phase-gate documents ${flag} for gate, which scripts/cli.mjs USAGE does not declare`)
    }
  }
  assert.ok(checked > 0, 'precondition: phase-gate must document at least one cli.mjs gate flag')
})

test('phase-gate states that conflicts are escalated rather than retried', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section(/merge check does/)
  assertStatement(
    section,
    /A conflict fails the merge check and names both branches and the conflicting paths/i,
    'phase-gate must document the merge check on conflicts',
  )
  assertClaim(section, {
    label: 'conflict handling',
    claim: /Treat a conflict like a process violation: escalate it, do not retry/i,
    then: /No single teammate can fix a conflict between two file sets, so redispatching one owner cannot resolve it/i,
    subject: /escalate it|do not retry|redispatching/i,
  })
})

test('phase-gate documents preview.link and states links are shared, not copied', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section(/merge check does/)
  assertStatement(section, /preview\.link is not consulted/, 'phase-gate must mention preview.link')
  assertCode(section, /"preview":\s*\{\s*"link"/, 'phase-gate must show the preview.link config shape')
  // The subject lock replaces `doesNotMatch(/links are copie/i)`: every sentence in this section
  // about copying has to be listed, so a claim that links are copies fails however it is phrased.
  assertClaim(section, {
    label: 'link semantics',
    claim: /^Links are shared, not copies\b/i,
    then: /A check that writes into node_modules writes to the real one, because it is the same directory/i,
    subject: /\bcop(y|ies|ied|ying)\b/i,
    allow: [/That is the cost of linking; copying a real dependency tree is minutes per gate run/i],
  })
})

test('phase-gate states that a failed link fails the merge check', async () => {
  const { doc } = await skill('phase-gate')
  assertClaim(doc.section(/merge check does/), {
    label: 'link failure routing',
    claim: /A link that cannot be made is reported as a merge failure rather than left to surface as a command-check failure/i,
    subject: /is reported as a (merge|command-check) failure/i,
  })
})

// The earlier version of this rule said to prune the moment a teammate returned. `phase-gate`
// resumes that same teammate on a `retry` decision, and a resumed agent whose worktree is gone
// fails to start at all — so following both skills in order foreclosed the recovery path the
// gate depends on. The rule now holds the worktree until the phase passes, and names the one
// case that still needs an early removal: handing the task to a fresh implementer.
// Unnamed dispatch is the first-line remedy for a reviewer that idles without emitting; the
// file drop covers a returning dispatch that dies anyway. Both halves have to be stated, and
// the missing-result case must never be recorded as an empty findings array — "no result" and
// "no findings" are different facts and only one of them is a pass.
test('phase-gate gives each reviewer a findings path and reads it before respawning', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertStatement(
    section,
    /name a findings path per lens/i,
    'each reviewer dispatch must carry the path it writes to',
  )
  assertStatement(
    section,
    /read that file before respawning/i,
    'an idle reviewer must be recovered from its file, not paid for twice',
  )
  assertStatement(
    section,
    /a missing result is never an empty findings array/i,
    'phase-gate must forbid scoring a lost review as a clean pass',
  )
})

test('parallel-execution keeps a returned teammate’s worktree until its phase passes the gate', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertClaim(section, {
    label: 'worktree pruning',
    claim: /^Prune after the phase passes its gate, not when a teammate returns:.*a resumed teammate whose worktree is gone cannot start/i,
    then: /Once the phase has a recorded PASS, run prune-run to remove the worktree, not git worktree remove by hand/i,
    subject: /\bprun(e|es|ed|ing)\b/i,
    allow: [
      // Reviewed: the preview exception folded into the same sentence rather than left to
      // contradict it — a leaked preview is the one worktree this "only this run" guarantee does
      // not bind, and section 5 above states the same fact.
      /^Only prune worktrees belonging to this run — a leaked preview is swept regardless of which run left it, as above\.$/i,
      // Reviewed: the fresh-implementer exception. `prune-run` only removes a worktree once its
      // phase already recomputes to PASS, and a mid-phase stall has none yet — so this one case
      // still needs a hand removal, named and justified in the same breath rather than left to
      // contradict the rule above it. `--force` is named and authorised for this one case: a
      // mid-stall worktree is exactly the one most likely to hold modified or untracked files a
      // bare remove refuses over, and discarding that work is the deliberate point.
      /^The one exception is a task going to a fresh implementer instead of a resume, because resuming stalled: prune that task's worktree first, since prune-run only removes a worktree whose phase already recomputes to PASS and a mid-phase stall has none yet to rest that removal on — do it by hand with git worktree remove --force <path>, then git worktree prune; --force is required and authorised here, because a mid-stall worktree is exactly the one most likely to hold modified or untracked files a bare remove refuses over, and discarding that work is the deliberate point of abandoning it for a fresh implementer — that authorisation covers the teammate's unfinished work only, not a junction: --force still follows one out of the worktree and deletes its target, and nothing unlinks it first the way it does for a leaked preview, so check the worktree for one first with dir \/AL \/S and remove the link itself with rd <link> — both from cmd\.exe, not PowerShell, where rd and rmdir are aliases for Remove-Item; never a recursive delete, which follows it — before forcing — because a returned teammate's worktree keeps its branch checked out and the new dispatch would otherwise fail with "already used by worktree"; then restate the findings, the branch and the file set in its dispatch, because none of that survives the handover\.$/i,
      // Reviewed: the command bullet states the same rule mechanically — it recomputes each
      // phase's gate and removes only worktrees whose phase passes — so it reinforces the claim
      // rather than qualifying it.
      /^Prune with the command rather than by hand:$/i,
      /^It recomputes each phase's gate, removes only this run's worktrees whose phase passes, sweeps every leaked merge-preview worktree under the system temp directory regardless of which run left it, and names every one it left alone and why\.$/i,
      /^Without --yes it removes nothing but prints the plan anyway\.$/i,
      // Reviewed: `--enforcement-only` documentation below. Neither sentence qualifies this
      // claim — the first only names `prune-run` as one of the two callers the flag speeds up,
      // the second reinforces the same "PASS resting on a skipped check is not prunable" guardrail
      // in `--enforcement-only`'s own terms rather than contradicting it.
      /^finish and prune-run otherwise recompute every command check of every phase — for a five-phase run, five full test suites — to answer a question that usually does not need them\.$/i,
      /^And it will not let prune-run remove a worktree for a phase whose PASS rests on a check the flag skipped — a cheap verdict is enough to report, not enough to delete\.$/i,
    ],
  })
  assertStatement(
    section,
    /Only prune worktrees belonging to this run/i,
    'the guarantee must state its limit: only this run’s worktrees',
  )
  assertStatement(
    section,
    /prune that task's worktree first/i,
    'the one case needing an early removal — a fresh implementer on that task — must be named',
  )
  assertStatement(
    section,
    /restate the findings, the branch and the file set in its dispatch/i,
    'a fresh implementer inherits nothing, so the dispatch must carry what the resume would have',
  )
})

test('parallel-execution requires detaching the main worktree before dispatching the integrator', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Before dispatching tm-integrator')
  // The structural form of "the paragraph introducing the command block states Y": the claim is a
  // statement of a prose block, and the block immediately after it is the code block it
  // introduces. A paragraph or code block inserted between them fails; so does any other sentence
  // in the section that speaks about detaching.
  assertClaim(section, {
    label: 'detach before dispatch',
    claim: /^Detach the main worktree first:?$/i,
    introduces: /git checkout --detach/,
    subject: /\bdetach\w*\b/i,
  })
  assertStatement(
    section,
    /cannot check it out while the main worktree holds it/i,
    'parallel-execution must say why the integrator needs the branch released',
  )
  assertStatement(
    section,
    /reaches for git update-ref/i,
    'parallel-execution must name the unsupported workaround it prevents',
  )
})

test('parallel-execution states an amendment committed only on the run branch does not move the anchor', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  assertClaim(section, {
    label: 'run-branch-only amendment',
    claim: /an amendment committed only on the run branch changes nothing: the merge-base does not move/i,
    subject: /committed only on the run branch/i,
    forbid: [/commit(ting)? (it )?(only )?on the run branch (is enough|suffices|makes it authoritative)/i],
  })
  assertStatement(
    section,
    /Commit it on the base branch/i,
    'parallel-execution must say an authoritative amendment goes on the base branch',
  )
})

test('parallel-execution states the limit of the anchored plan read in the same breath', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  // The guarantee ("a teammate cannot widen its own file set by editing the plan") holds only for
  // the working tree. A teammate that can move refs/heads/<base> can commit a widened file set for
  // itself, and that commit is exactly the step the amendment procedure prescribes — the anchor
  // then reads it. One statement, so text asserting the opposite cannot satisfy it.
  assertClaim(section, {
    label: 'anchored plan read',
    claim: /State the limit with the guarantee: the plan is read from git at the anchor, so a working-tree edit is inert, but a commit on the base branch is authoritative by design and is not distinguishable from an amendment the user made/i,
    then: /A teammate has Bash; if it can move refs\/heads\/<base>/i,
    forbid: [/a teammate cannot widen its own file set by editing the plan\./i],
  })
  assertStatement(
    section,
    /What bounds this is write access to the base branch, not the plan read/i,
    'parallel-execution must name what actually bounds the guarantee',
  )
})

test('parallel-execution documents the base-merge amendment route and whose operation a rebuild is', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  // tm-integrator does checkout plus --no-ff merge and reports blocked otherwise, so "rebuild the
  // run branch, via tm-integrator" prescribes an operation its contract does not cover. The route
  // the gate's ownership check actually accepts is a base merge: its secondary parent is an
  // ancestor of the base, and it moves mergeBase(base, runBranch).
  assertClaim(section, {
    label: 'base-merge route',
    claim: /Merge the base into the run branch with --no-ff: that moves the merge-base onto the new base tip, and ownership accepts the merge because its secondary parent is an ancestor of the base/i,
    then: /The limit on that acceptance: every secondary parent is checked, so a rogue parent riding alongside the base parent still fails/i,
  })
  // The base merge is likewise not an integrator dispatch. tm-integrator merges teammate branches
  // only after a gate PASS and stops on files outside a task's declared set; an amendment has no
  // PASS (the failing gate is why it exists), the base is no teammate branch, and the merge carries
  // planPath, which no task declares. A contracted integrator refuses, so the orchestrator does it.
  assertClaim(section, {
    label: 'base merge ownership',
    claim: /Merging the base into the run branch is the orchestrator's operation, not a tm-integrator dispatch/i,
    forbid: [/(so|then) dispatch tm-integrator, which is the sole writer to it/i],
  })
  assertClaim(section, {
    label: 'rebuild ownership',
    claim: /Rebuilding the run branch is the orchestrator's operation, not the integrator's/i,
    forbid: [/rebuild the run branch on the new base tip, via tm-integrator/i],
  })
})

test('parallel-execution gives the rebase step a rationale runFilesetCheck does not contradict', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  // runFilesetCheck diffs each task branch from `await git.mergeBase(runSha, sha)` — the branch's
  // own fork point off the run branch, never the run anchor. So an un-rebased in-flight branch
  // still diffs to its own changes only, and the fileset failure the old rationale predicted
  // cannot occur. The step is still right; a false reason invites skipping it.
  assertClaim(section, {
    label: 'rebase rationale',
    claim: /never from the anchor, so an un-rebased branch still diffs to its own changes only/i,
    then: /Rebase because the branch needs the amended plan and the interfaces earlier phases merged/i,
    forbid: [/or its diff against the new anchor will contain every file the earlier phases merged/i],
  })
})

test('phase-gate states reviewers are dispatched without a name and a named one loses its result', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertClaim(section, {
    label: 'unnamed reviewers',
    claim: /dispatch one tm-reviewer per lens in parallel over the phase diff, without a name/i,
    then: /A named reviewer becomes an addressable teammate that goes idle without emitting its result, and the review is lost; unnamed reviewers return normally/i,
    subject: /\b(name|named|unnamed)\b/i,
    allow: [
      /Six consecutive named dispatches were lost this way in run preview/i,
      /^The file is \{ "results"/i,
      // Reviewed: this "name" is the findings path the dispatch carries, not the agent name the
      // claim above forbids. The two uses are unrelated and the fallback does not weaken the
      // unnamed-dispatch rule — it covers the case where an unnamed reviewer dies anyway.
      /^Name a findings path per lens in the dispatch/i,
      // Reviewed: this "name" is a CHECK name out of the gate manifest, listed among the values
      // printed through `printable`. It says nothing about how a reviewer is dispatched, so it
      // cannot weaken the unnamed-dispatch rule the claim above states.
      /^Where a line quotes a value an agent wrote/i,
    ],
    forbid: [/dispatch one tm-reviewer per lens[^.]*with a name/i],
  })
})

test('parallel-execution states the blast radius is context, not an enforced file set', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('The map')
  // The no-edit rule needs its own inventory lock: as a bare assertStatement it stayed green
  // while a later sentence in the same section granted the permission back ("when the task
  // requires it, a teammate should go ahead and edit those files too"). Locking on `edit` makes
  // any second sentence in this section about editing a reviewed decision.
  assertClaim(section, {
    label: 'blast radius files are not editable',
    claim: /they are outside the file set, so the teammate may not edit them/i,
    subject: /\bedit(s|ed|ing)?\b/i,
  })
  assertClaim(section, {
    label: 'coupling is correlation, not enforcement',
    claim: /^Coupling is correlation in history, not a dependency\b/i,
    then: /Nothing enforces it and no gate reads it/i,
    // The subject must name what is being claimed about, not repeat the `then` pattern — a
    // subject copied from `then` can only ever match the statement `then` already exempts, so it
    // locks nothing and deleting it changes no outcome.
    subject: /coupling|blast radius/i,
    allow: [
      /^Every generated brief carries a blast radius/i,
      /^Coupling for a brief is computed over a fixed window/i,
      /^A brief with no blast radius section usually means new files/i,
    ],
  })
})

test('parallel-execution states the coupling window is bounded, not the whole history', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('The map')
  // Correction to the plan: the brief's window is not a default and not settable — the workflow
  // path hardcodes 500 and `--commits` reaches only the standalone `map` command. Two contiguous
  // patterns, no `.*` between the halves of either claim: a character gap is exactly the hole
  // md-contract.mjs exists to close, and a single sentence spanning it can keep both anchor
  // phrases while cancelling the claim in between.
  assertStatement(
    section,
    /Coupling for a brief is computed over a fixed window of the last 500 commits, which the workflow path hardcodes and no flag changes/i,
    'the skill must state the brief window is fixed at 500 commits, not a settable default',
  )
  assertStatement(
    section,
    /--commits sets the window for the standalone map command only, and workflow --commits is swallowed without complaint/i,
    'the skill must confine --commits to the map command and say workflow silently ignores it',
  )
  // The support floor, not an empty repository, is the ordinary reason a brief has no section.
  assertStatement(
    section,
    /a declared file needs at least three commits of its own history before coupling counts it/i,
    'the skill must name the support floor so a section-less brief does not read as a broken dispatch',
  )
})

test('parallel-execution documents --enforcement-only and what it is for', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  // Why the flag exists at all. Without this a reader sees the guardrails below but never learns
  // what the flag buys — the whole reason `finish` and `prune-run` recompute every command check
  // of every phase in the first place.
  assertStatement(
    section,
    /^finish and prune-run otherwise recompute every command check of every phase — for a five-phase run, five full test suites — to answer a question that usually does not need them\.$/i,
    '--enforcement-only must state what it is for',
  )
})

// The three `subject:` locks below (scope, refusal, prune guard) each catch a contradicting
// neighbour that uses the vocabulary the subject names — "ownership check", "refus-", "remove" /
// "delete". A sentence that negates the pinned claim without using any of that vocabulary passes
// unreviewed, the same limit `tests/md-contract.mjs:41-52` documents for this whole module: this
// is a vocabulary lock, not a semantic one, and no amount of widening turns it into one. Piling on
// more subject words to chase completeness is the wrong fix — it only pulls more legitimate
// neighbours into each `allow` list, which is how a lock stops locking. An accurate note about a
// partial lock, not a wider vocabulary, is the stable end state.
test('parallel-execution states --enforcement-only drops only command checks', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertClaim(section, {
    label: 'enforcement-only scope',
    claim: /^It drops only command checks; fileset, ownership, and the merge check the gate computes for itself still run\.$/i,
    // Widened from a phrase unique to this sentence ("drops only", which nothing else could ever
    // repeat) to the check-kind nouns a contradicting neighbour would actually use. Proven by
    // mutation: "It also skips the ownership check, and it refuses nothing when a phase declares
    // no checks at all." is caught by this subject — it names "ownership check" — though it
    // shares none of the claim's own wording.
    subject: /\b(fileset|ownership|command check)/i,
    allow: [
      // Reviewed: the refusal claim below. It names fileset and ownership as what a manifest must
      // declare for the flag to answer at all, consistent with — not qualifying — the claim that
      // both checks still run.
      /^It REFUSES with exit 2 when a phase's manifest declares no fileset and no ownership check, because with nothing else to verify the result would be meaningless\.$/i,
      // Reviewed: the purpose sentence. It says finish/prune-run normally run every command
      // check of every phase; it says nothing about what --enforcement-only itself drops or
      // keeps, so it does not qualify this claim.
      /^finish and prune-run otherwise recompute every command check of every phase — for a five-phase run, five full test suites — to answer a question that usually does not need them\.$/i,
    ],
  })
})

test('parallel-execution states every check --enforcement-only drops is reported as skip', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertStatement(
    section,
    /^Every dropped check is reported as skip, never silently omitted\.$/i,
    '--enforcement-only must state dropped checks are always reported, never silently omitted',
  )
})

test('parallel-execution states --enforcement-only refuses a phase with no enforcement check', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertClaim(section, {
    label: 'enforcement-only refusal',
    claim: /^It REFUSES with exit 2 when a phase's manifest declares no fileset and no ownership check, because with nothing else to verify the result would be meaningless\.$/i,
    // Widened from the case-sensitive, claim-only /\bREFUSES\b/ (which even "refuses" missed) to
    // every inflection of the verb, case-insensitively. Proven by mutation: "...and it refuses
    // nothing when a phase declares no checks at all" is caught.
    subject: /\brefus(e|es|ed|ing)\b/i,
    allow: [
      // Reviewed: the fresh-implementer exception's own justification for hand-forcing a
      // worktree removal — an unrelated refusal (git's, on a dirty worktree) used to explain why
      // `--force` is authorised there, not a claim about this flag's exit-2 refusal.
      /^The one exception is a task going to a fresh implementer instead of a resume, because resuming stalled: prune that task's worktree first, since prune-run only removes a worktree whose phase already recomputes to PASS and a mid-phase stall has none yet to rest that removal on — do it by hand with git worktree remove --force <path>, then git worktree prune; --force is required and authorised here, because a mid-stall worktree is exactly the one most likely to hold modified or untracked files a bare remove refuses over, and discarding that work is the deliberate point of abandoning it for a fresh implementer — that authorisation covers the teammate's unfinished work only, not a junction: --force still follows one out of the worktree and deletes its target, and nothing unlinks it first the way it does for a leaked preview, so check the worktree for one first with dir \/AL \/S and remove the link itself with rd <link> — both from cmd\.exe, not PowerShell, where rd and rmdir are aliases for Remove-Item; never a recursive delete, which follows it — before forcing — because a returned teammate's worktree keeps its branch checked out and the new dispatch would otherwise fail with "already used by worktree"; then restate the findings, the branch and the file set in its dispatch, because none of that survives the handover\.$/i,
    ],
  })
})

test('parallel-execution states --enforcement-only never authorises a prune on a skipped check', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertClaim(section, {
    label: 'enforcement-only prune guard',
    claim: /^And it will not let prune-run remove a worktree for a phase whose PASS rests on a check the flag skipped — a cheap verdict is enough to report, not enough to delete\.$/i,
    // Widened from "not enough to delete", a phrase unique to this sentence, to every inflection
    // of remove/delete — the verbs a contradicting neighbour would actually use. Proven by
    // mutation: "In practice, pass --yes as well and it will remove the worktree regardless." is
    // caught, though it shares none of the claim's own wording.
    subject: /\b(remov(e|es|ed|ing)|delet(e|es|ed|ing))\b/i,
    allow: [
      // Reviewed: the prune-run command bullet's own description of its ordinary removal
      // behaviour, for a PASS it computed itself — a different claim than this flag's guardrail
      // on a PASS resting on what the flag skipped.
      /^It recomputes each phase's gate, removes only this run's worktrees whose phase passes, sweeps every leaked merge-preview worktree under the system temp directory regardless of which run left it, and names every one it left alone and why\.$/i,
      /^Without --yes it removes nothing but prints the plan anyway\.$/i,
      // Reviewed: the worktree-pruning bullet's own removal instruction for the ordinary case of
      // a recorded PASS — again a different claim than this flag's guardrail.
      /^Once the phase has a recorded PASS, run prune-run to remove the worktree, not git worktree remove by hand — the command above already covers this case\.$/i,
      // Reviewed: the same bullet's fresh-implementer exception. A named, justified hand removal
      // for the one case prune-run cannot yet reach — again a different claim than this flag's
      // guardrail, which is about a PASS resting on what the flag itself skipped.
      /^The one exception is a task going to a fresh implementer instead of a resume, because resuming stalled: prune that task's worktree first, since prune-run only removes a worktree whose phase already recomputes to PASS and a mid-phase stall has none yet to rest that removal on — do it by hand with git worktree remove --force <path>, then git worktree prune; --force is required and authorised here, because a mid-stall worktree is exactly the one most likely to hold modified or untracked files a bare remove refuses over, and discarding that work is the deliberate point of abandoning it for a fresh implementer — that authorisation covers the teammate's unfinished work only, not a junction: --force still follows one out of the worktree and deletes its target, and nothing unlinks it first the way it does for a leaked preview, so check the worktree for one first with dir \/AL \/S and remove the link itself with rd <link> — both from cmd\.exe, not PowerShell, where rd and rmdir are aliases for Remove-Item; never a recursive delete, which follows it — before forcing — because a returned teammate's worktree keeps its branch checked out and the new dispatch would otherwise fail with "already used by worktree"; then restate the findings, the branch and the file set in its dispatch, because none of that survives the handover\.$/i,
    ],
  })
})

// The three sentences § 5 carries beyond its pinned claim, each written once and used twice
// below: as an `assertStatement` that REQUIRES it, and as an `allow` entry that PERMITS it past
// the claim's subject inventory. Two copies of the same 500-character regex is a drift hazard
// for nothing, and drift here is silent — the pin would go on matching a sentence the allow
// entry no longer covers, or the reverse.
//
// ANCHORED END TO END, and that is the whole point of them. A prefix pin imposes only its
// prefix: measured on this tree, replacing the first sentence with the bare
// `This is irreversible on every prunable worktree:` — dropping the junction hazard and the
// post-merge-edits warning its own failure message names — left the suite green under an
// eight-word prefix pin, because the truncated sentence matched no subject alternative either
// and so was not a stray. The other two survived the same truncation, but by ACCIDENT and in a
// different test each: the exception sentence via the hand-sweep corpus losing its `by hand`
// site, the dry-run sentence via the claim's own subject inventory catching `removes`. Anchored,
// all three die where they are declared.
const CLEANUP_IRREVERSIBLE = /^This is irreversible on every prunable worktree, not only a leaked preview: git worktree remove --force runs whether or not a teammate's worktree still holds edits made after its branch merged, and --force follows a junction out of the worktree to its target instead of stopping at the boundary — verified on Windows, and exactly the shape a dependency install during bootstrap \(see "Worktree mechanics" below\) can leave behind; nothing unlinks it first the way a leaked preview's own links are unlinked, because that sweep runs only for previews:$/i
const CLEANUP_EXCEPTION = /^The one exception is a task going to a fresh implementer before its phase has passed: this command cannot reach that worktree yet, so it still has to be removed by hand with --force — authorised there because abandoning that teammate's unfinished worktree for a fresh dispatch is the deliberate point, and a mid-stall worktree is exactly the one most likely to hold modified or untracked files a bare remove refuses over — and that authorisation covers the teammate's unfinished work only: --force still follows a junction out of the worktree the same way, and nothing unlinks it first there either, so check the worktree for one first with dir \/AL \/S and remove the link itself with rd <link> — both from cmd\.exe, not PowerShell, where rd and rmdir are aliases for Remove-Item; never a recursive delete, which follows it — before forcing — see the matching exception in "Worktree mechanics" below\.$/i
const CLEANUP_DRY_RUN = /^Without --yes it removes nothing and prints the prunable and leaked-preview lists it would act on if nothing changes before the --yes run — both runs recompute the gate from scratch, so a phase that fails a check during the dry run and passes during the --yes run has worktrees force-removed that never appeared in the list the operator approved; the per-branch "left <branch> in place: not an ancestor" line is decided only while --yes runs the removal, so a dry run does not yet show which merged worktree's branch would survive\.$/i

test('parallel-execution makes prune-run the only supported cleanup', async () => {
  const doc = parseDoc(await readFile(new URL('parallel-execution/SKILL.md', dir), 'utf8'), 'parallel-execution')
  const cleanup = doc.section(/^5\. Clean up the phase$/)
  // The claim's antecedent ("This") is the code block above it. `statementsOf` never sees a code
  // block — only paragraphs and list items — so the `subject:` lock below cannot reach it, and a
  // swap of the invocation for an unguarded `rm -rf` sweep plus a `--merged`-relative
  // `git branch -D` would read as this same claim with every sentence untouched. Pin the block by
  // its own content, ANCHORED end to end: `assertCode` tests an unanchored substring, so an
  // unanchored pattern still matches a block that sandwiches the real invocation between a hand
  // sweep and a check-skipping `--enforcement-only` flag — proven by mutation below.
  assertCode(
    cleanup,
    /^node "<fleetmates root>\/scripts\/cli\.mjs" prune-run --run <runId> --plan <planPath> --root <project root> --yes$/,
    'the cleanup section must show the exact prune-run invocation the claim is about, and nothing else in the same block',
  )
  // `assertCode` is `scope.code.find()` — it finds ONE matching block and says nothing about
  // any others, so anchoring the pattern (above) closes the same-block sandwich but not a
  // second, unpinned block placed anywhere else in the section: a hand-sweep block two blank
  // lines below the real invocation still passes. The section may carry exactly one code block,
  // full stop.
  assert.equal(
    cleanup.code.length,
    1,
    `the cleanup section must contain exactly one code block, found ${cleanup.code.length}`,
  )
  // `allow` GRANTS PERMISSION AND NEVER IMPOSES EXISTENCE. Measured on dadb385, this task's prose
  // commit, with these three calls not yet written: rewording any of the three sentences below
  // was red, because the anchored allow regex stopped matching and the sentence became a stray —
  // but DELETING any
  // of them outright was GREEN, each one on its own, with nothing in the suite noticing. So the
  // safety prose two commits exist to add could have been reverted and every check here would
  // still have passed. That is a past measurement on a past tree, and it is written as one: on
  // this tree each deletion is red, and so is each truncation to the sentence's opening words.
  // What dies in either case is 'parallel-execution makes prune-run the only supported cleanup',
  // at the `assertStatement` for the sentence that went, whose message names what that sentence
  // buys. `assertStatement` is what makes a sentence required; the allow entries stay, because
  // they are what keeps a FOURTH sentence about the same subject from appearing unreviewed.
  assertStatement(
    cleanup,
    CLEANUP_IRREVERSIBLE,
    'deleting or truncating this leaves the section introducing prune-run --yes with no warning that '
      + 'the removal '
      + 'is irreversible on a worktree holding post-merge edits, and none that --force follows a '
      + 'junction out of the worktree to its target',
  )
  // NOT MEASURED, and nothing in this repository can measure it: the junction commands this
  // sentence carries are Windows-only and every run of this suite is on POSIX. What was verified
  // here is the CONTRACT — that the sentence exists, and that both halves name cmd.exe rather than
  // mixing a PowerShell detection command with a removal whose spelling aliases `Remove-Item`
  // there. On a Windows host the checks would be `dir /AL /S` inside the worktree to list reparse
  // points, `rd <link>` to remove one, and `dir` on the junction's target afterwards to confirm
  // the target survived. Treat the behaviour as documented, not as tested.
  assertStatement(
    cleanup,
    CLEANUP_EXCEPTION,
    'deleting or truncating this leaves the prohibition above it absolute, so the one case prune-run '
      + 'cannot yet '
      + 'reach reads as forbidden — and takes with it the junction check and the rd instruction '
      + 'that make the authorised hand removal safe',
  )
  assertStatement(
    cleanup,
    CLEANUP_DRY_RUN,
    'deleting or truncating this leaves the dry run undocumented: nothing then says the two runs '
      + 'recompute the '
      + 'gate independently, nor that the per-branch ancestor verdict is decided only under --yes',
  )
  assertClaim(cleanup, {
    label: 'cleanup command',
    claim: /^This is the only supported way to clean up after a phase\.$/i,
    // Anchored end to end, not a prefix: `assertClaim` exempts the `then` consequence from the
    // subject inventory below (`consequence` is assigned at tests/md-contract.mjs:452 and the
    // stray scan compares against it by identity at :472, so the allow list can never see it), so
    // an unanchored prefix match would leave the sentence's TAIL — including the ancestor-proof
    // bound — pinned nowhere. This regex is the one and only place that bound is checked.
    // Reviewed: the ancestor-proof bound, AS IT NOW STANDS. The proof does not resolve the run
    // branch by name: `derive` takes `runBranchRef` straight off `head.ref`
    // (scripts/cli.mjs:2280-2290), which is `git symbolic-ref --quiet HEAD`
    // (scripts/git.mjs:271), and the deletion resolves that same ref at the moment it decides
    // (scripts/cli.mjs:3845-3847). Abbreviation is what the tag / `heads/<name>` /
    // `refs/heads/refs/heads/<name>` plant redirected, and `symbolic-ref` abbreviates nothing;
    // `classifyHeadRef` (scripts/git.mjs:126) additionally refuses a detached HEAD, a HEAD
    // outside `refs/heads/`, and a stripped name that is itself a ref path. The mechanism the
    // old plant needed is gone from this tree — `command grep -rn 'abbrev-ref' scripts/` finds
    // only two comments describing what was replaced — and `tests/git.test.mjs:158-161` pins
    // `currentBranchRef` to `symbolic-ref`.
    //
    // This comment previously asserted the OPPOSITE, and outlived the sentence it justifies by a
    // long way: the prose was corrected in dadb385 while these lines were left over from a800266,
    // fifteen commits earlier counting first-parent (91 counting every ancestor), still describing
    // an operator pre-flight that § 5 no longer carries. Both of its citations had gone stale too
    // — `scripts/git.mjs:147` is the name-slice inside `classifyHeadRef`, and
    // `scripts/cli.mjs:3092-3117` spans a command boundary rather than naming any proof: `brief`
    // ends at :3103 and `workflow` opens at :3105, so half those lines belong to a command with no
    // bearing on ancestry at all. Left standing it would have
    // argued a maintainer into RESTORING the deleted warning, which
    // `finishing-a-development-branch/SKILL.md:99-104` already contradicts in the same words the
    // regex below pins.
    then: /^It recomputes each phase's gate rather than reading status\.gates, removes only this run's worktrees whose phase passes, sweeps every leaked merge-preview worktree under the system temp directory regardless of which run left it — even one holding an operator's own uncommitted work — deletes each removed worktree's branch where git merge-base --is-ancestor proves it is already in the run branch — the run branch it proves against is the ref HEAD symbolically points at, so no tag or same-named branch can redirect that proof — and names every worktree it leaves alone with the reason\.$/i,
    // Widened to match the sibling lock at :813 in this file: the behaviour claims themselves
    // ("removes only...", "sweeps every...", "deletes each...") are the substance of this
    // section, and the narrower `prune-run|by hand|...` lexicon alone does not reach a rewrite of
    // any of them, as long as the rewrite avoids those four exact phrases. Proven by mutation:
    // "removes every worktree in the repository whether or not its phase passes" is caught by
    // this subject though it shares none of the narrower lexicon's wording. `rm -rf|rm -fr` is
    // added on top for the same reason: nothing else here names the shell command a hand sweep
    // would actually use, so a paragraph proposing one otherwise passes unreviewed.
    subject: /prune-run|by hand|git worktree remove|git branch -D|remov(e|es|ed|ing)|delet(e|es|ed|ing)|rm -rf|rm -fr/i,
    allow: [
      // `normalize()` strips backticks before matching (tests/md-contract.mjs:73-81), so these
      // patterns are written without them, matching the convention every other allow entry in
      // this file already follows — a pattern that kept the backticks in would never match and
      // this test would fail permanently rather than on a real regression.
      /^Once the phase has a recorded PASS and its branches are merged, remove what it left\.$/i,
      // Reviewed: the irreversibility and junction warning that introduces the command block.
      // Names the general prunable-worktree case, not only a leaked preview — a phase can pass on
      // committed work while a teammate's worktree separately holds uncommitted edits, and
      // `git worktree remove --force` (scripts/git.mjs:673-678) takes both the same way — and the
      // junction hazard a bootstrap step in Worktree mechanics can leave behind, verified on
      // Windows at scripts/cli.mjs:1337-1345.
      CLEANUP_IRREVERSIBLE,
      // Reviewed: the corrected git facts. `git worktree remove` (no `--force`) refuses on
      // uncommitted work, so the hazard is `--force` reaching an unpassed worktree, not the bare
      // command; `git branch -D` refuses only a branch a registered worktree still holds
      // (scripts/git.mjs:696-702) — the ordering constraint this command relies on — and
      // otherwise force-deletes without measuring ancestry; `-d` measures upstream-or-HEAD, never
      // the run branch.
      /^Do not remove a worktree or delete a teammate branch by hand: git worktree remove refuses one holding uncommitted work only until --force is added, and nothing then stops --force from reaching a worktree whose phase has not passed yet; git branch -D does not measure "merged" at all — the one thing it refuses is a branch a registered worktree still has checked out, which is why the worktree has to go first, and otherwise it force-deletes regardless of ancestry — and -d, the flag that does measure, measures against the branch's own upstream or HEAD, never against the run branch\.$/i,
      // Reviewed: the fresh-implementer exception — named and justified in the same breath rather
      // than left to contradict the prohibition above it, `--force` named and authorised for this
      // one case (a mid-stall worktree is exactly the one most likely to refuse a bare remove),
      // and its pointer down to the matching exception in Worktree mechanics.
      CLEANUP_EXCEPTION,
      // Reviewed: the dry-run scoping. `renderPrunePlan` (scripts/cli.mjs:3706) runs above the
      // `--yes` check (:3711) and shows the prunable and leaked-preview lists either way, but the
      // per-branch ancestor decision itself is at :3847, printed at :3853 and :3855, all three
      // inside the removal loop only `--yes` reaches — so this states what a dry run does NOT yet
      // show rather than repeating the removal claim above.
      CLEANUP_DRY_RUN,
    ],
  })
})

test('fleet-lifecycle states who writes the map notes and that nothing enforced reads them', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  assertStatement(
    section,
    /a teammate never writes this file, and nothing enforced ever reads it/i,
    'the skill must keep map notes out of both the write path and the enforcement path',
  )
})

test('fleet-lifecycle states the Explore prompt filters directory names before they render', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  // Correction to the plan: the Explore prompt is handed to an agent with Bash and no gate, so
  // the skill has to say the directory names it carries are filtered, not merely listed. The
  // claim is anchored end-to-end AND subject-locked: an unanchored substring stayed green while
  // the same sentence trailed off into "…but the filter is advisory and the raw names are used
  // when it returns nothing".
  assertClaim(section, {
    label: 'carried directory names are filtered',
    claim: /^The directory names that prompt carries are filtered — anything that is not a plain path segment is dropped — because that prompt is handed to an agent that has Bash and is gated by nothing\.$/i,
    subject: /filter(s|ed|ing)?\b|directory names/i,
  })
})

test('fleet-lifecycle claims only what map-notes verifies, and names every exit code', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  // mapNotesStale compares a header the writing agent was TOLD to copy against HEAD. Nothing
  // observes which tree that agent read and nothing detects a later edit, so exit 0 is evidence
  // of provenance, not proof — the same tamper-evident/tamper-proof distinction SECURITY.md and
  // phase-gate keep elsewhere.
  assertClaim(section, {
    label: 'exit 0 is provenance, not proof',
    claim: /^Exit 0 means the stored notes declare the commit the repository is on; the header is a string the writing agent was told to copy, so this is tamper-evident provenance and not proof/i,
    subject: /\bexit 0\b/i,
  })
  // An orchestrator branching on `code === 4` alone reads the exit-2 git failure as "current".
  assertStatement(
    section,
    /^Exit 4 means there are none, they carry no header at all, they name a different commit, they were written for a different run, or the file could not be read/i,
    'the skill must name every condition that produces exit 4, not only the missing-notes case',
  )
  assertClaim(section, {
    label: 'exit 2 is unknown, not current',
    claim: /^Exit 2 means git could not be read, so no comparison happened at all — read that as unknown, never as current\.$/i,
    subject: /\bexit 2\b/i,
  })
})

test('fleet-lifecycle states the orchestrator writes the map, not the agent', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  // Anchored end-to-end: an unanchored (or prefix-only) pattern here waives any statement that
  // merely CONTAINS this text, so a mutated tail — "... or let a teammate write `map.md` in
  // place, with the same command and --write:" — would still match and pass, directly
  // contradicting the pinned claim below and naming the locked subject (map.md) while doing it.
  const dispatchPattern =
    /^Dispatch a read-only agent with the printed prompt; it RETURNS the map and you write it to that path yourself, with the same command and --write:$/i
  assertStatement(
    section,
    dispatchPattern,
    'the skill must not tell a read-only agent to write a file',
  )
  assertClaim(section, {
    label: 'map notes writer',
    // Anchored end-to-end: `assertClaim`'s `subject:` inventory screen exempts the claim
    // statement itself (it would otherwise flag itself), so an unanchored `claim:` is the one
    // pattern nothing else in this check screens — a clause appended to this exact sentence
    // ("... unless you dispatch one with Bash and tell it to.") still matches an unanchored
    // pattern as a substring and passes uncaught. Anchoring forces the whole statement to equal
    // what was reviewed, the same fix already applied to the `allow` entries in this file.
    claim: /^A teammate never writes this file, and nothing enforced ever reads it\.$/,
    subject: /writes this file|map\.md/i,
    allow: [dispatchPattern],
  })
})

test('phase-gate states that findings are stamped with the tips they judged', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertStatement(
    section,
    /refuses a file whose stamp names different tips/,
    'the skill must state that stale findings are refused',
  )
  assertStatement(
    section,
    /findings about the old tree are not findings about this one/,
    'the reason must be stated, not just the rule',
  )
})

test('phase-gate documents finish taking per-phase results', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  // A whole-document regex with `.*` gaps is exactly what tests/md-contract.mjs exists to
  // replace: /phases.*1.*results/s is satisfied by "results" drifting in from an unrelated later
  // sentence, so mutating the documented shape to { "phases": { "1": [...] } } — which `finish`
  // itself rejects with "--results phase 1 must be an object with a results array" — stayed
  // green. Lock the one statement that carries the shape instead.
  assertStatement(
    section,
    /^Hand it the same results, keyed by phase: \{ "phases": \{ "1": \{ "results": \[\.\.\.\] \} \} \}\.$/i,
    'the skill must state the exact --results shape finish expects, keyed by phase',
  )
  assertStatement(
    section,
    /A phase that passed on supplied results is marked \(review supplied\) in its output/,
    'a reader must be able to tell a recomputed pass from a reported one',
  )
})

test('parallel-execution states a run bases off the default branch, not another run branch', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  // Step 1 of the procedure in this section commits the amendment on the BASE branch. If the base
  // is another run's deliverable branch, those commits land on it, and `ownership` evaluated for
  // THAT run reports them as reachable from no task branch of it and from no ancestor of its base
  // — which is what they are. The limit is procedural and belongs beside the step that causes it.
  // `subject:` rather than a `doesNotMatch` on the retracted phrase. A phrase pin binds exactly one
  // spelling: "run/claims can never again pass its own gate", inserted anywhere in this section,
  // reinstates the retracted claim with the whole suite green. The inventory lock fails on any
  // unlisted sentence about the report's permanence, whatever its wording.
  assertClaim(section, {
    label: 'stacked-run base',
    claim: /Branch a run's base from the default branch, not from another run's branch/i,
    then: /Step 1 commits the amendment on the base, so if the base is another run's deliverable branch the amendment lands there/i,
    subject: /(permanent|permanently|forever|never (again )?(pass|go green)|does not last|not last|preserve the finding|its own gate|passes on run\/claims)/i,
    allow: [
      /That report does not last/i,
      /ownership now passes on run\/claims — so do not count on the check to preserve the finding/i,
    ],
  })
  assertStatement(
    section,
    /Run followups2 based on run\/claims did exactly this, and ownership gated on run\/claims named five unowned commits/i,
    'parallel-execution must name the run that paid for this and the number of commits it left',
  )
  // Measured against base `master`: the anchor equals the run tip, the range is empty, and
  // `ownership` passes. A skill promising the report survives would send a reader to a green check
  // as evidence of a violation it no longer reports.
  assertStatement(
    section,
    /the derived anchor moved onto the run tip, the commit range emptied, and ownership now passes on run\/claims/i,
    'parallel-execution must state that the ownership report does not survive the run landing',
  )
  assertStatement(
    section,
    /If work genuinely stacks, land the first run before starting the second/i,
    'parallel-execution must give the alternative for genuinely stacked work',
  )
})

test('parallel-execution states the integrator merges in dependency order because a consumer cannot build alone', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Import coupling across tasks')
  assertClaim(section, {
    label: 'import coupling',
    claim: /A task whose file set imports a symbol another task introduces cannot build on its own branch/i,
    then: /merging it first produces a commit whose tree cannot load/i,
  })
  assertStatement(
    section,
    /A revert of the providing task breaks every consumer, not only the feature that motivated it/i,
    'parallel-execution must state that a revert propagates to consumers',
  )
  // The softer form leaves the tree loading and only the prose wrong, so no build catches it. It
  // still has to be judged on the merge, which is the same rule the load failure produces.
  assertStatement(
    section,
    /The softer form leaves the tree loading and only a comment wrong/i,
    'parallel-execution must record the softer form, not only the load failure',
  )
  assertStatement(
    section,
    /the integrator merges in dependency order, and a reviewer judging a cross-task claim judges it on the merge, not on one branch/i,
    'parallel-execution must state the rule both forms share',
  )
})

test('fleet-supervision states liveness detects an absence of progress and names both stall causes', async () => {
  const { doc } = await skill('fleet-supervision')
  const section = doc.section('When a teammate stalls')
  assertStatement(
    section,
    /what it detects is an absence of progress/i,
    'fleet-supervision must say what liveness measures, not what its hint guesses',
  )
  assertNoStatement(
    section,
    /liveness detects (a )?backgrounded command/i,
    'the hint names a likely cause; the skill must not promote it to a diagnosis',
  )
  assertClaim(section, {
    label: 'two stall causes',
    claim: /That names a likely cause; it is a guess, not a diagnosis/i,
    then: /Two causes produce the same board, and the hint names only one of them/i,
  })
  assertStatement(
    section,
    /the harness moved it to the background at the harness timeout of 120 seconds/i,
    'the second cause is the harness backgrounding a foreground command at its own timeout',
  )
  // No relative frequency exists, so neither cause may be ranked. Of the two stalls this repository
  // records, only one attributes a cause: docs/plans/2026-08-08-tooling-gaps.md names run `codemap`
  // as teammates backgrounding the suite themselves, while
  // docs/specs/2026-08-10-claims-liveness-distinct-refs-design.md records run `claims` as three
  // stalls with no cause attributed. The harness-timeout cause rests on in-session reports only.
  // Ranking it above the first also countermands `agents/tm-implementer.md`, which tells a teammate
  // not to background its suite.
  //
  // `subject:` rather than a `doesNotMatch` on "is the common one": that phrase pin binds one
  // spelling, and "the second is the usual one for a long test suite" restores the unmeasured
  // ranking with the suite green. The inventory lock fails on any unlisted sentence in this section
  // that speaks about frequency or ranking.
  assertClaim(section, {
    label: 'stall cause ranking',
    claim: /Neither cause is ranked above the other, because no relative frequency has been measured/i,
    subject: /\b(rank|ranks|ranked|ranking|frequency|count|counts|counted|common|usual|usually|typical|typically|often|majority|mostly|rare|rarer)\b/i,
    allow: [
      /do not assume disobedience without checking which cause applies/i,
    ],
  })
  assertStatement(
    section,
    /of the two stalls this repository records, one attributes the first cause \(run codemap\) and one names no cause at all \(run claims\)/i,
    'fleet-supervision must say what the repository actually records, not attribute both stalls to one cause',
  )
  assertStatement(
    section,
    /the second cause has been reported by teammates in session and never written down/i,
    'fleet-supervision must say the second cause has no written record',
  )
  assertStatement(
    section,
    /do not assume disobedience without checking which cause applies/i,
    'the caution must be conditional, so it does not countermand the implementer contract',
  )
  assertStatement(
    section,
    /pass an explicit longer timeout on the long-running command rather than relying on the default/i,
    'fleet-supervision must give the dispatch-time fix, not only the recovery',
  )
})

test('fleet-supervision states the stall recovery resumes that agent rather than respawning it', async () => {
  const { doc } = await skill('fleet-supervision')
  const section = doc.section('When a teammate stalls')
  assertClaim(section, {
    label: 'stall recovery',
    claim: /The recovery is to resume THAT agent with an instruction to re-run in the foreground with an explicit longer timeout/,
    then: /Do not respawn it: a respawn discards the task's whole context, and a returned teammate's worktree keeps its branch checked out, so a fresh dispatch fails with "already used by worktree" until that worktree is pruned/i,
  })
})

// The direct-dispatch instructions in parallel-execution build each teammate's brief from
// `cli.mjs brief` rather than composing it by hand. The invocation carries the <fleetmates root>
// prefix a skill CLI call must (see the relative-path test above), so the closing quote sits
// between `cli.mjs` and `brief`; binding the literal keeps the dispatch instructions from drifting
// away from the CLI they call.
test('parallel-execution names the brief command its direct dispatches are built from', async () => {
  const { body } = await skill('parallel-execution')
  assert.ok(body.includes('cli.mjs" brief'), 'parallel-execution must name the cli.mjs brief command')
})

// SubagentStop fires only when a teammate actually stops; a stalled or parked teammate never
// reaches it, and `liveness` is the only check that sees an absence of progress with no stop. No
// skill or agent may claim otherwise: any sentence that names both SubagentStop and a stall or a
// parked teammate must also name liveness, so a contract cannot quietly promote the backstop into a
// stall detector. The guard matches both `stall` and `park` because the property it protects covers
// a teammate that never stops for either reason, and the test name asserts exactly that coverage.
// The hook writes a FIXED-FORM refusal naming the branch to create and forwards nothing from
// `complete`'s stdout. The reason is security, not economy: that output carries check names read
// from `fleetmates.gate.json` in the main worktree, which any teammate can write, and forwarding it
// was reproduced delivering a check named to look like an orchestrator instruction carrying a shell
// command. Two documents promised the opposite — the agent contract and fleet-supervision — and
// nothing pinned either, so the contradiction survived a correction to the sibling skill. Any
// sentence about a refusal reaching a teammate must not promise the check's own text.
test('no skill or agent claims a SubagentStop refusal hands back the check output', async () => {
  const agentsDir = new URL('../agents/', import.meta.url)
  const docs = []
  for (const name of await allSkills()) docs.push((await skill(name)).doc)
  for (const file of await readdir(agentsDir)) {
    const text = await readFile(new URL(file, agentsDir), 'utf8')
    const { body } = splitFrontmatter(text, file)
    docs.push(parseDoc(body, file))
  }
  // claimSites, not statements: a heading is invisible to the statement inventory, so scanning
  // statements alone refused the sentence and let the same claim through one line higher as a
  // heading over the very block it contradicts.
  for (const doc of docs) {
    for (const site of claimSites(doc)) {
      if (!/refus|reject|block/i.test(site.text)) continue
      assert.doesNotMatch(
        site.text,
        /hand(?:ing|s)? back the (?:same )?failure text|with the failure text|hands? back the check(?:'s)? output/i,
        `a refusal is a fixed-form message; no document may promise the check's own text `
          + `(${doc.label}, ${site.where}): ${site.text}`,
      )
    }
  }

  // The denylist above is a backstop, not the contract. A phrasing it does not name restores the
  // false promise, which is how the claim survived a correction to a sibling document in the first
  // place. These two sentences are the contract, pinned positively: a paraphrase fails by not being
  // the sentence, whatever words it chooses. The third copy lives inside GUARD_BLOCK already.
  const contractDoc = parseDoc(
    splitFrontmatter(await readFile(new URL('tm-implementer.md', agentsDir), 'utf8'), 'tm-implementer.md').body,
    'tm-implementer.md',
  )
  const refusalBlock = contractDoc.blocks.find((b) => /SubagentStop/.test(b.text))
  assert.ok(refusalBlock, 'agents/tm-implementer.md must carry a block describing the SubagentStop hook')
  assert.deepEqual(
    statementsOf(refusalBlock.text),
    CONTRACT_REFUSAL,
    'agents/tm-implementer.md: the block describing the SubagentStop refusal must match exactly — a '
      + 'sentence was added, removed or reworded anywhere in it. A neighbour phrased outside a '
      + 'denylist is how the false promise came back before.',
  )
  const backstop = (await skill('fleet-supervision')).doc.section('The SubagentStop backstop')
  assert.deepEqual(
    backstop.statements.map((st) => st.text),
    SUPERVISION_REFUSAL,
    'skills/fleet-supervision: the SubagentStop backstop section must match exactly',
  )
  // A nested heading inside the locked section is prose the inventory above cannot see, exactly as
  // a code block is. Bounded rather than enumerated: the section holds no subheading, and adding
  // one has to be argued for here.
  assert.deepEqual(
    backstop.blocks.filter((b) => b.kind === 'heading').map((b) => b.text),
    [],
    'skills/fleet-supervision: the SubagentStop backstop section must hold no nested heading — a '
      + 'heading carries prose the statement inventory does not reach',
  )
})

// The scan above is only as wide as claimSites, and claimSites is in another file, so this pins the
// reach itself rather than trusting the one call site. Both directions are asserted: the synthetic
// document must actually contain the sentence in a heading (an anchor that silently stopped
// matching would read exactly like a closed hole), and the sites must reach it.
// The subject-scoped locks above each bind ONE section or ONE block. That is the documented scope
// bound of md-contract.mjs, and it leaves the cheapest escape untouched: not rewording a locked
// sentence, but writing a contradicting one under a different heading, or in a different document,
// where no lock is looking. The denylist scan is the only thing that spans documents, and it is a
// lexicon — it catches the phrasings someone thought of.
//
// This lock spans the corpus. Every site in every skill and agent contract that names the
// SubagentStop mechanism must be one of the sentences below, in this order, attributed to this
// document. A sentence added anywhere fails; one moved from parallel-execution to phase-gate fails;
// one reworded fails. It does not read polarity and does not need to — the escape it closes is
// location, and location is now spent.
//
// It buys nothing about MEANING: a sentence discussing the hook without naming it, or "stop", or
// "stop-time", is invisible here exactly as it is to a section-scoped subject lock. The list is
// what a human reviewed, not what is true.
const SUBAGENT_STOP_MECHANISM = /SubagentStop|stop[- ]time|the stop\b|\bhook\b/i

const SUBAGENT_STOP_CORPUS = [
  "fleet-supervision :: A teammate's stop runs the SubagentStop hook, which re-runs the cheap enforcement checks and can refuse the stop; a refusal appears in that teammate's transcript as one of two fixed messages — the branch the task is missing, named alongside a pointer to the teammate's brief for the step that creates it, or a direction to run its own verification command — never as the failing check's text, which is not forwarded.",
  "fleet-supervision :: But SubagentStop fires only when a teammate actually stops — a stalled or parked teammate never reaches it, so liveness remains the only thing that sees a teammate which never stops at all.",
  "fleet-supervision :: No stop-path hook fires for a parked agent.",
  "fleet-supervision :: The SubagentStop backstop",
  "parallel-execution :: What it decides is whether the stop-time checks are allowed to be a verdict: complete --enforcement-only compares the recorded run branch against the branch the main worktree has checked out, and when it is absent or different it reports that it cannot verify completion and the stop is allowed.",
  "parallel-execution :: The SubagentStop hook does two cheap things at that moment: it blocks a teammate whose task branch does not exist, and it runs complete --enforcement-only.",
  "parallel-execution :: Only a task-scoped failure refuses the stop, meaning fileset or merge, so a refused stop is not always about a file set; an ownership failure with no task-scoped failure beside it is reported and the stop is allowed.",
  "parallel-execution :: The teammate is shown none of that detail — the hook reads the exit status and never forwards what the check printed.",
  "parallel-execution :: The hook resolves a stopping teammate through records under .fleetmates/, which is gitignored and writable by every teammate, and it allows the stop on anything it cannot establish — a teammate it cannot resolve, a plan it cannot read, a recorded run branch that is not the branch checked out.",
  "parallel-execution :: The hook can only ever add a block that would not otherwise happen, so declining to block on anything it cannot establish is what keeps an unreadable record from costing a teammate a turn.",
  "parallel-execution :: It is not a guarantee against being blocked over foreign state: the records are teammate-writable, so a planted location record makes the hook establish something false and block whoever stops in the worktree that record keys on — resolution is by worktree path, not by teammate identity, and any linked worktree of this repository qualifies, including a reviewer's scratch one.",
  "tm-implementer.md :: Stopping without running that gate is caught, not waved through: a SubagentStop hook runs the enforcement checks at stop time and can refuse the stop.",
]

test('every sentence about the SubagentStop mechanism, in any document, is one a human locked', async () => {
  const agentsDir = new URL('../agents/', import.meta.url)
  const docs = []
  for (const name of await allSkills()) docs.push({ label: name, doc: (await skill(name)).doc })
  for (const file of await readdir(agentsDir)) {
    const text = await readFile(new URL(file, agentsDir), 'utf8')
    const { body } = splitFrontmatter(text, file)
    docs.push({ label: file, doc: parseDoc(body, file) })
  }
  assertCorpusInventory(
    docs,
    SUBAGENT_STOP_MECHANISM,
    SUBAGENT_STOP_CORPUS,
    'the SubagentStop mechanism is described across several documents and no section lock spans them',
  )
})

// A section lock binds one section, so the cheapest escape was never to reword a locked sentence
// but to add a contradicting one under the next heading. Measured on this tree: a
// `Clear leftovers by hand when you are in a hurry:` bullet plus an `rm -rf
// .claude/worktrees/agent-* && git branch -D $(git branch --list 'teammates/*')` block, placed in
// Worktree mechanics, left the whole suite green — the document then carried an unsupported hand
// sweep two sections below the claim that prune-run is the only supported way to clean up, and no
// test named it. The corpus inventory removes the LOCATION dimension: every sentence about
// sweeping by hand, in either document, has to be in this list.
//
// WHAT THIS LOCK DOES NOT REACH. `claimSites` reads statements and headings, never code, so a
// hand-sweep BLOCK is invisible to THIS INVENTORY wherever it parses as a block. Measured on this
// tree: the same plant with only its bullet line deleted — blank-line separated, which is how
// every indented command block in these documents is written — parses as kind `code`, leaves the
// lexicon count at seven sites in parallel-execution, and, placed in Worktree mechanics, leaves
// the whole suite green. What this lock reaches is the PROSE that introduces such a block, and
// only where that prose names something in the lexicon.
//
// An earlier version of this comment claimed the block-alone shape was caught; it is caught only
// with the blank line ALSO removed, where the indented lines are read as a continuation of the
// preceding list item and land inside that item's statement. That is a parsing accident, not
// coverage, and describing it as coverage would tell the next reviewer a hole was closed.
//
// INVISIBLE TO THIS INVENTORY IS NOT UNCAUGHT, and the difference is load-bearing in exactly one
// section: § 5 carries its own code-block count, so the byte-identical plant there is red either
// way — `the cleanup section must contain exactly one code block, found 2` when it sits apart from
// the real invocation, and `must show the exact prune-run invocation … and nothing else in the
// same block` when it sits against it. Both measured. So do not read the paragraph above as "no
// test anywhere catches a planted block", and do not drop `cleanup.code.length` as buying nothing:
// it is what closes the same-section sandwich this inventory cannot see. The scope sentence here
// has been wrong in both directions — too narrow, then too wide — so it now names the one section
// that is covered as precisely as the ones that are not.
//
// The corpus is also two documents, not every document. Measured: `skills/` holds fourteen
// SKILL.md files; the byte-identical bullet+block plant appended to `fleet-lifecycle` leaves the
// suite green, and a `claimSites` scan finds lexicon sites already outside the lock in
// `fleet-lifecycle`, `phase-gate` and `fleetmates-config`. Widening the corpus would pin prose in
// documents nobody has reviewed for this purpose, so the bound is stated instead of closed.
//
// So this buys nothing about MEANING, exactly as the lexicon above buys nothing, and nothing about
// blocks. What is spent is the location OF PROSE naming the lexicon, in these two documents.
const HAND_SWEEP_LEXICON = /rm -rf|rm -fr|by hand|hand-run|hand sweep/i

const HAND_SWEEP_CORPUS = [
  "finishing-a-development-branch :: Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above — it only does what the flag itself says, on whatever you point it at.",
  "parallel-execution :: On a detached HEAD init-run records the literal string HEAD, which is not a run branch and which no command overwrites, so it disarms the second layer until the field is removed by hand.",
  "parallel-execution :: On either direct-Agent path — the fallback above and the fewer-than-three-task case — build each teammate's brief with the CLI rather than composing it by hand:",
  "parallel-execution :: Do not remove a worktree or delete a teammate branch by hand: git worktree remove refuses one holding uncommitted work only until --force is added, and nothing then stops --force from reaching a worktree whose phase has not passed yet; git branch -D does not measure \"merged\" at all — the one thing it refuses is a branch a registered worktree still has checked out, which is why the worktree has to go first, and otherwise it force-deletes regardless of ancestry — and -d, the flag that does measure, measures against the branch's own upstream or HEAD, never against the run branch.",
  "parallel-execution :: The one exception is a task going to a fresh implementer before its phase has passed: this command cannot reach that worktree yet, so it still has to be removed by hand with --force — authorised there because abandoning that teammate's unfinished worktree for a fresh dispatch is the deliberate point, and a mid-stall worktree is exactly the one most likely to hold modified or untracked files a bare remove refuses over — and that authorisation covers the teammate's unfinished work only: --force still follows a junction out of the worktree the same way, and nothing unlinks it first there either, so check the worktree for one first with dir /AL /S and remove the link itself with rd <link> — both from cmd.exe, not PowerShell, where rd and rmdir are aliases for Remove-Item; never a recursive delete, which follows it — before forcing — see the matching exception in \"Worktree mechanics\" below.",
  "parallel-execution :: Prune with the command rather than by hand:",
  "parallel-execution :: Once the phase has a recorded PASS, run prune-run to remove the worktree, not git worktree remove by hand — the command above already covers this case.",
  "parallel-execution :: The one exception is a task going to a fresh implementer instead of a resume, because resuming stalled: prune that task's worktree first, since prune-run only removes a worktree whose phase already recomputes to PASS and a mid-phase stall has none yet to rest that removal on — do it by hand with git worktree remove --force <path>, then git worktree prune; --force is required and authorised here, because a mid-stall worktree is exactly the one most likely to hold modified or untracked files a bare remove refuses over, and discarding that work is the deliberate point of abandoning it for a fresh implementer — that authorisation covers the teammate's unfinished work only, not a junction: --force still follows one out of the worktree and deletes its target, and nothing unlinks it first the way it does for a leaked preview, so check the worktree for one first with dir /AL /S and remove the link itself with rd <link> — both from cmd.exe, not PowerShell, where rd and rmdir are aliases for Remove-Item; never a recursive delete, which follows it — before forcing — because a returned teammate's worktree keeps its branch checked out and the new dispatch would otherwise fail with \"already used by worktree\"; then restate the findings, the branch and the file set in its dispatch, because none of that survives the handover.",
]

test('every sentence about sweeping worktrees by hand, in either cleanup skill, is one a human locked', async () => {
  const docs = []
  for (const name of ['parallel-execution', 'finishing-a-development-branch']) {
    docs.push({ label: name, doc: (await skill(name)).doc })
  }
  assertCorpusInventory(
    docs,
    HAND_SWEEP_LEXICON,
    HAND_SWEEP_CORPUS,
    'the two documents that tell an operator not to sweep by hand each carry authorised exceptions, '
      + 'and no section lock spans them',
  )
})

// A corpus inventory is a list, so a statement counted once per enclosing heading would appear in
// it two or three times and the lock would encode nesting depth as if it were content. Adding an
// unrelated `###` anywhere would then fail a lock about SubagentStop. Measured before the fix:
// parallel-execution reported 316 statements for 154 sentences.
test('a statement is counted once per document, not once per heading enclosing it', () => {
  const source = [
    '# Title',
    '',
    'Top sentence.',
    '',
    '## Section',
    '',
    'Middle sentence.',
    '',
    '### Subsection',
    '',
    'Deep sentence.',
  ].join('\n')
  const doc = parseDoc(source, 'synthetic')

  assert.deepEqual(
    doc.statements.map((s) => s.text),
    ['Top sentence.', 'Middle sentence.', 'Deep sentence.'],
    'document statements must be flat, in document order, with no sentence repeated per enclosing heading',
  )

  // The nesting that caused the duplication is still real — this pins that the fix was flattening
  // the document view, not flattening the sections.
  assert.deepEqual(doc.section('Title').statements.map((s) => s.text), [
    'Top sentence.',
    'Middle sentence.',
    'Deep sentence.',
  ], "a section's own view still includes everything nested under it")
  assert.deepEqual(doc.section('Subsection').statements.map((s) => s.text), ['Deep sentence.'])
})

test('claimSites reaches a claim written into a heading, which statements alone never see', () => {
  const source = [
    '## A refusal hands back the check output',
    '',
    'The hook allows the stop when it cannot establish the teammate.',
    '',
    '### Refusals hand back the failure text',
    '',
    'That is the whole of it.',
  ].join('\n')
  const doc = parseDoc(source, 'synthetic')
  const promise = /hand(?:ing|s)? back the (?:same )?failure text|hands? back the check(?:'s)? output/i

  // The anchor: the claim exists in this document, in headings and nowhere else.
  assert.ok(promise.test(source), 'the synthetic document must carry the claim being scanned for')
  assert.equal(
    doc.statements.filter((s) => promise.test(s.text)).length,
    0,
    'the claim must live only in headings here — otherwise this test passes without exercising the gap',
  )

  const hits = claimSites(doc).filter((s) => promise.test(s.text))
  assert.equal(hits.length, 2, `claimSites must reach both headings, got ${JSON.stringify(hits)}`)
  assert.deepEqual([...new Set(hits.map((h) => h.where))], ['heading'])

  // And the same reach through a section, whose own heading is sliced off its block list.
  const section = doc.section('A refusal hands back the check output')
  assert.equal(
    section.statements.filter((s) => promise.test(s.text)).length,
    0,
    "a section's statements must not reach its own heading — that is the gap this closes",
  )
  assert.ok(
    claimSites(section).some((s) => s.where === 'heading' && /check output/i.test(s.text)),
    "claimSites over a section must reach that section's own heading",
  )
})

test('no skill or agent claims SubagentStop catches a stalled or parked teammate', async () => {
  const agentsDir = new URL('../agents/', import.meta.url)
  const docs = []
  for (const name of await allSkills()) docs.push((await skill(name)).doc)
  for (const file of await readdir(agentsDir)) {
    const text = await readFile(new URL(file, agentsDir), 'utf8')
    const { body } = splitFrontmatter(text, file)
    docs.push(parseDoc(body, file))
  }
  for (const doc of docs) {
    for (const s of doc.statements) {
      if (/SubagentStop/.test(s.text) && /\b(?:stall|park)/i.test(s.text)) {
        assert.match(
          s.text,
          /liveness/i,
          `a sentence naming SubagentStop and a stall or a parked teammate must also name liveness (${doc.label}): ${s.text}`,
        )
      }
    }
  }
})

// These two tests lock the EXACT STATEMENT INVENTORY of the two blocks that describe the run-branch
// record and the SubagentStop guard. Not a subject lexicon — an ordered list.
//
// The lexicon approach was tried and failed four times. A subject alternation is escapable by
// writing the reversal in words it does not name, and each escape was answered by adding the noun
// it leaned on: branch, verdict, layer, then manifest, fileset, ownership, task-scoped, merge,
// pending. The fifth escape used the paragraph's own opening sentence, which names none of them.
// Separately, an `allow` entry is permissive: a sentence that exists only as an allow entry can be
// DELETED outright and nothing fails, which was demonstrated on the "never read a stop that was
// allowed as a verdict" caution.
//
// An ordered inventory closes both classes at once, because it is not a filter over what happens to
// be written — it is the whole text of the section, from its first statement to its last. Any
// sentence added, removed, reworded or reordered fails, in any vocabulary, whether or not it
// mentions the subject, and wherever in the section it is placed.
//
// The block-kind sequence is locked alongside it. `statementsOf` builds statements only from
// paragraphs and list items, so a heading or a fenced code block contributes none and could
// otherwise carry false prose between two locked statements without changing the inventory.
//
// The cost is that every legitimate prose edit must update the list here. That is the review step,
// and it is the point: this section made 45 findings across fifteen rounds, almost all of them
// claims that were true of some paths and false of others. A maintainer editing it should have to
// say so in the test.
//
// No entry may contain a backtick: normalize() strips them before matching.

const RECORD_SHAPE = ['paragraph', 'code', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph']
const GUARD_SHAPE = [
  'paragraph',
  'code',
  'paragraph',
  'paragraph',
  'paragraph',
  'paragraph',
  'code',
  'paragraph',
  'paragraph',
  'paragraph',
  'paragraph',
  'paragraph',
  // The "On a harness other than Claude Code" subsection nests under this h2, so its heading,
  // prose and command block sit in this section's block list too.
  'heading',
  'paragraph',
  'code',
  'paragraph',
]

const CONTRACT_REFUSAL = [
  'Stopping without running that gate is caught, not waved through: a SubagentStop hook runs the enforcement checks at stop time and can refuse the stop.',
  "It hands back one of two fixed messages — the branch your task is missing, named alongside a pointer to your brief for the step that creates it, or a direction to run your own verification command — and never the check's own output — that output carries check names read from a manifest any teammate can write, so run complete yourself to see why.",
  'It is a backstop, not a substitute — it runs only the cheap subset, and the phase gate still runs everything before anything integrates.',
]

const SUPERVISION_REFUSAL = [
  "A teammate's stop runs the SubagentStop hook, which re-runs the cheap enforcement checks and can refuse the stop; a refusal appears in that teammate's transcript as one of two fixed messages — the branch the task is missing, named alongside a pointer to the teammate's brief for the step that creates it, or a direction to run its own verification command — never as the failing check's text, which is not forwarded.",
  'But SubagentStop fires only when a teammate actually stops — a stalled or parked teammate never reaches it, so liveness remains the only thing that sees a teammate which never stops at all.',
  'No stop-path hook fires for a parked agent.',
]

const GUARD_CODE = [
  "node \"<fleetmates root>/scripts/cli.mjs\" workflow --run <runId> --phase <n> --root <project root>",
  "node \"<fleetmates root>/scripts/cli.mjs\" brief --run <id> --task <id> --plan <path> --base <branch> --root <project root>",
  "node \"<fleetmates root>/scripts/cli.mjs\" dispatch --run <id> --phase <n> --harness <name> --root <project root>",
]

const RECORD_BLOCK = [
  "Create and check out this run's branch before initializing, then run init-run from it:",
  'This writes .fleetmates/<runId>/plan.json and status.json and prints the phase breakdown.',
  'Tasks land in the same phase only when their deps are satisfied and their file sets are disjoint.',
  'The order matters for enforcement, not just tidiness. init-run records a run branch by fill-if-absent: it records HEAD when the run has no runBranch recorded yet and HEAD is not the base branch, and it records nothing when HEAD is the base.',
  'A value already recorded always wins — writePlan resolves the field as carried ?? usable — so a re-init from a different branch keeps the old record and prints a note naming the branch it kept.',
  'Compare that name by bytes rather than by eye: the check is byte-wise, and zero-width and homoglyph characters render identically in a terminal.',
  'It records nothing at all wherever it cannot resolve the base on its own: it derives the base itself and takes no --base, so a repository holding both main and master, or neither, throws into a catch that leaves the field unset, and no §1 order can arm anything there until a command that does take --base records it.',
  'One input escapes that description: a recorded empty string is carried like any other, then dropped on write because it is falsy, so the field disappears, the note names no branch, and the run ends up with no record rather than the one it reports keeping.',
  'That record does not resolve a stopping teammate to its task — the worktree location record written by locate does that.',
  'What it decides is whether the stop-time checks are allowed to be a verdict: complete --enforcement-only compares the recorded run branch against the branch the main worktree has checked out, and when it is absent or different it reports that it cannot verify completion and the stop is allowed.',
  'Checking the run branch out before the first init-run is therefore what puts the record in place at the start of the run, on a run id that has none yet.',
  'It does not repair a run whose recorded branch is already wrong: no command overwrites that field.',
  'To correct one, remove runBranch from .fleetmates/<runId>/plan.json and run init-run again — from an attached branch.',
  'An absent record needs no hand-editing: some later commands fill it in and others only read it, so read runBranch in .fleetmates/<runId>/plan.json rather than predicting which.',
  'On a detached HEAD init-run records the literal string HEAD, which is not a run branch and which no command overwrites, so it disarms the second layer until the field is removed by hand.',
  'When init-run records nothing it prints a note directing you to check the run branch out before gating; the note concerns gate refusing to run from the base branch, and a checkout on its own records no run branch.',
]

const GUARD_BLOCK = [
  'Phases with three or more tasks go through the Workflow tool:',
  'Write that source to a file and invoke Workflow with it.',
  "The Workflow tool needs the user's opt-in — ask once per run, then remember it for that run.",
  'If the user declines, or the Workflow tool is unavailable, do not stop.',
  "Fall back to the direct-agent path below for the whole phase: dispatch each task as its own background Agent with isolation: 'worktree', respecting maxParallel.",
  'The result contract is identical, so nothing downstream changes.',
  'Say which path you took.',
  "Phases with fewer than three tasks are dispatched as direct background Agent calls with isolation: 'worktree' and the tm-implementer persona.",
  'Same result contract either way.',
  "On either direct-Agent path — the fallback above and the fewer-than-three-task case — build each teammate's brief with the CLI rather than composing it by hand:",
  'The Workflow path already renders each brief from the same composer, so a hand-written dispatch is only ever a way to drift from what the gate enforces.',
  'On a pure direct-Agent phase a teammate can stop before any other lifecycle command has run.',
  'The SubagentStop hook does two cheap things at that moment: it blocks a teammate whose task branch does not exist, and it runs complete --enforcement-only.',
  'That run keeps every non-command check the manifest declares, plus merge, which the gate computes for itself.',
  'Do not declare merge in the manifest: it finds no runner there and lands as a pending that fails the gate verdict beside the computed result, an agent check declared there finds no runner either, though it fails the verdict only when it is not marked optional.',
  'Only a task-scoped failure refuses the stop, meaning fileset or merge, so a refused stop is not always about a file set; an ownership failure with no task-scoped failure beside it is reported and the stop is allowed.',
  'The teammate is shown none of that detail — the hook reads the exit status and never forwards what the check printed.',
  'Treat both as best effort.',
  'The hook resolves a stopping teammate through records under .fleetmates/, which is gitignored and writable by every teammate, and it allows the stop on anything it cannot establish — a teammate it cannot resolve, a plan it cannot read, a recorded run branch that is not the branch checked out.',
  'That is deliberate.',
  'The hook can only ever add a block that would not otherwise happen, so declining to block on anything it cannot establish is what keeps an unreadable record from costing a teammate a turn.',
  "It is not a guarantee against being blocked over foreign state: the records are teammate-writable, so a planted location record makes the hook establish something false and block whoever stops in the worktree that record keys on — resolution is by worktree path, not by teammate identity, and any linked worktree of this repository qualifies, including a reviewer's scratch one.",
  'One plant costs one forced retry, since the next stop carries stop_hook_active.',
  'What this buys is a fast signal on the common honest mistake, not a barrier against a determined one.',
  'The enforcement is the phase gate: its fileset and ownership checks recompute from git and read nothing under .fleetmates/, whatever else the command around them reads.',
  "Which checks run is another matter: that list comes from fleetmates.gate.json in the working tree, which every teammate can write, and an agent check's result comes from files under .fleetmates/ the enforced teammate can write too.",
  'Do the §1 order because it is what lets complete --enforcement-only reach a verdict; the branch-existence check does not depend on it and blocks whether or not a run branch was ever recorded.',
  'Never read a stop that was allowed as a verdict.',
  'Wait on completion notifications.',
  'Do not poll in a loop.',
  'When the orchestrator is not Claude Code, the Workflow tool and background Agent calls do not exist.',
  'Dispatch the whole phase through the CLI instead:',
  'This is worktree-isolated and gate-identical: it produces the same result contract the Workflow and Agent paths do, and resuming a run re-runs the same dispatch.',
  'The harness name is the one the orchestrator is itself running in, passed explicitly.',
]

// Lock the section's WHOLE statement list, not a suffix of it. An earlier version started at the
// block's first sentence, which left everything above it free — a paragraph inserted there
// contradicting the locked text shipped green.
function assertBlock(section, expected, label) {
  assert.deepEqual(
    section.statements.map((s) => s.text),
    expected,
    `${label}: the section's statements must match the locked inventory exactly — a sentence was `
      + 'added, removed, reworded or reordered, anywhere in the section. If the change is correct, '
      + 'update the list in this file; that is the review step, not a formality.',
  )
}

// And lock the sequence of block kinds. Headings and code blocks contribute no statements, so
// without this a heading or fenced block could sit between two locked statements carrying prose the
// inventory never sees.
function assertShape(section, kinds, label) {
  assert.deepEqual(
    section.blocks.map((b) => b.kind),
    kinds,
    `${label}: the section's block structure changed. A heading, code block, list item or paragraph `
      + 'was added, removed or reordered — including forms that carry no statement and so would '
      + 'otherwise be invisible to the statement inventory.',
  )
}

test('parallel-execution checks out the run branch before init-run to record it', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Initialize the run')

  // Order is read from the COMMAND BLOCK. indexOf over section text takes the first occurrence of
  // each string, so prose naming the checkout satisfies it regardless of what the block prescribes.
  const commandBlock = section.blocks.find((b) => b.kind === 'code' && b.code.includes('init-run <planPath>'))
  assert.ok(commandBlock, 'the Initialize section must contain a command block invoking init-run')
  const checkout = commandBlock.code.indexOf('git checkout -b')
  const initRun = commandBlock.code.indexOf('init-run <planPath>')
  assert.notEqual(checkout, -1, 'the command block must instruct checking out the run branch')
  assert.ok(
    checkout < initRun,
    `the checkout must come BEFORE init-run in the same command block: ${JSON.stringify(commandBlock.code)}`,
  )

  assertBlock(section, RECORD_BLOCK, 'the Initialize section')
  assertShape(section, RECORD_SHAPE, 'the Initialize section')
})

test('parallel-execution bounds the SubagentStop guard rather than describing its layers', async () => {
  const { doc } = await skill('parallel-execution')
  assertBlock(doc.section('Dispatch the phase'), GUARD_BLOCK, 'the Dispatch section')
  assertShape(doc.section('Dispatch the phase'), GUARD_SHAPE, 'the Dispatch section')

  // The command blocks' CONTENT, not just their presence in the shape. GUARD_SHAPE pins that three
  // code blocks exist here — the Workflow and brief invocations plus the non-Claude-Code dispatch;
  // without this, a comment line inside any could carry prose the statement inventory forbids,
  // since code contributes no statements.
  assert.deepEqual(
    doc.section('Dispatch the phase').blocks.filter((b) => b.kind === 'code').map((b) => b.code),
    GUARD_CODE,
    'the Dispatch section\'s command blocks must match exactly — a comment line inside one is prose '
      + 'the statement inventory cannot see',
  )

  // Every section, not two. The document has thirteen, and a reversal does not have to move one
  // heading down to escape a two-section loop — any other heading will do. The section HEADINGS are
  // scanned too: parseDoc slices a section's blocks past its own heading, so a claim placed in the
  // heading text is invisible to both the statement inventory and the shape.
  for (const heading of doc.sections) {
    assert.doesNotMatch(
      heading.label ?? '',
      /barrier|never fail-open|always armed|blocked either way/i,
      `a section heading may not carry a claim the body is forbidden to make: ${heading.label}`,
    )
  }
  // Scoped: naming these as the commands that record the run branch is the defect the guard
  // sections keep re-acquiring. Elsewhere the document discusses them legitimately.
  for (const scope of [doc.section('Initialize the run'), doc.section('Dispatch the phase')]) {
    assertNoStatement(
      scope,
      /prune-run|rebuild-state/i,
      'the guard sections must not enumerate the commands that record the run branch; any such list drifts',
    )
  }
  for (const scope of doc.sections) {
    assertNoStatement(
      scope,
      /blocked either way|blocks regardless|caught whether or not|on (?:every|any|each) dispatch path/i,
      'no section may claim a stop-time check fires unconditionally',
    )
    assertNoStatement(
      scope,
      /makes the stop-time checks\s*run at all|only ever turn a block into a non-block/i,
      'no section may invert the guard direction',
    )
    assertNoStatement(
      scope,
      /never fail-open|closed unconditionally|always armed|rely on the stop hook/i,
      'no section may present the guard as a barrier',
    )
    assertNoStatement(
      scope,
      /a verdict of completeness|allowed is a verdict|needs no further check/i,
      'no section may say an allowed stop implies the work was checked',
    )
  }

  // The two command blocks of the Dispatch section, locked by content.

})


// The solo-gate paragraph was bound by NOTHING, and a review verified its EXACT NEGATION passes
// the suite: inverting all four sentences ("reported as a clean first-pass PASS", "a check that
// was skipped is never reported as skipped", "writes a verdict into status.json on every
// invocation", "--run writes no verdict anywhere") left 1959 tests | 1956 pass | 0 fail. Filed by
// pass five, carried unclosed through passes six and seven.
//
// Two layers, and the difference between them matters. The sentence pins are CHANGE DETECTORS —
// they catch an inversion because an inversion changes the bytes, not because anything checks the
// behaviour. The persistence claim is the one that is mechanically decidable, so it gets a real
// assertion against the code that implements it.
test('phase-gate states what still binds on a solo gate, and the persistence rule is true', async () => {
  const text = await readFile(new URL('phase-gate/SKILL.md', dir), 'utf8')

  const CLAIMS = [
    'a PASS reached after N rounds of fixes is reported as such, never as a clean first-pass PASS',
    'a check that was skipped is reported as skipped, every time',
    'A solo gate writes a verdict\ninto `status.json` only when the caller passes `--run`, and a solo gate invoked without `--run`\nwrites no verdict anywhere.',
  ]
  for (const claim of CLAIMS) {
    assert.ok(text.includes(claim),
      `phase-gate must carry this solo-gate rule verbatim, and its negation must fail this test: ${claim}`)
  }

  // The decidable half. `status` is loaded only when a runId is present, and the gate persists
  // exclusively inside `if (status)`, so no `--run` means no write — the claim above, checked
  // against the code rather than against its own restatement.
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const persistSite = cli.slice(cli.indexOf("io.out(JSON.stringify({ ...bound, results }, null, 2))"))
  assert.match(persistSite.slice(0, 200), /if \(status\) \{/,
    'the gate verdict must be persisted only under `if (status)`; if that guard moves, the ' +
    'solo-gate persistence rule the skill states is no longer true and must be rewritten')
})
