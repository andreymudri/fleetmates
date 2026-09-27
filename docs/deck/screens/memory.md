# Memory (graph, ask thread, note panel)

| | |
|---|---|
| Canvas boards | `MemoryV1` (clustered overview + ask thread), `MemoryNote` (local graph on click + note panel) |
| Routes | `/memory` (graph + ask), `/memory?view=browse|captures|misses`, `/memory?thread=<id>`, `/memory/note/*` (vault-relative path, for example `/memory/note/02-wiki/nestjs/bullmq-worker.md`) |
| Milestone | M5 |
| Status | Decided (layouts, graph styling rules, ask panel anatomy, note panel sections), Proposed (states, tabs other than Graph), Open where vault-mcp lacks the data. The owner said the memory UI is not final (Q5). |

## 1. Purpose

Answers **"What does my vault know about this, and how does it connect?"** Ask a question and get an answer that cites `path:line` (or an honest miss that can become research); see the vault as a graph clustered by domain; open a note with its links and where it was used today.

## 2. Route and entry points

| Entry | Result |
|---|---|
| Rail "Memory" (`Alt Shift 2`) | `/memory` (last thread restored, Proposed) |
| Palette `?question` or "Ask your vault" | `/memory?thread=new` and the question is sent |
| Palette note row, NoteChip, Citation, BacklinkRow, Focus Memory tab, Home "learned 1 thing" | `/memory/note/<path>` |
| Home calm "Open Memory" | `/memory` |
| Graph node click | `/memory/note/<path>` (local layout + note panel) |
| "Whole map" | `/memory` |

## 3. Layout

| Region | Component / token | Notes |
|---|---|---|
| Header | PageHeader `size="md"` (`--layout-header-md`): h1, Tabs "Memory views", crumb, primary action | |
| Filter bar | height `--layout-toolbar`, `border.default` bottom | "Whole map" toggle (local only), filter Buttons, legend |
| Graph | KnowledgeGraph `layout="clusters"` or `"local"`, flex 1 | overlays: hint bottom left, zoom controls bottom right |
| Right panel | `aside`, width `--layout-panel-sm`, `bg.surface` | AskThread ("Ask your vault") or note panel ("Note preview") |

| Width | Behaviour |
|---|---|
| 1920 | graph about 1416px + panel 440 |
| 1440 | graph about 936px + panel 440; graph runs Fit on resize (design-system 8.3) |
| 1280 | same; legend collapses to a "Legend" Button with a popover (Proposed) |

## 4. Content inventory

### 4.1 Header and filter bar

| Element | Component | Data binding | Copy | Notes |
|---|---|---|---|---|
| Title | h1 | | "Memory" | |
| Views | Tabs `label="Memory views"` | counts: `captures.today` (teal), `misses.unresolved` (amber badge) | "Graph", "Browse by MOC", "Captures 4 today", "Misses 3" | |
| Crumb | text muted | clusters: `graph.counts.notes`, `graph.counts.edges`; local: selected note title, hops | "Clustered by domain · 22 notes · 34 links" / "Local graph · bullmq-worker · 2 hops" | |
| Research | Button `primary` icon `compass` | | "Research a topic" | opens the research form |
| Whole map | Button `teal-outline` `pressed` | local layout only | "Whole map" (Icon `arrow-left`) | |
| Filters | Button `secondary sm` + popover (Select or checkbox list) | `filters.tags`, `filters.age`, `filters.status` mapped to `vault_graph` params `tags`, `status`; age filters by `mtime_ms` client-side | "Tags: any", "Age: any", "Status: all" | |
| Legend | inline dots | domains present in the graph (`domain.*` tokens) + cited | "nestjs", "docker", "patterns", "concorrencia", "projects", "cited" | |

### 4.2 Graph

