# fleetmates deck

A local web deck for your Claude Code sessions. It shows which session is working, which one needs
you, and which one finished, sends a desktop popup when one is waiting on you, and, for sessions
started with `fm claude` or from the deck, mirrors the live terminal in the browser so you can type
into it.

![Home with nine sessions, three of them waiting on you](https://raw.githubusercontent.com/andreymudri/fleetmates/master/hub/docs/screenshots/home.png)

**Status: 0.2.0, not published yet.** This is milestone M2, Control, on top of M1, Observe. The package name
(`@andreymudri/fleetmates-deck`) and the command names (`fleetmates-deck`, `fm`) are still an open
decision and may change before the first release.

## What M1 does

- Observes plain Claude Code sessions through user-level async hooks. Nothing about how you start
  `claude` changes.
- Home shows every session as a card with its state (running, needs approval, asked you, idle,
  no activity, done, reviewed), open requests, and counts in the header. A palette (`Alt K`) jumps
  to any session; the Needs-you drawer lists what is waiting.
- Desktop popups and a bell when a session needs you or finishes, with re-notify, and quiet mode
  while a TurbidAssist meeting records.
- Shows fleetmates team runs as team cards.
- First run checks your setup; Settings holds notification and connection preferences.

Plain `claude` sessions stay observed only: the deck watches them through the hooks and cannot type
into them.

## What M2 adds

- Run `claude` through the deck's PTY daemon, `fleetmates-deckd`, with `fm claude [args]` instead
  of `claude [args]`. The session behaves as before in your terminal, and the deck can show and
  drive it.
- Focus (`/s/<id>`) mirrors the live terminal. Keys typed in the browser reach the session; the
  header says whether the terminal or the browser typed last and flags a collision when both type at
  once. Stop, Nudge and Relaunch work from Focus; Home's quiet row has Stop and Nudge, and the
  palette has launch actions.
- Launch from the deck: "Launch a ship" on Home or `Alt N` opens New session. Pick a repo found
  under the scan root (`~/dev` by default), type a task, and the deck starts `claude` in that repo
  and types the task once Claude Code shows its idle input box. A second plain session in a repo
  that is already busy gets a warning and the choice "Run as a fleetmates job".
- Home has a compact density with live terminal tails. Fleetmates runs have a read-only Team run
  page with phases, gates, tasks, teammate tool steps and the plan. The Crew sheet customizes each
  repo's crew member, and Settings, Appearance sets text size, motion and density.
- Restarting the web server leaves every `fm claude` and launched session running; the browser
  reconnects and keeps typing into them.

### The `fm` command

| Command | Does |
|---|---|
| `fm claude [args]` | Starts `claude [args]` inside deckd and attaches this terminal to it |
| `fm attach <id\|repo>` | Attaches this terminal to a session deckd already runs, by PTY id or by repo name (refused when the repo has several) |
| `fm ls` | Lists the sessions deckd runs: id, repo, pid, start time and attached clients |
| `Ctrl ]` then `d` | Detaches this terminal; the session keeps running in deckd. `Ctrl ]` twice sends one `Ctrl ]` |

If deckd is not running, `fm claude` says so and runs plain `claude` with the same arguments, so
you are never blocked; that session is observed only. `fm attach` and `fm ls` exit 2 when deckd is
not running.

### Login environment

Sessions launched from the deck start with the environment of your login shell, not the bare
environment of the systemd service: deckd runs your shell once as a login shell when it starts and
keeps what it prints, without Claude Code's own per-session variables. `fleetmates-deck doctor`
names (never shows the values of) the variables that differ from the service environment. deckd
reads your profile only when it starts, so after you change your shell profile, restart deckd:
`systemctl --user restart fleetmates-deckd`. That ends every session running inside deckd, so do it
when none you care about runs (`fm ls`). Sessions started with `fm claude` take the environment of
the terminal you run it in.

### M2 limits

- No answering from the browser yet: approval prompts and questions are answered by typing in the
  mirrored terminal (or your own terminal). Answer buttons come in M3.
- No diff view: Focus, Changes lists the changed files only.
- Fleetmates teammates have no terminal of their own; the Team run page shows their tool steps.

## Requirements

- Linux with systemd user services. macOS, Windows and WSL are not supported.
- Node.js 24.2 or newer. CI uses the version in `hub/.node-version`.
- Claude Code. The hook fixtures were captured from Claude Code 2.1.282; `fleetmates-deck doctor`
  tells you when yours differs.
- Chromium or Firefox.
- For popups: `notify-send` (libnotify) and a notification daemon such as mako.
- Build tools for `node-pty` only if no prebuilt binary matches your platform.

## Install and first run

Until the package is published, install from a clone of the fleetmates repository:

    git clone https://github.com/andreymudri/fleetmates.git
    cd fleetmates/hub
    npm ci
    npm run build
    node bin/fleetmates-deck.mjs init
    node bin/fleetmates-deck.mjs open

`npm link` from `hub/` puts `fleetmates-deck` and `fm` on your PATH. From the repository root,
`node scripts/cli.mjs deck <cmd>` and `node scripts/cli.mjs ui` forward to the same commands.

After the release, the install will be:

    npm install -g @andreymudri/fleetmates-deck
    fleetmates-deck init
    fleetmates-deck open

`init` creates the private directories, copies the hook script, adds the deck's hooks to
`~/.claude/settings.json` (after writing a backup next to it), creates the token, writes and starts
the two systemd user units, then runs the setup checks. `init --dry-run` prints what it would do and
writes nothing. Running `init` again changes nothing that is already in place; `--rotate-token`
replaces the token.

`open` starts the web server if needed, checks that the process on the port is really the deck,
and opens `http://127.0.0.1:47800/` in your browser with the token in the URL fragment.

![First run with the hooks check failing](https://raw.githubusercontent.com/andreymudri/fleetmates/master/hub/docs/screenshots/first-run.png)

| Command | Does |
|---|---|
| `fleetmates-deck init [--dry-run] [--rotate-token]` | Hooks, units, directories and token, then the checks |
| `fleetmates-deck open` | Starts the web server and opens the deck |
| `fleetmates-deck doctor` | The setup checks in the terminal; exits 1 when the hooks are missing |
| `fleetmates-deck status` | Units, sockets, hook state and Claude Code version as JSON |
| `fleetmates-deck uninstall-hooks` | Removes only the deck's hook entries, after a backup |
| `fm claude [args]`, `fm attach <id\|repo>`, `fm ls` | Run, attach to and list sessions in the deck's PTY daemon (see above) |

## Security model

- The web server listens on `127.0.0.1` only and refuses to start on any other address.
- Every API request and WebSocket connection needs a random token kept in a 0600 file under
  `~/.local/state/fleetmates/deck/`. `open` hands it to the browser in the URL fragment, which is
  never sent over the network.
- The server checks the `Host` and `Origin` headers, so another web page, a DNS rebinding trick or a
  proxy cannot talk to it. Only `127.0.0.1:<port>` is accepted; `localhost` is redirected to it.
- Keys typed in the browser reach a session only over the authenticated WebSocket, for a session
  that tab has attached, at most 64 KiB per frame.
- The PTY daemon `fleetmates-deckd` listens on a Unix socket in a 0700 directory and is not
  reachable from the browser.
- The hook never prints to Claude Code and never blocks it. Private files are 0600 and private
  directories 0700. The token and hook payloads are kept out of the default logs.

## What is stored, and for how long

| What | Where |
|---|---|
| Sessions, requests, events and summaries | `~/.local/state/fleetmates/deck/deck.db` (SQLite) |
| Token | `~/.local/state/fleetmates/deck/token` |
| Hook events while the server is down | `~/.local/state/fleetmates/deck/spool/`, replayed and removed at the next start |
| Configuration | `~/.config/fleetmates/deck/` |
| Hook script copy | `~/.local/share/fleetmates-deck/hook/deck-hook.mjs` |
| Units | `~/.config/systemd/user/fleetmates-deck.service`, `fleetmates-deckd.service` |

The policy is a summary row per session kept forever, and the event stream and stored scrollback
dropped after 30 days. The server runs this cleanup when it starts and then daily at 04:10 local
time. Claude Code transcripts are linked by path, never copied.

Meeting content: M1 only reads whether TurbidAssist is recording, to keep the bell quiet. It does
not read or store transcripts.

## Uninstall

    fleetmates-deck uninstall-hooks
    systemctl --user disable --now fleetmates-deck.service fleetmates-deckd.service
    rm ~/.config/systemd/user/fleetmates-deck.service ~/.config/systemd/user/fleetmates-deckd.service
    systemctl --user daemon-reload

Stopping `fleetmates-deckd` ends every session that runs inside it (`fm claude`); plain `claude`
sessions are not affected. Then remove `~/.local/state/fleetmates/deck/`, `~/.config/fleetmates/deck/`
and `~/.local/share/fleetmates-deck/` if you want the data gone. The `settings.json.deck-backup-*`
files next to your Claude Code settings are left for you. A single `uninstall` command is planned.

## Troubleshooting

Start with `fleetmates-deck doctor` and `fleetmates-deck status`.

- **Sessions never appear.** The hooks are missing or point at a deleted script: run
  `fleetmates-deck init`, or use "Install hooks" in First run.
- **"This tab's key no longer matches the deck."** The token changed. Run `fleetmates-deck open`
  again.
- **The web server does not start, port 47800 in use.** Set `DECK_PORT` in a drop-in
  (`systemctl --user edit fleetmates-deck`), restart the unit, then run `fleetmates-deck open`.
- **No popups.** Run `notify-send test` in a terminal and check that your notification daemon runs.
- **Logs:** `journalctl --user -u fleetmates-deck -u fleetmates-deckd --since "10 min ago"`.

The full table is in
[docs/deck/13-operations.md](https://github.com/andreymudri/fleetmates/blob/master/docs/deck/13-operations.md)
section 12.

## Roadmap

| Milestone | Adds |
|---|---|
| M1 Observe | Watch sessions, popups, First run, Settings |
| M2 Control (this release) | Live terminals in the browser, launch sessions, `fm ls` and `fm attach`, Team run page, Crew sheet |
| M3 Unblock | Answer approvals and questions from the deck, permission rules |
| M4 Meetings | TurbidAssist meetings |
| M5 Memory ask | Ask the knowledge vault |
| M6 Deep research | Research runs |

Design documents: [docs/deck/](https://github.com/andreymudri/fleetmates/tree/master/docs/deck).

## Development

    npm ci
    mkdir -p /tmp/hx && TMPDIR=/tmp/hx npm test

Use a short `TMPDIR`: Unix socket paths are limited to about 108 bytes. The end-to-end, security
and accessibility suites and the performance scripts are under `test/e2e/` and `test/perf/`; each
file names its own command.

## License

MIT.
