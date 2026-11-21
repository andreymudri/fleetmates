// Acceptance evidence: a recorded state per entry of a plan's `## Acceptance` section, and the
// list of the entries left without one (docs/specs/2026-11-21-acceptance-evidence-design.md).
//
// The evidence is declared by the session that did the work. It is a record, not a proof, and
// nothing here feeds a verdict: `finish` prints the list and decides exactly as it did before.
//
// Entry text comes from a plan and notes come from whoever recorded them. Both are data: every
// line printed here that carries them goes through `printable`.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { bulletSection } from './plan-sections.mjs'
import { printable } from './reviews.mjs'
import { readState, runDir } from './state.mjs'
import { ticketIdentity } from './tickets.mjs'

const exec = promisify(execFile)

export const EVIDENCE_VERSION = 1
export const NOTE_LIMIT = 1024
const STATUSES = ['pass', 'fail']
const ENTRY_ID = /^A[1-9][0-9]{0,3}$/
const COMMIT = /^[a-f0-9]{40}([a-f0-9]{24})?$/

// `code` is the exit code: 2 for a malformed invocation, an unknown entry or run, and a file that
// cannot be read.
export class AcceptanceError extends Error {
  constructor(message, code = 2) {
    super(message)
    this.code = code
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// The entries of the plan, in order: A1, A2, ... The hash is what ties evidence to the text it
// was recorded for.
export function acceptanceEntries(markdown) {
  return bulletSection(markdown, 'Acceptance').map((entry, index) => ({ id: `A${index + 1}`, text: entry.text, textSha256: sha256(entry.text) }))
}

export function evidencePath(root, runId) {
  return path.join(runDir(root, runId), 'acceptance.json')
}

function validRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    && typeof record.textSha256 === 'string' && STATUSES.includes(record.status)
    && typeof record.note === 'string' && typeof record.commit === 'string' && COMMIT.test(record.commit)
    && typeof record.by === 'string' && Number.isSafeInteger(record.at)
}

// A missing file is an empty record. A file that cannot be parsed, or of a version this command
// does not know, is named and refused: nothing repairs or replaces it.
export async function readEvidence(root, runId) {
  const file = evidencePath(root, runId)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: EVIDENCE_VERSION, entries: {} }
    throw new AcceptanceError(`the evidence file ${file} cannot be read: ${error.message}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new AcceptanceError(`the evidence file ${file} is not valid JSON; move it aside to start again`)
  }
  const entries = data?.entries
  if (data?.version !== EVIDENCE_VERSION || entries === null || typeof entries !== 'object' || Array.isArray(entries)
      || Object.entries(entries).some(([id, record]) => !ENTRY_ID.test(id) || !validRecord(record))) {
    throw new AcceptanceError(`the evidence file ${file} is not version ${EVIDENCE_VERSION} acceptance evidence; move it aside to start again`)
  }
  return data
}

export const LOCK_WAIT_MS = 10000

// One recorder at a time. Recording reads the file, changes one entry and writes it back, so two
// recorders that both read before either wrote would each keep only their own entry, and both
// would report success. The lock is a file created exclusively beside the evidence; a recorder
// that cannot take it in time names it and refuses. It is never reclaimed automatically: a lock
// left by a killed process is removed by hand, which the refusal says.
async function withEvidenceLock(file, waitMs, action) {
  const lock = `${file}.lock`
  const deadline = Date.now() + waitMs
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (error) {
      // Windows reports EPERM for a lock file another process is deleting right now.
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
      if (Date.now() >= deadline) {
        throw new AcceptanceError(`another recording holds ${lock}; if no acceptance command is running, remove that file and record again`)
      }
      await sleep(delay)
    }
  }
  try {
    return await action()
  } finally {
    await rm(lock, { force: true, maxRetries: 5, retryDelay: 20 })
  }
}

// Recording again replaces the earlier evidence for the entry. A temporary file and a rename, so
// a reader never meets half a file.
export async function recordEvidence(root, runId, id, record, { waitMs = LOCK_WAIT_MS } = {}) {
  const file = evidencePath(root, runId)
  await mkdir(path.dirname(file), { recursive: true })
  await withEvidenceLock(file, waitMs, async () => {
    const evidence = await readEvidence(root, runId)
    evidence.entries[id] = record
    const tmp = `${file}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
    await writeFile(tmp, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  })
}

// One row per entry of the plan. Evidence recorded for a different text does not count: the entry
// has no evidence, and `changed` says why.
export function summarizeAcceptance(entries, evidence) {
  const rows = entries.map((entry) => {
    const record = Object.hasOwn(evidence.entries, entry.id) ? evidence.entries[entry.id] : null
    if (!record) return { ...entry, state: 'none', changed: false, record: null }
    if (record.textSha256 !== entry.textSha256) return { ...entry, state: 'none', changed: true, record: null }
    return { ...entry, state: record.status, changed: false, record }
  })
  const passed = rows.filter((row) => row.state === 'pass').length
  return { rows, passed, total: rows.length, complete: passed === rows.length }
}

async function git(root, args) {
  const { stdout } = await exec('git', args, { cwd: root, timeout: 10000, windowsHide: true })
  return stdout.trim()
}

async function headCommit(root) {
  try {
    const commit = await git(root, ['rev-parse', '--verify', 'HEAD'])
    if (COMMIT.test(commit)) return commit
  } catch { /* reported below */ }
  throw new AcceptanceError('cannot read the current commit: evidence is recorded with the commit it was taken at')
}

