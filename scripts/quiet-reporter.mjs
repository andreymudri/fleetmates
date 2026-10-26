import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printable, printableBlock } from './reviews.mjs'

// A test reporter that prints failures and one summary line, and nothing else.
//
// WHY THIS EXISTS. Token cost in a fleet run is dominated by cache reads, not by what is sent
// once: measured across three real agents of run `fog`, fresh input was 212 tokens and cache
// reads were 2,190,488. Cache reads scale with turns x context, so every token sitting in an
// agent's context is paid for again on each later turn. The largest single contributor was this
// project's own test command — 161,489 chars, of which 1,843 lines were `✔ <name>` that nothing
// reads. The `claims` reviewer lens runs it about nine times per review, implementers at least
// twice, and the gate once per phase. Measured with this reporter in place: ~99 tokens on a
// green run, down from ~40,372.
//
// The saving comes ENTIRELY from the success path. Failures keep their full detail and the summary
// prints either way — a reporter that made a failing run harder to read would have traded the only
// output anyone reads for the output nobody does. Test-authored text (stdout, stderr, a test's name
// and its error stack) is passed through with its newlines and tabs intact and its other control
// bytes neutralised; see the two sites below for why that costs no detail. This paragraph said
// "stderr is passed through untouched" after the code stopped doing that — the same sentence the
// spec was amended to correct, left stale here.

// Failure detail is never shortened. See above: the success path is where the noise is, so
// there is nothing to gain by abbreviating a stack and a diagnostic to lose by doing it.
function renderFailure(data) {
  const error = data.details?.error
  const body = error?.stack ?? error?.message ?? String(error)
  // Neutralised, because BOTH halves are attacker-authored: a test's name and its thrown error are
  // whatever the test file says. Raw, a stack carrying SGR 8 (conceal) rendered the authoritative
  // summary line invisible, and a U+2028 in a name drew a standalone line that read like a green
  // summary.
  //
  // DIFFERENT HELPERS, deliberately. The name is spliced into a one-line sentence, so it gets
  // `printable`, which neutralises LF too — `printableBlock` preserves LF by design, so a plain
  // newline in a name still opened a line of its own, and an earlier version of this comment
  // claimed that forgery was closed when only its U+2028 spelling was. The stack is a block whose
  // line structure IS its content, so it gets `printableBlock` and loses no legibility.
  // Where, relative to the working directory: a CI log of many failures cannot otherwise be mapped
  // back to files, since names built at run time or reused by subtests match nothing in a search.
  const where = typeof data.file === 'string'
    ? ` (${printable(path.relative(process.cwd(), data.file.startsWith('file:') ? fileURLToPath(data.file) : data.file))}${Number.isInteger(data.line) ? `:${data.line}` : ''})`
    : ''
  return `✖ ${printable(data.name)}${where}\n${printableBlock(body)}\n\n`
}

// Printed on green AND red. It is what satisfies this project's evidence rule — a claim that
// tests pass requires output showing the count and zero failures — so summarising only on
// success would leave a failing run unable to state its own counts. `success` is reported beside
// them so a run can never read as green while its exit code says otherwise.
//
// A missing root summary is reported as a failure rather than as silence: a run that crashed
// before emitting one would otherwise produce clean-looking output with no counts in it, which
// reads exactly like a pass.
function renderSummary(summary) {
  if (!summary) return '\nno test summary was emitted; treat this run as failed\n'
  const c = summary.counts
  const parts = [
    `${c.tests} tests`,
    `${c.passed} pass`,
    `${c.failed} fail`,
    `${c.skipped} skipped`,
  ]
  if (c.cancelled > 0) parts.push(`${c.cancelled} cancelled`)
  if (c.todo > 0) parts.push(`${c.todo} todo`)
  return `\n${parts.join(' | ')}${summary.success ? '' : '  FAILED'}\n`
}

export default async function* quietReporter(source) {
  let rootSummary = null
  for await (const event of source) {
    if (event.type === 'test:fail') {
      yield renderFailure(event.data)
      continue
    }
    // Passed through, but not verbatim. A test writes these streams itself, so leaving them raw
    // let a test print an escape sequence that erases this reporter's summary line and draws one
    // of its own — a failing run reading as green to whoever is looking at the terminal, with no
    // 0x1B needed for the plainest version of the trick. `printableBlock` keeps the content's own
    // newlines and tabs, so a multi-line console.log still reads as it was written, and
    // neutralises every other control byte.
    //
    // This does not cost failure readability, which is the thing this reporter exists to protect:
    // `printableBlock` keeps newlines and tabs. An earlier version of this comment argued the fix
    // was COMPLETE because `renderFailure` reads its text from the `test:fail` event rather than
    // from these streams — which was wrong twice over: that payload is attacker-authored too, so
    // the event being a different source made it no safer. `renderFailure` neutralises separately.
    // What neither can do is stop a test printing a line that merely LOOKS like the summary; the
    // exit code remains the authority, and `scripts/gate-runner.mjs` reads that, never this text.
    if (event.type === 'test:stderr' || event.type === 'test:stdout') {
      yield printableBlock(event.data.message)
      continue
    }
    // THE ROOT SUMMARY IS THE ONE WITH NO `file`. The runner emits one summary per file and one
    // for the whole run, and only the latter aggregates. Counting `test:pass` events instead is
    // the obvious implementation and it is wrong: a parent suite emits its own alongside its
    // children, which measured 5 where the truth was 4. A wrong count is worse than a verbose
    // one, because the evidence rule depends on the number being true.
    if (event.type === 'test:summary' && event.data.file === undefined) {
      rootSummary = event.data
    }
  }
  yield renderSummary(rootSummary)
}
