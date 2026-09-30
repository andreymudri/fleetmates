// Idle CPU of deckd plus the web server with 10 sessions (docs/deck/09-testing.md section 9, budget:
// under 2% of one core, 03-architecture 7). Starts real deckd and the real deck server as separate
// processes on a temporary HOME and XDG_RUNTIME_DIR, spawns 10 fake `claude` sessions through deckd that
// fire their hooks through the real deck-hook and then sit on the idle-input frame, connects the built app
// in headless Chromium, lets it settle, and samples utime + stime from /proc/<pid>/stat of both processes
// for DURATION seconds (default 60). Then it repeats with 10 sessions redrawing the spinner frame every
// 100 ms and reports that too (reported, not gated). Prints one JSON line; exits 1 when idle is over 2%.
//
// Not part of `npm test`. Every hook walks its process ancestry for a `claude` process, so run it
// outside a Claude Code session, or detached:
//   mkdir -p /tmp/hx/perf && TMPDIR=/tmp/hx/perf setsid -f node hub/test/perf/idle-cpu.mjs > /tmp/hx/perf/idle.json
import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectDeckd } from '../../deckd/client.mjs'
import { transformHooks } from '../../server/setup/hooks.mjs'
import { TOKEN, buildWeb, hub, launchBrowser, until } from '../e2e/observe.spec.mjs'
import { claudeAncestor, environment } from './hook-latency.mjs'

const DURATION_S = Number(process.env.DURATION ?? 60)
const SESSIONS = 10
const BUDGET_PERCENT = 2
const TICKS = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())

const scripts = {
  idle: { sessionId: 'auto', steps: [
    { hook: 'SessionStart', with: { source: 'startup' } },
    { sleep: 200 },
    { hook: 'UserPromptSubmit', with: { prompt: 'idle perf session' } },
    // The deck hooks are async; a turn takes time, so the Stop hook starts after the prompt's.
    { sleep: 500 },
    { hook: 'Stop', with: { stop_hook_active: false } },
    { frame: 'idle-input' },
    { hang: {} }
  ] },
  spinning: { sessionId: 'auto', steps: [
    { hook: 'SessionStart', with: { source: 'startup' } },
    { sleep: 200 },
    { hook: 'UserPromptSubmit', with: { prompt: 'spinning perf session' } },
    { frame: 'spinner', forMs: (DURATION_S + 40) * 1000, tickMs: 100 },
    { hang: {} }
  ] }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address()
      server.close(() => resolve(port)) })
  })
}

function child(args, env, ready) {
  const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  proc.stderr.on('data', chunk => { err += chunk })
  return { proc, ready: until(async () => ready(err), { timeout: 15_000, message: `${args[0]} to start: ${err}` }) }
}

async function cpuTicks(pid) {
  const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).replace(/^.*\) /s, '').split(' ')
  return Number(fields[11]) + Number(fields[12])
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const gone = new Promise(resolve => proc.once('exit', resolve))
  proc.kill('SIGTERM')
  await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 3000))])
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
}

