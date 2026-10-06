import { defaultExec } from './gate-runner.mjs'
import { HARNESS_NAMES } from './harnesses/index.mjs'

const CAPABILITIES = ['harness', 'render', 'ci', 'vault']
const MAX_BYTES = 65536
const observation = (capability, state, reason, metadata = {}) => ({ capability, state, reason, ...metadata })

async function runProbe(capability, command, argv, env, exec) {
  let result
  try {
    result = await exec(command, process.cwd(), {
      argv, env, timeoutMs: 5000, graceMs: 250,
      maxOutputBytes: MAX_BYTES, maxCaptureBytes: MAX_BYTES,
    })
  } catch {
    return { failure: observation(capability, 'unavailable', 'Probe executable could not be started') }
  }
  if (!result || typeof result.output !== 'string' || !Number.isInteger(result.code)) {
    return { failure: observation(capability, 'unknown', 'Malformed probe receipt') }
  }
  if (result.timedOut || result.outputLimited || Buffer.byteLength(result.output) > MAX_BYTES) {
    return { failure: observation(capability, 'unknown', 'Probe exceeded execution limits') }
  }
  if (result.code !== 0) {
    return { failure: observation(capability, 'unavailable', 'Probe exited unsuccessfully') }
  }
  return { output: result.output }
}

async function observe(capability, harness, env, exec) {
  if (capability === 'vault') {
    return observation(capability, 'unavailable', 'No supported read-only Vault adapter is installed')
  }
  const [command, argv] = capability === 'harness'
    ? (harness === 'codex' ? ['codex', ['login', 'status']] : ['cursor-agent', ['status']])
    : capability === 'render'
      ? [env.CHROMIUM_PATH || 'chromium', ['--version']]
      : ['gh', ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts']]
  const result = await runProbe(capability, command, argv, env, exec)
  if (result.failure) return result.failure
  const output = result.output
  if (capability === 'harness') {
    if (/not logged in/i.test(output)) return observation(capability, 'unavailable', 'Harness is not authenticated')
    if (/^Logged in\b/im.test(output)) return observation(capability, 'available', 'Authenticated harness status observed')
    return observation(capability, 'unknown', 'Unrecognized harness authentication response')
  }
  if (capability === 'render') {
    const match = /^Chromium (\d{1,5}(?:\.\d{1,5}){1,3})(?=\s|$)/.exec(output)
    return match
      ? observation(capability, 'available', 'Installed browser version observed', { version: match[1] })
      : observation(capability, 'unknown', 'Unrecognized browser version response')
  }
  let status
  try { status = JSON.parse(output) } catch {
    return observation(capability, 'unknown', 'Malformed GitHub authentication response')
  }
  const accounts = status?.hosts?.['github.com']
  if (!Array.isArray(accounts) || accounts.some(account => !account
    || !['success', 'error'].includes(account.state) || typeof account.active !== 'boolean')) {
    return observation(capability, 'unknown', 'Malformed GitHub authentication schema')
  }
  return accounts.some(account => account.state === 'success' && account.active === true)
    ? observation(capability, 'available', 'Authenticated GitHub CLI observed')
    : observation(capability, 'unavailable', 'No authenticated active GitHub account')
}

export async function probeCapabilities({ required = [], harness = 'codex', env = process.env, exec = defaultExec } = {}) {
  if (!Array.isArray(required) || required.length > 20 || [...required].some(name => !CAPABILITIES.includes(name))) {
    throw new TypeError('required must be a bounded array of known capability names')
  }
  if (!HARNESS_NAMES.includes(harness)) throw new TypeError('Unknown harness name')
  const observations = []
  for (const capability of new Set(required)) observations.push(await observe(capability, harness, env, exec))
  const blocked = observations.filter(item => item.state !== 'available').map(item => `${item.capability}: ${item.reason}`)
  return { version: 1, ready: blocked.length === 0, observations, blocked }
}
