# fleetmates deck: component specs

One spec per component, in the order a port would build them. Values are token names from [tokens.json](tokens.json); CSS variables are the same path joined with `-` (see [design-system.md](design-system.md) section 2). Canvas references ("canvas 2.10") point to sections of the canvas inventory.

Status labels: **Decided** (drawn on the canvas or chosen by the owner), **Proposed** (this handoff; mostly states the canvas never drew), **Open** (needs an owner call).

Conventions that apply to every component, so they are not repeated below:

- The UI is JavaScript with JSDoc (Decided direction; TSX is still Open, Q2 in [15-open-questions.md](../15-open-questions.md)). Props are documented as `@typedef`.
- **Untrusted text**: any string that comes from an agent, a transcript, a task, a command, a file path, a note or a URL renders as a React text node. Never `dangerouslySetInnerHTML`. Markdown goes through a sanitising renderer that emits React elements (design-system 11.13).
- **Focus**: every interactive element shows the global focus-visible ring (design-system 11.1). "focus-visible" below only lists deviations.
- **Hover** on any clickable surface without its own rule: `bg.hover` state layer, 100ms (`--transition-hover`). **Press**: `bg.press`.
- **Disabled**: `aria-disabled` or the native `disabled`, `cursor: not-allowed`, no hover, and a visible reason nearby (text, not only a tooltip).
- **Loading**: regions that load set `aria-busy="true"` and show SkeletonCard or a spinner; buttons that trigger async work show `loader-circle` and keep their label.
- Separators " · " come from the `MetaLine` helper (items array, dots `aria-hidden`), never from string concatenation (design-system 12.5).
- **Truncation**: single-line ellipsis via CSS; the text node always holds the full string, and truncated titles get a `title` attribute.

---

## 1. AppShell

**Status** Decided (layout), Proposed (live region, breakpoints). **Screens** every screen except FirstRun, CrewSheet (full-bleed pages) and Failures specimens.

Purpose: the frame. Rail, optional secondary sidebar, main, optional right panel; hosts overlays, the polite live region and the recording bar.

Anatomy: `[RecBar?]` over `[Rail][Sidebar?][main][Aside?]`, then overlay root (Drawer, Dialog, Palette, Toast stack) and one `role="status"` live region.

```js
/**
 * @typedef {Object} AppShellProps
 * @property {'sessions'|'memory'|'meetings'|'settings'} section  Active rail item
 * @property {React.ReactNode} [sidebar]   Secondary list (Focus list, Meetings list, Settings nav)
 * @property {React.ReactNode} [aside]     Right panel
 * @property {React.ReactNode} children    Main content (starts with PageHeader)
 * @property {boolean} [recording]         Shows the 40px recording bar and the rail rec dot
 */
```

Layout: `display: flex; height: 100vh`; only inner regions scroll. Widths from `layout.*`; breakpoint behaviour in design-system 8.3.

Tokens: `bg.canvas`, `layout.rail`, `layout.list`, `layout.nav`, `layout.panel-sm`, `layout.panel-md`, `layout.rec-bar`, `z.*`.

Keyboard and ARIA: landmarks `nav` (Rail), `main`, `aside aria-label` per panel. Owns the global keydown listener from keyboard.md. The live region batches announcements (one per 2s, bursts merged) for new requests and crashes. Skip link "Skip to main content" as the first focusable element (`.sr-only-focusable`) (Proposed).

---

## 2. Rail

**Status** Decided (canvas 4.2), Proposed (hover, focus, tooltip text). **Screens** every shell screen.

Anatomy: logo tile (38, `radius.lg`, `brand.accent`, anchor mark), items Sessions, Memory, Meetings, spacer, Settings. Sessions carries a needs badge; Meetings carries the rec dot.

```js
/**
 * @typedef {Object} RailProps
 * @property {'sessions'|'memory'|'meetings'|'settings'} active
 * @property {number} needs      Sessions with an open request; badge hidden at 0
 * @property {boolean} recording Pulsing rec dot on Meetings
 */
```

States:

- Default item: 44 x 44, `radius.lg`, icon 20 stroke 1.75, `text.muted`.
- Hover (Proposed): `bg.hover`, icon `text.default`.
- Active: `brand.accent-strong-tint` bg, `text.link` icon, `shadow.ring-selected`, `aria-current="page"`.
- Focus-visible: ring with 2px offset (the rail has room).
- Needs badge: min 16 x 16, `radius.pill`, `state.needs-approval.fg` fill, `text.on-amber`, `type.badge` (11px, was 10).
- Rec dot: 8px `color.red.400`, `.motion-rec-pulse` (now reduced-motion safe).

Tokens: `bg.sunken`, `border.default` (right edge), `brand.*`, `size.icon.lg`.

Keyboard and ARIA: `nav aria-label="Deck sections"`; each item a link with `aria-label` ("Sessions"). Needs badge text is `aria-hidden`; the link label becomes "Sessions, 3 need you". Tooltip (native `title` is not enough for keyboard users; use a Tooltip on hover and focus) reads "Memory · Alt Shift 2" (keyboard.md 4).

---

## 3. PageHeader

**Status** Decided (canvas 2.3). **Screens** Home, HomeCompact, Focus, Team, Memory, ResearchReview, Meetings detail.

Anatomy: `[back link?] [CrewAvatar?] [title block: h1 + subtitle] [pills] [spacer] [actions]`, bottom border `border.default`.

```js
/**
 * @typedef {Object} PageHeaderProps
 * @property {string} title                 h1 text
 * @property {React.ReactNode} [subtitle]   Plain text or MetaLine; mono when it is repo · branch · path
 * @property {{label: string, href: string, kbd?: string}} [back]  "All ships" + "Alt Esc"
 * @property {{seed: string, slot: number, pose: string, hat?: string}} [crew]
 * @property {React.ReactNode} [pills]     StatePill(s), count chips
 * @property {React.ReactNode} [actions]   Buttons, SegmentedControl, search trigger
 * @property {'lg'|'md'|'sm'} [size]        84 comfortable, 72 tool pages, 64 compact
 */
```

Variants: `lg` (84, padding 0 28, gap 20, `type.page-title`), `md` (72, padding 0 24, gap 16), `sm` (64, padding 0 24, gap 16, title `type.section-title`, subtitle inline).

Content: title one line, ellipsis. Subtitle one line. Themed copy allowed in the subtitle only ("Captain's log: ...").

ARIA: `header` element; the title is the page's only `h1`.

---

## 4. StatePill

**Status** Decided (canvas 2.4, labels from 02-domain.md), Proposed (icons for starting, idle, reviewed, ended; count chip merge). **Screens** Home, HomeCompact, Focus, Team, Failures, ResearchReview, Palette.

Purpose: the literal, always-present statement of a session's state. The primary carrier of state; color and crew pose are backups.

Anatomy: inline-flex, `gap 6`, `[icon or live dot] [label]`.

```js
/**
 * @typedef {'starting'|'running'|'needs_approval'|'asked_you'|'done'|'stale'|'idle'|'reviewed'|'crashed'|'ended'} SessionState
 * @typedef {Object} StatePillProps
 * @property {SessionState|'draft'} state
 * @property {string} [label]        Override, still literal: "2 of 4 need you", "Needs approval · 3m", "Done · to review"
 * @property {'research'} [role]     Running research shows the compass icon instead of the dot
 * @property {'pill'|'text'|'dot'|'count'} [variant]
 * @property {Object} [params]       ICU params for the label: { n }, { duration }, { code }
 */
```

Variants:

- `pill` (cards, headers): padding `4px 10px` (`component.pill.*`), `radius.pill`, `type.pill`, fg on `state.<s>.bg`, icon `size.icon.sm`.
- `text` (quiet cards, task rows, lists): no fill, `type.pill` in `state.<s>.fg`, icon kept (Proposed: the canvas dropped it; keep it so state is never color-only).
- `dot` (compact card header): 8px dot + 11px/600 label; the dot breathes only for running.
- `count` (Home header chips "3 need you", "4 running", "1 to review"): padding `4px 10px`, `type.body-sm` 600, icons bell, play (filled), check. Clicking a count chip filters or opens the relevant view (behaviour owned by the screen spec).

States: static (not interactive) except `count`, which is a button: hover `bg.hover` over its tint, focus ring.

Tokens: `state.*.fg|bg`, `component.pill.*`, `size.dot.md`, `.motion-breathe`.

ARIA: plain text; icon `aria-hidden`. The live dot is `aria-hidden`. Do not put the pill in a live region; AppShell announces changes.

Content: labels come from i18n keys with params, never concatenated. Never themed.

---

## 5. TierBadge

**Status** Decided (canvas 2.5), Proposed (sizes collapsed to two). **Screens** Home, HomeCompact, Approvals, Focus PromptBar, Settings.

```js
/**
 * @typedef {Object} TierBadgeProps
 * @property {'safe'|'caution'|'destructive'|'question'} tier
 * @property {string} [detail]    Appended after " · ": "TEST", "2", "+1"
 * @property {'sm'|'md'} [size]   sm: mini chip; md: section header with icon
 * @property {'filled'|'outline'} [appearance]
 */
```

