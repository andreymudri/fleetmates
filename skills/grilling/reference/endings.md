# Grilling: what it cannot settle, and where it ends

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
