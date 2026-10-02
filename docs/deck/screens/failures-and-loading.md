# Failures, loading, empty and error patterns

| | |
|---|---|
| Canvas board | `Failures` (Failure and loading states): crashed card, adrift card, deckd lost banner + skeletons, per-tab degraded cards |
| Route | none: these are patterns used on every screen. Each screen spec says where they appear. |
| Milestone | M1 (crash card, stale, deckd and server banners, skeletons, notification failure). M4 adds the scribed degraded card. M5 adds the vault-mcp degraded card. |
| Status | Decided (the four specimens and their copy), Proposed (error mapping table, loading rules, the catalogue in 3) |

## 1. Purpose

Answers **"Something is wrong: what broke, what still works, and what do I do first?"** One vocabulary of failure and waiting states so every screen fails the same honest way (error-handling-ux: what happened, why, what to do; loading-states: show something immediately, match the shape, never a blank screen).

## 2. Where each pattern appears

| Pattern | Component | Screens |
|---|---|---|
| Crashed session card | SessionCard `crashed` | Home main grid, Focus crash banner (same content), compact card |
| Adrift (stale) | QuietCard `stale`, Focus Banner `hint` | Home quiet row or QuietStrip, Focus |
| Server link lost (browser to web server) | Banner `connection` (full width under the page header) | every shell screen |
| deckd lost | Banner `connection` + skeletons where PTY data was | every shell screen; Home compact tails; Focus terminal |
| Dependency degraded (vault-mcp, scribed) | DegradedCard replaces the tab content | Memory, Research, Meetings, MeetingLive |
| Per-run reader failure | inline Banner `error` | Team, Home team card |
| Notifications failing | Settings Notifications line + one toast per server run | Settings, global toast |
| Page-level fatal (token invalid, origin rejected) | full-page message | shell ([rail-and-shell.md](rail-and-shell.md)) |
| Loading skeleton | SkeletonCard `session`, `row`, `panel` | every region that loads |
| Inline action error | Banner `error` next to the action | request boxes, forms, dialogs |
| Empty state | text + optional action, per screen | every list |

## 3. Catalogue

### 3.1 Loading rules (Proposed, from loading-states)

| Wait | Indicator |
|---|---|
| under 100ms | nothing |
| 100ms to 1s | skeleton in place (same size as the content, no layout shift) or button spinner (`loader-circle`, label kept) |
| 1s to 10s | skeleton + an `.sr-only` status text; long operations name what they wait for ("Searching your vault…") |
| over 10s | literal progress text and a way out: Cancel, Stop, or "keep working, we will notify you" |

- Regions that load set `aria-busy="true"`; skeleton blocks are `aria-hidden` (components SkeletonCard).
- Skeleton to content: 160ms fade; stagger list items 40ms (loading-states), capped at 6 items.
- Never two spinners for one wait. A button spinner replaces, not adds to, a region skeleton.
- Shimmer uses `.motion-shimmer`; reduced motion shows static blocks.
- A cached snapshot always beats a skeleton: after the first load, reconnects show the last data dimmed with "as of {time}", not skeletons (state-machines 4.1).

### 3.2 Error message pattern (design-system 12.4)

1. Title may be themed ("No one on the radio").
2. What happened, literally, with the real error in mono when there is one.
3. What still works.
4. The first fix as a literal verb button (primary), then "Retry" (secondary).
5. Timing facts in parentheses: "(attempt 3, next in 4s)".

Input is never cleared on error (forms keep values; composers keep the question).

### 3.3 Retry and backoff

| Link | Backoff | Source |
|---|---|---|
| Browser WebSocket | `min(2^(attempt-1), 30)` s with ±20% jitter; countdown each second; skip wait when the tab becomes visible | state-machines 4.1 |
| deckd | same formula | state-machines 4.2 |
| Dependency probes | 2, 4, 8 … 60 s when down; 30 s when ok | state-machines 5.2 |
| `status.json` parse | 3 retries 200ms apart, then error state, then normal file-watch retries | state-machines 5.3 |

"Retry now" never resets the attempt counter (state-machines 4.1).

## 4. Specimens (from the canvas)

### 4.1 Crashed session card

| Element | Component | Data binding | Copy (canvas) |
|---|---|---|---|
| Title | SessionCard header | themed headline "{repo} ran aground" (flavor in the title, fact in the pill) | "andreymudri.com ran aground" |
| Subtitle | mono | `repo.name · branch` | "andreymudri.com · hero" |
| Pill | StatePill | `crashKind`, `exitCode`, `exitSignal` | "Crashed · exit 1", "Crashed · signal SIGKILL", "Crashed · lost" |
| Error excerpt | TerminalTail `error` | last 2 to 6 lines of scrollback containing the error (ANSI stripped server-side) | "Error: ENOSPC: no space left on device, write" / "at WriteStream (node:fs:2811)" |
| Consequence | Banner `hint` | mapping table 4.1.1 | bold "The disk is full, so relaunching now would fail the same way." + "/home has 0 B free. Free some space first; your changes to components/Hero.tsx are still in the working tree." |
| Actions | Buttons | mapping table | "Show disk usage" (primary), "Relaunch after freeing space", "Ship's log" |

