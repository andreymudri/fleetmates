#!/usr/bin/env node
// Integrator replay (docs/plans/2026-09-24-mid-tier-to-opus.md, Task 3): re-runs past phase
// integrations with a `candidate` model and a `control` model, on the same sample, and writes a
// verdict on whether the integrator's fixed tier can drop to `cheap`.
//
//   node tools/replay/integrator-replay.mjs --roots <a,b> [--count 15] [--seed N] [--out <dir>]
//     [--dry-run | --preflight | --smoke | --execute] [--models '{"candidate":"haiku","control":"sonnet"}']
//
// An integration is one phase of one run: the consecutive `--no-ff` task merges on the run branch's
// first-parent chain that tools/replay/integrator-census.mjs counts, grouped by the census's phase.
// A phase whose merges are not consecutive first-parent commits (an operator commit or a base
// merge between them), or whose phase is unknown, is not replayable and is reported, not sampled.
//
// Each cell builds a scratch repository under `$TMPDIR` with `git init` and one `git fetch` from the
// source repository by sha: the run branch at the phase's first merge's first parent, and every task
// branch at its merged tip, under its recorded name. Task branches are usually pruned, so the tips
// are the merges' second parents. The recorded merges are descendants of all of those, so they are
// not fetched. The source repository is only read.
//
// The session is `claude -p --model <m> --output-format json --permission-mode bypassPermissions
// --strict-mcp-config --append-system-prompt <body of agents/tm-integrator.md>`, with the dispatch
// prompt on stdin. Like tools/replay/replay.mjs, it runs unattended with the operator's own OS
// permissions, and the scratch directory is its starting directory, not a sandbox.
//
// Pass rule, all of: the run branch's final tree equals the tree of the phase's last recorded merge;
// the commits the session added are exactly one per dispatched branch, all on the first-parent
// chain; each is a two-parent merge whose message is exactly the dispatched single-line message
// (so no body and no trailers), in the dispatched order; and every `command` check of the gate
// manifest at the integrated tip passes. `failReason` is the first failing one of `wrong-tree`,
// `session-error`, `extra-commits`, `not-merge`, `message`, `command:<check name>`. A session that
// reports a permission denial makes the cell invalid: nothing is recorded and the run stops.
//
// Only a hashed key (the census key of the phase's last merge: a truncated, unsalted sha256 of the
// run name and merge sha, so pseudonymous, not secret) and metrics are written to
// `integrator-replay.jsonl`. `integrator-verdict.json` holds the counts, the rule and the sample.

import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { censusRoot } from './integrator-census.mjs'
import {
  DEFAULT_SEED, PERMISSION_MODE, copyPreviewPaths, parseClaudeOutput, removeClone, seededShuffle,
} from './replay.mjs'
import { defaultGitExec } from '../../scripts/git.mjs'
import { loadGateConfig, checksForPhase, previewLinks } from '../../scripts/gate-config.mjs'
import { runCommandCheck } from '../../scripts/gate-runner.mjs'
import { validateLinkPaths } from '../../scripts/preview-links.mjs'

export const DEFAULT_COUNT = 15
export const ROLES = ['candidate', 'control']
export const VERDICT_RULE = 'cheap when the candidate passes at least as many integrations as the control, '
  + 'has zero wrong-tree results and a lower mean cost over the same sample; sonnet otherwise'
const TASK_PREFIXES = ['fleetmates', 'teammates']

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
const hash = (text, length) => createHash('sha256').update(text).digest('hex').slice(0, length)

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