Variants: `sm` (padding `2px 6px`, `radius.xs`, `type.badge`, no icon); `md` (padding `4px 10px`, `radius.sm`, 12px/700, icon `size.icon.xs`: shield, triangle-alert, octagon-alert, message-circle-question). `outline` = `tier.<t>.border` 1px, no fill (team card CAUTION). Settings rule rows use `sm` with a fixed 64px width, text centred.

Tokens: `tier.*`, `type.badge`, `component.badge.*`.

Content: label word from i18n in sentence case ("Safe"), uppercased by CSS. Always the word, never only the color.

---

## 6. Button

**Status** Decided (canvas 2.6 variants), Proposed (sizes collapsed, all interaction states). **Screens** all.

```js
/**
 * @typedef {Object} ButtonProps
 * @property {'primary'|'secondary'|'ghost'|'amber'|'amber-outline'|'safe-outline'|'teal-outline'|'purple'|'danger'|'danger-confirm'} [variant]
 * @property {'xs'|'sm'|'md'|'lg'|'xl'|'hero'} [size]   28, 32, 36, 40, 44, 48
 * @property {string} [icon]          lucide name, leading
 * @property {string} [kbd]           Trailing Kbd ("Alt N")
 * @property {boolean} [iconOnly]     Requires ariaLabel; square
 * @property {string} [ariaLabel]
 * @property {boolean} [disabled]
 * @property {string} [disabledReason] Rendered visibly next to or inside the button ("needs hooks")
 * @property {boolean} [loading]
 * @property {boolean} [pressed]      Toggle buttons only (aria-pressed)
 * @property {'button'|'submit'} [type]
 * @property {(e: Event) => void} [onClick]
 */
```

Sizes: `xs` 28 (padding 0 10, `radius.sm`, 12px), `sm` 32 (0 12, `radius.sm`, 13px), `md` 36 (0 14, `radius.md`, 13px), `lg` 40 (0 16, `radius.md`, 14px), `xl` 44 (0 18, `radius.lg`, 14px), `hero` 48 (0 22, `radius.lg`, 16px, HomeCalm only). Label weight 600 on filled variants, 400 on outlines. Icon 16 (14 at xs), gap 8.

Variants (fill / text / border):

| Variant | Default | Hover | Pressed | Use |
|---|---|---|---|---|
| `primary` | `brand.accent` / `text.on-primary` | `brand.accent-hover` | `brand.accent-press` + translateY 1px | The one main action per region |
| `secondary` (outline) | transparent / `text.default` / `border.strong` | `bg.hover` | `bg.press` | Neutral actions (Cancel, Edit first, Open plan) |
| `ghost` | transparent / `text.default` / `border.default` | `bg.hover` | `bg.press` | Low-emphasis actions in cards (Open, Nudge, Copy) |
| `amber` | `component.button.amber-bg` / `text.on-amber` | `amber-bg-hover` | `amber-bg-press` | Answering a request: Allow once (caution), Reply, Review 2 |
| `amber-outline` | transparent / `tier.caution.fg` / `tier.caution.border` | `bg.hover` | `bg.press` | Deny on caution, Retry now |
| `safe-outline` | transparent / `tier.safe.fg` / `tier.safe.border` | `bg.hover` | `bg.press` | Allow once on Safe rows, Allow both Safe once |
| `teal-outline` | transparent / `text.link` / `brand.accent-border` | `bg.hover` | `brand.accent-tint` | Launch as session, Research this; `pressed` = `brand.accent-tint` fill (toggle "Whole map") |
| `purple` | `component.button.purple-bg` / `text.on-purple` | `purple-bg-hover` | `purple-bg-press` | Review changes |
| `danger` (outline) | transparent / `state.crashed.fg` / `state.crashed.border` | `color.red.900` fill | same + 1px | Stop…, Stop run…, Discard, destructive Deny |
| `danger-confirm` (filled) | `component.button.danger-bg` / `text.on-danger` | `danger-bg-hover` | `danger-bg-press` | Stop and summarize; destructive Allow once after its checkbox |

Disabled: `primary` uses `component.button.primary-bg-disabled` + `text.on-primary-disabled`; `danger-confirm` uses `danger-bg-disabled` + `text.on-danger-disabled`; outlines drop to `text.muted` with `border.default`. Always show `disabledReason` as visible text (the canvas put it in the label: "Set sail (needs hooks)").

Loading (Proposed): leading icon swaps to `loader-circle` (spins at 1s linear; static under reduced motion), label stays, `aria-busy="true"`, clicks ignored.

Keyboard and ARIA: native `<button>`. Icon-only buttons (Close ×, zoom, send) need `aria-label` and are at least 36 x 36. Toggle buttons use `aria-pressed`. A destructive-confirm button is never the default (Enter) button of a form.

Content: verb first, sentence case, no trailing period. Ellipsis "…" when a confirm step follows. Plain verbs on state-changing buttons (see design-system 12.3 for the Open themed-button question).

---

## 7. Kbd

**Status** Decided (canvas 2.7), Proposed (display rules from keyboard.md). **Screens** Home, Palette, Focus, ResearchForm, MeetingLive, Approvals footer.

```js
/**
 * @typedef {Object} KbdProps
 * @property {string[]} keys          ['Alt', 'K'], rendered "Alt K"
 * @property {'chip'|'bare'|'on-primary'} [variant]
 */
```

Variants: `chip` (padding `2px 6px`, `radius.xs`, `component.kbd.bg`, `component.kbd.fg`, `type.kbd`); `bare` (no fill, inherits color, used inside buttons and list rows); `on-primary` (fill `overlay.on-primary-kbd`).

Rules: keys joined with a space, never "+" (keyboard.md 4). Show a Kbd only where the action has a shortcut. Render as `<kbd>`; screen readers read it inline, so the parent's accessible name should not also spell the shortcut. Not interactive, no states.

---

## 8. SegmentedControl

**Status** Decided (canvas 2.8), Proposed (states). **Screens** Home (density).

```js
/**
 * @typedef {Object} SegmentedControlProps
 * @property {string} label                      "Density"
 * @property {{value: string, label: string}[]} options
 * @property {string} value
 * @property {(v: string) => void} onChange
 * @property {'md'|'sm'} [size]                  md: 28 segments; sm: 28 at 12px (compact header)
 */
```

Anatomy: container padding 4, `radius.md`, `bg.surface`, `border.default`; segments `size.control.xs`, `radius.sm`, padding 0 10.

States: off `text.muted`; hover `bg.hover`, `text.default`; on `bg.control`, `text.strong`, weight 600 (the bg change alone is only 1.4:1, so the label change is required); focus ring inset.

Keyboard and ARIA: `role="radiogroup"` with `aria-label`, segments `role="radio"` + `aria-checked` (Proposed; the canvas used `aria-pressed` buttons, which also works but radiogroup gives arrow-key semantics). Arrow keys move and select; Tab enters and leaves the group.

---

## 9. Tabs

**Status** Decided (canvas 2.9), Proposed (states). **Screens** Focus details (Changes, Facts, Memory), Memory views (Graph, Browse by MOC, Captures, Misses).

```js
/**
 * @typedef {Object} TabItem
 * @property {string} id
 * @property {string} label
 * @property {number} [count]
 * @property {'default'|'teal'|'amber'} [countTone]   amber badge for Misses
 * @typedef {Object} TabsProps
 * @property {string} label          aria-label of the tablist
 * @property {TabItem[]} items
 * @property {string} selected
 * @property {(id: string) => void} onSelect
 */
```

Anatomy: tab `size.control.sm`, padding 0 12, `radius.sm`, `type.body-sm`; count text follows the label (`text.muted`, `text.link` for teal, amber pill badge for Misses).

States: unselected `text.muted`; hover `bg.hover` + `text.default`; selected `bg.control` + `text.strong` 600; focus ring inset; disabled (tab data unavailable, for example Memory when vault-mcp is down) `text.muted` at 60% with the reason in the panel.

Keyboard and ARIA: WAI-ARIA tabs pattern: `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`; Left and Right move, Home and End jump, automatic activation. Panels `role="tabpanel"`. Counts are part of the tab's accessible name ("Misses, 3").

---

## 10. SessionCard

**Status** Decided (canvas 2.10, HomeCompact card), Proposed (states the canvas did not draw). **Screens** Home, HomeCompact, Failures.

Purpose: one live session (or one team run) on the Home grid: who, what, state, and the one thing you can do right now.

Anatomy (comfortable): `article` (padding 20, gap 12, `radius.2xl`, `bg.surface`, border `state.<s>.border`) with header `[CrewAvatar md] [title + mono "repo · branch"] [StatePill]`, a body that depends on the variant, and an optional footer pinned to the bottom (`margin-top: auto`).

