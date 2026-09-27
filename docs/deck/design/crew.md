# Crew: CrewAvatar reimplementation spec

Status legend: **Decided** (owner or canvas), **Proposed** (handoff recommendation), **Open** (needs an owner call). Source of truth for the original behaviour: `Crew.dc.html` and `CrewSheet.dc.html` on the canvas, summarised in the canvas inventory section 4.1.

The pixel crew gives every repo a small 9 x 9 character. It is decoration with a job: at a glance it says "which repo" (color and shape) and, as a backup only, "what state" (pose). It never carries meaning alone: every card also has a StatePill with an icon and a literal label (Decided, CrewSheet note).

## 1. Inputs

| Input | Source | Notes |
|---|---|---|
| `seed` | `repo.crewSeed` (defaults to `repo.name`, Decided) | Drives the shape only. "Reroll" stores a new seed (Decided behaviour, seed format Proposed: `name#2`, `name#3`, ...). |
| `slot` | `repo.crewSlot` (0..8) | Drives the body color. Assigned once, persisted (section 4). |
| `pose` | Derived from the session state (section 6) | |
| `hat` | `repo.hat` (`none`, `cap`, `bandana`) or the team hat | Section 7. |
| `size` | 27, 36, 45 or 72 px | Section 8. |

Teammates and scouts are not repos. Their seeds and colors are covered in section 5.

## 2. Seed hashing (Decided algorithm)

32-bit FNV-1a over UTF-16 code units, exactly as `Crew.dc.html`:

```js
/** @param {string} seed @returns {number} uint32 */
export function fnv1a(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
```

UTF-16 code units (not code points, not UTF-8 bytes) are part of the contract: a Rust or Python port must iterate `encode_utf16()` / `seed.encode('utf-16-le')` pairs to match.

## 3. Shape derivation (Proposed fix of a canvas bug)

```js
const wide  = ((h >>> 4) & 1) === 1;   // head row 2..3 spans x 1..7 instead of 2..6
const ears  = (h >>> 6) % 3;           // 0 none, 1 antenna, 2 ears
const belly = ((h >>> 9) & 1) === 1;   // light pixels at (4,4) and (4,5)
```

**The bug.** The canvas used `(h >> 6) % 3`. JavaScript's `>>` first converts the uint32 to a signed int32, so for every seed whose hash has the top bit set (`h >= 2^31`, about half of all repos) the shift is negative and `% 3` returns `0`, `-1` or `-2`. Only `1` and `2` draw anything, so those repos could never get ears or an antenna: the distribution was 67% "no ears" instead of 33%.

**The fix.** Use the unsigned shift `>>>` for all three bits. `wide` and `belly` are unaffected (a masked single bit is the same either way), `ears` becomes uniform over 0, 1, 2. The change alters the look of repos with `h >= 2^31` (in the test set: `vault-mcp`, `discord-audit`, `rustot-client`). Nothing is persisted yet, so no migration is needed; ship the fixed version from M1 and never change the formula again, because the shape is part of the repo's identity (Proposed). Ports in other languages: use unsigned 32-bit arithmetic end to end.

## 4. Color slots

### 4.1 Slot table (tokens `crew.slot.0` to `crew.slot.8`)

| Slot | Color | Name | Canvas holder | Status |
|---|---|---|---|---|
| 0 | `#ff9e64` | orange | fleetmates | Decided |
| 1 | `#f7768e` | rose | rustot | Decided |
| 2 | `#7aa2f7` | blue | vault-mcp | Decided |
| 3 | `#73daca` | mint | discord-audit | Decided |
| 4 | `#bb9af7` | lilac | andreymudri.com | Decided |
| 5 | `#7dcfff` | sky | turbidassist | Decided |
| 6 | `#c3e88d` | lime | rustot-client | Decided |
| 7 | `#e0c98a` | sand | axios-like | Decided |
| 8 | `#f5a3d7` | pink | free | Proposed |

Why slot 8 is pink (Proposed): the canvas had three color lists that disagree. `SLOTS` in Crew.dc.html holds 8 repo colors plus `#c0caf5` for research; the fallback `hues` list has 9 colors including `#f5a3d7`; the CrewSheet swatches offered `#ffc777`, `#b4f9f8`, `#fca7ea` as "free" slots that appear in neither list. `#ffc777` is too close to the amber needs-you signal (`#e0af68`) and `#b4f9f8` too close to the teal team hat and brand, so both would blur state signals. The nine slots above are the eight repo colors the canvas actually rendered plus the one remaining `hues` entry. The Customize dialog shows the free slots from this table, not the three canvas swatches. Owner confirmation: **Open**.

