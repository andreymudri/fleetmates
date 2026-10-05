// Keystroke echo latency through Focus (M2 Task 15; replaces the M0 spike's keystroke-echo.spec.mjs and keeps
// its contract): Chromium Focus page -> deck server WebSocket terminal channel -> deckd -> PTY -> fake claude
// (echo.json) -> deckd -> deck server -> page -> xterm.js DOM rows.
//
// Not part of `npm test`. Run with `node hub/test/perf/focus-echo.mjs` (a short TMPDIR, as for every hub test).
// It starts its own deckd (DECKD_LOGIN_ENV=inherit, so no login shell runs) and deck server as separate
// processes on a private HOME and XDG_RUNTIME_DIR, spawns one wrapped fake claude on the echo.json script through
// deckd, opens the session's Focus page in the system Chromium (CHROMIUM_PATH, default /usr/bin/chromium,
// headless) through playwright-core, types KEYS single letters KEY_SPACING_MS apart into the Focus terminal and
// measures, inside the page, the time from each keydown to the first render of the terminal's DOM rows that shows
// that many echoed letters. `wire` is the same measure taken when the echo's output frame reaches the page, before
// xterm.js renders it. It refuses to report when the screen does not hold exactly the typed letters, prints one
// JSON line with p50, p95 and max in milliseconds, the environment and the load average, and exits 1 when p95 is
// not under the 50 ms budget (03-architecture.md section 7). It stops every process it started.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectDeckd } from '../../deckd/client.mjs'
import { fakeBin } from '../helpers/fake-bin.mjs'
import { TOKEN, buildWeb, hub, launchBrowser, until } from '../e2e/observe.spec.mjs'
import { environment } from './hook-latency.mjs'

const KEYS = 200
const KEY_SPACING_MS = 20
const BUDGET_P95_MS = 50
const DEADLINE = 15_000
const echoScript = path.join(hub, 'test/fixtures/scripts/echo.json')

/**
 * The value at quantile `q` (nearest rank) of an ascending array.
 * @param {number[]} sorted
 * @param {number} q
 * @returns {number}
 */
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

/** @param {number} n */
const round = n => Math.round(n * 100) / 100

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address()
      server.close(() => resolve(port)) })
  })
}

/**
 * Start a node child by absolute path and resolve once its stderr matches `ready`.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {RegExp} ready
 */
function child(args, env, ready) {
  const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  proc.stderr.on('data', chunk => { err += chunk })
  const started = until(() => {
    if (proc.exitCode !== null) throw Error(`${args[0]} exited ${proc.exitCode}: ${err}`)
    return ready.test(err)
  }, { timeout: DEADLINE, message: `${args[0]} to start` })
  return { proc, started }
}

/**
 * Stop a child: SIGTERM, then SIGKILL after 3 s.
 * @param {import('node:child_process').ChildProcess | undefined} proc
 */
