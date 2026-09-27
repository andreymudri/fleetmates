# fleetmates deck: design system

Foundations for porting the canvas boards to React. Read with [tokens.json](tokens.json) (source of truth for values), [tokens.css](tokens.css) (generated CSS), [components.md](components.md) (one spec per component) and [crew.md](crew.md) (pixel crew).

Status labels, as in every deck doc (see [../02-domain.md](../02-domain.md)):

- **Decided**: chosen by the owner, or drawn on the canvas and reviewed.
- **Proposed**: this handoff's recommendation. Safe to build; flag in review.
- **Open**: needs an owner decision. Collected in section 15.

Scope: the design system only. Product behaviour (what a button does, which states exist) comes from the other deck docs; this file only decides how things look, move, read and announce themselves.

## 1. Principles

1. **Facts are literal, flavor is optional.** Status, numbers, errors and buttons that change state say exactly what is true. The nautical voice lives in headlines and subtitles (Decided: "theme the flavor, never the facts").
2. **Urgency is loud, everything else is quiet.** Amber is reserved for "needs you"; it is the only hue that pulses. Calm states recede (quiet row, lower contrast borders).
3. **Never one signal.** Every state is carried by at least two of: text label, icon, color, position. Color and crew pose are always the backup, never the carrier.
4. **Dense but legible.** 1920 x 1080 shows six live sessions at once; nothing is smaller than 11px, and every text pair clears WCAG AA.
5. **One dark theme.** A single fixed Tokyo Night style palette (Decided). No light mode, no theme switching, no following the desktop theme.

## 2. Token architecture and naming

### 2.1 Tiers (Proposed structure, Decided values unless marked)

| Tier | JSON groups | Example | Who may use it |
|---|---|---|---|
| Primitive | `color.*`, `crew.slot.*` | `color.teal.500` | Only semantic and component tokens |
| Semantic | `bg`, `text`, `border`, `brand`, `focus`, `state`, `tier`, `domain`, `overlay`, `shadow`, `space`, `radius`, `size`, `font`, `type`, `motion`, `z`, `layout`, `breakpoint`, `crew` (except slots) | `state.needs-approval.fg` | Components |
| Component | `component.*` | `component.button.primary-bg-hover` | That component only |

Rules:

- Components never use primitives or raw hex values. A lint rule (Stylelint `declaration-strict-value` on `color`, `background`, `border-color`, `box-shadow`, `fill`, `stroke`) enforces it (Proposed).
- A component token exists only when a semantic token cannot express the value (hover and pressed fills, the xterm theme, log line colors, graph edges).
- Since the theme is fixed and single (Decided), the semantic layer is not a theming seam; it exists so names say intent and so collapses like section 14 stay one-line changes.

### 2.2 Naming (Proposed)

- JSON path: `{group}.{concept}.{variant}` in kebab-case segments: `state.needs-approval.bg`, `text.on-amber-tint`, `motion.duration.loop-ambient`.
- CSS custom property: the path joined with `-`: `--state-needs-approval-bg`, `--motion-duration-loop-ambient`.
- Spacing tokens are named by their pixel value (`--space-12` is 12px) because a 2px-based scale with 18 steps has no natural t-shirt names. Radii, font sizes and control heights use t-shirt names (`--radius-md`, `--font-size-sm`, `--size-control-lg`).
- Session state tokens use the `SessionState` enum from 02-domain.md with `_` replaced by `-` (`needs_approval` becomes `needs-approval`).
- React components: PascalCase (`StatePill`); props camelCase (`needsCount`); CSS classes kebab-case, scoped per component with CSS Modules (`StatePill.module.css`) (Proposed).
- Icons: `icon-{lucide-name}` in code, for example `<Icon name="bell" />`.

### 2.3 How tokens reach the code

`tokens.css` is generated from `tokens.json` by [tools/build-tokens.mjs](tools/build-tokens.mjs), which also writes the WCAG contrast table [contrast.md](contrast.md) from [tools/contrast-pairs.json](tools/contrast-pairs.json) (87 pairs, 0 failing). Run `node docs/deck/design/tools/build-tokens.mjs docs/deck/design` after any token change. The script (resolve `{refs}` into `var(--...)`, emit composite typography as `font` shorthands and shadows as `box-shadow` lists). The utilities after the `:root` block (focus ring, `.sr-only`, keyframes, reduced motion) are hand-written and live in the same file. Style Dictionary v4 reads DTCG natively and is an acceptable replacement for the script (Proposed). JavaScript that needs a value (xterm theme, graph layout, crew colors) imports `tokens.json` and resolves references once at startup, never reads computed styles.

Each token in `tokens.json` carries `$extensions.deck.status` where it differs from Decided, and `$extensions.deck.was` with the canvas value it replaced.

## 3. Color

### 3.1 Surfaces (Decided values, collapse Proposed)

| Token | Value | Use |
|---|---|---|
| `bg.sunken` | `#0f1016` | Terminals, code, diff, graph canvas, rail |
| `bg.canvas` | `#15161e` | Page, inner wells inside cards (step lists, stat tiles, request rows) |
| `bg.sidebar` | `#181922` | Secondary sidebars (Focus list, Meetings list, Settings nav), quiet cards |
| `bg.surface` | `#1b1c26` | Cards, drawers, right panels |
| `bg.raised` | `#22243a` | Dialogs, palette, chips, selected rows, skeleton base |
| `bg.control` | `#2b2f45` | Selected tab or segment, kbd, tracks, user chat bubble, skeleton highlight |
| `bg.hover` / `bg.press` | `rgba(200,208,240,.06)` / `.10` | State layers laid over any surface (Proposed) |

Elevation is expressed by lighter surfaces. Shadows exist only on overlays (dialog, drawer, toast).

### 3.2 Text

| Token | Value | Use |
|---|---|---|
| `text.strong` | `#e6e9f7` | Commands, focused input text, emphasis |
| `text.default` | `#c8d0f0` | Body |
| `text.secondary` | `#b4bbdb` | Supporting lines |
| `text.muted` | `#8f96b8` | Meta, subtitles, eyebrows, dim terminal lines. Decided after a contrast fix: it replaced `#6b7294`, which measured about 3.5:1 on the canvas. The terminal dim `#737aa2` is collapsed into it. |
| `text.link` / `text.link-hover` | `#7fe3e3` / `#a6f0f0` | Links, teal emphasis |
| `text.code` | `#7dcfff` | Inline code in prose and answers |
| `text.on-*` | see tokens | Text on fills and tints; always use the pair, never mix a tint with a different text token |

### 3.3 Brand

Sea teal `#3cc8c8` (`brand.accent`, Decided) marks primary actions, the logo, cited notes, active navigation and the team hat. Ink on teal is `#0e2a2b`. Teal is never used for a session state, so "teal" always means "the deck itself" or "your memory".

### 3.4 Session states

One token set per `SessionState` (02-domain.md section 3). Labels are literal and Decided; they are the i18n keys' English values.

