# 13 · Operations: install, run, upgrade, troubleshoot

Status labels as in [02-domain.md](02-domain.md). **Decided**: `deckd` as a systemd user service owning every PTY, opening the deck in a regular browser tab, localhost only, a random token in a 0600 file, user-level hooks installed once by an `init` command and merged with fleetmates' hooks, `DECK_LANG` (`en` | `pt`), rules in each repo's `.claude/settings.local.json`, tier patterns in `~/.config/fleetmates/deck/tiers.json`, retention (summary forever, detail 30 days), public at M1. Everything else (unit files, paths not listed as Decided in [03-architecture.md](03-architecture.md), config keys, upgrade, backup, release mechanics) is **Proposed**.

Command names follow [03-architecture.md](03-architecture.md) section 6. They are Proposed and depend on the Open naming question (03-architecture section 3, [15-open-questions.md](15-open-questions.md) Q1): the owner asked for `fleetmates ui` and `fleetmates deck init`; with the hub as its own npm package the literal commands are `fleetmates-deck <cmd>` and `fm`, plus plugin aliases `node scripts/cli.mjs ui` and `node scripts/cli.mjs deck <cmd>`. The npm package name is also Open; this page writes `<deck-package>` for it (example in 03-architecture: `@andreymudri/fleetmates-deck`).

## 1. Requirements

| Need | Version or note | Status |
|---|---|---|
| Linux with systemd user services | Omarchy (Arch, Hyprland) is the reference machine. macOS and native Windows also run the deck since D-149 (section 14, [16-platforms.md](16-platforms.md)) | Decided (D-149) |
| Node.js | 24.16 or newer for the hub (`engines` `>=24.16.0`, [16-platforms.md](16-platforms.md) section 1); fleetmates itself requires `>=24.2.0`; the hub pins an exact tested minor in `hub/.node-version` for CI ([09-testing.md](09-testing.md) section 10) | Decided (Node 24+); minor pin Proposed |
| Build tools for `node-pty` | Only if the pinned `node-pty` has no Linux prebuild for Node 24 (verify at M0). On Arch: `base-devel` and `python` | Proposed |
| Claude Code | Any version; the tested one is the newest hook fixture set, shown by `fleetmates-deck doctor` | Decided (pinned tested version) |
| Browser | Chromium or Firefox, current | Proposed (qa-checklist 1.10) |
| `notify-send` (libnotify) and a notification daemon (mako on Omarchy) | For desktop popups | Decided (notify-send / mako) |
| `pw-play` (PipeWire) | Bell when the deck tab is hidden ([04-integrations.md](04-integrations.md) section 5) | Proposed |
| vault-mcp | Optional; needed from M5 (Memory) and M6 (Research); version 0.4 or later for the graph and the save preview | Decided (only path to the vault) |
| TurbidAssist `scribed` | Optional; needed from M4 (Meetings) | Decided (Node client of the socket) |

## 2. Install

### 2.1 From npm (after the M1 release)

```sh
npm install -g <deck-package>
fleetmates-deck init        # hooks, units, dirs, token, then the six checks
fleetmates-deck open        # opens http://127.0.0.1:47800/#token=<token>
```

### 2.2 From a clone (development, or before M1 is published)

```sh
git clone https://github.com/andreymudri/fleetmates.git ~/dev/fleetmates
cd ~/dev/fleetmates/hub
npm ci
npm run build               # vite build of web/ into web/dist
npm link                    # optional: puts fleetmates-deck and fm on PATH
fleetmates-deck init        # or: node bin/fleetmates-deck.mjs init
fleetmates-deck open
```

`init` records the absolute path of the hub it was run from. Running `init` from a clone points the units and hooks at the clone; running it after `npm install -g` points them at the global package. Re-run `init` whenever you switch.

### 2.3 What `init` does (Proposed; Decided parts marked)

`init` is idempotent: running it twice changes nothing the second time. Every step prints one line with its result. `--dry-run` prints the planned changes, including the settings diff, and writes nothing.

