# App shell, Rail, recording bar, global toasts

| | |
|---|---|
| Canvas boards | `Rail` (component), shell structure on every board; recording bar from `MeetingLive` |
| Route | all shell routes (every route except `/welcome` and the full-page fatal states) |
| Milestone | M1 (shell, Rail, badge, live region, toasts, connection banners, keyboard layer, document title). M4 adds the recording bar and rec dot. |
| Status | Decided (Rail layout and items, badge, rec dot, rail height rule), Proposed (routing, live region, toasts, fatal pages, keyboard layer mechanics) |

## 1. Purpose

Answers **"Where am I, where else can I go, and is anything calling for me?"** from any screen: sections in the Rail, the needs-you count always visible, recording always visible, one place for announcements and toasts.

## 2. Routes (SPA, hash-free, Proposed)

| Route | Screen | Spec | Notes |
|---|---|---|---|
| `/` | Home | [home.md](home.md) | redirects to `/welcome` until first run is complete |
| `/new` | New session dialog over the previous route | [new-session.md](new-session.md) | query `repo`, `task` |
| `/s/:sessionId` | Focus | [focus.md](focus.md) | query `tab`, `file` |
| `/runs/:repoKey/*runId` | Team run | [team-run.md](team-run.md) | `runId` may contain `/` |
| `/memory` | Memory | [memory.md](memory.md) | query `view`, `thread` |
| `/memory/note/*` | Memory with note panel | [memory.md](memory.md) | vault-relative path; `#L13` anchors a line |
| `/research/new` | Research form over the previous route | [research.md](research.md) | query `topic`, `miss` |
| `/research/:id` | Research review | [research.md](research.md) | |
| `/meetings` | Meetings list | [meetings.md](meetings.md) | query `q` |
| `/meetings/:id` | Meeting detail | [meetings.md](meetings.md) | |
| `/meetings/live` | Live meeting | [meetings.md](meetings.md) | redirects to `/meetings` when not recording |
| `/settings/:section` | Settings | [settings.md](settings.md) | `/settings` redirects to `/settings/rules` |
| `/settings/crew` | Crew sheet | [crew-sheet.md](crew-sheet.md) | |
| `/welcome` | First run | [first-run.md](first-run.md) | no shell |

Rules:

- The server answers every route above with the SPA `index.html` (history fallback); only `/api/*` and the WebSocket need the token (Proposed; security details belong to the security doc).
- `fleetmates-deck open` (name pending Q1 in [15-open-questions.md](../15-open-questions.md)) opens `http://127.0.0.1:<port>/#token=<t>`. On load the app moves the token into `sessionStorage` and calls `history.replaceState` to drop the fragment, so routing never uses the hash (state-machines 4.1). The fragment may also carry `&to=<route>` (Proposed), used when a desktop notification's "Open" has to open a new tab ([04-integrations.md](../04-integrations.md) section 5); the app accepts `to` only when it matches a route pattern in the table above, and ignores it otherwise.
- Overlays (Palette, Needs-you drawer, dialogs) are not routes; they push a history entry so browser Back closes them.
- Dialog routes (`/new`, `/research/new`) render over the previous route (background location). A direct load renders over `/` or `/memory`.
- Unknown path: shell with a not-found message "This page is not on the deck." + "All ships".

## 3. Layout

| Region | Component / token | Notes |
|---|---|---|
| Recording bar | Banner `recording`, height `--layout-rec-bar`, full width above everything | only while recording (from any client) |
| Rail | Rail, width `--layout-rail`, `bg.sunken` | height = viewport minus the bar while recording (Decided) |
| Secondary sidebar | per screen | Focus list, Meetings list, Settings nav |
| Main | flex 1, `min-width: 0` | only inner regions scroll; `height: 100vh` on the shell |
| Aside | per screen | |
| Overlay root | Drawer, Dialog, Palette, Toast stack, Tooltip | z tokens `--z-drawer`, `--z-dialog`, `--z-palette`, `--z-toast`, `--z-tooltip` |
| Live region | one `role="status"` element, visually hidden | AppShell owns it |
| Skip link | `.sr-only-focusable` first focusable element | "Skip to main content" |