| State | Pill label | Icon | fg | bg | Card border | Crew pose |
|---|---|---|---|---|---|---|
| `starting` | Starting | `loader-circle` (Proposed) | `#9ece6a` | `#1f2a1c` | `#2b2f45` | running |
| `running` | Running | live dot (breathe); `compass` for research | `#9ece6a` | `#1f2a1c` (fixed, see 14) | `#2b2f45`; research `1px dashed #3cc8c8` | running |
| `needs_approval` | Needs approval | `bell` | `#e0af68` | `#2c261c` | `#7a6036` | needs |
| `asked_you` | Asked you | `bell` | `#e0af68` | `#2c261c` | `#7a6036` | needs |
| `done` | Done | `check` | `#bb9af7` | `#231f33` | `#5b4a86` | done |
| `stale` | No activity {n}m | `waves` | `#d6a86a` | `#2c261c` | `#4d3f28` | idle |
| `idle` | Idle {duration} | `moon` (Proposed) | `#8f96b8` | `#22243a` | `#2b2f45` | idle |
| `reviewed` | Reviewed | `check-check` (Proposed) | `#bb9af7` | `#231f33` | `#2b2f45` | done |
| `crashed` | Crashed · exit {code} | `x` | `#f7768e` | `#2e1c22` | `#6b2d3a` | crashed |
| `ended` | Ended | `square` (Proposed) | `#8f96b8` | `#22243a` | `#2b2f45` | none |

Aggregate team pill ("2 of 4 need you") takes the colors and icon of the most urgent teammate state, in the order of 02-domain.md section 3. The research draft pill ("Draft · not saved") uses the `state.draft` tokens (purple, `file-pen` icon).

`stale` keeps its own muted amber `#d6a86a` (Proposed) instead of collapsing into `#e0af68`: adrift is worth noticing but is not a request, and the quiet row must not look like it needs an answer.

### 3.5 Risk tiers

| Tier | Label | Icon | fg | bg | border |
|---|---|---|---|---|---|
| `safe` | SAFE | `shield` | `#9ece6a` | `#1f2a1c` | `#3f5a2e` |
| `caution` | CAUTION | `triangle-alert` | `#e0af68` | `#2c261c` | `#7a6036` |
| `destructive` | DESTRUCTIVE | `octagon-alert` | `#f7768e` | `#2e1c22` | `#6b2d3a` |
| `question` (not a tier) | QUESTION | `message-circle-question` | `#e0af68` | `#2c261c` | `#7a6036` |

### 3.6 Data colors

- **Vault domains** (`domain.*`): index `#c8d0f0`, nestjs `#7aa2f7`, docker `#7dcfff`, patterns `#bb9af7`, concorrencia `#ff9e64`, projects `#9ece6a`. Domains not in this list take `crew.slot[fnv1a(domain) % 9]` (Proposed). The same map drives graph nodes, note chips, capture dots and the legend; the canvas HomeCalm capture dots did not match it (frontend green, rust orange): use the domain map everywhere (Proposed).
- **Crew slots**: nine body colors, see [crew.md](crew.md) section 4.
- **Log lines** (`component.log.*`): prompt and edits blue, tool lines muted, prose default, success green, waiting amber, memory teal, errors red, stale muted amber, reviewed purple.

### 3.7 Contrast

Computed by script from the resolved token values (WCAG 2.x relative luminance). Body text needs 4.5:1; large text (18.66px bold or 24px regular and up) and UI graphics (focus ring, field boundaries, progress fill) need 3:1. Every pair the system defines is listed; a pair not in this table is not an approved combination.

