# Meetings (list, detail, live)

| | |
|---|---|
| Canvas boards | `Meetings` (list + detail), `MeetingLive` (recording bar, live transcript, ask panel) |
| Routes | `/meetings` (list; selects the newest meeting), `/meetings/:id` (detail; `id` = TurbidAssist `session_id`), `/meetings?q=<search>`, `/meetings/live` (live view; redirects to `/meetings` when nothing is recording) |
| Milestone | M4 (do not start before M1 passes its one-week test, D-44) |
| Status | Decided (layout, sections, Record behaviour, quiet mode copy), Proposed (states and data mapping), several Open items where TurbidAssist has no such data (pins, live title, source label, live decisions, vault in live ask) |

Meeting content (transcripts, summaries, decisions, action items, pins) is PT-BR and stays PT-BR; chrome follows `DECK_LANG` (Decided). Every content node carries `lang="pt-BR"`.

## 1. Purpose

- List and detail: **"What was decided in that meeting, what do I owe, and where was X said?"**
- Live: **"Record this call, follow what is said, mark the important moments and ask without leaving the call."**

## 2. Route and entry points

| Entry | Result |
|---|---|
| Rail "Meetings" (`Alt Shift 3`) | `/meetings/live` while recording, else `/meetings` |
| Record → tag menu → start | `/meetings/live` after `SC.ok(start)` |
| Recording bar title (any screen) | `/meetings/live` |
| Home calm "Last meeting" | `/meetings/:id` |
| Recording started by another client (scribe CLI, TUI, Hyprland bind) | rec bar appears on every screen (state-machines 6.3 row 11); no automatic navigation |

## 3. Layout

### 3.1 List + detail

| Region | Component / token | Notes |
|---|---|---|
| List | `aside aria-label="Meetings"`, width `--layout-panel-sm`, `bg.sidebar` | h1 "Meetings", Record button, search Field + helper, day groups of ListRow |
| Detail | `main`, padding `--space-32 --space-48` | title row + 2-column grid `minmax(0,1.25fr) minmax(0,1fr)` |

| Width | Behaviour (design-system 8.3) |
|---|---|
| 1920 | list 440 + detail 2 columns |
| 1440 | detail 1 column (Action items move under Summary, before Pinned moments, Proposed) |
| 1280 | list 360 (Proposed exception), detail 1 column |

### 3.2 Live

| Region | Component / token | Notes |
|---|---|---|
| Recording bar | Banner `recording`, height `--layout-rec-bar`, above the whole shell | owned by AppShell ([rail-and-shell.md](rail-and-shell.md)); Rail height follows the viewport minus the bar |
| Transcript | `section aria-label="Live transcript"`, padding `--space-24 --space-40` | h1 + meta, TranscriptLine list |
| Ask | `aside aria-label="Ask during the meeting"`, width `--layout-panel-md` | AskThread + Pins list |

| Width | Behaviour |
|---|---|
| 1920 | transcript + ask 600 |
| 1440 | ask 440 |
| 1280 | ask 440; rec bar hides "Sound muted while recording · popups still show" behind an info icon with Tooltip (Proposed) |

## 4. Content inventory

### 4.1 List

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Title | h1 | | "Meetings" | |
| Record | Button `secondary` with an 8px red dot (outline; red fill only while recording, Decided) | recorder machine `idle` | "Record" | hidden while recording; replaced by "Recording · Open" link |
| Tag menu | popover menu (listbox) | tags = keys of `synthesis.tag_policies` from TurbidAssist `config.yaml`; `default_tag` preselected; confidential = `store_transcript: false` | "pessoal", "client-a · transcript not stored", "client-b · transcript not stored" | state-machines 6.3 row 3 |
| Search | Field TextInput `lg`, sr label "Search transcripts" | `q` | placeholder "Search transcripts" | |
| Search helper | text muted | hit count across meetings | "4 hits in 2 meetings" | |
| Day group | Eyebrow `h2` | `startedAt` local day | "Today", "Yesterday", "Thursday", then dates | `Intl.RelativeTimeFormat` / weekday |
| Meeting row | ListRow `role="link"` | title (4.1.1), start time, meta, optional hit snippet | "Client A · weekly sync", "14:00", "Teams · 42 min · 3 action items", "…o feature flag liga primeiro no beta interno…" | selected `aria-current` |
| Post-state line | ListRow subtitle | manifest `state` (state-machines 6.4) | "Saving the session…", "Transcribing with large-v3…", "Summarizing…", "Needs speaker names", "Summary failed" | replaces the meta while not synthesized |