async function mustGit(args, cwd, gitExecFn = defaultGitExec) {
  const res = await gitExecFn(args, cwd)
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr || res.stdout).trim()}`)
  return res.stdout
}

function isTaskBranch(name, runId) {
  return TASK_PREFIXES.some((p) => {
    const head = `${p}/${runId}/`
    return name.startsWith(head) && name.length > head.length && !name.slice(head.length).includes('/')
  })
}

// Task branch names by tip sha: the run's recorded gate verdicts first, live refs second — the
// same two sources, in the same order, the census resolves a merge's second parent from.
async function taskBranchNames(root, runId) {
  const names = new Map()
  for (const dir of ['.fleetmates', '.teammates']) {
    let status
    try {
      status = JSON.parse(await readFile(path.join(root, dir, runId, 'status.json'), 'utf8'))
    } catch {
      continue
    }
    for (const [key, gate] of Object.entries(status?.gates ?? {})) {
      if (key.startsWith('solo:') || !gate || typeof gate !== 'object') continue
      for (const [name, sha] of Object.entries(gate.branchShas ?? {})) {
        if (isTaskBranch(name, runId) && typeof sha === 'string' && !names.has(sha)) names.set(sha, name)
      }
    }
    break
  }
  const refs = git(root, ['for-each-ref', '--format=%(objectname) %(refname:short)', ...TASK_PREFIXES.map((p) => `refs/heads/${p}/${runId}/`)])
  for (const line of refs.split('\n').filter(Boolean)) {
    const [sha, name] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]
    if (isTaskBranch(name, runId) && !names.has(sha)) names.set(sha, name)
  }
  return names
}

function firstParentChain(root, branch) {
  const out = git(root, ['log', '--first-parent', '--reverse', '--format=%H%x00%P%x00%B%x1e', branch])
  return out.split('\x1e').map((chunk) => chunk.replace(/^\n/, '')).filter(Boolean).map((chunk) => {
    const [sha, parents, ...body] = chunk.split('\x00')
    return { sha, parents: parents.split(' ').filter(Boolean), message: body.join('\x00') }
  })
}

const subjectOf = (message) => message.split('\n')[0].trim()

// Every integration (run, phase) in one repository, eligible or not. The census supplies which
// merges are integrations, their phase and the conflict flag; the census key of a merge is
// hash(run \0 merge sha), recomputed here to join its rows to the merges.
export async function discoverIntegrations({ root, projectsDir, censusFn = censusRoot }) {
  const rows = await censusFn({ root, projectsDir })
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const branches = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/run/']).split('\n').filter(Boolean).sort()
  const integrations = []
  for (const runBranch of branches) {
    const runId = runBranch.slice('run/'.length)
    const names = await taskBranchNames(root, runId)
    const chain = firstParentChain(root, runBranch)
    const phases = new Map()
    chain.forEach((commit, index) => {
      const row = byKey.get(hash(`${runId}\0${commit.sha}`, 16))
      if (!row || commit.parents.length !== 2) return
      const phaseKey = row.phase === null ? `unknown:${commit.sha}` : String(row.phase)
      if (!phases.has(phaseKey)) phases.set(phaseKey, { phase: row.phase, entries: [] })
      phases.get(phaseKey).entries.push({ commit, index, row })
    })
    for (const { phase, entries } of phases.values()) {
      const last = entries.at(-1).commit
      const base = {
        root, runId, runBranch, phase, key: hash(`${runId}\0${last.sha}`, 16),
        conflicted: entries.some((e) => e.row.conflict),
      }
      if (phase === null) {
        integrations.push({ ...base, eligible: false, reason: 'phase-unknown' })
        continue
      }
      const consecutive = entries.every((e, i) => i === 0 || e.index === entries[i - 1].index + 1)
      if (!consecutive) {
        integrations.push({ ...base, eligible: false, reason: 'non-consecutive' })
        continue
      }
      const merges = entries.map(({ commit }) => ({
        sha: commit.sha, tip: commit.parents[1], branch: names.get(commit.parents[1]) ?? null,
        message: subjectOf(commit.message),
      }))
      if (merges.some((m) => m.branch === null)) {
        integrations.push({ ...base, eligible: false, reason: 'branch-unknown' })
        continue
      }
      integrations.push({
        ...base,
        eligible: true,
        startSha: entries[0].commit.parents[0],
        finalTree: git(root, ['rev-parse', `${last.sha}^{tree}`]).trim(),
        merges,
      })
    }
  }
  return integrations
}

// Conflicted integrations first, so the hard cases are in the sample whenever there are any; each
// group in a seeded shuffle of its key order, so the sample does not depend on discovery order.
export function sampleIntegrations(integrations, { count, seed }) {
  const eligible = integrations.filter((i) => i.eligible).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const conflicted = seededShuffle(eligible.filter((i) => i.conflicted), seed)
  const clean = seededShuffle(eligible.filter((i) => !i.conflicted), seed)
  return [...conflicted, ...clean].slice(0, count)
}

// The scratch repository for one integration; see the file header. Returns { cloneDir }.
export async function buildIntegrationClone({ integration, tmpRoot = tmpdir(), gitExecFn = defaultGitExec }) {
  await mkdir(tmpRoot, { recursive: true })
  const cloneDir = await mkdtemp(path.join(tmpRoot, 'fleetmates-integrator-replay-'))
  try {
    await mustGit(['init', '--quiet'], cloneDir, gitExecFn)
    const refspecs = [
      `${integration.startSha}:refs/heads/${integration.runBranch}`,
      ...integration.merges.map((m) => `${m.tip}:refs/heads/${m.branch}`),
    ]
    await mustGit(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', integration.root, ...refspecs], cloneDir, gitExecFn)
    await mustGit(['config', 'user.name', 'fleetmates-replay'], cloneDir, gitExecFn)
    await mustGit(['config', 'user.email', 'replay@fleetmates.invalid'], cloneDir, gitExecFn)
    await mustGit(['checkout', '--quiet', integration.runBranch], cloneDir, gitExecFn)
  } catch (err) {
    await removeClone(cloneDir)
    throw err
  }
  return { cloneDir }
}

// The body of agents/tm-integrator.md, frontmatter removed.
export async function integratorSystemPrompt(agentFile = path.join(TOOL_DIR, '..', '..', 'agents', 'tm-integrator.md')) {
  const text = await readFile(agentFile, 'utf8')
  const match = /^---\n[\s\S]*?\n---\n/.exec(text)
  return match ? text.slice(match[0].length) : text
}

export function buildDispatchPrompt(integration) {
  return [
    `Integrate phase ${integration.phase} of run ${integration.runId}. The phase gate for this phase returned PASS.`,
    `The repository is the current directory. The run branch is \`${integration.runBranch}\`; no other worktree holds it.`,
    `Merge these task branches into \`${integration.runBranch}\`, one at a time, in exactly this order, each with`,
    '`git merge --no-ff` and exactly the message given: one line, no body, no trailers.',
    '',
    ...integration.merges.map((m, i) => `${i + 1}. \`${m.branch}\` with message \`${m.message}\``),
    '',
    'There is no remote: do not push. When you are done, reply with your return value as JSON.',
  ].join('\n')
}