| Element | Component | Data binding | Notes |
|---|---|---|---|
| Nodes | KnowledgeGraph nodes | `vault_graph.nodes[]`: `id` (path), `title`, `domain` (02-wiki domain, or area mapping 4.2.1), `kind` (index when `00-index/index-knowledge.md`, MOC when path ends `-moc.md`, else note) | labels always for MOC, index, cited, new; leaves on hover or focus |
| Edges | KnowledgeGraph edges | `vault_graph.edges[]` | opacities per components KnowledgeGraph |
| Cited | node flag | citations of the current thread's answers | teal glow |
| New | node flag | created today and not yet opened (Proposed; MEM-O3) | " · new" suffix, `.motion-arrive` up to 60s |
| Hint | text muted | | "Scroll to zoom · drag to pan · links between domains stay faint until you hover or cite them · MOCs, cited and new notes are always labelled" |
| Zoom | icon Buttons 36 | | "Zoom in", "Zoom out", "Fit" |
| sr note | `.sr-only` link | | "A list view of the same notes is in Browse by MOC" |

#### 4.2.1 Clusters (Proposed)

A cluster per `02-wiki/<domain>`; notes under `03-projects/` form a "projects" cluster; `00-index` is the centre; `04-daily`, `01-raw` and `99-archive` are excluded from the default map (the Status filter or a later "Show daily notes" option can add them). Cluster centres are laid out on a ring by the client (the canvas coordinates are a 5-domain sample, not a layout algorithm).

### 4.3 Ask panel (`aside aria-label="Ask your vault"`)

| Element | Component | Data binding | Copy |
|---|---|---|---|
| Eyebrow + title | AskThread header | `AskThread.title` (first question) | "Thread", "Queues, retries and limits" |
| History / New thread | Button `ghost xs` | threads list | "History", "New thread" |
| User message | AskThread user bubble | `AskMessage(role=user).text` | "How do retries work in the BullMQ worker?" |
| Answer | AskThread answer (sanitised markdown) | `AskMessage(role=assistant).text` | canvas answer text |
| Citations | Citation `source` | `citations[]`: `path`, `line`, `viaGraph` | "nestjs/bullmq-worker.md:13", "nestjs/auth-guard.md:11 · via graph" |
| Miss card | AskThread miss | `isMiss` | "Nothing in your vault on this." / "Logged as a miss. Want to chart it?" / "Research this" |
| General knowledge | AskThread general-knowledge card | `generalKnowledge` | "General knowledge · not from your vault" + text |
| Composer | Field `xl` + icon Button send | | placeholder "Ask a follow-up", sr label "Ask your vault", send `aria-label="Send"` |

### 4.4 Note panel (`aside aria-label="Note preview"`)

| Element | Component | Data binding | Copy |
|---|---|---|---|
| Path | mono muted | note path | "02-wiki/nestjs/bullmq-worker.md" |
| Title | h2 | note title (first H1 or file name) | "BullMQ worker" |
| Tags and properties | TagChip `tag` / `property` | frontmatter `tags[]`, `tipo`, `atualizado` (from `vault_get_note`) | "#nestjs", "#filas", "tipo: wiki", "atualizado 2026-08-26" |
| Excerpt | well with h3 + sanitised markdown, wikilinks as NoteChip `inline` | the section that holds the cited line, else the first `##` section (Proposed) | "Retry e backoff" + PT-BR body (`lang="pt-BR"`) |
| Backlinks | Eyebrow + BacklinkRow list | `vault_backlinks(path)` | "Backlinks · 3": "nestjs (MOC)", "outbox", "e2e-tests" |
| Links out | Eyebrow + NoteChip list | `vault_graph` edges from this node (or the `Links:` line of `vault_get_note`) | "Links out · 2": "auth-guard", "retry-backoff" |
| Recently used | Eyebrow + rows | deck data: threads citing the note today; sessions that called `vault_get_note` on it today (hook `tool_input.path`) | "Cited today in the thread \"Queues, retries and limits\"", "Read by the discord-audit session at 15:48 (vault_get_note)" |
| Actions | Button `primary` + `secondary` | | "Open in Obsidian", "Ask about this note" |

### 4.5 Other views (Proposed, not on the canvas)

| View | Content |
|---|---|
| Browse by MOC | list grouped by domain MOC (Eyebrow per domain with count, ListRow per note: title, path, `atualizado`), filterable by the same filters; the accessible alternative to the graph |
| Captures | notes captured today (and a date picker for earlier days): ListRow with domain dot, title, "from {repo} · {time}" when the capturing session is known; "Revert" per row is **Open** (MEM-O4) |
| Misses | unresolved `Miss` rows: question, searched terms, date, thread link, "Research this"; resolved misses in a collapsed "Resolved" group with `resolvedBy` |

