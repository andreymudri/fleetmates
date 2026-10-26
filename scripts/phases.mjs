// Normalize a DECLARED path for phase-conflict detection. This function is
// normalizeDeclarePath: the declarative normalizer for human-authored plan paths.
// Declared paths can contain redundant segments: interior ./ (a/./b.mjs), repeated
// separators (a//b.mjs), multiple leading ./ (././a.mjs), and .. references
// (a/../a/b.mjs). These must be resolved to their canonical form to detect actual
// file collisions that filesetViolations would otherwise catch via enforce.mjs's
// normalizePath.
//
// Relationship to enforce.mjs's normalizePath:
// normalizeDeclarePath = normalizePath + deterministic segment folding.
// Critical property: if normalizePath(a) === normalizePath(b), then
// normalizeDeclarePath(a) === normalizeDeclarePath(b). This invariant ensures no
// path can escape phase serialization while still passing the fileset check: both
// checks normalize via the same git-canonical form first, so any collision that
// filesetViolations catches will also be caught here. Collapsing only over-serializes
// (forces tasks into different phases), never under-serializes (permits concurrent
// writes).
//
// normalizePath is not applied to git output because git output is already canonical.
// This helper is specifically for comparing declared paths typed into plans by humans.
function normalizeDeclarePath(p) {
  // Start with the same basic cleanup as enforce.mjs's normalizePath:
  // backslashes -> slashes, remove leading ./ and leading slashes
  let path = String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

  // Split into segments and canonicalize
  const segments = path.split('/')
  const canonical = []

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      // Skip empty segments (from repeated slashes) and current-directory references
      continue
    } else if (segment === '..') {
      // Resolve parent directory references
      if (canonical.length > 0) {
        canonical.pop()
      }
    } else {
      canonical.push(segment)
    }
  }

  return canonical.join('/')
}

export function assignPhases(tasks) {
  const scheduled = new Set()
  const out = []
  let remaining = tasks.map((t) => ({ ...t }))
  let phase = 1

  while (remaining.length > 0) {
    const taken = new Set()
    const placed = []
    const deferred = []

    for (const t of remaining) {
      const depsReady = t.deps.every((d) => scheduled.has(d))
      const filesFree = t.files.every((f) => !taken.has(normalizeDeclarePath(f)))
      if (depsReady && filesFree) {
        t.files.forEach((f) => taken.add(normalizeDeclarePath(f)))
        t.phase = phase
        placed.push(t)
      } else {
        deferred.push(t)
      }
    }

    if (placed.length === 0) {
      throw new Error(`unsatisfiable dependencies: ${remaining.map((t) => t.id).join(', ')}`)
    }

    placed.forEach((t) => scheduled.add(t.id))
    out.push(...placed)
    remaining = deferred
    phase += 1
  }

  return out
}
