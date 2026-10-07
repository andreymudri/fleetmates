import { createHash } from 'node:crypto'
import { parsePlan } from './plan-parser.mjs'
import { assignPhases } from './phases.mjs'
import { checksForPhase, fixRoundsForPhase } from './gate-config.mjs'
import { evidenceIdentity } from './workflow-evidence.mjs'
import { RESULT_SCHEMA, validateResult } from './result-schema.mjs'
import { NAMES } from './names.mjs'
import { validateGate } from './config.mjs'

const PROFILES = Object.freeze({
  'bug-fix': ['reproducer', 'regression-check'],
  feature: ['functional-acceptance'],
  migration: ['compatibility-check', 'rollback-review'],
  ui: ['rendered-output', 'interaction-check', 'accessibility-check'],
  research: ['sources', 'claim-evidence', 'uncertainty-review'],
})
// Inclusive bounds on the expansion's numeric parameters. The workflow controller derives its own
// maxRepairRounds and maxWallMs bounds from these, so a request it accepts always expands.
export const PROFILE_LIMITS = Object.freeze({ maxRepairRounds: Object.freeze([0, 10]), maxWallMinutes: Object.freeze([1, 1440]) })
const within = (value, [low, high]) => Number.isSafeInteger(value) && value >= low && value <= high
const hash = value => createHash('sha256').update(value).digest('hex')
const plain = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
const repoPath = value => plain(value) && !value.startsWith('/') && !value.startsWith('-') && !value.includes('\\')
  && value.split('/').every(v => v && v !== '.' && v !== '..')

