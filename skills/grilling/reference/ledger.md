# Grilling: the ledger and its buckets

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
