# fleetmates deck

A local web deck for your Claude Code sessions. Start sessions in your terminals as usual; the deck
shows which one is working, which one needs you, and which one finished, and sends a desktop popup
when one is waiting on you.

![Home with nine sessions, three of them waiting on you](https://raw.githubusercontent.com/andreymudri/fleetmates/master/hub/docs/screenshots/home.png)

**Status: 0.1.0, not published yet.** This is milestone M1, Observe. The package name
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

M1 only watches. Requests are answered in the terminal where the session runs, and every request
row says so. Answering from the browser, launching sessions and live terminals come in later
milestones (see the roadmap below).

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
| `fm claude [args]`, `fm attach <id>` | Run `claude` inside the deck's PTY daemon |

## Security model

- The web server listens on `127.0.0.1` only and refuses to start on any other address.
- Every API request and WebSocket connection needs a random token kept in a 0600 file under
  `~/.local/state/fleetmates/deck/`. `open` hands it to the browser in the URL fragment, which is
  never sent over the network.
- The server checks the `Host` and `Origin` headers, so another web page, a DNS rebinding trick or a
  proxy cannot talk to it.
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
dropped after 30 days. In 0.1.0 the 30-day cleanup is implemented and tested but not yet scheduled,
so nothing is dropped yet. Claude Code transcripts are linked by path, never copied.

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
| M1 Observe (this release) | Watch sessions, popups, First run, Settings |
| M2 Control | Live terminals in the browser, launch sessions |
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
