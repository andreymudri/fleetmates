// Settings saves end to end: the built app on the real deck server (temporary HOME), driven in headless
// Chromium the way the owner does it. A Connections field saved with its button and with Enter, and a
// Notifications toggle, must reach config.json or the prefs table, say so on the page, and survive a reload.
//
// Not part of `npm --prefix hub test`. Run with:
//   mkdir -p /tmp/hx/e2e && TMPDIR=/tmp/hx/e2e node --test hub/test/e2e/settings-save.spec.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { buildWeb, launchBrowser, openDeck, startDeck, TOKEN } from './observe.spec.mjs'

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

const patches = page => {
  const seen = []
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith('/api/prefs')) seen.push(JSON.parse(request.postData())) })
  return seen
}
const answered = page => page.waitForResponse(response => response.url().endsWith('/api/prefs') && response.request().method() === 'PATCH')
const formOf = (page, selector) => page.locator('form', { has: page.locator(selector) })
const statusOf = (page, selector) => formOf(page, selector).locator('[role="status"]')
const config = async h => JSON.parse(await readFile(path.join(h.paths.config, 'config.json'), 'utf8'))

test('Settings: Connections fields saved with Save or Enter, and a Notifications toggle, persist and survive a reload', { timeout: 120_000 }, async t => {
  const h = await startDeck(t, { web: web.dir })
  const page = await openDeck(browser, h, '/settings/connections')
  const sent = patches(page)
  await page.waitForSelector('#pref-scanRoot')

  // Type into two fields first, then save each: one with its Save button, one with Enter.
  await page.fill('#pref-scanRoot', '/home/you/Work')
  await page.fill('#vault', '/home/you/vault')
  let response = answered(page)
  await formOf(page, '#pref-scanRoot').getByRole('button', { name: 'Save' }).click()
  assert.equal((await response).status(), 200)
  await statusOf(page, '#pref-scanRoot').filter({ hasText: 'Saved.' }).waitFor({ timeout: 5000 })
  response = answered(page)
  await page.press('#vault', 'Enter')
  assert.equal((await response).status(), 200)
  await statusOf(page, '#vault').filter({ hasText: 'Saved.' }).waitFor({ timeout: 5000 })
  assert.equal(await page.inputValue('#vault'), '/home/you/vault', 'the field keeps the saved text')
  assert.deepEqual(await config(h), { scanRoot: '/home/you/Work', vaultPath: '/home/you/vault' })

  // A Save that sends nothing still answers on the page.
  await page.click('#pref-scanRoot')
  await page.keyboard.type('x')
  assert.equal(await statusOf(page, '#pref-scanRoot').count(), 0, 'typing clears the saved line')
  await page.fill('#pref-scanRoot', '')
  await formOf(page, '#pref-scanRoot').getByRole('button', { name: 'Save' }).click()
  await statusOf(page, '#pref-scanRoot').filter({ hasText: 'Not saved: this field cannot be empty.' }).waitFor({ timeout: 5000 })
  await page.fill('#pref-scanRoot', '/home/you/Work')
  await page.press('#pref-scanRoot', 'Enter')
  await statusOf(page, '#pref-scanRoot').filter({ hasText: 'No change to save.' }).waitFor({ timeout: 5000 })
  assert.deepEqual(sent, [{ scanRoot: '/home/you/Work' }, { vaultPath: '/home/you/vault' }], 'refused and unchanged text is never sent')

  await page.reload()
  await page.waitForSelector('#pref-scanRoot')
  assert.equal(await page.inputValue('#pref-scanRoot'), '/home/you/Work', 'Repos folder survives a reload')
  assert.equal(await page.inputValue('#vault'), '/home/you/vault', 'Vault survives a reload')

  await page.goto(`${h.base}/settings/notifications`)
  await page.waitForSelector('#pref-notifyDone')
  assert.equal(await page.isChecked('#pref-notifyDone'), true)
  response = answered(page)
  await page.click('#pref-notifyDone')
  assert.equal((await response).status(), 200)
  await page.reload()
  await page.waitForSelector('#pref-notifyDone')
  assert.equal(await page.isChecked('#pref-notifyDone'), false, 'the toggle survives a reload')
  assert.equal(h.deck.store.get('SELECT value FROM prefs WHERE key=?', 'notifyDone')?.value, 'false')
  assert.deepEqual(page.errors, [])

  // Dogfood bug 4 probe: a new browser context shares no page state, cache or storage with the one that
  // saved, so every value it shows came back from the server.
  const fresh = await openDeck(browser, h, '/settings/connections')
  assert.notEqual(fresh.context(), page.context(), 'the read-back runs in a new browser context')
  await fresh.waitForSelector('#pref-scanRoot')
  assert.equal(await fresh.inputValue('#pref-scanRoot'), '/home/you/Work', 'Repos folder reads back in a new context')
  assert.equal(await fresh.inputValue('#vault'), '/home/you/vault', 'Vault reads back in a new context')
  await fresh.goto(`${h.base}/settings/notifications`)
  await fresh.waitForSelector('#pref-notifyDone')
  assert.equal(await fresh.isChecked('#pref-notifyDone'), false, 'the toggle reads back in a new context')
  const data = await (await fetch(`${h.base}/api/prefs`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.deepEqual([data.prefs.scanRoot, data.sources.scanRoot], ['/home/you/Work', 'config'])
  assert.deepEqual([data.prefs.vaultPath, data.sources.vaultPath], ['/home/you/vault', 'config'])
  assert.deepEqual([data.prefs.notifyDone, data.sources.notifyDone], [false, 'db'])
  assert.deepEqual(await config(h), { scanRoot: '/home/you/Work', vaultPath: '/home/you/vault' }, 'config.json holds the saved Connections fields')
  assert.deepEqual(fresh.errors, [])
})
