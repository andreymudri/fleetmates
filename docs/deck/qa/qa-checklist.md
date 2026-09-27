# Design QA checklist

Verifies that the React build matches the screen specs in [../screens/](../screens/README.md), the tokens and components in [../design/](../design/design-system.md), the keyboard map in [../interaction/keyboard.md](../interaction/keyboard.md) and the behaviour in [../interaction/state-machines.md](../interaction/state-machines.md). QA runs against the specs, not against memory of the canvas.

Status labels (Decided, Proposed, Open) as in [02-domain.md](../02-domain.md). Items marked **auto** have an automated check; the rest are manual passes.

## 0. Process

1. **Developer self-review** against sections 1 and 2 for the screens in the milestone, with every automated check green.
2. **Design QA pass** (owner or reviewer) at 1920 x 1080 first, then 1440 x 900 and 1280 x 800, using the fixtures in [screens/README.md](../screens/README.md) section 4.
3. **File bugs** with: screen, fixture, viewport, screenshot of the build next to the canvas render (section 3 baseline) or the spec line it violates, severity.
4. **Severity**: S1 wrong or hidden "needs you", wrong count, an approval path that bypasses a tier rule, unescaped agent text; S2 missing state, broken keyboard path, contrast failure, layout break at a supported width; S3 visual drift from tokens or copy; S4 polish.
5. **Verify fixes** on the same fixture and viewport; S1 and S2 fixes need an automated regression test.
6. **Record recurring issues** at the bottom of this file (section 4) so the next milestone checks them first.

## 1. Global checks (every screen)

### 1.1 Visual accuracy

- [ ] **auto** No raw colour values in component CSS or JS: Stylelint `declaration-strict-value` on `color`, `background`, `border-color`, `box-shadow`, `fill`, `stroke` passes; `grep -rE '#[0-9a-fA-F]{3,8}\b' src/` finds matches only in `tokens.css`, `tokens.json` and the crew slot table generator.
- [ ] Components use semantic tokens, not primitives (`--color-*` appears only inside `tokens.css`) (design-system 2.1). **auto** grep for `var(--color-` outside tokens.css.
- [ ] Typography uses `type.*` styles only; no weight 500; weight 700 only in `badge` (design-system 4.1).
- [ ] Spacing values come from the 2px scale; radii from `radius.*`; control heights from `size.control.*`.
- [ ] Icons are lucide at `size.icon.*`, stroke 2 (Rail 1.75), `currentColor`; the anchor logo is the custom LogoMark.
- [ ] Crew avatars render as one inline SVG with `crispEdges`; sizes only 27, 36, 45, 72 (crew.md 8); test vectors pass (crew.md 11) **auto**.
- [ ] One dark theme; nothing follows the OS colour scheme (design-system section 1, principle 5).

### 1.2 Layout and widths

- [ ] 1920 x 1080: every screen matches its spec's layout table; Home comfortable shows 6 cards + quiet row without scroll with fixture `busy`.
- [ ] 1440 x 900 and 1440 x 1000: behaviour per each spec's width table (design-system 8.2, 8.3).
- [ ] 1280 x 800: no horizontal page scroll on any route **auto** (`document.documentElement.scrollWidth <= innerWidth`); Focus list collapses to 72px; details panel becomes a drawer.
- [ ] Only inner regions scroll; the page header stays; the shell is `100vh`.
- [ ] No layout shift when skeletons are replaced by content (CLS under 0.02 on Home load) **auto**.
- [ ] Recording bar present: Rail height is viewport minus 40px; nothing is hidden under the bar.

### 1.3 Interaction and keyboard

- [ ] Focus-visible ring on every interactive element (buttons, links, rows, tabs, chips, graph nodes, swatches, the terminal section via `:focus-within`); no `outline: none` without the replacement; rings never on mouse click **auto** (axe `focus-visible` custom rule + a tab-through script that screenshots each focus stop).
- [ ] Hover (100ms) and pressed states exist on every clickable surface (components conventions).
- [ ] Disabled controls show a visible reason next to them (not only a tooltip): "deckd is reconnecting", "Set sail (needs hooks)", orphan-citation reason.
- [ ] Keyboard map matches keyboard.md, **not** the canvas: `Alt I` (not `Alt B`) toggles the Focus panel; Rail uses `Alt Shift 1..4`; `Alt 1..9` jump to sessions; `Alt U` opens the drawer; `Alt N` launches; chords written with spaces ("Alt K"), never "Alt+K" **auto** (grep the i18n catalog for `Alt+`).
- [ ] With a terminal focused, only the global set is intercepted; `Alt P`, `Alt B`, `Alt T` reach the PTY **auto** (fake deckd records bytes).
- [ ] Every shortcut duplicates a visible control (keyboard.md intro); Kbd chips appear only where a shortcut exists.
- [ ] No keyboard path approves a Destructive request (no Enter, no `Alt A`, no `1`) **auto**.
- [ ] Dialogs, drawer and palette trap focus, close on Esc and return focus to the trigger **auto**.
- [ ] Targets at least 28 x 28; icon-only buttons 36 x 36; 8px between adjacent small targets (design-system 11.3).
- [ ] Moving content never moves under the pointer: reorders and insertions defer while the pointer is over a grid, list or drawer body (home.md 7.2, needs-you-drawer.md 7).

