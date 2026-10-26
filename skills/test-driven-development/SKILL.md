---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code - write the failing test first and watch it fail for the right reason.
---

# Test-Driven Development (TDD)

_Adapted from the MIT-licensed superpowers plugin by Jesse Vincent. See NOTICE.md._

## Overview

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** if you didn't watch the test fail, you don't know if it tests the right
thing.

## The Cycle

One action per step. Do not merge steps or skip ahead.

1. **RED** — write one failing test for one behavior.
2. **Verify RED** — run it. Confirm it fails, and check *why* it fails.
3. **GREEN** — write the minimal code to pass that test.
4. **Verify GREEN** — run the full suite. Confirm it passes and nothing else broke.
5. **REFACTOR** — clean up duplication and naming while staying green.
6. **COMMIT** — commit the change, then start the next RED.

## Verify RED means checking the failure message, not just the exit code

A red exit code alone proves nothing. Read the failure message before moving on:

- **Correct reason:** the assertion fails because the behavior doesn't exist yet — e.g.
  `AssertionError: expected undefined to equal 'success'`.
- **Wrong reason:** a typo in the import path, a missing file, a syntax error, a test that
  throws before it reaches the assertion. These also turn the run red, but they say nothing
  about the code under test — a fix that turns *this* red green afterward proves nothing
  either, because the test was never exercising the real behavior.

If the failure isn't the expected one, fix the test (or the setup) and rerun until the failure
is the one you intended, before writing any implementation code.

## GREEN: minimal code only

Write just enough to pass the test that's currently red. Don't add options, branches, or
handling for cases no test asks for yet. Extra behavior written now is behavior no test has
watched fail — it's exactly the kind of code this discipline exists to prevent.

## Red Flags

Any of these thoughts, mid-task, means stop and go back to RED:

| Rationalization | Reality |
|---|---|
| "This is too obvious to test" | Obvious code is exactly the code that breaks silently. Writing the test takes seconds; it's the only proof the obvious thing is actually true. |
| "I'll write tests after" | A test written after the code it verifies always passes on the first run. A test that has never failed has never proven it can catch a bug — you've written documentation, not a test. |
| "The test is trivial" | Trivial to write is not the same as unnecessary. If the assertion is trivial, writing it first costs nothing; skipping it saves nothing either. |

## Bugfixes start with a reproducing test

Never patch a bug directly. First write a test that fails because the bug exists — the test
call sequence should reproduce the reported behavior and assert the correct outcome. Watch it
fail with the same symptom being reported. Only then write the fix, and confirm the same test
now passes. Skipping the reproducing test means shipping a fix with no proof it fixes anything
and no regression guard if it regresses later.

## Applying This

Both `tm-implementer` (dispatched into worktrees by the fleet) and inline execution in the main
session follow this cycle for every task. There is no "small enough to skip" exception — task
size changes how many RED/GREEN cycles a task needs, not whether it needs them.
