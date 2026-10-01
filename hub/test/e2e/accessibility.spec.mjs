// M1 accessibility (docs/deck/09-testing.md section 11.2, qa-checklist 1.3, 1.5 and 1.9): axe on every
// M1 screen and overlay with zero serious or critical violations, plus the focus traps and the skip link.
//
// axe-core is a hub development dependency (hub/package.json), so `npm ci --prefix hub` installs it. This
// suite injects axe-core's own `axe.min.js` into the page, from AXE_CORE_PATH when set and otherwise from
// hub/node_modules; when neither file exists, the axe tests are skipped with that reason.
//
// Not part of `npm --prefix hub test`. Run with:
//   mkdir -p /tmp/hx/e2e && TMPDIR=/tmp/hx/e2e node --test hub/test/e2e/accessibility.spec.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { buildWeb, fakeDeckd, hub, launchBrowser, openDeck, startDeck } from './observe.spec.mjs'

async function findAxe() {
  const candidates = [process.env.AXE_CORE_PATH]
  try { candidates.push(createRequire(path.join(hub, 'package.json')).resolve('axe-core/axe.min.js')) } catch {}
  for (const candidate of candidates) {
    if (!candidate) continue
    try { await access(candidate)
      return candidate } catch {}
  }
  return null
}

const axePath = await findAxe()
let axeSource
const skipAxe = axePath ? false : 'axe-core is not installed in hub/node_modules and AXE_CORE_PATH is unset'
/** Impacts that fail the suite (qa 1.9: zero serious or critical). */
const BLOCKING = new Set(['serious', 'critical'])

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

/**
 * Run axe on the page and return every violation, each flattened to its rule, impact and first targets.
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{ id: string, impact: string, help: string, targets: string[] }[]>}
 */
async function axe(page) {
  // The deck's CSP (script-src 'self') refuses an injected script tag; evaluating the source over the DevTools protocol is not a page script.
  if (!(await page.evaluate(() => typeof window.axe === 'object'))) await page.evaluate(axeSource ??= await readFile(axePath, 'utf8'))
  const result = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }))
  return result.violations.map(row => ({ id: row.id, impact: row.impact, help: row.help, targets: row.nodes.slice(0, 5).map(node => node.target.join(' ')) }))
}

const screens = {}
/**
 * An auditor for one test: `run` axes a screen state and records every finding for the report; `done`
 * fails when any audited screen had a serious or critical violation, after every screen was audited.
 * @returns {{ run: (page: import('playwright-core').Page, name: string) => Promise<void>, done: () => void }}
 */
function auditor() {
  const blocking = []
  return {
    async run(page, name) {
      await page.waitForTimeout(150)
      const violations = await axe(page)
      screens[name] = violations
      for (const row of violations) if (BLOCKING.has(row.impact)) blocking.push({ screen: name, ...row })
    },
    done() { assert.deepEqual(blocking, [], 'serious or critical axe violations') }
  }
}

after(() => {
  if (Object.keys(screens).length) process.stdout.write(`axe findings by screen: ${JSON.stringify(screens)}\n`)
})

test('axe: Home busy, calm, crowded and empty, with the palette open', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startDeck(t, { web: web.dir })
  await h.load('busy')
  const page = await openDeck(browser, h)
  await page.waitForSelector('.home-grid > article')
  await audit.run(page, 'home-busy')
  await page.keyboard.press('Alt+KeyK')
  await page.waitForSelector('.palette-input')
  await audit.run(page, 'palette-busy')
  await page.fill('.palette-input', 'zzzz-nothing')
  await audit.run(page, 'palette-empty')
  const calm = await startDeck(t, { web: web.dir })
  await calm.load('calm')
  const calmPage = await openDeck(browser, calm)
  await calmPage.waitForSelector('h1.calm-headline')
  await audit.run(calmPage, 'home-calm')
  const crowded = await startDeck(t, { web: web.dir })
  await crowded.load('crowded12')
  const crowdedPage = await openDeck(browser, crowded)
  await crowdedPage.waitForSelector('.quiet-strip')
  await audit.run(crowdedPage, 'home-crowded12')
  const empty = await startDeck(t, { web: web.dir })
  const emptyPage = await openDeck(browser, empty)
  await audit.run(emptyPage, 'home-empty')
  audit.done()
})

test('axe: the Needs-you drawer', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startDeck(t, { web: web.dir })
  await h.load('busy')
  const page = await openDeck(browser, h)
  await page.keyboard.press('Alt+KeyU')
  await page.waitForSelector('.drawer')
  await audit.run(page, 'drawer-busy')
  audit.done()
})

