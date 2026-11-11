// Per-run token reporting: the pure half. Reads nothing and writes nothing, so every rule below
// is testable without touching a real transcript store.
//
// WHY THIS EXISTS. Cache reads dominate a fleet run's token cost — measured at 2,190,488 against
// 212 tokens of fresh input across three agents — and they scale with turns x context, because
// every token in an agent's context is re-read on each later turn. The number that matters is
// therefore not a total but the FIXED PREFIX: the system prompt, agent definition, tool schemas
// and dispatch prompt an agent carries before doing any work. It was 40% of all cache reads, and
// a totals-only report hid it completely: the integrator looked cheapest by cache reads while
// carrying a 5x larger prefix than a reviewer whose prompt was longer.

import { printable } from './reviews.mjs'

// The harness's directory name for a project: its absolute path with the separators replaced.
// Both separator kinds are replaced rather than `path.sep` alone, because the answer must not
// depend on which platform is asking about which path.
//
// The COLON is replaced for the same reason and one more: every absolute Windows path carries a
// drive letter, and a colon cannot appear in a Windows filename at all. Leaving it in produced a
// slug like `D:-fake-project`, naming a directory that can never exist there — so the lookup
// could not fail in any way a reader would recognise as "wrong slug".
export function projectSlug(root) {
  return String(root).replace(/[/\\:]/g, '-')
}

