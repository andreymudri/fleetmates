# Changelog

The deck package versions on its own, separately from the fleetmates plugin. Releases are tagged
`deck-vX.Y.Z`. Every entry states the Claude Code version its hook fixtures were captured from,
whether `fleetmates-deckd` changed (restarting it ends every PTY session), and whether the database
schema changed.

## v0.2.0 (unreleased)

M2, Control. Every session started with `fm claude` or from the deck runs in a deckd PTY and is
controlled from the browser. Prepared, not tagged or published; the exit report is
`docs/deck/m2-exit.md`.

- Tested Claude Code: 2.1.282
- deckd changed: yes. Restart `fleetmates-deckd` only when no session you care about runs (`fm ls`):
  restarting it ends every PTY session. Until then the new web server keeps working with the old
  deckd, without exit tails, and Settings, Connections says deckd is outdated.
- Database migration: yes (`0002-launch` adds `sessions.launch_task`)

### Added

- deckd protocol 2: `hello` lists the login-environment variable names (never values) that differ
  from the service environment, and exit records carry the last 1,000 lines (at most 256 KiB) of
  output, kept as the crash scrollback. The server still speaks protocol 1.
- Login environment: sessions launched from the deck start with the environment of your login
  shell, captured once when deckd starts, without Claude Code's own per-session variables.
  `fleetmates-deck doctor` names the variables that differ. Set `DECKD_LOGIN_ENV=inherit` to skip
  the probe.
- `fm ls` lists the PTYs deckd runs; `fm attach` takes a PTY id or a repo name; `Ctrl ]` then `d`
  detaches and leaves the session running; `fm claude` runs plain `claude` when deckd is down, and
  that session is observed only.
- Focus mirrors the live terminal through xterm.js: keys typed in the browser reach the PTY, the
  header says who typed last ("Last typed from: terminal" or "browser") and shows a collision chip,
  and Stop, Nudge and Relaunch work. Changes lists files (no diff yet); Facts shows the session
  facts and the review baseline commit.
- New session (`Alt N`, "Launch a ship"): pick a repo from the scan root, type a task, and the deck
  starts `claude` in that repo and types the task once the idle input box appears. A second plain
  session in a busy repo is warned about, with "Run as a fleetmates job".
- Home compact density with live terminal tails, launch and quiet-row Stop and Nudge, palette
  Actions, and Needs-you deep links filtered to a run or a task.
- Team run page, read only: phases, gate verdicts, tasks and teammate tool steps attributed to their
  task, with the plan in a read-only drawer and "Open in editor". Run file changes reach the page
  within about two seconds through a file watch, with the 60 s poll as the fallback.
- Crew sheet with Customize (reroll, color, hat, Undo) and Settings Appearance (text size, motion,
  density).
- A web server restart leaves every PTY running; the browser reconnects and keeps typing into them.
- `hooks` health row: the deck reports missing hooks or a missing hook script without waiting for
  First run.

### Changed

- `GET /api/version` reports `build: 'm2'`. `apiVersion` stays 1; every API change is additive.
- The API body cap is 256 KiB (was 1 MiB), and `Host: localhost:<port>` is answered with 421 and a
  redirect to `127.0.0.1`.
- The M0 spike page and server are gone; `npm run perf` measures keystroke echo through Focus.

### Known limits

- No answering from the browser: approvals and questions are still answered by typing in the
  mirrored terminal. Answer buttons come in M3.
- No diff view: Changes lists the changed files only.
- Teammates have no terminal of their own; the Team run page shows their tool steps only.

## v0.1.0 (unreleased)

M1, Observe. The first public release is prepared but not published. Publishing waits for the
owner's dogfood week, manual smoke test, design QA, clean install on a fresh account and the
package name decision (see `docs/deck/m1-exit.md`).

- Tested Claude Code: 2.1.282
- deckd changed: yes (first release)
- Database migration: yes (initial schema `0001-init`)

### Added

- Hook ingestion. `deck-hook` runs as a user-level async hook for every Claude Code session,
  sends one line to `$XDG_RUNTIME_DIR/fleetmates-deck/hooks.sock`, and spools to a private file
  when the web server is down. It never writes stdout and never blocks Claude Code.
- A web server on `127.0.0.1` with SQLite storage (`node:sqlite`), a token in a 0600 file, and
  Host and Origin checks on every API request and WebSocket upgrade. The browser gets a snapshot,
  then replay by sequence number after a reconnect.
- Session, request and count machines for observed sessions: running, needs approval, asked you,
  idle, stale, done and reviewed, with open requests and the counts in the header.
- The fleetmates run reader, so team runs show as team cards.
- Desktop notifications through `notify-send`, a bell when the tab is hidden, re-notify, notify
  on done, and quiet mode while TurbidAssist records.
- Screens: Home (comfortable grid, quiet row, crowding strip, calm), palette, read-only Needs-you
  drawer, read-only Focus, First run, Settings (Notifications, Connections, Rules, Appearance),
  failure and loading states, crew avatars. English only; `DECK_LANG=pt` falls back to English
  with a notice.
- `fleetmates-deck init [--dry-run] [--rotate-token]`, `doctor`, `status`, `open` and
  `uninstall-hooks`, and the two systemd user units `fleetmates-deckd.service` and
  `fleetmates-deck.service`.
- From a fleetmates checkout, `node scripts/cli.mjs ui` and `node scripts/cli.mjs deck <cmd>`
  forward to `fleetmates-deck`.
- CI (`deck.yml`) and a release workflow (`deck-release.yml`) with npm provenance, a package
  contents check and a clean-install rehearsal.

### Known limits

- Observe only. Answering requests and launching sessions from the browser come in M2 and M3.
- Changed-line counts on edit steps are always empty: the hook does not forward tool responses.
