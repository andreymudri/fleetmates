import { LEGACY, NAMES } from './names.mjs'
import { normalizePath } from './enforce.mjs'
import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'

const MANIFEST = NAMES.gateFile
const INFERRED_ORDER = ['typecheck', 'lint', 'test', 'build']
const DEFAULT_FIX_ROUNDS = 2
const DEFAULT_LENS = ['correctness', 'security', 'tests']

export function defaultMaxParallel() {
  return Math.max(1, Math.min(8, availableParallelism() - 2))
}

export async function loadGateConfig(root) {
  try {
    return JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// The suggested `test` check carries the runner's own refusal of a focused test and, where the
// runner writes JUnit without a dependency, the test inventory's report contract. `node --test`
// ignores `.only` unless `--test-only` is given, so it needs no flag; Jest has no refusal at all,
// and a focused Jest suite shows up as drops in the inventory instead.
function inferTestCheck(script, platform) {
  // Only a script that names no reporter of its own: added reporters would leave node with more
  // reporters than destinations, and it refuses to start (review, reproduced on this repository).
  // The flags go right after `node --test` in the script itself — node stops reading its own
  // options at the first positional argument, so `npm run test -- …` never reaches the runner, and
  // NODE_OPTIONS is inherited by every nested `node --test` a suite spawns, which then writes into
  // the same report (both measured).
  // `--test` as a whole flag: `--test-concurrency` and `--test-only` must not match (review: the
  // rewrite glued the rest of such a flag onto the report path). The script no longer runs through
  // `npm run`, so `node_modules/.bin` is put on PATH the way npm would.
  // The rewrite is sh (`PATH=…`, `$FLEETMATES_REPORT_DIR`), and win32 runs checks through cmd.exe,
  // which expands neither — the suite would write its report to a literal `$FLEETMATES_REPORT_DIR`
  // directory and the inventory would fail every gate (measured on the release CI). There the
  // plain check is suggested and the report left for the user to add in cmd syntax.
  const nodeTest = /\bnode\s+--test(?=\s|$)/
  if (platform !== 'win32' && nodeTest.test(script) && !/--test-reporter/.test(script) && !/[;&|`$\\]/.test(script)) {
    return {
      name: 'test',
      kind: 'command',
      run: `PATH="$PWD/node_modules/.bin:$PATH" ${script.replace(nodeTest, 'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="$FLEETMATES_REPORT_DIR/node.xml"')}`,
      report: { format: 'junit', dir: true },
    }
  }
  if (/\bvitest\b/.test(script)) return { name: 'test', kind: 'command', run: 'npm run test -- --allowOnly=false' }
  if (/\bmocha\b/.test(script)) return { name: 'test', kind: 'command', run: 'npm run test -- --forbid-only' }
  return { name: 'test', kind: 'command', run: 'npm run test' }
}

export function inferGateConfig(pkg, { platform = process.platform } = {}) {
  const scripts = pkg?.scripts ?? {}
  const checks = INFERRED_ORDER
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => (name === 'test' ? inferTestCheck(scripts.test, platform) : { name, kind: 'command', run: `npm run ${name}` }))

  checks.push({ name: 'fileset', kind: 'fileset' })
  checks.push({ name: 'ownership', kind: 'ownership' })

  checks.push({
    name: 'review',
    kind: 'agent',
    agent: 'tm-reviewer',
    blockOn: ['high'],
  })

  const config = {
    maxParallel: defaultMaxParallel(),
    lens: DEFAULT_LENS,
    phases: { default: { fixRounds: DEFAULT_FIX_ROUNDS, checks } },
  }
  // Inference happens only while a manifest is being created — `gate` exits 3 and prints this
  // for confirmation. At gate time nothing is inferred: the gate links exactly what the saved
  // manifest says, so the default is visible in a file the user approved.
  if (pkg) config.preview = { link: ['node_modules'] }
  return config
}

// Top-level rather than per-phase: what a project needs in order to run its checks does not
// vary by phase. Absent or empty means link nothing, which is the behaviour before this field
// existed, so no existing manifest changes meaning.
export function previewLinks(config) {
  const link = config?.preview?.link
  return Array.isArray(link) ? link : []
}

// The two checks no manifest can remove. Everything they decide is computed from git; the only
// thing the manifest contributes is the protected set, and only through its top-level key.
export const ENFORCEMENT_CHECK_KINDS = ['fileset', 'ownership']

// The gate manifest is always protected, under both names: the current one is what the gate
// reads, and the legacy one is what a later migration would adopt. `protected` only adds.
export function protectedPaths(config) {
  const extra = Array.isArray(config?.protected) ? config.protected : []
  return [...new Set([NAMES.gateFile, LEGACY.gateFile, ...extra].map(normalizePath))]
}

// `fileset` and `ownership` are injected when the phase's list lacks them. The manifest the gate
// reads is the run tip's, AFTER the last integration: a merge that removed `ownership` from it
// would otherwise switch off, at the next gate, the one check that reports that merge. Every
// consumer (`gate`, `complete`, `finish`, `prune-run`) reads its checks through here, so this is
// the single injection point. The operator's `--no-fleet` flag stays the only way not to run them.
//
// A declared entry of either kind gets `protected` overwritten, not merged: the manifest widens the
// set through its top-level key only, so no per-check field can narrow what these checks enforce.
export function checksForPhase(config, phaseName) {
  const phases = config?.phases ?? {}
  const checks = phases[phaseName]?.checks ?? phases.default?.checks ?? []
  const fallback = Array.isArray(config?.lens) && config.lens.length ? config.lens : DEFAULT_LENS
  const guarded = protectedPaths(config)
  const expectedSkips = Array.isArray(config?.skips) ? config.skips.map((s) => s?.file).filter((f) => typeof f === 'string') : []
  // `injected` is this function's mark, never the manifest's: a declared entry carrying it would
  // have its name printed as if this code had chosen it, and the name is manifest text.
  const result = checks.map((check) => {
    let out = check
    if (out && typeof out === 'object' && Object.hasOwn(out, 'injected')) {
      out = { ...out }
      delete out.injected
    }
    if (out?.kind === 'agent' && !Array.isArray(out.lens)) return { ...out, lens: fallback }
    if (ENFORCEMENT_CHECK_KINDS.includes(out?.kind)) return { ...out, protected: guarded }
    // The inventory's expected skips come from the top-level `skips` only, overwriting anything the
    // check entry carries — the same rule as `protected` above.
    if (out?.kind === 'command' && out.report !== undefined) return { ...out, skips: expectedSkips }
    return out
  })
  const names = new Set(checks.map((check) => check?.name))
  for (const kind of ENFORCEMENT_CHECK_KINDS) {
    if (checks.some((check) => check?.kind === kind)) continue
    // Results are keyed by name, so an injected check must not collide with a declared one that
    // happens to carry this name under another kind.
    let name = kind
    for (let n = 1; names.has(name); n += 1) name = n === 1 ? `${kind}:injected` : `${kind}:injected-${n}`
    names.add(name)
    result.push({ name, kind, injected: true, protected: guarded })
  }
  return result
}

// A fix-round budget is only meaningful as a non-negative whole number: the loop
// compares `roundsSoFar >= budget`, and any other value makes that comparison
// NaN -> false forever, leaving the retry loop unbounded. Discard anything else
// so the next fallback in the chain supplies a usable bound.
function validFixRounds(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

export function fixRoundsForPhase(config, phaseName) {
  const phases = config?.phases ?? {}
  return validFixRounds(phases[phaseName]?.fixRounds)
    ?? validFixRounds(phases.default?.fixRounds)
    ?? DEFAULT_FIX_ROUNDS
}