| Foreground | Background | Values | Ratio | Need | Result | Used for |
|---|---|---|---|---|---|---|
| `text.strong` | `bg.canvas` | #e6e9f7 on #15161e | 14.90:1 | 4.5:1 body | Pass | Commands, focused input |
| `text.strong` | `bg.surface` | #e6e9f7 on #1b1c26 | 13.99:1 | 4.5:1 body | Pass | Commands in request rows |
| `text.strong` | `bg.raised` | #e6e9f7 on #22243a | 12.57:1 | 4.5:1 body | Pass | Palette input, dialog emphasis |
| `text.strong` | `bg.sunken` | #e6e9f7 on #0f1016 | 15.70:1 | 4.5:1 body | Pass | Terminal bright white |
| `text.default` | `bg.canvas` | #c8d0f0 on #15161e | 11.79:1 | 4.5:1 body | Pass | Body on page |
| `text.default` | `bg.sidebar` | #c8d0f0 on #181922 | 11.44:1 | 4.5:1 body | Pass | Sidebar rows, quiet cards |
| `text.default` | `bg.surface` | #c8d0f0 on #1b1c26 | 11.07:1 | 4.5:1 body | Pass | Body in cards and panels |
| `text.default` | `bg.raised` | #c8d0f0 on #22243a | 9.94:1 | 4.5:1 body | Pass | Chips, dialogs, selected rows |
| `text.default` | `bg.control` | #c8d0f0 on #2b2f45 | 8.61:1 | 4.5:1 body | Pass | User chat bubble, selected tab |
| `text.default` | `bg.sunken` | #c8d0f0 on #0f1016 | 12.42:1 | 4.5:1 body | Pass | Terminal foreground, diff context |
| `text.secondary` | `bg.canvas` | #b4bbdb on #15161e | 9.50:1 | 4.5:1 body | Pass | Secondary lines on page |
| `text.secondary` | `bg.sidebar` | #b4bbdb on #181922 | 9.22:1 | 4.5:1 body | Pass | Quiet card line |
| `text.secondary` | `bg.surface` | #b4bbdb on #1b1c26 | 8.92:1 | 4.5:1 body | Pass | Secondary lines in cards |
| `text.secondary` | `bg.raised` | #b4bbdb on #22243a | 8.01:1 | 4.5:1 body | Pass | Tag property chip |
| `text.secondary` | `bg.control` | #b4bbdb on #2b2f45 | 6.94:1 | 4.5:1 body | Pass | kbd chip |
| `text.secondary` | `bg.sunken` | #b4bbdb on #0f1016 | 10.01:1 | 4.5:1 body | Pass | Frontmatter block |
| `text.muted` | `bg.canvas` | #8f96b8 on #15161e | 6.20:1 | 4.5:1 body | Pass | Meta on page, wells inside cards |
| `text.muted` | `bg.sidebar` | #8f96b8 on #181922 | 6.01:1 | 4.5:1 body | Pass | Meta in sidebars |
| `text.muted` | `bg.surface` | #8f96b8 on #1b1c26 | 5.82:1 | 4.5:1 body | Pass | Meta in cards, eyebrows |
| `text.muted` | `bg.raised` | #8f96b8 on #22243a | 5.23:1 | 4.5:1 body | Pass | Meta in dialogs and palette |
| `text.muted` | `bg.control` | #8f96b8 on #2b2f45 | 4.53:1 | 4.5:1 body | Pass | Muted text on a selected row |
| `text.muted` | `bg.sunken` | #8f96b8 on #0f1016 | 6.53:1 | 4.5:1 body | Pass | Tool lines in terminals and tails |
| `text.link` | `bg.canvas` | #7fe3e3 on #15161e | 12.01:1 | 4.5:1 body | Pass | Links |
| `text.link` | `bg.surface` | #7fe3e3 on #1b1c26 | 11.28:1 | 4.5:1 body | Pass | Links in cards |
| `text.link` | `bg.raised` | #7fe3e3 on #22243a | 10.13:1 | 4.5:1 body | Pass | Backlink rows, glyph tiles |
| `text.link` | `bg.sunken` | #7fe3e3 on #0f1016 | 12.66:1 | 4.5:1 body | Pass | Memory lines in logs |
| `text.link` | `brand.accent-strong-tint` | #7fe3e3 on #1d3a3a | 8.15:1 | 3:1 ui | Pass | Active rail icon |
| `text.link-hover` | `bg.surface` | #a6f0f0 on #1b1c26 | 13.17:1 | 4.5:1 body | Pass | Link hover |
| `text.on-teal-tint` | `brand.accent-tint` | #bdeeee on #16302f | 11.10:1 | 4.5:1 body | Pass | Citations, callouts, search marks |
| `text.link` | `brand.accent-tint` | #7fe3e3 on #16302f | 9.35:1 | 4.5:1 body | Pass | Learned chip, timestamps in callouts |
| `text.on-primary` | `brand.accent` | #0e2a2b on #3cc8c8 | 7.43:1 | 4.5:1 body | Pass | Primary button label |
| `text.on-primary` | `brand.accent-hover` | #0e2a2b on #59d0d0 | 8.20:1 | 4.5:1 body | Pass | Primary button hover |
| `text.on-primary` | `brand.accent-press` | #0e2a2b on #35b0b0 | 5.77:1 | 4.5:1 body | Pass | Primary button pressed |
| `text.on-primary-disabled` | `component.button.primary-bg-disabled` | #9fd6d6 on #1d3a3a | 7.60:1 | 4.5:1 body | Pass | Disabled primary (kept readable, exempt from 1.4.3) |
| `text.on-amber` | `component.button.amber-bg` | #15161e on #e0af68 | 9.01:1 | 4.5:1 body | Pass | Amber filled button, rail count badge |
| `text.on-amber` | `component.button.amber-bg-hover` | #15161e on #e5bb7f | 10.08:1 | 4.5:1 body | Pass | Amber filled hover |
| `text.on-amber` | `component.button.amber-bg-press` | #15161e on #c59a5c | 6.99:1 | 4.5:1 body | Pass | Amber filled pressed |
| `text.on-danger` | `component.button.danger-bg` | #2a0f15 on #f7768e | 6.74:1 | 4.5:1 body | Pass | Danger filled button |
| `text.on-danger` | `component.button.danger-bg-hover` | #2a0f15 on #f88b9f | 7.80:1 | 4.5:1 body | Pass | Danger filled hover |
| `text.on-danger` | `component.button.danger-bg-press` | #2a0f15 on #d9687d | 5.29:1 | 4.5:1 body | Pass | Danger filled pressed |
| `text.on-danger-disabled` | `component.button.danger-bg-disabled` | #c48d98 on #4a2630 | 4.72:1 | 4.5:1 body | Pass | Disabled destructive Allow once |
| `text.on-purple` | `component.button.purple-bg` | #1d1530 on #bb9af7 | 7.55:1 | 4.5:1 body | Pass | Review changes |
| `text.on-purple` | `component.button.purple-bg-hover` | #1d1530 on #c5a9f8 | 8.65:1 | 4.5:1 body | Pass | Review changes hover |
| `state.running.fg` | `state.running.bg` | #9ece6a on #1f2a1c | 8.17:1 | 4.5:1 body | Pass | Running pill (fixed tint) |
| `state.running.fg` | `bg.surface` | #9ece6a on #1b1c26 | 9.26:1 | 4.5:1 body | Pass | Running text state |
| `state.running.fg` | `bg.sunken` | #9ece6a on #0f1016 | 10.39:1 | 4.5:1 body | Pass | Success lines in logs |
| `state.needs-approval.fg` | `state.needs-approval.bg` | #e0af68 on #2c261c | 7.50:1 | 4.5:1 body | Pass | Needs approval and Asked you pills |
| `state.needs-approval.fg` | `bg.surface` | #e0af68 on #1b1c26 | 8.46:1 | 4.5:1 body | Pass | Amber text states |
| `state.needs-approval.fg` | `bg.sunken` | #e0af68 on #0f1016 | 9.49:1 | 4.5:1 body | Pass | Waiting lines in logs |
| `state.done.fg` | `state.done.bg` | #bb9af7 on #231f33 | 6.90:1 | 4.5:1 body | Pass | Done, Reviewed and Draft pills |
| `state.done.fg` | `bg.surface` | #bb9af7 on #1b1c26 | 7.32:1 | 4.5:1 body | Pass | Done text state |
| `state.done.fg` | `bg.sidebar` | #bb9af7 on #181922 | 7.56:1 | 4.5:1 body | Pass | Reviewed on quiet card |
| `state.stale.fg` | `state.stale.bg` | #d6a86a on #2c261c | 6.90:1 | 4.5:1 body | Pass | No activity pill |
| `state.stale.fg` | `bg.sidebar` | #d6a86a on #181922 | 8.05:1 | 4.5:1 body | Pass | No activity on quiet card |
| `state.stale.fg` | `bg.sunken` | #d6a86a on #0f1016 | 8.74:1 | 4.5:1 body | Pass | Stale lines in logs |
| `state.idle.fg` | `state.idle.bg` | #8f96b8 on #22243a | 5.23:1 | 4.5:1 body | Pass | Idle and Ended pills |
| `state.idle.fg` | `bg.sidebar` | #8f96b8 on #181922 | 6.01:1 | 4.5:1 body | Pass | Idle on quiet card |
| `state.crashed.fg` | `state.crashed.bg` | #f7768e on #2e1c22 | 6.08:1 | 4.5:1 body | Pass | Crashed pill, destructive badge |
| `state.crashed.fg` | `bg.surface` | #f7768e on #1b1c26 | 6.40:1 | 4.5:1 body | Pass | Danger ghost button label |
| `state.crashed.fg` | `bg.sunken` | #f7768e on #0f1016 | 7.18:1 | 4.5:1 body | Pass | Error lines, diff deletions on terminal bg |
| `tier.safe.fg` | `tier.safe.bg` | #9ece6a on #1f2a1c | 8.17:1 | 4.5:1 body | Pass | SAFE badge, diff additions on tint |
| `tier.caution.fg` | `color.amber.800` | #e0af68 on #3a3120 | 6.40:1 | 4.5:1 body | Pass | Tier chip on compact action strip |
| `tier.destructive.fg` | `tier.destructive.bg` | #f7768e on #2e1c22 | 6.08:1 | 4.5:1 body | Pass | DESTRUCTIVE badge, diff deletions on tint |
| `text.on-amber-tint` | `color.amber.900` | #f0dcb4 on #2c261c | 11.14:1 | 4.5:1 body | Pass | Question text, banners, miss card title |
| `text.on-amber-tint-secondary` | `color.amber.900` | #e8c690 on #2c261c | 9.22:1 | 4.5:1 body | Pass | Wants to run, rule suggestion link |
| `text.on-green-tint` | `color.green.900` | #b9d98f on #1f2a1c | 9.52:1 | 4.5:1 body | Pass | Gate info banner |
| `text.on-red-tint` | `color.red.900` | #f4b3be on #2e1c22 | 9.22:1 | 4.5:1 body | Pass | Recording label and timer, confirm checkbox label |
| `text.on-red-tint` | `bg.sunken` | #f4b3be on #0f1016 | 10.88:1 | 4.5:1 body | Pass | Error excerpt |
| `text.on-red-tint-secondary` | `color.red.900` | #e7c3ca on #2e1c22 | 10.00:1 | 4.5:1 body | Pass | Recording bar secondary text |
| `text.on-blue-tint` | `color.blue.900` | #9db8f8 on #1f2740 | 7.48:1 | 4.5:1 body | Pass | Tag chip |
| `text.code` | `bg.surface` | #7dcfff on #1b1c26 | 9.87:1 | 4.5:1 body | Pass | Inline code in answers |
| `text.code` | `bg.canvas` | #7dcfff on #15161e | 10.50:1 | 4.5:1 body | Pass | Inline code in Settings intro |
| `component.log.prompt` | `bg.sunken` | #7aa2f7 on #0f1016 | 7.54:1 | 4.5:1 body | Pass | Prompt and edit lines |
| `component.log.prompt` | `bg.canvas` | #7aa2f7 on #15161e | 7.16:1 | 4.5:1 body | Pass | Prompt lines in card step lists |
| `focus.ring` | `bg.canvas` | #7fe3e3 on #15161e | 12.01:1 | 3:1 ui | Pass | Focus ring on page |
| `focus.ring` | `bg.surface` | #7fe3e3 on #1b1c26 | 11.28:1 | 3:1 ui | Pass | Focus ring in cards |
| `focus.ring` | `bg.raised` | #7fe3e3 on #22243a | 10.13:1 | 3:1 ui | Pass | Focus ring in dialogs |
| `focus.ring` | `bg.sunken` | #7fe3e3 on #0f1016 | 12.66:1 | 3:1 ui | Pass | Focus ring on terminals |
| `focus.ring` | `bg.control` | #7fe3e3 on #2b2f45 | 8.78:1 | 3:1 ui | Pass | Focus ring on a selected row |
| `border.field` | `bg.canvas` | #666e94 on #15161e | 3.62:1 | 3:1 ui | Pass | Input boundary on page wells |
| `border.field` | `bg.surface` | #666e94 on #1b1c26 | 3.40:1 | 3:1 ui | Pass | Input boundary in cards and drawers |
| `border.field` | `bg.raised` | #666e94 on #22243a | 3.06:1 | 3:1 ui | Pass | Input boundary in dialogs |
| `border.field-focus` | `bg.canvas` | #3cc8c8 on #15161e | 8.83:1 | 3:1 ui | Pass | Focused input boundary |
| `brand.accent` | `bg.canvas` | #3cc8c8 on #15161e | 8.83:1 | 3:1 ui | Pass | Progress fill, phase bar, cited dot |
| `brand.accent` | `bg.control` | #3cc8c8 on #2b2f45 | 6.45:1 | 3:1 ui | Pass | Progress fill against its track |
| `state.needs-approval.fg` | `bg.canvas` | #e0af68 on #15161e | 9.01:1 | 3:1 ui | Pass | Needs flag pixels, rail badge |
| `text.muted` | `color.amber.900` | #8f96b8 on #2c261c | 5.15:1 | 4.5:1 body | Pass | Muted text on amber tint (avoid if under 4.5) |

