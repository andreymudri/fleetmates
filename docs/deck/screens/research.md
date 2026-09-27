# Research (form and draft review)

| | |
|---|---|
| Canvas boards | `ResearchForm` (launch form dialog over Memory), `ResearchReview` (draft review) |
| Routes | `/research/new` (dialog over the previous route; query `topic`, `miss`), `/research/:id` (review, or progress while running) |
| Milestone | M6 |
| Status | Decided (form fields, presets, draft-review-save flow, 3-file commit, source rules), Proposed (states, progress view), Open where the run output contract and vault-mcp preview do not exist yet |

## 1. Purpose

- Form: **"Send a fleetmates team to research a topic, sized to how deep I need it, without duplicating notes I already have."**
- Review: **"Is this draft true, well sourced and ready to become a note, and what exactly will saving write?"** Nothing is written until approved (Decided).

## 2. Route and entry points

| Entry | Result |
|---|---|
| Memory "Research a topic" | `/research/new` over `/memory` |
| Memory miss "Research this", Home calm "Research this", Misses view | `/research/new?topic=<question>&miss=<id>` |
| Palette `> research <topic>`, "Research \"…\"" row | `/research/new?topic=` |
| Meetings action item "Research first" | `/research/new?topic=<item text>` |
| Home research card title, Focus list research row header link, done notification "The scouts made port" | `/research/:id` |
| Failed card "Send scouts again" | `/research/new` prefilled from the failed run |

`/research/new` renders over the route it was opened from (background location); a direct load renders over `/memory`. Esc or Cancel returns to the previous route.

## 3. Layout

### 3.1 Form (dialog)

Dialog `variant="form"` (`--layout-dialog`, `--radius-3xl`), top 110px, over the scrim. Stack: header (CrewAvatar lg research + title + subtitle), Topic, info Banner, Depth radio cards (3 columns), Target domain + Source types (2 columns), Focus notes, footer (note left, Cancel + submit right). Identical at 1920, 1440, 1280; height under 900: the dialog body scrolls, header and footer stay (Proposed).

### 3.2 Review

| Region | Component / token | Notes |
|---|---|---|
| Header | PageHeader `size="lg"`: CrewAvatar md (research, done pose, team hat), h1, subtitle, StatePill `draft` | Rail active = memory |
| Draft | `article aria-label="Draft note"`, padding `--space-28 --space-56`, prose column max `--layout-readable` | frontmatter well, h2, prose, table, Sources list |
| Sources | `aside aria-label="Sources"`, width `--layout-panel-md` | SourceCard list, footer with notes and actions |

| Width | Behaviour (design-system 8.3) |
|---|---|
| 1920 | draft + sources 600 |
| 1440 | sources `--layout-panel-sm` (440) |
| 1280 | sources 440, draft padding `--space-28` |

## 4. Content inventory

### 4.1 Form

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Crew | CrewAvatar lg, color `crew.research`, team hat | | | `aria-hidden` |
| Title | Dialog title | | "Send out scouts" | themed, form dialog title (components Dialog) |
| Subtitle | Dialog description | | "A fleetmates team researches, you review the draft before anything is saved." | |
| Topic | Field TextInput `lg`, required | `research.topic` | label "Topic", value from `?topic=` | initial focus |
| Existing notes | Banner `info` with NoteChip `inline` | `vault_search(topic)` top hits over a threshold, debounced 400ms → `research.existingNotes` | "You already have 2 notes on this: locks-redis, timeout-de-fila. The research becomes a new note linked to them." | hidden when none |
| Depth | RadioGroup cards (fieldset + legend) | `research.preset` | legend "Depth"; "Quick" / "1 scout · ~6 sources · ~5 min"; "Standard" / "3 scouts · ~12 sources · ~15 min" (default); "Deep" / "5 scouts · ~25 sources · ~40 min" | numbers illustrative (RES-O4) |
| Target domain | Select | domains = directories under `02-wiki/` (from `vault_list` paths); suggested = domain of the top existing note | "concorrencia (suggested)", other domains, "New domain…" | "New domain…" reveals a TextInput "Domain name" |
| Source types | Checkbox group (fieldset) | `research.sourceTypes[]` | legend "Source types": "Official docs", "Repos", "Blogs", "Papers" | at least one required |
| Focus notes | Textarea (rows 3), optional | `research.focusNotes` | label "Focus notes" + hint "optional" | |
| Footer note | text muted | | "Runs on your subscription · shows up on the Sessions grid" | |
| Cancel | Button `secondary lg` | | "Cancel" | |
| Submit | Button `primary lg` + Kbd | | "Send scouts" + `Alt Enter` | themed launch verb (design-system 15.1, Open) |

