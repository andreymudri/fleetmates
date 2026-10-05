# M1 exit report (Observe)

Status: **code ready, milestone not complete.** The automated suites, budgets and the release
preparation below are done and were measured on 2026-10-01. The dogfood week, the manual smoke
test with real Claude Code, design QA, the clean install on a fresh account, the owner decisions in
section 6, and the tag and publication are still PENDING. They need the owner and are not claimed
here.

Exit criteria from [12-milestones.md](12-milestones.md) section 3:

| # | Criterion | State |
|---|---|---|
| 1 | Dogfood week passed, report committed | PENDING (owner). Template in section 7 |
| 2 | M1 acceptance criteria pass in the UI suites; counts property test passes | Automated suites green (section 1). Design QA sign-off PENDING (owner) |
| 3 | Security suite green | Green (section 1) |
| 4 | Hook fixture contract tests green; `init` idempotency and `uninstall-hooks` tests green | Green inside the hub suite (section 1) |
| 5 | Budgets met | Met on the reference machine under TEST-O2 (section 2) |
| 6 | Published: tag, npm with provenance, README with screenshots, clean install passed | Workflow, README and screenshots ready; rehearsal passed (section 3). Clean install on a fresh account, tag and publication PENDING (owner) |

## 1. Test suites

Run from the repository root on the integrated M1 tree. The hub suites need `npm ci --prefix hub`
first and a short `TMPDIR`, because Unix socket paths are limited to about 108 bytes.

| Suite | Command | Result |
|---|---|---|
| Root (fleetmates) | `npm test` | 2796 tests, 2779 pass, 0 fail, 17 skipped |
| Hub | `mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm --prefix hub test` | 630 tests, 630 pass, 0 fail, 0 skipped |
| Observe e2e | `TMPDIR=/tmp/hx node --test hub/test/e2e/observe.spec.mjs` | 39 tests, 39 pass, 0 fail, 0 skipped |
| Security e2e | `TMPDIR=/tmp/hx node --test hub/test/e2e/security.spec.mjs` | 10 tests, 10 pass, 0 fail, 0 skipped |
| Accessibility e2e | `TMPDIR=/tmp/hx node --test hub/test/e2e/accessibility.spec.mjs` | 7 tests, 7 pass, 0 fail, 0 skipped |

Notes:

- The accessibility suite now finds `axe-core` in `hub/node_modules` (a pinned hub development
  dependency, 4.13.0), so its axe tests run without `AXE_CORE_PATH`. It reports zero serious or
  critical violations. The moderate `page-has-heading-one` finding on the loading page was fixed in
  the cleanup round (section 5), and the spec now asserts it.
- The e2e specs and the performance scripts are not part of `npm --prefix hub test` and are not in
  `deck.yml`. The release workflow runs them (section 3).
- Never run a bare `node --test` in this repository: its default glob includes
  `hub/test/capture/capture-cc.mjs`, which starts real Claude Code.
- Timing-sensitive tests can fail under load (the hook contract latency test, the setup socket and
  systemctl tests, a root process-kill test). Rerun a lone failure on its own before treating it as
  real. None failed in the runs above.

## 2. Performance

Measured on the reference machine: AMD Ryzen 7 5700X (8 cores, 16 threads), Linux 7.2, Node
v26.7.0, Chromium 152.0.7977.82 headless. CI pins Node 24.21.0 in `hub/.node-version`; these runs
used the newer local Node and are not a CI measurement. The desktop session was in use, so the
load average was about 3.

| Budget | Script | Result | Load average (1 min) |
|---|---|---|---|
| Hook to UI, p95 under 300 ms for `Stop`, `PermissionRequest` and `Notification` | `hook-latency.mjs` | p95 56.3 ms, p50 46 ms, max 65.5 ms (260 `PermissionRequest` envelopes). Within budget | 2.89 before, 3.36 after |
| Home first paint with 20 sessions, under 500 ms | `home-paint.mjs` | median 49.6 ms from snapshot to painted Home (5 runs: 56.1, 48.2, 49.6, 50, 47.5); navigation to paint p50 136.1 ms. Within budget | 2.73 before, 3.55 after |
| Idle CPU of deckd plus the web server with 10 sessions, under 2% of one core | `idle-cpu.mjs` | 0.20% (deckd 0.02, server 0.18) over 60 s. Within budget. With 10 sessions redrawing a spinner every 100 ms: 1.85% (reported, not gated) | 3.31 at start |

