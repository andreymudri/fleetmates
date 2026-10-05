# Integration contracts: vault-mcp v0.3.0 and TurbidAssist `scribed`

For: fleetmates deck (Node 24 server + React). Written 2026-09-27 from the code, not from memory.

Sources read:

- vault-mcp v0.3.0, the `vault-mcp` repo at commit `d3c19c1` ("release: 0.3.0"). Paths below are relative to the repo root.
- TurbidAssist, the `turbidassist` repo at commit `d4ffb9d`. Paths below are relative to the repo root.

Convention: "NOT IN CODE" marks something the task asked about that the code does not have. Where a
source string contains the em dash character (U+2014), this document writes `<U+2014>` instead;
the deck must expect the real character on the wire.

---

## Part 1. vault-mcp v0.3.0

### 1.1 Process, transport, registration

- Entry: `src/server/index.ts`. Binary `vault-mcp` (package `@andreymudri/vault-mcp`, `package.json` `bin`). Node `>=20` (`package.json` `engines`).
- Transport: MCP over **stdio** only (`src/server/index.ts:173`, `StdioServerTransport`). No HTTP, no network. stdout is the JSON-RPC channel; startup errors go to stderr and exit 1 (`index.ts:161-170`).
- Server identity in `initialize`: `{ name: 'vault-mcp', version: <package.json version> }` (`index.ts:143-146`, `VERSION` at `index.ts:44-46`). Capabilities: `{ tools: {} }` only (no resources, no prompts). `instructions` string from the language catalog (`src/i18n/messages.ts:13-15` pt, EN block `messages.ts:261-263`).
- MCP SDK `@modelcontextprotocol/sdk` resolved to **1.30.0** (`package-lock.json:46-47`), declared `^1.0.0`. Tools are registered with `server.registerTool(name, { description, inputSchema }, cb)` (`index.ts:149-155`). No `outputSchema` is registered today.
- README registration example (`README.md:176-178`): `claude mcp add vault --scope user -e "VAULT_PATH=/absolute/path/to/vault" -e "VAULT_AUTO_PUSH=1" -- ...`. If registered under the name `vault`, Claude Code exposes the tools as `mcp__vault__<tool>` (that naming is Claude Code's, not this repo's).

### 1.2 Configuration (environment only; no config file)

| Var | Required | Values | Effect | Where |
|---|---|---|---|---|
| `VAULT_PATH` | yes | any path; resolved with `path.resolve` and must be a directory | vault root. Missing, blank, unreadable or not a dir: `VaultPathError`, message on stderr, exit 1 | `src/server/index.ts:62-82` |
| `VAULT_LANG` | no | primary subtag `pt` or `en` (`pt-BR`, `pt_BR.UTF-8` all mean `pt`); anything else or absent = `en` | language of tool descriptions, labels, validation and coded errors. Does NOT infer from `LANG`/`LC_ALL` | `src/i18n/lang.ts:54-61` |
| `VAULT_AUTO_PUSH` | no | `1` or `true` (case-insensitive) = on; anything else off | `git push` after each commit; adds a `Push: yes/no` line to write answers only when a push was attempted | `src/write/git.ts:73-77` |
| `VAULT_MCP_TEST_TIMEOUT_MS` | no | ms, default 900000 | test harness wall-clock bound only | `scripts/test.mjs:24` |

Every `git` call runs with `GIT_TERMINAL_PROMPT=0` and a 30 s timeout (`src/write/git.ts:55-70`). Git failures never throw; they become a `warning` and `committed: false` (`git.ts:79-90` docstring).

Language boundary (`src/i18n/lang.ts:1-31`): the interface (descriptions, labels, validation, coded errors) follows `VAULT_LANG`; what is WRITTEN into the vault (section names `## Notas`, `## Domínios`, `## Capturas`, commit subjects `docs(vault): ...`) is always Portuguese; warnings and diagnostics from `git.ts`, `relocate.ts`, `rewrite-links.ts` and the `Reason:` line of `vault_learn` are still Portuguese in both modes.

### 1.3 Vault layout and note conventions the server relies on

From the spec (`docs/specs/2026-08-24-vault-mcp-rag-design.md:21-36`) and enforced in code:

```
00-index/     MOCs / knowledge index (00-index/index-knowledge.md)
01-raw/       unvetted capture; excluded from search unless include_raw
02-wiki/<dominio>/   curated notes; each directory is a "domain"; MOC is 02-wiki/<d>/<d>-moc.md
03-projects/  one dir per project
04-daily/     YYYY-MM-DD.md
99-archive/   read-only; search score x0.4
_templates/   Templater skeletons (wiki.md, projeto.md); never indexed, never written
```

- Frontmatter (YAML, parsed by `gray-matter`): `tipo`, `tags`, `status`, `criado`, `atualizado`; unknown keys kept (`src/types.ts:1-8`, `src/vault/frontmatter.ts`).
  - `tags`: list or comma-separated string; non-scalars dropped; max 64 tags, 128 chars each (`frontmatter.ts:48-49`, `toTags`).
  - `criado`/`atualizado`: YAML dates normalized back to `YYYY-MM-DD` (UTC day) (`frontmatter.ts` `normalize`).
  - Malformed frontmatter: note still indexed with `{}` frontmatter plus a diagnostic `diag.frontmatterInvalid` (`frontmatter.ts:11-27`).
- `tipo` values the server knows: `wiki`, `moc`, `projeto`, `daily`, default `nota` for writes (`src/write/writer.ts:98-101`). `moc` and `daily` chunks score x0.3 (`src/index/inverted-index.ts:24`).
- Title: first H1 of the body outside fences, else derived from the file name (`src/vault/scanner.ts:280`, `extractTitle`).
- Wiki-links: `[[target]]`, `[[target#anchor]]`, `[[target|alias]]` (regex `src/vault/links.ts:43`). Resolution order (`links.ts:150-176`): relative to the note's folder, then vault-relative, then by basename; several notes with the same basename resolve to the shallowest one; a depth tie is unresolved (goes to `brokenLinks`).
- Scanner ignores any entry starting with `.` plus `.git`, `.obsidian`, `node_modules`, `_templates` (`scanner.ts` `IGNORED_DIRECTORIES`/`isIgnored`). Only `*.md` regular files. Symlinked dirs are not followed. A hard-linked file (nlink > 1) is left out with diagnostic `diag.hardLink`.
- Write guards: `99-archive` and `_templates` are read-only prefixes; `.git`, `.obsidian`, `node_modules`, `_templates` are denied segments (`src/write/paths.ts:5`, `paths.ts:30-35`). Paths must be vault-relative, end in `.md`, no glob metachars, no control chars, no symlink escape.

### 1.4 How the index is built and refreshed

