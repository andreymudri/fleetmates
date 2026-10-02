# fleetmates deck M2 third cleanup Implementation Plan

Source: `docs/deck/m2-exit.md` section 10.2 and the claims finding on `docs/deck/design/components.md:754`
from run deck-m2b (2026-10-02). The owner asked to keep coding while away; M2's remaining exit step
is the owner's two working days and M3 needs owner decisions first (`docs/deck/12-milestones.md`
section 9), so this round closes the code items M2 left open. Run deck-m2c, run branch
`run/deck-m2c` from `feat/deck` at 16f6442. Task numbers continue from the M2 plans.

## Owner decisions (2026-10-02, asked while the run was in flight)

- Hook budget: the 200 ms budget covers the hook's own run (module load to exit), not Node's interpreter boot. Keep what Task 29 shipped; the docs say so.
- Run the tier design-oversight review (APR-O1, Q4) now as a findings document; the owner resolves its findings before M3.
- SM-O9 / DRW-O4: Caution requests are never approved from a popup; the popup offers "Open".
- DRW-O1: Destructive tiers.json entries carry a confirm label template; when the deck cannot fill the count the label reads "I checked what this command will change".
- SM-O10: approvals given in the terminal (observed through `PostToolUse`) count toward "Make it a rule?".
- SM-O11: a Safe request that matches no tiers.json pattern gets no rule suggestion.

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
- A denied tool call is a block: report it immediately rather than waiting silently.

### Task 31: fm attach detaches on SIGHUP from the moment it starts attaching

`docs/deck/m2-exit.md` 10.2: `hub/bin/fm.mjs` installs its SIGHUP handler (line ~354) only after
the awaited `attach` reply and the `screen` request, while deckd lists the client as soon as it
handles `attach`. A SIGHUP in that window kills fm with signal 1 instead of detaching.

**Files:**
- Modify: `hub/bin/fm.mjs`
- Test: `hub/test/integration/fm.test.mjs`

- [ ] Install the SIGHUP handling before `fm attach` sends `attach` and before `fm claude` sends `spawn`. A SIGHUP that arrives before the PTY id is known, or before the attach reply, is remembered, and fm detaches (sends `detach` for that PTY, prints nothing, exits 0) as soon as it knows the PTY id. A SIGHUP after attach behaves as today. The PTY keeps running in every case. If the attach fails, fm exits as it does today for that failure.
- [ ] Test: hold deckd's `attach` reply (for example a small Unix socket proxy in the test between fm and a test deckd, or a test deckd hook, whichever the existing fm.test harness supports with least new code), send SIGHUP to fm while the reply is held, then release it. Assert fm exits 0 with no signal, prints nothing, deckd received a `detach` request for that PTY before fm's socket closed, and the PTY is still listed. Mutation: move the handler back after the attach reply (the test sees signal 1).
- [ ] The existing "SIGHUP to fm attach detaches without printing and leaves the PTY running" also asserts that deckd received the `detach` request (not only the detached state deckd reports on socket close). Mutation: make the handler call `finish(0)` without sending `detach`; the test fails.

### Task 32: the hooks budget test also kills a hook that hangs before its clock preload

`docs/deck/m2-exit.md` 10.2: `hub/test/contract/hooks.test.mjs` arms its 500 ms kill timer only when
the preload's first clock line arrives (~line 139), so a hook that hangs before the preload writes
is never killed by the test.

**Files:**
- Test: `hub/test/contract/hooks.test.mjs`

- [ ] Arm a second watchdog at spawn that kills the child and fails the test with a distinct message (for example "socket hook never started its clock") if no clock line arrives within a generous startup bound (Node boot under load, for example 10 s). Keep the existing 500 ms timer and the 200 ms budget exactly as they are. Never widen the budget.
- [ ] Mutation: make the preload not write its first line (or have the spawned command sleep before loading it); the test fails with the new message instead of hanging until the runner's timeout.

### Task 33: pin the Team run Stop dialog's Cancel label

`docs/deck/design/components.md:754` and `docs/deck/m2-exit.md` say the Team run Stop dialog passes no
`cancelLabel` and so shows `confirm.cancel` ("Cancel"); nothing tests it.

**Files:**
- Test: `hub/test/unit/team-run.test.mjs`

- [ ] Render the Team run view with the Stop confirmation open (the way the existing Stop tests reach it) and assert the dialog's Cancel button text is the `confirm.cancel` text from `hub/web/src/i18n/en.js`. Mutation: pass `cancelLabel="Keep running"` in `hub/web/src/screens/team-run/TeamRun.jsx`; the test fails.

### Task 35: tier design-oversight review (APR-O1)

**Files:**
- Create: `docs/deck/reviews/2026-10-02-tier-oversight.md`

- [ ] Review `docs/deck/07-approvals.md` (sections 1 to 12, especially 3 Classification, 3.4 Floors, 3.5 File tools and repo scope, 4.3 Default pattern list, 4.4 Worked examples, 5.4 Batch, 6 Rule suggestion, 8 Destructive confirm) as a design-oversight review: where can a wrong default cost the owner data or let a risky action through with one click? Cover at least: in-repo file edits, `git add` / `git commit`, `git push` and force variants, `curl ... | sh` and other pipe-to-shell or download-and-run forms, `rm` inside and outside the repo, package installs, environment and credential files, compound commands, quoting and shell-escape tricks that could make the classifier read a command as lower tier than it is, and the rule writer turning one approval into a broad rule. Apply the owner decisions in the plan header (SM-O9, DRW-O1, SM-O10, SM-O11) as settled.
- [ ] For each finding: severity (high: data loss or an unreviewed Destructive action becomes possible; medium; low), the section and pattern it concerns, a concrete command that shows it, and a proposed change to the default. End with a short list of the questions only the owner can answer. Do not edit 07-approvals.md or any other doc: the owner resolves the findings first.
- [ ] Docs rules: English, plain prose, no em dash, `/home/you` placeholders.

### Task 34: third cleanup docs

**Files:**
- Modify: `docs/deck/m2-exit.md`
- Modify: `docs/deck/05-api.md`
- Modify: `docs/deck/03-architecture.md`
- Modify: `docs/deck/14-decisions.md`
- Modify: `docs/deck/15-open-questions.md`

**Depends:** T31, T32, T33, T35

- [ ] Add section 11, "Third cleanup round, Tasks 31 to 34": each item with its test and the mutation evidence, moving the matching rows out of 10.2; what is still open after it (the owner question on the hook budget, dogfood bug 4).
- [ ] Hook budget: `05-api.md` section 6.2 item 3 and `03-architecture.md` section 2.3 say the 200 ms budget covers the hook's own run, from module load to exit, not Node's interpreter boot (owner decision 2026-10-02), and `hooks.test.mjs` measures that span. Remove the owner question row from m2-exit.
- [ ] `14-decisions.md`: add D-70 to D-74 for the five owner decisions in the plan header other than running the review (hook budget, SM-O9 / DRW-O4, DRW-O1, SM-O10, SM-O11), each with its reason and the docs it touches, in the table's existing shape. `15-open-questions.md`: mark SM-O9, DRW-O4, DRW-O1, SM-O10 and SM-O11 decided with their D numbers; mark APR-O1 / Q4 as "review run 2026-10-02, findings in `reviews/2026-10-02-tier-oversight.md`, owner to resolve before M3" (still open).
- [ ] Cite suite counts from runs on the task's own tip. Docs rules: English, plain prose, no em dash, `/home/you` placeholders.
