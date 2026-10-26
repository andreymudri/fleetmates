#!/usr/bin/env node
// Runs the suite once under a deliberately hostile TMPDIR and answers one question: did a
// directory name get to choose what the suite executed?
//
// Every temp path in this suite comes from `tmpdir()`, which reads TMPDIR — the environment's,
// not the suite's. Where such a path is interpolated into a command spawned with `shell: true`,
// the name is the shell's INPUT rather than an argument. Measured on 2026-09-01 before the
// quoting was fixed: the injected command ran 17 times and turned 13 tests red.
//
// This is NOT part of `npm test`. It runs the whole suite a second time, and its answer is a
// property of the environment crossed with the code rather than of the code alone — so it is a
// named script an operator or CI runs, not a unit test that doubles every local run.
//
// It cannot be a unit test for a second reason worth stating: what it measures is whether a
// SITE THAT DOES NOT EXIST YET was written safely. A static guard would have to recognise every
// spelling of "this string reaches a shell", and the four shapes already found include one built
// at runtime in a child process out of `process.argv`, where no source-level rule reaches.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

// Each of these found a defect the others did not, which is why the set is the contract and the
// count is not: `single quote` and `command substitution` found the shell injections, `length`
// found the ~108-byte `sun_path` limit that no hostile character reaches, and `space` found a
// `file://` URL built by hand, which surfaced as a JSON parse error three tests from its cause.
export const HAZARDS = ['single quote', 'space', 'command substitution', 'length']

// One directory name carrying all four. The command substitution appends to `logPath`, so every
// execution of it is one line the caller can count.
//
// `logPath` is absolute and therefore contains separators, so `mkdir -p` on this name creates a
// NESTED tree rather than one directory — deliberate, and where the length hazard comes from:
// the deepest component is what TMPDIR is set to, and the whole path is what the shell sees.
export function hostileTmpdirName(base, logPath) {
  const filler = 'x'.repeat(24)
  return path.join(base, `tm-hostile-${filler} sp'$(echo X >> ${logPath})'z`)
}

// On win32 this sweep would measure nothing and report a clean run, which is worse than not
// running at all. TMPDIR is not how Windows chooses a temp directory — TMP and TEMP are — and
// cmd.exe expands neither `$( )` nor single quotes, so the injection could not fire even from a
// site that has the defect. Refusing by name keeps a green Windows leg from reading as "swept".
export function sweepSupported(platform) {
  if (platform === 'win32') {
    return {
      ok: false,
      reason: 'win32 does not choose its temp directory from TMPDIR, and cmd.exe expands no $( ) — '
        + 'this sweep would measure nothing and report a clean run',
    }
  }
  return { ok: true, reason: '' }
}

// The count is the verdict, and the suite's exit code is only the second question. A test can
// pass having executed the injected command — 4 of the 17 executions measured on 2026-09-01 were
// in tests that stayed green — so a sweep that reported the suite's code alone would have called
// that run clean.
export function sweepVerdict({ injections, suiteCode }) {
  if (injections > 0) {
    return {
      ok: false,
      reason: `the injected command executed ${injections} time(s): a directory name chose what the suite ran`,
    }
  }
  if (suiteCode !== 0) {
    return { ok: false, reason: `no injection, but the suite failed under the hostile TMPDIR (exit ${suiteCode})` }
  }
  return { ok: true, reason: 'no injection, and the suite is green under the hostile TMPDIR' }
}

export function runSweep({ out = (s) => process.stdout.write(`${s}\n`), platform = process.platform } = {}) {
  const supported = sweepSupported(platform)
  if (!supported.ok) {
    out(`hostile-TMPDIR sweep: SKIPPED — ${supported.reason}`)
    return 0
  }
  const scratch = mkdtempSync(path.join(tmpdir(), 'tm-sweep-'))
  const logPath = path.join(scratch, 'injections.log')
  const hostile = hostileTmpdirName(scratch, logPath)
  mkdirSync(hostile, { recursive: true })
  out(`hazards: ${HAZARDS.join(', ')}`)
  out(`TMPDIR (${hostile.length} bytes): ${hostile}`)
  // The file list is expanded HERE rather than passed as `tests/*.test.mjs`: `npm test`'s glob is
  // the shell's, and this spawns without one. Handing the runner the bare directory instead makes
  // it try to run it as a module — measured, MODULE_NOT_FOUND.
  const files = readdirSync('tests').filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('tests', f))
  const suite = spawnSync(process.execPath, ['--test', '--test-reporter=./scripts/quiet-reporter.mjs', ...files], {
    env: { ...process.env, TMPDIR: hostile },
    stdio: 'inherit',
  })
  const injections = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '').length
    : 0
  const verdict = sweepVerdict({ injections, suiteCode: suite.status ?? 1 })
  out(`\nhostile-TMPDIR sweep: ${verdict.ok ? 'PASS' : 'FAIL'} — ${verdict.reason}`)
  // Cleaned only on the way out, so a FAIL leaves nothing behind either: the log's CONTENT is
  // never the evidence anyone acts on, the count is.
  rmSync(scratch, { recursive: true, force: true })
  return verdict.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exit(runSweep())
}