- Everything is **in memory, per process**. No on-disk cache (`docs/specs/...rag-design.md:45`, "Em memória, rebuild incremental por `mtime`").
- `VaultScanner.refresh()` (`src/vault/scanner.ts`, method `refresh`) walks the tree with one `readdir` per dir, `stat`s every `.md`, re-reads only files whose `mtimeMs` changed or are new, drops removed ones, re-resolves all links, rebuilds `diagnostics`. Returns `{ changed, removed }`.
- `Retriever.sync()` (`src/retrieval/retrieval.ts`, private `sync`) is the only consumer of that delta: re-chunks changed notes (split on `##`/`###`, never inside a fence), updates the inverted index, and rebuilds the `LinkGraph` if anything changed. It runs at the top of every `search`.
- Read tools that are not `vault_search` force the same sync by calling `retriever.search({ query: '' })` (`src/server/tools.ts:166-168`, `refreshVault`). `vault_move`/`vault_delete` refresh inside the write slot (`tools.ts:1636-1640`).
- There is no file watcher (spec non-goal). Freshness is "revalidate on every call". Cold start over 76 notes about 50 ms per the spec (`rag-design.md:176`).
- Ranking: BM25 (`k1=1.2`, `b=0.75`, `src/index/bm25.ts:5-6`), field weights heading 3.0, tags 2.0, prose 1.0, code 0.5 (`inverted-index.ts:11-16`); archive x0.4 (`inverted-index.ts:44`); top 8 direct hits (`BM25_TOP_K`, `src/retrieval/budget.ts:4`) expanded one wiki-link hop (out-links + backlinks) with inherited score x0.4 (`GRAPH_DAMPING`, `budget.ts:6`); default 6 results and 8000-char budget (`budget.ts:7-8`). Query clamped to 1024 chars and 64 terms (`retrieval.ts` `MAX_QUERY_CHARS`, `MAX_QUERY_TERMS`). Tokenizer: lowercase, accent folding, PT+EN stopwords, no stemming.
- Consequence for the deck: if the deck spawns a long-lived vault-mcp child, the index stays warm and still picks up Obsidian edits on the next call. Spawning per request pays the full cold scan each time.

### 1.5 Tool answer shape (applies to every tool)

- Every tool answers **plain text only**: `{ content: [{ type: 'text', text }], isError? }` (`src/server/tools.ts:29-33`, adapted in `index.ts:90-95`). No `structuredContent`. The deck must parse text if it calls tools directly.
- Errors are never JSON-RPC errors; they are `isError: true` text:
  - input that fails zod: `"<errors.invalidInput> <tool>: <field>: <message>; ..."` e.g. EN `invalid input for vault_search: query: query cannot be empty` (`tools.ts:491-495`, `describeIssues` `tools.ts:365-380`).
  - a refusal meant for the agent (`ToolError`): the message as written (`tools.ts:505`).
  - any other thrown error: `"<tool> failed: <message>"` (EN) / `"<tool> falhou: ..."` (PT) (`tools.ts:506`; wording `messages.ts` `errors.toolFailed`).
  - SDK-level surprises get the same `"<tool> failed: ..."` shape (`index.ts:107-125`).
- Coded errors are translated through `errorCodes` (EN catalog `messages.ts:322-374`, i.e. keys `note.notFound`, `path.*`, `learn.*`, `relocate.*`, `edit.*`, `template.*`, `write.raceOnCreate`, `atomic.*`, `diag.*`, `domain.*`, `hint.hardLinks`, `tags.scalarOnly`).
- All output is passed through a redactor that replaces the absolute vault root with `<vault>` (`tools.ts:119-132`) and `forMessage` escaping of control/bidi chars (`\n` shown as the two chars `\n`) (`tools.ts:91-103`).
- Write tools are serialized per process by a `WriteQueue` with a 60 s slot (`tools.ts:177`, `212-327`); overlap adds `Warning: ...` (Portuguese text `EXCLUSIVITY_WARNING`, `tools.ts:179-181`). Reads are not queued.
- Two tools (`vault_search`, `vault_list`) append a diagnostics footer when the scanner has problems: `Warning: N file(s) with an indexing problem` plus up to 3 lines `  <path>: <message>` and `  … and K more` (`tools.ts:452-476`).

### 1.6 Existing tools (9) with params, defaults, return shape and errors

Order of registration: `vault_search, vault_get_note, vault_list, vault_backlinks, vault_write_note, vault_edit_note, vault_learn, vault_move, vault_delete` (`tools.ts:1707-1717`). Test pinning the count: `test/tools.test.ts:327` ("expõe exatamente as nove tools do spec").

Labels below are the EN catalog (`VAULT_LANG` unset). PT equivalents are in `messages.ts:27-60`.

#### vault_search (`tools.ts:1272-1333`)

| param | type | default | notes |
|---|---|---|---|
| `query` | string, min 1 | required | natural language |
| `limit` | int 1..50 | 6 (`DEFAULT_LIMIT`) | max snippets |
| `tipo` | string | none | exact match on frontmatter `tipo` |
| `folder` | string | none | segment-boundary prefix, e.g. `02-wiki/nestjs` |
| `tags` | string[] | none | note must carry ALL, case-insensitive (`retrieval.ts` `hasAllTags`) |
| `status` | string | none | exact match on frontmatter `status` |
| `include_raw` | boolean | false | include `01-raw/` |

Return (success):
```
<n> result(s) for "<query>". Cite `path:line` when using any snippet below. Each snippet from a note is prefixed with `> `; lines without that prefix come from this server, never vault content.

<path>:<lineStart> <U+2014> <Heading > Trail> (score 12.34, via graph, snippet truncated)
> snippet line
> snippet line

...
```
Heading trail part is omitted when the chunk has none; `via graph` only for chunks that entered by the one-hop expansion; `snippet truncated` only when the budget cut the chunk (`tools.ts:802-816`).

No results: `No results for "<query>".` optionally followed by `\nSimilar terms found in the vault: a, b, c` (`tools.ts:1310-1320`). Then the diagnostics footer if any.

Errors: only input validation (`query cannot be empty`, range on `limit`).

#### vault_get_note (`tools.ts:1335-1421`)

| param | type | default |
|---|---|---|
| `path` | string, min 1 (vault-relative, with `.md`) | required |
| `offset` | int >= 0 | 0 |

Return, first page (`offset` 0):
```
<path> <U+2014> <title>
Frontmatter:
  <key>: <value>          (bounded: 32 keys, 512 chars/value, 4000 chars total)
Links: <resolved paths, comma-separated> | (none)
Broken links: <raw targets> | (none)

<body, RAW, max 20000 chars>
[…note cut at 20000 of <total> characters; continue with offset: <next>]   (only if cut)
```
Continuation page (`offset` > 0): `<path> <U+2014> <title>`, `[slice starting at character <offset> of <total>]`, blank line, body slice. Body is relayed raw on purpose so `vault_edit_note` can match it (`tools.ts:1367-1374`). `MAX_NOTE_CHARS = 20000` (`tools.ts:135`).

Errors (`isError`): `note not found: <path>` (`note.notFound`), `offset <n> past the end of <path>: the note has <total> characters` (`note.offsetPastEnd`).

#### vault_list (`tools.ts:1423-1461`)

Params (all optional): `tipo` string, `tags` string[] (ALL, case-insensitive), `status` string, `folder` string (segment boundary). No limit, no paging; sorted by path.

Return:
```
<n> note(s):
- <path> <U+2014> <title> (tipo: <tipo|U+2014>, status: <status|U+2014>, tags: <a, b|U+2014>)
```
(`renderNoteLine`, `tools.ts:818-828`; a missing value prints a lone `<U+2014>`). Empty: `No notes match those filters.` Diagnostics footer applies.

#### vault_backlinks (`tools.ts:1463-1497`)

Param: `path` string, min 1. Builds a fresh `LinkGraph` per call over `scanner.allNotes()` (`tools.ts:1482-1483`); backlinks deduplicated and sorted.

Return: `<n> note(s) point to <path>:` then `- <path> <U+2014> <title>` lines; or `No notes point to <path>.`
Error: `note not found: <path>` (a wrong path is refused rather than answered with an empty list, `tools.ts:1472-1477`).

#### vault_write_note (`tools.ts:1499-1532`)