### 1.4 Motion

- [ ] Only allowed loops run: breathe (running dot), pulse (needs-you card), rec-pulse, arrive (new graph node, stops after 60s), shimmer (skeleton), caret (xterm only when motion is allowed).
- [ ] With `prefers-reduced-motion: reduce` (and with Settings "Always reduce motion"), no CSS animation runs and transitions are at most 100ms fades **auto** (`document.getAnimations()` returns no running animation 1s after load).
- [ ] No transition over 280ms; numbers and counters jump, never animate; no smooth scroll.

### 1.5 Contrast and colour meaning

- [ ] Every text and background pair clears WCAG AA (4.5:1 normal, 3:1 large) per design-system 3.7; field borders 3:1 **auto** (axe `color-contrast` on every fixture screen).
- [ ] State is never colour-only: every StatePill has an icon or dot plus a literal label; TierBadges show the word; diff lines keep `+` and `-`; file counts keep `+` and `−`; FirstRun circles carry glyphs and sr words; transcript speakers are labelled.
- [ ] Amber is the only pulsing hue; teal never marks a session state.

### 1.6 Content and copy

- [ ] Pills are literal (02-domain 3): "Running", "Needs approval", "Asked you", "Done", "No activity 22m", "Idle 1h", "Reviewed", "Crashed · exit 1", "Ended"; never themed; the compact "Done · to review" and Team "Needs you" canvas labels are gone.
- [ ] Themed words appear only in headlines, subtitles, empty or calm states and the three Open launch buttons.
- [ ] Every chrome string comes from an i18n key; no string concatenation for sentences; plurals through ICU **auto** (lint rule forbidding JSX text literals outside the i18n layer; catalog keys match the copy decks in each spec).
- [ ] Separators " · " come from MetaLine with `aria-hidden` dots; ranges use "to"; minus in diff counts is U+2212; the em dash and en dash characters appear nowhere in chrome strings **auto** (grep the catalog for U+2014 and U+2013).
- [ ] Durations `12m`, `1h 12m`, `3d`; clock 24h; meeting offsets `MM:SS` counting total minutes; numbers via `Intl.NumberFormat`.
- [ ] Truncation: single-line ellipsis with the full text in the node and `title`; commands in request rows never truncate (they scroll).
- [ ] Real content fits: run every screen with the fixtures and with a "long" variant (80-character task, 60-character repo, 300-character command, 400-character question).

### 1.7 Untrusted text (security-relevant UI)

- [ ] **auto** For every fixture field that carries agent, transcript, task, command, path, note, URL or meeting text, inject `<img src=x onerror=alert(1)>`, `<script>alert(1)</script>`, `javascript:alert(1)` links, bidi override U+202E and ANSI escapes; assert: no new element, no dialog, no navigation, the text is visible literally, bidi controls are shown or neutralised, ANSI stripped.
- [ ] No `dangerouslySetInnerHTML` anywhere, zero exceptions **auto** (ESLint `react/no-danger`). Markdown is rendered by walking markdown-it tokens into React elements ([08-security.md](../08-security.md)); no HTML string is ever injected.
- [ ] Markdown links open with `rel="noopener"`; non-localhost terminal links ask for confirmation.

### 1.8 Counts consistency (S1 if broken)

- [ ] **auto** Property test on the fixture server: for 200 random sequences of request open, answer, expire and session state changes, after each event the Home "N need you" chip, the Rail badge, the document title prefix, the drawer subtitle ("R requests from S ships"), and every Team pill numerator agree with the server `counts` object and with each other in the same animation frame.
- [ ] "N running" counts `starting` + `running` only (02-domain section 3; chips are disjoint); "N to review" counts `done` (including `alive=false`).
- [ ] A team card counts once in the sessions counts (its lead session), while its pill shows teammates ("2 of 4 need you").

