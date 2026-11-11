import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runCli } from '../scripts/cli.mjs'
import { ConfigError, loadConfig, validateCost, validateKey } from '../scripts/config.mjs'
import {
  agentCost, annotateUsage, budgetLines, contextShare, projectSlug, renderUsage, summarizeTranscript,
} from '../scripts/usage.mjs'

const usageRecord = (over = {}) => ({
  message: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over } },
})

const PRICE = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 }

// The peak is the LARGEST context of any turn. Both orders hold the same contexts, so an
// implementation that takes the first or the last turn passes one and fails the other.
test('summarizeTranscript reports the peak context, whatever the order of the turns', () => {
  const ctx = (n) => usageRecord({ input_tokens: 1, cache_read_input_tokens: n, cache_creation_input_tokens: 2 })
  assert.equal(summarizeTranscript([ctx(900), ctx(4000), ctx(700)]).peak, 4003)
  assert.equal(summarizeTranscript([ctx(4000), ctx(700), ctx(900)]).peak, 4003)
})

// Each of the four categories is priced at its own rate. Distinct token counts and distinct prices
// mean a swapped pair (cache reads priced as input, say) changes the answer.
test('agentCost prices each token category at its own rate, per million tokens', () => {
  const agent = { model: 'm', input: 1_000_000, output: 2_000_000, cacheRead: 4_000_000, cacheWrite: 8_000_000 }
  assert.equal(agentCost(agent, { m: PRICE }), 2 + 16 + 2 + 24)
})

test('agentCost uses the model\'s own price before "*", and returns null with neither', () => {
  const agent = { model: 'm', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  assert.equal(agentCost(agent, { m: PRICE, '*': { ...PRICE, input: 100 } }), 2)
  assert.equal(agentCost({ ...agent, model: 'other' }, { m: PRICE, '*': { ...PRICE, input: 100 } }), 100)
  assert.equal(agentCost({ ...agent, model: 'other' }, { m: PRICE }), null)
})

// The model name comes from a meta.json an agent can write. An inherited key must not price it.
test('agentCost does not resolve a model named after an inherited property', () => {
  assert.equal(agentCost({ model: 'constructor', input: 1 }, { m: PRICE }), null)
  assert.equal(contextShare({ model: 'toString', peak: 1 }, { m: 1000 }), null)
})

test('contextShare is the peak over the window, and null when no window is set', () => {
  assert.equal(contextShare({ model: 'm', peak: 850 }, { m: 1000 }), 0.85)
  assert.equal(contextShare({ model: 'x', peak: 500 }, { '*': 1000 }), 0.5)
  assert.equal(contextShare({ model: 'x', peak: 500 }, { m: 1000 }), null)
})

test('annotateUsage leaves the report untouched when nothing is configured', () => {
  const report = { sessionId: 's', agents: [{ model: 'm', peak: 1 }], unreadable: [] }
  assert.equal(annotateUsage(report, { prices: {}, contextWindows: {} }), report)
  assert.doesNotMatch(renderUsage(annotateUsage(report, {})), /cost|ctx%/)
})

test('annotateUsage totals only priced agents and counts the rest as unpriced', () => {
  const report = {
    sessionId: 's',
    agents: [
      { model: 'm', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      { model: 'm', input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      { model: 'unknown', input: 9_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    ],
    unreadable: [],
  }
  const out = annotateUsage(report, { currency: 'CNY', budget: 10, prices: { m: PRICE }, contextWindows: {} })
  assert.equal(out.cost.total, 3)
  assert.equal(out.cost.unpriced, 1)
  assert.equal(out.cost.currency, 'CNY')
  assert.equal(out.agents[2].cost, null)
  const text = renderUsage(out)
  assert.match(text, /cost = 3\.00 CNY/)
  assert.match(text, /1 agent with no configured price is not in the cost/)
})

// Three sides of the two thresholds. A wrong comparison (> for >=) or a swapped branch moves
// one of these lines.
test('budgetLines warns at 80% and again when the budget is used up, and never before', () => {
  const at = (total) => budgetLines({ total, budget: 10, currency: 'USD' }).join('\n')
  assert.doesNotMatch(at(7.9), /warning/)
  assert.match(at(8), /warning: 80% of the budget is spent/)
  assert.match(at(10), /warning: the budget is used up/)
  assert.doesNotMatch(at(10), /80%/)
  assert.deepEqual(budgetLines({ total: 5, budget: null, currency: 'USD' }), [])
})

test('renderUsage flags an agent at or past 85% of its window, and shows ? without a window', () => {
  const report = annotateUsage({
    sessionId: 's',
    agents: [
      { agentType: 'tired', model: 'a', turns: 1, prefix: 1, peak: 850, cacheRead: 1, output: 1 },
      { agentType: 'fine', model: 'b', turns: 1, prefix: 1, peak: 840, cacheRead: 1, output: 1 },
      { agentType: 'blind', model: 'c', turns: 1, prefix: 1, peak: 840, cacheRead: 1, output: 1 },
    ],
    unreadable: [],
  }, { prices: {}, contextWindows: { a: 1000, b: 1000 } })
  const text = renderUsage(report)
  const row = (name) => text.split('\n').find((l) => l.startsWith(name))
  assert.match(row('tired'), /!85%/)
  assert.match(row('fine'), / 84%/)
  assert.doesNotMatch(row('fine'), /!/)
  assert.match(row('blind'), /\?/)
  assert.match(text, /! 1 agent reached 85% or more of the context window/)
})

test('validateCost accepts a full config and refuses each malformed field by name', () => {
  const good = { currency: 'CNY', budget: 20, prices: { '*': PRICE }, contextWindows: { 'deepseek-chat': 128000 } }
  assert.equal(validateCost(good, 'f'), good)
  const bad = [
    [{ currency: 'yuan!' }, /cost\.currency/],
    [{ budget: 0 }, /cost\.budget/],
    [{ budget: '20' }, /cost\.budget/],
    [{ prices: { m: { input: 1, output: 1, cacheRead: 1 } } }, /cost\.prices\.m\.cacheWrite/],
    [{ prices: { m: { ...PRICE, input: -1 } } }, /cost\.prices\.m\.input/],
    [{ prices: { m: { ...PRICE, extra: 1 } } }, /cost\.prices\.m\.extra/],
    [{ prices: { '': PRICE } }, /cost\.prices keys/],
    [{ contextWindows: { m: 10 } }, /cost\.contextWindows\.m/],
    [{ other: 1 }, /cost\.other/],
  ]
  for (const [value, message] of bad) assert.throws(() => validateCost(value, 'f'), (err) => err instanceof ConfigError && message.test(err.message), JSON.stringify(value))
})

test('config set accepts cost.currency and cost.budget and validates them', () => {
  assert.equal(validateKey('cost.budget', 25), 25)
  assert.equal(validateKey('cost.currency', 'CNY'), 'CNY')
  assert.throws(() => validateKey('cost.budget', -1), ConfigError)
  assert.throws(() => validateKey('cost.prices', {}), ConfigError)
})

// Per model, not per block: a local price for one model must not erase the gate's price for
// another, and a local scalar wins over the gate's.
test('loadConfig merges cost prices per model across the two layers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-cost-cfg-'))
  try {
    await writeFile(path.join(root, 'fleetmates.gate.json'), JSON.stringify({ cost: { currency: 'USD', budget: 5, prices: { a: PRICE, b: PRICE } } }))
    await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify({ cost: { budget: 9, prices: { b: { ...PRICE, input: 7 } } } }))
    const { resolved } = await loadConfig(root)
    assert.deepEqual(resolved.cost.prices.a, PRICE)
    assert.equal(resolved.cost.prices.b.input, 7)
    assert.equal(resolved.cost.budget, 9)
    assert.equal(resolved.cost.currency, 'USD')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// End to end: the prices in the project's config reach the table. Without the wiring in the CLI
// the table has no cost column at all.
test('usage prices the table from the project config and warns past the budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-cost-root-'))
  const store = await mkdtemp(path.join(tmpdir(), 'tm-cost-store-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    await writeFile(path.join(root, 'fleetmates.local.json'), JSON.stringify({
      cost: { currency: 'CNY', budget: 1, prices: { '*': PRICE }, contextWindows: { '*': 1000 } },
    }))
    const subagents = path.join(store, 'projects', projectSlug(path.resolve(root)), 'sess-1', 'subagents')
    await mkdir(subagents, { recursive: true })
    await writeFile(path.join(subagents, 'agent-a.jsonl'), JSON.stringify(usageRecord({ input_tokens: 900, output_tokens: 1_000_000 })))
    await writeFile(path.join(subagents, 'agent-a.meta.json'), JSON.stringify({ agentType: 'fleetmates:tm-implementer', model: 'deepseek-chat' }))
    process.env.CLAUDE_CONFIG_DIR = store
    const lines = []
    const code = await runCli(['usage', '--root', root], { out: (t) => lines.push(t) })
    const out = lines.join('\n')
    assert.equal(code, 0, 'the budget only warns; it never changes the exit code')
    assert.match(out, /cost = 8\.00 CNY/)
    assert.match(out, /!90%/)
    assert.match(out, /warning: the budget is used up/)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(root, { recursive: true, force: true })
    await rm(store, { recursive: true, force: true })
  }
})

