// The flaky detector: runs a test command, retries exactly once on a non-zero exit, and records a
// test that passed on the retry in the tracked quarantine file. See
// docs/specs/2026-11-02-ci-reliability-design.md, component 2.
//
// The report and the command's argv are written by a process running teammate code, so every name
// read from them goes through `printable` before it reaches a terminal or a step summary.
import { open, lstat, writeFile, rename as fsRename, rm, appendFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { printable } from './reviews.mjs'
import { readReport, openReportFile, MAX_REPORT_BYTES } from './test-report.mjs'

export const QUARANTINE_FILE = 'fleetmates.flaky.json'
// After this many passes in a row a quarantined test is a candidate for release (`doctor` says so).
export const RELEASE_STREAK = 20

export const QUARANTINE_MAX_BYTES = 1024 * 1024

export class FlakyConfigError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function isCount(value) {
  return Number.isInteger(value) && value >= 0
}

function validate(doc, file) {
  const bad = (why) => { throw new FlakyConfigError(`${file} is malformed: ${why}`) }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) bad('not a JSON object')
  if (doc.v !== 1) bad(`unsupported version ${printable(JSON.stringify(doc.v) ?? 'undefined')}, expected 1`)
  const tests = doc.tests
  if (tests === null || typeof tests !== 'object' || Array.isArray(tests)) bad('"tests" is not an object')
  for (const [id, entry] of Object.entries(tests)) {
    const where = `test ${printable(JSON.stringify(id))}`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) bad(`${where} is not an object`)
    if (typeof entry.firstSeen !== 'string' || !ISO.test(entry.firstSeen)) bad(`${where} has no ISO firstSeen`)
    if (typeof entry.lastSeen !== 'string' || !ISO.test(entry.lastSeen)) bad(`${where} has no ISO lastSeen`)
    if (!isCount(entry.flakes)) bad(`${where} has a flakes count that is not a non-negative integer`)
    if (!isCount(entry.passStreak)) bad(`${where} has a passStreak that is not a non-negative integer`)
  }
  return { v: 1, tests: { ...tests } }
}

