// Keystroke echo latency through the whole spike path (M0, Task 9):
// Chromium page -> spike server WebSocket -> deckd -> PTY -> fake claude
// (echo.json) -> deckd -> spike server -> page -> xterm.js DOM rows.
//
// Not part of `npm test`. Run with `npm --prefix hub run perf`. It starts its
// own deckd and spike server on a private XDG_RUNTIME_DIR, opens the spike
// page in the system Chromium (CHROMIUM_PATH, default /usr/bin/chromium,
// headless) through playwright-core, clicks Start, types KEYS single keys
// KEY_SPACING_MS apart and measures, inside the page, the time from the
// keydown event to the moment the echoed character appears in the terminal's
// DOM rows. `wire` is the same measure taken when the echo's WebSocket
// message reaches the page, before xterm.js renders it. It prints one JSON
// line with p50, p95 and max in milliseconds and
// exits 1 when p95 is not under the 50 ms budget (03-architecture.md
// section 7).
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { makeRuntimeDir } from '../helpers/runtime-dir.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const hubDir = path.resolve(here, '..', '..')
const deckdMain = path.join(hubDir, 'deckd', 'main.mjs')
const spikeMain = path.join(hubDir, 'spike', 'server.mjs')
const echoScript = path.join(hubDir, 'test', 'fixtures', 'scripts', 'echo.json')
const KEYS = 200
const KEY_SPACING_MS = 20
const BUDGET_P95_MS = 50
const DEADLINE = 15000

/**
 * Start a child (cwd: hub/) and resolve once its stdout or stderr matches `ready`.
 * @param {string} script
 * @param {NodeJS.ProcessEnv} env
 * @param {RegExp} ready
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, match: RegExpMatchArray }>}
 */
function startChild (script, env, ready) {
  const proc = spawn(process.execPath, [script], { env, cwd: hubDir, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${script} did not start: ${err}`)), DEADLINE)
    const check = () => {
      const match = out.match(ready) ?? err.match(ready)
      if (match) {
        clearTimeout(timer)
        resolve({ proc, match })
      }
    }
    proc.stdout?.on('data', (d) => { out += d; check() })
    proc.stderr?.on('data', (d) => { err += d; check() })
    proc.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${script} exited ${code}: ${err}`))
    })
  })
}

/**
 * Kill a child and wait for it to be gone.
 * @param {import('node:child_process').ChildProcess | undefined} proc
 * @param {NodeJS.Signals} signal
 */
async function stop (proc, signal) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const gone = new Promise((resolve) => proc.once('exit', resolve))
  proc.kill(signal)
  await gone
}

/**
 * The value at quantile `q` (nearest rank) of an ascending array.
 * @param {number[]} sorted
 * @param {number} q
 * @returns {number}
 */
function quantile (sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}

/** @param {number} n */
const round = (n) => Math.round(n * 100) / 100

