# fleetmates deck session archive Implementation Plan

Source: the owner's request of 2026-10-02, "it would be nice to have an option to archive sessions,
so the page doesn't get polluted", and the owner decisions below. Run deck-ar1, run branch
`run/deck-archive` from `feat/deck`, in its own worktree because the M3 run occupies the main
worktree. Task numbers are local to this plan. The M3 run renamed its migration to `0004-approvals.sql`
so this run owns `0003-archive.sql`.

## Owner decisions (2026-10-02)

- Any session can be archived, live ones included. An archived session that starts needing the owner (any open request) is unarchived automatically.
- Manual Archive per session, "Archive all finished", and auto-archive of finished sessions after a delay chosen in Settings (default 24 hours, or Never). A session with unreviewed changes is never auto-archived and never swept by "Archive all finished".
- Archived sessions are hidden from Home, the Focus ship list and the palette. An "Archived (N)" toggle at the bottom of the Home list shows them read-only, each with Unarchive. History stays under normal retention.
- A small run right after the terminal fixes, shipped to dogfood the same way, while M3 continues in parallel.

## Definitions (used by every task, quoted verbatim in code comments where they apply)

- Archived: `sessions.archived_at` is not null. `archived_by` is `'owner'` or `'auto'`.
- Unreviewed changes: `json_array_length(sessions.changed_files) > 0`. Mark reviewed empties `changed_files`, so a reviewed session has none.
- Finished: `sessions.alive = 0` and no open request for the session.
- Auto-archive candidate: finished, not archived, no unreviewed changes, and `coalesce(ended_at, state_since) <= now - autoArchiveAfter hours`. `autoArchiveAfter` null means never.
- Needs the owner: the session has at least one row in `requests` with `state = 'open'`.

## Destination

Home shows only sessions the owner still cares about: any session can be archived in one action, finished ones archive themselves after the chosen delay, an archived session comes back by itself the moment it needs the owner, and every archived session stays reachable read-only behind "Archived (N)".

## Out of Scope

- Deleting sessions early - retention already deletes ended sessions after 30 days, archived or not, and the owner asked to keep history.
- Archiving teams or runs as a unit - the request was about sessions; a run's crew rows follow their own sessions.
- Notifications for archived live sessions - an archived session that needs the owner is unarchived first, so the existing needs-you notifications apply unchanged.

## Global Constraints

- Base branch: `feat/deck`. Run branches start from it and the gate compares against it.
- Root package runtime and development dependencies remain zero. No new hub dependency. Hub dependencies stay in
  `hub/package.json` and `hub/package-lock.json`, pinned to exact versions.
- Node >= 24.2.0. Use built-in `node:sqlite`, `node:http` and ESM `.mjs` for the server and deckd.
- Hub tests run with a short TMPDIR: `mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm --prefix hub test`.
  Unix socket paths are limited to about 108 bytes. Tests use temporary HOME, XDG and runtime
  directories, never the owner's live settings, shell profile or services.
- Never run real Claude Code in a test. Use `hub/test/fake-claude/fake-claude.mjs` (through
  `hub/test/helpers/fake-bin.mjs`), `hub/test/integration/stubs/claude` and the captured 2.1.282
  and 2.1.285 fixtures. Do not recapture fixtures; that needs the owner's separate authorization. Never run a
  bare `node --test` at the repo root: its glob reaches `hub/test/capture/capture-cc.mjs`.
- Any test that starts deckd passes an explicit login environment (`startDeckd({ loginEnv })`), so
  no test ever runs the owner's `$SHELL -l -i`.
- The web server binds IPv4 loopback only. Every new `/api/*` route and the WebSocket keep the
  token, Host and Origin checks of `docs/deck/05-api.md` section 1 and `docs/deck/08-security.md`
  sections 4.1 and 4.2. New routes are written in the shapes `route === '<literal>'` or
  `s[1] === '<resource>' && s.length === N && s[3] === '<action>'` inside the matching method block
  of `hub/server/http/api.mjs`, because `routerTable()` in `hub/test/e2e/security.spec.mjs` reads
  those shapes to prove every route refuses a missing or wrong token.
