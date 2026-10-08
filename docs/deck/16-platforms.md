# 16 · Platforms: Linux, macOS and Windows

Status labels as in [02-domain.md](02-domain.md). This page replaces the "Linux only" scope of
D-05 for the deck runtime (D-149). Linux stays the reference platform. macOS and native Windows
(not WSL) run the same core: `fleetmates-deck init`, deckd, the deck server, the web deck,
`fm claude`, `fm attach` and the observation hook. A few integrations stay Linux only and say so
in `doctor` instead of failing.

## 1. What runs where

| Piece | Linux | macOS | Windows |
|---|---|---|---|
| deckd endpoint | Unix socket `$XDG_RUNTIME_DIR/fleetmates-deck/deckd.sock` | Unix socket under the runtime base of section 2 | Named pipe `\\.\pipe\fleetmates-deck-<id>-deckd` |
| hook endpoint | `hooks.sock` beside deckd | `hooks.sock` beside deckd | Named pipe `\\.\pipe\fleetmates-deck-<id>-hooks` |
| Services | systemd user units | launchd LaunchAgents in `~/Library/LaunchAgents` | Detached processes started by `fleetmates-deck start`, autostart through the HKCU Run key |
| PTY | node-pty (forkpty) | node-pty (forkpty, `spawn-helper`) | node-pty (ConPTY) |
| Login environment | `$SHELL -l -i` probe | `$SHELL -l -i` probe | Inherited service environment |
| Private files | uid and mode 0600/0700 checks | uid and mode checks | Per-user profile directory ACLs; uid and mode checks are skipped |
| Process tree kill | `kill(-pgid)` | `kill(-pgid)`, EPERM fallback | `taskkill /PID <pid> /T /F` |
| Open a URL | `$BROWSER`, xdg tools | `open` | `cmd /d /s /c start "" <url>` |
| Desktop popup | notify-send, mako | `osascript` notification | none (in-tab only) |
| Bell | `pw-play` | `afplay` | none (in-tab only) |
| Meetings (scribed) | yes | no, reported by doctor | no, reported by doctor |
| Auto-approve (safe tier) | yes | yes | no: every request asks (section 6) |

## 2. Runtime base and endpoints

Every process that talks to deckd or the hook endpoint derives the address from one function,
`runtimeBase(env, platform)` in `hub/platform/index.mjs`:

1. `XDG_RUNTIME_DIR` when it is set, on every platform. Tests rely on this.
2. macOS: `$HOME/Library/Caches/fleetmates-deck`. It is derived from `HOME` and not from
   `TMPDIR`, because launchd agents and terminal shells do not always agree on `TMPDIR`.
3. Windows: `%LOCALAPPDATA%\fleetmates-deck\run`.
4. Any other POSIX system without `XDG_RUNTIME_DIR`: `/tmp/fleetmates-deck-<uid>`.

The deck directory is `<base>/fleetmates-deck` as before. On POSIX an endpoint is
`<base>/fleetmates-deck/<name>.sock`. When that path is longer than 100 bytes (macOS allows 104,
Linux 108) the endpoint moves to `/tmp/fleetmates-deck-<uid>/<name>.sock`, and the same checks
apply to that directory.

On Windows an endpoint is `\\.\pipe\fleetmates-deck-<h>-<name>`, where `<h>` is the first 16 hex
digits of the SHA-256 of the resolved runtime base, lower-cased. Two tests with two runtime dirs
get two pipes, and the hook, which is copied alone into the share directory, computes the same
name with its own inline copy of the function. A unit test pins that the two copies agree.

The hook stays a single self-contained file (it is copied to `share/hook/deck-hook.mjs` by
`init`), so it never imports `hub/platform/`.

## 3. Authentication of local endpoints

On POSIX nothing changes: the socket is 0600 inside a 0700 directory owned by the user, and the
file mode is the authentication (03-architecture section 5).

On Windows a named pipe has no file mode. libuv creates the pipe with the default security
descriptor, which grants full control to the creating user, SYSTEM and Administrators, and read
access to Everyone. A client must open the pipe for read and write, so another non-admin user
cannot connect. The orchestrator measures this on the Windows 11 test VM with a second local
account before the change ships, and records the result here. Administrators can reach the pipe, the same as they can read a POSIX user's
files with sudo.

The pipe name is predictable. To stop another user from creating the pipe first and waiting for
the deck to connect (squatting), deckd creates its pipe with the first-instance flag that libuv
sets on every `listen` (`FILE_FLAG_FIRST_PIPE_INSTANCE`), and refuses to start when the name is
taken. A client does not verify the server, which matches the POSIX model, where the runtime
directory check is what stops a squatter.

## 4. Services

`hub/server/setup/service.mjs` is the one service adapter. It exposes `install`, `start`,
`stop`, `restart`, `isActive` and `uninstall` for the two services (`deckd`, `web`) and picks an
implementation from `process.platform`:

- **systemd** (Linux): today's behaviour, unchanged (unit files, `systemctl --user`).
- **launchd** (macOS): plists `io.fleetmates.deck.deckd.plist` and `io.fleetmates.deck.web.plist`
  with `ProgramArguments` set to the absolute node binary and entry file, `RunAtLoad`,
  `KeepAlive` on failure, `Umask` 63 (octal 077), stdout and stderr to files in the state `logs`
  directory. `launchctl bootstrap gui/<uid>`, `launchctl kickstart -k gui/<uid>/<label>`,
  `launchctl bootout` and `launchctl print` drive them.
- **detached** (Windows): `start` spawns `node <entry>` detached with `windowsHide`, writes the
  pid to `<state>/run/<service>.pid`, and logs to the state `logs` directory. `isActive` is a
  connect probe of the endpoint (deckd) or an HTTP probe (web), never the pid alone. `stop` kills
  the recorded tree with `taskkill`. `install` adds a value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` that runs
  `conhost.exe --headless <node> <fleetmates-deck.mjs> start`, so no console window appears at
  logon. No admin rights are needed anywhere.

Every caller that ran `systemctl` (`init`, `open`, doctor, the setup wait, "Start deckd" in the
deck) goes through the adapter.

## 5. Processes and terminals on Windows

- `claude` is resolved through `PATH` and `PATHEXT`. A `.exe` is spawned directly. A `.cmd` or
  `.bat` is spawned as `cmd.exe /d /s /c "<file>" <args>` with the arguments quoted for cmd.
  deckd accepts `claude`, `claude.exe` and `claude.cmd` as the program name.
- Signals: deckd's kill op maps `SIGTERM`, `SIGINT` and `SIGHUP` to a tree kill on Windows,
  because a ConPTY child cannot receive them. `SIGKILL` is the same tree kill.
- `fm` uses `process.stdout.on('resize')` instead of `SIGWINCH` everywhere, and listens for
  `SIGHUP` only where the platform delivers it.
- The hook cannot read `/proc` or `ps` on Windows, so `claudePid` is null there and session
  identity rests on `FLEETMATES_DECK_PTY`, which deckd sets for every session it launches.
- The hook command written to Claude Code settings uses double-quoted forward-slash paths on
  Windows, which both cmd and Git Bash accept. `isDeckHook` matches either separator, so `init`
  stays idempotent and uninstall finds the entry.

## 6. Approvals on Windows

The tier engine parses POSIX shell and POSIX paths. On Windows a `C:\` path can escape the
repository-scope checks, so `classify` adds `floor.platform` (tier `caution`) to every request
when the platform is `win32`. Nothing is auto-approved there; every request reaches the human.
Floors that name service control gain their macOS and Windows forms: `launchctl` against a
`io.fleetmates.deck.*` label, and writes to `~/Library/LaunchAgents/io.fleetmates.deck.*`.

## 7. Paths

| Path | Linux and macOS | Windows |
|---|---|---|
| config | `$XDG_CONFIG_HOME` or `~/.config`, then `fleetmates/deck` | `%APPDATA%\fleetmates\deck` |
| state | `$XDG_STATE_HOME` or `~/.local/state`, then `fleetmates/deck` | `%LOCALAPPDATA%\fleetmates\deck\state` |
| share | `$XDG_DATA_HOME` or `~/.local/share`, then `fleetmates-deck` | `%LOCALAPPDATA%\fleetmates\deck\share` |
| Claude settings | `$CLAUDE_CONFIG_DIR` or `~/.claude`, then `settings.json` | same |

macOS keeps the XDG layout on purpose: the deck is a developer tool next to `~/.claude`, and one
layout for the two POSIX platforms keeps the docs and the approval floors identical. XDG variables
win on Windows too when they are set, which is what the tests use.

## 8. Verification

- Linux: the hub suite and the e2e specs, as before.
- Windows: the hub suite runs on a local Windows 11 VM (dockur/windows over KVM, Node 24, Git for
  Windows), plus a manual smoke: `init`, `start`, a session from the deck, `fm claude` with the
  fake claude, `fm attach`, and a hook event reaching the Home card.
- macOS: there is no local macOS machine and a macOS VM on non-Apple hardware breaks the license,
  so the macOS paths are pinned by unit tests that inject `platform: 'darwin'`, and by running
  the Linux suite with `XDG_RUNTIME_DIR` unset and a long `HOME` (the fallback paths). The hub
  suite on a GitHub macOS runner is the last check, not the first.

Tests that assert POSIX modes, symlinks or Unix socket files skip on Windows through
`posixTest` in `hub/test/helpers/platform.mjs`, with the reason in the skip message. A skip is
reported as a skip.