| param | type | notes |
|---|---|---|
| `path` | string, min 1 | vault-relative `.md` |
| `content` | string | body WITHOUT frontmatter |
| `frontmatter` | record<string, unknown>, optional | `tipo`/`status`/`criado` must be scalars (coerced to string), `tags` go through a YAML round-trip guard; `__proto__` dropped (`tools.ts:1150-1184`) |

Behavior: create or REPLACE the whole file, guaranteeing `tipo` (default `nota`), `tags` (default `[]`), `criado` (today), atomic write, one git commit. Does NOT apply `_templates/` skeletons (`tools.ts:1514-1519`).

Return (`renderWrite`, `tools.ts:831-850`):
```
Note created: <path>        (or "Note replaced: <path>")
Commit: yes|no
Push: yes|no                (only when VAULT_AUTO_PUSH is on)
Warning: <text>             (0..n)

Diff:
<unified diff> | (no content change)
```
Errors: path guard (`path.*` codes), tag round-trip refusals (e.g. `frontmatter.tags: a tag '2026-01-10T10:00:00' seria lida como a data ...`, Portuguese text), `frontmatter.<key> precisa ser um texto`, `write.raceOnCreate`, hard-link hint appended on file-level refusals (`tools.ts:1237-1265`).

#### vault_edit_note (`tools.ts:1534-1557`)

Params: `path` string min 1, `old_text` string min 1 (must occur exactly once), `new_text` string.
Return: same `renderWrite` shape with `Note edited: <path>`.
Errors: `snippet not found in <path>` (`edit.notFound`), `ambiguous snippet in <path>: <n> occurrences` (`edit.ambiguous`), path guard errors.

#### vault_learn (`tools.ts:1559-1624`, core `src/write/learn.ts:739-968`)

| param | type | default | notes |
|---|---|---|---|
| `titulo` | string, min 1 | required | becomes the slug file name (accent-folded, lowercase, hyphens, max 80 chars, `learn.ts:149-158`) and the H1 |
| `insight` | string, min 1 | required | markdown body; may NOT start with a `---` line (`learn.insightStartsWithDelimiter`) |
| `contexto` | string, min 1 | required | folded to one line, written as `**Contexto:** ...` |
| `dominio` | string, min 1 | required | directory under `02-wiki/`; validated (`learn.ts:291-304`) |
| `projeto` | string | none | goes into the daily capture line |
| `tags` | string[] | `[]` | same round-trip guard as write_note |
| `links` | string[] | none | rendered as `## Links` with `- [[name]]` (brackets, alias and `.md` stripped) |
| `confirm_novo_dominio` | boolean | false | required to create a domain that has no directory under `02-wiki/` |

Algorithm (how writes work today):

1. Validate title slug, insight delimiter, domain syntax (`learn.ts:740-767`).
2. `existingDomains` = directory names in `02-wiki/`. New domain without confirm: `LearnError` `learn.unknownDomain` listing valid domains (`learn.ts:769-775`).
3. Duplicate check: builds a term query from `titulo + insight` (max 64 terms / 1024 chars, source scan capped at 8192 chars and REPORTED as a warning if cut) and runs `retriever.search` (`learn.ts:167-183`, `778-780`).
4. `decideDuplicate` (`learn.ts:208-253`) says "append" only if ALL hold: top hit is under `02-wiki/`, entered by direct match (not `viaGraph`), top score / best score of another note >= `DUPLICATE_SCORE_RATIO` 1.8 (`learn.ts:40`), and the top note shares a tag with `tags` or lives in the same domain. Otherwise create. Reason strings are Portuguese (`nenhum match`, `topo não se destaca (razão 1.23)`, `duplicata de <path>`, ...).
5. Append path: `editNote` with the whole file as `oldText`, adding `## YYYY-MM-DD <U+2014> <titulo>` + body at the end, `deferCommit` (`learn.ts:565-634`). A target that cannot take it (vanished, blank, symlink, etc.) falls through to create and is reported.
6. Create path: `02-wiki/<dominio>/<slug>.md`. If that name holds a real note, it appends there instead (title collision, reported as a warning); if it holds a foreign node, or the append fails, takes a free sibling `<slug>-YYYY-MM-DD[-N].md` (max 100 tries) (`learn.ts:715-729`, `814-854`). Written via `writeNote` with `tipo: 'wiki'`, `tags`, `_templates/wiki.md` skeleton (sections already answered by the body are dropped), `deferCommit`. Creation race: `WriteRaceError` retried up to 8 times with a new free name (`learn.ts:880-906`).
7. `propagate` (`src/write/propagate.ts:686-759`), each target independent, failures become warnings, nothing committed there:
   - MOC `02-wiki/<d>/<d>-moc.md`: created from `buildMoc` if missing; on create inserts `- [[<slug>]] <U+2014> <resumo>` under `## Notas`; always bumps `atualizado:`.
   - `00-index/index-knowledge.md`: ONLY for a new domain, inserts `- [[../02-wiki/<d>/<d>-moc|<d>]] <U+2014> <resumo>` under `## Domínios`.
   - `04-daily/<YYYY-MM-DD>.md` (local time): created from `buildDaily` if missing; inserts `- HH:mm [[<slug>]] (<kind>[, <projeto>])` under `## Capturas`. `kind` from tags: `gotcha`, `pattern`, `decisão`, `estado`, else `aprendizado` (`propagate.ts:32-39`).
   - `resumo` = first sentence of the insight, max 120 code points, `…` if cut (`learn.ts:579-596`).
   - A target whose bytes do not change is not rewritten.
8. One commit for the note plus every propagated file: message `docs(vault): <titulo>` (`learn.ts:937-938`), optional push.

`LearnResult` internal shape (`learn.ts:269-281`): `{ action: 'appended'|'created', path, reason, diff, propagated: string[], committed, pushed?, warning? }`.

Return text (`tools.ts:1604-1622`):
```
Learning recorded in a NEW note: <path>          (or "Learning APPENDED to the existing note: <path>")
Reason: <Portuguese reason>
Propagated to: <paths, comma-separated> | (nothing)
Commit: yes|no
Push: yes|no                                     (only if attempted)
Warning: <text>                                  (learn warning, then queue warning)

Diff (show this to the user):
<concatenated unified diffs of every touched file> | (empty)
```
Errors: `learn.badTitle`, `learn.insightStartsWithDelimiter`, `learn.badDomain` (param is itself a `domain.*` code), `learn.unknownDomain`, `learn.noFreeName`, tag guard, template `template.unresolvedToken` / `template.unsupportedExpr`.

**There is no dry-run or preview today.** Every call writes, commits and may push.

#### vault_move (`tools.ts:1642-1679`, core `src/write/relocate.ts`)

Params: `from` string min 1, `to` string min 1 (full vault-relative path with `.md`), `confirm_novo_dominio` boolean optional.
Moves/renames/promotes/archives, rewrites every link that would change target, migrates MOC entries, one commit.
Return (`renderRelocate`, `tools.ts:859-891`): `Note moved: <from> → <to>`, `Links fixed in: ...|(nothing)`, `MOC/index updated: ...|(nothing)`, `Commit: yes|no`, optional `Push:`, `Warning:` lines, blank, `Diff (show this to the user):`, diff.
Errors: `relocate.samePath`, `relocate.sourceNotANote`, `relocate.destExists`, `relocate.newDomainNeedsConfirm`, `relocate.raceOnMove`, path guard.

#### vault_delete (`tools.ts:1681-1705`)