- `apiVersion` stays 1 and the deckd protocol stays `proto` 2; deckd is not changed. Every API change here is additive (`docs/deck/05-api.md` section 8).
- The server never logs prompt text, tool input, environment values or the token.
- Persist private state with 0600 files and 0700 directories. Child processes are started with an
  argv array, never a shell string, with a timeout, and without the deck token in their environment
  (`docs/deck/08-security.md` section 4.8).
- Untrusted text (hook payloads, PTY screen rows, run files, plan markdown, repo names, tasks) is
  rendered as text, never as HTML. No `dangerouslySetInnerHTML`.
- Screen copy lives in each screen's own frozen `*_COPY` object read through `translate` from
  `hub/web/src/components/StatusPill.jsx`, as the M1 screens do; `hub/web/src/i18n/en.js` keeps the
  shell keys. Copy strings are the ones quoted in this plan, verbatim.
- Components and screens never import CSS (the vite `runnerImport` test loader cannot load it).
  Styles go in the existing stylesheets named in each task.
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

### Task 1: archive state, auto-unarchive and the sweep in the server machines

**Files:**
- Create: `hub/server/db/migrations/0003-archive.sql`
- Create: `hub/server/machines/archive.mjs`
- Modify: `hub/server/machines/projector.mjs`
- Modify: `hub/server/machines/counts.mjs`
- Modify: `docs/deck/06-storage.md`
- Test: `hub/test/unit/db.test.mjs`
- Create: `hub/test/unit/archive.test.mjs`
- Test: `hub/test/unit/machines.test.mjs`

- [ ] **Step 1:** `0003-archive.sql`: `ALTER TABLE sessions ADD COLUMN archived_at INTEGER;`, `ALTER TABLE sessions ADD COLUMN archived_by TEXT CHECK (archived_by IS NULL OR archived_by IN ('owner','auto'));`, and `CREATE INDEX sessions_archived ON sessions(archived_at) WHERE archived_at IS NOT NULL;`. `db.test.mjs`: the fresh-database version assertion becomes 3, the v1 to latest test expects 3, and a new test migrates a version 2 database to 3 with a `deck.db.pre-0003.bak` backup and both columns present (mutation: drop the backup call; the test fails).
- [ ] **Step 2:** `archive.mjs` exports, all synchronous over the store and called inside a projector `commit`:
  - `archiveSession(store, id, { by, at })`: sets `archived_at = at`, `archived_by = by`. Refuses with `{ ok: false, code: 'needs_you' }` when the session needs the owner, `{ ok: false, code: 'not_found' }` for an unknown id, and is a no-op returning `{ ok: true, changed: false }` when already archived.
  - `unarchiveSession(store, id)`: clears both columns; `{ ok: true, changed }`.
  - `archiveFinished(store, { at })`: archives with `by: 'owner'` every session that is finished, not archived and has no unreviewed changes; returns the ids.
  - `autoArchiveCandidates(store, { at, afterHours })`: the ids matching the Definitions; `afterHours` null returns `[]`.
  - `unarchiveNeedingOwner(store)`: clears archive on every archived session that needs the owner; returns the ids.
