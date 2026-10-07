// Bounded execution of the fixed workflow-profile fragments. The controller loads committed
// inputs itself, probes capabilities and the environment through the supplied executor, and
// releases a dependent step only after the artifacts its predecessor names were read back and
// validated. No command, path or authority is taken from an artifact or from model text.
import { createHash, randomUUID } from 'node:crypto'
import { realpath, lstat, open, mkdir, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createGit } from './git.mjs'
import { git as gitSync, lifecycleStatus } from './workflow-lifecycle.mjs'
import { expandWorkflowProfile, profileTaskResultAccepted } from './workflow-profile.mjs'
import { evidenceIdentity } from './workflow-evidence.mjs'
import { strictExecutionIdentity, summarizeCompletionObligations } from './completion-obligations.mjs'
import { retainExecutionArtifact, readExecutionArtifact } from './execution-artifacts.mjs'
import { appendExecutionEvent, readExecutionEvents, strictExecutionAttempts } from './execution-journal.mjs'
import { reconcileExecutionAttempt } from './execution-recovery.mjs'
import { validateRolePolicy, resolveRoleCapabilities } from './role-capabilities.mjs'
import { probeCapabilities } from './capability-preflight.mjs'
import { validateEnvironmentRecipe, captureEnvironment } from './environment-preflight.mjs'
import { checksForPhase } from './gate-config.mjs'
import { reviewStamp, reviewStale } from './reviews.mjs'
import { taskBranchName } from './enforce.mjs'
import { NAMES } from './names.mjs'
import { executeReviewedPhaseGate, executeReviewedPhaseGateFixture, integrateReviewedPhase,
  integrateReviewedPhaseFixture } from './reviewed-integration.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const STEP_COMMAND = { prepare: 'init-run', baseline: 'preview-check', implement: 'dispatch', review: 'dispatch-reviews',
  collect: 'collect-reviews', gate: 'gate', finish: 'finish' }
const COMMANDS = new Set(Object.values(STEP_COMMAND))
const REQUEST_KEYS = ['version', 'profile', 'runId', 'planPath', 'baseBranch', 'runBranch', 'harness', 'sandboxMode', 'parameters', 'limits']
const LIMITS = { maxWallMs: [1000, 86_400_000], maxAttempts: [1, 500], maxRepairRounds: [0, 10], stepTimeoutMs: [1000, 21_600_000] }
const RETENTION_UPPER = { maxArtifactBytes: 16 * 1024 * 1024, maxRunBytes: 256 * 1024 * 1024, maxAgeMs: 365 * 24 * 60 * 60 * 1000 }
const OUTPUT_BYTES = 4 * 1024 * 1024, FILE_BYTES = 1024 * 1024, SOURCE_BYTES = 512 * 1024, CLI_BYTES = 8 * 1024 * 1024
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const WRITE_LINE = /^results written to (.+) — pass that path to gate --results$/
const TRUST = ['Commands come only from the fixed workflow-profile fragments and the fixed fix-decision call, run as the absolute installed CLI with an explicit project root.',
  'Executor, capability and environment observations are local same-UID observations, not hostile-process isolation.',
  'An injected verification fixture never establishes completion; publication and remote effects are absent.',
  'An agent step that was interrupted or timed out is an unknown effect and is not redispatched automatically.',
  'A code failure stops with the existing fix decision; the controller dispatches no repair round.']

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
const repoPath = value => text(value) && !value.startsWith('/') && !value.startsWith('-') && !/[\\:]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..')
function exactKeys(value, required, optional, label) {
  if (!plainObject(value)) throw new Error(`Invalid ${label}`)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || ![...required, ...optional].includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`Invalid ${label} field`)
  }
  if (required.some(key => !Object.hasOwn(value, key))) throw new Error(`Missing ${label} field`)
}
function branchName(value, cwd) {
  if (!text(value, 255) || value.startsWith('-') || value.startsWith('refs/')) throw new Error('Invalid request branch')
  gitSync(['check-ref-format', '--branch', value], cwd)
}
function validateRequest(request) {
  exactKeys(request, REQUEST_KEYS, [], 'workflow request')
  if (request.version !== 1 || !text(request.profile, 64) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(request.runId ?? '')
      || !repoPath(request.planPath) || !['codex', 'cursor'].includes(request.harness) || !['clone', 'files'].includes(request.sandboxMode)
      || request.baseBranch === request.runBranch || !plainObject(request.parameters)
      || Buffer.byteLength(JSON.stringify(request.parameters)) > 4096) throw new Error('Invalid workflow request')
  exactKeys(request.limits, Object.keys(LIMITS), [], 'workflow request limits')
  for (const [key, [low, high]] of Object.entries(LIMITS)) {
    if (!Number.isSafeInteger(request.limits[key]) || request.limits[key] < low || request.limits[key] > high) throw new Error(`Invalid workflow request limit ${key}`)
  }
  return structuredClone(request)
}
function validateRetention(retention) {
  exactKeys(retention, Object.keys(RETENTION_UPPER), [], 'retention')
  for (const [key, upper] of Object.entries(RETENTION_UPPER)) {
    if (!Number.isSafeInteger(retention[key]) || retention[key] <= 0 || retention[key] > upper) throw new Error(`Invalid retention ${key}`)
  }
  return { ...retention }
}
function validateAcceptance(acceptance) {
  if (acceptance === undefined) return []
  if (!Array.isArray(acceptance) || acceptance.length > 20) throw new Error('Invalid acceptance evidence list')
  for (const entry of acceptance) {
    exactKeys(entry, ['criterion', 'reference'], [], 'acceptance evidence')
    if (!text(entry.criterion, 128)) throw new Error('Invalid acceptance criterion')
  }
  return structuredClone(acceptance)
}

// A bounded, no-follow read of a regular file that must stay inside the project root.
async function readInside(root, relative, max = FILE_BYTES) {
  const file = path.join(root, relative)
  if (!file.startsWith(root + path.sep)) return null
  let info
  try { info = await lstat(file) } catch { return null }
  if (!info.isFile() || info.nlink !== 1 || info.size > max) return null
  try { if (await realpath(path.dirname(file)) !== path.dirname(file)) return null } catch { return null }
  let handle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) } catch { return null }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== info.ino || opened.size > max) return null
    const buffer = Buffer.alloc(opened.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return offset === opened.size ? buffer.subarray(0, offset) : null
  } finally { await handle.close() }
}
const parseJson = bytes => { try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) } catch { return undefined } }

async function committedBlob(git, commit, file) {
  if (!repoPath(file)) throw new Error('Invalid committed source path')
  const mode = await git.fileModeAtCommit(commit, file)
  if (mode !== '100644' && mode !== '100755') throw new Error(`Committed source ${file} is not a regular file`)
  const size = await git.fileSizeAtCommit(commit, file)
  if (size > SOURCE_BYTES) throw new Error(`Committed source ${file} exceeds its byte bound`)
  const bytes = await git.fileAtCommit(commit, file)
  if (typeof bytes !== 'string' || bytes.includes('�') || Buffer.byteLength(bytes) !== size) throw new Error(`Committed source ${file} is not lossless UTF-8`)
  return bytes
}
const refTip = (root, ref) => { try { return gitSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], root) } catch { return null } }