#### 4.1.1 Known error mapping (Proposed; state-machines 1.11 item 9)

| Match in the tail | Consequence line | First action (primary) | Relaunch label |
|---|---|---|---|
| `ENOSPC` | "The disk is full, so relaunching now would fail the same way." + "{mount} has {free} free. Free some space first; your changes to {files} are still in the working tree." | "Show disk usage" (dialog with `df -h {cwd}` output, read-only) | "Relaunch after freeing space" |
| `EACCES` / `EPERM` | "A file could not be written: permission denied on {path}." | "Open terminal" | "Relaunch" |
| `ENOMEM`, signal `SIGKILL` with no user stop | "The process ran out of memory or was killed by the system." | "Relaunch" | (primary is Relaunch) |
| `command not found` | "A command the session needed is not installed: {cmd}." | "Open terminal" | "Relaunch" |
| `Crashed · lost` (observed pid gone, or PTY unknown after restart) | "The deck lost track of this process. It may have been closed outside the deck." | "Dismiss" | "Relaunch" (only with a `claudeSessionId`) |
| anything else | "The session exited with code {code}." | "Relaunch" | |

"{files}" lists up to 3 `changedFiles` paths then "and {n} more"; when there are none the clause is omitted. "Ship's log" opens Focus on that session with the final scrollback (terminal read-only) (Proposed).

### 4.2 Adrift (stale) session

| Element | Data binding | Copy |
|---|---|---|
| Pill | minutes since `lastActivityAt` | "No activity 22m" |
| Body (Focus banner and the large specimen) | `stateSince` | "rustot-client is adrift, 22 min without a signal. No commits and no file changes in its worktree since 17:40." is the canvas copy; the port uses "rustot-client is adrift: no activity for 22 min, since 17:40." because the deck measures hook and screen activity, not commits (Proposed) |
| Open tool | open `PreToolUse` without `PostToolUse` | "Still inside Bash: cargo test --release" |
| Actions | origin | "Open terminal" (primary), "Nudge (send Enter)", "Stop…" (danger); observed sessions: "Open" only |

The large main-grid adrift card on the canvas is a specimen: on Home a stale session lives in the quiet row (02-domain 3); the same sentence and actions appear in the QuietCard and as the Focus banner.

### 4.3 deckd lost

| Element | Copy | Notes |
|---|---|---|
| Banner `connection` (`role="status"`) | "Radio silence from deckd. Ships still sailing, re-establishing contact… (attempt 3, next in 4s)" | Decided copy; design-system 15.4 proposes "Radio silence from deckd. Sessions keep running; reconnecting (attempt 3, next in 4s)." (Open) |
| Action | "Retry now" (`amber-outline xs`) | |
| Skeletons | only where PTY data was: compact tails, Focus terminal | pills and requests keep updating from hooks (state-machines 4.2) |
| Disabled actions | Allow once, Deny, Reply, Nudge, Stop…, Relaunch, Launch a ship | visible reason "deckd is reconnecting" |

The full 6-card skeleton grid shows only when the browser has no snapshot at all.

### 4.4 Web server link lost (Proposed, not on canvas)

Banner `connection`: "Lost the deck server. Your ships are unaffected, reconnecting… (attempt 3, next in 4s)" + "Retry now". Whole UI dims (opacity via a token-backed overlay), "as of 18:42" appended, every action disabled.

### 4.5 Dependency degraded cards

| Tab | Eyebrow | Title | Body | Command well | Fix | Retry |
|---|---|---|---|---|---|---|
| Memory (vault-mcp down) | "Memory tab" | "The charts are out of reach" | "vault-mcp did not answer on stdio (spawn exited 1: VAULT_PATH is not a directory). Sessions and meetings still work." (the parenthesis is the real error) | `VAULT_PATH=/home/you/vault` | "Fix in Settings" | "Retry" |
| Meetings (scribed down) | "Meetings tab" | "No one on the radio" | "scribed is not running: no socket at $XDG_RUNTIME_DIR/turbidassist.sock. Past meetings still load from the vault." | see FAIL-O1 | "Start scribed" | "Retry" |

Degraded cards replace only the part that depends on the service (Meetings keeps its past list; only Record, live and ask degrade, state-machines 5.4). Recovery: 160ms fade to content and a polite "Memory is back" (components DegradedCard).

### 4.6 Other degraded surfaces (Proposed)

