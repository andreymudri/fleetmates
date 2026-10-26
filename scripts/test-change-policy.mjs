import path from 'node:path'
import { taskBranchName } from './enforce.mjs'

export async function runTestChangePolicy(check, ctx) {
  const result = (status, output, findings = []) => ({ name: check.name, kind: check.kind, status, output, findings, optional: check.optional === true,
    temporalTdd: 'unverified', coverage: 'not-established-by-test-diff' })
  const globs = check.tests?.match ?? ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**']
  if (!Array.isArray(globs) || globs.length === 0 || globs.some(g => typeof g !== 'string' || !g || g.length > 512)) return result('fail', 'tests.match must contain nonempty bounded globs')
  const exceptions = check.exceptions ?? []
  if (!Array.isArray(exceptions) || exceptions.some(e => !e || typeof e.path !== 'string' || !e.path
      || typeof e.reason !== 'string' || !e.reason || typeof e.evidence !== 'string' || !e.evidence)) return result('fail', 'Each test-policy exception needs an exact path, reason and evidence reference')
  const tasks = (ctx.tasks ?? []).filter(t => t.phase === ctx.currentPhase && (ctx.taskScope == null || t.id === ctx.taskScope))
  if (!tasks.length) return result('fail', 'No tasks selected for this test-change policy')
  const findings = [], declared = []
  let integrationBases = null
  for (const task of tasks) {
    const branch = `refs/heads/${taskBranchName(ctx.runId, task.id)}`
    let sha
    try { sha = await ctx.git.resolveRef(branch) } catch { findings.push({ task: task.id, kind: 'missing-task-branch' }); continue }
    let fork = await ctx.git.mergeBase(ctx.runSha ?? ctx.anchorSha, sha)
    if (ctx.runSha && fork === sha) {
      if (integrationBases === null) {
        integrationBases = new Map()
        const range = await ctx.git.commitsBetween({ from: ctx.anchorSha, to: ctx.runSha })
        let cursor = ctx.runSha
        for (let steps = 0; cursor !== ctx.anchorSha && steps <= range.length; steps++) {
          const parents = await ctx.git.commitParents(cursor)
          if (!parents.length) break
          for (const parent of parents.slice(1)) if (!integrationBases.has(parent)) integrationBases.set(parent, parents[0])
          cursor = parents[0]
        }
      }
      fork = integrationBases.get(sha)
      if (!fork) { findings.push({ task: task.id, kind: 'unmeasurable-task-diff' }); continue }
    }
    const changed = await ctx.git.changedFiles({ base: fork, branch: sha })
    const tests = changed.filter(file => globs.some(glob => path.matchesGlob(file.replace(/\\/g, '/'), glob)))
    const sources = changed.filter(file => !tests.includes(file))
    if (tests.length) continue
    for (const file of sources) {
      const exception = exceptions.find(e => e.path === file)
      if (exception) declared.push({ task: task.id, ...exception })
      else findings.push({ task: task.id, kind: 'untested-change', file })
    }
  }
  return { ...result(findings.some(f => f.kind !== 'unmeasurable-task-diff') ? 'fail' : findings.length ? 'pending' : 'pass',
    JSON.stringify({ findings, declaredExceptions: declared, policy: 'test-change only; test edits do not prove coverage or temporal TDD' }), findings), declaredExceptions: declared }
}
