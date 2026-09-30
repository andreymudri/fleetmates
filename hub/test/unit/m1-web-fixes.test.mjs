import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const token = 'a'.repeat(43)
const fixture = JSON.parse(await readFile(new URL('../fixtures/hooks/2.1.282/SessionStart.startup.json', import.meta.url)))

async function findChromium() {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (!candidate) continue
    try { await access(candidate)
      return candidate } catch {}
  }
  return null
}

/** The built deck on a real server with two done sessions, and a Chromium page holding the token. */
async function deckWithTwoSessions(t) {
  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the M1 web fixes browser test')
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'm1w-'))
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  await mkdir(state, { recursive: true, mode: 0o700 })
  await writeFile(path.join(state, 'token'), token, { mode: 0o600 })
  const out = path.join(dir, 'web')
  execFileSync('npm', ['run', 'build', '--', '--outDir', out], { cwd: hub, stdio: 'pipe' })
  const deck = await startDeckServer({ env, port: 0, staticDir: out, notifications: false, connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }) })
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(async () => { await browser.close()
    await deck.close()
    await rm(dir, { recursive: true, force: true }) })
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
