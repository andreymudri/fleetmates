# Session archive

The session archive keeps Home to the sessions the owner still cares about. Any session can be archived in one
action, finished sessions archive themselves after a delay chosen in Settings, an archived session comes back by
itself the moment it needs the owner, and every archived session stays reachable read-only behind "Archived (N)".

Plan: `docs/plans/2026-10-02-deck-archive.md` (run deck-ar1, run branch `run/deck-archive` from `feat/deck`).

## 1. Owner decisions (2026-10-02)

- Any session can be archived, live ones included. An archived session that starts needing the owner (any open
  request) is unarchived automatically.
- Manual Archive per session, "Archive all finished", and auto-archive of finished sessions after a delay chosen in
  Settings (default 24 hours, or Never). A session with unreviewed changes is never auto-archived and never swept
  by "Archive all finished".
- Archived sessions are hidden from Home, the Focus ship list and the palette. An "Archived (N)" toggle at the
  bottom of the Home list shows them read-only, each with Unarchive. History stays under normal retention.
- A small run right after the terminal fixes, shipped to dogfood the same way, while M3 continues in parallel.

## 2. Definitions

- Archived: `sessions.archived_at` is not null. `archived_by` is `'owner'` or `'auto'`.
- Unreviewed changes: `json_array_length(sessions.changed_files) > 0`. Mark reviewed empties `changed_files`, so a
  reviewed session has none.
- Finished: `sessions.alive = 0` and no open request for the session.
- Auto-archive candidate: finished, not archived, no unreviewed changes, and
  `coalesce(ended_at, state_since) <= now - autoArchiveAfter hours`. `autoArchiveAfter` null means never.
- Needs the owner: the session has at least one row in `requests` with `state = 'open'`.

Storage: migration `0003-archive.sql` adds `sessions.archived_at` (ms) and `sessions.archived_by`, and the partial
index `sessions_archived` (`docs/deck/06-storage.md`). Retention is unchanged: an archived ended session is deleted
after 30 days like any ended session.

## 3. Routes and the pref

All three routes are body-less POSTs and keep the token, Host and Origin checks of `05-api.md` section 1
(`hub/test/e2e/security.spec.mjs` lists them and proves each refuses a missing or wrong token).

| Route | Answer |
|---|---|
| `POST /api/sessions/:id/archive` | `{ session }` archived by `'owner'`; 404 `not_found`; 409 `needs_you` when the session has an open request |
| `POST /api/sessions/:id/unarchive` | `{ session }` with `archivedAt` and `archivedBy` null; 404 `not_found` |
| `POST /api/sessions/archive-finished` | `{ ids }`: every finished, not archived session without unreviewed changes, archived by `'owner'` |
| `GET /api/sessions?archived=1` | only archived sessions of any age, newest `archivedAt` first, then `id`; `nextBefore` is the opaque cursor `<archivedAt>:<id>` |
| `GET /api/sessions?archived=0` | only sessions that are not archived |

Session views carry `archivedAt` (ms or null) and `archivedBy` (`'owner'`, `'auto'` or null). The `counts` event
carries `archived`, the number of archived sessions in any state, and the other counts ignore archived sessions.

The pref `autoArchiveAfter` lives in the SQLite `prefs` table, default 24, and accepts exactly 6, 12, 24, 72, 168
or null (Never). The server sweeps once at start, every 10 minutes (the `archiveSweepMs` server option overrides
the interval in tests), and once right after a `prefs.changed` that changes the value. A sweep archives every
auto-archive candidate with `archivedBy: 'auto'`.

## 4. What Archived looks like

- Home, the Focus ship list and the palette skip archived sessions.
- Session cards that are not running a turn, and every quiet card, have "Archive" in their footer. The Focus header
  has "Archive", or "Unarchive" for an archived session. The palette has "Archive session" for the focused session.
- "Archive all finished" sits next to the Home title while at least one session qualifies as the client sees it
  (not alive, no open request, no `changedFiles`, not archived).