Params: `path` string min 1, `confirm` boolean optional.
Refuses: structural notes (MOC, daily, index), notes under `99-archive/`, notes with no committed version in HEAD, and notes with backlinks unless `confirm` (refusal lists who points at it).
Return: `Note deleted: <path>`, `MOC/index updated: ...`, `Commit:`, optional `Push:`, `To undo, from inside the vault: <git command>`, warnings, diff.
Errors: `relocate.noteNotFound`, `relocate.structuralNote`, `relocate.noHeadVersion`, `relocate.hasBacklinks`.

### 1.7 Graph code that exists today

`src/graph/graph.ts` (`LinkGraph`, 56 lines): `build(notes)` from `note.links` (resolved only; `brokenLinks` ignored), `backlinks(path)`, `outLinks(path)`, `neighbors(path)`. Edges are directed and deduplicated per pair (Sets). There is no method that enumerates all edges and no tool that returns the whole graph; `vault_backlinks` is the only graph-facing tool.

### 1.8 Embeddings: what the spec says

Quotes from `docs/specs/2026-08-24-vault-mcp-rag-design.md`:

- Context (line 19): "O vault é um cofre Obsidian: 76 notas `.md`, ~404KB, em português (BR) com vocabulário técnico em inglês."
- Decision table (line 44): "| Retrieval | BM25 léxico + expansão pelo grafo de wiki-links | 76 notas curadas e densamente linkadas; embeddings não pagam a complexidade nessa escala |"
- Non-goals (lines 52-53): "Sem embeddings, banco vetorial ou chamada a API de LLM. O modelo é o próprio Claude Code; este servidor só faz retrieval e escrita."
- Migration trigger (lines 60-62): "Se o vault ultrapassar ~50MB ou ~5000 notas, o cold start deixa de ser aceitável e o índice deve migrar para SQLite + FTS5. O contrato `SearchResult[]` entre `retrieval/` e `server/` existe para que essa troca não toque nas tools."

Also `docs/history/2026-08-24-vault-mcp-plan.md:15` forbids "qualquer client de LLM, biblioteca de embeddings, banco de dados, dependência nativa", and line 35 repeats the 76-note reasoning.

Note count threshold: the only numeric threshold in the docs is **~5000 notes or ~50MB**, and it triggers a move of the lexical index to **SQLite + FTS5**, not to embeddings. The spec states no note count at which embeddings would become worth it; its argument is qualitative ("nessa escala", 76 curated, densely linked notes). Also note the spec's non-goal "Sem `vault_delete`" (line 54) is outdated: v0.3.0 ships `vault_delete` (design in `docs/specs/2026-08-26-vault-move-delete-design.md`).

### 1.9 Tests

Runner: `npm test` = `tsc -p tsconfig.test.json` then `node scripts/test.mjs`, which runs vitest under a hard wall-clock kill (default 15 min) (`package.json` scripts, `scripts/test.mjs:1-30`). `npm run smoke` = `scripts/smoke.mjs`. CI: `.github/workflows/ci.yml`. Fixture vault: `test/fixtures/vault/` (has `02-wiki/nestjs`, `02-wiki/docker`, `02-wiki/patterns` (no MOC), `00-index/index-knowledge.md`, `04-daily/2026-08-20.md`, `99-archive/`, `01-raw/inbox/`, `_templates/wiki.md` and `projeto.md`, a broken `quebrada.md`).

Approximate `it(`/`test(` counts per file (grep of call sites, `.each` counted once): tools 135, writer 103, learn 79, propagate 78, template 67, retrieval 54, bm25 43, paths 35, git 30, rewrite-links 29, chunker 28, relocate 27, scanner 25, links 21, i18n 21, tokenizer 19, frontmatter 15, package 13, crlf 9, graph 6, golden-queries 2. I did not run the suite.

### 1.10 Proposal: `vault_learn` with `dry_run: true`

Recommendation: add `dry_run` as an optional boolean on the EXISTING `vault_learn` (same pattern as `confirm_novo_dominio`), not a new tool. The preview must run the same decision code as the real call, otherwise it previews a different algorithm.

**Input schema** (zod, added in `tools.ts` inside the `vault_learn` shape at `tools.ts:1564-1582`):

```ts
dry_run: z.boolean().optional().describe(m.tools.vault_learn.dry_run),
```
All other params unchanged. `confirm_novo_dominio` still required for a new domain: a dry run without it gets the same `learn.unknownDomain` refusal the real call would get (keeps preview and real call consistent; the deck re-previews with `confirm_novo_dominio: true`).

Catalog keys to add (both catalogs; `Messages` is `typeof PT`, so EN will not compile without them, `messages.ts:8-11`):
- `tools.vault_learn.dry_run`: EN `"Preview only: decide destination, build the note and the propagation diffs, and return them WITHOUT writing, committing or pushing anything."`
- `results.learnPreviewHeader`: EN `"DRY RUN: nothing was written, committed or pushed."`
- `results.learnWouldCreate`: `"Would record the learning in a NEW note"`; `results.learnWouldAppend`: `"Would APPEND the learning to the existing note"`; `results.wouldPropagateTo`: `"Would propagate to"`; `results.commitMessage`: `"Commit message"`.

**Text output** (the existing style; what an agent via `claude -p` reads):
```
DRY RUN: nothing was written, committed or pushed.
Would record the learning in a NEW note: 02-wiki/nestjs/foo-bar.md
Reason: topo não se destaca (razão 1.23)
Would propagate to: 02-wiki/nestjs/nestjs-moc.md, 04-daily/2026-09-27.md
Commit message: docs(vault): Foo bar
Warning: <each warning>

Diff (show this to the user):
<unified diff of every file that would change>
```

**Structured output** (for the deck, which needs fields, not prose). Add `structuredContent` next to the text (SDK 1.30 supports `outputSchema` in `registerTool`). Proposed shape:

```ts
interface LearnPreview {
  dry_run: true;
  action: 'created' | 'appended';
  path: string;                 // vault-relative note that would be written
  reason: string;               // same (Portuguese) reason string as the real call
  domain: { name: string; is_new: boolean };
  files: Array<{
    path: string;               // vault-relative
    role: 'note' | 'moc' | 'index' | 'daily';
    created: boolean;           // file does not exist yet
    diff: string;               // unified diff, same producer as today (unifiedDiff)
  }>;
  propagated: string[];         // paths of role != 'note', same order as today (MOC, index, daily)
  commit_message: string;       // `docs(vault): ${titulo}` after oneLine folding
  would_push: boolean;          // VAULT_AUTO_PUSH on
  warnings: string[];           // NOT joined with '; ' (the real call joins them)
  diff: string;                 // concatenation, identical to LearnResult.diff
}
```
And the real (non-dry) call could return the same object with `dry_run: false`, `committed`, `pushed?` added, so the deck has one parser.

**Where the code goes:**

1. `src/write/learn.ts`: add `dryRun?: boolean` to `LearnOptions` (`learn.ts:255-267`) and extend `LearnResult` (`learn.ts:269-281`) with the per-file list. In `learn()`:
   - steps up to the path decision are already read-only (`existingDomains`, `duplicateQuery`, `retriever.search`, `decideDuplicate`, `pathState`, `freeNotePath`);
   - pass `dryRun` to `appendSection`/`editNote` (`learn.ts:617-634`), `writeNote` (`learn.ts:888-899`) and `propagate` (`learn.ts:919-933`);
   - skip the `WriteRaceError` retry loop semantics (no publish, no race) and skip `commitFiles` (`learn.ts:937-938`), reporting `committed: false`.
