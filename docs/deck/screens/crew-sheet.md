# Crew sheet (pose reference and customize)

| | |
|---|---|
| Canvas board | `CrewSheet` (Pixel crew · poses and teams); component board `Crew` |
| Route | `/settings/crew` (inside Settings; query `repo=<repoKey>` preselects the customize target) |
| Milestone | M1 renders the avatars (CrewAvatar everywhere). M2 ships this page with Customize. |
| Status | Decided (one crew member per repo, shape from the name, color slot saved once and never repeated, team hat, Reroll, hats None/Cap/Bandana, pose is a backup signal), Proposed (placement in Settings, states), Open (swatches and slot 8, crew.md 12) |

The avatar algorithm, poses, hats, sizes and test vectors are in [crew.md](../design/crew.md); this spec covers only the page.

## 1. Purpose

Answers **"Which crew member is which repo, and can I change how mine looks?"** A reference of every known repo in every pose, the team-hat rule, and a Customize panel (Reroll shape, pick a free color, hat).

## 2. Route and entry points

| Entry | Result |
|---|---|
| Settings nav "Crew" | `/settings/crew` |
| Settings, Appearance "Customize crew" (shared colors notice) | `/settings/crew` |
| Repo avatar context action (Proposed: none in v1) | |

## 3. Layout

Inside the Settings shell (nav 300 + content). Content, left to right at 1920: the pose grid section, then a right column with "A fleetmates team shares a hat", the Customize card and "At card size (27px), poses still read".

| Width | Behaviour |
|---|---|
| 1920 | two columns (grid + right column) |
| 1440 | one column: grid first, then the right column content below |
| 1280 | one column; grid cells shrink to `crew.size.lg` (45px) avatars (Proposed) |

Grid: first column repo names (mono), then 5 pose columns (running, needs you, idle, done, crashed) with CrewAvatar `xl` (72px) in `bg.surface` tiles.

## 4. Content inventory

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Heading | h2 `type.heading-detail` | | "One crew member per repo" | Settings h1 stays "Settings" |
| Intro | text, max 760 | | "The shape comes from the repo name. The color is the first free slot when the deck first sees the repo, saved so it never changes and never repeats. Needs you raises an arm and adds an amber signal; idle closes the eyes." | |
| Pose headers | Eyebrow, each in its pose colour + text | | "running", "needs you", "idle", "done", "crashed" | uppercased by CSS |
| Repo rows | mono label + CrewAvatar `xl` per pose, `role="img"` | every repo known to the deck (not archived), `crewSeed`, `crewSlot`, `hat` | "fleetmates", "rustot", … | `aria-label="rustot crew member, needs you"` (crew.md 10) |
| Team section | h2 + CrewTile x 4 | a sample team from the first repo (lead + 3 teammates, seeds `<repo>#T1..T3`, teal cap) | "A fleetmates team shares a hat", tiles "lead", "T1", "T2", "T3" | canvas "teammate 1..3" |
| Customize card | CalmSection-like card (`radius.3xl`) | selected repo | "Customize rustot's crew member" | repo Select above the card (Proposed) to choose the target |
| Preview | CrewAvatar `xl` in a well, `role="img"` | current `crewSeed`, `crewSlot`, `hat`, pose done | "Current look" | |
| Reroll | Button `secondary` | writes a new `crewSeed` (`name#2`, `name#3`, crew.md 1) | "Reroll" | |
| Reset shape (Proposed) | Button `ghost sm` | `crewSeed` back to `name` | "Use the original shape" | only when rerolled |
| Color | RadioGroup `aria-label="Color"`, 28px round swatches | current slot + free slots from the 9-slot table (crew.md 4.1) | "Current color", "Free color slot {n}" | swatch colours from `crew.slot.*` tokens |
| Hat | RadioGroup `aria-label="Hat"` of buttons | `repo.hat` | "No hat", "Cap", "Bandana" | teal is never a personal hat colour |
| Small poses | h2 + 5 tiles with CrewAvatar `sm` (27px) and pose label | selected repo | "At card size (27px), poses still read", "running", "needs you", "idle", "done", "crashed" | |
| Note | text muted | | "The pose is a backup signal, never the only one: every card also carries a state pill with an icon and a label." | |
| Shared slots notice | Banner `hint` (Proposed) | repos with `crewSlotShared` | "{n} repos share colors because there are more than 9. Pick which ones share below." | crew.md 4.3 |

## 5. States

| State | What shows |
|---|---|
| Loading | grid rows as skeleton tiles (5 per row, 3 rows) |
| Empty (no repos yet) | "No repos yet. Crew members appear the first time the deck sees a repo." ; Customize hidden |
| No free color | Color group shows only the current colour and the line "All 9 colors are taken. Archive a repo to free one." |
| Saving | the changed control shows a spinner in place for up to 1s; the preview updates optimistically |
| Save failed | control reverts; toast `error` "Could not save the crew change: {error}" |
| Saved | toast `success` "rustot's crew member updated" + "Undo" (6s) |
| Overflow | more than 12 repos: the grid scrolls inside the section with sticky pose headers; long repo names truncate with `title` |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Repo Select | switches the Customize target | route `?repo=` |
| "Reroll" | new seed, preview and every avatar of that repo update | `PATCH /api/repos/:repoKey/crew {seed}` |
| "Use the original shape" | seed = name | same |
| Color swatch (arrow keys within the group) | move to that free slot; the old slot becomes free | `PATCH … {slot}` (one DB transaction, crew.md 4.2) |
| Hat option | hat changes | `PATCH … {hat}` |
| "Undo" in the toast | restores the previous seed, slot and hat | `PATCH … {seed, hat}` with the previous values, plus the previous `slot` when the change moved the slot |