// How many commits HEAD is ahead of the commit the evidence was recorded at, or null when that
// commit is not in this history (a rebase, another clone).
async function commitsSince(root, commit) {
  try {
    await git(root, ['merge-base', '--is-ancestor', commit, 'HEAD'])
    const count = Number(await git(root, ['rev-list', '--count', `${commit}..HEAD`]))
    return Number.isSafeInteger(count) ? count : null
  } catch {
    return null
  }
}

const ORDER = { fail: 0, none: 1, pass: 2 }

// The list. A failed entry comes first, then the entries without evidence, then the passed ones;
// inside each group the plan's order is kept. No verdict is passed on the age of evidence: the
// commit and the distance are shown and the reader decides.
export async function renderAcceptance({ root, runId, summary }) {
  const lines = [`acceptance for run ${printable(runId)}: ${summary.passed} of ${summary.total} entries have pass evidence`]
  const rows = [...summary.rows].sort((a, b) => ORDER[a.state] - ORDER[b.state])
  for (const row of rows) {
    lines.push(`  ${row.id}  ${row.state === 'none' ? 'no evidence' : row.state}  ${printable(row.text)}`)
    if (row.changed) lines.push('        the entry changed since its evidence was recorded')
    if (!row.record) continue
    const since = await commitsSince(root, row.record.commit)
    const age = since === null ? 'a commit that is not in this history' : since === 0 ? 'the current commit' : `${since} commit${since === 1 ? '' : 's'} before the current one`
    lines.push(`        note: ${printable(row.record.note)}`)
    lines.push(`        recorded by ${printable(row.record.by)} at ${row.record.commit.slice(0, 12)}, ${age}`)
  }
  return lines
}

// A run id is a path under `.fleetmates/`: no empty, `.` or `..` segment and no backslash, so it
// cannot name a directory outside it.
function validRunId(runId) {
  return typeof runId === 'string' && runId.length > 0 && runId.length <= 255 && !runId.includes('\\') && !path.isAbsolute(runId)
    && runId.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

async function entriesOfPlan(root, planPath) {
  if (typeof planPath !== 'string' || planPath === '') throw new AcceptanceError('write `--plan <path>`')
  try {
    return acceptanceEntries(await readFile(path.resolve(root, planPath), 'utf8'))
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    throw new AcceptanceError(`cannot read the plan: ${error.message}`)
  }
}

const on = (flags, name) => {
  if (flags[name] === undefined) return false
  if (flags[name] !== true) throw new AcceptanceError(`\`--${name}\` takes no value`)
  return true
}

// `acceptance --run <id> --plan <path>` lists; with `--entry <An> (--pass | --fail) --note <text>`
// it records. It runs nothing: no test suite and no gate check.
export async function runAcceptanceCommand({ root, flags, io, env = process.env, now = Date.now() }) {
  try {
    const runId = flags.run
    if (!validRunId(runId)) throw new AcceptanceError('write `--run <id>`')
    if (await readState(root, runId, 'plan') === null) {
      throw new AcceptanceError(`there is no run ${runId}: evidence belongs to a run created by init-run`)
    }
    const entries = await entriesOfPlan(root, flags.plan)
    const pass = on(flags, 'pass'), fail = on(flags, 'fail')

    if (flags.entry === undefined) {
      if (pass || fail || flags.note !== undefined) throw new AcceptanceError('recording evidence needs `--entry <An>`')
      if (entries.length === 0) return 0
      const summary = summarizeAcceptance(entries, await readEvidence(root, runId))
      for (const line of await renderAcceptance({ root, runId, summary })) io.out(line)
      return summary.complete ? 0 : 1
    }

    if (typeof flags.entry !== 'string') throw new AcceptanceError('write `--entry <An>`')
    const id = flags.entry.toUpperCase()
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) {
      throw new AcceptanceError(entries.length === 0
        ? `there is no entry ${flags.entry}: the plan has no Acceptance entries`
        : `there is no entry ${flags.entry}: the plan has A1 to A${entries.length}`)
    }
    if (pass === fail) throw new AcceptanceError('recording evidence needs exactly one of --pass and --fail')
    if (typeof flags.note !== 'string' || flags.note.trim() === '') throw new AcceptanceError('recording evidence needs `--note <text>`: what proved the entry, or what failed')
    if ([...flags.note].length > NOTE_LIMIT) throw new AcceptanceError(`the note takes at most ${NOTE_LIMIT} characters`)
    const status = pass ? 'pass' : 'fail'
    await recordEvidence(root, runId, id, {
      textSha256: entry.textSha256, status, note: flags.note, commit: await headCommit(root), by: ticketIdentity(env), at: now,
    })
    io.out(`recorded ${id} as ${status}`)
    return 0
  } catch (error) {
    if (!(error instanceof AcceptanceError)) throw error
    io.out(`acceptance: ${printable(error.message)}`)
    return error.code
  }
}

// The same list, for `finish` to print after its summary. A plan without Acceptance entries gives
// no line. A plan or an evidence file that cannot be read gives one line saying so: it must never
// change what `finish` decides.
export async function acceptanceLinesForFinish({ root, runId, planPath }) {
  try {
    const entries = await entriesOfPlan(root, planPath)
    if (entries.length === 0) return []
    return await renderAcceptance({ root, runId, summary: summarizeAcceptance(entries, await readEvidence(root, runId)) })
  } catch (error) {
    return [`acceptance: ${printable(error.message)}`]
  }
}