Width behaviour: the Rail never collapses (64px at every width). Below 1280 the layout is not designed; the shell scrolls horizontally (design-system 8.3, Open 15.3).

## 4. Content inventory

### 4.1 Rail

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Logo | LogoMark tile | | Tooltip "fleetmates deck" | not a link (Proposed: link to `/`) |
| Sessions | Rail item link, Icon `layout-grid` | route active | label "Sessions"; Tooltip "Sessions · Alt Shift 1" | accessible name "Sessions, 3 need you" when badge > 0 |
| Needs badge | Rail badge | `counts.needYouSessions` (same `counts` object as Home and the drawer) | "3"; "99+" over 99 | hidden at 0; text `aria-hidden` |
| Memory | link, Icon `book-open` | | "Memory"; "Memory · Alt Shift 2" | |
| Meetings | link, Icon `mic` | | "Meetings"; "Meetings · Alt Shift 3" | |
| Rec dot | 8px dot, `.motion-rec-pulse` | recorder `recording` | | name becomes "Meetings, recording" |
| Settings | link, Icon `sliders-horizontal` | | "Settings"; "Settings · Alt Shift 4" | bottom |

### 4.2 Recording bar (M4)

Content and states are specified in [meetings.md](meetings.md) 4.3; the shell owns its placement on every screen, the "Recording started" and "Recording stopped" announcements, and clicking the title to open `/meetings/live`.

As built in 0.4.0 (`hub/web/src/shell/RecBar.jsx`, `hub/web/src/shell/App.jsx`, `hub/web/src/styles/shell.css`):

- The bar shows while the recorder is `recording` or `stopping`, from any client. It is a `role="region"` landmark labelled "Recording". While it shows, the shell renders the skip link as the bar's first child, so the skip link stays the first focusable element and is inside a landmark (axe `region`, M4-T17-F4, fixed by M4 Task 19). Without the bar the skip link is the shell's first child, as before.
- The announcements go through the shell's single live region (`shell.announce.recStart` and its pair in `hub/web/src/i18n/en.js`), not through the bar.
- The bar is `box-sizing: border-box` with `height: var(--layout-rec-bar)` (40 px), so its bottom border is inside that height; while it shows, the Rail's height is the viewport minus the bar minus the Rail's own 12 px padding top and bottom, and main is the viewport minus the bar, so the shell fits the viewport (AC6; M4-T17-F1, fixed by M4 Task 19).
- The bar's title link renders the tag through `titleText` inside `<bdi>` (M4-T17-F2).

### 4.3 Connection banners

The browser-to-server and deckd banners ([failures-and-loading.md](failures-and-loading.md) 4.3, 4.4) render at the top of `main`, below the page header, on every shell screen. At most one banner shows: server link lost wins over deckd lost.

### 4.4 Toasts

| Aspect | Rule (components Toast) |
|---|---|
| Position | bottom right, 16px from the edges, max 3 visible, older collapse into "+N more" |
| Tones | `info`, `success` dismiss after 6s; `needs`, `error` stay until dismissed or resolved |
| Pause | timers pause on hover and focus within the stack |
| Suppression | `needs` toasts do not show while the drawer is open, or when the tab shows that session in Focus (state-machines 9.3) |
| In-browser notification | a new request produces a `needs` toast "rustot needs approval" + body command + "Open" (first request per session episode; later requests update the badge only, Proposed) |
| Undo | toasts with Undo: rule added, action item dismissed |

### 4.5 Document title

`{pageTitle} · fleetmates deck`, prefixed with "(3) " when `counts.needYouSessions > 0` (state-machines 9.2).

### 4.6 Full-page fatal states

| State | Copy | Action |
|---|---|---|
| `token_invalid` | "This tab's key no longer matches the deck. Open the deck again with fleetmates-deck open." (name pending Q1 in [15-open-questions.md](../15-open-questions.md)) | none (no retry) |
| `origin_rejected` | "The deck only answers pages it served itself. Open it from fleetmates-deck open." (name pending Q1 in [15-open-questions.md](../15-open-questions.md)) | none |
| `client_outdated` | "The deck was updated. Reload" (shown only after one automatic reload did not help; [interaction/state-machines.md](../interaction/state-machines.md) 4.1, [05-api.md](../05-api.md) section 8) | Reload button |

