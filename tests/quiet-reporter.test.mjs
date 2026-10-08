import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import quietReporter from '../scripts/quiet-reporter.mjs'

// A file:// URL, not a filesystem path. `--test-reporter` is resolved by the ESM loader, and on
// Windows an absolute path begins `D:\...`, whose drive letter the loader reads as a URL scheme:
// it fails with ERR_UNSUPPORTED_ESM_URL_SCHEME, "Received protocol 'd:'". A file:// URL is
// accepted on every platform, so it is what this passes. (`.pathname` is wrong for the opposite
// reason — it keeps the URL's leading slash, `/C:/...`, which is not a valid path.) Note this
// applies to the ABSOLUTE specifier only: package.json passes a relative one,
// `./scripts/quiet-reporter.mjs`, which has no scheme to misread and works as-is.
const reporterUrl = new URL('../scripts/quiet-reporter.mjs', import.meta.url).href

async function collect(events) {
  async function* source() { for (const e of events) yield e }
  let out = ''
  for await (const chunk of quietReporter(source())) out += chunk
  return out
}

const counts = (over = {}) => ({
  tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, ...over,
})
const rootSummary = (over = {}, success = true) => ({
  type: 'test:summary', data: { success, counts: counts(over) },
})

test('a green run prints only the summary line', async () => {
  const out = await collect([
    { type: 'test:pass', data: { name: 'one' } },
    { type: 'test:pass', data: { name: 'two' } },
    { type: 'test:pass', data: { name: 'three' } },
    rootSummary({ tests: 3, passed: 3 }),
  ])
  assert.equal(out, '\n3 tests | 3 pass | 0 fail | 0 skipped\n')
  assert.doesNotMatch(out, /✔|one|two|three/)
})

// THE CASE THE NAIVE IMPLEMENTATION GETS WRONG. A parent suite emits its own `test:pass`
// alongside its children, so tallying them inflates the count — measured at 5 where the truth
// was 4. The per-file summary is the other wrong source: the runner emits one per file AND one
// for the whole run, and only the latter aggregates. A wrong count is worse than a verbose one,
// because this project's evidence rule depends on the number being true.
test('counts come from the root summary, not from tallying pass events', async () => {
  const out = await collect([
    { type: 'test:pass', data: { name: 'leaf one' } },
    { type: 'test:pass', data: { name: 'leaf two' } },
    { type: 'test:pass', data: { name: 'a suite' } },
    { type: 'test:pass', data: { name: 'subtest' } },
    { type: 'test:pass', data: { name: 'top level' } },
    { type: 'test:summary', data: { success: true, file: '/x.test.mjs', counts: counts({ tests: 99, passed: 99 }) } },
    rootSummary({ tests: 4, passed: 4 }),
  ])
  assert.match(out, /4 tests \| 4 pass/)
  assert.doesNotMatch(out, /5 tests/, 'tallied test:pass events instead of reading the root summary')
  assert.doesNotMatch(out, /99 tests/, 'read the per-file summary instead of the root one')
})

test('a failing run prints the failure and still prints the summary', async () => {
  const error = Object.assign(new Error('boom'), { stack: 'Error: boom\n    at x.mjs:1:1' })
  const out = await collect([
    { type: 'test:fail', data: { name: 'breaks', details: { error } } },
    rootSummary({ tests: 1, failed: 1 }, false),
  ])
  assert.match(out, /✖ breaks/)
  assert.match(out, /at x\.mjs:1:1/, 'the stack must not be abbreviated')
  assert.match(out, /1 fail/)
  assert.match(out, /FAILED/)
})

test('stderr and stdout pass through with their layout intact', async () => {
  const out = await collect([
    { type: 'test:stderr', data: { message: 'a real warning\n' } },
    { type: 'test:stdout', data: { message: 'printed by a test\n' } },
    rootSummary({ tests: 1, passed: 1 }),
  ])
  assert.match(out, /a real warning\n/)
  assert.match(out, /printed by a test\n/)
})

// A crashed run that never emits a root summary must not read as clean output.
test('a run that emits no root summary is reported as failed', async () => {
  const out = await collect([
    { type: 'test:summary', data: { success: true, file: '/x.test.mjs', counts: counts({ tests: 1, passed: 1 }) } },
  ])
  assert.match(out, /treat this run as failed/)
})

test('skipped tests are counted and not named', async () => {
  const out = await collect([
    { type: 'test:pass', data: { name: 'skipped one', skip: true } },
    { type: 'test:pass', data: { name: 'skipped two', skip: true } },
    rootSummary({ tests: 5, passed: 3, skipped: 2 }),
  ])
  assert.match(out, /2 skipped/)
  assert.doesNotMatch(out, /skipped one|skipped two/)
})

