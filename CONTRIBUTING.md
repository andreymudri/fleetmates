# Contributing

Thanks for taking a look. This is a small plugin with strong opinions about verification, so a
few of the rules below are stricter than you might expect.

## Testing a local checkout

The marketplace installs the package published on npm, so `/plugin marketplace add` on a checkout
no longer runs your working copy. Load the checkout directly instead:

    claude --plugin-dir .

Start a new session after an edit to agents, skills, hooks or scripts; a running session keeps
the copy it loaded.

## Ground rules

- **Zero dependencies.** Runtime and dev, both. Tests use the built-in `node:test` runner. A
  change that needs a package almost certainly needs a different design.
- **Node >= 24.2.0.**
- Run `npm test` before opening a pull request. It should be 4077 passing, 0 failing.
- Commit messages: single line, commitlint style, English.

## Running the tests

    npm test

The suite shells out to git constantly — it creates temporary repositories, worktrees and merge
previews. It needs a git identity configured, and it is genuinely platform-sensitive: junctions
versus symlinks, and drive-relative paths, have both produced real bugs here. CI runs Linux,
Windows and macOS, and a change that touches path or link handling should be assumed broken on
the platforms you did not run.

## Tests are the review

The bar here is not "is there a test" but **"would this test fail if the code were wrong"**.

Before submitting, verify each new test by mutation: break the thing it covers, watch the test
fail, restore it, watch it pass. A test you have not seen fail is not evidence. If a mutation
leaves the suite green, the test does not pin what its name says it pins.

This is not ceremony. Several assertions in this repo passed for months while pinning nothing —
a contract test that matched tokens scattered across a whole document, a survival check that
could not observe the deletion it existed to catch. Each was found by someone running the
mutation rather than reading the code.

For prose contracts — the assertions in `tests/agents.test.mjs` and
`tests/skill-contracts.test.mjs` that pin what the skills and agent contracts *say* — use the
helpers in `tests/md-contract.mjs`. Read its header first: it documents precisely what it can and
cannot detect. Do not write a comment claiming a guarantee the assertion does not provide.

## Changing a skill or an agent contract

Skills and `agents/*.md` are read by agents at runtime; their prose is behaviour, not
documentation. Two consequences:

- A change to what a skill promises needs a contract test pinning the new claim.
- Every guarantee must state its limit in the same breath. This is enforced by test, and it is
  the rule the enforcement design turns on: a skill that claims more than it delivers is worse
  than one that claims nothing.

## Changing the enforcement path

`scripts/gate-runner.mjs`, `scripts/enforce.mjs` and `scripts/preview-links.mjs` decide whether a
phase passes. Two invariants hold there:

- **Nothing in a check may read `.fleetmates/`.** That state is written by the agents the gate
  exists to enforce. Every check computes from git instead. If a change needs run state to decide
  a verdict, the design is wrong, not the constraint.
- `aggregateVerdict` stays the only producer of a verdict.

`tests/adversarial.test.mjs` pins the stated limits of the enforcement model. If you change what
is defended, change that file and the design spec together.

## Scope

Bug reports, platform fixes and test-strength improvements are all welcome. For a larger change,
open an issue first — the plugin has a fairly specific view of how a fleet should work, and it is
worth agreeing on the shape before either of us spends the effort.