Hook to UI under TEST-O2. The owner decided on 2026-09-30 that the 300 ms budget applies to
`Stop`, `PermissionRequest` and `Notification`, which flush the reorder buffer early, and that
`PostToolUse` and other events keep the 250 ms reorder window. In the same run, 240 `PostToolUse`
envelopes measured p95 308.5 ms (p50 299.7 ms), almost all of it the 250 ms hold; that is outside
the budget by that decision, not a failure. Split over all 500 envelopes: hook process start p95
36 ms, socket p95 9 ms, DOM p95 13.4 ms.

Commands (the hook and idle scripts walk the process ancestry for a `claude` process, so run them
outside a Claude Code session or detached with `setsid -f`):

    mkdir -p /tmp/hx/perf
    TMPDIR=/tmp/hx/perf setsid -f sh -c 'node hub/test/perf/hook-latency.mjs > /tmp/hx/perf/hook.json'
    TMPDIR=/tmp/hx/perf node hub/test/perf/home-paint.mjs
    TMPDIR=/tmp/hx/perf setsid -f sh -c 'node hub/test/perf/idle-cpu.mjs > /tmp/hx/perf/idle.json'

## 3. Release preparation and clean install

Prepared:

- `hub/package.json`: version 0.1.0, `bin` (`fleetmates-deck`, `fm`), `files` (`bin/`, `deckd/`,
  `server/`, `hook/`, `web/dist/`, `systemd/`, `vendor/`, `README.md`, `CHANGELOG.md`), license and
  repository fields. `prepack` runs `bin/vendor-fleetmates.mjs` and then the Vite build; `postpack`
  removes the vendored copy again. It keeps `"private": true` (see section 6).
- The server's fleetmates adapter imports root modules (`scripts/names.mjs`, `liveness.mjs`,
  `git.mjs`, and `reviews.mjs` through them), which the package cannot ship from outside `hub/`.
  `bin/vendor-fleetmates.mjs` copies their import closure into `hub/vendor/fleetmates/` (ignored by
  git), following every relative import and refusing one that leaves `scripts/` or names a package.
  Inside a fleetmates checkout the adapter still loads the root modules, so the root contract test
  keeps covering what the deck runs; elsewhere it loads `vendor/fleetmates/`. Covered by
  `hub/test/unit/package-contents.test.mjs`, which also packs a staged copy of the hub, extracts it
  and imports `server/main.mjs` and `deckd/main.mjs` from the result. An earlier version of this
  report called the rehearsal passed while the installed server could not start: its import failed
  with `ERR_MODULE_NOT_FOUND`, and the rehearsal never imported the server.
- `hub/CHANGELOG.md` with the 0.1.0 entry, `hub/README.md`, a deck section in the root
  `README.md`, and two screenshots in `hub/docs/screenshots/`.
- `.github/workflows/deck-release.yml`, triggered by `deck-v*` tags only. Jobs: the hub suite,
  the three e2e specs, `hub-perf` (informational, results uploaded), a package job (tag must equal
  `deck-v` plus the package version, package must not be private, `npm pack --dry-run` listing with
  required files, the vendored modules, and no tests or spike code), a clean-install job that also
  imports `server/main.mjs` and `deckd/main.mjs` from the installed package, and `publish` (npm 11.5.1 or
  later, `id-token: write`, `npm publish --provenance --access public` from `hub/`, skipped when
  the version is already on npm). The root `release.yml` fires on `v*`; as a glob, `v*` does not
  match `deck-v0.1.0` and `deck-v*` does not match `v2.3.1` (checked with Node's
  `path.matchesGlob`, an approximation of the GitHub filter syntax). The workflow has not run on
  GitHub yet.
- `node scripts/cli.mjs ui` and `node scripts/cli.mjs deck <init|doctor|status|open|uninstall-hooks>`
  forward to `hub/bin/fleetmates-deck.mjs` with an argv array and no shell, refuse unknown
  subcommands, flags and positionals before starting anything, and refuse with the install command
  when `hub/` or `hub/node_modules` is missing (`tests/deck-forwarding.test.mjs`).

Clean-install rehearsal, run locally on 2026-10-01 on the fixed tree (not a fresh user account):

