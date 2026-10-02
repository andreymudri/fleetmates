// M2 Control end to end (docs/deck/09-testing.md sections 2 and 12, 12-milestones.md section 4 exit criteria
// 1 to 5): the built app served by the real deck server, a real deckd started in this process with an
// explicit login environment (so no login shell runs), the real deck-hook registered in a temporary HOME,
// and fake claude (hub/test/fake-claude/fake-claude.mjs) as `claude` on the login PATH, driven in headless
// Chromium through playwright-core. The fixture is hub/test/fixtures/ui/control.json.
//
// The fake runs as `node <dir>/fake/claude`, a symlink named `claude` to fake-claude.mjs, so deck-hook's
// process walk stops at the fake and every PTY session has its own claude process, as with real Claude
// Code; the suite can therefore run inside a Claude Code session.
//
// Not part of `npm --prefix hub test` (its glob is test/**/*.test.mjs). Run with:
//   mkdir -p /tmp/hx/e2e && TMPDIR=/tmp/hx/e2e node --test hub/test/e2e/control.spec.mjs
// CHROMIUM_PATH overrides /usr/bin/chromium.
//
// This file also exports the harness accessibility.spec.mjs and security.spec.mjs use. Its tests register
// only when it is the entry file (`import.meta.main`), so importing it runs nothing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import nodePty from 'node-pty'
import { makeEnvelope } from '../../hook/deck-hook.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { deckHookCommand, transformHooks } from '../../server/setup/hooks.mjs'
import { firstPromptKeys } from '../../server/launch/launch.mjs'
import { fleetmatesScriptsDir } from '../../server/adapters/fleetmates.mjs'
import { TOKEN, buildWeb, envelopeFor, fixture, hookPayload, hub, launchBrowser, openDeck, until } from './observe.spec.mjs'

/** The parsed `hub/test/fixtures/ui/control.json`. */
export const control = JSON.parse(await readFile(new URL('../fixtures/ui/control.json', import.meta.url), 'utf8'))
const rootState = await import(pathToFileURL(path.join(fleetmatesScriptsDir(), 'state.mjs')).href)
const fakeClaude = path.join(hub, 'test/fake-claude/fake-claude.mjs')
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Deck Test', '-c', 'user.email=deck-test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' })

/**
 * Replace the fixture's `/home/you` placeholder with a real directory, everywhere in a JSON value.
 * @template T
 * @param {T} value
 * @param {string} home
 * @returns {T}
 */
export function placed(value, home) {
  return JSON.parse(JSON.stringify(value).replaceAll(control.home, home))
}

function writeLines(socketPath, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    socket.once('error', reject)
    socket.once('connect', () => socket.end(lines.join(''), resolve))
  })
}

/**
 * A `connectDeckd` that can cut the server off from a running deckd: `down()` refuses new connections and
 * closes every live link (the server sees deckd go away while every PTY keeps running), `up()` lets the next
 * reconnect attempt through.
 */