87 pairs, 0 failing.

Notes:

- The canvas running pill (`#9ece6a` on `#1e2433`) passed at 8.48:1, but `#1e2433` is a blue-grey that read as "neutral chip". The real green tint `#1f2a1c` keeps 8.17:1 and matches the SAFE badge family.
- Disabled controls are exempt from WCAG 1.4.3, but the deck keeps them readable anyway because a disabled button with a reason ("Set sail (needs hooks)") is information. The disabled destructive label moved from `#b77f8a` (3.98:1) to `#c48d98` (4.72:1).
- Field boundaries: WCAG 1.4.11 needs 3:1 for the visual boundary of an input. The canvas `#2b2f45` and `#3a3f5c` borders measured 1.5 to 1.8:1, so fields get `border.field` `#666e94` (Proposed). Buttons keep their subtle borders because their text label identifies them.
- Decorative borders (card borders, dividers) are exempt and stay subtle; the state they hint at is always carried by a pill.

## 4. Typography

Fonts: **Geist** and **Geist Mono** (Decided), weights 400, 600, 700 (sans) and 400, 600 (mono), self-hosted from the `geist` npm package with `font-display: swap` (Proposed). No CDN and no Google Fonts: the CSP allows `font-src 'self'` only ([08-security.md](../08-security.md)). Base size 14px (Decided); `html { font-size: 14px }`.

### 4.1 Scale

| Style (`type.*`) | Size / weight / line-height / tracking | Use |
|---|---|---|
| `display` | 40 / 600 / 1.3 / -0.02em | HomeCalm headline |
| `welcome` | 34 / 600 / 1.3 / -0.02em | FirstRun welcome |
| `heading-detail` | 28 / 600 / 1.3 / -0.01em | Meeting detail, draft note h2, CrewSheet h1, Settings section h2 |
| `page-title` | 22 / 600 / 1.3 / -0.01em | Page h1 on every screen |
| `dialog-title` | 20 / 600 / 1.3 | Drawer and dialog titles; stat numbers use the same size |
| `section-title` | 18 / 600 / 1.3 | h3 in prose, compact page title, meeting card title, palette input |
| `panel-title` | 16 / 600 / 1.3 | Side panel titles, Focus header title, tier aside |
| `card-title` | 15 / 600 / 1.3 | Session card title, FirstRun check, Settings repo, thread title |
| `prose` | 16 / 400 / 1.65 | Draft note, meeting summary, live transcript |
| `body` | 14 / 400 / 1.5 | Default UI text, card "now" line, question text |
| `body-sm` | 13 / 400 / 1.5 | Secondary lines, buttons up to 36px, banners |
| `label` | 13 / 600 / 1.3 | Form labels, list row titles |
| `meta` | 12 / 400 / 1.5 | Meta lines, helper text, footers |
| `pill` | 12 / 600 / 1.3 | StatePill, text-only states |
| `eyebrow` | 12 / 600 / 1.3 / 0.06em, uppercase, `text.muted` | Section labels ("Changed files", "Related memory") |
| `badge` | 11 / 700 / 1.3 | TierBadge, rail count badge, status glyphs |
| `mono` | Geist Mono 12 / 400 / 1.6 | repo · branch, paths, logs, diff, citations, frontmatter |
| `mono-md` | Geist Mono 13 / 400 / 1.5 | Commands in request rows and rules |
| `kbd` | Geist Mono 11 / 400 | Kbd |
| `terminal` | Geist Mono 14, xterm `lineHeight: 1.2` | TerminalView |

Rules:

- Timers, counters and anything that ticks use `font-variant-numeric: tabular-nums` (recording timer, "waiting 3m", progress percentages).
- Titles truncate to one line with an ellipsis and expose the full text in `title` and to assistive tech (the text node is complete; only CSS clips it).
- Uppercase is applied with `text-transform`, never typed in caps in the source string (screen readers spell some all-caps words letter by letter). The canvas typed "MEMORY TAB" and "SAFE" in caps; the port stores "Memory tab" and "Safe" and uppercases in CSS.
- Weight 700 appears only in `badge`. Weight 500 does not exist.

## 5. Spacing (Proposed)