### 4.2 Review

| Element | Component | Data binding | Copy |
|---|---|---|---|
| Title | h1 | `research.topic`, themed | "The scouts made port: advisory locks vs Redis locks" |
| Subtitle | MetaLine | `preset`, scouts, duration, cited and rejected counts, `preview.action`/`preview.domain` | "Standard · 3 scouts · 23 min · 5 sources cited, 1 rejected · new note in concorrencia" |
| Pill | StatePill `draft` | `research.state` | "Draft · not saved" |
| Frontmatter | mono well | `research.draft.frontmatter` as it will be written (from `preview.files[role=note].diff`) | "tipo: wiki", "tags: [...]", "criado: 2026-09-26" (RES-O2 for status and source keys) |
| Note body | sanitised markdown (react-markdown without raw HTML), `lang` per content | `research.draft.body` | h2, paragraphs, table, "Sources" list |
| Citations | Citation `superscript` | `[n]` markers in the body | "[1]" |
| Wikilinks | NoteChip `inline` (missing target: dashed, "Not in your vault yet") | `[[target]]` | "locks-redis" |
| Orphan highlights | background `color.amber.900` on sentences citing an unchecked source + amber `[n]` | `sources[].kept=false` | |
| Sources header | h2 + muted line | | "Sources", "Why each was picked and what it backs" |
| Source card | SourceCard | `draft.sources[]`: `n`, `title`, `url` (middle-truncated), `why`, `backs[]`, `kept` | "[1] Explicit Locking · Advisory Locks", "Why: primary docs for lock lifetime", "Backs: session locks release when the connection ends" |
| Rejected source | SourceCard `rejectedByScout`, no number, "Rejected" label | `draft.rejected[]`: `url`, `reason` | "Top 10 locking tricks (listicle)", "Why: scout 2 flagged: no benchmarks, contradicts [1]", "Backs: nothing in the note relies on it" |
| Footer note 1 | text muted | | "Unchecking a source highlights every sentence that cites it, so nothing loses support silently." |
| Footer note 2 | text muted, mono paths | `preview.files[]` in order (note, moc, index, daily) | "Save writes 3 files in one commit: 02-wiki/concorrencia/advisory-locks-vs-redis-locks.md, the concorrencia MOC and today's daily note." |
| Daily note footnote | text muted | | "Times in the daily note are set when you save." |
| Discard | Button `danger lg` | | "Discard" |
| Edit first | Button `secondary lg` | | "Edit first" |
| Save | Button `primary lg`, grows | | "Save to vault" |

### 4.3 Running view (Proposed, not on the canvas)

When `/research/:id` opens while `state = running`: the same header with pill "Running" (compass), the draft column shows ProgressBar (indeterminate until RES-O1) with "Scouting · drafting the note", and the sources column lists sources as they arrive (if the run output provides them) or "Sources appear when the scouts report back." Actions: "Open lead session" (Focus) and "Stop run…" (`danger`).

## 5. States

### 5.1 Form (state-machines 7.2)

| State | What shows |
|---|---|
| `form.editing` | as 4.1; Standard preselected |
| `form.checking_existing` | callout area keeps its previous content; a muted "Checking your vault…" line replaces it only after 1s (no flicker) |
| Validation | Topic under 3 characters: Field error "Enter at least 3 characters."; new domain without a name: "Name the new domain."; no source type: "Pick at least one source type." Errors show on submit and then live |
| `form.submitting` | "Send scouts" `loading`; fields read-only |
| Creation failed | Banner `error` at the top of the form body: "The research could not start: {reason}." inputs kept; focus moves to the banner |
| vault-mcp down | the form still opens; existing-notes check skipped with a muted line "Could not check your vault for existing notes." Domain Select falls back to a TextInput (Proposed). Submit allowed (the run can proceed; preview and save will wait, state-machines 5.4) |
| deckd down | submit disabled with "deckd is reconnecting" (the lead session needs a PTY) |
| Cancelled | form draft kept in sessionStorage for 10 minutes (state-machines row 5) |

### 5.2 Review

