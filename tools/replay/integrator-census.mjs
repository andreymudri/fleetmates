#!/usr/bin/env node
// Integrator census: how much judgement does the integrator actually exercise on local fleet runs?
//
//   node tools/replay/integrator-census.mjs --roots <a,b> --out <dir> [--execute]
//
// Dry run by default: prints the summary and writes nothing. `--execute` writes
// `<out>/integrator-census.json`. Rows carry hashed keys and metrics only — never a run name, a
// task id, a merge message or a path.
//
// An integration is a `--no-ff` merge on a `run/<run>` branch's first-parent chain whose second
// parent is the tip of a `fleetmates/<run>/<task>` or `teammates/<run>/<task>` branch. Task
// branches are usually pruned after a run, so the tip is looked up in the run's recorded gate
// verdicts (`.fleetmates/<run>/status.json`, `gates.<phase>.branchShas`) first, and in the live
// refs second.
//
// Escalation and blocked are read from `status.json` `integrations.<phase>` (`escalated`, an array
// or a boolean; `status: 'blocked'`). Where the run recorded no such entry both are null — unknown,
// never false.
//
// Integrator transcripts are read with `readSessionUsage`, the reader `cli.mjs usage` uses, from
// `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`). A transcript is joined to a merge
// when its agent type is `tm-integrator` (with or without a plugin prefix) and the merge's commit
// time falls inside the transcript's first and last record timestamps, with a minute of slack. A
// merge with no such transcript is recorded as missing, with null metrics, never 0.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readSessionUsage } from '../../scripts/usage-store.mjs'
import { projectSlug } from '../../scripts/usage.mjs'

const SLACK_MS = 60_000
const TASK_PREFIXES = ['fleetmates', 'teammates']

const hash = (text, length) => createHash('sha256').update(text).digest('hex').slice(0, length)

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

// The task a branch name belongs to, when it is a task branch of this run; otherwise null.
function taskOf(branch, runId) {
  for (const prefix of TASK_PREFIXES) {
    const head = `${prefix}/${runId}/`
    if (branch.startsWith(head) && branch.length > head.length && !branch.slice(head.length).includes('/')) {
      return branch.slice(head.length)
    }
  }
  return null
}

async function readStatus(root, runId) {
  for (const dir of ['.fleetmates', '.teammates']) {
    try {
      return JSON.parse(await readFile(path.join(root, dir, runId, 'status.json'), 'utf8'))
    } catch { /* absent or unreadable: try the next layout */ }
  }
  return null
}

// Gate records keyed by the numeric phase. A `solo:` record is a --no-fleet gate, not a phase.
function gatePhases(status, runId) {
  const gates = status && typeof status.gates === 'object' && status.gates !== null ? status.gates : {}
  const phases = []
  for (const [key, gate] of Object.entries(gates)) {
    if (key.startsWith('solo:') || !gate || typeof gate !== 'object') continue
    const phase = Number.isInteger(gate.phase) ? gate.phase : Number(key)
    if (!Number.isInteger(phase)) continue
    const shas = gate.branchShas && typeof gate.branchShas === 'object' ? gate.branchShas : {}
    const branches = Object.entries(shas).filter(([name]) => taskOf(name, runId) !== null)
    phases.push({ phase, branches })
  }
  return phases.sort((a, b) => a.phase - b.phase)
}

function liveTaskRefs(root, runId) {
  const patterns = TASK_PREFIXES.map((p) => `refs/heads/${p}/${runId}/`)
  const out = git(root, ['for-each-ref', '--format=%(objectname) %(refname:short)', ...patterns])
  return out.split('\n').filter(Boolean).map((line) => {
    const space = line.indexOf(' ')
    return { sha: line.slice(0, space), name: line.slice(space + 1) }
  }).filter((ref) => taskOf(ref.name, runId) !== null)
}