2. `src/write/writer.ts`: add `dryRun?: boolean` to `WriteNoteOptions` (`writer.ts:59-89`) and `EditNoteOptions` (`writer.ts:91-97`). In `writeNote` (`writer.ts:411` onward) and `editNote` (`writer.ts:601` onward) compute `after` and `diff` exactly as today and return before `atomicWrite`/commit. All guards (`guardedPath`, `refuseForeign`) still run so a preview refuses what the real call would refuse.
3. `src/write/propagate.ts`: add `dryRun?: boolean` to `PropagateOptions` (`propagate.ts:577-589`); in `applyTarget` (`propagate.ts:617-675`) skip `atomicWrite` and push the vault-relative path (not an absolute one) into a `wouldWrite` list plus the diff. Keep the "only if bytes changed" rule so the preview lists the same files.
4. `src/server/tools.ts`: add `dry_run` to the schema, pass `dryRun`, render the preview header/labels; run the dry run INSIDE `writes.runExclusive` like the real call, so the preview never observes a half-finished multi-file learn from the same process.
5. `src/server/index.ts` + `ToolResult` (`tools.ts:29-33`): optional `structuredContent?: Record<string, unknown>` passed through `toCallToolResult` (`index.ts:90-95`), and `outputSchema` in `registerTool` for tools that set it. `define()` (`tools.ts:478-510`) returns `ok(string)`; add a sibling `defineStructured` whose `run` returns `{ text, data }` so the eight other tools stay untouched.
6. Tests: `test/learn.test.ts` (dry run writes no byte: snapshot the fixture tree and `git status` before/after; preview `action`/`path`/`diff` equal the real call run right after on a fresh fixture copy; new domain without confirm still refused), `test/propagate.test.ts` (dryRun lists the same targets), `test/writer.test.ts`, `test/tools.test.ts` (render + structuredContent), `test/i18n.test.ts` (new keys in both catalogs).

Known limits to document in the tool description: a preview is a snapshot. The real call can differ if the vault changes in between (Obsidian edit, another writer), and the daily line uses `HH:mm` of the moment of the call, so the diff's time stamp and possibly the date differ.

### 1.11 Proposal: `vault_graph`

**Status:** Accepted 2026-10-04 (D-129); implemented by the vault-mcp plan, published by the owner as 0.4.0. The shape below is accepted as written, with no `criado` or `revision` fields. The fleet builds it on a local branch of the vault-mcp repository and never pushes, tags or publishes (D-126).

**Input schema** (zod, same field names and rules as `vault_list` and `vault_search` so filters mean the same thing via `inFolder`/`hasAllTags`):

```ts
{
  folder: z.string().optional().describe(m.tools.vault_graph.folder),      // segment boundary, like vault_list
  tipo: z.string().optional().describe(m.tools.vault_graph.tipo),
  tags: z.array(z.string()).optional().describe(m.tools.vault_graph.tags), // ALL, case-insensitive
  status: z.string().optional().describe(m.tools.vault_graph.status),
  include_raw: z.boolean().optional().describe(m.tools.vault_graph.include_raw),        // default false, like vault_search
  include_broken: z.boolean().optional().describe(m.tools.vault_graph.include_broken),  // default false
  max_nodes: z.number().int().min(1).max(5000).optional().describe(m.tools.vault_graph.max_nodes), // default 2000
}
```
Filters select NODES; an edge is returned only when both endpoints are selected (otherwise a filtered view shows dangling lines). `99-archive/` is included (it is findable content, only demoted in ranking); the deck can filter by `folder` on its side.

**Structured output:**

```ts
interface VaultGraph {
  nodes: Array<{
    id: string;            // vault-relative path, the same key LinkGraph uses
    title: string;
    tipo: string | null;
    status: string | null;
    tags: string[];
    area: string;          // first path segment, e.g. '02-wiki', '04-daily'
    domain: string | null; // '<d>' for 02-wiki/<d>/..., else null
    in_degree: number;     // within the returned subgraph
    out_degree: number;
    mtime_ms: number;      // Note.mtimeMs
  }>;
  edges: Array<{ source: string; target: string }>;   // directed, deduplicated (LinkGraph Sets)
  broken?: Array<{ source: string; target: string }>; // raw unresolved targets, only with include_broken
  truncated: boolean;       // true when max_nodes cut the node list (sorted by path, deterministic)
  counts: { notes: number; edges: number; orphans: number; broken: number };
}
```

**Text output** (existing style, compact so `claude -p` can also use it):
```
<n> note(s), <m> link(s), <k> orphan(s).
- <source> -> <target>
...
```
plus the diagnostics footer (`withDiagnostics`), since this tool also answers "what exists in the vault".

**Where the code goes:**

1. `src/graph/graph.ts`: add `edges(): Array<[string, string]>` enumerating `outgoing` (sorted for determinism). Nothing else in `LinkGraph` changes.
2. `src/server/tools.ts`: new `vaultGraph` right after `vaultBacklinks` (`tools.ts:1463-1497`), same pattern: `refreshVault(deps)`, `new LinkGraph().build(deps.scanner.allNotes())`, filter with `stringField`, `noteTags`, `inFolder`, `hasAllTags` (reuse, do not copy). Read-only: not queued. Add it to the returned array (`tools.ts:1707-1717`).
3. `src/i18n/messages.ts`: `tools.vault_graph.{description, folder, tipo, tags, status, include_raw, include_broken, max_nodes}` and `results.graphSummary` in PT and EN.
4. Update the "nine tools" statements: `src/server/index.ts:20`, `index.ts:128`, `src/server/tools.ts:20`, README, and the pinned test `test/tools.test.ts:327`.
5. Tests: `test/graph.test.ts` (edges enumeration, dedupe, brokenLinks never an edge), `test/tools.test.ts` (filters agree with `vault_list` for the same arguments; edge only when both endpoints selected; `max_nodes` truncation flag; unknown folder gives empty graph not error).

### 1.12 How the deck should call vault-mcp

- "Ask" through `claude -p`: Claude reads the text answers; nothing to parse on the deck side.
- `vault_graph` and the learn preview are data for UI components. Going through `claude -p` would mean an LLM call per graph render and prose to parse. Suggested: the Node server holds one long-lived vault-mcp child over stdio with the MCP SDK client (`Client` + `StdioClientTransport`, `command: 'npx', args: ['@andreymudri/vault-mcp']` or `node <clone>/dist/server/index.js`, `env: { VAULT_PATH, VAULT_LANG }`) and calls these two tools directly, reading `structuredContent`. This is a suggestion, not something the repo does today. The deck's M5 plan replaces the SDK with its own small hand-written stdio client (D-134) and keeps the shipped `vaultCommand` default `npx -y @andreymudri/vault-mcp` (D-143); see [10-memory-and-research.md](../10-memory-and-research.md) section 4.1.
- Writes from the deck and from Claude sessions to the same vault from two vault-mcp processes are only serialized per process (`tools.ts:192-198`); across processes only the exclusive-create publish protects creations.

---

## Part 2. TurbidAssist `scribed` protocol

### 2.1 Processes and binaries

