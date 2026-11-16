---
name: brainstorming
description: Use when starting any creative work - creating features, building components, adding functionality, or modifying behavior. Explores intent and design before implementation.
---

# Brainstorming Ideas Into Designs

_Adapted from the MIT-licensed superpowers plugin by Jesse Vincent. See NOTICE.md._

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions in rounds of up to four at a time to refine the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

You MUST complete these in order:

1. **Explore project context** — check files, docs, recent commits
2. **Ask clarifying questions** — hand this phase to the `grilling` skill: questions one at a
   time, walked as a design tree, with an open-questions ledger. Its resolved decisions and
   deferred items carry into the design doc
3. **Propose 2-3 approaches** — with trade-offs and your recommendation
4. **Present design** — in sections scaled to their complexity, get user approval after each section
5. **Write design doc** — save to `docs/specs/YYYY-MM-DD-<topic>-design.md`
6. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
7. **User reviews written spec** — ask user to review the spec file before proceeding
8. **Transition to implementation** — invoke the `writing-plans` skill to create an implementation plan

**The terminal state is invoking `writing-plans`.** Once the design is approved, do NOT invoke any other implementation skill: the ONLY skill you invoke after the design is `writing-plans`. The one skill invoked before then is `grilling`, which runs step 2's question phase and hands its ledger back here — it is part of this process, not a transition out of it.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope. A request that describes several independent subsystems is decomposed first: see `reference/design-guidance.md`.
- For appropriately-scoped projects, invoke the `grilling` skill and run the question phase there: questions in rounds of **up to four at a time**, never batching a question with one it depends on, walked as a design tree, each carrying your recommended answer, with an open-questions ledger
- `grilling` governs the form of those questions — asked in rounds of up to four with declared options, never as prose. Do not run a second, looser question phase here
- Focus on understanding: purpose, constraints, success criteria
- The ledger the interview produces is an input to the design doc: every resolved decision appears in the design, and every deferred item appears with its reason and the trigger that reopens it

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why
- YAGNI ruthlessly - remove unnecessary features from every approach and design

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Documentation:**

- Write the validated design (spec) to `docs/specs/YYYY-MM-DD-<topic>-design.md`
  - (User preferences for spec location override this default)
- Commit the design document to git

**Spec Self-Review:**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.
5. **Ledger check:** Is anything from the `grilling` ledger left unresolved or silently dropped? Every resolved decision must appear in the spec, and every deferred item must appear with its reason and the trigger that reopens it.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate:**
After the spec review loop passes, ask the user to review the written spec before proceeding:

> "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan."

Wait for the user's response. If they request changes, make them and re-run the spec review loop. Only proceed once the user approves.

**Implementation:**

- Invoke the `writing-plans` skill to create a detailed implementation plan
- Do NOT invoke any other skill at this point. `writing-plans` is the next step. (`grilling` belongs earlier, at step 2, not here.)

## When to read a reference

| Situation | Read |
|---|---|
| The request is too large for one spec, or the design has unit boundaries to draw or existing code to fit | `reference/design-guidance.md` |
| The order of the steps, or which step loops back, is unclear | `reference/process-flow.md` |