function attemptOnce({ cwd, prompt, model, systemPrompt, claudeBin, env, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const args = [
      '-p', '--model', model, '--output-format', 'json', '--permission-mode', PERMISSION_MODE,
      '--strict-mcp-config', '--append-system-prompt', systemPrompt,
    ]
    const startedAt = performance.now()
    const child = spawnFn(claudeBin, args, { cwd, env: env ? { ...process.env, ...env } : process.env })
    let stdout = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', () => {})
    child.on('error', () => resolve({ wallClockMs: performance.now() - startedAt, parsed: parseClaudeOutput('') }))
    child.on('close', () => resolve({ wallClockMs: performance.now() - startedAt, parsed: parseClaudeOutput(stdout) }))
    child.stdin?.write(prompt)
    child.stdin?.end()
  })
}

// The structural half of the pass rule, read from the run branch ref (wherever HEAD was left).
async function verifyHistory({ cloneDir, integration, gitExecFn }) {
  const tip = (await gitExecFn(['rev-parse', '--verify', '--quiet', `refs/heads/${integration.runBranch}`], cloneDir)).stdout.trim()
  if (tip === '') return { reason: 'wrong-tree', tip: null }
  const tree = (await mustGit(['rev-parse', `${tip}^{tree}`], cloneDir, gitExecFn)).trim()
  if (tree !== integration.finalTree) return { reason: 'wrong-tree', tip }
  const exclude = [integration.startSha, ...integration.merges.map((m) => m.tip)].map((s) => `^${s}`)
  const added = (await mustGit(['rev-list', tip, ...exclude], cloneDir, gitExecFn)).split('\n').filter(Boolean)
  const firstParent = (await mustGit(['rev-list', '--first-parent', '--reverse', tip, `^${integration.startSha}`], cloneDir, gitExecFn))
    .split('\n').filter(Boolean)
  if (added.length !== integration.merges.length || firstParent.length !== integration.merges.length) {
    return { reason: 'extra-commits', tip }
  }
  for (const [i, sha] of firstParent.entries()) {
    const parents = (await mustGit(['rev-list', '--parents', '-n', '1', sha], cloneDir, gitExecFn)).trim().split(' ').slice(1)
    if (parents.length !== 2) return { reason: 'not-merge', tip }
    const message = (await mustGit(['log', '-1', '--format=%B', sha], cloneDir, gitExecFn)).replace(/\n+$/, '')
    if (message !== integration.merges[i].message) return { reason: 'message', tip }
  }
  return { reason: null, tip }
}