| State | What shows |
|---|---|
| `running` | 4.3 |
| `drafted.previewing` | draft renders; sources render; footer note 2 is a skeleton line; Save disabled with "Preparing the preview…" |
| `drafted.ready` | as 4.2; Save enabled |
| `drafted.stale` | footer line "Preview out of date, updating…"; Save disabled |
| `drafted.preview_error` (`learn.unknownDomain`) | inline Banner in the footer: "Creates a new domain concorrencia in 02-wiki. Confirm?" + "Confirm new domain" |
| `drafted.preview_error` (other) | Banner `error` with the vault-mcp error text literally + "Retry" |
| Orphan citations | Save disabled with reason "2 sentences still cite unchecked source [3]. Edit them or re-check the source." |
| `drafted.saving` | Save `loading`; other buttons disabled |
| `saved` | toast "Saved to your vault: {path}" + "Open"; the page switches to read-only with pill "Saved" (Proposed) and "Open in Memory" |
| Saved to a different path | notice "Saved to a different place than the preview showed: {path}" + "Open" |
| Save error | Banner `error` "Could not save: {message}. Your draft is safe here." draft kept; write race re-previews |
| vault-mcp down while drafted | Save disabled: "vault-mcp is down. Your draft is safe here." |
| `discarded` | page shows "Draft discarded. Nothing was written to your vault." + "Back to Memory" |
| `failed` | "The scouts ran aground" + reason + "Send scouts again"; partial sources listed if any |
| Edit first | draft becomes an editable Textarea with the markdown source (monospace), "Done editing" returns to preview mode (Proposed) |
| Overflow | long draft scrolls in its column; many sources scroll in the aside; long URLs middle-truncate with full URL in `title` |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Topic typing | existing-notes check after 400ms | `GET /api/vault/search?q=` (vault_search) = `V.searchResult` |
| Depth arrow keys | select preset | client |
| Domain "New domain…" | reveals the name field | client |
| "Send scouts", `Alt Enter` | validate then create the run | `POST /api/research` = `U.SendScouts` (state-machines 7.3 rows 4, 6) |
| "Cancel", Esc | close; draft kept 10 min | `U.Cancel` |
| Source checkbox | toggle kept; highlights orphan sentences; re-preview after 800ms | `U.ToggleSource` → `T.RePreview` → `POST /api/research/:id/preview` (vault_learn `preview`) |
| "Edit first" | edit mode; changes re-preview after 800ms | `U.EditDraft` |
| "Confirm new domain" | re-preview with `confirm_novo_dominio: true` | `U.ConfirmNewDomain` |
| "Save to vault" | same params as the last preview, without `preview` | `POST /api/research/:id/save` = `U.Save` |
| "Discard" | confirm Dialog "Discard this draft? Nothing was written to your vault." | `U.Discard` |
| `[n]` superscript | scrolls the aside to source n and focuses it | client |
| Wikilink chip | opens the note in Memory (new tab of the deck state, keeps the draft) | route |
| "Stop run…" (running) | confirm; stops the lead session | `U.StopRun` |

## 7. Real-time updates

| Event | Effect |
|---|---|
| `research.updated` (run output files, SM-O15) | running view progress and sources; transition to drafted |
| `research.preview` | footer file list, action, domain |
| `research.saved` | toast, read-only state, Home card collapses to "Saved" |
| `health.changed` (vault-mcp) | Save disabled or enabled |
| Motion | orphan highlight fades in 160ms; Save enable/disable colour 100ms |

## 8. Accessibility

- Form: native `<dialog>` or `role="dialog"` + `aria-modal`, labelled by the title and described by the subtitle; initial focus Topic; `fieldset`/`legend` for Depth and Source types; errors via `aria-invalid` + `aria-describedby`; Esc cancels; focus returns to the trigger.
- Review: h1 title; draft `article` with its own h2; Sources `aside` with h2.
- Unchecking a source announces politely "2 sentences now cite an unchecked source" (Proposed); highlighted sentences also get an `.sr-only` "(unsupported)" suffix so the state is not colour-only.
- Superscripts are links named "Source 1".
- The Save disabled reason is visible text, not only a tooltip.
- Draft content language: `lang="pt-BR"` when the draft is Portuguese (detected from the vault language setting, Proposed).

## 9. Copy deck