`#c0caf5` (token `crew.research`) is reserved for research runs and scouts and is not in the pool, so launching research never consumes a repo slot (Proposed).

### 4.2 Assignment (Decided rule, Proposed mechanics)

- On the first sighting of a repo (first hook event, first launch, or first scan of `~/dev`), assign the **lowest-numbered free slot** and persist it in `repo.crewSlot` together with `firstSeenAt`.
- The slot never changes on its own. The user can move a repo to another **free** slot in Customize; the old slot becomes free.
- Two live repos never share a slot while a free one exists ("never repeats", Decided).
- A slot is held for as long as the repo row exists. A repo whose directory has been missing for 30 days is archived and its slot released (Proposed; the 30-day figure is **Open**).
- Assignment runs inside one DB transaction (`SELECT` free slot, `UPDATE repo`) so two repos seen in the same tick cannot grab the same slot.

### 4.3 More than nine repos (Proposed, owner confirmation Open)

When all nine slots are held and a tenth repo appears:

1. It gets `crewSlot = h % 9` (its FNV-1a hash) and `crewSlotShared = true`. The color repeats, the shape almost certainly does not, and the repo name is always printed next to the avatar, so identity still holds.
2. Settings, Appearance shows one line: "10 repos share 9 colors" with a link to Customize, where the user can swap which repos share. Nothing is ever reassigned silently.
3. When a slot frees up (a repo is archived), the shared repo with the oldest `firstSeenAt` takes it automatically and `crewSlotShared` clears. This is the only automatic reassignment, and it only moves a repo from a shared color to an exclusive one.

The canvas fallback `hues[h % 9]` for unknown seeds is replaced by this rule; a CrewAvatar is never rendered without a resolved slot (the component asserts it in development).

### 4.4 Shades (Decided)

`mix(hex, to, t)` interpolates each 8-bit channel with `Math.round(a * (1 - t) + b * t)` and re-encodes as lowercase 6-digit hex.

- `light = mix(body, '#ffffff', 0.35)`: antenna, belly, raised hand.
- `dark = mix(body, '#000000', 0.35)`: feet, hands, mouth, closed eyes, dropped arms.
- `ink = #15161e` (`crew.ink`): open eyes and smile.

| Slot | body | light | dark |
|---|---|---|---|
| 0 | `#ff9e64` | `#ffc09a` | `#a66741` |
| 1 | `#f7768e` | `#faa6b6` | `#a14d5c` |
| 2 | `#7aa2f7` | `#a9c3fa` | `#4f69a1` |
| 3 | `#73daca` | `#a4e7dd` | `#4b8e83` |
| 4 | `#bb9af7` | `#d3bdfa` | `#7a64a1` |
| 5 | `#7dcfff` | `#abe0ff` | `#5187a6` |
| 6 | `#c3e88d` | `#d8f0b5` | `#7f975c` |
| 7 | `#e0c98a` | `#ebdcb3` | `#92835a` |
| 8 | `#f5a3d7` | `#f9c3e5` | `#9f6a8c` |
| research | `#c0caf5` | `#d6ddf9` | `#7d839f` |

Precompute these at build time into a frozen table; do not mix colors at render time.

## 5. Teammates and scouts (Proposed)

A fleetmates run shows one avatar per teammate. The canvas used hand-picked oranges (`#ffb98c`, `#e98748`, `#ffcfa6`) for the fleetmates team; the rule below generalises that to any repo.

- **Seed:** lead = `repo.crewSeed`; teammate = `<repo name>#<taskId>` (for example `fleetmates#T5`). fleetmates task ids are stable, so a teammate keeps its shape for the whole run.
- **Body color:** lead = the repo's slot color. Teammate number k (1-based, in task order) takes the k-th entry, cycling, of: `mix(body, white, 0.25)`, `mix(body, black, 0.12)`, `mix(body, white, 0.45)`, `mix(body, black, 0.24)`. For slot 0 these are `#ffb68b`, `#e08b58`, `#ffcaaa`, `#c2784c` (the canvas values were `#ffb98c`, `#e98748`, `#ffcfa6`).
- **Hat:** every member of a run, lead included, wears the team cap in `crew.hat.team` (teal `#3cc8c8`, Decided). The team hat replaces the personal hat for the duration of the run.
- **Scouts:** research lead and scouts use body `crew.research`, seeds `research` and `scout-<n>`, team cap.

Shading for teammate colors uses the same 0.35 light and dark mixes from their own body color.

## 6. Poses