// The tests above drive the generator directly and so never observe an exit code, which the
// contract names for both outcomes. This drives a real runner over real fixtures.
test('the reporter drives a real run and preserves exit codes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-quiet-'))
  try {
    const green = path.join(dir, 'green.test.mjs')
    const red = path.join(dir, 'red.test.mjs')
    await writeFile(green, "import { test } from 'node:test'\ntest('ok', () => {})\n", 'utf8')
    await writeFile(red, "import { test } from 'node:test'\ntest('bad', () => { throw new Error('nope') })\n", 'utf8')

    // NODE_TEST_CONTEXT must be scrubbed from the child's environment. The runner sets it to
    // `child-v8` in every test process, and a nested `node --test` that sees it switches to the
    // internal serialised protocol and ignores `--test-reporter` entirely — the child then exits
    // 0 with EMPTY stdout, which reads as "the reporter printed nothing" rather than as "the
    // reporter was never asked". Found the hard way: this test failed with actual '' while the
    // identical command worked from a shell.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT

    const run = (file) => {
      try {
        const stdout = execFileSync('node', ['--test', '--test-reporter', reporterUrl, file], { encoding: 'utf8', env })
        return { status: 0, stdout }
      } catch (err) {
        return { status: err.status, stdout: err.stdout ?? '' }
      }
    }

    const ok = run(green)
    assert.equal(ok.status, 0)
    assert.match(ok.stdout, /1 tests \| 1 pass \| 0 fail/)

    const bad = run(red)
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /✖/)
    assert.match(bad.stdout, /1 fail/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


// The summary's cancelled and todo branches are conditional, so deleting either left the suite
// green. Both are reachable in a real run — `--test-timeout` cancels, `{ todo: true }` marks todo
// — and both belong in the one line this project's evidence rule reads.
test('the summary names cancelled and todo counts when there are any', async () => {
  const out = await collect([rootSummary({ tests: 4, passed: 1, cancelled: 2, todo: 1 })])
  assert.match(out, /2 cancelled/)
  assert.match(out, /1 todo/)
})

test('the summary omits cancelled and todo when there are none', async () => {
  const out = await collect([rootSummary({ tests: 1, passed: 1 })])
  assert.doesNotMatch(out, /cancelled|todo/, 'a zero count must not clutter the line it is read from')
})

// A failing run must say so in the text as well as the exit code, or a reader quoting the summary
// alone cannot tell the two apart.
test('a failing summary is marked FAILED', async () => {
  const out = await collect([rootSummary({ tests: 2, passed: 1, failed: 1 }, false)])
  assert.match(out, /FAILED/)
})

// The spec's Testing table names this case ("load failure — non-zero exit and a visible reason")
// and no test existed for it: a file that throws at import time never emits a root summary, so a
// naive reporter prints nothing and the run reads as clean. Driven through a real runner, because
// the exit code is half the contract.
test('a file that throws at import fails loudly rather than printing nothing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-quiet-load-'))
  try {
    const bad = path.join(dir, 'load.test.mjs')
    await writeFile(bad, "throw new Error('boom at import time')\n", 'utf8')
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    let status = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', ['--test', '--test-reporter', reporterUrl, bad], { encoding: 'utf8', env })
    } catch (err) {
      status = err.status
      stdout = err.stdout ?? ''
    }
    assert.notEqual(status, 0, 'a file that cannot be loaded must not exit 0')
    // NOT an alternation including the thrown text: node prints its own crash dump for an import
    // failure, which satisfied `/boom at import time/` no matter what this reporter did — so the
    // test survived the very renderSummary silencing its comment describes. The reporter's own
    // line is what is asserted.
    assert.match(stdout, /\d+ tests \| .* fail|no test summary was emitted/,
      "the reporter's own summary line must be present, not just node's crash dump")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


// A run that crashed before emitting a root summary must not produce clean-looking output with no
// counts in it, which reads exactly like a pass. The reporter's header states this; nothing
// pinned it, and returning '' instead left the whole suite green.
test('a run with no root summary is reported as failed, never as silence', async () => {
  const out = await collect([])
  assert.notEqual(out.trim(), '', 'silence reads as a pass')
  assert.match(out, /no test summary|failed/i, 'the reader must be told the run cannot be trusted')
})

// The per-file summary must not be mistaken for the root one — only the root aggregates, and a
// file summary arriving with no root summary after it is still a run with no counts.
test('a per-file summary alone does not stand in for the root summary', async () => {
  const out = await collect([
    { type: 'test:summary', data: { success: true, file: '/x.test.mjs', counts: counts({ tests: 3, passed: 3 }) } },
  ])
  assert.match(out, /no test summary|failed/i, 'a file summary was mistaken for the root summary')
})


