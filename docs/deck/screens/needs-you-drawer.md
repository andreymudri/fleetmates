# Needs-you drawer (approvals)

| | |
|---|---|
| Canvas board | `Approvals` (Needs you · approval drawer) over Home |
| Route | none: overlay on any route; deep link `?needs=<requestId>` or `?needs=run:<runId>` (Proposed) |
| Milestone | M1 read-only (lists every open request with "Open" and "Answer in your terminal"). M3 adds Allow, Deny, Reply, batch, confirm checkbox and rule suggestion. |
| Status | Decided (sections, tier rules, copy), Proposed (states, per-milestone behaviour) |

## 1. Purpose

Answers **"What exactly is waiting on me, and can I clear it safely in one place?"** Every open request from every session, grouped by risk tier so the safe ones can be cleared fast and the dangerous ones get friction (Decided tier rules, state-machines 2.5).

## 2. Route and entry points

| Entry | Opens with |
|---|---|
| `Alt U` anywhere (keyboard.md 2) | focus on the first request's primary action |
| Home "N need you" chip, Rail badge click (Proposed) | same |
| Team card "Review 2", Team header "Review 2 requests" | scrolled to and focused on that run's first request |
| Card "+1 more request", "Review in Needs you" (Destructive), compact "Reply" | focused on that request (reply field for questions) |
| Palette Enter on a Destructive or Question row | focused on that request |
| Desktop popup "Open" for a Caution, Destructive or question request (state-machines 9.3) | the deck tab focuses and opens the drawer on that request (Proposed: when the session is not observed; observed opens Focus) |

The drawer is an overlay: it does not replace the route. Opening pushes a history entry so Back closes it (Proposed). Deep link query `?needs=<requestId>` opens it on load.

## 3. Layout

| Region | Component / token | Notes |
|---|---|---|
| Scrim | `--overlay-scrim` | one scrim opacity (design-system 7) |
| Panel | Drawer `width="md"` (`--layout-panel-md`), right, full height, `--z-drawer` | |
| Header | Drawer header: title, subtitle, close icon button | |
| Body | sections in fixed order: Safe, Caution, Question, Destructive; section gap `--space-24` | a section renders only when it has requests |
| Section header | TierBadge `md` rendered as h3 + detail count, one-line description | "Safe · 2" + "Reads, tests, builds" |
| Rows | RequestRow per tier variant | |
| Footer | Drawer footer `type.meta` | keyboard hints and rules location |

Width: 600px at 1920, 1440 and 1280 (design-system 8.3). At 1280 the drawer covers most of the page; the scrim still shows the left edge. Height under 800: body scrolls, header and footer stay.

## 4. Content inventory