## 5. States

| State | What shows |
|---|---|
| Loading (no snapshot) | Rail renders immediately (badge hidden); main shows the current screen's skeleton |
| Populated | as above |
| Recording | bar on top, Rail shortened, rec dot |
| Stopping | bar neutral "Stopping… saving the session" (meetings.md) |
| Server link lost | banner + dimmed UI; Rail still navigates (cached data) |
| Overflow | badge "99+"; toasts collapse into "+N more"; live region merges bursts into "3 new requests" |

## 6. Interactions and keyboard layer

One capture-phase `keydown` listener on `window`, matching `event.code`; xterm's `attachCustomKeyEventHandler` returns false for the global set (keyboard.md 1).

| Keys | Action | Scope |
|---|---|---|
| `Alt K` | open Palette | global |
| `Alt N` | new-session form | global |
| `Alt U` | Needs-you drawer | global |
| `Alt 1` to `Alt 9` | Nth session in urgency order | global |
| `Alt Shift 1`, `2`, `3`, `4` | Sessions, Memory, Meetings, Settings | global |
| `Alt Esc` | Home | global |
| `Alt I` | Focus details panel | global (acts only on Focus) |
| everything else | screen scope when no terminal has focus; the terminal otherwise | keyboard.md 3 |

| Trigger | Result | API or event |
|---|---|---|
| Rail item click | route | client |
| Rail badge click (part of the Sessions link) | Home; `Alt U` opens the drawer | client |
| Recording bar title | `/meetings/live` | route |
| Toast action | per toast | per toast |
| Toast close | dismiss | client |
| Skip link | focus `main` | client |

## 7. Real-time updates

| Event | Effect |
|---|---|
| `counts` | Rail badge, document title prefix |
| `request.opened` | `needs` toast (rules in 4.4), live region "rustot needs approval: cargo test --release combat::", bell (state-machines 9.2, once per episode, not in quiet mode) |
| `session.state` to `crashed` | live region "andreymudri.com crashed, exit 1"; toast `error` with "Open" (Proposed) |
| `meeting.status` | recording bar in or out, rec dot, quiet mode |
| `health.changed` | connection banners |
| `notify.failed` | one toast per server run |

Live region batching: at most one announcement every 2s; bursts merge ("3 new requests"); nothing assertive (design-system 11.5).

Motion: toasts enter 200ms, exit 160ms; the rec dot pulses; reduced motion fades only and keeps the dot static.

## 8. Accessibility

- Landmarks: `nav aria-label="Deck sections"` (Rail), `main`, labelled `aside`s; one h1 per screen (owned by the screen).
- Rail items: links with `aria-current="page"` on the active one; Tooltip on hover and focus (400ms), not native `title`.
- Focus-visible ring on every Rail item with 2px offset.
- Skip link first in tab order. While the recording bar shows, the skip link is the first child of the bar's labelled region (4.2), so it stays first and inside a landmark.
- Toast stack comes after `main` in the tab order; `Alt U` is the fast path to requests.
- The bell never plays without a visible change (design-system 11.12).

## 9. Copy deck

