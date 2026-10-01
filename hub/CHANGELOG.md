# Changelog

The deck package versions on its own, separately from the fleetmates plugin. Releases are tagged
`deck-vX.Y.Z`. Every entry states the Claude Code version its hook fixtures were captured from,
whether `fleetmates-deckd` changed (restarting it ends every PTY session), and whether the database
schema changed.

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