| Element | Component | Data binding | Copy (EN) | Notes |
|---|---|---|---|---|
| Title | Drawer title (h2) | none | "Needs you" | |
| Subtitle | MetaLine | `counts.openRequests`, `counts.needYouSessions`, `min(request.createdAt)` | "4 requests from 3 ships · oldest waiting 9 min" | same server `counts` object as Home (02-domain 3); "ships" is the Decided subtitle wording |
| Close | Button icon-only 36, `aria-label="Close"` | | "×" rendered by Icon `x` | |
| Safe header | TierBadge `md` safe + count | requests with `tier = safe` | "Safe · 2", "Reads, tests, builds" | uppercased by CSS |
| Safe row | RequestRow `safe` | `request.summary`, source MetaLine: `repo.name`, `session.branch` or teammate `taskId`, waiting | "cargo test --release combat::" / "rustot · combat-tick · waiting 3m" | teammate source: "fleetmates · T5 teammate · waiting 1m" |
| Safe actions | Button `secondary xs` Deny, `safe-outline xs` Allow once | `request.id` | "Deny", "Allow once" | |
| Rule suggestion | link | rule machine `offered` (state-machines 2.8) | "You allowed cargo test in rustot 5 times. Make it a rule?" | one line per offered pattern |
| Batch | Button `safe-outline xs` | Safe requests count >= 2 | "Allow both Safe once" (2), "Allow all 3 Safe once" (3+) | hidden with a single Safe request |
| Caution header | TierBadge `md` caution + count | | "Caution · 1", "Network, installs, outside the repo · one at a time" | |
| Caution row | RequestRow `caution` | as above; source third item is the consequence when known | "npm install commander@14 -w packages/gate" / "fleetmates · T4 teammate · adds a dependency" | consequence text from tiers.json entry description (Proposed) else "waiting {duration}" |
| Caution actions | Button `amber-outline sm` Deny, `amber sm` Allow once | | "Deny", "Allow once" | |
| Question header | TierBadge `md` question + count | `kind = question` | "Question · 1" | |
| Question row | RequestRow `question` | `request.summary`, `request.options` for AskUserQuestion | "Should logs older than 30 days be paginated or truncated?" | options render as `amber-outline sm` buttons + "Other" text field |
| Reply | Field TextInput `md` (sr-only label "Reply") + Button `amber` | | placeholder "Reply to discord-audit", "Reply" | |
| Destructive header | TierBadge `md` destructive | | "Destructive", "Never batched, never a rule, never from a popup" | |
| Destructive row | RequestRow `destructive` | `request.summary`, consequence | "git push --force origin ui/inventory" / "rustot-client · rewrites 3 commits on the remote" | |
| Confirm | Checkbox `tone="danger"` | label from the tiers.json destructive entry (Proposed), with counts when the deck can compute them | "I checked the 3 commits that will be overwritten" | see DRW-O1 |
| Destructive actions | Button `danger sm` Deny, `danger-confirm sm` Allow once (disabled until checked) | | "Deny", "Allow once" | never default button |
| Observed row actions | text + Button `ghost xs` | `session.origin = observed` | "Answer in your terminal", "Open" | replaces every answer button |
| Footer | text | none | "Alt A allow focused · Alt D deny · Alt Shift A allow all Safe · rules live in each repo's .claude/settings.local.json" | M1 footer: "Answer in your terminal for now. Answering here arrives with approvals." (Proposed) |

## 5. States

| State | What shows |
|---|---|
| Loading (drawer opened before the snapshot) | three RequestRow skeletons (SkeletonCard `row`), `aria-busy="true"` |
| Empty | "Nothing needs you." + muted "New requests show up here and on the Sessions grid." (components Drawer); focus on Close |
| Populated | sections as in 4 |
| Row `open.waiting` + `screenMatch = queued` | buttons disabled, line "Queued behind another prompt in this session" |
| Row `open.confirming` (Destructive) | Allow once enabled; Enter still does not press it |
| Row `open.sending` | chosen button shows `loader-circle`, label kept; other buttons in the row disabled |
| Row `open.verifying` | line "Sent · checking…" |
| Row `open.did_not_land` | inline Banner `error`: "Your answer did not reach rustot. The prompt is still open in its terminal." + "Try again" (only when `on_screen`) + "Open terminal" |
| Row answered | row collapses with a 160ms fade; no toast for single answers; batch results give one toast "Allowed 2 of 2" or "Allowed 1 of 2: 1 did not land" |
| Row expired while visible | muted inline note for 3s: "Answered in the terminal" (answered via terminal) or "The session moved on" (expired), then the row leaves |
| After Deny | for 30s the row keeps a Field "Tell Claude what to do instead" + "Send"; empty dismisses (state-machines 2.5) |
| deckd down | every PTY row shows "deckd is reconnecting. Answer in your terminal for now." and answer buttons are disabled; Open stays |
| Server link lost | whole drawer dimmed, actions disabled, banner in the drawer header "Reconnecting to the deck server…" |
| Overflow: many requests | body scrolls; section headers stick to the top of the body while their rows scroll (Proposed) |
| Overflow: long command | `code` scrolls horizontally inside the row; never truncated (components RequestRow) |
| Overflow: long question | full text, wraps; why-line max 2 lines |