2px base scale, tokens named by value: `0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72`.

| Context | Tokens |
|---|---|
| Inside pills, chips and badges | 2, 4, 6, 10 |
| Gaps between inline items (icon to label, chips) | 6, 8 |
| Stack gaps inside a card | 10, 12 |
| Card padding | 20 (comfortable), 12 (compact, quiet 14 x 16) |
| Grid gaps between cards | 20 (comfortable), 10 (compact) |
| Page padding | 28 horizontal on shells, 56 on reading pages (ResearchReview, Settings), 72 x 120 on HomeCalm (layout exception) |
| Section gaps on pages | 24, 32, 40 |

Mapping from the canvas: 3 and 5 go to 4; 7 and 9 go to 8; 18 goes to 20 (card padding and grid gap) or 16 (small stacks); 22 goes to 20 or 24; 26 goes to 24 or 28; pill paddings `3px 8px` to `5px 11px` all become `4px 10px`; badge paddings become `2px 6px`.

## 6. Radii (Proposed)

| Token | Value | Use | Absorbs |
|---|---|---|---|
| `radius.xs` | 4 | kbd, mini badges, search mark, diamond | 3, 5 |
| `radius.sm` | 6 | 28 and 32px controls, tag chips, file chips, tabs | 7 |
| `radius.md` | 8 | 36 and 40px controls, inputs, wells, list rows, citations | 9 |
| `radius.lg` | 10 | 44 and 48px controls, rail items, boxes inside cards, compact cards | 11 |
| `radius.xl` | 12 | Quiet cards, sections, task rows | |
| `radius.2xl` | 14 | Session cards, palette, degraded cards | |
| `radius.3xl` | 16 | HomeCalm sections, form dialogs, Customize card | |
| `radius.pill` | 999px | Pills, chips, bars | |
| `radius.round` | 50% | Dots, status circles | |
| `radius.bubble` | 12 12 4 12 | User chat bubble | |

Rule of thumb: control radius follows control height (28 to 32: sm, 36 to 40: md, 44 to 48: lg). A nested box uses a radius at most equal to its parent's minus the padding between them.

## 7. Elevation, overlays and stacking

| Layer | Surface | Shadow | Scrim | z |
|---|---|---|---|---|
| Page | `bg.canvas` | none | | 0 |
| Card | `bg.surface` | none | | 0 |
| Sticky header (if any) | page bg | none | | 10 |
| Drawer | `bg.surface` + `border.strong` left | `shadow.drawer` | `overlay.scrim` | 30 |
| Dialog | `bg.raised` + `border.strong` | `shadow.dialog` | `overlay.scrim` | 40 |
| Palette | `bg.raised` + `border.strong` | `shadow.dialog` | `overlay.scrim` | 50 |
| Toast | `bg.raised` + `border.strong` | `shadow.toast` | none | 60 |
| Tooltip | `bg.control` | none | none | 70 |

One scrim opacity: `rgba(10,11,16,.66)` (Proposed; the drawer used .55). Selected rows use `shadow.ring-selected` (a 3px inset teal bar on the left) plus `bg.selected`. Team tiles that need you use `shadow.ring-needs`.

## 8. Layout grid

### 8.1 Frame (Decided: 1920 x 1080 primary)

App shell: `Rail` (64) + optional secondary list + `main` (flex 1, `min-width: 0`) + optional right panel. Heights are the viewport; only inner regions scroll. The Rail height follows the viewport minus the 40px recording bar while recording (Decided).

Structural widths (tokens `layout.*`): rail 64, Focus list 264, Settings nav 300, tier aside 380, `panel-sm` 440, `panel-md` 600 (collapses the canvas 560 MeetingLive ask and 620 Team task column), dialog 700, readable column 820, Settings content 980. Headers: 84 comfortable, 72 tool pages (Focus, Memory), 64 compact.

### 8.2 Home grid

| Condition | Columns | Rows | Notes |
|---|---|---|---|
| Comfortable, width at least 1440 and height at least 1000 (Decided at 1920) | `repeat(3, minmax(0, 1fr))` | `minmax(0, 1fr) minmax(0, 1fr) 176px` | 6 session cards in urgency order, quiet row of 3. Padding 20 28 24, gap 20. |
| Height under 1000 (Proposed) | same | `repeat(2, minmax(360px, auto)) 176px` | The fleet section scrolls vertically; header stays. |
| More than 6 active sessions (Proposed) | same | `repeat(n, minmax(360px, 1fr))` then the quiet row | Scroll; the most urgent always come first. |
| Width 1280 to 1439 (Proposed) | `repeat(2, minmax(0, 1fr))` | `minmax(360px, auto)` rows, scroll | Quiet row keeps its own `repeat(3, minmax(0, 1fr))` at 176px spanning both columns. |
| Compact density | `repeat(3, minmax(0, 1fr))` | `repeat(3, minmax(0, 1fr))` | 9 terminal tails. At 1280 wide: 2 columns, rows `minmax(260px, 1fr)`, scroll. |

