# Deck platforms: the deck runs on macOS and native Windows

## Destination

`fleetmates-deck` (the `hub/` package) installs and runs on Linux, macOS and native Windows: `fleetmates-deck init` and `start`, deckd, the deck server, the web deck, `fm claude`, `fm attach`, and the observation hook reaching the server live. The design is `docs/deck/16-platforms.md`. Linux behaviour is unchanged. Every platform branch takes an injectable `platform` (and where needed `spawn`, `uid`, `env`), so a Linux machine pins the darwin and win32 branches in unit tests. The orchestrator verifies Windows on a local Windows 11 VM at each gate; macOS is verified by injected-platform tests and the Linux suite with `XDG_RUNTIME_DIR` unset, and by a GitHub macOS runner only as the last check.

## Global Constraints

- Node >= 24.2.0. Zero new runtime or development dependencies, in `hub/` and at the root.
- Only `hub/` changes, plus the docs and the `.github/workflows/deck.yml` a task declares. The root fleetmates code is not touched.
- Linux behaviour is unchanged: every existing hub test that a task does not own stays green and unedited.
- Every platform branch is selected from an injectable parameter that defaults to `process.platform` (`platform = process.platform`), never from a module-level constant, so tests can pin `darwin` and `win32` on Linux.
- `hub/hook/deck-hook.mjs` stays a single self-contained file: it is copied alone by `init`, so it must not import anything under `hub/` (only `node:` modules).
- Spawns on Windows pass `windowsHide: true`. Nothing spawns a shell from a string built out of user input; argv arrays only, and `cmd.exe /d /s /c` only for a resolved `.cmd`/`.bat` file with arguments quoted by `quoteCmdArg` from `hub/platform/index.mjs`.
- Commit messages: single line, commitlint style, English, scope `deck` (for example `feat(deck): ...`). Configured git author only. Never run `git config`.
- No personal identities, credentials or real home paths in code, docs, fixtures or test output; use `/home/you` or `C:\Users\you` placeholders.
- Do not modify `fleetmates.gate.json`, any file in `docs/plans/`, or anything under `.fleetmates/`.
- Every new test must be seen failing under a targeted mutation of the code it covers, then restored (`CONTRIBUTING.md`). Name the mutations you ran in your result.
- Run the hub suite with a private short TMPDIR: `mkdir -p /tmp/hx/<task> && TMPDIR=/tmp/hx/<task> npm --prefix hub test`. Kill every deckd, deck server, fake claude and Chromium you start; from the repo root `pgrep -af "$PWD/hub/(deckd|server)/main\.mjs|fake-claude\.mjs"` must print nothing.
- No Windows or macOS machine is available to teammates. Do not claim Windows or macOS behaviour was observed; claim only what an injected-platform test on Linux shows.
- Docs in English, plain prose, no em dash character.

## Not Yet Specified

- Which shell does Claude Code use to run hook commands on native Windows (Git Bash or cmd)? The double-quoted forward-slash form is chosen because it works in both; the orchestrator confirms on the VM.

## Out of Scope

- Meetings (scribed) on macOS and Windows - scribed is a Linux tool; doctor reports it as unavailable there.
- Native Windows desktop popups and bell - the deck tab shows them; a PowerShell toast is a later change.
- Auto-approval on Windows - the tier engine parses POSIX paths; every Windows request asks (16-platforms section 6).
- WSL - it is Linux and already works as Linux where systemd is enabled.
- Releasing or publishing - after the run, by the orchestrator.

### Task 1: one platform module for runtime paths, endpoints, private files, process trees and commands

**Files:**
- Create: `hub/platform/index.mjs`
- Modify: `hub/package.json`
- Test: `hub/test/unit/platform.test.mjs`
- Test: `hub/test/unit/package-contents.test.mjs`

**Model:** capable

**Acceptance:**
- `hub/platform/index.mjs` imports only `node:` modules and exports exactly these, each taking its platform-specific inputs as options with defaults from the live process:
  - `runtimeBase({ env = process.env, platform = process.platform, uid = process.getuid?.() ?? null, home = env.HOME || os.homedir() } = {})`: `env.XDG_RUNTIME_DIR` when it is a non-empty string, on every platform; else on `darwin` `path.join(home, 'Library', 'Caches', 'fleetmates-deck')`; else on `win32` `path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'fleetmates-deck', 'run')`; else `/tmp/fleetmates-deck-<uid>`.
  - `deckDir(base, { platform } = {})`: `<base>/fleetmates-deck`, joined with `path.win32` on win32 and `path.posix` otherwise.
  - `endpoint(base, name, { platform, uid } = {})` with `name` one of `deckd`, `hooks`: on POSIX `<deckDir>/<name>.sock`, unless that string is longer than 100 bytes (`Buffer.byteLength`), then `/tmp/fleetmates-deck-<uid>/<name>.sock`; on win32 `\\.\pipe\fleetmates-deck-<h>-<name>` with `<h>` = the first 16 hex digits of SHA-256 of `path.win32.resolve(base).toLowerCase()`. Any other `name` throws.
  - `isPipe(endpointPath)`: true when it starts with `\\.\pipe\` or `\\?\pipe\`.
  - `ensurePrivateDir(dir, { platform, uid } = {})` (async): `mkdir(dir, { recursive: true, mode: 0o700 })`; on POSIX then `stat` it and throw when the owner is not `uid` (when `uid` is not null) or `mode & 0o077` is not 0, with the messages deckd uses today (`runtime dir <dir> is owned by uid <n>, not by this user`, `... has mode <oooo>; it must allow no group or world access (0700)`); on win32 only the mkdir.
  - `privateFileProblem(stat, { platform, uid, mode = 0o600 } = {})`: returns null or a one-line reason. POSIX: a reason when `uid` is not null and `stat.uid !== uid`, or `(stat.mode & 0o777) !== mode`. win32: always null.
  - `killTree(pid, signal = 'SIGTERM', { platform, kill = process.kill, spawnSync = childProcess.spawnSync } = {})`: POSIX keeps today's `signalProcessGroup` behaviour (group, ESRCH ignored, EPERM falls back to the pid); win32 runs `spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })` for any signal and returns. Returns nothing; throws only on POSIX errors other than ESRCH.
  - `resolveCommand(name, { env = process.env, platform, exists = fs.existsSync } = {})`: on POSIX returns `name` unchanged. On win32: a name with a path separator or an extension is returned as is; otherwise each `PATH` directory (split on `;`) is tried with each `PATHEXT` extension (default `.COM;.EXE;.BAT;.CMD`, compared case-insensitively) and the first existing file is returned; none found returns `name`.
  - `quoteCmdArg(arg)`: quotes one argument for `cmd.exe /d /s /c` the way cross-spawn does (escape `"` and trailing backslashes per CommandLineToArgvW, then caret-escape `()%!^"<>&|`).
  - `commandSpawn(file, args, { platform } = {})`: returns `{ file, args, options }`. win32 and `file` ends in `.cmd` or `.bat` (case-insensitive): `{ file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + [file, ...args].map(quoteCmdArg).join(' ') + '"'], options: { windowsVerbatimArguments: true, windowsHide: true } }`; win32 otherwise `options: { windowsHide: true }`; POSIX `options: {}`.
  - `openUrlArgv(url, { platform } = {})`: linux `['xdg-open', url]`, darwin `['open', url]`, win32 `['cmd.exe', '/d', '/s', '/c', 'start', '""', quoteCmdArg(url)]` (callers pass `windowsVerbatimArguments: true`).
  - `isClaudeProgram(file, { platform } = {})`: basename `claude`; on win32 also `claude.exe` and `claude.cmd`, case-insensitive.
- `hub/package.json` `files` gains `platform/`. `package-contents.test.mjs` asserts that the packed file list includes `platform/index.mjs`.
- `platform.test.mjs` covers every export for `linux`, `darwin` and `win32` with injected inputs, including: XDG wins on darwin and win32; the 100-byte fallback (a long `XDG_RUNTIME_DIR` gives `/tmp/fleetmates-deck-<uid>/deckd.sock`); two different bases give two different pipe names and the same base with different case gives the same one; an unknown endpoint name throws; `ensurePrivateDir` on a real temp dir rejects mode 0755 on linux and accepts it with `platform: 'win32'`; `privateFileProblem` for wrong uid, wrong mode and win32; `killTree` win32 calls the injected `spawnSync` with the taskkill argv and never calls `kill`; POSIX EPERM fallback; `resolveCommand` finds `claude.cmd` in a temp PATH dir under `platform: 'win32'` (inject `exists`), prefers `.EXE` over `.CMD` when PATHEXT says so; `commandSpawn` for `.cmd`, `.exe` and POSIX; `quoteCmdArg` on `a b`, `a"b`, `a&b`, `100%`, and a trailing backslash; `openUrlArgv` per platform; `isClaudeProgram`.
- Mutations each fail a test, then are restored: drop the XDG-first rule; drop `.toLowerCase()` from the pipe hash; drop the 100-byte fallback; make `ensurePrivateDir` skip the mode check on linux; make `killTree` call `kill` on win32; drop the caret escape of `&`.

