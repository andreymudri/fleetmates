import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createApiClient } from '../../web/src/state/api.js'
import { setupPaths } from '../../server/setup/paths.mjs'
import { commandSpawn, resolveCommand } from '../../platform/index.mjs'
import { findChromium } from '../helpers/chromium.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const token = 'a'.repeat(43)
const fixture = JSON.parse(await readFile(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))

/**
 * Run npm with `args`: `process.execPath` with the npm-cli.js installed next to it (Windows layout, then the POSIX
 * `lib/` layout), else `npm` through resolveCommand and commandSpawn, since `npm` is `npm.cmd` on Windows and a
 * spawn without a shell cannot run that.
 */
function npm(args, options) {
  const dir = path.dirname(process.execPath)
  const cli = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(file => existsSync(file))
  if (cli) return execFileSync(process.execPath, [cli, ...args], options)
  const spawn = commandSpawn(resolveCommand('npm'), args)
  return execFileSync(spawn.file, spawn.args, { ...options, ...spawn.options })
}

/** Write the token where the server reads it for `env`: ~/.local/state/... on linux, under AppData\Local on win32. */
async function writeToken(env) {
  const file = setupPaths(env).token
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, token, { mode: 0o600 })
}

// Windows refuses to remove a directory while a just-closed file in it is still held; retry for a while.
const rmDir = dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

/** The built deck on a real server with two done sessions, and a Chromium page holding the token. */
async function deckWithTwoSessions(t) {
  const executablePath = findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the M1 web fixes browser test')
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'm1w-'))
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  await writeToken(env)
  const out = path.join(dir, 'web')
  npm(['run', 'build', '--', '--outDir', out], { cwd: hub, stdio: 'pipe' })
  // deckd answers, so no deckd banner is up: its once-a-second countdown would re-render the shell and hide stale state.
  const deckd = { request: async op => op === 'list' ? { ptys: [] } : op === 'exits' ? { exits: [] } : {}, on: () => () => {}, close() {} }
  // The sessions below are observed, with hooks stamped at 1000. On the wall clock they are decades old, so the
  // projector's 5 s tick would end them (an observed session silent for a day) part way through a slow test. A
  // server clock held one minute after the hooks keeps them done for the whole test.
  const deck = await startDeckServer({ env, port: 0, staticDir: out, notifications: false, connectDeckd: async () => deckd,
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }), now: () => 61_000 })
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => { await browser.close()
    await deck.close()
    await rmDir(dir) })
  const base = `http://127.0.0.1:${deck.address().port}`
  // First run is done, so `/` does not redirect to /welcome (the fake home has no hooks for its checks to pass).
  deck.store.run('INSERT INTO prefs(key,value,updated_at) VALUES(?,?,?)', 'firstRunCompletedAt', JSON.stringify(1000), 1000)
  for (const [claude, task] of [['claude-a', 'first task'], ['claude-b', 'second task']]) {
    deck.ingest.receive(JSON.stringify({ v: 1, hookTs: 1000, ptyId: null, claudePid: null, pidChain: [], truncated: false,
      hook: { ...fixture, cwd: dir, session_id: claude, hook_event_name: 'SessionStart' } }))
    deck.ingest.flush()
    const id = deck.projector.snapshot().sessions.find(row => row.claudeSessionIds?.includes(claude) || row.claudeSessionId === claude)?.id
      ?? deck.projector.snapshot().sessions.at(-1).id
    deck.store.run('UPDATE sessions SET state=?,task=? WHERE id=?', 'done', task, id)
  }
  const ids = deck.projector.snapshot().sessions.map(row => ({ id: row.id, task: row.task }))
  const a = ids.find(row => row.task === 'first task').id
  const b = ids.find(row => row.task === 'second task').id
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/s/${a}#token=${token}`)
  await page.waitForSelector('#focus-title', { timeout: 5000 })
  return { base, page, a, b, errors }
}

/** Client-side navigation the way the deck's own overlays do it: push a history entry and fire popstate. */
async function pushRoute(page, to) {
  await page.evaluate(target => {
    history.pushState(null, '', target)
    dispatchEvent(new PopStateEvent('popstate', { state: null }))
  }, to)
}

const selectedTab = page => page.getAttribute('.focus-tab[aria-selected="true"]', 'id')