Sections never hide: an empty Destructive section is not rendered at all (the canvas "Example · none pending" specimen is not shipped).

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Up / Down (no terminal focus; the drawer is modal) | move the focused request (keyboard target, `shadow.ring-selected`) | client (keyboard.md 3) |
| `Alt A` | allow the focused request once; ignored on Destructive (focus moves to its checkbox instead, Proposed) | `U.Allow` |
| `Alt D` | deny the focused request | `U.Deny` |
| `Alt Shift A` | allow every Safe request once; Caution, Destructive and questions untouched | `U.AllowAllSafe` |
| "Allow once" click | option 1 | `POST /api/requests/:id/answer {choice:'allow'}` |
| "Deny" click | option 3 | `{choice:'deny'}` |
| "Allow both Safe once" | batch, per-row progress | `POST /api/requests/answer-batch {ids, choice:'allow'}` (server re-checks every id is Safe) |
| Checkbox (click or Space only) | enables Allow once | `U.ConfirmDestructive(checked)` |
| "Reply" / Enter in reply field | sends text | `U.Reply(text)` |
| Option button (AskUserQuestion) | sends option number | `U.PickOption(n)` |
| Rule suggestion link | writes the rule; toast "Rule added to rustot: Bash(cargo test:*)" + "Undo" | `U.AcceptRule` |
| "Try again" | re-sends if guards pass | `U.TryAgain` |
| "Open" / "Open terminal" | closes the drawer, Focus on the session | route `/s/:id` |
| Esc, scrim click, "×", Back | close; unchecks every Destructive checkbox (state-machines 2.7 row 8); focus returns to the trigger | client |

Batch semantics (state-machines 2.5): parallel across sessions, sequential within one session.

## 7. Real-time updates

| Event | Effect |
|---|---|
| `request.opened` | row inserted in its section with a 200ms fade; if the drawer is open, the live region announces "New request from rustot" (batched); focus does not move |
| `request.updated` | delivery sub-state, screenMatch, options |
| `request.closed` | row leaves as in 5 |
| `counts` | subtitle numbers |
| `rule.offered` | suggestion line appears under the Safe section |
| `health.changed` (deckd) | row-level disabled state and message |

A row never moves up under the pointer: insertions happen at the end of their section (sorted oldest first), so existing rows only move down, and never while the pointer is over the body (deferred up to 5s, Proposed).

Toasts of tone `needs` are suppressed while the drawer is open (components Toast).

## 8. Accessibility

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the title, focus trap; initial focus on the first request's primary action (design-system 11.2). For a Destructive-first drawer the initial focus is the checkbox, never Allow.
- Each section header is an `h3` (TierBadge as text); each request is a `group` labelled by its command.
- The focused request exposes `aria-current="true"`; Alt A and Alt D act on it; hints in the footer are text.
- Destructive: no shortcut approves; Allow once is not the default button; the checkbox label names the consequence.
- Live announcements come from AppShell (polite, batched); rows are not live regions.
- Command text is in `code`; screen readers read it verbatim.

## 9. Copy deck