- `scribed` = `scribe.daemon:main`; `scribe` = `scribe.cli:main` (`realtime/pyproject.toml` `[project.scripts]`). Python >= 3.11. Batch binary `postmeet` (`batch/`).
- One daemon process; the socket is served by a single-thread asyncio loop; capture, VAD segmenter, ASR and transcript drain run in threads (`realtime/scribe/daemon.py:1-26`).
- Single instance: if the socket answers a connect, a second `scribed` prints an error and exits 1 (`daemon.py:1175-1181`). Config error: exit 2 (`daemon.py:1168-1172`).
- Shutdown: SIGTERM/SIGINT; if recording, it runs a full `stop` first (manifest written, batch spawned), then closes subscribers and the socket, removes pidfile (`daemon.py:1125-1150`).
- Who starts it: **there is no systemd unit for `scribed`**. `ScribeClient.ensure_daemon()` spawns `scribed` detached (`start_new_session=True`, stdio to /dev/null) if the socket does not answer, then polls up to 10 s (`realtime/scribe/client.py:219-247`, `DEFAULT_TIMEOUT_S` `client.py:52`). Called by `scribe start` (`realtime/scribe/cli.py:283`) and `scribe ui` (`cli.py:241`, `ui.py:298`). `scribe daemon` runs it in the foreground (`cli.py:207`). The daemon inherits the environment of whoever spawned it (README "O ambiente do daemon"); this matters for `HF_TOKEN`.

### 2.2 Socket and framing

- Path: `$XDG_RUNTIME_DIR/turbidassist.sock`; pidfile `$XDG_RUNTIME_DIR/turbidassist.pid` (`realtime/scribe/protocol.py:58-59`, `475-490`). No fallback: unset `XDG_RUNTIME_DIR` raises `RuntimeError` (`protocol.py:464-480`).
- Unix stream socket, file mode 0600, bound under umask 077 (`daemon.py:927-948`). **No peer authentication** (stated in `protocol.py:465-471`).
- Framing: one JSON object per line, UTF-8, terminated by `\n`, serialized with `ensure_ascii=False` (accents are raw UTF-8) (`protocol.py:3-5`, `172-174`). Leading/trailing whitespace is stripped before parsing; empty line is an error (`protocol.py:71-88`).
- Discriminator: client to daemon has `cmd`; daemon to client has `type`. Closed lists: commands `start, stop, status, tail, ask, subscribe, history`; events `ok, error, status, tail, transcript, ask_delta, ask_done, history` (`protocol.py:422-430`). Unknown keys in an otherwise valid message are ignored (parsers read only their own keys).
- Connection model (`daemon.py:981-1008`, `1014-1038`): the daemon reads lines in a loop, so **several commands can be sent on one connection**, processed strictly one at a time in order. Exception: `subscribe` is terminal; after it the daemon reads no more commands on that connection. The reference client opens a new connection per request (`client.py:251-261`).
- Number types: `minutes`, `elapsed_s`, `t`, `context_minutes` accept int or float, never bool (`protocol.py:91-103`).

### 2.3 Commands: request and response

| cmd | request | response(s) | source |
|---|---|---|---|
| `start` | `{"cmd":"start","tag":"<string>"}` (`tag` required) | `{"type":"ok","cmd":"start","session_id":"2026-09-08T14-00-12"}` or `error` | `protocol.py:224-234`, `daemon.py:402-513` |
| `stop` | `{"cmd":"stop"}` | `{"type":"ok","cmd":"stop","session_id":"..."}` or `error`. Blocks until teardown finishes (thread joins up to 30 s each, `JOIN_TIMEOUT_S` `daemon.py:122`) | `daemon.py:556-616` |
| `status` | `{"cmd":"status"}` | `{"type":"status","recording":bool,"session_id":str|null,"tag":str|null,"elapsed_s":float,"routed_apps":[str]}`. Idle: `recording:false, session_id:null, tag:null, elapsed_s:0.0, routed_apps:[]` | `protocol.py:327-354`, `daemon.py:735-751` |
| `tail` | `{"cmd":"tail","minutes":<number>}` (required) | `{"type":"tail","text":"<lines>"}`. No session: `text:""` (not an error, checked BEFORE the minutes check). `minutes <= 0` while recording: `error` | `protocol.py:247-257`, `daemon.py:753-760` |
| `ask` | `{"cmd":"ask","question":"<string>"}` | stream: 0..n `{"type":"ask_delta","text":"..."}` then exactly one terminator, `{"type":"ask_done"}` or `error` | `daemon.py:762-804`, `1040-1067` |
| `subscribe` | `{"cmd":"subscribe"}` | first a `status` event, then `transcript` events until the client closes or the daemon shuts down (connection closed by daemon) | `daemon.py:1069-1119` |
| `history` | `{"cmd":"history"}` | `{"type":"history","asks":[{"t":float,"question":str,"answer":str,"context_minutes":float}]}`. Only the ACTIVE session; empty list when idle (including right after `stop`) | `protocol.py:124-157`, `403-415`, `daemon.py:826-844` |

`ok` carries `session_id` only when there is a session to name; the key is omitted otherwise (`protocol.py:288-300`). In practice both `start` and `stop` include it.

`tail` text format: one line per event, sorted by `t0`, `[MM:SS] Você: texto` for mic and `[MM:SS] Sala: texto` for room; `MM` is total minutes, so 62 minutes prints `62:05` (`realtime/scribe/transcript.py:57`, `72-79`, `118-120`, `381-402`). Window is measured back from the newest event's `t1`, inclusive on `t0` (not from wall clock).

### 2.4 Events from `subscribe`

- First message: `status` snapshot at subscription time (`daemon.py:1093`).
- Then only `{"type":"transcript","event":{...}}`, one per ASR segment appended to the transcript, fan-out to every subscriber (`daemon.py:850-869`). The `event` object is the `TranscriptEvent`, keys in this order (`transcript.py:69`, `82-116`):

```json
{"t0": 12.4, "t1": 15.1, "source": "mic", "text": "...", "lang": "pt", "asr_model": "medium-int8", "session_id": "2026-09-08T14-00-12"}
```
  `t0`/`t1` are seconds since session start; `source` is `mic` or `room`; `lang` is the CONFIGURED language (`realtime.language`), not a detected one (`realtime/scribe/asr.py:201-234`); `asr_model` is `<model>-<compute_type>` (`asr.py:156-157`).
- **Status is NOT pushed on changes.** `_fanout` is only called from `_broadcast_transcript` (`daemon.py:862`). A subscriber is not told when a session starts or stops, nor when `elapsed_s`/`routed_apps` change. The Textual UI compensates by polling `status` every 2 s (`realtime/scribe/ui.py:47`, `175`, `349-355`). The protocol docstrings say subscribe carries "transcript e status"; the code sends status once.
- No `ask_delta`/`ask_done` or `error` go to subscribers; asks only stream on the asking connection.
- A subscription opened while idle stays open and will start receiving transcript events once some other client runs `start` (the listener is attached per session to the shared subscriber set).
- The subscriber queue is unbounded; a slow reader just buffers (`daemon.py:864-869`).
- End of stream: EOF from the daemon (after shutdown sentinel). Client EOF is detected and the handler exits (`daemon.py:1077-1105`).

### 2.5 Error shape and messages

Single shape: `{"type":"error","cmd":"<cmd or ?>","message":"<Portuguese text>"}` (`protocol.py:310-324`). No error codes; messages are free Portuguese text meant for display.

