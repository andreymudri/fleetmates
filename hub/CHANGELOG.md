# Changelog

The deck package versions on its own, separately from the fleetmates plugin. Releases are tagged
`deck-vX.Y.Z`. Every entry states the Claude Code version its hook fixtures were captured from,
whether `fleetmates-deckd` changed (restarting it ends every PTY session), and whether the database
schema changed.

## v0.4.0 (unreleased)

M4, Meetings. TurbidAssist meetings are recorded, followed and read from the deck over scribed's
socket, with scribed and TurbidAssist unchanged. Prepared, not tagged or published; the exit report
is `docs/deck/m4-exit.md`.

- Tested Claude Code: 2.1.285 (unchanged from 0.3.0)
- deckd changed: no. The deckd protocol is unchanged, so no deckd restart is needed and no PTY
  session ends.
- Database migration: yes (`0005-meetings` adds the `meetings`, `meeting_pins` and
  `meeting_item_dismissals` tables and their triggers)
- Restart the web server (`systemctl --user restart fleetmates-deck`) to pick M4 up. For the dogfood
  deck this is an owner action.

### Added

- Meetings list, detail and search: meetings grouped by day with their post-processing state
  ("Saving the session…", "Transcribing with {model}…", "Summarizing…", "Needs speaker names",
  "Summary failed", "Recording interrupted"), the synthesized note's summary, decisions and action
  items, pinned moments, the full transcript drawer and the `postmeet.log` tail. Search scans every
  meeting's transcript on demand, confidential ones included, and never indexes or caches it.
- Record with a tag from `config.yaml`, the live view (transcript, pins, the transcript-only ask)
  and the recording bar on every screen, with "Pin moment" (`Alt P`) and "Stop and summarize". A
  recording started by another client (the `scribe` CLI, the TUI, a key binding) shows within one
  2 s poll.
- Live ask: scribed's `ask`, over the transcript only and without citations ("Ask · uses the
  transcript"). Answers stream to the browser and are never stored by the deck.
- Action items: "Launch as session" opens the new-session form with the item as the task;
  "Dismiss" with Undo. Home Calm shows "Last meeting" with its first open action item.
- "Start scribed" from the degraded card, Settings and First run runs
  `systemd-run --user --collect --unit=turbidassist-scribed --property=KillMode=process $SHELL -l -c 'exec scribed'`,
  so scribed runs outside the deck's cgroup.
- Settings, Connections: the "TurbidAssist config.yaml" path (default
  `~/dev/turbidassist/config.yaml` when it exists) with "Read {n} tags from {path}." or
  "config.yaml not found at {path}.".
- Quiet mode follows the full recorder: no bell while any client records, popups still show.

### Changed

