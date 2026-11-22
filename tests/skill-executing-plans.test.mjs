import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const body = async () => readFile(new URL('../skills/executing-plans/SKILL.md', import.meta.url), 'utf8')

test('initialises shared run state so the run is resumable', async () => {
  assert.match(await body(), /init-run/)
  assert.match(await body(), /\.fleetmates/)
})

test('states that a gate manifest is optional for inline work', async () => {
  assert.match(await body(), /optional/i)
})

test('does not require a phase structure or reviewer dispatch for small work', async () => {
  const b = await body()
  assert.match(b, /checkpoint/i)
})

test('says an inline run can be handed to a fleet without translation', async () => {
  assert.match(await body(), /parallel-execution/)
})

test('carries upstream attribution', async () => {
  assert.match(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})

// docs/specs/2026-11-21-acceptance-evidence-design.md: the last step records the evidence, lists
// it, and reports what is left, and says what the evidence is not.
test('the finish step records evidence per Acceptance entry, lists it and names what is left', async () => {
  const b = (await body()).replace(/\s+/g, ' ')
  const finish = b.slice(b.indexOf('## 4. Finish'), b.indexOf('## When to stop'))
  assert.match(finish, /acceptance --run <runId> --plan <planPath> --entry <An> --pass --note "<what proved it>" --root <project root>/)
  assert.match(finish, /acceptance --run <runId> --plan <planPath> --root <project root>/)
  assert.ok(finish.includes('Record `--fail` for an entry the work does not meet.'))
  assert.ok(finish.includes('Name in your final message every entry the list shows without `pass` evidence.'))
  assert.ok(finish.includes('The evidence is your own record, not a proof: no gate reads it, and the command runs no test.'))
})
