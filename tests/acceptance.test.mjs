import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  EVIDENCE_VERSION, NOTE_LIMIT, acceptanceEntries, acceptanceLinesForFinish, evidencePath, readEvidence, summarizeAcceptance,
} from '../scripts/acceptance.mjs'
import { runCli } from '../scripts/cli.mjs'

// docs/specs/2026-11-21-acceptance-evidence-design.md. Each test below covers a rule the spec
// states, through the command a session runs.

const PLAN = (entries) => [
  '# Plan', '', '## Global Constraints', '', '- none', '', '## Destination', '', 'It works.', '',
  '## Statement', '', 'Make it work.', '',
  ...(entries.length ? ['## Acceptance', '', ...entries.map((entry) => `- ${entry}`), ''] : []),
  '### Task 1: one', '', '**Files:**', '- Create: `a.txt`', '', '- [ ] **Step 1:** do it', '',
].join('\n')

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function commit(root, message) {
  git(root, 'add', '-A')
  git(root, '-c', 'user.name=tester', '-c', 'user.email=tester@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

// A repository with one plan and the run `r1` created from it.
async function project(t, entries = ['the first thing holds', 'the second thing holds']) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-acceptance-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  git(root, 'init', '-q', '-b', 'main')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  await writeFile(path.join(root, 'plan.md'), PLAN(entries))
  commit(root, 'plan')
  const quiet = { out() {}, err() {} }
  assert.equal(await runCli(['init-run', 'plan.md', '--run', 'r1', '--root', root], quiet), 0)
  return root
}

async function cli(root, ...args) {
  const lines = []
  const io = { out: (line) => lines.push(String(line)), err: (line) => lines.push(String(line)) }
  const code = await runCli(['acceptance', '--run', 'r1', '--plan', 'plan.md', ...args, '--root', root], io)
  return { code, lines, text: lines.join('\n') }
}

test('entries are numbered in the order of the plan, and a plan without the section has none', () => {
  const entries = acceptanceEntries(PLAN(['one', 'two', 'three']))
  assert.deepEqual(entries.map((entry) => [entry.id, entry.text]), [['A1', 'one'], ['A2', 'two'], ['A3', 'three']])
  assert.match(entries[0].textSha256, /^[a-f0-9]{64}$/)
  assert.notEqual(entries[0].textSha256, entries[1].textSha256)
  assert.deepEqual(acceptanceEntries(PLAN([])), [])
})

test('the list shows every entry without evidence and exits 1 until every entry has pass', async (t) => {
  const root = await project(t)
  const before = await cli(root)
  assert.equal(before.code, 1)
  assert.equal(before.lines[0], 'acceptance for run r1: 0 of 2 entries have pass evidence')
  assert.match(before.text, /^ {2}A1 {2}no evidence {2}the first thing holds$/m)
  assert.match(before.text, /^ {2}A2 {2}no evidence {2}the second thing holds$/m)
  assert.equal(existsSync(evidencePath(root, 'r1')), false, 'listing writes nothing')

  assert.equal((await cli(root, '--entry', 'A1', '--pass', '--note', 'ran the suite, 12 passing')).code, 0)
  const half = await cli(root)
  assert.equal(half.code, 1, 'one entry still has no evidence')
  assert.equal(half.lines[0], 'acceptance for run r1: 1 of 2 entries have pass evidence')

  assert.equal((await cli(root, '--entry', 'A2', '--pass', '--note', 'read the output')).code, 0)
  const done = await cli(root)
  assert.equal(done.code, 0)
  assert.equal(done.lines[0], 'acceptance for run r1: 2 of 2 entries have pass evidence')
})

test('recording stores the state, the note, the commit and the recorder, and a second recording replaces the first', async (t) => {
  const root = await project(t)
  const head = git(root, 'rev-parse', 'HEAD')
  const lines = []
  const env = { CLAUDE_CODE_SESSION_ID: 'session-one' }
  const { runAcceptanceCommand } = await import('../scripts/acceptance.mjs')
  const record = (flags) => runAcceptanceCommand({ root, flags: { run: 'r1', plan: 'plan.md', ...flags }, io: { out: (l) => lines.push(l) }, env, now: 1700000000000 })

  assert.equal(await record({ entry: 'a1', fail: true, note: 'the endpoint returned 500' }), 0, 'the entry id is read in either case')
  assert.deepEqual(lines, ['recorded A1 as fail'])
  let evidence = await readEvidence(root, 'r1')
  assert.equal(evidence.version, EVIDENCE_VERSION)
  assert.deepEqual(evidence.entries.A1, {
    textSha256: acceptanceEntries(PLAN(['the first thing holds']))[0].textSha256,
    status: 'fail', note: 'the endpoint returned 500', commit: head, by: 'session-one', at: 1700000000000,
  })

  assert.equal(await record({ entry: 'A1', pass: true, note: 'fixed, returns 200' }), 0)
  evidence = await readEvidence(root, 'r1')
  assert.equal(evidence.entries.A1.status, 'pass')
  assert.equal(evidence.entries.A1.note, 'fixed, returns 200')
  assert.deepEqual(Object.keys(evidence.entries), ['A1'])

  // Outside a session the recorder is the terminal.
  assert.equal(await runAcceptanceCommand({ root, flags: { run: 'r1', plan: 'plan.md', entry: 'A2', pass: true, note: 'x' }, io: { out() {} }, env: {} }), 0)
  assert.equal((await readEvidence(root, 'r1')).entries.A2.by, 'terminal')
})

test('the list puts a failed entry first, and shows the note, the recorder and the distance from the commit', async (t) => {
  const root = await project(t, ['one', 'two', 'three'])
  await cli(root, '--entry', 'A1', '--pass', '--note', 'checked one')
  const recordedAt = git(root, 'rev-parse', 'HEAD')
  commit(root, 'a later commit')
  commit(root, 'another')
  await cli(root, '--entry', 'A3', '--fail', '--note', 'three is broken')

  const listed = await cli(root)
  assert.equal(listed.code, 1)
  const rows = listed.lines.filter((line) => /^ {2}A\d/.test(line)).map((line) => line.trim().split(/ {2}/)[0])
  assert.deepEqual(rows, ['A3', 'A2', 'A1'], 'failed, then no evidence, then passed')
  assert.match(listed.text, /^ {2}A3 {2}fail {2}three$/m)
  assert.match(listed.text, /^ {8}note: three is broken$/m)
  assert.match(listed.text, /^ {8}recorded by \S+ at [a-f0-9]{12}, the current commit$/m)
  assert.ok(listed.lines.includes(`        recorded by ${listed.text.match(/recorded by (\S+)/)[1]} at ${recordedAt.slice(0, 12)}, 2 commits before the current one`),
    'a later commit does not invalidate evidence: the distance is shown and the entry still passes')
  assert.equal(listed.lines[0], 'acceptance for run r1: 1 of 3 entries have pass evidence')
})

test('an entry whose text changed after its evidence was recorded is listed as having no evidence', async (t) => {
  const root = await project(t)
  await cli(root, '--entry', 'A1', '--pass', '--note', 'ok')
  await cli(root, '--entry', 'A2', '--pass', '--note', 'ok')
  assert.equal((await cli(root)).code, 0)

  await writeFile(path.join(root, 'plan.md'), PLAN(['the first thing holds', 'the second thing holds, and so does a third']))
  const listed = await cli(root)
  assert.equal(listed.code, 1)
  assert.match(listed.text, /^ {2}A2 {2}no evidence {2}the second thing holds, and so does a third\n {8}the entry changed since its evidence was recorded$/m)
  assert.doesNotMatch(listed.text, /A2[^\n]*\n[^\n]*\n? {8}note:/, 'the stale note is not shown as if it covered the new text')
  assert.equal(listed.lines[0], 'acceptance for run r1: 1 of 2 entries have pass evidence')

  const summary = summarizeAcceptance(acceptanceEntries(await readFile(path.join(root, 'plan.md'), 'utf8')), await readEvidence(root, 'r1'))
  assert.deepEqual(summary.rows.map((row) => [row.id, row.state, row.changed]), [['A1', 'pass', false], ['A2', 'none', true]])
})

test('a plan without an Acceptance section prints nothing and exits 0', async (t) => {
  const root = await project(t, [])
  const listed = await cli(root)
  assert.deepEqual([listed.code, listed.lines], [0, []])
  const recorded = await cli(root, '--entry', 'A1', '--pass', '--note', 'x')
  assert.equal(recorded.code, 2)
  assert.match(recorded.text, /there is no entry A1: the plan has no Acceptance entries/)
})

test('a malformed recording, an unknown entry and an unknown run exit 2 and write nothing', async (t) => {
  const root = await project(t)
  const refused = async (args, pattern) => {
    const result = await cli(root, ...args)
    assert.equal(result.code, 2, `${args.join(' ')} -> ${result.text}`)
    assert.match(result.text, pattern)
  }
  await refused(['--entry', 'A3', '--pass', '--note', 'x'], /^acceptance: there is no entry A3: the plan has A1 to A2$/)
  await refused(['--entry', 'A1', '--note', 'x'], /exactly one of --pass and --fail/)
  await refused(['--entry', 'A1', '--pass', '--fail', '--note', 'x'], /exactly one of --pass and --fail/)
  await refused(['--entry', 'A1', '--pass'], /needs `--note <text>`/)
  await refused(['--entry', 'A1', '--pass', '--note', '   '], /needs `--note <text>`/)
  await refused(['--entry', 'A1', '--pass', '--note', 'x'.repeat(NOTE_LIMIT + 1)], /at most 1024 characters/)
  await refused(['--pass', '--note', 'x'], /needs `--entry <An>`/)
  await refused(['--note', 'x'], /needs `--entry <An>`/)
  assert.equal((await cli(root, '--entry', 'A1', '--pass', '--note', 'x'.repeat(NOTE_LIMIT))).code, 0, 'the limit itself is accepted')
  await rm(evidencePath(root, 'r1'))

  const lines = []
  const io = { out: (line) => lines.push(String(line)), err: (line) => lines.push(String(line)) }
  assert.equal(await runCli(['acceptance', '--run', 'never-made', '--plan', 'plan.md', '--root', root], io), 2)
  assert.match(lines.join('\n'), /^acceptance: there is no run never-made: evidence belongs to a run created by init-run$/)
  // A run id is a path under `.fleetmates/`. One that climbs out of it is refused even when a
  // `plan.json` sits where it points.
  await mkdir(path.join(root, '.fleetmates', '..', 'escape'), { recursive: true })
  await writeFile(path.join(root, 'escape', 'plan.json'), '{}')
  assert.equal(await runCli(['acceptance', '--run', '../escape', '--plan', 'plan.md', '--entry', 'A1', '--pass', '--note', 'x', '--root', root], io), 2)
  // The CLI refuses such an id before the command runs; the command refuses it on its own too.
  const { runAcceptanceCommand } = await import('../scripts/acceptance.mjs')
  assert.equal(await runAcceptanceCommand({ root, flags: { run: '../escape', plan: 'plan.md', entry: 'A1', pass: true, note: 'x' }, io }), 2)
  assert.match(lines.at(-1), /^acceptance: write `--run <id>`$/)
  assert.equal(existsSync(path.join(root, 'escape', 'acceptance.json')), false)
  assert.equal(await runCli(['acceptance', '--run', 'r1', '--plan', 'missing.md', '--root', root], io), 2)
  assert.match(lines.at(-1), /^acceptance: cannot read the plan: /)
  assert.equal(existsSync(evidencePath(root, 'r1')), false)
})

test('a damaged evidence file is named and refused, and is left as it was', async (t) => {
  const root = await project(t)
  const file = evidencePath(root, 'r1')
  for (const [content, pattern] of [
    ['{ not json', /is not valid JSON/],
    [JSON.stringify({ version: 2, entries: {} }), /is not version 1 acceptance evidence/],
    [JSON.stringify({ version: 1, entries: { A1: { status: 'maybe' } } }), /is not version 1 acceptance evidence/],
    [JSON.stringify({ version: 1, entries: [] }), /is not version 1 acceptance evidence/],
  ]) {
    await writeFile(file, content)
    const listed = await cli(root)
    assert.equal(listed.code, 2, content)
    assert.match(listed.text, pattern)
    assert.ok(listed.text.includes('acceptance.json'), 'the file is named')
    const recorded = await cli(root, '--entry', 'A1', '--pass', '--note', 'x')
    assert.equal(recorded.code, 2)
    assert.equal(await readFile(file, 'utf8'), content, 'nothing repairs or replaces the file')
  }
})

test('a note and an entry with control characters cannot repaint the terminal', async (t) => {
  const esc = String.fromCharCode(27)
  const root = await project(t, [`an entry${esc}[2K with an escape`, 'plain'])
  const forged = `ok${esc}[2K\r  A2  pass  plain\nacceptance for run r1: 2 of 2 entries have pass evidence`
  assert.equal((await cli(root, '--entry', 'A1', '--pass', '--note', forged)).code, 0)
  const listed = await cli(root)
  assert.equal(listed.code, 1)
  for (const line of listed.lines) {
    assert.ok(!line.includes(esc) && !line.includes('\r') && !line.includes('\n'), JSON.stringify(line))
  }
  assert.equal(listed.lines.filter((line) => line.startsWith('acceptance for run')).length, 1, 'the note cannot add a header line of its own')
  assert.equal(listed.lines.filter((line) => /^ {2}A2 /.test(line)).length, 1)
})

// The run here FINISHES: its one task is integrated on the run branch, so `finish` exits 0. Only
// from that state can a test see evidence turning a pass into a refusal.
test('finish prints the list after its summary, and a finished run stays finished whatever the evidence says', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-acceptance-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  git(root, 'init', '-q', '-b', 'main')
  await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
  await writeFile(path.join(root, 'plan.md'), PLAN(['the first thing holds', 'the second thing holds']))
  await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ phases: { default: { checks: [] } } }))
  commit(root, 'plan')
  git(root, 'checkout', '-q', '-b', 'work')
  assert.equal(await runCli(['init-run', 'plan.md', '--run', 'r1', '--root', root], { out() {}, err() {} }), 0)
  git(root, 'checkout', '-q', '-b', 'fleetmates/r1/T1')
  await writeFile(path.join(root, 'a.txt'), 'done\n')
  commit(root, 'T1')
  git(root, 'checkout', '-q', 'work')
  git(root, '-c', 'user.name=tester', '-c', 'user.email=tester@example.invalid', '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', 'fleetmates/r1/T1', '-m', 'merge T1')

  const finish = async () => {
    const lines = []
    const io = { out: (line) => lines.push(String(line)), err() {} }
    const code = await runCli(['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--enforcement-only', '--root', root], io)
    return { code, text: lines.join('\n') }
  }
  const verdictOf = (text) => text.split('\n').filter((line) => /^ {2}phase |^not finished|^every phase passes/.test(line)).join('\n')

  const bare = await finish()
  assert.equal(bare.code, 0, bare.text)
  assert.match(verdictOf(bare.text), /^ {2}phase 1 +PASS\nevery phase passes/)
  assert.match(bare.text, /^acceptance for run r1: 0 of 2 entries have pass evidence$/m)
  assert.ok(bare.text.indexOf('acceptance for run r1') > bare.text.indexOf('every phase passes'), 'the list comes after the summary')

  await cli(root, '--entry', 'A1', '--pass', '--note', 'ok')
  await cli(root, '--entry', 'A2', '--pass', '--note', 'ok')
  const passed = await finish()
  assert.match(passed.text, /^acceptance for run r1: 2 of 2 entries have pass evidence$/m)

  await cli(root, '--entry', 'A2', '--fail', '--note', 'it broke')
  const failed = await finish()
  assert.match(failed.text, /^ {2}A2 {2}fail {2}the second thing holds$/m)

  assert.deepEqual([bare.code, passed.code, failed.code], [0, 0, 0], 'neither missing evidence nor a recorded fail blocks finish')
  assert.equal(verdictOf(passed.text), verdictOf(bare.text))
  assert.equal(verdictOf(failed.text), verdictOf(bare.text))
})

test('for finish, a plan without entries gives no line and an unreadable file gives one line, never a throw', async (t) => {
  const none = await project(t, [])
  assert.deepEqual(await acceptanceLinesForFinish({ root: none, runId: 'r1', planPath: 'plan.md' }), [])

  const root = await project(t)
  await writeFile(evidencePath(root, 'r1'), '{ not json')
  const damaged = await acceptanceLinesForFinish({ root, runId: 'r1', planPath: 'plan.md' })
  assert.equal(damaged.length, 1)
  assert.match(damaged[0], /^acceptance: the evidence file .*acceptance\.json is not valid JSON/)
  const missing = await acceptanceLinesForFinish({ root, runId: 'r1', planPath: 'gone.md' })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /^acceptance: cannot read the plan: /)
})