### 1.9 Accessibility (beyond the above)

- [ ] **auto** axe-core has zero serious or critical violations on every fixture screen and overlay.
- [ ] One h1 per screen; landmarks: `nav` Rail "Deck sections", `main`, labelled `aside`s; skip link first.
- [ ] One polite live region; announcements batched (max one per 2s, bursts merged); nothing assertive; the recording timer is not live.
- [ ] Screen reader smoke test (Orca on the owner's machine, Proposed): new request announcement, drawer navigation, palette result count, Focus terminal leave hint.
- [ ] `lang="pt-BR"` on meeting content and PT-BR notes when chrome is English.
- [ ] Browser zoom 150% at 1920 still works without overlap (text resizes with zoom).

### 1.10 Cross-platform

- [ ] Chromium and Firefox latest on Linux (Omarchy/Hyprland). Safari and mobile are out of scope for v1 (D-05).
- [ ] Device pixel ratios 1 and 1.25: crew pixels stay crisp (small unevenness at 1.25 is accepted, crew.md 9).
- [ ] Geist and Geist Mono are self-hosted and load offline.

## 2. Per-screen checklists

### 2.1 Home ([home.md](../screens/home.md))

- [ ] `busy` 1920: card order fleetmates, rustot, discord-audit, research, andreymudri.com, vault-mcp; quiet row rustot-client, turbidassist, axios-like.
- [ ] Chips "3 need you", "2 running", "1 to review"; chips are buttons with full accessible names.
- [ ] Card variants per the selection table; Destructive requests show "Review in Needs you" only; observed sessions show "Answer in your terminal".
- [ ] Request box: tier badge word, full command (scrolls), rule suggestion link when offered.
- [ ] Answer states: sending spinner with label kept, "Sent · checking…", did-not-land error with Try again, guard messages.
- [ ] Quiet cards: corrected lines ("Adrift since 17:40: no activity since then.", "Reviewed at 15:20. Leaves the grid at midnight."), "Nudge (send Enter)", "Stop…".
- [ ] Crowded mode with `crowded12`: QuietStrip chip order, hysteresis at 8.
- [ ] Calm: eligibility rule, headline, `Alt N` on the hero button, section empty lines.
- [ ] Compact: 3 x 3, tails bottom-aligned with pinned head, action strips per variant, compact Reply opens the drawer.
- [ ] Density persists across reload.
- [ ] deckd down: banner countdown, disabled actions with reason, pills still update.
- [ ] 1280: 2 columns, fleet scrolls, header fixed.

### 2.2 Palette ([palette.md](../screens/palette.md))

- [ ] Opens with `Alt K` from anywhere, including a focused terminal; `Alt K` while open moves up.
- [ ] Group order Needs you, Sessions, Actions, Memory; Kbd only on rows with shortcuts; no `Alt ?`.
- [ ] `?` and `>` prefix modes; unknown command message.
- [ ] Destructive and question rows open the drawer; Safe and Caution rows allow (M3).
- [ ] Combobox semantics, result count announced, Esc returns focus.

### 2.3 Needs-you drawer ([needs-you-drawer.md](../screens/needs-you-drawer.md))

- [ ] Title, subtitle counts equal Home and Rail.
- [ ] Sections only when non-empty; no "Example · none pending".
- [ ] Safe batch label pluralises; `Alt Shift A` never touches Caution, Destructive or questions.
- [ ] Destructive: checkbox by click or Space only; Allow disabled until ticked; unticked on close; initial focus never on Allow.
- [ ] Row lifecycle: queued, sending, verifying, did not land, answered fade, expired notes.
- [ ] After Deny: "Tell Claude what to do instead" for 30s.
- [ ] Team "Review 2" opens scrolled and focused on the run's first request.
- [ ] M1 build: read-only rows and M1 footer.

### 2.4 Focus ([focus.md](../screens/focus.md))

- [ ] Terminal focused on open; "Alt Esc to leave the terminal" visible while focused; global chords leave it.
- [ ] Input-source indicator states and collision chip.
- [ ] PromptBar per tier (Safe 1, 2, 3; Caution 1, 3; Destructive checkbox), keys 1 to 3 only without terminal focus.
- [ ] Observed session: read-only banner, activity log, no Stop or Nudge.
- [ ] Changes tab listbox and unified diff; Memory tab (M5); Facts tab rows.
- [ ] `Alt I` toggles the panel; at 1280 the panel is a drawer and the list is 72px.
- [ ] Stop confirm focuses Cancel, copy says SIGTERM then SIGKILL after 5 s.

### 2.5 Team run ([team-run.md](../screens/team-run.md))

- [ ] Task ids (T3...), "Phase N" labels, gates from recorded verdicts only, `status.phase` ignored.
- [ ] Task states include Pending, Blocked, Failed, Orphaned, Unknown with their tokens.
- [ ] Unreadable `status.json`: last data dimmed + error banner after 3 retries.
- [ ] Crew panels: tool steps only for teammates with the note; `role="log"` `aria-live="off"`.
- [ ] 1280: crew panels one column.

### 2.6 Failures and loading ([failures-and-loading.md](../screens/failures-and-loading.md))

- [ ] Crash card: pill variants (exit, signal, lost), error mapping rows, ENOSPC primary "Show disk usage".
- [ ] A user-requested stop never produces a crash card.
- [ ] deckd banner backoff and "Retry now" semantics; server-link banner dims the UI with "as of".
- [ ] Degraded cards replace only the dependent area; recovery fade and announcement.
- [ ] Skeleton rules: same size as content, `aria-busy`, static under reduced motion, cached snapshot beats skeleton.

### 2.7 Memory ([memory.md](../screens/memory.md))

- [ ] Crumb counts from `vault_graph`; clusters; labels always for MOC, index, cited, new.
- [ ] Keyboard graph navigation (roving tabindex, arrows, Enter, Esc, `+ - 0`).
- [ ] Ask states: thinking, streaming, answered with citations, miss card, general-knowledge block separate, error with question kept, 120s timeout, Stop.
- [ ] Note panel sections and "Recently used" rows only from observable data.
- [ ] Browse by MOC as the graph's accessible equivalent.
- [ ] vault-mcp down: degraded card; no-graph-tool message.

### 2.8 Research ([research.md](../screens/research.md))

- [ ] Form: Topic focus, existing-notes callout debounce, Standard default, validation messages, `Alt Enter`, draft kept 10 minutes.
- [ ] Review: pill "Draft · not saved", sources with Why and Backs, "Rejected" label (no dash glyph), orphan highlight with sr "(unsupported)".
- [ ] Save disabled until preview, while stale, with orphans, or when vault-mcp is down, each with its visible reason.
- [ ] Footer file list built from `preview.files` (3 or 4 files); daily time footnote.
- [ ] Discard confirm; saved and saved-elsewhere notices.

### 2.9 Meetings ([meetings.md](../screens/meetings.md))

- [ ] List by day, meta, post-state lines; search hits with `mark` built from ranges.
- [ ] Record outline with red dot, tag menu from `config.yaml`, confidential tags marked.
- [ ] Recorder states: starting, recording (rec bar on every screen), stopping (ignore polls), refused toast verbatim PT.
- [ ] Timer `MM:SS` total minutes, `aria-hidden`; static sr text.
- [ ] `Alt P` pin with 2s merge; pinned style.
- [ ] Live ask eyebrow matches the engine in use; no vault citation or Save button unless MEET-O4 and MEET-O8 are decided.
- [ ] Confidential: no transcript text persisted by the deck (inspect DB) **auto**.
- [ ] scribed down: past meetings still load.

### 2.10 Settings ([settings.md](../screens/settings.md))

- [ ] Rules grouped by repo, source lines ("from 5 approvals · 26 Sep", "added by hand"), Revoke neutral then red confirm with Cancel focused.
- [ ] Revoke writes the real settings file **auto**; external edits show as "added by hand".
- [ ] Threshold Select 5 / 3 / Never and its effect on suggestions.
- [ ] Tier aside text verbatim; aside below content at 1440.
- [ ] Other sections render per spec (Proposed) and persist.

### 2.11 First run ([first-run.md](../screens/first-run.md))

- [ ] Redirect to `/welcome` until completed; six checks in parallel with 10s timeouts.
- [ ] Only hooks gate "Set sail"; disabled label "Set sail (needs hooks)"; real Claude Code version (no "[version]").
- [ ] Fix actions re-check; summary announcement.

### 2.12 New session ([new-session.md](../screens/new-session.md))

- [ ] Two fields only; repo combobox with recent harbors; `Alt N` opens; `Alt Enter` submits.
- [ ] Same-repo warning shows and never blocks; "Run as a fleetmates job" present (behaviour flagged Open).
- [ ] deckd down disables Launch with reason; spawn error keeps inputs.

### 2.13 Shell ([rail-and-shell.md](../screens/rail-and-shell.md))

- [ ] Rail items, `aria-current`, tooltips "Memory · Alt Shift 2", badge hidden at 0 and "99+" over 99, rec dot.
- [ ] Routes resolve on hard reload, including nested run ids; token fragment removed.
- [ ] Toast rules (stack, tones, pause, suppression while the drawer is open).
- [ ] Fatal pages for 4401 and 4403 with no retry.

### 2.14 Crew sheet ([crew-sheet.md](../screens/crew-sheet.md))

- [ ] Grid as a table with row and column headers; avatars named "{repo} crew member, {pose}".
- [ ] Swatches only from free slots; Reroll and hat changes propagate to every open avatar.
- [ ] Unsigned-shift ears (vault-mcp, discord-audit, rustot-client differ from the canvas).

## 3. Visual regression plan

### 3.1 Tooling

- Playwright `toHaveScreenshot` at viewport 1920 x 1080, `deviceScaleFactor: 1`, Chromium, fonts self-hosted, `animations: 'disabled'`, `caret: 'hide'`, `page.clock` frozen at 2026-09-26 18:44 local (the canvas "Saturday evening").
- The fixture server replays deterministic data (screens/README.md section 4); xterm renders from a fixed screen buffer; the graph layout is seeded.
- Masks (`mask:` option) for regions that are not comparable by design: the live xterm canvas (Focus), ticking values only when the clock is not frozen, and the rec dot.
- Also capture 1440 x 900 and 1280 x 800 for every state; these have no canvas baseline and use the build baseline from phase 2.

### 3.2 Baselines in two phases

1. **Phase 1: canvas as the initial baseline.** Copy the canvas renders (`render/shots/<Board>.png`, 1920 x 1080) into `hub/test/visual/canvas/<Board>.png`. Each state in 3.3 is compared with its board using a loose threshold (`maxDiffPixelRatio: 0.08`) and a diff image. Every differing region must map to an intentional difference in 3.4; anything else is a bug. This phase is a review aid, not a CI gate.
2. **Phase 2: approved build as the baseline.** Once the design QA pass signs off a screen, its build screenshots replace the canvas baseline (`hub/test/visual/build/`), the threshold drops to `maxDiffPixelRatio: 0.002`, and the test becomes a CI gate. Updating a build baseline needs a linked spec change or bug.

### 3.3 Screenshot matrix (1920 x 1080)

| Test name | Route and fixture | Canvas baseline |
|---|---|---|
| `home-busy-comfortable` | `/`, `busy` | `Home.png` |
| `home-busy-compact` | `/`, `busy`, density compact | `HomeCompact.png` |
| `home-calm` | `/`, `calm` | `HomeCalm.png` |
| `home-crowded` | `/`, `crowded12` | none (new) |
| `home-deckd-down` | `/`, `deckdDown` | `Failures.png` (banner + skeleton region only, clipped) |
| `home-loading` | `/`, no snapshot, WebSocket held in `connecting` | `Failures.png` (skeleton region, clipped) |
| `palette-rus` | `/` + `Alt K` + "rus", `busy` | `Palette.png` |
| `drawer-busy` | `/` + `Alt U`, `busy` | `Approvals.png` (without the Destructive example) |
| `drawer-destructive` | `/` + `Alt U`, `destructive` | `Approvals.png` (Destructive card region, clipped) |
| `focus-rustot` | `/s/<rustot>`, `busy`, terminal masked | `Focus.png` |
| `team-gate-cli` | `/runs/fleetmates/gate-cli`, `team` | `Team.png` |
| `failures-crash-card` | `/`, `busy` with andreymudri.com crashed (ENOSPC), card clipped | `Failures.png` (crash specimen, clipped) |
| `failures-stale-focus` | `/s/<rustot-client>`, `busy` | `Failures.png` (adrift specimen, clipped) |
| `failures-memory-degraded` | `/memory`, `vaultDown` | `Failures.png` (Memory tab card, clipped) |
| `failures-meetings-degraded` | `/meetings`, `scribedDown` | `Failures.png` (Meetings tab card, clipped) |
| `memory-clusters-ask` | `/memory?thread=<canvas thread>`, `vault22` | `MemoryV1.png` |
| `memory-note` | `/memory/note/02-wiki/nestjs/bullmq-worker.md`, `vault22` | `MemoryNote.png` |
| `research-form` | `/research/new?topic=…` over `/memory`, `vault22` | `ResearchForm.png` |
| `research-review` | `/research/<id>`, `researchDrafted` | `ResearchReview.png` |
| `meetings-detail-search` | `/meetings/<client-a>?q=feature%20flag`, `meetings5` | `Meetings.png` |
| `meetings-live` | `/meetings/live`, `recording` | `MeetingLive.png` |
| `settings-rules` | `/settings/rules`, `rules5` | `Settings.png` |
| `first-run` | `/welcome`, `firstRunHooksMissing` | `FirstRun.png` |
| `crew-sheet` | `/settings/crew`, `busy` | `CrewSheet.png` (content area, clipped; the page now sits inside Settings) |
| `rail` | any, Rail element only | `Rail.png` |

Additional states captured without a canvas baseline (phase 2 only): drawer empty, palette `?` mode, palette no results, Focus observed session, Focus 1280 drawer, Team unreadable status, Memory empty vault, Research stale preview, Research orphan citations, Meetings awaiting names, Meetings stopping, Settings revoke dialog, New session with conflict banner, First run all ok, toast stack.

### 3.4 Intentional differences from the canvas renders

Each is documented in the "Changes from the canvas" section of the named spec. Reviewers must not file these as bugs.

**Tokens and visuals (design-system 14)**

1. Running pill background green tint (was blue-grey); surfaces collapsed (`#131420`, `#111219`, `#12131a` to token surfaces); skeleton colours; amber tints unified; field borders `border.field`.
2. Typography: 10px badges to 11px; compact tail 12.5/1.72 to 12/1.6; degraded titles 18px; Settings h2 28px; page h1 22px everywhere; eyebrows 12px with one tracking; typed caps become CSS uppercase (same pixels, different source).
3. Spacing, radii and control heights snapped to the scales (for example card padding 18 to 20, grid gap 18 to 20, 38px buttons to 36 or 40).
4. Icons redrawn with lucide (small shape differences); new icons for idle (`moon`), reviewed (`check-check`), starting, ended, draft.
5. Focus-visible rings appear on the focused element in screenshots taken after keyboard navigation (the canvas has none).
6. Scrim opacity .55 to .66 (drawer).
7. Crew: unsigned-shift ears change `vault-mcp`, `discord-audit`, `rustot-client`; crew sizes 54, 63, 108 to 45 and 72; teammate colours from the shade formula; bandana drawn.

**Copy and data honesty**

8. Home "4 running" becomes "2 running" (disjoint counts, 02-domain section 3).
9. Task ids everywhere ("T4 · needs you", "T5 teammate", "T3" rows) instead of "task 4", "teammate 2", "fm-t1".
10. Phase names become "Phase 1..4" (HOME-O2, TEAM-O1); Team phase ranges use "to".
11. Team "Needs you" task state becomes "Needs approval"; compact "Done · to review" becomes "Done"; Focus list "Done · to review" becomes "Done"; compact "ASK" badge becomes "Question".
12. Quiet stale and reviewed lines rewritten; "Nudge" becomes "Nudge (send Enter)"; "Stop" becomes "Stop…".
13. Home "Launch a ship" shows `Alt N`.
14. Palette loses `Alt ?`; footer hint text changed.
15. Drawer: Destructive "Example · none pending" section absent unless a real request exists.
16. Focus: "Hide panel Alt B" becomes "Hide panel Alt I"; Related memory moves to the Memory tab; new "Mark reviewed" and "Open run" actions when applicable; the terminal is the live xterm (masked).
17. Team: gate banner shortened; teammate panels show tool steps only with a note; "running 1h 12m" only when a start time exists.
18. FirstRun: real Claude Code version instead of "[version]".
19. Research: rejected source shows "Rejected" instead of the dash glyph; frontmatter preview shows what `vault_learn` will write; footer adds the daily-time note.
20. Meetings live: timer "19:14" instead of "00:19:14"; rec bar title "Client A · started 14:00"; ask eyebrow "Ask · uses the transcript"; no vault citation and no "Save answer to meeting note"; no partial italic line ("Listening…" instead); ask panel 600 wide.
21. Memory: "Recently used" shows `vault_get_note` reads only; chat bubble max width 420.
22. Crew sheet: swatches from free slots only; team tiles "T1..T3"; page inside Settings.
23. Rail tooltips "Sessions · Alt Shift 1" style (not visible in static screenshots unless hovered).
24. HomeCalm capture dots use the vault domain colours.

## 4. Recurring issues log

| Date | Issue | Screens | Prevention |
|---|---|---|---|
| (empty) | | | |
