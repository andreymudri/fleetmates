import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSkill } from './md-contract.mjs'

// Every file of the skill, SKILL.md first and then reference/*.md in name order.
const read = async (name) => (await readSkill(name)).raw

test('parallel-execution absorbs subagent-driven development: fresh agent per task, review between tasks', async () => {
  const b = await read('parallel-execution')
  assert.match(b, /fresh/i)
  assert.match(b, /between tasks|per task/i)
})

test('parallel-execution absorbs worktree guidance: creation and cleanup', async () => {
  const b = await read('parallel-execution')
  assert.match(b, /git worktree/i)
})

test('parallel-execution requires a clean green baseline before task work starts in a worktree', async () => {
  const b = await read('parallel-execution')
  assert.match(b, /install.*depend|depend.*install/i)
  assert.match(b, /green baseline|baseline.*green/i)
})

test('fleet-lifecycle absorbs parallel dispatch guidance: independence is required', async () => {
  const b = await read('fleet-lifecycle')
  assert.match(b, /independent/i)
})

test('phase-gate absorbs verification-before-completion: evidence before claims', async () => {
  const b = await read('phase-gate')
  assert.match(b, /evidence/i)
})

test('phase-gate absorbs requesting-code-review: how reviewers are dispatched', async () => {
  const b = await read('phase-gate')
  assert.match(b, /tm-reviewer/)
})
