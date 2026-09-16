import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const scripts = async () => JSON.parse(await readFile(new URL('package.json', root), 'utf8')).scripts

// The reporter passing its own unit tests proves nothing about whether `npm test` actually uses
// it. This pins the wiring: the whole saving depends on the command the gate manifest, the
// skills and every brief already name being the one that runs quietly.
test('npm test drives the quiet reporter, and the reporter exists', async () => {
  const s = await scripts()
  assert.match(s.test, /--test-reporter[= ]\.\/scripts\/quiet-reporter\.mjs/)
  assert.ok(existsSync(new URL('scripts/quiet-reporter.mjs', root)), 'the reporter the test script names must exist')
})

// Windows CI runs npm scripts under cmd.exe, where a pipeline behaves differently or not at all.
// This repository's CI has already been broken once by a platform assumption, so the constraint
// is asserted rather than remembered.
test('no npm script relies on a shell pipeline', async () => {
  const s = await scripts()
  for (const name of ['test', 'test:verbose', 'test:e2e:codex']) {
    assert.doesNotMatch(s[name], /[|>]|&&|\bgrep\b/, `${name} must not depend on shell features cmd.exe lacks`)
  }
})

// `tests/e2e-codex.test.mjs` matches the `test` script's own `tests/*.test.mjs` glob (every test
// in it skips itself when Codex is unavailable, so `npm test` stays green offline — see that
// file). `test:e2e:codex` is the explicit, single-file way to run just that suite, and it has to
// keep naming the real file or a rename of the suite silently breaks the explicit entry point
// while the glob-matched default entry point stays green and hides it.
test('test:e2e:codex runs the e2e Codex suite by its own file', async () => {
  const s = await scripts()
  assert.match(s['test:e2e:codex'], /\bnode --test tests\/e2e-codex\.test\.mjs\b/)
  assert.ok(existsSync(new URL('tests/e2e-codex.test.mjs', root)), 'the file test:e2e:codex names must exist')
})

// The escape hatch has to stay an escape hatch: if test:verbose ever names a reporter of its
// own, there is no documented way back to full per-test output when a failure is confusing.
test('test:verbose names no reporter, so it keeps the full spec output', async () => {
  const s = await scripts()
  assert.ok(s['test:verbose'], 'test:verbose must exist')
  assert.doesNotMatch(s['test:verbose'], /--test-reporter/)
})
