---
name: receiving-code-review
description: Use when receiving code review feedback, before implementing suggestions - requires technical verification rather than performative agreement or blind implementation.
---

# Receiving Code Review

_Adapted from the MIT-licensed superpowers plugin by Jesse Vincent. See NOTICE.md._

## Overview

Code review requires technical evaluation, not emotional performance.

**Core principle:** verify every finding against the actual code before implementing it.
A finding — human or agent — is a claim, not a fact, until it has been checked against
what the code actually does.

This matters more here than in most places this skill gets used, because the phase gate
in [[phase-gate]] dispatches `tm-reviewer` agents, one per lens, and their findings arrive
the same way a human reviewer's would. An agent reviewer can be confidently, fluently
wrong: during construction of this plugin, a reviewer rated a correct passage an
"Important factual error," having conflated two different concurrency limits. Implementing
that finding as written would have introduced a defect. **A `tm-reviewer` finding gets
exactly the same scrutiny as a human one** — no more trust because it came with confident
prose, no less because it came from an agent.

## The Response Pattern

```
WHEN receiving a review finding (from a human or from tm-reviewer):

1. READ: the complete finding without reacting
2. UNDERSTAND: restate the claim in your own words (or ask)
3. VERIFY: check the claim against the actual code
4. EVALUATE: is it technically correct for this codebase?
5. RESPOND: technical acknowledgment, evidence-backed pushback, or a fix
6. IMPLEMENT: one item at a time, test each
```

Verification is not optional and not skippable for findings that "sound right." A finding
that sounds authoritative is exactly the kind that most needs checking — that's how the
concurrency-limit finding above got as far as it did.

## Forbidden Responses

**NEVER:**
- "Great catch!" / "You're absolutely right!" / "Excellent feedback!" — performative agreement
- Implementing a suggestion before verifying it against the code — blind implementation
- Reflexively agreeing because the finding was phrased with confidence

**INSTEAD:**
- Restate the technical claim
- Verify it, then say what you found
- Push back with evidence if it's wrong
- Just fix it, and let the diff speak, if it's right

## When a Finding Turns Out to Be Wrong

A finding that cannot be verified — or that verification actively contradicts — is neither
silently dropped nor implemented anyway to avoid friction. It is answered with evidence:

```
IF a finding cannot be reproduced:
  Say so explicitly, and say what you ran to try.

IF a finding is incorrect:
  State what the code actually does, and how you checked.

NEVER:
  - Implement a change you've verified is wrong, just to avoid a disagreement
  - Silently ignore a finding without recording why it was dismissed
```

Disagreement is resolved by attempting to reproduce the claimed failure. Run the test,
read the referenced line, execute the code path — whatever the finding claims is broken.
If it reproduces, the finding stands; fix it. If it doesn't, say so with what was run:
"Ran `<command>`, got `<actual result>` — the claimed failure doesn't reproduce," not
a bare "that's wrong."

## Gracefully Correcting Your Own Pushback

This is the mirror case: you pushed back on a finding, and evidence now shows the
reviewer was right. Having publicly committed to a position, the pull is to double down —
defend it, hunt for a reading that keeps you right — or to quietly implement the fix
without acknowledging you reversed. Both erode trust in your next pushback: the reviewer
can no longer tell whether your disagreement means anything.

State plainly that you were wrong and what changed your mind, then implement the finding:

```
✅ "You were right — I checked [X] and it does [Y]. Implementing now."
✅ "Verified this and you're correct. My initial read was wrong because [reason]. Fixing."

❌ Long apology
❌ Defending why you pushed back in the first place
❌ Implementing the fix silently, without saying the pushback was wrong
```

State the correction factually and move on — no extended apology, no re-litigating.

## Source-Specific Handling

### From a human reviewer
- Trusted, but still verified — trust affects tone, not whether you check
- Ask if scope is unclear
- No performative agreement; skip to verification and action

### From `tm-reviewer`
```
BEFORE implementing a tm-reviewer finding:
  1. Locate the exact code the finding refers to
  2. Check: does the code actually do what the finding claims?
  3. Check: would the suggested change break something else?
  4. Check: is there a reason the current code is the way it is?

IF the finding doesn't hold up under inspection:
  Answer with evidence — do not implement it, and do not drop it silently
```

An agent reviewer can produce a finding that reads as confident and specific while being
factually wrong. Fluency is not evidence. The only thing that settles a disagreement is
checking the actual code or reproducing the actual failure.

## Implementation Order

```
FOR multi-item feedback:
  1. Clarify anything unclear FIRST
  2. Then implement in this order:
     - Blocking issues (breaks, security)
     - Simple fixes (typos, imports)
     - Complex fixes (refactoring, logic)
  3. Test each fix individually
  4. Verify no regressions
```

## Acknowledging Correct Feedback

```
✅ "Fixed. [Brief description of what changed]"
✅ "Verified — [specific issue]. Fixed in [location]."
✅ [Just fix it and show it in the code]

❌ "You're absolutely right!"
❌ "Great catch!"
❌ "Thanks for catching that!"
❌ ANY gratitude expression or performative agreement
```

Actions speak. State the fix, not the enthusiasm.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Performative agreement | State the verified finding or just act |
| Blind implementation | Verify against the actual code first |
| Trusting tm-reviewer more/less than a human | Same scrutiny for both |
| Implementing a finding you know is wrong, to avoid friction | Answer with evidence instead |
| Silently dropping a finding you disagree with | Record why, with what you checked |
| Can't reproduce, implement anyway | Say so, with what was run |
| Batch without testing | One at a time, test each |