// The run branch's first-parent chain, oldest first, with each commit's parents, time and message.
function firstParentChain(root, branch) {
  const out = git(root, ['log', '--first-parent', '--reverse', '--format=%H%x00%P%x00%ct%x00%B%x1e', branch])
  return out.split('\x1e').map((chunk) => chunk.replace(/^\n/, '')).filter(Boolean).map((chunk) => {
    const [sha, parents, ct, ...body] = chunk.split('\x00')
    return { sha, parents: parents.split(' ').filter(Boolean), time: Number(ct) * 1000, message: body.join('\x00') }
  })
}

// True when the recorded merge tree is exactly what git produces from the two parents unaided.
function mergedCleanly(root, commit) {
  const res = spawnSync('git', ['-C', root, 'merge-tree', '--write-tree', commit.parents[0], commit.parents[1]], { encoding: 'utf8' })
  if (res.status !== 0) return false
  const clean = res.stdout.split('\n')[0].trim()
  const recorded = git(root, ['rev-parse', `${commit.sha}^{tree}`]).trim()
  return clean === recorded
}

// The dispatched form is one line — no body, no trailers — that names the task.
function dispatchedForm(message, taskId) {
  const text = message.replace(/\n+$/, '')
  if (text === '' || text.includes('\n')) return false
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return /^merge(\([^)\s]+\))?: \S/.test(text) && new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(text)
}

function integrationRecord(status, phase) {
  if (phase === null) return null
  const all = status && typeof status.integrations === 'object' && status.integrations !== null ? status.integrations : null
  if (!all || !Object.hasOwn(all, String(phase))) return null
  const rec = all[String(phase)]
  return rec && typeof rec === 'object' ? rec : null
}