```js
/**
 * @typedef {'solo-running'|'approval'|'question'|'research'|'team'|'done'|'crashed'|'stale'} SessionCardVariant
 * @typedef {Object} SessionCardProps
 * @property {SessionCardVariant} variant
 * @property {'comfortable'|'compact'} [density]
 * @property {Object} session          Session view model (02-domain.md 2.2), escaped strings
 * @property {{seed: string, slot: number, hat?: string}} crew
 * @property {{icon: string, text: string, tone: string}[]} [steps]   Last 3 tool steps
 * @property {Object} [request]        Open request (permission or question), see RequestRow
 * @property {Object} [team]           { members, requests, phases, next, tasksDone, tasksTotal, gate, elapsed }
 * @property {Object} [research]       { notes, stats, latestClaim, progress, preset }
 * @property {{path: string, adds: number, dels: number}[]} [files]
 * @property {() => void} onOpen       Opens Focus (or Team for a run)
 */
```

Variants (body):

- `solo-running`: step list (TerminalTail `steps` variant), "now" line (`type.body`), eyebrow "Changed files", FileRow chips, footer meta ("14m · 31 tool calls") + optional "learned 1 thing" NoteChip (teal).
- `approval`: steps, now line, amber request box (`color.amber.900`, `radius.lg`, padding 12): TierBadge + "Wants to run", command (`type.mono-md`, `text.strong`), rule suggestion link, Deny (`amber-outline`) + Allow once (`amber`). Card border amber + `.motion-pulse`.
- `question`: steps, note line, question box (`text.on-amber-tint`, `type.body`), reply row (TextInput + `amber` Reply). Pulse.
- `research`: border `1px dashed brand.accent`; intro + NoteChips, 3 StatTiles, "Latest claim checked" well, ProgressBar footer.
- `team`: CrewTile row, amber request box listing each request (TierBadge sm outline + mono line) + "Review N", PhaseBar (card size), "Next:" line, footer "Tasks 5/9 · Gate 1 passed · 1h 12m". Takes the most urgent teammate state (02-domain.md 3).
- `done`: steps in green, now line, FileRow chips, footer "Finished 6 min ago" + `purple` Review changes. Border `state.done.border`.
- `crashed`: error excerpt (TerminalTail `error`), consequence hint (Banner `hint`), actions mapped from the known error (Failures board). Border `state.crashed.border`.
- `stale` on the main grid (Failures specimen): body sentence + Open terminal (`primary`), Nudge (send Enter), Stop…

Compact density: header strip (padding 8 12, `border.default` bottom) with CrewAvatar sm, repo 600 13px, branch mono 11px, StatePill `dot`; body TerminalTail `tail` (12 lines, 10 with an action strip); optional action strip (`color.amber.900`, padding 6 12): TierBadge sm on `color.amber.800`, one-line ask, ghost + filled `xs` buttons. `radius.lg`.

States:

- Default as above.
- Hover (Proposed): border lightens one step (`border.strong` for neutral borders; state borders unchanged), cursor pointer on the card header only.
- Focus-visible: the card is not one big button (it contains buttons and inputs). The header title is the link to Focus; its focus ring is drawn around the whole card with `:has(.card-link:focus-visible)` (Proposed).
- Active (pressed title link): `bg.press` on the header.
- Loading (first paint, deckd reconnecting): SkeletonCard in the same grid cell.
- Error (session data failed to load): DegradedCard content inside the card shell (Proposed).
- Empty: not applicable; an empty grid is HomeCalm.
- Arriving (new session): fade in 200ms; reorder uses FLIP (design-system 10.4).

Tokens: `bg.surface`, `bg.canvas` (wells), `state.*`, `radius.2xl`, `component.card.*`, `.motion-pulse`.

Keyboard and ARIA: `article aria-labelledby` the title. Order inside: title link, request actions, other actions. Inline Allow once / Deny must answer the exact request id shown (race: if the request expired, the button disables with "Answered in the terminal").

Content: title 1 line; "repo · branch" 1 line; now line max 2 lines (line clamp); question max 3 lines then "Open to read all"; steps 3 lines, each 1 line with ellipsis; file chips wrap to max 2 rows then "+N more".

---

## 11. QuietCard

**Status** Decided (canvas 2.11). **Screens** Home quiet row (176px).

```js
/**
 * @typedef {Object} QuietCardProps
 * @property {'stale'|'idle'|'reviewed'} state
 * @property {Object} session
 * @property {{seed: string, slot: number}} crew
 * @property {string} line          One sentence ("Adrift since 17:40: no commits and no file changes in its worktree.")
 * @property {{label: string, onClick: () => void, variant?: string}[]} actions
 */
```

Anatomy: padding 14 16, gap 10, `radius.xl`, `bg.sidebar`, border `state.<s>.border` (stale) else `border.default`; header CrewAvatar sm, title (14/600) + mono repo · branch, StatePill `text`; line `type.body-sm` `text.secondary`, 2 lines max; actions `ghost` `xs`.

States: idle and reviewed at opacity .85 (Decided) except on hover or focus-within, where they return to 1 (Proposed). Hover and focus as SessionCard.

---

## 12. FileRow

**Status** Decided (canvas 2.12). **Screens** Home cards (chip), Focus Changes tab (row).

```js
/**
 * @typedef {Object} FileRowProps
 * @property {string} path
 * @property {number} adds
 * @property {number} dels
 * @property {'chip'|'row'} variant
 * @property {boolean} [selected]
 * @property {() => void} [onSelect]
 */
```

Variants: `chip` (inline-flex, padding `4px 8px`, `radius.sm`, `bg.raised`, `type.mono`); `row` (flex, padding `8px 10px`, `radius.sm`, path grows, counts right).

States: hover `bg.hover`; selected (row) `bg.selected` + `shadow.ring-selected`; focus ring (inset for rows).

Content: path is the file name in chips and the repo-relative path in rows; middle-truncate long paths (`src/…/damage.rs`) keeping the file name (Proposed). Counts `+N` in `text.diff-add`, `−N` (U+2212) in `text.diff-del`; omit zero on chips, show `−0` in rows (canvas). The sign characters are part of the text, so meaning never depends on color.

ARIA: chips are links (open diff); rows are `role="option"` inside a `listbox` labelled "Changed files", or buttons in a list (Proposed: listbox, arrow keys move the diff).

---

## 13. CrewTile

**Status** Decided (canvas 2.13). **Screens** Home team card, CrewSheet.

```js
/**
 * @typedef {Object} CrewTileProps
 * @property {{seed: string, color: string, hat?: string}} crew
 * @property {'running'|'needs'|'idle'|'done'|'crashed'|'none'} pose
 * @property {string} label        "task 4 · needs you" (literal)
 * @property {boolean} [needsYou]  Amber tile
 * @property {() => void} [onClick] Opens Focus for that teammate
 */
```

Anatomy: column, gap 4, padding 8 6 6, `radius.lg`, CrewAvatar md with team hat, label `type.meta` (12px; the canvas used 11px, raised for legibility, Proposed). Normal: `bg.canvas`. Needs you: `color.amber.900` + `shadow.ring-needs`, label 600 `state.needs-approval.fg`.

States: hover `bg.hover`; focus ring; the tile is a button when `onClick` is set.

ARIA: accessible name is the label ("teammate task 4, needs you"); the avatar is `aria-hidden`.

---

## 14. TerminalView (live xterm)

**Status** Decided (live terminal, input lock "last keystroke wins"), Proposed (theme, options, a11y). **Screens** Focus.

```js
/**
 * @typedef {Object} TerminalViewProps
 * @property {string} ptyId
 * @property {string} label              "rustot · combat-tick"
 * @property {boolean} readOnly          true for observed sessions (no PTY input)
 * @property {boolean} [screenReaderMode] From Settings, Appearance
 * @property {(from: 'browser') => void} [onInput]
 */
```

Anatomy: `section aria-label="Terminal, {label}"`, `bg.sunken`, padding 18 22, xterm instance filling it. Optional header banner is the terminal's own output, not deck chrome.

xterm options (Proposed): `fontFamily` from `font.family.mono`, `fontSize: 14`, `lineHeight: 1.2`, `cursorBlink: !reducedMotion`, `theme` from `component.terminal.*`, `allowProposedApi: false`, `scrollback: 5000`, `screenReaderMode` from props, `customGlyphs: true` (box drawing stays connected).

States:

- Focused: section `:focus-within` shows the focus ring inset; the Focus header shows "Alt Esc to leave the terminal".
- Read-only (observed session): no cursor, a Banner above ("Observed session: started as plain claude, read-only here") and input disabled (Proposed copy).
- Disconnected: output frozen, Banner `connection` above, input disabled.
- Loading: skeleton lines until the first PTY frame.
- Ended: final output stays; StatePill in the header says Ended or Crashed.

Keyboard: global chords from keyboard.md are intercepted with `attachCustomKeyEventHandler`; everything else goes to the PTY, including Tab. No other component may steal keys while it has focus.

Content: the PTY stream is rendered by xterm (canvas/WebGL renderer), which never interprets HTML. Link detection (`@xterm/addon-web-links`) opens links only after a confirm for non-localhost URLs (Proposed).

## 15. TerminalTail (read-only tail)

**Status** Decided (canvas 2.14 line model and colors), Proposed (collapsed styles). **Screens** Home cards (steps), HomeCompact (tail), Team (crew terminals), Failures (error excerpt).