State to pose mapping follows 02-domain.md section 3 (Decided):

| Pose | Session states | What changes |
|---|---|---|
| `running` | starting, running | Both arms out with dark hands |
| `needs` | needs_approval, asked_you | Right arm raised (light hand), amber flag at top left |
| `idle` | stale, idle | Eyes closed (dark), grey "z" pixels at top right, arms down |
| `done` | done, reviewed | Both arms up, smile |
| `crashed` | crashed | Red eyes, arms dropped low |
| `none` | ended, and neutral badges (Settings, recent harbors, palette rows) | Open eyes, arms down, no signal |

### 6.1 Paint order (Decided, with the ears fix and hats added)

Coordinates are `(x, y)` with x = column 0..8 and y = row 0..8. `set` overwrites, so order matters: later steps win. Pose signals are painted after the hat, so a state signal is never hidden by an accessory.

1. Head top: `x 2..6, y 1` = body.
2. Head middle: `y 2..3`, `x 1..7` if wide else `x 2..6` = body.
3. Torso: `x 2..6, y 4..5` = body.
4. Hips: `x 3..5, y 6` = body.
5. Feet: `(3,7)`, `(5,7)` = dark.
6. Belly: if belly, `(4,4)`, `(4,5)` = light.
7. Head accessory:
   - hat is `cap` (personal cap or team hat): `x 2..6, y 0` = hat; `(wide ? 1 : 2, 1)` = hat; `(wide ? 7 : 6, 1)` = hat. The cap hides ears and antenna.
   - otherwise: ears 1 draws `(4,0)` = light (antenna); ears 2 draws `(2,0)`, `(6,0)` = body. Then, if hat is `bandana`: `x 2..6, y 1` = hat plus the knot tail `(7,1)` and `(8,2)` = hat.
8. Eyes: idle `(3,2)`, `(5,2)` = dark plus signal `(8,0)`, `(7,1)` = `crew.signal.idle`; crashed `(3,2)`, `(5,2)` = `crew.signal.crashed`; otherwise `(3,2)`, `(5,2)` = ink.
9. Mouth: done `(3,3)`, `(4,3)`, `(5,3)` = ink; otherwise `(4,3)` = dark.
10. Arms and signals:
    - running: `(1,5)` body, `(0,5)` dark, `(7,5)` body, `(8,5)` dark.
    - needs: `(1,5)` body; `(7,4)` body, `(8,3)` body, `(8,2)` light, `(8,1)` light; flag `(0,0)`, `(0,1)` = `crew.signal.needs`.
    - done: `(1,4)` body, `(0,3)` body, `(0,2)` light; `(7,4)` body, `(8,3)` body, `(8,2)` light.
    - crashed: `(1,6)` dark, `(7,6)` dark.
    - idle and none: `(1,5)` body, `(7,5)` body.
11. Row 8 is never painted; the figure sits in the top 8 rows of the 9-row box (keeps it optically centred against text baselines).

### 6.2 Pixel maps

Legend: `B` body, `L` light, `D` dark, `I` ink, `H` hat, `A` amber signal, `G` grey signal, `R` red signal, `.` empty. All maps below were produced by running the fixed reference implementation in Node, [tools/crew-reference.mjs](tools/crew-reference.mjs); port it to `hub/web/src/components/crew/` and keep these maps as its test fixtures.

`rustot` (narrow, antenna, no belly), no hat:

```
running     needs       idle        done        crashed     none
....L....   A...L....   ....L...G   ....L....   ....L....   ....L....
..BBBBB..   A.BBBBB.L   ..BBBBBG.   ..BBBBB..   ..BBBBB..   ..BBBBB..
..BIBIB..   ..BIBIB.L   ..BDBDB..   L.BIBIB.L   ..BRBRB..   ..BIBIB..
..BBDBB..   ..BBDBB.B   ..BBDBB..   B.BIIIB.B   ..BBDBB..   ..BBDBB..
..BBBBB..   ..BBBBBB.   ..BBBBB..   .BBBBBBB.   ..BBBBB..   ..BBBBB..
DBBBBBBBD   .BBBBBB..   .BBBBBBB.   ..BBBBB..   ..BBBBB..   .BBBBBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........
```

`fleetmates` (wide, ears, belly), no hat:

```
running     needs       idle        done        crashed     none
..B...B..   A.B...B..   ..B...B.G   ..B...B..   ..B...B..   ..B...B..
..BBBBB..   A.BBBBB.L   ..BBBBBG.   ..BBBBB..   ..BBBBB..   ..BBBBB..
.BBIBIBB.   .BBIBIBBL   .BBDBDBB.   LBBIBIBBL   .BBRBRBB.   .BBIBIBB.
.BBBDBBB.   .BBBDBBBB   .BBBDBBB.   BBBIIIBBB   .BBBDBBB.   .BBBDBBB.
..BBLBB..   ..BBLBBB.   ..BBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..
DBBBLBBBD   .BBBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..   .BBBLBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........
```

`discord-audit` (narrow, ears, belly; ears only appear with the fix), no hat:

```
running     needs       idle        done        crashed     none
..B...B..   A.B...B..   ..B...B.G   ..B...B..   ..B...B..   ..B...B..
..BBBBB..   A.BBBBB.L   ..BBBBBG.   ..BBBBB..   ..BBBBB..   ..BBBBB..
..BIBIB..   ..BIBIB.L   ..BDBDB..   L.BIBIB.L   ..BRBRB..   ..BIBIB..
..BBDBB..   ..BBDBB.B   ..BBDBB..   B.BIIIB.B   ..BBDBB..   ..BBDBB..
..BBLBB..   ..BBLBBB.   ..BBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..
DBBBLBBBD   .BBBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..   .BBBLBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........
```

## 7. Hats

| Hat | Shape | Color | Status |
|---|---|---|---|
| `none` | nothing; ears or antenna show | | Decided |
| `cap` | Canvas hat shape: crown `x 2..6, y 0` plus the two side pixels on row 1. Hides ears. | Personal: the repo's `dark` shade. Team: `crew.hat.team` teal. | Shape Decided (canvas), personal color Proposed |
| `bandana` | Band across row 1 `x 2..6` plus a knot tail at `(7,1)`, `(8,2)`. Ears and antenna stay visible. | The repo's `dark` shade | Proposed (CrewSheet offered "Bandana" but Crew.dc.html never drew one) |

Teal is reserved for team membership, so a personal hat can never be teal (Proposed). Why `dark` for personal hats: it is guaranteed distinct from the body at every slot and reads as "same character, dressed up" rather than as a new signal color.

`rustot` with a `cap`:

```
running     needs       idle        done        crashed     none
..HHHHH..   A.HHHHH..   ..HHHHH.G   ..HHHHH..   ..HHHHH..   ..HHHHH..
..HBBBH..   A.HBBBH.L   ..HBBBHG.   ..HBBBH..   ..HBBBH..   ..HBBBH..
..BIBIB..   ..BIBIB.L   ..BDBDB..   L.BIBIB.L   ..BRBRB..   ..BIBIB..
..BBDBB..   ..BBDBB.B   ..BBDBB..   B.BIIIB.B   ..BBDBB..   ..BBDBB..
..BBBBB..   ..BBBBBB.   ..BBBBB..   .BBBBBBB.   ..BBBBB..   ..BBBBB..
DBBBBBBBD   .BBBBBB..   .BBBBBBB.   ..BBBBB..   ..BBBBB..   .BBBBBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........
```

`fleetmates` with a `bandana` (the needs and done arms overwrite the knot tail, as intended):

```
running     needs       idle        done        crashed     none
..B...B..   A.B...B..   ..B...B.G   ..B...B..   ..B...B..   ..B...B..
..HHHHHH.   A.HHHHHHL   ..HHHHHG.   ..HHHHHH.   ..HHHHHH.   ..HHHHHH.
.BBIBIBBH   .BBIBIBBL   .BBDBDBBH   LBBIBIBBL   .BBRBRBBH   .BBIBIBBH
.BBBDBBB.   .BBBDBBBB   .BBBDBBB.   BBBIIIBBB   .BBBDBBB.   .BBBDBBB.
..BBLBB..   ..BBLBBB.   ..BBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..
DBBBLBBBD   .BBBLBB..   .BBBLBBB.   ..BBLBB..   ..BBLBB..   .BBBLBBB.
...BBB...   ...BBB...   ...BBB...   ...BBB...   .D.BBB.D.   ...BBB...
...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...   ...D.D...
.........   .........   .........   .........   .........   .........
```

## 8. Sizes

Rendered size is `cell * 9`. Only integer cells are allowed, so edges stay crisp.

| Token | Size | Cell | Use | Status |
|---|---|---|---|---|
| `crew.size.sm` | 27px | 3 | Cards, list rows, palette rows, request rows, quiet cards, Settings. Minimum readable size. | Decided |
| `crew.size.md` | 36px | 4 | Session card and page headers, team crew tiles | Decided |
| `crew.size.lg` | 45px | 5 | Research form dialog, FirstRun hero (was 54px) | Proposed |
| `crew.size.xl` | 72px | 8 | HomeCalm hero and CrewSheet grid (were 63px), Customize preview (was 108px) | Proposed |