| Step | Behaviour |
|---|---|
| 1. Directories | Creates `~/.config/fleetmates/deck/` (0700), `~/.local/state/fleetmates/deck/` (0700) with `spool/` and `logs/`, and `~/.local/share/fleetmates-deck/` (0700). Existing directories keep their contents; wrong modes are tightened and reported. |
| 2. Hook script | Copies `hook/deck-hook.mjs` to `~/.local/share/fleetmates-deck/hook/deck-hook.mjs` (the path in [04-integrations.md](04-integrations.md) section 2.1). A stable copy means hooks keep working when the global npm path or the clone moves; `init` after an upgrade refreshes it. |
| 3. Hooks (Decided: user level, once, merged with fleetmates' hooks) | Reads `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set). If the file is not valid JSON, stops and changes nothing. Backs it up to `settings.json.deck-backup-<yyyymmddThhmmss>` (FR-O3 default). For each event in 04-integrations section 2.1, adds one `{ "type": "command", "command": "node <share>/hook/deck-hook.mjs", "async": true, "timeout": 5 }` entry under a `"matcher": "*"` group, unless an entry with that command already exists. An entry pointing at an older deck hook path is updated in place. Never removes or reorders other entries. fleetmates' own hooks live in the plugin's `hooks.json` and are not in this file ([reference/fleetmates-contract.md](reference/fleetmates-contract.md)). Writes atomically (temp file + rename, mode preserved), then re-reads and verifies. |
| 4. Token (Decided: random token in a 0600 file) | Creates `~/.local/state/fleetmates/deck/token` only if missing: 32 random bytes, base64url, mode 0600. An existing token is kept so open tabs stay valid. `--rotate-token` replaces it. |
| 5. Config | Writes `~/.config/fleetmates/deck/config.json` with defaults (section 7) only if missing, and, only if missing, a stub `tiers.json` that `extends` the shipped defaults and holds no entries of its own ([07-approvals.md](07-approvals.md) section 4.1, APR-O5 default). `tiers.schema.json` is copied next to it on every run, so the stub's `$schema` resolves (07-approvals 4.2). Existing files are never overwritten. |
| 6. systemd units | Renders the two unit templates from `hub/systemd/` into `~/.config/systemd/user/` with the absolute Node path (`process.execPath`) and hub path, then `systemctl --user daemon-reload` and `systemctl --user enable --now fleetmates-deckd.service fleetmates-deck.service`. If a unit file exists and differs, it is replaced and the change is reported. `init` never restarts a running `fleetmates-deckd` (that would end every session); it prints a notice when the running deckd is older than the installed one (section 9.2). |
| 7. Checks | When deckd is active, first waits up to 3 s for its socket to accept a connection (deckd is `Type=simple`, so systemd reports it active a moment before it listens). Runs the six First run checks in the terminal (same probes as [screens/first-run.md](screens/first-run.md)) and prints them. Exit code 0 when the hooks check passes (the only blocking check, Decided), 1 otherwise. |
| 8. Research workspace (M6) | Creates the research workspace at `researchWorkspace` (default `~/.local/share/fleetmates-deck/research/`, section 7.1; D-54) only if missing: `git init`, one initial commit with `fleetmates.gate.json`, `README.md` and `.gitignore`, and `.claude/settings.local.json` with the vault write denies ([10-memory-and-research.md](10-memory-and-research.md) section 8.2). Then asks in the terminal whether to allow `WebSearch` and `WebFetch` in that workspace (KB-O3); nothing is written without a yes, and a non-interactive terminal skips the question. An existing workspace is left untouched. Not part of the exit code. |

The First run screen's "Install hooks" button runs step 3 through the web server (`POST /api/setup/hooks`); "Start deckd" runs `systemctl --user start fleetmates-deckd.service`.

## 3. systemd units (Proposed)

Templates ship in `hub/systemd/`. `@NODE@` and `@HUB@` are replaced by `init`. Entry file names (`deckd/main.mjs`, `server/main.mjs`) are Proposed; the folders are from 03-architecture section 3.

### 3.1 `fleetmates-deckd.service`

```ini
# ~/.config/systemd/user/fleetmates-deckd.service
# Rendered by `fleetmates-deck init`. Edits are overwritten by the next init;
# use `systemctl --user edit fleetmates-deckd` for a drop-in instead.

[Unit]
Description=fleetmates deck PTY daemon (deckd)
Documentation=https://github.com/andreymudri/fleetmates/tree/master/docs/deck
# No dependency on the web server: deckd must outlive it.

[Service]
Type=simple
ExecStart=@NODE@ @HUB@/deckd/main.mjs
Restart=on-failure
RestartSec=2
# Default KillMode (control-group) on purpose: stopping deckd ends every
# session cleanly; the web server then shows them as "Crashed · lost"
# (03-architecture 2.1). KillMode=process is NOT used.
TimeoutStopSec=15
UMask=0077
Environment=NODE_ENV=production
# No sandboxing: deckd runs the user's agents with the user's full rights
# (they may need sudo, ssh-agent, docker, and so on).

[Install]
WantedBy=default.target
```

### 3.2 `fleetmates-deck.service`

```ini
# ~/.config/systemd/user/fleetmates-deck.service
# Rendered by `fleetmates-deck init`. Use `systemctl --user edit fleetmates-deck`
# for local settings (DECK_PORT, DECK_LANG, DECK_DEBUG, VAULT_PATH).

[Unit]
Description=fleetmates deck web server (127.0.0.1)
Documentation=https://github.com/andreymudri/fleetmates/tree/master/docs/deck
# Wants, not Requires or BindsTo: the web server keeps serving history,
# Memory and Meetings when deckd is down, and restarting either one must not
# restart the other.
Wants=fleetmates-deckd.service
After=fleetmates-deckd.service

[Service]
Type=simple
ExecStart=@NODE@ @HUB@/server/main.mjs
Restart=on-failure
RestartSec=2
UMask=0077
Environment=NODE_ENV=production
NoNewPrivileges=yes
# Environment=DECK_PORT=47800
# Environment=DECK_LANG=en
# Environment=DECK_DEBUG=1
# Environment=VAULT_PATH=%h/vault

[Install]
WantedBy=default.target
```

Both start at login (`default.target` of the user manager). No lingering is needed: the deck is used while the owner is logged in.

### 3.3 Child processes and cgroups

Anything the web server spawns lives in its cgroup and dies when the web server unit stops or restarts: `claude -p` Ask children (acceptable, the question is kept and the UI shows the error), the vault-mcp child (restarted with the server), `notify-send` processes waiting for an action (the popup's "Open" becomes a no-op). **scribed is the exception**: a scribed spawned as a plain detached child would stay in the web unit's cgroup, so a web server restart would kill it and any recording in progress. Decided 2026-10-04 (OPS-O1, SM-O13, FAIL-O1, D-106): the deck starts it with `systemd-run --user --collect --unit=turbidassist-scribed --property=KillMode=process $SHELL -l -c 'exec scribed'`, so it gets its own transient unit outside the deck's cgroup and the login environment (including `HF_TOKEN`). TurbidAssist change T4 (a `scribed.service` unit, [04-integrations.md](04-integrations.md) section 4.3) is not taken.

As built in 0.4.0 (`hub/server/meetings/start-scribed.mjs`): "Start scribed" (`POST /api/deps/scribed/start`) first asks scribed for `status`; when it answers, nothing is spawned. Otherwise it runs `systemd-run` with an argv array, a 5 s timeout and the web server's environment without any key whose name contains `TOKEN`, `SECRET`, `PASSWORD` or `AUTHORIZATION`, then probes every 100 ms for up to 10 s. When the Settings `scribedCommand` is the default `scribed` the argv is exactly the decided command above; any other value is passed as one argument after `-c 'exec "$0"'`, so the setting never reaches a shell parser. A non-zero `systemd-run` exit is 502 `dependency_start_failed` with `details.exitCode` and the last 2 KiB of its stderr (redacted); no answer within 10 s is the same code with `details.reason: 'no_socket'`. The server finds the socket only under its own `XDG_RUNTIME_DIR` and never falls back to another path.

The `turbidassist-scribed` unit is transient: it exists while scribed runs, and with `--collect` systemd unloads it when scribed exits, failed or not (systemd-run(1)), so there is no unit file to edit or enable. To inspect it:

    systemctl --user status turbidassist-scribed
    journalctl --user -u turbidassist-scribed --since "1 hour ago"
    ls -l "$XDG_RUNTIME_DIR/turbidassist.sock"

Stop it with `systemctl --user stop turbidassist-scribed` only when no meeting records: stopping scribed during a recording ends that recording. Because the unit is outside the web server's cgroup, a web server restart is meant to leave it and its recording running; that is part of exit criterion 5 and has not been checked on a real recording yet ([m4-exit.md](m4-exit.md)).

The environment of the systemd user manager is not the login shell's (no `PATH` additions from `.zshrc`, mise, nvm, no exported keys). Sessions started with `fm claude` get the terminal's environment (03-architecture 2.4). Sessions launched from the UI need the login environment (03-architecture 2.1); OPS-O2 covers how deckd obtains it.

## 4. Start, stop, restart

| Task | Command |
|---|---|
| Open the UI | `fleetmates-deck open` (starts the web unit if needed, writes a 0600 bootstrap page holding the tokenised URL and opens it in the web browser: `$BROWSER`, then the `xdg-settings get default-web-browser` entry through `gtk-launch` or `gio launch`, then `xdg-open`; if none works it prints the bootstrap file path) |
| Status of everything | `fleetmates-deck status` (units, sockets, hook install state, live PTYs, versions) |
| Six checks in the terminal | `fleetmates-deck doctor` |
| Restart the web server | `systemctl --user restart fleetmates-deck` |
| Restart deckd (ends every PTY session) | `systemctl --user restart fleetmates-deckd` |
| Stop everything | `systemctl --user stop fleetmates-deck fleetmates-deckd` |
| Disable autostart | `systemctl --user disable fleetmates-deck fleetmates-deckd` |
| Wrap a session | `fm claude [args]`, detach with `Ctrl ]` then `d`, reattach with `fm attach <id>` or `fm attach <repo>`, list with `fm ls` |

### 4.1 What survives what

| Event | PTY sessions (`wrapped`, `launched`) | Observed sessions | Hook events | Browser tab | Other |
|---|---|---|---|---|---|
| Web server restart or crash (Decided: PTYs survive) | Keep running in deckd; reconciled on start (03-architecture 4.4) | Keep running; state rebuilt from SQLite and the spool | Spooled to `spool/` by `deck-hook`, drained on start | Shows "Lost the deck server" banner, reconnects, resyncs by `seq` or snapshot | In-flight Ask answers fail (question kept); an answer being verified is not confirmed and the request stays open; scribed dies too unless OPS-O1 |
| deckd restart, crash or stop | **End** (children get SIGHUP); shown as `Crashed · lost`, relaunch with "Relaunch" (`claude --resume`) | Unaffected (no PTY) | Unaffected (hooks go to the web server) | deckd banner; pills keep updating from hooks; PTY actions disabled | Accepted limit (03-architecture 2.1) |
| Browser tab closed or reloaded | Unaffected | Unaffected | Unaffected | Reopen with `fleetmates-deck open` or the same URL (the token stays in `sessionStorage` for the tab) | none |
| Logout or reboot | End | End | none | none | Summaries stay in SQLite; units start again at the next login |
| `fleetmates-deck init` re-run | Unaffected (never restarts deckd) | Unaffected | Unaffected | Unaffected (token kept) | Web unit restarted only if its unit file changed |

### 4.2 Full command list (Proposed)

This is the full `fleetmates-deck` command list; [03-architecture.md](03-architecture.md) section 6 lists the core ones and points here. Names depend on Q1 in [15-open-questions.md](15-open-questions.md).

| Command | Does | Section |
|---|---|---|
| `fleetmates-deck init [--dry-run] [--rotate-token]` | Hooks, units, dirs, token, config, then the six checks | 2.3 |
| `fleetmates-deck open` | Starts the web unit if needed, opens the tokenised URL | 4 |
| `fleetmates-deck status` | Units, sockets, hook install state, live PTYs, versions | 4 |
| `fleetmates-deck doctor` | The six First run checks in the terminal | 4, 12 |
| `fleetmates-deck uninstall-hooks` | Removes only the deck's hook entries | 10 |
| `fleetmates-deck uninstall [--keep-data]` | Hooks, units, runtime, state and config | 10 |
| `fleetmates-deck backup <dir>` | Consistent copy of `deck.db` with `VACUUM INTO` | 11 |
| `fleetmates-deck restore <file>` | Stops the web unit, moves the current database aside, copies the backup in, new `epoch`, starts the unit | 11 |
| `fleetmates-deck reset [--keep-crew]` | Stops the web unit, renames `deck.db*` aside, starts on an empty database with a new `epoch` | 11 |
| `fleetmates-deck audit [--repo <name>] [--since <YYYY-MM-DD>]` (M3) | Prints the approvals audit: rule events and request events ([07-approvals.md](07-approvals.md) section 11). Output below | 4.3 |
| `fleetmates-deck export-misses --kind retrieval` (M5) | Writes resolved retrieval misses as JSONL for vault-mcp golden queries ([10-memory-and-research.md](10-memory-and-research.md) section 3.3) | |
| `fleetmates-deck research prune --older-than 90d` (Later) | Removes old research runs from the research workspace ([10-memory-and-research.md](10-memory-and-research.md) section 8.2) | |
| `fleetmates-deck report --since <date>` | Summarises the dogfood metrics ([09-testing.md](09-testing.md) section 13.3) | |
| `fm claude`, `fm attach`, `fm ls` | Wrapped sessions ([03-architecture.md](03-architecture.md) section 2.4) | 4 |

### 4.3 `fleetmates-deck audit` output (M3, as built)

`audit` opens `deck.db` read-only and prints the rows of `approval_audit` and `rule_audit` ([06-storage.md](06-storage.md) section 4.5) merged, oldest first, one per line. Each line starts with the ISO 8601 UTC time of the event:

    <time> <kind> repo=<name> tier=<tier> via=<via> choice=<choice> summary="<summary>"
    <time> rule_<action> repo=<name> pattern="<pattern>" actor=<actor>

- `kind` is `answered`, `refused`, `did_not_land`, `expired`, `tiers_loaded` or `tiers_rejected`. For a refusal, `choice` holds the error code (`confirm_required`, `not_on_screen` and the rest). A missing value prints as `-`.
- `action` is `added`, `revoked`, `undo`, `found` or `vanished`; `actor` is `suggestion`, `manual` or `external`.
- `summary` and `pattern` are JSON strings, redacted again on output with the log redaction rules of [08-security.md](08-security.md) section 4.10, so a bearer token prints as `***`.
- `--repo <name>` keeps the rows of that repo by its display name (rows without a repo, such as `tiers_loaded`, are left out). `--since <YYYY-MM-DD>` keeps rows from local midnight of that day. Any other argument, or a date that does not exist, prints the usage line and exits 1. With no database yet it says "no deck database yet; start the deck first".

Example, from the fixture of `hub/test/unit/setup.test.mjs` (times shortened):

    2026-10-01T... refused repo=api tier=destructive via=browser choice=confirm_required summary="rm -rf build"
    2026-10-02T... tiers_loaded repo=- tier=- via=- choice=- summary=""
    2026-10-02T... rule_added repo=web pattern="Bash(npm run test)" actor=suggestion
    2026-10-03T... answered repo=web tier=safe via=browser choice=allow summary="curl -H \"Authorization: Bearer ***\" https://example.invalid"

## 5. Files and directories

From [03-architecture.md](03-architecture.md) section 5, plus the two install locations this page adds (Proposed).

| Purpose | Path | Mode |
|---|---|---|
| Config | `~/.config/fleetmates/deck/config.json` (section 7) | 0600 |
| Tier patterns | `~/.config/fleetmates/deck/tiers.json` (Decided path) | 0600 |
| State dir | `~/.local/state/fleetmates/deck/` | 0700 |
| Database | `~/.local/state/fleetmates/deck/deck.db` (+ `-wal`, `-shm`) | 0600 |
| Database backups from migrations | `~/.local/state/fleetmates/deck/deck.db.pre-<NNNN>.bak` ([06-storage.md](06-storage.md) section 7) | 0600 |
| Browser token | `~/.local/state/fleetmates/deck/token` | 0600 |
| Hook spool | `~/.local/state/fleetmates/deck/spool/hooks-<yyyymmdd>.jsonl` | dir 0700 |
| Debug logs | `~/.local/state/fleetmates/deck/logs/` (only with `DECK_DEBUG=1`) | 0600 |
| Runtime sockets | `$XDG_RUNTIME_DIR/fleetmates-deck/{deckd,hooks}.sock` | dir 0700, sockets 0600 |
| Hook script copy | `~/.local/share/fleetmates-deck/hook/deck-hook.mjs` (from 04-integrations 2.1; added here) | 0600 |
| Research workspace (M6) | `~/.local/share/fleetmates-deck/research/` (`researchWorkspace`; D-54) | dir 0700 |
| Units | `~/.config/systemd/user/fleetmates-deck.service`, `fleetmates-deckd.service` | 0644 |
| Hooks | `~/.claude/settings.json` `hooks` (Decided) | as found |
| Rules | `<repo>/.claude/settings.local.json` `permissions.allow` (Decided) | as found |

## 6. Logs

- Both services log to **journald** (stdout and stderr). One line per event, plain text, prefixed with a component (`ingest`, `deckd-link`, `vault`, `scribed`, `notify`, `http`).

  ```sh
  journalctl --user -u fleetmates-deck -f
  journalctl --user -u fleetmates-deckd -f
  journalctl --user -u fleetmates-deck -u fleetmates-deckd --since "10 min ago"
  ```

- **`DECK_DEBUG=1`** (set in a drop-in: `systemctl --user edit fleetmates-deck`, add `[Service]` and `Environment=DECK_DEBUG=1`, then restart) adds verbose logs to `~/.local/state/fleetmates/deck/logs/` (Proposed rotation: 5 files of 10 MiB). Debug logs include hook payloads, so they contain commands, file paths and prompts. Review before attaching them to a bug report.
- Never logged, at any level (Proposed, rules from [08-security.md](08-security.md) and [04-integrations.md](04-integrations.md) section 4.2): the token, transcript text, ask text and pin labels of confidential meeting tags, `tool_input` of requests at the default level.
- `deck-hook` never prints (its stdout could reach Claude's context, 03-architecture 2.3). Its failures appear only as spool files and as a count in `fleetmates-deck status`.

## 7. Configuration

### 7.1 `config.json` keys (Proposed)

Environment variables win over `config.json`. Edits made by hand to the file need a web server restart (`systemctl --user restart fleetmates-deck`). Edits made through Settings, Connections are written to `config.json` by the server and applied live, without a restart. `port` always needs a restart, however it was changed.

| Key | Default | Env override | Notes |
|---|---|---|---|
| `port` | `47800` | `DECK_PORT` | Loopback only; the server refuses any other bind address (Decided: localhost only) |
| `scanRoot` | `"~/dev"` | none | Decided default (repo picker scans `~/dev`); scan depth is NEW-O2 |
| `lang` | `"en"` | `DECK_LANG` | `en` or `pt` (Decided: `DECK_LANG`). Also passed to vault-mcp as `VAULT_LANG`. Settings shows it read-only (SET-O1 default) |
| `staleMinutes` | `20` | none | Decided for fleetmates team runs (D-20); applying it to plain sessions is Proposed. Not editable in the v1 UI (02-domain 3) |
| `claudeCommand` | `"claude"` | none | Binary used for launched sessions and the Ask engine |
| `vaultPath` | `null` | `VAULT_PATH` | Vault root handed to vault-mcp; unset means Memory shows the degraded card |
| `vaultCommand` | `["npx", "-y", "@andreymudri/vault-mcp"]` | none | How the web server spawns vault-mcp (reference/vault-turbid-contract.md 1.12); a clone can use `["node", "<clone>/dist/server/index.js"]` |
| `obsidianVaultName` | `null` (basename of `vaultPath`) | none | For "Open in Obsidian" (MEM-O5 default) |
| `turbidassistConfig` | `null` (use `~/dev/turbidassist/config.yaml` if present) | none | Where the deck reads tags and `session_dir` (MEET-O11 default) |
| `scribedCommand` | `"scribed"` | none | Used by "Start scribed" (OPS-O1) |
| `researchWorkspace` | `"~/.local/share/fleetmates-deck/research/"` | none | Deck-owned git workspace for research runs (D-54, M6); created by `init` step 8 |

`config.json` holds boot and connection settings only. UI behaviour preferences edited in Settings (text size, motion, bell, re-notify interval, notify on done, quiet in meetings, crash popups, rule suggestion threshold) are stored in the deck database `prefs` table ([06-storage.md](06-storage.md) section 8, SET-O2 default in [screens/settings.md](screens/settings.md)). Home density is per browser, in `localStorage` key `deck.density`.

### 7.2 Other environment variables

| Variable | Read by | Effect |
|---|---|---|
| `DECK_PORT` | web server, `fleetmates-deck open` | Port (section 7.1) |
| `DECK_LANG` | web server | UI language, `en` or `pt` (Decided) |
| `DECK_DEBUG` | web server, deckd | `1` turns on debug logs (section 6) |
| `DECK_DOGFOOD` | web server | `1` enables the dogfood pane-check logger ([09-testing.md](09-testing.md) TEST-O4) |
| `VAULT_PATH` | web server | Vault root for its vault-mcp child |
| `CLAUDE_CONFIG_DIR` | `init`, `uninstall-hooks` | Location of `settings.json` when not `~/.claude` |
| `FLEETMATES_DECK_PTY` | set by deckd in each PTY, read by `deck-hook` | Ties hook events to the PTY (03-architecture 2.1) |

### 7.3 Changing the language

`DECK_LANG` is an environment variable (Decided), so it is set in the web unit, not in the UI: `systemctl --user edit fleetmates-deck`, add `Environment=DECK_LANG=pt`, then `systemctl --user restart fleetmates-deck`. Meeting content stays PT-BR whatever the chrome language (Decided). M1 ships the `en` catalog only by default; until a `pt` catalog exists, `DECK_LANG=pt` falls back to `en` with a notice (Q19 in [15-open-questions.md](15-open-questions.md)).

## 8. Data retention (Decided policy, Proposed mechanics)

- Summary row per session forever (repo, branch, task, outcome, duration, gate result); event stream and scrollback dropped after 30 days; Claude Code transcripts are linked, never copied (Decided).
- The web server runs the retention job at start and daily at 04:10 local (Proposed; [06-storage.md](06-storage.md) section 6). It deletes `events` and stored scrollback older than 30 days and runs `PRAGMA incremental_vacuum` (or `VACUUM` weekly).
- Spool files older than 7 days that were already drained are deleted (Proposed).

## 9. Upgrading

### 9.1 Procedure

1. Read `hub/CHANGELOG.md` for the release: every entry states "Tested Claude Code", "deckd changed: yes/no" and "Database migration: yes/no" (Proposed, section 13.3).
2. Install the new version: `npm install -g <deck-package>@latest`, or in a clone `git pull && cd hub && npm ci && npm run build`.
3. Run `fleetmates-deck init`: refreshes the hook script copy and the unit files, keeps the token and config.
4. `systemctl --user restart fleetmates-deck` (web server only). Sessions keep running.
5. Only if the changelog says "deckd changed: yes": when no session you care about is running (`fm ls` or `fleetmates-deck status`), `systemctl --user restart fleetmates-deckd`. Until then the old deckd keeps working (9.2).
6. Run `fleetmates-deck doctor`.

### 9.2 deckd and web server compatibility (Proposed)

deckd and the web server exchange a `hello { protocolVersion }` on connect. A web server accepts the current and the previous deckd protocol version, so step 4 before step 5 is always safe for one release. When the web server finds an older deckd it shows a Settings, Connections note "deckd {version} is running; restart it when convenient (ends running sessions)". A deckd too old to support shows the deckd banner with that reason.

### 9.3 Database migrations (Proposed)

- Schema version in `PRAGMA user_version`. Migrations in `hub/server/db/migrations/NNNN-<name>.sql` (or `.mjs` for data moves), applied in order at web server start, each in its own transaction.
- Before the first pending migration, the server writes `deck.db.pre-<NNNN>.bak` with `VACUUM INTO` (06-storage 7) and keeps the three newest backups.
- If `user_version` is newer than the code knows (a downgrade), the server refuses to start and logs: "deck.db is schema {n}, this build knows {m}. Install the newer version or restore {backup}." Downgrades are never migrated.
- A failed migration rolls back its transaction, logs the error and exits non-zero; systemd restarts it (and it fails the same way), so the fix is to install a fixed version or restore the backup (section 11).

### 9.4 Hook fixture version check after an upgrade

- The new release may carry a newer `testedClaudeCode`. `doctor` and First run check 1 compare it with `claude --version` (SM-O18 default: warn only when Claude Code is newer).
- `deck-hook` stamps `deckHookVersion` in every envelope. If envelopes arrive from an older hook script than the server expects (for example `init` was skipped), Settings, Connections shows "Hooks are from an older deck release. Run fleetmates-deck init." Events are still accepted when they validate.

### 9.5 Upgrading Claude Code

1. After a Claude Code update, run `fleetmates-deck doctor`. "Claude Code {version} is newer than this deck was tested with" means no fixture set covers it yet.
2. Watch the drift count ("N hook payloads did not match the pinned fixtures", state-machines 1.11 item 13). Drifted events are held and never applied, so a session may show a stale state.
3. If drift appears: stay on the older Claude Code until a deck patch release covers the new one (OPS-O5 on holding Claude Code back), or, as the maintainer, follow the capture procedure in [09-testing.md](09-testing.md) section 5.3 and ship a patch release.

## 10. Uninstall (Proposed)

`fleetmates-deck uninstall` (Proposed, section 4.2; asks for confirmation, `--keep-data` skips step 4) runs:

1. **Hooks**: `fleetmates-deck uninstall-hooks`: backs up `settings.json`, removes only hook entries whose `command` points at a deck hook script (current or older path), removes a `matcher` group only if it became empty and was created by the deck, leaves fleetmates' and every other hook untouched, writes atomically, verifies by re-reading.
2. **Units**: `systemctl --user disable --now fleetmates-deck.service fleetmates-deckd.service` (this ends every PTY session; the command lists them first), removes both unit files, `systemctl --user daemon-reload`.
3. **Runtime**: removes `$XDG_RUNTIME_DIR/fleetmates-deck/`.
4. **State and config**: removes `~/.local/state/fleetmates/deck/`, `~/.config/fleetmates/deck/`, and `~/.local/share/fleetmates-deck/` except the research workspace. The research workspace (`researchWorkspace`) holds run branches, briefs and drafts, so uninstall asks separately before removing it (default: keep); `--keep-data` keeps it without asking.
5. Prints what it left in place: `settings.json.deck-backup-*` files, the research workspace if kept, per-repo rules the deck wrote (OPS-O6), research notes in the vault (they are vault content with their own git history).

Then `npm uninstall -g <deck-package>` (or delete the clone).

## 11. Backup and restore (Proposed)

| Item | Back up? | How |
|---|---|---|
| `deck.db` | Yes: session summaries, crew colour slots (which must never change, [design/crew.md](design/crew.md)), rule mirror with sources and dates, ask threads, search-miss log, meeting pins | `fleetmates-deck backup <dir>` (Proposed command) writes a consistent copy with `VACUUM INTO` while the server runs. Do not copy `deck.db` with `cp` while the server runs (WAL) |
| `config.json`, `tiers.json` | Yes | plain copy |
| Rules | Not needed here | source of truth is each repo's `.claude/settings.local.json` |
| Token, spool, logs, sockets | No | regenerated or transient |
| Vault, repos, TurbidAssist sessions | Not the deck's job | their own backups and git |

Restore: `fleetmates-deck restore <file>` (section 4.2; details in [06-storage.md](06-storage.md) section 9). By hand: `systemctl --user stop fleetmates-deck`, copy the backup to `deck.db`, delete `deck.db-wal` and `deck.db-shm`, start the unit. Reset: `fleetmates-deck reset`. The server assigns a new `epoch` on a restored database (Proposed) so open tabs load a fresh snapshot instead of replaying ([state-machines](interaction/state-machines.md) 4.3).

## 12. Troubleshooting

Built from [screens/failures-and-loading.md](screens/failures-and-loading.md) and [screens/first-run.md](screens/first-run.md). Start with `fleetmates-deck doctor` and `fleetmates-deck status`.

| Symptom (what the UI or terminal shows) | Likely cause | Check | Fix |
|---|---|---|---|
| Banner "Radio silence from deckd..." with attempts; Launch, Allow, Stop disabled with "deckd is reconnecting"; First run "deckd is not running" | deckd stopped or crashed | `systemctl --user status fleetmates-deckd`; `journalctl --user -u fleetmates-deckd -n 100`; `ls -l $XDG_RUNTIME_DIR/fleetmates-deck/deckd.sock` | `systemctl --user start fleetmates-deckd` or "Start deckd". Sessions that ran in the old deckd are gone ("Crashed · lost"); "Relaunch" resumes them with `claude --resume` |
| `fm claude` prints "deckd is not running, starting plain claude; this session will be observed only" | deckd down when the session started | as above | Start deckd; that session stays observed (read-only); new ones are wrapped |
| First run "Observation hooks not installed", "Set sail (needs hooks)" disabled; sessions started in a terminal never appear | Hooks missing: another tool rewrote `settings.json`, `CLAUDE_CONFIG_DIR` points elsewhere, or the hook script copy was deleted | `fleetmates-deck doctor`; `grep -c deck-hook ~/.claude/settings.json`; `ls ~/.local/share/fleetmates-deck/hook/`; `/hooks` inside `claude` lists them | `fleetmates-deck init` or "Install hooks" |
| Hooks installed but sessions still missing, spool files growing | The web server is down, so `deck-hook` spools | `ls ~/.local/state/fleetmates/deck/spool/`; `systemctl --user status fleetmates-deck` | Start the web server; it drains the spool on start |
| Sessions show wrong states after a Claude Code update; check 1 says "N hook payloads did not match the pinned fixtures" | Hook payload drift | `claude --version` vs `fleetmates-deck doctor` tested version | Section 9.5 |
| A card says "Joined mid-voyage: changes before 18:42 are not counted" | Normal: the session started before the hooks or the deck | none | none |
| Memory tab "The charts are out of reach · vault-mcp did not answer on stdio (...)"; First run "vault-mcp did not start" | `VAULT_PATH` unset or not a directory, `npx` cannot fetch the package offline, wrong Node | The real error is in the card; run the configured `vaultCommand` by hand with `VAULT_PATH=... ` (it waits on stdin; stop with `Ctrl C`) | Fix in Settings, Connections, or set `VAULT_PATH` in the web unit drop-in; "Retry" |
| Memory graph tab says it needs vault-mcp 0.4; Research cannot save | vault-mcp older than the `vault_graph` and `preview` release ([04-integrations.md](04-integrations.md) 3.3) | `tools/list` in `doctor` output | Upgrade vault-mcp |
| Meetings "No one on the radio · scribed is not running: no socket at $XDG_RUNTIME_DIR/turbidassist.sock" | scribed not started (TurbidAssist has no unit; it is spawned on demand), crashed with a config error (exit 2), or `XDG_RUNTIME_DIR` unset | `ls -l $XDG_RUNTIME_DIR/turbidassist.sock`; run `scribe daemon` in a terminal to see its error | "Start scribed" (OPS-O1, FAIL-O1), or start TurbidAssist yourself. Past meetings still load |
| A recording stopped when the deck web server restarted | scribed was a child of the web server unit | `systemctl --user status fleetmates-deck` shows `scribed` in its cgroup | OPS-O1, Decided (D-106): start scribed through `systemd-run --user` in its own `turbidassist-scribed` unit, running a login shell (`$SHELL -l -c 'exec scribed'`) |
| No desktop popups; Settings "Desktop notifications are not working: notify-send exited 1" or the test ping fails | `notify-send` missing, mako not running, mako in a do-not-disturb mode, or the user manager lacks `DBUS_SESSION_BUS_ADDRESS` | `notify-send test` in a terminal; `makoctl mode`; `systemctl --user show-environment` (look for `DBUS_SESSION_BUS_ADDRESS`) | Install libnotify; start mako or leave its do-not-disturb mode; `systemctl --user import-environment DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY` then restart the web unit |
| Popups show but no bell | Expected while TurbidAssist records (Decided quiet mode: popups, no sound); or the tab never got a click (browser autoplay policy) and `pw-play` is missing | Rec dot on the Rail; `which pw-play` | Click once in the deck tab after opening it; install PipeWire tools; check Settings "Quiet in meetings" |
| Crash card "ran aground" with "The disk is full, so relaunching now would fail the same way." | ENOSPC in the session | "Show disk usage" (`df -h` of the session's filesystem) | Free space, then "Relaunch after freeing space". If the deck's own disk is full, SQLite writes fail too: `journalctl` shows `SQLITE_FULL` and hooks spool or drop; free space and restart the web unit |
| Web unit fails to start, journal shows `EADDRINUSE 127.0.0.1:47800` | Port in use | `ss -ltnp 'sport = :47800'` | Stop the other process, or set `DECK_PORT` (drop-in) or `port` in `config.json`, restart, then `fleetmates-deck open` (the URL changes) |
| Full-page "This tab's key no longer matches the deck. Open the deck again with `fleetmates-deck open`." (name pending Q1 in [15-open-questions.md](15-open-questions.md)) (WebSocket 4401) | Token rotated (`init --rotate-token`), state dir recreated, or a bookmarked URL from an old install | `ls -l ~/.local/state/fleetmates/deck/token` | `fleetmates-deck open` (new URL with the current token). If it repeats, the service and the CLI see different `HOME`s |
| Full-page "The deck only answers pages it served itself." (WebSocket 4403) | Opened through another host name or a proxy (`0.0.0.0`, a LAN IP, a tunnel) | The address bar | Open with `fleetmates-deck open`. Remote access is not supported in v1 (Decided) |
| Launched sessions crash with "command not found" or miss API keys that work in your terminal | deckd does not have your login environment (OPS-O2) | Compare `systemctl --user show-environment` with your shell `env` | Per OPS-O2 default: restart deckd after changing your shell profile; or use `fm claude` from a terminal |
| Web unit restarts in a loop after an upgrade; journal names a migration or "deck.db is schema {n}" | Failed migration or a downgrade | `journalctl --user -u fleetmates-deck -n 50` | Install the fixed or newer version, or restore the backup (section 11) |
| `ExperimentalWarning: SQLite is an experimental feature` in the journal | `node:sqlite` on some Node 24 builds | none | Harmless; use the Node minor in `hub/.node-version` |

## 13. Release process for the public M1 (Proposed; public at M1 is Decided)

### 13.1 Versioning and tags

- The hub package versions independently of the plugin (the root stays `fleetmates` 2.x). Semver; `0.1.0` at M1, one minor per milestone after that (`0.2.0` M2 ... `0.6.0` M6), patches for fixes and new Claude Code fixture sets. `1.0.0` when the owner calls v1 done.
- Tags are `deck-vX.Y.Z` so the existing root `release.yml`, which publishes the plugin on `v*` tags, never fires for a deck release (OPS-O3).

### 13.2 Package contents

`hub/package.json` `files`: `bin/`, `deckd/`, `server/`, `hook/`, `web/dist/`, `systemd/`, `README.md`, `CHANGELOG.md`, `LICENSE` (MIT, same as fleetmates). Tests and fixtures are not shipped. `prepack` runs the Vite build. `"fleetmatesDeck": { "testedClaudeCode": "<version>" }` is set from the newest hook fixture set ([09-testing.md](09-testing.md) section 4). The root `package.json` `files` whitelist is unchanged, so the plugin package does not grow.

### 13.3 Changelog

`hub/CHANGELOG.md`, same shape as the root changelog (`## vX.Y.Z`, then `### Added`, `### Changed`, `### Fixed`), plus three lines per release (Proposed): `Tested Claude Code: <version>`, `deckd changed: yes|no`, `Database migration: yes|no`. Commit messages follow the repo's commitlint style with a `deck` scope (`feat(deck): ...`).

### 13.4 Workflow

`.github/workflows/deck-release.yml` on `deck-v*` tags:

1. All jobs of `deck.yml` plus `hub-perf` ([09-testing.md](09-testing.md) section 10).
2. Tag must equal `v` + `hub/package.json` version (same check as the root workflow).
3. Publish from `hub/` with npm trusted publishing (`id-token: write`, npm 11.5.1 or later) and `npm publish --provenance --access public`, skipped if the version is already on npm (same pattern as the root `release.yml`). Verify whether npm lets a trusted publisher be configured before the package exists; if not, the owner publishes `0.1.0` once by hand with 2FA and configures trusted publishing for later releases.

### 13.5 M1 release checklist

| Step | Done when |
|---|---|
| Dogfood week | Passed per [09-testing.md](09-testing.md) section 13, report committed |
| CI | `deck.yml` required jobs and `hub-perf` green on the release commit |
| Manual smoke | Real Claude Code smoke ([09-testing.md](09-testing.md) section 5.4) on the pinned version |
| Design QA | qa-checklist signed for the M1 screens |
| Public-data scrub | TEST-O6 resolved: no client names or personal paths in fixtures, screenshots or docs |
| Open naming | Package name and command names decided (03-architecture section 3 Open, Q1 in [15-open-questions.md](15-open-questions.md)) |
| Docs | `hub/README.md` written (13.5.1); root `README.md` gains a "fleetmates deck" section; `docs/deck/` published with the repo |
| Clean install | On a fresh user account: `npm install -g <deck-package>`, `fleetmates-deck init`, `doctor` all green except optional checks |
| Tag and publish | `deck-v0.1.0` pushed; package visible on npm with provenance |

#### 13.5.1 README content (Proposed)

- **Root `README.md`**: a short "fleetmates deck" section: one sentence, one screenshot, three install commands, link to `hub/README.md` and `docs/deck/`.
- **`hub/README.md`** (also the npm page): what it is and what M1 does (observe; control and approvals come in later milestones), requirements (section 1), install and first run, the security model in plain words (127.0.0.1 only, token, Origin and Host checks, deckd not reachable from the browser), what is stored and for how long (section 8), confidential meeting handling, uninstall, troubleshooting link, milestone roadmap. English (OPS-O4).
- **Screenshots**: for screens built in M1 (Home busy and calm, Needs-you drawer read-only, First run, failure states), use build screenshots from the Playwright visual suite (fixtures, frozen clock, 1920 x 1080, [qa/qa-checklist.md](qa/qa-checklist.md) section 3). Canvas renders (`render/shots/<Board>.png`) may appear only in a "Where it is going" section, each captioned "Design mockup, not built yet". Store images in `docs/deck/img/` and reference them from `hub/README.md` with absolute `raw.githubusercontent.com` URLs so they render on npm.

## 14. macOS and Windows (D-149)

The design is [16-platforms.md](16-platforms.md). The sections above describe Linux. This one
covers what differs on macOS and on native Windows. On every platform `fleetmates-deck init`,
`open`, `start`, `stop`, `doctor` and `status` go through one service adapter
(`hub/server/setup/service.mjs`), so the commands are the same; what they drive differs.

### 14.1 Installing: npm skips install scripts

npm 11 skips package install scripts by default. Measured with npm 11.19.0 on Linux and on the
Windows 11 test VM (`npm install -g <tarball>`): npm skips every install script that `allowScripts`
does not cover, including the deck's own `postinstall` (`node bin/prepare-native.mjs`), even when
the package is named in `--allow-scripts` for a tarball install.

- Windows and Linux: node-pty's prebuilt binaries work without that script.
- macOS: the script exists to give node-pty's prebuilt `spawn-helper` its execute bits, and every
  PTY spawn needs them. Task 18 makes deckd set them itself: on darwin, before its first PTY spawn,
  deckd runs the same preparation once; when it fails, the spawn is refused with `spawn_failed`
  and a message that says to reinstall. Until Task 18 is integrated, run
  `node <hub>/bin/prepare-native.mjs` by hand after installing on macOS.

### 14.2 macOS: launchd

`init` writes two LaunchAgents, `~/Library/LaunchAgents/io.fleetmates.deck.deckd.plist` and
`io.fleetmates.deck.web.plist`, then for each runs `launchctl bootout` (a job that is not loaded
is not an error) and `launchctl bootstrap gui/<uid> <plist>`. Each plist runs the absolute node
binary with the entry file, starts at load (`RunAtLoad`), restarts after a failed exit
(`KeepAlive` with `SuccessfulExit` false) and sets `Umask` 63 (octal 077).

| Task | Command |
|---|---|
| Start both | `fleetmates-deck start` (`launchctl kickstart gui/<uid>/<label>`) |
| Stop both | `fleetmates-deck stop` (`launchctl kill SIGTERM gui/<uid>/<label>`; stopping deckd ends every PTY session) |
| Restart the web server | `launchctl kickstart -k gui/<uid>/io.fleetmates.deck.web` |
| Inspect a job | `launchctl print gui/<uid>/io.fleetmates.deck.deckd` |
| Remove autostart | `launchctl bootout gui/<uid>/io.fleetmates.deck.web`, the same for `io.fleetmates.deck.deckd`, then remove the two plists |

Logs: launchd writes each service's stdout and stderr to the state `logs` directory,
`~/.local/state/fleetmates/deck/logs/deckd.out.log` and `deckd.err.log`, and `web.out.log` and
`web.err.log`. macOS keeps the XDG paths of section 5 ([16-platforms.md](16-platforms.md)
section 7). Desktop popups use `osascript`, the bell `afplay`, and Meetings are not available
(doctor says so).

macOS was not observed on a real machine: these steps are what the adapter's unit tests pin with
an injected `platform: 'darwin'` on Linux, plus the CI job on `macos-latest`
([16-platforms.md](16-platforms.md) section 8).

### 14.3 Windows: detached processes and the Run key

There is no service manager. `fleetmates-deck start` starts deckd and the web server as detached,
hidden `node` processes, each only when its probe does not answer, writes each pid to
`%LOCALAPPDATA%\fleetmates\deck\state\run\<service>.pid` (`deckd.pid`, `web.pid`), and
appends its output to `%LOCALAPPDATA%\fleetmates\deck\state\logs\<service>.log`
(`deckd.log`, `web.log`). No admin rights are needed anywhere.

| Task | Command |
|---|---|
| Start both | `fleetmates-deck start` |
| Stop both | `fleetmates-deck stop` (web first, then deckd; stopping deckd ends every PTY session) |
| Status | `fleetmates-deck status`, `fleetmates-deck doctor` |
| Remove autostart | `reg delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v fleetmates-deck /f` |
| Logs | `Get-Content -Wait $env:LOCALAPPDATA\fleetmates\deck\state\logs\web.log` (and `deckd.log`) |

- **Autostart.** `init` adds the value `fleetmates-deck` under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, holding
  `conhost.exe --headless "<node>" "<hub>\bin\fleetmates-deck.mjs" start`, so both services
  start at logon without a console window. Then it starts both services.
- **Stop.** `stop` kills a pid only when its command line, read through PowerShell
  (`Get-CimInstance Win32_Process`), runs that service's entry file. A pid file left by a crash or
  a reboot that names another program is only removed. It kills with `taskkill /T /F`, which skips
  the server's own cleanup, so `stop` then removes that server's endpoint key and lock itself
  ([16-platforms.md](16-platforms.md) section 3).
- **Start from a local console, or let the Run key start it.** Measured on the Windows 11 test
  VM: a deck started over an OpenSSH session is killed when that session ends, because the
  session's job object ends every process in it. Start it from a local console, or log on and let
  the Run key start it.
- **Restarts.** Windows Update restarts the machine on its own schedule, which is outside the
  deck's control. A restart ends every PTY session, as a reboot does on Linux (section 4.1); the
  Run key starts the deck again at the next logon.
- Approvals: every request asks, and the deck writes no permission rules on Windows
  ([16-platforms.md](16-platforms.md) section 6, D-150). Popups and the bell are in-tab only.
  Meetings are not available (doctor says so).

## Open items

| ID | Question | Default until decided | Blocks milestone |
|---|---|---|---|
| OPS-O1 | A scribed spawned detached by the web server stays in the web unit's cgroup, so restarting or stopping the deck kills scribed and any recording. How should the deck start scribed? (Related: SM-O13, FAIL-O1, MEET-O10.) | **Decided** 2026-10-04 (D-106): `systemd-run --user --collect --unit=turbidassist-scribed --property=KillMode=process $SHELL -l -c 'exec scribed'` ([11-meetings.md](11-meetings.md) section 3.5), so scribed is outside the deck's cgroup and the login shell supplies `HF_TOKEN`. TurbidAssist change T4 (a `scribed.service` unit) is not taken. | M4 (decided) |
| OPS-O2 | The systemd user manager does not have the login shell's environment (`PATH` from shell profiles, mise or nvm, exported keys, `HF_TOKEN`). How do deckd (for UI launches) and the web server (for `claude -p` and scribed) get it? | deckd and the web server run `$SHELL -lc 'env -0'` once at start and use that environment for children; restarting deckd picks up profile changes. | M2 (launch from UI); M0 to verify |
| OPS-O3 | Tag scheme and versioning for the hub package inside the fleetmates repo, whose `release.yml` publishes the plugin on every `v*` tag. | `deck-vX.Y.Z` tags, semver from `0.1.0` at M1, separate `deck-release.yml`. | M1 |
| OPS-O4 | Public README language: English only, or English plus PT-BR like vault-mcp (EN plus PT-BR was once chosen for specs; the handoff is English only, D-45; the README was left open, Q10). | English only for M1; add PT-BR later if wanted. | M1 |
| OPS-O5 | Should the owner's machine hold Claude Code at the tested version (disable its auto-update, verify the mechanism on the pinned version), or accept updates and rely on the drift warning? | Accept updates; rely on First run and Settings drift warnings and re-capture within a week. | none |
| OPS-O6 | On uninstall, should the deck remove the permission rules it wrote into repos' `.claude/settings.local.json`? | No: rules belong to the repos and also apply to plain `claude` (Decided that they live there); uninstall lists them. | none |

Referenced, not duplicated: package and command naming (03-architecture section 3, [15-open-questions.md](15-open-questions.md) Q1), SET-O1 and SET-O2 (settings storage and language row), SM-O13 / FAIL-O1 (scribed start), SM-O18 (incompatible Claude Code blocks or warns), FR-O3 (hook merge rules, Proposed default adopted in 2.3), MEM-O5, MEET-O11, NEW-O2, TEST-O4, TEST-O6.

## Prepared M5 operations

The web server manages vault-mcp and restricted Ask children. Vault preferences recreate the
client; Retry probes it again. Read the `vault-mcp` health row for state, reason, version and
capabilities. An absent vault path reports down with `VAULT_PATH is not set`.

Ask state is under `<state>/ask/`, including a private child working directory and
`running.json` process identities for restart recovery. Unfinished assistant messages become
errors after restart. Closing the web server cancels its running asks.

`fleetmates-deck export-misses --kind retrieval|all [--out <file>]` reads the database without
migration or mutation. Output files use mode 0600. Review real golden queries locally before
adding them to the vault-mcp evaluation suite. Restarting the dogfood web server and
publishing or tagging 0.5.0 are owner actions, still pending.