// A test's own stdout is passed through, and it was passed through VERBATIM — so a test could
// print an escape sequence that erases the reporter's summary line and draws one of its own,
// making a failing run read as green to whoever is looking at the terminal. `printableBlock` is
// the right instrument and was already in this repo: it keeps the content's own newlines and tabs
// (so a multi-line console.log still reads as it was written) and neutralises everything else.
//
// This does NOT touch failure detail: `renderFailure` reads the stack from the `test:fail` event,
// never from these two streams, so a stack trace is unaffected by this rule.
test('test output cannot smuggle an escape sequence into the report', async () => {
  const ESC = String.fromCharCode(27)
  const out = await collect([
    { type: 'test:stdout', data: { message: `${ESC}[2K${ESC}[G99 tests | 99 pass | 0 fail` } },
    { type: 'test:stderr', data: { message: `${ESC}[31mred${ESC}[0m` } },
    rootSummary({ tests: 1, passed: 0, failed: 1 }, false),
  ])
  assert.doesNotMatch(out, new RegExp(ESC), 'an escape byte from a test reached the terminal')
  assert.match(out, /1 fail/, 'the real counts must still be printed')
  assert.match(out, /FAILED/, 'and the run must still read as failed')
})

// Layout is content, not decoration: a test that prints three lines must still show three lines,
// or this rule would make debugging a test harder than not having it.
test('passed-through output keeps its own newlines and tabs', async () => {
  const out = await collect([
    { type: 'test:stdout', data: { message: 'one\ntwo\tindented\n' } },
    rootSummary({ tests: 1, passed: 1 }),
  ])
  assert.match(out, /one\ntwo\tindented/, 'newlines and tabs are the content\'s own structure')
})

// Stated plainly because it is the limit of this fix: neutralising control bytes cannot stop a
// test from printing a line that merely LOOKS like the summary. The exit code stays the authority.
test('a plain-text lookalike line is still possible, and the exit code is what decides', async () => {
  const out = await collect([
    { type: 'test:stdout', data: { message: '99 tests | 99 pass | 0 fail | 0 skipped' } },
    rootSummary({ tests: 1, passed: 0, failed: 1 }, false),
  ])
  assert.match(out, /99 tests/, 'the lookalike is not removed — that is not what this rule does')
  assert.match(out, /FAILED/, 'the reporter\'s own line still marks the run failed')
})


// The failure path carries ATTACKER-AUTHORED text too: a test's NAME and its error stack are
// whatever the test file says they are. Neutralising only the stdout/stderr passthrough closed one
// half of the hole while a comment asserted the other half did not exist. SGR 8 (conceal) in a
// stack renders the authoritative summary line invisible; U+2028 in a name draws a standalone
// line that reads like a green summary.
test('a crafted test name or stack cannot forge or conceal the summary', async () => {
  const ESC = String.fromCharCode(27)
  const out = await collect([
    {
      type: 'test:fail',
      data: {
        name: `t${ESC}[2K\u202820 tests | 20 pass | 0 fail`,
        details: { error: { stack: `Error: ${ESC}[8m hidden \u009b2K` } },
      },
    },
    rootSummary({ tests: 1, passed: 0, failed: 1 }, false),
  ])
  assert.doesNotMatch(out, new RegExp(`[${ESC}\u009b\u2028\u2029]`), 'a raw control byte reached the terminal')
  assert.match(out, /1 fail/, 'the real counts must still print')
  assert.match(out, /FAILED/, 'and the run must still read as failed')
})

// A test NAME is spliced into a one-line sentence, so it needs `printable`, not `printableBlock`
// — which preserves LF by design. A plain newline in a name therefore still opened a line of its
// own, which is the forgery the fix's own comment claimed it had closed.
test('a newline in a test name cannot open a line of its own', async () => {
  const out = await collect([
    {
      type: 'test:fail',
      data: { name: 'oops\n20 tests | 20 pass | 0 fail | 0 skipped', details: { error: { stack: 'Error: x' } } },
    },
    rootSummary({ tests: 1, passed: 0, failed: 1 }, false),
  ])
  const forged = out.split('\n').filter((l) => /^20 tests \| 20 pass/.test(l))
  assert.equal(forged.length, 0, 'a newline in the name drew a standalone summary line')
})

// A failure names its file and line. Without them a CI log of a few hundred failures cannot be
// mapped back to test files: names built at run time, or reused by subtests ("branch", "bytes"),
// match nothing a search of the sources can find.
test('a failure names the file and line of the failing test', async () => {
  const file = path.join(process.cwd(), 'tests', 'sample.test.mjs')
  const out = await collect([
    { type: 'test:fail', data: { name: 'breaks', file, line: 12, details: { error: new Error('boom') } } },
    rootSummary({ tests: 1, failed: 1 }, false),
  ])
  assert.match(out, /✖ breaks \(tests[\\/]sample\.test\.mjs:12\)\n/)
})

test('a failure without a file keeps the bare name line', async () => {
  const out = await collect([
    { type: 'test:fail', data: { name: 'breaks', details: { error: new Error('boom') } } },
    rootSummary({ tests: 1, failed: 1 }, false),
  ])
  assert.match(out, /✖ breaks\n/)
})
