// Session archive end to end (docs/plans/2026-10-02-deck-archive.md, Task 6; docs/deck/archive.md): the built app
// on the real deck server with a real SQLite store in a temporary HOME, fed pinned 2.1.282 hook payloads through
// the real hooks.sock, in headless Chromium through playwright-core. Archive from a card and Unarchive from
// "Archived (N)", "Archive all finished" around a session with unreviewed changes, an archived live session that
// starts needing the owner, the auto-archive sweep after a Settings change, and paging through a long Archived list.
//
// The clock is injected through the hook timestamps: a session's `ended_at` is the `hookTs` of its SessionEnd,
// so a SessionEnd sent "7 hours ago" ends the session 7 hours before the server's own clock.
//
// Not part of `npm --prefix hub test` (its glob is test/**/*.test.mjs). Run with:
//   mkdir -p /tmp/hx/e2e && TMPDIR=/tmp/hx/e2e node --test --test-concurrency=1 hub/test/e2e/archive.spec.mjs
// CHROMIUM_PATH overrides /usr/bin/chromium.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildWeb, card, envelopeFor, launchBrowser, openDeck, startDeck, until } from './observe.spec.mjs'

const HOUR = 3600
const spec = (name, fn) => test(name, { timeout: 120_000 }, fn)

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

/** A session that is running a turn now. */
const running = [{ e: 'SessionStart', ago: 600 }, { e: 'UserPromptSubmit', ago: 590, prompt: 'keep working' }, { e: 'PreToolUse', ago: 5, tool_name: 'Bash', tool_input: { command: 'npm test' } }]
/** A live session waiting at the prompt. */
const idle = [{ e: 'SessionStart', ago: 900 }, { e: 'UserPromptSubmit', ago: 890, prompt: 'tidy up' }, { e: 'Stop', ago: 800 }]
/** A session that ended `ago` seconds ago without changes (finished, state `ended`). */
const ended = (ago = 600, prompt = 'look around') => [{ e: 'SessionStart', ago: ago + 300 }, { e: 'UserPromptSubmit', ago: ago + 290, prompt }, { e: 'Stop', ago: ago + 10 }, { e: 'SessionEnd', ago, reason: 'prompt_input_exit' }]
/** A session that edited a file and ended (finished, state `done`, unreviewed changes). */
const edited = repo => [{ e: 'SessionStart', ago: 1200 }, { e: 'UserPromptSubmit', ago: 1190, prompt: 'fix the bug' },
  { e: 'PostToolUse', ago: 1000, tool_name: 'Edit', tool_input: { file_path: `/home/you/dev/${repo}/src/main.mjs`, old_string: 'a', new_string: 'b', replace_all: false } },
  { e: 'Stop', ago: 900 }, { e: 'SessionEnd', ago: 800, reason: 'prompt_input_exit' }]

/**
 * Send every session's hooks through hooks.sock and map each key to its deck session id.
 * @param {Awaited<ReturnType<typeof startDeck>>} h
 * @param {Record<string, object[]>} sessions key to hook steps
 */
async function seed(h, sessions) {
  h.fixtureName = 'arch'
  const now = Date.now()
  await h.send(Object.entries(sessions).flatMap(([key, steps]) => steps.map(step => envelopeFor({ key, fixture: 'arch' }, step, now))))
  for (const key of Object.keys(sessions)) {
    const id = h.deck.store.get('SELECT id FROM sessions WHERE claude_session_id=?', `fx-arch-${key}`)?.id
    assert.ok(id, `session ${key} was created`)
    h.ids.set(key, id)
  }
}

const row = (h, key) => h.deck.store.get('SELECT state, alive, archived_at AS archivedAt, archived_by AS archivedBy, changed_files AS changedFiles FROM sessions WHERE id=?', h.ids.get(key))
const toggle = page => page.locator('.home-archived-toggle')
const archivedRows = page => page.locator('.archived-rows .archived-row')
const archivedTitles = page => page.$$eval('.archived-rows .archived-row .archived-row-title', rows => rows.map(r => r.textContent))