- [ ] Step 1: Write `platform.test.mjs`; observe it fail (module missing).
- [ ] Step 2: Implement `hub/platform/index.mjs`; add `platform/` to `files`; extend `package-contents.test.mjs`.
- [ ] Step 3: Run the mutations; restore; run the hub suite; commit only the declared files.

### Task 2: test helpers that work on Windows

**Files:**
- Create: `hub/test/helpers/platform.mjs`
- Modify: `hub/test/helpers/fake-bin.mjs`
- Modify: `hub/test/helpers/runtime-dir.mjs`
- Modify: `hub/test/fake-claude/fake-claude.mjs`
- Test: `hub/test/unit/test-helpers-platform.test.mjs`

**Model:** mid

**Acceptance:**
- `hub/test/helpers/platform.mjs` exports `isWindows` (`process.platform === 'win32'`), `posixTest(name, [opts], fn)`, which is `test` from `node:test` off Windows and `test.skip` on Windows with the skip message `POSIX only: <reason>` where `<reason>` is `opts.reason` or `file modes, symlinks or Unix sockets`, and `posixIt` with the same contract for `describe`/`it` style files. `FLEETMATES_TEST_FORCE_WINDOWS=1` (test-only) makes `isWindows` true and `posixTest` skip, so Linux can see the skip path. It imports nothing from `hub/platform/` (helpers must not depend on the code under test).
- `fake-bin.mjs`: on Windows (`process.platform === 'win32'`, or `FLEETMATES_TEST_FORCE_WINDOWS=1` for the content check only) it writes `claude.cmd` containing `@"<node>" "<fake-claude.mjs>" %*` with CRLF line endings instead of the `#!/bin/sh` wrapper; the POSIX wrapper is byte-identical to today's. It also returns `claudePath`, the full path of the file it wrote.
- `runtime-dir.mjs`: the `chmod` is skipped on Windows; nothing else changes.
- `fake-claude.mjs`: runs hook commands with `spawn(command, { shell: true })` on Windows and keeps `spawn('/bin/sh', ['-c', command])` elsewhere; reports resize through `process.stdout.on('resize')` in addition to `SIGWINCH`, de-duplicated so one resize is reported once.
- `test-helpers-platform.test.mjs` covers: `posixTest` runs on linux and skips with the message under `FLEETMATES_TEST_FORCE_WINDOWS=1` (spawn a child `node --test` on a one-test file under TMPDIR and read the TAP `# skip` count and message); `fakeBin` writes the `.cmd` content under the force flag and the unchanged shell wrapper without it; the fake claude reports exactly one resize event when both signals fire for one resize.
- Mutations each fail a test, then are restored: `posixTest` ignoring the force flag; the `.cmd` missing `%*`; reporting the resize twice.

- [ ] Step 1: Write the test; observe it fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 3: a service adapter for systemd, launchd and detached Windows processes

**Files:**
- Create: `hub/server/setup/service.mjs`
- Modify: `hub/server/setup/units.mjs`
- Test: `hub/test/unit/service.test.mjs`

**Model:** capable

**Acceptance:**
- `hub/server/setup/service.mjs` exports `createServiceManager({ platform = process.platform, paths, nodePath = process.execPath, hubPath, run, spawn, uid = process.getuid?.() ?? null, probe, writeFile, mkdir, readFile, rm, env = process.env })`, where `paths` is the object `setupPaths()` returns (`config`, `state`, `logs`, `units`, `home`), `run(file, args)` resolves `{ code, stdout, stderr }`, and `probe(service)` resolves a boolean (deckd: endpoint connect; web: HTTP). It does not import `hub/platform/`. It returns `{ kind, install(), start(service), stop(service), restart(service), isActive(service), uninstall(), describe(service) }` for `service` in `deckd`, `web`, with `kind` one of `systemd`, `launchd`, `detached`.
  - `systemd` (linux): `install` writes the two units with today's `renderUnit`/`writeUnit` and runs `systemctl --user daemon-reload`, `try-restart` and `enable --now` exactly as `bin/fleetmates-deck.mjs` does today; `start` is `systemctl --user start <unit>`; `isActive` is `systemctl --user is-active --quiet <unit>` exit 0; `describe` returns `journalctl --user -u <unit>`.
  - `launchd` (darwin): `install` writes `~/Library/LaunchAgents/io.fleetmates.deck.deckd.plist` and `io.fleetmates.deck.web.plist` (from `paths.home`) rendered by `renderPlist(label, nodePath, entry, logsDir)` with `Label`, `ProgramArguments` [nodePath, entry], `RunAtLoad` true, `KeepAlive` `{ SuccessfulExit: false }`, `Umask` 63, `ProcessType` `Interactive`, `StandardOutPath`/`StandardErrorPath` under `paths.logs`, all strings XML-escaped; then for each: `launchctl bootout gui/<uid>/<label>` (failure ignored) and `launchctl bootstrap gui/<uid> <plist>`. `start` is `launchctl kickstart gui/<uid>/<label>`, `restart` adds `-k`, `stop` is `launchctl kill SIGTERM gui/<uid>/<label>`, `isActive` is `probe(service)`, `uninstall` boots out and removes the plists, `describe` names the log files.
  - `detached` (win32): `start` spawns `nodePath entry` with `{ detached: true, windowsHide: true, stdio: ['ignore', out, err] }` where `out`/`err` are append-mode fds of `<logs>/<service>.log`, calls `unref()`, and writes the pid to `<state>/run/<service>.pid`; `start` of an active service is a no-op. `isActive` is `probe(service)`. `stop` reads the pid file and runs `taskkill /PID <pid> /T /F`, then removes the pid file. `install` runs `reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v <name> /t REG_SZ /d <command> /f` for one value `fleetmates-deck` whose command is `conhost.exe --headless "<node>" "<hub>/bin/fleetmates-deck.mjs" start`, then starts both services. `uninstall` deletes the value and stops both. `describe` names the log files.
  - Entry files: deckd `<hub>/deckd/main.mjs`, web `<hub>/server/main.mjs`.