## 5. States

| Area | Loading | Empty | Degraded / error | Overflow |
|---|---|---|---|---|
| Graph | cluster label skeletons + "Loading the graph" (`aria-busy`) | "No notes yet. Captures and research land here." | vault-mcp down: DegradedCard replaces graph and panel ([failures-and-loading.md](failures-and-loading.md) 4.5); `vault_graph` missing (older vault-mcp): "This vault-mcp version has no graph tool. Browse by MOC still works." + link | more than 300 nodes: leaves unlabeled, clusters only, "Fit" on open (Proposed); `truncated: true` shows "Showing {n} of {total} notes" |
| Ask | thinking: "Searching your vault…" (3 dots as text), `aria-busy` | empty thread: "Ask anything about your vault. Answers cite the note and line." | error: "The ask did not finish: {reason}." + "Try again", question kept in the composer; timeout after 120s (state-machines 8) | long answers scroll the thread; citations wrap; more than 6 citations collapse to 6 + "+N sources" |
| Ask streaming | text appends; citations render when the final block arrives | | "Citations unavailable for this answer" when the result block is missing (state-machines 8.3) | |
| Ask cancelled | partial text + "Stopped" | | | |
| Note panel | title and path skeleton + 4 lines | note deleted: "This note is not in your vault anymore." + "Whole map" | `note not found` error text from vault-mcp shown literally | body over 20,000 characters: excerpt only; "Open in Obsidian" for the rest |
| Tabs | counts skeleton | Captures "Nothing captured today.", Misses "No misses. Every question found an answer." | | |

## 6. Interactions

| Trigger | Result | API or event |
|---|---|---|
| Tab click, Left/Right arrows | switch view | route query `view=` |
| Node click, Enter on a focused node | local layout + note panel | route `/memory/note/<path>`; `GET /api/vault/note?path=` (vault_get_note, vault_backlinks) |
| Node hover or focus | label and connected edges lift | client |
| Arrow keys in the graph | move to the nearest node in that direction (roving tabindex) | client |
| Esc in local layout, "Whole map" | clusters layout | route `/memory` |
| Scroll, drag | zoom and pan 1:1 | client |
| `+`, `-`, `0` with graph focus; zoom buttons | zoom in, out, fit (280ms) | client |
| Filter popover change | refetch graph with params | `GET /api/vault/graph?tags=&status=` (`vault_graph`) |
| Composer Enter (Shift Enter new line), send button | ask | `POST /api/ask {threadId, text}` = `U.Ask` (state-machines 8.3) |
| "Stop" during thinking or streaming | cancel | `U.StopAsk` |
| "Research this" (miss) | research form prefilled with the question | route `/research/new?topic=&miss=<id>` |
| Citation | note panel at that line | route `/memory/note/<path>#L13` |
| "History" | thread list popover (title, date) | `GET /api/ask/threads` |
| "New thread" | empty thread, composer focused | client |
| "Research a topic" | research form | route `/research/new` |
| "Open in Obsidian" | `obsidian://open?vault=<name>&file=<path>` (MEM-O5) | browser |
| "Ask about this note" | new thread with the note as scope; composer prefilled "About {title}: " | client |
| Backlink, link out, tag | note or filtered Browse | route |

## 7. Real-time updates

| Event | Effect |
|---|---|
| `ask.delta` | answer text appends (no per-token announcement) |
| `ask.done` | citations render; cited nodes glow; thread saved; polite announcement of the complete answer |
| `ask.error` | error state in the thread |
| `vault.changed` (the deck re-queries `vault_graph` after any deck-originated write and on a 60s poll while the tab is visible, Proposed; vault-mcp has no watcher) | new nodes arrive with the arrive motion; counts update |
| `misses.changed` | Misses count |
| `health.changed` (vault-mcp) | degraded card in or out |

