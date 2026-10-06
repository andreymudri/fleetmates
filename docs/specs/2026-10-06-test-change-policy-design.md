# Honest test-change policy (#25 W05, C2)

The manifest's optional `tdd` kind is a Git-computed test-change policy. It
never claims tests ran red before implementation. Test changes and execution
are separate evidence. Temporal TDD remains unverified, including squashed
and files-mode branches. Existing inventory/drop protections are unchanged.

For each task in the current phase, compare its qualified task branch tip
with its actual merge base against the current run tip. For an integrated
tip, use the first parent of its integrating merge, never the run-wide anchor.
An integrated tip without a matching merge is explicitly unmeasurable. A missing branch is a
failure. Split changed paths using declared `tests.match` globs or common
Node test/spec globs. A source change without a test change fails unless every
source path has a manifest-declared exception with a reason and evidence
reference. Reasons include documentation, assets, behavior-preserving work
and behavior already covered by existing tests. Exceptions are declarations,
not independent coverage proof. The output says so explicitly.

A token test edit can satisfy this syntactic policy, but cannot establish
coverage or acceptance. Project command/inventory checks and current
acceptance evidence are still required. This work does not independently run
regression tests on pre-fix and candidate trees; that remains a W05 obligation.

Malformed test-match configuration, exceptions and task identities fail rather than silently
reducing scope. Tests use real Git branches and ensure missing test changes,
exceptions, existing test changes and missing branch tips have distinct results.
