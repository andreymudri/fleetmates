// A fake test runner for tests/flaky.test.mjs. It keeps a run counter in the file named by
// FLAKY_COUNTER, exits 1 while the count (after this run) is at most FLAKY_FAILS and 0 after, and,
// when FLAKY_REPORT names a path, writes a JUnit report there with one testcase `t1` that carries
// a <failure> on failing runs.
import { readFileSync, writeFileSync } from 'node:fs'

const counter = process.env.FLAKY_COUNTER
if (!counter) {
  process.stderr.write('fails-n-times: FLAKY_COUNTER is not set\n')
  process.exit(64)
}
let count = 0
try { count = Number.parseInt(readFileSync(counter, 'utf8'), 10) || 0 } catch {}
count += 1
writeFileSync(counter, String(count))
const failing = count <= Number.parseInt(process.env.FLAKY_FAILS ?? '0', 10)

if (process.env.FLAKY_REPORT) {
  const testcase = failing
    ? '<testcase name="t1" classname="fixture"><failure message="boom">run failed</failure></testcase>'
    : '<testcase name="t1" classname="fixture"/>'
  writeFileSync(process.env.FLAKY_REPORT, `<?xml version="1.0"?>\n<testsuites><testsuite name="fixture">${testcase}</testsuite></testsuites>\n`)
}
process.exit(failing ? 1 : 0)
