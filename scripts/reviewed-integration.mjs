import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGit } from './git.mjs'
import { deriveContext, runChecks, aggregateVerdict } from './gate-runner.mjs'
import { checksForPhase, previewLinks } from './gate-config.mjs'
import { withMergePreview } from './merge-preview.mjs'
import { filesetViolations, resolveTaskBranch } from './enforce.mjs'
import { resolveRoleCapabilities } from './role-capabilities.mjs'

const execute = promisify(execFile)
const receipts = new WeakMap()
const active = new Set()
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const scopedConfig = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'commit.gpgSign=false',
  'tag.gpgSign=false', 'merge.gpgSign=false', 'merge.autoStash=false', 'merge.verifySignatures=false',
  'rerere.enabled=false', 'submodule.recurse=false', 'core.attributesFile=/dev/null']
const trust = ['Gate receipts are process-local executed observations, not serializable authorization.',
  'Review callbacks and executor seams are trusted host code, never artifact or model commands.',
  'Project gate commands execute project code under the host-approved execution policy.',
  'No hostile same-UID isolation or cross-process ref locking; external concurrent writers remain outside this boundary.',
  'No network, publication, force-ref operations or generative integration authority.']

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export async function boundedIntegrationGit(args, cwd, env) {
  try {
    const result = await execute('git', args, { cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    return { code: 0, signal: null, ...result }
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1,
      signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

function scopedGit(root, executor = boundedIntegrationGit) {
  if (typeof executor !== 'function') throw new TypeError('Git executor must be trusted host code')
  const exec = async (args, cwd = root) => {
    if (cwd && typeof cwd === 'object') cwd = cwd.cwd ?? root
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', GIT_NO_REPLACE_OBJECTS: '1' })
    return executor([...scopedConfig.flatMap(value => ['-c', value]), ...args], cwd, env)
  }
  const run = async (args, cwd) => {
    const result = await exec(args, cwd)
    if (result.code !== 0 || result.signal) throw new Error('scoped Git operation failed')
    return result.stdout.trim()
  }
  return { exec, run, git: createGit({ cwd: root, exec }) }
}

async function verifierIdentity() {
  const base = path.dirname(fileURLToPath(import.meta.url))
  const entries = []
  async function walk(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name), relative = prefix + name
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) throw new Error('unsupported verifier configuration')
      if (stat.isDirectory()) await walk(file, relative + '/')
      else if (name.endsWith('.mjs')) entries.push([relative, hash(await readFile(file))])
    }
  }
  await walk(base)
  return hash(JSON.stringify(entries))
}

async function configuration(scope) {
  const executableConfig = '^(merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process)|diff\\.(external|.*\\.(command|textconv))|branch\\..*\\.mergeoptions|core\\.alternaterefscommand|core\\.bare|core\\.sparsecheckout|extensions\\..*)$'
  const { code, stdout, signal } = await scope.exec(['config', '--get-regexp', executableConfig])
  if (signal || ![0, 1].includes(code)) throw new Error('unsupported Git configuration')
  if (stdout.split('\n').some(line => line && !/^(core\.bare|core\.sparsecheckout) false$/i.test(line))) {
    throw new Error('unsupported Git configuration')
  }
  if (await scope.run(['for-each-ref', '--format=%(refname)', 'refs/replace/'])) throw new Error('unsupported replacement configuration')
}

async function clean(scope) {
  const entries = (await scope.run(['ls-files', '-v', '-z'])).split('\0')
  if (entries.some(entry => /^[a-zS] /.test(entry))) throw new Error('unsupported hidden index configuration')
  if (await scope.run(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('dirty checkout')
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const result = await scope.exec(['rev-parse', '--verify', '--quiet', name])
    if (result.signal || result.code !== 1) throw new Error('dirty or interrupted Git operation')
  }
}

async function tracked(scope, commit, file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').some(x => !x || x === '.' || x === '..') || /[:\\\0]/.test(file)) {
    throw new Error('invalid tracked input identity')
  }
  if (!['100644', '100755'].includes(await scope.git.fileModeAtCommit(commit, file))) throw new Error('tracked input is not a regular file')
  return scope.git.fileAtCommit(commit, file)
}

async function snapshot(input, scope, runTip = input.expectedRunTip) {
  const { root, runId, phase, branch, baseBranch, planPath, taskTips } = input
  if (!path.isAbsolute(root) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId)
    || !Number.isSafeInteger(phase) || phase < 1 || !SHA.test(runTip ?? '')
    || typeof branch !== 'string' || branch.startsWith('-') || branch.startsWith('refs/')) throw new Error('invalid integration identity')
  await scope.run(['check-ref-format', '--branch', branch])
  if (typeof baseBranch !== 'string' || baseBranch === branch || baseBranch.startsWith('refs/') || baseBranch.startsWith('-')) {
    throw new Error('base branch must differ from the run branch')
  }
  await scope.run(['check-ref-format', '--branch', baseBranch])
  await configuration(scope)
  await clean(scope)
  if (await scope.git.resolveRef(`refs/heads/${branch}`) !== runTip) throw new Error('run tip moved')
  const ctx = await deriveContext({ git: scope.git, runId, runBranch: branch, baseBranch, planPath })
  if (ctx.phaseError) throw new Error('invalid phase ownership identity')
  const tasks = ctx.tasks.filter(task => task.phase === phase)
  if (!tasks.length || !taskTips || typeof taskTips !== 'object' || Array.isArray(taskTips)
    || !same(Object.keys(taskTips).sort(), tasks.map(task => task.id).sort())) throw new Error('task ownership identity mismatch')
  const tips = {}
  for (const task of tasks) {
    const ref = resolveTaskBranch(task, runId)
    const tip = await scope.git.resolveRef(`refs/heads/${ref}`)
    if (!SHA.test(taskTips[task.id] ?? '') || tip !== taskTips[task.id] || ref === branch) throw new Error('task tip moved or ownership identity mismatch')
    const fork = await scope.git.mergeBase(input.expectedRunTip, tip)
    const changed = await scope.git.changedFiles({ base: fork, branch: tip })
    if (!changed.length || filesetViolations(changed, task.files).length) throw new Error('task ownership identity mismatch')
    tips[task.id] = tip
  }
  const plan = await tracked(scope, ctx.anchorSha, planPath)
  const manifest = await tracked(scope, runTip, 'fleetmates.gate.json')
  const identity = { runId, phase, branch, expectedRunTip: input.expectedRunTip, baseBranch, planPath,
    anchor: ctx.anchorSha, plan: hash(plan), manifest: hash(manifest), verifier: await verifierIdentity(), taskTips: tips }
  return { identity, ctx, tasks, config: JSON.parse(manifest) }
}

