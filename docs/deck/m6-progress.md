# M6 implementation progress

Started on 2026-10-05 from `feat/deck` after the M5 merge, including M1 history.
This is a tested release candidate, not a claim that the milestone exit passed.

Implemented: research form, Quick/Standard/Deep presets, palette and Memory
entry points, existing-note lookup and selection, Home cards, existing PTY
session launch, bounded scout/draft validators and confined output reader,
persistent owner edits, source toggles, orphan citation highlighting, explicit
new-domain confirmation, complete file previews and approved MCP save. Saves
record a research capture and resolve the originating Memory miss. Saved output
is immutable and read only. No research text is stored in browser storage or
event notifications. Home summaries omit draft, source and preview content.

`templates/research.template.md` and the generated launch brief define scout,
draft and Deep verification tasks. Outputs use `out/research-<uuid>/` in the
selected registered repository, following the proposed output layout in
10-memory-and-research section 8. The dedicated research workspace is not
automatically initialized. No existing gate, plan or fleet run state was edited.

Migration 0007 stores the authoritative owner request, repository and session.
Migration 0008 stores owner review, exact preview parameters/revision/identity,
save state and immutable saved output, preserving existing capture rows.
An edit, changed team draft, changed vault identity or mismatched preview ID
blocks saving. The upstream revision catches changes to planned vault files
or templates. A save with an uncertain transport outcome blocks retries;
a process restart treats an in-flight save the same way.

The vault-mcp preview/save contract is published as 0.5.0, tagged v0.5.0 upstream,
and pinned in the Deck's test dependency and lockfile. Preview plans the note,
MOC, knowledge index and daily note without writing files, creating directories,
committing or pushing. Approved save repeats the exact input and timestamp and
checks the revision before writing. `force_new` preserves existing notes.

Validation includes synthetic Git vault snapshots covering every file and
Git byte before/after preview; exactly one approved commit with precisely the
previewed files and contents; stale templates; existing-note preservation;
structured MCP stale errors; deck edit/revision/orphan/approval/error-state
checks; and Chromium review/edit/source/preview/save/reload with axe checks.
Contract checks now run against the published npm package by default. They
verify the ten-tool schemas and preview capability, a no-write preview followed
by exactly one approved synthetic vault commit, and the browser edit, citation,
preview, save and reload flow. All nine published-package integration/browser
checks passed. The full Deck suite passed all 1869 tests with the published
release; the three research browser tests also passed. The optional file-URL
bootstrap navigation used its existing override because local Chromium policy
blocks it; other browser checks remained enabled. Capability removal and a wrong approved revision each produced
failing tests, with source restored afterwards. No real vault or authenticated
Claude session was used.

Remaining exit work: three owner-authorized real research runs, one per preset.
Existing topics now support a new linked note; richer scout progress and Discard remain proposed UI follow-ups. The
M1 one-week dogfood check remains separate. No real vault or real Claude
session was used for these tests.
