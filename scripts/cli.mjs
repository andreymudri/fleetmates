import { migrate } from './migrate.mjs'
import { NAMES } from './names.mjs'
import { readFile, writeFile, mkdir, rename, lstat, readdir, unlink, open as openFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { livenessRows, renderLiveness, hasStall, hasUnknown, DEFAULT_STALE_MINUTES } from './liveness.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlan } from './plan-parser.mjs'
import { bulletSection, parsePlanSections, PlanSectionError } from './plan-sections.mjs'
import { renderUsage } from './usage.mjs'
import { readSessionUsage } from './usage-store.mjs'
import { homedir } from 'node:os'
import { assignPhases } from './phases.mjs'
import { readState, writeState, claimTask, releaseClaim, readFixRounds, recordFixRound, runDir, writeLocation, worktreeKey, isLocalAbsolute } from './state.mjs'
import { composeBrief } from './brief.mjs'
import { inferGateConfig, checksForPhase, fixRoundsForPhase, previewLinks } from './gate-config.mjs'
import {
  loadConfig, readLayer, writeLayer, validateKey, validateLocal, isEnforcementKey, assertSafeKey,
  getKey, setKey, unsetKey, ensureGitignored, ConfigError,
  GATE_FILE, LOCAL_FILE, ROLES,
} from './config.mjs'
import * as configModule from './config.mjs'
import { TIERS, inferTier } from './routing.mjs'
import { decideFix } from './fix-loop.mjs'
import { runChecks, aggregateVerdict } from './gate-runner.mjs'
import { renderDigest } from './digest.mjs'
import { collectDoctorReport, renderDoctor } from './doctor.mjs'
import { collectReviewResults, isUnsafePathComponent, printable, printableBlock, reviewFileName, reviewStamp } from './reviews.mjs'
import { generateReviewDispatch } from './review-gen.mjs'
import { resolveTaskBranch, taskBranchName } from './enforce.mjs'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { validateLinkPaths } from './preview-links.mjs'
import { planDrift, renderDrift } from './plan-drift.mjs'
import { summarizeRun, renderRunSummary, renderPlanNotes, suppliedForPhase, validateSuppliedPhases } from './finish.mjs'
import { selectPrunableWorktrees, renderPrunePlan, leakedPreviews } from './prune.mjs'
import { previewOwnerMarkerPath, previewClaimPrefix } from './merge-preview.mjs'
import { rebuildRunState } from './rebuild.mjs'
import { generatePhaseWorkflow } from './workflow-gen.mjs'
import { createGit, GitError, defaultGitExec, gitDirWritable } from './git.mjs'
import { getAdapter, HARNESS_NAMES } from './harnesses/index.mjs'
import { dispatchPhase, waitForExit, runPool, killProcess, pidAlive } from './driver.mjs'
import { buildCoupling, neighboursOf, inventory, hotPairs, renderMap } from './codemap.mjs'
import { mapNotesStale, mapNotesPrompt, mapNotesWritable } from './mapnotes.mjs'
import { deriveContext } from './gate-runner.mjs'

// The temp root as GIT would spell it, which is not what `os.tmpdir()` returns.
//
// `git worktree list` reports a worktree's resolved real path. `os.tmpdir()` reports whatever
// TMPDIR/TEMP/TMP holds, and on both non-Linux CI runners those are a DIFFERENT spelling of the
// same directory: macOS `/var` is a symlink to `/private/var`, and a Windows `TEMP` can be an 8.3
// short name (`C:\Users\RUNNER~1\...`) for a path git names in long form. `under()` in prune.mjs
// is a whole-segment string comparison over paths it cannot stat — deliberately, since that
// module is pure — so a disagreeing spelling identified NO preview at all, and every preview test
// went red on macOS and windows-latest while ubuntu passed.
//
// Resolving belongs here, in the caller, because here there is a filesystem to ask.
//
// `.native` and not the JS `realpathSync`: measured on Windows 10, the JS implementation returns
// an 8.3 component unchanged (`...\Temp\LONGDI~1`) while `.native` expands it to the long name
// git reports. `.native` is realpath(3) off Windows, so it resolves the macOS symlink too. The JS
// one would have fixed macOS only, while reading as though it had fixed both.
//
// A failed resolution falls back to the unresolved value rather than throwing. The cost of not
// resolving is that a preview goes UNIDENTIFIED, which leaves it on disk and reports it among the
// refusals — the same non-destructive outcome as before this fix, and never a wider delete.
// Aborting the whole prune because a temp directory could not be statted would be the worse trade.
function resolvedTempRoot() {
  const raw = tmpdir()
  try {
    return realpathSync.native(raw)
  } catch {
    return raw
  }
}

// scripts/cli.mjs -> scripts/ -> <fleetmates root>. The agent personas live at
// <fleetmates root>/agents/tm-<role>.md, next to this scripts directory.
const FLEET_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// The persona a headless teammate is prompted with: the body of `agents/tm-<role>.md` with its
// YAML frontmatter stripped, so the harness prompt is the same system-prompt text a Claude Code
// `agentType: fleetmates:tm-<role>` dispatch would carry. Roles map by name — implementer,
// reviewer, integrator — the same three `scripts/config.mjs` declares in ROLES.
async function personaFor(role) {
  const body = await readFile(path.join(FLEET_ROOT, 'agents', `tm-${role}.md`), 'utf8')
  const frontmatter = body.match(/^---\n[\s\S]*?\n---\n?/)
  return frontmatter ? body.slice(frontmatter[0].length).replace(/^\s+/, '') : body
}

// The message Step 2 prints for every GIT_WRITING_COMMANDS command whose common git dir this
// shell cannot write. Copied to the letter from the plan so both the code and the test that pins
// it read the same three lines.
function sandboxRefusal(dir) {
  return `cannot write to ${dir}: this shell is sandboxed.\n`
    + '  Start the harness with full access (codex: --sandbox danger-full-access),\n'
    + '  or re-run this one command with sandbox escalation.'
}

// The harness resolved from `--harness` (default `codex`), or null after printing the
// unknown-harness message that names every known harness. A bare `--harness` (parsed as the
// boolean `true` when the flag carries no value) reads as the default rather than as a name.
//
// The name is checked against the exported allowlist BEFORE `getAdapter`, not through the truthiness
// of a bare `ADAPTERS[name]` lookup: `--harness __proto__` and `--harness constructor` resolve to
// truthy INHERITED properties on the registry object, which slip past a `!adapter` test and then
// throw `adapter.probe is not a function` out of `runCli`. `HARNESS_NAMES` is a plain array of own
// keys, so `.includes` admits only a real harness and a prototype key is refused exactly like
// `bogus`.
function resolveHarness(flags, io) {
  const name = (flags.harness === undefined || flags.harness === true) ? 'codex' : flags.harness
  if (!HARNESS_NAMES.includes(name)) {
    io.out(`unknown harness: ${printable(String(name))} (known: ${HARNESS_NAMES.join(', ')})`)
    return null
  }
  return getAdapter(name)
}

// The harness sandbox/network/timeout/tierModels for one run, resolved from `harnesses.<name>.*`
// with the same defaults the codex adapter assumes when a field is unset: an isolated `clone`,
// network off, a 30-minute timeout, and no tier→model map.
function harnessSettings(resolved, harnessName) {
  const entry = (resolved.harnesses && resolved.harnesses[harnessName]) || {}
  return {
    sandboxMode: entry.sandbox ?? 'clone',
    network: entry.network ?? false,
    timeoutMinutes: entry.timeoutMinutes ?? 30,
    tierModels: entry.tierModels ?? {},
  }
}

// Sums the codex `readUsage` totals a driver stores per task into one token count, or null when
// no usage was recorded. The shape is `{ input, cachedInput, cacheWrite, output, reasoning }`.
function totalTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  return (usage.input ?? 0) + (usage.cachedInput ?? 0) + (usage.cacheWrite ?? 0)
    + (usage.output ?? 0) + (usage.reasoning ?? 0)
}

const USAGE = `usage: cli.mjs <init-run|gate|doctor|liveness|digest|claim|unclaim|locate|brief|workflow|dispatch|dispatch-reviews|dispatch-integrator|message|sessions|complete|fix|record-fix-round|review-dispatch|collect-reviews|preview-check|plan-drift|finish|prune-run|rebuild-state|map|map-notes|usage|config> [options]

  init-run <planPath> --run <id> [--root <path>]
  doctor   --run <id> --plan <path> [--base <branch>] [--run-branch <name>] [--root <path>]
  liveness --run <id> --plan <path> [--stale <minutes>] [--root <path>]
  finish   --run <id> --plan <path> [--base <branch>] [--root <path>] [--results <path>] [--enforcement-only]
  prune-run --run <id> --plan <path> [--base <branch>] [--yes] [--root <path>] [--results <path>] [--enforcement-only]
  rebuild-state --run <id> --plan <path> [--base <branch>] [--force] [--root <path>]
  map      [--files <a,b>] [--commits <n>] [--top <n>] [--root <path>]
  map-notes --run <id> [--root <path>] [--write <path>]
  usage    [--session <id>] [--json] [--root <path>]
  plan-drift --run <id> --plan <path> [--base <branch>] [--root <path>]
  preview-check [--root <path>]
  review-dispatch --run <id> [--phase <name>] [--models <json>] [--root <path>]
  collect-reviews --run <id> [--phase <name>] [--root <path>]
  gate     --run <id> --plan <path> [--base <branch>] [--root <path>] [--phase <name>] [--no-fleet] [--results <path>]
  digest   --run <id> [--root <path>]
  claim    --run <id> --task <id> --by <teammate> [--root <path>]
  unclaim  --run <id> --task <id> [--root <path>]
  locate   --run <id> --task <id> [--worktree <path>] [--branch <name>] [--root <path>]
  brief    --run <id> --task <id> --plan <path> [--base <branch>] [--fix-round] [--root <path>]
  workflow --run <id> --phase <n> [--root <path>] [--models <json>] [--plan <path>] [--base <branch>]
  dispatch --run <id> --phase <n> [--harness <name>] [--plan <path>] [--base <branch>] [--models <json>] [--root <path>]
  dispatch-reviews --run <id> [--phase <name>] [--harness <name>] [--models <json>] [--root <path>]
  dispatch-integrator --run <id> [--phase <name>] [--harness <name>] [--root <path>]
  message  --run <id> --task <id> --text <s> [--harness <name>] [--root <path>]
  sessions --run <id> [--root <path>]
  complete --run <id> --task <id> --plan <path> [--base <branch>] [--root <path>] [--enforcement-only]
  fix      --run <id> --phase <n> --verdict <path> [--root <path>]
  record-fix-round --run <id> --phase <n> --task <id> [--root <path>]
  config   list [--root <path>]
  config   get <key> [--root <path>]
  config   set <key> <value> [--root <path>] [--local]
  config   unset <key> [--root <path>] [--local]`

// A flag followed by nothing, or by another flag, is a boolean switch (e.g. --no-fleet)
// and takes no value. Without this, a boolean flag anywhere but the very last argv
// position swallows the next flag's name as its own value, and at the very last position
// reads as `undefined` — either way `flags['no-fleet'] !== undefined` never sees it.
// Flags that are a switch and nothing else: present or absent, never carrying a value. Their
// presence is the whole signal, so any value written after one is a spelling this CLI cannot
// act on — see the refusal in parseFlags. Kept as a named set so the advice printed for a
// rejected spelling can name a form that actually works, per flag.
const VALUELESS_FLAGS = new Set(['no-fleet', 'local', 'yes', 'force', 'enforcement-only', 'fix-round'])

// What to tell a caller who wrote a spelling this CLI does not take. It must never name a form
// that fails — and for `--no-fleet` it must never name one that does the OPPOSITE of what the
// caller was reaching for: someone typing `--no-fleet=false` wants the enforcement checks
// running, and "write `--no-fleet`" would hand them the spelling that switches those checks off.
function spellingAdvice(name) {
  if (name === 'no-fleet') {
    return '`--no-fleet` takes no value: omit it entirely to keep the fileset and ownership'
      + ' checks running, or pass it alone to run without them'
  }
  if (VALUELESS_FLAGS.has(name)) return `\`--${name}\` takes no value: write \`--${name}\` alone`
  return `write \`--${name} <value>\``
}

function parseFlags(argv) {
  const flags = {}
  const positional = []
  // Rejected spellings, reported by the caller before any command runs — never dropped, or the
  // flag would go missing exactly as it did before.
  const rejected = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const token = argv[i].slice(2)
      // `--name=value` is a spelling this CLI does not accept, and it is refused rather than
      // guessed at — in EITHER direction, which is the whole point.
      //
      // Read as a flag name (what happened before any of this), `--local=true` produced a flag
      // literally called `local=true`, leaving `flags.local` undefined, so the write silently
      // landed in the TRACKED enforcement manifest instead of the gitignored layer the caller
      // named. Interpreted as a value (what replaced it) is worse: every switch in this CLI is
      // tested with `!== undefined`, so `--no-fleet=false` READS as negation and DISABLES the
      // fileset and ownership checks — `=false`, `=0`, `=off` alike — while also dropping
      // `--run` and `--plan` from REQUIRED. An argv that says "enforcement is not disabled"
      // would open the entire solo path, which is the one guarantee SECURITY.md makes about a
      // fleet run.
      //
      if (token.includes('=')) {
        rejected.push({ raw: argv[i], name: token.slice(0, token.indexOf('=')) })
        continue
      }
      const name = token
      const next = argv[i + 1]
      // A flag in VALUELESS_FLAGS never consumes the token after it, and never carries a value
      // of its own. `--no-fleet false` reads to a human as "solo mode off" and meant the exact
      // opposite: any value at all left `flags['no-fleet']` defined, which is what both
      // consumers tested, so the fileset and ownership checks were skipped by an argv written
      // to keep them. Refused rather than interpreted, for the same reason `=` is.
      if (VALUELESS_FLAGS.has(name)) {
        if (next !== undefined && !next.startsWith('--')) {
          rejected.push({ raw: `${argv[i]} ${next}`, name })
          i += 1
          continue
        }
        flags[name] = true
        continue
      }
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        i += 1
      }
    } else {
      positional.push(argv[i])
    }
  }
  return { flags, positional, rejected }
}

// `null`, not `{}`, when there is no package.json: `inferGateConfig` distinguishes "a Node
// project with no scripts" from "not a Node project" by the truthiness of this value, and only
// the first should get `preview.link: ["node_modules"]`. Returning an empty object made every
// repo look like a Node one, so a Python or Rust project's inferred manifest named a directory
// it does not have — which then fails the `merge` check on a missing link target.
async function readPackage(root) {
  try {
    return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Exported so the suite can DERIVE the command list rather than restate it. A hardcoded list
// catches a command REMOVED from these tables and not one ADDED without an entry — and adding is
// the direction that happens, which is how a 21st subcommand could swallow an unknown flag and
// exit 0 with the suite green.
export const REQUIRED = {
  'init-run': ['run'],
  gate: ['run', 'plan'],
  doctor: ['run', 'plan'],
  liveness: ['run', 'plan'],
  // `--phase` is the manifest phase key, not a plan phase number, so it stays out of
  // NUMERIC_PHASE_COMMANDS and defaults to `default` exactly as `gate`'s does. Not required here
  // even so, because whether that default is ambiguous depends on the RUN rather than on the argv
  // this table is checked against: `ambiguousPhaseRefusal` refuses the omission on a plan with
  // more than one phase, and lets it stand on a plan with one.
  'collect-reviews': ['run'],
  'review-dispatch': ['run'],
  // No required flags: it reads the manifest and the working tree, and belongs to no run.
  'preview-check': [],
  'plan-drift': ['run', 'plan'],
  finish: ['run', 'plan'],
  'prune-run': ['run', 'plan'],
  'rebuild-state': ['run', 'plan'],
  // Belongs to no run: it reads git history and the working tree, and answers a question about
  // the repository rather than about a fleet.
  map: [],
  // Belongs to no run either: the transcript store is keyed by session, not by run id.
  usage: [],
  'map-notes': ['run'],
  digest: ['run'],
  claim: ['run', 'task', 'by'],
  unclaim: ['run', 'task'],
  // Both paths are derived from where the command runs, so neither is required: the brief
  // carries one bare invocation rather than a shell dance a teammate can get wrong.
  locate: ['run', 'task'],
  brief: ['run', 'task', 'plan'],
  workflow: ['run', 'phase'],
  // `dispatch` replaces the Workflow path for one numeric plan phase, so its `--phase` is a
  // plan phase number like `workflow`'s (it is in NUMERIC_PHASE_COMMANDS below).
  dispatch: ['run', 'phase'],
  // `dispatch-reviews`/`dispatch-integrator` operate on a MANIFEST phase key like
  // `review-dispatch`/`collect-reviews`, which defaults to `default`; `--phase` is not required.
  'dispatch-reviews': ['run'],
  'dispatch-integrator': ['run'],
  message: ['run', 'task', 'text'],
  sessions: ['run'],
  complete: ['run', 'task', 'plan'],
  fix: ['run', 'phase', 'verdict'],
  'record-fix-round': ['run', 'phase', 'task'],
  // Recorded explicitly as taking no required flags rather than relying on the `?? []`
  // fallthrough: a command absent from this map also skips the whole missing-argument
  // branch, so the omission would read as "not a command" to anyone auditing the table.
  config: [],
}

// Every flag each command actually reads. An unknown flag is refused rather than ignored: a
// swallowed `workflow --commits 5000` exits 0 while the operator believes the coupling window
// widened, which is the silent-wrong-answer class this CLI removes everywhere else. `parseFlags`
// accepts any `--name`, so without this table a mistyped, renamed or hallucinated flag is
// indistinguishable from one the command acts on.
//
// This is a WHITELIST, and a command absent from it is unchecked — so a new command must be
// added here as well as to REQUIRED, or its flags go unvalidated. Every command this CLI
// dispatches is listed, including the ones taking nothing at all.
export const UNIVERSAL_FLAGS = new Set(['root'])
export const KNOWN_FLAGS = {
  'init-run': ['run'],
  gate: ['run', 'plan', 'base', 'phase', 'no-fleet', 'results'],
  doctor: ['run', 'plan', 'base', 'run-branch'],
  liveness: ['run', 'plan', 'stale'],
  digest: ['run'],
  claim: ['run', 'task', 'by'],
  unclaim: ['run', 'task'],
  locate: ['run', 'task', 'worktree', 'branch'],
  brief: ['run', 'task', 'plan', 'base', 'fix-round'],
  complete: ['run', 'task', 'plan', 'base', 'phase', 'enforcement-only'],
  workflow: ['run', 'phase', 'models', 'plan', 'base'],
  dispatch: ['run', 'phase', 'harness', 'plan', 'base', 'models'],
  'dispatch-reviews': ['run', 'phase', 'harness', 'plan', 'base', 'models'],
  'dispatch-integrator': ['run', 'phase', 'harness', 'plan', 'base', 'models'],
  message: ['run', 'task', 'harness', 'text'],
  sessions: ['run'],
  fix: ['run', 'phase', 'verdict'],
  'record-fix-round': ['run', 'phase', 'task'],
  'review-dispatch': ['run', 'phase', 'models'],
  'collect-reviews': ['run', 'phase'],
  'preview-check': [],
  'plan-drift': ['run', 'plan', 'base'],
  finish: ['run', 'plan', 'base', 'results', 'enforcement-only'],
  'prune-run': ['run', 'plan', 'base', 'yes', 'results', 'enforcement-only'],
  'rebuild-state': ['run', 'plan', 'base', 'force'],
  map: ['files', 'commits', 'top'],
  // `--run` reads a headless run's session store (`.fleetmates/<run>/sessions/*.json`); without
  // it `usage` still reads the Claude Code transcript store keyed by session.
  usage: ['session', 'json', 'run'],
  'map-notes': ['run', 'write'],
  config: ['local'],
}

function unknownFlags(command, flags) {
  const known = KNOWN_FLAGS[command]
  if (!known) return []
  const allowed = new Set([...known, ...UNIVERSAL_FLAGS])
  return Object.keys(flags).filter((f) => !allowed.has(f))
}

// Commands whose `--phase` names a numeric plan phase, not a manifest phase key. `gate` is
// deliberately absent: its `--phase` is a NAME (`default`, `integration`) that selects a
// block of checks from fleetmates.gate.json.
// Not a missing argument in the sense the generic line means, so it does not get that line's
// lead. A `--no-fleet` gate names its phase from the manifest and emits a verdict carrying
// `phaseName` with no integer `phase` — reported as a typo, that told an operator following the
// phase-gate skill end to end nothing about why the two commands do not compose.
const NAMED_PHASE_REFUSAL = '__named_phase__'

const NUMERIC_PHASE_COMMANDS = new Set(['workflow', 'fix', 'record-fix-round', 'dispatch'])

// Every command that writes to the repository's git dir. Each fails fast through the
// `gitDirWritable` preflight below when this shell cannot write the common dir, so a sandboxed
// orchestrator gets one fixable message instead of a failure deep inside a worktree add, a clone,
// or a fetch. `dispatch`/`dispatch-reviews`/`dispatch-integrator` clone, fetch and merge; the
// existing four (`finish`, `prune-run`, `init-run`, `gate`) already touched git before this set
// named them.
const GIT_WRITING_COMMANDS = new Set([
  'dispatch', 'dispatch-reviews', 'dispatch-integrator', 'finish', 'prune-run', 'init-run', 'gate',
])

// Every command that accepts caller-supplied check results. `gate` takes a flat list for the one
// phase it computes; `finish` and `prune-run` recompute every phase, so theirs is keyed by phase.
const RESULTS_COMMANDS = new Set(['gate', 'finish', 'prune-run'])

// `finish` and `prune-run` recompute every phase, and a `command` check is the expensive part of
// every one of them: on a run with three phases and a test suite per phase, `finish` costs three
// full suites to answer "is this run finished", and `prune-run` has timed out at 120s deciding
// whether a directory could be deleted. `--enforcement-only` asks the narrower question those
// two callers usually mean — does the enforcement still hold — and pays only for the checks that
// answer it.
//
// Only `command` checks are dropped. Everything else runs exactly as it otherwise would: the
// always-enforced kinds (`fileset`, `ownership`, and the `merge` result `runChecks` computes for
// itself) are the point of the flag, and a manifest kind with no runner must still land as the
// blocking `pending` it always was rather than disappear from the list.
//
// Every dropped check is recorded as `skip` — never omitted, and never `pass`. `aggregateVerdict`
// collects skips and both callers below print them by name, because a verdict that hides which
// checks did not run is worse than a slow one. It follows that this flag can report PASS where a
// full run would have reported FAIL: that is what it buys, and the printed skip list is the only
// thing that says so.
//
// Two guards keep that trade from becoming a lie, because a `skip` result is still a result and
// `aggregateVerdict` counts it toward the fail-closed "at least one check ran" clause that stops
// a self-generated result reading as a verified phase:
//
//   - `enforcementOnlyRefusal` below refuses the whole invocation for a phase that declares no
//     enforcement check at all. Without it, a manifest of nothing but a failing `command` check
//     produced "phase 1 PASS   skipped: test" and then "the run branch is ready to land", exit 0,
//     where the identical state without the flag exits 1 — a run declared landable having
//     verified nothing.
//   - `prune-run` below refuses to PRUNE any phase whose verdict rests on a check THIS FLAG
//     skipped. A cheap verdict is enough to report; it is never enough to run
//     `git worktree remove --force` over a teammate's uncommitted work.
const ENFORCEMENT_ONLY_SKIP = 'skipped by --enforcement-only: this verdict reports the enforcement checks, not whether the merged tree works'

// Marks a `skip` this flag synthesised, as opposed to one that arrived any other way. Three
// sources produce a `skip`, and they are not the same act:
//
//   - this flag, which drops a check the caller did not ask about and nobody ran;
//   - `--results`, where `skip` is one of the three statuses a caller may supply — a deliberate
//     assertion that the check did not run and that they accept it, which is evidence given, not
//     evidence missing;
//   - `runChecks` itself, which skips `command` checks when the phase does not merge; there the
//     `merge` check fails, so the phase never reaches a PASS to be pruned on anyway.
//
// Only the first is this flag's business. Refusing to prune on any of the three made a supplied
// `skip` unprunable with no remedy the caller could follow — they never passed the flag they were
// told to drop, and the only way forward would have been rewriting their `skip` as a `pass`.
const ENFORCEMENT_ONLY_SKIPPED = Symbol('skipped by --enforcement-only')

// The enforcement kinds a manifest can actually declare. `merge` is deliberately absent even
// though it is enforced: the gate computes it for itself, `aggregateVerdict` excludes it from the
// same "something was verified" clause for exactly that reason, and a manifest entry claiming it
// finds no runner and lands as a blocking pending. So a phase whose only enforced kind were
// `merge` has declared no enforcement, and counting it here would reopen the hole this closes.
const MANIFEST_ENFORCED_KINDS = new Set(['fileset', 'ownership'])

// A MANIFEST ENTRY IS NOT KNOWN TO BE AN OBJECT. `fleetmates.gate.json` is `JSON.parse`-only and
// `validateGate` in `scripts/config.mjs` checks only that `phases[*].checks` is an ARRAY, never
// what is in it, so a hand-written `[null, …]` — or a bare string, or a number — arrives here
// intact. `runChecks` diagnoses every one of those shapes and fails the phase on them, which is
// the answer the operator needs; but a bare dereference in a site that runs FIRST throws a
// TypeError instead and the command exits with no verdict at all. Measured on three paths, each
// crashing at a different line: `gate` in `validateSuppliedResults`, `gate --no-fleet` in the solo
// filter, `--enforcement-only` in `enforcementOnlyRefusal`. So a kind read off an entry straight
// out of the manifest goes through here, and `validateSuppliedResults` skips a non-object entry
// rather than indexing it. A null-entry test drives each of those paths; add one for any new site.
const kindOf = (check) => check?.kind

// Returns the refusal message when `--enforcement-only` cannot answer for some phase, or null.
// Checked before a single check runs, so the caller learns the flag is the wrong tool for this
// manifest rather than reading a verdict that was never grounded in anything.
function enforcementOnlyRefusal(config, phases) {
  const barren = phases.filter((p) => !checksForPhase(config, String(p)).some((c) => MANIFEST_ENFORCED_KINDS.has(kindOf(c))))
  if (barren.length === 0) return null
  return `--enforcement-only cannot answer for phase ${barren.join(', ')}: `
    + `that phase's manifest declares no ${[...MANIFEST_ENFORCED_KINDS].join(' or ')} check, so dropping its command checks would leave nothing verified at all.`
    + ' Re-run without --enforcement-only, or declare an enforcement check for it.'
}

function commandChecks(checks) {
  return checks.filter((c) => kindOf(c) === 'command')
}

// THE ONLY WAY TO NARROW A MANIFEST CHECK LIST BEFORE `runChecks`. `gate-runner` reports a
// malformed entry by its POSITION — that is all an entry with no `name` can be found by, and the
// message sends the operator to that position in `fleetmates.gate.json` — and it counts the list it
// is handed. A plain `.filter` therefore renumbers the entries and the diagnosis names a different
// one. Returning the positions alongside the narrowed list is what keeps the numbering true — but
// that is a convention, not a guarantee: a caller that destructures only `checks` drops them
// silently and nothing here can detect it. Hand the result straight to `runChecks`.
function narrowChecks(checks, keep) {
  const kept = []
  const checkPositions = []
  let position = -1
  for (const check of checks) {
    position += 1
    if (!keep(check)) continue
    kept.push(check)
    checkPositions.push(position)
  }
  return { checks: kept, checkPositions }
}

async function runPhaseChecks(checks, ctx, enforcementOnly) {
  if (!enforcementOnly) return runChecks(checks, ctx)
  const { checks: enforcement, checkPositions } = narrowChecks(checks, (c) => kindOf(c) !== 'command')
  const results = await runChecks(enforcement, { ...ctx, checkPositions })
  return [
    ...results,
    // `optional` is read off the manifest exactly as gate-runner's own `checkResult` reads it, so
    // every result in the list has the same shape whoever built it. It changes no verdict here:
    // `aggregateVerdict` reads `optional` only for `fail` and `pending`, never for `skip`.
    // Set for consistency, not for consequence.
    ...commandChecks(checks).map((c) => ({
      name: c.name,
      kind: c.kind,
      status: 'skip',
      output: ENFORCEMENT_ONLY_SKIP,
      optional: c.optional === true,
      // A symbol, not a string field: `--results` is parsed from JSON, which cannot express one,
      // so no supplied result can ever claim to be a skip this flag synthesised. `aggregateVerdict`
      // reports skips by name only, so the marker is read off the results list directly.
      [ENFORCEMENT_ONLY_SKIPPED]: true,
    })),
  ]
}

// Printed once, before the first check runs, when the command checks are NOT being skipped. An
// operator about to wait several minutes should be told that is what is happening and that a
// cheaper answer exists, rather than watching a silent process and reaching for the timeout.
//
// Two independent conditions, kept separate because they answer different questions:
//
//   - `checkCount === 0` silences the line entirely. It exists to explain a wait, and with
//     nothing to wait for it explained nothing. This is not the "a skipped check is always
//     reported" rule — no check is being hidden here; there is no check.
//   - `recommendEnforcementOnly` decides only the tail. Whether the wait is worth explaining and
//     whether the cheaper route exists are unrelated: a manifest of nothing but `command` checks
//     has a real wait to explain AND is exactly the barren shape `enforcementOnlyRefusal` exits 2
//     on, so it must be told about the wait and not sent to a flag that would refuse it. Gating
//     the recommendation on the count instead only reached manifests with no command checks,
//     which is the one case where the line is never printed at all.
function announceCommandChecks(io, command, checkCount, phaseCount, recommendEnforcementOnly) {
  if (checkCount === 0) return
  io.out(
    `${command}: running ${checkCount} command check${checkCount === 1 ? '' : 's'}`
    + ` across ${phaseCount} phase${phaseCount === 1 ? '' : 's'} — this is the slow part;`
    + (recommendEnforcementOnly
      ? ' pass --enforcement-only to skip them and report the enforcement checks alone'
      : ' --enforcement-only cannot shorten it, because no phase declares an enforcement check to report instead'),
  )
}

// A phase reports the checks it did not run, every time, whatever put them in that state:
// `--enforcement-only` here, and the merge-conflict skip `runChecks` produces on its own.
//
// The name is the manifest's, and `validateGate` checks the SHAPE of a phase and not the
// content of a check — so a check name is an arbitrary agent-written string, exactly like the
// name `complete` already wraps. It reaches a terminal here on the `prune-run` path, which is
// the command whose `--yes` removes worktrees, so the line saying a check did NOT run is the
// last one that should be erasable.
function reportSkipped(io, phase, verdict) {
  for (const name of verdict.skipped ?? []) io.out(`phase ${phase}: skipped: ${printable(name)}`)
}

// A skill branches on this CLI's exit code. A missing argument must produce the usage
// message and exit 2, never an unhandled TypeError and a stack trace.
//
// `flags[f] === true` means the flag was given with no value (parseFlags's boolean-switch
// reading) — for every flag in REQUIRED that takes a value, that is a missing argument,
// not a truthy one. `complete --plan` (value omitted) must not sneak past this check and
// die inside git with a raw diagnostic instead.
//
// `gate --no-fleet` never derives anything from git, so it never reads `--plan` and never
// records anything under `--run` — requiring either would only teach a caller to invent a
// throwaway value to get past this check. Solo drops both from the requirement.
// A window flag written with no value parses as boolean `true`, and `Number(true)` is 1 — so
// `map --commits` would answer, exit 0, and have read a ONE-COMMIT history. Everywhere else in
// this CLI `flags[f] === true` means "the argument is missing" (see missingArgs, and --models);
// this keeps that rule intact by refusing anything that is not a string before coercing, and
// returning NaN so the caller's single positive-integer guard reports it like any other typo.
function numericWindow(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') return NaN
  return Number(value)
}

// Newest mtime under a directory, pruning what git says the project ignores and visiting at most
// MAX_WALK_ENTRIES entries. `floored: true` means the cap stopped the walk, so the answer is a
// lower bound on freshness rather than a measurement — `livenessRows` reports such a row as
// `unknown` rather than as either working or stalled.
//
// `ignored` is supplied by the caller from `git.ignoredPaths`, not decided here, and it replaced a
// hardcoded `.git`/`node_modules` pair that was the wrong filter twice over: it missed every other
// generated directory (`dist`, `.next`, `target`, `.venv`), and it named `node_modules` in a
// project that might legitimately track it. A repository with any of those floored every walk, and
// a floored row could never be stalled, so the command's only failure signal was inert on exactly
// the repositories it exists to supervise.
//
// `.git` stays hardcoded because git does not report it as ignored — it is not ignored, it is
// simply not part of the working tree — so nothing in the supplied set can cover it.
//
// Both the cap and this function are exported so the suite walks a real tree of MAX_WALK_ENTRIES+1
// entries rather than being told the flag: a walk that always floors reports no stall ever, while
// every unit test on the synthetic flag stays green. That is not hypothetical — it is how the
// branch was found unpinned.
export const MAX_WALK_ENTRIES = 5000
const WALK_SKIP = new Set(['.git'])

// What each unmeasured row means and what to do about it. `livenessRows` names the reason and this
// supplies the prose, so the pure module stays free of wording and the two cannot be conflated in
// the output — they call for different actions, and "not measured" with no cause named is close to
// useless to whoever is holding the heartbeat.
const UNMEASURED_REASONS = [
  ['walk-capped', `the worktree walk hit its ${MAX_WALK_ENTRIES}-entry cap, so the newest file may be one it never`
    + ' reached. Add the generated directory to the project .gitignore — the walk skips what git ignores.'],
  ['no-worktree-measurement', 'no worktree of that branch could be read, so nothing looked at whether files are'
    + ' being edited. Either none is registered — a teammate dispatched without worktree isolation, or working in'
    + ' the main worktree — or its directory is gone. This is not a stall; look at that teammate directly.'],
]

export async function newestMtime(dir, { ignored = new Set() } = {}) {
  let newest = null
  let visited = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      // A worktree deleted without `git worktree prune` is still listed by git, so this is a state
      // git produces routinely rather than a rare race. It is not an error worth failing the
      // report over; it is the absence of evidence, which the caller already represents as a
      // missing touch record.
      continue
    }
    for (const entry of entries) {
      if (visited >= MAX_WALK_ENTRIES) return { at: newest, floored: true }
      visited += 1
      if (WALK_SKIP.has(entry.name)) continue
      const full = path.join(current, entry.name)
      // git reports ignored paths relative to the worktree root, with forward slashes, and a
      // whole ignored directory carries a trailing slash. Both spellings are tested, because a
      // rule can ignore a single file as easily as a directory.
      const rel = path.relative(dir, full).split(path.sep).join('/')
      if (ignored.has(rel) || ignored.has(`${rel}/`)) continue
      if (entry.isDirectory()) { stack.push(full); continue }
      try {
        const st = await stat(full)
        if (newest == null || st.mtimeMs > newest) newest = st.mtimeMs
      } catch { /* a link whose target is gone, or a file removed mid-walk; same reasoning */ }
    }
  }
  return { at: newest, floored: false }
}

function missingArgs(command, flags, positional) {
  // `=== true`, not `!== undefined`: solo mode is entered only by the one spelling that means
  // it. parseFlags already refuses `--no-fleet <value>` outright, and this is the second half
  // of the same rule — the check that decides whether the enforcement checks run should test
  // for the switch being SET, not merely for something having been written after it.
  const solo = command === 'gate' && flags['no-fleet'] === true
  const requiredList = solo ? [] : (REQUIRED[command] ?? [])
  const missing = requiredList
    .filter((f) => !flags[f] || flags[f] === true)
    .map((f) => `--${f}`)
  if (command === 'init-run' && !positional[0]) missing.unshift('<planPath>')
  // Unvalidated, a non-numeric `--phase` reaches `fix`'s task filter, selects nothing, and
  // comes back `escalate`/`unattributable` — "halt and ask the user" for what is only a
  // mistyped flag, with a genuine retry lost. `default` is the likeliest mistype of all: it
  // is the exact token `gate --phase` takes when omitted, and an operator carries it across.
  if (NUMERIC_PHASE_COMMANDS.has(command)
    && flags.phase && flags.phase !== true && !Number.isInteger(Number(flags.phase))) {
    // A `--no-fleet` gate names its phase from the manifest and emits a verdict carrying
    // `phaseName` with no integer `phase`, so this refusal is the whole of what an operator
    // following the phase-gate skill end to end sees. Reported as a boundary rather than as a
    // typo: these commands filter tasks and count fix rounds by numeric phase, and a phase with
    // no task set has nothing to retry — the findings are addressed directly instead.
    missing.push(NAMED_PHASE_REFUSAL)
  }
  // `--results` is optional, so it is not in REQUIRED — but once given it takes a value, and
  // a bare `--results` parses as `true` (parseFlags's boolean-switch reading). Left alone,
  // the gate's own `flags.results !== true` guard skips the whole supplied-results block and
  // the run exits 1 on the still-pending checks with nothing on stdout about the dropped
  // flag. Same treatment every value-taking flag gets from the `=== true` rule above.
  //
  // An EMPTY value is the same missing argument in the other spelling — `--results ""` is what
  // an unset `$RESULTS` templated *quoted* produces, where templated unquoted it produces the
  // bare `--results` above. Only the bare form was caught, so the quoted one fell through to
  // the gate's own `if (flags.results)` truthiness test, which skipped the supplied-results
  // block entirely and exited 1 on the still-pending checks with nothing said about the flag.
  // Both spellings of one mistake now get one answer, exactly as `--root` already does.
  //
  // `finish` and `prune-run` take the same flag, in the same per-phase spelling, so they get the
  // same refusal: three commands reading one flag must not disagree about what a valueless one
  // means, or the two that skip it silently report a run finished on evidence nobody supplied.
  if (RESULTS_COMMANDS.has(command)
    && (flags.results === true || (typeof flags.results === 'string' && flags.results.trim() === ''))) {
    missing.push('--results <path>')
  }
  return missing
}

// The `## Global Constraints` section is plan-wide, so every dispatch in every phase carries
// the same list. It is read from the plan markdown rather than restated per task: a constraint
// that has to be repeated is a constraint that will drift.
//
// The extraction rules — where a section ends, how a wrapped bullet is joined onto its
// continuation, and why neither pattern spans a bullet's text with `.` — now live in
// `scripts/plan-sections.mjs`, next to `bulletSection` itself. Read them there rather than
// here: this is just the plan-wide list mapped down to the bare strings callers expect.
export function parseConstraints(markdown) {
  return bulletSection(markdown, 'Global Constraints').map((item) => item.text)
}

// Renders a `PlanSectionError` as the refusal `init-run` prints before it exits 2. The
// document-level defect (a missing Destination) has no offending bullet to quote, so it gets
// its own two-line explanation with nothing indented below it. Both entry-level defects share
// one shape: the raw message (which already names the section, ordinal and line), two lines of
// explanation for why the shape rule exists, and the offending bullet quoted back so the
// author does not have to reopen the plan to see what tripped it. `err.entry` is plan-authored
// text reaching this refusal unfiltered — the same attacker channel `idRefusal` above quotes
// with `JSON.stringify(printable(...))` — so it gets the identical treatment here: `printable`
// neutralises control bytes (including line-erasing CSI sequences and the C1 range that
// `JSON.stringify` leaves raw) and `JSON.stringify` supplies quoting, so a boundary is visible
// even when the entry is empty, whitespace-only, or a lone zero-width character. `err.message`
// needs none of this: it is composed by `plan-sections.mjs` from a fixed string plus an ordinal
// and a line number and carries no plan-authored text.
function formatPlanSectionError(err) {
  if (err.reason === 'missing-destination') {
    return 'plan defect: this plan has an Out of Scope section but no Destination.\n'
      + 'Out of scope means beyond the destination, so without one there is\n'
      + 'nothing to judge an entry against.'
  }
  if (err.reason === 'missing-reason') {
    return `plan defect: ${err.message}.\n`
      + 'An entry without a reason is not a scope boundary — it is a word.\n'
      + 'Write what it is, and why it is beyond the destination.\n\n'
      + `  - ${JSON.stringify(printable(err.entry))}`
  }
  // missing-question
  return `plan defect: ${err.message}.\n`
    + 'An entry without a question mark is a work item wearing fog\'s clothes.\n'
    + 'Ask it as a question, or write it as a task with a declared file set.\n\n'
    + `  - ${JSON.stringify(printable(err.entry))}`
}

// The router both `init-run` and `rebuild-state` put around their `parsePlanSections(...)`
// call: format a `PlanSectionError` as the refusal to print, or re-throw anything else
// unchanged. Extracted so this decision has a test that does not depend on making
// `parsePlanSections` itself throw a non-`PlanSectionError` — under any real markdown it never
// does, which is exactly why deleting this guard left the whole suite green: nothing that runs
// through a real plan file can distinguish "the guard is gone" from "the guard was never
// exercised". Without it, a stray bug inside `plan-sections.mjs` would print as
// `plan defect: TypeError: ...` with a bullet reading `  - undefined`, reporting an internal
// fault as though the operator's plan prose were at fault.
// Reads the three header sections from the plan COMMITTED AT THE ANCHOR, or null when that
// cannot be done — an absent plan, an unreadable one, or one whose sections no longer parse.
// null means "no comparison is possible", never "they match": a defect at the anchor is not
// evidence that `plan.json` is current, so the caller stays quiet rather than asserting either.
async function planSectionsAtAnchor(ctx, planPath) {
  if (!ctx?.git || !ctx?.anchorSha || typeof planPath !== 'string' || planPath === '') return null
  try {
    return parsePlanSections(await ctx.git.fileAtCommit(ctx.anchorSha, planPath))
  } catch {
    return null
  }
}

// Compares only what the notes actually render — the destination and the fog list. `outOfScope`
// is deliberately excluded: it never reaches this report, so a change to it is not a staleness
// the operator is looking at. Entry text is compared, not `line`, because a fog entry that only
// moved down the file says the same thing.
function samePlanNotes(plan, anchored) {
  const recordedDestination = typeof plan?.destination === 'string' ? plan.destination : null
  if (recordedDestination !== (anchored.destination ?? null)) return false
  const textsOf = (list) => (Array.isArray(list) ? list : [])
    .filter((e) => e !== null && typeof e === 'object' && typeof e.text === 'string')
    .map((e) => e.text)
  const recorded = textsOf(plan?.notYetSpecified)
  const current = textsOf(anchored.notYetSpecified)
  return recorded.length === current.length && recorded.every((t, i) => t === current[i])
}

export function planSectionsRefusal(err) {
  if (!(err instanceof PlanSectionError)) throw err
  return formatPlanSectionError(err)
}

// runId/taskId become path segments under root/.fleetmates. Without containment, a value
// like `../../ESCAPED` writes state outside the run directory entirely — the same class
// of ref/path-escape primitive the git layer already closes for branch and tag names.
function assertContained(baseDir, segment, flagName) {
  const resolvedBase = path.resolve(baseDir)
  const resolvedTarget = path.resolve(path.join(baseDir, String(segment)))
  const rel = path.relative(resolvedBase, resolvedTarget)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    // `printable` because this is a PRINT SITE for a value nothing upstream has validated for
    // characters: on the `collect-reviews` / `review-dispatch` route `assertContained` is the only
    // gate the run id passes, and it answers containment, not characters. `collect-reviews` hands
    // `err.message` straight to the operator unwrapped, so the wrap has to be here, where the
    // sentence is built.
    throw new Error(`${flagName} ${printable(segment)} escapes the run directory`)
  }
}

// THE LOCATION RECORD'S ID RULE, restated here because `init-run` is what creates ids and the
// store is what has to be able to hold them. `scripts/state.mjs` keeps its predicate private,
// so this is a restatement, and a restatement pinned only by tests written against itself pins
// nothing — the test `init-run accepts exactly the run ids the location record can hold` puts
// every id in a corpus to BOTH implementations and compares their answers, which is what makes
// this safe to have twice.
//
// THE STORE IS AUTHORITATIVE. Do not relax anything below to admit an id `writeLocation` would
// refuse: `init-run` accepting one the record cannot hold is not a cosmetic mismatch. Such a run
// parses, phases and dispatches normally, every teammate's `locate` fails at its first act after
// the checkout, the stop-time hook then resolves nothing for any worktree, and enforcement is off
// for the whole run — a state indistinguishable from a clean pass.
//
// The reasoning behind the shape of the rule (why an allowlist rather than a blocklist, why a
// non-NFC id is refused rather than folded, why ZWJ/ZWNJ are excluded per UAX #31's restricted
// profile, and the accepted cross-script-confusable limit) is recorded above `ID_COMPONENT` in
// scripts/state.mjs. It is not repeated here; read it there.
const ID_COMPONENT_RE = /^[\p{L}\p{M}\p{N}._-]+$/u
const ID_INVISIBLE_RE = new RegExp('\\p{Default_Ignorable_Code_Point}', 'u')
// The store's own caps, in bytes, matching how it measures them.
// Exported so the corpus can pass the SAME constant the CLI uses. Passing a literal `128` instead
// left the task cap unpinned outright: raising it alone kept the whole suite green while
// `init-run` would accept an id `writeLocation` refuses.
export const MAX_RUN_ID_BYTES = 255
export const MAX_TASK_ID_BYTES = 128

// Returns the character to name in a refusal, or '' when the whole VALUE is what is wrong (a
// byte cap, a non-NFC spelling, an empty id) and no single character can be pointed at. A
// refusal that cannot say which character it tripped on cannot be acted on, which is why this
// returns the character rather than a boolean.
function offendingIdChar(component) {
  for (const ch of component) {
    if (ID_INVISIBLE_RE.test(ch)) return ch
    if (!ID_COMPONENT_RE.test(ch)) return ch
  }
  return ''
}

// null when the id is usable, otherwise a sentence naming the id and what is wrong with it.
// `nested` is true for a runId, which may descend (`init-run --run 2026/substop` really does
// create `.fleetmates/2026/substop/`), and false for a taskId, which names exactly one component.
// Exported so the corpus can put BOTH nesting modes to it directly. `init-run` only ever reaches
// the nested (runId) call with caller-supplied text — a plan's task ids are built as `T<digits>`
// by `plan-parser.mjs` and cannot be anything else — so the single-component branch has no route
// through the CLI to test it by, and testing it through `init-run` would be testing nothing.
export function idRefusal(flagName, value, { nested, maxBytes }) {
  // The repository's convention for quoting an attacker-controlled value into a sentence:
  // `printable` neutralises the control bytes (including the C1 range, which JSON.stringify
  // leaves raw), and `JSON.stringify` then supplies the quoting that makes an empty or
  // whitespace-only id readable. A refusal is the line most worth forging — this one is printed
  // while the command exits 2 — and an id is argv, so it is exactly such a value.
  const show = (v) => JSON.stringify(printable(v))
  if (typeof value !== 'string' || value === '') return `${flagName} must be a non-empty id`
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > maxBytes) return `${flagName} ${show(value.slice(0, 40))}... is ${bytes} bytes, over the ${maxBytes} a location record can hold`
  if (value.normalize('NFC') !== value) {
    return `${flagName} ${show(value)} is not in Unicode NFC — nothing in this repository normalises ids, so pick the composed spelling`
  }
  // Checked over the WHOLE value, not per component: `a..b` is revision-range syntax wherever
  // it appears, exactly as the store checks it.
  if (value.includes('..')) return `${flagName} ${show(value)} contains '..', which no id may`
  const components = value.split('/')
  if (!nested && components.length > 1) return `${flagName} ${show(value)} must name one component, not a path`
  for (const component of components) {
    if (component === '' || component === '.') return `${flagName} ${show(value)} has an empty or '.' component`
    // The id is spent as argv, so no component may look like an option.
    if (component.startsWith('-')) return `${flagName} ${show(value)} has a component starting with '-', which would read as an option`
    const bad = offendingIdChar(component)
    if (bad !== '') {
      // Escaped, always: this rule refuses several characters that render as nothing, and a
      // refusal that silently drops the character it is complaining about names nothing.
      const escaped = `\\u{${bad.codePointAt(0).toString(16)}}`
      return `${flagName} ${show(value)} contains ${escaped}, which a location record cannot hold`
        // The rule as the regex above actually spells it. It named `/` and omitted `_`, both
        // wrong: `_` is in the class, and `/` separates components rather than appearing inside
        // one — so a caller who re-read the printed rule and acted on it would be refused again
        // for the character the message had just told them to use.
        + ' — a component allows letters, marks, digits, and only . _ and -'
    }
  }
  return null
}

// The MAIN worktree's root, which is where a run's `.fleetmates/` lives. `--git-common-dir` is
// `<main>/.git` for a linked worktree and the repository's own `.git` otherwise, so its parent
// is the main worktree in both cases. `locate` runs from inside a teammate's worktree, so its
// `--root` is that worktree and cannot be the store's root.
//
// Here rather than in scripts/git.mjs for the same reason `repoPrefix` above is: it composes an
// existing git primitive for one command, and is not a new primitive of the git layer.
// The top level of the worktree `root` sits in — git's own answer, so it agrees with what the
// harness reports as a stopping agent's cwd. Separate from `mainWorktreeRoot` above: that one
// answers "where does this run's state live", this one answers "which worktree am I in", and for
// a linked worktree the two are different directories. Confusing them is what files a record
// nothing can find.
async function worktreeTopLevel(root) {
  const { code, stdout, stderr } = await defaultGitExec(['rev-parse', '--path-format=absolute', '--show-toplevel'], root)
  if (code !== 0) {
    throw new GitError(`git rev-parse --show-toplevel failed: ${stderr.trim() || `exit ${code}`}`)
  }
  const topLevel = stdout.replace(/\n$/, '')
  if (topLevel === '') throw new GitError('git rev-parse --show-toplevel printed nothing')
  return topLevel
}

// WHAT KIND OF WORKTREE IS THIS, decided structurally rather than by asking git to list them.
//
// A `.git` FILE is plain text a teammate can write, and four hand-written files — none of them
// inside `.git` — are enough to make `rev-parse` report a `--show-toplevel` and a `--git-common-dir`
// that both look like this repository's:
//
//     <main>/packages/app/.git            "gitdir: <main>/.fleetmates/fakewt"
//     <main>/.fleetmates/fakewt/commondir  "<main>/.git"
//     <main>/.fleetmates/fakewt/gitdir     "<main>/packages/app/.git"
//     <main>/.fleetmates/fakewt/HEAD       "ref: refs/heads/master"
//
// `.fleetmates/` is gitignored, so `git status --untracked-files=all` shows nothing. A record filed
// for that path then blocks every unrelated agent whose cwd is inside it.
//
// The discriminator is CONTAINMENT of the git dir, measured on all four shapes in a real
// repository before it was written here:
//
//     cwd                          commonDir === gitDir   dirname(dirname(gitDir)) === commonDir
//     main worktree root           true                   false
//     the plant                    false                  false
//     real linked worktree         false                  true
//     linked worktree subdirectory false                  true
//
// A genuine linked worktree's git dir is `<commonDir>/worktrees/<name>`; the plant's is wherever
// its author put it, and no amount of writing files outside `.git` moves it inside `<commonDir>`.
//
// KEEP THE CLASSIFICATION EXPRESSION IDENTICAL to the SubagentStop handler's — the three lines
// deciding main / contained / neither. Every divergence between the two files in this phase has
// produced a defect.
//
// The NORMALISATION differs between the two files and the difference is INCIDENTAL. Both sides
// compare two values that came out of the same `git rev-parse --path-format=absolute` call — here
// `commonDir` against `dirname(dirname(gitDir))`, and the handler does the identical comparison
// with `normaliseWorktree` — and git has already canonicalised both operands, so neither choice
// can change the answer. Measured: swapping the handler's `normaliseWorktree` for `path.resolve`
// leaves its suite green, so neither spelling is load-bearing for THIS comparison.
//
// Two earlier versions of this comment asserted otherwise — first that the two files used the same
// normalisation, then that the difference was required because the handler consumes a payload
// `cwd`. Both were wrong; the handler's operands here are its own rev-parse output. Recorded so
// the next reader neither "fixes" a divergence that costs nothing nor invents a reason for it.
//
// `worktreeKey` below is different, and there the choice IS load-bearing: one of its operands is
// the caller-supplied candidate path, which nothing has canonicalised, and the question asked of
// it is "do these two paths address the same record" — the store's own question, so the store's
// own function.
const CLASSIFY_MAIN = 'main'
const CLASSIFY_LINKED = 'linked'
const CLASSIFY_SUBDIRECTORY = 'subdirectory'
const CLASSIFY_FOREIGN_REPO = 'foreign-repo'
const CLASSIFY_NOT_A_WORKTREE = 'not-a-worktree'

async function classifyWorktree(candidate, expectedCommonDir) {
  const at = async (arg) => {
    const { code, stdout, stderr } = await defaultGitExec(['rev-parse', '--path-format=absolute', arg], candidate)
    if (code !== 0) throw new GitError(`git rev-parse ${arg} failed: ${stderr.trim() || `exit ${code}`}`)
    const value = stdout.replace(/\n$/, '').replace(/[\\/]+$/, '')
    if (value === '') throw new GitError(`git rev-parse ${arg} printed nothing`)
    return path.resolve(value)
  }
  const commonDir = await at('--git-common-dir')
  const gitDir = await at('--git-dir')
  if (commonDir !== path.resolve(expectedCommonDir)) return CLASSIFY_FOREIGN_REPO
  if (commonDir === gitDir) return CLASSIFY_MAIN
  if (path.resolve(path.dirname(path.dirname(gitDir))) !== commonDir) return CLASSIFY_NOT_A_WORKTREE
  // A worktree and every directory beneath it share one git dir, so the containment test above
  // cannot tell them apart — the `git worktree list` membership check this replaced could, because
  // that listing names only top levels. Losing the distinction meant `--worktree <wt>/src` was
  // recorded at exit 0, and the record was then unfindable: the handler resolves a stopping
  // agent's cwd through `--show-toplevel`, so it looks up `<wt>` and finds nothing. A do-nothing
  // teammate that recorded from a subdirectory got allowed instead of blocked, which is precisely
  // the case the record exists for.
  //
  // Compared through `worktreeKey`, the store's own addressing function, because "is this the
  // worktree" and "does this address the worktree's record" have to be the same question.
  return worktreeKey(candidate) === worktreeKey(await at('--show-toplevel'))
    ? CLASSIFY_LINKED
    : CLASSIFY_SUBDIRECTORY
}

// The repository's shared git directory, normalised the same way `classifyWorktree` normalises,
// so the two can be compared without either one re-deriving it.
async function gitCommonDir(root) {
  const { code, stdout, stderr } = await defaultGitExec(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)
  if (code !== 0) {
    throw new GitError(`git rev-parse --git-common-dir failed: ${stderr.trim() || `exit ${code}`}`)
  }
  // Exactly the framing newline; a directory name may legally end in other whitespace. Trailing
  // separators are stripped so `dirname` steps out of `.git` rather than out of an empty tail.
  const commonDir = stdout.replace(/\n$/, '').replace(/[\\/]+$/, '')
  if (commonDir === '') throw new GitError('git rev-parse --git-common-dir printed nothing')
  return path.resolve(commonDir)
}

async function mainWorktreeRoot(root) {
  return path.dirname(await gitCommonDir(root))
}

// Read from git at the anchor, never from the working tree. `gate` and `complete` both read the
// plan with `git show <anchor>:<planPath>` precisely so a teammate cannot widen its own file set
// by editing the checked-out copy. Reading it from disk left the two disagreeing: the constraints
// injected into every brief came from mutable, uncommitted markdown while the gate enforced the
// committed plan, so a working-tree edit between phases would hand every teammate instruction
// text with no record in git.
//
// The consequence is that an uncommitted plan fails rather than generating. That is the honest
// outcome: a brief must not carry rules the run cannot show a reader.
//
// A --plan pointing at nothing is a mistake worth an exit code. Swallowing the read error and
// generating a constraint-free brief would hand every teammate in the phase a dispatch missing
// the very rules the caller asked to carry, with exit 0 and nothing on stdout.
//
// Shared by `workflow` and `brief` rather than copied into the second one: two composers reading
// the plan from two places is precisely the divergence above, and a copy is how it comes back.
const PLAN_READ_REJECTED = Symbol('the plan could not be read at the run anchor')

async function planAtAnchor(root, planPath, flags, io) {
  if (!planPath) return ''
  const git = createGit({ cwd: root })
  let anchorSha
  try {
    // THE SHARED CLASSIFIER, for the same reason `derive` uses it: this reads the plan every
    // teammate is briefed from, and it does not go through `derive`, so it inherits none of that
    // command's refusals. It guarded only the detached case for one round, and that was a genuine
    // regression against the tree before this task — with `ref: refs/mine/rb` written straight
    // into `.git/HEAD` (a plain file write, which no pseudo-ref guard sees), `brief` and
    // `workflow` exited 0 and emitted dispatches whose `## Global Constraints` came from an anchor
    // of the planter's choosing, with a real constraint silently absent. Measured: the merge base
    // exits 2 in the identical state, so this had to refuse it too.
    const head = await git.headBranch()
    if (!head.ok) {
      throw new GitError(`${head.reason} — there is no run branch to read the plan from; check out the run branch and re-run`)
    }
    const baseBranch = await resolveBaseBranch(git, flags.base)
    const runSha = await git.resolveRef(head.ref)
    const baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
    anchorSha = await git.mergeBase(baseSha, runSha)
    // `git show <sha>:<path>` takes a repo-relative path and rejects an absolute one, but
    // --plan is commonly given as absolute (every caller that builds it from a root does).
    // Normalising here keeps both spellings working; the brief still points at the path the
    // caller wrote, since that is what a reader of the dispatch will recognise.
    const relPath = path.isAbsolute(planPath)
      ? path.relative(root, planPath).split(path.sep).join('/')
      : planPath
    return await git.fileAtCommit(anchorSha, relPath)
  } catch (err) {
    const where = anchorSha ? ` at anchor ${anchorSha}` : ''
    io.out(
      `--plan ${planPath} could not be read from git${where}: ${err instanceof GitError ? err.message : err.message}`
      + ' — the plan must be committed on the base branch, which is where the gate reads it from',
    )
    return PLAN_READ_REJECTED
  }
}

// `complete`'s one code that means "a check SCOPED TO THIS TASK rejected this task", and nothing
// else. It is read programmatically: the SubagentStop handler blocks a teammate's stop on this
// code and allows on every other, so what it may cover is not a style question.
//
// It exists because neither code already in use can carry that decision. `complete` returns 2 for
// a malformed manifest OR a rejected invocation, and 4 for the cannot-verify situations — no gate
// manifest, an underivable context, a task the plan does not contain. Blocking on 2 would cost a
// teammate a turn for the orchestrator's typo; allowing on 4 would wave through the very rejection
// the hook exists to catch.
const COMPLETE_REJECTED = 3

// The code for everything this command could not answer for. Named alongside the one above so the
// pair reads as one decision; the earlier exits in `complete` still write the literal 4, and mean
// the same thing.
const COMPLETE_CANNOT_VERIFY = 4

// The two kinds `runChecks` narrows to `ctx.taskScope`, and therefore the only two whose failure
// is a statement about the calling task. `ownership` is deliberately absent: it is run-wide by
// design (`scopedTasks` in gate-runner.mjs leaves it reading the full task list, so a direct write
// to the run branch cannot ride in behind whichever task finishes first). That is correct for the
// check and fatal for a block decision — uncommitted changes in the MAIN worktree, or anyone's
// direct commit to the run branch, fail `ownership` for every teammate in the phase at once. A
// teammate blocked on that is told to clean a worktree it must never touch, and the only
// remediation it can act on is cherry-picking a foreign commit onto its own branch, which then
// trips `fileset`.
//
// So the narrowing lives in the exit-code mapping rather than in any check: no gate check changes
// behaviour, the phase gate still catches everything, and what survives at stop time is exactly
// the question a stopping teammate owns — did you stray outside your file set, is your branch
// empty, will your work merge.
const TASK_SCOPED_KINDS = new Set(['fileset', 'merge'])

// SELF-HEALING for the one input `complete --enforcement-only`'s fail-open guard depends on.
//
// Recording the run branch at `init-run` alone was not enough, and the reason is in the
// documented workflow: `skills/parallel-execution/SKILL.md` opens with `init-run`, and nothing
// before it creates or checks out the run branch. So `init-run` recorded whatever the operator
// happened to be on — usually the base branch — every later comparison failed, and because absent
// and wrong both fail OPEN, stop-time enforcement was off for the whole run with the explanation
// going to a stdout the handler discards. A guard whose input is wrong by default is worse than
// no guard: it looks like enforcement and is not.
//
// FILL-IF-ABSENT, NEVER OVERWRITE. This is the whole safety property and it is easy to get wrong,
// because `derive` proves less than it looks like it proves: it establishes that the checked-out
// branch is not the BASE branch, and nothing more. It does not establish that it is THIS RUN's
// branch. An operator who runs `gate` from `feature/foo` gets a failing gate — and, if this
// overwrote, a plan.json now naming `feature/foo`. Both directions then break:
//
//   - back on the real run branch the guard no longer matches, so `complete --enforcement-only`
//     goes 3 -> 4 and the hook allows every stop for the rest of the dispatch window (`complete`
//     never refreshes, so nothing repairs it until a lifecycle command runs again);
//   - and while the wrong checkout persists, the guard MATCHES it, so a compliant teammate is
//     blocked over a sibling's landed file — which violates the invariant this guard is built
//     around, that it may only ever turn a block into a non-block.
//
// Filling only an absent value keeps every repair — `workflow`, `gate`, `finish` and `prune-run`
// all still populate a field `init-run` could not — while making both failures unreachable.
//
// THE RULE IS NOT ENFORCED BY THIS COMMENT. It is enforced by `writePlan`, which is the only
// function in this file that writes plan.json, and — for the specific mistake that caused those
// regressions, a second writer added inline — by the source scan in tests/cli.test.mjs. That scan
// is a tripwire for one spelling, not a proof; read what it is worth at `writePlan` below before
// relying on it.
// This paragraph used to end "there is no exception anywhere", and that sentence was false in
// three consecutive rounds — `rebuild-state`, then `init-run`, each an inline writer nobody had
// listed. Enumerating writers in prose is how that kept happening; the enumeration is now the code.
//
// Which commands call THIS function is still a real decision and is deliberately not "everything
// that derives": `workflow` (before dispatch), `gate`, `finish` and `prune-run` (after a successful
// derive). `init-run` and `rebuild-state` write plans of their own and get the same rule by going
// through `writePlan`. `doctor`, `liveness` and `plan-drift` derive too and deliberately do not
// write: they are diagnostics, and a diagnostic that mutates run state is a surprise. `complete`
// derives and must never write — it is the CONSUMER, and a consumer that records what it is about
// to compare against approves itself.
//
// Never throws. `plan.json` is teammate-writable, and a corrupt one must not crash the command that
// happened to refresh a diagnostic field; each caller has its own fail-closed handling for state it
// actually depends on.
// THE ONLY WRITER OF plan.json IN THIS FILE. Every command that writes a plan goes through here,
// and fill-if-absent for `runBranch` is enforced HERE rather than at each call site.
//
// That structure is the point. This rule has now been stated as a universal in four consecutive
// rounds and been false in three of them, each time through a writer the comment did not know
// about — first `rebuild-state`, then `init-run`, which had been an inline writer the whole time.
// A rule that depends on every future author noticing a comment is not a rule, so there is exactly
// one `writeState(root, runId, 'plan', …)` call in this file, and a source-level test parses this
// file's `writeState`, `writeFile` and `rename` calls and requires that to stay true.
//
// WHAT THAT TEST IS WORTH. It reads source text: a tripwire for the literal
// `writeState(root, runId, 'plan', …)` spelling. Every prose enumeration of what it does and does
// not catch has itself been found incomplete, so there is none here. It is not a proof. The real
// coverage of fill-if-absent is behavioural and lives in the tests above the pin, which drive the
// CLI and assert the recorded branch survives; if you are changing this function, those are the
// ones to trust.
//
// `planFields === null` means "keep whatever is on disk and only reconsider the run branch", which
// is what `rememberRunBranch` wants; anything else replaces the plan's own fields.
//
// REPAIRING A POISONED RECORD: nothing here does, deliberately. Every automatic writer fills only
// an absent value precisely so that no automatic writer can be talked into replacing a good one —
// which means a wrong value, once written, is the operator's to remove: delete
// `.fleetmates/<runId>/plan.json` (or just its `runBranch`) and re-run `init-run`, or delete the run
// directory and `rebuild-state`. `init-run` prints the recorded branch whenever it differs from the
// checkout, so a poisoned record announces itself rather than being found later by its effects.
async function writePlan(root, runId, planFields, { candidateRunBranch = null, baseBranch = null } = {}) {
  let previous = null
  try {
    previous = await readState(root, runId, 'plan')
  } catch {
    // An unreadable plan.json carries nothing forward. Recovering from one is `rebuild-state`'s
    // job, and for every other caller a corrupt file is handled by its own fail-closed path.
    previous = null
  }
  const carried = typeof previous?.runBranch === 'string' ? previous.runBranch : null
  // The base branch can never be a run branch, and `workflow` is the one caller whose branches do
  // not come from `derive` — which refuses that case itself — so the test lives here.
  const usable = typeof candidateRunBranch === 'string'
    && candidateRunBranch !== ''
    && candidateRunBranch !== baseBranch
    ? candidateRunBranch
    : null
  const runBranch = carried ?? usable

  const base = planFields ?? previous
  if (!base) return { runBranch: null, carried: null, wrote: false }
  // Whatever the caller supplied for this field is discarded: it is decided here or not at all.
  const { runBranch: _decidedHere, ...rest } = base
  if (planFields === null && runBranch === carried) return { runBranch, carried, wrote: false }
  await writeState(root, runId, 'plan', { ...rest, ...(runBranch ? { runBranch } : {}) })
  return { runBranch, carried, wrote: true }
}

async function rememberRunBranch(root, runId, runBranch, baseBranch) {
  try {
    const { wrote } = await writePlan(root, runId, null, { candidateRunBranch: runBranch, baseBranch })
    return wrote
  } catch {
    return false
  }
}

// A failing `merge` means two opposite things and they are told apart by ONE field.
//
//   - the preview was BUILT and the branches CONFLICTED. `runChecks` attaches `pairs` (the
//     conflicting branch pairs) to that result and to no other. This is a verdict about the
//     calling task: its work does not merge, which is one of the three questions the stop-time
//     hook exists to ask.
//   - the preview could not be built AT ALL — a branch deleted mid-run, no committer identity,
//     a worktree that would not create. There is no merged tree, so nothing downstream is
//     evidence about anyone's work, and on one of those paths `runChecks` marks every other
//     check failed carrying that same reason.
//
// `Object.hasOwn(r, 'pairs')` is the whole discriminator, and it is the single word between a
// teammate being blocked and being waved through. `tests/cli.test.mjs` drives a REAL merge
// conflict through this function for that reason: before it did, every one of the suite's
// invocations saw `merge: pass`, so deleting this predicate shipped green while turning an
// unmergeable branch from blocked into allowed.
const previewUnbuildable = (r) => r.kind === 'merge' && r.status === 'fail' && !Object.hasOwn(r, 'pairs')

// Which code a non-PASS verdict earns. Applied on both paths, with and without
// `--enforcement-only`: an exit code that meant one thing per flag would need two brief tables to
// explain, and the teammate reading it does not know which flag the hook passed.
//
// The task-scoped question is asked FIRST. Returning early on an unbuildable preview meant a real
// `fileset` rejection standing beside one surfaced as 4 — fail-open, and the phase gate does
// recompute it, but it is not what the contract says and the teammate was told its file set was
// fine when it was not.
export function completeExitCode(results, verdict) {
  const blocking = new Set(verdict.failed)
  // The reason an unbuilt preview stamped on everything else. Those results are not measurements
  // of anything, so a `fileset` carrying this exact text is excluded below while a `fileset` that
  // really ran — the ordinary case, since the no-preview path still runs it against the real
  // repository — still rejects.
  const previewReason = results.find(previewUnbuildable)?.output ?? null
  const rejected = results.some((r) => (
    TASK_SCOPED_KINDS.has(r.kind)
    && r.status === 'fail'
    // `verdict.failed` membership, not `status === 'fail'` alone: an OPTIONAL failing check never
    // blocked the gate, so it must never be the thing that blocks a teammate's stop either.
    && blocking.has(r.name)
    && !previewUnbuildable(r)
    && !(previewReason !== null && r.output === previewReason)
  ))
  return rejected ? COMPLETE_REJECTED : COMPLETE_CANNOT_VERIFY
}

// Preferring `main` when both `main` and `master` exist is the same ref-creation primitive
// as the tag-shadowing bypass the design closed elsewhere: a teammate creates a branch
// named `main`, the heuristic silently prefers it, mergeBase(main, run) collapses onto the
// run tip, and every downstream diff and commit range becomes vacuous. When both exist and
// the caller did not disambiguate, refuse rather than guess.
async function resolveBaseBranch(git, flag) {
  if (flag) {
    // Checked HERE because every consumer splices the answer into `refs/heads/<name>`: a value
    // that is not a local branch becomes a ref that cannot exist, and git answers with
    // `fatal: Needed a single revision`, which names neither the flag nor the shape it wanted.
    // Measured on run `purgefix`: `--base origin/fix/pass6-findings` exited 4 on that plumbing
    // error with nothing telling the operator what to pass instead. A remote-tracking ref and a
    // raw sha are the two spellings an operator actually reaches for, so the refusal names both.
    if (!await git.branchExists(flag)) {
      throw new Error(
        `--base ${flag} is not a local branch — this flag takes a local branch NAME, which is `
        + 'spliced into refs/heads/<name>. A remote-tracking ref (origin/main) or a raw commit '
        + 'does not resolve there: create or check out a local branch at that commit first.',
      )
    }
    return flag
  }
  const present = []
  for (const candidate of ['main', 'master']) {
    if (await git.branchExists(candidate)) present.push(candidate)
  }
  if (present.length > 1) {
    throw new Error(`ambiguous base branch — both ${present.join(' and ')} exist; pass --base to choose one`)
  }
  if (present.length === 1) return present[0]
  throw new Error('could not determine the base branch — pass --base')
}

// Only the checks the CLI cannot run itself may be supplied. `command`, `fileset` and
// `ownership` are computed, so they are never in this set.
const SUPPLIABLE_KINDS = new Set(['agent', 'mcp'])
// The same vocabulary aggregateVerdict recognises, minus `pending` — supplying "still
// pending" says nothing, and anything outside the set is an error rather than a pass.
const SUPPLIED_STATUSES = new Set(['pass', 'fail', 'skip'])
// Provenance, not authority: `response` is the reviewer's returned result, `file` is one
// recovered from the findings file it wrote before idling without returning. The distinction
// exists nowhere else — a recovered review and a returned one produce identical verdicts — so
// without carrying it here, "this lens was paid for twice / was nearly lost" is unrecorded.
// Unset means `response`, because that is the ordinary path.
const SUPPLIED_SOURCES = new Set(['response', 'file'])

// `--results` is caller input for one run, never persisted authority. A result for a computed
// check would be a way to hand the gate a passing `fileset`, so those are rejected outright.
//
// Module-private on purpose: this is a trust boundary, every branch below is covered
// end-to-end through `runCli`, and nothing outside this module has any business calling it.
function validateSuppliedResults(supplied, checks) {
  const byName = new Map()
  const duplicated = new Set()
  for (const c of checks) {
    // A manifest entry that is not an object at all carries no name to index and no kind to
    // validate against, and `runChecks` has already failed the phase on it. Skipped rather than
    // indexed: `c.name` here threw a TypeError on a `null` entry — the shape a hand-written
    // manifest reaches most easily — which killed `gate` before its own diagnosis was printed.
    if (c === null || typeof c !== 'object') continue
    if (byName.has(c.name)) duplicated.add(c.name)
    byName.set(c.name, c)
  }
  for (const r of supplied) {
    // `checksForPhase` does not enforce unique check names, and a name that resolves to more
    // than one check cannot be validated: `byName` would resolve it to exactly one (last
    // wins) while the merge below fills EVERY pending result carrying that name — so a
    // manifest declaring `{name:'test',kind:'command'}` and `{name:'test',kind:'agent'}`
    // would let an `agent` result land on the `command` check. Whether the file was accepted
    // would then depend on declaration order rather than on what gets written. Reject the
    // collision instead of resolving it.
    // Every value below is agent-written — the name out of the `--results` file, the kind and
    // name out of the manifest — and each is spliced into a sentence a terminal draws, so each
    // takes `printable`. The two refusals naming `r?.name` are quoted as well as wrapped:
    // `JSON.stringify` escapes quotes and the C0 range, which keeps the name legible as a
    // quoted string, and leaves 0x7F, the C1 range and U+2028/U+2029 untouched — so it runs AFTER
    // `printable`, the order `reviewFileName` uses in `scripts/reviews.mjs`, never instead of it.
    if (duplicated.has(r?.name)) {
      return `--results names a check declared more than once in this phase's manifest: ${JSON.stringify(printable(r?.name))}`
    }
    const check = byName.get(r?.name)
    if (!check) return `--results names a check not in this phase's manifest: ${JSON.stringify(printable(r?.name))}`
    if (!SUPPLIABLE_KINDS.has(check.kind)) return `--results may not supply a ${printable(check.kind)} check: ${printable(check.name)}`
    if (!SUPPLIED_STATUSES.has(r.status)) return `--results carries an unrecognized status for ${printable(check.name)}: ${JSON.stringify(r.status)}`
    if (r.source !== undefined && !SUPPLIED_SOURCES.has(r.source)) {
      return `--results carries an unrecognized source for ${printable(check.name)}: ${JSON.stringify(r.source)} (expected "response" or "file")`
    }
  }
  return null
}

// Fills in the pending results only. A check the gate actually ran keeps its computed result,
// so a supplied entry can never overwrite what the CLI itself determined. The merged list is
// then handed to aggregateVerdict, which stays the only producer of a verdict — that is what
// makes a recorded PASS CLI-computed rather than hand-written.
//
// `status`, `output` and `findings` come from the supplied entry — that is what the caller is
// reporting. `optional` is taken from the COMPUTED result and never from the file: `optional`
// is a manifest declaration that a check does not block, so letting a result declare itself
// optional would turn a failing required review advisory by way of the very file reporting
// its failure (PASS, exit 0, the failure demoted into `optionalFailed`).
//
// Each supplied entry is consumed once, so a name appearing twice in the raw results fills
// only the first pending one and any collision is left pending rather than silently passed.
// validateSuppliedResults already rejects duplicate names outright; this keeps the invariant
// local to the function that does the writing.
//
// The `status !== 'pending'` guard is dormant future-proofing rather than dead code: no
// suppliable kind has a runner today, so the gate always leaves `agent`/`mcp` pending. The
// moment one of them does run, a supplied result must not overwrite the computed one.
export function mergeSuppliedResults(rawResults, supplied) {
  const unused = new Map()
  for (const r of supplied) {
    if (!unused.has(r.name)) unused.set(r.name, r)
  }
  return rawResults.map((r) => {
    const s = unused.get(r.name)
    if (!s || r.status !== 'pending') return r
    unused.delete(r.name)
    return {
      name: r.name,
      kind: r.kind,
      status: s.status,
      output: s.output ?? '',
      optional: r.optional,
      findings: s.findings ?? [],
      // Provenance travels with the result into the recorded verdict. It is deliberately not
      // read by aggregateVerdict: a review recovered from a file is worth exactly as much as
      // one that was returned — the file is written by the reviewer either way.
      source: s.source ?? 'response',
    }
  })
}

// The per-phase counterpart of `gate`'s `--results` read. Same three answers: no flag means no
// supplied evidence, an unreadable or malformed file is refused BY NAME, and a shape that is not
// `{ phases: { "<n>": { results: [...] } } }` is refused with the shape it expected. Only the
// SHAPE is checked here — which results may be supplied at all is `validateSuppliedResults`'s
// rule, and it is applied per phase against that phase's own manifest block.
const SUPPLIED_REJECTED = Symbol('supplied phase results rejected')

async function readSuppliedPhases(flags, io) {
  // A valueless or empty `--results` never reaches here: missingArgs rejects it as the missing
  // argument it is, rather than letting this truthiness test silently drop the flag.
  if (!flags.results) return null
  let parsed
  try {
    parsed = JSON.parse(await readFile(flags.results, 'utf8'))
  } catch (err) {
    // Node embeds a slice of the parsed input in a JSON parse error, so this message carries
    // bytes out of the agent-written file it failed on. `printable`, for the reason every other
    // quoted value here goes through it: see its definition in `reviews.mjs`.
    io.out(`--results ${printable(flags.results)} could not be read as JSON: ${printable(err.message)}`)
    return SUPPLIED_REJECTED
  }
  const invalid = validateSuppliedPhases(parsed)
  if (invalid) {
    // The refusal embeds a phase key from the agent-written `--results` file. `JSON.stringify`
    // escapes the C0 range but leaves 0x7F, the C1 range and U+2028/U+2029 raw — 0x9B is CSI in
    // an 8-bit terminal, and U+2028 is a line break where the transcript is rendered — so the
    // refusal itself would print a forged `[gate] ... PASS` line. Wrapped for the same reason the
    // JSON-parse message three lines above it already is.
    io.out(printable(invalid))
    return SUPPLIED_REJECTED
  }
  return parsed
}

// A supplied block keyed to a phase the run does not have is read by NOBODY: evidence is looked
// up with `suppliedForPhase(supplied, phase)` for phases taken from the plan, so a key naming no
// real phase is never consulted — including one carrying a `command` result, which under a real
// phase is refused with exit 2. An operator with a typo'd phase key would otherwise get a pending
// report and no hint their evidence was discarded.
//
// Reported, never refused. Dropping the block is already the safe direction — unmatched evidence
// changes no verdict — so this exists only so the output stops lying by omission.
//
// The keys are printed BARE, and that is safe only because of a constraint stated elsewhere:
// `validateSuppliedPhases` in `scripts/finish.mjs` refuses any key for which
// `String(Number(key)) !== key`, so every key that reaches here is the canonical decimal form of
// an integer and can carry no control byte. Both callers run that validator first —
// `readSuppliedPhases` returns SUPPLIED_REJECTED on its refusal and both return 2 on it — so a
// key with bytes in it never gets this far. That refusal is pinned by 'a numeric phase key that
// is not its own canonical form is refused' in `tests/finish.test.mjs`; if it is ever loosened,
// these keys need `printable` like every other quoted value here. The `phases` half of the
// sentence is a list of integers `assignPhases` computed, never read from anything.
function reportUnmatchedSuppliedPhases(io, supplied, phases) {
  const byPhase = supplied?.phases
  if (!byPhase || typeof byPhase !== 'object') return
  const real = new Set(phases.map((p) => String(p)))
  const unmatched = Object.keys(byPhase).filter((key) => !real.has(key))
  if (unmatched.length === 0) return
  io.out(
    `--results supplies evidence for phase ${unmatched.join(', ')}, which this run does not have`
    + ` (its phases are ${phases.join(', ') || 'none'}) — that evidence was not used`,
  )
}

// How deep the link sweep below will walk. A `preview.link` entry is a repo-relative directory
// path, so a handful of segments covers every shape the manifest can declare; reaching the limit
// means a tree this cannot vouch for, and it THROWS rather than returning quietly — a partial
// sweep followed by a removal is the exact failure the sweep exists to prevent.
const PREVIEW_LINK_MAX_DEPTH = 12

// Remove the links a merge preview was provisioned with, before the worktree itself is removed.
//
// `git worktree remove --force` FOLLOWS a junction: verified against a throwaway fixture on
// Windows — a junction created inside a worktree with fs.symlink(target, link, 'junction'), which
// is exactly what scripts/preview-links.mjs creates, exits 0 and deletes THE CONTENTS OF THE LINK
// TARGET. On an operator's machine that target is the repository's real `node_modules`, wiped by
// `prune-run --yes`. `rm -rf` has the same behaviour and is no safer.
//
// This is not a rare shape. A leaked preview is BY CONSTRUCTION one whose `teardownLinks` never
// ran — scripts/merge-preview.mjs runs it in a `finally`, which a SIGKILL skips — so a leaked
// preview is precisely the case most likely to still hold its junctions.
//
// The sweep is the caller's own: it never follows a link (every entry is `lstat`ed, and only a
// real directory is descended into), so nothing outside the preview tree is ever read or written.
// Any failure propagates, and the caller must leave that worktree in place: an unremovable link
// is a reason not to remove the worktree, never a footnote under a removal that happened anyway.
async function unlinkPreviewLinks(dir, depth = 0) {
  if (depth > PREVIEW_LINK_MAX_DEPTH) {
    throw new Error(`nested deeper than ${PREVIEW_LINK_MAX_DEPTH} levels at ${dir}, so its links cannot be accounted for`)
  }
  let removed = 0
  for (const name of await readdir(dir)) {
    const entry = path.join(dir, name)
    // lstat, never stat: a junction or symlink must be seen as itself. `stat` reports the TARGET's
    // type, which is how a link to a directory reads as a directory and gets descended into.
    const info = await lstat(entry)
    if (info.isSymbolicLink()) {
      await unlink(entry)
      removed += 1
      continue
    }
    if (info.isDirectory()) removed += await unlinkPreviewLinks(entry, depth + 1)
  }
  return removed
}

// Which of these previews a HOLDER is still holding — either kind.
//
// scripts/merge-preview.mjs writes an OWNER MARKER beside the preview directory before it calls
// `git worktree add`, and releases it only after `removeWorktree` has deregistered the worktree.
// Git registers a worktree at the START of the add and deregisters it at the end of the removal,
// so the span over which the marker is held contains the span over which the preview is
// observable here — which is what makes this different in kind from an mtime or a registration
// age. Those are sampled by the reaper and only narrow the window; this is held by the owner, so
// there is no instant at which a living owner reads as absent.
//
// A second kind of holder, the CLAIM, exists because the marker does not survive its own
// creator's death: a SIGKILLed gate runs no `finally`, so its marker survives naming a pid
// nobody is at, while the suite it spawned is still writing to the tree. Every sibling file
// matching `previewClaimPrefix(dir)` is a CANDIDATE claim, VETTED below before it is trusted.
//
// The MARKER is a candidate too, and is vetted by the same triple before it is read. It sits at
// a path derived from the preview directory's name and nothing secret, in the same directory as
// the claims, so anyone who can plant a claim can plant a marker; reading it unvetted, which this
// function used to do, trusted an entry the claim path would have rejected.
//
// The two part company in ONE case, argued where the code makes the choice: a preview directory
// that is GONE leaves the uid half of the marker's vetting with no referent, so the marker is
// read on `isFile()` alone rather than reaped out of hand, while claims stay ignored as they
// always were.
//
// FAIL-SAFE BRANCHES, all deliberate, all saying the same thing: a holder that cannot be RULED
// OUT is a holder.
//
//   1. A marker or a vetted claim that cannot be READ for any reason other than ENOENT —
//      EACCES, EBUSY, EIO. The file is there and could not be opened, so its pid is unknown.
//   2. A marker or claim that will not PARSE as a positive integer.
//   3. A probe that fails with anything other than ESRCH — EPERM means the pid exists and
//      belongs to another OS user, which is a gate this process may not signal, not one that
//      is gone.
//   4. A directory listing that fails for any reason: whether a claim exists at all becomes
//      unknown, which is exactly as unresolved as a marker that cannot be read.
//   5. The preview directory itself failing to `lstat` for any reason other than ENOENT: without
//      it there is no owner to vet a candidate claim against, so nothing under this prefix is
//      verifiable and the whole preview is unknown.
//
// An unreaped preview costs the operator a directory; a followed junction costs them their
// repository's build inputs. Only ENOENT and ESRCH — the two answers that positively mean "no
// owner" — let a preview through.
//
// VETTING a candidate — the marker and every claim alike — is a DIFFERENT move from the five
// branches above: a candidate that fails vetting is not "unknown", it is IGNORED — dropped from
// the vote entirely, contributing neither a holder nor an `unknown`. That distinction is the
// whole point: any local user can see this prefix and `touch` a file under it, so a candidate has
// to prove it is a genuine holder before its content is trusted at all, and a forged one must
// never be able to force `live` in EITHER direction merely by existing.
//
// THAT LAST SENTENCE IS A CLAIM ABOUT A MECHANISM, so here is the mechanism, because a version of
// this function held the sentence while an errno could get round it. Every candidate is vetted
// EXACTLY ONCE, on one of two paths, and neither can be skipped by planting a particular shape:
// `openHolderEntry` opens the entry and vets the DESCRIPTOR, and if the open fails for any reason
// but ENOENT the caller vets the PATH with the same predicate and reads nothing. An entry nobody
// can open — a socket, a mode-000 file — is therefore still judged, and judged by what it IS
// rather than by which errno it produced. The one thing an unopenable entry can still buy its
// planter is `unknown`, and only when it PASSES vetting, which means being a regular file owned
// by the preview directory's own owner: the shape a legitimate holder has.
//
//   - It must be a REGULAR FILE. A directory, a symlink, a fifo, a socket, a device — none of
//     those is ever READ. WHICH syscall rejects it varies by shape, and that matters to anyone
//     tempted to simplify this, so it is measured rather than assumed. Opening each shape with
//     this function's own flag word:
//
//       regular    open OK      isFile=true                 -> vetted, read
//       directory  open OK      isDirectory=true            -> rejected by the fstat
//       fifo       open OK      isFIFO=true                 -> rejected by the fstat
//       symlink    open FAILS   ELOOP                       -> rejected by the fallback lstat
//       mode 000   open FAILS   EACCES                      -> judged by the fallback lstat
//       socket     open FAILS   ENXIO                       -> rejected by the fallback lstat
//
//     Two consequences worth spelling out. A directory and a fifo reach `fstat` alive, which is
//     why the open must carry O_NONBLOCK: without it the fifo's open never returns and
//     `prune-run` stops dead with no output. And the three that fail to open are judged anyway,
//     by the fallback — which is the only reason "none of those is ever read" is a statement
//     about every shape rather than only about the openable ones.
//   - It must be owned by the SAME uid as the PREVIEW DIRECTORY, never by whoever is running
//     this reaper. `sudo prune-run` is the one caller whose removal can actually succeed, and
//     under it the reaper runs as uid 0 while the gate that legitimately holds the preview does
//     not — comparing a claim against the READER's own uid, which an earlier version of this
//     check did, discarded every genuine claim under sudo and reaped previews still in use. uid
//     0 is an ordinary value here, not a sentinel for "unset": a preview a root-run gate created
//     is legitimately claimed by uid 0 too, and the strict `!==` below honours that.
//
// Neither check ever uses a symlink-following `stat`: the ENTRY itself, not whatever it might
// point at, is what a planted file can control. On the default path that is `fstat` on an
// O_NOFOLLOW descriptor; where the open failed, and wherever a test injects `read`, it is the
// injectable `stat` below, which defaults to `lstat`.
//
// The two are not interchangeable in one respect, and getting that backwards is how a hole got
// in here. `lstat` needs no read permission on the entry, only search permission on the directory
// containing it — so it answers about entries an `open` cannot touch at all. That was written as
// a note about symlink safety while it was really the load-bearing reason the fallback above can
// exist: an unreadable entry can still be judged, so an attacker cannot escape vetting by making
// the thing unopenable.
//
// TWO LIMITS to the guarantee above, stated rather than left implicit:
//   - Windows-void, and only the UID half of it. Node's fs reports uid 0 for every path on that
//     platform, so the ownership comparison can never tell one local account from another there;
//     a claim reads as "owned" unconditionally and that half gives no protection on Windows.
//     Nothing here calls `process.getuid` at all — the comparison is between two `lstat` results,
//     never against the reader's own identity — so there is no platform branch to skip, only a
//     check that is silently a no-op on that platform. The REGULAR-FILE half is emphatically not
//     a no-op there: an unprivileged Windows user needs no privilege at all to plant a junction,
//     which is exactly what that check rejects. Do not read this note as licence to drop
//     `!info.isFile()` behind a platform branch.
//   - TOCTOU on a world-writable parent without the sticky bit. This was the CONTENT race:
//     vetting a candidate and reading it were two syscalls against a NAME, and between them
//     another local user could remove the entry the `lstat` approved and put a different one at
//     that name. `openHolderEntry` closed it by making the vetting and the read one descriptor,
//     which is measured in the table above that function. What survives is narrower and is what
//     the rest of this bullet is about: between the READDIR that discovers a claim name and the
//     open that follows it, the entry at that name can still change — so what is opened may not
//     be what was listed. It cannot be an entry that fails vetting, because vetting now happens
//     on the object opened, but it can be a different vetted one. A STICKY parent narrows who may
//     remove an entry inside it. Per unlink(2) and rename(2), a sticky directory only lets a
//     removal through when the REMOVING process's euid equals the FILE's own owner, OR equals the
//     DIRECTORY's owner, OR that process holds CAP_FOWNER — three ways through, not one.
//
//     Those three are measured against the ATTACKER, not against this reader: the euid unlink(2)
//     tests is the REMOVING process's, so who runs `prune-run` does not enter into it at all.
//     What closes the race is the vetting above, which forces the claim's uid to equal the
//     PREVIEW DIRECTORY's uid. Against a root-owned sticky temp root, another local user
//     attacking a claim is none of the three: not the file's owner (that is the preview's owner),
//     not the directory's owner (that is root), and not privileged. `sudo prune-run` changes
//     nothing here — the sudo'd reaper is not the removing process in this scenario, it is the
//     one being deceived — so citing root's CAP_FOWNER as a reason the race is closed had it
//     backwards: that capability is a way THROUGH the check, held by nobody the check must stop.
//
//     That reasoning is about POSIX sticky semantics, and the temp root is not sticky everywhere.
//     Linux is the case reasoned about above: the shared, world-writable `drwxrwxrwt`. macOS is
//     strictly STRONGER — `os.tmpdir()` there is the per-user `/var/folders/.../T`, `drwx------`
//     and not sticky at all, which no other unprivileged user can even traverse — so what holds
//     under sticky holds a fortiori under it.
//
//     Windows reaches the same place by a mechanism with no sticky bit in it, so state the
//     mechanism rather than the mode string. `os.tmpdir()` there is %TEMP%/%TMP%, which for an
//     interactive account is the per-user `C:\Users\<user>\AppData\Local\Temp` — in practice
//     the macOS case: private to one account. A service account with TEMP and TMP unset falls
//     back to `%SystemRoot%\Temp`, which IS shared, and that is the case worth spelling out:
//     deleting a file on NTFS requires DELETE on the file or FILE_DELETE_CHILD on the directory,
//     and the stock ACL there is SYSTEM/Administrators (OI)(CI)(F) with
//     `BUILTIN\Users:(CI)(S,WD,AD,X)` — container-inherit create and traverse, and NO
//     delete-child — while new files inherit CREATOR OWNER (F). So another unprivileged user can
//     plant a NEW name but cannot unlink the gate user's vetted claim: exactly the set sticky
//     reaches, by a different mechanism. What is NOT reached is the uid half, which is void on
//     that platform for the reason stated above.
//
//     Nothing in this suite asserts an NTFS ACL — its win32 leg exercises the code paths, not
//     the permission model — so nothing here will fail if those ACL claims are wrong; they are
//     held true by reading, not by a test. This is the fifth revision of this
//     paragraph — the first three overstated the guarantee, the fourth overstated the hazard by
//     reading "no sticky bit" as "no protection" — which is the reason it is written as a
//     mechanism that can be checked against `icacls %SystemRoot%\Temp` rather than as a verdict.
//
//     The limit for the POSIX cases, stated in the same breath: the argument rests entirely on
//     the parent being sticky (or otherwise not writable by the attacker). Point the preview root
//     at a plain world-writable directory with no sticky bit and the race reopens in full — any
//     local user may then unlink the vetted claim and re-plant at that name.
//
//     What is NOT closed: the directory-owner exception. If the PARENT directory itself — not
//     the vetted file — is owned by someone other than the claim's writer, that owner may still
//     unlink the vetted claim and re-plant a file at the same name between the lstat and the
//     read, despite owning neither the claim nor its preview. Reachable in principle:
//     `os.tmpdir()` honours `TMPDIR`, and scripts/merge-preview.mjs mkdtemps a preview wherever
//     that points, so an environment pointing it at a sticky directory owned by someone else
//     hands that owner exactly this window. Closed under this repository's deployed default of a
//     root-owned system temp directory, which is the only reason this is a comment and not a
//     blocking finding.
//
//     A second, narrower gap in the same spirit: sticky blocks another user's REMOVAL of a claim
//     that is still there, but not its RE-CREATION once the legitimate holder releases its own.
//     That window is LIVE, not hypothetical: `runCommandCheck` in scripts/gate-runner.mjs writes
//     claims. It takes a `previewDir`, and its `onSpawn` writes `previewClaimPath(previewDir,
//     pid)` synchronously with `{ encoding: 'utf8', flag: 'wx' }` for each pid it spawns, then
//     releases every claim it created in a `finally`. So there IS a releaser, and the instant
//     between its release and the next legitimate claim is one another local user may take at
//     that name. Two properties bound the exposure and neither closes it: a claim is held only
//     on the clean-merge path, since a conflicted phase gets `previewDir: null` and writes
//     nothing at all; and EEXIST is tolerated and never unlinked, so a claim that writer did not
//     create is never released by it.
//
//     Stated in the same breath, because the same writer bounds how wide that window is: this
//     function takes each preview's parent listing FRESH, inside the loop, for every preview it
//     examines. It used to memoise one listing per parent for the whole pass, which made a claim
//     written after that snapshot invisible for the remainder of it — including to previews the
//     pass had not reached yet, since in production every preview is a direct child of the temp
//     root and one readdir covered them all. That was unreachable while nothing wrote claims and
//     is reachable now, which is why the memo is gone. What remains is one readdir wide: a claim
//     written after THIS preview's own listing is still unseen for THIS preview, and for no later
//     one. Vetting and reading are no longer part of that width — they happen on a single
//     descriptor now, per `openHolderEntry`.
//
// `read`, `list`, `stat` and `probe` are injectable because several of the branches above cannot
// be staged end to end: EPERM needs a process owned by another user, EACCES needs a file this
// user cannot read, and a foreign-uid marker or claim needs a filesystem entry `write` alone
// cannot fabricate. The NON-REGULAR shapes are no longer in that list: a fifo used to be worse
// than unstageable, since a real one with no writer would park the staging test in open(2) for as
// long as the suite was allowed to run, and O_NONBLOCK is what makes it a test that can be
// written at all — so the fifo, directory and symlink cases are now staged for real, against the
// real bindings, rather than described through doubles. Exported for the same reason
// `isMissingPreviewRoot` is — each branch is on the destructive path and has to be pinned on its
// own.
// Open a candidate holder — a marker or a claim — so that VETTING IT AND READING IT ARE THE SAME
// OBJECT rather than the same path visited twice.
//
// `lstat` answers about a PATH. `readFile` resolves that path again, so between the two syscalls
// another local user may unlink the entry the `lstat` approved and put a different one at the
// name. Vetting a path and then reading a path therefore proves nothing about what was read.
//
// MEASURED, not reasoned. A swapper flipping the marker name between a regular file and a fifo
// with rename(2), against a reader calling this function in a loop for twenty seconds, with the
// preview directory absent so the uid half is waived:
//
//   marker read unvetted                        killed at the timeout, parked in open(2)
//   vetted by path, uid half enforced           returned, ~99k calls, never opened anything
//   vetted by path, uid half waived             killed at the timeout, parked in open(2)
//   vetted and read through one descriptor      returned, ~70k calls, three runs out of three
//
// The third row is the one that matters: by-path vetting is not a defence against a swap, it only
// narrows which entries are worth swapping in. `prune-run` parked there produces no plan and no
// verdict, and `process.exit()` cannot interrupt a libuv thread already inside a blocking open(2);
// only SIGINT recovers the shell.
//
//   - O_NOFOLLOW refuses a SYMLINK at the final component instead of following it.
//   - O_NONBLOCK means a FIFO cannot park this call: open(2) returns immediately rather than
//     waiting for a writer, which is the difference between a hung `prune-run` and a rejected
//     entry.
//   - `fstat` on the DESCRIPTOR, not `lstat` on the path, so `isFile()` and the uid describe the
//     object now held open — and the read below comes from that same descriptor. A swap after
//     this point renames the entry; it cannot reach through a descriptor that is already open.
//
// This function REFUSES rather than classifies. Every failure it can produce — O_NOFOLLOW's
// refusal of a symlink (ELOOP on Linux, EMLINK on macOS and the BSDs), EACCES, ENXIO, a
// descriptor limit — is handed to the caller as a throw, and the caller vets the path instead of
// reading the errno. That division is deliberate: an errno says why THIS process could not open
// the entry, never what the entry IS, and only the second question decides between ignoring a
// candidate and calling it unknown.
// The flag word for that open, or `null` when this platform's `fs.constants` does not carry both
// flags — which is the whole point of computing it in one place rather than inlining the OR.
//
// `fs.constants` is platform-conditional, which is checkable here and is checked: `O_SYMLINK` is
// `undefined` on Linux, so the object plainly does not carry every name on every platform. A
// missing name is `undefined`, and `undefined | undefined` is `0` — so an inlined OR of two
// absent flags does not fail, it silently opens with O_RDONLY alone: symlinks followed again,
// no non-blocking guarantee, and vetting that has gone blind without saying so.
//
// VERIFIED ON-PLATFORM, since the suite gained a win32 leg: O_NOFOLLOW is one of the names
// missing there, and the flag-word unit test asserts this returns null on that platform rather
// than assuming it. The guard never depended on the claim — it triggers on the constants
// actually present at runtime, wherever that happens to be — and its consequence is stated at
// the call site.
export function fusedHolderOpenFlags(c = fsConstants) {
  if (typeof c.O_NOFOLLOW !== 'number' || typeof c.O_NONBLOCK !== 'number') return null
  return c.O_RDONLY | c.O_NONBLOCK | c.O_NOFOLLOW
}

// The run's plan, read through the same descriptor discipline as a findings file, or null when
// there is none.
//
// THE THIRD DOOR of the class closed at the other two: `readState` opens by path,
// so a FIFO at `.fleetmates/<run>/plan.json` parks the open forever. Measured — `master` hangs on it
// too (SIGKILL at 15s, empty stdout), so the door is inherited rather than opened here; what IS
// new is the reach. The ambiguity check above reads the plan BEFORE the manifest is resolved, so a
// run with no manifest — which `master` answers in milliseconds without ever touching `plan.json`
// — now arrives at that open. An inherited door that this branch newly walks through is this
// branch's to close.
//
// The filename is spelled here rather than reached out of `scripts/state.mjs`, which owns the
// layout and keeps `statePath` private. That duplication is real and is why it is called out: if
// the two ever disagree, every fixture in this suite that runs `init-run` and then
// `collect-reviews` fails at once, because the plan those fixtures write is the plan this reads.
async function readRunPlan(root, runId) {
  const file = path.join(runDir(root, runId), 'plan.json')
  try {
    return JSON.parse(await readEntryText(file, nonBlockingReadFlags()))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// O_RDONLY|O_NONBLOCK, and deliberately WITHOUT O_NOFOLLOW, or null where this platform cannot
// spell it. The property this read needs is that it cannot park; refusing a link is a different
// property that came along for the ride when the plan borrowed the findings reader, and it made
// these two commands the only ones in the CLI that refuse a symlinked `.fleetmates/<run>/plan.json`.
// Measured across three trees: a symlinked plan read fine on `master` and at the fork point and
// failed here with ELOOP — one cell of "used to proceed, now refuses" that nothing asked for.
//
// Every other reader of that same file goes through `readState`, which follows the link. A
// hardening that only two of eleven commands apply is a trap for the next reader rather than a
// defence; if state files should refuse links, that belongs in `scripts/state.mjs` where every
// reader gets it. Parking is still impossible: O_NONBLOCK returns at once on a FIFO whether it was
// reached directly or through a link, and the `isFile` check below refuses it either way.
function nonBlockingReadFlags(c = fsConstants) {
  if (typeof c.O_RDONLY !== 'number' || typeof c.O_NONBLOCK !== 'number') return null
  return c.O_RDONLY | c.O_NONBLOCK
}

// A findings file read through a DESCRIPTOR that cannot park, or by path where this platform
// cannot express that. `readFile` on a path opens blocking, and a FIFO planted at
// `<phase>-<lens>.json` parks that open forever: measured on this branch, `collect-reviews` never
// returned — killed at 20s, empty stdout, no exit code. This is the easier of the two FIFO doors,
// with no permission precondition at all, because the reviews directory is where reviewers are
// told to write and this loop opens whatever it finds under the manifest's lens names. It is the
// one defect here that is not new: `git show master:scripts/cli.mjs` carries the same path-based
// `readFile` at this site, so this is a fix rather than a regression introduced beside it.
//
// `fusedHolderOpenFlags` is exactly the right word — O_RDONLY|O_NONBLOCK|O_NOFOLLOW — and this is
// the third caller of the rule it encodes. `stat` on the descriptor, not the path, so what is read
// is what was vetted; anything that is not a regular file is refused, and the caller records it as
// unreadable, which is the outcome a FIFO or a directory deserves and is never "no findings".
//
// A symlinked findings file is now refused rather than followed. That is a deliberate narrowing,
// and it is scoped to FINDINGS: nothing this project writes creates one, and the class this
// command distrusts is exactly the entries it did not create itself — files a reviewer was told to
// drop in a directory anyone can write. The run's own `plan.json` is not in that class, is read
// through `nonBlockingReadFlags`, and still follows a link as the rest of the CLI does.
//
// DOCUMENTATION DOES NOT FOLLOW CODE THAT MOVES OUT FROM UNDER IT. This block stayed where it was
// when the two readers were split, so for three commits it sat on `readRunPlan` and described that
// function as refusing symlinked findings files — false of the function it named, and leaving this
// one undocumented, while every claim in it stayed true of the code it was written for. Editing a
// comment gets scrutiny; relocating the code beneath one does not, and the second is the easier
// mistake to ship.
async function readFindingsFile(file) {
  return readEntryText(file, fusedHolderOpenFlags())
}

// The shared body: open with the caller's flag word, vet the DESCRIPTOR, read from that same
// descriptor. Which hazards are refused is the caller's choice of flags and nothing else.
async function readEntryText(file, flags) {
  // No such flag word on this platform: the historical path-based read, stated rather than hidden,
  // for the reason `livePreviewPaths` gives at its own fallback.
  if (flags === null) return readFile(file, 'utf8')
  const handle = await openFile(file, flags)
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      throw Object.assign(new Error(`${file} is not a regular file`), { code: 'ENOTREGULAR' })
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close().catch(() => {})
  }
}

// The flag word for emptying a results file in place, or `null` when this platform's
// `fs.constants` does not carry BOTH names — the same shape, and the same two reasons, as
// `fusedHolderOpenFlags` above: a missing name is `undefined`, `O_WRONLY | undefined` is
// `O_WRONLY`, and an inlined OR would quietly open through a symlink while looking like it
// refused one. The caller treats `null` as "cannot empty safely" and refuses, rather than
// emptying blind.
//
// O_NONBLOCK IS NOT OPTIONAL HERE, and leaving it out is how this function first shipped — citing
// the precedent above while dropping the flag that precedent exists for, whose own header calls it
// "the difference between a hung `prune-run` and a rejected entry". Measured on this branch: with
// a FIFO at the results path and the `0555` directory this fallback is reached through,
// `collect-reviews` never returned — killed at 20s with an empty stdout and no exit code, where
// the same fixture with a regular file answers 4 in milliseconds. Isolated to the one flag:
// `O_WRONLY|O_NOFOLLOW` on a FIFO stayed blocked past 5s, and adding O_NONBLOCK returns ENXIO at
// once, which the caller already reports as a reason it could not empty the file.
//
// A FIFO is the only shape that parks the call: a directory and a socket refuse promptly, and
// O_NOFOLLOW refuses a symlink to a device node before it can open one.
export function emptyResultsOpenFlags(c = fsConstants) {
  if (typeof c.O_NOFOLLOW !== 'number' || typeof c.O_NONBLOCK !== 'number') return null
  return c.O_WRONLY | c.O_NONBLOCK | c.O_NOFOLLOW
}

async function openHolderEntry(p) {
  const handle = await openFile(p, fusedHolderOpenFlags())
  try {
    return {
      info: await handle.stat(),
      read: () => handle.readFile('utf8'),
      close: () => handle.close().catch(() => {}),
    }
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

export async function livePreviewPaths(previewPaths, {
  // Injected only by the tests below, and injecting it changes WHICH implementation vets a
  // candidate, which is the one thing about this seam a reader has to know. A double cannot hand
  // out a file descriptor, so supplying `read` selects a two-syscall stand-in — `stat` by path,
  // then `read` by path — that reproduces the caller's ignored/missing/unknown bookkeeping
  // faithfully and reproduces the ATOMICITY not at all. The fused `openHolderEntry` above is what
  // production uses, and it is covered by the real-filesystem tests that inject nothing.
  read = null,
  list = (dir) => readdir(dir),
  // lstat, not a symlink-following stat — see the vetting section above for why. `lstat` is
  // already imported for `unlinkPreviewLinks`, under a name distinct from this parameter, so
  // there is no `stat = (p) => stat(p)` self-reference to fall into here. This one is a genuine
  // path question — "who owns the preview directory" — with no read attached, so it stays an
  // lstat by path.
  stat = (p) => lstat(p),
  // Signal 0 sends nothing: it only asks whether the pid can be signalled at all.
  probe = (pid) => process.kill(pid, 0),
} = {}) {
  // Three implementations, and which one is in play is the one thing a reader has to know.
  //
  //   - The fused open, which is production on any platform whose `fs.constants` carries both
  //     flags.
  //   - By path — `lstat`, then `readFile` — on a platform whose constants do not, because the
  //     alternative is refusing to open anything there and never reaping a preview at all. That
  //     loses the atomicity, which that platform cannot offer in the first place, and keeps the
  //     behaviour the fork point had. This is the branch win32 takes: it has no O_NOFOLLOW, so
  //     every preview-reaping test in the suite's win32 leg runs through here, not the fused open.
  //   - The stand-in a test selects by injecting `read`, which is by path for the same reason a
  //     double cannot hand out a file descriptor. It reproduces the bookkeeping below faithfully
  //     and the atomicity not at all, so anything about OPEN FAILURE has to be pinned against the
  //     fused default with nothing injected.
  const byPathHolder = async (p) => ({ info: await stat(p), read: () => readFile(p, 'utf8'), close: () => {} })
  const openHolder = read !== null
    ? async (p) => ({ info: await stat(p), read: () => read(p), close: () => {} })
    : (fusedHolderOpenFlags() === null ? byPathHolder : openHolderEntry)

  // ONE candidate entry — a marker or a claim — resolved to exactly one of four answers. Naming
  // them is the point: IGNORED and UNKNOWN are the two the rest of this function must never
  // conflate, because a candidate that fails vetting contributes nothing at all while one that
  // cannot be read contributes `unknown`, and `unknown` means live.
  // AN ENTRY THAT COULD NOT BE OPENED IS STILL VETTED, on the path, with the SAME predicate.
  //
  // Fusing the vetting into the open put the vetting behind something an attacker controls: an
  // entry this process cannot open is an entry it never vetted, and calling that `unknown` makes
  // it live. Measured against the fork point, two entries any local user can plant in a 1777 temp
  // root went from ignored to live that way — a unix socket at a claim name, which open(2) refuses
  // with ENXIO, and a claim-named regular file chmod 000, which it refuses with EACCES. Either one
  // makes a preview unreapable forever, which is precisely the denial-of-cleanup the vetting
  // exists to prevent, reached through the adjacent door.
  //
  // Mapping those errnos to `ignored` instead would be worse than the hole. This process's OWN
  // marker, mode 000, is also EACCES — a legitimate holder's record that cannot be read — and
  // ignoring it would reap a preview whose owner is alive. The errno cannot decide this; only the
  // predicate can. So: fall back to `lstat`, which succeeds on entries that cannot be opened, and
  // ask the same question.
  //
  //   predicate REJECTS                  -> ignored   (wrong type or wrong owner, as before)
  //   predicate ACCEPTS, open failed      -> unknown   (a real holder we cannot read; stay live)
  //   the lstat is ENOENT                 -> missing
  //   the lstat fails any other way       -> unknown
  //
  // The fallback READS NOTHING, so it reopens no race: a successful open is still vetted on the
  // descriptor, and this path only decides between ignoring an entry and admitting it is
  // unreadable. There is no ELOOP or EMLINK arm any more, and none is wanted — a symlink lands
  // here, its `lstat` says it is not a regular file, and it is ignored by the same rule as
  // everything else rather than by a second one that could drift from it.
  const vetWithoutOpening = async (p, accept) => {
    let info
    try {
      info = await stat(p)
    } catch (err) {
      return err?.code === 'ENOENT' ? 'missing' : 'unknown'
    }
    return accept(info) ? 'unknown' : 'ignored'
  }

  const holderAt = async (p, accept) => {
    let handle
    try {
      handle = await openHolder(p)
    } catch (err) {
      // ENOENT is the one answer that positively means "not there".
      if (err?.code === 'ENOENT') return 'missing'
      return vetWithoutOpening(p, accept)
    }
    try {
      if (!accept(handle.info)) return 'ignored'
      return { text: await handle.read() }
    } catch (err) {
      // Released between the open and the read: ENOENT means what it says. Anything else — EACCES,
      // EBUSY, EIO — leaves this holder unknown.
      return err?.code === 'ENOENT' ? 'missing' : 'unknown'
    } finally {
      await handle.close()
    }
  }

  const live = new Set()

  for (const dir of previewPaths) {
    // Every holder's marker contents, and whether anything about them is UNKNOWN. The rule the
    // whole reaper rests on is unchanged and now applies to both kinds: only ENOENT and ESRCH —
    // the two answers that positively mean "no owner" — let a preview through.
    const holders = []
    let unknown = false
    // ONE owner uid per preview, resolved before anything under this prefix is trusted, and used
    // to vet the marker and every candidate claim alike. Who a candidate has to be owned by: see
    // the vetting section above this function.
    let ownerUid
    // Distinguished from `ownerUid === undefined`, which an `lstat` that failed for some OTHER
    // reason also produces. Only the ENOENT case means the referent is absent rather than
    // unreadable, and only that case relaxes anything below.
    let ownerGone = false
    try {
      ownerUid = (await stat(dir)).uid
    } catch (err) {
      // The preview directory is gone (ENOENT). Every CLAIM below is then UNVERIFIABLE rather
      // than unknown — it falls through the uid comparison and is ignored, exactly like a
      // foreign-owned one. That is the behaviour on the base branch, it is not changed here, and
      // it is deliberately left alone. Anything else leaves the whole preview unknown, same as an
      // unreadable marker.
      if (err?.code === 'ENOENT') ownerGone = true
      else unknown = true
    }
    // THE MARKER IS VETTED THE SAME WAY A CLAIM IS. It was not, and the asymmetry had teeth: any
    // local user who can see this prefix can plant an entry at the marker's exact path, which is
    // derived from the preview directory name and nothing secret.
    //
    // A FIFO there makes `read` block forever, and `process.exit()` cannot interrupt it because
    // the libuv thread is parked in open(2), so only SIGINT recovers the shell. That is a PRIOR
    // reproduction, recorded in docs/followups/2026-08-27-purge-open-findings.md, NOT a
    // measurement taken here: staging a fifo whose read never returns would hang the suite that
    // staged it, which is why `read` and `stat` are injectable and why the tests pin this branch
    // through the doubles instead.
    //
    // One detail of that write-up does not survive checking, and is corrected rather than
    // repeated: the await does NOT precede every print. `prune-run` announces its command checks
    // and runs the phases before it reaches `livePreviewPaths(previewCandidates)`. What is true
    // is that the await precedes the prune plan and every removal, so a marker read that never
    // returns strands the command after that announcement with no plan, no verdict and nothing
    // removed.
    //
    // A junk file, a symlink or a directory makes the preview unreapable forever, because a
    // marker that cannot be read is `unknown` and `unknown` means live.
    //
    // A candidate that fails vetting is IGNORED, not `unknown` — the same distinction the claim
    // path makes, and for the same reason: a forged entry must not be able to force `live` in
    // either direction merely by existing. Only a marker that is a regular file owned by the
    // preview directory's own uid is read at all.
    //
    // NOT ON THE SAME FOOTING AS CLAIMS, and the difference is worth stating rather than
    // implying. Ignoring an unverifiable CLAIM is pre-existing behaviour, unchanged here. Vetting
    // the MARKER is a change this branch makes, so its edge cases are this branch's to answer,
    // and one of them bites: when `stat(dir)` answers ENOENT there is no uid to compare against,
    // and a strict `markerInfo.uid === ownerUid` is then false for EVERY marker — including a
    // regular file, owned by the right user, positively naming a LIVE pid. Vetting turned into
    // reaping a preview whose owner was demonstrably alive, which contradicts the rule the rest of
    // this function restates three times: only ENOENT and ESRCH may let a preview through.
    //
    // `ownerGone` skips the UID half in that one case, and only that one. The reasoning, since
    // the alternative is defensible and was rejected on a concrete consequence rather than on
    // taste: treating a missing preview directory as UNKNOWN would also honour the rule, but
    // `unknown` means live, so a registration whose directory is already gone could never be
    // reaped again — and that state is reachable by the very path documented above, where
    // merge-preview.mjs's `removeWorktree(...).catch(() => {})` swallows a failure and the
    // following `rm` deletes the directory anyway. Making it permanent would disable exactly the
    // cleanup this command exists to perform. So: with no directory there is no tree and no
    // junctions to follow, nothing the uid comparison protects and no referent for it to compare
    // against, and the marker is read on `isFile()` alone.
    //
    // The REGULAR-FILE half is NOT relaxed with it, and that is the half that matters here: a
    // planted fifo or junction needs no preview directory to exist. The invariants hold either
    // way — a marker that fails `isFile()` is still IGNORED, and one that cannot be READ for any
    // reason but ENOENT is still UNKNOWN.
    //
    // An earlier version of this paragraph said that half was what kept a fifo out of open(2).
    // That was false while the vetting was an `lstat` BY PATH: a regular file approved by the
    // lstat could be swapped for a fifo before the read resolved the name again, which was
    // measured and is tabulated above `openHolderEntry`. It is true now, and it is true because
    // that function opens once with O_NONBLOCK and fstats the descriptor it holds — the
    // `isFile()` here is asked of an object, not of a name. Waiving the uid half is safe only
    // because of that; on the by-path shape this waiver was itself the hazard.
    //
    // Measured by driving this function's doubles with `stat(dir)` answering ENOENT, against the
    // base branch and against both revisions of this one. Marker a regular file naming a live
    // pid: live before the vetting landed, NOT live with the strict comparison, live again now —
    // so this restores the base answer rather than inventing a third. Marker not a regular file:
    // live on the base branch, not live here — the one place this is deliberately stricter than
    // what it replaced.
    //
    // PRE-EXISTING, not introduced by the claim work. `git log -S` on the unvetted read puts it
    // in e6e1a6e, the commit that introduced the marker; the claim work is 4797c98, eighteen days
    // later. The window is not theoretical either: merge-preview.mjs releases the marker LAST in
    // its `finally`, and its `removeWorktree(dir).catch(() => {})` swallows a rejection while the
    // marker's own `rm` sits in an outer `finally` that always runs — so a removal that fails
    // leaves a still-REGISTERED preview whose marker is already gone and whose marker path, in a
    // temp root that outlives it, is free for anyone to plant at.
    // `missing` is the only "no marker": a preview from before markers existed, or one whose owner
    // has already released it. `ignored` is a marker that failed vetting and contributes nothing.
    // `unknown` leaves the owner unresolved, which means live.
    //
    // `ownerGone` waives the UID half HERE AND NOWHERE ELSE — see the argument above, and the
    // claim predicate below, which deliberately does not carry it.
    const marker = await holderAt(
      previewOwnerMarkerPath(dir),
      (info) => info.isFile() && (ownerGone || info.uid === ownerUid),
    )
    if (marker === 'unknown') unknown = true
    else if (typeof marker !== 'string') holders.push(marker.text)
    const parent = path.dirname(dir)
    // ONE LISTING PER PREVIEW, not one per sweep. The memo that used to stand here took each
    // parent directory's listing once and reused it for every candidate underneath, so a claim
    // written after that snapshot was invisible for the remainder of the pass — including to
    // previews the pass had not reached yet. In production every preview is a direct child of the
    // temp root, so that was a single readdir of the temp directory covering every preview in the
    // run.
    //
    // It was unreachable while nothing wrote claims. `runCommandCheck` in scripts/gate-runner.mjs
    // writes one per spawned pid, so it is reachable now, and it fails in the destructive
    // direction: listing taken, gate spawns a check and writes its claim, gate is SIGKILLed so its
    // `finally` never releases anything, the loop reaches that preview, the marker probes ESRCH,
    // the cached listing shows no claim — and `git worktree remove --force` follows the preview's
    // junctions into the repository's real node_modules with the child still writing to that tree.
    //
    // The cost is one readdir per preview instead of one per sweep. A sweep examines the previews
    // in one temp directory, so that is a small multiple of a cheap syscall against an
    // irreversible removal. The window does not close — a claim written after THIS preview's
    // listing is still unseen for it, and the readdir-to-open note above still applies — it
    // narrows from one sweep wide to one readdir wide.
    //
    // `null` records a listing that FAILED, which is not the same as an empty one.
    let names
    try { names = await list(parent) } catch { names = null }
    if (names === null) {
      // The directory could not be listed, so whether a claim exists is unknown, so the preview
      // is live. An unreaped preview costs a directory; a followed junction costs the
      // repository's build inputs.
      unknown = true
    } else {
      const prefix = previewClaimPrefix(dir)
      const claimNames = names.filter((name) => name.startsWith(prefix))
      if (claimNames.length > 0) {
        // A claim SHARES THE MARKER'S SHAPE EXACTLY — a sibling entry under a prefix any local
        // user can guess, vetted and then read — so it goes through the same `holderAt`, with the
        // same fused open and the same vet-the-path-when-the-open-failed fallback, for the same
        // reasons. The claim side is where that fallback was measured: a socket and a mode-000
        // file, both planted at claim names, were the two entries that went from ignored to live
        // without it.
        //
        // `ownerUid` was resolved once at the top of this iteration, so the value that vetted the
        // marker vets every claim here and the two cannot disagree about who owns this preview.
        //
        // The predicate differs from the marker's in ONE term, and the omission is the whole
        // point: `ownerGone` is NOT here. With the preview directory missing, `ownerUid` is
        // `undefined`, no claim's uid can equal it, and every claim is IGNORED. That is the
        // behaviour on the base branch, and it is what stops a claim any local user planted at a
        // free name — which is what the prefix becomes once the directory is gone — from naming a
        // live pid and forcing `live` on a preview nothing could then ever reap. The marker can
        // afford the waiver because there is exactly one marker path per preview and it is the
        // owner's own record; the claim prefix admits unboundedly many entries.
        for (const name of claimNames) {
          const claim = await holderAt(
            path.join(parent, name),
            (info) => info.isFile() && info.uid === ownerUid,
          )
          if (claim === 'unknown') unknown = true
          else if (typeof claim !== 'string') holders.push(claim.text)
        }
      }
    }
    if (unknown) { live.add(dir); continue }
    for (const raw of holders) {
      const pid = Number.parseInt(String(raw).trim(), 10)
      if (!Number.isInteger(pid) || pid <= 0) { live.add(dir); break }
      try {
        probe(pid)
        live.add(dir)
        break
      } catch (err) {
        if (err?.code !== 'ESRCH') { live.add(dir); break }
      }
    }
  }
  return live
}

// "The preview root is not there at all", told apart from every other sweep failure.
//
// It is a state that really occurs: scripts/merge-preview.mjs removes the directory after
// `git.removeWorktree(dir).catch(() => {})`, so a removal that failed leaves the worktree
// registered with its directory gone, and a temp cleaner produces the same state unaided.
// `git worktree list --porcelain` still reports that path, so it still enters `plan.previews`,
// and the sweep's `readdir` then throws ENOENT. Treated as a failed sweep, that deadlocks:
// `prune-run --yes` exits 1 on every subsequent run and the stale registration — which
// `git worktree remove --force` clears happily, missing directory and all — can never be
// cleared. The printed reason would be false as well: a directory that is not there holds no
// links to sweep, so nothing is being left in place to protect a link target.
//
// Narrow on purpose, and BOTH clauses carry weight — each is on the destructive path, because a
// `true` here skips the `continue` and lets `git worktree remove --force` run with the preview's
// junctions still in place, which deletes the CONTENTS of their targets:
//
//   - only ENOENT. An EACCES, EPERM or EBUSY `readdir` on the preview root is a directory that IS
//     there and could not be read, so its links are unaccounted for and it must block.
//   - only on the ROOT the sweep was asked to walk. An ENOENT deeper in the tree is a directory
//     disappearing mid-sweep — exactly the concurrent mutation a worktree must not be removed on
//     top of — and it says nothing about whether the root's own links were swept.
//
// Exported so each clause can be pinned on its own. The end-to-end tests can only construct a
// sweep failure that trips one clause at a time by accident (the depth guard's plain Error has no
// `.path`; an ENOENT deep in the tree is a race no test can stage deterministically), so deleting
// either clause left the whole suite green — a test passing for the wrong reason.
export function isMissingPreviewRoot(err, dir) {
  return Boolean(err)
    && err.code === 'ENOENT'
    && typeof err.path === 'string'
    && path.resolve(err.path) === path.resolve(dir)
}

// The task branches of a phase, resolved to the shas they stand at right now. This is what a
// review stamp names: findings describe a diff, and a diff is only identified by its tips.
function tasksOfPhase(plan, phaseName) {
  // `--phase` names the MANIFEST key, as it does for `gate`. When it is also a plan phase number
  // the branches narrow to that phase; when it is not, every task branch of the run is in scope,
  // which is the honest reading of "this manifest phase's diff".
  const phaseNumber = Number(phaseName)
  // `tasks` is whatever the plan file holds, and `?? []` only covers the one shape where it is
  // absent: a `tasks` of `7` or `{}` reached `.filter` and threw, exiting 1 with an empty stdout on
  // `master`, on the fork point and here alike. Narrowed to the shape this function can actually
  // walk — the same treatment `ambiguousPhaseRefusal` gives the same field — so a malformed plan
  // is a run with no task branches, which every caller already reports.
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []
  return Number.isInteger(phaseNumber)
    ? tasks.filter((t) => t?.phase === phaseNumber)
    : tasks
}

// The component of the run's reviews path that is a symlink, or null when every one of them that
// exists is a real entry. `lstat` reports only the FINAL component of a path, so asking it about
// the reviews directory alone answers nothing about the directories above it: with
// `.fleetmates/<run>` planted as a link to a directory the caller chose, `lstat(dir)` is a plain
// directory, `mkdir` recursive builds `reviews/` inside the link's target, and every path built
// from `dir` resolves through it — measured on this branch, the command exited 0 printing an
// in-repo path while the bytes landed at `<root>/outside-the-run/reviews/results-1.json`.
//
// EVERY component from `root` down, accumulated over `path.relative`, and NOT a fixed list. A
// fixed list of three — `<root>/.fleetmates`, the run directory, `reviews` — is right only for a
// single-segment run id, because `path.dirname` climbs exactly one level. Run ids nest by design
// (`scripts/state.mjs` names `--run 2026/substop`, and `idRefusal` caps bytes rather than depth),
// and at depth two `<root>/.fleetmates` itself went unchecked. Measured on this branch, through a
// real `init-run`: with `--run a/b` and `.fleetmates` symlinked out, the command exited 0 printing
// `.fleetmates/a/b/reviews/results-default.json` while the bytes landed under the planted target;
// with `--run 2026/substop` the same plant put the clear inside a victim tree; and at `--run
// a/b/c` a plant at `.fleetmates/a` did the same. The control that settles it: the identical plant
// with a FLAT run id was refused by the fixed list. The rule was right and its reach was wrong.
//
// Top down, so the refusal names the OUTERMOST planted component — the one an operator has to go
// and look at. A component that does not exist yet is nothing to plant through: whatever creates
// it creates a real directory, since its parent has just been vetted.
//
// A `dir` that is not under `root` is refused rather than walked. `assertContained` makes that
// unreachable through the CLI today, which is exactly why it would sit unpinned: without it, the
// accumulation would climb ABOVE the root this function promises never to look above, one `lstat`
// per `..`. Exported for that reason — it is the only way to reach that arm, and the depth cases
// above are cheaper to state here than to stage end to end.
//
// The depth property is pinned by COUNTING rather than by planting, and the difference matters: a
// fixture plants at one depth, so it can only ever rule out climbs shorter than itself. A fixed
// climb of twelve passed every fixture in this project's test file when that was all there was —
// it now reddens the two counting tests, one of which exists because of that measurement. What is
// asserted is that the number of components examined equals the number of components in the path,
// at a range of depths, which no fixed climb satisfies at more than one of them.
//
// Deliberately the same three clauses `assertContained` uses, spelled the same way, because it is
// the same question about the same kind of value. Worth knowing when changing either: they are
// byte-identical, so a search-and-replace across this file hits the other one first — which is
// exactly what a mutation run here did, silently mutating `assertContained` and leaving this
// function's test green.
//
// Nothing AT OR ABOVE `root` is checked, `root` included. That is the same assumption every other
// path in this CLI makes: the operator names the root, and a link on the way to it is theirs.
//
// A CHECK, NOT A LOCK, and narrower than it looks. It is not atomic, and no Node API makes it so:
// there is no way to write relative to an opened directory descriptor here, so a link planted
// between the last check and the `rename` is still a window, and so is one planted between this
// check and the descriptor the clear opens.
//
// It sees LINKS only, and a BIND MOUNT is not a link. Staged in this worktree under `unshare -Urm`
// and confirmed: `mount --bind` over the reviews directory left `lstat` reporting
// `isSymbolicLink=false isDirectory=true`, this function answered null, and the write landed in
// the victim tree. `realpath` does not help either — a bind mount resolves to the path it is
// mounted at, not to its source — so closing this would mean reading `/proc/self/mountinfo`, which
// exists on one platform of the three this suite targets. Left open, pinned by the test that
// stages it, and stated as the boundary of what this walk promises.
//
// An earlier version of this paragraph said staging one "needs a privilege this worktree does not
// have". That was asserted, not attempted: `unshare -Urm` returns 0 here. The rule that produced
// the error is worth more than the correction — an environment wall is a measurement like any
// other, and claiming one without running the command is the same defect as any other unbacked
// claim.
//
// What it closes is every stationary symlink, and it is re-run immediately before the write so
// that window is a few syscalls rather than a whole collection.
// `deps.lstat` is a TEST SEAM and nothing else — every production caller passes two arguments.
// It exists because the property this function is FOR cannot be pinned by a fixture: "every
// component, however deep" is a claim about all depths, and a test can only plant at one. Planting
// one level deeper than the last guess is what the fixtures below used to do, and it proves only
// that the walk beats THAT climb — a fixed climb of twelve passed the entire suite. Counting the
// components examined turns the claim into an equality that holds at every depth at once.
export async function plantedReviewsLink(root, dir, deps = {}) {
  const statLink = deps.lstat ?? lstat
  const rel = path.relative(root, dir)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${printable(dir)} is not inside ${printable(root)}, so its components cannot be vetted`)
  }
  let component = root
  for (const segment of rel.split(path.sep)) {
    component = path.join(component, segment)
    let info = null
    try {
      info = await statLink(component)
    } catch (err) {
      // ENOENT is a component that is not there yet; anything else is a component this process
      // cannot see, and refusing to guess about it is the whole job. Swallowing these instead
      // leaves the suite green, and a reviewer measured why: with a regular file at
      // `.fleetmates/<run>`, the throw refuses with `cannot vet the run's reviews directory …
      // ENOTDIR` and swallowing refuses with `could not clear the previous results file … unlink
      // failed (ENOTDIR)` — a different sentence, the same exit, nothing removed either way. No
      // wrong RESULT is reachable through this arm, because every operation that follows it acts
      // on the same path and fails the same way. It is kept for the sentence, which names the
      // component, and it is stated here as unpinned rather than left to look pinned.
      if (err.code !== 'ENOENT') throw err
    }
    if (info?.isSymbolicLink()) return component
  }
  return null
}

// Whether an omitted `--phase` is ambiguous for this run, and the refusal to print when it is.
// Returns null when the flag was given, when the plan cannot be read, or when the plan has at most
// one phase; a string otherwise.
//
// `--phase` defaults to the manifest key `default`, and `tasksOfPhase` reads a non-integer name as
// EVERY task branch of the run — the honest reading of "this manifest phase's diff" when the
// manifest has one phase, and a silent widening when the plan has several: a phase-3 review then
// judges phase 1 and 2 branches that were integrated rounds ago. Refused rather than warned,
// because the widening produces a review that reads as complete.
// A single-phase plan is unaffected: there is nothing for the flag to disambiguate.
//
// Reading the plan may fail — a run with no `plan.json` — and that falls through to the old
// behaviour rather than becoming a second refusal: what the caller omitted is unambiguous exactly
// when nothing says otherwise, and both commands already have their own say about a missing plan.
//
// The phases come from `plan.tasks[].phase`, the same field `tasksOfPhase` filters on, so the set
// named is the set the flag chooses between. Non-integers are COUNTED but not named: `tasksOfPhase`
// compares `t.phase === phaseNumber` against an integer, so a phase that is not one is not
// selectable, yet the omitted flag still reviews its branch — and naming only integers is what keeps
// this sentence free of any byte a hand-edited `plan.json` chose.
async function ambiguousPhaseRefusal(root, runId, flags, command) {
  if (flags.phase !== undefined && flags.phase !== true) return null
  // CANNOT BE READ means exactly that, and `readState` answers null only for ENOENT — it rethrows
  // a parse error, a mode-000 file, a directory at that path. The comment above promised a
  // fall-through and delivered a crash: measured on this branch, a `plan.json` of `not json at
  // all` with no manifest present exited 1 with an unhandled SyntaxError and an EMPTY stdout,
  // where the fork point printed `no gate manifest` and exited 4. Exit 1 is not a code these
  // commands otherwise return, and a refusal that prints nothing is the one shape this command's
  // whole design refuses to produce.
  //
  // Swallowed rather than reported because of what this function IS: it decides whether an omitted
  // flag is ambiguous, and an unreadable plan cannot say that it is. Every caller reads the plan
  // again downstream and has its own answer for a plan it cannot use.
  let plan = null
  try {
    plan = await readRunPlan(root, runId)
  } catch {
    return null
  }
  if (!plan) return null
  // THE TRAVERSAL IS PART OF THE READ, and guarding only the read left this crashing on a plan it
  // had just successfully parsed. `{"tasks":[null]}` reached `t.phase` on null and `{"tasks":"abc"}`
  // reached `.map` on a string: both exited 1 with an EMPTY stdout, where `master` and the fork
  // point printed a 70-byte refusal and exited 4 — the two properties the comment above condemns,
  // reintroduced two lines below it. A plan is agent-written, so `tasks` is whatever is in the
  // file, and neither `??` nor a property access says otherwise.
  //
  // `{"tasks":{…}}` and `{"tasks":7}` still crash further downstream, in `tasksOfPhase`, and that
  // is fixed there rather than worked around here.
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : []
  // EVERY DISTINCT VALUE COUNTS, integer or not. Counting integers only left `1` beside `"2"` one
  // countable phase, so nothing was refused and the omitted flag reviewed both branches under one
  // `default` stamp. Only the integers are NAMED: a phase `--phase` cannot select is reported as a
  // count, which keeps every byte of this sentence one the CLI wrote.
  const distinct = [...new Set(tasks.map((t) => t?.phase))]
  if (distinct.length < 2) return null
  const integers = distinct.filter((p) => Number.isInteger(p)).sort((a, b) => a - b)
  const others = distinct.length - integers.length
  const unselectable = others === 0 ? '' : `${others} non-integer phase${others === 1 ? '' : 's'} no --phase can select`
  const named = [integers.join(', '), unselectable].filter(Boolean).join(', plus ')
  return `${command} needs --phase: the plan for this run has ${distinct.length} phases (${named}), `
    + 'and an omitted --phase reviews every task branch of the run — including branches integrated in earlier phases'
}

async function resolveBranchShas(git, tasks, runId) {
  const branchShas = {}
  for (const task of tasks) {
    const branch = resolveTaskBranch(task, runId)
    // Through refs/heads/, so a tag named like a branch cannot stand in for one — the same
    // resolution rule deriveContext uses for the anchor.
    if (branch && await git.branchExists(branch)) branchShas[branch] = await git.resolveRef(`refs/heads/${branch}`)
  }
  return branchShas
}

// `deps.git` is a TEST SEAM and nothing else — every production caller passes three arguments and
// gets a git built here. It exists because the round-trip refusal below could not otherwise be
// pinned at its CALL SITE: with the run branch resolved from HEAD's own ref, the two shas can
// disagree only if the branch moves between two subprocesses, which no in-process fixture can
// stage, so `if (disagreement) throw` could be deleted with the whole suite green. The helper's
// arms were pinned as a pure function; the wiring was not. Injecting git is the smallest seam that
// covers both, and it is exported for the same reason.
export async function derive(root, runId, flags, deps = {}) {
  const git = deps.git ?? createGit({ cwd: root })
  // THE REF, NOT THE NAME, is what everything destructive downstream is given. `currentBranchRef`
  // is `git symbolic-ref --quiet HEAD` (scripts/git.mjs), so this is the ref HEAD literally points
  // at, never a name abbreviated toward it: no tag, no `heads/<name>` branch and no
  // `refs/heads/refs/heads/<name>` changes what it resolves. `runBranch` below is derived FROM it
  // for display and for the ordinary name comparisons, and `ctx.runBranchRef` is what
  // `prune-run` resolves at the `git branch -D`.
  // THE SHARED CLASSIFIER, not a conditional of this function's own. `headBranch` is the single
  // place that decides what HEAD has to be (scripts/git.mjs); every other run-branch consumer asks
  // the same question through the same call, which is what keeps them from drifting apart the way
  // they did for three rounds. What is local to `derive` is only the CONSEQUENCE: a throw, because
  // everything downstream of here verifies or removes something.
  const head = await git.headBranch()
  if (!head.ok) {
    throw new Error(
      `${head.reason}${head.kind === 'detached' ? ` (HEAD is ${await git.headSha()})` : ''}.`
      + ' Check out the run branch and re-run. Nothing is verified or removed against a HEAD that'
      + ' does not name a branch: the name such a state yields is either invented or the whole ref'
      + ' string, and prefixing refs/heads/ onto either lands on a ref anyone with a worktree can'
      + ' create and point at a commit of their choosing.',
    )
  }
  const runBranchRef = head.ref
  const runBranch = head.name
  // The two-subprocess race, and ONLY that. `headSha` and `resolveRef` are separate git
  // invocations, so a commit or merge landing on the run branch between them shows up here as a
  // disagreement; that is an honest race and the message says so.
  //
  // It is NOT what closes the repointed-HEAD hazard, and an earlier revision of this comment
  // claimed it was. `refs/heads/${runBranch}` is rebuilt from a name that was itself taken off
  // `head.ref`, so it reconstructs that ref character for character — the comparison cannot
  // disagree about WHICH ref is the run branch, only about what that one ref held a moment
  // earlier. The guard above is the whole of that closure. Reverting this to resolve `head.ref`
  // directly changes nothing measurable, which is exactly why it must not be described as
  // defence.
  const headSha = await git.headSha()
  const namedSha = await git.resolveRef(`refs/heads/${runBranch}`).catch(() => null)
  const disagreement = runBranchDisagreement({ resolvedRef: `refs/heads/${runBranch}`, headSha, namedSha })
  if (disagreement) throw new Error(disagreement)
  const baseBranch = await resolveBaseBranch(git, flags.base)
  // Every other failure path here fails closed; a plain operator mistake — running the
  // gate while checked out on the base branch itself — must not be the one that fails
  // open. merge-base(X, X) is X's own tip, so every diff and commit range this computes
  // is vacuous and both checks pass trivially with nothing actually verified. This is a
  // name comparison, not a state comparison: it must fire even on a truly fresh run,
  // where the run branch (a distinct branch) has no commits past the base yet — that
  // state is legitimate and is not what this guards against.
  if (runBranch === baseBranch) {
    throw new Error(
      `the run branch and the base branch are both '${runBranch}'. The run branch is derived from `
      + 'HEAD, so these agree in two situations and they want opposite answers. If you are on the '
      + 'BASE by mistake, check out the run branch and re-run. If the run is already INTEGRATED — '
      + 'its branch merged, and possibly deleted — then there is no run branch left to derive and '
      + 'no phase left to recompute: nothing here can decide what is prunable, and the run\'s '
      + 'scaffolding has to be removed by hand. Prove each ref is redundant first with '
      + '`git cherry <base> <ref>` (no line starting with + means every commit is already in the '
      + 'base by patch-id, which survives a history rewrite), and delete with '
      + '`git update-ref -d <ref> <proved sha>` so a concurrent write is not deleted unproved.',
    )
  }
  try {
    // `runBranchRef` rides along so the destructive path never has to rebuild `refs/heads/` from
    // a name. `deriveContext` is given the name, as it always was — by this point the name came
    // off `symbolic-ref` and the round trip above has been checked, so the two agree.
    return { ...await deriveContext({ git, runId, runBranch, baseBranch, planPath: flags.plan }), runBranchRef }
  } catch (err) {
    // deriveContext reads the plan via `git show <anchorSha>:<planPath>`, which fails with
    // raw git stderr ("fatal: bad revision ..."). That is often an adopting project's
    // first interaction with enforcement, so it must name the anchor and say what to check
    // rather than surface git's own diagnostic.
    if (err instanceof GitError && flags.plan && err.message.includes(`:${flags.plan}`)) {
      let anchorSha = 'unknown'
      try {
        const baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
        const runSha = await git.resolveRef(runBranchRef)
        anchorSha = await git.mergeBase(baseSha, runSha)
      } catch { /* best-effort context for the message only */ }
      throw new Error(
        `plan not found at anchor ${anchorSha}: ${flags.plan} — check --plan and confirm the plan is committed on ${baseBranch}`,
      )
    }
    throw err
  }
}

// The run-branch round-trip decision, as a pure function of three values: null when the ref holds
// the commit HEAD is on, and the operator-facing refusal otherwise.
//
// `resolvedRef` is the ref the CALLER resolved — `refs/heads/<run branch>`, the same string
// `deriveContext` builds — and not HEAD's own symbolic target. Those are the same ref in every
// honest run, and a revision that compared HEAD's sha against HEAD's own target instead was
// trivially true and vetted nothing; the parameter is named for what it must be so that mistake
// cannot be re-made silently.
//
// SEPARATED FROM `derive` SO BOTH ARMS CAN BE PINNED. The two shas can only disagree if the ref
// moves between `headSha` and `resolveRef` — two subprocesses with no seam a fixture can open,
// since `derive` builds its own git. In-process that arm was therefore unreachable, and it was
// left with no coverage at all: mutating the comparison to `namedSha === null` kept the whole
// suite green while removing the only check standing between a moved run branch and a
// `git branch -D`. Exported for the tests, not for callers — `derive` is the only caller.
export function runBranchDisagreement({ resolvedRef, headSha, namedSha }) {
  if (namedSha === headSha) return null
  return (
    `HEAD is ${headSha}, but ${printable(resolvedRef)} — the ref this run resolves the run branch through —`
    + ` is ${namedSha === null ? 'not a ref at all' : namedSha}.`
    // ONE reachable cause now, and it is an honest one. `headSha` and `resolveRef` are two
    // subprocesses: a commit or merge landing on the run branch between them produces exactly
    // this disagreement. The detached case is refused earlier with its own message, and the
    // shadowing case is gone — the ref comes from `symbolic-ref` rather than from abbreviation,
    // so no tag and no `heads/…` branch can produce it, and telling an operator to hunt for one
    // would send them after a ref that is not there.
    + ' Either something moved the branch while this was reading it — an integrator merging'
    + ' concurrently — in which case settle the repository and re-run; or the ref was deleted'
    + ' underneath this command. Nothing is verified or removed against a run branch whose ref'
    + ' does not hold the commit HEAD is on.'
  )
}

// Everything this CLI can say about a failed config operation, or null for an error that is
// not one — a real bug must still crash rather than be reported as a config problem.
//
// A ConfigError is a stated rejection and carries its own wording. A Node system error is a
// layer file that exists but cannot be read or written (a directory created in its place, a
// permission error): left alone it escapes as an unhandled rejection with a raw stack and exit
// 1, which a skill branching on this CLI's exit code reads as neither a pass nor a stated
// failure. `syscall` is what distinguishes an fs error from an ordinary Error carrying a
// `code` property.
// Both messages quote the manifest back. A ConfigError names the key it rejected, and a phase
// key, an `agents.<role>` field name and an unknown role are all arbitrary strings out of the
// file; the JSON parse error is worse still, because Node embeds a slice of the RAW FILE BYTES
// in `err.message`. That is the same hazard `readSuppliedPhases` wraps for a `--results` file,
// arriving through the manifest instead, and it reaches almost every subcommand at exit 2.
// Wrapped at this single boundary rather than at each `throw` in `config.mjs`, so a message
// added there is covered on the day it is added.
function configFailureMessage(err) {
  if (err instanceof ConfigError) return printable(err.message)
  if (typeof err?.syscall === 'string') return `could not access the config layers: ${printable(err.message)}`
  return null
}

// The single reader. `loadConfig` validates the LOCAL layer and, until T9 lands, keeps the
// tracked one as `(readLayer ?? {})` — so `fleetmates.gate.json` holding `[]` resolved every key
// to its default at exit 0 while the same body on the local side exited 2. Both layers are
// validated here, on the way out, so a reader and a writer cannot disagree about a file and the
// two layers cannot disagree with each other. Every read path in this module goes through it.
async function loadValidatedConfig(root) {
  const config = await loadConfig(root)
  validateGateLayer(config.gate)
  return config
}

// `loadValidatedConfig` throws on a malformed or over-reaching layer, and every command below
// branches on this CLI's exit code. Resolving through here turns that into the message-and-2
// the rest of the CLI already guarantees, instead of a stack trace from whichever command
// happened to read the layer first. `null` means "already reported, exit 2".
// Shared by `workflow` and `review-dispatch`: both hand a tier→model map straight into a
// generated dispatch, so both need the same refusals. Kept as one function rather than two
// copies, because a copy that drifts turns "a model name is a non-empty string" into a rule
// that holds for implementers and not for the reviewer grading their work.
const TIER_MODELS_REJECTED = Symbol('tier models rejected')

function parseTierModels(flags, io) {
  // `--models` written as a bare switch parses as `true` (parseFlags's boolean-switch
  // reading). Skipping it silently would exit 0 with a model-free dispatch — the caller
  // asked for routing and got none, with nothing on stdout to say so. Treated as the
  // missing argument it is, exactly as missingArgs treats `=== true` for required flags.
  if (flags.models === true) {
    io.out('--models needs a value: a JSON object mapping tiers to model names')
    return TIER_MODELS_REJECTED
  }
  if (flags.models === undefined) return undefined

  let tierModels
  try {
    tierModels = JSON.parse(flags.models)
  } catch {
    // A caller branches on this exit code. A malformed map must produce a message and
    // 2, never a raw SyntaxError stack from deep inside JSON.parse.
    io.out('--models must be a JSON object mapping tiers to model names')
    return TIER_MODELS_REJECTED
  }
  if (tierModels === null || typeof tierModels !== 'object' || Array.isArray(tierModels)) {
    io.out('--models must be a JSON object mapping tiers to model names')
    return TIER_MODELS_REJECTED
  }
  // The container being an object is not enough: every value is emitted verbatim into
  // the generated task list AND spread into the agent() options, so a nested object, a
  // number or an empty string becomes a `model` field no dispatcher can act on and no
  // reader can spot. A model name is a non-empty string or it is a mistake.
  for (const [tier, model] of Object.entries(tierModels)) {
    if (typeof model !== 'string' || model.trim() === '') {
      io.out(`--models value for '${tier}' must be a non-empty string model name`)
      return TIER_MODELS_REJECTED
    }
  }
  return tierModels
}

async function resolveConfig(root, io) {
  try {
    return (await loadValidatedConfig(root)).resolved
  } catch (err) {
    const message = configFailureMessage(err)
    if (message === null) throw err
    io.out(message)
    return null
  }
}

// `gate`, `complete` and `fix` read the manifest through `loadGateConfig`, which parses and does
// not validate — a third reader alongside `loadConfig` and the write path, covered by neither
// validator. It fails CLOSED (a body of `[]` yields zero checks and `aggregateVerdict` returns
// FAIL on its `verified.length > 0` guard), so this was never a hole. It was a diagnostics one:
// the operator saw a failing gate and nothing naming the file, and `{"phases":{"default":
// {"checks":"nope"}}}` crashed with a TypeError whose stdout is not the JSON a skill parses.
//
// Validated here, at the consumer, rather than inside `loadGateConfig` — that function is also
// the plain reader `self-gate` and the gate-config tests use, and the tripwire test in
// tests/config.test.mjs pins it staying that way. Read through `readLayer` so a manifest that is
// not valid JSON is a ConfigError like everywhere else, instead of a SyntaxError escaping raw.
const GATE_CONFIG_REJECTED = Symbol('gate manifest rejected')

async function resolveGateConfig(root, io) {
  try {
    const raw = await readLayer(root, GATE_FILE, { missing: ABSENT })
    // `null` means no manifest, which each of the three callers answers on its own terms —
    // `gate` infers one and exits 3, `complete` refuses at 4, `fix` falls back to defaults.
    // Only a manifest that is PRESENT and broken is this function's business.
    return raw === ABSENT ? null : validateGateLayer(raw)
  } catch (err) {
    const message = configFailureMessage(err)
    if (message === null) throw err
    io.out(message)
    return GATE_CONFIG_REJECTED
  }
}

// Every key this CLI can resolve, as a single field. `set` gets this check from `validateKey`,
// which needs a value; `get` and `unset` have none to give it, and without an equivalent
// `config unset totallyBogus` created the file, gitignored it, reported `wrote …` and exited 0
// having removed nothing, while `config get agents.implementer` printed `[object Object]`.
const CONFIG_KEYS = [
  'maxParallel',
  'caveman',
  ...ROLES.flatMap((role) => [`agents.${role}.tier`, `agents.${role}.effort`]),
]

// `unset` may also name one role's entry — `agents.implementer` is a real subtree of the layer
// and removing it removes exactly the fields this layer knows about. The bare segment `agents`
// is NOT in this set, and that is the point: it is a prefix of every role including the
// reviewer's, `isEnforcementKey('agents')` is false, so `config unset agents --local` walked
// straight past the enforcement guard and wiped the reviewer's tier and effort along with
// everyone else's. A key that can reach an enforcement field is not an ergonomics key.
const UNSETTABLE_KEYS = [...CONFIG_KEYS, ...ROLES.map((role) => `agents.${role}`)]

// One rejection wording for all three subcommands: a key nothing reads is the same answer
// whether the caller asked to read it, write it or remove it.
function assertKnownKey(dotted, allowed) {
  if (!allowed.includes(dotted)) throw new ConfigError(`unknown config key: ${dotted}`)
}

// Both layers, symmetrically. `readLayer` parses but does not validate, and the `?? {}` that
// follows it only replaces a NULLISH body — a layer whose whole body is `[]` or `"text"`
// survives it, `setKey` then writes a property `JSON.stringify` drops (a silent no-op reported
// as `wrote …`, exit 0) or dies with a raw TypeError. `config list` already exits 2 on both of
// those bodies, so leaving the write path unchecked had one CLI giving two answers about one
// file.
//
// The gate layer's check is `validateGate` from scripts/config.mjs the moment that export
// exists: T9 adds it and is merging into this phase alongside this task, but at the commit this
// branch is based on it is not there, and creating it would mean editing a file outside this
// task's declared set. Resolved once, here, so this path runs exactly one validator either way
// — never a local copy competing with T9's stricter one.
const validateGateLayer = configModule.validateGate ?? ((gate) => {
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
    throw new ConfigError(`${GATE_FILE} must contain a JSON object`)
  }
  return gate
})

// The local layer's own rules (no enforcement keys, no unknown keys) sit ON TOP of the same
// shape check the gate layer gets — validateLocal already rejects a non-object body itself.
function validateLayer(file, layer) {
  return file === LOCAL_FILE ? validateLocal(layer) : validateGateLayer(layer)
}

// Tells a missing file apart from one whose whole body is `null`; readLayer's default answer is
// the same `null` for both.
const ABSENT = Symbol('absent layer')

// Every READER validates both layers through `loadValidatedConfig`; the write path validated
// only the layer it was writing. So `config set maxParallel 3 --local` exited 0 against a repo
// whose `fleetmates.gate.json` was malformed, while `config list` on that same repo exited 2 —
// one CLI, two answers about one repository. The same shape as the layer-and-spelling asymmetries
// fixed in the read path and in `loadConfig`: a guard applied to one side and not its counterpart.
//
// Gate first, then local, which is `loadConfig`'s own order — a repo broken in both layers must
// name the same file whichever command the operator reached for. The layer being written is
// validated from the object already in hand rather than re-read, so this adds one read, not two.
async function validateBothLayers(root, targetFile, targetLayer) {
  for (const file of [GATE_FILE, LOCAL_FILE]) {
    if (file === targetFile) {
      validateLayer(file, targetLayer)
      continue
    }
    const raw = await readLayer(root, file, { missing: ABSENT })
    // An absent counterpart is the ordinary case, never a failure: a project with no manifest
    // must still be able to write a local override, and vice versa.
    if (raw !== ABSENT) validateLayer(file, raw)
  }
}

// `.gitignore` has no effect on a path git already tracks: the entry is written, the file goes
// on being committed, and the trust split the "added …" message claims — this layer is
// untracked, so a teammate cannot change it without leaving the dirty worktree `fileset` and
// `ownership` detect — silently does not hold. Reported rather than claimed.
//
// Any failure means no answer, which is reported as "not tracked": outside a git repository
// there is nothing to be tracked by, and this must never be the thing that fails a write.
async function isTracked(root, file) {
  try {
    const { code } = await defaultGitExec(['ls-files', '--error-unmatch', '--', file], root)
    return code === 0
  } catch {
    return false
  }
}

// `git ls-files` reports paths relative to the CURRENT DIRECTORY, while `git log --name-only`
// reports them relative to the REPOSITORY ROOT. `map` reads both and keys one against the other,
// so run anywhere below the root the two halves stopped being the same namespace: a file 100%
// coupled by history was reported as "no coupled files found", and the overview printed
// root-relative pairs beside cwd-relative directory rows. The prefix that reconciles them is what
// git itself calls it — `rev-parse --show-prefix` — and everything cwd-relative, including the
// caller's own --files argument, is lifted through it before any key is compared.
//
// This lives here rather than in scripts/git.mjs deliberately: it is a fix to how `map` composes
// two existing primitives, not a new primitive.
async function repoPrefix(root) {
  const { code, stdout, stderr } = await defaultGitExec(['rev-parse', '--show-prefix'], root)
  if (code !== 0) {
    throw new GitError(`git rev-parse --show-prefix failed: ${stderr.trim() || `exit ${code}`}`)
  }
  // Exactly one trailing newline is git's framing; a directory name may legally end in
  // whitespace, so nothing else is trimmed.
  return stdout.replace(/\n$/, '')
}

function toRepoPath(prefix, p) {
  const joined = `${prefix}${String(p).replace(/\\/g, '/')}`
  if (joined === '') return joined
  const normalized = path.posix.normalize(joined)
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

// A directory name taken from the repository is attacker-controlled data — a branch, a PR, a
// vendored dependency can all introduce one — and `map-notes` interpolates it into a prompt under
// the line "dispatch an Explore agent with exactly this prompt". Unlike the implementer brief,
// nothing downstream bounds what that agent then does, so the hint is restricted to what a
// directory name in a normal repository actually looks like: '/'-separated plain path segments.
// A name carrying a newline, a control character, quoting, or the whitespace and punctuation that
// let it read as a new instruction is DROPPED rather than escaped — the hint is orientation, and
// orientation is worth exactly nothing next to a prompt-injection foothold. Surviving names still
// render, so the signal is narrowed, never removed.
const PLAIN_SEGMENT = /^[A-Za-z0-9._+@-]+$/
export function promptSafeDirectories(dirs = []) {
  return dirs.filter((dir) => {
    if (typeof dir !== 'string' || dir === '' || dir.length > 120) return false
    const segments = dir.split('/')
    return segments.length <= 8 && segments.every((s) => PLAIN_SEGMENT.test(s))
  })
}

export async function runCli(argv, io = { out: console.log }) {
  // Two channels, not one. `io.out` carries the ANSWER a command was asked for — and for
  // `workflow` that answer is a JavaScript module a caller redirects into a file. Anything
  // that is commentary about how the answer was produced has to leave by another door, or a
  // single advisory line becomes the first statement of the generated source and the command
  // that promised never to fail the dispatch is what fails it. A caller supplying only `out`
  // keeps working: `err` defaults to console.error, exactly as `out` defaults to console.log.
  io = { err: console.error, ...io }
  const [command, ...rest] = argv
  const { flags, positional, rejected } = parseFlags(rest)
  // Refused before EVERYTHING else — before the required-argument check, before any command
  // body. A rejected spelling must not be able to reach a guard that tests the flag it was
  // meant to set: `gate --no-fleet=false` has to exit here, not after `missingArgs` has
  // already decided that a solo run needs neither --run nor --plan.
  if (rejected.length > 0) {
    const advice = rejected.map(({ raw, name }) => `\`${raw}\` — ${spellingAdvice(name)}`)
    io.out(`unsupported flag spelling: ${advice.join('; ')}\n\n${USAGE}`)
    return 2
  }
  // An empty or whitespace-only --root must never silently fall through to cwd: `??` only
  // catches `undefined`, so `--root ""` survives to become `repoRoot: ''` downstream, which
  // defeats the realpath-based containment checks in the merge preview (realpath('') rejects,
  // so both guarded escape checks in linkInto get skipped instead of enforced). Fail loudly
  // here instead of silently using the wrong root. A bare `--root` with no value at all (e.g.
  // last on the argv, or immediately followed by another flag) is the same orchestrator
  // mistake in a different guise: an unset `$PROJECT_ROOT` templated *unquoted* makes the
  // argument vanish entirely rather than become empty, so parseFlags maps it to `true`
  // instead of a string. That `true` would otherwise reach path.join() downstream and throw
  // a raw TypeError with no verdict, which must never happen.
  if (typeof flags.root !== 'undefined' && (typeof flags.root !== 'string' || flags.root.trim() === '')) {
    io.out(`--root must not be empty\n\n${USAGE}`)
    return 2
  }
  const root = flags.root ?? process.cwd()
  const runId = flags.run

  // Before the required-argument check and before any command body, for the same reason the
  // rejected spellings are: a flag this command does not read must never reach a guard that
  // acts on a DIFFERENT flag. Reported by name, so the caller sees which of its arguments the
  // command was never going to act on rather than a bare usage dump.
  const strays = unknownFlags(command, flags)
  if (strays.length > 0) {
    io.out(`${command} does not take ${strays.map((f) => `--${f}`).join(', ')}`)
    io.out(USAGE)
    return 2
  }

  if (REQUIRED[command]) {
    const missing = missingArgs(command, flags, positional)
    if (missing.includes(NAMED_PHASE_REFUSAL)) {
      // Stated as the boundary it is rather than as a typo. Note what it must NOT say: that a
      // named phase has no task set. `tasksOfPhase` returns EVERY task of the run for a
      // non-integer phase name, which is the honest reading of "this manifest phase's diff" —
      // so the accurate claim is only that tasks and rounds are keyed numerically, and this
      // refusal also reaches `workflow` and `record-fix-round` and a plain typo.
      // Every OTHER missing flag is listed alongside. Returning on the phase alone bounced the
      // operator a second time for something this call already knew was absent.
      const alsoMissing = missing.filter((m) => m !== NAMED_PHASE_REFUSAL)
      io.out(`${command} takes --phase <integer> and got ${printable(flags.phase)}. Tasks and fix `
        + 'rounds are keyed by numeric phase, so a non-numeric value addresses none of them. If '
        + 'this came from a --no-fleet gate verdict, which names its phase from the manifest, that '
        + 'verdict has no task branches to redispatch and its findings are fixed directly.'
        + (alsoMissing.length > 0 ? ` Also missing: ${alsoMissing.join(', ')}.` : '')
        + `\n\n${USAGE}`)
      return 2
    }
    if (missing.length > 0) {
      io.out(`missing required argument: ${missing.join(', ')}\n\n${USAGE}`)
      return 2
    }
  }

  // Before any command reads a name: a repository claude-teammates left behind is moved to the
  // fleetmates spellings once, or the command refuses and says why. `newestMtime` is the same walk
  // `liveness` uses, so "a teammate is live" means the same thing in both places.
  const migration = await migrate(root, { io, measureTouch: (dir) => newestMtime(dir) })
  if (migration.code !== 0) return migration.code

  // runId and taskId become path segments under root/.fleetmates before any command runs.
  // Checked once, here, rather than in each command — a value like `../../ESCAPED` must
  // never reach a filesystem call.
  try {
    if (typeof runId === 'string') assertContained(path.join(root, NAMES.stateDir), runId, '--run')
    if ((command === 'claim' || command === 'unclaim') && typeof flags.task === 'string') {
      assertContained(path.join(root, NAMES.stateDir, runId, 'claims'), flags.task, '--task')
    }
    // `message` builds `.fleetmates/<run>/sessions/<task>.json` from --task and hands the task's
    // session id to a harness, so its task id is contained here too — a `../evil` must be refused
    // (exit 2) before any session path is joined or any adapter is invoked, not reach the driver.
    if (command === 'message' && typeof flags.task === 'string') {
      assertContained(path.join(root, NAMES.stateDir, runId, 'sessions'), flags.task, '--task')
    }
  } catch (err) {
    io.out(`${err.message}\n\n${USAGE}`)
    return 2
  }

  // The git-writability preflight (Step 2): a command that writes the repo's git dir fails fast
  // with one fixable message when this shell cannot write the common dir, rather than deep inside
  // a clone, fetch or worktree add. Runs after the id-containment check so `dispatch --run ../evil`
  // is still refused as an escape (exit 2) before this touches git, and before any command body so
  // nothing is created on the way to the refusal.
  if (GIT_WRITING_COMMANDS.has(command)) {
    const writable = await gitDirWritable((args, opts) => defaultGitExec(args, { cwd: root, ...opts }), root)
    if (!writable.ok) {
      io.err(sandboxRefusal(writable.dir))
      return 2
    }
  }

  if (command === 'init-run') {
    // Before the plan is even read: an id the location record cannot hold must never reach
    // dispatch, because the failure it causes surfaces one agent later, in every teammate at
    // once, as enforcement that is simply off.
    //
    // Deliberately NOT hoisted to run for every command, and the reason is a measurement rather
    // than a preference: a run directory is a directory anyone with write access can create, so
    // refusing the id at the door would not stop `digest` or `collect-reviews` from being handed
    // one — it would only remove the route the SANITISED_SITES rows use to prove those commands
    // escape what they are handed. Tried, and it turned six of those rows red while closing no
    // hazard; see `tests/cli.test.mjs`, the `renderDigest` header row, for the same argument in
    // the place it was first written.
    const runRefusal = idRefusal('--run', runId, { nested: true, maxBytes: MAX_RUN_ID_BYTES })
    if (runRefusal) { io.out(runRefusal); return 2 }

    // Resolved against `--root`, which is what `--plan` means everywhere else in this CLI: `gate`,
    // `complete` and `rebuild-state` all hand it to `git show <anchor>:<planPath>`, and a git path
    // is repo-relative by definition. This command alone read it with a bare `readFile`, so a
    // relative argument was read from the process cwd — masked until now because every caller
    // builds the path from a root and passes it absolute, which resolves identically either way.
    //
    // The two spellings have to agree because this command now RECORDS the path as well as reads
    // it: reading from the cwd while recording relative to the root would write a pointer to a
    // file the recorded path does not name.
    const planFile = path.resolve(root, positional[0])
    const planText = await readFile(planFile, 'utf8')

    // Parsed from the same text the task list is about to be parsed from below — read once,
    // handed to both parsers — before `assignPhases(parsePlan(...))` runs, so a malformed
    // section refuses the run before any task work is even derived from the file.
    let sections
    try {
      sections = parsePlanSections(planText)
    } catch (err) {
      // `planSectionsRefusal` re-throws anything that is not a `PlanSectionError` rather than
      // reporting it as if the plan's prose were at fault.
      io.out(planSectionsRefusal(err))
      return 2
    }

    const tasks = assignPhases(parsePlan(planText))

    // DEFENCE IN DEPTH, and stated as such rather than as a validation that earns its keep:
    // `plan-parser.mjs` builds every id as `T${digits}` from `/^###\s+Task\s+(\d+)\s*:/`, so no
    // plan can currently produce an id this rejects. It stays because the ids are recorded and
    // branched on exactly as written, and a parser that ever learns a richer heading must not
    // silently start minting ids the location record cannot hold. The RULE it applies is
    // cross-checked against the store directly in tests/cli.test.mjs, not through this loop.
    for (const task of tasks) {
      const taskRefusal = idRefusal('--task', task.id, { nested: false, maxBytes: MAX_TASK_ID_BYTES })
      if (taskRefusal) { io.out(taskRefusal); return 2 }
    }

    // Every task carries a tier from here on, so no consumer has to re-derive one.
    // `plan-parser.mjs` records a declared tier verbatim and validates nothing; the
    // vocabulary lives in routing.mjs, so this is the single place that checks it. A typo
    // must fail the run at init, not silently route a task to a tier no dispatcher knows.
    for (const task of tasks) {
      if (task.tierSource === 'declared') {
        if (!TIERS.includes(task.tier)) {
          // The tier is the value being refused, and it was never validated: `plan-parser.mjs`
          // records `**Model:**` verbatim with `(.+?)`. A refusal is the line most worth
          // forging — the command exits 2 while the operator reads a pass — so it goes through
          // `printable` exactly as the phase listing below does.
          io.out(`${printable(task.id)}: unknown model tier '${printable(task.tier)}' (expected ${TIERS.join(', ')})`)
          return 2
        }
        continue
      }
      task.tier = inferTier(task, tasks)
      task.tierSource = 'inferred'
      // Kept alongside the tier a configured one may replace below. Without it, removing the
      // configured tier leaves nothing to fall back to, and plan.json keeps a tier the run is
      // no longer dispatching at — which is the tier `fix` would go on escalating from.
      task.inferredTier = task.tier
    }

    const totalPhases = tasks.reduce((max, t) => Math.max(max, t.phase), 0)
    // The resolved value, not the manifest's: the gitignored local layer is an ergonomics
    // surface, and a parallelism it sets must actually take effect where it is consumed.
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2

    // A configured implementer tier is an explicit operator decision and outranks inferTier's
    // guess. Applied HERE, before plan.json is written, for two reasons the in-memory override
    // in `workflow` cannot serve. First, `fix` escalates from the RECORDED tier: with the
    // record left inferred, a retry after a failure at a configured `capable` was dispatched
    // at `mid` — below the tier that just failed. Second, the tier this command prints is the
    // run's only operator-facing routing report, and it has to name what will be dispatched.
    // A declared `**Model:**` still wins: it names a task the operator already reasoned about.
    const roleTier = resolved.agents.implementer.tier
    if (roleTier) {
      for (const task of tasks) {
        if (task.tierSource !== 'declared') {
          task.tier = roleTier
          task.tierSource = 'configured'
        }
      }
    }

    // Recorded so a stop-time hook can run `complete` without being told the plan path.
    // Repo-relative on purpose: the gate reads this path out of git at the run anchor, git
    // paths are always `/`-separated, and an absolute path from one machine means nothing on
    // another.
    // The same resolved file the plan was READ from, expressed relative to the root — so the
    // recorded pointer and the file this command parsed are the same file by construction.
    const planPath = path.relative(root, planFile).split(path.sep).join('/')

    // Recorded for the SAME reason as planPath, and it is the only durable record of which
    // branch this run belongs to. `complete` otherwise derives the run branch from whatever the
    // main worktree has checked out, which is the operator's state, not the teammate's: with the
    // main worktree on an unrelated branch a compliant teammate is told its file set is wrong and
    // to delete a sibling's landed file.
    //
    // Best effort. A repository this cannot be read from still gets a run — the field is simply
    // absent, and every consumer treats absent as "cannot confirm" and fails OPEN. Failing the
    // whole `init-run` here would be a new way to lose a run for a question nothing asked before.
    //
    // The BASE branch is never recorded as a run branch. `skills/parallel-execution/SKILL.md`
    // opens with this command and nothing before it checks out a run branch, so the checked-out
    // branch here is very often the base — and recording that would be recording a value no real
    // run branch can ever equal. That state is already broken for everything else: `derive`
    // refuses outright when the checked-out branch is the base, so `gate` cannot run from here
    // either. It was simply never said out loud, which is what made the consequence invisible.
    let runBranch = null
    let baseHere = null
    // WHY there is no run branch, not just that there is none. The note below used to infer the
    // cause from `baseHere` alone, which reads the base branch's EXISTENCE as evidence that it is
    // checked out — `resolveBaseBranch` answers from `branchExists` and never looks at HEAD. On a
    // detached HEAD that printed `because main is checked out and that is the base branch` while
    // main was not checked out at all (measured), sending an operator to fix the wrong thing.
    // The KIND, from the shared classifier, not a null test. There are two ways to be on no
    // branch and they need different sentences: a null test collapses them, so a HEAD repointed
    // to `refs/mine/rb` was reported as detached while `git status` in the same repository said
    // `## refs/mine/rb` (measured). That is the same failure this comment already describes —
    // naming a cause the operator cannot act on — one spelling further along.
    let headKind = null
    try {
      const git = createGit({ cwd: root })
      const head = await git.headBranch()
      headKind = head.kind
      baseHere = await resolveBaseBranch(git, flags.base)
      runBranch = head.name === baseHere ? null : head.name
    } catch {
      runBranch = null
    }
    // Through `writePlan` like every other plan write, which is what makes fill-if-absent apply
    // here too. It matters most on a RE-INIT: amending a plan mid-run is normal (the comment below
    // says so, and preserves `gates` and `fixRounds` for exactly that reason), and this command
    // used to re-record `runBranch` from whatever was checked out — so a re-init from an unrelated
    // branch re-pointed the run at it, permanently.
    const recorded = await writePlan(
      root, runId,
      {
        runId, totalPhases, tasks, planPath,
        destination: sections.destination,
        notYetSpecified: sections.notYetSpecified,
        outOfScope: sections.outOfScope,
      },
      { candidateRunBranch: runBranch, baseBranch: baseHere },
    )
    if (recorded.runBranch === null) {
      io.out(
        `note: run ${printable(runId)} recorded no run branch`
        + (headKind === 'detached'
          ? ', because HEAD is detached and a detached HEAD is on no branch'
          : headKind === 'not-a-branch'
            ? ', because HEAD points at a ref that is not a branch, and only a branch can be a run branch'
            : headKind === 'ref-path-name'
              ? ', because the checked-out branch has a name that is itself a ref path, which git resolves inconsistently depending on the command'
              : (baseHere ? `, because ${printable(baseHere)} is checked out and that is the base branch` : ''))
        + '. Check out this run\'s branch before gating — `gate` refuses to run from the base branch,'
        + ' and until some command derives a context from the run branch, stop-time enforcement'
        + ' cannot confirm the checkout and will allow every stop rather than risk blocking on the wrong ref.',
      )
    } else if (recorded.carried !== null && recorded.carried !== runBranch) {
      // The one thing that makes a wrong recorded branch findable. Nothing repairs such a record
      // automatically — that is the price of never letting an automatic writer replace a good one —
      // so it has to announce itself instead of being discovered later by its effects.
      io.out(
        `note: run ${printable(runId)} keeps its recorded run branch ${printable(recorded.carried)}`
        + `, which is not the branch checked out here (${printable(runBranch ?? 'none')}).`
        + ` If that recorded branch is wrong, remove \`runBranch\` from ${NAMES.stateDir}/`
        + `${printable(runId)}/plan.json and run this command again — no command overwrites it,`
        + ' so that a wrong checkout can never re-point a run.',
      )
    }
    // Recorded for reporting only. The gate derives the anchor, the phase, and every
    // verdict from git; nothing here decides anything.
    //
    // Re-running init-run must not erase what the gate recorded. `gates` and `fixRounds` are
    // the run's only history of what passed and what it cost; a plan amendment mid-run is a
    // normal reason to re-init, and it must not silently discard them — without this, "never
    // report a phase done without a recorded PASS" becomes unsatisfiable after any re-init.
    // The spreads are conditional so a fresh run emits neither key rather than an empty
    // object, which anything testing only for presence would read as a recorded one.
    const previous = await readState(root, runId, 'status')
    await writeState(root, runId, 'status', {
      runId,
      phase: previous?.phase ?? 1,
      totalPhases,
      maxParallel: resolved.maxParallel,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, state: 'pending' })),
      ...(previous?.gates ? { gates: previous.gates } : {}),
      ...(previous?.fixRounds ? { fixRounds: previous.fixRounds } : {}),
    })
    for (let p = 1; p <= totalPhases; p += 1) {
      // Tier and its source are printed, not just the ids: routing decides what every
      // dispatch in the phase costs, and an operator should see an inference they disagree
      // with before the run starts, while a Model line is still cheap to add.
      const ids = tasks
        .filter((t) => t.phase === p)
        // Same as `rebuild`'s listing: the id and the tier are read out of the plan file.
        .map((t) => `${printable(t.id)} (${printable(t.tier)}, ${printable(t.tierSource)})`)
        .join(', ')
      io.out(`phase ${p}: ${ids}`)
    }
    return 0
  }

  if (command === 'digest') {
    const status = await readState(root, runId, 'status')
    if (!status) { io.out(`no status for run ${runId}`); return 1 }
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2
    io.out(renderDigest(status, Date.now(), resolved.caveman))
    return 0
  }

  if (command === 'claim') {
    const won = await claimTask(root, runId, flags.task, flags.by)
    io.out(won ? 'claimed' : 'taken')
    return won ? 0 : 1
  }

  if (command === 'unclaim') {
    await releaseClaim(root, runId, flags.task)
    io.out('released')
    return 0
  }

  if (command === 'locate') {
    // A bare `--worktree`/`--branch` parses as the boolean `true` — the shape an unset shell
    // variable templated unquoted produces. Falling back to the derived value there would file
    // a record for the wrong directory and exit 0, which is exactly the silent outcome this
    // command exists to remove. Refused with the same advice a misspelling gets.
    for (const name of ['worktree', 'branch']) {
      if (typeof flags[name] !== 'undefined' && (typeof flags[name] !== 'string' || flags[name].trim() === '')) {
        io.out(`unsupported flag spelling: \`--${name}\` — ${spellingAdvice(name)}`)
        return 2
      }
    }
    try {
      // Run from inside a teammate's worktree, so `root` here is that worktree. The record
      // belongs to the run, which lives in the MAIN worktree — and the hook resolves the main
      // root the same way before looking a cwd up, so a record filed anywhere else is a record
      // no reader ever finds. The WORKTREE recorded still comes from where this ran: the two
      // paths are deliberately different, and collapsing them breaks the lookup in one
      // direction or the other.
      const mainRoot = await mainWorktreeRoot(root)
      const git = createGit({ cwd: root })

      // The worktree's TOP LEVEL, never the raw cwd. A teammate that runs this from a
      // subdirectory — `src/`, or anywhere it happened to be — would otherwise file the record
      // under the hash of that subdirectory and exit 0 with a plausible confirmation line, while
      // the harness hands the hook the worktree root: the lookup misses, the handler allows, and
      // enforcement is off for that teammate's every stop including the do-nothing case it
      // exists for. `rev-parse --show-toplevel` is git's own answer to "which worktree am I in",
      // so the recorded path is the one the hook will ask about.
      const worktree = typeof flags.worktree === 'string'
        ? flags.worktree
        : await worktreeTopLevel(root)

      // RELATIVE paths are refused before git is asked about anything. `classifyWorktree` spawns
      // git with the candidate as its cwd, so a relative one would be resolved against the
      // PROCESS's directory — and if that happens to sit inside a repository, git answers about a
      // directory the caller never named. `isLocalAbsolute` covers exactly that: a non-existent
      // ABSOLUTE path still reaches git and surfaces as `spawn git ENOENT`, which the catch below
      // re-throws with the path quoted, so it is diagnosable and needs no separate check here.
      if (!isLocalAbsolute(worktree)) {
        throw new Error(`${JSON.stringify(printable(worktree))} is not a path a record can name`)
      }

      // A RECORD MAY NAME ONLY A LINKED WORKTREE OF THIS REPOSITORY, however the path was arrived
      // at — explicit `--worktree` or derived. The main worktree belongs to no task and is where
      // everything that is not a teammate runs; anything else is not this run's to name.
      //
      // Classified from the CANDIDATE's own git dirs, not from `git worktree list`. The listing
      // was the previous check and it only ever ran for an explicit flag, so the derived path —
      // the invocation the brief actually renders — went unchecked; and a `.git` FILE is plain
      // text, so a planted one produces a `--show-toplevel` inside the main worktree that the
      // listing never mentions and no `git status` reveals. See `classifyWorktree`.
      let shape
      try {
        shape = await classifyWorktree(worktree, await gitCommonDir(root))
      } catch (err) {
        // git's own failure, re-thrown with the path it was asked about — otherwise a directory
        // outside any repository reports only that some rev-parse exited non-zero.
        throw new Error(`${JSON.stringify(printable(worktree))} could not be identified as a worktree: ${err.message}`)
      }
      if (shape === CLASSIFY_MAIN) {
        throw new Error(
          `${JSON.stringify(printable(worktree))} is the main worktree, which belongs to no task`
          + ' — run this from inside your own worktree',
        )
      }
      if (shape === CLASSIFY_SUBDIRECTORY) {
        throw new Error(
          `${JSON.stringify(printable(worktree))} is inside a worktree but is not its top level`
          + ' — a record must name the worktree itself, because that is the path a stopping agent'
          + ' is looked up by; omit --worktree to have it derived',
        )
      }
      if (shape !== CLASSIFY_LINKED) {
        throw new Error(
          `${JSON.stringify(printable(worktree))} is not a linked worktree of this repository`
          + ' — its git directory is not contained in this repository\'s',
        )
      }

      // Compared through `worktreeKey`, which is the store's own normalisation and the same
      // function the reader will hash the hook's cwd with — comparing raw strings would accept a
      // spelling that then addresses a different record.
      const key = worktreeKey(worktree)
      if (key === '') throw new Error(`${JSON.stringify(printable(worktree))} is not a path a record can name`)

      // The harness checks out `worktree-agent-<hash>`, and a teammate that never created its
      // task branch legitimately records that. The store constrains only the type and length —
      // what a branch name MEANS is the hook's to decide, and "not the expected branch" is the
      // case it exists to catch.
      // What is STORED is null on every rejection: the store accepts it (`writeLocation` bounds
      // the field's type and length only) and a reader asking which branch this worktree is on
      // then gets "none" rather than a name. The value it used to record in that state was the
      // string `HEAD`, which names a ref anyone can create — so the record asserted a branch that
      // a third party, not the teammate, controlled.
      // The KIND again, for the label only — what is STORED is unchanged. Labelling by a null
      // test called a worktree whose HEAD pointed at `refs/mine/wb` "detached" while `git status`
      // there said `## refs/mine/wb`.
      const head = typeof flags.branch === 'string' ? null : await git.headBranch()
      const branch = typeof flags.branch === 'string' ? flags.branch : head.name
      await writeLocation(mainRoot, runId, flags.task, { worktree, branch })
      // One arm per kind, and the third is not the second: a ref-path name IS a branch, one
      // `git branch --list` marks with `*`, so the not-a-branch wording contradicts git in the
      // same worktree. This is the third consumer of `kind`; `doctor` and `init-run` are the
      // others, and all three have to be visited whenever a state is added.
      const label = branch !== null
        ? printable(branch)
        : head.kind === 'detached'
          ? '(detached HEAD)'
          : head.kind === 'ref-path-name'
            ? `(branch ${printable(head.ref)}, whose name is itself a ref path)`
            : `(no branch: HEAD points at ${printable(head.ref)})`
      io.out(`recorded ${printable(flags.task)} at ${printable(worktree)} on ${label}`)
      return 0
    } catch (err) {
      // Never swallowed. A `locate` that exits 0 having written nothing leaves the teammate
      // believing it is identified and the hook finding no record for its cwd.
      io.out(`cannot record this worktree: ${printable(err.message)}`)
      return 2
    }
  }

  if (command === 'brief') {
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2
    // The same coercion `workflow` applies: a bare `--plan`/`--base` is the value MISSING, not
    // a value, and coercing `true` through would render the literal `true` as a plan path.
    const planPath = flags.plan === true ? '' : (flags.plan ?? '')
    const baseBranch = flags.base === true ? '' : (flags.base ?? '')
    if (planPath === '') {
      io.out(`--plan must not be empty\n\n${USAGE}`)
      return 2
    }
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no run ${runId} — run init-run first`); return 4 }
    const task = (plan.tasks ?? []).find((t) => t.id === flags.task)
    if (!task) { io.out(`no task ${printable(flags.task)} in run ${runId}`); return 4 }

    const planMarkdown = await planAtAnchor(root, planPath, flags, io)
    if (planMarkdown === PLAN_READ_REJECTED) return 2

    io.out(composeBrief({
      // `taskBranchName` is the single definition of `fleetmates/${runId}/${taskId}`, and the
      // gate resolves the branch through it. A brief restating the shape could name a ref
      // nothing looks for.
      task: { ...task, branch: taskBranchName(runId, task.id) },
      runId,
      planPath,
      baseBranch,
      constraints: parseConstraints(planMarkdown),
      caveman: resolved.caveman,
      // A fix round's work is already ON the task branch, so the ordinary first step — a
      // `checkout -B` back to the base — would destroy what the round exists to repair. The
      // orchestrator knows which rounds are fix rounds; the brief cannot tell on its own.
      fixRound: flags['fix-round'] === true,
    }))
    return 0
  }

  if (command === 'workflow') {
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId}`); return 1 }
    const phase = Number(flags.phase)
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2

    // Concrete model names never enter this repository or fleetmates.gate.json — they live
    // in the dispatching skill, which passes its own tier map through here. Absent, the
    // generated agent() calls carry no model and inherit the session's, as before.
    const tierModels = parseTierModels(flags, io)
    if (tierModels === TIER_MODELS_REJECTED) return 2

    // Both are optional: omitted, the brief renders without a plan pointer and falls back to
    // its no-base variant rather than failing. A bare `--plan`/`--base` parses as `true`
    // (parseFlags's boolean-switch reading), which is the value missing, not a value — coerced
    // through it would render the literal `true` as a plan path or a branch name.
    const planPath = flags.plan === true ? '' : (flags.plan ?? '')
    const baseBranch = flags.base === true ? '' : (flags.base ?? '')

    const planMarkdown = await planAtAnchor(root, planPath, flags, io)
    if (planMarkdown === PLAN_READ_REJECTED) return 2

    // `init-run` already applied any configured implementer tier, so this normally changes
    // nothing. It stays because the config can change between the two commands, and a per-task
    // `**Model:**` stays authoritative over both — it names a specific task the operator
    // already reasoned about, which a blanket role setting knows nothing about.
    //
    // The result is written back to plan.json rather than kept in memory: `fix` escalates from
    // the recorded tier, so a dispatch at a tier the record does not carry means a retry can be
    // sent BELOW the tier that just failed.
    // Reverting matters exactly as much as applying, and for the same reason: gated on
    // `if (roleTier)` alone, a task stamped `configured` kept that tier forever once the
    // operator removed the setting — plan.json naming a tier the run no longer dispatches at,
    // and `fix` escalating from it. `inferredTier` is what init-run keeps for this. A task
    // whose plan.json predates that record is left alone rather than guessed at.
    const roleTier = resolved.agents.implementer.tier
    const phaseTasks = plan.tasks.filter((t) => t.phase === phase)
    let retier = false
    for (const task of phaseTasks) {
      if (task.tierSource === 'declared') continue
      if (roleTier) {
        if (task.tier === roleTier && task.tierSource === 'configured') continue
        task.tier = roleTier
        task.tierSource = 'configured'
        retier = true
      } else if (task.tierSource === 'configured' && task.inferredTier) {
        task.tier = task.inferredTier
        task.tierSource = 'inferred'
        retier = true
      }
    }
    // Through `writePlan` as well: `plan` here was read from disk and so happens to carry the
    // recorded branch, but "happens to" is exactly the property that stopped holding twice.
    if (retier) await writePlan(root, runId, plan)

    // AFTER the retier write, and that ordering is the whole point. `plan` was read into memory
    // above; refreshing before this line wrote the run branch to disk and then this line wrote the
    // stale in-memory object back over it — so with a tier configured, the field this command
    // exists to populate came out `undefined`, and only in that configuration. `rememberRunBranch`
    // re-reads the file, so running it last picks up the retier and cannot be clobbered.
    //
    // This is the EARLIEST repair: it runs on the run branch immediately before a phase is
    // dispatched, so the guard's input is right before the teammates it dispatches can stop.
    // `gate` only reaches it after they have finished.
    //
    // Wrapped and discarded on failure: dispatching a phase must not fail because a diagnostic
    // field could not be refreshed.
    try {
      const branchGit = createGit({ cwd: root })
      await rememberRunBranch(
        root, runId,
        await branchGit.currentBranch(),
        await resolveBaseBranch(branchGit, flags.base),
      )
    } catch { /* the field stays as it was; every consumer treats it as cannot-confirm */ }

    // Coupling is recomputed here rather than read from anywhere: it is a statistic about the
    // repository as it stands, and a stored one would be a second source of truth about a number
    // nobody can check. A failure to read history is not a failure to dispatch — a brief without
    // a blast radius is the brief this command emitted until now, so it degrades to that and says so.
    const neighbours = {}
    try {
      const coupling = buildCoupling(await createGit({ cwd: root }).commitFileSets({ limit: 500 }))
      for (const task of phaseTasks) {
        const near = neighboursOf(coupling, task.files ?? [], { top: 5 })
        if (near.length > 0) neighbours[task.id] = near
      }
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      // stderr, not stdout: stdout is the generated workflow source, and a caller redirects it
      // straight into a file it then runs. A notice printed there would be a syntax error in the
      // dispatch — turning "a history failure never fails the dispatch" into its exact opposite.
      io.err(`could not compute the blast radius (${err.message}); briefs will carry no coupling section`)
    }

    const src = await generatePhaseWorkflow({
      runId,
      phase,
      tasks: phaseTasks,
      neighbours,
      maxParallel: resolved.maxParallel,
      tierModels,
      planPath,
      baseBranch,
      constraints: parseConstraints(planMarkdown),
      caveman: resolved.caveman,
      effort: resolved.agents.implementer.effort ?? '',
    })
    io.out(src)
    return 0
  }

  if (command === 'dispatch') {
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId} — run init-run first`); return 4 }
    const phase = Number(flags.phase)
    const phaseTasks = (plan.tasks ?? []).filter((t) => t.phase === phase)
    if (phaseTasks.length === 0) { io.out(`no tasks for phase ${printable(flags.phase)} in run ${runId}`); return 4 }

    // The run branch every sandbox is cut from — recorded by `init-run`. Absent means no branch
    // was ever confirmed for this run, and a clone of `origin/<undefined>` cannot be built, so a
    // dispatch would fail identically inside every teammate's `makeSandbox`. Refused here instead.
    const runBranch = typeof plan.runBranch === 'string' ? plan.runBranch : null
    if (!runBranch) {
      io.out(`run ${printable(runId)} has no recorded run branch — check out its branch and re-run init-run before dispatching`)
      return 4
    }

    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2

    const adapter = resolveHarness(flags, io)
    if (!adapter) return 2

    const probe = await adapter.probe({})
    if (!probe.ok) { io.out(`${probe.reason}\n${probe.fix}`); return 2 }

    const { sandboxMode, network, timeoutMinutes, tierModels } = harnessSettings(resolved, adapter.name)

    // The plan path the brief points at AND the plan `completeEnforcement` runs `complete` against.
    // It must resolve to a real path: `complete --plan '' --enforcement-only` exits 2 for a missing
    // argument, and the driver reads any code that is not 3 as a pass — so an empty plan would
    // SILENTLY disable enforcement for every task. When `--plan` is omitted (or a bare `--plan`
    // parses as `true`), fall back to the plan path `init-run` recorded in plan.json — which is the
    // run's plan by definition — and refuse the whole dispatch when neither yields one, rather than
    // dispatch teammates whose work nothing enforces.
    const flagPlan = (flags.plan === true || flags.plan == null) ? '' : String(flags.plan)
    const recordedPlan = typeof plan.planPath === 'string' ? plan.planPath : ''
    const planPath = flagPlan || recordedPlan
    if (planPath === '') {
      io.out(`run ${printable(runId)} has no plan path to enforce against — pass --plan <path>, or re-run init-run so plan.json records one`)
      return 2
    }
    const baseBranch = flags.base === true ? '' : (flags.base ?? '')
    const planMarkdown = await planAtAnchor(root, planPath, flags, io)
    if (planMarkdown === PLAN_READ_REJECTED) return 2
    const constraints = parseConstraints(planMarkdown)
    const composeBriefFor = (task) => composeBrief({
      task: { ...task, branch: taskBranchName(runId, task.id) },
      runId, planPath, baseBranch, constraints, caveman: resolved.caveman,
    })

    // Runs the existing `complete --enforcement-only` code path in `root` and returns its exit
    // code — the same check the phase gate recomputes. Output is swallowed: the driver reads only
    // the code, and a `3` triggers its one enforcement resume with the fixed refusal.
    const completeEnforcement = (taskId) => runCli(
      ['complete', '--run', runId, '--task', taskId, '--plan', planPath,
        ...(baseBranch ? ['--base', baseBranch] : []), '--enforcement-only', '--root', root],
      { out: () => {}, err: () => {} },
    )

    const { results, orphaned } = await dispatchPhase({
      adapter,
      git: (args, opts) => defaultGitExec(args, { cwd: root, ...opts }),
      runRepo: root,
      runId,
      runBranch,
      phaseTasks,
      maxParallel: resolved.maxParallel,
      sandboxMode,
      network,
      timeoutMinutes,
      tierModels,
      effortFor: () => resolved.agents.implementer.effort || undefined,
      composeBriefFor,
      personaFor,
      runDir: runDir(root, runId),
      completeEnforcement,
    })

    // Each session record is stamped with the harness that produced it, so `sessions` can name a
    // harness per row. The driver owns every other field; this only adds `harness`.
    const dispatchSessionsDir = path.join(runDir(root, runId), 'sessions')
    for (const task of phaseTasks) {
      const file = path.join(dispatchSessionsDir, `${task.id}.json`)
      try {
        const record = JSON.parse(await readFile(file, 'utf8'))
        record.harness = adapter.name
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
      } catch { /* a task that produced no record has nothing to stamp */ }
    }

    // Append each result to status.json exactly as the Workflow path's post-processing does: a
    // returned result sets the task's state to its status, and a task that produced nothing is
    // `orphaned`. No recorded PASS is consulted; this only reflects what the phase produced.
    const status = await readState(root, runId, 'status')
    if (status) {
      const byId = new Map(results.map((r) => [r.taskId, r]))
      for (const task of status.tasks ?? []) {
        if (byId.has(task.id)) task.state = byId.get(task.id).status
        else if (orphaned.includes(task.id)) task.state = 'orphaned'
      }
      await writeState(root, runId, 'status', status)
    }

    for (const r of results) io.out(`${printable(r.taskId)}: ${printable(r.status)}`)
    for (const id of orphaned) io.out(`${printable(id)}: orphaned`)
    return 0
  }

  if (command === 'dispatch-reviews') {
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2
    const adapter = resolveHarness(flags, io)
    if (!adapter) return 2

    // The lenses and per-lens prompts come from `review-dispatch`, unchanged: this reuses that
    // command's output rather than re-deriving it, so both dispatch paths agree on what a phase's
    // reviewers are. Its stdout is the JSON spec; a non-zero exit forwards its message and code.
    const captured = []
    const phaseArgs = flags.phase && flags.phase !== true ? ['--phase', flags.phase] : []
    const modelArgs = flags.models && flags.models !== true ? ['--models', flags.models] : []
    const code = await runCli(
      ['review-dispatch', '--run', runId, ...phaseArgs, ...modelArgs, '--root', root],
      { out: (t) => captured.push(t), err: (t) => io.err(t) },
    )
    if (code !== 0) { io.out(captured.join('\n')); return code }
    const spec = JSON.parse(captured.join('\n'))

    const probe = await adapter.probe({})
    if (!probe.ok) { io.out(`${probe.reason}\n${probe.fix}`); return 2 }

    const { network, timeoutMinutes } = harnessSettings(resolved, adapter.name)
    const timeoutMs = (Number(timeoutMinutes) > 0 ? Number(timeoutMinutes) : 30) * 60_000
    const persona = await personaFor('reviewer')
    const reviewSessionsDir = path.join(runDir(root, runId), 'sessions')
    await mkdir(reviewSessionsDir, { recursive: true })

    // One reviewer per lens, in parallel, cwd at the project root — read-only, each creating its
    // own scratch worktree outside the repo. Nothing is written to status or results here;
    // `collect-reviews` reads the findings files the reviewers write and is unchanged.
    await runPool(spec.reviewers, resolved.maxParallel, async (reviewer) => {
      const base = path.join(reviewSessionsDir, `review-${reviewer.lens}`)
      const handle = await adapter.spawn({
        sandbox: { cwd: root, meta: { mode: 'full' } },
        prompt: `${persona}\n\n${reviewer.prompt}`,
        model: reviewer.model,
        effort: reviewer.effort,
        network,
        schemaPath: `${base}.schema.json`,
        resultPath: `${base}.result.json`,
        streamPath: `${base}.stream.jsonl`,
        errPath: `${base}.stderr.log`,
      })
      await handle.sessionId
      await waitForExit(handle.child, timeoutMs)
    })
    io.out(`dispatched ${spec.reviewers.length} reviewer${spec.reviewers.length === 1 ? '' : 's'} for phase ${printable(spec.phase)}`)
    return 0
  }

  if (command === 'dispatch-integrator') {
    // Refuses unless the phase holds a recorded PASS. Unlike a teammate-facing decision, the
    // integrator is dispatched by the orchestrator after the gate it itself ran wrote this record,
    // so reading it here is the orchestrator confirming its own prior verdict, not trusting an
    // enforced party. No PASS means the gate has not passed, and nothing may merge.
    //
    // The record is found by its `phaseName`, NOT by the raw `--phase` used as a KEY. `gate` keys
    // its record under `String(ctx.currentPhase ?? phaseName)` — the NUMERIC derived phase for
    // every phase after the first — while it stores the manifest key it selected checks under as
    // `phaseName` on the record itself. Looking up `status.gates['default']` therefore missed the
    // real PASS for any phase >= 2 (recorded under e.g. `"2"`) and refused a gate that had passed.
    // Scanning for the entry whose `phaseName` matches, whatever numeric key it landed under, is
    // what mirrors how the gate actually wrote it. `Object.values` reads only own enumerable
    // properties, so a `__proto__`-shaped key cannot inject a fake PASS.
    const phaseName = flags.phase && flags.phase !== true ? flags.phase : 'default'
    const status = await readState(root, runId, 'status')
    const gates = status && typeof status.gates === 'object' && status.gates !== null ? status.gates : {}
    const passed = Object.values(gates).some(
      (g) => g && typeof g === 'object' && g.verdict === 'PASS' && g.phaseName === phaseName,
    )
    if (!passed) {
      io.out(`phase ${printable(phaseName)} of run ${printable(runId)} has no recorded PASS — run the gate to a PASS before dispatching the integrator`)
      return 4
    }

    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2
    const adapter = resolveHarness(flags, io)
    if (!adapter) return 2
    const probe = await adapter.probe({})
    if (!probe.ok) { io.out(`${probe.reason}\n${probe.fix}`); return 2 }

    const { network, timeoutMinutes } = harnessSettings(resolved, adapter.name)
    const timeoutMs = (Number(timeoutMinutes) > 0 ? Number(timeoutMinutes) : 30) * 60_000
    const persona = await personaFor('integrator')
    const integratorSessionsDir = path.join(runDir(root, runId), 'sessions')
    await mkdir(integratorSessionsDir, { recursive: true })
    const base = path.join(integratorSessionsDir, 'integrator')
    const handle = await adapter.spawn({
      sandbox: { cwd: root, meta: { mode: 'full' } },
      prompt: persona,
      network,
      schemaPath: `${base}.schema.json`,
      resultPath: `${base}.result.json`,
      streamPath: `${base}.stream.jsonl`,
      errPath: `${base}.stderr.log`,
    })
    await handle.sessionId
    await waitForExit(handle.child, timeoutMs)
    io.out(`dispatched integrator for phase ${printable(phaseName)}`)
    return 0
  }

  if (command === 'message') {
    // `--text` is REQUIRED, so `missingArgs` has already refused an absent, bare (`true`) or empty
    // (`''`) value with exit 2 before this handler runs — `text` is a non-empty string here.
    const text = flags.text
    const messageSessionsDir = path.join(runDir(root, runId), 'sessions')
    const file = path.join(messageSessionsDir, `${flags.task}.json`)
    let record
    try {
      record = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      io.out(`no session recorded for task ${printable(flags.task)} in run ${printable(runId)}`)
      return 4
    }
    if (typeof record.sessionId !== 'string' || record.sessionId === '') {
      io.out(`task ${printable(flags.task)} has no session id to resume`)
      return 4
    }
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2
    const adapter = resolveHarness(flags, io)
    if (!adapter) return 2

    // SIGTERM the task's live process group first, if the record names one, so the resume never
    // races a still-running turn. The driver records a pid only while a child is in flight, so an
    // absent or dead pid means there is nothing to signal.
    if (Number.isInteger(record.pid) && pidAlive(record.pid)) {
      killProcess({ pid: record.pid }, 'SIGTERM')
    }

    const { network, timeoutMinutes } = harnessSettings(resolved, adapter.name)
    const timeoutMs = (Number(timeoutMinutes) > 0 ? Number(timeoutMinutes) : 30) * 60_000
    const base = path.join(messageSessionsDir, `${flags.task}`)
    const handle = await adapter.resume({
      sandbox: record.sandbox,
      sessionId: record.sessionId,
      message: text,
      network,
      schemaPath: `${base}.schema.json`,
      resultPath: `${base}.result.json`,
      streamPath: `${base}.stream.jsonl`,
      errPath: `${base}.stderr.log`,
    })
    await handle.sessionId
    await waitForExit(handle.child, timeoutMs)
    io.out(`resumed ${printable(flags.task)}`)
    return 0
  }

  if (command === 'sessions') {
    const sessDir = path.join(runDir(root, runId), 'sessions')
    let entries
    try {
      entries = await readdir(sessDir)
    } catch {
      io.out(`no sessions for run ${printable(runId)}`)
      return 1
    }
    // Only the per-task records (`<taskId>.json`), never the sidecar files a driver writes beside
    // them (`<taskId>.schema.json`, `<taskId>.result.json`, and the `.stream.jsonl`/`.stderr.log`).
    const taskFiles = entries
      .filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json') && !f.endsWith('.result.json'))
      .sort()
    if (taskFiles.length === 0) { io.out(`no sessions for run ${printable(runId)}`); return 1 }

    const header = ['task', 'harness', 'session', 'state', 'elapsed', 'tokens']
    const rows = [header]
    for (const fileName of taskFiles) {
      let record
      try {
        record = JSON.parse(await readFile(path.join(sessDir, fileName), 'utf8'))
      } catch { continue }
      const taskId = record.taskId ?? fileName.replace(/\.json$/, '')
      const tokens = totalTokens(record.usage)
      const elapsed = Number.isFinite(record.startedAt) && Number.isFinite(record.updatedAt)
        ? `${Math.round((record.updatedAt - record.startedAt) / 1000)}s`
        : '—'
      rows.push([
        printable(String(taskId)),
        printable(String(record.harness ?? '—')),
        printable(String(record.sessionId ?? '—')),
        printable(String(record.state ?? '—')),
        elapsed,
        tokens == null ? '—' : String(tokens),
      ])
    }
    const widths = header.map((_, i) => Math.max(...rows.map((r) => r[i].length)))
    for (const r of rows) {
      io.out(r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd())
    }
    return 0
  }

  if (command === 'doctor') {
    const git = createGit({ cwd: root })
    // The plan is read from the WORKING TREE here, not from the anchor commit the gate reads
    // it at. The gate's reason for reading it from git — the enforced party must not choose
    // what is enforced — does not apply to a report that enforces nothing, and a diagnostic
    // that cannot run until the plan is committed is useless at exactly the moment a run is
    // going wrong.
    let tasks = []
    try {
      tasks = assignPhases(parsePlan(await readFile(path.resolve(root, flags.plan), 'utf8')))
    } catch (err) {
      io.out(`cannot read the plan at ${flags.plan}: ${err.message}`)
      return 2
    }

    // `--run-branch` exists because the failure most worth diagnosing is the one where the
    // main worktree was moved off the run branch: in that state `currentBranch` reports the
    // wrong branch, and every task diff computed from it would be nonsense. Default to the
    // current branch, which is right whenever nothing moved it.
    //
    // NULL IS PASSED THROUGH DELIBERATELY, not defaulted to a name. `currentBranch` answers null
    // on a detached HEAD, and that is one of the states this report exists to describe — refusing
    // here, the way `derive` does, would silence the diagnosis at the moment it is most wanted.
    // `collectDoctorReport` raises it as a problem instead. It must not be turned back into a
    // string here: the string that state used to produce was `HEAD`, and `refs/heads/HEAD` is a
    // creatable ref, so a detached repository compared equal to a run branch named `HEAD` and the
    // report said `no problems found`.
    const runBranch = typeof flags['run-branch'] === 'string' && flags['run-branch'] !== ''
      ? flags['run-branch']
      : await git.currentBranch()

    // The anchor is what tells an INTEGRATED branch from an empty one: both have an empty diff
    // against their own fork point. What separates them is the same predicate the gate's fileset
    // check applies — whether a merge on the run branch's own first-parent chain, inside
    // anchor..run, named this branch's sha as a secondary parent AND that merge's own diff
    // carried at least one of the task's DECLARED files. Bare membership in `mergedBranchTips` is
    // no longer the test on either side: a sha shared with a sibling used to read as landed for
    // any task that pointed at it. Building that index needs both the anchor and the run sha, and
    // without these two arguments `collectDoctorReport` leaves `landed` false for every task, so
    // every merged branch is reported as NO CHANGES — the report's loudest problem, on the run's
    // healthiest state.
    //
    // Taken from `derive`, so this reads the same anchor the gate enforces at rather than a
    // second computation that could disagree with it. It is allowed to FAIL: `doctor` must keep
    // working in the states the gate refuses to run in — the main worktree parked on the base
    // branch, a plan not committed at the anchor — which are exactly the moments an operator
    // needs it. When it fails, the report degrades to its previous behaviour and says so; a
    // silent degradation would leave the reader believing an integrated branch carries nothing.
    let anchorSha = null
    let derivedRunSha = null
    let anchorNote = null
    const relPlan = path.isAbsolute(flags.plan)
      ? path.relative(root, flags.plan).split(path.sep).join('/')
      : flags.plan
    try {
      const derived = await derive(root, runId, { ...flags, plan: relPlan })
      // `--run-branch` names a branch that may not be the one `derive` computed from, and an
      // anchor for a different branch is not this report's anchor. Refused rather than mixed.
      if (derived.runBranch === runBranch) {
        anchorSha = derived.anchorSha
        derivedRunSha = derived.runSha
      } else {
        anchorNote = `the report is about ${runBranch} but the main worktree is on ${derived.runBranch}`
      }
    } catch (err) {
      anchorNote = err.message
    }

    let report
    try {
      report = await collectDoctorReport({
        git,
        runId,
        runBranch,
        baseBranch: await resolveBaseBranch(git, flags.base),
        tasks,
        repoRoot: root,
        anchorSha,
        runSha: derivedRunSha,
      })
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`doctor could not read the repository: ${err.message}`)
      return 2
    }
    io.out(renderDoctor(report))
    if (anchorNote) {
      io.out(
        `note: could not derive the run anchor (${anchorNote}) — an integrated branch is reported`
        + ' above as having no changes, because without the anchor nothing tells the two apart',
      )
    }
    // 1 on problems, mirroring the gate, so a caller can branch on the exit code. It is still
    // a report: nothing is recorded, and no verdict is issued or implied.
    return report.problems.length === 0 ? 0 : 1
  }

  if (command === 'liveness') {
    const git = createGit({ cwd: root })
    // Same reasoning as `doctor`: the plan is read from the working tree, because a report that
    // enforces nothing has no reason to read it at the anchor, and a diagnostic that needs a
    // committed plan is useless at the moment a run is going wrong.
    let tasks = []
    try {
      tasks = assignPhases(parsePlan(await readFile(path.resolve(root, flags.plan), 'utf8')))
    } catch (err) {
      io.out(`cannot read the plan at ${flags.plan}: ${err.message}`)
      return 2
    }

    const staleMinutes = numericWindow(flags.stale, DEFAULT_STALE_MINUTES)
    if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
      io.out(`--stale takes a positive number of minutes, got ${JSON.stringify(flags.stale)}`)
      return 2
    }

    // Existence only, never the contents. The constraint that no CHECK may read `.fleetmates/`
    // binds the checks whose verdict must not be influenced by the agents they enforce; this is a
    // report that records nothing and decides nothing, and the state it reads is a directory name
    // the orchestrator created, not a claim a teammate wrote. The exception is stated here rather
    // than left to look like an oversight.
    //
    // Without it a mistyped run id is the quietest failure this command has: `--run r11` for a run
    // named `r1` matches no branch and no worktree, so every row takes the not-started path and
    // the heartbeat reads as an all-clear for a run nothing ever looked at.
    try {
      await stat(runDir(root, runId))
    } catch {
      io.out(
        `run ${runId} has no directory under ${NAMES.stateDir} — check --run, because a run id that`
        + ' matches nothing produces a report about no teammate at all',
      )
      return 2
    }

    // The current phase's tasks only. An earlier phase's teammates have returned, and a later
    // phase's have not been dispatched; reporting either as stalled would be noise on every run.
    //
    // There is deliberately no fallback to "every task in the run". Three states reach here with
    // no phase to name, and rows for all of them is what made a finished run print a full board of
    // stalls and exit 1 — the supervision skill's signal that a teammate has HUNG, raised on a run
    // whose teammates all returned. None of the three is a hang, so each is stated instead:
    //
    //   - the derivation FAILED (the main worktree parked on the base branch, a plan absent from
    //     the anchor). Surfaced the way `doctor` surfaces the same failure, not swallowed: without
    //     it the output was byte-identical to a real stall report.
    //   - `derivePhase` refused to name a phase (`phaseError`: phases integrated out of order, a
    //     plan parsing to zero tasks at the anchor).
    //   - every phase is integrated, which is a finished run and not a stall.
    //
    // The first two exit 2 — this report could not be produced — rather than 0 or 1, because both
    // of those are assertions about teammates that nothing here measured.
    let derived = null
    let deriveError = null
    try {
      derived = await derive(root, runId, { ...flags, plan: flags.plan })
    } catch (err) {
      deriveError = err.message
    }
    const phaseProblem = deriveError ?? derived?.phaseError ?? null
    if (phaseProblem) {
      io.out(
        `liveness could not derive the current phase: ${phaseProblem}`
        + ' — without a current phase this report cannot tell a hung teammate from a finished one,'
        + ' so it reports nothing rather than raising a stall it has not measured',
      )
      return 2
    }
    if (derived.currentPhase == null) {
      io.out(`every phase of run ${runId} is integrated — no teammate of this run is expected to be working`)
      return 0
    }
    const subject = tasks.filter((t) => t.phase === derived.currentPhase)
    // The phase is derived from the plan at the ANCHOR; these rows come from the plan in the
    // WORKING TREE. Amending a plan mid-run is a documented procedure in this plugin — `plan-drift`
    // exists because it happens — and an amendment that drops the derived phase's tasks left this
    // printing a bare header at exit 0: an all-clear covering nobody. Same class as the three
    // states above, so it gets the same answer.
    if (subject.length === 0) {
      io.out(
        `the plan in the working tree has no task in phase ${derived.currentPhase}, which is the`
        + ` phase derived from the plan at the anchor — reporting nothing rather than an all-clear`
        + ' covering no teammate. Run plan-drift to see what changed.',
      )
      return 2
    }

    // Worktree paths come from git rather than from `.fleetmates/`, which is written by the very
    // teammates being reported on. This is NOT a claim that the path is trustworthy: `git worktree
    // list` reports whatever path was passed to `git worktree add`, so the directory is still the
    // teammate's choice, and `liveness.mjs`'s header concedes both signals are forgeable anyway.
    // What it buys is narrower and worth stating exactly — the report follows the directory git
    // has checked out for that branch right now, so redirecting it means moving a real worktree
    // rather than editing a JSON file the teammate already owns.
    const byBranch = new Map()
    for (const wt of await git.worktrees()) {
      if (wt.branch) byBranch.set(wt.branch, wt.path)
    }

    const tips = {}
    const touches = {}
    for (const task of subject) {
      const branch = taskBranchName(runId, task.id)
      if (await git.branchExists(branch)) {
        const sha = await git.resolveRef(`refs/heads/${branch}`)
        tips[task.id] = { branch, at: await git.commitTime(sha) }
      }
      const dir = byBranch.get(branch)
      if (dir) {
        // The project's own ignore rules prune the walk. A failure here is not fatal: an empty set
        // walks everything, which can only floor the row into `unknown` — the honest answer — and
        // never invent freshness. The likeliest cause is the worktree directory being gone, which
        // the walk itself already treats as no measurement.
        const ignored = new Set(await git.ignoredPaths(dir).catch(() => []))
        const walked = await newestMtime(dir, { ignored })
        touches[task.id] = { branch, at: walked.at, floored: walked.floored }
      }
    }

    const rows = livenessRows({ tasks: subject, tips, touches, now: Date.now(), staleMinutes })
    io.out(renderLiveness(rows, { staleMinutes }))

    // Said before the exit code is decided, and independently of it: precedence chooses the code,
    // never what the operator is told. A board carrying both a stall and an unmeasured row reports
    // both.
    for (const [reason, explanation] of UNMEASURED_REASONS) {
      // Same plan-authored ids `renderLiveness` wraps, reaching a terminal by a second route —
      // wrapping only the renderer would leave this line as the way to erase what it printed.
      const names = rows.filter((row) => row.unknownReason === reason).map((row) => printable(row.taskId))
      if (names.length > 0) io.out(`freshness was not measured for ${names.join(', ')}: ${explanation}`)
    }

    // Precedence is deliberate, and the two codes answer different questions. A stall is a
    // MEASUREMENT and the one thing a supervisor must act on, so it wins outright: masking a
    // measured hang behind an unrelated unmeasured row would lose the signal this command exists
    // for. Every row and every explanation is printed either way, so the ordering hides nothing.
    //
    // Exit 1 on a stall mirrors `doctor`. It remains a report: it records nothing, and no verdict
    // is issued or implied.
    if (hasStall(rows)) return 1
    // Freshness that was never measured is not an all-clear. Exit 2 is what this command already
    // returns wherever it could not measure, rather than 0, which would say every teammate is fine
    // on the strength of something nobody looked at.
    if (hasUnknown(rows)) return 2
    return 0
  }

  if (command === 'rebuild-state') {
    // Refused by default: the gate history is the one thing git cannot vouch for, so replacing
    // a live run's status would destroy the only record of what passed and what it cost.
    // Recovery is the case this serves, and recovery starts from a run whose files are gone.
    const existing = await readState(root, runId, 'status')
    if (existing && flags.force !== true) {
      io.out(`run ${runId} already has state; rebuilding would discard its gate history, which cannot be reconstructed from git. Pass --force if that is what you want.`)
      return 2
    }

    let ctx
    try {
      ctx = await derive(root, runId, flags)
    } catch (err) {
      io.out(`cannot rebuild the state: ${err.message}`)
      return 2
    }

    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2

    // `rebuild-state` already takes `--plan` and reads it at the same anchor `derive` above
    // just used to parse the task list, so `destination`, `notYetSpecified` and `outOfScope`
    // are re-derived the same way `init-run` derives them the first time — rather than left to
    // fall out as `undefined`, which is what writing `plan` verbatim below would do: none of
    // those three keys exists on `rebuildRunState`'s output, and `writePlan`'s fill-if-absent
    // rule only carries a field FORWARD from the previous plan.json, it does not invent one
    // that was never written into the object passed in.
    const rebuiltPlanPath = path.relative(root, path.resolve(root, flags.plan)).split(path.sep).join('/')
    // RECOVERY, NOT REFUSAL — decided 2026-08-22. This command exists to restore state after
    // `.fleetmates/` is lost, and the plan it reads is the one COMMITTED AT THE ANCHOR, not the
    // one on disk. A section defect there is therefore unfixable by the operator: correcting
    // plan.md in the working tree does not change a historical commit, so refusing would leave
    // the run permanently unrecoverable for a reason nobody can act on. `init-run` still
    // refuses — it reads the working tree, where a defect IS fixable, and refusing is how a bad
    // plan gets caught before a run starts. Here the three section fields degrade to
    // `null` / `[]` / `[]` and everything git can vouch for is rebuilt regardless.
    //
    // The warning names this command, the anchor, and where the plan was read from, because
    // without those an operator who has already corrected plan.md cannot tell why it persists.
    // Only a `PlanSectionError` degrades: `planSectionsRefusal` re-throws anything else, and a
    // plan MISSING at the anchor is a different failure that `derive` above has already made
    // impossible to reach here.
    let sections = { destination: null, notYetSpecified: [], outOfScope: [] }
    try {
      const planMarkdown = await ctx.git.fileAtCommit(ctx.anchorSha, rebuiltPlanPath)
      sections = parsePlanSections(planMarkdown)
    } catch (err) {
      const refusal = planSectionsRefusal(err)
      io.out(`rebuild-state: the plan at the anchor ${printable(ctx.anchorSha)} has a section defect, `
        + 'so destination, notYetSpecified and outOfScope were rebuilt as empty. Everything else '
        + 'below came from git and is unaffected. The plan was read from git at that anchor, not '
        + `from ${printable(rebuiltPlanPath)} in the working tree, so correcting the file on disk `
        + 'will not clear this — only a plan committed at the anchor would.')
      io.out(refusal)
    }

    const git = createGit({ cwd: root })
    const info = {}
    for (const task of ctx.tasks ?? []) {
      const branch = resolveTaskBranch(task, runId)
      const entry = { exists: false, contributes: false, merged: false }
      if (branch && await git.branchExists(branch)) {
        entry.exists = true
        const sha = await git.resolveRef(`refs/heads/${branch}`)
        // Merged means landed: on the run branch AND past the anchor. The same pair of
        // questions `fileset` asks, for the same reason — a branch parked at the anchor is an
        // ancestor of the run branch without ever having carried anything.
        entry.merged = await git.isAncestor(sha, ctx.runSha) && !(await git.isAncestor(sha, ctx.anchorSha))
        const forkPoint = await git.mergeBase(ctx.runSha, sha)
        entry.contributes = (await git.changedFiles({ base: forkPoint, branch: sha })).length > 0
      }
      info[task.id] = entry
    }

    const { plan, status } = rebuildRunState({
      runId,
      tasks: ctx.tasks ?? [],
      info,
      maxParallel: resolved.maxParallel,
      currentPhase: ctx.currentPhase,
    })
    // `rebuildRunState` reconstructs what git can vouch for, and git carries neither of these:
    // they are the run's own bookkeeping. Writing its output verbatim DROPPED both, so the
    // documented first recovery step — the one reached precisely when things are already wrong —
    // silently disarmed the stop-time hook: the same payload that blocked before a rebuild
    // allowed after it, and `complete --enforcement-only` went from 3 to a permanent 4.
    //
    // `planPath` is re-derived, because `--plan` is a required argument of this command and the
    // operator naming it is an explicit statement of which plan this run follows.
    //
    // `runBranch` is CARRIED FORWARD when the old plan.json had one, and derived only when it did
    // not. This command is the last writer that could still overwrite a good value, and it does
    // real harm: run from an unrelated branch it replaced a correct `run-branch` with whatever was
    // checked out, and because fill-if-absent then protects the new value, no later command could
    // repair it — enforcement permanently off, from the command an operator reaches for when
    // things are already broken. "The operator asked for a rebuild" is not consent to re-point the
    // run at a different branch; they asked to rebuild task states from git, and git cannot tell
    // anyone which branch a run belongs to. So the fill-if-absent rule holds here too, with no
    // exception anywhere, and recovery still works: the case this command exists for is a run
    // whose directory is GONE, where the field is absent and gets derived.
    //
    // Carrying the existing value forward and deriving only when there is none is `writePlan`'s
    // rule, shared with every other plan write rather than restated here — this command had its
    // own copy of it, which is how it became the writer that could still overwrite a good value.
    const rebuiltRecord = await writePlan(
      root, runId,
      {
        ...plan,
        planPath: rebuiltPlanPath,
        destination: sections.destination,
        notYetSpecified: sections.notYetSpecified,
        outOfScope: sections.outOfScope,
      },
      { candidateRunBranch: ctx.runBranch, baseBranch: ctx.baseBranch },
    )
    await writeState(root, runId, 'status', status)

    // Task ids come from the plan file a planning agent wrote; `printable` keeps a crafted id
    // from redrawing this listing.
    for (const t of status.tasks) io.out(`${printable(t.id)}  ${printable(t.state)}`)
    // Said out loud, because a rebuild that quietly changed what the hook can confirm is exactly
    // the failure being fixed here.
    // Reports what was WRITTEN, not what was derived — those differ now that an existing value is
    // carried forward, and a line naming the checked-out branch while the file kept another one
    // would be the same class of lie this whole guard exists to remove.
    io.out(
      `rebuilt plan.json with planPath ${printable(rebuiltPlanPath)} and run branch `
      + `${rebuiltRecord.runBranch === null ? '(none)' : printable(rebuiltRecord.runBranch)}`
      + `${rebuiltRecord.carried === null ? '' : ' (kept from the previous plan.json)'}`,
    )
    io.out('rebuilt from git: no gate history, so every phase must be gated again before anything is reported done')
    return 0
  }

  if (command === 'prune-run') {
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out(`no ${GATE_FILE} — without a gate there is no passing phase, so nothing is prunable`); return 4 }

    // The same evidence `finish` takes, for the same reason: a phase whose only outstanding check
    // is a review no runner can run would otherwise never be prunable, however many times it was
    // actually reviewed.
    const supplied = await readSuppliedPhases(flags, io)
    if (supplied === SUPPLIED_REJECTED) return 2

    let ctx
    try {
      ctx = { cwd: root, previewLink: previewLinks(config), ...(await derive(root, runId, flags)) }
    } catch (err) {
      io.out(`cannot decide what is prunable: ${err.message}`)
      return 4
    }
    await rememberRunBranch(root, runId, ctx.runBranch, ctx.baseBranch)

    // Which phases hold a passing gate is RECOMPUTED, never read from `status.gates`. That file
    // is written by the agents whose worktrees are about to be removed, and a phase marked PASS
    // there is exactly how a fix round would lose the context it still needs.
    const enforcementOnly = flags['enforcement-only'] === true
    const phases = [...new Set((ctx.tasks ?? []).map((t) => t.phase))].sort((a, b) => a - b)
    reportUnmatchedSuppliedPhases(io, supplied, phases)
    // Computed either way: it decides whether the flag is refused, and — when it was not passed —
    // whether the announcement should recommend it at all.
    const refusal = enforcementOnlyRefusal(config, phases)
    if (enforcementOnly) {
      if (refusal) { io.out(refusal); return 2 }
    } else {
      const total = phases.reduce((n, p) => n + commandChecks(checksForPhase(config, String(p))).length, 0)
      announceCommandChecks(io, 'prune-run', total, phases.length, refusal === null)
    }

    const passedPhases = []
    for (const phase of phases) {
      const checks = checksForPhase(config, String(phase))
      const forPhase = suppliedForPhase(supplied, phase)
      const invalid = validateSuppliedResults(forPhase, checks)
      if (invalid) { io.out(`phase ${phase}: ${invalid}`); return 2 }
      const results = mergeSuppliedResults(await runPhaseChecks(checks, { ...ctx, currentPhase: phase }, enforcementOnly), forPhase)
      const verdict = aggregateVerdict(results)
      // This command reports a verdict only as a phase's presence in the prune plan below, so
      // without this the checks that did not run would leave no trace in the output at all.
      reportSkipped(io, phase, verdict)
      // A PASS resting on a check THIS FLAG dropped does not authorise a deletion. `--yes` below
      // runs `git worktree remove --force`, which discards whatever a teammate has not committed
      // and removes the worktree a `retry` needs to resume that teammate — and unlike a wrong
      // report, that is not recoverable by running the command again with better flags. The same
      // rule that makes this command recompute rather than read `status.gates` (see above)
      // applies to its own cheap mode: prune on evidence, never on an absence of it.
      //
      // Scoped to this flag's own skips, and to nothing else. A `skip` supplied through
      // `--results` is evidence the caller gave deliberately, and blocking on it offered a remedy
      // they could not follow — see ENFORCEMENT_ONLY_SKIPPED for the three sources and why only
      // one of them is this command's business.
      if (verdict.verdict !== 'PASS') continue
      const flagSkipped = results.filter((r) => r[ENFORCEMENT_ONLY_SKIPPED] === true).map((r) => r.name)
      if (flagSkipped.length > 0) {
        io.out(
          `phase ${phase} is not prunable: --enforcement-only left ${flagSkipped.length} check(s) unrun`
          + ` (${flagSkipped.map(printable).join(', ')}), and a worktree is removed only on checks that ran.`
          + ' Re-run without --enforcement-only to prune it.',
        )
        continue
      }
      passedPhases.push(phase)
    }

    const git = createGit({ cwd: root })
    const worktrees = await git.worktrees()
    // Liveness is read here and handed to the pure module as data. The candidates have to be
    // identified before their markers can be read, so `leakedPreviews` is called twice: once
    // with no live set to learn which paths are preview-shaped, and once inside
    // `selectPrunableWorktrees` with the answer. The first call is what decides which
    // directories are opened at all — no path outside a detached, branchless tm-preview-* under
    // the temp root is ever read.
    //
    // ONE root for both calls, resolved once. The two passes are the same identification run
    // twice, so disagreeing on the temp root is not a narrower result — it is the destructive
    // one. With the raw spelling here and the resolved one below, the candidate list came back
    // EMPTY on macOS and Windows, so no marker was read, so the live set was empty, and then the
    // resolved pass identified the preview and found nothing claiming it: a preview whose owner
    // is alive was reaped with its junctions still in place. Resolving in only one of the two
    // places is strictly worse than resolving in neither.
    const tempRoot = resolvedTempRoot()
    const previewCandidates = leakedPreviews(worktrees, { tempRoot }).map((p) => p.path)
    const livePreviews = await livePreviewPaths(previewCandidates)
    const plan = selectPrunableWorktrees({
      runId,
      worktrees,
      livePreviews,
      // git lists the main worktree first, always. Naming it explicitly beats matching it
      // against `root`, which can differ by symlink, drive-letter case, or trailing separator.
      mainWorktree: worktrees[0]?.path ?? null,
      taskPhases: Object.fromEntries((ctx.tasks ?? []).map((t) => [t.id, t.phase])),
      passedPhases,
      // The module stays pure and takes no view of where the system temp directory is, so the
      // caller supplies the root it observed. Without it, NOTHING is identified as a leaked
      // preview — a `tm-preview-*` worktree an operator keeps elsewhere on disk is theirs.
      // Resolved, not raw: git reports real paths, and the raw spelling misses every preview on
      // macOS and Windows. See resolvedTempRoot. The SAME value the candidate pass above used.
      tempRoot,
    })
    io.out(renderPrunePlan(plan))

    // Removing a worktree is not reversible from here, so the default is to say what would
    // happen. `--yes` is the caller stating the intent, in the same spelling every other
    // valueless flag in this CLI uses.
    if (flags.yes !== true) {
      io.out('dry run: nothing was removed. Re-run with --yes to remove the worktrees listed as prunable and delete each one\'s branch where it is already an ancestor of the run branch.')
      return 0
    }

    let failed = 0
    for (const w of plan.prunable) {
      try {
        await git.removeWorktree(w.path)
        io.out(`removed ${w.path}`)
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        failed += 1
        io.out(`could not remove ${w.path}: ${err.message}`)
        // Its branch is still checked out in a worktree git still knows about, so the deletion
        // below could not succeed anyway — `git branch -D` refuses a branch a registered
        // worktree holds. And a branch whose worktree survived is one an operator may still be
        // looking at. Falling through would turn one reported failure into two.
        continue
      }
      // The worktree is gone; its branch is scratch, but only once that is PROVED. A task branch
      // that is not an ancestor of the run branch carries commits that are in no other ref, and
      // `-D` — which is what `deleteBranch` runs, deliberately, because `-d` measures "merged"
      // against the caller's HEAD or upstream rather than against the run branch — would be the
      // last thing that ever saw them. The proof is the caller's job precisely because the
      // helper does not do it. The refusal is reported by name, like every other refusal this
      // command makes, so an operator who wanted the branch gone learns why it is still there.
      //
      // BOTH SIDES ARE SHAS, RESOLVED HERE, and that is the whole safety of it.
      //
      // QUALIFIED, because the proof and the deletion have to be about the SAME ref. Git resolves
      // a bare name through refs/tags/ BEFORE refs/heads/, warns on stderr only and exits 0
      // (`isAncestor` reads no stderr), while `git branch -D` resolves refs/heads only — so an
      // ancestry question asked on the bare name `w.branch` is answerable by a TAG while the
      // thing deleted is the branch. One ordinary `git tag fleetmates/r1/T1 <any commit the run
      // branch contains>`, which a teammate can create inside its own worktree, then turns this
      // guard into a rubber stamp: verified end to end, the unmerged branch was deleted and
      // `deleted …` printed. It also fires by accident wherever a release tag and a branch share
      // a name. This is the invariant scripts/git.mjs states as "every name that reaches a
      // ref-consuming git command goes through here first".
      //
      // FRESH, because `ctx.runSha` is a SNAPSHOT. `ctx` is built once by `derive` before any of
      // this command's phases run their checks, and each of those checks is an arbitrary shell
      // command bounded at fifteen minutes by default — this command announces them as the slow
      // part. Nothing re-resolves the run branch in between. Reproduced with a check that runs
      // `git update-ref refs/heads/<run branch> <pre-merge sha>` (note `git branch -f` is refused
      // for a checked-out branch and `update-ref` is not): against the snapshot the branch was
      // deleted and reported as contained, while `merge-base --is-ancestor` against the run
      // branch afterwards said it was not. So the run branch is resolved per iteration, at the
      // moment its answer is used, and the sha that is printed is the one that was proved
      // against. A snapshot is exactly as good as the assumption that nothing moved, and the
      // thing being decided is irreversible.
      //
      // WHAT REMAINS OPEN. This list is meant to be read as complete, so it leads with the item
      // that used to defeat the paragraph above — now closed, and kept precisely so a reader can
      // tell "closed" from "never considered" — and follows it with the ones that merely bound
      // it. Nothing below the first bullet is closed by anything in this file.
      //
      //   - WHICH REF IS THE RUN BRANCH. Closed at `derive`, by REFUSAL rather than by resolution,
      //     and recorded here because this list is read as complete. It took three attempts and
      //     each earlier one was reported as closed, so the wording below is deliberately about
      //     what is refused rather than about what is resolved.
      //
      //     Attempt one resolved HEAD symbolically, which killed the tag / `heads/<name>` /
      //     `refs/heads/refs/heads/<name>` plant but left `currentBranch` returning the string
      //     `HEAD` on a detached HEAD — and `refs/heads/HEAD` is a ref `git update-ref` creates
      //     without complaint. Attempt two returned null there instead, but still trusted
      //     `symbolic-ref`'s target to be a branch: `git symbolic-ref HEAD refs/tags/x` is
      //     accepted (git refuses only targets outside `refs/`), the `refs/heads/` strip is a
      //     no-op on such a ref, and `refs/heads/refs/tags/x` is creatable — so `deriveContext`
      //     read the planter's commit as the run branch. Measured on that revision, with HEAD at
      //     the real run tip and the tree clean, `ownership` went from FAIL naming a rogue commit
      //     to PASS.
      //
      //     Attempt three refused both of those, and was still permissive, because the round trip
      //     it added proves less than it appears to: `refs/heads/${runBranch}` reconstructs HEAD's
      //     own ref BYTE FOR BYTE, so it can only catch the branch moving between two
      //     subprocesses — never a disagreement about WHICH ref is meant. The divergence was at a
      //     CONSUMER: `derive` hands `deriveContext` the NAME, gate-runner.mjs:1703 passes that
      //     name on as the merge-preview base, and `qualifyBranch` returns any `refs/`-prefixed
      //     string unchanged. So HEAD at `refs/heads/refs/heads/run-branch` stripped to
      //     `refs/heads/run-branch`, which re-qualified to the REAL branch while `ctx.runBranchRef`
      //     stayed the planted one. Measured: `gate --phase 1` exited 0, verdict PASS, merge=pass,
      //     on a tree where merging the task branch into `ctx.runBranchRef` conflicts.
      //
      //     What closes it is `derive` refusing three states outright — HEAD detached, HEAD
      //     pointing anywhere but under `refs/heads/`, and a stripped name that is ITSELF a ref
      //     path — all three in `classifyHeadRef`, so a consumer cannot be handed a name two
      //     qualification rules disagree about. The round trip is kept for the honest
      //     two-subprocess race and is described as that and nothing more.
      //
      //     CLOSED. That consumer took the NAME rather than `ctx.runBranchRef`; it now takes
      //     `ctx.runBranchRef ?? ctx.runBranch`, so the guarantee no longer rests on the refusal
      //     above alone — a consumer handed a ref cannot misread which ref is meant. Pinned by a
      //     unit test on `runChecks` rather than end to end, because `classifyHeadRef` refuses
      //     that HEAD state and no CLI path can reach the consumer with such a name any more; the
      //     test builds the disagreement directly. The fallback keeps a caller that never
      //     resolved HEAD — a `--run-branch` named on the command line — on its old behaviour.
      //
      //     WHAT IS NOT THIS CODE'S DOING: under the `refs/tags/x` plant the `git branch -D`
      //     below fails on its own, with `fatal: HEAD not found below refs/heads!`, exit 128
      //     (measured). That is git declining to run `branch -D` at all in that state, not a
      //     guarantee anything here provides — `git worktree list` works fine in the same
      //     repository, which is why the force-removal a few lines up WAS reached. Do not read
      //     the surviving branch as evidence that this path was safe.
      //   - Proof-to-delete. The sha is proved and then deleted BY NAME, so a write to
      //     refs/heads/<branch> in between is deleted unproved. A compare-and-swap
      //     (`git update-ref -d <ref> <proved sha>`) would close it, and was DECIDED AGAINST on
      //     2026-09-13 after measuring what it gives up on git 2.55.0: `update-ref -d` deletes a
      //     branch a worktree still has checked out (exit 0, the worktree left on an unborn
      //     branch) where `branch -D` refuses with `used by worktree`, and it leaves
      //     `branch.<name>.*` config behind. That refusal is the one guard this loop leans on if
      //     the worktree removal above did not take; trading it for a two-command window is the
      //     wrong way round. This comment is the record, and the decision is not to re-litigate.
      //   - The run branch can still move between this resolve and the `-D` on the same
      //     iteration, and between one iteration and the next. Per-iteration shrinks that window
      //     to two git commands; it does not remove it. What is left is the honest race alone:
      //     the redirected-name case the first bullet used to pair this with is closed, so a move
      //     inside this window is now something that moved the real run branch.
      //   - The WORKTREE REMOVAL a few lines up is authorised by a verdict computed over
      //     SNAPSHOT ENDPOINTS. Not by a stale verdict: `passedPhases` is built by actually
      //     running this command's checks above, and the worktree list is re-read after them — a
      //     check that exits non-zero makes the phase FAIL and its worktree is not removed at
      //     all. What is snapshotted is the RANGE those checks measure, and it is the run-branch
      //     side, not the task-branch side. `runFilesetCheck` and `runOwnershipCheck` re-resolve
      //     `refs/heads/<task branch>` at check time, so a task branch that moved since `derive`
      //     is judged at its NEW sha — measured, by moving one mid-run: the fileset check read
      //     the moved sha, flipped from pass to `contributes no file changes past its fork
      //     point`, and the phase failed, so that worktree is not removed at all. `ctx.anchorSha`
      //     and `ctx.runSha` are the derive-time values, so a commit added to the RUN BRANCH
      //     mid-run is never examined by ownership — measured on the same repository: the branch
      //     advanced, `ctx.runSha` did not, and ownership passed without ever naming the new
      //     commit — and `mergedParentFiles` walks that same stale range. The existing fixture at
      //     tests/cli.test.mjs already demonstrates the consequence, by moving the run branch
      //     backward past the integration merge and watching the phase still pass and the
      //     worktree still go. `git worktree remove --force` discards whatever is uncommitted in
      //     that worktree regardless. Irreversible, and not re-proved the way the deletion below
      //     now is.
      try {
        const runSha = await git.resolveRef(ctx.runBranchRef)
        const branchSha = await git.resolveRef(`refs/heads/${w.branch}`)
        if (await git.isAncestor(branchSha, runSha)) {
          await git.deleteBranch(w.branch)
          // Both shas are named because they are what was actually proved. `-D` discards the
          // branch reflog and `deleteBranch` swallows git's own "Deleted branch … (was <abbrev>)",
          // and the worktree — whose own reflog is the other copy — was force-removed a few lines
          // up, so this line is the ONLY surviving handle for `git branch <name> <sha>`.
          io.out(`deleted ${w.branch} (${branchSha}), which ${printable(ctx.runBranch)} (${runSha}) contains`)
        } else {
          io.out(`left ${w.branch} in place: refs/heads/${w.branch} (${branchSha}) is not an ancestor of ${printable(ctx.runBranch)} (${runSha}), so deleting it would drop commits that are in no other branch`)
        }
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        failed += 1
        io.out(`could not delete ${w.branch}: ${err.message}`)
      }
    }

    // The leaked merge previews, reaped last and by a different route. They are NOT in `prunable`
    // — the `continue` in selectPrunableWorktrees that keeps them out is a deliberate second
    // barrier, so that a bug in this loop can never reach a worktree holding a task branch.
    //
    // Every one is stripped of its provisioned links FIRST. `git worktree remove --force` follows
    // a junction into its target and deletes the contents (see unlinkPreviewLinks), and a leaked
    // preview is exactly the one whose own teardown never ran, so it is exactly the one still
    // holding those junctions. A preview whose links cannot be removed is LEFT IN PLACE and
    // reported: an accumulated worktree costs disk, and the alternative costs the operator their
    // repository's build inputs.
    //
    // WHAT THIS SWEEP DOES AND DOES NOT CLOSE. It closes the junction hazard for a preview whose
    // owner is DEAD — the links it finds are the ones a killed gate's `finally` never tore down,
    // and they are gone before anything is removed. For a LIVE preview the sweep alone could
    // never close it, because a junction the owner creates in the window BETWEEN this sweep and
    // the removal below would still be followed. What closes that window for a preview held by
    // its OWNER MARKER is that such a preview does not reach this loop at all: `livePreviewPaths`
    // above found the marker its owner holds from before `git worktree add` registers the preview
    // until after `removeWorktree` deregisters it, and the preview is excluded from
    // `plan.previews` and reported as owned instead. The teardown is inside that span, not after
    // it: a preview mid-teardown still holds its junctions, and reading it as unowned there would
    // follow them.
    //
    // "Live" is NOT synonymous with "marker held", and the sentence above must not be read that
    // way. `livePreviewPaths` counts a vetted CLAIM as a holder exactly as it counts the marker,
    // and a claim is written per spawned pid long after the add — see the bullet below on the
    // listing window. A preview whose only holder is a claim written during the pass can
    // therefore reach this loop with a spawned check still inside it, and for that one the
    // junction argument above does not hold: the sweep is all there is, and it is not enough.
    //
    // THE RESIDUALS, stated as what is true rather than as what would be convenient.
    //
    //   - A pid can be RECYCLED. A marker naming a pid an unrelated process has since taken
    //     makes a dead preview read as live. That direction only leaves a directory on disk; it
    //     never destroys data, and `prune-run` can be run again once the pid is free.
    //   - A preview created by a gate from BEFORE this marker existed carries none, and is
    //     reaped as leaked. That is the pre-existing hazard, unchanged and no worse.
    //   - The worktree list and the markers are read once, above, and acted on here. A preview
    //     that appears in between is not in the list at all, so it cannot be reaped; a preview
    //     already in the list cannot acquire an OWNER MARKER, because its owner would have had to
    //     write that marker before the add that put it there.
    //   - It CAN acquire a CLAIM, and that is a real window, not a hypothetical one. A claim is
    //     written per spawned pid while a check runs, long after the add — and `livePreviewPaths`
    //     lists, vets and reads as separate syscalls, so a claim written after THAT preview's own
    //     listing is invisible to it and the preview reads as unowned and is reaped here. The
    //     window is one readdir wide per preview, not one sweep wide: the per-parent listing memo
    //     that made a mid-pass claim invisible to every later preview too is gone. See the
    //     vetting comment above `livePreviewPaths` for the same limit stated at the reading end.
    //
    // So the destructive direction — a live preview read as dead — is closed by construction for
    // the OWNER MARKER, because that marker is HELD across a span containing the whole span over
    // which the preview is observable, instead of being sampled at one instant. It is only
    // NARROWED for claims, by the bullet above. The two are not interchangeable, and this comment
    // said "closed by construction" of both before claims had a writer.
    //
    // WHAT THE PATTERN MATCHES, since the reaper is force-removing directories nobody named:
    // every detached, branchless worktree registered in this repository whose path lies under
    // the system temp root and whose final segment begins `tm-preview-`. That includes one an
    // operator created deliberately and left uncommitted work in — the leaf name is the whole
    // test. The dry run is the default and the plan is printed before anything is removed, so
    // the operator sees each path before `--yes`.
    for (const p of plan.previews ?? []) {
      try {
        await unlinkPreviewLinks(p.path)
      } catch (err) {
        // Registered but not on disk: no links exist to sweep, and the removal below is what
        // clears the registration. Blocking on it would deadlock the command forever — see
        // isMissingPreviewRoot.
        if (!isMissingPreviewRoot(err, p.path)) {
          failed += 1
          io.out(
            `left ${p.path} in place: its provisioned links could not be removed (${err.message}),`
            + ' and `git worktree remove --force` deletes the CONTENTS of a junction\'s target',
          )
          continue
        }
        io.out(`${p.path} is registered but its directory is gone: nothing to sweep, clearing the registration`)
      }
      try {
        await git.removeWorktree(p.path)
        io.out(`removed leaked preview ${p.path}`)
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        failed += 1
        io.out(`could not remove ${p.path}: ${err.message}`)
      }
    }
    return failed > 0 ? 1 : 0
  }

  if (command === 'finish') {
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out(`no ${GATE_FILE} — there is nothing to verify a phase against`); return 4 }

    // Read once, before any phase is computed, so a malformed file is refused before minutes of
    // check-running rather than after. Never persisted and never read back from `.fleetmates/`:
    // it fills in this run's pending checks and nothing else.
    const supplied = await readSuppliedPhases(flags, io)
    if (supplied === SUPPLIED_REJECTED) return 2

    let ctx
    try {
      ctx = { cwd: root, previewLink: previewLinks(config), ...(await derive(root, runId, flags)) }
    } catch (err) {
      io.out(`cannot verify the run: ${err.message}`)
      return 4
    }
    await rememberRunBranch(root, runId, ctx.runBranch, ctx.baseBranch)

    // Phases come from the plan at the anchor, not from `status.gates`. The recorded keys are
    // written by the agents being enforced, so a phase deleted from that file would simply not
    // be verified — the check would report on whatever remained and call the run finished.
    const phases = [...new Set((ctx.tasks ?? []).map((t) => t.phase))].sort((a, b) => a - b)
    reportUnmatchedSuppliedPhases(io, supplied, phases)

    const enforcementOnly = flags['enforcement-only'] === true
    // Computed either way: it decides whether the flag is refused, and — when it was not passed —
    // whether the announcement should recommend it at all.
    const refusal = enforcementOnlyRefusal(config, phases)
    if (enforcementOnly) {
      // Before any check runs, and before any phase reaches the summary below: a phase with no
      // enforcement check left to run would otherwise be summarised PASS on nothing but its own
      // skips, and reported as "ready to land".
      if (refusal) { io.out(refusal); return 2 }
    } else {
      const total = phases.reduce((n, p) => n + commandChecks(checksForPhase(config, String(p))).length, 0)
      announceCommandChecks(io, 'finish', total, phases.length, refusal === null)
    }

    const phaseResults = []
    for (const phase of phases) {
      // Every phase is computed as if it were current. `deriveContext` sets `currentPhase` to
      // the first UN-integrated phase, which is the right answer for a gate deciding whether to
      // advance and the wrong one here: an already-integrated phase would otherwise be skipped
      // by `fileset`, and skipping is what "verify the whole run" must never do.
      const phaseCtx = { ...ctx, currentPhase: phase }
      const checks = checksForPhase(config, String(phase))
      // Per phase, against that phase's own manifest block — evidence for phase 1 can never
      // satisfy phase 3, and a supplied result still may not name a computed check.
      const forPhase = suppliedForPhase(supplied, phase)
      const invalid = validateSuppliedResults(forPhase, checks)
      if (invalid) { io.out(`phase ${phase}: ${invalid}`); return 2 }
      const results = mergeSuppliedResults(await runPhaseChecks(checks, phaseCtx, enforcementOnly), forPhase)
      // `supplied` is carried into the summary so a reader can tell a recomputed pass from a
      // reported one. It changes no verdict: aggregateVerdict stays the only producer of those.
      phaseResults.push({ phase, supplied: forPhase.length > 0, verdict: aggregateVerdict(results) })
    }

    // No wrapper at this print site, because every value the table carries is wrapped where the
    // table is BUILT, in `renderRunSummary` (`scripts/finish.mjs`). Enumerated: the run id and
    // each failed/pending/skipped check name go through `printable` there; `entry.phase` and the
    // phase lists in the "not finished" lines are integers `assignPhases` produced; the verdict
    // is `aggregateVerdict`'s own `PASS`/`FAIL`; the rest of every line is a string literal.
    //
    // Wrapping at the build site is also the only place the table's real hazard can be closed.
    // `printableBlock` keeps every newline it is given, including a value's own, so a wrap here
    // stops a name from redrawing the table but not from ADDING a row shaped like one this CLI
    // wrote — and by then the name is already inside the block. A `printableBlock` here was
    // therefore a second pass over bytes already neutralised: removed by mutation, it changed no
    // byte of any output this suite produces and left every sanitising row green. It is gone
    // rather than kept as a layer no test can drive.
    io.out(renderRunSummary(runId, phaseResults))
    // `plan.json` is teammate-writable, same rule `writePlan` states about its own read: a
    // corrupt or wrong-shaped file must not crash the command that reports the verdict.
    //
    // The try is here for the READ. `readState` throws on unparseable JSON, and that is a throw
    // a try can catch. `renderPlanNotes` now defends its own input shape, so it is handed the
    // value verbatim: a `plan ?? {}` here used to stand in for a defense it did not have, and it
    // only ever covered null anyway — a wrong-shaped `notYetSpecified` MISRENDERED, which no try
    // can catch, so the fix belongs where the shape is known rather than at this call site. The
    // render stays inside the try regardless, because a function that must never crash the
    // verdict report is not a function to leave one refactor away from doing so.
    try {
      const plan = await readState(root, runId, 'plan')
      const notes = renderPlanNotes(plan)
      if (notes) {
        io.out(notes)
        // THE TWO HALVES OF THIS REPORT HAVE DIFFERENT SOURCES. The verdict above is computed
        // from the plan at the git anchor; these notes come from `plan.json`, written when
        // `init-run` last ran. Amend and commit the plan without re-running `init-run` and the
        // report describes two different versions of it at once — the fog count can name an
        // entry the current plan no longer contains, or miss one it now does. `plan.json` is
        // the reader this feature specified, so the fix is not to switch sources; it is to stop
        // presenting a stale half as current. Compared only when there is something to show,
        // and reported only when the two actually differ: an advisory printed on every run is
        // one an operator learns to skip past.
        const anchored = await planSectionsAtAnchor(ctx, plan?.planPath)
        if (anchored && !samePlanNotes(plan, anchored)) {
          // The remedy has a direction, and naming only one sent the operator round a loop.
          // `init-run` records from the WORKING TREE plan; the anchor is the plan committed at
          // merge-base(base, run). So when plan.json is AHEAD, re-running init-run rewrites the
          // identical plan.json and this advisory fires again, with no action available to clear
          // it. Both cases are named so the reader can tell which one they are in.
          io.out('  (these notes are from plan.json and no longer match the plan at the anchor; '
            + 'the verdict above is computed from the anchor, not from this. If the plan moved on '
            + 'after the run started, re-run init-run; if plan.json is already ahead, the edit has '
            + 'not reached the anchor — land it on the base branch and merge)')
        }
      }
    } catch {
      // Swallow and print nothing — see the comment above.
    }
    const summary = summarizeRun(phaseResults)
    if (summary.complete) return 0
    // 1 for a phase that was verified and failed; 4 for one that was never verified at all.
    // Same split the output makes, so a caller branching on the code and a human reading the
    // table reach the same conclusion.
    //
    // `--enforcement-only` cannot reach here with a phase in the second state wearing the first
    // state's answer: the refusal above exits 2 unless every phase still has an enforcement check
    // to run, so a phase summarised below always had something actually verify it.
    return summary.failedPhases.length > 0 ? 1 : 4
  }

  if (command === 'plan-drift') {
    let ctx
    try {
      // The same derive `gate` uses: the anchored plan is read with `git show <anchor>:<path>`,
      // and the phases come from branch ancestry. Reading it any other way would compare the
      // working tree against something other than what the gate actually enforces.
      ctx = await derive(root, runId, flags)
    } catch (err) {
      io.out(`cannot read the anchored plan: ${err.message}`)
      return 2
    }

    let currentTasks
    try {
      currentTasks = assignPhases(parsePlan(await readFile(path.resolve(root, flags.plan), 'utf8')))
    } catch (err) {
      io.out(`cannot read the working-tree plan at ${flags.plan}: ${err.message}`)
      return 2
    }

    const report = planDrift({
      anchored: ctx.tasks,
      current: currentTasks,
      integratedPhases: ctx.integratedPhases,
    })
    io.out(renderDrift(report))
    // 1 only for drift against an integrated phase. Amending a task nobody has implemented is
    // how a plan is meant to evolve mid-run, and exiting 1 for it would train a caller to
    // ignore the exit code for the case that actually costs something.
    return report.tooLate.length > 0 ? 1 : 0
  }

  if (command === 'usage') {
    // A headless run stores per-task usage in its session records (`readUsage` output, per task).
    // When those exist and a run was named, report token totals from them; the Claude Code
    // transcript path below is preserved unchanged for a Claude Code session.
    if (typeof runId === 'string') {
      const usageSessionsDir = path.join(runDir(root, runId), 'sessions')
      let entries = null
      try { entries = await readdir(usageSessionsDir) } catch { entries = null }
      const taskFiles = (entries ?? [])
        .filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json') && !f.endsWith('.result.json'))
        .sort()
      if (taskFiles.length > 0) {
        const tasks = []
        for (const fileName of taskFiles) {
          let record
          try {
            record = JSON.parse(await readFile(path.join(usageSessionsDir, fileName), 'utf8'))
          } catch { continue }
          tasks.push({ taskId: record.taskId ?? fileName.replace(/\.json$/, ''), usage: record.usage ?? null })
        }
        if (flags.json === true) {
          io.out(printableBlock(JSON.stringify({ runId, tasks }, null, 2)))
        } else {
          const lines = [`run ${printable(String(runId))}  (${tasks.length} task${tasks.length === 1 ? '' : 's'})`, '']
          let total = 0
          for (const t of tasks) {
            const tok = totalTokens(t.usage) ?? 0
            total += tok
            lines.push(`${printable(String(t.taskId))}  ${tok}`)
          }
          lines.push(`TOTAL  ${total}`)
          io.out(lines.join('\n'))
        }
        return 0
      }
    }
    // Reads the harness's own transcript store, which is internal and may change: a failure to
    // find it is reported with the path rather than rendered as an empty table, because a table
    // of zeros reads as "this run cost nothing".
    try {
      const report = await readSessionUsage({
        // CLAUDE_CONFIG_DIR is the harness's own variable for relocating that directory, so
        // honouring it is correct for a user who has moved it — and it is what lets this command
        // be tested against a fixture store instead of the developer's real transcripts.
        projectsDir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects'),
        root,
        sessionId: typeof flags.session === 'string' && flags.session !== '' ? flags.session : null,
      })
      // The JSON branch does not pass through `renderUsage`, so neutralising the table left this
      // one raw: `JSON.stringify` escapes the C0 range and leaves C1 and U+2028/U+2029 alone, and
      // U+009B is CSI to a terminal decoding C1. The values are read from a meta.json an agent can
      // write and from a session directory name, so they are neutralised here too. `printableBlock`
      // rather than `printable`: the pretty-printer's own newlines are structure, and neutralising
      // them leaves a document that no longer parses.
      io.out(flags.json === true ? printableBlock(JSON.stringify(report, null, 2)) : renderUsage(report))
      return 0
    } catch (err) {
      // Neutralised, as the sibling handler below is. (Not every print site in this file is —
      // several still interpolate repo- and fs-derived values raw; that is a gap, not a
      // convention this line is conforming to.) The value is not the operator's own
      // typing: `missing()` splices the store path into the message, and that path carries a
      // session DIRECTORY name discovered on disk — so a directory an agent can create reaches
      // this line with no flag typed at all. The sibling handler below wraps for the same reason.
      io.out(printable(err.message))
      return 1
    }
  }

  if (command === 'map') {
    const git = createGit({ cwd: root })
    // Both windows are validated the same way and for the same reason: `Number('lots')` is NaN,
    // and NaN reaching either `--max-count` or `slice` produces a plausible-looking answer to a
    // question nobody asked. A typo must exit, never quietly change the result.
    const limit = numericWindow(flags.commits, 500)
    if (!Number.isInteger(limit) || limit <= 0) {
      io.out('--commits takes a positive whole number of commits to read')
      return 2
    }
    const top = numericWindow(flags.top, 5)
    if (!Number.isInteger(top) || top <= 0) {
      io.out('--top takes a positive whole number of files to report')
      return 2
    }
    // `--files` written with no value is `true`, not a string — the same orchestrator mistake
    // `--commits` and `--top` already refuse, and refused here for a stronger reason than theirs:
    // falling through, it asked git a question with `flags.files.split` and died with a raw
    // TypeError, and once that was guarded by truthiness alone it fell through to the WHOLE-
    // REPOSITORY OVERVIEW and exited 0. A caller that asked "what does my file set put at risk"
    // must never be answered with a repository summary and a success code.
    let requestedFiles = null
    if (typeof flags.files !== 'undefined') {
      requestedFiles = typeof flags.files === 'string'
        ? flags.files.split(',').map((f) => f.trim()).filter(Boolean)
        : []
      if (requestedFiles.length === 0) {
        io.out('--files takes a comma-separated list of paths to report the blast radius for')
        return 2
      }
    }
    let sets
    let paths
    let prefix
    try {
      sets = await git.commitFileSets({ limit })
      prefix = await repoPrefix(root)
      paths = (await git.listFiles()).map((p) => toRepoPath(prefix, p))
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`cannot read the repository: ${err.message}`)
      return 2
    }
    const coupling = buildCoupling(sets)

    // A file set turns this from an overview into the one question an implementer has: what does
    // my change put at risk. Answered for the whole set at once, because that is what a task holds.
    if (requestedFiles !== null) {
      // Lifted into the same repo-root namespace the coupling keys live in, so a path the caller
      // wrote relative to --root still matches the history when --root is not the repository root.
      const files = requestedFiles.map((f) => toRepoPath(prefix, f))
      const near = neighboursOf(coupling, files, { top })
      if (near.length === 0) {
        io.out(`no coupled files found for ${files.join(', ')} in the last ${limit} commits — new files, or a shallow history`)
        return 0
      }
      for (const n of near) io.out(`${String(Math.round(n.confidence * 100)).padStart(3)}%  ${n.path}`)
      return 0
    }

    io.out(renderMap({ inventory: inventory(paths), hotPairs: hotPairs(coupling), usedCommits: coupling.usedCommits }))
    return 0
  }

  if (command === 'map-notes') {
    const git = createGit({ cwd: root })
    const notesPath = path.join(runDir(root, runId), 'map.md')
    let sha
    try {
      sha = await git.headSha()
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`cannot read the repository: ${err.message}`)
      return 2
    }

    // The orchestrator's half of the inverted map-notes contract: the dispatched agent is
    // read-only and RETURNS the map, the caller saves that text somewhere, and this is the one
    // path that turns it into `.fleetmates/<runId>/map.md`. Without it the orchestrator writes
    // that file by hand and `mapNotesWritable` — the validator that exists precisely so the
    // stamped file can be vouched for — is never called by anything.
    //
    // Still not a path by which this CLI authors a map: it copies text an agent produced, after
    // checking the header the agent was handed still names this run and this commit. A map that
    // fails that check must not land at all, because every later reader treats the header as
    // provenance, and a file written past a failed validation would manufacture exactly the
    // fact this design refuses to fake.
    if (flags.write !== undefined) {
      // Valueless `--write` is the missing argument it looks like, not a request to write
      // nothing. Same rule as everywhere else in this CLI: `flags[f] === true` means the value
      // was omitted. REQUIRED cannot express "required only when present", so it is checked here.
      if (flags.write === true) {
        io.out('--write takes the path of the file holding the map the agent returned')
        return 2
      }
      const source = path.resolve(root, flags.write)
      let returned
      try {
        returned = await readFile(source, 'utf8')
      } catch (err) {
        io.out(`cannot read the returned map at ${source}: ${err.code ?? err.message}`)
        return 4
      }
      const refusal = mapNotesWritable(returned, { runId, sha })
      // Verbatim, and nothing is written. The reason names the mismatch it found — which commit,
      // which run, or a missing body — and that is what tells the caller whether to re-dispatch
      // the agent or to re-save what it already returned.
      // `printable`, because the refusal quotes the header line out of the file the agent
      // returned — `run=` and `sha=` are matched as `\S+`, and ESC is not whitespace, so a
      // returned map can carry an escape sequence into this sentence.
      if (refusal) { io.out(printable(refusal)); return 4 }
      // Written through a uniquely-named temp file and renamed, the same way `writeState` writes
      // every other file under `.fleetmates/`: a reader must never find a half-written map under
      // a header that vouches for the whole of it.
      const tmp = `${notesPath}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
      try {
        await mkdir(path.dirname(notesPath), { recursive: true })
        await writeFile(tmp, returned, 'utf8')
        await rename(tmp, notesPath)
      } catch (err) {
        // The destination can be unwritable for the same reasons the read path two blocks below
        // already handles deliberately — map.md is a directory (EISDIR, and EPERM out of
        // `rename`), permissions (EACCES) — and from the caller's side they are one situation:
        // the map did not land. Left to throw, this produced an unhandled-rejection stack and
        // exit 1, a code this CLI's documented 0/2/4 contract does not include.
        //
        // The temp file goes with it. It is scaffolding for an operation that did not happen,
        // and leaving it in the run directory hands a later reader a file it cannot interpret.
        await unlink(tmp).catch(() => {})
        io.out(`the map notes at ${notesPath} could not be written (${err.code ?? err.message}), so nothing was written`)
        return 4
      }
      io.out(`wrote the returned map to ${notesPath} for run ${runId} at commit ${sha}`)
      return 0
    }

    // ENOENT is the ordinary case — no notes yet. But every other read failure (map.md is a
    // directory: EISDIR; permissions: EACCES) is the SAME situation from the caller's side:
    // there are no notes it can use. Rethrowing produced a raw stack and exit 1, which is not a
    // code any caller branches on, so an unusable file has to arrive as the documented 4 with
    // the prompt — naming the read failure, so an operator can tell it from an empty file.
    let text = null
    let readFailure = null
    try {
      text = await readFile(notesPath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') readFailure = `the map notes at ${notesPath} could not be read (${err.code ?? err.message}), so nothing says which commit they describe`
    }

    const stale = readFailure ?? mapNotesStale(text, { runId, sha })
    if (!stale) { io.out(`current map notes: ${notesPath}`); return 0 }

    // 4, matching `complete` and `collect-reviews`: this cannot verify what it was asked about.
    // The prompt is printed so the caller dispatches an Explore agent rather than writing prose
    // itself — and a teammate never writes this file.
    // Same reason as the write path's refusal above: the reason names the header the agent wrote.
    io.out(printable(stale))
    io.out('')
    io.out('dispatch an Explore agent with exactly this prompt:')
    io.out('')
    let topDirectories = []
    try {
      topDirectories = promptSafeDirectories(inventory(await git.listFiles(), { top: 8 }).rows.map((r) => r.dir))
    } catch (err) {
      if (!(err instanceof GitError)) throw err
    }
    io.out(mapNotesPrompt({ runId, sha, notesPath, topDirectories }))
    return 4
  }

  if (command === 'preview-check') {
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out(`no ${GATE_FILE} — nothing to check`); return 4 }

    const links = previewLinks(config)
    if (links.length === 0) {
      // Not a failure: a project whose checks need nothing but tracked content is the normal
      // case for this repository itself. Said out loud, because silence here would read as
      // "checked, all good" to a project that meant to declare something and did not.
      io.out(`no preview.link declared — the merge preview will contain tracked content only`)
      return 0
    }

    // The same validator the merge check runs, so a manifest that passes here cannot fail there
    // for a reason this command could have named first.
    const invalid = validateLinkPaths(links)
    // Wrapped, like every other print site in this block: the refusal quotes the rejected manifest
    // entry, and the comment immediately below already says `validateLinkPaths` does not screen
    // control bytes. An entry embedding a raw U+2028 ahead of a forged success sentence otherwise renders
    // a second line reading exactly like this command's own success line.
    if (invalid) { io.out(printable(invalid)); return 1 }

    // `validateLinkPaths` above rejects a non-string, an empty string, an absolute path, a `..`
    // and a duplicate, and quotes what it rejected through `JSON.stringify` — but it does not
    // screen control bytes, and `"a\u001b[2K"` is a legal relative path by every one of those
    // rules. So each entry is wrapped again on its way into the sentences below, including the
    // success line, which is the one printed on a manifest that passed every validator.
    const git = createGit({ cwd: root })
    const problems = []
    for (const entry of links) {
      const target = path.resolve(root, entry)
      try {
        const info = await stat(target)
        if (!info.isDirectory()) problems.push(`${printable(entry)}: exists but is not a directory`)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
        problems.push(`${printable(entry)}: does not exist — the preview would be missing it, and every command check would fail on a tree that is otherwise fine`)
        continue
      }
      try {
        // Linking over a path the merge produced would shadow the merged result, which is the
        // one thing the preview exists to measure.
        if (await git.tracks(entry)) {
          problems.push(`${printable(entry)}: is tracked by the repository — linking over it would shadow the merged result`)
        }
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        problems.push(`${printable(entry)}: ${printable(err.message)}`)
      }
    }

    if (problems.length === 0) {
      io.out(`preview.link is usable: ${links.map(printable).join(', ')}`)
      return 0
    }
    for (const p of problems) io.out(p)
    return 1
  }

  if (command === 'review-dispatch') {
    // Before the manifest is even read: an invocation this command cannot act on unambiguously is
    // rejected on its own terms, the way a missing argument is, rather than after the environment
    // has had its say. 2 is what this CLI returns for a rejected invocation; 4 would say the
    // command tried and could not verify, which is not what happened.
    const ambiguous = await ambiguousPhaseRefusal(root, runId, flags, command)
    if (ambiguous) { io.out(ambiguous); return 2 }

    // The TRACKED manifest, not the resolved config: the reviewer grades the diff, so letting
    // the gitignored local layer choose its tier would let the party being judged pick its own
    // judge. `config.mjs` already refuses `agents.reviewer` in the local layer; reading the
    // manifest directly here means this command does not depend on that refusal holding.
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out('no gate manifest — cannot tell which lenses to dispatch'); return 4 }

    const phaseName = flags.phase ?? 'default'
    const agentChecks = checksForPhase(config, phaseName).filter((c) => kindOf(c) === 'agent')
    if (agentChecks.length !== 1) {
      io.out(`this phase declares ${agentChecks.length} agent checks; review-dispatch handles exactly one`)
      return 4
    }
    const check = agentChecks[0]

    const tierModels = parseTierModels(flags, io)
    if (tierModels === TIER_MODELS_REJECTED) return 2

    // Through the same non-parking reader as `collect-reviews`, for the same inherited FIFO door:
    // these two commands read the same file for the same reason, and a hang in one is a hang in
    // the other.
    let plan = null
    try {
      plan = await readRunPlan(root, runId)
    } catch (err) {
      io.out(`the plan for run ${printable(runId)} cannot be read: ${printable(err.message)}`)
      return 4
    }
    if (!plan) { io.out(`no plan for run ${printable(runId)}`); return 4 }

    const git = createGit({ cwd: root })
    // Resolved to shas as well as names: the stamp each reviewer carries back names the tips it
    // judged, and `collect-reviews` compares that against the tips as they stand then.
    const branchShas = await resolveBranchShas(git, tasksOfPhase(plan, phaseName), runId)
    const branches = Object.keys(branchShas)
    if (branches.length === 0) {
      // Refused rather than emitted: reviewers dispatched over branches that do not exist grade
      // an empty diff and report no findings, which is indistinguishable from a clean review.
      io.out(`no task branch of phase ${phaseName} exists yet — there is no diff to review`)
      return 4
    }

    // Which command check is the suite, chosen by a stated rule rather than by position. The
    // first command check in the list is NOT it: `inferGateConfig` emits typecheck, lint, test,
    // build in that order, and that inferred config is what `gate` prints for an operator to
    // save — so positionally the claims reviewer would baseline on `npm run typecheck`, which
    // survives deleting a filter or widening a guard, and every probed claim would read as
    // unpinned. The rule is: the check named `test` if there is exactly one; otherwise the sole
    // command check if there is exactly one; otherwise no choice is made here.
    //
    // This comes from `fleetmates.gate.json` in the WORKING TREE — `resolveGateConfig` reads it
    // through `readLayer`, not out of the index — so an enforced agent can edit it. Reading the
    // manifest rather than the resolved config keeps the gitignored local layer out of the
    // choice; it does not make the value trusted. Nothing screens the run string: containment is
    // structural, and `generateReviewDispatch` emits it as a JSON literal in a DATA block that
    // sits below every instruction, so no value of it can become one.
    const commandChecks = checksForPhase(config, phaseName).filter((c) => kindOf(c) === 'command')
    const namedTest = commandChecks.filter((c) => c.name === 'test')
    const commandCheck = namedTest.length === 1
      ? namedTest[0]
      : (namedTest.length === 0 && commandChecks.length === 1 ? commandChecks[0] : null)
    // Refused, not guessed — and only for the lens that actually runs the command, since no
    // other lens reads this value and blocking their dispatch over it would answer a question
    // they never ask. Zero command checks is not ambiguity: it falls through to
    // `generateReviewDispatch`, whose message says the phase declares no command check.
    //
    // The two ambiguous shapes get different sentences because they have different remedies, and
    // one message covering both told an operator with two checks named `test` to name one of them
    // `test` — a fix already applied, so the only instruction offered was a no-op.
    if (!commandCheck && commandChecks.length > 1 && (check.lens ?? []).includes('claims')) {
      const preamble = 'the claims lens needs one command check to baseline against and this phase declares'
      io.out(namedTest.length > 1
        // The duplicates, not every command check: enumerating all of them printed a third name
        // under a count of two, and the extra name is the one an operator told to "rename the one
        // that is not the suite" would reach for, which would change nothing.
        ? `${preamble} ${namedTest.length} command checks named "test": `
          + `${namedTest.map((c) => printable(c.name)).join(', ')}. Rename the one that is not the suite`
        : `${preamble} ${commandChecks.length} with none named "test": `
          + `${commandChecks.map((c) => printable(c.name)).join(', ')}. `
          + 'Name the one that runs the suite "test", or drop the claims lens from this phase')
      return 4
    }
    const testCommand = commandCheck?.run ?? ''
    const testCommandName = commandCheck?.name ?? ''
    // The same paths the merge preview links in, for the same reason: a scratch worktree has no
    // untracked build inputs, and the suite cannot run without them. `previewLinks` normalises a
    // non-array to []; `config.mjs`'s `preview` validator has already refused one by here, so
    // that normalisation is a second net rather than the one that catches it.
    const linkPaths = previewLinks(config)

    // THE SHARED CLASSIFIER again, before a dispatch is built. This command does not go through
    // `derive` either, and the value below is what every reviewer is told to diff the phase
    // against — so a HEAD that names no branch would have a whole review round computed against a
    // tree of the planter's choosing and reported as fact. The consequence here is an exit code
    // rather than a throw, because `review-dispatch` reports its refusals that way.
    const head = await git.headBranch()
    if (!head.ok) {
      io.out(`${head.reason} — there is no run branch to review against; check out the run branch and re-run`)
      return 4
    }
    // THE REF, not the name, because this value is handed to an AGENT as a git argument rather
    // than to `qualifyBranch`. Git's DWIM order resolves `refs/tags/<name>` BEFORE
    // `refs/heads/<name>`, so a bare name is redirected by one `git tag run-branch <task tip>` —
    // creatable by any teammate from its own worktree, with no HEAD write and no privilege.
    // Measured: the prompt's own `git merge-base run-branch <branch>` then answered the T1 TIP,
    // the diff against it was EMPTY, and every reviewer honestly returned zero findings while
    // `export const backdoor = 1` sat in the phase. The agent review BLOCKS, so that is a pass
    // issued over an unreviewed diff. The mechanical checks never saw it precisely because they
    // go through `qualifyBranch`, which is what made this invisible to everything else.
    const reviewRunBranch = head.ref

    let spec
    try {
      spec = generateReviewDispatch({
        runId,
        phaseName,
        checkName: check.name,
        lenses: check.lens,
        blockOn: check.blockOn ?? ['high'],
        // The fixed reviewer tier is `capable`; only the tracked manifest replaces it.
        tier: config.agents?.reviewer?.tier ?? 'capable',
        effort: config.agents?.reviewer?.effort ?? '',
        tierModels,
        // WRAPPED HERE, AND THIS IS A COMPROMISE — say so rather than reading it as the clean fix.
        // `generateReviewDispatch` splices this value bare into the reviewer's PROMPT, and a
        // branch name is chosen by whoever created the branch. A name legitimately under
        // refs/heads/ — so `classifyHeadRef` returns ok and the refusal above never fires — can
        // carry control characters that render as line breaks, and the payload after one reads as
        // its own instruction to an agent this gate trusts. Measured splices per lens:
        // `correctness:2 security:2 tests:2 claims:4` — claims is not uniform with the others,
        // because review-gen.mjs:76 is a claims-only method step that splices the name again.
        // How many characters that yields is the attacker's to choose, so no total is recorded
        // here; the fixture is the same information under test.
        //
        // Bounded, and not a regression: the line this replaced passed the identical string, and
        // `[` and `:` are refname-illegal, so a bracketed verdict cannot be spelled and the JSON
        // still parses.
        //
        // THE STRUCTURAL FIX IS AT THE SPLICE SITES in review-gen.mjs, which is outside this
        // task's declared file set. So this is a caller-side wrap: exactly the per-site shape that
        // let the HEAD rule drift across four sites for three review rounds. It closes THIS
        // caller and no other — `review-gen.mjs` still splices `runBranch` bare from every other
        // one, and that is recorded as a separate followups item rather than fixed here.
        runBranch: printable(reviewRunBranch),
        // Fully qualified for the same reason, and this is the same channel: these names are
        // spliced into the reviewer's `git worktree add` / `git merge-base` / `git diff` lines,
        // so a tag named like a task branch redirects them exactly as one named like the run
        // branch did. `resolveBranchShas` already proved each exists under refs/heads/.
        branches: branches.map((b) => (b.startsWith('refs/') ? b : `refs/heads/${b}`)),
        findingsDir: `${NAMES.stateDir}/${runId}/reviews`,
        scratchRoot: tmpdir(),
        testCommand,
        testCommandName,
        linkPaths,
        branchShas,
      })
    } catch (err) {
      // `generateReviewDispatch` throws `validateLinkPaths`'s message among others, which quotes
      // a manifest-supplied path through `JSON.stringify` — escaping the C0 range but not U+2028,
      // 0x7F or the C1 range. Wrapped here so the refusal cannot print a line of the attacker's
      // choosing on its way out.
      io.out(printable(err.message))
      return 4
    }
    // Emitted exactly as generated. Nothing is appended here: the claims prompt ends with a DATA
    // block whose banner says nothing below it is an instruction, and appending anything after it
    // made that banner false in the one prompt whose containment depends on it. The stamp
    // requirement the reviewers used to receive from here is now emitted by the generator, above
    // that block.
    io.out(JSON.stringify(spec, null, 2))
    return 0
  }

  if (command === 'collect-reviews') {
    // `--phase` names the manifest key and comes off argv alone, so it is resolved here rather
    // than after the manifest: everything below needs it, starting with the clear.
    const phaseName = flags.phase ?? 'default'

    const dir = path.join(runDir(root, runId), 'reviews')

    // THE PREVIOUS ROUND'S RESULTS FILE IS REMOVED BEFORE THIS ROUND READS ANYTHING, and that is
    // what keeps a deterministic, phase-scoped filename safe to advertise.
    //
    // The file is written only on success, so before it existed this command was fail-closed:
    // there was no artefact unless the operator made one, and a `>` redirect truncates on the
    // failing run. Writing it turned that fail-open. Measured on this branch before this removal:
    // a clean round wrote `results-default.json` saying `"status": "pass"` and printed that path;
    // a fix-round commit then made the round-2 collection refuse with exit 4 (`stale findings for
    // lens correctness`), the round-1 file survived untouched still saying `"pass"`, and `gate
    // --results` on exactly the path round 1 advertised exited 0 with verdict PASS — a pass over
    // a tree no reviewer judged.
    //
    // REMOVAL rather than a stamp inside the document. A stamp is only worth what its reader
    // checks, and `gate --results` does not check one: it `JSON.parse`s the file and trusts
    // `results`, which is how the stale document above passed. Teaching the gate to verify a
    // stamp would put that check on every run's gate path and still leave the document trusted by
    // anything else that reads it, whereas removing it makes its EXISTENCE the claim — a results
    // file is present only when the round that wrote it succeeded.
    //
    // Removed HERE — before the manifest is resolved, before the phase is matched to a check,
    // before the findings are read — rather than on each failing exit. "Before the findings are
    // read" was too weak, and the gap it left was measured: a round that refused at the empty-lens
    // check, or at the agent-check count, returned 4 with the previous round's `"status": "pass"`
    // still on disk, and `gate --results` on that file exited 0 with verdict PASS over a tree that
    // round had refused to judge. Five refusals sat above it.
    //
    // The property is positional, so it is stated positionally, and it is checkable by reading
    // rather than by counting: NO `return` in this command sits above this block, and the only
    // three inside it are the guards below that decide whether the removal may happen at all —
    // they cannot be moved after the thing they guard. Every other exit, all fifteen of them, is
    // downstream. A count of the paths downstream was true and useless, which is what the earlier
    // version of this sentence was: what mattered was the paths UPSTREAM. Clearing here also
    // covers the exits no `return` can: a crash, a kill, a timeout mid-collection.
    //
    // `unlink` removes the LINK, never what it points at, so a symlink an earlier round (or
    // another teammate) left AT THE RESULTS PATH is cleared without touching the file on the other
    // end of it. That is true of a link at that path and false of a link at the DIRECTORY above
    // it, which is why the directory is vetted first: through a planted `reviews` link this
    // removal deleted the victim directory's own `results-1.json` — measured on this branch,
    // before the vet was moved ahead of it. The destructive half must not be the unguarded one:
    // a refused write costs a round, a deletion costs the file.
    //
    // The name is `results-<phase>.json`, beside the findings files this round reads, and the
    // phase goes through `isUnsafePathComponent` — the predicate `reviewFileName` applies to each
    // of its own components — so a phase name that is not a safe filename is refused rather than
    // escaping the directory. Vetted HERE rather than beside the write, because this removal
    // builds a path from the same value: unvetted, it is a delete-anything primitive as readily as
    // the write was a write-anything one. Measured, with this block moved below the unlink and a
    // real file planted at `.fleetmates/pwned.json`: the command still exited 4 with this same
    // sentence, and the file was gone. The refusal is not what the ordering buys — the ordering is
    // what stops the deletion happening on the way to it. Refused with the 4 the `reviewFileName`
    // failure below returns, rather than a second code for the same flag on the same command.
    //
    // NOT redundant with the per-lens `reviewFileName` failure, which is the reading the lens loop
    // invites. That loop runs AFTER this, and after the removal below: by the time it could refuse
    // the phase, this code has already built a path from it and deleted whatever was there. The
    // two refusals also read differently on purpose — this one names the results file — because
    // they otherwise printed the same sentence, and a fixture could not tell which had fired.
    // Measured on this branch, with this guard forced to false and the manifest declaring a phase
    // key of `a/../../../pwned`: the results file was written to `.fleetmates/pwned.json`, two
    // directories above the run's own reviews directory, and the command printed that path and
    // exited 0; with the guard merely MOVED below the removal, a real file planted at that same
    // path was deleted while the command still exited 4 with this very sentence.
    //
    // Coerced with `String` first for the same reason `reviewFileName` does it: the value that
    // gets checked has to be the value that gets joined, or the two can differ.
    const resultsName = String(phaseName)
    if (isUnsafePathComponent(resultsName)) {
      io.out(`the results file cannot be named: a phase must be a non-empty name with no path separators, got ${JSON.stringify(printable(resultsName))}`)
      return 4
    }
    const resultsPath = path.join(dir, `results-${resultsName}.json`)

    // The directory is resolved BEFORE the removal, not beside the write, because the removal is
    // the half that cannot be undone.
    let planted = null
    try {
      planted = await plantedReviewsLink(root, dir)
    } catch (err) {
      io.out(`cannot vet the run's reviews directory at ${printable(dir)}: ${printable(err.message)}`)
      return 4
    }
    if (planted) {
      io.out(`${printable(planted)} is a symlink, and every component of ${printable(dir)} must be a real directory — refusing before anything is removed or written`)
      return 4
    }

    try {
      await unlink(resultsPath)
    } catch (err) {
      // ENOENT is the ordinary case — no earlier round, or one that failed. Anything else is a
      // document this command cannot account for, and leaving it in place would let it be read as
      // this round's answer.
      if (err.code !== 'ENOENT') {
        // EMPTIED WHERE IT CANNOT BE REMOVED, which is a real case and not a defensive one: in a
        // `0555` reviews directory `unlink` fails EACCES while `truncate` succeeds, because
        // removing an entry needs write permission on the DIRECTORY and emptying a file needs it
        // on the FILE. Measured on this branch: without this fallback that round exited 4 with the
        // superseded document still on disk saying `"status": "pass"`, and `gate --results` on
        // it exited 0 with verdict PASS over a tree no reviewer had judged — the exact failure the
        // up-front clear exists to prevent. A zero-byte file is fail-closed: the gate refuses it
        // with `--results must be a readable JSON file`, measured in the same run.
        //
        // THROUGH A DESCRIPTOR, never by path, and the property required is not the one that
        // reads most naturally. "only a regular file is emptied" describes the CHECK; what the
        // fallback actually needs is that the bytes it destroys BELONG TO THIS COMMAND, and
        // `isFile()` does not say that. A hard link is a regular file: `unlink` on one is
        // harmless because it removes a NAME, which is why such a plant is inert on the normal
        // path, but `truncate` destroys the shared inode. Measured on this branch with the
        // path-based check: `link('<outside>/secret.txt', '<reviews>/results-1.json')` in a `0555`
        // directory — the very condition this fallback exists for — left that file outside the
        // project at zero bytes, with nothing in the output naming it. `st_nlink` was never
        // consulted.
        //
        // So: open with the O_WRONLY|O_NONBLOCK|O_NOFOLLOW word above, `fstat` the DESCRIPTOR,
        // require a regular file with exactly one link, and `ftruncate` that same descriptor. This
        // is the pattern `openHolderEntry` uses, against the same class of plant; there was no
        // reason this site did not reach for it first.
        //
        // WHAT IT ACTUALLY BUYS, measured by substituting the old `lstat`-then-`truncate` body
        // back in — which reddens 'the empty-instead-of-remove fallback does not destroy an inode
        // with another name' and 'collect-reviews refuses when the previous results file can be
        // neither removed nor emptied', and nothing else: exactly one hazard changes hands — the HARD LINK, which
        // `isFile()` cannot see. The symlink and the directory were already refused by the old
        // body: `lstat` reports the link, so `isFile()` is false and `truncate` was never called,
        // and a directory fails the same test. The symlink fixture stays green under the old body,
        // and the directory case still refuses with the same exit and the same sentence except for
        // one parenthetical — the old body records no reason, because it decides on `lstat` and
        // never opens, where this one records the EISDIR its open returns. That is what the second
        // failing test above is: a wording difference, not a hazard. An earlier version of this
        // comment claimed four hazards, counting two the check it replaced already covered.
        //
        // O_NONBLOCK IS NOT ONE OF THEM EITHER, and the claim that it "comes with the descriptor"
        // was doubly wrong. It is PINNED — reverting the flag word reddens the FIFO-at-the-results-
        // path fixture (SIGKILL at 20 000 ms) and the flag-word unit test, which are exactly the
        // two kills the mutation record in the test file names for that substitution. And the hang
        // it prevents is one THIS REWRITE INTRODUCED: the old body never opened a FIFO at all, so
        // it refused one in milliseconds. Opening is what created the hazard; O_NONBLOCK is what
        // closes it again. Measured in isolation: `O_WRONLY|O_NOFOLLOW` on a FIFO stayed blocked
        // past 5s, and adding O_NONBLOCK returns ENXIO at once.
        //
        // One property really is unpinned, and it is the one left: the check and the destruction
        // are now one object rather than two syscalls on a path, so nothing can be swapped in
        // between. No test here holds that — staging the swap needs a scheduler this suite does
        // not have.
        let emptied = false
        let emptyErr = null
        const flags = emptyResultsOpenFlags()
        if (flags === null) {
          emptyErr = new Error('this platform has no O_NOFOLLOW, so the entry cannot be opened without risking following a link')
        } else {
          let handle = null
          try {
            handle = await openFile(resultsPath, flags)
            const info = await handle.stat()
            if (info.isFile() && info.nlink === 1) {
              await handle.truncate(0)
              emptied = true
            } else {
              emptyErr = new Error(`the entry there is not a single-linked regular file (nlink ${info.nlink}), so emptying it could destroy bytes this command does not own`)
            }
          } catch (err) {
            emptyErr = err
          } finally {
            if (handle) await handle.close().catch(() => {})
          }
        }
        if (!emptied) {
          // ONLY WHAT WAS OBSERVED, which is narrower than "report the outcome" and is the rule
          // this sentence has now broken twice. The first version asserted a norm ("must not
          // survive this one"). The second asserted a state nobody had looked at — that the
          // document is still on disk carrying a verdict `gate --results` would read as this
          // round's — and that is false on three reachable paths, all measured on this branch: a
          // DIRECTORY at the path (the state one of this command's own tests builds) makes the
          // gate exit 2, not read a verdict, and `rm` without `-r` refuses the advice; the
          // reviews entry replaced by a regular file fails ENOTDIR, so the file named as "still
          // on disk" does not exist; and a `0666` reviews directory fails EACCES on both the
          // unlink and the open, so nothing observed the entry at all.
          //
          // What IS observed is two attempts and two failures, so that is what is printed —
          // together with the one consequence this code does control, which is that the round is
          // refused before anything is read. Naming both errors is the whole of the diagnosis: an
          // EACCES pair says the directory, an EISDIR says the entry.
          io.out(`could not clear the previous results file at ${printable(resultsPath)}: unlink failed (${printable(err.message)}), and emptying it in place failed too (${printable(emptyErr?.message ?? 'no reason recorded')}) — this round is refused before reading any findings, so nothing here is its answer; inspect that path before re-running`)
          return 4
        }
      }
    }

    // Refused before the manifest, for the reason given at the same call in `review-dispatch`:
    // collecting under the widened default records a pass over branches this phase never reviewed.
    const ambiguous = await ambiguousPhaseRefusal(root, runId, flags, command)
    if (ambiguous) { io.out(ambiguous); return 2 }

    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    // 4, matching `complete`: this cannot verify what it was asked about. Inferring a manifest
    // here would invent the lens list, which is the one thing this command must not guess —
    // the lens list is what decides whether a review is complete.
    if (!config) { io.out('no gate manifest — cannot tell which lenses were dispatched'); return 4 }

    const checks = checksForPhase(config, phaseName)
    const agentChecks = checks.filter((c) => kindOf(c) === 'agent')
    if (agentChecks.length !== 1) {
      io.out(`this phase declares ${agentChecks.length} agent checks; collect-reviews handles exactly one`)
      return 4
    }
    const check = agentChecks[0]

    // AN AGENT CHECK WITH NO LENS COLLECTS NOTHING, and a pass over nothing is the outcome this
    // whole command exists to refuse. `checksForPhase` substitutes the manifest's lens list only
    // for a check that OMITS one; an explicit `"lens": []` is kept, the read loop below runs zero
    // times, and `collectReviewResults` reports a clean pass because no lens is missing. Measured
    // on this branch before this refusal: exit 0, `0 finding(s), none blocking, recovered from the
    // reviewers' findings files`, with no findings file opened at all — and the results file was
    // written and advertised, so `gate --results` on it returned verdict PASS over a tree no
    // reviewer had judged.
    //
    // The pass COMPUTATION is not new — `git show master:scripts/cli.mjs` prints the same document
    // on stdout for the same manifest — but persisting it is what makes it reusable, and it
    // contradicts this command's own contract that a results file exists only where a round
    // succeeded. Refused at the COLLECTION
    // rather than at the write, because the document is wrong wherever it goes: a reader of that
    // stdout is as misled as a reader of the file. 4, matching every other "this cannot be
    // verified" answer here.
    if (Array.isArray(check.lens) && check.lens.length === 0) {
      io.out(`the agent check ${printable(check.name ?? 'review')} declares an empty lens list, so no review was dispatched for this phase and there is nothing to collect — a pass over zero lenses is not a review`)
      return 4
    }


    const files = []
    const unreadable = []
    for (const lens of check.lens) {
      let name
      try {
        name = reviewFileName(phaseName, lens)
      } catch (err) {
        io.out(err.message)
        return 4
      }
      try {
        const parsed = JSON.parse(await readFindingsFile(path.join(dir, name)))
        // A reviewer returns an array of findings; the file it writes may carry that array
        // directly or wrap it. Both are accepted, and anything else is unreadable rather than
        // an empty review — the distinction this whole command exists to preserve.
        const found = Array.isArray(parsed) ? parsed : parsed?.findings
        if (!Array.isArray(found)) { unreadable.push(name); continue }
        // The stamp travels with the findings. A file that carries none is not "probably
        // current" — `reviewStale` refuses it, which is the whole point of stamping.
        // `unableToVerify` and `unprobed` travel with the findings too: one decides whether this
        // lens is a review at all, the other bounds it. Read off the wrapped form only — a bare
        // array carries findings and nothing else.
        files.push({
          lens,
          findings: found,
          stamp: Array.isArray(parsed) ? undefined : parsed?.stamp,
          unableToVerify: Array.isArray(parsed) ? undefined : parsed?.unableToVerify,
          unprobed: Array.isArray(parsed) ? undefined : parsed?.unprobed,
        })
      } catch (err) {
        // ENOENT is a missing lens, reported below by name. Anything else is a file that
        // exists and cannot be trusted, which must never be read as "no findings".
        if (err.code !== 'ENOENT') unreadable.push(name)
      }
    }

    if (unreadable.length > 0) {
      io.out(`unreadable findings file(s): ${unreadable.map(printable).join(', ')} — a file that exists and cannot be parsed is not an empty review`)
      return 4
    }

    // What the findings must have judged: the phase's task branches as they stand NOW. A fix
    // round moves a branch, and findings about the old tree are not findings about this one —
    // during run `codemap` that was worked around three times by deleting the files by hand
    // between rounds.
    // The same rethrow one command down, and PRE-EXISTING: `master` crashes identically on a
    // `plan.json` that is not JSON — measured, exit 1 with an empty stdout on both, where this
    // branch's only contribution is that the clear has already run by then.
    // Folded into the refusal below rather than left to throw, because "no plan" and "a plan this
    // cannot read" put the operator in the same position: nothing here says which tips were
    // judged.
    //
    // `${runId}` goes through `printable` like every other value in this command's output, and the
    // reason is precise: WHAT VALIDATES THIS ID IS CONTAINMENT, AND NOTHING VALIDATES ITS BYTES.
    // `assertContained` runs before dispatch for every command — measured here, `--run ../../pwned`
    // and `--run a/../../out` both exit 2 on `escapes the run directory` — so the path this block
    // builds from `runId`, and deletes and renames files under, cannot leave the run directory.
    // That guarantee is real and this comment must not talk a reader out of it.
    //
    // What no one checks is the CHARACTERS. `idRefusal` would refuse every payload below — it is
    // an allowlist, and calling it directly with an ESC, a C1 CSI, a bare CR and a NUL refuses all
    // four — but both of its call sites are inside `init-run`, so nothing on this path consults it
    // and a control byte travels intact to this sentence. Measured: `--run $'r1\e[2K\rreview:
    // PASS'` reached it raw and drew a forged verdict line under it. For those bytes the wrapper
    // is not a second line of defence; it is the only one.
    //
    // Twice this sentence has been written from an inference about which validator applies, and
    // twice the mechanism was wrong while the conclusion happened to hold. Both times one call —
    // `idRefusal(…)` directly, `--run ../../pwned` through the CLI — settled it in seconds.
    let plan = null
    try {
      plan = await readRunPlan(root, runId)
    } catch (err) {
      io.out(`the plan for run ${printable(runId)} cannot be read: ${printable(err.message)} — nothing says which branch tips this phase is at, and a findings file that cannot be vouched for is not a review`)
      return 4
    }
    if (!plan) {
      // Wrapped for the reason above, and STRICTLY EASIER TO REACH than the sentence it sits under:
      // that one needs a `plan.json` this cannot parse, this one needs no plan file at all.
      // Measured before this wrap: a C1 CSI in `--run` reached the terminal raw here while the
      // neighbouring line, already wrapped, tokenised the same bytes.
      io.out(`no plan for run ${printable(runId)} — nothing says which branch tips this phase is at, and a findings file that cannot be vouched for is not a review`)
      return 4
    }
    let branchShas
    try {
      branchShas = await resolveBranchShas(createGit({ cwd: root }), tasksOfPhase(plan, phaseName), runId)
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`cannot read this phase's task branches: ${err.message}`)
      return 4
    }
    if (Object.keys(branchShas).length === 0) {
      // The mirror of `review-dispatch`'s refusal: with no branch there was no diff to review,
      // so any file claiming to have reviewed one describes something else entirely.
      io.out(`no task branch of phase ${phaseName} exists — there was no diff to review`)
      return 4
    }
    const expected = reviewStamp({ phase: phaseName, lens: null, branchShas })

    const collected = collectReviewResults({
      checkName: check.name,
      lenses: check.lens,
      files,
      blockOn: check.blockOn ?? ['high'],
      // `lens` is filled in per file by collectReviewResults; phase and branches are the run's.
      expected: { phase: phaseName, branches: expected.branches },
    })
    if (collected.stale.length > 0) {
      // Reported the way `missing` is, and for the same reason: a stale review is a review this
      // phase does not have. Recording a pass on it would be a verdict about another tree.
      //
      // The reason quotes a reviewer's own file, and this line is read in a terminal. `printable`
      // neutralises the control bytes with which a value could otherwise erase this refusal and
      // draw a passing gate in its place; see its definition in `reviews.mjs`.
      for (const s of collected.stale) {
        io.out(`stale findings for lens ${printable(s.lens)}: ${printable(s.reason)} — respawn that review rather than recording a pass`)
      }
      return 4
    }
    // Every unaccounted-for lens is reported before anything returns. These are three different
    // reasons a review is not here, they can hold at once across different lenses, and returning
    // on the first one costs a full respawn-and-re-run to discover the second.
    //
    // `u.reason` is the reviewer's own `unableToVerify` string, straight out of its file, so it
    // goes through `printable` for the same reason the stale reason above does.
    for (const u of collected.unverified) {
      io.out(`lens ${printable(u.lens)} could not verify anything: ${printable(u.reason)} — that review did not happen; respawn that lens rather than recording a pass`)
    }
    for (const m of collected.malformed) {
      // Deliberately not "respawn": the reviewer may have done all its work and written the key
      // in a shape this command does not read. What needs fixing is the file, or whatever wrote it.
      io.out(`lens ${printable(m.lens)} has a findings file this command cannot read: ${printable(m.reason)} — fix the file rather than recording a pass or respawning the review`)
    }
    if (collected.unexpected.length > 0) {
      io.out(`ignored findings file(s) for lens(es) this phase did not dispatch: ${collected.unexpected.map(printable).join(', ')}`)
    }
    // A lens already reported above is also in `missing`, and calling its review lost would send
    // the operator looking for a file that is sitting right there. Only the genuinely absent ones
    // are named here.
    const explained = new Set([...collected.unverified, ...collected.malformed].map((e) => e.lens))
    const lost = collected.missing.filter((lens) => !explained.has(lens))
    if (lost.length > 0) {
      io.out(`no findings file for lens(es): ${lost.map(printable).join(', ')} — those reviews are lost, not empty; respawn them rather than recording a pass`)
    }
    if (lost.length > 0 || explained.size > 0) return 4

    // PRINTED AND PERSISTED, because printing alone is a trap this run fell into. `gate --results
    // <path>` needs a FILE, and this command's only output was stdout — so an operator who ran it
    // without redirecting had the review check sit `pending` forever while the gate reported FAIL
    // with an empty `failed: []`, naming nothing to fix. Writing the file makes the next command's
    // argument something that exists rather than something the operator had to know to create.
    //
    // The JSON goes out FIRST, before anything is written, and the path after it. Two reasons,
    // and the ordering serves both. Nothing is prepended to what a caller already parses; and a
    // collection that succeeded is never lost to a filesystem that refused it — with the results
    // file made unwritable (an earlier round under another uid, or a read-only `.fleetmates`) the
    // write-first version exited 1 with a raw Node stack and ZERO bytes on stdout, discarding a
    // review it had already computed, and 1 is not a code this command otherwise returns.
    //
    // A `> results.json` redirect is NOT preserved by that ordering — it captures the path line
    // too, and `gate --results` JSON.parses the whole file, so the redirect yields `--results must
    // be a readable JSON file` (measured on this branch). The file written below is the path to
    // pass instead, which is what makes the redirect unnecessary.
    const document = JSON.stringify({ results: collected.results }, null, 2)
    io.out(document)

    // TEMP-THEN-RENAME, matching `writeState` in `scripts/state.mjs`, because a plain `writeFile`
    // FOLLOWS A SYMLINK sitting at the target. `'w'` is `O_CREAT|O_WRONLY|O_TRUNC`, and the guard
    // above vets the phase STRING while nothing vets the ENTRY already at the safe path — which
    // any teammate can plant, since `.fleetmates/<run>/reviews/` is where reviewers are told to
    // write and the filename is derivable from the phase in their own dispatch prompt. Measured on
    // this branch before this change, each with the printed path still naming the innocuous
    // in-repo location and the command exiting 0: a symlink to `fleetmates.gate.json` had the
    // TRACKED MANIFEST overwritten with this document (`git status` reported it modified); a
    // symlink to a file outside the project root had that file overwritten; and a DANGLING symlink
    // to `hooks-new-file.mjs` CREATED that file. `rename` replaces a link rather than following
    // it, so all three now end with the plant gone and the document at the real path.
    //
    // `'wx'` on the temp for the same reason `writeOwnerMarker` uses it (see
    // scripts/merge-preview.mjs) — an entry already at the scratch name is refused, not followed.
    // `'wx'` is wrong for the DESTINATION, and NOT for the reason that reads most naturally.
    // "an exclusive create would refuse every round after the first" is false for this code: the
    // unconditional clear above guarantees the destination is absent by the time the write runs,
    // and a fixture collecting twice against the same run returned 0 both times with `'wx'`
    // substituted at the destination — measured on this branch. What it would really break is the
    // window this whole block exists for: a plant landing between the clear and the write turns
    // `'wx'` into EEXIST, which fails a round whose collection had already succeeded. `rename`
    // replaces that plant instead, which is the outcome the operator needs.
    //
    // Stated as UNCOVERED rather than as safe: no test here pins that `'wx'`, and removing it
    // alone leaves the suite green — measured. The scratch name carries this pid and a
    // microsecond clock reading, so no fixture can pre-plant the entry it would refuse, which is
    // the same property that makes a plant there implausible in the first place. It stays because
    // a `'w'` on a scratch path that did happen to be occupied would follow it, and it costs
    // nothing; do not read a green suite as evidence for it.
    let tmp = null
    try {
      // The shape neither `rename` nor `'wx'` reaches: a symlink anywhere on the way to the
      // directory, where `mkdir` recursive is a no-op on the link and every path built from `dir`
      // resolves through it, so the document lands wherever it points while the printed path still
      // says in-repo. Re-checked here rather than trusted from the vet before the clear: that one
      // ran before the whole collection, and this one runs immediately before the write, which is
      // as close as this can be brought without an API for writing relative to an open directory.
      // Checked BEFORE `mkdir`, so a planted chain has nothing created inside it.
      const replanted = await plantedReviewsLink(root, dir)
      if (replanted) {
        throw new Error(`${printable(replanted)} is a symlink, and every component of ${printable(dir)} must be a real directory`)
      }
      await mkdir(dir, { recursive: true })
      tmp = `${resultsPath}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
      await writeFile(tmp, `${document}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(tmp, resultsPath)
    } catch (err) {
      if (tmp) await unlink(tmp).catch(() => {})
      // Reported, not thrown: the results are already on stdout above. 4 rather than 0 because
      // this command's answer is now a FILE and there is not one — a caller told 0 would go
      // looking for a path that does not exist. Wrapped for the reason `configFailureMessage`'s
      // syscall branch is: a Node fs error quotes the path this CLI built, and nothing that
      // reaches a terminal should carry bytes unfiltered.
      io.out(`cannot write the results file at ${printable(resultsPath)}: ${printable(err.message)} — the results above are complete; redirect them to a file and pass that to gate --results`)
      return 4
    }
    io.out(`results written to ${printable(resultsPath)} — pass that path to gate --results`)
    return 0
  }

  if (command === 'gate') {
    let config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) {
      const pkg = await readPackage(root)
      config = inferGateConfig(pkg)
      io.out(`inferred gate manifest — review, then save as ${NAMES.gateFile}:`)
      io.out(JSON.stringify(config, null, 2))
      // `preview.link` is inferred only for a Node project, because `node_modules` is the one
      // build input this CLI can name without guessing. Every other ecosystem gets a manifest
      // with no preview field at all, links nothing into the merge preview — which holds
      // tracked content only — and fails every command check on a tree that is fine. The
      // manifest cannot carry the warning (JSON has no comment, and an empty link list means
      // "link nothing", which is both wrong as advice and indistinguishable from a considered
      // choice), so it is printed beside it, and only where it applies.
      if (!pkg) {
        io.out('')
        io.out('no package.json: the merge preview is built with `git worktree add`, which materializes tracked files only. If this project\'s test runner is itself a dependency — a virtualenv, `target/`, `vendor/` — name those directories or the gate will fail every command check on a tree that is fine:')
        io.out('    "preview": { "link": ["<dir>", "..."] }')
      }
      return 3
    }
    const phaseName = flags.phase ?? 'default'
    const all = checksForPhase(config, phaseName)
    // `=== true`, matching missingArgs: the two must agree about what counts as solo, or one
    // of them drops --run and --plan from the requirements while the other still runs the
    // enforcement checks, or vice versa.
    const solo = flags['no-fleet'] === true

    // --no-fleet is the only way the enforcement checks are skipped, and the caller must
    // say it. Inferring "solo" from missing state let deleting one file record a PASS.
    //
    // Through `narrowChecks`, because this narrows the manifest's list exactly as
    // `--enforcement-only` does: a plain `.filter` here renumbered the entries and `gate --no-fleet`
    // named the wrong entry of `fleetmates.gate.json` in the malformed-entry diagnosis.
    const { checks, checkPositions } = narrowChecks(
      all,
      (c) => !solo || (kindOf(c) !== 'fileset' && kindOf(c) !== 'ownership'),
    )
    if (solo) io.out('--no-fleet: enforcement checks are not running')

    // Read once, at the moment of the run. The file is never persisted and never read back
    // from `.fleetmates/`; it fills in this run's pending checks and nothing else.
    let supplied = []
    // A valueless `--results` never reaches here: missingArgs rejects it as the missing
    // argument it is, rather than letting this guard silently drop the flag.
    if (flags.results) {
      try {
        const parsed = JSON.parse(await readFile(flags.results, 'utf8'))
        supplied = Array.isArray(parsed?.results) ? parsed.results : null
      } catch {
        supplied = null
      }
      if (supplied === null) {
        io.out('--results must be a readable JSON file shaped { "results": [...] }\n')
        return 2
      }
    }

    let ctx = { cwd: root }
    if (!solo) {
      try {
        ctx = { cwd: root, previewLink: previewLinks(config), ...(await derive(root, runId, flags)) }
      } catch (err) {
        io.out(JSON.stringify({ verdict: 'FAIL', failed: ['derive'], error: err.message }, null, 2))
        return 1
      }
      // The gate runs on the run branch, once per phase, for the life of the run — so this is the
      // repair that makes the stop-time guard's input right even when `init-run` could not know it.
      await rememberRunBranch(root, runId, ctx.runBranch, ctx.baseBranch)
    }

    const rawResults = await runChecks(checks, { ...ctx, checkPositions })
    const invalid = validateSuppliedResults(supplied, checks)
    if (invalid) { io.out(`${invalid}\n`); return 2 }
    const results = mergeSuppliedResults(rawResults, supplied)
    const verdict = aggregateVerdict(results)
    const branchShas = Object.assign({}, ...results.map((r) => r.branchShas ?? {}))
    // `phase` is the numeric plan phase derived from git; `phaseName` is the manifest key
    // this gate selected its checks under. They are two different key spaces and the
    // verdict carries both, so `fix` can filter tasks by the number while looking the
    // fix-round budget up under the very key that produced these checks.
    let bound = {
      ...verdict,
      anchorSha: ctx.anchorSha,
      planHash: ctx.planHash,
      branchShas,
      phase: ctx.currentPhase,
      phaseName,
    }

    // Recorded for digests and supervision. Nothing reads this to decide anything.
    //
    // A solo (--no-fleet) verdict never derived an anchor, so it must not land under the
    // same key a real, derived phase record uses — otherwise `--phase 1 --no-fleet`
    // silently overwrites phase 1's real, anchorSha-bearing record with one that carries
    // no anchor at all. Solo records get a `solo:` prefix so the two namespaces cannot
    // collide, however the phase name is spelled.
    const gateKey = solo ? `solo:${phaseName}` : String(ctx.currentPhase ?? phaseName)
    // --run is optional in solo mode (see missingArgs): without it there is no run to
    // record anything against, so skip straight to the exit code.
    //
    // Read BEFORE the verdict is printed. status.json is agent-writable, and a corrupt one
    // is a gate failure, not a footnote: printing a computed `"verdict": "PASS"` and then
    // appending `could not read run state: ...` both contradicts the exit code and leaves
    // stdout unparseable as JSON for the caller that has to read it.
    let status = null
    let stateError = null
    if (typeof runId === 'string') {
      try {
        status = await readState(root, runId, 'status')
        // plan.json is read here too, and only to be VALIDATED. It is as agent-writable as
        // status.json, and the run-branch refresh above reads it — a refresh that must never be
        // what decides anything, so it swallows its own errors. Without this line a corrupt
        // plan.json therefore produced no diagnosis at all from `gate`: the refresh ignored it and
        // nothing else looked. Routed through the same fail-closed path as status.json, so
        // unreadable run state is a gate failure with parseable JSON on stdout, not a footnote.
        await readState(root, runId, 'plan')
      } catch (err) {
        stateError = err.message
      }
    }
    if (stateError) {
      bound = {
        ...bound,
        verdict: 'FAIL',
        failed: [...verdict.failed, 'run-state'],
        error: `could not read run state: ${stateError}`,
      }
      io.out(JSON.stringify({ ...bound, results }, null, 2))
      return 1
    }
    io.out(JSON.stringify({ ...bound, results }, null, 2))

    if (status) {
      status.gates = status.gates ?? {}
      // Object.defineProperty bypasses any inherited setter — notably the legacy
      // `__proto__` accessor on Object.prototype — so a manifest or CLI flag naming a
      // phase "__proto__" creates a real, retrievable own property instead of silently
      // rewriting status.gates's prototype and losing the record.
      Object.defineProperty(status.gates, gateKey, {
        value: { ...bound, recordedAt: Date.now() },
        enumerable: true,
        configurable: true,
        writable: true,
      })
      await writeState(root, runId, 'status', status)
    }
    return verdict.verdict === 'PASS' ? 0 : 1
  }

  if (command === 'complete') {
    const config = await resolveGateConfig(root, io)
    // 2, not 4: a broken manifest is a config failure like every other one in this CLI, and
    // `cannot verify completion` would send a teammate looking at its own branch instead.
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out('no gate manifest — cannot verify completion'); return 4 }

    // Checked before a single check runs and before the context is derived, exactly as `finish`
    // and `prune-run` check it: the caller learns the flag is the wrong tool for this manifest
    // rather than reading a verdict that was never grounded in anything. 2, not the rejection
    // code — this is an answer about the manifest, never about the task.
    const enforcementOnly = flags['enforcement-only'] === true
    if (enforcementOnly) {
      const refusal = enforcementOnlyRefusal(config, [flags.phase ?? 'default'])
      if (refusal) { io.out(refusal); return 2 }
    }

    let ctx
    try {
      ctx = { cwd: root, previewLink: previewLinks(config), ...(await derive(root, runId, flags)) }
    } catch (err) {
      io.out(`cannot verify completion: ${err.message}`)
      return 4
    }

    // FAIL OPEN unless the checked-out branch really is this run's run branch.
    //
    // `derive` takes the run branch from whatever the MAIN worktree has checked out. That is the
    // operator's state, not the teammate's, and with the main worktree parked on an unrelated
    // branch every check is computed against the wrong ref: a compliant teammate is told
    // `fileset: T1: outside declared set — b.mjs` and, under --enforcement-only, blocked from
    // stopping and instructed to delete a sibling's landed file. A teammate must never be blocked
    // by state it did not write.
    //
    // The signal is `runBranch` in plan.json, written by `init-run` — the same shape and the same
    // reason as `planPath`, which is already recorded there so a stop-time hook need not be told
    // it. Nothing else in the repository records which branch a run belongs to: the gate derives
    // it from HEAD every time, which is precisely the assumption that breaks here.
    //
    // Scoped to `--enforcement-only`, which is the hook's invocation and the only one whose
    // answer costs a teammate a turn. A human running `complete` by hand from another branch
    // still gets the derived answer, unchanged.
    //
    // Absent `runBranch` — a run from before this was recorded, or an `init-run` that could not
    // read git — is "cannot confirm", and cannot-confirm allows. That is the whole point: this
    // guard may only ever turn a block into a non-block.
    if (enforcementOnly) {
      const planState = await readState(root, runId, 'plan')
      const stored = typeof planState?.runBranch === 'string' ? planState.runBranch : null
      // A recorded value equal to the BASE branch is not a run branch and never matches one, so
      // it is treated as absent rather than as a mismatch. `init-run` no longer writes that, but
      // a plan.json written by an earlier CLI can carry it, and the difference matters: absent
      // says "nothing to compare against", while a mismatch would accuse a correct checkout.
      const recorded = stored === ctx.baseBranch ? null : stored
      if (recorded === null || recorded !== ctx.runBranch) {
        io.out(
          `cannot verify completion: this repository has ${printable(ctx.runBranch)} checked out`
          + `${recorded === null ? ', and run ' + printable(runId) + ' recorded no run branch to compare it against' : `, not run ${printable(runId)}'s branch ${printable(recorded)}`}`
          + '. Every check would be computed against the wrong ref, so nothing here is a verdict about this task.',
        )
        return COMPLETE_CANNOT_VERIFY
      }
    }

    const allChecks = checksForPhase(config, flags.phase ?? 'default')
    const taskKnown = (ctx.tasks ?? []).some((t) => t.id === flags.task)
    if (!taskKnown) { io.out(`no task ${flags.task} in the plan`); return 4 }

    // `complete` verifies the calling task, not the whole phase. Anything that walks every
    // task in the current phase — `runFilesetCheck`, and the merge preview `runChecks`
    // builds — otherwise fails the first teammate to finish on a sibling's missing or
    // non-compliant branch, indistinguishable from "my own work is wrong". The scope is
    // declared once, as an explicit `taskScope` marker on the context, and `gate-runner`
    // honours it in both places. `gate` never sets it, so `gate` stays phase-wide: the
    // full gate remains its job, and phase-gate still runs it before integration, so a
    // phase can never advance without every task passing.
    //
    // `tasks` stays intact. `runOwnershipCheck` must stay run-wide — it explains every
    // commit on the run branch, not just this task's, so narrowing the task list would
    // hide a direct write riding in behind whichever task finishes first. Narrowing
    // `tasks` is exactly what the marker replaces.
    //
    // One `runChecks` call over the combined list, not one per kind: each call builds its
    // own merge preview, so splitting them did the work twice and emitted two results
    // named `merge` that could disagree with each other.
    const taskCtx = { ...ctx, taskScope: flags.task }

    // The gate is recomputed. A PASS recorded in status.json is never consulted, so a
    // stale or forged one buys nothing.
    const results = await runPhaseChecks(allChecks, taskCtx, enforcementOnly)
    const verdict = aggregateVerdict(results)

    // A check that did not run is reported by name and by reason, every time and whatever the
    // verdict — `--enforcement-only` here, and the merge-conflict skip `runChecks` produces on
    // its own. This is the only thing that says a cheap answer was cheap, and a verdict that
    // hides which checks it dropped is worse than a slow one. Both the name and the note come
    // out of an agent-written manifest, so both go through the escaping the failure lines use.
    for (const r of results) {
      if (r.status === 'skip' && r.output) io.out(`skipped: ${printable(r.name)}: ${printableBlock(r.output)}`)
    }

    if (verdict.verdict !== 'PASS') {
      const names = [...verdict.failed, ...verdict.pending]
      // The names come from the gate manifest, which is a file in the worktree this command is
      // run from — the same source as `r.name` below, which already goes through `printable`.
      // The summary line was the half that did not, so a check name could erase this refusal.
      io.out(`gate does not pass for phase ${ctx.currentPhase}: ${names.map(printable).join(', ')}`)
      // A check's output is a block with its own line structure — a captured command output, a
      // fileset check enumerating branch and file names an enforced teammate chose — so it takes
      // the block form: escape sequences are neutralised, the line breaks it legitimately
      // contains are kept.
      for (const r of results) {
        if (names.includes(r.name) && r.output) io.out(`${printable(r.name)}: ${printableBlock(r.output)}`)
      }
      // A `pending` result carries no `output` at all, so the loop above prints nothing for it and
      // the check appeared in the summary line with no explanation whatsoever. That is not a
      // hypothetical: this repository's own manifest declares `{"name":"review","kind":"agent"}`,
      // no runner answers to `agent`, and so EVERY `complete` on the default manifest lists
      // `review` among the failures with not one word about it — including for a task that is
      // entirely compliant. Named as what it is, and named distinctly from a check that ran and
      // failed, because the two call for opposite responses from the teammate reading them.
      for (const r of results) {
        if (r.status === 'pending' && names.includes(r.name)) {
          io.out(
            `could not run: ${printable(r.name)} (kind ${printable(r.kind)}) — this CLI has no runner`
            + ' for that kind, so the check never executed. Nothing on your branch changes it.',
          )
        }
      }
      const code = completeExitCode(results, verdict)
      // Said in words as well as in the code, because nothing above this line distinguishes the
      // cases: the summary is the same sentence either way and only the named checks differ.
      //
      // Deliberately NOT "this is not your work". A `command` check also earns this code — it is
      // not task-scoped, and under --enforcement-only it never ran at all — but it tests the
      // merged tree, and a teammate told to ignore a red suite would return done on one. The line
      // states which question was answered and leaves the reading of the named checks to the
      // brief's table, which can afford the room to separate them.
      if (code === COMPLETE_CANNOT_VERIFY) {
        io.out(
          `no task-scoped check (${[...TASK_SCOPED_KINDS].join(', ')}) rejected your work:`
          + ' what failed above is run-wide, could not run, or tests the merged tree.'
          + ' The phase gate recomputes all of it.',
        )
      }
      return code
    }

    const status = await readState(root, runId, 'status')
    if (!status) { io.out(`no status for run ${runId}`); return 1 }
    const task = (status.tasks ?? []).find((t) => t.id === flags.task)
    if (!task) { io.out(`no task ${flags.task} in run ${runId}`); return 1 }
    // The enforcement-only verdict is not evidence the task is finished: every `command` check
    // was skipped, and this path exists to be run from a stop-time hook against a teammate that
    // may be stopping mid-work or reporting `blocked`. Writing `done` there would have `digest`
    // and `doctor` reporting a task complete that its own author just called unfinished. Exit 0
    // regardless — the hook allows the stop on it, and the phase gate still decides the phase.
    if (enforcementOnly) {
      io.out(`${printable(flags.task)} passes the enforcement checks — not marked done, because --enforcement-only ran no command check`)
      return 0
    }
    task.state = 'done'
    await writeState(root, runId, 'status', status)
    io.out(`${flags.task} done`)
    return 0
  }

  // Every computed decision — `none`, `retry`, and `escalate` alike — exits 0. The caller
  // reads the `decision` field, not the exit code: a retry also has to carry the task list
  // and the tier each task retries at, and an exit code cannot carry that. A non-zero exit
  // here means this command could not compute a decision at all (missing run state, an
  // unreadable verdict), which is a different condition from "the phase must escalate".
  //
  // This command decides nothing about the gate itself. The verdict it reads was computed
  // from git by `gate`; nothing here can turn a FAIL into a PASS.
  if (command === 'fix') {
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId}`); return 1 }
    const status = await readState(root, runId, 'status')

    let verdict
    try {
      verdict = JSON.parse(await readFile(flags.verdict, 'utf8'))
    } catch (err) {
      // The verdict file is written by the agent that ran the gate — `skills/phase-gate/SKILL.md`
      // instructs it to — and Node embeds a slice of the parsed input in a JSON parse error, so
      // this message carries bytes out of that file. `printable` on both halves, exactly as
      // `readSuppliedPhases` does for a `--results` file: see its definition in `reviews.mjs`.
      io.out(`cannot read verdict at ${printable(flags.verdict)}: ${printable(err.message)}`)
      return 1
    }

    // Validated as an integer by missingArgs, then normalised: `--phase 01` and `--phase 1`
    // must select the same tasks and read the same round counter, not two disjoint string
    // keys. Every phase comparison below this line is numeric.
    const phase = Number(flags.phase)

    // The verdict names the phase it was computed for. A `--phase` that disagrees with it
    // is an argument error, not a decision: adjudicating phase 3 against phase 1's verdict
    // silently selects the wrong task set and reports `unattributable` for findings that
    // are perfectly attributable to the phase that actually failed.
    if (Number.isInteger(verdict?.phase) && verdict.phase !== phase) {
      // `verdict.phase` is a real integer by the guard above. The other two are not: `flags.phase`
      // is the STRING that was typed, and `missingArgs` admits it on `Number.isInteger(Number(x))`
      // — which `Number` also accepts for `0x1`, `1.0`, `1e0`, `+1`, and any string that is only
      // leading/trailing whitespace-class characters (including `\r1`, `\n1`, ` 1`). The bound
      // this guard actually gives: whatever reaches this printed line is a non-integer spelling
      // of an integer, and every consumer downstream in this command is `Number(flags.phase)` —
      // not a claim that the text itself is constrained. A line break here is still a line this
      // CLI did not mean to draw, so both it and the path are wrapped, for the same reason the
      // parse-error line above wraps what it quotes.
      io.out(`--phase ${printable(flags.phase)} does not match the verdict's phase ${verdict.phase} at ${printable(flags.verdict)}\n\n${USAGE}`)
      return 2
    }

    const gateConfig = await resolveGateConfig(root, io)
    if (gateConfig === GATE_CONFIG_REJECTED) return 2
    // A broken manifest must not reach here as `{}`: the fix budget would silently become the
    // default, which is the outcome an operator reading `budget-exhausted` cannot tell from a
    // budget they actually set.
    const config = gateConfig ?? {}
    // decideFix attributes findings to the tasks that declared the cited files, so it must
    // see only the failing phase's tasks — a file declared by a later phase's task is not
    // this phase's to retry.
    const phaseTasks = (plan.tasks ?? []).filter((t) => Number(t.phase) === phase)
    // Two key spaces meet here. Task selection and the round counter are keyed by the
    // NUMERIC phase; fleetmates.gate.json is keyed by phase NAME (`default`, `integration`),
    // which is what `gate --phase` selects checks under. The manifest key space wins for
    // the budget, and the gate's own verdict carries the name it used forward as
    // `phaseName` — so the budget comes from the same manifest block that produced these
    // checks instead of missing and silently falling back to the default.
    const budgetKey = typeof verdict?.phaseName === 'string' ? verdict.phaseName : String(phase)
    const decision = decideFix(
      verdict,
      phase,
      phaseTasks,
      // Already the per-phase `{ taskId: count }` map; decideFix does not index it again.
      readFixRounds(status, phase),
      { fixRounds: fixRoundsForPhase(config, budgetKey) },
    )
    io.out(JSON.stringify(decision, null, 2))
    return 0
  }

  // The writer for the counter `fix` reads. Deliberately a separate subcommand rather than a
  // side effect of `fix`: `fix` is a pure read that a caller may re-run freely (to re-inspect
  // a decision, or after an unrelated crash), and a read that writes would double-count every
  // one of those re-runs and burn the budget without a retry ever happening. The caller
  // records a round when it ACTUALLY DISPATCHES a retry — that is the moment a round happens
  // — and keeping the write separate from the decision is what makes it exactly-once.
  if (command === 'record-fix-round') {
    const phase = Number(flags.phase)
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId}`); return 1 }
    const status = await readState(root, runId, 'status')
    if (!status) { io.out(`no status for run ${runId}`); return 1 }

    // A round is spent against a budget that belongs to one task in one phase, so the pair
    // must exist in the plan. This also keeps an arbitrary caller-supplied string — say
    // `__proto__` — from ever reaching the round map as a key.
    const known = (plan.tasks ?? []).some((t) => t.id === flags.task && Number(t.phase) === phase)
    if (!known) { io.out(`no task ${flags.task} in phase ${phase} of run ${runId}`); return 1 }

    const next = recordFixRound(status, phase, flags.task)
    await writeState(root, runId, 'status', next)
    io.out(`${flags.task} phase ${phase} round ${readFixRounds(next, phase)[flags.task]}`)
    return 0
  }

  // Reads the subcommand and key from `positional`, targets a layer with `--local`, and maps
  // every ConfigError to exit 2 with the message on stdout — a skill branches on this exit
  // code, so a validation failure must never surface as a stack trace.
  if (command === 'config') {
    const [sub, key, rawValue] = positional
    // `=== true`, not `!== undefined`: `--local` is in VALUELESS_FLAGS, so it is the only value
    // the parser can produce for it, and testing identity keeps `--local false` from reading as
    // "select the local layer" the way any-defined-value did.
    const local = flags.local === true
    const file = local ? LOCAL_FILE : GATE_FILE
    try {
      if (sub === 'list') {
        const { resolved, sources } = await loadValidatedConfig(root)
        io.out(`maxParallel  ${resolved.maxParallel}  (${sources.maxParallel})`)
        io.out(`caveman      ${resolved.caveman}  (${sources.caveman})`)
        for (const role of ROLES) {
          const entry = resolved.agents[role]
          // Provenance is per FIELD, not per role: a role whose tier comes from the tracked
          // manifest and whose effort comes from the local file must not report one layer for
          // both. `sources` is keyed as `agents.<role>.<field>` for exactly this reason.
          io.out(`agents.${role}.tier    ${entry.tier ?? '-'}  (${sources[`agents.${role}.tier`]})`)
          io.out(`agents.${role}.effort  ${entry.effort ?? '-'}  (${sources[`agents.${role}.effort`]})`)
        }
        return 0
      }
      if (sub === 'get') {
        if (!key) { io.out('config get needs a key'); return 2 }
        // The same two guards, in the same order, as `set` and `unset` below. `getKey` does
        // re-check the key itself, but only AFTER the layers have been read, and the known-key
        // check has to come between the two — so the order is stated here rather than inherited
        // from whichever callee happens to run first. Without the known-key check,
        // `config get agents.implementer` printed `[object Object]` and exited 0.
        assertSafeKey(key)
        assertKnownKey(key, CONFIG_KEYS)
        const { resolved } = await loadValidatedConfig(root)
        const value = getKey(resolved, key)
        if (value === undefined) { io.out(`unset: ${key}`); return 2 }
        io.out(String(value))
        return 0
      }
      if (sub === 'set' || sub === 'unset') {
        if (!key) { io.out(`config ${sub} needs a key`); return 2 }
        // assertSafeKey runs for BOTH set and unset, and before anything reads or writes a
        // layer. `unset` reaches the same object walk as `set`, so a key guarded on only one
        // of the two leaves the other as a live path to Object.prototype.
        assertSafeKey(key)
        if (local && isEnforcementKey(key)) {
          io.out(`${key} is an enforcement key; it may only be set in ${GATE_FILE}`)
          return 2
        }
        // ABSENT rather than readLayer's default `null`, which it also returns for a file
        // whose whole body is `null`. Collapsed together, an absent file and a `null` one
        // would both become `{}` here — and a `null` body is a layer every READER already
        // exits 2 on, so writing it into shape would be the same file answering two ways
        // again, one layer down.
        const raw = await readLayer(root, file, { missing: ABSENT })
        const layer = raw === ABSENT ? {} : raw
        // Whichever layer this is. `readLayer` parses but does not validate, and `?? {}` only
        // catches a nullish body: a file holding `[]` or `"text"` reached `setKey`, which set
        // a property `JSON.stringify` then dropped — reported as `wrote …` at exit 0 — or
        // threw a raw TypeError. Both layers get the check, in the one place that writes them,
        // and the counterpart layer gets it too so this command agrees with every reader about
        // the repository it is writing into.
        await validateBothLayers(root, file, layer)
        if (sub === 'set') {
          if (rawValue === undefined) { io.out('config set needs a value'); return 2 }
          let parsed
          // JSON first so numbers and `false` arrive as themselves; a bare word that is not
          // valid JSON is the string the caller typed, so `set agents.implementer.tier capable`
          // works without shell quoting.
          try { parsed = JSON.parse(rawValue) } catch { parsed = rawValue }
          setKey(layer, key, validateKey(key, parsed))
        } else {
          assertKnownKey(key, UNSETTABLE_KEYS)
          unsetKey(layer, key)
        }
        await writeLayer(root, file, layer)
        io.out(`wrote ${file}`)
        if (local) {
          const added = await ensureGitignored(root, LOCAL_FILE)
          if (await isTracked(root, LOCAL_FILE)) {
            io.out(
              `${LOCAL_FILE} is tracked by git — the .gitignore entry has no effect on it;`
              + ` run \`git rm --cached ${LOCAL_FILE}\` to keep this layer out of commits`,
            )
          } else if (added) {
            io.out(`added ${LOCAL_FILE} to .gitignore`)
          }
        }
        return 0
      }
      io.out('usage: config <list|get|set|unset>')
      return 2
    } catch (err) {
      const message = configFailureMessage(err)
      if (message === null) throw err
      io.out(message)
      return 2
    }
  }

  io.out(USAGE)
  return 2
}

// import.meta.main only exists from Node 24.2. On an older runtime it is undefined, and
// treating that as falsy would make the CLI print nothing and exit 0 — which a caller like
// phase-gate reads as PASS. Fall back to comparing argv[1] against this module's own path
// so the guard never silently skips running a subcommand.
export function isEntryPoint(main, argv1, moduleUrlPath) {
  if (main !== undefined) return main
  return argv1 === moduleUrlPath
}

if (isEntryPoint(import.meta.main, process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2))
}