function authority(policy) {
  const resolved = resolveRoleCapabilities({ policy, role: 'integrator', harness: 'host', mode: 'host-bounded', network: false })
  if (!resolved.ready) throw new Error('required host integration authority is absent or unsupported')
}

export async function executeReviewedPhaseGate(input) {
  authority(input.policy)
  const root = await realpath(input.root)
  const scoped = scopedGit(root, input.git)
  const before = await snapshot({ ...input, root }, scoped)
  if (before.ctx.currentPhase !== input.phase) throw new Error('gate phase identity mismatch')
  const checks = checksForPhase(before.config, String(input.phase))
  const observed = await withMergePreview({ git: scoped.git, base: input.expectedRunTip,
    branches: before.tasks.map(task => before.identity.taskTips[task.id]), link: previewLinks(before.config), repoRoot: root,
    run: async preview => {
      if (preview.conflict || !preview.path) throw new Error('gate rejected merge conflict')
      const testedTree = await scoped.run(['rev-parse', 'HEAD^{tree}'], preview.path)
      const results = await runChecks(checks, { ...before.ctx, solo: true, cwd: preview.path })
      for (let i = 0; i < results.length; i++) {
        if (results[i].kind !== 'agent' || results[i].status !== 'pending' || typeof input.reviewCheck !== 'function') continue
        const check = checks.find(check => check.name === results[i].name)
        const result = await input.reviewCheck(freeze(structuredClone(check)), freeze({ root: preview.path, testedTree, identity: before.identity }))
        results[i] = { ...results[i], status: result?.status === 'pass' ? 'pass' : 'fail' }
      }
      if (aggregateVerdict(results).verdict !== 'PASS' || checks.some(check => !check.optional
        && !results.some(result => result.name === check.name && result.status === 'pass'))) throw new Error('gate rejected required checks')
      return { testedTree, results }
    } })
  const after = await snapshot({ ...input, root }, scoped)
  if (!same(before.identity, after.identity)) throw new Error('gate inputs moved')
  const receipt = freeze({ version: 1, mode: 'host-bounded', verdict: 'PASS', ...observed, identity: before.identity, trust: [...trust] })
  receipts.set(receipt, { root, input: { ...input, root, taskTips: { ...input.taskTips } }, identity: before.identity, ended: Date.now() })
  return receipt
}

