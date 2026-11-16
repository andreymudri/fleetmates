---
name: grilling
description: Use when a plan, spec or design has unresolved decisions, the user says "grill me" or asks to be interviewed, requirements feel fuzzy, or `brainstorming` reaches its question phase.
---

# Grilling Requirements

Interview the user until the design has no unresolved branches left — not until you run out
of questions.

## When to use

A feature, spec or plan is described well enough to start arguing about, and badly enough that
two competent implementers would build different things. Also whenever `brainstorming` reaches
step 2: that step's question phase is this skill.

## The loop

Each round, in order:

1. Take the top entry of the **OPEN** bucket — the one blocking the most below it — and, walking
   down the bucket, up to three more entries whose answers do not depend on it or on each other.
2. Fact-find first: if the repository, docs or history answer one of them, read them and state the
   answer instead of asking. Refill the round from **OPEN** the same way.
3. Ask up to four questions, as one `AskUserQuestion` call.
4. Record every answer in the ledger: move each entry to **RESOLVED** with the option chosen, and
   add any new child decisions the answers opened to **OPEN**, in blocking order.
5. If the user typed their own answer, check what it reopened and move those entries back to
   **OPEN** before continuing.
6. When a branch closes, restate the ledger.

Repeat until the interview meets its stop condition below.

## The design tree

A feature is a tree of decisions, not a flat list of unknowns. Every decision opens the decisions
that hang off it: choosing a storage location opens who owns writes, which opens what happens on
a concurrent write. Walk it branch by branch — resolve a parent before the children that depend
on it, and finish a branch before starting the next. Scattered questions produce answers that
contradict each other, because each was answered against a different imagined design.

A round of four does not change that order; it only fills the round with what is already
askable. Siblings under a resolved parent are the natural batch: once storage is decided, who
owns writes and how long entries are kept can be answered side by side. A child whose options
depend on an answer in this round waits for the next round, because its options cannot be
written until the parent is known. Questions from another branch may fill a round only when
nothing in the current branch is askable and their answers cannot change each other.

## The shape of one turn

**Ask with `AskUserQuestion`, never in prose. Up to four questions per `AskUserQuestion` call, one
call per turn** — and never put a question in the same call as a question it depends on, because
the user answers both against a parent that is not settled yet. Ask fewer when fewer are
independent; never pad a round to reach four with a question the ledger does not need yet. Each
question keeps its own short `header`, so the user can tell the decisions apart at a glance. Prose
hides what the decision turns on, the same reason `using-fleetmates` refuses to put the fleet-or-inline choice in prose: a
paragraph reads as commentary, options read as a decision with consequences attached.

Each question declares **two to four options, three by default**, one of them flagged as your own
recommended answer so agreeing is a single click. Every option must be a real, distinct position:
a genuinely binary decision gets two, and padding it to three with a strawman turns it back into
a prose question wearing options. The question text says why this matters and what breaks if it
is wrong; each option's description says what choosing it commits them to downstream, which later
branches of the tree it opens and which it closes — that is the payoff of walking the tree in
order. You do not declare a "something else" option: Claude Code appends a free-text entry to
every `AskUserQuestion` prompt itself, so the user can always type an answer none of yours
offered, and a typed answer is a new branch that can reopen what was already resolved.

A worked question, the rules for labels, and what to do without the tool are in
`reference/asking.md`.

## Fact-find rather than ask

If the repository, the docs or the git history can answer it, go read them and state what you
found: "the gate config already has a `checks` array, so I am assuming the new check is a
fourth entry, not a new file." Only ask what genuinely lives in the user's head — intent,
priorities, constraints you cannot observe, what "good" looks like. Never hand the user a
lookup you could have done; each one spends a round and teaches them that answering you is
expensive.

## The open-questions ledger

Keep a ledger visible across the interview: restate it in the message that closes a branch, and
for an interview long enough to lose it, keep it in a scratch file and name the path — the design
doc's self-review in `brainstorming` assumes the ledger is still there to check against. It is what
makes the remaining gaps countable instead of a feeling.

An example ledger, and what each of its three buckets carries, are in `reference/ledger.md`.

## Coverage sweep

Before declaring the interview done, walk this list on purpose and put anything untouched into
the ledger as open or deferred:

- Purpose, and the success criteria that say it worked
- Users, and the moment that triggers the feature
- Inputs, outputs and interfaces
- Data and state: what exists, who owns writes
- Failure modes and error handling
- Edge cases and limits
- Concurrency and ordering, where more than one actor touches the same thing
- Migration and backwards compatibility
- Security and trust boundaries
- Observability: what someone sees when it misbehaves
- Testing strategy
- Explicit non-goals

## Stop condition

Stop when no branch is open and the user confirms the ledger reads complete. **A question count
is never a valid stop condition** — not five, not twenty. Finishing early with open branches hands
the unknowns to the implementer, who will resolve them silently and differently.

## When to read a reference

| Situation | Read |
|---|---|
| Writing the options of a question, or asking without `AskUserQuestion` | `reference/asking.md` |
| Restating the ledger, or recording a typed answer or a deferral | `reference/ledger.md` |
| A decision that conversation cannot settle, a subject too large, or handing the ledger off | `reference/endings.md` |
| A reason to batch more, stop early or skip a lookup comes to mind | `reference/red-flags.md` |
