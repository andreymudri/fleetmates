import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { evidenceIdentity } from './workflow-evidence.mjs'
const execute = promisify(execFile)

export function summarizeCi({ inputs, required, snapshot }) {
  const identity = evidenceIdentity(inputs)
  if (!/^[a-f0-9]{40,64}$/.test(inputs.commit) || !Array.isArray(required) || !required.length
      || !snapshot || !Array.isArray(snapshot.check_runs) || !Number.isSafeInteger(snapshot.total_count)
      || snapshot.total_count < snapshot.check_runs.length) throw new Error('Invalid CI evidence contract')
  const names = new Set()
  const obligations = required.map(requirement => {
    if (!requirement || typeof requirement.name !== 'string' || !requirement.name || typeof requirement.app !== 'string' || !requirement.app) throw new Error('CI requires explicit check name and app')
    const key = JSON.stringify([requirement.name, requirement.app])
    if (names.has(key)) throw new Error('Duplicate required CI check')
    names.add(key)
    const matching = snapshot.check_runs.filter(check => check.name === requirement.name && check.app?.slug === requirement.app && check.head_sha === inputs.commit)
    if (matching.some(check => !Number.isSafeInteger(check.id) || check.id <= 0) || new Set(matching.map(check => check.id)).size !== matching.length) throw new Error('Invalid CI attempt identity')
    const latest = matching.reduce((a, b) => !a || b.id > a.id ? b : a, null)
    const status = !latest ? 'missing' : latest.status !== 'completed' ? 'pending'
      : latest.conclusion === 'success' ? 'pass'
      : ['failure', 'timed_out', 'action_required'].includes(latest.conclusion) ? 'fail' : 'unresolved'
    return { ...requirement, status, attempt: latest?.id ?? null, conclusion: latest?.conclusion ?? null,
      url: latest?.html_url ?? null, previousAttempts: matching.filter(check => check !== latest).map(check => check.id),
      action: status === 'pass' ? null : 'inspect-or-escalate; no automatic code rewrite or retry' }
  })
  const truncated = snapshot.total_count !== snapshot.check_runs.length
  return { version: 1, identity, commit: inputs.commit, mode: 'reporting', scope: 'committed-branch-tip-only', complete: !truncated && obligations.every(check => check.status === 'pass'),
    truncated, obligations, inputVerification: { commit: 'check-head-sha', plan: 'declared-only', manifest: 'declared-only', environment: 'declared-only', verifier: 'declared-only' }, stale: snapshot.check_runs.filter(check => check.head_sha !== inputs.commit).map(check => check.id),
    trust: 'CI metadata is an observation tied to declared inputs, not semantic acceptance or permission to publish, merge or deploy.' }
}

export async function collectGitHubCi({ git, repository, inputs, required, exec = execute }) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) throw new Error('Invalid GitHub repository')
  const head = await git.headBranch()
  if (!head.ok) throw new Error('CI collection requires a checked-out branch')
  const commit = await git.resolveRef(head.ref)
  if (inputs?.commit !== commit) throw new Error('CI input commit does not match current branch tip')
  // Validate before any network/tool invocation.
  summarizeCi({ inputs, required, snapshot: { total_count: 0, check_runs: [] } })
  let stdout
  try {
    ({ stdout } = await exec('gh', ['api', `repos/${repository}/commits/${commit}/check-runs?per_page=100`], { timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' }))
  } catch { throw new Error('GitHub CI metadata unavailable; check gh authentication, connectivity or API limits') }
  const report = summarizeCi({ inputs, required, snapshot: JSON.parse(stdout) })
  // Refuse stale collection if local input changed while GitHub was queried.
  if (await git.resolveRef(head.ref) !== commit) throw new Error('Branch tip changed while collecting CI evidence')
  return { ...report, repository, source: 'github-check-runs' }
}
