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

export function inferGateConfig(pkg) {
  const scripts = pkg?.scripts ?? {}
  const checks = INFERRED_ORDER
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => ({ name, kind: 'command', run: `npm run ${name}` }))

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
  const result = checks.map((check) => {
    if (check?.kind === 'agent' && !Array.isArray(check.lens)) return { ...check, lens: fallback }
    if (ENFORCEMENT_CHECK_KINDS.includes(check?.kind)) return { ...check, protected: guarded }
    return check
  })
  const names = new Set(checks.map((check) => check?.name))
  for (const kind of ENFORCEMENT_CHECK_KINDS) {
    if (checks.some((check) => check?.kind === kind)) continue
    // Results are keyed by name, so an injected check must not collide with a declared one that
    // happens to carry this name under another kind.
    const name = names.has(kind) ? `${kind}:injected` : kind
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