Card internals flex, and long content truncates (see each component's content rules) rather than growing the card.

### 8.3 Other screens at 1440 and 1280 (Proposed)

| Screen | 1920 | 1440 | 1280 (minimum supported) |
|---|---|---|---|
| Focus | list 264, terminal, details 440 | same (terminal about 670px, 80 columns at 14px) | List collapses to 72px (avatars and Alt digits, names in tooltips); details panel becomes an overlay drawer toggled with Alt I |
| Team | tasks 600, 2 x 2 crew terminals | tasks 440, crew terminals 2 x 2 | Crew terminals 1 column x 4, scroll |
| Memory | graph + panel 440 | same | same; graph Fit on resize |
| ResearchReview | draft + sources 600 | sources 440 | sources 440, draft padding 28 |
| Meetings | list 440 + detail 2 columns | detail 1 column | list 360 (Proposed exception), detail 1 column |
| MeetingLive | transcript + ask 600 | ask 440 | ask 440 |
| Settings | nav 300 + content + tiers 380 | tiers aside moves below the content | nav 240 |
| Dialogs, palette, drawer | 700 / 700 / 600 | same | same |

Below 1280 the layout is not designed (mobile is "Later", D-05). Browser zoom that pushes the CSS viewport under 1280 falls back to horizontal scroll of the shell (Open, see accessibility 11.9).

## 9. Iconography

### 9.1 Set (Proposed: lucide)

Port every inline SVG to **lucide** (`lucide-react`): it is a 24-grid, round-cap, round-join stroke set, which is exactly the canvas drawing style, it tree-shakes per icon, and it is ISC licensed. Keep one custom SVG: the anchor logo mark.

| Canvas icon | Where | lucide name |
|---|---|---|
| logo (anchor) | Rail logo | keep custom (lucide `anchor` is the fallback) |
| sessions grid | Rail | `layout-grid` |
| memory book | Rail, learned chip, callouts | `book-open` |
| meetings mic | Rail | `mic` |
| settings sliders | Rail | `sliders-horizontal` |
| bell | needs pills, header chip | `bell` |
| play (filled) | "4 running" chip | `play` with `fill="currentColor"` |
| check | done pill, decisions, FirstRun ok | `check` |
| compass | research pill, Research a topic | `compass` |
| plus | Launch a ship, palette action | `plus` |
| search | search trigger, palette | `search` |
| x | crashed pill, FirstRun bad, close | `x` |
| shield | SAFE | `shield` |
| triangle | CAUTION | `triangle-alert` |
| octagon | DESTRUCTIVE | `octagon-alert` |
| waves | stale pill | `waves` |
| wifi-off | connection banner | `wifi-off` |
| monitor | "Last typed from" | `monitor` |
| arrow send | chat send | `arrow-right` |
| text glyph ← | back links | `arrow-left` |
| text glyphs + and − | graph zoom | `plus`, `minus` |
| (new) idle, reviewed, starting, ended | pills | `moon`, `check-check`, `loader-circle`, `square` |
| (new) question tier | badge | `message-circle-question` |
| (new) draft | draft pill | `file-pen` |
| (new) pin, copy, open externally, retry, stop | buttons | `pin`, `copy`, `external-link`, `rotate-cw`, `square` |

The ellipsis in "Stop…" and "Revoke…" is text (it signals a confirm step), not an icon.

### 9.2 Sizes and stroke (Proposed)

`size.icon.xs` 12 (badges), `sm` 14 (pills, chips), `md` 16 (buttons, rows), `lg` 20 (rail, send), `logo` 22. Stroke 2 everywhere; rail icons 1.75. The canvas used 1.8 to 3 depending on size; lucide's `absoluteStrokeWidth` is not used. Icons inherit `currentColor`. Decorative icons next to a label get `aria-hidden="true"`; icon-only buttons get an `aria-label` (see Icon in components.md).

## 10. Motion

### 10.1 Principles (Proposed)

1. **Motion means "alive" or "arriving"**: loops only on things that are live (running, recording) or waiting for you; transitions only when something enters or leaves.
2. **Quick**: no UI transition longer than 280ms; keyboard surfaces (palette) are faster still.
3. **Nothing is motion-only**: every animated signal also has a label or icon, so reduced motion loses nothing.
4. **Calm by default**: at most one pulsing hue on screen (amber). Running dots breathe gently; nothing bounces or overshoots.

### 10.2 Tokens

| Token | Value | Use |
|---|---|---|
| `motion.duration.instant` | 0ms | Focus ring, selection |
| `motion.duration.fast` | 100ms | Hover, press |
| `motion.duration.normal` | 160ms | Exits, palette entry, tab changes |
| `motion.duration.moderate` | 200ms | Dialog and toast entry, drawer exit, scrim |
| `motion.duration.slow` | 280ms | Drawer entry, graph Fit |
| `motion.duration.loop-blink` | 1100ms | Caret |
| `motion.duration.loop-alert` | 1600ms | Recording pulse, shimmer |
| `motion.duration.loop-ambient` | 2400ms | Breathe, needs-you pulse, arrive |
| `motion.easing.standard` | `cubic-bezier(0.2, 0, 0, 1)` | In-place changes |
| `motion.easing.enter` | `cubic-bezier(0, 0, 0.2, 1)` | Arrivals |
| `motion.easing.exit` | `cubic-bezier(0.4, 0, 1, 1)` | Departures |
| `motion.easing.ambient` | `cubic-bezier(0.37, 0, 0.63, 1)` | Loops |
| `motion.easing.linear` | `linear` | Shimmer |

### 10.3 Named motions (Decided from the canvas; durations collapsed, Proposed)

| Name (class) | What it does | Duration, easing | Where | Reduced motion |
|---|---|---|---|---|
| **breathe** (`.motion-breathe`) | Opacity 1 to .35 and scale 1 to .75 | 2400ms ambient, infinite | Live dot in running pills (Home, compact dot, Team) | Solid dot, full opacity; the label "Running" carries the state |
| **pulse** (`.motion-pulse`, canvas `nudge`) | Amber glow ring 0 to 5px at 16% | 2400ms ambient, infinite (was 2.8s) | Session cards that need you | Static 1px amber inset ring in addition to the amber border |
| **rec-pulse** (`.motion-rec-pulse`) | Opacity 1 to .3 | 1600ms ambient, infinite | Recording dot (rec bar, Rail, Record button while recording) | Solid dot; "Recording" label and timer stay. The canvas Rail had no reduced-motion guard (bug fixed). |
| **arrive** (`.motion-arrive`) | White glow ring breathing | 2400ms ambient (was 2.6s); stops once the node is hovered, focused or opened, or after 60s (Proposed) | New note in the graph | Static white ring; the " · new" label suffix stays |
| **caret** (`.motion-caret`) | Blink, step | 1100ms `steps(1, end)` | Terminal replica and TerminalTail cursor only. TerminalView uses xterm `cursorBlink: true`. | Solid cursor; xterm `cursorBlink: false` |
| **shimmer** (`.motion-shimmer`) | Gradient sweep | 1600ms linear | SkeletonCard | Static base color; `aria-busy="true"` on the region carries "loading" |

### 10.4 Interaction transitions (not on the canvas; all Proposed)

| Interaction | Properties | Duration and easing | Reduced motion |
|---|---|---|---|
| Hover (buttons, rows, links, chips) | background, color, border-color | 100ms standard (`--transition-hover`) | Instant |
| Press | background to the `-press` token, `translateY(1px)` on filled buttons | 100ms standard | Background only, instant |
| Focus-visible | outline appears | instant, never animated | same |
| Drawer open | panel `translateX(100%)` to 0; scrim opacity 0 to 1 | panel 280ms enter; scrim 200ms enter | Panel and scrim fade 100ms, no slide |
| Drawer close | reverse | panel 200ms exit; scrim 160ms exit | Fade 100ms |
| Dialog open | opacity 0 to 1, `translateY(8px) scale(.98)` to none; scrim fade | 200ms enter | Fade 100ms, no transform |
| Dialog close | opacity to 0 | 160ms exit | Fade 100ms |
| Palette open | opacity, `translateY(8px)` | 160ms enter (keyboard surface, must feel instant) | Fade 100ms |
| Palette close | opacity | 100ms exit | Instant |
| Palette selection move | background of the highlighted row | instant | same |
| Toast in | opacity, `translateX(12px)` to 0 | 200ms enter | Fade 100ms |
| Toast out | opacity | 160ms exit | Fade 100ms |
| Tabs, segmented control | background and color of the selected item | 100ms standard | Instant |
| Card state change | border-color, pill colors | 200ms standard | Instant |
| Card reorder on Home | FLIP translate to the new slot | 200ms standard | No movement; cards jump |
| Progress and phase bar fill | width | 280ms standard | Instant |
| Graph Fit and zoom buttons | transform | 280ms standard; wheel and drag follow the pointer 1:1 | Instant |
| Skeleton to content | opacity 0 to 1 | 160ms enter | Instant |

Implementation: durations and distances are CSS variables, and the reduced-motion block in `tokens.css` overrides them once at `:root` (fast becomes 0ms, the rest 100ms, distances 0px) and stops the loops. Components never write their own `@media (prefers-reduced-motion)`. JavaScript-driven motion (FLIP, graph) reads `matchMedia('(prefers-reduced-motion: reduce)')`.

What never animates: text content, numbers ticking (counters jump), the crew pixels, layout on resize, scroll position (no smooth scroll), and anything inside the terminal.

## 11. Accessibility rules to build in

These are build requirements. The full WCAG 2.2 audit runs later on the React build (deferred during design; timing in [09-testing.md](../09-testing.md) section 11).

1. **Focus-visible ring** (Proposed): `outline: 2px solid var(--focus-ring)` (`#7fe3e3`), `outline-offset: 2px`. Inside containers that clip (list rows, tabs inside a bar, the terminal section) use the `.focus-inset` variant (offset -2px). Only `:focus-visible`, never `:focus`, so mouse clicks do not ring. Never `outline: none` without this replacement. The ring is at least 8.78:1 on every surface. When xterm has focus, its hidden textarea is focused, so the ring is drawn on the terminal section with `:focus-within`.
2. **Focus order and management**: DOM order equals visual order. Dialogs, drawer and palette trap focus, set initial focus (palette: input; Needs-you drawer: first request's primary action; research form: Topic), close on Esc (except while the terminal has focus, see keyboard.md) and return focus to the trigger. Opening a session in Focus moves focus to the terminal.
3. **Target size**: every control is at least 28 x 28 (`size.control.xs`); icon-only buttons are 36 x 36; WCAG 2.5.8 needs 24. Inline links in prose are exempt. Adjacent small targets keep at least 8px between them (Palette, compact action strip).
4. **Never color-only** (Decided for crew; Proposed elsewhere): StatePill always has icon or live dot plus a literal label; TierBadge always has its word; needs-you cards have an amber border and a pill; diff lines keep their `+` and `-` prefixes; changed-file counts keep `+` and `−`; FirstRun status circles carry a glyph; transcript speakers are labelled; cited graph nodes are listed in the answer's citations; crew pose is a backup signal only; selected rows and tabs also carry `aria-selected` or `aria-current` and a 600 weight label.
5. **Live regions** (Proposed): one polite `role="status"` region in AppShell announces new requests ("rustot needs approval: cargo test --release combat::") and crashes ("andreymudri.com crashed, exit 1"). Announcements are batched: at most one every 2 seconds, merging bursts into "3 new requests". Nothing is assertive. The connection banner is `role="status"`. The recording timer is not live (it would talk every second); the rec bar announces only "Recording started" and "Recording stopped". The palette announces the result count politely. Toasts render inside the same polite region.
6. **Terminal accessibility**: xterm.js `screenReaderMode` is a Settings, Appearance toggle, off by default because it costs performance (Proposed). The terminal section has `aria-label="Terminal, {repo} · {task}"`. Tab and Shift Tab belong to the terminal while it has focus; the global chords from keyboard.md (Alt Esc, Alt 1 to 9, Alt K) always leave it, and the Focus header shows "Alt Esc to leave the terminal" as a visible hint, so there is no keyboard trap (WCAG 2.1.2). The PromptBar mirrors every permission prompt outside the terminal so approvals never require reading the TUI.
7. **Reduced motion**: section 10; handled globally.
8. **Screen-reader-only text**: `.sr-only` replaces the canvas `left: -9999px` labels. Every input has a label (visible or `.sr-only`); placeholders are never the only label.
9. **Zoom and reflow**: text resizes with browser zoom (all sizes in px tokens scale with page zoom). Reflow to 320px (WCAG 1.4.10) is not designed because the minimum supported width is 1280 (**Open**, tied to "mobile later").
10. **Language**: `<html lang>` follows `DECK_LANG`. Meeting content is PT-BR: wrap transcript lines, summaries, decisions and action items in `lang="pt-BR"` when the chrome is English, so screen readers switch voice.
11. **Structure**: one `h1` per screen; landmarks `nav` (Rail, `aria-label="Deck sections"`), `main`, labelled `aside`s and `section`s as on the canvas. Rail items use `aria-current="page"`.
12. **Sound**: the Ship's bell always accompanies a visible change and never plays alone.
13. **Untrusted text**: all agent, transcript, task, command and note text renders as text nodes. Never `dangerouslySetInnerHTML` for it (Decided, D-35). Markdown in notes and answers goes through a sanitising renderer that outputs React elements (Proposed: `react-markdown` without `rehype-raw`).

## 12. Voice and copy

### 12.1 Rules (Decided)

- **Theme the flavor, never the facts.** The nautical voice may appear in page headlines, subtitles and empty or calm states. It never appears in status pills, counts, error causes, or confirmation text.
- **Pills are literal**: Running, Needs approval, Asked you, Done, No activity 22m, Idle 1h, Reviewed, Crashed · exit 1.
- **Plain terms in code, API fields and logs.** Themed terms only in UI subtitles.

### 12.2 Vocabulary (Decided, from 02-domain.md)

| Plain (pills, buttons, errors, code) | Themed (headlines, subtitles only) |
|---|---|
| session | ship |
| repo | harbor |
| run | voyage, fleet |
| teammate | crew member |
| stale | adrift |
| done | made port |
| research, research teammates | scouts, send out scouts |
| vault note | chart |
| daily recap | Captain's log |
| notification sound | Ship's bell |

### 12.3 Do and don't (examples from the canvas copy)

| Do | Don't | Why |
|---|---|---|
| Headline "andreymudri.com ran aground" + pill "Crashed · exit 1" | Pill "Ran aground" | The pill is the fact |
| Subtitle "Captain's log: 9 voyages · 3 made port · 1 chart added" | Header chip "3 made port" | Chips are counts: "1 to review" |
| Title "The scouts made port: advisory locks vs Redis locks" + pill "Draft · not saved" | Pill "Scouts returned" | Draft state must be unmistakable |
| "The disk is full, so relaunching now would fail the same way." | "Rough seas ahead!" | Errors name the cause and the consequence |
| Degraded card title "The charts are out of reach", body "vault-mcp did not answer on stdio (spawn exited 1: VAULT_PATH is not a directory). Sessions and meetings still work." | A themed body | Flavor in the title, facts in the body |
| "Calm seas. No ships out." only when nothing is running and nothing adrift | "Calm seas" with one ship adrift | Decided review fix: then the headline is "One ship adrift" |
| "Nudge (send Enter)" | "Nudge" alone | Say what the button actually does when the verb is playful |
| Button "Stop…", "Revoke…" (ellipsis = a confirm follows) | "Stop" that stops immediately | The ellipsis promises a confirm step |

Tension to resolve (**Open**): "Launch a ship", "Set sail (needs hooks)" and "Send scouts" are themed buttons that change state, and 02-domain.md says buttons that change state stay plain. They are on the reviewed canvas. Either allow themed verbs on launch buttons whose effect is obvious from context, or rename them "Launch session", "Start (needs hooks)", "Start research". The design system supports both; the owner picks.

### 12.4 Error message pattern (Proposed)

1. **Title**: may be themed ("No one on the radio").
2. **What happened, literally**, with the real error text in mono when there is one: "scribed is not running: no socket at $XDG_RUNTIME_DIR/turbidassist.sock."
3. **What still works**: "Past meetings still load from the vault."
4. **The first fix as a literal verb button**, primary, then Retry as secondary: "Start scribed", "Retry".
5. **Timing facts in parentheses** for retries: "(attempt 3, next in 4s)".

The connection banner keeps its themed lead but its second sentence is literal. Proposed wording: "Radio silence from deckd. Sessions keep running; reconnecting (attempt 3, next in 4s)." (canvas: "Ships still sailing, re-establishing contact…").

### 12.5 Formatting conventions

- Separator: middle dot with spaces, " · " (U+00B7). Built by a `MetaLine` helper that joins items and marks the dots `aria-hidden`, never by string concatenation.
- Ranges: "tasks 3 to 7", never a dash.
- Minus in diff counts: U+2212 "−4"; plus "+38".
- Durations: `12m`, `1h 12m`, `3d` (02-domain.md). Clock times 24h: `18:42`. Meeting offsets `MM:SS`.
- Ellipsis character "…" (U+2026) for truncation markers and confirm buttons.
- Paths show `~` for `$HOME`.

### 12.6 i18n (Decided: `DECK_LANG` = `en` | `pt`)

- Chrome follows `DECK_LANG`; meeting content stays PT-BR in both; agent and terminal output is never translated (Decided).
- Every chrome string is keyed (`home.header.needYouCount`). No string concatenation: plurals and placeholders go through ICU MessageFormat, for example `{count, plural, one {# needs you} other {# need you}}` (Proposed library: FormatJS `react-intl`, which also provides the formatters below).
- State labels are keys too (`state.needs_approval.label`), with the English values of section 3.4.
- Numbers with `Intl.NumberFormat(locale)` ("1,240" in `en`, "1.240" in `pt-BR`). Dates and times with `Intl.DateTimeFormat(locale, { hourCycle: 'h23' })`. Relative times ("6 min ago") with `Intl.RelativeTimeFormat`. Lists with `Intl.ListFormat`.
- Compact durations (`12m`, `1h 12m`) use the same unit letters in both languages (Proposed).
- Layout must survive PT strings about 30% longer than EN: buttons never have fixed widths; pills and titles truncate with the full text available.
- Keyboard hints are not translated ("Alt K").

## 13. Density

Two densities on Home only (Decided): Comfortable (default) and Compact. Compact sets the Home root to `font-size.sm` (13px), header 64, 3 x 3 grid, card radius `lg`, compact buttons `size.control.xs`. Other screens have one density. The density choice persists per browser (localStorage) (Proposed).

## 14. Changes from canvas

Every value this system collapsed or fixed, old to new. All Proposed unless marked.

**Color**

- Running pill background `#1e2433` (blue-grey) to `#1f2a1c` (green tint).
- `#131420` (compact tail) to `#15161e`; `#111219` (Rail) and `#12131a` (graph canvas) to `#0f1016`.
- Skeleton `#1f2130` / `#262939` to `#22243a` / `#2b2f45`.
- Terminal dim `#737aa2` to `#8f96b8`.
- Amber tints `#2a2419` (connection banner, stale pill, hint) and `#1d1a14` (Focus approval bar) to `#2c261c`.
- Amber soft border `#4a3f2e` to `#4d3f28`.
- Danger ghost border `#5a2a35` to `#6b2d3a`.
- Diff add `#16241a` to `#1f2a1c`; diff delete `#2a1519` to `#2e1c22`.
- Recording bar tertiary text `#b98f98` to `#e7c3ca`.
- Disabled destructive label `#b77f8a` (3.98:1) to `#c48d98` (4.72:1).
- Input, select and textarea borders `#2b2f45` / `#3a3f5c` to `#666e94` (3:1 boundary); focused stays 2px `#3cc8c8`.
- Pending gate diamond border `#4a5070` to `#3a3f5c` (border.strong); dashed "Example" badge `#4a5070` to `#3a3f5c`.
- Graph unlit edge `#353a55` kept as a component token (not collapsed into border.strong; edges need to sit below borders).
- Selected row background in Palette and Focus list `#2b2f45` to `#22243a` (same as Meetings and Settings).
- Scrim `.55` (drawer) to `.66`.
- HomeCalm capture dots to the vault domain map.
- Crew slot 8 `#f5a3d7`; CrewSheet swatches `#ffc777`, `#b4f9f8`, `#fca7ea` removed (crew.md 4.1).
- `muted` `#6b7294` to `#8f96b8` (Decided, before this handoff).

**Typography**

- 10px badges (tier mini, rail count) to 11px.
- 12.5px / 1.72 compact tail to 12px / 1.6.
- 17px degraded-card titles to 18px.
- 26px Settings h2 to 28px.
- Page h1 20px (Team, ResearchReview, MeetingLive) to 22px; drawer and dialog titles stay 20px.
- Weight 500 (Focus prompt title, Team phase label default) to 600 and 400.
- Line heights 1.45 and 1.55 to 1.5; 1.72 to 1.6; 1.65 kept as `prose`.
- Eyebrows 11px and 13px to 12px; tracking 0.04em and 0.05em to 0.06em.
- Typed caps ("MEMORY TAB", "SAFE") to sentence case + `text-transform: uppercase`.
- Terminal replica 14px / 1.65 to xterm 14px, `lineHeight` 1.2.

**Spacing, radii, sizes**

- Spacing to the 2px scale: 3, 5 to 4; 7, 9 to 8; 18 to 20 or 16; 22 to 20 or 24; 26 to 24 or 28. Card padding 18 to 20; Home grid gap 18 to 20; bottom padding 22 to 24.
- Pill paddings (seven variants) to `4px 10px`; badge paddings to `2px 6px`.
- Radii 3, 5 to 4; 7 to 6; 9 to 8; 11 to 10.
- Control heights 26, 30 to 28; 34 to 32; 38 to 36; 42 to 40; 48 kept only for the HomeCalm hero.
- Dots 7px to 8px; 9px to 10px. Icons 13 to 14, 15 to 16, 18 to 20.
- Crew sizes 54 to 45, 63 and 108 to 72.
- Panels 560 (MeetingLive ask) and 620 (Team tasks) to 600; chat bubble max 330 to 420.

**Motion**

- Breathe 2.4s kept; nudge 2.8s and arrive 2.6s to 2.4s (one ambient loop); canvas `nudge` renamed `pulse`.
- `ease-in-out` loops to `cubic-bezier(0.37, 0, 0.63, 1)`.
- Rail rec dot gains its missing reduced-motion guard.
- New: every interaction transition in 10.4 (the canvas had none).

**Accessibility and markup**

- `left: -9999px` labels to `.sr-only`.
- Focus-visible ring added everywhere (the canvas had none).
- Rail `aria-current="page"` added; key hints `Alt+1` to `Alt Shift 1` style per keyboard.md.
- Crew in cards becomes `aria-hidden` (the pill already says the state).
- Rejected research source used a dash glyph as its "number"; the port shows a "Rejected" label instead.
- Team phase ranges written with an en dash (U+2013, "tasks 1" dash "2") to the word: "tasks 1 to 2".

## 15. Open items

1. Themed state-changing buttons ("Launch a ship", "Set sail", "Send scouts"): keep or rename (12.3).
2. Crew slot 8 and removal of the CrewSheet swatches; more-than-nine-repos rule; 30-day slot release; teammate shade formula (crew.md).
3. Reflow below 1280px and 200% zoom at small windows (11.9).
4. Connection banner wording change (12.4).
5. `stale` as its own amber (`#d6a86a`) vs collapsing into needs amber (3.4). Proposed keeps it separate; the canvas inventory called it a designer call.
6. xterm `screenReaderMode` default off (11.6).