async function main () {
  const rt = await makeRuntimeDir()
  const fakeLog = path.join(rt.dir, 'fake-claude.log')
  const fake = await fakeBin({ script: echoScript, log: fakeLog })
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let deckd
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let spike
  /** @type {import('playwright-core').Browser | undefined} */
  let browser
  try {
    deckd = (await startChild(deckdMain, { ...fake.env, XDG_RUNTIME_DIR: rt.dir, HOME: rt.dir, DECKD_LOGIN_ENV: 'inherit' }, /deckd listening on/)).proc
    const started = await startChild(spikeMain, { ...rt.env, SPIKE_PORT: '0' }, /^(http:\/\/127\.0\.0\.1:\d+\/)#token=([A-Za-z0-9_-]{43})\n/m)
    spike = started.proc
    const [, base, token] = started.match

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true })
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    // Before the page script runs: stamp every echoed letter as its `out`
    // message reaches the page, so the render share can be told apart.
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window)
      w.wireAt = []
      const Native = w.WebSocket
      w.WebSocket = class extends Native {
        /** @param {any[]} args */
        constructor (...args) {
          super(...args)
          this.addEventListener('message', (/** @type {MessageEvent} */ e) => {
            const msg = JSON.parse(e.data)
            if (msg.t !== 'out') return
            const now = performance.now()
            const letters = atob(msg.data).replace(/[^a-z]/g, '').length
            for (let k = 0; k < letters; k++) w.wireAt.push(now)
          })
        }
      }
    })
    await page.goto(`${base}?${new URLSearchParams({ spawn: '1', cwd: rt.dir })}#token=${token}`)
    await page.click('#start')
    await page.waitForFunction(() => /^lastInputFrom: none$/.test(document.getElementById('status')?.textContent ?? '') && location.search.startsWith('?pty='), null, { timeout: DEADLINE })
    await page.waitForSelector('.xterm-rows', { timeout: DEADLINE })
    // The fake puts its tty in raw mode before it logs `ready`. A key typed
    // earlier is echoed twice: once by the tty's own cooked-mode echo, once
    // by the fake.
    const readyBy = Date.now() + DEADLINE
    while (!(await readFile(fakeLog, 'utf8').catch(() => '')).includes('"ready":true')) {
      if (Date.now() > readyBy) throw new Error('fake claude never logged ready')
      await sleep(20)
    }

    // In the page: stamp every keydown, and on every DOM change of the rows
    // count the echoed letters; key i is rendered once i + 1 letters show.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      w.keyAt = []
      w.shownAt = []
      const rows = /** @type {Element} */ (document.querySelector('.xterm-rows'))
      document.addEventListener('keydown', () => { w.keyAt.push(performance.now()) }, true)
      new MutationObserver(() => {
        const now = performance.now()
        const shown = (rows.textContent ?? '').replace(/[^a-z]/g, '').length
        while (w.shownAt.length < shown && w.shownAt.length < w.keyAt.length) w.shownAt.push(now)
      }).observe(rows, { childList: true, subtree: true, characterData: true })
    })
    await page.focus('.xterm-helper-textarea')

    let typed = ''
    for (let i = 0; i < KEYS; i++) {
      const key = String.fromCharCode(97 + (i % 26))
      typed += key
      await page.keyboard.press(key)
      await page.waitForTimeout(KEY_SPACING_MS)
    }
    await page.waitForFunction((n) => /** @type {any} */ (window).shownAt.length >= n, KEYS, { timeout: DEADLINE })
    const { keyAt, shownAt, wireAt } = await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      return { keyAt: w.keyAt, shownAt: w.shownAt, wireAt: w.wireAt }
    })
    // A duplicated or lost echo would shift every key onto another key's
    // render time, so the screen must hold exactly the typed letters.
    const onScreen = await page.evaluate(() => (document.querySelector('.xterm-rows')?.textContent ?? '').replace(/[^a-z]/g, ''))
    if (onScreen !== typed) throw new Error(`the terminal shows ${JSON.stringify(onScreen)}, not the ${KEYS} typed letters`)
    if (keyAt.length !== KEYS) throw new Error(`expected ${KEYS} keydown events, saw ${keyAt.length}`)
    if (wireAt.length !== KEYS) throw new Error(`expected ${KEYS} echoed letters on the WebSocket, saw ${wireAt.length}`)
    /** @param {number[]} at */
    const since = (at) => keyAt.map((/** @type {number} */ t, /** @type {number} */ i) => at[i] - t).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b)
    const lat = since(shownAt)
    const wire = since(wireAt)
    const result = {
      keys: KEYS,
      spacingMs: KEY_SPACING_MS,
      p50: round(quantile(lat, 0.5)),
      p95: round(quantile(lat, 0.95)),
      max: round(lat[lat.length - 1]),
      min: round(lat[0]),
      wire: { p50: round(quantile(wire, 0.5)), p95: round(quantile(wire, 0.95)), max: round(wire[wire.length - 1]), min: round(wire[0]) },
      budgetP95Ms: BUDGET_P95_MS,
      withinBudget: quantile(lat, 0.95) < BUDGET_P95_MS,
      chromium: browser.version()
    }
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.withinBudget) process.exitCode = 1
  } finally {
    await browser?.close()
    await stop(spike, 'SIGTERM')
    await stop(deckd, 'SIGTERM')
    await fake.cleanup()
    await rt.cleanup()
  }
}

main().catch((err) => {
  process.stderr.write(`keystroke-echo: ${err.stack ?? err.message}\n`)
  process.exitCode = 2
})