spec('archive a finished session from its card: it leaves Home and shows under "Archived (1)"; Unarchive brings it back', async t => {
  const h = await startDeck(t, { web: web.dir })
  await seed(h, { builder: running, shipped: edited('shipped') })
  assert.deepEqual({ state: row(h, 'shipped').state, alive: row(h, 'shipped').alive }, { state: 'done', alive: 0 }, 'shipped is finished')
  const page = await openDeck(browser, h)
  const shipped = card(page, h.ids.get('shipped'))
  await shipped.waitFor({ timeout: 5000 })
  assert.equal(await toggle(page).count(), 0, 'no Archived toggle while nothing is archived')

  await shipped.getByRole('button', { name: 'Archive', exact: true }).click()
  await shipped.waitFor({ state: 'detached', timeout: 5000 })
  await page.locator('.archive-toast', { hasText: 'Session archived' }).waitFor({ timeout: 5000 })
  await toggle(page).filter({ hasText: 'Archived (1)' }).waitFor({ timeout: 5000 })
  assert.equal(row(h, 'shipped').archivedBy, 'owner')
  assert.ok(await card(page, h.ids.get('builder')).isVisible(), 'the running session stays on Home')

  await toggle(page).click()
  await archivedRows(page).first().waitFor({ timeout: 5000 })
  assert.deepEqual(await archivedTitles(page), ['fix the bug'])
  assert.match(await archivedRows(page).first().textContent(), /archived by you/)

  await archivedRows(page).first().getByRole('button', { name: 'Unarchive' }).click()
  await shipped.waitFor({ timeout: 5000 })
  await toggle(page).waitFor({ state: 'detached', timeout: 5000 })
  assert.equal(row(h, 'shipped').archivedAt, null)
  assert.deepEqual(page.errors, [])
})

spec('"Archive all finished" archives the finished sessions and leaves the one with unreviewed changes on Home', async t => {
  const h = await startDeck(t, { web: web.dir })
  await seed(h, { builder: running, shipped: edited('shipped'), quiet: ended(600, 'first look'), gone: ended(300, 'second look'), waiting: idle })
  assert.equal(row(h, 'quiet').state, 'ended')
  const page = await openDeck(browser, h)
  const button = page.getByRole('button', { name: 'Archive all finished' })
  await button.click()
  await page.locator('.archive-toast', { hasText: 'Archived 2 finished sessions' }).waitFor({ timeout: 5000 })
  await toggle(page).filter({ hasText: 'Archived (2)' }).waitFor({ timeout: 5000 })
  await button.waitFor({ state: 'detached', timeout: 5000 })
  assert.equal(row(h, 'quiet').archivedBy, 'owner')
  assert.equal(row(h, 'gone').archivedBy, 'owner')
  assert.equal(row(h, 'shipped').archivedAt, null, 'unreviewed changes are never swept')
  assert.equal(row(h, 'waiting').archivedAt, null, 'a live session is not finished')
  assert.ok(JSON.parse(row(h, 'shipped').changedFiles).length > 0)
  for (const key of ['shipped', 'waiting', 'builder']) assert.ok(await card(page, h.ids.get(key)).isVisible(), `${key} stays on Home`)
  assert.deepEqual(page.errors, [])
})

spec('an archived live session that receives a permission hook reappears on Home needing you, without a reload', async t => {
  const h = await startDeck(t, { web: web.dir })
  await seed(h, { builder: running, waiting: idle })
  const page = await openDeck(browser, h)
  const waiting = card(page, h.ids.get('waiting'))
  await waiting.waitFor({ timeout: 5000 })
  await waiting.getByRole('button', { name: 'Archive', exact: true }).click()
  await waiting.waitFor({ state: 'detached', timeout: 5000 })
  await toggle(page).filter({ hasText: 'Archived (1)' }).waitFor({ timeout: 5000 })
  assert.equal(row(h, 'waiting').alive, 1, 'archived while live')

  const navigations = []
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()) })
  await h.hook('waiting', { e: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  await waiting.and(page.locator('.session-card--approval')).waitFor({ timeout: 5000 })
  await toggle(page).waitFor({ state: 'detached', timeout: 5000 })
  assert.deepEqual({ archivedAt: row(h, 'waiting').archivedAt, state: row(h, 'waiting').state }, { archivedAt: null, state: 'needs_approval' })
  assert.deepEqual(navigations, [], 'no reload')
  assert.deepEqual(page.errors, [])
})

