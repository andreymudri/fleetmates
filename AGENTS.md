# AGENTS.md

Instructions for coding agents (Codex, Cursor, and others) working in this repository. Humans:
see `README.md` and `CONTRIBUTING.md`.

## What is here

Two separate things share this repo:

- **fleetmates** (repo root): a Claude Code plugin plus a CLI (`scripts/cli.mjs`) that runs a
  planned change as a fleet of worktree-isolated agents with phase gates. Zero dependencies,
  runtime and dev.
- **fleetmates deck** (`hub/`, design docs in `docs/deck/`): a local web deck over Claude Code
  sessions. A private npm package with its own dependencies (node-pty, xterm, ws). The
  zero-dependency rule does not apply inside `hub/`.

## Current state of the deck

All deck work lives on the `feat/deck` branch. Base new deck branches and fleet runs on it
(`--base feat/deck`), not on `master`, and commit deck plans there.

M0 (the spike) is done. M1 (Observe) is integrated on `feat/deck`; its remaining exit steps need
the owner and are listed in `docs/deck/m1-exit.md`. Start from these files:

- `docs/deck/spikes/m0.md`: what M0 built, its measurements, and the open questions it
  answered. Section 6 lists known defects and follow-ups with file:line. Section 7 lists what
  M1 inherits. Section 9 lists the checks only the owner can do.
- `docs/deck/12-milestones.md`: the milestones. M2 follows M1's exit.
- `docs/deck/README.md`: how the design docs are organized.
- `docs/plans/2026-09-26-deck-m0.md`: the M0 plan, including its deviations from the handoff.

Section 6 of the report may be out of date. Before fixing or citing an item from it, check it
against the current code: grep for the symbol, and run or mutate the test that is supposed to pin
it.

Parts of `hub/`:

| Path | Contents |
|---|---|
| `hub/deckd/` | PTY daemon on a Unix socket. The protocol is in `docs/deck/05-api.md` section 5 |
| `hub/bin/fm.mjs` | `fm claude` and `fm attach` |
| `hub/server/screen/` | Screen parsers |
| `hub/server/adapters/scribed.mjs` | scribed client |
| `hub/test/fixtures/` | Captured Claude Code 2.1.282 hook and screen fixtures, already redacted |

## Commands

Root (fleetmates):

    npm test

Hub:

    npm ci --prefix hub
    mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm --prefix hub test
    TMPDIR=/tmp/hx npm --prefix hub run perf    # keystroke echo through Focus; headless /usr/bin/chromium, override with CHROMIUM_PATH

Use a short `TMPDIR` for hub tests. Unix socket paths are limited to about 108 bytes, and a long
temp dir makes the socket tests fail with errors that look like real bugs. CI runs only the root
suite. The hub suite is Linux and macOS only, and is not in CI yet.

Before you finish, kill every deckd, deck server, fake claude and headless Chromium you started.
From the repository root this command must print nothing:

    pgrep -af "$PWD/hub/(deckd|server)/main\.mjs|fake-claude\.mjs"

## Rules

- **Commits:** single line, commitlint style, English, scope `deck` for hub work (for example
  `fix(deck): ...`). The configured git user is the only author. Never add `Co-Authored-By`,
  session links, "Generated with" lines, or any other tool attribution, in commits, PR bodies or
  tags.
- **This repo is public.** Never write personal names, emails, usernames or real home paths into
  code, docs, fixtures or test output. Use placeholders such as `/home/you`. Fixture redaction
  lives in `hub/test/capture/capture-cc.mjs`. Recapturing fixtures starts a real Claude Code
  session, so the owner must authorize each one.
- **Docs in `docs/deck/`:** English, plain prose, no em dash character, placeholders for personal
  paths.
- **Tests must be able to fail.** For each new test, break the code it covers, watch the test
  fail, then restore the code. A mutation that leaves the suite green means the test does not
  pin what its name says. See `CONTRIBUTING.md`.
- **Never modify the fleetmates gate or plan to make your own work pass.** That includes
  `fleetmates.gate.json`, the plans in `docs/plans/`, and anything under `.fleetmates/`
  (gitignored run state). When a fleet run is active, the CLI decides which files each task may
  touch.

## Running a fleet from Codex

When Codex orchestrates, dispatch through the CLI rather than Claude Code's Agent tool:

    node scripts/cli.mjs dispatch --run <id> --phase <n> --harness codex --root .
    node scripts/cli.mjs dispatch-reviews --run <id> --phase <n> --harness codex --root .
    node scripts/cli.mjs dispatch-integrator --run <id> --phase <n> --harness codex --root .

The gate is the same one Claude Code uses:

    node scripts/cli.mjs gate --run <id> --plan <path> --base master --root . --phase <n>

A full multi-phase fleet run driven from Codex has not been done yet. Check each step's output
before relying on it.
