# Writing plans: fog, entry rules and enforcement of the header sections

**The fog-or-task test**, and the rule the whole feature rests on — it turns on
dispatchability, not sharpness:

> Can you write it as a task — a declared file set, and acceptance criteria a green suite would
> satisfy? If yes, it is a task, even when it is blocked and cannot be worked yet. If no, it is
> Not Yet Specified, however sharply you can phrase the question.

The consequence: do not pre-slice fog into task-shaped pieces. One fog entry may graduate into
three tasks, or into none. A question can be perfectly sharp and still have nowhere to go —
sharpness is not the test, dispatchability is.

**The two entry rules, and what each is for:**

- Every `## Out of Scope` entry needs a reason clause — a separator (em dash, en dash, spaced
  hyphen, or spaced double hyphen) followed by at least one non-whitespace character. A reason
  clause is what makes a boundary reviewable; an entry without one is a word, not a decision.
- Every `## Not Yet Specified` entry must contain a `?` — anywhere in the entry, not necessarily
  at the end, so the question can carry the context that makes it worth reading. A question mark
  is what keeps fog from becoming a dumping ground for work nobody wanted to size.

**What enforces these rules.** `init-run` parses the header sections from the plan in the working
tree and refuses the run, with exit 2, on a malformed entry or a missing Destination, Statement
or Acceptance. `rebuild-state` reads the plan at the anchor and, on the same defects, rebuilds
the section fields as empty instead of refusing. The rules check shape — a separator is present,
a `?` is present, a section has prose or an entry — not truth: whether a reason is a good one, or
an acceptance entry really follows from the statement, is what `plan-check` and review are for.

**An `## Out of Scope` entry does not answer a reviewer's finding.** A finding relocated there
is still a finding, and moving it changes nothing about whether it is real. The mechanical rules
cannot catch this: a well-formed entry with a plausible reason is exactly what silencing a
finding would look like to a parser.
