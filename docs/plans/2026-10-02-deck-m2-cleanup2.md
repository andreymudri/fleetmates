# fleetmates deck M2 second cleanup Implementation Plan

Tasks 27 to 30 of `docs/plans/2026-10-01-deck-m2.md`, moved into their own run (deck-m2b) on
2026-10-02. Run deck-m2a cannot gate them: after `feat/deck` was fast-forwarded to that run's
tip, its anchor moved past phase 1, and the fileset check reads phase 1 as not integrated. Task
numbers and text are unchanged. Tasks 27, 28 and 29 were already implemented on the deck-m2a
branches and are carried over as they are; their dependency on Task 26 is dropped because Task 26
is already on `feat/deck`.

## Global Constraints

- Base branch: `feat/deck`. Run branches start from it and the gate compares against it.
- Root package runtime and development dependencies remain zero. Hub dependencies stay in
  `hub/package.json` and `hub/package-lock.json`, pinned to exact versions.
- Node >= 24.2.0. Use built-in `node:sqlite`, `node:http` and ESM `.mjs` for the server and deckd.
- Hub tests run with a short TMPDIR: `mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm --prefix hub test`.
  Unix socket paths are limited to about 108 bytes. Tests use temporary HOME, XDG and runtime
  directories, never the owner's live settings, shell profile or services.
- Never run real Claude Code in a test. Use `hub/test/fake-claude/fake-claude.mjs` (through
  `hub/test/helpers/fake-bin.mjs`), `hub/test/integration/stubs/claude` and the captured 2.1.282
  fixtures. Do not recapture fixtures; that needs the owner's separate authorization. Never run a
  bare `node --test` at the repo root: its glob reaches `hub/test/capture/capture-cc.mjs`.
- Any test that starts deckd passes an explicit login environment (`startDeckd({ loginEnv })`), so
  no test ever runs the owner's `$SHELL -l -i`.
- The web server binds IPv4 loopback only. Every new `/api/*` route and the WebSocket keep the
  token, Host and Origin checks of `docs/deck/05-api.md` section 1 and `docs/deck/08-security.md`
  sections 4.1 and 4.2. New routes are written in the shapes `route === '<literal>'` or
  `s[1] === '<resource>' && s.length === N && s[3] === '<action>'` inside the matching method block
  of `hub/server/http/api.mjs`, because `routerTable()` in `hub/test/e2e/security.spec.mjs` reads
  those shapes to prove every route refuses a missing or wrong token.
- `apiVersion` stays 1. Every API change in M2 is additive (`docs/deck/05-api.md` section 8).
- Keystrokes from the browser reach deckd only through the WebSocket terminal channel with the
  checks listed in Task 6; the server never logs input bytes, prompt text, tool input, environment
  values or the token.
- Persist private state with 0600 files and 0700 directories. Child processes are started with an
  argv array, never a shell string, with a timeout, and without the deck token in their environment
  (`docs/deck/08-security.md` section 4.8). The one shell the deck runs on purpose is deckd's
  login-environment probe in Task 1.
- Untrusted text (hook payloads, PTY screen rows, run files, plan markdown, repo names, tasks) is
  rendered as text, never as HTML. No `dangerouslySetInnerHTML`.
- Screen copy lives in each screen's own frozen `*_COPY` object read through `translate` from
  `hub/web/src/components/StatusPill.jsx`, as the M1 screens do; `hub/web/src/i18n/en.js` keeps the
  shell keys. Copy strings come from the spec copy decks verbatim.
- Components and screens never import CSS (the vite `runnerImport` test loader cannot load it).
  Each new stylesheet is imported once from `hub/web/src/main.jsx` by Task 14.
- Each new test must fail for a deliberate mutation of the behaviour it claims to cover, then pass
  after restoration. Every test step below names its mutation. Record the mutation and the command
  in the task result. Where a task changes behaviour an existing test pins, update only the
  assertions that pin the old behaviour, and say which in the task result.
- Style: single quotes, two-space indentation, no semicolons, JSDoc for public JS exports.
- Commit messages: one English commitlint line with scope `deck`; no tool attribution of any kind.
- Public files use placeholders such as `/home/you`, never real names, usernames, emails or home
  paths. Docs in `docs/deck/` are English plain prose without the em dash character.
- Do not edit `fleetmates.gate.json`, any plan in `docs/plans/`, or `.fleetmates/` to make a check
  pass. Do not publish, tag or push.
- Before finishing a task, stop every deckd, deck server, spike server, fake claude and headless
  Chromium the task started. From the worktree root,
  `pgrep -af "$PWD/hub/(deckd|server|spike)/(main|server)\.mjs|fake-claude\.mjs"` must print
  nothing. The pattern is anchored to the worktree so an installed deck the owner runs from another
  directory does not count; tests must therefore start these processes by absolute path.
