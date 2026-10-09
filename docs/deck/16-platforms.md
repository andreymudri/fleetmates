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

The Node floor is `>=24.16.0` (`engines` in `hub/package.json`) on every platform. Node 24.2 to
24.15 `node:sqlite` truncates a bound string at its first NUL. This was measured with Node 24.9 on
the Windows 11 test VM, and Node 24.16 fixes it.

On macOS node-pty runs every PTY through its prebuilt `spawn-helper`, which needs its execute bits.
npm 11 skips install scripts by default, so the deck's `postinstall` that sets them may never
run. deckd therefore makes the helper executable itself before its first PTY spawn on macOS
([13-operations.md](13-operations.md) section 14.1).

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
digits of the SHA-256 of the resolved runtime base, lower-cased, followed by a NUL and the
endpoint's secret (section 3). Without a secret `endpoint` throws on win32. Two tests with two
runtime dirs get two pipes, and the hook, which is copied alone into the share directory,
computes the same name with its own inline copy of the function. A unit test
(`hook-platform.test.mjs`) pins that the two copies agree.

The hook stays a single self-contained file (it is copied to `share/hook/deck-hook.mjs` by
`init`), so it never imports `hub/platform/`.

## 3. Authentication of local endpoints

On POSIX nothing changes: the socket is 0600 inside a 0700 directory owned by the user, and the
file mode is the authentication (03-architecture section 5).

On Windows a named pipe has no file mode. libuv creates the pipe with the default security
descriptor. Measured with a probe on the Windows 11 test VM (Node 24.21): the pipe's DACL grants
read to Everyone and to Anonymous, full control to SYSTEM and to Administrators, and full control
to the creating user. A client must open the pipe for read and write, so another non-admin user
cannot connect. Administrators can reach the pipe, the same as they can read a POSIX user's files
with sudo. A second `listen` on a pipe name that is already listening fails with `EADDRINUSE`
(measured on the same VM), so another process cannot serve a name the deck holds.

A pipe name is machine-global, and any local user can list `\\.\pipe\`. A user who could
predict the name could create it before the deck starts and receive hook envelopes or `fm`
keystrokes (squatting). The name is therefore not predictable. Each endpoint has its own key
file in the deck directory, `<deckDir(base)>\endpoint-deckd.key` and `endpoint-hooks.key`, under
`%LOCALAPPDATA%`, which only the user, SYSTEM and Administrators can read. A key is 32 random bytes
written as 64 lowercase hex digits, and the pipe name hashes it (section 2), so the name changes
every time its creator starts.

- The creator (deckd for `deckd`, the deck server for `hooks`) starts its pipe with
  `listenEndpoint` in `hub/platform/index.mjs`. It first takes a start lock,
  `endpoint-<name>.lock`, which records its pid and start time and is held while it listens. A
  lock whose holder is a live deck process (its pid is alive and was created at the recorded
  start time, within 2 s) refuses the start with `EADDRINUSE`, so deckd still refuses to run
  twice. A lock whose holder is dead, or whose pid now belongs to a process created at another
  time, is taken over. The creator then listens on the pipe of a new random key, and only then
  writes the key file, so a client never reads a key whose pipe is not yet this server's. A clean
  close removes the key and the lock.
- Clients (the deckd client used by `fm` and the web server, and the hook) read the key on every
  connect and never write it. A missing key means the server is not running: the hook spools,
  `fm` reports that deckd is not running. A key whose lock names a pid that is not alive (what a
  crashed server leaves) counts as missing for the hook and the deckd client.
- On Windows `fleetmates-deck stop` ends a service with `taskkill /F`, which skips the server's
  own close, so the service manager removes that server's key and lock itself after the kill, only
  while the lock still names the pid it killed.
- A process that answers on an old pipe name is not asked anything at the next start: the key is
  replaced, so clients move to the new name. A unit test pins that a squatter on the old name of a
  crashed server neither blocks the next start nor receives what is sent after it.

What remains (stated in `listenEndpoint`'s comment): a server ended without `stop` (a crash, a
logoff, a reboot) leaves its key and lock. Once Windows gives the dead pid to another process, the
hook and the deckd client dial the old name again until the next start replaces the key, and a
local user who saw that name and created it receives what they send. `setupPaths` and the doctor's
probe read the key without checking the lock. A client does not verify the server, which matches
the POSIX model, where the runtime directory check is what stops a squatter.

## 4. Services

`hub/server/setup/service.mjs` is the one service adapter. It exposes `install`, `start`,
`stop`, `restart`, `isActive` and `uninstall` for the two services (`deckd`, `web`) and picks an
implementation from `process.platform`:

- **systemd** (Linux): today's behaviour, unchanged (unit files, `systemctl --user`).
- **launchd** (macOS): plists `io.fleetmates.deck.deckd.plist` and `io.fleetmates.deck.web.plist`
  with `ProgramArguments` set to the absolute node binary and entry file, `RunAtLoad`,
  `KeepAlive` on failure, `Umask` 63 (octal 077), stdout and stderr to files in the state `logs`
  directory. `install` runs `launchctl bootout` and then `launchctl bootstrap gui/<uid> <plist>`
  for each; `start` is `launchctl kickstart gui/<uid>/<label>`, `restart` is
  `launchctl kickstart -k`, and `stop` is `launchctl kill SIGTERM`. `isActive` is the same
  endpoint or HTTP probe as on Windows.
- **detached** (Windows): `start` spawns `node <entry>` detached with `windowsHide`, writes the
  pid to `<state>/run/<service>.pid`, and logs to the state `logs` directory. `isActive` is a
  connect probe of the endpoint (deckd) or an HTTP probe (web), never the pid alone. `stop` first
  reads the recorded pid's command line (`Get-CimInstance Win32_Process` through PowerShell) and
  kills the tree with `taskkill /T /F` only when that command line runs this service's entry file;
  otherwise, or when the query fails, it only removes the pid file. After a failed
  `taskkill` it checks again, and `stop` fails while the process still runs. `install` adds a value under
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

ConPTY facts, measured on the Windows 11 test VM (Node 24.21, node-pty 1.1.0), and what the deck
does about each:

- **SystemRoot.** node-pty passes the environment it is given as it is, and a node child whose
  environment lacks `SystemRoot` dies at start (exit 134, a `ncrypto::CSPRNG` assertion).
  `child_process` adds the Windows base variables itself; node-pty does not. deckd hands node-pty
  `windowsChildEnv(env)`: one key per case-insensitive variable name (so `Path` and `PATH` do not
  both reach the child), with `SystemRoot`, `SystemDrive`, `windir`, `TEMP`, `TMP`,
  `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `USERNAME`, `USERDOMAIN`, `LOGONSERVER`, `ComSpec` and
  `PATHEXT` filled from deckd's own environment when the request lacks them.
