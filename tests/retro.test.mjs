import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runCli } from '../scripts/cli.mjs'
import { selectLearnings } from '../scripts/learning-context.mjs'
import { draftRetro } from '../scripts/retro.mjs'

const PLAN = {
  tasks: [
    { id: 'T1', title: 'Add the cart', files: ['src/cart.mjs', 'tests/cart.test.mjs'], phase: 1 },
    { id: 'T2', title: 'Add checkout', files: ['src/checkout.mjs'], phase: 2 },
    { id: 'T3', title: 'Docs', files: ['docs/a,b.md'], phase: 2 },
  ],
}
const STATUS = {
  fixRounds: { 1: { T1: 1 }, 2: { T1: 1, T2: 2 } },
  gates: { 1: { verdict: 'PASS', failed: [] }, 2: { verdict: 'FAIL', failed: ['test', 'fileset'] } },
}

test('draftRetro proposes nothing for a clean run', () => {
  const out = draftRetro({ runId: 'r1', date: '2026-11-11', plan: PLAN, status: { gates: { 1: { verdict: 'PASS' } } } })
  assert.deepEqual(out.findings, [])
  assert.equal(out.markdown, '')
})

// Rounds are summed over phases and the most expensive task comes first. T1 spent one round in
// each of two phases, so a per-phase count (1) or a last-phase count would both be wrong.
test('draftRetro sums fix rounds per task across phases', () => {
  const { findings } = draftRetro({ runId: 'r1', date: '2026-11-11', plan: PLAN, status: STATUS })
  const fixes = findings.filter((f) => f.id.startsWith('retro-fix-'))
  assert.deepEqual(fixes.map((f) => f.id).sort(), ['retro-fix-T1', 'retro-fix-T2'])
  const t1 = fixes.find((f) => f.id === 'retro-fix-T1')
  const t2 = fixes.find((f) => f.id === 'retro-fix-T2')
  assert.match(t1.title, /T1 needed 2 fix rounds: Add the cart/)
  assert.match(t2.title, /T2 needed 2 fix rounds/)
  assert.deepEqual(t1.scope, ['src/cart.mjs', 'tests/cart.test.mjs'])
  assert.match(t1.evidence[0], /1=1, 2=1/)
})

test('draftRetro orders fix-round findings by total rounds', () => {
  const { findings } = draftRetro({ runId: 'r1', date: '2026-11-11', plan: PLAN, status: { fixRounds: { 1: { T1: 1, T2: 3 } } } })
  assert.deepEqual(findings.map((f) => f.id), ['retro-fix-T2', 'retro-fix-T1'])
})

test('draftRetro reports a gate last recorded failing, scoped to that phase\'s files', () => {
  const { findings } = draftRetro({ runId: 'r1', date: '2026-11-11', plan: PLAN, status: STATUS })
  const gate = findings.filter((f) => f.id.startsWith('retro-gate-'))
  assert.deepEqual(gate.map((f) => f.id), ['retro-gate-2'], 'a PASS phase proposes nothing')
  assert.match(gate[0].title, /phase 2 was last recorded FAIL \(test, fileset\)/)
  // `docs/a,b.md` holds the scope separator, so it cannot be a scope glob; it is left out.
  assert.deepEqual(gate[0].scope, ['src/checkout.mjs'])
})

test('draftRetro reports orphaned and failed teammates and the limit waits they sat through', () => {
  const sessions = [
    { taskId: 'T1', state: 'orphaned', exitReason: 'timeout' },
    { taskId: 'T2', state: 'done', limitWaits: [{ type: 'provider.free-limit', delayMs: 90_000 }, { type: 'provider.free-limit', delayMs: 30_000 }] },
    { taskId: 'T3', state: 'done' },
  ]
  const { findings } = draftRetro({ runId: 'r1', date: '2026-11-11', plan: PLAN, status: {}, sessions })
  assert.deepEqual(findings.map((f) => f.id), ['retro-orphaned-T1', 'retro-limit-T2'])
  assert.match(findings[0].title, /T1 ended orphaned: timeout/)
  assert.match(findings[1].title, /T2 waited 2 times on a provider limit \(about 2 minutes\)/)
})

