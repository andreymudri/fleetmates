# Acceptance evidence: design

Status: design answers given by the owner on 2026-11-21; this document awaits the owner's review.

## Why

A plan states what must be true of the finished work under `## Acceptance`. `plan-check` compares
those entries with the request before the first task, and the final reviewers judge the diff
against them. Nothing records which entry was verified, or how. A session can end a task without
having checked one, and nobody sees it.

This change gives each entry a recorded state and a command that lists the entries left without
evidence. It is aimed at the inline path. A fleet run gets the same list from `finish`.

## Limits

- The evidence is declared by the session that did the work. It is a record, not a proof.
- It does not catch a wrong plan or a misread request: when an entry is wrong, its evidence is
  recorded all the same. `plan-check` covers that.

## Command

    cli.mjs acceptance --run <id> --plan <path> [--root <path>]
    cli.mjs acceptance --run <id> --plan <path> --entry <A1> (--pass | --fail) --note <text> [--root <path>]

- Entries come from the plan's `## Acceptance` section in the working tree, numbered in order:
  `A1`, `A2`, and so on.
- Without `--entry` the command lists every entry with its state: `pass`, `fail`, or no evidence.
  An entry with evidence also shows the note, who recorded it, the commit it was recorded at, and
  how many commits the current `HEAD` is ahead of that commit.
- With `--entry` it records the state and the note at the current `HEAD` commit. Recording again
  replaces the earlier evidence for that entry.
- The note is required, at most 1024 characters.
- The command runs nothing: no test suite, no gate check.

## Rules

- **Changed entry.** The evidence stores a hash of the entry's text. When the text in the plan no
  longer matches, the evidence does not count: the entry is listed as having no evidence, with a
  line saying the entry changed since it was recorded.
- **No verdict on age.** A commit made after the evidence does not invalidate it. The list shows
  the commit and the distance, and the reader decides.
- **Exit codes.** 0 when every entry has `pass` evidence; 1 when an entry has no evidence or has
  `fail`; 2 for an entry that does not exist or a malformed invocation. A plan without an
  `## Acceptance` section prints nothing and exits 0.
- **Identity.** The recorder is the value of `CLAUDE_CODE_SESSION_ID`, or `terminal` outside a
  session, as for tickets.
- **Printing.** The note and the entry text are data. Every line that carries them goes through
  `printable`.

## Storage

`.fleetmates/<run-id>/acceptance.json`, beside the run's `plan.json` and `status.json`:

    { "version": 1, "entries": { "A1": { "textSha256": "...", "status": "pass", "note": "...",
      "commit": "...", "by": "...", "at": 1763700000000 } } }

A file that cannot be parsed, or with a version the command does not know, is reported by name
and the command exits 2. Nothing repairs or replaces it. The write is atomic (a temporary file,
then a rename).

A run that does not exist is refused with exit 2: evidence belongs to a run created by `init-run`.

## finish

After its summary, `finish` prints the same list when the plan has an `## Acceptance` section.
The verdict and the exit code of `finish` do not change, including when an entry is recorded as
`fail`: the verdict comes from the gate's checks only.

## Skill

`executing-plans`, in its last step: record the evidence for each Acceptance entry, run the list,
and name in the final message the entries left without evidence. Turning those into tickets is
already the rule of the `tickets` skill; no new rule is added for it.

`finishing-a-development-branch` is not changed.

## Testing

Each rule gets a test that is shown to fail when the rule is removed:

- record, list, and record again replacing the earlier evidence;
- an entry whose text changed is listed as having no evidence;
- the three exit codes, and silence for a plan without Acceptance;
- an unknown entry, a missing note, both or neither of `--pass` and `--fail`, an unknown run;
- a damaged evidence file is named and refused;
- `finish` prints the list and keeps its verdict and exit code;
- a note with control characters cannot repaint the terminal.

## Out of scope

- Blocking `finish`, or invalidating evidence when a commit is added.
- The CLI running verification commands.
- Anything for the fleet: independent or blind acceptance tests are a separate proposal that
  depends on an eval.
- `workflow-accept`. It records acceptance evidence for the strict Workflow controller, which
  needs a retained request and the execution journal. It is neither reused nor changed.

## Deferred

- **Evidence written by the gate.** The separate fleet proposal would write to this same file with
  the gate as the recorder. Reopens if that proposal is built.
- **Whether the list earns its place in `finish`.** Reopen after real use on a few runs.

## Decision ledger

RESOLVED (owner, 2026-11-21)

- Where the list appears: its own command, and `finish` as well.
- Evidence: a state and a required note.
- Age: show the commit, no verdict.
- Exit code of the list: 1 when something is missing or failed.
- A recorded `fail` does not change the verdict of `finish`.
- An entry left without evidence is reported in the final message and offered as a ticket.
