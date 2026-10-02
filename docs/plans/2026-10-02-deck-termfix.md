# fleetmates deck terminal fixes Implementation Plan

Source: the owner's report of 2026-10-02 (a screenshot of the Focus terminal): "there's a visual
issue when hovering/clicking inside the deck terminal" and "older runs (that are read only) are
almost unreadable text to a human". Both were diagnosed and reproduced in headless Chromium against
the 2.1.282 screen fixtures the same day. Run deck-tf1, run branch `run/deck-termfix` from
`feat/deck`, in its own worktree because the M3 run occupies the main worktree. Task numbers are
local to this plan.

## Owner decisions (2026-10-02)

- Ship both fixes now in a separate run, ahead of M3. The dogfood update needs a deckd restart; the orchestrator asks the owner before restarting.
- The ended-session history keeps colours: deckd serializes its headless terminal with `@xterm/addon-serialize` (a new pinned hub dependency, same xterm project).

## Diagnosis

- Bug 1 (two background tones after a click or any focus): xterm.js adds the class `focus` to its `.xterm` element when the terminal is focused. The Focus screen root also uses the bare class `.focus` (`hub/web/src/screens/focus/Focus.jsx` around line 484), styled as a three-column grid in `hub/web/src/styles/observe.css` (around lines 298 and 304) and `hub/web/src/styles/focus.css` (around line 75). On focus `.xterm` becomes that grid, `.xterm-scrollable-element` (which carries the theme background `--bg-sunken`) is squeezed into the first column (264 px at 1440 px and wider, 72 px below), and the rest shows xterm.css's `.xterm .xterm-viewport { background-color: #000 }`. Reproduced: before a click the scrollable element is 1356 px wide, after it 264 px; adding `.xterm.focus { display: block }` keeps 1356 px.
- Bug 2 (ended or crashed sessions unreadable): the read-only Focus view writes raw PTY bytes (`GET /api/sessions/:id/scrollback`, stored from deckd's `exit` record `tail`, which is `ring.tail()` of raw output) into an xterm fitted to the browser. Claude Code draws with relative cursor moves, so at any size other than the PTY's the lines overwrite each other; and because Claude's output has almost no LF bytes, the 1,000-line cut is in practice an arbitrary byte cut. Reproduced with `hub/test/fixtures/screens/2.1.282/permission-edit.ansi` (captured at 120x40): rendered at 120x40 the lines `   3. No` and ` Do you want to make this edit to notes.txt?` are present; replayed into a 96x30 terminal both are missing.

## Destination

Clicking or focusing the Focus terminal never changes its layout or background, and the history of an ended or crashed session reads as the screen looked, in colour, at any browser size.

## Out of Scope

- The live attach snapshot (`hub/server/pty-bridge/bridge.mjs`) also replays raw ring bytes, but the browser resize that follows makes Claude Code redraw, so a live view recovers - change it only if a later report shows a live view staying garbled.
- Capturing the alternate screen when a fullscreen program exits (`?1049l`) - no fixture contains that sequence, so the behaviour cannot be pinned here.

## Global Constraints

- Base branch: `feat/deck`. Run branches start from it and the gate compares against it.
- Root package runtime and development dependencies remain zero. The one new hub dependency is `@xterm/addon-serialize` 0.14.0 (Task 2). Hub dependencies stay in
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
- `apiVersion` stays 1 and the deckd protocol stays `proto` 2. Every API and protocol change here is additive (`docs/deck/05-api.md` section 8).
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
  This plan adds no stylesheet.
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

### Task 1: stop the Focus screen class from styling the focused xterm

**Files:**
- Modify: `hub/web/src/screens/focus/Focus.jsx`
- Modify: `hub/web/src/styles/observe.css`
- Modify: `hub/web/src/styles/focus.css`
- Modify: `hub/web/src/styles/terminal.css`
- Test: `hub/test/unit/observe-screens.test.mjs`
- Test: `hub/test/e2e/observe.spec.mjs`
- Test: `hub/test/unit/focus-m2.test.mjs`
- Create: `hub/test/unit/web-css-classes.test.mjs`

- [ ] Rename the Focus screen root class `focus` to `focus-screen` in `Focus.jsx` and in every selector that targets the screen root (`observe.css` around lines 298 and 304, `focus.css` around line 75, and any other bare `.focus` selector in `hub/web/src/styles/`). Keep `focus-*` classes (`focus-terminal`, `focus-details`, `focus-banner` and the rest) unchanged. Update the selectors that name the root in `observe-screens.test.mjs` (around line 597) and `observe.spec.mjs` (around lines 794 and 795) and nothing else in those files; likewise the root class regex in `focus-m2.test.mjs` (around line 315). The width check goes in a Focus history-terminal spec in `observe.spec.mjs` (the live Focus terminal specs live in `control.spec.mjs`, outside this task).
- [ ] `terminal.css`: `.terminal-view .xterm .xterm-viewport { background-color: var(--bg-sunken) }`, so the area outside the scrollable element can never show xterm's default black.
- [ ] `web-css-classes.test.mjs`: read every `hub/web/src/styles/*.css` file, strip comments, and assert that no selector uses a class xterm.js sets at runtime as a bare class: `focus`, `terminal`, `xterm` and any `xterm-*` class, `composition-view`, `scrollbar`, `slider`, `shadow`, `visible`, `invisible`, `fade` (check the list against `hub/node_modules/@xterm/xterm/lib/xterm.mjs` and add any other class it adds with `classList.add`), unless the selector is scoped under `.xterm` or `.terminal-view`. The test names the file and line of an offending selector. Mutation: put `.focus {` back in `observe.css`; the test fails naming that line.
- [ ] `observe.spec.mjs`: in the Focus terminal spec, click the terminal, then assert that the width of `.xterm-scrollable-element` equals the width of `.xterm` (within 1 px) at viewport widths 1480 and 1280. Mutation: restore the bare `.focus` class on the screen root; both widths fail (the scrollable element measures 264 px and 72 px).

### Task 2: deckd keeps a rendered, serialized history of each PTY

**Files:**
- Modify: `hub/deckd/screen-model.mjs`
- Modify: `hub/deckd/main.mjs`
- Modify: `hub/package.json`
- Modify: `hub/package-lock.json`
- Modify: `docs/deck/05-api.md`
- Create: `hub/test/unit/screen-model-history.test.mjs`
- Test: `hub/test/unit/deckd-protocol.test.mjs`

- [ ] Add `@xterm/addon-serialize` 0.14.0 to `hub/package.json` `dependencies`, pinned exactly, and update `hub/package-lock.json` with `npm install --prefix hub --save-exact @xterm/addon-serialize@0.14.0` (no other lockfile change). Confirm it loads into `@xterm/headless` 6.0.0 (`term.loadAddon(new SerializeAddon())`) in the test below; if it does not, report status "blocked" naming the error.
- [ ] `ScreenModel`: `scrollback` becomes 1000 (exported constant `HISTORY_LINES`). New method `history()` returns `{ data, cols, rows }`, where `data` is the serialize addon's output for the scrollback and the screen (`serialize({ scrollback: HISTORY_LINES })`, which keeps colours and attributes) and `cols`/`rows` are the model's size at that moment. `lines()` and the `screen` event keep returning only the visible rows, unchanged.
- [ ] `main.mjs`: the `exit` record gains `history: { data, cols, rows }` taken from the PTY's ScreenModel after `flush()` at exit, with `data` capped at `EXIT_TAIL_BYTES` by dropping whole leading lines (cut after a `\r\n`, never inside an escape sequence or a UTF-8 character). `tail` stays as it is. The `screen` op accepts `history: true` and then answers with a `history` field of the same shape. Both are additive proto 2 fields; a connection with `proto < 2` gets neither, like `tail`.
- [ ] `05-api.md` section 5: document the `history` field of the exit record and of the `screen` reply, and say that `tail` remains the raw ring bytes for compatibility.
- [ ] `screen-model-history.test.mjs`: feed `hub/test/fixtures/screens/2.1.282/permission-edit.ansi` into a ScreenModel at 120x40, take `history()`, write `data` into a fresh `@xterm/headless` Terminal at 96x30 (scrollback 1000), and assert the rendered text contains `   3. No` and ` Do you want to make this edit to notes.txt?`. Mutation: make `history()` return the raw bytes written so far instead of the serialized output; both lines are missing. A second test asserts SGR colour survives: a model fed `\x1b[31mred\x1b[0m` serializes with an SGR 31 sequence before `red` (mutation: serialize with `excludeModes`/plain text; the SGR is gone). A third asserts the cap drops whole leading lines and the result still parses (mutation: cut at a raw byte offset).
- [ ] `deckd-protocol.test.mjs`: a proto 2 connection receives `history` on the exit record and on `screen` with `history: true`; a proto 1 connection receives neither (mutation: send `history` to proto 1).

### Task 3: the server stores and serves the rendered history

**Files:**
- Modify: `hub/server/machines/projector.mjs`
- Modify: `hub/server/launch/launch.mjs`
- Create: `hub/server/screen/history.mjs`
- Modify: `docs/deck/06-storage.md`
- Create: `hub/test/unit/scrollback-history.test.mjs`
- Test: `hub/test/integration/session-actions.test.mjs`

**Depends:** T2

- [ ] `projector.mjs`: when an `exit` event carries `history`, `session_scrollback.text` stores `history.data`; otherwise it stores the raw `tail` as today. No schema change.
- [ ] `history.mjs`: export `renderHistory(text, { cols = 120, rows = 40 } = {})`, which writes `text` into an `@xterm/headless` Terminal of that size (scrollback 1000) with the serialize addon loaded and returns the serialized output. Writing already serialized history through it reproduces the same screen; writing legacy raw bytes through it turns them into absolute-positioned rows (best effort, since their original size is unknown).
- [ ] `launch.mjs` `scrollback()`: for a live PTY, request `screen` with `history: true` and serve `history.data` (falling back to the raw `scrollback` when deckd does not send `history`); for a stored row, serve `renderHistory(stored.text)`. `lastLines` then cuts the served text on `\r\n` line boundaries. The response shape `{ text, source, truncated }` is unchanged.
- [ ] `06-storage.md`: `session_scrollback.text` holds deckd's serialized history when deckd sent one, else the raw tail; legacy raw rows are rendered at 120x40 when served.
- [ ] `scrollback-history.test.mjs`: a stored row holding serialized history from the permission-edit fixture, served through `scrollback()` and written into a 96x30 headless terminal, contains `   3. No` (mutation: serve `stored.text` without `renderHistory` when it is raw, or skip storing `history`). An exit event without `history` stores the raw tail (mutation: store an empty string).
- [ ] `session-actions.test.mjs`: the existing scrollback assertions keep passing; update only those that pinned raw bytes, and list them in the task result.