// `prefix` is the MINIMUM context observed, not the first message's. A minimum cannot be inflated
// by ordering or by a retried first turn — the same reasoning the quiet reporter applies when it
// takes counts from the root summary rather than from whichever event arrived first. Prefer the
// definition that cannot be fooled.
//
// A message is counted ONCE. Claude Code writes one line per content block of an assistant message,
// and each line repeats the message's `id` and its whole `usage`; summing per line counted a
// three-block message three times, and the cost priced from these totals came out about double.
// The last line of an id wins, because a line written mid-stream can carry a smaller output count.
// A record with no id cannot be matched to another, so it counts on its own.
export function summarizeTranscript(records) {
  const totals = { turns: 0, prefix: 0, peak: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const usages = []
  const byId = new Map()
  for (const record of records) {
    const usage = record?.message?.usage
    if (!usage || typeof usage !== 'object') continue
    const id = record.message.id
    if (typeof id !== 'string' || id === '') { usages.push(usage); continue }
    if (byId.has(id)) usages[byId.get(id)] = usage
    else { byId.set(id, usages.length); usages.push(usage) }
  }
  let min = null
  for (const usage of usages) {
    totals.turns += 1
    totals.input += usage.input_tokens ?? 0
    totals.output += usage.output_tokens ?? 0
    totals.cacheRead += usage.cache_read_input_tokens ?? 0
    totals.cacheWrite += usage.cache_creation_input_tokens ?? 0
    const context = (usage.input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0)
    if (min === null || context < min) min = context
    // The largest context any one turn carried: how close the agent came to its window. A total
    // cannot show this, and a model degrades near the end of its window long before it fails.
    if (context > totals.peak) totals.peak = context
  }
  totals.prefix = min ?? 0
  return totals
}

const n = (value) => Number(value ?? 0).toLocaleString('en-US')

// Above this share of its context window an agent is flagged. Where the work starts to degrade is
// not measured here; 85% is the line the ULU app draws, taken as a starting point.
export const CONTEXT_WARN_SHARE = 0.85
// The budget warns once this share is spent, and again when it is used up. It never stops a run.
export const BUDGET_WARN_SHARE = 0.8

// The configured entry for a model: its own key first, then `*`. `Object.hasOwn`, because the key
// is a model name read from a meta.json an agent can write, and `constructor` must not resolve to
// an inherited function.
function forModel(table, model) {
  if (!table || typeof table !== 'object') return null
  if (typeof model === 'string' && Object.hasOwn(table, model)) return table[model]
  return Object.hasOwn(table, '*') ? table['*'] : null
}

// Prices one agent's tokens. Prices are per million tokens. `null` when the model has no price:
// the caller shows that as unknown, never as zero, because a zero would understate the total.
export function agentCost(agent, prices) {
  const price = forModel(prices, agent?.model)
  if (!price) return null
  return ((agent.input ?? 0) * price.input + (agent.output ?? 0) * price.output
    + (agent.cacheRead ?? 0) * price.cacheRead + (agent.cacheWrite ?? 0) * price.cacheWrite) / 1_000_000
}

// The agent's peak context as a share of its model's window, or `null` when no window is set for
// that model. No window is assumed: the same model name can run with different windows, and a
// guessed window would print a confident percentage that is wrong.
export function contextShare(agent, windows) {
  const size = forModel(windows, agent?.model)
  if (!Number.isInteger(size) || size <= 0) return null
  return (agent.peak ?? 0) / size
}

// Adds cost and context share to a report, from the resolved `cost` config. Pure: the report is
// not changed. With no prices and no windows configured it returns the report as it was, so the
// table and the JSON stay exactly as before for a user who set nothing.
export function annotateUsage(report, cost) {
  const prices = cost?.prices ?? {}
  const windows = cost?.contextWindows ?? {}
  const priced = Object.keys(prices).length > 0
  const windowed = Object.keys(windows).length > 0
  if (!priced && !windowed) return report
  const agents = (report?.agents ?? []).map((agent) => ({
    ...agent,
    ...(priced ? { cost: agentCost(agent, prices) } : {}),
    ...(windowed ? { contextShare: contextShare(agent, windows) } : {}),
  }))
  const out = { ...report, agents }
  if (priced) {
    const known = agents.filter((a) => a.cost !== null)
    out.cost = {
      currency: cost.currency ?? 'USD',
      total: known.reduce((sum, a) => sum + a.cost, 0),
      unpriced: agents.length - known.length,
      budget: cost.budget ?? null,
    }
  }
  return out
}

// The budget lines under the table. A warning, never an exit code: the budget does not stop work.
export function budgetLines(summary) {
  if (!summary || !(summary.budget > 0)) return []
  const share = summary.total / summary.budget
  const lines = [`budget: ${money(summary.total)} of ${money(summary.budget)} ${summary.currency} (${Math.round(share * 100)}%)`]
  if (share >= 1) lines.push('warning: the budget is used up (it is a warning only; nothing was stopped)')
  else if (share >= BUDGET_WARN_SHARE) lines.push(`warning: ${Math.round(BUDGET_WARN_SHARE * 100)}% of the budget is spent`)
  return lines
}

function money(value) {
  return Number(value ?? 0).toFixed(value !== 0 && Math.abs(value) < 0.01 ? 4 : 2)
}

// Every value below `p()` wraps is read from disk — a meta.json an agent can write, a filename, a
// session directory name. This was the only render module in scripts/ with no neutralisation at
// all, and `fit` pads by String.length, so a literal newline counted as one character: a forged
// row needed no escape sequence to appear. See scripts/reviews.mjs for what `printable` covers
// and what it deliberately does not (bidi and format controls pass through, a recorded decision).
const p = (value) => printable(String(value))

export function renderUsage(report) {
  const agents = report?.agents ?? []
  const unreadable = report?.unreadable ?? []
  const lines = [`run ${p(report?.sessionId ?? '(unknown)')}  (${agents.length} subagent${agents.length === 1 ? '' : 's'})`, '']

  const cols = [
    ['agentType', 32, (a) => p(a.agentType ?? '(unknown)'), false],
    ['model', 9, (a) => p(a.model ?? '(unknown)'), false],
    ['turns', 7, (a) => n(a.turns), true],
    ['prefix', 9, (a) => n(a.prefix), true],
    ['prefix×turns', 14, (a) => n((a.prefix ?? 0) * (a.turns ?? 0)), true],
    ['cache_rd', 12, (a) => n(a.cacheRead), true],
    ['output', 9, (a) => n(a.output), true],
    ['peak', 10, (a) => n(a.peak), true],
  ]
  // Optional columns, only when the report was annotated with them, so a user who configured
  // nothing sees the table as it always was.
  const hasShare = agents.some((a) => Object.hasOwn(a, 'contextShare'))
  const hasCost = report?.cost !== undefined
  if (hasShare) {
    cols.push(['ctx%', 7, (a) => (a.contextShare === null || a.contextShare === undefined)
      ? '?' : `${a.contextShare >= CONTEXT_WARN_SHARE ? '!' : ''}${Math.round(a.contextShare * 100)}%`, true])
  }
  if (hasCost) cols.push(['cost', 10, (a) => (a.cost === null || a.cost === undefined) ? '?' : money(a.cost), true])

  const prefixTurns = agents.reduce((sum, a) => sum + (a.prefix ?? 0) * (a.turns ?? 0), 0)
  const cacheRead = agents.reduce((sum, a) => sum + (a.cacheRead ?? 0), 0)
  const totalRow = [
    'TOTAL', '',
    n(agents.reduce((s, a) => s + (a.turns ?? 0), 0)), '',
    n(prefixTurns), n(cacheRead),
    n(agents.reduce((s, a) => s + (a.output ?? 0), 0)),
    n(Math.max(0, ...agents.map((a) => a.peak ?? 0))),
  ]
  if (hasShare) totalRow.push('')
  if (hasCost) totalRow.push(money(report.cost.total))

  // A numeric column GROWS to fit its widest value; only a text column is capped. `fit` applied
  // one rule to both, so a cache_rd of 1,000,000,000 rendered as `1,000,000,…` — and a long fleet
  // run reaches 10^9 comfortably. The headline number of a token report is not a value to
  // truncate, and a reader cannot tell a truncated count from a smaller one.
  const widths = cols.map(([title, width, read, right], i) => {
    if (!right) return width
    const longest = Math.max(
      title.length,
      totalRow[i].length,
      ...agents.map((a) => read(a).length),
    )
    return Math.max(width, longest + 1)
  })

  // Truncated, not just padded. A value wider than its column runs into the next one and the
  // table stops being readable in exactly the case that matters — a fully-qualified agent type
  // like `fleetmates:tm-integrator` is 24 characters, and a longer plugin or agent name overruns
  // its column. One trailing space keeps a truncated
  // cell from touching its neighbour.
  const fit = (text, width, right) => {
    const value = String(text)
    if (right) return value.padStart(width)
    const cell = value.length > width - 1 ? `${value.slice(0, width - 2)}…` : value
    return cell.padEnd(width)
  }
  const row = (cells) => cells.map((cell, i) => fit(cell, widths[i], cols[i][3])).join('')

  lines.push(row(cols.map(([title]) => title)))
  for (const agent of agents) lines.push(row(cols.map(([, , read]) => read(agent))))

  lines.push('─'.repeat(widths.reduce((sum, w) => sum + w, 0)))
  lines.push(row(totalRow))

  // Guarded rather than computed blind: with no cache reads recorded the share is undefined, and
  // printing NaN or Infinity in the one line a reader takes a decision from is worse than saying
  // the question has no answer here.
  lines.push(cacheRead > 0
    ? `fixed prefix = ${Math.round(prefixTurns / cacheRead * 100)}% of all cache reads`
    : 'fixed prefix = n/a (no cache reads recorded)')

  if (hasShare) {
    const tired = agents.filter((a) => typeof a.contextShare === 'number' && a.contextShare >= CONTEXT_WARN_SHARE)
    if (tired.length > 0) {
      lines.push(`! ${tired.length} agent${tired.length === 1 ? '' : 's'} reached ${Math.round(CONTEXT_WARN_SHARE * 100)}% or more of the context window`)
    }
  }
  if (hasCost) {
    lines.push(`cost = ${money(report.cost.total)} ${p(report.cost.currency)} at the configured prices (an estimate from tokens, not the provider's bill)`)
    // Said every time, because a total with unpriced agents in it is a lower bound, not the spend.
    const unpriced = report.cost.unpriced ?? 0
    if (unpriced > 0) lines.push(`${unpriced} agent${unpriced === 1 ? '' : 's'} with no configured price ${unpriced === 1 ? 'is' : 'are'} not in the cost (add the model or "*" to cost.prices)`)
    lines.push(...budgetLines(report.cost))
  }

  // Named and counted, never skipped. A dropped agent understates a total, and an understated
  // total is how this tool would appear to prove a saving nobody made.
  if (unreadable.length > 0) {
    lines.push('')
    for (const entry of unreadable) lines.push(`  ! ${p(entry.name)}: ${p(entry.reason)}`)
    // Counted apart, because a transcript that lost one line still contributed its row and every
    // other record in it. Filing that under "unreadable" states the opposite of what happened, in
    // the one line a reader takes the totals' trustworthiness from. A missing `kept` is the older
    // shape, where nothing was salvaged.
    // Each kind named as what it actually is. `kept: 0` was overloaded to mean a read failure, a
    // file that read fine but holds no records yet, and a DIRECTORY the walk could not enter — and
    // this tally called all three "transcript(s) unreadable", asserting a read failure that never
    // happened and calling a directory a transcript, in the one line a reader takes the totals'
    // trustworthiness from. `kind` is absent on the older shape, where `kept > 0` meant partial and
    // anything else meant unreadable; that reading is the fallback.
    const kindOf = (e) => e.kind ?? ((e.kept ?? 0) > 0 ? 'partial' : 'unreadable')
    const count = (kind) => unreadable.filter((e) => kindOf(e) === kind).length
    const partial = unreadable.filter((e) => kindOf(e) === 'partial')
    if (count('unreadable') > 0) lines.push(`${count('unreadable')} transcript(s) unreadable`)
    if (partial.length > 0) {
      const dropped = partial.reduce((sum, e) => sum + (e.dropped ?? 0), 0)
      lines.push(`${partial.length} transcript(s) with dropped lines (${dropped} line(s) total)`)
    }
    if (count('empty') > 0) lines.push(`${count('empty')} transcript(s) with no records yet`)
    // Inflected, like the unreadable-entry notice in finish.mjs: "1 directory(ies)" reads as a
    // template nobody checked.
    const dirs = count('directory')
    if (dirs > 0) lines.push(`${dirs} ${dirs === 1 ? 'directory' : 'directories'} could not be read`)
    // Last, because it bounds everything above it: past the cap the report is incomplete and no
    // other count on this screen can be read as a total.
    for (const e of unreadable.filter((x) => kindOf(x) === 'truncated')) lines.push(`walk truncated: ${p(e.reason)}`)
  }
  return lines.join('\n')
}