spec('"Archive finished sessions after" 6 hours sweeps a session that ended 7 hours ago into Archived, and not one that ended 5 hours ago', async t => {
  const h = await startDeck(t, { web: web.dir })
  await seed(h, { builder: running, old: ended(7 * HOUR, 'old work'), young: ended(5 * HOUR, 'young work') })
  const page = await openDeck(browser, h, '/settings/appearance')
  const select = page.locator('#pref-autoArchiveAfter')
  await select.waitFor({ timeout: 5000 })
  assert.equal(await select.inputValue(), '24', 'the default is 24 hours')
  assert.equal(row(h, 'old').archivedAt, null, 'nothing is archived at 24 hours')

  const saved = page.waitForResponse(response => response.url().endsWith('/api/prefs') && response.request().method() === 'PATCH')
  await select.selectOption('6')
  assert.equal((await saved).status(), 200)
  await until(() => row(h, 'old').archivedAt !== null, { timeout: 5000, message: 'the sweep after the pref change' })
  assert.equal(row(h, 'old').archivedBy, 'auto')
  assert.equal(row(h, 'young').archivedAt, null, 'ended 5 hours ago: not yet')

  await page.locator('nav[aria-label="Deck sections"]').getByRole('link', { name: /^Sessions/ }).click()
  await toggle(page).filter({ hasText: 'Archived (1)' }).waitFor({ timeout: 5000 })
  await toggle(page).click()
  await archivedRows(page).first().waitFor({ timeout: 5000 })
  assert.deepEqual(await archivedTitles(page), ['old work'])
  assert.match(await archivedRows(page).first().textContent(), /archived automatically/)
  assert.deepEqual(page.errors, [])
})

spec('"Archive all finished" over 25 sessions, then "Show more" until it is gone, lists every archived session exactly once', async t => {
  const h = await startDeck(t, { web: web.dir })
  const keys = Array.from({ length: 25 }, (_, i) => `s${String(i).padStart(2, '0')}`)
  await seed(h, { builder: running, ...Object.fromEntries(keys.map((key, i) => [key, ended(600 + i, `task ${key}`)])) })
  const page = await openDeck(browser, h)
  await page.getByRole('button', { name: 'Archive all finished' }).click()
  await toggle(page).filter({ hasText: 'Archived (25)' }).waitFor({ timeout: 5000 })
  assert.equal(new Set(keys.map(key => row(h, key).archivedAt)).size, 1, 'one archive-finished call stamps one archivedAt')

  await toggle(page).click()
  await until(async () => await archivedRows(page).count() >= 20, { timeout: 5000, message: 'the first page' })
  let clicks = 0
  while (await page.locator('.archived-more').count()) {
    assert.ok(++clicks <= 3, 'Show more ends')
    const shown = await archivedRows(page).count()
    await page.locator('.archived-more').click()
    await until(async () => await archivedRows(page).count() > shown || !(await page.locator('.archived-more').count()), { timeout: 5000, message: 'the next page' })
    await page.waitForFunction(() => document.querySelector('#home-archived-list')?.getAttribute('aria-busy') !== 'true', null, { timeout: 5000 })
  }
  const titles = await archivedTitles(page)
  assert.equal(titles.length, 25, `25 rows: ${titles.join(', ')}`)
  assert.deepEqual([...titles].sort(), keys.map(key => `task ${key}`), 'every archived session exactly once')
  assert.deepEqual(page.errors, [])
})
