import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat, realpath, mkdtemp, rm, mkdir, open, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGit } from './git.mjs'
import { deriveContext, runChecks, aggregateVerdict } from './gate-runner.mjs'
import { checksForPhase, previewLinks } from './gate-config.mjs'
import { createVerificationExecutor } from './harnesses/codex.mjs'
import { MAX_REPORT_BYTES } from './test-report.mjs'
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
  'Production project commands require independently probed native verification authority, separate from fixed Git authority.',
  'No hostile same-UID isolation or cross-process ref locking; external concurrent writers remain outside this boundary.',
  'Fixed Git integration grants no network, publication, force-ref operations or generative integration authority.',
  'Injected unit fixtures do not establish OS confinement or production completion evidence.']

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
  const bindings = new Map()
  const raw = async (args, cwd = root) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', GIT_NO_REPLACE_OBJECTS: '1' })
    return executor([...scopedConfig.flatMap(value => ['-c', value]), ...args], cwd, env)
  }
  const binding = async (cwd = root) => {
    cwd = await realpath(cwd)
    const observed = await raw(['rev-parse', '--show-toplevel'], cwd)
    if (observed.code !== 0 || observed.signal) throw new Error('unsupported Git worktree root')
    let effective
    try { effective = await realpath(observed.stdout.replace(/\r?\n$/, '')) }
    catch { throw new Error('unsupported Git worktree root') }
    if (effective !== cwd) throw new Error('unsupported Git worktree root')
    const dirs = await raw(['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'], cwd)
    const config = await raw(['config', '--get-all', 'core.worktree'], cwd)
    if (dirs.code !== 0 || dirs.signal || config.signal || ![0, 1].includes(config.code)) throw new Error('unsupported Git worktree configuration')
    const paths = dirs.stdout.replace(/\r?\n$/, '').split(/\r?\n/)
    if (paths.length !== 2) throw new Error('unsupported Git worktree configuration')
    const identity = hash(JSON.stringify([cwd, ...await Promise.all(paths.map(dir => realpath(dir))), config.stdout]))
    if (bindings.has(cwd) && bindings.get(cwd) !== identity) throw new Error('Git worktree configuration changed')
    bindings.set(cwd, identity)
    return identity
  }
  const exec = async (args, cwd = root) => {
    if (cwd && typeof cwd === 'object') cwd = cwd.cwd ?? root
    args = [...args]
    while (args[0] === '-C') {
      cwd = path.resolve(cwd, args[1])
      args.splice(0, 2)
    }
    cwd = await realpath(cwd)
    if (['checkout', 'merge'].includes(args[0]) || (args[0] === 'worktree' && args[1] === 'add')) await binding(cwd)
    return raw([`--work-tree=${cwd}`, ...args], cwd)
  }
  const run = async (args, cwd) => {
    const result = await exec(args, cwd)
    if (result.code !== 0 || result.signal) throw new Error('scoped Git operation failed')
    return result.stdout.trim()
  }
  return { exec, run, binding, git: createGit({ cwd: root, exec }) }
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