// Both layers validate the block. Without the local layer's call, a bad local price would reach
// the report and print a confident number from a value nobody checked.
test('loadConfig refuses a malformed cost block in either layer', async () => {
  for (const file of ['fleetmates.local.json', 'fleetmates.gate.json']) {
    const root = await mkdtemp(path.join(tmpdir(), 'tm-cost-bad-'))
    try {
      await writeFile(path.join(root, file), JSON.stringify({ cost: { prices: { '*': { input: 1 } } } }))
      await assert.rejects(loadConfig(root), (err) => err instanceof ConfigError && /cost\.prices/.test(err.message), file)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('harnesses.<name>.limitWaitMinutes accepts 0 to 1440 and defaults to 60 in the harness settings', async () => {
  const { validateHarnesses } = await import('../scripts/config.mjs')
  const { harnessSettings } = await import('../scripts/cli.mjs')
  validateHarnesses({ opencode: { limitWaitMinutes: 0 } }, 'f')
  validateHarnesses({ opencode: { limitWaitMinutes: 1440 } }, 'f')
  for (const bad of [-1, 1441, 1.5, '60']) {
    assert.throws(() => validateHarnesses({ opencode: { limitWaitMinutes: bad } }, 'f'), /limitWaitMinutes/, String(bad))
  }
  assert.equal(validateKey('harnesses.opencode.limitWaitMinutes', 30), 30)
  assert.equal(harnessSettings({ harnesses: {} }, 'opencode', 'files').limitWaitMinutes, 60)
  assert.equal(harnessSettings({ harnesses: { opencode: { limitWaitMinutes: 0 } } }, 'opencode', 'files').limitWaitMinutes, 0)
})
