---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes - reproduce and isolate before changing anything.
---

# Systematic Debugging

_Adapted from the MIT-licensed superpowers plugin by Jesse Vincent. See NOTICE.md._

## Overview

**Core principle:** find the root cause before attempting a fix. A fix aimed at a symptom
without a confirmed cause is a guess, and guesses are how debugging sessions run for hours
without progress.

## The Loop

One step at a time. Do not skip ahead to a fix because the cause "seems obvious."

1. **Reproduce reliably.** Trigger the bug on demand, with exact steps. If you can't
   reproduce it consistently, gather more evidence before doing anything else — don't guess
   at a fix for a bug you can't summon.
2. **Minimise the reproduction.** Strip away everything not required to trigger it: unrelated
   setup, unrelated input, unrelated code paths. A smaller reproduction narrows where the
   cause can be.
3. **State a hypothesis that predicts something observable.** "I think X is the cause because
   Y, and if true then Z will happen when I do W." A hypothesis that can't fail — one with no
   observable prediction — is not a hypothesis, it's a guess wearing a hypothesis's clothes.
4. **Instrument to test it.** Add logging, a debugger breakpoint, or a targeted probe that
   checks the prediction from step 3. Run it once. Read the result against what you predicted,
   not against what you hoped.
5. **Fix the confirmed root cause.** Not the nearest symptom, not a defensive check that papers
   over it — the thing step 4 confirmed.
6. **Add a regression test that fails without the fix.** Apply the `test-driven-development`
   skill: write the test, confirm it fails for the bug's actual symptom, then confirm the fix
   makes it pass. Skipping this step means nothing stops the bug from coming back.

## One change at a time

Change exactly one thing between test runs. Two simultaneous changes make the result
uninterpretable: if the bug clears, you don't know which change fixed it or whether they
cancelled each other out; if it doesn't, you don't know which change to keep. This holds even
under time pressure — especially under time pressure, since that's when bundling changes feels
fastest and costs the most.

## No speculative or shotgun fixes

A speculative fix — "try changing X and see if it helps" — is prohibited. So is a shotgun
fix — changing several plausible-looking things at once in the hope that one of them works.
Both skip the hypothesis step, and both leave you unable to explain afterward why the bug is
gone, which means you can't tell whether it's actually gone or just not currently triggering.

Every fix must trace back to a hypothesis that was tested and confirmed in step 4.

## Discard disproved hypotheses

If instrumentation doesn't confirm the prediction, the hypothesis is wrong. Discard it and form
a new one from what the evidence actually showed — don't patch the old hypothesis with an
exception to keep it alive ("X is the cause, except in this case where it's also Y"). A
hypothesis that needs a growing list of exceptions to survive contact with evidence isn't
converging on the root cause; it's accumulating epicycles around the wrong one.

## When the loop itself is failing

Roughly three fixes in, if each one clears the reported symptom but surfaces new breakage in a
different place, the problem isn't a wrong hypothesis — it's coupling the design didn't
anticipate, and the loop is the wrong tool for it. A fourth local fix will very likely repeat
the pattern: fix here, break there. When you see this shape, stop fixing, name the
architectural problem in one sentence, and raise it rather than running another iteration of
the loop.

## Red flags — stop and go back to reproduce

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "I don't fully understand it, but this might work"
- "Let me change a few things and rerun the tests"
- Proposing a fix before the reproduction is confirmed
- Patching a hypothesis instead of discarding it

Any of these mid-task means: stop, go back to reproduce, and continue from there.

## Applying this

Use this loop for any bug, failing test, or unexpected behavior before proposing a fix — a
`tm-implementer` working a task, or inline work in the main session. Once the loop reaches
step 6, hand off to the `test-driven-development` skill for the RED/GREEN discipline on the
regression test itself. Before claiming the bug is fixed, the `phase-gate` skill is where that
claim is checked against a recorded PASS rather than taken on your word.


## Gate failures

1. **Reproduce.** Run the same complete command from the main worktree root with the original
   run, task, plan and base arguments. Record the command, worktree, exit status and relevant
   output. Interpret the command's documented exit codes: a rejected invocation or unavailable
   measurement is different from a measured failing verdict.
2. **Isolate.** Name the failing check and reduce its reproducer. Separate missing tooling,
   dependencies, inaccessible previews and stale evidence from defects in the task's code.
3. **Hypothesis.** State one explanation and an observable result that would disprove it.
4. **Probe.** Test that prediction once. Discard it when the evidence contradicts it.
5. **Fix.** Correct the confirmed cause within the declared files. If the fix needs another
   owner's files or policy, report blocked; do not widen ownership or weaken checks.
6. **Re-run.** Run the same complete command after the fix, wait for completion, then refresh
   affected phase checks through the orchestrator before reporting done. Task-only enforcement
   does not replace the full phase gate. Include actual output tied to the final tested commit.