// One cell: clone, copy `preview.link` entries in, one session, verify, remove the clone.
export async function runIntegratorCell({
  integration, model, tmpRoot = tmpdir(), claudeBin = 'claude', env, spawnFn = spawn,
  gitExecFn = defaultGitExec, loadConfigFn = loadGateConfig, runCheckFn = runCommandCheck,
  copyPreviewPathsFn = copyPreviewPaths, systemPrompt,
}) {
  const system = systemPrompt ?? await integratorSystemPrompt()
  const { cloneDir } = await buildIntegrationClone({ integration, tmpRoot, gitExecFn })
  let teardownLinks = null
  try {
    const startConfig = await loadConfigFn(cloneDir)
    const links = startConfig ? previewLinks(startConfig) : []
    if (links.length > 0 && validateLinkPaths(links) === null) {
      teardownLinks = await copyPreviewPathsFn(cloneDir, integration.root, links)
    }
    const attempt = await attemptOnce({
      cwd: cloneDir, prompt: buildDispatchPrompt(integration), model, systemPrompt: system, claudeBin, env, spawnFn,
    })
    const { parsed } = attempt
    const metrics = {
      turns: parsed.turns, totalCostUsd: parsed.totalCostUsd, costMissing: parsed.costMissing, wallClockMs: attempt.wallClockMs,
    }
    if (parsed.usageLimit) return { usageLimit: true }
    if (parsed.permissionDenials > 0) {
      return { invalid: true, permissionDenials: parsed.permissionDenials, deniedTools: parsed.deniedTools, ...metrics }
    }
    const history = await verifyHistory({ cloneDir, integration, gitExecFn })
    let failReason = history.reason === 'wrong-tree' ? 'wrong-tree' : null
    if (failReason === null && (parsed.malformed || parsed.isError)) failReason = 'session-error'
    if (failReason === null) failReason = history.reason
    if (failReason === null) {
      await mustGit(['checkout', '--quiet', '--force', '--detach', history.tip], cloneDir, gitExecFn)
      const config = await loadConfigFn(cloneDir)
      const checks = config ? checksForPhase(config, String(integration.phase)).filter((c) => c?.kind === 'command') : []
      for (const check of checks) {
        const result = await runCheckFn(check, { cwd: cloneDir })
        if (result.status !== 'pass') { failReason = `command:${check.name}`; break }
      }
    }
    return { status: failReason === null ? 'pass' : 'fail', failReason, sessionError: parsed.malformed || parsed.isError, ...metrics }
  } finally {
    if (teardownLinks) await teardownLinks().catch(() => {})
    await removeClone(cloneDir)
  }
}

function roleCounts(rows) {
  const costs = rows.map((r) => r.totalCostUsd)
  const known = costs.every((c) => typeof c === 'number')
  return {
    cells: rows.length,
    pass: rows.filter((r) => r.status === 'pass').length,
    fail: rows.filter((r) => r.status !== 'pass').length,
    wrongTree: rows.filter((r) => r.failReason === 'wrong-tree').length,
    costMissing: costs.filter((c) => typeof c !== 'number').length,
    meanCostUsd: known && rows.length > 0 ? costs.reduce((s, c) => s + c, 0) / rows.length : null,
  }
}

