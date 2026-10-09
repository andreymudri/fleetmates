import { test, it } from 'node:test'

// Test-only platform switches. This file must not import anything from hub/platform/: the helpers
// must not depend on the code under test.

const DEFAULT_REASON = 'file modes, symlinks or Unix sockets'

/**
 * True on Windows, or when FLEETMATES_TEST_FORCE_WINDOWS=1 (test-only, so Linux can see the skip path).
 * Read at call time.
 * @returns {boolean}
 */
function windowsNow () {
  return process.platform === 'win32' || process.env.FLEETMATES_TEST_FORCE_WINDOWS === '1'
}

/** True on Windows, or under FLEETMATES_TEST_FORCE_WINDOWS=1; read once when this module loads. */
export const isWindows = windowsNow()

/**
 * Wrap a node:test `test` or `it`: off Windows it is `run` unchanged; on Windows the test is skipped
 * with the message `POSIX only: <reason>`, `<reason>` being `opts.reason` or the default.
 * @param {typeof test} run
 * @returns {(name: string, optsOrFn?: any, fn?: any) => any}
 */
function posixOnly (run) {
  return (name, optsOrFn, fn) => {
    const hasOpts = typeof optsOrFn === 'object' && optsOrFn !== null
    const { reason, ...opts } = hasOpts ? optsOrFn : {}
    const body = hasOpts ? fn : optsOrFn
    if (!windowsNow()) return hasOpts ? run(name, opts, body) : run(name, body)
    return run(name, { ...opts, skip: `POSIX only: ${reason ?? DEFAULT_REASON}` }, body)
  }
}

/** `test` from node:test off Windows; a skip with `POSIX only: <reason>` on Windows. */
export const posixTest = posixOnly(test)

/** `it` from node:test off Windows; a skip with `POSIX only: <reason>` on Windows. */
export const posixIt = posixOnly(it)