// The proposals are only useful if the learnings reader takes them back. A heading it does not
// match would be read as free text, and a scope it does not match would never be selected.
test('the proposed markdown is read back by selectLearnings with its scope', () => {
  const { markdown, findings } = draftRetro({ runId: 'run-7', date: '2026-11-11', plan: PLAN, status: STATUS })
  const all = selectLearnings(markdown, ['src/cart.mjs'])
  assert.equal(all.length, 1, 'only the T1 entry is scoped to src/cart.mjs')
  assert.equal(all[0].run, 'run-7')
  assert.equal(all[0].date, '2026-11-11')
  assert.match(all[0].text, /T1 needed 2 fix rounds/)
  assert.equal(selectLearnings(markdown, ['src/checkout.mjs']).length, findings.length - 1)
})

// The findings are meant for feedback-draft, whose rules are: single-line titles of at most 200
// characters and non-empty scope and evidence lists.
test('every finding fits the shape feedback-draft accepts', () => {
  const long = 'x'.repeat(500)
  const { findings } = draftRetro({
    runId: 'r1', date: '2026-11-11',
    plan: { tasks: [{ id: 'T9', title: `${long}\nsecond line`, files: [] }] },
    status: { fixRounds: { 1: { T9: 1 } } },
  })
  for (const f of findings) {
    assert.ok(f.title.length <= 200 && !/[\n\r]/.test(f.title), f.id)
    assert.ok(['rule', 'decision', 'pitfall', 'defect'].includes(f.type))
    assert.ok(f.scope.length > 0 && f.evidence.length > 0)
  }
  assert.deepEqual(findings[0].scope, ['**'], 'a task with no usable file still gets a scope')
})

test('draftRetro refuses a run id the learnings heading cannot carry', () => {
  assert.throws(() => draftRetro({ runId: 'a b', date: '2026-11-11', plan: PLAN, status: STATUS }), /run id/)
  assert.throws(() => draftRetro({ runId: 'r', date: '11/11/2026', plan: PLAN, status: STATUS }), /ISO date/)
})

test('retro prints proposals and writes nothing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-retro-'))
  try {
    const dir = path.join(root, '.fleetmates', 'r1')
    await mkdir(path.join(dir, 'sessions'), { recursive: true })
    await writeFile(path.join(dir, 'plan.json'), JSON.stringify(PLAN))
    await writeFile(path.join(dir, 'status.json'), JSON.stringify(STATUS))
    await writeFile(path.join(dir, 'sessions', 'T2.json'), JSON.stringify({ taskId: 'T2', state: 'failed', exitReason: 'enforcement' }))
    const before = (await readdir(root, { recursive: true })).sort()
    const lines = []
    const code = await runCli(['retro', '--run', 'r1', '--date', '2026-11-11', '--root', root], { out: (t) => lines.push(t) })
    const out = lines.join('\n')
    assert.equal(code, 0)
    assert.match(out, /Nothing was written/)
    assert.match(out, /## 2026-11-11 run: r1 scope: src\/cart\.mjs, tests\/cart\.test\.mjs/)
    assert.match(out, /T2 ended failed: enforcement/)
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before)

    const json = []
    assert.equal(await runCli(['retro', '--run', 'r1', '--date', '2026-11-11', '--json', '--root', root], { out: (t) => json.push(t) }), 0)
    assert.equal(JSON.parse(json.join('\n')).findings.length, 4)

    const missing = []
    assert.equal(await runCli(['retro', '--run', 'nope', '--root', root], { out: (t) => missing.push(t) }), 2)
    assert.match(missing.join('\n'), /no run nope/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