async function resolveHost({ root, cliPath }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Project root must be an absolute path')
  if (typeof cliPath !== 'string' || !path.isAbsolute(cliPath)) throw new Error('Installed CLI entrypoint must be an absolute path')
  const canonicalRoot = await realpath(root)
  if (await realpath(gitSync(['rev-parse', '--show-toplevel'], canonicalRoot)) !== canonicalRoot) throw new Error('Project root is not a Git worktree root')
  const cli = await realpath(cliPath)
  const info = await lstat(cli)
  if (path.basename(cli) !== 'cli.mjs' || !info.isFile() || info.size > CLI_BYTES) throw new Error('Installed CLI entrypoint must be a regular cli.mjs file')
  const handle = await open(cli, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let bytes
  try { bytes = await handle.readFile() } finally { await handle.close() }
  const common = await realpath(gitSync(['rev-parse', '--path-format=absolute', '--git-common-dir'], canonicalRoot))
  return { root: canonicalRoot, cliPath: cli, verifier: hash(bytes), common }
}
const verifierNow = async cliPath => {
  try {
    const handle = await open(cliPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { return hash(await handle.readFile()) } finally { await handle.close() }
  } catch { return null }
}

function expectedStepIds(phases) {
  return ['prepare', 'baseline', ...phases.flatMap(p => ['implement', 'review', 'collect', 'gate', 'integrate'].map(s => `${s}-${p}`)), 'acceptance', 'finish']
}
// Independent structural validation: the expansion must be exactly the fixed fragment set, bound to
// the inputs this controller read, with every argv on the CLI whitelist for its step.
export function validateWorkflowExpansion(expanded, { inputs, request }) {
  const { profileHash, ...rest } = expanded
  if (profileHash !== hash(JSON.stringify(rest)) || expanded.identity !== evidenceIdentity(inputs)
      || expanded.integration !== 'host-bounded' || expanded.mode !== 'dry-run') throw new Error('Expanded profile identity does not match its committed inputs')
  const phases = expanded.phaseContracts.map(c => c.phase)
  const ids = expanded.steps.map(s => s.id)
  if (JSON.stringify(ids) !== JSON.stringify(expectedStepIds(phases))) throw new Error('Expanded profile steps are not the fixed fragment set')
  for (const step of expanded.steps) {
    const kind = step.id.replace(/-\d+$/, '')
    if (kind === 'integrate') {
      if (step.kind !== 'host-integration' || step.mode !== 'host-bounded' || step.argv !== undefined) throw new Error('Integration must be host-bounded')
      continue
    }
    if (kind === 'acceptance') {
      if (step.kind !== 'judgment-or-human' || step.argv !== undefined) throw new Error('Acceptance must be judgment-or-human evidence')
      continue
    }
    const argv = step.argv
    if (!Array.isArray(argv) || argv.length > 32 || argv[0] !== 'node' || argv[1] !== 'scripts/cli.mjs' || argv[2] !== STEP_COMMAND[kind]
        || !COMMANDS.has(argv[2]) || argv.some(arg => !text(arg)) || argv.includes('--root')
        || (kind === 'baseline' ? argv.length !== 3 : argv.indexOf('--run') < 0 || argv[argv.indexOf('--run') + 1] !== request.runId)) throw new Error(`Step ${step.id} is not a whitelisted CLI fragment`)
    const phaseResults = `${NAMES.stateDir}/${request.runId}/reviews/results-${step.id.replace(/^\D+-/, '')}.json`
    if (kind === 'collect' && step.resultsPath !== phaseResults) throw new Error('Unexpected review results path')
    // The controller hands gate the path collect-reviews named, so the fragment must name that same file.
    if (kind === 'gate' && (argv.indexOf('--results') < 0 || argv[argv.indexOf('--results') + 1] !== phaseResults)) throw new Error('gate must read the collected review results')
    if (kind === 'finish' && argv[argv.indexOf('--results') + 1] !== `${NAMES.stateDir}/${request.runId}/reviews/finish-results.json`) throw new Error('finish must receive the collected review results')
  }
  return phases
}

function blocker(category, step, reason) { return { category, step, reason: String(reason).slice(0, 512) } }

function journalBranches(ctx) {
  const refs = [`refs/heads/${ctx.request.baseBranch}`, `refs/heads/${ctx.request.runBranch}`,
    ...ctx.tasks.map(task => `refs/heads/${taskBranchName(ctx.request.runId, task.id)}`)]
  const observed = {}
  for (const ref of refs) { const tip = refTip(ctx.root, ref); if (tip) observed[ref] = tip }
  return observed
}

async function retain(ctx, kind, bytes) {
  const { reference } = await retainExecutionArtifact({ common: ctx.common, runId: ctx.request.runId, kind, bytes: Buffer.from(bytes), retention: ctx.retention, now: ctx.tick() })
  ctx.observations.set(JSON.stringify(reference), reference)
  return reference
}
async function observe(ctx, reference) {
  try {
    await readExecutionArtifact({ common: ctx.common, runId: ctx.request.runId, reference, retention: ctx.retention })
    ctx.observations.set(JSON.stringify(reference), reference)
    return true
  } catch { return false }
}
async function readArtifact(ctx, reference) {
  const bytes = await readExecutionArtifact({ common: ctx.common, runId: ctx.request.runId, reference, retention: ctx.retention })
  ctx.observations.set(JSON.stringify(reference), reference)
  return bytes
}

function event(ctx, step, attempt, kind, artifacts = []) {
  return { version: 2, id: randomUUID(), runId: ctx.request.runId, executionId: ctx.executionId, task: 'profile', step, attempt, kind,
    at: ctx.tick(), inputs: ctx.inputs, branches: journalBranches(ctx), checkout: 'root', artifacts }
}
async function append(ctx, raw, fresh = false) {
  return appendExecutionEvent(ctx.common, raw, { now: raw.at, requireFreshStart: fresh })
}

// ---- step validators: each returns { ok, artifacts: [{ kind, bytes }], reason?, category? } ----

async function validatePrepare(ctx) {
  const bytes = await readInside(ctx.root, `${NAMES.stateDir}/${ctx.request.runId}/plan.json`)
  const plan = bytes && parseJson(bytes)
  if (!plainObject(plan) || plan.runId !== ctx.request.runId || plan.runBranch !== ctx.request.runBranch || !Array.isArray(plan.tasks)
      || JSON.stringify(plan.tasks.map(t => [t?.id, t?.phase]).sort()) !== JSON.stringify(ctx.tasks.map(t => [t.id, t.phase]).sort())) {
    return { ok: false, reason: 'run plan is missing or does not match the committed plan' }
  }
  return { ok: true, artifacts: [{ kind: 'run-plan', bytes }] }
}
// The commit a task branch was cut from. Once the task is merged, the merge-base with the run tip
// is the task tip itself, so the fork is read from the first parent of the merge that took it.
function forkPoint(ctx, runTip, tip) {
  const fork = gitSync(['merge-base', '--end-of-options', runTip, tip], ctx.root)
  if (fork !== tip) return fork
  const merge = gitSync(['rev-list', '--first-parent', '--parents', '--max-count=1000', '--end-of-options', runTip], ctx.root)
    .split('\n').map(line => line.split(' ')).find(parents => parents.length === 3 && parents[2] === tip)
  return merge ? gitSync(['merge-base', '--end-of-options', merge[1], tip], ctx.root) : null
}
function phaseTasks(ctx, phase) { return ctx.tasks.filter(task => task.phase === phase) }
function currentTips(ctx, phase) {
  return Object.fromEntries(phaseTasks(ctx, phase).map(task => [task.id, refTip(ctx.root, `refs/heads/${taskBranchName(ctx.request.runId, task.id)}`)]))
}
async function validateImplement(ctx, phase) {
  const runTip = refTip(ctx.root, `refs/heads/${ctx.request.runBranch}`), artifacts = [], tips = {}
  for (const task of phaseTasks(ctx, phase)) {
    const bytes = await readInside(ctx.root, `${NAMES.stateDir}/${ctx.request.runId}/sessions/${task.id}.result.json`)
    const result = bytes && parseJson(bytes)
    const branch = taskBranchName(ctx.request.runId, task.id)
    if (!profileTaskResultAccepted(result) || result.branch.replace(/^refs\/heads\//, '') !== branch) return { ok: false, reason: `task ${task.id} result is missing, malformed or not done` }
    const tip = refTip(ctx.root, `refs/heads/${branch}`)
    if (!tip || tip === runTip) return { ok: false, reason: `task ${task.id} branch is missing or empty` }
    const fork = forkPoint(ctx, runTip, tip)
    if (!fork) return { ok: false, reason: `task ${task.id} has no fork point on the run branch` }
    const changed = gitSync(['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', '--end-of-options', fork, tip, '--'], ctx.root).split('\0').filter(Boolean)
    if (!changed.length || changed.some(file => !task.files.includes(file))) return { ok: false, reason: `task ${task.id} changed files outside its declared set` }
    tips[task.id] = tip
    artifacts.push({ kind: 'task-result', bytes })
  }
  ctx.taskTips[phase] = tips
  return { ok: true, artifacts }
}
function agentCheck(ctx, phase) {
  return checksForPhase(ctx.manifest, String(phase)).find(check => check.kind === 'agent' && check.optional !== true)
}
async function reviewsCurrent(ctx, phase) {
  const tips = currentTips(ctx, phase)
  if (JSON.stringify(tips) !== JSON.stringify(ctx.taskTips[phase] ?? null)) return { ok: false, reason: 'task tips moved after implementation' }
  const branchShas = Object.fromEntries(Object.entries(tips).map(([id, tip]) => [taskBranchName(ctx.request.runId, id), tip]))
  const artifacts = []
  for (const lens of agentCheck(ctx, phase).lens) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(lens)) return { ok: false, reason: 'unsupported review lens name' }
    const bytes = await readInside(ctx.root, `${NAMES.stateDir}/${ctx.request.runId}/reviews/${phase}-${lens}.json`)
    const findings = bytes && parseJson(bytes)
    if (!plainObject(findings) || !Array.isArray(findings.findings) || reviewStale(findings, reviewStamp({ phase, lens, branchShas })) !== null) {
      return { ok: false, reason: `review findings for lens ${lens} are missing, malformed or stamped for other tips` }
    }
    artifacts.push({ kind: 'review-findings', bytes })
  }
  return { ok: true, artifacts }
}
async function validateCollect(ctx, phase, step, output) {
  const matches = output.split(/\r?\n/).map(line => WRITE_LINE.exec(line)).filter(Boolean)
  const expected = path.join(ctx.root, step.resultsPath)
  if (matches.length !== 1 || matches[0][1] !== expected) return { ok: false, reason: 'collect-reviews did not name the expected results path on its success line' }
  const bytes = await readInside(ctx.root, step.resultsPath)
  const parsed = bytes && parseJson(bytes)
  const check = agentCheck(ctx, phase)
  const result = plainObject(parsed) && Object.keys(parsed).length === 1 && Array.isArray(parsed.results)
    ? parsed.results.filter(r => plainObject(r) && r.kind === 'agent' && r.name === check.name) : []
  if (result.length !== 1 || !['pass', 'fail'].includes(result[0].status)) return { ok: false, reason: 'review results file is missing or malformed' }
  const reviews = await reviewsCurrent(ctx, phase)
  if (!reviews.ok) return reviews
  ctx.reviewResults[phase] = { path: expected, sha256: hash(bytes), status: result[0].status, check: check.name, results: parsed.results }
  if (result[0].status !== 'pass') {
    return { ok: false, category: 'code', reason: 'mandatory review blocked', verdict: { verdict: 'FAIL', phase, results: parsed.results },
      artifacts: [{ kind: 'review-results', bytes }] }
  }
  return { ok: true, artifacts: [{ kind: 'review-results', bytes }] }
}
async function gateInputsCurrent(ctx, phase) {
  const collected = ctx.reviewResults[phase]
  const bytes = collected && await readInside(ctx.root, path.relative(ctx.root, collected.path))
  if (!bytes || hash(bytes) !== collected.sha256 || collected.status !== 'pass') return { ok: false, reason: 'gate review input changed or is absent' }
  if (JSON.stringify(currentTips(ctx, phase)) !== JSON.stringify(ctx.taskTips[phase])) return { ok: false, reason: 'task tips moved after review' }
  return { ok: true, artifacts: [{ kind: 'gate-input', bytes: JSON.stringify({ version: 1, phase, results: collected.sha256, taskTips: ctx.taskTips[phase] }) }] }
}

// Exit codes as read from the handlers in scripts/cli.mjs, not observed from a live run here: gate and
// finish return 1 for a FAIL verdict (the only code failures); gate returns 3 after inferring a manifest.
const EXIT_CONTRACT = {
  'init-run': { 1: 'policy', 2: 'policy' },
  'preview-check': { 1: 'policy', 2: 'policy', 4: 'infrastructure' },
  dispatch: { 2: 'policy', 4: 'infrastructure' },
  'dispatch-reviews': { 2: 'policy', 4: 'infrastructure' },
  'collect-reviews': { 2: 'policy', 4: 'missing-artifact' },
  gate: { 1: 'code', 2: 'policy', 3: 'policy', 4: 'infrastructure' },
  finish: { 1: 'code', 2: 'policy', 4: 'infrastructure' },
  fix: { 1: 'infrastructure', 2: 'policy' },
}
function classifyExit(step, result) {
  const agent = step.kind === 'agent'
  if (result.timedOut || result.outputLimited) return agent ? 'unknown-effect' : 'infrastructure'
  return EXIT_CONTRACT[step.argv[2]]?.[result.code] ?? (agent ? 'unknown-effect' : 'unknown')
}
// As read from cli.mjs, gate prints its verdict with JSON.stringify(value, null, 2), so the block starts
// at a line that is exactly "{". Only the fix decision reads it; an unreadable block leaves it undecided.
function gateVerdict(output) {
  const lines = output.split(/\r?\n/), start = lines.indexOf('{')
  if (start < 0) return null
  const verdict = parseJson(Buffer.from(lines.slice(start).join('\n')))
  return plainObject(verdict) && verdict.verdict === 'FAIL' && Array.isArray(verdict.results) ? verdict : null
}

async function writeInside(root, relative, text) {
  const file = path.join(root, relative), dir = path.dirname(file)
  if (!file.startsWith(root + path.sep)) throw new Error('State file escapes the project root')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (await realpath(dir) !== dir) throw new Error('State directory contains a link')
  const temporary = path.join(dir, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { await handle.writeFile(text) } finally { await handle.close() }
  await rename(temporary, file)
}

// A code failure is handed to the existing fix contract (`fix --verdict`) for its budget and
// escalation decision. No fixed CLI fragment performs the repair itself: `dispatch` treats a
// recorded done result as final and does not respawn the task, so the controller stops with the
// decision instead of re-running dispatch as if that repaired anything.
async function repairDecision(ctx, failedStep, phase, failure) {
  if (!failure.verdict) return { blocker: blocker('code', failedStep.id, `${failure.blocker.reason}; no readable verdict for the fix decision`) }
  const relative = `${NAMES.stateDir}/${ctx.request.runId}/profile-verdict-${phase}.json`
  try { await writeInside(ctx.root, relative, JSON.stringify(failure.verdict)) }
  catch (error) { return { blocker: blocker('infrastructure', failedStep.id, `verdict not written: ${error.message}`) } }
  const step = { id: `fix-${phase}`, kind: 'deterministic', argv: ['node', 'scripts/cli.mjs', 'fix', '--run', ctx.request.runId, '--phase', String(phase), '--verdict', relative] }
  const result = await runCli(ctx, step, phase)
  if (!result.ok) return result
  const decision = result.outcome.decision
  ctx.report.repair = { phase, step: failedStep.id, decision }
  const reason = decision.decision === 'retry' ? 'repair-round-required: fix decided retry; no fixed CLI fragment respawns a recorded done task'
    : decision.decision === 'escalate' ? `fix-escalated: ${decision.reason}` : 'fix-decision-none-for-a-failed-verdict'
  return { blocker: blocker('code', failedStep.id, reason) }
}

function budget(ctx, stepId) {
  if (ctx.attemptsUsed >= ctx.request.limits.maxAttempts) return blocker('budget', stepId, 'attempt-budget-exhausted')
  const remaining = ctx.request.limits.maxWallMs - ctx.wallUsed - (ctx.now() - ctx.invocationStart)
  if (remaining < 1000) return blocker('budget', stepId, 'wall-time-budget-exhausted')
  return { remaining }
}
async function inputsCurrent(ctx, stepId) {
  const lifecycle = lifecycleStatus(ctx.root, ctx.request.runId)
  if (lifecycle.state !== 'running') return { state: lifecycle.state, blocker: blocker('lifecycle', stepId, `run is ${lifecycle.state}`) }
  if (refTip(ctx.root, `refs/heads/${ctx.request.baseBranch}`) !== ctx.inputs.commit || await verifierNow(ctx.cliPath) !== ctx.inputs.verifier) {
    return { blocker: blocker('changed-input', stepId, 'committed base or installed verifier changed after expansion') }
  }
  return null
}

function nextAttempt(ctx, stepId) {
  const n = (ctx.attemptCounts.get(stepId) ?? 0) + 1
  ctx.attemptCounts.set(stepId, n)
  return `${stepId}.${n}`
}

// Runs one action between a persisted start and a persisted outcome. The action returns
// { ok, artifacts, category, reason, outcome } and is never started when the start cannot persist.
async function guarded(ctx, step, action, { counts = true } = {}) {
  const changed = await inputsCurrent(ctx, step.id)
  if (changed) return { ok: false, stop: true, ...changed }
  const bound = budget(ctx, step.id)
  if (bound.category) return { ok: false, stop: true, blocker: bound }
  const attempt = nextAttempt(ctx, step.id)
  try { await append(ctx, event(ctx, step.id, attempt, 'step-started'), true) }
  catch (error) { return { ok: false, stop: true, blocker: blocker('infrastructure', step.id, `start not persisted: ${error.message}`) } }
  if (counts) ctx.attemptsUsed++
  const started = ctx.now()
  let outcome
  try { outcome = await action(Math.min(ctx.request.limits.stepTimeoutMs, bound.remaining)) }
  catch (error) { outcome = { ok: false, category: 'infrastructure', reason: error.message, artifacts: [] } }
  const durationMs = Math.max(0, ctx.now() - started)
  const references = []
  let retentionError = null
  for (const artifact of outcome.artifacts ?? []) {
    try { references.push(await retain(ctx, artifact.kind, artifact.bytes)) } catch (error) { retentionError = error; break }
  }
  if (retentionError && outcome.ok) outcome = { ok: false, category: 'infrastructure', reason: `artifact not retained: ${retentionError.message}` }
  const summary = { version: 1, step: step.id, attempt, ok: outcome.ok, category: outcome.ok ? null : outcome.category ?? 'missing-artifact',
    exitCode: outcome.exitCode ?? null, timedOut: outcome.timedOut ?? false, durationMs }
  try { references.push(await retain(ctx, 'step-outcome', JSON.stringify(summary))) } catch (error) {
    if (outcome.ok) outcome = { ok: false, category: 'infrastructure', reason: `outcome not retained: ${error.message}` }
  }
  try { await append(ctx, event(ctx, step.id, attempt, outcome.ok ? 'step-completed' : 'step-failed', references)) }
  catch (error) { outcome = { ok: false, category: 'infrastructure', reason: `outcome not persisted: ${error.message}` } }
  ctx.report.steps.push({ id: step.id, attempt, status: outcome.ok ? 'completed' : 'failed', exitCode: summary.exitCode, durationMs,
    artifacts: references, ...(outcome.mode ? { mode: outcome.mode } : {}) })
  return outcome.ok ? { ok: true, references, outcome }
    : { ok: false, category: outcome.category ?? 'missing-artifact', verdict: outcome.verdict ?? null, blocker: blocker(outcome.category ?? 'missing-artifact', step.id, outcome.reason ?? 'validation failed') }
}

async function runCli(ctx, step, phase) {
  return guarded(ctx, step, async timeoutMs => {
    let argv = step.argv.slice(2)
    if (step.argv[2] === 'gate') {
      const index = argv.indexOf('--results'), collected = ctx.reviewResults[phase]
      argv = [...argv.slice(0, index + 1), collected.path, ...argv.slice(index + 2)]
      const current = await gateInputsCurrent(ctx, phase)
      if (!current.ok) return { ...current, category: 'changed-input', artifacts: [] }
    }
    const extra = []
    if (step.argv[2] === 'finish') {
      // finish recomputes every phase and leaves an agent check pending unless its results are
      // supplied, so it receives the reviews collected in this invocation for every phase.
      const index = argv.indexOf('--results'), named = `${NAMES.stateDir}/${ctx.request.runId}/reviews/finish-results.json`
      if (index < 0 || argv[index + 1] !== named) throw new Error('finish results input is not the controller-written path')
      if (ctx.phases.some(p => ctx.reviewResults[p]?.status !== 'pass')) return { ok: false, category: 'missing-artifact', reason: 'review results are not current for every phase', artifacts: [] }
      const document = JSON.stringify({ phases: Object.fromEntries(ctx.phases.map(p => [String(p), { results: ctx.reviewResults[p].results }])) })
      await writeInside(ctx.root, named, document)
      argv = [...argv.slice(0, index + 1), path.join(ctx.root, named), ...argv.slice(index + 2)]
      extra.push({ kind: 'finish-input', bytes: document })
    }
    if (step.argv[2] === 'fix') {
      const index = argv.indexOf('--verdict')
      argv = [...argv.slice(0, index + 1), path.join(ctx.root, argv[index + 1]), ...argv.slice(index + 2)]
    }
    let result
    try {
      result = await ctx.executor(process.execPath, ctx.root, { argv: [ctx.cliPath, ...argv, '--root', ctx.root],
        timeoutMs, graceMs: 1000, maxOutputBytes: OUTPUT_BYTES, maxCaptureBytes: OUTPUT_BYTES })
    } catch (error) { return { ok: false, category: 'infrastructure', reason: `spawn failed: ${error.message}`, artifacts: [] } }
    const streams = plainObject(result) && typeof result.stdout === 'string' && typeof result.stderr === 'string'
    if (!plainObject(result) || !Number.isInteger(result.code) || !(typeof result.output === 'string' || streams)) {
      return { ok: false, category: 'infrastructure', reason: 'malformed executor receipt', artifacts: [] }
    }
    const output = typeof result.output === 'string' ? result.output : `${result.stdout}${result.stderr}`
    const artifacts = [...(streams ? [{ kind: 'step-stdout', bytes: result.stdout }, { kind: 'step-stderr', bytes: result.stderr }] : [{ kind: 'step-output', bytes: output }]), ...extra]
    const observed = { exitCode: result.code, timedOut: result.timedOut === true }
    if (result.code !== 0 || result.timedOut || result.outputLimited) {
      const category = classifyExit(step, result)
      return { ok: false, ...observed, category, reason: result.timedOut ? 'timed out' : result.outputLimited ? 'output limit exceeded' : `exit ${result.code}`, artifacts,
        ...(category === 'code' && step.argv[2] === 'gate' ? { verdict: gateVerdict(streams ? result.stdout : output) } : {}) }
    }
    const kind = step.id.replace(/-\d+$/, '')
    if (kind === 'fix') {
      const decision = parseJson(Buffer.from(streams ? result.stdout : output))
      if (!plainObject(decision) || !['none', 'retry', 'escalate'].includes(decision.decision) || !Array.isArray(decision.tasks)) {
        return { ok: false, ...observed, category: 'infrastructure', reason: 'fix decision is malformed', artifacts }
      }
      return { ok: true, ...observed, decision, artifacts: [...artifacts, { kind: 'fix-decision', bytes: JSON.stringify(decision) }] }
    }
    const validation = kind === 'prepare' ? await validatePrepare(ctx)
      : kind === 'implement' ? await validateImplement(ctx, phase)
      : kind === 'review' ? await reviewsCurrent(ctx, phase)
      : kind === 'collect' ? await validateCollect(ctx, phase, step, streams ? result.stdout : output)
      : kind === 'gate' ? await gateInputsCurrent(ctx, phase)
      : { ok: true, artifacts: [] }
    return { ...validation, ...observed, artifacts: [...artifacts, ...(validation.artifacts ?? [])] }
  })
}

function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
async function runIntegration(ctx, step, phase) {
  return guarded(ctx, step, async () => {
    const runTip = refTip(ctx.root, `refs/heads/${ctx.request.runBranch}`)
    const taskTips = ctx.taskTips[phase]
    const current = await gateInputsCurrent(ctx, phase)
    if (!current.ok) return { ...current, category: 'changed-input', artifacts: [] }
    const reviewCheck = async (check, observed) => {
      const reviews = await reviewsCurrent(ctx, phase)
      const collected = ctx.reviewResults[phase]
      return { status: reviews.ok && sameJson(observed.identity.taskTips, taskTips) && collected?.status === 'pass' && collected.check === check.name ? 'pass' : 'fail' }
    }
    const input = { root: ctx.root, runId: ctx.request.runId, phase, branch: ctx.request.runBranch, baseBranch: ctx.request.baseBranch,
      planPath: ctx.request.planPath, expectedRunTip: runTip, taskTips, policy: ctx.policy, reviewCheck }
    const fixture = typeof ctx.verificationFactory === 'function'
    let gateReceipt
    try {
      gateReceipt = fixture ? await executeReviewedPhaseGateFixture(input, ctx.verificationFactory) : await executeReviewedPhaseGate(input)
    } catch (error) {
      const category = /required checks|merge conflict/.test(error.message) ? 'code' : /verification/.test(error.message) ? 'infrastructure'
        : /moved|mismatch|dirty/.test(error.message) ? 'changed-input' : 'policy'
      return { ok: false, category, reason: `host gate: ${error.message}`, artifacts: [],
        ...(category === 'code' && Array.isArray(error.results) ? { verdict: { verdict: 'FAIL', phase, results: error.results } } : {}) }
    }
    let receipt
    try {
      receipt = await (fixture ? integrateReviewedPhaseFixture : integrateReviewedPhase)({ ...input, gateReceipt })
    } catch (error) {
      const partial = error.receipt
      const uncertain = partial && (partial.merges.length > 0 || partial.state === 'unknown-effect')
      return { ok: false, category: uncertain ? 'unknown-effect' : /moved|mismatch|dirty/.test(error.message) ? 'changed-input' : 'policy',
        reason: `host integration: ${error.message}`, artifacts: partial ? [{ kind: 'integration-receipt', bytes: JSON.stringify(partial) }] : [] }
    }
    const record = { version: 1, mode: receipt.mode, verification: gateReceipt.verification.kind, phase, testedTree: gateReceipt.testedTree,
      before: receipt.before, after: receipt.after, merges: receipt.merges, taskTips, review: gateReceipt.results.filter(r => r.kind === 'agent').map(r => [r.name, r.status]) }
    ctx.integrated[phase] = record
    return { ok: receipt.complete === true, mode: 'host-bounded', category: 'unknown-effect', reason: 'integration incomplete',
      artifacts: [{ kind: 'integration-receipt', bytes: JSON.stringify(record) }] }
  })
}

// ---- resume reconciliation ----

function latestAttempt(ctx, stepId) {
  const groups = ctx.priorGroups.filter(g => g.start.step === stepId)
  return groups.sort((a, b) => a.start.at - b.start.at || a.start.id.localeCompare(b.start.id)).at(-1) ?? null
}
async function outcomeOf(ctx, group) {
  const reference = group.end?.artifacts.find(a => a.kind === 'step-outcome')
  if (!reference) return null
  try { return parseJson(await readArtifact(ctx, reference)) ?? null } catch { return null }
}
async function integrationStillCurrent(ctx, phase, group) {
  const reference = group.end.artifacts.find(a => a.kind === 'integration-receipt')
  const record = reference && parseJson(await readArtifact(ctx, reference))
  const runTip = refTip(ctx.root, `refs/heads/${ctx.request.runBranch}`)
  const ancestor = sha => { try { gitSync(['merge-base', '--is-ancestor', '--end-of-options', sha, runTip], ctx.root); return true } catch { return false } }
  const ok = plainObject(record) && SHA.test(record.after ?? '') && ancestor(record.after)
    && sameJson(record.taskTips, currentTips(ctx, phase)) && Object.values(record.taskTips).every(ancestor)
  if (ok) { ctx.integrated[phase] = record; ctx.taskTips[phase] = record.taskTips }
  return { ok }
}
// Observed outputs that may be reused after revalidation against the current tree. Mandatory
// verdict steps (collect-reviews, gate, finish) and acceptance are absent, so they always run again.
const REUSE = {
  prepare: ctx => validatePrepare(ctx),
  baseline: async () => ({ ok: true }),
  implement: (ctx, phase) => validateImplement(ctx, phase),
  review: (ctx, phase) => reviewsCurrent(ctx, phase),
  integrate: integrationStillCurrent,
}
// Decides whether a prior attempt's observed output may be reused. Returns 'reuse', 'run' or a blocker.
async function priorDecision(ctx, step, phase) {
  const kind = step.id.replace(/-\d+$/, '')
  const group = latestAttempt(ctx, step.id)
  if (!group) return { action: 'run' }
  const agentLike = step.kind === 'agent' || step.kind === 'host-integration'
  if (!group.end) {
    if (kind === 'integrate' && group.start.branches[`refs/heads/${ctx.request.runBranch}`] === refTip(ctx.root, `refs/heads/${ctx.request.runBranch}`)) return { action: 'run' }
    return agentLike ? { action: 'block', blocker: blocker('unknown-effect', step.id, 'prior attempt has no recorded outcome; reconcile its effects before redispatch') } : { action: 'run' }
  }
  if (group.end.kind === 'step-failed') {
    const outcome = await outcomeOf(ctx, group)
    if (agentLike && (!outcome || outcome.category === 'unknown-effect')) return { action: 'block', blocker: blocker('unknown-effect', step.id, 'prior attempt ended with an unknown effect') }
    return { action: 'run' }
  }
  const reuse = REUSE[kind]
  if (!reuse) return { action: 'run' }
  const reconciled = ctx.reconciled.find(a => a.step === step.id && a.attempt === group.start.attempt)
  if (!reconciled || ['stale', 'missing-artifact', 'retention-exceeded', 'unknown-effect'].includes(reconciled.state)) return { action: 'run' }
  for (const reference of group.end.artifacts) if (!await observe(ctx, reference)) return { action: 'run' }
  const validation = await reuse(ctx, phase, group)
  if (!validation.ok) return { action: 'run' }
  ctx.report.steps.push({ id: step.id, attempt: group.start.attempt, status: 'reused', exitCode: null, durationMs: null, artifacts: group.end.artifacts })
  return { action: 'reuse' }
}

// ---- obligations ----

async function obligations(ctx, finishReferences, acceptanceReferences) {
  const runRef = `refs/heads/${ctx.request.runBranch}`
  const finalTip = refTip(ctx.root, runRef), finalTree = gitSync(['rev-parse', `${finalTip}^{tree}`], ctx.root)
  const identity = strictExecutionIdentity(ctx.inputs)
  const requirements = [], receipts = []
  const add = (requirement, artifact) => {
    const full = { mandatory: true, inputs: ctx.inputs, ...requirement }
    requirements.push(full)
    if (artifact) receipts.push({ id: `receipt-${full.id}`, requirement: full.id, version: 2, executionBacked: true, kind: full.kind, status: 'pass',
      requestIdentity: identity, identity, tree: full.tree, refs: full.refs, artifact })
  }
  const stepArtifact = (stepId, kind) => {
    const fresh = ctx.report.steps.filter(s => s.id === stepId && ['completed', 'reused'].includes(s.status)).at(-1)
    return fresh?.artifacts.find(a => a.kind === kind) ?? null
  }
  const phases = ctx.phases
  for (const phase of phases) {
    const record = ctx.integrated[phase]
    if (!record) return null
    const taskRefs = Object.fromEntries(Object.entries(record.taskTips).map(([id, tip]) => [`refs/heads/${taskBranchName(ctx.request.runId, id)}`, tip]))
    for (const [id, tip] of Object.entries(record.taskTips)) {
      add({ id: `implementation-${phase}-${id}`, kind: 'implementation', scope: 'step', tree: gitSync(['rev-parse', `${tip}^{tree}`], ctx.root),
        refs: { [`refs/heads/${taskBranchName(ctx.request.runId, id)}`]: tip } }, stepArtifact(`implement-${phase}`, 'task-result'))
    }
    add({ id: `command-${phase}`, kind: 'command', scope: 'step', tree: record.testedTree, refs: taskRefs }, stepArtifact(`gate-${phase}`, 'gate-input'))
    add({ id: `review-${phase}`, kind: 'review', scope: 'step', tree: record.testedTree, refs: taskRefs }, stepArtifact(`collect-${phase}`, 'review-results'))
    add({ id: `integration-${phase}`, kind: 'integration', scope: 'step', tree: record.testedTree, refs: taskRefs }, stepArtifact(`integrate-${phase}`, 'integration-receipt'))
  }
  const last = ctx.integrated[phases.at(-1)]
  const finalReview = last.testedTree === finalTree && last.review.every(([, status]) => status === 'pass') && last.review.length > 0
  add({ id: 'final-review', kind: 'review', scope: 'final', tree: finalTree, refs: { [runRef]: finalTip } }, finalReview ? stepArtifact(`integrate-${phases.at(-1)}`, 'integration-receipt') : null)
  add({ id: 'final-command', kind: 'command', scope: 'final', tree: finalTree, refs: { [runRef]: finalTip } }, finishReferences?.find(a => a.kind === 'step-output' || a.kind === 'step-stdout') ?? null)
  for (const [criterion, reference] of acceptanceReferences) {
    add({ id: `acceptance-${criterion}`, kind: 'acceptance', scope: 'step', tree: finalTree, refs: { [runRef]: finalTip } }, reference)
  }
  if (!acceptanceReferences.length) add({ id: 'acceptance', kind: 'acceptance', scope: 'step', tree: finalTree, refs: { [runRef]: finalTip } }, null)
  const branches = {}
  for (const requirement of requirements) for (const ref of Object.keys(requirement.refs)) branches[ref] = refTip(ctx.root, ref)
  const artifactObservations = [...ctx.observations.values()].map(reference => ({ reference, verified: true }))
  return summarizeCompletionObligations({ inputs: ctx.inputs, requirements, receipts, artifactObservations, branches,
    lifecycle: { runId: ctx.request.runId, state: 'running' } })
}

async function acceptanceEvidence(ctx) {
  const required = ctx.acceptanceRequired, finalTip = refTip(ctx.root, `refs/heads/${ctx.request.runBranch}`)
  const finalTree = gitSync(['rev-parse', `${finalTip}^{tree}`], ctx.root)
  const accepted = [], missing = []
  for (const criterion of required) {
    const entries = ctx.acceptance.filter(entry => entry.criterion === criterion)
    let ok = false
    if (entries.length === 1) {
      try {
        const evidence = parseJson(await readArtifact(ctx, entries[0].reference))
        ok = plainObject(evidence) && evidence.version === 1 && evidence.criterion === criterion && evidence.tree === finalTree && evidence.status === 'pass'
          && entries[0].reference.kind === 'acceptance-evidence'
      } catch { ok = false }
    }
    if (ok) accepted.push([criterion, entries[0].reference]); else missing.push(criterion)
  }
  return { accepted, missing, finalTree }
}

// ---- main sequence ----

function finalize(ctx, state, extra = {}) {
  const report = ctx.report
  report.state = state
  report.attempts = { used: ctx.attemptsUsed, max: ctx.request.limits.maxAttempts }
  report.wallMs = { used: ctx.wallUsed + Math.max(0, ctx.now() - ctx.invocationStart), max: ctx.request.limits.maxWallMs }
  Object.assign(report, extra)
  return report
}
function stop(ctx, result) {
  ctx.report.blockers.push(result.blocker)
  const category = result.blocker.category
  return finalize(ctx, result.state ?? (category === 'code' ? 'failed' : 'blocked'))
}

async function executeSteps(ctx) {
  for (const step of ctx.expanded.steps.slice(0, 2)) {
    const decision = ctx.resume ? await priorDecision(ctx, step) : { action: 'run' }
    if (decision.action === 'block') return stop(ctx, decision)
    if (decision.action === 'reuse') continue
    const result = await runCli(ctx, step)
    if (!result.ok) return stop(ctx, result)
  }
  for (const contract of ctx.expanded.phaseContracts) {
    const phase = contract.phase
    for (const name of ['implement', 'review', 'collect', 'gate', 'integrate']) {
      const step = ctx.expanded.steps.find(s => s.id === `${name}-${phase}`)
      const decision = ctx.resume ? await priorDecision(ctx, step, phase) : { action: 'run' }
      if (decision.action === 'block') return stop(ctx, decision)
      if (decision.action === 'reuse') continue
      const result = name === 'integrate' ? await runIntegration(ctx, step, phase) : await runCli(ctx, step, phase)
      if (result.ok) continue
      if (result.category === 'code') return stop(ctx, await repairDecision(ctx, step, phase, result))
      return stop(ctx, result)
    }
  }
  const acceptance = await acceptanceEvidence(ctx)
  ctx.report.acceptance = { required: ctx.acceptanceRequired, missing: acceptance.missing, tree: acceptance.finalTree }
  if (acceptance.missing.length) {
    return finalize(ctx, 'human-required', { obligations: await obligations(ctx, null, acceptance.accepted) })
  }
  const finish = ctx.expanded.steps.find(s => s.id === 'finish')
  const result = await runCli(ctx, finish)
  if (!result.ok) return stop(ctx, result)
  const summary = await obligations(ctx, result.references, acceptance.accepted)
  const native = ctx.report.verification === 'native-required'
  const verified = summary?.verifiedComplete === true && native
  return finalize(ctx, verified ? 'verified-complete' : 'unresolved', { obligations: summary, verifiedComplete: verified })
}

function baseReport(ctx) {
  return { version: 1, mode: 'executed', runId: ctx.request.runId, executionId: ctx.executionId, profile: ctx.request.profile,
    profileHash: null, identity: null, inputs: null, state: 'unresolved', blockers: [], steps: [], acceptance: null,
    verification: typeof ctx.verificationFactory === 'function' ? 'injected-unit-fixture' : 'native-required',
    obligations: null, verifiedComplete: false, publication: 'absent', trust: [...TRUST] }
}

async function controller({ root, cliPath, request: rawRequest, environment, rolePolicy, retention: rawRetention, executor, now = Date.now,
  verificationFactory, acceptance, resume = false }) {
  const request = validateRequest(rawRequest)
  const retention = validateRetention(rawRetention)
  if (!repoPath(environment) || !repoPath(rolePolicy)) throw new Error('Environment and role-policy contracts must be committed repository paths')
  if (typeof executor !== 'function' || typeof now !== 'function') throw new Error('Executor and clock must be trusted host functions')
  if (verificationFactory !== undefined && typeof verificationFactory !== 'function') throw new Error('Invalid verification fixture factory')
  const host = await resolveHost({ root, cliPath })
  branchName(request.baseBranch, host.root); branchName(request.runBranch, host.root)
  const commit = refTip(host.root, `refs/heads/${request.baseBranch}`)
  if (!commit || !refTip(host.root, `refs/heads/${request.runBranch}`)) throw new Error('Base and run branches must exist')
  if (gitSync(['symbolic-ref', '--quiet', 'HEAD'], host.root) !== `refs/heads/${request.runBranch}`) throw new Error('The run branch must be checked out at the project root')
  const git = createGit({ cwd: host.root })
  const markdown = await committedBlob(git, commit, request.planPath)
  const manifestText = await committedBlob(git, commit, NAMES.gateFile)
  const recipeText = await committedBlob(git, commit, environment)
  const policyText = await committedBlob(git, commit, rolePolicy)
  const sourceInputs = { commit, plan: hash(markdown), manifest: hash(manifestText), environment: hash(recipeText), verifier: host.verifier }
  // A dry expansion before any probe: malformed profiles and parameters refuse without executing anything.
  expandWorkflowProfile({ ...request, inputs: sourceInputs, markdown, manifestText, parameters: request.parameters,
    maxRepairRounds: request.limits.maxRepairRounds, maxWallMinutes: Math.ceil(request.limits.maxWallMs / 60000),
    integration: 'host-bounded', contracts: { environment, rolePolicy } })
  const bundle = { version: 1, request, environment, rolePolicy, retention }
  const executionId = 'wf-' + hash(JSON.stringify([request, environment, rolePolicy])).slice(0, 40)
  const context = hash(JSON.stringify({ request, environment, rolePolicy, policy: hash(policyText), recipe: hash(recipeText) }))
  let last = 0
  const ctx = { root: host.root, cliPath: host.cliPath, common: host.common, request, retention, executor, verificationFactory,
    acceptance: validateAcceptance(acceptance), resume, executionId, now: () => { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid clock'); return at },
    observations: new Map(), taskTips: {}, reviewResults: {}, integrated: {},
    attemptCounts: new Map(), attemptsUsed: 0, wallUsed: 0, priorGroups: [], reconciled: [], manifest: JSON.parse(manifestText) }
  ctx.tick = () => { last = Math.max(ctx.now(), last + 1); return last }
  ctx.invocationStart = ctx.now()
  ctx.report = baseReport(ctx)
  ctx.tasks = []

  const prior = await readExecutionEvents(host.common, request.runId)
  const groups = strictExecutionAttempts(prior).filter(g => g.start.executionId === executionId)
  if (!resume && prior.length) throw new Error('Run already has an execution journal; resume it instead of starting again')
  ctx.priorGroups = groups.filter(g => g.start.step !== 'request')
  for (const group of ctx.priorGroups) {
    ctx.attemptCounts.set(group.start.step, (ctx.attemptCounts.get(group.start.step) ?? 0) + 1)
    if (!['acceptance'].includes(group.start.step)) ctx.attemptsUsed++
    if (group.end) ctx.wallUsed += Math.max(0, group.end.at - group.start.at)
    last = Math.max(last, ...group.records.map(r => r.at))
  }
  for (const group of groups) last = Math.max(last, ...group.records.map(r => r.at))
  if (!resume) {
    ctx.inputs = { ...sourceInputs, context, environment: hash(recipeText) }
    const reference = await retain(ctx, 'workflow-request', JSON.stringify(bundle))
    const startEvent = event({ ...ctx, tasks: [] }, 'request', 'request.1', 'step-started')
    await append(ctx, startEvent, true)
    await append(ctx, event({ ...ctx, tasks: [] }, 'request', 'request.1', 'step-completed', [reference]))
  }

  // Role authority: resolved from the committed policy, never from a request flag.
  let policy
  try { policy = validateRolePolicy(JSON.parse(policyText)) } catch (error) { return stop(ctx, { blocker: blocker('policy', 'preflight', error.message) }) }
  const roles = [
    resolveRoleCapabilities({ policy, role: 'implementer', harness: request.harness, sandboxMode: request.sandboxMode, network: false }),
    resolveRoleCapabilities({ policy, role: 'reviewer', harness: request.harness, sandboxMode: request.harness === 'codex' ? 'clone' : 'files', network: false }),
    resolveRoleCapabilities({ policy, role: 'integrator', harness: 'host', mode: 'host-bounded', network: false }),
  ]
  const refused = roles.flatMap(r => r.blocked)
  if (refused.length) return stop(ctx, { blocker: blocker('policy', 'preflight', refused.join('; ')) })
  ctx.policy = policy
  let recipe
  try { recipe = validateEnvironmentRecipe(JSON.parse(recipeText)) } catch (error) { return stop(ctx, { blocker: blocker('policy', 'preflight', error.message) }) }

  // Capabilities are probed, never accepted from the request.
  const required = ['harness', ...(request.profile === 'ui' ? ['render'] : []), ...(request.parameters.requiresVault === true ? ['vault'] : []), ...recipe.required]
  const probe = await probeCapabilities({ required: [...new Set(required)], harness: request.harness, exec: executor })
  if (!probe.ready) return stop(ctx, { blocker: blocker('capability', 'preflight', probe.blocked.join('; ')) })
  const environmentReport = await captureEnvironment({ git, commit, recipePath: environment, cwd: host.root, execute: true, exec: executor, now: ctx.now })
  if (!environmentReport.ready) return stop(ctx, { blocker: blocker('infrastructure', 'preflight', environmentReport.blocked.join('; ') || 'environment not ready') })

  ctx.inputs = { commit, plan: sourceInputs.plan, manifest: sourceInputs.manifest, context, environment: environmentReport.identity, verifier: host.verifier }
  const expanded = expandWorkflowProfile({ ...request, inputs: ctx.inputs, markdown, manifestText, parameters: request.parameters,
    capabilities: Object.fromEntries(probe.observations.map(o => [o.capability, o.state])),
    maxRepairRounds: request.limits.maxRepairRounds, maxWallMinutes: Math.ceil(request.limits.maxWallMs / 60000),
    integration: 'host-bounded', contracts: { environment, rolePolicy } })
  ctx.phases = validateWorkflowExpansion(expanded, { inputs: ctx.inputs, request })
  ctx.expanded = expanded
  ctx.tasks = expanded.phaseContracts.flatMap(c => c.tasks.map(task => ({ ...task, phase: c.phase })))
  ctx.acceptanceRequired = expanded.steps.find(s => s.id === 'acceptance').inputs.filter(i => !i.startsWith('integrated-refs-'))
  Object.assign(ctx.report, { profileHash: expanded.profileHash, identity: strictExecutionIdentity(ctx.inputs), inputs: ctx.inputs })
  if (!expanded.ready) return stop(ctx, { blocker: blocker('policy', 'preflight', expanded.blocked.join('; ')) })

  if (resume) {
    const branches = journalBranches(ctx)
    const reconciled = await reconcileExecutionAttempt({ common: host.common, runId: request.runId, inputs: ctx.inputs, branches, retention,
      checkouts: { root: host.root } })
    ctx.reconciled = reconciled.attempts.filter(a => a.executionId === executionId)
  }
  return executeSteps(ctx)
}

export async function executeWorkflowProfile({ root, cliPath, request, environment, rolePolicy, retention, executor, now, verificationFactory, acceptance }) {
  return controller({ root, cliPath, request, environment, rolePolicy, retention, executor, now, verificationFactory, acceptance, resume: false })
}

// Rereads the retained request, rederives the profile from current committed contracts and
// reconciles recorded attempts. Mandatory verdict steps always run again.
export async function resumeWorkflowProfile({ root, cliPath, runId, executor, now, verificationFactory, acceptance }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Project root must be an absolute path')
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId)) throw new Error('Invalid run identity')
  const canonical = await realpath(root)
  const common = await realpath(gitSync(['rev-parse', '--path-format=absolute', '--git-common-dir'], canonical))
  const events = await readExecutionEvents(common, runId)
  const requests = strictExecutionAttempts(events).filter(g => g.start.step === 'request' && g.end?.kind === 'step-completed')
  if (requests.length !== 1) throw new Error('Run has no single retained workflow request to resume')
  const reference = requests[0].end.artifacts.find(a => a.kind === 'workflow-request')
  if (!reference) throw new Error('Retained workflow request reference is missing')
  const bundle = parseJson(await readExecutionArtifact({ common, runId, reference, retention: RETENTION_UPPER }))
  exactKeys(bundle, ['version', 'request', 'environment', 'rolePolicy', 'retention'], [], 'retained workflow request')
  if (bundle.version !== 1 || bundle.request?.runId !== runId) throw new Error('Retained workflow request does not match the run')
  const executionId = 'wf-' + hash(JSON.stringify([bundle.request, bundle.environment, bundle.rolePolicy])).slice(0, 40)
  if (requests[0].start.executionId !== executionId) throw new Error('Retained workflow request identity mismatch')
  return controller({ root, cliPath, request: bundle.request, environment: bundle.environment, rolePolicy: bundle.rolePolicy,
    retention: bundle.retention, executor, now, verificationFactory, acceptance, resume: true })
}
