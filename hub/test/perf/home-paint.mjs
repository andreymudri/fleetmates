// Home first paint with 20 sessions (docs/deck/09-testing.md section 9, budget: under 500 ms,
// 03-architecture 7): fixture `perf20` (20 sessions in mixed states, 6 open requests) on the real deck
// server, the built app in a cold browser context at 1920 x 1080, median of 5 runs.
//
// The app emits no performance marks yet, so this script adds them from the outside: an init script
// marks `deck:snapshot-received` when the WebSocket delivers the snapshot (its listener runs before the
// app's), and `deck:home-painted` in the frame after the Home grid first holds cards (requestAnimationFrame,
// then a macrotask, so the frame has been painted). It reports that interval and, for context, navigation
// start to the painted mark. Prints one JSON line; exits 1 when the median is not under 500 ms.
//
// Not part of `npm test`. Run with:
//   mkdir -p /tmp/hx/perf && TMPDIR=/tmp/hx/perf node hub/test/perf/home-paint.mjs
import { buildWeb, envelopeFor, launchBrowser, openDeck, startDeck } from '../e2e/observe.spec.mjs'
import { environment, stats } from './hook-latency.mjs'

const RUNS = 5
const BUDGET_MS = 500

/**
 * The perf20 sessions: 4 awaiting approval (one with two requests), 1 question, 7 running, 3 done,
 * 3 idle, 1 stale and 1 reviewed; 6 open requests in all.
 * @returns {{ key: string, hooks: object[] }[]}
 */
export function perf20() {
  const edit = (key, ago) => ({ e: 'PostToolUse', ago, tool_name: 'Edit', tool_input: { file_path: `/home/you/dev/${key}/src/main.js`, old_string: 'a', new_string: 'b', replace_all: false } })
  const start = (key, ago = 3000) => [{ e: 'SessionStart', ago }, { e: 'UserPromptSubmit', ago: ago - 100, prompt: `task for ${key}` }]
  const sessions = []
  for (let i = 0; i < 4; i++) {
    const key = `approve-${i}`
    sessions.push({ key, hooks: [...start(key), { e: 'PermissionRequest', ago: 600 - i * 60, tool_name: 'Bash', tool_input: { command: `make check-${i}` } },
      ...(i === 0 ? [{ e: 'PermissionRequest', ago: 300, tool_name: 'Bash', tool_input: { command: 'make deploy-preview' } }] : [])] })
  }
  sessions.push({ key: 'question-0', hooks: [...start('question-0'), { e: 'PreToolUse', ago: 200, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'main', description: 'main' }], multiSelect: false }] } }] })
  for (let i = 0; i < 7; i++) sessions.push({ key: `run-${i}`, hooks: [...start(`run-${i}`, 900), { e: 'PreToolUse', ago: 30 + i, tool_name: 'Read', tool_input: { file_path: `/home/you/dev/run-${i}/README.md` } }] })
  for (let i = 0; i < 3; i++) sessions.push({ key: `done-${i}`, hooks: [...start(`done-${i}`), edit(`done-${i}`, 2000), { e: 'Stop', ago: 1500 + i * 60 }] })
  for (let i = 0; i < 3; i++) sessions.push({ key: `idle-${i}`, hooks: [...start(`idle-${i}`), { e: 'Stop', ago: 2500 + i * 60 }] })
  sessions.push({ key: 'stale-0', hooks: start('stale-0', 1500) })
  sessions.push({ key: 'reviewed-0', hooks: [...start('reviewed-0'), edit('reviewed-0', 2000), { e: 'Stop', ago: 1800 }] })
  return sessions
}

const marks = () => {
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args)
      this.addEventListener('message', event => {
        if (performance.getEntriesByName('deck:snapshot-received').length) return
        try { if (JSON.parse(event.data).t === 'snapshot') performance.mark('deck:snapshot-received') } catch {}
      })
    }
  }
  new MutationObserver((_, observer) => {
    if (!document.querySelector('.home-grid > article, .quiet-strip .strip-chip')) return
    observer.disconnect()
    requestAnimationFrame(() => setTimeout(() => performance.mark('deck:home-painted'), 0))
  }).observe(document, { childList: true, subtree: true })
}

async function main() {
  const before = environment()
  const web = await buildWeb()
  const browser = await launchBrowser()
  const h = await startDeck(null, { web: web.dir })
  try {
    const now = Date.now()
    const sessions = perf20()
    await h.send(sessions.flatMap(session => session.hooks.map(step => envelopeFor({ ...session, fixture: 'perf20' }, step, now))))
    const reviewed = h.deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', 'fx-perf20-reviewed-0').id
    h.deck.projector.signal(reviewed, { type: 'review' }, Date.now())
    h.deck.projector.tick(Date.now())
    const snapshot = h.deck.projector.snapshot()
    const shape = { sessions: snapshot.sessions.length, openRequests: snapshot.requests.filter(row => row.state === 'open').length }
    if (shape.sessions !== 20 || shape.openRequests !== 6) throw Error(`perf20 has ${JSON.stringify(shape)}`)
    const runs = []
    for (let run = 0; run < RUNS; run++) {
      const page = await openDeck(browser, h, '/', { viewport: { width: 1920, height: 1080 }, init: marks })
      await page.waitForFunction(() => performance.getEntriesByName('deck:home-painted').length === 1, null, { timeout: 10_000 })
      runs.push(await page.evaluate(() => {
        const snapshotAt = performance.getEntriesByName('deck:snapshot-received')[0].startTime
        const paintedAt = performance.getEntriesByName('deck:home-painted')[0].startTime
        return { snapshotToPaint: paintedAt - snapshotAt, navigationToPaint: paintedAt, cards: document.querySelectorAll('.home-grid > article').length }
      }))
      await page.context().close()
      h.contexts.clear()
    }
    const snapshotToPaint = stats(runs.map(row => row.snapshotToPaint))
    const median = [...runs.map(row => row.snapshotToPaint)].sort((a, b) => a - b)[Math.floor(RUNS / 2)]
    const result = {
      fixture: 'perf20', ...shape, runs: RUNS, viewport: '1920x1080', cardsPainted: runs[0].cards,
      snapshotToPaintMs: { median: Math.round(median * 10) / 10, ...snapshotToPaint, all: runs.map(row => Math.round(row.snapshotToPaint * 10) / 10) },
      navigationToPaintMs: stats(runs.map(row => row.navigationToPaint)),
      budgetMs: BUDGET_MS, withinBudget: median < BUDGET_MS,
      environment: { ...environment(browser), loadavgBefore: before.loadavg }
    }
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.withinBudget) process.exitCode = 1
  } finally {
    await browser.close()
    await h.close()
    await web.cleanup()
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`home-paint: ${error.stack ?? error.message}\n`)
    process.exitCode = 2
  })
}