- **Failed spawns.** When `CreateProcess` fails on a file that is not a PE image (error 193),
  node-pty 1.1.0 leaks the pseudoconsole, a worker thread and the input pipe, so deckd would never
  exit. deckd therefore checks the program it resolved (after `PATH`, `PATHEXT` and npm cmd-shim
  unwrapping) before it calls node-pty: anything that is not an existing `.exe` or `.com` file is
  refused with `spawn_failed`, and node-pty is not called. A `.cmd` that is not an npm shim runs
  through `ComSpec`, which is an `.exe`.
- **win32-input-mode.** ConPTY output starts with `ESC[?9001h`, the request for win32-input-mode.
  Replayed to `fm`'s own console, it switched `fm`'s stdin to input records, and the `Ctrl ]`
  byte never arrived, so `Ctrl ] d` did not detach. `createInputModeFilter` removes `ESC[?9001h`
  and `ESC[?9001l`, also when a sequence is split across reads. deckd filters each PTY's output
  before the ring buffer, the screen model and output events, and `fm` filters everything it
  writes to its own stdout. On Linux and macOS the filter passes every byte through.
- **Console replies.** The Windows console answers device attribute queries (`ESC[c`, DA1) by
  writing the reply into the child's stdin. Bracketed paste reaches the child intact.
- **No `O_NOFOLLOW`.** `fs.constants.O_NOFOLLOW` is undefined on win32, and a normal user can
  create symbolic links there, so a plain `O_NOFOLLOW` open follows a link. Every no-follow open
  in the deck goes through `openNoFollowSync` or `openNoFollow` in `hub/platform/index.mjs`. On
  POSIX they add `O_NOFOLLOW`. On win32 they `lstat` the name and refuse a symbolic link with
  `ELOOP`, open, then `fstat` the descriptor and refuse (closing it) when its device and inode
  differ from the `lstat`. An `O_CREAT | O_EXCL` open on Windows follows a dangling symbolic link
  planted after the `lstat` and creates its target; the open then refuses and removes that
  target, but only when it is still the descriptor's own empty regular file. Residual: a window
  between that `lstat` and the `unlink`, and only an empty regular file is ever removed.

## 6. Approvals on Windows