| Step | Result |
|---|---|
| `npm pack` in `hub/` | `andreymudri-fleetmates-deck-0.1.0.tgz`, 243411 bytes, 51 entries including `CHANGELOG.md`, `README.md`, the built `web/dist/` and `vendor/fleetmates/` (`git.mjs`, `liveness.mjs`, `names.mjs`, `reviews.mjs`); `hub/vendor/` was gone again after the pack |
| `npm install -g --prefix <empty dir> <tarball>` with an empty `HOME` | Installed; npm 11.19.0 skipped `node-pty`'s install scripts (allowScripts) |
| `fleetmates-deck init --dry-run` | Printed the planned directories, hook script, settings, token and units; the empty `HOME` stayed empty |
| `fm` with no arguments | Printed its usage and failed, as expected |
| `web/dist/index.html` in the installed package | Present |
| `import('./server/main.mjs')` and `import('./deckd/main.mjs')` in the installed package | Both imported, and the adapter loaded the fleetmates modules from the package's `vendor/fleetmates/`. Importing either module starts nothing: each starts only when it is the script node runs |
| `node-pty` from the installed package | Loaded and spawned `/bin/echo` through a PTY (exit 0), so the prebuilt binary works without the skipped scripts on this machine |

Not rehearsed: starting the installed server and deckd as systemd units.

Still PENDING (owner): `fleetmates-deck init` and `doctor` on a fresh user account with systemd,
checking every non-optional check is green ([13-operations.md](13-operations.md) section 13.5).

The screenshot URLs in both READMEs point at `raw.githubusercontent.com/.../master/...`; they
return 404 until this work is merged to `master`.

## 4. Manual checks still PENDING (owner)

| Check | Reference |
|---|---|
| Dogfood week | [09-testing.md](09-testing.md) section 13; template in section 7 below |
| Manual smoke with real Claude Code 2.1.282 | [09-testing.md](09-testing.md) section 5.4 |
| Design QA sign-off for the M1 screens | [qa/qa-checklist.md](qa/qa-checklist.md) |
| Clean install on a fresh user account | Section 3 |
| Public-data review of the two screenshots and the docs | TEST-O6. The screenshots were checked by eye during this task: fixture repository names and no personal names, paths or emails |
| Tag `deck-v0.1.0` and publish with provenance | [13-operations.md](13-operations.md) section 13.4 |

## 5. Findings carried out of the run

Each was checked against the code on 2026-10-01 as noted; items marked "not re-checked" are carried
as reported by the run's reviewers.

| Severity | Finding | Checked how |
|---|---|---|
| Low | Line counts on Focus edit steps are always empty: `deck-hook` drops `tool_response` (`hookFields` in `hub/hook/deck-hook.mjs`), which `patchCounts` in `session.mjs` reads. Owner decision: should the hook compute the counts itself, since the response can carry file contents | Code read: `tool_response` is absent from `hookFields` |
| Low | A NUL in the path of a static request (for example `GET /a%00b`) returns 500: `realpath` in `hub/server/http/router.mjs` throws `ERR_INVALID_ARG_VALUE`, which the static route does not map to a 4xx. The API routes return 400 since the cleanup round | `realpath` called on a path containing NUL throws `ERR_INVALID_ARG_VALUE`; the router's catch maps that to 500 |
| Low | `runRetention` (`hub/server/db/retention.mjs`) stores each `session.removed` event with data `{}`. The live publish sends `{ id }`, but a client that replays stored events cannot tell which session to drop | Code read |
| Low | Earlier test gaps listed in the run's review files for T7, T10, T11 and T12 | Not re-checked |

New in this task:

- `hub/test/unit/m1-scaffold.test.mjs` asserts `"private": true`, so the package stays private and
  the release workflow's package job fails until the owner removes the flag and that assertion.
- The dogfood pane-check logger (TEST-O4, `DECK_DOGFOOD=1`) and `fleetmates-deck report` are not
  implemented; the dogfood week is logged by hand with the template below. The TEST-O6 denylist
  grep is not in CI.
- npm 11 may skip `node-pty`'s install scripts. The prebuilt binary worked here; a platform without
  a matching prebuild would need `npm install -g --allow-scripts=node-pty`.

Fixed in the cleanup round (tasks 17 and 18, phase 13, gate PASS with no review findings):