- `GET /api/version` reports `build: 'm4'`. `apiVersion` stays 1; every API change is additive.
- New API error codes: `unknown_tag` (422), `scribed_refused` (409, scribed's message verbatim),
  `scribed_unavailable` (503, retryable), `not_recording` (409), `ask_in_progress` (409) and
  `dependency_start_failed` (502).
- `POST /api/ask` accepts only the meeting scope (`meeting:<id>`); the vault scope is M5.

### Known limits

- The live ask uses the transcript only; it cannot read your vault and shows no citations.
- Pins are stored by the deck and shown in the deck only; they never reach the meeting note.
- No speaker naming in the deck: a meeting that needs names shows the `postmeet name {session}`
  command to copy.
- Meeting notes are read from disk, read only, from `vault.meetings_folder`; the vault-mcp client is
  M5. The deck never writes to the vault, `session_dir` or `config.yaml`.
- A tag that is not in `config.yaml`, or any meeting while `config.yaml` cannot be read, is treated
  as confidential.
- "Research first" and "Save answer to meeting note" are not shown.

## v0.3.0 (unreleased)

M3, Unblock. Permission prompts and questions of sessions that run in deckd are answered from the
browser, within tier rules the server enforces. Prepared, not tagged or published; the exit report is
`docs/deck/m3-exit.md`.

- Tested Claude Code: 2.1.285 (the 2.1.282 fixture set stays as the earlier regression set)
- deckd changed: yes (the guarded write). Restart `fleetmates-deckd` only when no session you care
  about runs (`fm ls`): restarting it ends every PTY session. Until then answering from the deck is
  refused with `deckd_outdated`, and everything else keeps working with the old deckd.
- Database migration: yes (`0003-archive` adds `sessions.archived_at` and `sessions.archived_by`;
  `0004-approvals` adds `requests.reasons`, `requests.confirm_label` and the `approval_audit` table)

### Added

- Tier classifier: every permission request gets Safe, Caution or Destructive from
  `hub/server/approvals/tiers.default.json` plus your `~/.config/fleetmates/deck/tiers.json`, with
  floors no entry can lower. A Bash command is Safe only when it is plain (simple commands from a
  fixed allowlist, literal words, plain relative paths inside the repo); anything else is at least
  Caution, and unknown commands are Caution. Each request shows why ("reasons") and a one-line
  description.
- Answering: Allow, Deny, Reply and option picks from the Needs-you drawer, Home cards, the palette
  (Enter allows Safe only) and the Focus PromptBar. The deck types the option key Claude Code printed
  into the PTY only when the screen still shows that prompt and nobody typed in the last second, then
  proves the answer by the prompt leaving the screen or a matching hook. No proof within 3 s shows
  "did not land" with Try again; the deck never retries on its own.
- Destructive requests are never answered without the confirm checkbox, never in a batch, never from
  a popup and never by a keyboard shortcut. The checkbox label comes from the matched entry's
  template ("I checked the 3 commits that will be overwritten"), else "I checked what this command
  will change".
- Safe batch ("Allow both Safe once", `Alt Shift A`), and a desktop popup "Allow once" for a single
  Safe request whose whole command it shows. Team "Review N requests" answers only that run's rows.
- After a Deny, "Tell Claude what to do instead" sends your text to the session for 30 s.
- Rules: after the configured number of Safe approvals (5, 3 or Never) the deck offers "Make it a
  rule?". Accepted, hand-added and revoked rules are written to `<repo>/.claude/settings.local.json`
  keeping every other key and the order, with a backup of the previous file. Rules the deck did not
  write show as "added by hand". Rules are suggested only for exact `npm run` and `pnpm run` script
  names and the read-only vault tools; Bash prefix rules are refused.
- Settings, Approval rules: the threshold, the rules of each repo with their source, Add a rule and
  Revoke, the tier aside, and a banner when `tiers.json` has an error (the previous tiers stay in
  force).
- Focus Changes shows the diff of each changed file against the session's review baseline.
- `fleetmates-deck audit [--repo <name>] [--since <YYYY-MM-DD>]` prints the approvals audit and the
  rule audit, oldest first, with summaries redacted.
- Session archive: Archive on a card, "Archive all finished", auto-archive of finished sessions
  after a delay set in Settings, and "Archived (N)" on Home. An archived session that needs you comes
  back by itself.

### Changed

- `GET /api/version` reports `build: 'm3'`. `apiVersion` stays 1; every API change is additive.
- deckd `hello` lists `features: ['guardedWrite']`, and `write` takes a `guard` (screen revision and
  quiet period). The protocol stays `proto` 2.
- Ended and crashed sessions show their stored scrollback at the size it was captured.

### Known limits

- Observed sessions (plain `claude`) are still answered in your terminal; their popups offer "Open"
  only.
- AskUserQuestion prompts with several questions or multi-select options, and MCP elicitation
  dialogs, are answered in the terminal.
- "Allow always" (option 2) is offered only when Claude Code's label is exactly "Yes, and don't ask
  again for <pattern>" and the pattern is the deck's own rule candidate. No captured 2.1.285 Bash
  prompt shows that label, so for Bash it is not offered until a real prompt confirms the wording.
- A running Claude Code session may keep an old rule until it restarts.

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