function deckdGate() {
  let open = true
  const links = new Set()
  return {
    async connect(options) {
      if (!open) throw Object.assign(Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      const { connectDeckd } = await import('../../deckd/client.mjs')
      const link = await connectDeckd(options)
      links.add(link)
      link.on('close', () => links.delete(link))
      return link
    },
    down() {
      open = false
      for (const link of [...links]) link.close()
    },
    up() { open = true }
  }
}

/**
 * Every line of a fake claude log as a parsed JSON entry.
 * @param {string} file
 * @returns {object[]}
 */
export function logEntries(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Every byte a fake claude logged as input, joined. */
export const typedInto = file => logEntries(file).filter(entry => typeof entry.input === 'string').map(entry => entry.input).join('')

/**
 * Create the fixture's repos (git repositories under the scan root) and, unless `team` is false, the team
 * run: plan and status files, the run branch, the task worktrees recorded in the fleetmates index, and the
 * plan markdown.
 * @param {string} home
 * @param {{ team?: boolean, repos?: string[] }} options
 */
async function makeRepos(home, { team = true, repos = control.repos } = {}) {
  const dev = placed(control.scanRoot, home)
  await mkdir(dev, { recursive: true })
  for (const name of repos) {
    const repo = path.join(dev, name)
    await mkdir(repo, { recursive: true })
    git(repo, 'init', '-q')
    await writeFile(path.join(repo, 'README.md'), `${name}\n`)
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-q', '-m', 'init')
  }
  if (!team) return null
  const spec = placed(control.team, home)
  const repo = fs.realpathSync(path.join(dev, spec.repo))
  git(repo, 'branch', spec.runBranch)
  const planFile = path.join(repo, spec.planPath)
  await mkdir(path.dirname(planFile), { recursive: true })
  await writeFile(planFile, spec.planMarkdown)
  const runDir = path.join(repo, '.fleetmates', spec.runId)
  await mkdir(runDir, { recursive: true })
  const now = Date.now()
  const gates = Object.fromEntries(Object.entries(spec.gates).map(([phase, gate]) => {
    const [hours, minutes] = gate.at.split(':').map(Number)
    const at = new Date()
    at.setHours(hours, minutes, 0, 0)
    return [phase, { verdict: gate.verdict, failed: [], optionalFailed: [], skipped: [], pending: [], phase: Number(phase), recordedAt: at.getTime() }]
  }))
  const plan = { runId: spec.runId, totalPhases: spec.totalPhases, planPath: spec.planPath, runBranch: spec.runBranch,
    tasks: spec.tasks.map(task => ({ id: task.id, title: task.title, phase: task.phase, files: task.files ?? [], deps: task.deps ?? [] })) }
  const status = { runId: spec.runId, phase: spec.statusPhase, totalPhases: spec.totalPhases, maxParallel: 4, gates,
    tasks: spec.tasks.map(task => ({ id: task.id, state: task.state, ...(task.startedMinutesAgo ? { startedAt: now - task.startedMinutesAgo * 60_000 } : {}) })) }
  await writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2))
  await writeFile(path.join(runDir, 'status.json'), JSON.stringify(status, null, 2))
  const worktrees = {}
  for (const taskId of spec.worktrees) {
    const worktree = path.join(home, 'wt', taskId)
    const branch = `fleetmates/${spec.runId}/${taskId}`
    git(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
    await rootState.writeLocation(repo, spec.runId, taskId, { worktree: fs.realpathSync(worktree), branch })
    worktrees[taskId] = fs.realpathSync(worktree)
  }
  return { ...spec, repo, runDir, plan, status, worktrees }
}

/**
 * Start a control deck: a real deckd (in process, explicit login environment), the real deck server on the
 * built app, deck-hook registered in a temporary HOME, the fixture repos and team run, and fake claude as
 * `claude`. First run is complete, the scan root is the fixture's and the repos are scanned.
 * @param {{ after?: Function }} t test context; its `after` stops and removes everything
 * @param {{ web: string, team?: boolean, repos?: string[], launchScript?: string | object, runPollMs?: number, port?: number,
 *   prepare?: (context: { home: string, team: object | null }) => Promise<void> }} options
 */
export async function startControl(t, options) {
  const { startDeckd } = await import('../../deckd/main.mjs')
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'ctl-'))
  const home = path.join(dir, 'home')
  const runtime = path.join(dir, 'r')
  await mkdir(runtime, { mode: 0o700 })
  await mkdir(path.join(home, '.claude'), { recursive: true })
  const env = { HOME: home, XDG_RUNTIME_DIR: runtime, PATH: process.env.PATH }
  const paths = setupPaths(env)
  await mkdir(paths.state, { recursive: true, mode: 0o700 })
  await writeFile(paths.token, TOKEN, { mode: 0o600 })
  // As after `init`: the hook script in the data directory, registered in ~/.claude/settings.json.
  await mkdir(path.dirname(paths.hook), { recursive: true, mode: 0o700 })
  await copyFile(path.join(hub, 'hook/deck-hook.mjs'), paths.hook)
  await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify(transformHooks({}, deckHookCommand(process.execPath, paths.hook)), null, 2))
  // `claude` on the login PATH execs node on a symlink named `claude`, so deck-hook's walk finds the fake.
  const bin = path.join(dir, 'bin')
  await mkdir(path.join(dir, 'fake'), { recursive: true })
  await mkdir(bin)
  await symlink(fakeClaude, path.join(dir, 'fake', 'claude'))
  await writeFile(path.join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, 'fake', 'claude'))} "$@"\n`, { mode: 0o755 })
  const team = await makeRepos(home, { team: options.team !== false, repos: options.repos })
  // Files the server must find on its first read of the runs (the run reader caches each run for 60 s).
  await options.prepare?.({ home, team })
  const launchScript = path.join(dir, 'launch.json')
  const launchLog = path.join(dir, 'launch.log')
  const writeScript = async (file, script) => {
    const value = typeof script === 'string' ? JSON.parse(await readFile(path.join(hub, 'test/fixtures/scripts', `${script}.json`), 'utf8')) : script
    await writeFile(file, JSON.stringify(value))
  }
  await writeScript(launchScript, options.launchScript ?? control.sessions.idle)
  const loginEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: runtime, TERM: 'xterm-256color',
    FAKE_CLAUDE_SCRIPT: launchScript, FAKE_CLAUDE_LOG: launchLog, FAKE_CLAUDE_VERSION: control.claudeCodeVersion }
  const startOwnDeckd = () => startDeckd({ runtimeDir: runtime, version: '0.2.0', loginEnv })
  let deckd = await startOwnDeckd()
  const gate = deckdGate()
  const runCommand = (file, args) => {
    if (file === 'claude') return { status: 0, stdout: `${control.claudeCodeVersion} (Claude Code)\n`, stderr: '' }
    if (file === 'systemctl' && args.includes('is-active')) return { status: 0, stdout: 'active\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  // The opener is recorded, never run: no test may reach the desktop's real xdg-open.
  const opened = []
  const services = { open: async file => { opened.push(file) } }
  const start = port => startDeckServer({ env, port, staticDir: options.web, notifications: false, connectDeckd: gate.connect, runCommand,
    reconnectMs: 300, runPollMs: options.runPollMs ?? 500, services })
  const { connectDeckd } = await import('../../deckd/client.mjs')
  const terminal = await connectDeckd({ runtimeDir: runtime, kind: 'terminal', name: 'control-harness' })
  const h = {
    dir, home, env, paths, team, runtime, launchScript, launchLog, loginEnv, gate, bin, terminal, opened,
    deck: await start(options.port ?? 0),
    get deckd() { return deckd },
    get port() { return this.savedPort },
    get base() { return `http://127.0.0.1:${this.savedPort}` },
    get hooksSocket() { return path.join(runtime, 'fleetmates-deck', 'hooks.sock') },
    contexts: new Set(),
    /** Authorized JSON request to the deck API. */
    async api(route, method = 'GET', body) {
      const response = await fetch(h.base + route, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: h.base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } })
      const text = await response.text()
      return { status: response.status, data: text ? JSON.parse(text) : null }
    },
    /** The projector's snapshot row of a session id. */
    session(id) { return h.deck.projector.snapshot().sessions.find(row => row.id === id) },
    /** The live session row a deckd PTY id belongs to. */
    sessionOfPty(ptyId) { return h.deck.projector.snapshot().sessions.find(row => row.ptyId === ptyId) },
    /** The repo row (with its `repoKey`) of a fixture repo name. */
    async repo(name) { return (await h.api('/api/repos')).data.repos.find(row => row.name === name) },
    /** Use `script` (a fixture name or inline script) for the next launched session. */
    setLaunchScript: script => writeScript(launchScript, script),
    /**
     * Spawn a wrapped fake claude in a fixture repo through deckd, as `fm claude` does, and wait for its session row.
     * @param {string} repo fixture repo name
     * @param {string | object} script
     */
    async wrapped(repo, script = 'echo') {
      const n = (h.spawned = (h.spawned ?? 0) + 1)
      const file = path.join(dir, `wrapped-${n}.json`)
      const log = path.join(dir, `wrapped-${n}.log`)
      await writeScript(file, script)
      const cwd = path.join(placed(control.scanRoot, home), repo)
      const { ptyId } = await terminal.request('spawn', { cwd, argv: ['claude'], cols: 100, rows: 30, origin: 'wrapped',
        env: { ...loginEnv, FAKE_CLAUDE_SCRIPT: file, FAKE_CLAUDE_LOG: log } })
      const row = await until(() => h.sessionOfPty(ptyId), { message: `the session row of ${repo}` })
      await until(() => logEntries(log).some(entry => entry.ready), { message: `the fake claude in ${repo} to be ready` })
      return { ...row, ptyId, log, cwd }
    },
    /** Send ready-made envelopes through the real hooks socket and wait until the store has every one. */
    async send(envelopes) {
      const count = () => h.deck.store.get('SELECT COUNT(*) AS n FROM hook_events').n + h.deck.store.get('SELECT COUNT(*) AS n FROM rejected_events').n
      const before = count()
      await writeLines(h.hooksSocket, envelopes.map(row => JSON.stringify(row) + '\n'))
      await until(() => count() >= before + envelopes.length, { message: `${envelopes.length} hook envelopes to be stored` })
    },
    /** Send observed-session hook envelopes (no process identity) through the real hooks socket. */
    async observe(session, steps = session.hooks) {
      const now = Date.now()
      const lines = steps.map(step => {
        const { e, ago = 0, ...fields } = placed(step, home)
        const hook = hookPayload(e, {
          session_id: session.sessionId ?? `fx-control-${session.key}`,
          cwd: session.cwd ?? path.join(placed(control.scanRoot, home), session.repo),
          transcript_path: path.join(home, '.claude/projects/fixture', `${session.sessionId ?? session.key}.jsonl`),
          ...(e === 'SessionStart' ? { source: 'startup' } : {}),
          ...(e === 'Stop' ? { stop_hook_active: false } : {}),
          ...fields
        })
        return JSON.stringify({ ...makeEnvelope(hook, { hookTs: now - Math.round(ago * 1000), ptyId: null }), pidChain: [], claudePid: null }) + '\n'
      })
      const count = () => h.deck.store.get('SELECT COUNT(*) AS n FROM hook_events').n
      const before = count()
      await writeLines(h.hooksSocket, lines)
      await until(() => count() >= before + lines.length, { message: `${lines.length} hook envelopes to be stored` })
      const sessionId = session.sessionId ?? `fx-control-${session.key}`
      return h.deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', sessionId)?.id
    },
    /** Load the fixture's observed sessions; returns a map of fixture key to session id. */
    async observed() {
      const ids = new Map()
      for (const session of control.sessions.observed) ids.set(session.key, await h.observe(session))
      return ids
    },
    /**
     * Feed the team run's lead: SessionStart in the repo, the `--run` Bash call that makes it the lead, a tool
     * step in each worktree and the two attributed permission requests. Returns the lead's session id.
     */
    async teamLead({ requests = true, prompt = team.lead.prompt } = {}) {
      const spec = team
      const lead = { sessionId: spec.lead.sessionId, cwd: spec.repo }
      await h.observe(lead, [
        { e: 'SessionStart', ago: 4000 },
        { e: 'UserPromptSubmit', ago: 3900, prompt },
        { e: 'PreToolUse', ago: 3000, tool_name: 'Bash', tool_input: { command: spec.lead.command } }
      ])
      let ago = 600
      for (const [taskId, steps] of Object.entries(spec.steps)) {
        for (const step of steps) {
          await h.observe({ sessionId: spec.lead.sessionId, cwd: spec.worktrees[taskId] }, [
            { e: 'PreToolUse', ago: ago--, ...step }, { e: 'PostToolUse', ago: ago--, ...step }])
        }
      }
      if (requests) {
        for (const request of spec.requests) {
          await h.observe({ sessionId: spec.lead.sessionId, cwd: spec.worktrees[request.taskId] }, [
            { e: 'PreToolUse', ago: ago--, tool_name: 'Bash', tool_input: { command: request.command } },
            { e: 'PermissionRequest', ago: ago--, tool_name: 'Bash', tool_input: { command: request.command } }])
        }
      }
      return h.deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', spec.lead.sessionId).id
    },
    /** Stop the server and start a new one on the same port and state. */
    async restart() {
      await h.deck.close()
      h.deck = await start(h.savedPort)
    },
    /** Start a new server on the same port and state, after `h.deck.close()`. */
    async startServer() { h.deck = await start(h.savedPort) },
    /** Close deckd (every PTY with it) and start a new one on the same runtime directory. */
    async restartDeckd() {
      await deckd.close()
      deckd = await startOwnDeckd()
    },
    async close() {
      for (const context of h.contexts) await context.close().catch(() => {})
      for (const pty of h.ptys ?? []) { try { pty.kill('SIGKILL') } catch {} }
      terminal.close()
      await h.deck.close().catch(() => {})
      await deckd.close().catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  }
  h.savedPort = h.deck.address().port
  t?.after?.(() => h.close())
  assert.equal((await h.api('/api/prefs', 'PATCH', { scanRoot: placed(control.scanRoot, home), bell: false })).status, 200)
  assert.equal((await h.api('/api/repos/rescan', 'POST')).status, 202)
  await until(async () => (await h.api('/api/repos')).data.repos.length >= (options.repos ?? control.repos).length, { message: 'the fixture repos to be scanned' })
  assert.equal((await h.api('/api/setup/complete', 'POST')).status, 200)
  await until(() => h.deck.link.health().state === 'ok', { message: 'the server to reach deckd' })
  return h
}