| Key | EN |
|---|---|
| `research.form.title` | Send out scouts |
| `research.form.subtitle` | A fleetmates team researches, you review the draft before anything is saved. |
| `research.form.topic` | Topic |
| `research.form.topic.error` | Enter at least 3 characters. |
| `research.form.existing` | You already have {n, plural, one {# note} other {# notes}} on this: {notes}. The research becomes a new note linked to them. |
| `research.form.checking` | Checking your vault… |
| `research.form.checkFailed` | Could not check your vault for existing notes. |
| `research.form.depth` | Depth |
| `research.form.depth.quick` | Quick |
| `research.form.depth.quick.sub` | 1 scout · ~6 sources · ~5 min |
| `research.form.depth.standard` | Standard |
| `research.form.depth.standard.sub` | 3 scouts · ~12 sources · ~15 min |
| `research.form.depth.deep` | Deep |
| `research.form.depth.deep.sub` | 5 scouts · ~25 sources · ~40 min |
| `research.form.domain` | Target domain |
| `research.form.domain.suggested` | {domain} (suggested) |
| `research.form.domain.new` | New domain… |
| `research.form.domain.newName` | Domain name |
| `research.form.domain.error` | Name the new domain. |
| `research.form.sources` | Source types |
| `research.form.sources.docs` | Official docs |
| `research.form.sources.repos` | Repos |
| `research.form.sources.blogs` | Blogs |
| `research.form.sources.papers` | Papers |
| `research.form.sources.error` | Pick at least one source type. |
| `research.form.focus` | Focus notes |
| `research.form.optional` | optional |
| `research.form.footer` | Runs on your subscription · shows up on the Sessions grid |
| `research.form.cancel` | Cancel |
| `research.form.submit` | Send scouts |
| `research.form.startError` | The research could not start: {reason}. |
| `research.form.deckdDown` | deckd is reconnecting |
| `research.review.title` | The scouts made port: {topic} |
| `research.review.meta.scouts` | {n, plural, one {# scout} other {# scouts}} |
| `research.review.meta.sources` | {cited} sources cited, {rejected} rejected |
| `research.review.meta.newNote` | new note in {domain} |
| `research.review.meta.append` | added to {path} |
| `research.review.sources` | Sources |
| `research.review.sources.sub` | Why each was picked and what it backs |
| `research.review.why` | Why: |
| `research.review.backs` | Backs: |
| `research.review.rejected` | Rejected |
| `research.review.notInVault` | Not in your vault yet |
| `research.review.uncheckNote` | Unchecking a source highlights every sentence that cites it, so nothing loses support silently. |
| `research.review.saveWrites` | Save writes {n} files in one commit: {note}, the {domain} MOC and today's daily note. |
| `research.review.saveWrites.index` | Save writes {n} files in one commit: {note}, the {domain} MOC, the knowledge index and today's daily note. |
| `research.review.dailyTime` | Times in the daily note are set when you save. |
| `research.review.preparing` | Preparing the preview… |
| `research.review.stale` | Preview out of date, updating… |
| `research.review.newDomain` | Creates a new domain {domain} in 02-wiki. Confirm? |
| `research.review.confirmDomain` | Confirm new domain |
| `research.review.orphans` | {n, plural, one {# sentence still cites} other {# sentences still cite}} unchecked source [{source}]. Edit them or re-check the source. |
| `research.review.orphansAnnounce` | {n, plural, one {# sentence now cites} other {# sentences now cite}} an unchecked source |
| `research.review.unsupported` | (unsupported) |
| `research.review.discard` | Discard |
| `research.review.discard.title` | Discard this draft? |
| `research.review.discard.body` | Nothing was written to your vault. |
| `research.review.discarded` | Draft discarded. Nothing was written to your vault. |
| `research.review.edit` | Edit first |
| `research.review.doneEditing` | Done editing |
| `research.review.save` | Save to vault |
| `research.review.saved` | Saved to your vault: {path} |
| `research.review.savedElsewhere` | Saved to a different place than the preview showed: {path} |
| `research.review.saveError` | Could not save: {message}. Your draft is safe here. |
| `research.review.vaultDown` | vault-mcp is down. Your draft is safe here. |
| `research.review.open` | Open |
| `research.review.openMemory` | Open in Memory |
| `research.review.back` | Back to Memory |
| `research.running.progress` | Scouting · drafting the note |
| `research.running.waitSources` | Sources appear when the scouts report back. |
| `research.running.openLead` | Open lead session |
| `research.running.stop` | Stop run… |
| `research.failed.title` | The scouts ran aground |
| `research.failed.again` | Send scouts again |
| `research.pill.saved` | Saved |

## 10. Acceptance criteria

1. **Given** `/research/new?topic=Postgres%20advisory%20locks%20vs%20Redis%20locks%20for%20job%20dedup` over Memory with fixture `vault22`, **then** the dialog opens with Topic focused and filled, Standard selected, and within 1s the callout names "locks-redis" and "timeout-de-fila".
2. **Given** Topic "ab", **when** pressing `Alt Enter`, **then** no request is sent and the Topic field shows "Enter at least 3 characters." with `aria-invalid="true"`.
3. **Given** a valid form, **when** pressing `Alt Enter`, **then** `POST /api/research` carries topic, preset `standard`, domain, source types and focus notes, and a research card appears on Home with a dashed border.
4. **Given** fixture `researchDrafted`, **when** opening `/research/:id`, **then** the pill reads "Draft · not saved", 5 numbered sources and 1 "Rejected" source render, and Save is disabled until the preview arrives.
5. **Given** the preview returned 3 files, **then** the footer reads "Save writes 3 files in one commit: 02-wiki/concorrencia/advisory-locks-vs-redis-locks.md, the concorrencia MOC and today's daily note."
6. **Given** unchecking source [3], **then** every sentence citing [3] gets the highlight and the sr-only "(unsupported)" text, Save is disabled with the orphan reason, and a re-preview request is sent 800ms after the last change.
7. **Given** a preview error `learn.unknownDomain`, **then** "Confirm new domain" appears; clicking it re-previews with `confirm_novo_dominio: true`.
8. **Given** Save succeeds with the same path, **then** a toast reads "Saved to your vault: {path}" and the Home card shows "Saved".
9. **Given** "Discard" and confirm, **then** no vault write request is sent and the page reads "Draft discarded. Nothing was written to your vault."
10. **Given** fixture `vaultDown` while drafted, **then** Save is disabled with "vault-mcp is down. Your draft is safe here."
11. **Given** a draft body containing raw HTML, **then** it renders as text or is dropped by the sanitiser; no element from the draft executes.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| RES-O1 | Research run output contract: where the lead writes the draft, sources, rejected sources, stats and progress (SM-O15). | **Open** (M6). Default: no progress percentage; running view indeterminate. |
| RES-O2 | Frontmatter on the canvas (`status: draft`, `source: research`) cannot be written by `vault_learn` (params are `titulo`, `insight`, `contexto`, `dominio`, `projeto`, `tags`, `links`; it writes `tipo: wiki`, `tags`, `criado`). A `status: draft` key would also stay "draft" after save. | **Open**. Default: preview shows exactly what `vault_learn` will write; `source: research` carried as a tag `research` (Proposed) until vault-mcp accepts extra frontmatter. |
| RES-O3 | `vault_learn` `preview: true` is a proposal, not in vault-mcp v0.3.0 (integration contract 1.10). | **Open** (M6 dependency). Without it, Save is unavailable; the deck must never write without a preview (Decided). |
| RES-O4 | Preset sizes (scouts, sources, minutes) are illustrative (D-26 fixes the presets, not their sizes). | **Open**. |
| RES-O5 | Decided "existing topic gets a new linked note", but `vault_learn` may decide to append to an existing note (duplicate check ratio 1.8). | **Open**. Default: show the preview's decision honestly ("added to {path}" in the subtitle) and let the user Save or Discard. |
| RES-O6 | Which repo a research run lives in (it is a fleetmates run, which needs a repo) (SM-O15). | **Open**. |
| RES-O7 | Themed buttons "Send scouts" (design-system 15.1). | **Open**. |

## 12. Changes from the canvas

1. The rejected source's dash glyph number becomes a "Rejected" label (design-system 14).
2. The existing-notes callout moves from a custom callout to Banner `info` (components Coverage 2.21).
3. The footer file list is built from `preview.files` and grows to 4 files for a new domain (the index is also touched).
4. A daily-note time footnote is added (state-machines 7.4).
5. Frontmatter preview shows what will really be written (RES-O2), not `status: draft`.
6. The running view, failed, discarded and saved states are new.
7. Crew sizes: form avatar 45px (was 54), header avatar 36px (crew.md 8).