```js
/**
 * @typedef {Object} TailLine
 * @property {string} text
 * @property {'prompt'|'tool'|'prose'|'success'|'waiting'|'memory'|'error'|'stale'|'reviewed'} tone
 * @property {string} [glyph]   "●", "⎿", "✓", "✗", "?", ">", "$"
 * @typedef {Object} TerminalTailProps
 * @property {TailLine[]} lines
 * @property {'steps'|'tail'|'crew'|'error'} variant
 * @property {number} [maxLines]    steps 3, tail 12 (10 with an action strip), crew 12
 * @property {boolean} [pinHead]    Keep a leading ">" prompt line on top (compact algorithm, canvas 3.2)
 */
```

Variants: `steps` (padding 10 12, `radius.md`, `bg.canvas`, gap 6, glyph column + text); `tail` (bottom-aligned, `bg.canvas`, `type.mono`, newest line at the bottom); `crew` (inside a Team crew terminal article, `bg.sunken`); `error` (`bg.sunken`, `radius.md`, `text.on-red-tint`).

All variants: `type.mono` (12 / 1.6), `white-space: pre`, one line per entry with ellipsis, colors from `component.log.<tone>`.

ARIA: `role="log"` only on Team crew terminals, and with `aria-live="off"` (updates are too frequent; AppShell announces what matters). Others are plain regions. Glyphs are text, so "✓ 18 tests added" reads naturally.

Content: text nodes only (ANSI stripped server-side into tones). Never render raw terminal escape sequences.

---

## 16. PhaseBar

**Status** Decided (canvas 2.15), Proposed (gate states beyond passed and pending). **Screens** Home team card (`card`), Team header (`timeline`).

```js
/**
 * @typedef {Object} Phase
 * @property {string} name            "Build"
 * @property {string} [sub]           "tasks 3 to 7 · 1 done, 2 need you, 1 running"
 * @property {'done'|'active'|'pending'} status
 * @property {{done: number, active: number, total: number}} [segments]   For the split fill
 * @typedef {Object} Gate
 * @property {string} name            "Gate 1"
 * @property {'passed'|'pending'|'failed'|'checking'} status
 * @property {string} [detail]        Tooltip / sr text
 * @typedef {Object} PhaseBarProps
 * @property {Phase[]} phases
 * @property {Gate[]} [gates]         Between phases (timeline only)
 * @property {'card'|'timeline'} variant
 */
```

Anatomy: phases share width; bar `size.bar.sm` (card) or `size.bar.md` (timeline), `radius.pill`. Done fill `state.running.fg`; active `brand.accent` (split: done green, active teal, rest `bg.control`); pending `bg.control`. Gate lane `layout.gate-lane` (104) with a 14 x 14 diamond (rotated square, `radius.xs`, 2px border, `0 0 0 3px bg.canvas` halo) and a 12/600 label.

Gate states: passed (fill and border `state.running.fg`, label green); pending (transparent, `border.strong`, `text.muted`); checking (Proposed: pending look + `loader-circle` 12px next to the label, "Gate 2 · checking"); failed (Proposed: `state.crashed` fill and label "Gate 2 failed").

ARIA: `ol aria-label="Phases"`; each phase `li` with text "Build, active: tasks 3 to 7 ..."; gates are list items too ("Gate 1 passed"). The bars are `aria-hidden`.

Content: ranges use "to", never a dash.

---

## 17. ProgressBar

**Status** Decided (canvas 2.16). **Screens** Home research card.

```js
/**
 * @typedef {Object} ProgressBarProps
 * @property {number} value          0..100
 * @property {string} label          "Scouting · drafting the note"
 * @property {string} [meta]         "3 scouts · Standard"
 * @property {boolean} [indeterminate]
 */
```

Anatomy: label row (`type.meta`, `text.muted`, space-between), track `size.bar.sm` `bg.control` `radius.pill`, fill `brand.accent`. Width transitions 280ms. Indeterminate (Proposed): a 30% segment sliding (loop-alert, linear); reduced motion shows a static 30% fill plus the text "in progress".

ARIA: `role="progressbar"`, `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuetext="62%, drafting the note"`.

---

## 18. StatTile

**Status** Decided (canvas 2.17). **Screens** Home research card.

```js
/** @typedef {Object} StatTileProps @property {number} value @property {string} label */
```

Anatomy: flex 1, padding 10 12, `radius.md`, `bg.canvas`; number `type.dialog-title` with `tabular-nums`, label `type.meta` `text.muted`. Not interactive. Render as `dl`/`dt`/`dd` pairs in a group of tiles (Proposed). Numbers formatted with `Intl.NumberFormat`.

---

## 19. Eyebrow

**Status** Decided (canvas 2.18), Proposed (single size). **Screens** everywhere.

```js
/** @typedef {Object} EyebrowProps @property {string} children @property {'h2'|'h3'|'p'} [as] @property {string} [tone] */
```

