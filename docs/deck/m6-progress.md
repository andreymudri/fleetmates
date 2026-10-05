# M6 implementation progress

Started on 2026-10-05 from `feat/deck`, after the M5 merge. The M1 history is
included. M6 is not complete.

The pure validator follows 10-memory-and-research sections 8.6 and 8.7. It
checks bounded text and collections, reciprocal claim/source references,
source identity, HTTP URLs, citation completeness, no draft frontmatter,
a Sources or Fontes section, and the form's target domain.

The implementation now includes a bounded output reader, authenticated API,
session launch orchestration, form, review screen, palette entry and Home
cards. The lead receives a brief describing scout tasks, the dependent draft
task and the JSON contracts. The deck uses its existing PTY session launcher;
it does not invoke fleetmates write commands itself. A separate internal task
label keeps the topic on session cards rather than the orchestration prompt.

Implementation defaults, still proposed for owner review: the form explicitly
selects a registered repository; outputs are `out/research-<uuid>/draft.md`,
`draft.json` and `scouts/TN.json` in that repository. This follows section 8's
proposed `out/<runId>/` layout. The configured dedicated research workspace is
not initialized automatically. No fleet gate or existing plan was changed.

Migration 0007 stores the authoritative request, repository and lead session
in a strict private `research` table. Agent edits to `request.json` cannot
change the selected domain. The output reader refuses symlink parents and
leaves, non-regular files and files larger than 256 KiB. A content hash changes
when the draft changes; it is groundwork for future preview freshness.
Missing draft files show Scouting while the lead is alive, or Interrupted
after it ends. Polling reads only the run's main repository, never individual
task worktrees. Drafts and requests are not persisted in browser storage.

The pinned published vault-mcp 0.4.0 tool schema has no `preview`, `force_new`
or custom frontmatter parameter. Its write tool cannot currently satisfy the
M6 preview-before-save requirement. Save must remain unavailable until the
dependency ships and its no-write preview contract is tested. The deck must
not emulate preview by writing and reverting.

The npm registry still reports 0.4.0 as latest on 2026-10-05. Preview requests
answer 501 `vault_tool_missing`; Save answers 409 `preview_required`, and the
review button is disabled with an explanation. No vault write is attempted.

Validation: 75 targeted regression tests passed, followed by four new API and
migration tests. Two Research browser tests passed with a real synthetic PTY
session, review reload, source details, Home, palette, safe markdown and axe
checks on the form and review. Each of the six new tests was checked with a
failing source mutation and restored afterwards. The earlier two pure
contract tests also have mutation evidence.

Final combined Memory and Research browser run: 10 tests passed. The security
route subset passed and lists all six Research routes. The full hub run had
1857 tests, 1853 passing and four failures. One was Archive's old assertion
that Home makes no reads while its archived list is closed: Home now reads
research. The assertion was updated to expect that read while still checking
that the archived list is not fetched; all 11 Archive tests then passed. The
other three failures are the previously recorded Chromium bootstrap policy
and two Git 2.52 optional hooksPath failures. They remain enabled. Root code
was not changed in this increment; its preceding M5 run had zero failures.

Remaining work: upstream no-write preview capability and its contract,
preview freshness and approved save, review editing and source toggles,
orphan highlighting during edits, existing-topic suggestions and related-note
selection, richer running scout progress, resolving originating misses after
save, and the three real preset runs. M6 is not complete and must not be
merged as a finished milestone until those checks pass.
