# Reviews and instruction lint

Moved from the project README. The review commands are listed under [Commands](../../README.md#commands) in the README.

Reviewer dispatches now check the tracked task specification and declared scope before their
assigned quality lens. The recorded plan path is used by default; `review-dispatch --plan <path>`
can name it explicitly. Unverifiable specifications use `unableToVerify`, which prevents a clean
review result. Implementer summaries start with the next action and step progress, then include
actual verification commands, worktrees, exit status and output tied to the final tested commit.
These instructions do not replace Git-derived checks or prove that an agent ran a command.

Instruction security lint runs in CI and inside the mandatory fileset check for committed skill
and agent changes. It also checks declared instruction files of tasks already integrated, so
merging before verification does not bypass the scan. It uses fixed diagnostics with file/line
and rule identifiers, without forwarding instruction text to the lead or running that text.

```sh
node scripts/security-lint.mjs --root .
node scripts/security-lint.mjs --root . --changed main --ref HEAD --json
```

The standalone command scans `skills/` and `agents/`; changed-commit mode also recognizes nested
skill/agent directories and `AGENTS.md`. Refs are HEAD, full commit IDs, branch names or qualified
refs. Committed scans read the immutable Git blobs, not worktree copies. Local scans reject
observable links and non-regular files. Inputs are limited to 512 KiB per file, 256 instruction
files and 5,000 filesystem entries; diagnostics cap each file at 100 findings plus a truncation
marker. Exit 0 means no matching rule, 1 means findings, and 2 means the scan could not complete.

Rules flag format/control characters except normal whitespace, mixed Latin/Greek/Cyrillic words
and compatibility spellings, hidden comments or inline HTML/CSS, long whitespace padding,
refusal overrides, unconditional skill triggers and recognizable provider shell-outs. The exact
shipped startup description of `using-fleetmates` has an explicit entrypoint exception. Lint is
heuristic: quoted examples can trigger findings, obfuscated attacks can evade it, and a clean
result is not proof of safety. It does not install, execute or fetch scanned instructions.

One lens carries a method of its own. `claims` reads the diff for sentences asserting a guarantee —
a comment, a skill line, a spec line — then breaks what each one protects and runs the suite: a
claim whose mutation leaves the suite green is a finding. It is bounded, not exhaustive. It probes a
capped number of the claims it enumerates and reports the rest under an `unprobed` key, and it
returns nothing at all when it cannot get a green baseline first.