async function measure(mode, web, browser) {
  const root = await mkdtemp(path.join(tmpdir(), 'perf-cpu-'))
  // Desktop notifiers and sound players on PATH are no-op stubs, so no popup reaches the desktop.
  const bin = path.join(root, 'bin')
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: path.join(root, 'home'), XDG_RUNTIME_DIR: path.join(root, 'r') }
  let deckd
  let server
  let client
  try {
    await mkdir(path.join(env.HOME, '.claude'), { recursive: true })
    await mkdir(bin)
    for (const name of ['notify-send', 'pw-play', 'paplay', 'makoctl']) await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 3\n', { mode: 0o700 })
    // deckd spawns only a binary named claude: this one execs the fake.
    await writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(hub, 'test/fake-claude/fake-claude.mjs'))} "$@"\n`, { mode: 0o700 })
    await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
    const state = path.join(env.HOME, '.local/state/fleetmates/deck')
    await mkdir(state, { recursive: true, mode: 0o700 })
    await writeFile(path.join(state, 'token'), TOKEN, { mode: 0o600 })
    // As after `init`: the hook script in the data directory, registered in ~/.claude/settings.json.
    const hookFile = path.join(env.HOME, '.local/share/fleetmates-deck/hook/deck-hook.mjs')
    await mkdir(path.dirname(hookFile), { recursive: true, mode: 0o700 })
    await copyFile(path.join(hub, 'hook/deck-hook.mjs'), hookFile)
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(hookFile)}`
    await writeFile(path.join(env.HOME, '.claude/settings.json'), JSON.stringify(transformHooks({}, command), null, 2))
    const script = path.join(root, `${mode}.json`)
    await writeFile(script, JSON.stringify(scripts[mode]))
    const launcher = path.join(root, 'server.mjs')
    await writeFile(launcher, `import { startDeckServer } from ${JSON.stringify(pathToFileURL(path.join(hub, 'server/main.mjs')).href)}\nconst deck = await startDeckServer({ staticDir: process.env.DECK_WEB })\nprocess.stderr.write('listening ' + deck.address().port + '\\n')\nprocess.once('SIGTERM', () => deck.close().then(() => process.exit(0)))\n`)
    const port = await freePort()
    const started = child([path.join(hub, 'deckd/main.mjs')], env, err => /deckd listening on/.test(err))
    deckd = started.proc
    await started.ready
    const web2 = child([launcher], { ...env, DECK_PORT: String(port), DECK_WEB: web }, err => /listening \d+/.test(err))
    server = web2.proc
    await web2.ready
    const base = `http://127.0.0.1:${port}`
    const api = async route => (await fetch(base + route, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
    const write = (route, body) => fetch(base + route, { method: route.endsWith('prefs') ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) })
    await write('/api/prefs', { bell: false })
    const completed = await write('/api/setup/complete')
    if (completed.status !== 200) throw Error(`First run did not complete: ${completed.status}`)
    client = await connectDeckd({ runtimeDir: env.XDG_RUNTIME_DIR, kind: 'terminal', name: 'perf' })
    for (let i = 0; i < SESSIONS; i++) {
      const cwd = path.join(root, 'dev', `${mode}-${i}`)
      await mkdir(cwd, { recursive: true })
      await client.request('spawn', { argv: [path.join(bin, 'claude')], cwd, cols: 120, rows: 40, origin: 'wrapped',
        env: { ...env, FAKE_CLAUDE_SCRIPT: script } })
    }
    const want = mode === 'idle' ? 'idle' : 'running'
    let seen = []
    await until(async () => {
      seen = (await api('/api/sessions')).sessions.map(row => `${row.origin}:${row.state}`)
      return seen.filter(row => row.endsWith(`:${want}`)).length === SESSIONS
    }, { timeout: 30_000, interval: 250 }).catch(error => { throw Error(`${error.message}: ${SESSIONS} ${want} sessions, saw ${JSON.stringify(seen)}`) })
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    const page = await context.newPage()
    await page.goto(`${base}/#token=${TOKEN}`)
    await page.waitForSelector('section.home', { timeout: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 5000))
    const pids = { deckd: deckd.pid, server: server.pid }
    const first = { deckd: await cpuTicks(pids.deckd), server: await cpuTicks(pids.server) }
    const loadStart = environment().loadavg
    const startedAt = process.hrtime.bigint()
    await new Promise(resolve => setTimeout(resolve, DURATION_S * 1000))
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9
    const last = { deckd: await cpuTicks(pids.deckd), server: await cpuTicks(pids.server) }
    const percent = name => Math.round((last[name] - first[name]) / TICKS / seconds * 100 * 100) / 100
    const sessions = (await api('/api/sessions')).sessions.map(row => row.state)
    await context.close()
    return { mode, sessions: sessions.length, states: [...new Set(sessions)], seconds: Math.round(seconds * 10) / 10,
      percentOfOneCore: { deckd: percent('deckd'), server: percent('server'), total: Math.round((percent('deckd') + percent('server')) * 100) / 100 },
      loadavgStart: loadStart, loadavgEnd: environment().loadavg }
  } finally {
    client?.close()
    await stop(server)
    await stop(deckd)
    await rm(root, { recursive: true, force: true })
  }
}

async function main() {
  const ancestor = claudeAncestor()
  if (ancestor) throw Error(`a claude process (pid ${ancestor}) is an ancestor: every hook would claim it and the sessions would merge. Run detached with setsid -f.`)
  const web = await buildWeb()
  const browser = await launchBrowser()
  try {
    const idle = await measure('idle', web.dir, browser)
    const spinning = await measure('spinning', web.dir, browser)
    const result = { sessions: SESSIONS, durationS: DURATION_S, clockTicks: TICKS, idle, spinning, budgetPercent: BUDGET_PERCENT,
      withinBudget: idle.percentOfOneCore.total < BUDGET_PERCENT, environment: environment(browser) }
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!result.withinBudget) process.exitCode = 1
  } finally {
    await browser.close()
    await web.cleanup()
  }
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`idle-cpu: ${error.stack ?? error.message}\n`)
    process.exitCode = 2
  })
}