- Toasts: "Session archived" with Undo, "Session restored", "Archived {n} finished sessions" with Undo that
  unarchives exactly those ids, "This session needs you. Answer it first." for a refused archive, and
  "Could not change the archive: {message}" for any other failure.
- "Archived (N)" at the bottom of the Home list, hidden while N is 0, expands in place into a paged list (20 a page,
  "Show more" while a page comes back full). Each row shows the task, the repo, how long ago it was archived and by
  whom ("archived automatically" or "archived by you"), an Open link and Unarchive. The expanded state is kept per
  browser in localStorage under `deck.archivedOpen`.
- Focus on an archived session shows "Archived. Unarchive to bring it back to Home." with Unarchive, a read-only
  terminal, and no Stop or Nudge, also for a live session.
- Settings, Appearance: "Archive finished sessions after" with 6 hours, 12 hours, 24 hours, 3 days, 1 week and
  Never, and the help text "Sessions with unreviewed changes are never archived automatically."

## 5. Unpinned and out of scope

- The server still accepts stop, nudge and terminal input for an archived live session; only the UI hides them.
  Checked by search only: `grep -ln archiv` over `hub/server/launch/*.mjs`, `hub/server/pty-bridge/*.mjs` and
  `hub/server/ws/*.mjs` finds nothing. No test runs those routes against an archived session.
- Team cards still show an archived lead session: `teamCards` in `hub/web/src/screens/home/Home.jsx` builds its
  members from every session without an archive check. Checked by search only; no test pins it either way.
- Phase 1 test gaps the review named and this run left open: the `order.changed` order that `urgencyOrder`
  produces once archived sessions leave it, the deck-store rejoin guards for ended sessions, and the request filter
  in the counts query.
- Out of scope by the plan: deleting sessions early, archiving teams or runs as a unit, and notifications for
  archived live sessions (an archived session that needs the owner is unarchived first).

## 6. Results of run deck-ar1 (task 6, measured 2026-10-03 on the task branch forked from `run/deck-archive` 20c7fc4)

- `npm --prefix hub test`: 1021 tests, 1021 pass. The e2e specs are not in its glob.
- Root `npm test`: 2796 tests, 2779 pass, 0 fail, 17 skipped.
- `hub/test/e2e/archive.spec.mjs`: 5 tests, 5 pass, in headless `/usr/bin/chromium`. It covers archive from a card
  and Unarchive from "Archived (1)", "Archive all finished" leaving a session with unreviewed changes on Home, an
  archived live session coming back needing the owner after a `PermissionRequest` hook without a reload, the sweep
  after setting 6 hours in Settings (a session ended 7 hours ago is archived by `'auto'`, one ended 5 hours ago is
  not), and 25 sessions archived by one "Archive all finished" paged through "Show more" with each listed once.
  The clock is injected through hook timestamps: a session's `ended_at` is the `hookTs` of its SessionEnd.
- `hub/test/e2e/security.spec.mjs`: 14 tests, 14 pass, with the three archive routes asserted in the router table.
- The other e2e specs (`observe`, `control`, `accessibility`, `settings-save`): 85 tests, 83 pass, 2 fail. Both
  failures are in `observe.spec.mjs` and both count the new Archive buttons: "Home AC8 and read-only" asserts
  `no button or input inside any card` and finds seven `card-archive` buttons, and "Focus AC1, AC8, steps and
  ?tab=facts" asserts `only tabs are buttons` and finds one more button. Those assertions pin the behaviour before
  the archive actions and need an owner decision; this run did not change them.
- Mutations run against the archive specs, each failing the named test and then restored: dropping the archived
  filter in `homeLayout`; skipping `projector.unarchive` in the unarchive route; dropping the `changed_files`
  condition in `archive.mjs`; removing the `unarchiveNeedingOwner` call in the projector commit; removing the sweep
  after `prefs.changed` in `main.mjs`; passing the last row's `archivedAt` instead of `list.next` in the Home
  `more` handler; and renaming the `sessions/archive-finished` route literal (the security spec).