async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const gone = new Promise(resolve => proc.once('exit', resolve))
  proc.kill('SIGTERM')
  await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 3000))])
  if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL')
    await gone }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'perf-echo-'))
  const env = { HOME: path.join(root, 'home'), XDG_RUNTIME_DIR: path.join(root, 'r') }
  const fakeLog = path.join(root, 'fake-claude.log')
  const fake = await fakeBin({ script: echoScript, log: fakeLog })
  let web
  let deckd
  let server
  let client
  let browser
  try {
    await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
    await mkdir(path.join(env.HOME, '.claude'), { recursive: true })
    const state = path.join(env.HOME, '.local/state/fleetmates/deck')
    await mkdir(state, { recursive: true, mode: 0o700 })
    await writeFile(path.join(state, 'token'), TOKEN, { mode: 0o600 })
    web = await buildWeb()
    const launcher = path.join(root, 'server.mjs')
    await writeFile(launcher, `import { startDeckServer } from ${JSON.stringify(pathToFileURL(path.join(hub, 'server/main.mjs')).href)}\nconst deck = await startDeckServer({ staticDir: process.env.DECK_WEB, notifications: false })\nprocess.stderr.write('listening ' + deck.address().port + '\\n')\nprocess.once('SIGTERM', () => deck.close().then(() => process.exit(0)))\n`)
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const d = child([path.join(hub, 'deckd/main.mjs')], { ...env, PATH: fake.env.PATH, DECKD_LOGIN_ENV: 'inherit' }, /deckd listening on/)
    deckd = d.proc
    await d.started
    const s = child([launcher], { ...env, PATH: process.env.PATH, DECK_PORT: String(port), DECK_WEB: web.dir }, /listening \d+/)
    server = s.proc
    await s.started
    // Focus opens without a completed First run, so the run skips it.
    const api = route => fetch(base + route, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: base } })

    client = await connectDeckd({ runtimeDir: env.XDG_RUNTIME_DIR, kind: 'terminal', name: 'perf' })
    const cwd = path.join(root, 'dev', 'echo')
    await mkdir(cwd, { recursive: true })
    const { ptyId } = await client.request('spawn', { argv: ['claude'], cwd, cols: 120, rows: 40, origin: 'wrapped',
      env: { ...env, PATH: fake.env.PATH, FAKE_CLAUDE_SCRIPT: echoScript, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_VERSION: '2.1.282' } })
    const session = await until(async () => (await (await api('/api/sessions')).json()).sessions.find(row => row.ptyId === ptyId), { timeout: DEADLINE, message: 'the session row' })
    // The fake puts its tty in raw mode before it logs `ready`; a key typed earlier is echoed twice.
    await until(async () => (await readFile(fakeLog, 'utf8').catch(() => '')).includes('"ready":true'), { timeout: DEADLINE, message: 'fake claude to be ready' })

    browser = await launchBrowser()
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    // Before the page script runs: stamp every echoed letter as its output frame reaches the page, so the render
    // share can be told apart. A frame is byte 0 the kind (1 output), byte 1 the id length, the id, the bytes.
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window)
      w.wireAt = []
      const Native = w.WebSocket
      w.WebSocket = class extends Native {
        /** @param {any[]} args */
        constructor(...args) {
          super(...args)
          this.addEventListener('message', (/** @type {MessageEvent} */ event) => {
            if (!(event.data instanceof ArrayBuffer)) return
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 1) return
            const now = performance.now()
            const text = new TextDecoder().decode(bytes.subarray(2 + bytes[1]))
            const letters = text.replace(/[^a-z]/g, '').length
            for (let k = 0; k < letters; k++) w.wireAt.push(now)
          })
        }
      }
    })
    await page.goto(`${base}/s/${encodeURIComponent(session.id)}#token=${TOKEN}`)
    await page.waitForSelector('.terminal-view .xterm-rows', { timeout: DEADLINE })
    await page.waitForSelector('.terminal-view .terminal-skeleton', { state: 'detached', timeout: DEADLINE })
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), null, { timeout: DEADLINE })

    // In the page: stamp every keydown, and on every DOM change of the rows count the echoed letters; key i is
    // rendered once i + 1 letters show.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      w.keyAt = []
      w.shownAt = []
      w.wireAt.length = 0
      const rows = /** @type {Element} */ (document.querySelector('.terminal-view .xterm-rows'))
      document.addEventListener('keydown', () => { w.keyAt.push(performance.now()) }, true)
      new MutationObserver(() => {
        const now = performance.now()
        const shown = (rows.textContent ?? '').replace(/[^a-z]/g, '').length
        while (w.shownAt.length < shown && w.shownAt.length < w.keyAt.length) w.shownAt.push(now)
      }).observe(rows, { childList: true, subtree: true, characterData: true })
    })
    const loadStart = environment().loadavg
    let typed = ''
    for (let i = 0; i < KEYS; i++) {
      const key = String.fromCharCode(97 + (i % 26))
      typed += key
      await page.keyboard.press(key)
      await page.waitForTimeout(KEY_SPACING_MS)
    }
    await page.waitForFunction(n => /** @type {any} */ (window).shownAt.length >= n, KEYS, { timeout: DEADLINE })
    const { keyAt, shownAt, wireAt } = await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      return { keyAt: w.keyAt, shownAt: w.shownAt, wireAt: w.wireAt }
    })
    // A duplicated or lost echo would shift every key onto another key's render time, so the screen must hold
    // exactly the typed letters.
    const onScreen = await page.evaluate(() => (document.querySelector('.terminal-view .xterm-rows')?.textContent ?? '').replace(/[^a-z]/g, ''))
    if (onScreen !== typed) throw Error(`the terminal shows ${JSON.stringify(onScreen)}, not the ${KEYS} typed letters`)
    if (keyAt.length !== KEYS) throw Error(`expected ${KEYS} keydown events, saw ${keyAt.length}`)
    if (wireAt.length !== KEYS) throw Error(`expected ${KEYS} echoed letters on the WebSocket, saw ${wireAt.length}`)
    const since = at => keyAt.map((t, i) => at[i] - t).sort((a, b) => a - b)
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
      loadavgStart: loadStart,
      environment: environment(browser)
    }
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.withinBudget) process.exitCode = 1
  } finally {
    await browser?.close()
    client?.close()
    await stop(server)
    await stop(deckd)
    await web?.cleanup()
    await fake.cleanup()
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`focus-echo: ${error.stack ?? error.message}\n`)
    process.exitCode = 2
  })
}