// The filter `git lfs install` writes runs only when user or system configuration installed it; the
// same entries in repository configuration, or any other value, stay refused.
const lfsFilter = new Map([['filter.lfs.clean', 'git-lfs clean -- %f'], ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.process', 'git-lfs filter-process']])

function allowedConfig(line) {
  const match = /^([a-z]+)\t(\S+) (.*)$/.exec(line)
  if (!match) return false
  const [, origin, key, value] = match
  if (/^(core\.bare|core\.sparsecheckout)$/i.test(key)) return /^false$/i.test(value)
  return ['system', 'global'].includes(origin) && lfsFilter.get(key) === value
}

async function configuration(scope) {
  const executableConfig = '^(merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process)|diff\\.(external|.*\\.(command|textconv))|branch\\..*\\.mergeoptions|core\\.alternaterefscommand|core\\.bare|core\\.sparsecheckout|extensions\\..*)$'
  const { code, stdout, signal } = await scope.exec(['config', '--show-scope', '--get-regexp', executableConfig])
  if (signal || ![0, 1].includes(code)) throw new Error('unsupported Git configuration')
  if (stdout.split('\n').some(line => line && !allowedConfig(line))) throw new Error('unsupported Git configuration')
  if (await scope.run(['for-each-ref', '--format=%(refname)', 'refs/replace/'])) throw new Error('unsupported replacement configuration')
  return scope.binding()
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
  const worktreeBinding = await configuration(scope)
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
    anchor: ctx.anchorSha, plan: hash(plan), manifest: hash(manifest), verifier: await verifierIdentity(), taskTips: tips, worktreeBinding }
  return { identity, ctx, tasks, config: JSON.parse(manifest) }
}

function authority(policy) {
  const resolved = resolveRoleCapabilities({ policy, role: 'integrator', harness: 'host', mode: 'host-bounded', network: false })
  if (!resolved.ready) throw new Error('required host integration authority is absent or unsupported')
}

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"

async function collectPrivateReports(source, destination) {
  let bytes = 0, entries = 0
  const canonical = await realpath(source)
  async function collect(dir, target, depth) {
    const stat = await lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || depth > 8
      || (dir === source ? await realpath(dir) !== canonical : !(await realpath(dir)).startsWith(canonical + path.sep))) {
      throw new Error('verification report directory is unsafe')
    }
    for (const name of await readdir(dir)) {
      if (++entries > 1000) throw new Error('verification report count exceeded')
      const file = path.join(dir, name), out = path.join(target, name)
      const info = await lstat(file)
      if (info.isSymbolicLink()) throw new Error('verification report is a symbolic link')
      if (info.isDirectory()) {
        await mkdir(out)
        await collect(file, out, depth + 1)
      } else {
        if (!info.isFile()) throw new Error('verification report is not a regular file')
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const observed = await handle.stat()
          if (!observed.isFile() || observed.size > MAX_REPORT_BYTES - bytes) throw new Error('verification report byte bound exceeded')
          const buffer = Buffer.alloc(observed.size + 1)
          let length = 0
          while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, null)
            if (!read.bytesRead) break
            length += read.bytesRead
          }
          if (length !== observed.size) throw new Error('verification report changed while reading')
          bytes += length
          await writeFile(out, buffer.subarray(0, length), { flag: 'wx', mode: 0o600 })
        } finally { await handle.close() }
      }
    }
  }
  await collect(source, destination, 0)
}

export const executeReviewedPhaseGate = input => executeGate(input, null)
export const executeReviewedPhaseGateFixture = (input, factory) => {
  if (typeof factory !== 'function') throw new TypeError('explicit injected unit fixture executor required')
  return executeGate(input, factory)
}

