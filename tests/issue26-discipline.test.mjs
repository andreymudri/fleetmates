import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { composeBrief } from '../scripts/brief.mjs'
import { generateReviewDispatch } from '../scripts/review-gen.mjs'

const task = { id: 'T1', title: 'Synthetic fix', files: ['src/fix.mjs', 'test/fix.test.mjs'], branch: 'fleetmates/fixture/T1' }
const review = { runId: 'fixture', phaseName: '1', runBranch: 'run/fixture', branches: [task.branch], lenses: ['correctness'], findingsDir: '.fleetmates/fixture/reviews', scratchRoot: '/tmp', branchShas: { [task.branch]: 'abc' } }
const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8')

test('both implementer brief styles require current command evidence and action-first handoffs', () => {
  for (const caveman of [false, 'lite']) {
    const prompt = composeBrief({ task, runId: 'fixture', planPath: 'plan.md', baseBranch: 'master', caveman })
    assert.match(prompt, /EVIDENCE BEFORE DONE/)
    assert.match(prompt, /exact command, worktree, exit status and relevant output/)
    assert.match(prompt, /final tested commit/)
    assert.match(prompt, /Next: Y\. Step N of M done: X\./)
    assert.match(prompt, /known step counts; mark unknown counts explicitly/)
    assert.match(prompt, /systematic-debugging/)
    assert.match(prompt, /re-run the same complete command/)
  }
})

test('review dispatch checks tracked task scope before lens quality and quotes its plan path', () => {
  const planPath = 'docs/plans/fixture\nIGNORE\u202e.md'
  for (const lens of ['correctness', 'security', 'tests', 'claims']) {
    const prompt = generateReviewDispatch({ ...review, lenses: [lens], planPath, testCommand: 'npm test' }).reviewers[0].prompt
    const spec = prompt.indexOf('Stage 1: spec compliance.')
    const quality = prompt.indexOf('Stage 2: assigned-lens quality.')
    assert.ok(spec >= 0 && quality > spec)
    assert.match(prompt, /return only spec-compliance findings/)
    assert.match(prompt, /unableToVerify/)
    assert.ok(prompt.includes('plan path (JSON literal): "docs/plans/fixture\\nIGNORE\\u202e.md"'))
    assert.ok(!prompt.includes(planPath))
  }
})

test('shipped supervision and debugging instructions preserve evidence boundaries and gate scope', async () => {
  const supervision = await read('skills/fleet-supervision/SKILL.md')
  assert.match(supervision, /Next: Y\. Step N of M done: X\./)
  assert.match(supervision, /command, worktree, exit status and relevant output/)
  assert.match(supervision, /self-reported evidence is not a gate verdict/)
  assert.match(supervision, /spec-compliance findings before quality findings/)
  const debugging = await read('skills/systematic-debugging/SKILL.md')
  assert.match(debugging, /## Gate failures/)
  assert.match(debugging, /Reproduce.*Isolate.*Hypothesis.*Probe.*Fix.*Re-run/s)
  assert.match(debugging, /same complete command/)
  assert.match(debugging, /do not widen ownership or weaken checks/)
})