The tier engine parses POSIX shell and POSIX paths. On Windows a `C:\` path can escape the
repository-scope checks, so `classify` adds `floor.platform` (tier `caution`) to every request
when the platform is `win32`. Nothing is auto-approved there; every request reaches the human.
Floors that name service control gain their macOS and Windows forms: `launchctl` against a
`io.fleetmates.deck.*` label, and writes to `~/Library/LaunchAgents/io.fleetmates.deck.*`.

Decision (D-150):

- **POSIX path parsing for Bash.** Claude Code runs its Bash tool through Git Bash on Windows, so
  the tier engine resolves parsed command paths with `path.posix` on every platform, never with
  the host's `path`. On win32 a Windows path and its Git Bash form name the same file: `C:\x`,
  `C:/x` and `/c/x` all read as `/c/x`, with `\` read as `/`.
- **Case-insensitive deck paths.** On win32 the deck's own protected paths (from
  `setupPaths(env, { platform: 'win32' })`) match case-insensitively, with `\` and `/` alike. Every
  floor probe that is Destructive on Linux stays Destructive on win32, plus `floor.platform`.
- **No rule writes on win32.** Auto-approval is off there, and a permission rule written into
  `.claude/settings.local.json` would auto-approve inside Claude Code itself. `validatePattern`
  and the rule write path refuse every rule on win32 with `rules_unsupported_on_win32`
  (`POST /api/rules` answers 422). Rules added by hand are still listed and classified. The
  persistence floor for rules also covers `~/Library/LaunchAgents/io.fleetmates.deck.*`.

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
- Windows: the hub suite runs on a local Windows 11 VM (dockur/windows over KVM, Node 24.21, Git
  for Windows), one test file at a time, driven by scripts kept outside the repository. The
  results, all reported by the orchestrator from that VM:

  | Tree | Pass | Fail | Skipped |
  |---|---|---|---|
  | master before the port | 891 | 951 | not recorded |
  | after the Windows test sweep | 1653 | 0 | 425 |
  | after the per-endpoint pipe keys (section 3) | 1684 | 0 | 428 |

  Each skip is one test with its reason in the skip message (`posixTest`, below).
- Windows end to end, from the npm tarball (0.5.2) on the same VM:
  `npm install -g --prefix <dir> <tarball>`, `fleetmates-deck init`, `fleetmates-deck start`,
  `fleetmates-deck doctor` (exit 0, deckd and web active), then `fm claude` with a fake claude (a
  node script behind `claude.cmd`) through deckd in ConPTY. Its SessionStart, UserPromptSubmit
  and SessionEnd hooks reached the server: the session was linked to the claude session id, its
  task was taken from the prompt, and its state was ended after the exit. `fm ls` and the
  scrollback API answered, and `fm` exited 0.
- macOS: there was no macOS machine. A macOS VM on non-Apple hardware breaks the license. Nothing
  was observed on a real Mac. The macOS paths are pinned by unit tests on Linux that inject
  `platform: 'darwin'`, by the Linux suite run with `XDG_RUNTIME_DIR` unset and a long `HOME`
  (the fallback paths), and by the CI job below on `macos-latest`.
- CI: the `hub` job of `.github/workflows/deck.yml` runs on a matrix of `ubuntu-latest`,
  `macos-latest` and `windows-latest`, with `fail-fast: false`. Every runner runs the same
  steps: the Node version from `hub/.node-version`, `npm ci`, the web build, a short check of
  named platform regressions, then `npm --prefix hub test`. On Windows the browser tests use the
  Chrome of the runner image, found by `findChromium` under `%ProgramFiles%`, and the regression
  check's POSIX-only tests skip with their reason. The Windows and macOS runs of this job had not
  happened when this section was written.

Tests that assert POSIX modes, symlinks or Unix socket files skip on Windows through
`posixTest` in `hub/test/helpers/platform.mjs`, with the reason in the skip message. A skip is
reported as a skip.

A few tests pin Linux behaviour in a child process that cannot be handed another platform: the
setup CLI tests that assert systemd units, `systemctl` and `xdg-open`, and the server process test
that asserts `notify-send`, `pw-play` and scribed. They skip off Linux with their reason in the skip
message. The darwin paths they would cover are pinned by tests that inject `platform: 'darwin'`.

`npm --prefix hub test` preloads `hub/test/helpers/canonical-tmp.mjs`, which points the temp
variables at the canonical temp directory. On the GitHub Windows runner TEMP names it by its 8.3
short name (`C:\Users\RUNNER~1\...`), and the deck resolves every directory with the native
realpath, which expands that name, so a path a test built from the short name never matched.
