# Command log evidence for issue 25 W04

## Destination

Command gate results preserve retrievable output outside disposable previews,
with bounded summaries and explicit incomplete evidence. This implements the
retained-log obligation in the existing context and evidence specification.

## Global Constraints

- Node >= 24.2.0; zero new runtime or development dependencies.
- Commit messages are single-line, commitlint style, English.
- Do not modify existing gate manifests, plans or fleet run state.
- Logs are local observations, never command execution proof or policy input.
- Preserve Git-derived enforcement, test inventory and process-group cleanup.
- Private temporary log files retain combined raw stdout/stderr with a 16 MiB per-command bound; retention ends when the operator or operating system removes them.
- Keep command summaries bounded to 64 KiB of captured output and 40 lines.
- A truncated or unwritable log cannot satisfy complete command evidence.

### Task 1: Capture private command evidence and compact outcomes

**Files:**
- Create: `scripts/command-log.mjs`
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/command-log.test.mjs`

**Acceptance:**
- Successful and failing real commands return retrievable log paths, exact raw bytes, SHA-256 content hashes and completeness metadata.
- Streaming output is retained outside the command cwd and survives preview removal; command summaries remain bounded while direct executor callers preserve their existing behavior.
- File creation is exclusive in a private new temporary directory with restrictive permissions on supported platforms.
- Timeout, output truncation and storage errors remain explicit and cannot produce a passing command check with complete evidence.
- Custom executors that return buffered output continue to work and retain their output.
- New tests must fail under targeted mutations, then pass after restoration.

### Task 2: Document retained evidence and remaining obligations

**Depends:** T1

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/2026-10-06-context-and-evidence-design.md`
- Modify: `docs/specs/2026-10-06-issue-25-progress.md`

**Acceptance:**
- Explain private log location, byte and summary bounds, incomplete evidence, sensitive output, cleanup and temporary retention limits.
- Keep independent failure classification, semantic acceptance, durable recovery and real evaluations explicitly outstanding.
- Run the full root and hub command checks, instruction lint and inline correctness/security/tests/claims review without changing gate policy.