// `{ v: 1, tests: {} }` when the file is absent; FlakyConfigError naming the file when it is not
// a valid quarantine store. Opened once without following a link and without blocking on a FIFO,
// then judged and read through that handle, bounded by QUARANTINE_MAX_BYTES. win32 has neither
// flag, so there an lstat refuses a link first and the handle must be the file lstat saw.
export async function readQuarantine(root) {
  const file = path.join(root, QUARANTINE_FILE)
  const refuse = (why) => { throw new FlakyConfigError(`${file} ${why}`) }
  const noFollow = constants.O_NOFOLLOW
  let seen = null
  if (noFollow === undefined) {
    try { seen = await lstat(file, { bigint: true }) } catch (err) {
      if (err?.code === 'ENOENT') return { v: 1, tests: {} }
      refuse(`cannot be read: ${printable(err?.code ?? err?.message ?? err)}`)
    }
    if (seen.isSymbolicLink()) refuse('is a symbolic link')
  }
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (err) {
    if (err?.code === 'ENOENT') return { v: 1, tests: {} }
    if (err?.code === 'ELOOP') refuse('is a symbolic link')
    refuse(`cannot be read: ${printable(err?.code ?? err?.message ?? err)}`)
  }
  let text
  try {
    const info = await handle.stat({ bigint: true })
    if (seen && (info.dev !== seen.dev || info.ino !== seen.ino)) refuse('was replaced while it was being opened')
    if (!info.isFile()) refuse('is not a regular file')
    if (info.size > BigInt(QUARANTINE_MAX_BYTES)) refuse(`is larger than ${QUARANTINE_MAX_BYTES} bytes`)
    const buffer = Buffer.alloc(Number(info.size))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    text = buffer.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
  let doc
  try { doc = JSON.parse(text) } catch { refuse('is malformed: not valid JSON') }
  return validate(doc, file)
}

// Temp file in the same directory, then rename: a reader never sees a half-written store.
export async function writeQuarantine(root, store, { rename = fsRename } = {}) {
  const file = path.join(root, QUARANTINE_FILE)
  const temp = path.join(root, `.${QUARANTINE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const sorted = Object.fromEntries(Object.entries(store.tests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  try {
    await writeFile(temp, `${JSON.stringify({ v: 1, tests: sorted }, null, 2)}\n`, { flag: 'wx' })
    await rename(temp, file)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The runner a token names: its basename without a Windows launcher or script extension.
function tool(token) {
  return path.basename(String(token).replaceAll('\\', '/')).replace(/\.(exe|cmd|bat|ps1|js|cjs|mjs)$/i, '').toLowerCase()
}

const PYTEST_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// The argv for a rerun of only `failedNames`, or null when the runner is not one this knows how to
// filter (node:test, vitest, jest, pytest) or a name cannot be expressed in its filter.
export function retryArgv(argv, failedNames) {
  if (!Array.isArray(argv) || argv.length === 0) return null
  const names = [...new Set(failedNames ?? [])]
  if (names.length === 0) return null
  const tools = argv.map(tool)
  const testFlag = argv.indexOf('--test')
  if (tools.includes('node') && testFlag !== -1) {
    return [...argv.slice(0, testFlag + 1), ...names.map((n) => `--test-name-pattern=${escapeRegExp(n)}`), ...argv.slice(testFlag + 1)]
  }
  if (tools.includes('vitest') || tools.includes('jest')) {
    return [...argv, '-t', names.map(escapeRegExp).join('|')]
  }
  const pytest = tools.includes('pytest') || tools.includes('py.test')
    || argv.some((a, i) => a === '-m' && argv[i + 1] === 'pytest')
  if (pytest) {
    // `-k` matches Python identifiers; a parametrized id's `[...]` part is not one, so the rerun
    // covers every parameter of that test.
    const bare = [...new Set(names.map((n) => n.replace(/\[.*$/s, '')))]
    if (!bare.every((n) => PYTEST_NAME.test(n))) return null
    return [...argv, '-k', bare.join(' or ')]
  }
  return null
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
function decode(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : whole
  })
}

// `readReport` keeps an inventory (how often each test ran or was skipped), not outcomes, so it
// is used here to vet the report (no link, no FIFO, bounded size, well-formed JUnit) and this scan
// reads each testcase's name and whether it holds a <failure> or <error>. One pass of indexOf
// calls that only move forward, so it stays linear on agent-written input.
function outcomes(xml) {
  const passed = new Set()
  const failed = new Set()
  let i = 0
  for (;;) {
    const start = xml.indexOf('<testcase', i)
    if (start === -1) break
    const close = xml.indexOf('>', start)
    if (close === -1) break
    const tag = xml.slice(start, close + 1)
    const name = tag.match(/\sname\s*=\s*(?:"([^"]*)"|'([^']*)')/)
    if (tag.endsWith('/>')) {
      if (name) passed.add(decode(name[1] ?? name[2]))
      i = close + 1
      continue
    }
    const end = xml.indexOf('</testcase>', close)
    const body = xml.slice(close + 1, end === -1 ? xml.length : end)
    if (name) {
      const id = decode(name[1] ?? name[2])
      if (/<(failure|error)[\s/>]/.test(body)) failed.add(id)
      else if (!/<skipped[\s/>]/.test(body)) passed.add(id)
    }
    if (end === -1) break
    i = end + '</testcase>'.length
  }
  for (const id of failed) passed.delete(id)
  return { passed: [...passed], failed: [...failed] }
}

// `{ passed, failed }` names from the report, or null when it is missing or unreadable, which
// means the caller cannot tell which tests ran and falls back to the whole command.
async function readOutcomes(report, cwd) {
  if (!report) return null
  const target = path.resolve(cwd, report)
  try {
    if (await readReport(target, { root: [cwd, target] }) === null) return null
    const handle = await openReportFile(target)
    let text
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_REPORT_BYTES) return null
      text = (await handle.readFile()).toString('utf8')
    } finally {
      await handle.close()
    }
    return outcomes(text)
  } catch {
    return null
  }
}

// Removes a report file (or a link standing where one should be) before an attempt, so the names
// read after it come from that attempt. A directory report is left alone: `readOutcomes` reads
// names from a single file only, so a directory never picks the retried tests anyway.
async function clearReport(report, cwd) {
  if (!report) return
  const target = path.resolve(cwd, report)
  let info
  try { info = await lstat(target) } catch { return }
  if (info.isDirectory()) return
  await rm(target, { force: true })
}

function defaultExec(argv, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: 'inherit', shell: false })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0) }))
  })
}

// GitHub workflow-command data: `%`, CR and LF are the characters the runner decodes.
function annotation(text) {
  return printable(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function cell(text) {
  return printable(text).replaceAll('|', '\\|')
}

// Returns { code, flaky: string[], quarantinedFailures: string[], retried: 'none'|'filtered'|'whole' }.
// `write` receives the detector's own lines (`flaky: <name>`, and GitHub annotations when
// GITHUB_ACTIONS=true); the command's output goes to the inherited stdio of the default exec.
// `exec(argv, { cwd, env })` resolves to `{ code }`.
export async function runFlaky(argv, {
  root, cwd = root, report = null, exec = defaultExec, canWrite = true, env = process.env, now = Date.now,
  write = (text) => process.stdout.write(text),
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError('runFlaky needs a non-empty argv array')
  // Read before anything runs: a malformed store refuses the whole run.
  const store = await readQuarantine(root)
  const commandId = argv.join(' ')
  const stamp = () => new Date(now()).toISOString()
  let dirty = false

  await clearReport(report, cwd)
  const first = await exec(argv, { cwd, env })
  const firstOutcomes = await readOutcomes(report, cwd)
  let result

  if (first.code === 0) {
    const ran = firstOutcomes ? firstOutcomes.passed : [commandId]
    for (const id of ran) {
      if (!Object.hasOwn(store.tests, id)) continue
      store.tests[id] = { ...store.tests[id], passStreak: store.tests[id].passStreak + 1 }
      dirty = true
    }
    result = { code: 0, flaky: [], quarantinedFailures: [], retried: 'none' }
  } else {
    const failedFirst = firstOutcomes && firstOutcomes.failed.length > 0 ? firstOutcomes.failed : null
    const filtered = failedFirst ? retryArgv(argv, failedFirst) : null
    const retried = filtered ? 'filtered' : 'whole'
    await clearReport(report, cwd)
    const second = await exec(filtered ?? argv, { cwd, env })
    if (second.code === 0) {
      const flaky = failedFirst ?? [commandId]
      const at = stamp()
      for (const id of flaky) {
        const prior = Object.hasOwn(store.tests, id) ? store.tests[id] : null
        store.tests[id] = { firstSeen: prior?.firstSeen ?? at, lastSeen: at, flakes: (prior?.flakes ?? 0) + 1, passStreak: 0 }
      }
      dirty = true
      result = { code: 0, flaky, quarantinedFailures: [], retried }
    } else {
      // Red unless every test still failing is a named, quarantined test. A whole command is never
      // quarantined (no report, or a report naming no failed test on the first attempt), and a
      // retry whose report names no failed test failed outside any test, so both keep the code.
      const secondOutcomes = await readOutcomes(report, cwd)
      const stillFailing = secondOutcomes ? secondOutcomes.failed : []
      const recovered = failedFirst && secondOutcomes
        ? failedFirst.filter((id) => secondOutcomes.passed.includes(id))
        : []
      const at = stamp()
      for (const id of recovered) {
        const prior = Object.hasOwn(store.tests, id) ? store.tests[id] : null
        store.tests[id] = { firstSeen: prior?.firstSeen ?? at, lastSeen: at, flakes: (prior?.flakes ?? 0) + 1, passStreak: 0 }
        dirty = true
      }
      for (const id of stillFailing) {
        if (!Object.hasOwn(store.tests, id) || store.tests[id].passStreak === 0) continue
        store.tests[id] = { ...store.tests[id], passStreak: 0 }
        dirty = true
      }
      const excused = failedFirst !== null && stillFailing.length > 0
        && stillFailing.every((id) => Object.hasOwn(store.tests, id))
      result = excused
        ? { code: 0, flaky: recovered, quarantinedFailures: stillFailing, retried }
        : { code: first.code, flaky: recovered, quarantinedFailures: [], retried }
    }
  }

  const github = env.GITHUB_ACTIONS === 'true'
  for (const id of result.flaky) {
    write(`flaky: ${printable(id)}\n`)
    if (github) write(`::warning title=flaky::${annotation(id)} passed on retry\n`)
  }
  for (const id of result.quarantinedFailures) {
    write(`flaky: quarantined test failed: ${printable(id)}\n`)
    if (github) write(`::warning title=flaky::quarantined test ${annotation(id)} failed\n`)
  }
  if (github && env.GITHUB_STEP_SUMMARY && (result.flaky.length > 0 || result.quarantinedFailures.length > 0)) {
    const rows = [
      ...result.flaky.map((id) => `| ${cell(id)} | flaky |`),
      ...result.quarantinedFailures.map((id) => `| ${cell(id)} | quarantined, failed |`),
    ]
    await appendFile(env.GITHUB_STEP_SUMMARY, `\n### Flaky tests\n\n| Test | Result |\n| --- | --- |\n${rows.join('\n')}\n`)
  }

  if (dirty && canWrite) await writeQuarantine(root, store)
  return result
}