async function executeGate(input, fixtureFactory) {
  authority(input.policy)
  const root = await realpath(input.root)
  const scoped = scopedGit(root, input.git)
  const before = await snapshot({ ...input, root }, scoped)
  if (before.ctx.currentPhase !== input.phase) throw new Error('gate phase identity mismatch')
  const checks = checksForPhase(before.config, String(input.phase))
  const common = await scoped.run(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const enforcement = resolveRoleCapabilities({ policy: { version: 1, roles: { implementer: {
    read: true, write: true, execute: true, network: false, sharedRefs: false, publication: false
  } } }, role: 'implementer', harness: 'codex', sandboxMode: 'clone', network: false }).enforcement
  const verification = { kind: fixtureFactory ? 'injected-unit-fixture' : 'native-required',
    observedNative: false, requested: { write: true, network: false, sharedRefs: false, publication: false }, observed: null }
  const workers = new Set(), brokers = new Map(), reviews = new Map()
  let mergedPreview = null, verificationFailure = null
  const closeWorker = async cwd => {
    const pending = brokers.get(cwd)
    if (pending) { brokers.delete(cwd); const broker = await pending; await broker.close() }
  }
  const previewGit = { ...scoped.git,
    addWorktreeDetached: async (dir, ref) => {
      await scoped.git.addWorktreeDetached(dir, ref)
      workers.add(await realpath(dir))
      return dir
    },
    mergeInto: async (dir, branches) => {
      const conflict = await scoped.git.mergeInto(dir, branches)
      if (!conflict) mergedPreview = { root: dir, testedTree: await scoped.run(['rev-parse', 'HEAD^{tree}'], dir) }
      return conflict
    },
    removeWorktree: async dir => {
      try {
        if (mergedPreview?.root === dir && typeof input.reviewCheck === 'function') {
          for (const check of checks.filter(check => check.kind === 'agent')) {
            try {
              const observed = freeze({ ...mergedPreview, identity: before.identity, verification: { ...verification } })
              const result = await input.reviewCheck(freeze(structuredClone(check)), observed)
              reviews.set(check.name, result?.status === 'pass' ? 'pass' : 'fail')
            } catch { reviews.set(check.name, 'fail') }
          }
        }
        await closeWorker(dir)
      } finally { workers.delete(dir); await scoped.git.removeWorktree(dir) }
    } }
  const confinedExec = async (command, cwd, options = {}) => {
    try {
      cwd = await realpath(cwd)
      if (!workers.has(cwd)) throw new Error('verification cwd is not a gate-owned preview')
      if (!brokers.has(cwd)) {
        const sandbox = { cwd, meta: { mode: 'clone', gitdir: common, enforcement } }
        brokers.set(cwd, (async () => {
          const broker = fixtureFactory ? await fixtureFactory({ sandbox, root, enforcement })
            : await createVerificationExecutor({ sandbox, root, enforcement })
          if (!broker || typeof broker.exec !== 'function' || typeof broker.close !== 'function') throw new Error('verification executor is missing')
          if (!fixtureFactory && (broker.evidence?.observed !== true || broker.evidence.kind !== 'required'
            || broker.evidence.runtime !== 'codex-sandbox' || broker.evidence.network !== false
            || broker.evidence.sharedRefs !== false || broker.evidence.publication !== false || broker.evidence.write !== true)) {
            await broker.close()
            throw new Error('verification restrictions were not independently observed')
          }
          if (!fixtureFactory) { verification.observedNative = true; verification.observed = { ...broker.evidence } }
          return broker
        })())
      }
      const broker = await brokers.get(cwd)
      let reportDir
      try {
        if (options.env?.FLEETMATES_REPORT_DIR) {
          reportDir = await mkdtemp(path.join(cwd, '.fm-reviewed-report-'))
          command = `export FLEETMATES_REPORT_DIR=${shellQuote(reportDir)};\n${command}`
        }
        const result = await broker.exec(command, cwd, { ...options, env: null })
        if (reportDir && result.code === 0 && !result.timedOut && !result.outputLimited) {
          await collectPrivateReports(reportDir, options.env.FLEETMATES_REPORT_DIR)
        }
        return result
      } finally { if (reportDir) await rm(reportDir, { recursive: true, force: true }) }
    } catch (error) { verificationFailure = error; throw error }
  }
  let results
  try {
    results = await runChecks(checks, { ...before.ctx, git: previewGit, cwd: root,
      runBranchRef: `refs/heads/${input.branch}`, previewLink: previewLinks(before.config), exec: confinedExec })
  } finally { for (const cwd of brokers.keys()) await closeWorker(cwd).catch(() => {}) }
  for (const result of results) {
    if (result.kind === 'agent' && result.status === 'pending' && reviews.has(result.name)) result.status = reviews.get(result.name)
  }
  if (verificationFailure || !mergedPreview || aggregateVerdict(results).verdict !== 'PASS'
    || results.some(result => !result.optional && result.status !== 'pass')
    || checks.some(check => !check.optional && !results.some(result => result.name === check.name && result.status === 'pass'))) {
    const conflict = results.some(result => result.kind === 'merge' && result.status === 'fail' && result.pairs)
    const error = new Error(verificationFailure ? `gate rejected verification: ${verificationFailure.message}`
      : conflict ? 'gate rejected merge conflict' : 'gate rejected required checks')
    error.results = results
    error.verification = freeze({ ...verification })
    throw error
  }
  const after = await snapshot({ ...input, root }, scoped)
  if (!same(before.identity, after.identity)) throw new Error('gate inputs moved')
  const receipt = freeze({ version: 1, mode: 'host-bounded', verdict: 'PASS', testedTree: mergedPreview.testedTree,
    results, verification, identity: before.identity, trust: [...trust] })
  receipts.set(receipt, { root, input: { ...input, root, taskTips: { ...input.taskTips } },
    identity: before.identity, verification, ended: Date.now() })
  return receipt
}

export const integrateReviewedPhase = input => integrate(input, 'native-required')
export const integrateReviewedPhaseFixture = input => integrate(input, 'injected-unit-fixture')

async function integrate(input, verificationKind) {
  const receipt = { version: 1, mode: 'host-bounded', complete: false, state: 'unresolved',
    before: input.expectedRunTip, after: null, merges: [], pending: null, trust: [...trust] }
  let scope, lockedRoot
  try {
    authority(input.policy)
    const evidence = receipts.get(input.gateReceipt)
    if (!evidence || evidence.verification.kind !== verificationKind) throw new Error('fresh executed gate receipt with matching verification authority required')
    receipt.verification = { ...evidence.verification }
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
