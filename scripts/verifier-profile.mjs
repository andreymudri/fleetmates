import { createHash } from 'node:crypto'
import { inferGateConfig } from './gate-config.mjs'

// A profile proposes tracked checks. It neither writes a manifest nor executes setup.
export function nodeVerifierProfile({ package: pkg, platform = process.platform, required = ['test'] }) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)
      || !['linux', 'darwin', 'win32'].includes(platform)
      || !Array.isArray(required) || new Set(required).size !== required.length
      || required.some(v => !['typecheck', 'lint', 'test', 'build'].includes(v))) throw new Error('Invalid Node verifier profile')
  if (pkg.scripts != null && (typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts))) throw new Error('Package scripts must be an object')
  const scripts = {}
  for (const name of ['typecheck', 'lint', 'test', 'build']) {
    const script = pkg.scripts?.[name]
    if (script !== undefined && (typeof script !== 'string' || !script.trim())) throw new Error(`Invalid ${name} script`)
    if (script !== undefined) scripts[name] = script
  }
  const missing = required.filter(name => !Object.hasOwn(scripts, name))
  const manifest = inferGateConfig({ scripts }, { platform })
  // Scheduling hints are host-dependent; exclude them from the reproducible contract.
  const contract = { version: 1, profile: 'node-typescript', platform, scripts, required, missing,
    phases: manifest.phases, preview: manifest.preview,
    acceptance: required.map(name => ({ id: name, kind: 'deterministic', check: name })),
    limits: ['Declared commands are project code and require existing execution permissions.',
      'Build and tests do not establish semantic acceptance or human approval.',
      'Linked node_modules and local configuration are not hermetic environments.'] }
  return { ...contract, ready: missing.length === 0, identity: createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
    action: missing.length ? 'supply-required-project-scripts' : 'review-and-track-manifest' }
}

export function commandOutcome({ code, timedOut = false }) {
  if (timedOut) return { category: 'timeout', repair: 'investigate-duration-or-environment', retry: 'requires-decision' }
  if (code === 0) return { category: 'success', repair: null, retry: null }
  return { category: 'unclassified', repair: 'inspect-evidence-before-code-changes', retry: 'requires-decision' }
}