test('moving between Focus sessions and following ?tab= gives each route fresh review and tab state', async t => {
  const { page, a, b, errors } = await deckWithTwoSessions(t)
  await page.route('**/api/sessions/*/mark-reviewed', route => route.fulfill({ status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'internal', message: 'fake failure', retryable: false } }) }))
  await page.click('.focus-actions button')
  await page.waitForSelector('.focus-error', { timeout: 5000 })
  assert.equal(await page.textContent('#focus-title'), 'first task')

  await pushRoute(page, `/s/${b}`)
  await page.waitForFunction(() => document.querySelector('#focus-title')?.textContent === 'second task', null, { timeout: 5000 })
  assert.equal(await page.locator('.focus-error').count(), 0, 'the review error on /s/a does not follow to /s/b')

  await pushRoute(page, `/s/${a}?tab=facts`)
  await page.waitForFunction(() => document.querySelector('#focus-title')?.textContent === 'first task', null, { timeout: 5000 })
  assert.equal(await selectedTab(page), 'focus-tab-facts')
  await pushRoute(page, `/s/${a}?tab=changes`)
  await page.waitForFunction(() => document.querySelector('.focus-tab[aria-selected="true"]')?.id === 'focus-tab-changes', null, { timeout: 2000 })
    .catch(() => {})
  assert.equal(await selectedTab(page), 'focus-tab-changes', 'following ?tab=changes from Facts shows Changes')

  // Back or an overlay (popstate) lands on ?tab=facts; then the session's own list link navigates in-app to the bare
  // /s/a, which names the default Changes tab. The pathname never changes, so only the shell's search state re-renders.
  await pushRoute(page, `/s/${a}?tab=facts`)
  await page.waitForFunction(() => document.querySelector('.focus-tab[aria-selected="true"]')?.id === 'focus-tab-facts', null, { timeout: 2000 })
  await page.click('.focus-list-row[aria-current="page"]')
  await page.waitForFunction(() => location.search === '', null, { timeout: 2000 })
  await page.waitForFunction(() => document.querySelector('.focus-tab[aria-selected="true"]')?.id === 'focus-tab-changes', null, { timeout: 2000 })
    .catch(() => {})
  assert.equal(await selectedTab(page), 'focus-tab-changes', 'an in-app link to the bare session URL shows Changes')
  assert.deepEqual(errors, [])
})

test('Alt K opens the palette, and inside the open palette it moves the highlight instead of opening another', async t => {
  const { page, errors } = await deckWithTwoSessions(t)
  await page.keyboard.press('Alt+KeyK')
  await page.waitForSelector('.palette-input', { timeout: 5000 })
  const entries = await page.evaluate(() => history.length)
  const first = await page.getAttribute('.palette-input', 'aria-activedescendant')
  await page.keyboard.press('ArrowDown')
  const second = await page.getAttribute('.palette-input', 'aria-activedescendant')
  assert.notEqual(second, first, 'the palette has at least two rows to move between')
  await page.keyboard.press('Alt+KeyK')
  assert.equal(await page.getAttribute('.palette-input', 'aria-activedescendant'), first, 'Alt K moves the highlight up')
  assert.equal(await page.evaluate(() => history.length), entries, 'Alt K inside the palette pushes no history entry')
  assert.deepEqual(errors, [])
})

test('the REST client hands screens the bare body the real deck server sends', async t => {
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'm1r-'))
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  await writeToken(env)
  await mkdir(path.join(dir, 'dev'))
  const deck = await startDeckServer({ env, port: 0, staticDir: dir, notifications: false, connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }) })
  t.after(async () => { await deck.close()
    await rmDir(dir) })
  const base = `http://127.0.0.1:${deck.address().port}`
  const client = createApiClient({ token, fetch: (route, init) => fetch(base + route, { ...init, headers: { ...init.headers, Origin: base } }) })
  assert.deepEqual(await client.get('/api/version'), { apiVersion: 1,
    deckVersion: JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version, build: 'm5' })
  const checks = await client.get('/api/setup/checks')
  assert.ok(Array.isArray(checks.checks) && checks.checks.some(check => check.id === 'hooks'), 'First run reads data.checks')
  const installed = await client.post('/api/setup/hooks')
  assert.equal(installed.check.id, 'hooks', 'the hooks fix reads data.check')
  assert.ok('backupPath' in installed)
  const prefs = await client.get('/api/prefs')
  assert.equal(typeof prefs.prefs, 'object', 'Settings reads data.prefs and data.sources')
  assert.equal(typeof prefs.sources, 'object')
  assert.deepEqual(await client.post('/api/repos/rescan'), { found: 0 })
  deck.ingest.receive(JSON.stringify({ v: 1, hookTs: 1000, ptyId: null, claudePid: null, pidChain: [], truncated: false,
    hook: { ...fixture, cwd: dir, hook_event_name: 'SessionStart' } }))
  deck.ingest.flush()
  const id = deck.projector.snapshot().sessions[0].id
  const steps = await client.get(`/api/sessions/${encodeURIComponent(id)}/steps`)
  assert.ok(Array.isArray(steps.steps), 'Focus reads data.steps')
})