| Surface | Copy |
|---|---|
| Team card or Team page, run unreadable | "status.json unreadable, retrying" |
| Notifications | Settings line "Desktop notifications are not working: notify-send exited 1." and one toast per server run with "Open settings" |
| Hook payload drift | FirstRun and Settings Connections: "3 hook payloads did not match the pinned fixtures" (state-machines 1.11 item 13) |

## 5. States of the patterns themselves

| Pattern | Loading | Error | Recovered |
|---|---|---|---|
| Crash card | error tail skeleton while scrollback loads | tail unavailable: "The last output is not available." | Relaunch moves the card to `starting` (skeleton body) |
| Degraded card | Retry shows `loading` | Retry failure keeps the card and updates the error text | fade to content |
| Connection banner | countdown | `token_invalid` or `origin_rejected` replace it with the full-page message | banner leaves with a 160ms fade; polite "Reconnected" |
| Show disk usage dialog | spinner | "Could not read disk usage: {message}" | |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| "Retry now" (connection) | reconnect now | `U.RetryNow` (state-machines 4.1, 4.2) |
| "Retry" (degraded card) | probe now | `U.Retry` (state-machines 5.2) |
| "Fix in Settings" | Settings, Connections, vault section focused | route `/settings/connections#vault` |
| "Start scribed" | start scribed with `systemd-run --user` running a login shell (`$SHELL -l -c 'exec scribed'`) (FAIL-O1), then probe | `POST /api/deps/scribed/start` |
| "Show disk usage" | read-only dialog | `GET /api/sessions/:id/disk` |
| "Relaunch", "Relaunch after freeing space" | `claude --resume` in the same deck session | `U.Relaunch` |
| "Dismiss" | leaves Failures; card becomes done (unreviewed changes) or disappears | `U.Dismiss` |
| "Ship's log" | Focus with the final scrollback | route |
| "Open terminal", "Nudge (send Enter)", "Stop…" | as Home | `U.Nudge`, `U.Stop` |

## 7. Real-time updates

`health.changed` drives every banner and degraded card; `session.state` into `crashed` inserts the crash card with a 200ms fade and the AppShell live region announces "{repo} crashed, exit {code}" (batched). Recovery events remove banners with a 160ms fade. Countdowns tick once per second (text only, `tabular-nums`).

## 8. Accessibility

- Connection banners are `role="status"` (polite); nothing is assertive (design-system 11.5).
- Degraded cards: the Eyebrow is an `h2` inside the replaced region; the fix button is the first focusable element.
- Crash announcements are batched with requests (one per 2s).
- Skeleton regions: `aria-busy="true"` + `.sr-only` "Loading {thing}".
- Uppercase eyebrow text ("MEMORY TAB") is stored in sentence case and uppercased by CSS.

## 9. Copy deck