export async function integrateReviewedPhase(input) {
  const receipt = { version: 1, mode: 'host-bounded', complete: false, state: 'unresolved',
    before: input.expectedRunTip, after: null, merges: [], pending: null, trust: [...trust] }
  let scope, lockedRoot
  try {
    authority(input.policy)
    const evidence = receipts.get(input.gateReceipt)
    if (!evidence) throw new Error('fresh executed gate receipt required')
    receipts.delete(input.gateReceipt)
    const root = await realpath(input.root)
    if (root !== evidence.root || Date.now() - evidence.ended > 300_000
      || ['runId', 'phase', 'branch', 'expectedRunTip'].some(key => input[key] !== evidence.identity[key])
      || !same(Object.entries(input.taskTips ?? {}).sort(), Object.entries(evidence.identity.taskTips).sort())) throw new Error('gate identity mismatch')
    if (active.has(root)) throw new Error('integration already active')
    active.add(root); lockedRoot = root
    scope = scopedGit(root, input.git)
    let tip = input.expectedRunTip
    receipt.after = tip
    const anchored = { ...evidence.input, ...input }
    for (const id of Object.keys(evidence.identity.taskTips)) {
      const current = await snapshot(anchored, scope, tip)
      if (!same(current.identity, evidence.identity)) throw new Error('gate input identity moved')
      await scope.run(['checkout', input.branch])
      await clean(scope)
      if (await scope.run(['symbolic-ref', 'HEAD']) !== `refs/heads/${input.branch}`
        || await scope.git.resolveRef(`refs/heads/${input.branch}`) !== tip) throw new Error('checkout identity moved')
      receipt.pending = { task: id, tip: evidence.identity.taskTips[id], before: tip }
      await scope.run(['merge', '--no-ff', '--no-edit', '--no-gpg-sign', '-m', `merge: integrate ${id}`,
        '--end-of-options', evidence.identity.taskTips[id]])
      const after = await scope.git.resolveRef(`refs/heads/${input.branch}`)
      const parents = (await scope.run(['rev-list', '--parents', '-n', '1', after])).split(' ')
      if (parents.length !== 3 || parents[1] !== tip || parents[2] !== evidence.identity.taskTips[id]) throw new Error('merge parent identity mismatch')
      receipt.merges.push({ ...receipt.pending, after })
      receipt.pending = null
      receipt.after = tip = after
    }
    await clean(scope)
    const final = await snapshot(anchored, scope, tip)
    if (!same(final.identity, evidence.identity)) throw new Error('gate input identity moved')
    if (await scope.run(['rev-parse', `${tip}^{tree}`]) !== input.gateReceipt.testedTree) throw new Error('integrated tree identity mismatch')
    receipt.complete = true; receipt.state = 'integrated'
    return freeze(receipt)
  } catch (error) {
    if (scope) {
      try { receipt.after = await scope.git.resolveRef(`refs/heads/${input.branch}`) } catch {
        receipt.lastObservedAfter = receipt.after
        receipt.after = null
        receipt.state = 'unknown-effect'
      }
      try { receipt.conflicts = (await scope.run(['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean) } catch { receipt.conflicts = null }
    }
    if (receipt.merges.length && receipt.state !== 'unknown-effect') receipt.state = 'partial'
    const failure = new Error(error.message)
    failure.receipt = freeze(receipt)
    throw failure
  } finally { if (lockedRoot) active.delete(lockedRoot) }
}
