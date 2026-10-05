# M6 implementation progress

Started on 2026-10-05 from `feat/deck`, after the M5 merge. The M1 history is
included. M6 is not complete.

The first implemented piece is a pure validator for scout and draft output,
following 10-memory-and-research sections 8.6 and 8.7. It checks bounded text
and collections, reciprocal claim/source references, source identity, HTTP
URLs, citation completeness, no draft frontmatter, a Sources or Fontes
section, and the form's target domain. It does not launch runs or save notes.
Both unit tests passed and each was verified by a failing source mutation,
with the implementation restored afterwards.

Output location and run repository remain open decisions. Keep the existing
proposed `out/<runId>/` layout until the research orchestrator establishes the
actual run contract. No fleet gate or existing plan was changed.

The pinned published vault-mcp 0.4.0 tool schema has no `preview`, `force_new`
or custom frontmatter parameter. Its write tool cannot currently satisfy the
M6 preview-before-save requirement. Save must remain unavailable until the
dependency ships and its no-write preview contract is tested. The deck must
not emulate preview by writing and reverting.

Next work: research output reader and launch orchestration, form, review UI,
preview freshness and save guards, Home and palette entry points. Real runs
for all three presets remain owner-pending.