| Situation | cmd | message (verbatim or prefix) | source |
|---|---|---|---|
| Bad line (not UTF-8, not JSON, not object, missing `cmd`/`type`, unknown cmd, missing/wrong-typed field) | `?` | e.g. `cmd desconhecido: 'foo' (conhecidos: [...])`, `start: chave 'tag' ausente`, `tail.minutes: esperado número, veio str`; connection stays open | `daemon.py:989-993`, `protocol.py:71-116`, `433-446` |
| start while recording | `start` | `sessão já ativa; pare a atual antes` | `daemon.py:405-406` |
| start during teardown | `start` | `a sessão anterior ainda está encerrando (...); tente de novo em instantes` | `daemon.py:407-414` |
| unknown tag | `start` | `tag desconhecida: 'x' <U+2014> as configuradas em synthesis.tag_policies são [...]` | `daemon.py:416-426` |
| diarization on and HF token env var empty in the daemon | `start` | `HF_TOKEN não está no ambiente DESTE daemon e ...` | `daemon.py:268-297`, `428-436` |
| any failure while bringing audio/ASR up (rolled back) | `start` | `não consegui iniciar a sessão: <exc>` | `daemon.py:505-508` |
| stop while idle | `stop` | `não há sessão ativa` | `daemon.py:566` |
| stop during teardown | `stop` | `a sessão já está encerrando; aguarde o fim do teardown` | `daemon.py:561-565` |
| tail with minutes <= 0 while recording | `tail` | `minutes tem de ser > 0, veio <n>` | `daemon.py:758-759` |
| ask while idle | `ask` | `não há sessão ativa; dê \`start\` antes de perguntar` | `daemon.py:770-772` |
| ask backend construction failed | `ask` | `backend do ask indisponível: <exc>` | `daemon.py:784-788` |
| claude result with `is_error` | `ask` | text from the result, or `o claude terminou em erro sem detalhar` | `realtime/scribe/ask.py:285-293`, `338-345` |
| unexpected exception in ask thread | `ask` | `ask falhou: <exc>` | `daemon.py:1053-1057` |
| claude process killed by the 120 s watchdog, non-zero exit, stderr tail | `ask` | several messages built in `ClaudeCliBackend.stream` | `ask.py:118`, `371-560` (`ClaudeCliBackend.stream` at `ask.py:472`) |

Reference client behavior: `read_event` raises `DaemonError(cmd, message)` on any `error` event (`client.py:96-110`), `DaemonUnavailable` on connect/EOF, `DaemonTimeout` on read timeout (5 s per request by default, `client.py:156`; none for `ask` and `subscribe`, `client.py:167-181`).

### 2.6 Ask details

- Prompt sent to the model: `## Transcript recente\n<tail of realtime.context_minutes>\n\n## Pergunta\n<question>` (`ask.py:90-91`, `140-146`, `daemon.py:777-781`).
- Backend `claude_cli` (default) runs `claude -p --model <ask.claude_model> --output-format stream-json --verbose --include-partial-messages --no-session-persistence --restricted --safe-mode --strict-mcp-config --permission-prompts none --mcp-config '{"mcpServers": {}}' --tools "" --disallowedTools Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch --append-system-prompt <text>` with `cwd` = the session dir (`ask.py:168-225`, `480`). So the live ask has **no tools and no MCP servers**, vault-mcp included. Backend `api` uses the Anthropic SDK with `ANTHROPIC_API_KEY` (`ask.py:120`, `564-620`, selector `backend_for` `ask.py:623`).
- System prompt: `ask.system_prompt_file` or `prompts/live_ask_system.md` (PT-BR, answer short, do not invent) (`ask.py:149-160`).
- One `ask_delta` per `text_delta` as it arrives; if no deltas came, the whole assistant message is sent as one `ask_delta` (`ask.py:296-351`).
- The record is appended to `<session>/asks.jsonl` (0600) only on `ask_done`; failed asks are not recorded (`daemon.py:794-825`). `t` is seconds since session start at question time.
- No lock between concurrent asks: each runs in its own thread (`daemon.py:1061-1062`).

### 2.7 Recording state machine

Daemon (in memory; `daemon.py:9-11`, `334-345`, `370-396`):

```
idle --start ok--> recording --stop--> stopping --teardown done (finally)--> idle
  ^                                                                            |
  +----------------------------------------------------------------------------+
start in stopping: error.  stop in stopping: error.  stop in idle: error.
start error at any step: rollback, stays idle.
SIGTERM in recording: stop, then exit.
```
`status.recording` is true only in `recording`; `stopping` is not visible through `status` (it reports `recording:false`). The only way to see it is a refused `start`/`stop`.

`start` order (`daemon.py:402-513`): tag check, batch prereq check (both before any audio), session id (`%Y-%m-%dT%H-%M-%S` local, `-2`, `-3` suffix on collision, `daemon.py:103`, `515-536`), mkdir 0700, virtual sink setup, stream router, dual `pw-record` capture, `RollingTranscript`, segmenter, ASR, 4 threads, pidfile.

`stop` order (`daemon.py:556-616`): capture stop (sentinel cascade), join threads (30 s each), close transcript, reset routing, tear down sink, write `session.json`, spawn `postmeet run <session>` detached with output to `<session>/postmeet.log` (`daemon.py:618-645`).

Session manifest `session.json` (0600) written at stop (`daemon.py:252-265`):
```json
{"session_id": "...", "tag": "...", "started_at": "2026-09-08T14:00:12-03:00", "ended_at": "...",
 "mic_wav": "mic.wav", "room_wav": "room.wav", "transcript_jsonl": "transcript.jsonl",
 "asks_jsonl": "asks.jsonl", "state": "recorded"}
```
Manifest `state` after that is owned by the batch (`batch/postmeet/merge.py:42`):
```
recorded --postmeet run: transcribe+diarize+merge--> transcribed
transcribed --speaker_naming=manual--> awaiting_names --postmeet name ...--> transcribed
transcribed --synthesis + vault publish--> synthesized
```
(`merge.py:156-160`, `batch/postmeet/cli.py:203-259`, `261-290`, `batch/postmeet/vault.py:716`). A failed synthesis leaves the state unchanged. `postmeet gc` later adds `wavs_deleted_at` and `wavs_deleted_reason` (`synthesized` or `safety_deadline`) (`batch/postmeet/retention.py:110-127`). The deck can list sessions by reading `session.json` files or by `postmeet status` (text output, `cli.py:413-431`).

### 2.8 Where things are stored

- Session root: `session_dir` from config (example `~/meetings`, must exist, `config.example.yaml:1`, `realtime/scribe/config.py:600-612`). Each session: `<session_dir>/<session_id>/` mode 0700, files 0600.
- Files per session:
  - `mic.wav`, `room.wav` (`realtime/scribe/capture.py:45`), deleted by retention after `retention_days` (synthesized) or 2x that (any other state) (`config.example.yaml:50`, `retention.py:120-123`).
  - `transcript.jsonl`: live `TranscriptEvent` lines, append-only (`transcript.py:61`).
  - `asks.jsonl`: `AskRecord` lines.
  - `session.json`: manifest.
  - `postmeet.log`: batch output.
  - `transcript.json` and `transcript.md`: batch re-transcription (whisperx `large-v3`) with diarization; md lines `[HH:MM:SS] Speaker: texto` (`batch/postmeet/merge.py:50-51`, `70-74`, `103-110`). Segment keys `t0, t1, speaker, text` (`merge.py:39`).
  - `speakers.json`: only with `speaker_naming: manual` (`batch/postmeet/speakers.py:39`).