/**
 * `fm claude` in its own pseudo terminal (node-pty), in a fixture repo, against the deck's deckd. The fake
 * claude it starts runs `script`; returns the pty, its session row and the fake's log.
 * @param {Awaited<ReturnType<typeof startControl>>} h
 * @param {string} repo
 * @param {string | object} [script]
 */
export async function fmClaude(h, repo, script = 'echo') {
  const n = (h.spawned = (h.spawned ?? 0) + 1)
  const file = path.join(h.dir, `fm-${n}.json`)
  const log = path.join(h.dir, `fm-${n}.log`)
  await writeFile(file, typeof script === 'string' ? await readFile(path.join(hub, 'test/fixtures/scripts', `${script}.json`), 'utf8') : JSON.stringify(script))
  const before = new Set(h.deck.projector.snapshot().sessions.map(row => row.id))
  const pty = nodePty.spawn(process.execPath, [path.join(hub, 'bin/fm.mjs'), 'claude'], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: path.join(placed(control.scanRoot, h.home), repo),
    env: { ...h.loginEnv, TERM_PROGRAM: 'fm-e2e', FAKE_CLAUDE_SCRIPT: file, FAKE_CLAUDE_LOG: log }
  })
  let output = ''
  pty.onData(data => { output += data })
  ;(h.ptys ??= []).push(pty)
  const row = await until(() => h.deck.projector.snapshot().sessions.find(session => !before.has(session.id) && session.origin === 'wrapped' && session.alive), { message: `the fm claude session in ${repo}` })
  await until(() => logEntries(log).some(entry => entry.ready), { message: 'the fake claude under fm to be ready' })
  return { pty, row, log, output: () => output }
}