- Popup titles name the most severe open tier before the task, as in
  `needs you · destructive · <task>`, so the tier comes before any task text. The mako rendering is
  not re-verified. Other tiers sort before untiered requests, and a test pins it.
- The 30-day retention job runs when the server starts and then daily at 04:10 local time. Removed
  sessions are published to open tabs.
- A deckd drop during the handshake counts one reconnect attempt, not two. The no-XDG Retry path,
  the probe on a later macrotask and the deckd Start path have tests.
- Rescan skips a subdirectory it cannot read; a NUL in the scan root or a session cwd returns 400.
- First run shows a missing Claude Code as not found.
- Settings keeps a stored value with hidden characters unless the field is changed, shows a hint
  for it, and accepts quoted `vaultCommand` arguments.
- The loading page has a level-one heading.
- `hub/LICENSE` ships in the package.
- The vendor script's refusal of a non-literal dynamic import, and its following of `export ... from`
  and literal dynamic imports, are tested.
- `setup.test.mjs` stops every listener it starts, and a listener exits when its stdin closes.
- The reorder early-flush tests and the AC15 countdown e2e use fake clocks instead of wall-clock
  waits.

## 6. Owner decisions still open

From [12-milestones.md](12-milestones.md) section 9 ("M1, before exit") and
[15-open-questions.md](15-open-questions.md). Each has a default that M1 ships with; the owner
confirms or changes it before the milestone closes.

| Item | Default in place |
|---|---|
| Q1: package and command names | `@andreymudri/fleetmates-deck`, `fleetmates-deck`, `fm`; `node scripts/cli.mjs ui` and `deck` forward. Removing `"private": true` belongs to this decision |
| Q19: `pt` UI catalog | English only; `DECK_LANG=pt` falls back to English with a notice |
| Q10, OPS-O3: tags and versioning | `deck-vX.Y.Z`, 0.1.0 at M1, separate `deck-release.yml` |
| Q10, OPS-O4: README language | English only |
| Q10, TEST-O6: scrub before going public | Placeholders in fixtures and screenshots; denylist grep not built |
| TEST-O4: dogfood logging | Manual log (section 7) |
| SM-O2, SM-O3: `agent_needs_input`, question heuristic | Decide from dogfood data |
| SM-O4 / FAIL-O3, SM-O7, SM-O8, SM-O17, SM-O18 / FR-O1 | As in [interaction/state-machines.md](interaction/state-machines.md) |
| SM-O13 / FAIL-O1 / FR-O2 / OPS-O1: "Start scribed" | `systemd-run --user` with a login shell |
| HOME-O1, HOME-O2 / TEAM-O1, HOME-O3, HOME-O5 | As in [screens/home.md](screens/home.md) |
| FR-O4, HOME-O9, design-system 15.1 to 15.5; FAIL-O2; SHELL-O2; CREW-O1 to CREW-O3 | As in the design and screen specs |
| SET-O1, SET-O2 | Language row read-only; UI prefs in the database |
| Hook line counts (section 5) | None computed |

## 7. Dogfood log template

Copy to `docs/deck/dogfood/<yyyy-mm-dd>-m1.md` and fill in one block per working day. The week
passes with zero status-check pane opens caused by the deck over five consecutive working days,
each meeting the load rule ([09-testing.md](09-testing.md) section 13.2). An S1 bug fails the day
and restarts the count after the fix.

    # M1 dogfood week, <start date> to <end date>

    Build: deck <version or commit>, installed with fleetmates-deck init
    Claude Code: <version> (pinned: 2.1.282)

    ## Day N, <weekday yyyy-mm-dd>

    Load: max concurrent sessions <n>; hours with 3 or more <h>; repos <list>; team run <yes/no>
    Pane opens to check status:
    | Time | Session | Reason | Deck wrong, missing or late? |
    |---|---|---|---|
    Popups that were wrong or late: <none or list>
    "Asked you" from the Stop heuristic: <total>, dismissed as wrong <n>
    Bugs filed (severity): <none or list>
    Day result: <pass / fail, why>

    ## Summary

    Days passed: <n> of 5
    S1 bugs and restarts: <list>
    SM-O2 decision: <...>
    SM-O3 decision (false positives <n>): <...>
    Verdict: <passed / not passed>

Days 1 to 5: PENDING.