## 7. Real-time updates

`repo.upserted` events (05-api section 2.1 folds `repo.crew` into it) update every avatar of that repo on every open screen (Home cards, lists, palette rows) without a reload. No animation on the pixels (crew.md 10).

## 8. Accessibility

- Standalone avatars are `role="img"` with "{repo} crew member, {pose}"; the grid is a `table` with column headers (poses) and row headers (repo names) so screen readers can navigate it (Proposed, replaces the canvas CSS grid semantics).
- Swatch and hat groups are radio groups with arrow keys; the current swatch is `aria-checked="true"` and labelled "Current color".
- Colour is never the only identity: the repo name is always next to the avatar.

## 9. Copy deck

| Key | EN |
|---|---|
| `crew.title` | One crew member per repo |
| `crew.intro` | The shape comes from the repo name. The color is the first free slot when the deck first sees the repo, saved so it never changes and never repeats. Needs you raises an arm and adds an amber signal; idle closes the eyes. |
| `crew.pose.running` | running |
| `crew.pose.needs` | needs you |
| `crew.pose.idle` | idle |
| `crew.pose.done` | done |
| `crew.pose.crashed` | crashed |
| `crew.avatar.a11y` | {repo} crew member, {pose} |
| `crew.team.title` | A fleetmates team shares a hat |
| `crew.team.lead` | lead |
| `crew.customize.title` | Customize {repo}'s crew member |
| `crew.customize.repo` | Repo |
| `crew.customize.current` | Current look |
| `crew.customize.reroll` | Reroll |
| `crew.customize.resetShape` | Use the original shape |
| `crew.customize.color` | Color |
| `crew.customize.color.current` | Current color |
| `crew.customize.color.free` | Free color slot {n} |
| `crew.customize.color.none` | All 9 colors are taken. Archive a repo to free one. |
| `crew.customize.hat` | Hat |
| `crew.customize.hat.none` | No hat |
| `crew.customize.hat.cap` | Cap |
| `crew.customize.hat.bandana` | Bandana |
| `crew.small.title` | At card size (27px), poses still read |
| `crew.note` | The pose is a backup signal, never the only one: every card also carries a state pill with an icon and a label. |
| `crew.shared` | {n} repos share colors because there are more than 9. Pick which ones share below. |
| `crew.empty` | No repos yet. Crew members appear the first time the deck sees a repo. |
| `crew.saved` | {repo}'s crew member updated |
| `crew.saveError` | Could not save the crew change: {error} |
| `crew.undo` | Undo |

## 10. Acceptance criteria

1. **Given** fixture `busy`, **when** opening `/settings/crew`, **then** one row per known repo renders with 5 pose avatars, each an `img` named "{repo} crew member, {pose}".
2. **Given** the crew.md test vectors, **then** the rendered SVG rects for `rustot` and `fleetmates` in every pose match the pixel maps (unit test on the component; Playwright compares a screenshot of the grid).
3. **Given** "Reroll" on rustot, **then** its seed becomes `rustot#2`, the preview changes shape, and the rustot avatar on Home changes without reload.
4. **Given** 8 slots taken, **then** the Color group offers exactly the current colour and slot 8.
5. **Given** choosing a free slot, **then** the previous slot becomes free for other repos (API state) and the change toast offers Undo.
6. **Given** reduced motion, **then** nothing on the page animates.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| CREW-O1 | Slot 8 colour and removal of the three canvas swatches (`#ffc777`, `#b4f9f8`, `#fca7ea`) (crew.md 4.1). | Open (crew.md 12). |
| CREW-O2 | More than nine repos rule and the 30-day slot release (crew.md 4.2, 4.3). | Open (crew.md 12). |
| CREW-O3 | Teammate shade formula replacing the canvas oranges (crew.md 5). | Open (crew.md 12). |
| CREW-O4 | The canvas CrewSheet is a standalone board; placing it under Settings is this spec's choice. | Proposed. |

## 12. Changes from the canvas

1. Swatches come from the 9-slot table (free slots only), not the three canvas colours.
2. Team tiles are labelled by task id ("T1") instead of "teammate 1".
3. Grid avatars 63px become 72px (`crew.size.xl`); the Customize preview 108px becomes 72px.
4. Bandana is drawn (crew.md 7); the canvas Crew component had only a flat hat row.
5. Ears use the unsigned shift fix (crew.md 3), so `vault-mcp`, `discord-audit` and `rustot-client` look different from the canvas.
6. The page lives at `/settings/crew`; the grid becomes a table for screen readers.