if (import.meta.main) {
  // Every test gets a deadline, so a hung browser, deckd or server fails the test instead of the run.
  const spec = (name, options, fn) => typeof options === 'function' ? test(name, { timeout: 120_000 }, options) : test(name, { timeout: 120_000, ...options }, fn)
  let web
  let browser
  before(async () => {
    web = await buildWeb()
    browser = await launchBrowser()
  })
  after(async () => {
    await browser?.close()
    await web?.cleanup()
  })
  const deck = (t, options = {}) => startControl(t, { web: web.dir, ...options })
  const focusTerminal = page => page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), null, { timeout: 10_000 })

  spec('harness: a wrapped session echoes what the Focus terminal types', async t => {
    const h = await deck(t, { team: false })
    const vault = await h.wrapped('vault-mcp')
    const page = await openDeck(browser, h, `/s/${vault.id}`)
    await page.waitForSelector('.terminal-view .xterm-rows')
    await focusTerminal(page)
    await page.keyboard.type('hello')
    await until(() => typedInto(vault.log) === 'hello', { message: 'the fake to receive hello' })
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('hello'), null, { timeout: 5000 })
    assert.deepEqual(page.errors, [])
  })

  spec('Focus AC1: busy opens on rustot with every live session listed in urgency order, rustot current, and the waiting pill', async t => {
    const h = await deck(t, { team: false })
    const now = Date.now()
    const busy = fixture('busy')
    await h.send(busy.sessions.flatMap(session => session.hooks.map(step => envelopeFor(session, step, now))))
    for (const key of busy.review) h.deck.projector.signal(h.deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', `fx-busy-${key}`).id, { type: 'review' }, Date.now())
    h.deck.projector.tick(Date.now())
    const idOf = key => h.deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', `fx-busy-${key}`).id
    const page = await openDeck(browser, h, `/s/${idOf('rustot')}`)
    await page.waitForSelector('.focus-list-row')
    const rows = await page.$$eval('.focus-list-row', links => links.map(link => [new URL(link.href).pathname.split('/').pop(), link.getAttribute('aria-current')]))
    const order = [...busy.expect.grid, ...busy.expect.quiet]
    assert.deepEqual(rows.map(([id]) => decodeURIComponent(id)), order.map(idOf), 'one row per live session, in urgency order')
    assert.deepEqual(rows.filter(([, current]) => current === 'page').map(([id]) => decodeURIComponent(id)), [idOf('rustot')], 'rustot is the current row')
    // The PermissionRequest is 540 s old in the fixture: the canvas's "3m" is the same pill at another age.
    assert.equal(await page.textContent('.focus-header .status-pill'), 'Needs approval · 9m')
    assert.deepEqual(page.errors, [])
  })

  spec('Focus AC2 and AC3: the live terminal has focus; ls Enter reaches the PTY and the header says Typing in browser; Alt K opens the palette and sends nothing; Alt P reaches the PTY', async t => {
    const h = await deck(t, { team: false })
    const vault = await h.wrapped('vault-mcp')
    const page = await openDeck(browser, h, `/s/${vault.id}`)
    await page.waitForSelector('.terminal-view .xterm-rows')
    await focusTerminal(page)
    assert.ok(await page.evaluate(() => document.querySelector('.terminal-view').contains(document.activeElement)), 'the terminal section has focus on open (AC1)')
    await page.keyboard.type('ls')
    await page.keyboard.press('Enter')
    await until(() => typedInto(vault.log) === 'ls\r', { message: 'deckd to write ls and Enter to the PTY' })
    await page.locator('.focus-input-text').filter({ hasText: 'Typing in browser' }).waitFor({ timeout: 5000 })
    await page.keyboard.press('Alt+KeyK')
    await page.waitForSelector('.palette-input')
    await page.waitForTimeout(300)
    assert.equal(typedInto(vault.log), 'ls\r', 'Alt K sent no byte to the PTY')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.palette', { state: 'detached' })
    await focusTerminal(page)
    await page.keyboard.press('Alt+KeyP')
    await until(() => typedInto(vault.log) === 'ls\r\u001bp', { message: 'Alt P to reach the PTY as ESC p' })
    assert.deepEqual(page.errors, [])
  })

  spec('Focus AC7: at 1280 x 800 the list is 72 px of avatars and Alt digits, the details panel is hidden, and Alt I opens it as an overlay', async t => {
    const h = await deck(t, { team: false })
    const vault = await h.wrapped('vault-mcp')
    await h.wrapped('discord-audit')
    const page = await openDeck(browser, h, `/s/${vault.id}`, { viewport: { width: 1280, height: 800 } })
    await page.waitForSelector('.terminal-view .xterm-rows')
    assert.equal(await page.$eval('.focus-list', el => Math.round(el.getBoundingClientRect().width)), 72)
    const shown = await page.$$eval('.focus-list-row', rows => rows.map(row => ({
      avatar: !!row.querySelector('svg, img, [role="img"]'),
      kbd: row.querySelector('kbd')?.textContent ?? null,
      text: [...row.querySelectorAll('.focus-list-text')].some(el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
    })))
    assert.deepEqual(shown, [{ avatar: true, kbd: 'Alt 1', text: false }, { avatar: true, kbd: 'Alt 2', text: false }])
    assert.equal(await page.isVisible('#focus-details'), false, 'the details panel is hidden')
    await page.keyboard.press('Alt+KeyI')
    await page.waitForSelector('.focus--drawer-open')
    assert.equal(await page.isVisible('#focus-details'), true, 'Alt I opens the details as an overlay')
    const overlay = await page.$eval('#focus-details', el => getComputedStyle(el).position)
    assert.ok(['fixed', 'absolute'].includes(overlay), `the details overlay is positioned over the page (${overlay})`)
  })

  spec('Focus AC8: an observed session has no terminal input, the observed banner, and neither Stop nor Nudge', async t => {
    const h = await deck(t, { team: false })
    const ids = await h.observed()
    const page = await openDeck(browser, h, `/s/${ids.get('rustot')}`)
    await page.waitForSelector('.focus-steps, .focus-log-empty')
    assert.equal(await page.locator('.xterm-helper-textarea, .terminal-view').count(), 0, 'no TerminalView')
    assert.equal(await page.textContent('.focus-banner--info'), 'Observed session: started as plain claude, read-only here.')
    const buttons = await page.$$eval('.focus-main button', rows => rows.map(row => row.textContent))
    assert.ok(!buttons.some(text => /^Stop|Nudge/.test(text)), `no Stop or Nudge: ${JSON.stringify(buttons)}`)
  })

  spec('Focus AC9: with deckd unreachable the banner shows, the terminal is read-only with the reason, Stop is disabled, and a hook still moves the pill', async t => {
    const h = await deck(t, { team: false })
    const vault = await h.wrapped('vault-mcp', { sessionId: 'auto', steps: [
      { hook: 'SessionStart', with: { source: 'startup' } },
      { hook: 'UserPromptSubmit', with: { prompt: 'index the vault' } },
      { frame: 'spinner', forMs: 200 },
      { sleep: 3000 },
      { hook: 'PermissionRequest', with: { tool_name: 'Bash', tool_input: { command: 'npm run reindex' } } },
      { hang: {} }
    ] })
    await until(() => h.session(vault.id).state === 'running', { message: 'the session to run' })
    const page = await openDeck(browser, h, `/s/${vault.id}`)
    await page.waitForSelector('.terminal-view .xterm-rows')
    const downAt = Date.now()
    h.gate.down()
    await page.waitForSelector('.banner--deckd', { timeout: 10_000 })
    assert.equal(await page.textContent('.focus-reason'), 'deckd is reconnecting')
    assert.equal(await page.getAttribute('.terminal-view', 'data-readonly'), 'true')
    assert.equal(await page.isDisabled('.focus-actions .button--danger'), true, 'Stop is disabled')
    await page.locator('.focus-header .status-pill').filter({ hasText: /^Needs approval/ }).waitFor({ timeout: 10_000 })
    const received = h.deck.store.get("SELECT received_at FROM hook_events WHERE event='PermissionRequest' ORDER BY id DESC LIMIT 1").received_at
    assert.ok(received > downAt, 'the hook arrived during the outage')
    h.gate.up()
    await page.waitForSelector('.banner--deckd', { state: 'detached', timeout: 10_000 })
  })

  spec('Focus AC10: Stop… opens the dialog with Cancel focused; confirming posts the stop and the session ends', async t => {
    const h = await deck(t, { team: false })
    const vault = await h.wrapped('vault-mcp')
    const page = await openDeck(browser, h, `/s/${vault.id}`)
    await page.waitForSelector('.terminal-view .xterm-rows')
    const posts = []
    page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname) })
    await page.click('.focus-actions .button--danger')
    await page.waitForSelector('[role="dialog"].confirm-dialog')
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'Cancel has focus')
    assert.equal(await page.textContent('.confirm-title'), `Stop vault-mcp · ${h.session(vault.id).task || 'Untitled session'}?`)
    await page.click('.confirm-dialog .button--danger')
    await until(() => posts.includes(`/api/sessions/${vault.id}/stop`), { message: 'POST stop' })
    await until(() => !h.session(vault.id).alive, { message: 'the session to end' })
  })

  spec('Focus AC11 and AC12: Mark reviewed turns a done session Reviewed; Down in the changed files moves the selection and shows the M2 diff caption', async t => {
    const h = await deck(t, { team: false })
    const ids = await h.observed()
    const axios = ids.get('axios-like')
    const page = await openDeck(browser, h, `/s/${axios}?tab=changes`)
    await page.waitForSelector('.focus-files')
    const files = await page.$$eval('.focus-file', rows => rows.map(row => [row.querySelector('.focus-file-path').textContent, row.getAttribute('aria-selected')]))
    assert.deepEqual(files.map(([file, selected]) => [file.split('/').slice(-2).join('/'), selected]), [['lib/retry.js', 'true'], ['lib/backoff.js', 'false']])
    await page.focus('.focus-files')
    await page.keyboard.press('ArrowDown')
    assert.deepEqual(await page.$$eval('.focus-file', rows => rows.map(row => row.getAttribute('aria-selected'))), ['false', 'true'])
    assert.equal(await page.getAttribute('.focus-files', 'aria-activedescendant'), 'focus-file-1')
    // FOC-O3 default for M2: the diff itself arrives with M3 approvals; the caption stands in for it.
    assert.equal(await page.textContent('.focus-diff-caption'), 'Diffs arrive with approvals.')
    // At Stop the deck re-reads the changes from git against the baseline taken at SessionStart, so the edits are real.
    const repo = path.join(placed(control.scanRoot, h.home), 'axios-like')
    await mkdir(path.join(repo, 'lib'), { recursive: true })
    for (const file of ['retry.js', 'backoff.js']) await writeFile(path.join(repo, 'lib', file), `// ${file}\n`)
    await h.observe(control.sessions.observed[1], [{ e: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }, { e: 'Stop' }])
    await until(() => h.session(axios).state === 'done', { message: 'axios-like to be done' }).catch(error => { throw Error(`${error.message}: ${JSON.stringify(h.session(axios))}`) })
    await page.locator('.focus-actions button', { hasText: 'Mark reviewed' }).click()
    await page.locator('.focus-header .status-pill').filter({ hasText: 'Reviewed' }).waitFor({ timeout: 5000 })
    assert.equal(h.session(axios).state, 'reviewed')
  })

  const launchTask = control.sessions.launched[0]
  // The browser's xterm answers the idle screen's focus-report and device-attribute queries, as any terminal
  // does. Those replies reach the PTY too; everything else in the fake's input log is what the deck typed.
  const withoutReplies = text => text.replace(/\u001b\[[IO]|\u001b\[\?[\d;]*c/g, '')
  // The fake writes the captured idle frame as is, laid out for the 120 x 40 launch size, and never redraws on a
  // resize as Claude Code does; a browser-sized PTY would wrap the frame and hide the idle box from the deck. So
  // this page attaches at 120 x 40 and keeps its own size to itself.
  const launchSize = () => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        let message = null
        try { message = JSON.parse(data) } catch {}
        if (message?.t === 'term.resize') return undefined
        if (message?.t === 'term.attach') data = JSON.stringify({ ...message, cols: 120, rows: 40 })
      }
      return send.call(this, data)
    }
  }
  const optionNames = page => page.$$eval('.launch-option', rows => rows.map(row => row.querySelector('.launch-option-name')?.textContent))

  spec('New session AC1 and AC2: Alt N opens the form with the Repo combobox focused and Recent harbors first; ?repo= selects the repo and focuses Task', async t => {
    const h = await deck(t, { team: false })
    await h.observed()
    const page = await openDeck(browser, h)
    await page.waitForSelector('.home-header')
    await page.keyboard.press('Alt+KeyN')
    await page.waitForSelector('.launch-dialog[role="dialog"]')
    assert.equal(new URL(page.url()).pathname, '/new')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'new-session-repo', 'the Repo combobox has focus')
    assert.equal(await page.textContent('.launch-group-title'), 'Recent harbors', 'Recent harbors is the first group')
    const recent = await page.$$eval('.launch-group:first-child .launch-option-name', rows => rows.map(row => row.textContent))
    assert.deepEqual([...recent].sort(), ['axios-like', 'rustot'], 'the repos with sessions are the recent harbors')
    const rustot = await h.repo('rustot')
    await page.goto(`${h.base}/new?repo=${encodeURIComponent(rustot.repoKey ?? rustot.name)}`)
    await page.waitForSelector('.launch-dialog')
    await page.waitForFunction(() => document.activeElement?.id === 'new-session-task', null, { timeout: 5000 })
    assert.equal(await page.inputValue('#new-session-repo'), 'rustot')
  })

  spec('New session AC3, AC4 and exit criterion 1: a busy repo warns but launches; Alt Enter posts repoKey and task, opens Focus with the terminal focused, and the task is typed after the idle box', async t => {
    const h = await deck(t, { team: false, launchScript: launchTask.script })
    const ids = await h.observed()
    const states = []
    t.after(h.deck.subscribe(event => { if (event.type === 'session.upserted') states.push([event.data.id, event.data.state]) }))
    const page = await openDeck(browser, h, '/new', { init: launchSize })
    await page.waitForSelector('#new-session-repo')
    await page.fill('#new-session-repo', 'rustot')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.activeElement?.id === 'new-session-task', null, { timeout: 5000 })
    assert.equal(await page.textContent('.launch-banner--hint .launch-banner-text'),
      'rustot already has an active session: rustot · combat-tick (Needs approval). Two plain sessions share one working tree, so their changes mix.')
    assert.equal(await page.isEnabled('.launch-submit'), true, 'Launch stays enabled')
    assert.ok(ids.get('rustot'))
    await page.fill('#new-session-task', launchTask.task)
    const posted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions')
    await page.keyboard.press('Alt+Enter')
    const body = JSON.parse((await posted).postData())
    const rustot = await h.repo('rustot')
    assert.deepEqual(body, { repoKey: rustot.repoKey ?? rustot.name, task: launchTask.task })
    await page.waitForFunction(() => /^\/s\/[^/]+$/.test(location.pathname), null, { timeout: 10_000 })
    assert.equal(await page.locator('.launch-dialog').count(), 0, 'the dialog closed')
    const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
    assert.equal(h.session(id).origin, 'launched')
    await page.waitForSelector('.terminal-view .xterm-rows')
    await focusTerminal(page)
    await until(() => states.some(([row, state]) => row === id && state === 'running'), { timeout: 20_000, message: 'the launched session to reach running' })
      .catch(error => { throw Error(`${error.message}: states ${JSON.stringify(states.filter(([row]) => row === id))}, log ${JSON.stringify(logEntries(h.launchLog))}`) })
    const log = logEntries(h.launchLog)
    const hookAt = log.find(entry => entry.hook === 'SessionStart').ts
    const typed = log.filter(entry => typeof entry.input === 'string')
    assert.equal(withoutReplies(typed.map(entry => entry.input).join('')), firstPromptKeys(launchTask.task), 'the task is typed once, as one paste and Enter')
    const paste = typed.find(entry => entry.input.includes('\u001b[200~'))
    assert.ok(paste.ts - hookAt >= 900, `the task was typed ${paste.ts - hookAt} ms after SessionStart, once the idle box showed`)
    assert.deepEqual(page.errors, [])
  })

  spec('New session AC5: an empty task launches and the session goes idle after SessionStart with nothing typed', async t => {
    const h = await deck(t, { team: false, launchScript: control.sessions.emptyLaunch })
    const page = await openDeck(browser, h, '/new?repo=turbidassist')
    await page.waitForFunction(() => document.activeElement?.id === 'new-session-task', null, { timeout: 5000 })
    await page.click('.launch-submit')
    await page.waitForFunction(() => /^\/s\/[^/]+$/.test(location.pathname), null, { timeout: 10_000 })
    const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
    await until(() => h.session(id)?.state === 'idle', { timeout: 10_000, message: 'the empty launch to go idle' })
    await page.waitForTimeout(300)
    assert.equal(withoutReplies(typedInto(h.launchLog)), '', 'nothing was typed into the PTY')
  })

  spec('New session AC6 and AC7: deckd down disables Launch with the visible reason; a spawn error shows the message and keeps the inputs', async t => {
    const h = await deck(t, { team: false })
    const page = await openDeck(browser, h, '/new?repo=portfolio-site')
    await page.waitForFunction(() => document.activeElement?.id === 'new-session-task', null, { timeout: 5000 })
    await page.fill('#new-session-task', 'ship the hero image')
    // AC7: the repo directory is gone after the scan, so deckd cannot start claude there.
    await rm(path.join(placed(control.scanRoot, h.home), 'portfolio-site'), { recursive: true, force: true })
    await page.click('.launch-submit')
    await page.waitForSelector('.launch-banner--error', { timeout: 10_000 })
    assert.match(await page.textContent('.launch-banner--error'), /^Could not start claude in portfolio-site: .+\.$/)
    assert.equal(await page.inputValue('#new-session-repo'), 'portfolio-site')
    assert.equal(await page.inputValue('#new-session-task'), 'ship the hero image')
    assert.equal(new URL(page.url()).pathname, '/new')
    h.gate.down()
    await page.locator('.launch-reason').filter({ hasText: 'deckd is reconnecting. Launching needs deckd.' }).waitFor({ timeout: 10_000 })
    assert.equal(await page.isDisabled('.launch-submit'), true)
    assert.equal(await page.getAttribute('.launch-submit', 'aria-describedby'), 'new-session-launch-reason')
  })

  spec('New session AC8: Esc keeps a draft, and reopening restores the repo and the task', async t => {
    const h = await deck(t, { team: false })
    const page = await openDeck(browser, h)
    await page.waitForSelector('section.home')
    await page.keyboard.press('Alt+KeyN')
    await page.waitForSelector('#new-session-repo')
    await page.fill('#new-session-repo', 'vault')
    await page.keyboard.press('Enter')
    await page.fill('#new-session-task', 'reindex the notes')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.launch-dialog', { state: 'detached' })
    assert.equal(new URL(page.url()).pathname, '/')
    await page.keyboard.press('Alt+KeyN')
    await page.waitForSelector('#new-session-repo')
    assert.equal(await page.inputValue('#new-session-repo'), 'vault-mcp')
    assert.equal(await page.inputValue('#new-session-task'), 'reindex the notes')
  })

  // Known gap logged by the phase 6 review: on /new the Needs-you drawer (z-index 30, hub/web/src/styles/observe.css:221)
  // opens under the launch scrim (z-index 40, hub/web/src/styles/launch.css:10), so a click meant for the drawer lands
  // on the scrim and cancels the form.
  spec('New session: Alt U opens the Needs-you drawer above the form', { todo: 'the drawer (observe.css:221, z 30) stacks under the launch scrim (launch.css:10, z 40)' }, async t => {
    const h = await deck(t, { team: false })
    await h.observed()
    const page = await openDeck(browser, h, '/new')
    await page.waitForSelector('#new-session-repo')
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer')
    const onTop = await page.$eval('.drawer', drawer => {
      const box = drawer.getBoundingClientRect()
      return drawer.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })
    assert.equal(onTop, true, 'the drawer is the topmost element at its centre')
  })

  spec('New session AC9: a repo name with markup renders as text', async t => {
    const markup = '<img src=x onerror=alert(1)>'
    const h = await deck(t, { team: false, repos: [markup, 'rustot'] })
    const page = await openDeck(browser, h, '/new')
    await page.waitForSelector('.launch-option')
    assert.ok((await optionNames(page)).includes(markup), 'the name is shown literally')
    assert.equal(await page.evaluate(() => document.querySelectorAll('img').length), 0, 'no img element')
    await page.fill('#new-session-repo', '<img')
    await page.waitForSelector('.launch-option')
    assert.deepEqual(await optionNames(page), [markup])
    assert.deepEqual(page.dialogs, [])
  })

  const teamRoute = `/runs/${control.team.repo}/${control.team.runId}`
  /** A control deck with the team lead fed and joined to the run (GET /api/runs names it). */
  const teamDeck = async (t, options = {}) => {
    const h = await deck(t, options)
    const lead = await h.teamLead()
    await until(async () => (await h.api('/api/runs')).data.runs.find(run => run.runId === control.team.runId)?.leadSessionId === lead, { message: 'the run to name its lead' })
    return { h, lead }
  }
  const taskRows = page => page.$$eval('.team-tasks > ul > .team-task, .team-tasks .team-task-list > .team-task', rows => rows.map(row => [row.dataset.task, row.querySelector('.team-task-state')?.textContent.trim()]))
  const panelTexts = page => page.$$eval('.team-crew', panels => Object.fromEntries(panels.map(panel => [panel.id, panel.querySelector('.team-crew-lines')?.textContent ?? ''])))

  spec('Team AC1, AC2, AC3: the timeline, gate, heading and task rows of the canvas run, phase from git and never from status.phase', async t => {
    const { h } = await teamDeck(t)
    const page = await openDeck(browser, h, teamRoute)
    await page.waitForSelector('.team-task')
    const expect = control.team.expect
    assert.equal(await page.locator('.team-phase').count(), expect.phases)
    assert.equal(await page.locator('.team-gate').count(), expect.gates)
    assert.deepEqual(await page.$$eval('.team-gate .team-gate-name', gates => gates.map(gate => gate.textContent)), [expect.gate1, 'Gate 2', 'Gate 3'], 'Gate 1 passed, Gate 2 pending')
    assert.deepEqual(await page.$$eval('.team-phase', phases => phases.map(phase => phase.className.replace('team-phase team-phase--', ''))), ['done', 'active', 'pending', 'pending'],
      'status.json says phase 1; the derived phase 2 is the active one (AC3)')
    assert.equal(await page.textContent('.team-tasks .team-eyebrow'), expect.heading)
    assert.ok((await page.textContent('.team-banner--gate')).startsWith(expect.gateBanner), 'the gate banner reads the recorded time')
    assert.deepEqual(await taskRows(page), expect.rows)
    assert.equal(await page.textContent('.team-actions .button--amber'), expect.review)
    assert.deepEqual(page.errors, [])
  })

  // A lead the run join detects claims no task (runRef.taskId is null), so it is not counted as a worker (TEAM-O7).
  spec('Team AC2: the header pill of the canvas run reads 2 of 4 need you', async t => {
    const { h } = await teamDeck(t)
    const page = await openDeck(browser, h, teamRoute)
    await page.waitForSelector('.team-task')
    assert.equal(await page.textContent('.team-header .status-pill'), control.team.expect.pill)
  })

  spec('Team AC6, AC8 and D-69: Review opens the drawer on the run\'s two requests with focus on T4; a T5 teammate hook appends to the T5 panel within 1 s and nowhere else; the T5 link opens the lead filtered to T5', async t => {
    const { h, lead } = await teamDeck(t)
    // An unrelated request the run filter must leave out.
    await h.observe(control.sessions.observed[0])
    const page = await openDeck(browser, h, teamRoute)
    await page.waitForSelector('#team-crew-T5 .team-crew-steps')
    await page.click('.team-actions .button--amber')
    await page.waitForSelector('.drawer')
    const runRequests = h.deck.store.all('SELECT id, task_id FROM requests WHERE session_id=? AND state=?', lead, 'open')
    assert.deepEqual(runRequests.map(row => row.task_id).sort(), ['T4', 'T5'])
    const shown = await page.$$eval('.drawer-row', rows => rows.map(row => row.dataset.request))
    assert.deepEqual([...shown].sort(), runRequests.map(row => row.id).sort(), 'only the run\'s two requests')
    const focused = await page.evaluate(() => document.activeElement?.closest('.drawer-row')?.dataset.request)
    assert.equal(focused, runRequests.find(row => row.task_id === 'T4').id, 'focus is on the T4 row')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.drawer', { state: 'detached' })

    const before = await panelTexts(page)
    const hook = placed(control.team.teammateHook, h.home)
    const sent = Date.now()
    await h.observe({ sessionId: control.team.lead.sessionId, cwd: h.team.worktrees[hook.taskId] }, [{ e: 'PreToolUse', tool_name: hook.tool_name, tool_input: hook.tool_input }])
    await page.waitForFunction(text => !document.querySelector('#team-crew-T5 .team-crew-lines').textContent.includes(text) ? false : true,
      'Grep', { timeout: 5000 })
    const took = Date.now() - sent
    assert.ok(took < 1000, `the T5 panel changed ${took} ms after the hook (budget 1 s)`)
    const afterTexts = await panelTexts(page)
    assert.deepEqual(Object.keys(afterTexts).filter(id => afterTexts[id] !== before[id]), ['team-crew-T5'], 'no other panel changes')

    await page.click('#team-crew-T5 .team-crew-link')
    await page.waitForFunction(id => location.pathname === `/s/${id}`, lead, { timeout: 5000 })
    await page.waitForSelector('.drawer .drawer-filter')
    assert.equal(await page.textContent('.drawer-filter-text'), 'Requests for T5')
    assert.deepEqual(await page.$$eval('.drawer-row', rows => rows.map(row => row.dataset.request)), [runRequests.find(row => row.task_id === 'T5').id])
  })

  // The server re-reads plan.json and status.json only when the run reader's 60 s poll interval has passed: its
  // file watcher is never armed (hub/server/main.mjs builds the reader without calling `watch`), so each file
  // change below can take up to a minute to reach the page. The waits allow for that and report what they took.
  const RUN_FILE_WAIT_MS = 75_000
  spec('Team AC4, AC5, AC9: a failed task reads Failed, an HTML task title renders as text, and an unreadable status.json shows the error with the last good data dimmed', { timeout: 240_000 }, async t => {
    const { h } = await teamDeck(t)
    const page = await openDeck(browser, h, teamRoute)
    await page.waitForSelector('.team-task')
    const status = path.join(h.team.runDir, 'status.json')
    const failed = structuredClone(h.team.status)
    failed.tasks.find(task => task.id === 'T6').state = 'failed'
    await writeFile(status, JSON.stringify(failed))
    const markup = '<img src=x onerror=alert(1)>'
    const plan = structuredClone(h.team.plan)
    plan.tasks.find(task => task.id === 'T7').title = markup
    await writeFile(path.join(h.team.runDir, 'plan.json'), JSON.stringify(plan))
    let since = Date.now()
    await page.locator('.team-task[data-task="T6"] .team-task-state').filter({ hasText: 'Failed' }).waitFor({ timeout: RUN_FILE_WAIT_MS })
    t.diagnostic(`the status.json and plan.json edits reached the page after ${Date.now() - since} ms`)
    assert.equal(await page.textContent('.team-task[data-task="T6"] .team-task-sub'), 'failed · see fleetmates doctor')
    assert.equal(await page.textContent('.team-task[data-task="T7"] .team-task-title'), markup, 'the HTML title is text')
    assert.equal(await page.evaluate(() => document.querySelectorAll('img').length), 0, 'no img element')
    const good = await taskRows(page)
    await writeFile(status, '{"runId": "gate-cli", "tasks": [')
    since = Date.now()
    await page.waitForSelector('.team-banner--error', { timeout: RUN_FILE_WAIT_MS })
    t.diagnostic(`the unreadable status.json reached the page after ${Date.now() - since} ms`)
    assert.match(await page.textContent('.team-banner--error'), /^status\.json could not be read: .+\. Retrying\./)
    assert.equal(await page.locator('.team-body--dim').count(), 1, 'the body is dimmed')
    assert.deepEqual(await taskRows(page), good, 'the last good rows stay visible')
    assert.deepEqual(page.dialogs, [])
  })

  spec('Team AC7: at 1280 wide the crew panels stack in one column and nothing scrolls sideways', async t => {
    const { h } = await teamDeck(t)
    const page = await openDeck(browser, h, teamRoute, { viewport: { width: 1280, height: 800 } })
    await page.waitForSelector('#team-crew-T5 .team-crew-steps')
    const lefts = await page.$$eval('.team-crew', panels => panels.map(panel => Math.round(panel.getBoundingClientRect().left)))
    assert.ok(lefts.length >= 3, `the lead and the workers have panels: ${lefts.length}`)
    assert.equal(new Set(lefts).size, 1, `one column: ${JSON.stringify(lefts)}`)
    assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no horizontal page scroll')
  })

  const crewTarget = control.crew.target
  const pickCrew = (page, name) => page.selectOption('#crew-repo', { label: name })
  const rectsOf = (page, selector) => page.$eval(selector, svg => [...svg.querySelectorAll('rect')].map(rect => ['x', 'y', 'width', 'fill'].map(name => rect.getAttribute(name)).join(' ')))

  spec('Crew AC1 and AC2: one row per known repo with 5 named pose avatars, each drawn as the CrewAvatar component draws it', async t => {
    const h = await deck(t, { team: false })
    const page = await openDeck(browser, h, '/settings/crew')
    await page.waitForSelector('.crew-grid tbody tr th.crew-repo')
    const repos = (await h.api('/api/repos')).data.repos
    const rows = await page.$$eval('.crew-grid tbody tr', trs => trs.map(tr => [tr.querySelector('th').textContent, [...tr.querySelectorAll('svg[role="img"]')].map(svg => svg.getAttribute('aria-label'))]))
    assert.deepEqual(rows.map(([name]) => name).sort(), repos.map(repo => repo.name).sort(), 'one row per known repo')
    const poses = ['running', 'needs you', 'idle', 'done', 'crashed']
    for (const [name, labels] of rows) assert.deepEqual(labels, poses.map(pose => `${name} crew member, ${pose}`))
    // AC2: crew.md's pixel maps are pinned on the component by the unit tests; here the page must draw exactly what
    // the component renders for rustot and fleetmates in every pose.
    const { runnerImport } = await import('vite')
    const { module } = await runnerImport(path.join(hub, 'web/src/components/CrewAvatar.jsx'), { configFile: false, logLevel: 'silent', root: hub })
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const POSES = ['running', 'needs', 'idle', 'done', 'crashed']
    for (const name of ['rustot', 'fleetmates']) {
      const repo = repos.find(row => row.name === name)
      for (const [index, pose] of POSES.entries()) {
        const html = renderToStaticMarkup(createElement(module.CrewAvatar, { seed: repo.crew.seed || name, slot: repo.crew.slot, hat: repo.crew.hat, pose, size: 'xl', label: 'x' }))
        const expected = [...html.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="1" fill="([^"]+)"/g)].map(m => [m[1], m[2], m[3], m[4]].join(' '))
        const drawn = await rectsOf(page, `svg[aria-label="${name} crew member, ${poses[index]}"]`)
        assert.ok(expected.length > 0, 'the component draws rects')
        assert.deepEqual(drawn, expected, `${name} ${pose}`)
      }
    }
  })

  spec('Crew AC3: Reroll gives rustot the seed rustot#2, the preview changes, and its Home avatar changes without a reload', async t => {
    const h = await deck(t, { team: false })
    const ids = await h.observed()
    const home = await openDeck(browser, h)
    const homeAvatar = () => home.$eval(`article[aria-labelledby="card-title-${ids.get(crewTarget).replace(/[^\w-]/g, '_')}"] svg.crew-avatar`, svg => svg.innerHTML)
    const before = await homeAvatar()
    const page = await openDeck(browser, h, '/settings/crew')
    await page.waitForSelector('#crew-repo')
    await pickCrew(page, crewTarget)
    const preview = () => page.$eval('.crew-preview svg', svg => svg.innerHTML)
    const previewBefore = await preview()
    await page.click('.crew-actions .button--secondary')
    await until(async () => (await h.repo(crewTarget)).crew.seed === `${crewTarget}#2`, { message: 'the seed rustot#2 to be saved' })
    assert.notEqual(await preview(), previewBefore, 'the preview changed shape')
    await until(async () => (await homeAvatar()) !== before, { timeout: 5000, message: 'the Home avatar to change without a reload' })
  })

  spec('Crew AC4, AC5 and the Undo follow-up: with 8 slots taken the colours are the current one and slot 8; picking slot 8 frees the old slot and toasts Undo, and Undo PATCHes the previous values within 6 s', async t => {
    const h = await deck(t, { team: false })
    const repos = (await h.api('/api/repos')).data.repos
    assert.equal(new Set(repos.map(repo => repo.crew.slot)).size, control.crew.slotsTaken, '8 repos hold 8 distinct slots')
    const old = (await h.repo(crewTarget)).crew
    const page = await openDeck(browser, h, '/settings/crew')
    await page.waitForSelector('#crew-repo')
    await pickCrew(page, crewTarget)
    assert.deepEqual(await page.$$eval('.crew-swatch', rows => rows.map(row => [row.getAttribute('aria-label'), row.getAttribute('aria-checked')])),
      [['Current color', 'true'], [`Free color slot ${control.crew.freeSlot}`, 'false']])
    const patches = []
    page.on('request', request => { if (request.method() === 'PATCH') patches.push([new URL(request.url()).pathname, JSON.parse(request.postData()), Date.now()]) })
    await page.click(`.crew-swatch[aria-label="Free color slot ${control.crew.freeSlot}"]`)
    await until(async () => (await h.repo(crewTarget)).crew.slot === control.crew.freeSlot, { message: 'slot 8 to be saved' })
    const after = (await h.api('/api/repos')).data.repos
    assert.ok(!after.some(repo => repo.crew.slot === old.slot), `the old slot ${old.slot} is free for other repos`)
    await page.waitForSelector('.crew-toast')
    assert.equal(await page.textContent('.crew-toast-text'), `${crewTarget}'s crew member updated`)
    const shownAt = Date.now()
    await page.click('.crew-toast button:text-is("Undo")')
    await until(() => patches.length === 2, { message: 'the Undo PATCH' })
    const [route, body, at] = patches[1]
    assert.ok(at - shownAt < 6000, 'Undo was offered and sent within 6 s')
    assert.deepEqual([route, body], [patches[0][0], { seed: old.seed || crewTarget, slot: old.slot, hat: old.hat ?? 'none' }])
    await until(async () => (await h.repo(crewTarget)).crew.slot === old.slot, { message: 'Undo to restore the old slot' })
  })

  spec('Crew AC6: with reduced motion nothing on the Crew page animates, before and after a change', async t => {
    const h = await deck(t, { team: false })
    const page = await openDeck(browser, h, '/settings/crew', { reducedMotion: 'reduce' })
    await page.waitForSelector('#crew-repo')
    const moving = () => page.evaluate(() => ({
      animations: document.getAnimations().filter(animation => animation.playState === 'running').map(animation => animation.animationName ?? animation.constructor.name),
      styled: [...document.querySelectorAll('*')].filter(el => { const style = getComputedStyle(el)
        return style.animationName !== 'none' && parseFloat(style.animationDuration) > 0.01 && style.animationPlayState !== 'paused' }).map(el => `${el.tagName.toLowerCase()}.${el.getAttribute('class')}`)
    }))
    assert.deepEqual(await moving(), { animations: [], styled: [] })
    await pickCrew(page, crewTarget)
    await page.click('.crew-actions .button--secondary')
    await page.waitForSelector('.crew-toast')
    assert.deepEqual(await moving(), { animations: [], styled: [] })
  })

  spec('Settings Appearance: text size, motion and density apply at once and the server keeps text size and motion', async t => {
    const h = await deck(t, { team: false })
    await h.wrapped('vault-mcp')
    const page = await openDeck(browser, h, '/settings/appearance')
    await page.waitForSelector('#pref-textSize')
    assert.equal(await page.locator('.settings-section .setting-hint', { hasText: 'arrives in a later milestone' }).count(), 0, 'Appearance is no longer a later section')
    await page.selectOption('#pref-textSize', '16')
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--text-base') === '16px', null, { timeout: 5000 })
    await page.click('[role="radio"]:text-is("Always reduce motion")')
    await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'reduce', null, { timeout: 5000 })
    await until(async () => { const { prefs } = (await h.api('/api/prefs')).data
      return prefs.textSize === 16 && prefs.motion === 'reduce' }, { message: 'the server to keep textSize 16 and motion reduce' })
    await page.click('[role="radio"]:text-is("Compact")')
    assert.equal(await page.evaluate(() => localStorage.getItem('deck.density')), 'compact')
    await page.click('nav[aria-label="Deck sections"] a[href="/"]')
    await page.waitForSelector('.home-grid--compact')
    await page.reload()
    await page.waitForSelector('.home-grid--compact')
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-base')), '16px', 'text size survives a reload')
  })

  spec('Home compact: PTY cards show their live tails and an observed card lists its last hook steps', async t => {
    const h = await deck(t, { team: false })
    const vault = await h.wrapped('vault-mcp')
    const ids = await h.observed()
    const page = await openDeck(browser, h, '/', { init: () => localStorage.setItem('deck.density', 'compact') })
    await page.waitForSelector('.home-grid--compact')
    const cardOf = id => `.home-grid--compact article[aria-labelledby$="${String(id).replace(/[^\w-]/g, '_')}"]`
    await h.terminal.request('write', { ptyId: vault.ptyId, data: Buffer.from('first tail line\r\n').toString('base64'), source: { kind: 'terminal', name: 'control-harness' } })
    await page.locator(`${cardOf(vault.id)} .compact-tail-line`, { hasText: 'first tail line' }).waitFor({ timeout: 5000 })
    await h.terminal.request('write', { ptyId: vault.ptyId, data: Buffer.from('second tail line\r\n').toString('base64'), source: { kind: 'terminal', name: 'control-harness' } })
    await page.locator(`${cardOf(vault.id)} .compact-tail-line`, { hasText: 'second tail line' }).waitFor({ timeout: 5000 })
    const observed = await page.$$eval(`${cardOf(ids.get('axios-like'))} .compact-tail--observed .compact-tail-line`, rows => rows.map(row => row.textContent))
    assert.equal(observed[0], 'Observed · from hooks')
    assert.ok(observed.length > 1 && observed.slice(1).every(line => line.trim()), `the last hook steps are listed: ${JSON.stringify(observed)}`)
    assert.ok(observed.slice(1).some(line => line.includes('retry.js') || line.includes('npm test')), `the steps are the session's own: ${JSON.stringify(observed)}`)
  })

  spec('Home quiet row follow-up: Stop… on an idle live PTY session opens the dialog and Confirm stops the session', async t => {
    const h = await deck(t, { team: false })
    // A session that needs you keeps Home out of its calm layout, so the idle one sits in the quiet row.
    await h.observed()
    const idle = await h.wrapped('turbidassist', control.sessions.idle)
    await until(() => h.session(idle.id).state === 'idle', { message: 'the session to go idle' })
    const page = await openDeck(browser, h)
    const quiet = `.quiet-row article[aria-labelledby$="${idle.id.replace(/[^\w-]/g, '_')}"]`
    await page.waitForSelector(quiet)
    await page.click(`${quiet} .quiet-actions button`)
    await page.waitForSelector('.confirm-dialog')
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel')
    assert.equal(await page.textContent('.confirm-title'), 'Stop turbidassist · tidy the README?')
    await page.click('.confirm-dialog .button--danger')
    await until(() => !h.session(idle.id).alive, { message: 'the session to stop' })
    await page.waitForSelector('.confirm-dialog', { state: 'detached' })
  })

  spec('Focus follow-up: a failed Stop shows the "Could not stop" toast through the shell', async t => {
    const h = await deck(t, { team: false })
    const vault = await h.wrapped('vault-mcp')
    const page = await openDeck(browser, h, `/s/${vault.id}`)
    await page.waitForSelector('.terminal-view .xterm-rows')
    // The server answers this one stop with a conflict, as when the PTY ended between render and click.
    await page.route(`**/api/sessions/${vault.id}/stop`, route => route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'invalid_state', message: 'the session already ended', retryable: false } }) }))
    await page.click('.focus-actions .button--danger')
    await page.click('.confirm-dialog .button--danger')
    await page.waitForSelector('.toast-stack .toast--error')
    assert.match(await page.textContent('.toast--error .toast-title'), /^Could not stop vault-mcp: /)
    assert.equal(await page.locator('.focus-error').count(), 0, 'the error goes to the shell toast, not the inline fallback')
  })


  spec('Exit criterion 3: fm claude in a terminal and the browser type into one session; "Last typed from" follows the typist and crossing keystrokes show the collision chip', async t => {
    const h = await deck(t, { team: false })
    const fm = await fmClaude(h, 'vault-mcp')
    const page = await openDeck(browser, h, `/s/${fm.row.id}`)
    await page.waitForSelector('.terminal-view .xterm-rows')
    await focusTerminal(page)
    fm.pty.write('t')
    await page.locator('.focus-input-text').filter({ hasText: 'Typing in terminal (fm-e2e)' }).waitFor({ timeout: 5000 })
    await page.locator('.focus-input-text').filter({ hasText: 'Last typed from: terminal (fm-e2e)' }).waitFor({ timeout: 6000 })
    await page.keyboard.type('b')
    await page.locator('.focus-input-text').filter({ hasText: 'Typing in browser' }).waitFor({ timeout: 5000 })
    await page.locator('.focus-input-text').filter({ hasText: 'Last typed from: browser' }).waitFor({ timeout: 6000 })
    assert.equal(await page.locator('.focus-collision').count(), 0, 'no chip while only one side types')
    // Crossing keystrokes: the browser types within 1.5 s of the terminal's last byte.
    fm.pty.write('x')
    await page.locator('.focus-input-text').filter({ hasText: 'Typing in terminal (fm-e2e)' }).waitFor({ timeout: 5000 })
    await page.keyboard.type('y')
    await page.waitForSelector('.focus-collision', { timeout: 5000 })
    assert.equal(await page.textContent('.focus-collision'), 'Both typing: last keystroke wins')
    await page.waitForSelector('.focus-collision', { state: 'detached', timeout: 8000 })
    await until(() => typedInto(fm.log).replace(/\u001b\[[IO]|\u001b\[\?[\d;]*c/g, '') === 'tbxy', { message: 'the fake to receive both sides in order' })
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('tbxy'), null, { timeout: 5000 })
    assert.ok(fm.output().includes('tbxy'), 'the fm terminal shows the browser\'s keystrokes too')
  })

  spec('Exit criterion 2: a server restart with three live PTYs; the page reconnects without a reload and types into each again', { timeout: 180_000 }, async t => {
    const h = await deck(t, { team: false })
    const rows = []
    for (const repo of ['vault-mcp', 'discord-audit', 'portfolio-site']) rows.push(await h.wrapped(repo))
    const page = await openDeck(browser, h, `/s/${rows[0].id}`)
    const typeInto = async (row, text) => {
      await page.click(`.focus-list-row[href="/s/${encodeURIComponent(row.id)}"]`)
      await page.waitForFunction(id => location.pathname === `/s/${id}`, encodeURIComponent(row.id))
      await page.waitForSelector('.terminal-view .xterm-rows')
      // Picking a row from the list can leave focus on the link; a click in the terminal focuses it, as a user does.
      await page.click('.terminal-view .xterm-screen')
      await focusTerminal(page)
      await page.keyboard.type(text)
      await until(() => typedInto(row.log).replace(/\u001b\[[IO]|\u001b\[\?[\d;]*c/g, '').endsWith(text), { message: `${row.cwd} to receive ${text}` })
      await page.waitForFunction(text => document.querySelector('.xterm-rows')?.textContent.includes(text), text, { timeout: 5000 })
    }
    for (const [n, row] of rows.entries()) await typeInto(row, `hi${n}`)
    const loaded = await page.evaluate(() => performance.timeOrigin)
    await h.deck.close()
    await page.waitForSelector('.banner--server', { timeout: 10_000 })
    await h.startServer()
    await page.waitForSelector('.banner--server', { state: 'detached', timeout: 30_000 })
    for (const [n, row] of rows.entries()) await typeInto(row, `ping${n}`)
    assert.equal(await page.evaluate(() => performance.timeOrigin), loaded, 'the page was never reloaded')
    const { ptys } = await h.terminal.request('list')
    assert.deepEqual(rows.map(row => ptys.some(pty => pty.ptyId === row.ptyId)), [true, true, true], 'deckd still runs all three')
    for (const row of rows) assert.notEqual(h.sessionOfPty(row.ptyId).state, 'crashed')
    assert.deepEqual(page.errors, [])
  })
}