#### 4.1.1 Meeting title and meta (Proposed)

- Title: synthesized: "{Tag} · {note title}" from the vault note H1 (written by postmeet); before synthesis: "{Tag} · {start time}". `{Tag}` is the tag capitalised ("Client A").
- Meta: source label (MEET-O1) · duration (`ended_at - started_at` from `session.json`) · action item count (from the note's "## Action items", excluding the "Nenhum action item registrado." placeholder).

### 4.2 Detail

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Title | h2 `type.heading-detail` (the page h1 is the list title) | 4.1.1 | "Client A · weekly sync" | |
| Meta | MetaLine | day, time, duration, speakers (batch `transcript.json` speaker set: mic + room speakers), ASR model (`batch.model` from config) | "Today 14:00 · 42 min · Você + 3 speakers on Sala · transcribed with large-v3" | |
| Open note | Button `secondary` | `notePath` (4.2.1) | "Open note in Obsidian" | |
| Full transcript | Button `secondary` | `transcript.md` (batch) or `transcript.jsonl` (live) | "Full transcript" | opens a Drawer with TranscriptLine list; confidential: read from disk each time, never cached (MEET-O7) |
| Summary | Eyebrow + prose | note "## Resumo" | "Summary" + PT-BR text | |
| Decisions | Eyebrow + list with Icon `check` | note "## Decisões" items ("Nenhuma decisão registrada." renders as the muted empty line) | "Decisions" | |
| Pinned moments | Eyebrow + PinnedMoment `quote` | deck-stored pins (MEET-O2) with the transcript line text (time only for confidential tags) | "Pinned moments", "18:11 · Sala", "\"Cinco por cento no beta…\"" | hidden when no pins |
| In-meeting hits | Eyebrow + TranscriptLine `hit` | search `q` within this meeting | "\"feature flag\" in this meeting · 2 hits" | only with a query |
| Action items | Eyebrow + ActionItemCard `card` | note "## Action items" lines `- [ ] Responsável: o que fazer` → `owner` = text before the first ":" when present | "Action items", "Ligar o feature flag da 3.2 no beta interno", "Você · até quarta" | |
| Item actions | Button `primary sm` + `ghost sm` | | "Launch as session" (MEET-O6), "Dismiss" or "Research first" | secondary action: "Research first" when the item reads like a research task is a canvas example; Proposed rule: both "Dismiss" and "Research first" are always offered via a small overflow, primary shown per canvas. In M4 "Research first" is not rendered, because the research form is M6 (D-113) |
| Awaiting names | Banner `hint` | state `awaiting_names` | "Needs speaker names. Run: postmeet name {session}" + "Copy" | SM-O14 |
| Summary failed | Banner `error` | deck-derived `stuck` flag | "Summary failed. The batch log stopped at {time}." + "Open log" | |

#### 4.2.1 Note location

The meeting note lives in `<vault.path>/<vault.meetings_folder>/` with a file name built by postmeet from date, tag and title. The deck finds it by frontmatter `session_id`. In M4 the note is read from disk only, read only and limited to that folder (MTG-O1, D-114); the vault-mcp client is M5. Past meetings must load without vault-mcp (Decided). It is written by postmeet, not through vault-mcp.

### 4.3 Live

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Rec dot | `.motion-rec-pulse` | recorder `recording` | | |
| Label | text | | "Recording" | |
| Title | text | tag + start time (MEET-O3) | "Client A · started 14:00" (canvas "Client A · weekly sync") | |
| Timer | mono, `tabular-nums`, `aria-hidden` | `elapsed_s` from the 2s poll + local ticking | "19:14" (MM:SS total minutes, 02-domain 4) | canvas "00:19:14" |
| Quiet note | text | quiet mode on (Settings "quiet in meetings") | "Sound muted while recording · popups still show" | hidden when quiet mode is off |
| Pin | Button (danger ghost on red bar) + Kbd | | "Pin moment" + `Alt P` | deck-stored (MEET-O2) |
| Stop | Button `danger-confirm xs` | | "Stop and summarize" | |
| Title (transcript) | h1 | | "Live transcript" | |
| Meta | MetaLine muted | `event.asr_model` ("medium-int8" shown "medium · int8"), `event.lang` ("PT-BR"), lag = now − (start + newest `t1`) | "medium · int8 · PT-BR · ~1.2s behind" | |
| Lines | TranscriptLine `live` | `transcript` events: `t0` → offset MM:SS, `source` mic → "Você", room → "Sala", `text` | "17:40 Você Então o feature flag liga primeiro no beta interno, certo?" | pinned lines use the pinned style |
| Listening indicator | muted line at the bottom | recording and no new line for 5s | "Listening…" | replaces the canvas partial italic line (MEET-O5) |
| Ask eyebrow | Eyebrow | engine (MEET-O4, Decided, D-105) | "Ask · uses the transcript" | the vault variant needs TurbidAssist change T3, not taken |
| Ask thread | AskThread | scribed `ask` stream (`ask_delta`, `ask_done`) for the default engine; `history` on open | user and assistant messages | answers PT-BR |
| Answer actions | Buttons | | "Copy"; "Save answer to meeting note" (MEET-O8) | M4 applies the MEET-O8 default: no Save button, and for a non-confidential meeting the muted line "Answers are added to the meeting note when it is summarized." |
| Pins | Eyebrow + PinnedMoment `pin` | deck pins for this session | "Pins · 2", "18:11 cinco por cento no beta, todo mundo depois" | |
| Composer | Field `xl` + send | | placeholder "Ask without leaving the call", sr label "Ask during the meeting" | |

## 5. States

### 5.1 List and detail

| State | What shows |
|---|---|
| Loading | list: 5 ListRow skeletons; detail: title skeleton + 3 paragraph lines |
| Empty (no sessions in `session_dir`) | "No meetings yet. Press Record, or start one with scribe; it shows up here." |
| No search hits | helper "No hits for \"{q}\"." |
| scribed down | Record replaced by the degraded card in the list header area ("No one on the radio", [failures-and-loading.md](failures-and-loading.md) 4.5); list and detail still load from disk (Decided) |
| vault-mcp down | no effect in M4: the detail renders from the note file on disk, which is how M4 always reads notes (D-114) |
| TurbidAssist config not found | "TurbidAssist is not configured for the deck: config.yaml not found at {path}." + "Fix in Settings" |
| Post states | 4.1 post-state line; detail shows only what exists (transcript before the summary) |
| Confidential tag | detail shows summary, decisions, action items from the note; Full transcript reads from disk on demand with a muted note "Transcript not stored by the deck for {tag}" |
| Overflow | list scrolls; long titles 2 lines then ellipsis; many action items scroll the column; long transcripts in the drawer virtualise (Proposed) |

### 5.2 Live and recorder (state-machines 6.2)

| Recorder state | What shows |
|---|---|
| `unavailable` | degraded card; Record hidden; live route redirects to `/meetings` |
| `idle` | "Record" outline button |
| `starting` | Record button `loading` "Starting…"; after 20s "scribed did not confirm the start. Checking…" |
| `recording` | rec bar everywhere, live view, quiet mode on |
| `stopping` | rec bar neutral: "Stopping… saving the session"; after 60s "Still stopping, scribed is closing the session" |
| error toast | "scribed refused: {message}" (Portuguese message verbatim, `lang="pt-BR"`) |
| subscribe lost, scribed ok | lines resume; the gap is filled from `tail`; a muted divider "Reconnected · {n} lines recovered" |
| scribed down mid-recording | partial live view kept, banner "Connection to scribed lost" |
| Ask thinking | "Asking…" in the thread; Stop available |
| Ask error | "The ask did not finish: {message}." + "Try again" |
| Overflow | transcript auto-scrolls while the user is at the bottom; scrolling up pauses auto-scroll and shows "Jump to live" (Proposed) |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| "Record" | tag menu | `U.Record` |
| Pick a tag (Enter or click) | start | `POST /api/meetings/start {tag}` = `U.StartWithTag` → scribed `start` |
| "Pin moment" / `Alt P` (no terminal focus) | pin `{t: elapsed_s, label: newest line first 80 chars}`; for confidential tags (`store_transcript: false`) the pin stores the time only, no label ([04-integrations.md](../04-integrations.md) 4.2, [06-storage.md](../06-storage.md) 4.9); pins within 2s merge | `POST /api/meetings/:id/pins` = `U.Pin` |
| "Stop and summarize" | stop (no short timeout) | `POST /api/meetings/stop` = `U.StopAndSummarize` |
| Transcript line click | pins or unpins that line (Proposed) | `U.Pin` with that line's `t0` |
| Ask composer Enter | ask | scribed `ask` (default) = state-machines 8 flow with scope `meeting:<id>` |
| "Copy" | copies the answer text | clipboard |
| Search field | debounced 300ms search across transcripts | `GET /api/meetings/search?q=` |
| Row click | detail | route `/meetings/:id` |
| Hit row click | Full transcript drawer scrolled to the offset | client |
| "Open note in Obsidian" | `obsidian://open?...` | browser |
| "Full transcript" | drawer | `GET /api/meetings/:id/transcript` |
| "Launch as session" | new-session form with the item text as task, repo empty | route `/new?task=` (MEET-O6) |
| "Research first" | research form prefilled | route `/research/new?topic=` |
| "Dismiss" | item fades 160ms; toast "Dismissed" with "Undo" for 6s; stored in the deck DB | `POST /api/meetings/:id/items/:n/dismiss` |
| "Copy" (awaiting names) | copies `postmeet name {session}` | clipboard |
| "Open log" | shows `postmeet.log` tail in a Drawer | `GET /api/meetings/:id/log` |

## 7. Real-time updates

| Event | Effect |
|---|---|
| `meeting.status` (2s poll of scribed `status`, Decided direction) | rec bar, recorder state, quiet mode, other-client start and stop |
| `meeting.transcript` (subscribe) | append TranscriptLine; lag meta |
| `meeting.updated` (fs.watch + 10s poll on `session.json`) | post-state line, detail sections as they appear |
| `meeting.pins` | pinned styles and Pins list |
| `ask.delta` / `ask.done` | ask thread |
| `health.changed` (scribed) | unavailable state |
| Motion | rec dot pulse (`.motion-rec-pulse`); new lines appear without animation; pin style 100ms; reduced motion: static dot, "Recording" label and timer stay |

The bell is muted during recording; popups still show (quiet mode, state-machines 9.5).

## 8. Accessibility

- Recording bar: only "Recording started" and "Recording stopped" are announced; the timer is `aria-hidden`, with a static "Recording, started 14:00" exposed (components Banner). As built in 0.4.0 the bar is not `role="status"`: it is a `role="region"` landmark labelled "Recording", the two announcements go through the shell's polite live region (`shell.announce.recStart` and its pair), and while the bar shows it holds the shell's skip link as its first child, so the skip link stays the first focusable element and sits inside a landmark (M4-T17-F4, fixed by M4 Task 19).
- Transcript container `role="log"` with `aria-live="off"` and a toggle "Read new lines aloud" (components TranscriptLine), off by default.
- `lang="pt-BR"` on transcript lines, summaries, decisions, action items, pins and PT answers.
- Speakers are labelled in text ("Você", "Sala"), never colour only.
- Tag menu is a listbox; confidential tags say "transcript not stored" in text.
- Stop and summarize is a normal button (no confirm, Decided flow), but it is never the default of any form.
- Search hits use `mark` elements built from ranges (no injected HTML).

## 9. Copy deck

| Key | EN |
|---|---|
| `meetings.title` | Meetings |
| `meetings.record` | Record |
| `meetings.recordingOpen` | Recording · Open |
| `meetings.tag.confidential` | transcript not stored |
| `meetings.tag.menuLabel` | Record with tag |
| `meetings.tag.option` | {tag} · {note} |
| `meetings.starting` | Starting… |
| `meetings.startSlow` | scribed did not confirm the start. Checking… |
| `meetings.refused` | scribed refused: {message} |
| `meetings.search.label` | Search transcripts |
| `meetings.search.helper` | {hits, plural, one {# hit} other {# hits}} in {meetings, plural, one {# meeting} other {# meetings}} |
| `meetings.search.none` | No hits for "{q}". |
| `meetings.day.today` | Today |
| `meetings.day.yesterday` | Yesterday |
| `meetings.row.title` | {tag} · {title} |
| `meetings.row.meta.items` | {n, plural, one {# action item} other {# action items}} |
| `meetings.post.stopping` | Saving the session… |
| `meetings.post.recorded` | Transcribing with {model}… |
| `meetings.post.transcribed` | Summarizing… |
| `meetings.post.names` | Needs speaker names |
| `meetings.post.namesHint` | Needs speaker names. Run: postmeet name {session} |
| `meetings.post.interrupted` | Recording interrupted |
| `meetings.post.failed` | Summary failed |
| `meetings.post.failedBody` | Summary failed. The batch log stopped at {time}. |
| `meetings.post.openLog` | Open log |
| `meetings.copy` | Copy |
| `meetings.duration` | {n} min |
| `meetings.drawer.close` | Close |
| `meetings.toast.dismiss` | Dismiss |
| `meetings.empty` | No meetings yet. Press Record, or start one with scribe; it shows up here. |
| `meetings.noConfig` | TurbidAssist is not configured for the deck: config.yaml not found at {path}. |
| `meetings.fixInSettings` | Fix in Settings |
| `meetings.detail.meta.speakers` | Você + {n, plural, one {# speaker} other {# speakers}} on Sala |
| `meetings.detail.meta.model` | transcribed with {model} |
| `meetings.detail.openNote` | Open note in Obsidian |
| `meetings.detail.transcript` | Full transcript |
| `meetings.detail.summary` | Summary |
| `meetings.detail.decisions` | Decisions |
| `meetings.detail.pinned` | Pinned moments |
| `meetings.detail.hits` | "{q}" in this meeting · {n, plural, one {# hit} other {# hits}} |
| `meetings.detail.actions` | Action items |
| `meetings.detail.launch` | Launch as session |
| `meetings.detail.dismiss` | Dismiss |
| `meetings.detail.dismissed` | Dismissed |
| `meetings.detail.undo` | Undo |
| `meetings.detail.researchFirst` | Research first |
| `meetings.detail.confidentialNote` | Transcript not stored by the deck for {tag} |
| `meetings.live.recording` | Recording |
| `meetings.live.title` | {tag} · started {time} |
| `meetings.live.quiet` | Sound muted while recording · popups still show |
| `meetings.live.pin` | Pin moment |
| `meetings.live.stop` | Stop and summarize |
| `meetings.live.stopping` | Stopping… saving the session |
| `meetings.live.stillStopping` | Still stopping, scribed is closing the session |
| `meetings.live.heading` | Live transcript |
| `meetings.live.meta.lag` | ~{seconds}s behind |
| `meetings.live.listening` | Listening… |
| `meetings.live.self` | Você |
| `meetings.live.room` | Sala |
| `meetings.live.lost` | Connection to scribed lost |
| `meetings.live.recovered` | Reconnected · {n, plural, one {# line recovered} other {# lines recovered}} |
| `meetings.live.jump` | Jump to live |
| `meetings.live.readAloud` | Read new lines aloud |
| `meetings.live.started.a11y` | Recording started |
| `meetings.live.stopped.a11y` | Recording stopped |
| `meetings.live.static.a11y` | Recording, started {time} |
| `meetings.ask.eyebrow.transcript` | Ask · uses the transcript |
| `meetings.ask.eyebrow.both` | Ask · uses the transcript and your vault |
| `meetings.ask.placeholder` | Ask without leaving the call |
| `meetings.ask.label` | Ask during the meeting |
| `meetings.ask.asking` | Asking… |
| `meetings.ask.stop` | Stop |
| `meetings.ask.stopped` | Stopped here; the answer may still be saved to the meeting |
| `meetings.ask.retry` | Try again |
| `meetings.ask.error` | The ask did not finish: {message}. |
| `meetings.ask.save` | Save answer to meeting note |
| `meetings.ask.copy` | Copy |
| `meetings.ask.autoSaved` | Answers are added to the meeting note when it is summarized. |
| `meetings.pins.title` | Pins · {n} |

As built in 0.4.0, M4 added `meetings.tag.option` (the tag menu option of a confidential tag, whose note is "transcript not stored"), `meetings.post.interrupted` (a recording that ended without a stop), `meetings.duration`, `meetings.drawer.close`, `meetings.toast.dismiss`, and the ask `meetings.ask.stop`, `meetings.ask.stopped` and `meetings.ask.retry`. `meetings.ask.save` and `meetings.detail.researchFirst` are not rendered in M4 (MEET-O8, Q6). The recording bar strings live in `REC_COPY` of `hub/web/src/shell/RecBar.jsx`, the rest in the `*_COPY` objects of `hub/web/src/screens/meetings/`.

## 10. Acceptance criteria

1. **Given** fixture `meetings5` (the canvas five sessions, synthesized), **when** opening `/meetings`, **then** day groups read Today, Yesterday, Thursday and the first row is selected with detail "Client A · weekly sync".
2. **Given** search "feature flag", **then** the helper reads "4 hits in 2 meetings", hits render with `mark` elements, and the detail shows "\"feature flag\" in this meeting · 2 hits".
3. **Given** clicking Record, **then** a menu lists the tags from the fixture `config.yaml` with `pessoal` preselected and "transcript not stored" on confidential tags.
4. **Given** choosing `client-a`, **then** scribed receives `{"cmd":"start","tag":"client-a"}`, the button shows "Starting…", and on `ok` the route becomes `/meetings/live` and the rec bar shows "Recording".
5. **Given** scribed refuses with "sessão já ativa; pare a atual antes", **then** a toast shows "scribed refused: sessão já ativa; pare a atual antes".
6. **Given** a recording started by another client, **then** within 2s the rec bar appears on the current screen without navigation, and the bell stays silent for new requests while popups still fire.
7. **Given** recording, **when** pressing `Alt P` with no terminal focused, **then** a pin with the current elapsed seconds is stored and the newest line gets the pinned style; pressing again within 2s does not create a second pin.
8. **Given** "Stop and summarize", **then** the bar shows "Stopping… saving the session", status polls reporting `recording:false` are ignored until the stop call returns, and after 60s the "Still stopping" text appears.
9. **Given** a confidential tag recording, **when** the page is reloaded after the meeting, **then** the deck database contains no transcript text for that session (inspect via test API) and the live ask history is not persisted.
10. **Given** fixture `scribedDown`, **then** the list and detail still load; Record is replaced by the degraded card.
11. **Given** a manifest in `awaiting_names`, **then** the row reads "Needs speaker names" and the detail shows the `postmeet name` command with Copy.
12. **Given** transcript text containing `<b>` tags, **then** they render as literal text.
13. **Given** reduced motion, **then** the rec dot is static and "Recording" and the timer stay visible.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| MEET-O1 | Source label (Teams, Meet, Discord): `routed_apps` exists only in live `status`; `session.json` does not store it. Meetings recorded while the deck was not polling have no source. | Default shipped in 0.4.0, still the owner's to revisit before exit: the deck records `routed_apps` seen during polling into its own Meeting row; unknown shows no source item. |
| MEET-O2 | Pins are not in TurbidAssist (no command, event, file or field). The deck stores them; postmeet does not know them, so they never reach the vault note. | Default shipped in 0.4.0, still the owner's to revisit before exit: deck-stored pins shown in the deck only (TurbidAssist change T1 not taken). |
| MEET-O3 | Live meeting title: nothing names a meeting before synthesis; only the tag exists. | Default shipped in 0.4.0, still the owner's to revisit before exit: "{Tag} · started {time}". |
| MEET-O4 | Live ask "uses the transcript and your vault": scribed `ask` runs `claude -p` with no tools and no MCP servers, so it cannot read the vault (integration contract 2.6). | **Decided** 2026-10-04 (D-105): scribed `ask` (transcript only) with the eyebrow "Ask · uses the transcript" and no citations. No deck-side engine; TurbidAssist change T3 not taken. |
| MEET-O5 | Partial (in-progress) transcript lines: scribed emits whole ASR segments only. | Default shipped in 0.4.0, still the owner's to revisit before exit: no partial lines; "Listening…" after 5 s without a new line. |
| MEET-O6 | "Launch as session" from action items: "Tasks from meetings" was not selected in the scope question (D-29) but is designed (Q6); the item has no repo. | Default shipped in 0.4.0, still the owner's to revisit before exit: the button opens the new-session form with the task prefilled and the repo picker focused; "Dismiss" with Undo for 6 s; "Research first" not rendered until M6. |
| MEET-O7 | Transcript search for confidential tags: the deck must not persist transcript text for them (02-domain 2.6), but search needs text. | **Decided** 2026-10-04 (D-109): search includes confidential meetings, reading session files on demand for every tag; it never indexes, caches or persists their text. |
| MEET-O8 | "Save answer to meeting note": no protocol path exists. scribed already records `ask_done` answers in `asks.jsonl`, and postmeet renders them under "Perguntas ao vivo" only when `store_transcript` is true. | Default shipped in 0.4.0, still the owner's to revisit before exit: no Save button; with the scribed engine and a non-confidential tag show the muted line "Answers are added to the meeting note when it is summarized." |
| MEET-O9 | Live decisions and action items: not produced live (only by the batch). | Decided by data: the live view shows none. |
| MEET-O10 | "Start scribed" (SM-O13, FAIL-O1). | **Decided** 2026-10-04 with SM-O13 (D-106): `systemd-run --user --collect --unit=turbidassist-scribed --property=KillMode=process $SHELL -l -c 'exec scribed'`. |
| MEET-O11 | Where the deck finds TurbidAssist's `config.yaml` and `session_dir`. | **Decided** 2026-10-04 (D-107): Settings, Connections field "TurbidAssist config" (path), default `~/dev/turbidassist/config.yaml` when present; `session_dir` is read from it. |

## 12. Changes from the canvas

1. Rec bar title uses the tag and start time until MEET-O3 is decided.
2. Timer "00:19:14" becomes "19:14" (MM:SS total minutes, same format as transcript offsets and pins).
3. The partial italic line is replaced by "Listening…".
4. Ask eyebrow says "uses the transcript" and the vault citation and "Save answer to meeting note" button are removed (MEET-O4 Decided, D-105; MEET-O8 default applied in M4).
5. Ask panel 560 becomes 600 (`--layout-panel-md`).
6. Recording bar tertiary text colour follows tokens (design-system 14).
7. Tag menu, post-state lines, awaiting-names and summary-failed states are new.