- `units.mjs` keeps `UNIT_NAMES`, `renderUnit` and `writeUnit` byte-identical in output and adds `LAUNCHD_LABELS` and `renderPlist`.
- `service.test.mjs` pins, with injected `run`/`spawn`/fs functions and no real service manager: the exact argv sequence of `install`/`start`/`isActive` for systemd (equal to today's `init`); the plist XML for a label, including escaping of `&` and `<` in a path and `Umask` 63; the launchd argv with `gui/<uid>`; the detached spawn options (`detached`, `windowsHide`), the pid file write, the taskkill argv in `stop`, the `reg add` argv in `install`, and that `isActive` trusts `probe`, not the pid file.
- Mutations each fail a test, then are restored: drop `windowsHide`; drop the `bootout` before `bootstrap`; make `isActive` read the pid file; change `Umask` to 18.

- [ ] Step 1: Write the test; observe it fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 4: deckd listens on the platform endpoint and runs claude through ConPTY on Windows

**Files:**
- Modify: `hub/deckd/main.mjs`
- Modify: `hub/deckd/client.mjs`
- Modify: `hub/deckd/pty-host.mjs`
- Modify: `hub/deckd/login-env.mjs`
- Test: `hub/test/unit/login-env.test.mjs`
- Test: `hub/test/unit/pty-signals.test.mjs`
- Test: `hub/test/integration/deckd.test.mjs`
- Test: `hub/test/integration/deckd-m2.test.mjs`

**Depends:** T1, T2

**Model:** capable

**Acceptance:**
- `deckd/main.mjs`: `main()` takes the base from `runtimeBase()` instead of exiting when `XDG_RUNTIME_DIR` is unset. `startDeckd({ runtimeDir, platform = process.platform, ... })` uses `ensurePrivateDir(deckDir(runtimeDir))` and `endpoint(runtimeDir, 'deckd')`. `socketPaths()` keeps its signature and returns the endpoint as `socketPath`. On a pipe endpoint: no stale-socket lstat/unlink, no umask, no chmod, no unlink on close; a second deckd on the same base fails to listen with `another deckd is listening on <pipe>` (EADDRINUSE). POSIX keeps today's sequence exactly. The kill op on win32 maps SIGTERM, SIGINT and SIGHUP to `killTree`.
- `deckd/client.mjs`: `connectDeckd({ runtimeDir })` connects to `endpoint(runtimeDir, 'deckd')`. It may import `hub/platform/index.mjs` (no node-pty).
- `deckd/pty-host.mjs`: the program check uses `isClaudeProgram`; on win32 the spawn resolves `argv[0]` with `resolveCommand` and, for `.cmd`/`.bat`, spawns `ComSpec` with `['/d', '/s', '/c', <quoted command line>]` built by `commandSpawn`; string data from ConPTY is already handled by the `onData` path. `signalProcessGroup` becomes a re-export of `killTree` behaviour for POSIX (keep the export name; its existing tests stay green). `#signalGroup` calls `killTree(this.pid, signal, { platform })`.
- `deckd/login-env.mjs`: `captureLoginEnv({ platform = process.platform, ... })` returns `dropSessionVars(baseEnv)` on win32 without spawning, and calls `onFallback('windows')`. POSIX unchanged.
- Tests: `login-env.test.mjs` adds the win32 case (no spawn, reason `windows`). `pty-signals.test.mjs` adds `isClaudeProgram`-based refusal cases and the win32 kill path through an injected platform. `deckd.test.mjs` and `deckd-m2.test.mjs`: every assertion of POSIX file modes, socket files or SIGTERM-to-group semantics is wrapped in `posixTest`; add one integration test that starts deckd with `XDG_RUNTIME_DIR` removed from its env and `HOME` set to a temp dir, on linux, and connects through `connectDeckd` with `runtimeDir` from `runtimeBase({ env })` (the `/tmp/fleetmates-deck-<uid>` fallback; clean it up after).
- Mutations each fail a test, then are restored: `main()` exiting again when XDG is unset; the client using the old hard-coded path; dropping `claude.cmd` from the accepted names; `captureLoginEnv` spawning on win32.

- [ ] Step 1: Write the new tests; observe them fail.
- [ ] Step 2: Implement; wrap the POSIX-only assertions; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 5: the deck server starts on macOS and Windows

**Files:**
- Modify: `hub/server/main.mjs`
- Modify: `hub/server/db/index.mjs`
- Modify: `hub/server/http/auth.mjs`
- Modify: `hub/server/ingest/socket.mjs`
- Modify: `hub/server/pty/link.mjs`
- Modify: `hub/server/ask/engine.mjs`
- Modify: `hub/server/adapters/vault-mcp.mjs`
- Modify: `hub/server/adapters/notify.mjs`
- Modify: `hub/server/setup/browser.mjs`
- Test: `hub/test/unit/db.test.mjs`
- Test: `hub/test/unit/ingest.test.mjs`
- Test: `hub/test/unit/notify.test.mjs`
- Test: `hub/test/unit/ask-engine.test.mjs`
- Test: `hub/test/unit/vault-mcp-client.test.mjs`
- Test: `hub/test/integration/server.test.mjs`
- Test: `hub/test/integration/deckd-link.test.mjs`
- Test: `hub/test/integration/m1-cleanup-server.test.mjs`

**Depends:** T1, T2, T3

**Model:** capable

**Acceptance:**
- No unguarded `process.getuid()` remains under `hub/server/` (grep pins it in a test that strips comments first). `privateDir` in `main.mjs`, the DB dir check in `db/index.mjs` and `readToken` in `http/auth.mjs` use `ensurePrivateDir` / `privateFileProblem`; on win32 a token file is accepted on owner profile ACLs alone. POSIX refusals keep their messages.
- `ingest/socket.mjs`: `startHookSocket({ runtimeDir, platform })` listens on `endpoint(runtimeDir, 'hooks')`; on a pipe it skips lstat/ino/chmod/unlink; POSIX unchanged.
- `main.mjs` and `pty/link.mjs`: the hook socket, the deckd link and the deckd status use `runtimeBase({ env })`, so they run without `XDG_RUNTIME_DIR`. "Start deckd" calls the service adapter's `start('deckd')` instead of `systemctl`. `services.open` uses `openUrlArgv`. The scribed socket and "Start scribed" stay Linux-only: on other platforms meetings report `unsupported on <platform>` instead of spawning `systemd-run`.
- `ask/engine.mjs`: spawns `claudeCommand` through `resolveCommand` + `commandSpawn` (adding `windowsHide`), and its `killGroup` uses `killTree`.
- `vault-mcp.mjs`: spawns its command through `resolveCommand` + `commandSpawn`, so `npx` resolves to `npx.cmd` on win32.
- `notify.mjs`: `createNotifier({ platform = process.platform, ... })` keeps linux defaults; darwin defaults to `osascript -e 'display notification ...'` (title and body passed as separate `-e` argument strings built with AppleScript string escaping, never shell) and `afplay /System/Library/Sounds/Glass.aiff`, with no action buttons; win32 returns a notifier whose popup and bell resolve `{ ok: false, reason: 'unsupported on win32' }` without spawning.
- `setup/browser.mjs`: on darwin opens with `open`, on win32 with `openUrlArgv`; linux unchanged.
- `m1-cleanup-server.test.mjs` 'Retry now without XDG_RUNTIME_DIR...' pinned the old behaviour (nothing connects without XDG); it now expects the startup connect attempt's `down` row before `checking`, and keeps asserting the true down state is republished.
- Tests cover each branch with injected `platform` and spawn/run functions. `server.test.mjs` adds one test that boots the server with `XDG_RUNTIME_DIR` removed and asserts the hook endpoint and deckd link resolve to the `runtimeBase` fallback; POSIX-mode assertions in the owned test files are wrapped in `posixTest`.
- Mutations each fail a test, then are restored: an unguarded `getuid` in `auth.mjs`; the server requiring `XDG_RUNTIME_DIR` for the hook socket; the darwin notifier building a shell string; the ask engine spawning without `commandSpawn`.

- [ ] Step 1: Write the new tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 6: install, doctor and paths per platform

**Files:**
- Modify: `hub/bin/fleetmates-deck.mjs`
- Modify: `hub/server/setup/paths.mjs`
- Modify: `hub/server/setup/doctor.mjs`
- Modify: `hub/server/setup/wait.mjs`
- Test: `hub/test/unit/setup.test.mjs`
- Test: `hub/test/unit/dogfood-setup.test.mjs`

**Depends:** T1, T3

**Model:** capable

**Acceptance:**
- `setupPaths(env = process.env, { platform = process.platform } = {})`: linux and darwin unchanged (XDG layout). win32 per `docs/deck/16-platforms.md` section 7: config `%APPDATA%\fleetmates\deck`, state `%LOCALAPPDATA%\fleetmates\deck\state`, share `%LOCALAPPDATA%\fleetmates\deck\share`; XDG variables still win when set. `runtime` is `deckDir(runtimeBase({ env, platform }))`, never null. `units` stays the systemd dir on linux, is `~/Library/LaunchAgents` on darwin and null on win32. `endpoints: { deckd, hooks }` is added from `endpoint()`.
- `bin/fleetmates-deck.mjs`: `init` installs services through `createServiceManager` (no direct `systemctl`); `open` starts the web service through it; new `start` and `stop` subcommands call the adapter for both services; `privateDir`/token writes use `ensurePrivateDir`. Help text lists `start` and `stop`. On linux the observable `init` sequence is unchanged (same files, same systemctl argv, via the adapter).
- `doctor.mjs` and `wait.mjs`: deckd active means the adapter's `isActive('deckd')`; the socket probe connects to `paths.endpoints.deckd`; claude's version runs through `resolveCommand` + `commandSpawn`; the scribed check reports `unsupported on <platform>` off linux; the notification check reports `in-tab only on win32`.
- Tests: `setup.test.mjs` covers win32 and darwin paths, the `runtime`/`endpoints` fields, `start`/`stop` argument parsing, and doctor results per platform with injected adapter and run functions. Existing linux expectations stay unchanged.
- Mutations each fail a test, then are restored: `runtime` null when XDG is unset; doctor calling `systemctl` directly on darwin; win32 config under `~/.config`.

- [ ] Step 1: Write the new tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 7: the hook and fm on macOS and Windows

**Files:**
- Modify: `hub/hook/deck-hook.mjs`
- Modify: `hub/server/setup/hooks.mjs`
- Modify: `hub/bin/fm.mjs`
- Test: `hub/test/unit/hook-version.test.mjs`
- Test: `hub/test/unit/hook-platform.test.mjs`
- Test: `hub/test/contract/hooks.test.mjs`
- Test: `hub/test/integration/fm.test.mjs`

**Depends:** T1, T2

**Model:** capable

**Acceptance:**
- `deck-hook.mjs` gains a self-contained `hookEndpoint(env, platform)` that returns exactly what `endpoint(runtimeBase({ env, platform }), 'hooks', ...)` returns; it imports only `node:` modules. `hook-platform.test.mjs` pins parity between the two for linux (XDG set and unset, long base), darwin and win32 bases. Ancestry on win32 returns null without spawning. The spool path is unchanged.
- `setup/hooks.mjs`: `deckHookCommand(execPath, hookPath, { platform })` keeps today's POSIX single-quoted form on linux and darwin; on win32 emits `"<node>" "<hook>"` with both paths converted to forward slashes and refuses a path containing `"`, `%`, `` ` `` or `$`. `isDeckHook` matches `/` and `\` separators, so a win32 entry is recognised for idempotent `init` and for uninstall.
- `fm.mjs`: connects with `runtimeBase()` instead of requiring `XDG_RUNTIME_DIR`; spawns plain claude through `resolveCommand` + `commandSpawn`; resize uses `process.stdout.on('resize')`; `SIGHUP` handling is registered only off win32; `repoOf` uses `path.sep`-agnostic home replacement.
- Tests: the parity test above; `deckHookCommand`/`isDeckHook` win32 cases including a second `transformHooks` run adding nothing; `fm.test.mjs` adds a run with `XDG_RUNTIME_DIR` removed (linux fallback base) attaching to a deckd started on that base; POSIX `stty` assertions wrapped in `posixTest`.
- Mutations each fail a test, then are restored: the hook's pipe hash without `.toLowerCase()`; `isDeckHook` matching only `/`; fm exiting when XDG is unset.

- [ ] Step 1: Write the new tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 8: approvals ask for everything on Windows and know the macOS and Windows service controls

**Files:**
- Modify: `hub/server/approvals/tiers.mjs`
- Modify: `hub/server/machines/request.mjs`
- Test: `hub/test/unit/tiers.test.mjs`
- Test: `hub/test/unit/machines.test.mjs`

**Model:** capable

**Acceptance:**
- `classify(input)` accepts `input.platform` (default `process.platform`). On `win32` it adds `reason('floor.platform', 'caution', '', 'Windows requests always ask: the tier rules read POSIX paths')`, so no request is `safe` and `ruleCandidate` is null.
- The `floor.deck` service-control floor also matches `launchctl` with any argument containing `io.fleetmates.deck`, `reg` writing under `CurrentVersion\Run` with value `fleetmates-deck`, and `reg add` or `reg delete` against that key. The persistence floor also covers `~/Library/LaunchAgents/io.fleetmates.deck.*`. `machines/request.mjs` mirrors the `launchctl` rule where it mirrors `systemctl` today.
- Tests: win32 makes a known-safe Bash command (`git status`) `caution` with `floor.platform` and no rule candidate; linux and darwin keep it `safe`; `launchctl kickstart gui/501/io.fleetmates.deck.deckd` is destructive with `floor.deck`; a Write to `~/Library/LaunchAgents/io.fleetmates.deck.web.plist` hits the persistence floor; the request.mjs mirror.
- Mutations each fail a test, then are restored: drop the win32 floor; drop the launchctl rule.

- [ ] Step 1: Write the tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

## Phases 3 to 6: the Windows sweep (amendment, 2026-10-09)

Phases 1 and 2 were verified file by file on the Windows 11 VM. A full run of the hub suite on the merged phase 2 tree on that VM gave 1149 pass, 364 fail, 159 skipped, plus 5 files over the 180 s per-file budget. Every failure was classified (A: a test assumes POSIX, B: a product bug on Windows, C: the VM, D: Linux only by design). The tasks below fix every A, B and D item. Facts measured on the VM that these tasks rely on:

- A node child spawned through node-pty (ConPTY) with an environment lacking `SystemRoot` exits 134 (`ncrypto::CSPRNG` assertion). `child_process` adds the Windows base variables itself; node-pty does not.
- node-pty 1.1.0 leaks the ConPTY, a Worker thread and the conin pipe when `CreateProcess` fails (error 193, a file that is not a PE image), so the process never exits.
- ConPTY output starts with `ESC[?9001h` (win32-input-mode). When `fm` replays it to its own console, the console switches `fm`'s stdin to win32-input-mode records and the `Ctrl ]` byte never arrives, so `Ctrl ] d` does not detach.
- `fs.constants.O_NOFOLLOW` is undefined on win32 and a normal user can create symlinks there, so every `O_NOFOLLOW` open follows a symlink.
- On win32 `{ ...process.env, PATH: x }` leaves both `Path` and `PATH`; the child uses `Path`, so the fake claude was bypassed and the real one ran.
- Node 24.2 through 24.15 `node:sqlite` truncates a bound string at its first NUL on every platform; 24.16.0 and later do not.
- Git for Windows runs `filter.<name>.clean` through its own sh, where a `C:\...` path loses its backslashes.
- A Windows directory cannot be removed while a SQLite file in it is open or while a child process has its cwd there (EPERM/EBUSY).

### Task 9: platform helpers for Windows children, no-follow opens and win32-input-mode, and Windows-safe test helpers

**Files:**
- Modify: `hub/platform/index.mjs`
- Modify: `hub/test/helpers/fake-bin.mjs`
- Create: `hub/test/helpers/chromium.mjs`
- Test: `hub/test/unit/platform.test.mjs`
- Test: `hub/test/unit/test-helpers-platform.test.mjs`

**Depends:** T4, T5, T6, T7, T8

**Model:** capable

**Acceptance:**
- `hub/platform/index.mjs` adds, each taking `platform = process.platform`:
  - `windowsChildEnv(env, { base = process.env, platform } = {})`: on POSIX returns `env` unchanged. On win32 returns a new object with one key per case-insensitive name (a later key in `env` wins over an earlier one, and `env` wins over `base`), and fills each of `SystemRoot`, `SystemDrive`, `windir`, `TEMP`, `TMP`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `USERNAME`, `USERDOMAIN`, `LOGONSERVER`, `ComSpec`, `PATHEXT` from `base` (case-insensitive lookup) when `env` has none.
  - `openNoFollowSync(file, flags = fs.constants.O_RDONLY, { platform, fs: fsImpl = fs } = {})` returning an fd, and `openNoFollow(file, flags, opts)` returning a `FileHandle`. POSIX: `open(file, flags | O_NOFOLLOW)`, unchanged behaviour. win32: `lstat` first and throw an error with `code: 'ELOOP'` when it is a symbolic link; open; `fstat` the fd and compare `dev` and `ino` with the lstat result (bigint stats), closing and throwing `ELOOP` on a mismatch.
  - `createInputModeFilter({ platform } = {})`: returns `(chunk: string) => string`. On win32 it removes every `ESC [ ? 9001 h` and `ESC [ ? 9001 l`, including a sequence split across chunks (it holds back at most the incomplete prefix and emits it with the next chunk when it turns out not to be the sequence). On POSIX it returns the chunk unchanged.
- `hub/test/helpers/fake-bin.mjs`: on win32 the returned `env` has exactly one PATH key (every key matching `/^path$/i` removed, then `PATH` set). It also exports `nodeClaudeShim(dir)`, which writes an npm-style cmd-shim `claude.cmd` that runs the fake claude with `process.execPath` (the shape `unwrapCmdShim` recognises), and returns its path.
- `hub/test/helpers/chromium.mjs` exports `findChromium()`: `CHROMIUM_PATH` when set and existing, else the first existing of `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `%ProgramFiles%\Google\Chrome\Application\chrome.exe`, `%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe`, `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`; else null. It imports nothing from `hub/` outside `test/`.
- Tests: `platform.test.mjs` covers `windowsChildEnv` (POSIX identity; win32 with `Path` and `PATH` both present collapses to one key holding the `env` value; missing `SystemRoot` filled from base; present one kept), `openNoFollowSync`/`openNoFollow` on a real temp symlink (POSIX refuses with ELOOP; win32 path with an injected `fs` whose `lstat` reports a symlink refuses with ELOOP; an injected dev/ino mismatch refuses), and `createInputModeFilter` (removes both sequences, a sequence split at every byte offset across two chunks, leaves `ESC[?900h` and other CSI alone, POSIX identity). `test-helpers-platform.test.mjs` covers the single PATH key (inject a `Path`-bearing env under the force flag) and `nodeClaudeShim` content.
- Mutations each fail a test, then are restored: `windowsChildEnv` keeping both `Path` and `PATH`; `openNoFollowSync` skipping the lstat on win32; the filter dropping the carry buffer; `fakeBin` keeping `Path`.

- [ ] Step 1: Write the tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 10: deckd and fm on Windows: child environment, failed spawns, detach

**Files:**
- Modify: `hub/deckd/pty-host.mjs`
- Modify: `hub/bin/fm.mjs`
- Test: `hub/test/unit/deckd-protocol.test.mjs`
- Test: `hub/test/unit/pty-signals.test.mjs`
- Test: `hub/test/integration/deckd-m3.test.mjs`
- Test: `hub/test/integration/fm.test.mjs`
- Test: `hub/test/integration/launch.test.mjs`
- Test: `hub/test/integration/deliver.test.mjs`

**Depends:** T9

**Model:** capable

**Acceptance:**
- `pty-host.mjs`, on win32 only (POSIX unchanged): the env handed to node-pty is `windowsChildEnv(requestEnv)`; before calling node-pty the resolved file (after `commandSpawn`) must exist and end in `.exe` or `.com` (case-insensitive), otherwise the spawn is refused with the existing `spawn_failed` error shape and node-pty is never called; output passes through one `createInputModeFilter({ platform })` per PTY before the ring, the screen model and output events.
- `fm.mjs`: everything written to its own stdout from the session passes through `createInputModeFilter({ platform })`, so a replayed `ESC[?9001h` never reaches the outer console.
- Tests: `pty-signals.test.mjs` win32 cases inject an existing `.exe` (or `.com`) where they expect node-pty to be called, so the PE check does not refuse them. `deckd-protocol.test.mjs` uses `nodeClaudeShim` on win32 instead of a shebang stub, and adds a unit test with an injected platform win32 and an injected node-pty spawn that asserts a `.mjs` or missing file is refused without calling it. `deckd-m3.test.mjs` passes on Windows. `fm.test.mjs`: kills sessions with `killTree`, removes temp dirs with `maxRetries`, builds `fm ls` expectations with `path.join`, and skips the byte-exact replay assertions on win32 with the reason `ConPTY re-renders output`. `launch.test.mjs` registers every `t.after` cleanup before the call that can throw and builds state paths with `setupPaths(env)`. `deliver.test.mjs` passes on Windows (the SystemRoot fix).
- Mutations each fail a test, then are restored: drop `windowsChildEnv` in pty-host (the VM run fails; on Linux the injected-platform unit test fails); drop the PE check; drop the filter in fm.

- [ ] Step 1: Write the tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 11: opens that refuse symlinks on Windows, and the machines tests

**Files:**
- Modify: `hub/server/adapters/fleetmates.mjs`
- Modify: `hub/server/approvals/extension-scan.mjs`
- Modify: `hub/server/machines/session.mjs`
- Modify: `hub/server/machines/request.mjs`
- Modify: `hub/server/http/open.mjs`
- Modify: `hub/server/research/output.mjs`
- Modify: `hub/server/approvals/confirm-count.mjs`
- Modify: `hub/server/adapters/git-diff.mjs`
- Modify: `hub/bin/fleetmates-deck.mjs`
- Create: `hub/test/unit/no-follow-sites.test.mjs`
- Test: `hub/test/unit/fleetmates-adapter.test.mjs`
- Test: `hub/test/unit/machines.test.mjs`
- Test: `hub/test/unit/confirm-count.test.mjs`
- Test: `hub/test/unit/git-diff.test.mjs`
- Test: `hub/test/unit/export-misses.test.mjs`

**Depends:** T9

**Model:** capable

**Acceptance:**
- Every `O_NOFOLLOW` open in the listed source files goes through `openNoFollowSync` or `openNoFollow` from `hub/platform/index.mjs`, keeping each site's flags and error handling. `bin/fleetmates-deck.mjs` `export-misses --out` refuses a symlinked output file on every platform.
- `no-follow-sites.test.mjs` reads every `.mjs` under `hub/server`, `hub/bin` and `hub/deckd` with comments stripped and asserts that `O_NOFOLLOW` appears only in `hub/platform/index.mjs` and `hub/server/meetings/` (Linux only) and `hub/bin/prepare-native.mjs` (darwin only).
- The listed test files pass on Windows or skip with a stated reason: symlink scenarios run on Windows (they now refuse); executable-bit, file-mode, mkfifo and `#!/bin/sh` fixtures are `posixTest`; git filter fixtures use forward-slash paths; harness cleanups close stores first and remove with `maxRetries`; path assertions use `path.join`/`path.relative`; the CRLF test sets `GIT_CONFIG_NOSYSTEM=1` for the product's git or skips with the reason `core.autocrlf from the system config`. Linux assertions stay strict.
- Mutations each fail a test, then are restored: one site back to a raw `O_NOFOLLOW` open (the sites test fails); `export-misses --out` following a symlink.

- [ ] Step 1: Write the tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 12: approvals on Windows parse Bash paths as POSIX and refuse rule writes; LaunchAgents persistence floor

**Files:**
- Modify: `hub/server/approvals/tiers.mjs`
- Modify: `hub/server/approvals/rules.mjs`
- Test: `hub/test/unit/tiers.test.mjs`
- Test: `hub/test/unit/tiers-corpus.test.mjs`
- Test: `hub/test/unit/screen-match.test.mjs`
- Test: `hub/test/unit/approvals-shell.test.mjs`
- Test: `hub/test/unit/rules/validate.test.mjs`
- Test: `hub/test/unit/rules/suggest.test.mjs`
- Test: `hub/test/integration/rules-api.test.mjs`

**Depends:** T9

**Model:** capable

**Acceptance:**
- Decision (recorded by Task 17 in 16-platforms section 6): Claude Code runs the Bash tool through Git Bash on Windows, so `tiers.mjs` resolves parsed command paths with `path.posix` on every platform (never the host `path`), and on win32 also matches the deck's protected paths (from `setupPaths(env, { platform: 'win32' })`) case-insensitively with `\` and `/` treated alike and `C:\x` equal to `/c/x`. On win32 every Destructive floor probe that is Destructive on linux is Destructive (`docker run -v /:/host x`, `cp`/`tee` to `~/.bashrc`, `cp x <state>\token`), plus `floor.platform`.
- `rules.mjs`: `validatePattern` and the rule write path refuse every rule on win32 with `{ ok: false, code: 'rules_unsupported_on_win32' }`, because auto-approval is off there (16-platforms section 6) and a written rule would auto-approve inside Claude Code. The persistence floor covers `~/Library/LaunchAgents/io.fleetmates.deck.*` for rules (the T8 deferral).
- Tests: the 15 Destructive floor probes run with `platform: 'win32'` and assert Destructive; rule writes on win32 refused; the LaunchAgents rule refused; tests that pin POSIX `safe` classification pass `platform: 'linux'` (or skip on win32 with the reason `validatePattern classifies for the host`), and `tiers-corpus` keeps one win32 row asserting `floor.platform`; `rules-api` registers `store.close()` before the directory removal and builds paths with `setupPaths`; `rules/suggest` closes before removal. The linear-time test in `approvals-shell.test.mjs` compares the 100 KB parse against a 10 KB parse of the same shape (ratio below 30) instead of an absolute time, so it holds on a loaded machine.
- Mutations each fail a test, then are restored: `tiers.mjs` back to the host `path`; the win32 rule refusal removed; the LaunchAgents rule floor removed.

- [ ] Step 1: Write the tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 13: server integration tests build deck paths with setupPaths (part 1)

**Files:**
- Modify: `hub/test/helpers/memory-harness.mjs`
- Test: `hub/test/integration/answer-api.test.mjs`
- Test: `hub/test/integration/archive-api.test.mjs`
- Test: `hub/test/integration/classify-throw.test.mjs`
- Test: `hub/test/integration/deckd-link.test.mjs`
- Test: `hub/test/integration/deliver-recovery.test.mjs`
- Test: `hub/test/integration/diff-api.test.mjs`
- Test: `hub/test/integration/m1-evidence-server-fixes.test.mjs`
- Test: `hub/test/integration/m1-server-fixes.test.mjs`
- Test: `hub/test/integration/memory-privacy.test.mjs`
- Test: `hub/test/integration/restart.test.mjs`
- Test: `hub/test/integration/run-join.test.mjs`
- Test: `hub/test/integration/run-watch.test.mjs`
- Test: `hub/test/integration/runs-crew-open.test.mjs`
- Test: `hub/test/unit/archive.test.mjs`

**Depends:** T9

**Model:** mid

**Acceptance:**
- Every hardcoded `.local/state/fleetmates/deck`, `.config/fleetmates/deck` or `.local/share/fleetmates-deck` in these files is replaced by the matching field of `setupPaths(env)` for the env the test hands the server, so the test writes where the server reads on every platform. On linux the resolved paths are byte-identical to today's.
- `claudeCommand` and claude spawns use `bin.claudePath`. Cleanups are registered before the call that can throw, close stores before removing directories, and remove with `maxRetries`. `mkfifo` cases are `posixTest`.
- Each listed file passes on Windows or skips individual tests with a stated reason; no file-level skip.
- Mutation: point `memory-harness.mjs` back at the hardcoded path with `platform` forced to win32 through `setupPaths` (a test fails). Name it in the result.

- [ ] Step 1: Edit; run the hub suite; commit only the declared files.

### Task 14: server, web and setup tests on Windows (part 2), and in-tab notifications are not failures

**Files:**
- Modify: `hub/server/machines/notification.mjs`
- Modify: `hub/package.json`
- Modify: `hub/package-lock.json`
- Test: `hub/test/integration/security.test.mjs`
- Test: `hub/test/integration/session-actions.test.mjs`
- Test: `hub/test/integration/shared-input.test.mjs`
- Test: `hub/test/integration/terminal-channel.test.mjs`
- Test: `hub/test/unit/m1-web-fixes.test.mjs`
- Test: `hub/test/unit/m5-release.test.mjs`
- Test: `hub/test/unit/fake-claude.test.mjs`
- Test: `hub/test/unit/scaffold.test.mjs`
- Test: `hub/test/unit/m1-scaffold.test.mjs`
- Test: `hub/test/unit/m2-wiring.test.mjs`
- Test: `hub/test/unit/setup-screens.test.mjs`
- Test: `hub/test/unit/dogfood-setup.test.mjs`
- Test: `hub/test/unit/m1-cleanup-web.test.mjs`
- Test: `hub/test/unit/popup-actions.test.mjs`
- Test: `hub/test/unit/m1-evidence-fixes.test.mjs`
- Test: `hub/test/unit/notify.test.mjs`

**Depends:** T9

**Model:** mid

**Acceptance:**
- `notification.mjs`: a popup or bell result `{ ok: false, reason: 'unsupported on <platform>' }` is recorded as skipped, not `notify.failed`; any other `ok: false` stays `notify.failed`. `notify.test.mjs` pins both.
- `hub/package.json` and the root package entry of `hub/package-lock.json`: `engines.node` becomes `>=24.16.0` (Node 24.2 to 24.15 `node:sqlite` truncates a bound string at NUL); `m1-scaffold.test.mjs` asserts the new floor.
- Test files: deck paths from `setupPaths(env)`; claude through `bin.claudePath` and `commandSpawn`; `npm` through `process.execPath` with `npm-cli.js` resolved next to it, or through `resolveCommand` + `commandSpawn`; browser tests take the browser from `findChromium()` in `test/helpers/chromium.mjs`; adapters whose Linux behaviour a test pins get `platform: 'linux'` (browser opener, doctor, notifier); capture-cc cases skip on win32 with the reason `capture-cc drives a POSIX claude wrapper`; separator assertions use `path.join`.
- Each listed file passes on Windows (with Chrome installed) or skips individual tests with a stated reason.
- Mutation: `notification.mjs` treating `unsupported` as `notify.failed` (a test fails).

- [ ] Step 1: Write the notification test; observe it fail.
- [ ] Step 2: Implement; edit the tests; run the mutation; restore; run the hub suite; commit only the declared files.

### Task 15: meetings tests skip off Linux; browser and POSIX-fixture tests on Windows

**Files:**
- Test: `hub/test/contract/scribed.test.mjs`
- Test: `hub/test/contract/vault-mcp.test.mjs`
- Test: `hub/test/unit/scribed-client.test.mjs`
- Test: `hub/test/unit/meetings-recorder.test.mjs`
- Test: `hub/test/unit/meetings-ask.test.mjs`
- Test: `hub/test/unit/start-scribed.test.mjs`
- Test: `hub/test/unit/meetings-config.test.mjs`
- Test: `hub/test/unit/meetings-history.test.mjs`
- Test: `hub/test/unit/meetings-note.test.mjs`
- Test: `hub/test/unit/meetings-post-watch.test.mjs`
- Test: `hub/test/integration/meetings-api.test.mjs`
- Test: `hub/test/integration/meetings-confidential.test.mjs`
- Test: `hub/test/integration/meetings-exit.test.mjs`
- Test: `hub/test/integration/meetings-quiet.test.mjs`
- Test: `hub/test/unit/archive-web.test.mjs`
- Test: `hub/test/unit/focus-m2.test.mjs`
- Test: `hub/test/unit/focus-m3.test.mjs`
- Test: `hub/test/unit/m3-wiring-web.test.mjs`
- Test: `hub/test/unit/new-session.test.mjs`
- Test: `hub/test/unit/settings-rules.test.mjs`
- Test: `hub/test/unit/web-shell.test.mjs`
- Test: `hub/test/unit/web-terminal.test.mjs`
- Test: `hub/test/unit/prepare-native.test.mjs`
- Test: `hub/test/unit/research-db.test.mjs`
- Test: `hub/test/unit/rules/write.test.mjs`
- Test: `hub/test/unit/vault-mcp-client.test.mjs`

**Depends:** T9

**Model:** mid

**Acceptance:**
- Meetings and scribed tests skip on win32 and darwin with the reason `meetings and scribed are Linux only (16-platforms section 1)`; on linux they are unchanged. Where a meetings test pins a refusal the product makes on every platform, it keeps running.
- Browser tests use `findChromium()` from `test/helpers/chromium.mjs`; their own copies are removed.
- `prepare-native`, `research-db` and `rules/write` mode, exec-bit and uid assertions are `posixTest` with a reason; the rest of each file runs on Windows.
- `contract/vault-mcp.test.mjs` splits relative paths with `/[\\/]/` and gives the client a `slowMs` large enough that a cold start is not `degraded` (the test pins schemas, not latency). `vault-mcp-client.test.mjs` 'slow answers twice give degraded...' uses a slow delay at least 4 times `slowMs` and a fast answer well under it, so a loaded machine does not flip it.
- Each listed file passes on Windows (with Chrome installed) or skips individual tests with a stated reason.

- [ ] Step 1: Edit; run the hub suite; commit only the declared files.

### Task 16: Windows endpoints carry a per-user secret, and detached stop binds the pid to the deck

**Files:**
- Modify: `hub/platform/index.mjs`
- Modify: `hub/deckd/main.mjs`
- Modify: `hub/deckd/client.mjs`
- Modify: `hub/server/ingest/socket.mjs`
- Modify: `hub/server/pty/link.mjs`
- Modify: `hub/server/main.mjs`
- Modify: `hub/server/setup/paths.mjs`
- Modify: `hub/server/setup/service.mjs`
- Modify: `hub/hook/deck-hook.mjs`
- Modify: `hub/bin/fm.mjs`
- Test: `hub/test/unit/platform.test.mjs`
- Test: `hub/test/unit/hook-platform.test.mjs`
- Test: `hub/test/unit/service.test.mjs`
- Test: `hub/test/integration/deckd.test.mjs`

**Depends:** T10, T11, T12, T13, T14, T15

**Model:** capable

**Acceptance:**
- Threat: on Windows a named pipe name is machine-global. Another local user who can predict `\\.\pipe\fleetmates-deck-<h>-<name>` can create it first and receive hook envelopes or fm keystrokes. Fix: on win32 the pipe name also hashes a 32-byte random secret stored in `<deckDir(base)>\endpoint.key`. `deckDir` lives under `%LOCALAPPDATA%`, which only the user, SYSTEM and Administrators can read. `endpoint(base, name, { platform, secret })` on win32 takes `<h>` = the first 16 hex digits of SHA-256 of `resolved-lowercased-base + '\0' + secret`; without a secret on win32 it throws. A new `endpointSecret(base, { platform, create })` reads the key file, and with `create: true` writes it (exclusive create, then reread) when it is missing. deckd and the server call it with `create: true`; the clients (deckd client, link, hook, fm) read it and treat a missing key as "deckd/server not running" (the hook spools). POSIX endpoints are unchanged and take no secret.
- The hook's inline `hookEndpoint` computes the same name; `hook-platform.test.mjs` pins parity with a secret.
- `service.mjs` detached `stop`: before `taskkill`, the pid is confirmed to be this deck's process by its command line (from `wmic`-free `Get-CimInstance Win32_Process` output or `tasklist /V` is not enough; use `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=<n>').CommandLine"` through `run`) containing the service's entry path; otherwise the pid file is removed without killing. A failed `taskkill` is followed by a recheck, and stop reports failure if the process is still alive. Both paths have tests with injected `run`.
- Mutations each fail a test, then are restored: endpoint without the secret on win32; the hook's copy ignoring the secret; stop killing without the command-line check.

- [ ] Step 1: Write the tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 18: deckd makes the macOS spawn helper executable when npm skipped the postinstall

**Files:**
- Modify: `hub/bin/prepare-native.mjs`
- Modify: `hub/deckd/pty-host.mjs`
- Test: `hub/test/unit/prepare-native.test.mjs`
- Test: `hub/test/unit/pty-signals.test.mjs`

**Depends:** T16

**Model:** mid

**Acceptance:**
- Measured on 2026-10-09: npm 11.19.0 (`npm install -g <tarball>`, on Linux and on the Windows VM) skips install scripts not covered by `allowScripts`, including the deck's own `postinstall` (`node bin/prepare-native.mjs`), even when the package is named in `--allow-scripts` for a tarball install. On macOS that leaves node-pty 1.1.0's prebuilt `spawn-helper` without execute bits, so every PTY spawn would fail.
- `prepare-native.mjs` gains `prepareNativeSync(opts)` with the same contract as `prepareNative` (darwin only, the same three helper paths, `O_NOFOLLOW` open, regular file only, adds `0o111`, throws when none is found); `prepareNative` keeps its behaviour.
- `pty-host.mjs`: on darwin, before the first node-pty spawn in the process, `PtyHost` runs the injectable `prepare` dep (default `prepareNativeSync`) once; a throw is a `spawn_failed` `DeckdError` whose message says to reinstall, and node-pty is not called. Later spawns do not run it again after a success. Other platforms never run it.
- Tests: `pty-signals.test.mjs` with an injected platform `darwin`, an injected `ptySpawn` and an injected `prepare` pins: prepare runs before ptySpawn, runs once across two hosts, a throwing prepare gives `spawn_failed` without calling ptySpawn; with platform `linux` prepare is never called. `prepare-native.test.mjs` covers `prepareNativeSync` like `prepareNative` (missing helper rejected, execute bits added as a `posixTest`, symlinked helper refused).
- Mutations each fail a test, then are restored: drop the darwin prepare call in pty-host; run it on every platform; `prepareNativeSync` not adding the execute bits.

- [ ] Step 1: Write the tests; observe them fail.
- [ ] Step 2: Implement; run the mutations; restore; run the hub suite; commit only the declared files.

### Task 17: docs and a hub CI job on macOS and Windows

**Files:**
- Modify: `docs/deck/16-platforms.md`
- Modify: `docs/deck/13-operations.md`
- Modify: `docs/deck/14-decisions.md`
- Modify: `hub/README.md`
- Modify: `hub/CHANGELOG.md`
- Modify: `.github/workflows/deck.yml`
- Test: `hub/test/unit/m1-scaffold.test.mjs`

**Depends:** T16

**Model:** mid

**Acceptance:**
- `16-platforms.md`: section 3 records the measured pipe DACL (Everyone and Anonymous read, SYSTEM and Administrators full, creator full; a second `listen` on the same name fails EADDRINUSE) and the per-user endpoint secret of Task 16; section 5 records the ConPTY facts (SystemRoot, failed spawn refusal, win32-input-mode filtering, no `O_NOFOLLOW` and `openNoFollow`); section 6 records the Task 12 decision (POSIX path parsing for Bash, case-insensitive deck paths, no rule writes on win32); section 8 describes the VM verification and the CI job. `13-operations.md` gains macOS (launchd) and Windows (`fleetmates-deck start`/`stop`, Run key, logs) operations. `14-decisions.md` gains D-149 (the deck runs on macOS and native Windows; 16-platforms) and D-150 (approvals on Windows: ask always, POSIX parsing, no rule writes). `hub/README.md` lists the three platforms and the Node floor `>=24.16.0`. `hub/CHANGELOG.md` gets an Unreleased section with the platform support. `13-operations.md` also records two measured install and start facts: npm 11 skips install scripts by default (Task 18 makes deckd prepare the macOS helper itself), and on Windows a deck started over an OpenSSH session is killed when that session ends, so start it from a local console or let the Run key start it at logon.
- `.github/workflows/deck.yml`: the hub job runs on a matrix of `ubuntu-latest`, `macos-latest` and `windows-latest`; on Windows it runs `npm --prefix hub test` with Chrome from the runner image; the Linux-only steps stay on Linux. `m1-scaffold.test.mjs` 'deck CI declares...' is updated to assert the three-OS matrix (it currently asserts no `windows-latest`); its other assertions keep their meaning.
- Docs: English, plain prose, no em dash, placeholders for personal paths.

- [ ] Step 1: Edit; commit only the declared files.