Motion: graph Fit and zoom buttons 280ms; wheel and drag follow 1:1; new-node arrive loop stops on hover, focus, open or after 60s. Reduced motion: no transitions, static ring.

## 8. Accessibility

- h1 "Memory"; Tabs pattern for views; graph `section aria-label="Knowledge graph"` with the sr-only pointer to Browse by MOC.
- Nodes are focusable buttons in a roving tabindex (components KnowledgeGraph); names are full note titles; the graph is a visual aid and Browse by MOC is the equivalent list.
- Ask message list `role="log"` `aria-live="polite"` announcing completed answers only.
- Composer has a visible or sr-only label; send button labelled.
- Note panel h2 per note; PT-BR content wrapped in `lang="pt-BR"`.
- General knowledge block is visually and semantically separate (its own `section` with the eyebrow as heading).

## 9. Copy deck

| Key | EN |
|---|---|
| `memory.title` | Memory |
| `memory.tabs.label` | Memory views |
| `memory.tabs.graph` | Graph |
| `memory.tabs.browse` | Browse by MOC |
| `memory.tabs.captures` | Captures |
| `memory.tabs.captures.count` | {n} today |
| `memory.tabs.misses` | Misses |
| `memory.crumb.clusters` | Clustered by domain · {notes, plural, one {# note} other {# notes}} · {links, plural, one {# link} other {# links}} |
| `memory.crumb.local` | Local graph · {title} · {hops} hops |
| `memory.research` | Research a topic |
| `memory.wholeMap` | Whole map |
| `memory.filter.tags` | Tags: {value} |
| `memory.filter.age` | Age: {value} |
| `memory.filter.status` | Status: {value} |
| `memory.filter.any` | any |
| `memory.filter.all` | all |
| `memory.legend.cited` | cited |
| `memory.graph.label` | Knowledge graph |
| `memory.graph.srList` | A list view of the same notes is in Browse by MOC |
| `memory.graph.hint` | Scroll to zoom · drag to pan · links between domains stay faint until you hover or cite them · MOCs, cited and new notes are always labelled |
| `memory.graph.new` | new |
| `memory.graph.zoomIn` | Zoom in |
| `memory.graph.zoomOut` | Zoom out |
| `memory.graph.fit` | Fit |
| `memory.graph.loading` | Loading the graph |
| `memory.graph.empty` | No notes yet. Captures and research land here. |
| `memory.graph.noTool` | This vault-mcp version has no graph tool. Browse by MOC still works. |
| `memory.graph.truncated` | Showing {n} of {total} notes |
| `memory.ask.label` | Ask your vault |
| `memory.ask.eyebrow` | Thread |
| `memory.ask.history` | History |
| `memory.ask.newThread` | New thread |
| `memory.ask.placeholder` | Ask a follow-up |
| `memory.ask.send` | Send |
| `memory.ask.stop` | Stop |
| `memory.ask.thinking` | Searching your vault… |
| `memory.ask.empty` | Ask anything about your vault. Answers cite the note and line. |
| `memory.ask.viaGraph` | via graph |
| `memory.ask.miss.title` | Nothing in your vault on this. |
| `memory.ask.miss.body` | Logged as a miss. Want to chart it? |
| `memory.ask.miss.research` | Research this |
| `memory.ask.general` | General knowledge · not from your vault |
| `memory.ask.error` | The ask did not finish: {reason}. |
| `memory.ask.tryAgain` | Try again |
| `memory.ask.noCitations` | Citations unavailable for this answer |
| `memory.ask.stopped` | Stopped |
| `memory.ask.moreSources` | +{n} sources |
| `memory.ask.aboutNote` | About {title}: |
| `memory.note.label` | Note preview |
| `memory.note.backlinks` | Backlinks · {n} |
| `memory.note.linksOut` | Links out · {n} |
| `memory.note.recent` | Recently used |
| `memory.note.recent.cited` | Cited today in the thread "{title}" |
| `memory.note.recent.read` | Read by the {repo} session at {time} ({tool}) |
| `memory.note.openObsidian` | Open in Obsidian |
| `memory.note.ask` | Ask about this note |
| `memory.note.gone` | This note is not in your vault anymore. |
| `memory.note.moc` | {title} (MOC) |
| `memory.browse.count` | {domain} · {n} |
| `memory.captures.meta` | from {repo} · {time} |
| `memory.captures.empty` | Nothing captured today. |
| `memory.misses.empty` | No misses. Every question found an answer. |
| `memory.misses.resolved` | Resolved |
| `memory.misses.research` | Research this |
| `memory.back` | Memory is back |

## 10. Acceptance criteria

1. **Given** fixture `vault22` (the canvas 22 notes and 34 links), **when** opening `/memory`, **then** the crumb reads "Clustered by domain · 22 notes · 34 links" and 5 cluster labels render.
2. **Given** the graph, **when** tabbing into it, **then** focus lands on the index node; arrow keys move to neighbours; Enter opens `/memory/note/00-index/index-knowledge.md`.
3. **Given** clicking bullmq-worker, **then** the URL is `/memory/note/02-wiki/nestjs/bullmq-worker.md`, the crumb reads "Local graph · bullmq-worker · 2 hops", the note panel shows "Backlinks · 3" and "Whole map" is pressed.
4. **Given** asking "How do retries work in the BullMQ worker?" with the stubbed Ask engine, **then** the thread shows the answer, two citations, and the bullmq-worker and auth-guard nodes gain the cited glow.
5. **Given** the stub returns `isMiss: true`, **then** the miss card shows and the Misses tab count increments by 1.
6. **Given** the stub exceeds 120s, **then** the thread shows "The ask did not finish: timed out after 120 s." and the question is back in the composer.
7. **Given** fixture `vaultDown`, **then** the graph and panel are replaced by the degraded card and Rail, Home and Meetings still work.
8. **Given** an answer containing `<script>` in markdown, **then** no script element exists in the DOM.
9. **Given** 1280 wide, **then** the legend collapses into a "Legend" button and no horizontal scroll exists.
10. **Given** reduced motion, **then** the new-note ring is static and Fit applies instantly.

## 11. Known gaps vs data reality

| Id | Gap | Status |
|---|---|---|
| MEM-O1 | `vault_graph` does not exist in vault-mcp v0.3.0; the graph needs it (proposal in the integration contract 1.11). | **Open** (M5 dependency). Default: Browse by MOC built from `vault_list` works without it; Graph tab shows `memory.graph.noTool`. |
| MEM-O2 | Search misses log storage (deck SQLite vs vault-mcp) is undecided (Q8). | **Open**. Default: deck SQLite `Miss` table (02-domain 2.7). |
| MEM-O3 | "Captures" and "new" note definitions: vault-mcp returns `mtime_ms`, not a creation date or the capturing session. | **Open**. Default: a capture is a note whose `criado` frontmatter is today (read through `vault_get_note` for recent `mtime_ms` notes) or a `vault_learn` call the deck observed; "new" = captured today and not opened in the deck yet. |
| MEM-O4 | "Recent captures include revert" (D-60): no revert tool; `vault_delete` refuses notes with backlinks and structural notes. | **Open**. Default: no Revert button in v1. |
| MEM-O5 | "Open in Obsidian" needs the Obsidian vault name; the deck knows only `VAULT_PATH`. | **Open**. Default: vault name = basename of `VAULT_PATH`, overridable in Settings, Connections. |
| MEM-O6 | "Read by the discord-audit session (vault_search)": hooks do not expose search hits (tool responses are not relied on). | Proposed: list only `vault_get_note` reads; copy uses the real tool name. |
| MEM-O7 | Ask output contract (SM-O16). | Open (tracked as SM-O16). |
| MEM-O8 | Memory UI to be revisited with the owner (Q5). | **Open**. |

## 12. Changes from the canvas

1. "Read by the discord-audit session at 15:48 (vault_search)" becomes "(vault_get_note)" style, showing only reads the deck can observe (MEM-O6).
2. Chat bubble max width 330 becomes `--layout-chat-bubble-max` (420).
3. Graph canvas background `#12131a` becomes `bg.sunken`.
4. Eyebrow tracking and sizes unified (design-system 14).
5. Browse by MOC, Captures and Misses views, loading, empty and error states are new.
6. Legend collapses at 1280 (new).
