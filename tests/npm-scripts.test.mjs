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

// `tests/e2e-codex.test.mjs` matches the `test` script's own `tests/*.test.mjs` glob, so it needs
// its OWN opt-in to stay out of the deterministic default suite the phase gate scores: every test
// in it skips unless `FLEETMATES_E2E === '1'` (in addition to `codexReady()`) — see that file's
// own comment for the measured reason (a Codex-present host running the gate's merged-preview
// `npm test` let real, non-deterministic model spawns into the gate's own verdict). This asserts
// `test:e2e:codex` both sets that flag and keeps naming the real file, so a rename of the suite or
// a dropped env var silently breaks the explicit entry point while the glob-matched default entry
// point stays green and hides it.
test('test:e2e:codex opts into the e2e Codex suite and runs it by its own file', async () => {
  const s = await scripts()
  assert.match(s['test:e2e:codex'], /\bFLEETMATES_E2E=1\b/, 'test:e2e:codex must set FLEETMATES_E2E=1')
  assert.match(s['test:e2e:codex'], /\bnode --test tests\/e2e-codex\.test\.mjs\b/)
  assert.ok(existsSync(new URL('tests/e2e-codex.test.mjs', root)), 'the file test:e2e:codex names must exist')
})

// The opt-in has to be opt-IN: if the default `test` script ever set FLEETMATES_E2E itself, the
// real-Codex suite would run inside the deterministic default suite again on any Codex-present
// host, exactly the flakiness this env var exists to keep out of the gate.
test('the default test script does not set FLEETMATES_E2E', async () => {
  const s = await scripts()
  assert.doesNotMatch(s.test, /FLEETMATES_E2E/)
  assert.doesNotMatch(s['test:verbose'], /FLEETMATES_E2E/)
})

// The escape hatch has to stay an escape hatch: if test:verbose ever names a reporter of its
// own, there is no documented way back to full per-test output when a failure is confusing.
test('test:verbose names no reporter, so it keeps the full spec output', async () => {
  const s = await scripts()
  assert.ok(s['test:verbose'], 'test:verbose must exist')
  assert.doesNotMatch(s['test:verbose'], /--test-reporter/)
})