Nothing smaller than 27px: below 3 device pixels per cell the poses stop reading (CrewSheet "At card size (27px), poses still read"). Four sizes are enough; the 54, 63 and 108px canvas sizes each had one use.

## 9. Rendering (Proposed: inline SVG)

Render one `<svg>` per avatar:

```jsx
<svg width={size} height={size} viewBox="0 0 9 9" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
  {runs.map((r) => <rect key={r.key} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />)}
</svg>
```

- Merge horizontal runs of the same color in a row into one `<rect>` (the `rustot` running figure has 35 painted cells and 17 runs).
- Memoise the run list on `(seed, slot, pose, hat)`; it is pure.

Why SVG over the alternatives:

- **vs. absolutely positioned spans** (the canvas approach): 30 to 45 DOM nodes per avatar, and a Home screen shows around 30 avatars. SVG is one element with a handful of rects.
- **vs. `<canvas>`**: canvas needs manual devicePixelRatio handling, redraw on zoom, and has no DOM for tests or accessible naming. SVG scales with CSS zoom and browser zoom for free, and Playwright can snapshot the rects.
- **vs. CSS grid of 81 cells**: 81 nodes, and grid gaps can open hairline seams at fractional zoom.
- `shape-rendering="crispEdges"` keeps pixel edges hard. At fractional device pixel ratios (1.25, 1.5) some cells render one device pixel wider than others; that is acceptable and identical in every technique short of pre-scaled bitmaps.

## 10. Accessibility

- Where a StatePill or a text label is next to the avatar (cards, rows, headers, palette), the avatar is decorative: `aria-hidden="true"`. Announcing it would repeat the state (Proposed).
- Where the avatar stands alone (CrewSheet, Customize preview), wrap it in `role="img"` with `aria-label="{repo} crew member, {pose label}"`, for example "rustot crew member, needs you". This keeps the canvas `aria-label` pattern.
- Pose is never the only signal (Decided). Color is never the only identity signal: the repo name is always rendered next to the avatar.
- The avatar does not animate. The breathe and pulse motions live on the pill dot and the card, not on the pixels (Proposed), so reduced motion needs nothing here.

## 11. Test vectors

Computed by running the fixed algorithm in Node (`fnv1a` above, unsigned shifts). "ears (canvas)" shows what the buggy signed shift produced, for regression awareness. `h % 9` is the shared-slot fallback of section 4.3.

| seed | h (uint32) | hex | wide | ears (fixed) | ears (canvas) | belly | h % 9 |
|---|---|---|---|---|---|---|---|
| `rustot` | 1585975556 | 0x5e881104 | false | 1 | 1 | false | 2 |
| `vault-mcp` | 3556031730 | 0xd3f4bcf2 | true | 1 | 0 | false | 6 |
| `discord-audit` | 2232665825 | 0x8513c6e1 | false | 2 | -2 | true | 5 |
| `andreymudri.com` | 1819880466 | 0x6c792c12 | true | 0 | 0 | false | 6 |
| `turbidassist` | 469188720 | 0x1bf74070 | true | 0 | 0 | false | 0 |
| `rustot-client` | 3212619052 | 0xbf7cad2c | false | 2 | -2 | false | 4 |
| `axios-like` | 1415994239 | 0x54665b7f | true | 2 | 2 | true | 2 |
| `fleetmates` | 789283731 | 0x2f0b8393 | true | 2 | 2 | true | 3 |

Unit tests to ship with the component (Proposed):

1. `fnv1a` and the three bits match every row above.
2. `paint('rustot', pose)` and `paint('fleetmates', pose)` match the ASCII maps in section 6.2 for all six poses, compared as strings.
3. `paint('rustot', pose, 'cap')` and `paint('fleetmates', pose, 'bandana')` match section 7.
4. The shade table in section 4.4 matches `mix` for all ten bodies.
5. Slot assignment: with slots 0 to 7 held, a new repo gets 8; with all nine held, a new repo gets `h % 9` and `crewSlotShared = true`; archiving the holder of slot 4 moves the oldest shared repo to slot 4.
6. Row 8 is empty for every seed, pose and hat.

## 12. Open items

- Slot 8 and the removal of the three CrewSheet swatches (section 4.1).
- The more-than-nine rule and the 30-day release (sections 4.2, 4.3).
- Teammate shade formula replacing the hand-picked canvas oranges (section 5).
