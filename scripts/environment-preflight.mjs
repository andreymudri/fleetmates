import { createHash } from 'node:crypto'
import { release } from 'node:os'
import { defaultExec, runCommandCheck } from './gate-runner.mjs'

const BLOB_BYTES = 512 * 1024
const OUTPUT_BYTES = 64 * 1024
const capabilities = ['harness', 'render', 'ci', 'vault']
const invalid = field => { throw new Error(`Invalid environment recipe: ${field}`) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
function exact(value, keys, field) {
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid(field)
}
function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) }
function repoPath(value) {
  return text(value, 1024) && !/[\\:*?\[\]]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function list(value, field, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 20) invalid(field)
}
function unique(values, field) { if (new Set(values).size !== values.length) invalid(field) }

export function validateEnvironmentRecipe(value) {
  exact(value, ['version', 'toolchains', 'lockfiles', 'setup', 'baseline', 'required', 'dependencies'], 'fields')
  if (value.version !== 1) invalid('version')
  if (!['clean-checkout', 'linked'].includes(value.dependencies)) invalid('dependencies')
  list(value.toolchains, 'toolchains')
  for (const tool of value.toolchains) {
    exact(tool, ['name', 'command', 'argv', 'expected'], 'toolchain fields')
    if (!text(tool.name, 128) || !text(tool.command, 1024) || !text(tool.expected, 256)) invalid('toolchain strings')
    list(tool.argv, 'toolchain argv')
    if (tool.argv.some(arg => typeof arg !== 'string' || arg.length > 2048 || /[\u0000-\u001f\u007f]/.test(arg))) invalid('toolchain argv strings')
  }
  unique(value.toolchains.map(tool => tool.name), 'toolchain names')
  list(value.lockfiles, 'lockfiles')
  if (value.lockfiles.some(file => !repoPath(file))) invalid('lockfile paths')
  unique(value.lockfiles, 'lockfiles')
  for (const field of ['setup', 'baseline']) {
    list(value[field], field, field === 'baseline' ? 1 : 0)
    for (const check of value[field]) {
      exact(check, ['name', 'run', 'timeoutMs'], `${field} fields`)
      if (!text(check.name, 128) || !text(check.run, 8192)) invalid(`${field} strings`)
      if (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 3600000) invalid(`${field} timeoutMs`)
    }
    unique(value[field].map(check => check.name), `${field} names`)
  }
  list(value.required, 'required')
  if (value.required.some(name => !capabilities.includes(name))) invalid('required capabilities')
  unique(value.required, 'required')
  return structuredClone(value)
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
async function anchoredBlob(git, commit, file) {
  if (!repoPath(file)) invalid('source path')
  const mode = await git.fileModeAtCommit(commit, file)
  if (mode !== '100644' && mode !== '100755') throw new Error('Environment source must be a regular committed blob')
  const size = await git.fileSizeAtCommit(commit, file)
  if (!Number.isSafeInteger(size) || size < 0 || size > BLOB_BYTES) throw new Error('Environment source exceeds the bounded blob size')
  const bytes = await git.fileAtCommit(commit, file)
  if (typeof bytes !== 'string' || bytes.includes('\ufffd') || Buffer.byteLength(bytes) !== size) throw new Error('Environment source cannot be captured as lossless UTF-8 bytes')
  return { bytes, source: { path: file, sha256: hash(bytes), size } }
}
function duration(start, end) { return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null }
const group = status => ({ status, checks: [], durationMs: null })

export async function captureEnvironment({ git, commit, recipePath, cwd, execute = false, exec = defaultExec, now = Date.now }) {
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) invalid('exact source commit')
  if (typeof execute !== 'boolean' || typeof exec !== 'function' || typeof now !== 'function' || !text(cwd, 4096)) invalid('capture options')
  const input = await anchoredBlob(git, commit, recipePath)
  let parsed
  try { parsed = JSON.parse(input.bytes) } catch { invalid('JSON') }
  const recipe = validateEnvironmentRecipe(parsed)
  const lockfiles = []
  for (const file of recipe.lockfiles) lockfiles.push((await anchoredBlob(git, commit, file)).source)
  const start = now()
  const report = {
    version: 1, ready: false, blocked: [], identity: null,
    startedAt: Number.isFinite(start) ? start : null, durationMs: null,
    sources: { commit, recipe: input.source, lockfiles },
    platform: { os: process.platform, arch: process.arch, release: release() },
    dependencies: { layout: recipe.dependencies, reproducible: recipe.dependencies === 'clean-checkout',
      limitations: recipe.dependencies === 'linked' ? ['Linked dependency contents are not captured by the committed recipe and lockfiles.'] : [] },
    required: recipe.required,
    toolchains: [], setup: group('not-executed'), baseline: group('not-executed'),
  }
  for (const tool of recipe.toolchains) {
    const observation = { name: tool.name, expected: tool.expected, version: null, state: 'not-executed', reason: 'Execution was not requested' }
    if (execute) {
      try {
        const result = await exec(tool.command, cwd, { argv: tool.argv, timeoutMs: 5000, graceMs: 250,
          maxOutputBytes: OUTPUT_BYTES, maxCaptureBytes: OUTPUT_BYTES })
        const version = typeof result.output === 'string' ? result.output.trim() : ''
        const complete = result.code === 0 && !result.timedOut && !result.outputLimited && Buffer.byteLength(version) <= 256 && text(version, 256)
        observation.version = complete ? version : null
        observation.state = complete && version.startsWith(tool.expected) ? 'available' : 'unavailable'
        observation.reason = observation.state === 'available' ? null : 'Required tool version was not observed or is incompatible'
      } catch {
        observation.state = 'unavailable'
        observation.reason = 'Required tool could not be executed'
      }
    }
    report.toolchains.push(observation)
  }
  const boundedExec = (command, directory, options) => exec(command, directory, {
    ...options, maxOutputBytes: OUTPUT_BYTES, graceMs: 250,
  })
  const runGroup = async checks => {
    const started = now()
    const result = group('pass')
    for (const check of checks) {
      const checkStarted = now()
      let receipt
      try {
        receipt = await runCommandCheck({ ...check, kind: 'command' }, { cwd, exec: boundedExec })
      } catch (error) {
        receipt = { name: check.name, kind: 'command', status: 'fail', exitCode: null,
          outcome: 'environment-error', log: error.commandLog ?? null }
      }
      receipt.durationMs = duration(checkStarted, now())
      result.checks.push(receipt)
      if (receipt.status !== 'pass' || receipt.log?.complete !== true) { result.status = 'fail'; break }
    }
    result.durationMs = duration(started, now())
    return result
  }
  if (!execute) {
    report.blocked.push('Environment baseline was not executed')
  } else if (report.toolchains.some(tool => tool.state !== 'available')) {
    report.blocked.push('Required toolchain is unavailable')
    report.setup = group('blocked')
    report.baseline = group('blocked')
  } else {
    report.setup = await runGroup(recipe.setup)
    if (report.setup.status !== 'pass') {
      report.blocked.push('Environment setup failed or its evidence is incomplete')
      report.baseline = group('blocked')
    } else {
      report.baseline = await runGroup(recipe.baseline)
      if (report.baseline.status !== 'pass') report.blocked.push('Environment baseline failed or its evidence is incomplete')
    }
  }
  report.ready = execute && report.setup.status === 'pass' && report.baseline.status === 'pass'
  report.durationMs = duration(start, now())
  const outcomes = value => ({ status: value.status, checks: value.checks.map(check => ({
    name: check.name, status: check.status, exitCode: check.exitCode, outcome: check.outcome, complete: check.log?.complete ?? false,
  })) })
  report.identity = hash(JSON.stringify(canonical({ version: report.version, sources: report.sources,
    platform: report.platform, dependencies: report.dependencies, toolchains: report.toolchains,
    setup: outcomes(report.setup), baseline: outcomes(report.baseline) })))
  return report
}