- [ ] **Step 3:** `projector.mjs`: `sessionView` adds `archivedAt` (number or null) and `archivedBy`. Inside `commit`, after `fn` and before the order event, call `unarchiveNeedingOwner` and append one `session.upserted` for each id it returns, so every path that opens a request (hooks, late reconcile, screen parse) unarchives in the same transaction. Add projector methods `archive(id, by)`, `unarchive(id)`, `archiveFinished()` and `autoArchive(afterHours)` that run the `archive.mjs` functions in `commit`, append `session.upserted` per changed session and one `counts`, and return the changed ids (or the refusal).
- [ ] **Step 4:** `counts.mjs`: `projectCounts` and `projectHome` ignore archived sessions (`archived_at IS NULL` in their queries), and `projectCounts` adds `archived`: the number of archived sessions of any state.
- [ ] **Step 5:** `06-storage.md`: document the two columns and the index in section 4.3 and section 12, the migration in section 7, and that retention is unchanged (archived ended sessions are deleted after 30 days like any ended session). No em dash.
- [ ] **Step 5b:** `machines.test.mjs`: the zero-counts assertion ('new deck has zero counts before any session arrives') gains `archived: 0`; change no other assertion there.
- [ ] **Step 6:** Tests in `archive.test.mjs` (use `openDeckDb` plus `createProjector`, and the 2.1.282 hook fixtures as `machines.test.mjs` does), each with its mutation:
  - archive then unarchive round trip, with `session.upserted` carrying `archivedAt` and `archivedBy` (mutation: omit `archivedAt` from `sessionView`);
  - archiving a session with an open request is refused with `needs_you` (mutation: skip the check);
  - an archived live session that receives a `PermissionRequest` hook is unarchived in the same commit, and the `request.opened` and its `session.upserted` (with `archivedAt: null`) are both published (mutation: remove the `unarchiveNeedingOwner` call);
  - `archiveFinished` skips live sessions, sessions with an open request and sessions with unreviewed changes, and takes ended, reviewed and crashed sessions without changes (mutation: drop the `changed_files` condition);
  - `autoArchiveCandidates` with `afterHours` 24 takes a session ended 25 hours ago, not one ended 23 hours ago, not one with unreviewed changes, and none when `afterHours` is null (mutation: use `>=` instead of `<=` in the age comparison);
  - `projectCounts` excludes archived sessions from `needYouSessions`, `running` and `toReview` and reports `archived` (mutation: drop the `archived_at IS NULL` filter).

### Task 2: archive routes, the auto-archive pref and the sweep timer