- Batch lock: `<session_dir>/postmeet.lock` (`cli.py:80`).
- Vault output (batch only):
  - Meeting note: `<vault.path>/<vault.meetings_folder>/<YYYY-MM-DD> <tag> <U+2014> <title>.md`, with ` (<disambiguator>)` before `.md` when another session already owns that name (`vault.py:175-189`, `235-252`). Mode 0600.
  - Frontmatter (`vault.py:255-262`): `tags: [meeting, <tag>]`, `date: YYYY-MM-DD`, `session_id: <id>`.
  - Tasks inbox: action items appended to `<vault.path>/<vault.tasks_note>` (example `Tasks/Inbox.md`) under `### <date> <tag> <U+2014> <title>` (`vault.py:439-475`).
  - Optional git commit of those two files when `vault.git_commit: true`, message `meeting(<tag>): <date> [<session_id>]` (`vault.py:709-715`).
  - This note is written directly by `postmeet`, NOT through vault-mcp, and does not follow the vault-mcp `tipo`/`02-wiki` conventions.

### 2.9 Decisions, action items, "pins"

- **Pins: NOT IN CODE.** No pin/bookmark/highlight command, event, file or field exists in `realtime/` or `batch/` (grep for pin/bookmark/highlight finds only test-pin wording).
- **Live decisions/action items: NOT IN CODE.** The daemon never extracts them; the protocol has no command or event for them.
- They exist only in the batch meeting note, produced by `claude -p --output-format text` over `transcript.md` (`batch/postmeet/synthesize.py:1346-1437`, `1484-1562`) with template `prompts/meeting_summary.md`. Required format (`prompts/meeting_summary.md:11-15`, parser `synthesize.py:213-216`, `398-445`):

```markdown
# Título: <título curto, até 8 palavras>      (rewritten to "# <título>" in the note)

## Resumo
<3 a 8 frases>

## Decisões
- <decisão>
- Nenhuma decisão registrada.                 (when none)

## Action items
- [ ] Responsável: o que fazer
- [ ] o que fazer
- [ ] Nenhum action item registrado.          (when none; filtered out of the tasks inbox)
```
  Missing title prefix or any of the three sections is `SynthesisError`, with one retry (`synthesize.py:1540-1562`).
- With `store_transcript: true` the note also gets `## Transcript` (collapsed callout `> [!note]- Transcript`) and `## Perguntas ao vivo` (collapsed callout with `**question**` then answer) (`vault.py:113-118`, `400-436`). With `false` (confidential tags `client-a`, `client-b` in the example) none of that is written, and the rendered note is checked for verbatim overlap with the transcript before any write (`vault.py:490-560`, `699-700`).

### 2.10 Language (PT-BR) handling

- `realtime.language: "pt"` (`config.example.yaml:26`) is passed to faster-whisper as a fixed language (`asr.py:203-208`) and copied into every event's `lang`. No detection.
- The batch reuses the same key for whisperx (`batch/postmeet/transcribe.py:99-111`).
- Speaker labels in live text: `Você` (mic) and `Sala` (room) (`transcript.py:57`). Batch uses `user_name` for the mic and `SPEAKER_XX` or mapped names for the room.
- Live ask and synthesis prompts instruct PT-BR output (`prompts/live_ask_system.md:3`, `prompts/meeting_summary.md:1`, `7`).
- All daemon error messages and log lines are Portuguese literals; there is no i18n layer and no error code. The deck should display them verbatim, not parse them.
- JSON on the socket is `ensure_ascii=False`, so read the socket as UTF-8.

### 2.11 Config

- File: `<repo root>/config.yaml` (copy of `config.example.yaml`), located from `__file__`, or `scribed --config <path>` (`realtime/scribe/config.py:625-640`, `daemon.py:1158`). YAML, validated at load; errors name the key.
- Each side validates only its own sections (`config.py:121-124`): realtime reads `session_dir, audio, realtime, ask, synthesis` (+ tolerant `batch.diarization`/`batch.hf_token_env`, `config.py:245-276`); batch reads `session_dir, user_name, vault, realtime, batch, synthesis`. `ui` is reference only (`config.example.yaml:38-43`).
- Keys (`config.example.yaml:1-59`): `session_dir`, `user_name`, `vault.{path, meetings_folder, tasks_note, git_commit}`, `audio.{sample_rate (16000 only), meeting_sink, playback_sink, mic_source, route_rules.{mic_in_use, allow_application_name, deny_application_name}, route_poll_s}`, `realtime.{model, compute_type, language, vad_min_silence_ms, segment_max_s, context_minutes, min_avg_logprob, max_no_speech_prob}`, `ask.{backend: claude_cli|api, claude_model, api_model, max_tokens, system_prompt_file}`, `batch.{model, compute_type, diarization, hf_token_env, speaker_naming: raw|manual, retention_days (>=1), max_no_speech_prob}`, `synthesis.{claude_model, template_file, default_tag, tag_policies.<tag>.store_transcript}`.
- Valid `start` tags are exactly the keys of `synthesis.tag_policies` (example: `pessoal`, `client-a`, `client-b`); `scribe start` without `--tag` uses `synthesis.default_tag` (`cli.py:280`). The deck should read `config.yaml` for the tag list; there is no protocol command that lists tags.
- Env: `XDG_RUNTIME_DIR` (required), the var named by `batch.hf_token_env` (default `HF_TOKEN`) must be in the daemon's environment when diarization is on, `ANTHROPIC_API_KEY` for `ask.backend: api`.

### 2.12 systemd units

- Only `systemd/turbidassist-gc.service` (oneshot `ExecStart=%h/.local/bin/postmeet gc`, sandboxed: `ProtectSystem=full`, `PrivateNetwork=true`, `NoNewPrivileges`, `MemoryDenyWriteExecute`, etc., timeout 10 min) and `systemd/turbidassist-gc.timer` (`OnCalendar=daily`, `Persistent=true`, `RandomizedDelaySec=1h`). User units; install instructions in the service header (`turbidassist-gc.service:1-11`).
- **No unit for `scribed` and none for `postmeet run`: NOT IN CODE.** `scribed` is spawned on demand (2.1); `postmeet run` is spawned by the daemon at `stop`.
- Hyprland: `CTRL ALT, SPACE` opens `ghostty --class=com.turbidassist.TurbidAssist -e scribe ui` (`hyprland/turbidassist.conf:37`).

### 2.13 Tests (TurbidAssist)

pytest, per side. Approximate `def test_` counts: realtime: daemon_manifest 90, ask_prompt 41, transcript 35, protocol 28, vad 27, asr_rtf 25, config 23, routing_decide 22, ui 2; batch: vault_policy 159, retention 96, config 34, speakers 20, merge 15, no_speech 4; `tests/smoke_e2e.py` 37; manual capture checklist `tests/realtime/test_capture_manual.md`. Fixture audio `tests/fixtures/sample_meeting_pt/{mic,room}.wav`. I did not run them.

### 2.14 Notes for the deck's Node client

- Connect with `net.createConnection({ path: process.env.XDG_RUNTIME_DIR + '/turbidassist.sock' })`, write `JSON.stringify(cmd) + '\n'`, split incoming data on `\n`, `JSON.parse` each line, dispatch on `type`.
- Use one connection per request/response command (as the Python client does) and a dedicated long-lived connection for `subscribe`; reconnect on EOF (the Textual UI retries; `ui.py` `_watch`).
- Poll `status` (the UI uses 2 s) to learn about start/stop, since subscribe does not push status changes.
- For `ask`, read until `ask_done` or `error`; there is no request id, so never send two asks on the same connection concurrently.
- `stop` can take tens of seconds; do not apply a short timeout to it.
- The socket carries the live transcript with no authentication; the deck's HTTP server should not expose it beyond localhost.
