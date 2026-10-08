// Test helper for the strict-execution suites. `strictTest` is `test` from node:test where strict
// execution is supported, and otherwise a skipped test with the refusal reason as the skip message.
// FLEETMATES_TEST_STRICT_UNSUPPORTED=1 is test-only: it takes the skip path on a POSIX host.
import { test } from 'node:test'
import { strictExecutionSupport, STRICT_EXECUTION_UNSUPPORTED } from '../scripts/execution-platform.mjs'

const support = process.env.FLEETMATES_TEST_STRICT_UNSUPPORTED === '1'
  ? { supported: false, reason: STRICT_EXECUTION_UNSUPPORTED }
  : strictExecutionSupport()

function skipped(name, options, fn) {
  if (typeof options === 'function') { fn = options; options = {} }
  // test.skip drops a skip message, so the skip goes through the `skip` option instead.
  return test(name, { ...(options ?? {}), skip: support.reason }, fn)
}

export const strictTest = support.supported ? test : skipped