| Key | EN |
|---|---|
| `shell.skip` | Skip to main content |
| `shell.rail.label` | Deck sections |
| `shell.rail.logo` | fleetmates deck |
| `shell.rail.sessions` | Sessions |
| `shell.rail.sessions.needs` | Sessions, {n, plural, one {# needs you} other {# need you}} |
| `shell.rail.memory` | Memory |
| `shell.rail.meetings` | Meetings |
| `shell.rail.meetings.recording` | Meetings, recording |
| `shell.rail.settings` | Settings |
| `shell.rail.tooltip` | {section} · {keys} |
| `shell.rail.badgeMax` | 99+ |
| `shell.title` | {page} · fleetmates deck |
| `shell.title.needs` | ({n}) {page} · fleetmates deck |
| `shell.notFound` | This page is not on the deck. |
| `shell.notFound.home` | All ships |
| `shell.fatal.token` | This tab's key no longer matches the deck. Open the deck again with fleetmates-deck open. |
| `shell.fatal.origin` | The deck only answers pages it served itself. Open it from fleetmates-deck open. |
| `shell.fatal.heading` | Fleetmates Deck |
| `shell.fatal.outdated` | The deck was updated. Reload |
| `shell.fatal.reload` | Reload |
| `shell.lang.fallback` | DECK_LANG is set to Portuguese, but the Portuguese catalog is not approved yet. The deck is shown in English. |
| `shell.page.home` | Sessions |
| `shell.page.new` | New session |
| `shell.page.focus` | Session |
| `shell.page.team` | Team run |
| `shell.page.memory` | Memory |
| `shell.page.research` | Research |
| `shell.page.meetings` | Meetings |
| `shell.page.settings` | Settings |
| `shell.page.crew` | Crew |
| `shell.page.welcome` | First run |
| `shell.page.notFound` | Not found |
| `shell.page.pending` | This screen arrives in a later milestone. |
| `shell.toast.needs.title` | {repo} needs approval |
| `shell.toast.question.title` | {repo} asked you |
| `shell.toast.crash.title` | {repo} crashed, exit {code} |
| `shell.toast.open` | Open |
| `shell.toast.dismiss` | Dismiss |
| `shell.toast.more` | +{n} more |
| `shell.announce.request` | {repo} needs approval: {summary} |
| `shell.announce.question` | {repo} asked you: {summary} |
| `shell.announce.crash` | {repo} crashed, exit {code} |
| `shell.announce.burst` | {n} new requests |
| `shell.announce.recStart` | Recording started |
| `shell.announce.recStop` | Recording stopped |

## 10. Acceptance criteria

1. **Given** fixture `busy`, **then** the Rail Sessions link has accessible name "Sessions, 3 need you" and `aria-current="page"` on Home.
2. **Given** any shell route, **when** pressing `Alt Shift 2`, **then** the route becomes `/memory`; `Alt 2` instead jumps to the second session.
3. **Given** the terminal focused in Focus, **when** pressing `Alt Shift 3`, **then** the route becomes `/meetings` and the PTY receives no bytes.
4. **Given** a request arrives, **then** exactly one polite announcement "rustot needs approval: cargo test --release combat::" is made and 3 requests within 2s produce "3 new requests".
5. **Given** the drawer open, **when** a request arrives, **then** no `needs` toast shows.
6. **Given** a recording starts from another client, **then** within 2s the bar appears, the Rail height shrinks by 40px and the Meetings item name becomes "Meetings, recording".
7. **Given** a URL with `#token=abc`, **then** after load the address bar has no fragment and API calls carry the token.
8. **Given** a stale token (fixture returns 4401), **then** the full-page token message shows and no retry happens.
9. **Given** 130 sessions needing you, **then** the badge reads "99+" and the document title starts with "(130) ".
10. **Given** a hard reload on `/runs/fleetmates/2026/substop`, **then** the Team route resolves `runId` "2026/substop".

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| SHELL-O1 | Browser WebSocket event names and REST paths used across these specs are Proposed here; the API doc may name them differently (the API doc wins). | Proposed |
| SHELL-O2 | Below 1280px and 200% zoom (design-system 15.3). | Open |
| SHELL-O3 | Whether the logo tile links to Home. | Proposed: yes |
| SHELL-O4 | In-browser `needs` toast for every request or once per session episode. | Proposed: once per episode, like the bell |

## 12. Changes from the canvas

1. Rail tooltips "Sessions (Alt+1)", "Memory (Alt+2)", "Meetings (Alt+3)", "Settings (Alt+,)" become "Sessions · Alt Shift 1" through "Settings · Alt Shift 4" (keyboard.md 2, 4).
2. Rail gets `aria-current`, hover, focus ring and the rec-dot reduced-motion guard (canvas 4.2 had none).
3. Rail background `#111219` becomes `bg.sunken`; badge 10px becomes 11px (`type.badge`).
4. Toasts, skip link, fatal pages, document title rule and the route map are new.
