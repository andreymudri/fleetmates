// Hook to UI latency (docs/deck/09-testing.md section 9, budget: p95 under 300 ms, 03-architecture 7).
// Spawns the real deck-hook once per envelope, as Claude Code does, at a mixed rate against the real
// deck server (fake deckd, temporary HOME), with the built app open in headless Chromium, and splits
// each envelope's latency into:
//   spawn  harness spawn() to the hook's own hookTs (process start)
//   socket hookTs to the server receiving the line on hooks.sock (hook_events.received_at)
//   server receipt to the WebSocket publish of the session change (the reorder buffer's hold)
//   dom    publish to the card's pill text changing in the page (MutationObserver, wall clock)
//   total  spawn() to the pill change
// The split is reported pooled (`splitMs`, information only) and per hook event (`byEventMs`). Per
// TEST-O2 (docs/deck/09-testing.md) the buffer flushes early for Stop, PermissionRequest and
// Notification and keeps its 250 ms window for other events, so the 300 ms budget is judged on the total
// p95 of the early-flushed events only (`budget`). Prints one JSON line and exits 1 when that p95 is not
// under 300 ms, when no early-flushed event was measured, or when an envelope went unmatched.
//
// Not part of `npm test`. The hook walks its process ancestry for a `claude` process, and every session
// that shares one is the same session to the deck, so run it outside a Claude Code session, or detached:
//   mkdir -p /tmp/hx/perf && TMPDIR=/tmp/hx/perf setsid -f node hub/test/perf/hook-latency.mjs > /tmp/hx/perf/hook.json
// ENVELOPES (default 500) and SESSIONS (default 20) override the load.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWeb, envelopeFor, hookPayload, hub, launchBrowser, openDeck, startDeck, until } from '../e2e/observe.spec.mjs'

const ENVELOPES = Number(process.env.ENVELOPES ?? 500)
const SESSIONS = Number(process.env.SESSIONS ?? 20)
const BUDGET_P95_MS = 300
/** Events the reorder buffer flushes early (TEST-O2); only these are held to the budget. */
export const EARLY_FLUSH_EVENTS = Object.freeze(['Stop', 'PermissionRequest', 'Notification'])

/**
 * The TEST-O2 verdict: total p95 over the early-flushed events only, against the budget.
 * @param {{ event: string, total: number }[]} samples one per matched envelope
 * @param {number} [budget]
 * @returns {{ events: string[], total: ReturnType<typeof stats> | null, budgetP95Ms: number, withinBudget: boolean }}
 */
export function budgetVerdict(samples, budget = BUDGET_P95_MS) {
  const judged = samples.filter(sample => EARLY_FLUSH_EVENTS.includes(sample.event)).map(sample => sample.total)
  const total = judged.length ? stats(judged) : null
  return { events: [...EARLY_FLUSH_EVENTS], total, budgetP95Ms: budget, withinBudget: !!total && total.p95 < budget }
}

/**
 * The first `claude` ancestor of this process, or null (the same walk deck-hook does).
 * @returns {number | null}
 */
export function claudeAncestor() {
  let pid = process.ppid
  for (let depth = 0; pid > 1 && depth < 16; depth++) {
    let status
    let command
    try {
      status = readFileSync(`/proc/${pid}/status`, 'utf8')
      command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    } catch { return null }
    const name = path.basename(command[0] ?? '')
    if (name === 'claude' || name === 'node' && command.slice(1).some(arg => path.basename(arg) === 'claude')) return pid
    pid = Number(status.match(/^PPid:\s*(\d+)$/m)?.[1] ?? 0)
  }
  return null
}

/**
 * The value at quantile `q` (nearest rank) of an ascending array.
 * @param {number[]} sorted
 * @param {number} q
 * @returns {number}
 */
export function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

/**
 * p50, p95 and max of a list of milliseconds, rounded to 0.1 ms.
 * @param {number[]} values
 */
export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const round = n => Math.round(n * 10) / 10
  return { n: sorted.length, p50: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), max: round(sorted.at(-1)) }
}

/**
 * CPU model, cores, load averages and tool versions for a perf report.
 * @param {import('playwright-core').Browser} [browser]
 */
export function environment(browser) {
  return { cpu: os.cpus()[0]?.model, cores: os.cpus().length, loadavg: os.loadavg().map(n => Math.round(n * 100) / 100), node: process.version, chromium: browser?.version(), platform: `${os.type()} ${os.release()}` }
}

function runHook(file, env, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, stdio: ['pipe', 'ignore', 'ignore'] })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`deck-hook exited ${code}`)))
    child.stdin.end(JSON.stringify(payload))
  })
}

