---
name: grilling
description: Use when a plan, spec or design still has unresolved decisions, when the user says "grill me" or asks to be interviewed, when requirements feel fuzzy or underspecified, or when `brainstorming` reaches its question phase.
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

1. Take the top entry of the **OPEN** bucket — the one blocking the most below it.
2. Fact-find first: if the repository, docs or history answer it, read them and state the answer
   instead of asking.
3. Ask exactly one question, as one `AskUserQuestion` call.
4. Record the answer in the ledger: move the entry to **RESOLVED** with the option chosen, and
   add any new child decisions the answer opened to **OPEN**, in blocking order.
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

## The shape of one turn

**Ask with `AskUserQuestion`, never in prose. One question per `AskUserQuestion` call, one call
per turn** — do not batch several questions into one call. Prose hides what the decision turns
on, the same reason `using-fleetmates` refuses to put the fleet-or-inline choice in prose: a
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

> `AskUserQuestion`, header `Ledger`, one question:
>
> **Where does the run ledger live?** This decides who can corrupt it, and it sets up who may
> write it during a fix round.
>
> 1. label `Worktree` — `.fleetmates/<run-id>/` in the working tree. Simplest, but a task branch
>    can reach it, so "who may write it" stays open and needs a guard.
> 2. label `Common dir (recommended)` — one copy every worktree shares. Closes the
>    concurrent-write branch, and makes retention a git-cleanup question rather than a new one.
> 3. label `Temp dir` — survives a branch reset, lost on a fresh clone, so it reopens resume and
>    rebuild as branches of their own.

Labels stay short and plain, with the recommendation marked inside the label text: a label is
emitted verbatim, so markdown in it reaches the user as literal asterisks. No fourth entry is
declared for the user's own words; the prompt already offers one.

Where the orchestrator has no `AskUserQuestion` tool, offer the options as a numbered list and
read the user's pick, marking the recommended one the same way.

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

```
RESOLVED
- Ledger location: git common directory (user picked option 2, this session)
- Retention: never auto-deleted (user typed their own answer, this session)

OPEN (ordered — each blocks the ones below it)
1. Who writes the ledger during a fix round?
2. What does a reader do with a half-written entry?

DEFERRED
- Digest output format — needs a prototype to judge readability.
  Reopens when the first multi-phase run produces real output.
```

Three buckets, nothing else. **Resolved** carries the decision, who decided it, and which option
was chosen — including when the user typed one of their own rather than picking — so a later
reader can tell a user ruling from your assumption. A typed answer is a new branch: before the
next question, check whether it has reopened anything already resolved, and move those entries
back to **Open**. **Open** is ordered by what blocks what, so the next question is always the top
entry. **Deferred** carries the reason and the trigger that
reopens it, so deferral is a decision rather than a leak.

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

## What is not grillable

Low-fidelity decisions resolve well in conversation: naming, routes, data shape, ordering,
ownership, error behaviour. High-fidelity ones do not — "how should this feel", "is this fast
enough", "is the output readable" are answered by a prototype or a spike, and a user pressed
for an answer will invent one that neither of you can trust. Park those in **Deferred** with
the experiment that would settle them.

## Where this ends

The ledger is the handoff; name where it goes before you stop.

- **Arrived from `brainstorming`** — return to its step 3 carrying the ledger. Its resolved
  decisions become the design, its deferred items appear in the design doc with their triggers.
- **Invoked directly against a written plan or spec** — hand the ledger to `writing-plans`, so
  the resolved decisions land in the plan rather than in the chat history.
- **The gaps turn out to be design-level** — a greenfield request with no design behind it is not
  an interview short of a few answers. Route into `brainstorming` and run the question phase from
  there. Grilling onward would carry a fuzzy request straight to a plan and skip the approval gate
  `brainstorming` exists to enforce, which no amount of resolved detail substitutes for.

## Scope guard

If the subject is too large to hold — several independent subsystems, or a tree you cannot see
the bottom of — say so and split it into grillable chunks, then grill the first chunk. A long
interview over a sprawling subject degrades: the later answers stop being consistent with the
earlier ones.

## Red flags

| Thought | Reality |
|---------|---------|
| "I'll batch these five questions into one message" | The user answers three of them, and the two you lose are the ones they had no opinion on yet — the ones worth a round. |
| "I'll just ask where the config lives" | If a file answers it, reading it costs you a tool call and asking costs the user a round. Read it and state what you assumed. |
| "Five questions in, that feels like enough" | A count is not a stop condition. Read the ledger: if a branch is open, the interview is not done. |
| "They don't seem sure, I'll press until they decide" | An extracted answer to a high-fidelity question is noise with a confident tone. Defer it with the experiment that would settle it. |
| "This question is too open-ended for options" | If you cannot name even two real positions, you do not understand the branch well enough to ask about it yet. Fact-find first, then ask. |
| "That detail can be figured out during implementation" | Then it will be, by whoever gets there first, invisibly. Put it in the ledger as deferred, with the trigger that reopens it. |