test('axe: Focus Changes and Facts, a done session, and the not-found session', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startDeck(t, { web: web.dir })
  await h.load('busy')
  const page = await openDeck(browser, h, `/s/${h.ids.get('rustot')}`)
  await page.waitForSelector('.focus-steps, .focus-log-empty')
  await audit.run(page, 'focus-needs-changes')
  await page.click('#focus-tab-facts')
  await audit.run(page, 'focus-needs-facts')
  await page.goto(`${h.base}/s/${h.ids.get('vault-mcp')}`)
  await page.waitForSelector('.focus-steps, .focus-log-empty')
  await audit.run(page, 'focus-done')
  await page.goto(`${h.base}/s/not-a-session`)
  await page.waitForSelector('.focus--missing')
  await audit.run(page, 'focus-missing')
  audit.done()
})

test('axe: First run, Settings sections and the rerun checklist', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startDeck(t, { web: web.dir, firstRun: true })
  const page = await openDeck(browser, h, '/welcome')
  await page.locator('.first-run-sail').filter({ hasText: 'Set sail (needs hooks)' }).waitFor({ timeout: 5000 })
  await audit.run(page, 'first-run-hooks-missing')
  await page.click('text=Install hooks')
  await page.locator('.first-run-sail').filter({ hasText: /^Set sail$/ }).waitFor({ timeout: 5000 })
  await audit.run(page, 'first-run-ready')
  h.completeFirstRun()
  for (const section of ['notifications', 'connections', 'rules', 'appearance']) {
    await page.goto(`${h.base}/settings/${section}`)
    await page.waitForSelector('.settings-section')
    await audit.run(page, `settings-${section}`)
  }
  await page.goto(`${h.base}/settings/connections`)
  await page.waitForSelector('.settings-section')
  await page.click('text=Run the setup checklist again')
  await page.waitForSelector('.checklist-inline')
  await audit.run(page, 'settings-connections-checklist')
  audit.done()
})

test('axe: loading, deckd down banner, lost server, fatal token and not-found pages', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startDeck(t, { web: web.dir, deckd: fakeDeckd({ up: false }) })
  await h.load('busy')
  const loading = await openDeck(browser, h, '/', { wait: false, init: () => { window.WebSocket = class { constructor() {} close() {} send() {} addEventListener() {} } } })
  await loading.waitForSelector('.skeleton-card')
  await audit.run(loading, 'home-loading')
  assert.deepEqual(screens['home-loading'].filter(row => row.id === 'page-has-heading-one'), [], 'the loading page has a level-one heading')
  const page = await openDeck(browser, h)
  await page.waitForSelector('.banner--deckd')
  await audit.run(page, 'home-deckd-down')
  await page.goto(`${h.base}/nowhere`)
  await page.waitForSelector('.screen--not-found')
  await audit.run(page, 'not-found')
  const stale = await browser.newPage()
  h.contexts.add(stale.context())
  await stale.goto(`${h.base}/#token=${'b'.repeat(43)}`)
  await stale.waitForSelector('.fatal')
  await audit.run(stale, 'fatal-token')
  await h.deck.close()
  await page.waitForSelector('.banner--server', { timeout: 10_000 })
  await audit.run(page, 'server-lost')
  audit.done()
})

test('keyboard (qa 1.3): the skip link is the first stop, and Tab stays inside the drawer and the palette', async t => {
  const h = await startDeck(t, { web: web.dir })
  await h.load('busy')
  const page = await openDeck(browser, h)
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to main content')
  for (const [open, panel] of [['Alt+KeyU', '.drawer'], ['Alt+KeyK', '.palette']]) {
    await page.keyboard.press(open)
    await page.waitForSelector(panel)
    const outside = []
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab')
      if (!(await page.evaluate(selector => document.querySelector(selector)?.contains(document.activeElement), panel))) outside.push(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60)))
    }
    assert.deepEqual(outside, [], `Tab never leaves ${panel}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector(panel, { state: 'detached' })
  }
})

test('keyboard (qa 1.3): every focusable control on Home shows a visible focus indicator', async t => {
  const h = await startDeck(t, { web: web.dir })
  await h.load('busy')
  const page = await openDeck(browser, h)
  const missing = []
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab')
    const seen = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const style = getComputedStyle(el)
      const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
      const ring = style.boxShadow && style.boxShadow !== 'none'
      return { visible: outline || !!ring, what: `${el.tagName.toLowerCase()}.${el.className}` }
    })
    if (seen && !seen.visible) missing.push(seen.what)
  }
  assert.deepEqual([...new Set(missing)], [], 'controls without a focus-visible indicator')
})