`type.eyebrow` (12/600, 0.06em, uppercase via CSS), `text.muted` by default; palette group headers use `tone` (the group's color token). When it titles a region, render it as the right heading level (`as="h2"`), not a styled `div`.

---

## 20. ListRow

**Status** Decided (canvas 2.19), Proposed (states). **Screens** Focus session list, Meetings list, Settings nav, Palette results.

```js
/**
 * @typedef {Object} ListRowProps
 * @property {React.ReactNode} [leading]   CrewAvatar sm or glyph tile (27, radius.sm, bg.control, text.link)
 * @property {string} title
 * @property {React.ReactNode} [subtitle]  State text (StatePill text variant), meta, or search hit with <mark>
 * @property {React.ReactNode} [trailing]  Kbd, time
 * @property {boolean} [selected]
 * @property {'link'|'option'|'tab'} role
 * @property {string} [href]
 */
```

Anatomy: padding 8 (Focus, Palette) to 12 (Meetings, Settings), `radius.md`, gap 10, title `type.label`, subtitle `type.meta`.

States: default transparent; hover `bg.hover`; selected `bg.selected` + `shadow.ring-selected` + `aria-current` / `aria-selected`; focus ring inset; disabled (Proposed) `text.muted`, no hover. Collapsed variant (Focus list under 1440): leading + trailing only, 72px wide, title in a tooltip and in `aria-label`.

Content: title one line; hit snippets keep 1 line with `…` on both sides; `mark` uses `bg.mark` + `text.on-teal-tint`, `radius.xs`, padding 0 2.

---

## 21. NoteChip

**Status** Decided (canvas 2.20). **Screens** Home research card, Memory note panel, ResearchReview draft.

```js
/**
 * @typedef {Object} NoteChipProps
 * @property {string} title       "locks-redis" (the wikilink target, escaped)
 * @property {string} domain      Drives the dot color from domain.*
 * @property {'chip'|'inline'} [variant]
 * @property {string} href
 */
```

Variants: `chip` (padding `4px 10px`, `radius.pill`, `bg.raised`, `type.body-sm`, 8px dot); `inline` inside prose (padding 0 6, 6px dot, no wrap). "learned 1 thing" is a `chip` with `brand.accent-tint` + `text.link` and a `book-open` icon.

States: hover `bg.control`; focus ring; missing target (Proposed): dashed `border.strong`, `text.muted`, title "Not in your vault yet".

ARIA: link; the dot is `aria-hidden`; name is the note title.

---

## 22. Citation

**Status** Decided (canvas 2.21). **Screens** Memory ask, MeetingLive ask, Focus related memory, ResearchForm (info callout lives in Banner).

```js
/**
 * @typedef {Object} CitationProps
 * @property {string} path         "nestjs/bullmq-worker.md"
 * @property {number} [line]
 * @property {boolean} [viaGraph]  Appends " · via graph"
 * @property {string} [title]      Callout variant: first line
 * @property {'source'|'callout'|'superscript'} [variant]
 * @property {string} href
 */
```

Variants: `source` (flex, padding 8 10, `radius.md`, `brand.accent-tint`, `text.on-teal-tint`, `type.mono`, 8px teal dot, text `path:line`); `callout` (title line + mono `path:line` in `text.link`); `superscript` (`[1]` in `text.link`, in draft prose).

States: hover `color.teal.700` fill (Proposed); focus ring.

ARIA: link named "Source: nestjs/bullmq-worker.md line 13"; superscripts name "Source 1".

---

## 23. AskThread

**Status** Decided (canvas 2.22), Proposed (loading, streaming, error). **Screens** Memory ask panel, MeetingLive ask panel.

```js
/**
 * @typedef {Object} AskMessageView
 * @property {'user'|'assistant'} role
 * @property {string} text                     Markdown for assistant (sanitised), plain for user
 * @property {{path: string, line?: number, viaGraph?: boolean}[]} [citations]
 * @property {string|null} [generalKnowledge]
 * @property {boolean} [isMiss]
 * @typedef {Object} AskThreadProps
 * @property {string} title
 * @property {AskMessageView[]} messages
 * @property {'idle'|'thinking'|'streaming'|'error'} status
 * @property {string} placeholder             "Ask a follow-up"
 * @property {(text: string) => void} onAsk
 * @property {{label: string, onClick: () => void}[]} [answerActions]  "Save answer to meeting note", "Copy"
 */
```

Anatomy: eyebrow + title + History / New thread (`ghost xs`); message list (gap 16); user bubble (`bg.control`, `radius.bubble`, max `layout.chat-bubble-max`, right-aligned); answer (`type.body` 1.5, citations below); miss card (`color.amber.900`, title `text.on-amber-tint` 600, line `text.on-amber-tint-secondary`, `amber` "Research this"); general-knowledge card (dashed `border.strong`, eyebrow "General knowledge · not from your vault", `text.secondary`); composer (TextInput xl + icon-only send `primary` 44).

States: thinking (Proposed: three dots "Searching your vault…" as text, `aria-busy`); streaming (text appends; caret none); error (inline Banner `error` with Retry, message kept in the composer); empty thread (Proposed: eyebrow "Thread" + one line "Ask anything about your vault. Answers cite the note and line."). Composer disabled while `thinking` only if the backend cannot queue (Open for the backend).

ARIA: message list `role="log"` `aria-live="polite"` that announces only completed assistant answers (not each streamed token). Send button `aria-label="Send"`; Enter sends, Shift Enter new line.

Content: user text as text nodes; assistant markdown sanitised (no raw HTML, links rel="noopener", code blocks `bg.sunken`). The general-knowledge block is always visually separate from vault answers (Decided).

---

## 24. Banner

**Status** Decided (canvas 2.23), Proposed (merged variants). **Screens** Failures, MeetingLive, Team, Focus, HomeCompact, ResearchForm.

```js
/**
 * @typedef {Object} BannerProps
 * @property {'connection'|'recording'|'gate'|'hint'|'info'|'error'|'approval'|'strip'} variant
 * @property {string} [icon]
 * @property {React.ReactNode} children
 * @property {React.ReactNode} [actions]
 * @property {boolean} [live]     role="status" (connection, recording start/stop)
 */
```

| Variant | Colors | Layout | Use |
|---|---|---|---|
| `connection` | `color.amber.900`, `text.on-amber-tint`, `wifi-off` in amber | full width, padding 12 16 | deckd lost |
| `recording` | `color.red.900`, `text.on-red-tint`, bottom border `color.red.700` | 40px bar | MeetingLive |
| `gate` | `color.green.900`, `text.on-green-tint` | boxed, `radius.lg` | Team gate summary |
| `hint` | `color.amber.900`, `text.on-amber-tint`, bold lead in amber | boxed, `radius.md` | Crash consequence |
| `info` | `brand.accent-tint`, `text.on-teal-tint`, `book-open` | boxed, `radius.md` | ResearchForm existing notes |
| `error` | `color.red.900`, `text.on-red-tint` | boxed | Inline errors (Proposed) |
| `approval` | `color.amber.900` top border `color.amber.750` | full width, padding 10 24 | Focus PromptBar container |
| `strip` | `color.amber.900` | padding 6 12 | HomeCompact action strip |

ARIA: `connection` and `recording` are `role="status"`; the rest are static. The recording timer inside is `aria-hidden` for live purposes (a static "Recording, started 14:02" is exposed instead).

Content: error pattern from design-system 12.4.

---

## 25. Field (TextInput, Textarea, Radio, Checkbox, Select)

**Status** Decided (canvas 2.24 shapes), Proposed (border color, all states, error). **Screens** Home reply, Approvals reply, Meetings search, Ask composers, ResearchForm, Settings, Palette input.

```js
/**
 * @typedef {Object} FieldProps
 * @property {string} label                 Visible, or sr-only when visuallyHiddenLabel
 * @property {boolean} [visuallyHiddenLabel]
 * @property {string} [hint]                "optional", helper text below
 * @property {string} [error]               Message; sets aria-invalid
 * @property {'sm'|'md'|'lg'|'xl'} [size]   32, 36, 40, 44
 * @property {boolean} [disabled]
 * @property {boolean} [readOnly]
 * @typedef {FieldProps & {value: string, placeholder?: string, onChange: Function}} TextInputProps
 * @typedef {FieldProps & {rows?: number}} TextareaProps
 * @typedef {FieldProps & {options: {value: string, label: string, sub?: string}[], value: string}} RadioGroupProps
 * @typedef {FieldProps & {checked: boolean, tone?: 'teal'|'danger'}} CheckboxProps
 * @typedef {FieldProps & {options: {value: string, label: string}[], value: string}} SelectProps
 */
```

Shared anatomy: label `type.label` above (gap 8), hint `type.meta` `text.muted`, control `bg.canvas` (inside cards and drawers too; the drawer's `bg.surface` input goes to `bg.canvas`), `border.field` 1px, `radius.md` (`radius.lg` at xl), padding 0 12, `type.body` (13px at sm).

States:

- Default: border `border.field`, text `text.default`, placeholder `text.muted`.
- Hover (Proposed): border `color.fog.500`.
- Focus: border 2px `border.field-focus`, text `text.strong` (canvas ResearchForm Topic). Fields show this instead of the outline ring (the thicker teal border is the ring; padding compensates by 1px so text does not shift).
- Disabled: `bg.surface`, `text.muted`, border `border.default`.
- Read-only: no border change, `text.secondary`.
- Error (Proposed): border `state.crashed.fg`, message below in `text.on-red-tint` with `x` icon, `aria-invalid="true"`, `aria-describedby` the message.

Radio card (ResearchForm depth): `label` card padding 12, `radius.lg`; unselected `bg.canvas` + `border.strong`; selected `brand.accent-tint` + 2px `brand.accent`; native radio with `accent-color: var(--brand-accent)`. Group is a `fieldset` + `legend`; arrow keys move.

Checkbox: native, 16 x 16, `accent-color` teal (or `state.crashed.fg` for the destructive confirm). Label clickable; wraps.

Select: native `<select>` styled like TextInput with a `chevron-down` icon (Proposed), so keyboard and screen readers get native behaviour.

Palette input: borderless variant inside the palette header, 18px, `text.strong`.

Content: placeholder is an example or hint, never the label ("Reply to discord-audit" is the sr-only label, the placeholder can repeat it).

---

## 26. Dialog

**Status** Decided (canvas 2.25), Proposed (behaviour, motion). **Screens** ResearchForm, confirm dialogs (Stop…, Revoke…, Discard), Customize crew.

```js
/**
 * @typedef {Object} DialogProps
 * @property {boolean} open
 * @property {string} title
 * @property {string} [description]
 * @property {'form'|'confirm'} [variant]   form: 700 wide, radius.3xl, padding 32; confirm: 480 wide (Proposed), radius.2xl, padding 24
 * @property {React.ReactNode} children
 * @property {React.ReactNode} footer       Buttons, right-aligned: secondary then primary
 * @property {() => void} onClose
 * @property {string} [initialFocus]        Selector; default first field or the safest button
 */
```

Anatomy: scrim `overlay.scrim` full viewport; panel `bg.raised`, `border.strong`, `shadow.dialog`, centred horizontally, top 110 (form) or vertically centred (confirm).

States: opening 200ms enter (fade + 8px rise), closing 160ms exit; submitting (primary `loading`, fields read-only); error (Banner `error` at the top of the body, focus moves to it).

Keyboard and ARIA: native `<dialog>` with `showModal()` (gives focus trap and inert background) or `role="dialog"` + `aria-modal="true"`; `aria-labelledby` title, `aria-describedby` description. Esc closes (Cancel semantics). Focus returns to the trigger. Confirm dialogs for destructive actions focus Cancel first.

Content: title states the action ("Stop rustot · combat-tick?"); body says the consequence literally ("The process gets SIGINT. Uncommitted changes stay in the worktree."). Themed copy only in form dialog titles ("Send out scouts").

---

## 27. Drawer

**Status** Decided (canvas 2.26), Proposed (motion, behaviour). **Screens** Approvals ("Needs you"); Focus details panel under 1440.

```js
/**
 * @typedef {Object} DrawerProps
 * @property {boolean} open
 * @property {string} title
 * @property {React.ReactNode} [subtitle]   "4 requests from 3 ships · oldest waiting 9 min"
 * @property {React.ReactNode} children
 * @property {React.ReactNode} [footer]     Keyboard hints, rules location
 * @property {'md'|'sm'} [width]            600 or 440
 * @property {() => void} onClose
 */
```

Anatomy: scrim; panel right, full height, `bg.surface`, left border `border.strong`, `shadow.drawer`; header padding 24 24 16 with title `type.dialog-title`, subtitle `type.body-sm` muted, close icon button 36; body scrolls (padding 20 24, section gap 24); footer padding 14 24, `type.meta` muted, top border.

Motion: open 280ms slide + 200ms scrim; close 200ms; reduced motion fades.

Keyboard and ARIA: `role="dialog"` `aria-modal="true"` `aria-labelledby`; focus trap; initial focus on the first request's primary action; Esc closes; Up and Down move between requests (keyboard.md 3). Opening from a filtered entry point ("Review 2" on a team card) scrolls to and focuses that team's first request.

Empty (Proposed): "Nothing needs you." + muted line "New requests show up here and on the Sessions grid." Loading: RequestRow skeletons.

---

## 28. RequestRow

**Status** Decided (canvas 2.27 tiers and rules), Proposed (states). **Screens** Approvals drawer; the same model drives SessionCard request boxes and compact strips.

```js
/**
 * @typedef {Object} RequestRowProps
 * @property {Object} request          02-domain.md 2.3; summary and why are escaped strings
 * @property {{seed: string, slot: number, hat?: string}} crew
 * @property {string} source           "rustot · combat-tick · waiting 3m"
 * @property {() => void} onAllow
 * @property {() => void} onDeny
 * @property {(text: string) => void} [onReply]     question kind
 * @property {boolean} [focused]       Target of Alt A / Alt D
 */
```

Variants by tier:

- `safe`: compact row (padding 12, `radius.lg`, `bg.canvas`), CrewAvatar sm (needs pose), command `type.mono-md` `text.strong`, source `type.meta` muted, Deny (`secondary xs`) + Allow once (`safe-outline xs`). Batchable ("Allow both Safe once" lives in the section header) and rule-suggestible.
- `caution`: card (padding 14, border `color.amber.750`), same content, actions right: Deny (`amber-outline sm`) + Allow once (`amber sm`). Never batched.
- `question`: card, question `type.body`, reply row (TextInput md + `amber` Reply).
- `destructive`: card with `state.crashed.border`, confirm Checkbox (`tone="danger"`, label names the consequence: "I checked the 3 commits that will be overwritten"), Deny (`danger sm`) + Allow once (`danger-confirm sm`, disabled until checked). No keyboard shortcut approves it (keyboard.md 3).

States: focused (keyboard target) `shadow.ring-selected` + `bg.selected`; answering (buttons `loading`); answered (row collapses with a 160ms fade, a Toast "Allowed cargo test in rustot" with Undo is not offered because the PTY already received the key (Proposed: no undo)); expired ("Answered in the terminal", muted, auto-removed after 4s); error (inline `error` Banner "Could not reach the session. Answer in the terminal." with Retry).

ARIA: each request is a `group` labelled by its command; the drawer's sections are headed by TierBadges rendered as `h3`.

Content: command one line with horizontal scroll inside a `code` element when longer (no ellipsis: hiding part of a command you approve is unsafe) (Proposed). Why-line max 2 lines.

---

## 29. Palette

**Status** Decided (canvas 3.4), Proposed (states, motion). **Screens** global (Alt K).

```js
/**
 * @typedef {Object} PaletteItem
 * @property {string} id
 * @property {string} title
 * @property {string} [subtitle]
 * @property {React.ReactNode} [leading]    CrewAvatar sm or glyph tile
 * @property {string[]} [kbd]
 * @property {() => void} run
 * @property {() => void} [openInFocus]
 * @typedef {Object} PaletteGroup
 * @property {'needs'|'sessions'|'actions'|'memory'} id   Urgency order (Decided)
 * @property {string} title
 * @property {PaletteItem[]} items
 * @typedef {Object} PaletteProps
 * @property {boolean} open
 * @property {string} query
 * @property {PaletteGroup[]} groups
 * @property {(q: string) => void} onQuery
 * @property {() => void} onClose
 */
```

Anatomy: Dialog shell (700 wide, top 150, `radius.2xl`, no padding); input row (padding 16 18, search icon, borderless Field, right hint "? ask · > run"); results (padding 8, gap 2, max height 60vh, scroll); group headers Eyebrow in group tone (needs amber, sessions green, actions teal, memory purple); rows ListRow (`option`); footer hints (`type.meta`, gap 20).

States: empty query (recent items + needs-you); no results (Proposed: "No matches. Press Enter to ask your vault" when the query is not a command); loading memory results (a muted "Searching notes…" row, other groups render immediately); prefix modes `?` (ask) and `>` (run) change the hint and the group list.

Keyboard and ARIA: combobox pattern: input `role="combobox"` `aria-expanded` `aria-controls` the `listbox`, `aria-activedescendant` the highlighted option. Up and Down (and Alt J / Alt K while open) move; Enter runs; Alt Enter opens in Focus; Esc closes. Result count announced politely ("7 results").

---

## 30. SkeletonCard

**Status** Decided (canvas 2.29), Proposed (colors). **Screens** Failures (deckd lost), any loading grid.

```js
/** @typedef {Object} SkeletonCardProps @property {'session'|'row'|'panel'} [shape] */
```

Anatomy (session): padding 14, gap 10, `radius.lg`, `bg.surface`; block 30 x 30 `radius.sm` + line 12 high; lines 10 high at 80% and 55%. Blocks use `.motion-shimmer` (`bg.skeleton` to `bg.skeleton-highlight`).

ARIA: the containing region has `aria-busy="true"` and an `.sr-only` "Loading sessions"; skeleton blocks are `aria-hidden`. Reduced motion: static blocks.

---

## 31. DegradedCard

**Status** Decided (canvas 2.30). **Screens** Failures specimens; in production it replaces a tab's content when its backend is down (Memory when vault-mcp is down, Meetings when scribed is down).

```js
/**
 * @typedef {Object} DegradedCardProps
 * @property {string} area          "Memory tab" (uppercased by Eyebrow)
 * @property {string} title         Themed allowed: "The charts are out of reach"
 * @property {string} body          Literal cause + what still works
 * @property {string} [command]     Mono line: "scribe daemon"
 * @property {{label: string, onClick: () => void}} fix     Primary: "Start scribed"
 * @property {() => void} onRetry
 */
```

Anatomy: padding 20, gap 12, `radius.2xl`, `bg.surface`, `border.default`; Eyebrow, title `type.section-title` (18, was 17), body `type.body-sm` `text.secondary`, command well (`bg.sunken`, `radius.sm`, `type.mono`, copy button on hover and focus (Proposed)), actions `primary sm` + `secondary sm` Retry.

States: retrying (Retry `loading`); recovered (card is replaced by content with a 160ms fade and a polite announcement "Memory is back").

---

## 32. KnowledgeGraph

**Status** Decided (canvas 2.31 and 3.9 layouts and styling), Proposed (interaction states, keyboard access). **Screens** Memory (clusters), MemoryNote (local).

```js
/**
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} label
 * @property {string} domain
 * @property {0|1|2} kind          0 note, 1 MOC, 2 index
 * @property {boolean} [cited]
 * @property {boolean} [fresh]     New note: " · new" suffix + arrive
 * @typedef {Object} KnowledgeGraphProps
 * @property {GraphNode[]} nodes
 * @property {[string, string][]} edges
 * @property {'clusters'|'local'} layout
 * @property {string} [selectedId]
 * @property {(id: string) => void} onSelect
 */
```

Anatomy: `section aria-label="Knowledge graph"`, `bg.sunken`; nodes as absolutely positioned buttons (dot sized 24 index, 18 MOC or selected, 12 leaf; label below); edges 1px (2px when both ends lit) `component.graph.edge` or `edge-lit`, opacities per canvas 2.31; cluster labels (`letter-spacing.cluster`, uppercase, domain color at 60%); hop rings in local layout (dashed `border.default`); zoom controls bottom right (icon buttons 36: Zoom in, Zoom out, Fit); hint text bottom left; legend in the filter bar.

States: node hover (Proposed): label shows even for leaves, connected edges lift to full opacity; node focus-visible: ring around the dot, same reveal as hover; selected: `shadow.glow-cited`, label `text.on-teal-tint`; cited: same glow; fresh: `.motion-arrive` until seen (design-system 10.3); loading: skeleton of cluster labels + "Loading the graph"; error: DegradedCard; empty vault (Proposed): "No notes yet. Captures and research land here."

Keyboard and ARIA (Proposed): the graph is a visual aid; the accessible equivalent is the "Browse by MOC" tab, linked from an `.sr-only` note at the top of the graph ("A list view of the same notes is in Browse by MOC"). Nodes are still focusable buttons in a roving tabindex: Tab enters the graph on the selected or index node, arrow keys move to the nearest node in that direction, Enter opens the note (local layout + note panel), Esc returns to the whole map. `+`, `-`, `0` zoom in, out and fit when the graph has focus.

Content: labels are note titles as text nodes; long titles truncate at 24 characters with `…` and full text in the accessible name.

---

## 33. PinnedMoment

**Status** Decided (canvas 2.32). **Screens** Meetings detail, MeetingLive pins list.

```js
/** @typedef {Object} PinnedMomentProps @property {string} offset "18:11" @property {string} [speaker] @property {string} text @property {'quote'|'pin'} variant @property {() => void} [onJump] */
```

Anatomy: padding 12 14 (quote) or 10 12 (pin), `radius.lg` / `radius.md`, `bg.surface` / `bg.canvas`, left border 3px `brand.accent`; offset `type.mono` `text.link` + speaker; text `type.body` 1.5, in quotes for `quote`. `lang="pt-BR"` on the text. Clicking jumps the transcript (button, focus ring).

---

## 34. TranscriptLine

**Status** Decided (canvas 2.33). **Screens** MeetingLive (live), Meetings (search hits).

```js
/**
 * @typedef {Object} TranscriptLineProps
 * @property {string} offset                 "18:42" (MM:SS, tabular-nums)
 * @property {'self'|'room'} speaker        Label from i18n: "Você", "Sala" (meeting content language)
 * @property {string} text
 * @property {boolean} [pinned]
 * @property {boolean} [partial]             In-progress line
 * @property {{start: number, end: number}[]} [hits]   Search highlight ranges
 * @property {'live'|'hit'} variant
 */
```

Anatomy: flex gap 14, padding 8 12, `radius.md`, left border 3px (transparent, or `brand.accent` when pinned); offset `type.mono` muted, width 44; speaker 12/600, width 44, `text.link` for self, `state.done.fg` for room; text `type.prose` (16/1.65) in `live`, `type.body` in `hit`. Pinned: `brand.accent-tint` bg. Partial: `text.muted`, italic. Hits: `mark` (see ListRow).

ARIA: the live transcript container is `role="log"` with `aria-live="off"` by default and a toggle "Read new lines aloud" (Proposed), because a meeting's own audio already carries the content. Each line has `lang="pt-BR"`.

Content: text nodes only; highlights are built by splitting the string at hit ranges into text and `mark` nodes, never by injecting HTML.

---

## 35. ActionItemCard

**Status** Decided (canvas 2.34), "Launch as session" from meetings is Open (Q6) (design supports it). **Screens** Meetings detail, HomeCalm last meeting.

```js
/** @typedef {Object} ActionItemCardProps @property {string} text @property {string} [owner] @property {'card'|'row'} variant @property {() => void} onLaunch @property {{label: string, onClick: () => void}} [secondary] "Dismiss" or "Research first" */
```

Variants: `card` (padding 14, gap 10, `radius.xl`, `bg.surface`, `border.default`; text `type.body` 600 1.4; owner `type.meta`; `primary sm` "Launch as session" + `ghost sm` secondary); `row` (HomeCalm: padding 10 12, `radius.lg`, `bg.canvas`, `teal-outline xs`).

States: launched (Proposed: button replaced by a link "Session started · Open" in `text.link`); dismissed (fades out 160ms; a Toast offers Undo for 6s).

Content: text is PT-BR meeting content (`lang="pt-BR"`), max 3 lines; buttons are chrome (DECK_LANG).

---

## 36. ChecklistRow

**Status** Decided (canvas 2.35). **Screens** FirstRun, Settings, Connections.

```js
/**
 * @typedef {Object} ChecklistRowProps
 * @property {'ok'|'bad'|'warn'|'todo'|'checking'} status
 * @property {string} title
 * @property {string} detail
 * @property {boolean} [optional]      Title suffix "(optional)"
 * @property {{label: string, onClick: () => void, variant: string}} [action]
 */
```

Anatomy: flex gap 16, padding 16 18, `radius.xl`, `bg.surface`, border per status (ok `border.default`, bad `state.crashed.border`, warn `color.amber.750`, todo `border.default`); status circle 30 (`radius.round`): ok `tier.safe.bg` + check, bad `tier.destructive.bg` + x, warn `tier.caution.bg` + "!", todo `bg.raised` + "?" in `text.secondary`, checking (Proposed) `bg.raised` + `loader-circle`; title `type.card-title`, detail `type.body-sm` muted; action `md` button.

ARIA: list of `li`; the status glyph has an `.sr-only` word ("Passed", "Failed", "Warning", "Not checked", "Checking"). "Check again" re-runs all and announces the summary politely ("5 of 6 checks passed").

---

## 37. RuleRow

**Status** Decided (canvas 2.36). **Screens** Settings, Approval rules.

```js
/** @typedef {Object} RuleRowProps @property {'safe'|'caution'} tier @property {string} pattern "Bash(cargo test:*)" @property {string} source "from 5 approvals · 26 Sep" @property {() => void} onRevoke */
```

Anatomy: repo section (`radius.xl`, `bg.surface`, `border.default`, header with CrewAvatar sm pose none, repo 15/600, mono path, count right) containing rows: gap 14, padding 12 16, bottom border `border.subtle`; TierBadge sm (64 wide), pattern `type.mono-md` `text.strong` (grows), source `type.meta` muted, `secondary xs` "Revoke…".

States: hover row `bg.hover`; revoking (confirm Dialog, then row fades 160ms); manual rule (source "added by hand"); error writing the settings file (inline Banner `error` under the section with the path).

---

## 38. TaskRow

**Status** Decided (canvas 2.37). **Screens** Team.

```js
/**
 * @typedef {Object} TaskRowProps
 * @property {string} taskId           "T5" (display "5" on the canvas; show the fleetmates id)
 * @property {string} title
 * @property {string} sub               "waiting on your approval (npm test, Safe)"
 * @property {SessionState|'pending'} state
 * @property {{seed: string, color: string}} [crew]
 * @property {boolean} [later]          Later-phase row (dashed, no fill)
 * @property {() => void} [onOpen]
 */
```

Anatomy: flex gap 14, padding 14, `radius.xl`, `bg.surface`, border `border.default` (needs you: `state.needs-approval.border`); id `type.mono` muted width 24; title `type.label` + sub `type.meta`; CrewAvatar sm with team hat; StatePill `text` right aligned, width 104. Later rows: dashed `border.default`, transparent, `text.muted`.

States: hover `bg.hover`; focus ring; the row is a link to the teammate in Focus.

---

## 39. SourceCard

**Status** Decided (canvas 2.38), Proposed (rejected marker). **Screens** ResearchReview.

```js
/**
 * @typedef {Object} SourceCardProps
 * @property {number|null} n            null for rejected sources
 * @property {string} title
 * @property {string} url
 * @property {string} why
 * @property {string} backs
 * @property {boolean} kept
 * @property {boolean} [rejectedByScout]
 * @property {(kept: boolean) => void} onToggle
 */
```

Anatomy: `label` card, gap 12, padding 12, `radius.lg`; kept: `bg.canvas` + `border.default`; unchecked or rejected: opacity .6. Checkbox 16 (teal); title 600 with `[n]` in `text.link` (rejected: a "Rejected" TierBadge-style muted label instead of the canvas dash glyph); URL `type.mono` muted, middle-truncated; "Why:" and "Backs:" lines `type.body-sm`, backs in `text.on-teal-tint` when kept, `text.muted` when not.

States: unchecking highlights every citing sentence in the draft (Decided behaviour): those sentences get `color.amber.900` background and a `[n]` in amber; hover `bg.hover`; focus ring on the checkbox.

---

## 40. DiffView

**Status** Decided (canvas 2.39), Proposed (split view, states). **Screens** Focus details (Changes tab), review flows.

```js
/**
 * @typedef {Object} DiffLine
 * @property {'hunk'|'context'|'add'|'del'} kind
 * @property {string} text
 * @property {number} [oldNo]
 * @property {number} [newNo]
 * @typedef {Object} DiffViewProps
 * @property {string} path
 * @property {DiffLine[]} lines
 * @property {'unified'|'split'} [mode]   unified when the panel is under 720px (Decided: "unified (panel is narrow)")
 */
```

Anatomy: `bg.sunken`, `radius.md`, padding 10 0, `type.mono`; caption muted; lines padding 0 12, `white-space: pre`, horizontal scroll per block; hunk `text.muted`; context `text.default`; add `text.diff-add` on `tier.safe.bg` with a `+` prefix; del `text.diff-del` on `tier.destructive.bg` with `-` prefix. Line numbers (Proposed) `text.muted`, `aria-hidden`.

States: loading (skeleton lines); binary or too large ("Binary file, 2.1 MB. Open in editor."); empty ("No changes in this file.").

ARIA: `figure` with `figcaption` path; each line's prefix character stays in the text so the change type is spoken ("plus pub fn melee_damage"). Optionally an `.sr-only` "added" / "removed" before each changed line (Proposed).

---

## 41. PromptBar

**Status** Decided (Focus approval bar mirrors the Claude Code permission prompt, same keys), Proposed (states). **Screens** Focus (bottom of the terminal column).

Purpose: a browser-side mirror of the Claude Code permission prompt currently on the PTY screen, so approving never depends on reading the TUI.

```js
/**
 * @typedef {Object} PromptBarProps
 * @property {Object} request                  permission request; options parsed from the PTY
 * @property {{key: string, label: string}[]} options   Exactly as Claude Code printed them ("1 Yes", "2 Yes, and don't ask again for ...", "3 No, and tell Claude what to do differently")
 * @property {'safe'|'caution'|'destructive'} tier
 * @property {(key: string) => void} onChoose  Sends the key to the PTY
 */
```

Anatomy: Banner `approval` (full width, padding 10 24, `color.amber.900`, top border `color.amber.750`): TierBadge sm + detail, one-line note "Same prompt as the terminal, same keys", then one button per option with a bare Kbd showing its number: option 1 `amber sm`, others `amber-outline sm`. Labels may be shortened for width but keep the verb and the scope ("2 Yes, don't ask again for cargo test here").

Destructive tier: option 1 is `danger-confirm` and stays disabled until a confirm Checkbox in the bar is ticked; key "1" does nothing until then (keyboard.md 3).

States: sending (chosen button `loading`, others disabled); answered elsewhere (bar collapses; polite "Answered in the terminal"); stale parse (options changed on screen: bar re-renders; if parsing fails, the bar shows "Answer in the terminal" and no buttons, rather than guessing).

Keyboard and ARIA: `role="group"` `aria-label="Permission prompt: Bash command cargo test --release combat::"`; keys 1, 2, 3 work when no terminal has focus (when the terminal has focus they go to Claude Code directly, which is the same result).

---

## 42. CalmSection

**Status** Decided (canvas 2.41). **Screens** HomeCalm.

```js
/** @typedef {Object} CalmSectionProps @property {string} title @property {React.ReactNode} children */
```

Anatomy: padding 24, gap 16, `radius.3xl`, `bg.surface`, `border.default`; title `type.panel-title` as `h2`. Children: open-loop link rows (padding 12, `radius.lg`, `color.purple.900` for review or `bg.raised` for PR; CrewAvatar sm done; trailing action text in `state.done.fg` or `text.link`), capture links (padding 12, `radius.lg`, `bg.canvas`, domain dot + title 600, meta), ActionItemCard `row`.

States: empty per section (Proposed): "No open loops.", "Nothing new in your vault today.", "No meetings today." in `text.muted`. The page-level rule: HomeCalm only when nothing is running and nothing is adrift (Decided).

---

## 43. TagChip

**Status** Decided (canvas 2.42). **Screens** Memory note panel.

```js
/** @typedef {Object} TagChipProps @property {string} label @property {'tag'|'property'} kind @property {string} [href] */
```

`tag`: `color.blue.900` + `text.on-blue-tint`; `property`: `bg.raised` + `text.secondary`. Padding `4px 8px`, `radius.sm`, `type.meta`. Tags are links to a filtered Browse view (hover `bg.control`, focus ring); properties are static text.

---

## 44. BacklinkRow

**Status** Decided (canvas 2.43). **Screens** Memory note panel (Backlinks, Links out).

```js
/** @typedef {Object} BacklinkRowProps @property {string} title @property {string} [kind] "MOC" @property {string} domain @property {string} href */
```

Anatomy: link, padding 8 10, `radius.md`, `bg.raised`, `text.link`, no underline; domain dot 8 leading (Proposed, matches NoteChip). Hover `bg.control` + `text.link-hover`; focus ring. Lists are `ul` under an Eyebrow with the count ("Backlinks · 3").

---

## 45. Icon

**Status** Proposed (lucide, design-system 9). **Screens** all.

```js
/**
 * @typedef {Object} IconProps
 * @property {string} name              lucide name ("bell")
 * @property {'xs'|'sm'|'md'|'lg'} [size]   12, 14, 16, 20
 * @property {number} [strokeWidth]     2 default, 1.75 in the Rail
 * @property {string} [label]           When set: role="img" + aria-label; otherwise aria-hidden
 * @property {boolean} [filled]         fill="currentColor" (play)
 */
```

Rules: color is `currentColor`; never use an icon as the only content of a control without `aria-label` on the control; import icons individually for tree shaking; the anchor logo is a separate `LogoMark` component.

---

## 46. CrewAvatar

**Status** Decided (canvas 4.1), Proposed (SVG rendering, sizes, hats, fixes). Full spec in [crew.md](crew.md). **Screens** nearly all.

```js
/**
 * @typedef {Object} CrewAvatarProps
 * @property {string} seed
 * @property {string} color              Resolved body color (slot, teammate shade or research)
 * @property {'running'|'needs'|'idle'|'done'|'crashed'|'none'} pose
 * @property {'none'|'cap'|'bandana'} [hat]
 * @property {string} [hatColor]         Team teal or the body's dark shade
 * @property {'sm'|'md'|'lg'|'xl'} [size]   27, 36, 45, 72
 * @property {string} [label]            When set: role="img" + aria-label; otherwise aria-hidden (default)
 */
```

No interactive states; no animation. Memoised by `(seed, color, pose, hat, hatColor)`.

---

## 47. Toast

**Status** Proposed (not on the canvas; needed for in-browser notifications and undo). **Screens** global.

Purpose: short, non-blocking confirmation or in-browser notification. Requests still live in the drawer and on cards; a toast only points at them.

```js
/**
 * @typedef {Object} ToastProps
 * @property {'info'|'success'|'needs'|'error'} tone
 * @property {string} title              "rustot needs approval"
 * @property {string} [body]             "cargo test --release combat::"
 * @property {{seed: string, color: string, pose: string}} [crew]
 * @property {{label: string, onClick: () => void}} [action]   "Open", "Undo"
 * @property {number|null} [duration]    ms; null = stays until dismissed
 * @property {() => void} onDismiss
 */
```

Anatomy: stack bottom right, 16 from the edges, gap 8, max 3 visible (older collapse into "+N more"); toast width 360, padding 12 14, `radius.xl`, `bg.raised`, `border.strong`, `shadow.toast`, left accent bar 3px in the tone color (`state.needs-approval.fg`, `state.running.fg`, `state.crashed.fg`, or `brand.accent` for info); icon + title `type.label`, body `type.meta` (commands in `type.mono`), action `ghost xs`, close icon button 28 (`x`, `aria-label="Dismiss"`).

Behaviour: info and success dismiss after 6s; `needs` and `error` stay until dismissed or the underlying request is answered. Timers pause on hover and on focus within the stack (WCAG 2.2.1). A needs toast is not shown while the Needs-you drawer is open. Clicking the toast body does the same as its action.

Motion: in 200ms enter (fade + 12px from the right), out 160ms exit; reduced motion fades only.

ARIA: rendered inside AppShell's polite live region (`role="status"`), so text is announced once; never `role="alert"`. Toasts are reachable by keyboard: Alt U opens the drawer instead of tabbing into toasts, and the stack is after main content in tab order.

Content: title literal ("rustot needs approval", never themed); body escaped text, one line with ellipsis.

---

## 48. Coverage

| Canvas catalogue (inventory section 2) | Component here |
|---|---|
| 2.1 App shell | AppShell |
| 2.2 Rail | Rail |
| 2.3 Page header bar | PageHeader |
| 2.4 State pill, header count chips | StatePill (`count` variant merged in) |
| 2.5 Risk tier badge | TierBadge |
| 2.6 Buttons (incl. swatch radio, recent harbor chip, search trigger) | Button; swatch radio is a RadioGroup variant in the Customize dialog (Proposed: `Field` radio with a 28px round swatch); recent harbor chip and search trigger are `secondary` Buttons with a leading CrewAvatar sm / search icon and trailing Kbd |
| 2.7 kbd | Kbd |
| 2.8 Segmented control | SegmentedControl |
| 2.9 Tabs | Tabs |
| 2.10 Session card; HomeCompact card | SessionCard (`density`) |
| 2.11 Quiet session card | QuietCard |
| 2.12 Changed-file chip / row | FileRow |
| 2.13 Crew tile | CrewTile |
| 2.14 Terminal / tool log | TerminalView (live), TerminalTail (read-only) |
| 2.15 Phase bar and gates | PhaseBar |
| 2.16 Progress bar | ProgressBar |
| 2.17 Stat tile | StatTile |
| 2.18 Section label | Eyebrow |
| 2.19 Selected list row | ListRow |
| 2.20 Note link chip | NoteChip |
| 2.21 Citation, memory callout | Citation; ResearchForm info callout moved to Banner `info` |
| 2.22 Chat thread | AskThread |
| 2.23 Banners and status bars | Banner |
| 2.24 Form fields | Field |
| 2.25 Modal dialog + scrim | Dialog (Palette reuses its shell) |
| 2.26 Drawer | Drawer |
| 2.27 Approval request row | RequestRow |
| 2.28 Command palette | Palette |
| 2.29 Skeleton card | SkeletonCard |
| 2.30 Degraded-service card | DegradedCard |
| 2.31 Knowledge graph | KnowledgeGraph |
| 2.32 Quote / pinned moment | PinnedMoment |
| 2.33 Transcript line, search hit row | TranscriptLine |
| 2.34 Action item card | ActionItemCard |
| 2.35 Checklist row | ChecklistRow |
| 2.36 Rule row and repo section | RuleRow |
| 2.37 Task row | TaskRow |
| 2.38 Source card | SourceCard |
| 2.39 Diff view | DiffView |
| 2.40 Permission prompt replica | PromptBar (the replica inside the terminal is the real TUI in xterm; the bar is the mirror) |
| 2.41 HomeCalm cards | CalmSection |
| 2.42 Tag chip | TagChip |
| 2.43 Backlink row | BacklinkRow |
| 2.44 Icons | Icon (+ LogoMark) |
| 4.1 Crew | CrewAvatar |
| (none) | Toast (Proposed), Tooltip (used by Rail and collapsed ListRow; native `title` is not keyboard accessible: show on hover and focus after 400ms, `role="tooltip"`, `aria-describedby`) |
