// Coupling and inventory for a target project, computed from git history alone.
//
// The question an implementer needs answered is "what will my change break", and the cheapest
// honest answer is which files have historically changed alongside the ones it holds. No parser,
// no language support, no index: `git log --name-only` says it for every language at once.
//
// What this measures is CORRELATION IN HISTORY, not a dependency. Two files that always change
// together may be caller and callee, or a source and its test, or two things one person happened
// to keep tidy. That is why nothing here decides anything — it is injected into briefs as context
// and read by operators, and no gate consults it.
//
// Pure: it takes commit file-sets and returns numbers. Reading git belongs to the caller.

// Commits touching enormous numbers of files — a mass rename, a vendored drop, a formatting
// sweep — couple everything to everything and drown the real signal. They are excluded by size
// rather than by message, because a message is a convention and a size is a fact.
const DEFAULT_MAX_COMMIT_FILES = 40
// A file seen in one or two commits produces 100%-confidence pairs that mean nothing. The floor
// is what stops a brand-new file from looking maximally coupled to whatever it arrived with.
const DEFAULT_MIN_SUPPORT = 3

export function buildCoupling(commitFileSets = [], { maxCommitFiles = DEFAULT_MAX_COMMIT_FILES } = {}) {
  const support = new Map()
  const pairs = new Map()
  let usedCommits = 0

  for (const files of commitFileSets) {
    const unique = [...new Set(files ?? [])]
    if (unique.length === 0 || unique.length > maxCommitFiles) continue
    usedCommits += 1
    for (const file of unique) support.set(file, (support.get(file) ?? 0) + 1)
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        // Sorted key so (a,b) and (b,a) are one entry; the direction lives in the confidence
        // calculation, which divides by the support of the file being asked about.
        const key = unique[i] < unique[j] ? `${unique[i]}\0${unique[j]}` : `${unique[j]}\0${unique[i]}`
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
  }

  return { support, pairs, usedCommits }
}

// How often `other` appeared in a commit that touched `file`, as a fraction of the commits that
// touched `file`. Asymmetric on purpose: a test that always accompanies its source is highly
// confident from the source's side and may be far less so from the other direction.
export function confidence(coupling, file, other) {
  const base = coupling.support.get(file) ?? 0
  if (base === 0) return 0
  const key = file < other ? `${file}\0${other}` : `${other}\0${file}`
  return (coupling.pairs.get(key) ?? 0) / base
}

// The blast radius of a declared file set: the files most likely to move when these do, with the
// set's own members removed — a teammate is already told about those, and it may edit them.
export function neighboursOf(coupling, files = [], { top = 5, minSupport = DEFAULT_MIN_SUPPORT } = {}) {
  const own = new Set(files)
  const scored = new Map()
  for (const file of own) {
    if ((coupling.support.get(file) ?? 0) < minSupport) continue
    for (const key of coupling.pairs.keys()) {
      const [a, b] = key.split('\0')
      if (a !== file && b !== file) continue
      const other = a === file ? b : a
      if (own.has(other)) continue
      const score = confidence(coupling, file, other)
      // A file coupled to two members of the set keeps its strongest association rather than a
      // sum: the number is a probability about one relationship, and adding two of them produces
      // a figure above 1 that means nothing.
      if (score > (scored.get(other) ?? 0)) scored.set(other, score)
    }
  }
  return [...scored.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, top)
    .map(([path, score]) => ({ path, confidence: score }))
}

// Directory rollup, deepest-first by file count. Deliberately counts every tracked path rather
// than guessing at source extensions: what counts as source is a per-project question, and a
// wrong guess hides exactly the directory an operator is looking for.
export function inventory(paths = [], { top = 20 } = {}) {
  const dirs = new Map()
  for (const p of paths) {
    const norm = String(p).replace(/\\/g, '/')
    const slash = norm.lastIndexOf('/')
    const dir = slash === -1 ? '.' : norm.slice(0, slash)
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
  }
  const rows = [...dirs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([dir, files]) => ({ dir, files }))
  return { totalFiles: paths.length, directories: dirs.size, rows }
}

export function renderMap({ inventory: inv, hotPairs = [], usedCommits = 0 }) {
  const lines = [`${inv.totalFiles} tracked files across ${inv.directories} directories, coupling from ${usedCommits} commits`]
  lines.push('largest directories:')
  for (const row of inv.rows) lines.push(`  ${String(row.files).padStart(5)}  ${row.dir}`)
  if (hotPairs.length) {
    lines.push('most coupled pairs:')
    for (const p of hotPairs) lines.push(`  ${Math.round(p.confidence * 100)}%  ${p.file} -> ${p.other}`)
  }
  return lines.join('\n')
}

// The strongest associations in the repository, for an operator reading the map directly rather
// than for a brief. Same floors as neighboursOf, so the two never disagree about what counts.
export function hotPairs(coupling, { top = 15, minSupport = DEFAULT_MIN_SUPPORT } = {}) {
  const out = []
  for (const key of coupling.pairs.keys()) {
    const [a, b] = key.split('\0')
    // Evaluate both directions and keep the strongest one whose reported file clears the
    // floor, same as neighboursOf: it only trusts a file's own coupling once that file itself
    // has enough history. Picking the stronger direction FIRST and only then checking its floor
    // discarded the whole pair whenever that direction's file was under-supported, even when
    // the other direction was both well-supported and reportable — the two functions would
    // disagree about whether the pair counted at all.
    const candidates = [
      { file: a, other: b, confidence: confidence(coupling, a, b) },
      { file: b, other: a, confidence: confidence(coupling, b, a) },
    ].filter((c) => (coupling.support.get(c.file) ?? 0) >= minSupport)
    if (candidates.length === 0) continue
    candidates.sort((x, y) => y.confidence - x.confidence)
    out.push(candidates[0])
  }
  return out.sort((x, y) => y.confidence - x.confidence || x.file.localeCompare(y.file)).slice(0, top)
}