**Files:**
- Modify: `hub/server/http/api.mjs`
- Modify: `hub/server/main.mjs`
- Modify: `docs/deck/05-api.md`
- Create: `hub/test/integration/archive-api.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Routes in the existing POST block, in the shapes the Global Constraints require: `POST /api/sessions/:id/archive` (body-less; 404 unknown, 409 `needs_you` when refused, 200 `{ session }` otherwise, archived by `'owner'`), `POST /api/sessions/:id/unarchive` (200 `{ session }`), and `POST /api/sessions/archive-finished` (route literal `sessions/archive-finished`, body-less, 200 `{ ids }`). None takes a body, so `postBodyRoutes` is unchanged.
- [ ] **Step 2:** `GET /api/sessions` accepts `archived=1` (only archived, any age, newest `archived_at` first, honouring `limit` and `before`) and `archived=0` (only not archived); without the parameter it behaves as today. The WebSocket snapshot keeps its 24-hour rule and includes `archivedAt` through `sessionView`; `counts.archived` reaches the client through the existing `counts` event.
- [ ] **Step 3:** Pref `autoArchiveAfter`: default 24, stored in the DB `prefs` table (not `configKeys`), `validatePref` accepts exactly `[6, 12, 24, 72, 168, null]`.
- [ ] **Step 4:** `main.mjs`: an auto-archive sweep runs once at start and every 10 minutes (an `unref()`'d interval pushed to `timers`, injectable through a new `archiveSweepMs` option for tests), reading `autoArchiveAfter` through `api.preferences()` and calling `projector.autoArchive(afterHours)` with `archived_by = 'auto'`. A `prefs.changed` for `autoArchiveAfter` triggers one sweep immediately.
- [ ] **Step 5:** `05-api.md`: the three routes, the `archived` query, the `archivedAt` and `archivedBy` session fields, `counts.archived` and the `autoArchiveAfter` pref. No em dash.
- [ ] **Step 6:** Tests in `archive-api.test.mjs` (use the `row(deck, id, fields)` pattern of `hub/test/integration/session-actions.test.mjs` and the `harness` of `hub/test/integration/server.test.mjs`), each with its mutation: archive, then GET `archived=1` lists it and GET `archived=0` does not (mutation: ignore the query); archive of a session with an open request is 409 `needs_you`; `archive-finished` returns only the eligible ids; a request without the token is 401 on each new route (mutation: none needed, the router enforces it; assert it anyway); PATCH `autoArchiveAfter` to 7 is 422 and to 168 succeeds; with `archiveSweepMs` 50 and `autoArchiveAfter` 6, a session ended 7 hours ago (injected `now`) is archived by `'auto'` within one sweep and one ended 5 hours ago is not (mutation: skip the sweep at start and stretch the interval); a live archived session that gets a permission hook through `POST /hook` is unarchived and its WebSocket `session.upserted` carries `archivedAt: null`.

### Task 3: web store and actions for archive

**Files:**
- Modify: `hub/web/src/state/deck-store.js`
- Modify: `hub/web/src/state/actions.js`
- Test: `hub/test/unit/web-shell.test.mjs`
- Test: `hub/test/unit/web-actions.test.mjs`

- [ ] **Step 1:** `actions.js`: `archiveSession(api, id)`, `unarchiveSession(api, id)`, `archiveFinished(api)` and `fetchArchived(api, { before, limit })` (`GET /api/sessions?archived=1`), each encoding the id with `encodeURIComponent` and returning the body or throwing the `ApiError`.
- [ ] **Step 2:** `deck-store.js`: `session.upserted` keeps `archivedAt` and `archivedBy` on the row and removes an archived id from `data.order`; a new selector `visibleSessions(state)` returns the sessions that are not archived, and `archivedCount(state)` returns `data.counts.archived ?? 0`. Alt digit keys use only non-archived ids.
- [ ] **Step 3:** Tests, each with its mutation: `web-actions.test.mjs` checks each helper's method and path, with an id containing `/` encoded as one segment (mutation: skip `encodeURIComponent`); `web-shell.test.mjs` checks that an upsert with `archivedAt` set drops the id from `order` and from `visibleSessions`, and an upsert with `archivedAt: null` brings it back (mutation: keep archived ids in `order`). Change no existing assertion.

### Task 4: Settings, auto-archive delay

**Files:**
- Modify: `hub/web/src/screens/settings/Settings.jsx`
- Test: `hub/test/unit/setup-screens.test.mjs`

- [ ] **Step 1:** In the Appearance section, after the density control, a select labelled "Archive finished sessions after" with options "6 hours" (6), "12 hours" (12), "24 hours" (24), "3 days" (72), "1 week" (168) and "Never" (null), saved through the existing `savePref` path as `autoArchiveAfter`, showing the env/read-only lock the other prefs use. Help text under it: "Sessions with unreviewed changes are never archived automatically." Copy keys go in `SETTINGS_COPY`.
- [ ] **Step 2:** Test in `setup-screens.test.mjs`: the select renders the six options with 24 selected by default, and choosing Never PATCHes `{ autoArchiveAfter: null }` (mutation: send 0 for Never). Change no existing assertion other than one that counts Appearance controls, if any, and name it.

### Task 5: archive actions and the Archived list on Home, Focus and the palette

**Files:**
- Modify: `hub/web/src/screens/home/Home.jsx`
- Modify: `hub/web/src/components/SessionCard.jsx`
- Modify: `hub/web/src/screens/focus/Focus.jsx`
- Modify: `hub/web/src/screens/palette/Palette.jsx`
- Modify: `hub/web/src/styles/observe.css`
- Create: `hub/test/unit/archive-web.test.mjs`
- Test: `hub/test/unit/observe-screens.test.mjs`
- Test: `hub/test/unit/focus-m2.test.mjs`

**Depends:** T3

- [ ] **Step 1:** Hidden when archived: `homeLayout`, `Calm`, the Focus `SessionList` and `paletteModel` skip sessions with `archivedAt` set (through `visibleSessions` where a list is built from the store).
- [ ] **Step 2:** Actions, each a plain button that calls the Task 3 helper and shows a toast with Undo (Undo calls the opposite helper); no confirm dialog, because archive is reversible:
  - `QuietCard` actions row gains "Archive"; `SessionCard` gains "Archive" in its footer for sessions that are not running a turn (`state` not `running` or `starting`).
  - Focus header `.focus-actions` gains "Archive" (or "Unarchive" when archived).
  - Palette gains the action row "Archive session" for the focused session.
  - Home gains "Archive all finished" next to the list heading, shown only when at least one session qualifies by the Definitions as the client sees them (not alive, no open request, no `changedFiles`, not archived); the toast reads "Archived {n} finished sessions" with Undo that unarchives exactly those ids.
  - A refused archive (409 `needs_you`) shows "This session needs you. Answer it first." and changes nothing.
  - Toasts: "Session archived" with Undo, "Session restored".
- [ ] **Step 3:** At the bottom of the Home list, a toggle "Archived (N)" (N from `archivedCount`, hidden when 0) that expands an in-place list fetched with `fetchArchived` (paged, "Show more" when a page is full): each row shows the session name or task, repo, how long ago it was archived and by whom ("archived automatically" when `archivedBy` is `'auto'`), an "Open" link to the read-only Focus view and an "Unarchive" button. The expanded state is remembered per browser in localStorage under `deck.archivedOpen` through the existing guarded storage helpers.
- [ ] **Step 4:** Focus for an archived session: a banner "Archived. Unarchive to bring it back to Home." with an Unarchive button; the terminal is read-only and Stop and Nudge are hidden while it is archived, also for a live session.
- [ ] **Step 5:** Styles for the new rows, the toggle and the banner in `observe.css`, using existing tokens only.
- [ ] **Step 6:** Tests in `archive-web.test.mjs` (render with the existing harness helpers; one headless-Chromium test of the real Home route with a recording API double, as `focus-m2.test.mjs` does), each with its mutation: an archived session is absent from Home, the Focus list and the palette (mutation: drop the filter in `homeLayout`); Archive posts `/api/sessions/<id>/archive` and Undo posts `/unarchive` (mutation: Undo calls archive again); "Archive all finished" is hidden when nothing qualifies and excludes a session with `changedFiles` (mutation: drop the `changedFiles` check); the Archived toggle shows N, fetches `archived=1` on expand and Unarchive removes the row (mutation: never refetch); a 409 shows the needs-you text; Focus on an archived live session renders read-only with no Stop (mutation: keep Stop). In `observe-screens.test.mjs` and `focus-m2.test.mjs` change only assertions that counted list rows or header buttons the new controls change, and name them.

### Task 6: end-to-end archive flow and the run report

**Files:**
- Create: `hub/test/e2e/archive.spec.mjs`
- Modify: `hub/test/e2e/security.spec.mjs`
- Test: `hub/test/e2e/observe.spec.mjs`
- Create: `docs/deck/archive.md`

**Depends:** T2, T4, T5

- [ ] **Step 1:** `archive.spec.mjs` against a real deck server (the `startDeck` and `openDeck` helpers of `observe.spec.mjs`, headless `/usr/bin/chromium`): archive a finished session from its card and see it leave Home and appear under "Archived (1)"; Unarchive brings it back; "Archive all finished" leaves a session with unreviewed changes in place; an archived live session that receives a permission hook reappears on Home with its needs-you state without a reload; set "Archive finished sessions after" to 6 hours with an injected clock and see an old finished session move to Archived after a sweep (mutation for each: the corresponding server or web line from Tasks 1, 2 and 5, named in the result).
- [ ] **Step 2:** `security.spec.mjs`: the route table now includes the three new routes, and each refuses a missing or wrong token (the existing loop; add the routes to its expected list only if the test enumerates them explicitly).
- [ ] **Step 2b:** `observe.spec.mjs`: the M1 read-only assertions at the "Home AC8 and read-only" test (no button or input inside any card) and the "Focus AC1, AC8, steps" test (only tabs are buttons) now exclude exactly the archive control (the card `.card-archive` button and the Focus header Archive or Unarchive button), because archiving changes deck metadata and never acts on the session. Every other control must still be absent; change no other assertion, and record in `docs/deck/archive.md` that read-only views now carry the archive control.
- [ ] **Step 3:** `docs/deck/archive.md`: the owner decisions, the Definitions, the routes and the pref, what Archived looks like, and the measured results of this run (test counts, the e2e run). No em dash, placeholders for personal paths.