export function expandWorkflowProfile({ profile, runId, planPath, baseBranch, harness, inputs, markdown, manifestText,
  capabilities = {}, parameters = {}, maxRepairRounds = 2, maxWallMinutes = 60, integration = 'legacy', contracts = null }) {
  const identity = evidenceIdentity(inputs)
  if (!/^[a-f0-9]{40,64}$/.test(inputs.commit) || !Object.hasOwn(PROFILES, profile) || !plain(runId) || Buffer.byteLength(runId) > 255 || runId !== runId.normalize('NFC') || !/^[\p{L}\p{M}\p{N}._/-]+$/u.test(runId)
      || runId.split('/').some(v => !v || v === '.' || v === '..')
      || !plain(planPath) || planPath.startsWith('/') || planPath.includes('\\') || planPath.split('/').some(v => !v || v === '.' || v === '..')
      || !plain(baseBranch) || !['codex', 'cursor'].includes(harness)
      || !within(maxRepairRounds, PROFILE_LIMITS.maxRepairRounds) || !within(maxWallMinutes, PROFILE_LIMITS.maxWallMinutes)) throw new Error('Invalid workflow profile parameters')
  if (typeof markdown !== 'string' || typeof manifestText !== 'string'
      || inputs.plan !== hash(markdown) || inputs.manifest !== hash(manifestText)) throw new Error('Profile tracked inputs do not match their identities')
  if (!['legacy', 'host-bounded'].includes(integration)) throw new Error('Invalid profile integration mode')
  if (contracts !== null && (!contracts || typeof contracts !== 'object' || Array.isArray(contracts)
      || Object.keys(contracts).length !== 2 || !['environment', 'rolePolicy'].every(key => repoPath(contracts[key])))) throw new Error('Invalid profile execution contracts')
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
      || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Invalid profile capability or parameter contract')
  for (const value of Object.values(capabilities)) if (!['available', 'unavailable', 'unknown'].includes(value)) throw new Error('Invalid capability status')
  if (parameters.requiresVault !== undefined && typeof parameters.requiresVault !== 'boolean') throw new Error('requiresVault must be boolean')
  if (profile === 'migration' && (!plain(parameters.compatibility) || !plain(parameters.rollback))) throw new Error('Migration requires compatibility and rollback contracts')
  const manifest = JSON.parse(manifestText)
  validateGate(manifest)
  const tasks = assignPhases(parsePlan(markdown))
  if (!tasks.length) throw new Error('Workflow profile requires tracked tasks')
  const phases = [...new Set(tasks.map(task => task.phase))]
  if (phases.length > 100) throw new Error('Workflow profile exceeds phase bound')
  const blocked = []
  for (const capability of ['harness', ...(profile === 'ui' ? ['render'] : []), ...(parameters.requiresVault ? ['vault'] : [])]) {
    if (capabilities[capability] !== 'available') blocked.push(`required capability ${capability} is ${capabilities[capability] ?? 'unknown'}`)
  }
  const cli = (...args) => ['node', 'scripts/cli.mjs', ...args]
  const common = ['--run', runId]
  const planArgs = ['--plan', planPath, '--base', baseBranch]
  const contractArgs = contracts ? ['--environment', contracts.environment, '--role-policy', contracts.rolePolicy] : []
  const steps = [{ id: 'prepare', kind: 'deterministic', argv: cli('init-run', planPath, ...common),
    inputs: ['tracked-plan'], outputs: ['run-plan'], effects: ['local-run-state'] },
  { id: 'baseline', kind: 'deterministic', argv: cli('preview-check'), inputs: ['tracked-manifest'], outputs: ['baseline-report'], effects: ['project-verifier-execution'] }]
  const phaseContracts = phases.map((phase, index) => {
    const checks = checksForPhase(manifest, String(phase))
    if (!checks.some(c => c.kind === 'agent' && c.optional !== true)) blocked.push(`phase ${phase} requires a tracked mandatory review check`)
    const phaseArgs = [...common, '--phase', String(phase)]
    // collect-reviews writes this exact path and names it on its success line; it is not stdout.
    const reviewResults = `${NAMES.stateDir}/${runId}/reviews/results-${phase}.json`
    steps.push({ id: `implement-${phase}`, kind: 'agent', argv: cli('dispatch', ...phaseArgs, '--harness', harness, ...planArgs, ...contractArgs), inputs: ['run-plan', 'baseline-report', ...(index ? [`integrated-refs-${phases[index - 1]}`] : [])], outputs: [`task-results-${phase}`], effects: ['isolated-checkouts', 'local-session-records'] },
      { id: `review-${phase}`, kind: 'agent', argv: cli('dispatch-reviews', ...phaseArgs, '--harness', harness, ...planArgs, ...contractArgs), inputs: [`task-results-${phase}`], outputs: [`finding-drops-${phase}`], effects: ['scratch-checkouts', 'local-review-records'] },
      { id: `collect-${phase}`, kind: 'deterministic', argv: cli('collect-reviews', ...phaseArgs), inputs: [`finding-drops-${phase}`], outputs: [`review-results-${phase}`], resultsPath: reviewResults, resultsFrom: 'success-write-line', effects: ['local-review-results'] },
      { id: `gate-${phase}`, kind: 'deterministic', argv: cli('gate', ...phaseArgs, ...planArgs, '--results', reviewResults), inputs: [`review-results-${phase}`], outputs: [`gate-verdict-${phase}`], effects: ['preview-checkouts', 'project-verifier-execution', 'local-gate-records'] },
      integration === 'host-bounded'
        ? { id: `integrate-${phase}`, kind: 'host-integration', mode: 'host-bounded', inputs: [`gate-verdict-${phase}`, `review-results-${phase}`], outputs: [`integrated-refs-${phase}`], effects: ['host-bounded-local-merges'] }
        : { id: `integrate-${phase}`, kind: 'agent', argv: cli('dispatch-integrator', ...phaseArgs, '--harness', harness, ...planArgs), inputs: [`gate-verdict-${phase}`], outputs: [`integrated-refs-${phase}`], effects: ['authorized-integration-refs'] })
    return { phase, tasks: tasks.filter(task => task.phase === phase).map(task => ({ id: task.id, files: task.files, deps: task.deps })), checks,
      repair: { maxRounds: Math.min(maxRepairRounds, fixRoundsForPhase(manifest, String(phase))), decision: 'existing-fix-contract', stop: ['process-violation', 'budget-exhausted', 'unknown-environment-failure'] } }
  })
  steps.push({ id: 'acceptance', kind: 'judgment-or-human', inputs: [...PROFILES[profile], `integrated-refs-${phases.at(-1)}`], outputs: ['acceptance-evidence'], effects: [] },
    { id: 'finish', kind: 'deterministic', argv: cli('finish', ...common, ...planArgs, ...(integration === 'host-bounded' ? ['--results', `${NAMES.stateDir}/${runId}/reviews/finish-results.json`] : [])), inputs: ['acceptance-evidence', 'current-review-evidence-for-all-phases'], outputs: ['completion-report'], effects: ['complete-project-verifier-execution'] })
  const result = { version: 1, profile, mode: 'dry-run', executable: false, ready: blocked.length === 0, blocked, identity,
    parameters, capabilities, maxWallMinutes, integration, contracts, phaseContracts, steps,
    outputContracts: { taskResult: RESULT_SCHEMA, gate: ['verdict', 'anchorSha', 'planHash', 'branchShas'], dependencyRule: 'validated artifacts and actual gates; free-text done is not delivery evidence' },
    limits: ['No commands are executed, publication is absent, and declared capabilities do not grant permissions.',
      'Execution belongs to workflow-controller, which revalidates this expansion and probes capabilities itself; this object authorizes nothing.',
      'Existing deterministic gates and fix budgets remain mandatory; task results are observations.'] }
  const serialized = JSON.stringify(result)
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Expanded profile exceeds 1 MiB; reduce review scope without dropping policy')
  return { ...result, profileHash: hash(serialized) }
}

export function profileTaskResultAccepted(value) {
  return validateResult(value) && value.status === 'done' && value.blockers.length === 0
}