- This run starts after `fix/deck-dogfood-1` has merged into `feat/deck`. That branch changes
  `hub/server/setup/doctor.mjs`, `hub/bin/fleetmates-deck.mjs` and
  `hub/web/src/screens/first-run/FirstRun.jsx` (init waits for deckd, version drift becomes a
  warning status, `open` launches the default browser). Steps that touch those files describe the
  change by behaviour; read the merged file before editing and keep its new behaviour.
- A denied tool call is a block: report it immediately rather than waiting silently.


### Task 27: watch run directories from server start

Second cleanup round (owner: "keep working", 2026-10-02). `m2-exit.md` 9.2: the server starts no run pass at startup, so a run directory is watched only after something lists runs.

**Files:**
- Modify: `hub/server/main.mjs`
- Test: `hub/test/integration/run-watch.test.mjs`
- Test: `hub/test/integration/server.test.mjs`


- [ ] When the server starts listening, run one priming pass: list runs (which arms the reader's watchers) and record each run's JSON as the comparison baseline, publishing nothing. Later watch events and polls publish only real changes, as today. A failing or slow list at startup must not delay `listen()` or crash the server.
- [ ] Test in `run-watch.test.mjs`: with a run present before start and `runPollMs` 10 minutes, and no client ever listing runs, editing `status.json` publishes `run.updated` within 2 s; and no `run.updated` is published at startup for an unchanged run. Mutation: skip the priming pass.
- [ ] `server.test.mjs` "snapshot queues events committed during an asynchronous run read" counts reader `list()` calls; update only what the priming pass changes in that count, and say so.

### Task 28: pin the two remaining unpinned claims

**Files:**
- Test: `hub/test/unit/spike-removed.test.mjs`
- Test: `hub/test/unit/new-session.test.mjs`


- [ ] `spike-removed.test.mjs`: `hub/test/perf/keystroke-echo.spec.mjs` does not exist. Mutation: restore it from `6b39b28^`.
- [ ] `new-session.test.mjs`: a hooks row that is not ok with an unknown reason (for example `something_else`) shows neither hint and Launch stays enabled (`hooksHintKey` fallback in `NewSession.jsx`). Mutation: make the fallback return `newSession.noHooks`.

### Task 29: make the known flaky tests deterministic

**Files:**
- Test: `hub/test/contract/hooks.test.mjs`
- Test: `hub/test/integration/fm.test.mjs`
- Test: `hub/test/e2e/observe.spec.mjs`
- Test: `hub/test/unit/m1-web-fixes.test.mjs`


- [ ] For each of: `hooks.test.mjs` "hook sends one complete line to the runtime socket without creating spool" and its 200 ms budget assertion; `fm.test.mjs` "SIGHUP to fm attach detaches without printing and leaves the PTY running"; `observe.spec.mjs` "Home AC15 and Failures AC4"; `m1-web-fixes.test.mjs` "moving between Focus sessions and following ?tab= ...": find why it fails under load (reproduce with parallel load, for example the full hub suite twice concurrently or `stress`-style CPU load from a node loop you start and stop yourself), then make it deterministic by awaiting the event, using injected clocks or fake timers, or measuring only the part the budget covers. Never widen a timeout or a budget and never loosen an assertion. Show each fixed test still fails when the behaviour it pins is broken.
- [ ] If a flake is a real product race, do not fix product code (not in this task): report it precisely with a repro.
- [ ] Report the before and after failure rate of each under the same load (at least 10 runs each).

### Task 30: second cleanup docs

**Files:**
- Modify: `docs/deck/screens/failures-and-loading.md`
- Modify: `docs/deck/screens/palette.md`
- Modify: `docs/deck/screens/needs-you-drawer.md`
- Modify: `docs/deck/screens/rail-and-shell.md`
- Modify: `docs/deck/design/design-system.md`
- Modify: `docs/deck/design/components.md`
- Modify: `docs/deck/m2-exit.md`
- Modify: `docs/deck/05-api.md`

**Depends:** T27, T28, T29

- [ ] Add the copy-deck rows `m2-exit.md` 9.2 lists as missing (31 copy-map keys and 17 `hub/web/src/i18n/en.js` keys), each with the exact English text the code ships, in the doc the table names; the state pill labels go in design-system.md's i18n section; `confirm.cancel` and `empty.openLoops.title` in components.md. Recount with a script over every `*_COPY` map and `en.js` and report the number still missing (target 0).
- [ ] `m2-exit.md`: a section for this second round listing each item from Tasks 27 to 30 with its test and evidence, moving the matching 9.2 rows out; flakes that remain, with their measured rates.
- [ ] `05-api.md`, the `run.updated` row of the events table: replace "the first read publishes every run once" with what Task 27 ships (the server primes at start: it lists runs, arms the watchers and records each run's data as the baseline without publishing; later reads publish only changed runs; if the priming list fails, the next successful read publishes every run once).
- [ ] Docs rules: English, plain prose, no em dash, `/home/you` placeholders.
