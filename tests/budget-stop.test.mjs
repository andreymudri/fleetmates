import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { runCli, budgetRefusal } from '../scripts/cli.mjs'
import { projectSlug, budgetStop, budgetStopLines } from '../scripts/usage.mjs'
import { validateCost, validateKey, assertBudgetStop, ConfigError, loadConfig, GATE_FILE, LOCAL_FILE } from '../scripts/config.mjs'

// One currency unit per token read from cache, so the fixture's 450 tokens cost exactly 450.
const PER_TOKEN = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }
const line = (tokens) => JSON.stringify({ message: { usage: { cache_read_input_tokens: tokens, output_tokens: 0 } } })
const STORE = {
  'agent-a.jsonl': [line(100), line(300)].join('\n'),
  'agent-a.meta.json': JSON.stringify({ agentType: 'fleetmates:tm-implementer', model: 'priced' }),
  'agent-b.jsonl': line(50),
  'agent-b.meta.json': JSON.stringify({ agentType: 'fleetmates:tm-implementer', model: 'priced' }),
}

// A transcript store injected through CLAUDE_CONFIG_DIR, so no test reads real transcripts.
async function withStore(root, files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-budget-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    if (files) {
      const subagents = path.join(dir, 'projects', projectSlug(root), 'sess-1', 'subagents')
      await mkdir(subagents, { recursive: true })
      for (const [name, body] of Object.entries(files)) await writeFile(path.join(subagents, name), body, 'utf8')
    }
    process.env.CLAUDE_CONFIG_DIR = dir
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
}
const capture = () => { const lines = []; return { io: { out: (t) => lines.push(t), err: () => {} }, lines } }
const cost = (over = {}) => ({ currency: 'USD', budget: 450, stopAtBudget: true, prices: { '*': PER_TOKEN }, contextWindows: {}, ...over })

test('budgetStop stops at the budget, not below it, and never without a priced total', () => {
  const report = (total, budget, unpriced = 0) => ({ cost: { currency: 'USD', total, budget, unpriced } })
  assert.equal(budgetStop(report(449.99, 450)), null)
  assert.deepEqual(budgetStop(report(450, 450)), { total: 450, budget: 450, currency: 'USD', unpriced: 0 })
  assert.deepEqual(budgetStop(report(900, 450, 2)), { total: 900, budget: 450, currency: 'USD', unpriced: 2 })
  assert.equal(budgetStop(report(900, null)), null)
  assert.equal(budgetStop({ agents: [] }), null)
  assert.equal(budgetStop(null), null)
})

test('the stop lines state the spend, the unpriced agents and that nothing was started', () => {
  const priced = budgetStopLines({ total: 450, budget: 450, currency: 'USD', unpriced: 0 })
  assert.equal(priced.length, 2)
  assert.match(priced[0], /^budget reached: .*450.* of .*450.* USD spent in this session$/)
  assert.equal(priced[1], 'nothing was started (cost.stopAtBudget is on); teammates already running are not affected')
  const partial = budgetStopLines({ total: 450, budget: 450, currency: 'USD', unpriced: 2 })
  assert.equal(partial[1], '2 agents had no price and are not counted, so the total is a lower bound')
  assert.match(budgetStopLines({ total: 1, budget: 1, currency: 'USD', unpriced: 1 })[1], /^1 agent had no price and is not counted/)
})

test('cost.stopAtBudget is a boolean in either layer and settable from the command line', () => {
  assert.deepEqual(validateCost({ stopAtBudget: true }, 'f'), { stopAtBudget: true })
  assert.deepEqual(validateCost({ stopAtBudget: false }, 'f'), { stopAtBudget: false })
  for (const bad of ['true', 1, null, {}]) {
    assert.throws(() => validateCost({ stopAtBudget: bad }, 'f'), (e) => e instanceof ConfigError && /cost\.stopAtBudget must be true or false/.test(e.message))
  }
  assert.equal(validateKey('cost.stopAtBudget', true), true)
  assert.throws(() => validateKey('cost.stopAtBudget', 'yes'), ConfigError)
})