// The verdict over integrations measured by both roles with the current models. A missing cost on
// either side leaves its mean unknown, and an unknown mean never counts as lower.
export function buildVerdict(rows, { models, now = () => new Date().toISOString() }) {
  const pick = (role) => new Map(rows.filter((r) => r.role === role && r.model === models[role]).map((r) => [r.key, r]))
  const candidate = pick('candidate')
  const control = pick('control')
  const keys = [...candidate.keys()].filter((k) => control.has(k))
  const counts = {
    candidate: roleCounts(keys.map((k) => candidate.get(k))),
    control: roleCounts(keys.map((k) => control.get(k))),
  }
  const cheaper = counts.candidate.meanCostUsd !== null && counts.control.meanCostUsd !== null
    && counts.candidate.meanCostUsd < counts.control.meanCostUsd
  const cheap = keys.length > 0 && counts.candidate.pass >= counts.control.pass && counts.candidate.wrongTree === 0 && cheaper
  return { date: now(), verdict: cheap ? 'cheap' : 'sonnet', rule: VERDICT_RULE, models, sampleSize: keys.length, counts }
}

function parseArgs(argv) {
  const flags = {}
  const VALUELESS = new Set(['execute', 'dry-run', 'smoke', 'preflight'])
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const name = token.slice(2)
    if (VALUELESS.has(name)) { flags[name] = true; continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${token} takes a value`)
    flags[name] = next
    i += 1
  }
  return flags
}

function parseModels(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('--models must be valid JSON')
  }
  for (const role of ROLES) {
    if (typeof parsed?.[role] !== 'string' || parsed[role].trim() === '') {
      throw new Error(`--models must name a model for '${role}', e.g. '{"candidate":"haiku","control":"sonnet"}'`)
    }
  }
  return { candidate: parsed.candidate, control: parsed.control }
}

async function readRows(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}

const short = (key) => key.slice(0, 12)

export async function main(argv, io = { out: (s) => process.stdout.write(`${s}\n`) }, deps = {}) {
  const {
    tmpRoot = tmpdir(), outDir = path.join(TOOL_DIR, 'data'), claudeBin = 'claude', claudeEnv, spawnFn = spawn,
    runCheckFn = runCommandCheck, now = () => new Date().toISOString(),
  } = deps
  let flags
  let models = null
  try {
    flags = parseArgs(argv)
    if (flags.execute || flags.smoke || flags.preflight) {
      if (typeof flags.models !== 'string') throw new Error('--execute, --smoke and --preflight need --models \'{"candidate":"...","control":"..."}\'')
      models = parseModels(flags.models)
    }
  } catch (err) {
    io.out(err.message)
    return 2
  }
  const roots = typeof flags.roots === 'string' ? [...new Set(flags.roots.split(',').map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r)))] : []
  if (roots.length === 0) {
    io.out('--roots must name at least one repository (comma-separated)')
    return 2
  }
  const count = flags.count !== undefined ? Number(flags.count) : DEFAULT_COUNT
  const seed = flags.seed !== undefined ? Number(flags.seed) : DEFAULT_SEED
  if (!Number.isInteger(count) || count <= 0) { io.out('--count must be a positive integer'); return 2 }
  if (!Number.isInteger(seed)) { io.out('--seed must be an integer'); return 2 }
  const dataDir = typeof flags.out === 'string' ? path.resolve(flags.out) : outDir

  // The census is asked for the conflict flag and phase only; pointing it at a directory that holds
  // no transcripts keeps it from reading the operator's session history.
  const projectsDir = path.join(tmpRoot, 'fleetmates-integrator-replay-no-transcripts')
  const all = []
  for (const root of roots) {
    try {
      all.push(...await discoverIntegrations({ root, projectsDir }))
    } catch (err) {
      io.out(`${root}: ${err.message.split('\n')[0]}`)
      return 2
    }
  }
  const sample = sampleIntegrations(all, { count, seed })
  const eligible = all.filter((i) => i.eligible)
  const skipped = all.filter((i) => !i.eligible)

  if (!flags.execute && !flags.smoke && !flags.preflight) {
    io.out(`dry run: ${all.length} integration(s) found, ${eligible.length} eligible (${eligible.filter((i) => i.conflicted).length} conflicted), `
      + `${sample.length} sampled for --count ${count}, ${sample.length * ROLES.length} planned cell(s)`)
    for (const i of skipped) io.out(`  skipped ${short(i.key)}: ${i.reason}`)
    for (const i of sample) io.out(`  ${short(i.key)}  merges=${i.merges.length}  conflicted=${i.conflicted}`)
    return 0
  }
  if (sample.length === 0) {
    io.out('no eligible integration to replay')
    return 1
  }

  const systemPrompt = await integratorSystemPrompt()
  const runCell = (integration, role) => runIntegratorCell({
    integration, model: models[role], tmpRoot, claudeBin, env: claudeEnv, spawnFn, runCheckFn, systemPrompt,
  })
  const invalidLine = (integration, role, cell) => `INVALID: ${short(integration.key)} ${role}: the session reported `
    + `${cell.permissionDenials} permission denial(s) (${cell.deniedTools.join(', ')}); nothing was recorded for this cell`

  // Preflight: one candidate cell on the first sampled integration, judged only on whether the
  // session could act: no permission denial, parseable output, no usage limit.
  const preflight = async () => {
    const cell = await runCell(sample[0], 'candidate')
    const ok = !cell.usageLimit && !cell.invalid && !cell.sessionError
    const why = cell.usageLimit ? 'usage limit' : cell.invalid ? `${cell.permissionDenials} permission denial(s) (${cell.deniedTools.join(', ')})` : 'session error'
    io.out(ok ? `preflight: ok — model=${models.candidate} cost=${cell.totalCostUsd ?? 'missing'} turns=${cell.turns ?? 'unknown'}`
      : `preflight: FAILED (${why}) — model=${models.candidate}`)
    return ok
  }

  if (flags.preflight && !flags.execute && !flags.smoke) return (await preflight()) ? 0 : 1

  if (flags.smoke) {
    const cell = await runCell(sample[0], 'candidate')
    if (cell.usageLimit) { io.out('BLOCKED: usage limit during --smoke'); return 1 }
    if (cell.invalid) { io.out(invalidLine(sample[0], 'candidate', cell)); return 1 }
    io.out(`smoke: ${short(sample[0].key)} model=${models.candidate} status=${cell.status} failReason=${cell.failReason ?? 'none'} `
      + `cost=${cell.totalCostUsd ?? 'missing'} turns=${cell.turns ?? 'unknown'}`)
    return cell.status === 'pass' ? 0 : 1
  }

  await mkdir(dataDir, { recursive: true })
  const resultsPath = path.join(dataDir, 'integrator-replay.jsonl')
  const verdictPath = path.join(dataDir, 'integrator-verdict.json')
  const rows = await readRows(resultsPath)
  const doneKey = (key, role) => `${key}\0${role}\0${models[role]}`
  const done = new Set(rows.map((r) => `${r.key}\0${r.role}\0${r.model}`))
  const pending = sample.some((i) => ROLES.some((role) => !done.has(doneKey(i.key, role))))
  if (pending && !(await preflight())) {
    io.out('aborting: the preflight failed, so no cell was run')
    return 1
  }
  const resume = `node tools/replay/integrator-replay.mjs ${argv.join(' ')}`
  for (const integration of sample) {
    for (const role of ROLES) {
      if (done.has(doneKey(integration.key, role))) continue
      const cell = await runCell(integration, role)
      if (cell.usageLimit) { io.out(`BLOCKED: usage limit, resume with ${resume}`); return 1 }
      if (cell.invalid) { io.out(`${invalidLine(integration, role, cell)}; fix the permission setup, then resume with ${resume}`); return 1 }
      const row = {
        key: integration.key, role, model: models[role], status: cell.status, failReason: cell.failReason,
        turns: cell.turns, totalCostUsd: cell.totalCostUsd, costMissing: cell.costMissing, wallClockMs: cell.wallClockMs,
        timestamp: now(),
      }
      await appendFile(resultsPath, `${JSON.stringify(row)}\n`)
      done.add(doneKey(integration.key, role))
      rows.push(row)
    }
  }
  const verdict = buildVerdict(rows, { models, now })
  await writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`)
  io.out(`integrator replay: ${rows.length} cell(s) recorded, verdict ${verdict.verdict} over ${verdict.sampleSize} integration(s)`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