// Every tm-integrator transcript under this root's project directory, with its time window.
async function integratorTranscripts(root, projectsDir) {
  const projectDir = path.join(projectsDir, projectSlug(path.resolve(root)))
  let sessions
  try {
    sessions = (await readdir(projectDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
  const found = []
  for (const sessionId of sessions) {
    let report
    try {
      report = await readSessionUsage({ projectsDir, root, sessionId })
    } catch {
      continue
    }
    for (const agent of report.agents) {
      if (!/(^|:)tm-integrator$/.test(agent.agentType)) continue
      let body
      try {
        body = await readFile(path.join(projectDir, sessionId, 'subagents', agent.name), 'utf8')
      } catch {
        continue
      }
      let first = null
      let last = null
      for (const raw of body.split('\n')) {
        if (raw.trim() === '') continue
        let record
        try { record = JSON.parse(raw) } catch { continue }
        const t = Date.parse(record?.timestamp)
        if (!Number.isFinite(t)) continue
        if (first === null || t < first) first = t
        if (last === null || t > last) last = t
      }
      if (first === null) continue
      found.push({
        session: hash(`${sessionId}\0${agent.name}`, 12),
        model: agent.model,
        turns: agent.turns,
        output: agent.output,
        first,
        last,
      })
    }
  }
  return found
}

const MISSING = Object.freeze({ status: 'missing', session: null, model: null, turns: null, output: null })

export async function censusRoot({ root, projectsDir }) {
  const branches = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/run/'])
    .split('\n').filter(Boolean).sort()
  const transcripts = await integratorTranscripts(root, projectsDir)
  const rows = []
  for (const branch of branches) {
    const runId = branch.slice('run/'.length)
    const status = await readStatus(root, runId)
    const phases = gatePhases(status, runId)
    const live = liveTaskRefs(root, runId)
    const chain = firstParentChain(root, branch)
    const runRows = []
    chain.forEach((commit, index) => {
      if (commit.parents.length !== 2) return
      const second = commit.parents[1]
      let taskId = null
      let phase = null
      for (const p of phases) {
        const hit = p.branches.find(([, sha]) => sha === second)
        if (hit) { taskId = taskOf(hit[0], runId); phase = p.phase; break }
      }
      if (taskId === null) {
        const ref = live.find((r) => r.sha === second)
        if (!ref) return
        taskId = taskOf(ref.name, runId)
        const owner = phases.find((p) => p.branches.some(([name]) => name === ref.name))
        phase = owner ? owner.phase : null
      }
      let nonMergeCommits = 0
      for (let i = index + 1; i < chain.length && chain[i].parents.length < 2; i += 1) nonMergeCommits += 1
      const rec = integrationRecord(status, phase)
      const escalated = rec === null
        ? null
        : Array.isArray(rec.escalated) ? rec.escalated.length > 0 : typeof rec.escalated === 'boolean' ? rec.escalated : false
      const transcript = transcripts.find((t) => commit.time >= t.first - SLACK_MS && commit.time <= t.last + SLACK_MS)
      runRows.push({
        key: hash(`${runId}\0${commit.sha}`, 16),
        run: hash(runId, 12),
        phase,
        branchesInPhase: null,
        conflict: !mergedCleanly(root, commit),
        nonMergeCommits,
        messageForm: dispatchedForm(commit.message, taskId),
        escalated,
        blocked: rec === null ? null : rec.status === 'blocked',
        transcript: transcript
          ? { status: 'found', session: transcript.session, model: transcript.model, turns: transcript.turns, output: transcript.output }
          : { ...MISSING },
      })
    })
    for (const row of runRows) {
      if (row.phase !== null) row.branchesInPhase = runRows.filter((r) => r.phase === row.phase).length
    }
    rows.push(...runRows)
  }
  return rows
}

// Nearest-rank percentile over a sorted list; null for an empty one.
function percentile(sorted, p) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

export function summarize(rows) {
  const clean = rows.filter((r) => !r.conflict).length
  const sessions = new Map()
  for (const row of rows) {
    if (row.transcript.status === 'found' && !sessions.has(row.transcript.session)) sessions.set(row.transcript.session, row.transcript)
  }
  const turns = [...sessions.values()].map((t) => t.turns).sort((a, b) => a - b)
  const modelMix = {}
  for (const t of sessions.values()) modelMix[t.model] = (modelMix[t.model] ?? 0) + 1
  return {
    integrations: rows.length,
    clean,
    cleanShare: rows.length === 0 ? null : clean / rows.length,
    conflicts: rows.length - clean,
    escalations: rows.filter((r) => r.escalated === true).length,
    escalationUnrecorded: rows.filter((r) => r.escalated === null).length,
    blocked: rows.filter((r) => r.blocked === true).length,
    nonMergeCommits: rows.reduce((s, r) => s + r.nonMergeCommits, 0),
    offFormMessages: rows.filter((r) => !r.messageForm).length,
    transcripts: { sessions: sessions.size, missingRows: rows.filter((r) => r.transcript.status === 'missing').length },
    turns: { median: percentile(turns, 0.5), p90: percentile(turns, 0.9) },
    modelMix,
  }
}

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--execute') flags.execute = true
    else if (arg === '--roots' || arg === '--out') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} takes a value`)
      flags[arg.slice(2)] = value
      i += 1
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return flags
}

export async function main(argv, io = { out: (s) => process.stdout.write(`${s}\n`) }) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (err) {
    io.out(err.message)
    return 2
  }
  if (typeof flags.roots !== 'string' || flags.roots.trim() === '') {
    io.out('usage: integrator-census.mjs --roots <a,b> [--out <dir>] [--execute]  (--roots is required)')
    return 2
  }
  const roots = [...new Set(flags.roots.split(',').map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r)))]
  for (const root of roots) {
    const res = spawnSync('git', ['-C', root, 'rev-parse', '--git-dir'], { encoding: 'utf8' })
    if (res.status !== 0) {
      io.out(`${root} is not a git repository`)
      return 2
    }
  }
  const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects')
  const rows = []
  for (const root of roots) rows.push(...await censusRoot({ root, projectsDir }))
  const summary = summarize(rows)
  const outDir = path.resolve(flags.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'))
  const outFile = path.join(outDir, 'integrator-census.json')
  io.out(JSON.stringify(summary, null, 2))
  if (flags.execute !== true) {
    io.out(`dry run: ${rows.length} integration(s) found; pass --execute to write ${outFile}`)
    return 0
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(outFile, `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), summary, rows }, null, 2)}\n`, 'utf8')
  io.out(`wrote ${outFile}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