| Key | EN |
|---|---|
| `fail.crash.title` | {repo} ran aground |
| `fail.crash.enospc.lead` | The disk is full, so relaunching now would fail the same way. |
| `fail.crash.enospc.body` | {mount} has {free} free. Free some space first; your changes to {files} are still in the working tree. |
| `fail.crash.enospc.action` | Show disk usage |
| `fail.crash.enospc.relaunch` | Relaunch after freeing space |
| `fail.crash.eacces` | A file could not be written: permission denied on {path}. |
| `fail.crash.oom` | The process ran out of memory or was killed by the system. |
| `fail.crash.notFound` | A command the session needed is not installed: {cmd}. |
| `fail.crash.lost` | The deck lost track of this process. It may have been closed outside the deck. |
| `fail.crash.generic` | The session exited with code {code}. |
| `fail.crash.noTail` | The last output is not available. |
| `fail.crash.relaunch` | Relaunch |
| `fail.crash.dismiss` | Dismiss |
| `fail.crash.log` | Ship's log |
| `fail.crash.andMore` | and {n} more |
| `fail.disk.title` | Disk usage for {path} |
| `fail.disk.error` | Could not read disk usage: {message} |
| `fail.stale.body` | {repo} is adrift: no activity for {minutes} min, since {time}. |
| `fail.stale.openTool` | Still inside {tool}: {summary} |
| `fail.deckd.banner` | Radio silence from deckd. Ships still sailing, re-establishing contact… (attempt {attempt}, next in {seconds}s) |
| `fail.deckd.disabled` | deckd is reconnecting |
| `fail.deckd.title` | deckd is unavailable |
| `fail.deckd.works` | Sessions keep running and hooks keep reporting. Launching, answering and terminals wait for deckd. |
| `fail.deckd.reason` | Last error: {reason} |
| `fail.deckd.start` | Start deckd |
| `fail.history.title` | Completed sessions |
| `fail.history.empty` | No completed sessions yet. |
| `fail.server.banner` | Lost the deck server. Your ships are unaffected, reconnecting… (attempt {attempt}, next in {seconds}s) |
| `fail.server.asOf` | as of {time} |
| `fail.retryNow` | Retry now |
| `fail.reconnected` | Reconnected |
| `fail.memory.area` | Memory tab |
| `fail.memory.title` | The charts are out of reach |
| `fail.memory.body` | vault-mcp did not answer on stdio ({error}). Sessions and meetings still work. |
| `fail.memory.fix` | Fix in Settings |
| `fail.memory.back` | Memory is back |
| `fail.meetings.area` | Meetings tab |
| `fail.meetings.title` | No one on the radio |
| `fail.meetings.body` | scribed is not running: no socket at $XDG_RUNTIME_DIR/turbidassist.sock. Past meetings still load from the vault. |
| `fail.meetings.fix` | Start scribed |
| `fail.meetings.back` | Meetings are back |
| `fail.retry` | Retry |
| `fail.run.unreadable` | status.json unreadable, retrying |
| `fail.notify.settings` | Desktop notifications are not working: notify-send exited {code}. |
| `fail.notify.toast` | Desktop notifications are not working. |
| `fail.notify.open` | Open settings |
| `fail.hooks.drift` | {n, plural, one {# hook payload did not match the pinned fixtures} other {# hook payloads did not match the pinned fixtures}} |
| `fail.loading` | Loading {thing} |
| `fail.loading.sessions` | sessions |

## 10. Acceptance criteria

1. **Given** a session whose PTY exits with code 1 and "ENOSPC" in the tail, **then** its card shows pill "Crashed · exit 1", the ENOSPC consequence, "Show disk usage" as the primary button and "Relaunch after freeing space".
2. **Given** a user-requested stop that exits 143, **then** the session ends and no crash card appears (state-machines row 42).
3. **Given** deckd drops, **then** within 1s the banner shows "(attempt 1, next in 1s)", then "(attempt 2, next in 2s)"; "Retry now" reconnects immediately and the next banner (if it fails again) shows attempt 3.
4. **Given** deckd is down and a hook event changes a session to `needs_approval`, **then** the pill updates while Allow once stays disabled with "deckd is reconnecting".
5. **Given** fixture `vaultDown`, **then** Memory shows the degraded card with the real spawn error in the body, and Home, Focus and Meetings render normally.
6. **Given** fixture `scribedDown`, **then** Meetings still lists past meetings and only Record and live views show the degraded card.
7. **Given** the server link drops with a snapshot cached, **then** no skeleton appears; the UI dims and shows "as of" with the last event time.
8. **Given** first load with no snapshot, **then** the Home grid shows 6 skeleton cards with `aria-busy="true"` and an sr-only "Loading sessions".
9. **Given** reduced motion, **then** skeleton blocks do not animate.
10. **Given** a crash tail containing ANSI escape sequences, **then** no escape characters appear in the DOM text.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| FAIL-O1 | "Start scribed" and the command well `systemctl --user start scribed`: TurbidAssist ships no scribed unit; scribed is spawned on demand (vault-mcp and scribed contract 2.1, 2.12). | **Open** (SM-O13). Default (Proposed): start it with `systemd-run --user` running a login shell (`$SHELL -l -c 'exec scribed'`), so it is outside the deck's cgroup and gets `HF_TOKEN` ([04-integrations.md](../04-integrations.md) 4.3, OPS-O1); TurbidAssist change T4 (a `scribed.service` unit) is the later clean fix. The command well shows `scribe daemon` (foreground, for manual start). |
| FAIL-O2 | Connection banner wording (design-system 15.4). | **Open**. Default: canvas copy. |
| FAIL-O3 | Should `stale` and `crashed` send desktop popups (SM-O4)? | Open (tracked as SM-O4). |
| FAIL-O4 | "Show disk usage" content: which command and scope. | Proposed: `df -h` for the filesystem holding `cwd`, read-only, no shell for the user. |
| FAIL-O5 | Adrift sentence: fleetmates liveness measures commits and worktree mtimes for teammates; plain sessions only have hook and screen activity. | Proposed: teammates may use the canvas sentence (it is true there); plain sessions use the activity sentence. |

## 12. Changes from the canvas

1. "MEMORY TAB" and "MEETINGS TAB" are stored as "Memory tab", "Meetings tab" and uppercased by CSS.
2. Degraded card title 17px becomes `type.section-title` (18px).
3. The adrift body sentence changes for plain sessions (FAIL-O5).
4. Skeleton colors follow `bg.skeleton` and `bg.skeleton-highlight` (design-system 14).
5. The server-link banner, error mapping table, disk usage dialog and loading rules are new.
6. The Failures board itself is not a screen; its specimens are patterns placed by each screen.