| Key | EN |
|---|---|
| `drawer.title` | Needs you |
| `drawer.subtitle.requests` | {n, plural, one {# request} other {# requests}} from {s, plural, one {# ship} other {# ships}} |
| `drawer.subtitle.oldest` | oldest waiting {duration} |
| `drawer.close` | Close |
| `drawer.safe.desc` | Reads, tests, builds |
| `drawer.caution.desc` | Network, installs, outside the repo · one at a time |
| `drawer.question.desc` | (none) |
| `drawer.destructive.desc` | Never batched, never a rule, never from a popup |
| `drawer.section.count` | {tier} · {n} |
| `drawer.row.source.session` | {repo} · {branch} · waiting {duration} |
| `drawer.row.source.teammate` | {repo} · {taskId} teammate · waiting {duration} |
| `drawer.row.deny` | Deny |
| `drawer.row.allowOnce` | Allow once |
| `drawer.row.reply.label` | Reply |
| `drawer.row.reply.placeholder` | Reply to {repo} |
| `drawer.row.reply.send` | Reply |
| `drawer.row.other` | Other |
| `drawer.row.answerInTerminal` | Answer in your terminal |
| `drawer.row.open` | Open |
| `drawer.row.openTerminal` | Open terminal |
| `drawer.row.queued` | Queued behind another prompt in this session |
| `drawer.row.sent` | Sent · checking… |
| `drawer.row.didNotLand` | Your answer did not reach {repo}. The prompt is still open in its terminal. |
| `drawer.row.tryAgain` | Try again |
| `drawer.row.answeredTerminal` | Answered in the terminal |
| `drawer.row.movedOn` | The session moved on |
| `drawer.row.tellInstead` | Tell Claude what to do instead |
| `drawer.row.tellInstead.send` | Send |
| `drawer.row.deckdDown` | deckd is reconnecting. Answer in your terminal for now. |
| `drawer.safe.batch` | {n, plural, =2 {Allow both Safe once} other {Allow all # Safe once}} |
| `drawer.safe.batch.toast` | Allowed {ok} of {n} |
| `drawer.safe.batch.toastPartial` | Allowed {ok} of {n}: {failed} did not land |
| `drawer.rule.suggest` | You allowed {command} in {repo} {n} times. Make it a rule? |
| `drawer.rule.added` | Rule added to {repo}: {pattern} |
| `drawer.destructive.confirm` | {consequence} |
| `drawer.empty.title` | Nothing needs you. |
| `drawer.empty.body` | New requests show up here and on the Sessions grid. |
| `drawer.footer` | Alt A allow focused · Alt D deny · Alt Shift A allow all Safe · rules live in each repo's .claude/settings.local.json |
| `drawer.footer.m1` | Answer in your terminal for now. Answering here arrives with approvals. |
| `drawer.newRequest.announce` | New request from {repo} |
| `drawer.reconnecting` | Reconnecting to the deck server… |

## 10. Acceptance criteria

1. **Given** fixture `busy`, **when** pressing `Alt U`, **then** the drawer opens with title "Needs you", subtitle "4 requests from 3 ships · oldest waiting 9 min", sections Safe (2), Caution (1), Question (1) and no Destructive section, and focus is on the first Safe row's "Allow once".
2. **Given** the drawer open, **then** the subtitle counts equal the Home chip ("3 need you") and the Rail badge ("3") at the same moment, across 20 randomized open and close events (property test on the fixture server).
3. **Given** fixture `destructive` (one destructive request), **when** focusing Allow once and pressing Enter or `Alt A`, **then** no answer is sent; **when** the checkbox is ticked with Space, **then** Allow once becomes enabled; **when** the drawer is closed and reopened, **then** the checkbox is unticked.
4. **Given** 2 Safe and 1 Caution requests, **when** pressing `Alt Shift A`, **then** exactly the 2 Safe request ids are answered and the Caution row remains.
5. **Given** a batch where one answer does not land, **then** one toast reads "Allowed 1 of 2: 1 did not land" and the failed row shows "Try again".
6. **Given** a request answered in the terminal while visible, **then** the row shows "Answered in the terminal" for 3s and then leaves.
7. **Given** an observed session's request, **then** its row has no Allow, Deny or Reply, only "Answer in your terminal" and "Open".
8. **Given** the drawer open and a new request arrives while the pointer is over the body, **then** no existing row moves until the pointer leaves or 5s pass.
9. **Given** the team card "Review 2", **then** the drawer opens scrolled to the T4 Caution row with focus on it.
10. **Given** M1 build flag, **then** rows show "Open" and "Answer in your terminal" only and the M1 footer text.
11. **Given** reduced motion, **then** the drawer fades in without sliding.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| DRW-O1 | The Destructive confirm label "I checked the 3 commits that will be overwritten" needs a per-command consequence (commit count for `git push --force`). No source computes it. | **Open**. Default: tiers.json destructive entries carry a label template; when the deck cannot fill the count, the label reads "I checked what this command will change". |
| DRW-O2 | Caution row third line "adds a dependency" is a per-pattern description that tiers.json does not define yet. | Proposed: optional `description` per tiers.json pattern; else "waiting {duration}". |
| DRW-O3 | Notification-only requests (state-machines 2.7 row 2) have no `tool_input`; their summary is the notification message, tier Caution. | Proposed: shown with the message text and a muted "(details not available)". |
| DRW-O4 | Popup "Open" for Caution (SM-O9). | Open (tracked as SM-O9). |

## 12. Changes from the canvas

1. The Destructive "Example · none pending" specimen and its dimmed section are not shipped; the section renders only with real requests.
2. Tier words are stored in sentence case and uppercased by CSS ("Safe · 2").
3. Section order stays Safe, Caution, Question, Destructive (canvas), but initial focus goes to the checkbox when the only requests are Destructive.
4. Batch label pluralises ("Allow all 3 Safe once").
5. Teammate source uses task ids ("T5 teammate"), not "task 5 teammate".
6. The drawer input moves from `bg.surface` to `bg.canvas` (components Field).
7. Scrim opacity .55 becomes the shared .66.