async function main() {
  const ancestor = claudeAncestor()
  if (ancestor) throw Error(`a claude process (pid ${ancestor}) is an ancestor: every hook would claim it and the sessions would merge. Run detached with setsid -f.`)
  const before = environment()
  const web = await buildWeb()
  const browser = await launchBrowser()
  const h = await startDeck(null, { web: web.dir })
  try {
    const keys = Array.from({ length: SESSIONS }, (_, i) => `s${String(i).padStart(2, '0')}`)
    const now = Date.now()
    await h.send(keys.flatMap(key => [envelopeFor({ key, fixture: 'lat' }, { e: 'SessionStart', ago: 120 }, now), envelopeFor({ key, fixture: 'lat' }, { e: 'UserPromptSubmit', ago: 110, prompt: `latency ${key}` }, now)]))
    const ids = Object.fromEntries(keys.map(key => [h.deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', `fx-lat-${key}`).id, key]))
    const published = []
    h.deck.subscribe(event => { if (event.type === 'session.upserted' && ids[event.data?.id]) published.push({ key: ids[event.data.id], state: event.data.state, at: Date.now() }) })
    const page = await openDeck(browser, h)
    await page.waitForSelector('.home-grid > article')
    await page.evaluate(() => {
      window.__pills = []
      const pill = card => card.querySelector('.card-header [class*="pill"]')?.textContent ?? ''
      const last = new Map()
      new MutationObserver(() => {
        const at = performance.timeOrigin + performance.now()
        for (const card of document.querySelectorAll('.home-grid > article')) {
          const id = card.getAttribute('aria-labelledby').replace(/^card-title-/, '')
          const text = pill(card)
          if (last.get(id) !== text) { last.set(id, text)
            window.__pills.push({ id, text, at }) }
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    const env = { PATH: process.env.PATH, HOME: h.env.HOME, XDG_RUNTIME_DIR: h.env.XDG_RUNTIME_DIR }
    const open = new Map(keys.map(key => [key, false]))
    const sent = []
    let seed = 0x5eed
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff }
    const running = []
    for (let i = 0; i < ENVELOPES; i++) {
      const key = keys[i % keys.length]
      const opening = !open.get(key)
      open.set(key, opening)
      const command = `probe-${i}`
      const payload = hookPayload(opening ? 'PermissionRequest' : 'PostToolUse', {
        session_id: `fx-lat-${key}`, cwd: `/home/you/dev/${key}`, transcript_path: `/home/you/.claude/projects/fixture/fx-lat-${key}.jsonl`,
        tool_name: 'Bash', tool_input: { command: opening ? command : sent.findLast(row => row.key === key).command }
      })
      const spawnedAt = Date.now()
      sent.push({ i, key, command, want: opening ? 'Needs approval' : 'Running', spawnedAt, event: payload.hook_event_name })
      running.push(runHook(h.paths.hook, env, payload))
      await new Promise(resolve => setTimeout(resolve, 10 + random() * 60))
    }
    await Promise.all(running)
    await until(() => h.deck.store.get("SELECT COUNT(*) AS n FROM hook_events WHERE claude_session_id LIKE 'fx-lat-%'").n >= SESSIONS * 2 + ENVELOPES, { timeout: 30_000, message: 'every envelope stored' })
    await page.waitForTimeout(1500)
    const pills = await page.evaluate(() => window.__pills)
    const idOf = Object.fromEntries(Object.entries(ids).map(([id, key]) => [key, id.replace(/[^\w-]/g, '_')]))
    const rows = h.deck.store.all("SELECT hook_ts, received_at, payload FROM hook_events WHERE claude_session_id LIKE 'fx-lat-%' AND event IN ('PermissionRequest','PostToolUse')")
    const byCommand = new Map(rows.map(row => [`${JSON.parse(row.payload).hook_event_name}:${JSON.parse(row.payload).tool_input?.command}`, row]))
    const split = { spawn: [], socket: [], server: [], dom: [], total: [] }
    const byEvent = {}
    const samples = []
    let missing = 0
    for (const row of sent) {
      const stored = byCommand.get(`${row.event}:${row.event === 'PermissionRequest' ? row.command : sent.findLast(prior => prior.key === row.key && prior.i < row.i).command}`)
      const next = sent.find(later => later.key === row.key && later.i > row.i)
      const within = at => at >= row.spawnedAt && (!next || at < next.spawnedAt + 5000)
      const publish = published.find(event => event.key === row.key && within(event.at) && (row.want === 'Running' ? event.state === 'running' : event.state === 'needs_approval'))
      const dom = pills.find(change => change.id === idOf[row.key] && change.text.startsWith(row.want) && within(change.at))
      if (!stored || !publish || !dom) { missing++
        continue }
      const parts = { spawn: stored.hook_ts - row.spawnedAt, socket: stored.received_at - stored.hook_ts, server: publish.at - stored.received_at, dom: dom.at - publish.at, total: dom.at - row.spawnedAt }
      byEvent[row.event] ??= { spawn: [], socket: [], server: [], dom: [], total: [] }
      for (const [name, value] of Object.entries(parts)) {
        split[name].push(value)
        byEvent[row.event][name].push(value)
      }
      samples.push({ event: row.event, total: parts.total })
    }
    const summarize = parts => Object.fromEntries(Object.entries(parts).map(([name, values]) => [name, stats(values)]))
    const budget = budgetVerdict(samples)
    const result = {
      envelopes: ENVELOPES, sessions: SESSIONS, matched: split.total.length, unmatched: missing,
      splitMs: summarize(split),
      byEventMs: Object.fromEntries(Object.entries(byEvent).map(([event, parts]) => [event, summarize(parts)])),
      budget, budgetP95Ms: BUDGET_P95_MS, withinBudget: budget.withinBudget,
      environment: { ...environment(browser), loadavgBefore: before.loadavg }
    }
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.withinBudget || missing) process.exitCode = 1
  } finally {
    await browser.close()
    await h.close()
    await web.cleanup()
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`hook-latency: ${error.stack ?? error.message}\n`)
    process.exitCode = 2
  })
}