test('the resolved switch is off by default and the local layer overrides the tracked one', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tm-budget-config-')))
  const resolved = async (gate, local) => {
    await writeFile(path.join(root, GATE_FILE), JSON.stringify(gate))
    if (local === null) await rm(path.join(root, LOCAL_FILE), { force: true })
    else await writeFile(path.join(root, LOCAL_FILE), JSON.stringify(local))
    return (await loadConfig(root)).resolved.cost.stopAtBudget
  }
  try {
    assert.equal(await resolved({}, null), false)
    assert.equal(await resolved({ cost: { stopAtBudget: true } }, null), true)
    assert.equal(await resolved({ cost: { stopAtBudget: true } }, { cost: { stopAtBudget: false } }), false)
    assert.equal(await resolved({}, { cost: { stopAtBudget: true } }), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a switch with nothing to measure against is a configuration error', () => {
  assert.doesNotThrow(() => assertBudgetStop(cost()))
  assert.doesNotThrow(() => assertBudgetStop(cost({ stopAtBudget: false, budget: null, prices: {} })))
  for (const broken of [cost({ budget: null }), cost({ prices: {} })]) {
    assert.throws(() => assertBudgetStop(broken), (e) => e instanceof ConfigError && /cost\.stopAtBudget needs cost\.budget and at least one cost\.prices entry/.test(e.message))
  }
})

test('budgetRefusal stops at the budget and goes on below it, with the switch off, or when usage cannot be read', async () => {
  const root = path.resolve('/fake/budget-project')
  await withStore(root, STORE, async () => {
    const at = capture()
    assert.equal(await budgetRefusal(root, cost({ budget: 450 }), at.io), 1)
    assert.match(at.lines[0], /^budget reached: /)
    assert.equal(at.lines.at(-1), 'nothing was started (cost.stopAtBudget is on); teammates already running are not affected')

    const below = capture()
    assert.equal(await budgetRefusal(root, cost({ budget: 451 }), below.io), null)
    assert.deepEqual(below.lines, [])

    const off = capture()
    assert.equal(await budgetRefusal(root, cost({ budget: 1, stopAtBudget: false }), off.io), null)
    assert.deepEqual(off.lines, [])

    const unpriced = capture()
    assert.equal(await budgetRefusal(root, cost({ budget: 400, prices: { 'another-model': PER_TOKEN } }), unpriced.io), null,
      'spend that cannot be priced is not counted, so it never stops a run')

    const broken = capture()
    assert.equal(await budgetRefusal(root, cost({ prices: {} }), broken.io), 2)
    assert.match(broken.lines[0], /^cost\.stopAtBudget needs /)
  })
  await withStore(root, null, async () => {
    const unread = capture()
    assert.equal(await budgetRefusal(root, cost({ budget: 1 }), unread.io), null)
    assert.equal(unread.lines.length, 1)
    assert.match(unread.lines[0], /^budget not checked: /)
  })
})

const PLAN = '### Task 1: A\n\n**Files:**\n- Create: `a.mjs`\n'
test('workflow and dispatch start nothing once the session has spent the budget, and workflow prints its dispatch below it', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tm-budget-repo-')))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  try {
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture')
    await writeFile(path.join(root, 'plan.md'), PLAN)
    await writeFile(path.join(root, '.gitignore'), '.fleetmates/\n')
    const manifest = (budget, stopAtBudget) => JSON.stringify({ cost: { budget, stopAtBudget, prices: { '*': PER_TOKEN } } })
    await writeFile(path.join(root, 'fleetmates.gate.json'), manifest(450, true))
    git('add', '.'); git('commit', '--quiet', '-m', 'initial')
    git('checkout', '--quiet', '-b', 'run-branch')
    assert.equal(await runCli(['init-run', path.join(root, 'plan.md'), '--run', 'r1', '--root', root], capture().io), 0)

    await withStore(root, STORE, async () => {
      const stopped = capture()
      assert.equal(await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], stopped.io), 1)
      assert.match(stopped.lines[0], /^budget reached: /)
      assert.ok(!stopped.lines.join('\n').includes('agent('), 'a stopped workflow must print no dispatch')

      // `dispatch` is refused at the same point, before a harness is probed or a sandbox is cut.
      const dispatched = capture()
      assert.equal(await runCli(['dispatch', '--run', 'r1', '--phase', '1', '--harness', 'codex', '--root', root], dispatched.io), 1)
      assert.ok(dispatched.lines.some((l) => /^budget reached: /.test(l)), dispatched.lines.join('\n'))
      assert.equal(dispatched.lines.at(-1), 'nothing was started (cost.stopAtBudget is on); teammates already running are not affected')

      await writeFile(path.join(root, 'fleetmates.gate.json'), manifest(451, true))
      const below = capture()
      assert.equal(await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], below.io), 0)
      assert.ok(below.lines.join('\n').includes('agent('), 'below the budget the workflow is printed as before')

      await writeFile(path.join(root, 'fleetmates.gate.json'), manifest(1, false))
      const off = capture()
      assert.equal(await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], off.io), 0)
      assert.ok(!off.lines.join('\n').includes('budget'), 'with the switch off the budget is not mentioned')
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})
