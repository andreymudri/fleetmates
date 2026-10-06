# M5 exit report (Memory / Ask)

Prepared on 2026-10-05. Implementation and release preparation are complete for
private package 0.5.0, build `m5`. Manual exit criteria remain owner-pending.
No release tag, package publication or dogfood service restart is claimed.

## Exit criteria

| Criterion | Evidence | State |
|---|---|---|
| Published vault-mcp 0.4 with graph | Exact 0.4.0 devDependency, real MCP contract and tools/list snapshot | Green |
| Fake-vault Memory and Ask behavior | Vault service, API, Ask, exit and browser suites cover graph, citations, misses, general knowledge, cancellation, recovery and history | Green |
| Graph latency under 500 ms on 1000 notes | Five measured calls after warmup: p50 56.86 ms, p95 64.46 ms with published 0.4.0 | Green |
| Twenty real vault questions | Owner records query, expected note, returned citations and result | Pending |
| Two weeks of reviewed misses | Owner reviews retrieval misses and records resolutions | Pending |

The real restricted-Claude proof in D-132 remains owner-pending. Automated
checks inspect the read-only argv and exercise a fake CLI that refuses write
tools. They do not prove the installed real CLI's enforcement. The M1 dogfood
week remains pending; its gate was waived for M5 and M6 by D-125.

## Validation

Memory browser suite: 8 tests passed, including keyboard navigation, thread
reload, browser-storage privacy, cancellation, timeout, palette, Focus,
hostile text and axe checks across graph, lists, notes, answer cards, history,
degraded state and palette. The authenticated-route security subset passed.
New tests were checked with 49 source mutations, each producing a failure
before restoration.

| Suite | Result |
|---|---|
| Root | 2796 tests: 2779 pass, 17 skipped, zero failures |
| Hub full suite | 1851 tests: 1847 pass, 4 failures |
| Memory browser | 8 pass, zero failures |
| Security authenticated-route subset | 1 pass, zero failures |

One hub failure was a stale reload-key assertion left at `m4` after the build
bump. It was updated to `m5`; all 25 tests in the web-shell file then passed. The
other three failures reproduce environment problems: Chromium policy blocks
the bootstrap `file:` URL, and Git 2.52 crashes while querying an optional
hooksPath in two tier tests. Those unrelated assertions remain enabled.

Privacy checks cover the real server entrypoint with synthetic children,
question and answer absence from logs, spool and events, thread deletion,
and confidential-meeting scrubbing of recognized database backups. Miss
export uses a read-only database and private output permissions.

## Limits and deviations

Filters use native controls and the graph legend is collapsible. Zoom is
bounded but has no animated interpolation. Note excerpts use explicit body
line offsets when available; otherwise the frontmatter offset is estimated,
so unusual YAML can select an adjacent section. Palette supports question
mode and note search; its ordinary empty-search state has no Ask fallback.

No real Claude session, owner vault or external recording service was used.
The root package keeps zero dependencies. deckd and the tested Claude Code
version are unchanged. Migration 0006 stores Ask threads, captures and misses.

## Owner evidence log

For each of twenty questions record date, query, expected note path, returned
citations, pass or miss, and explanation. For two weeks record each retrieval
miss and whether it was dismissed or resolved to a note. Run the restricted
CLI proof against the installed Claude version before declaring manual exit.
