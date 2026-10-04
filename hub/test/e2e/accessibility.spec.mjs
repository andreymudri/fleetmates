// M1, M2 and M3 accessibility (docs/deck/09-testing.md section 11.2, qa-checklist 1.3, 1.4, 1.5 and 1.9): axe on
// every M1, M2 and M3 screen and overlay with zero serious or critical violations, the focus traps, the skip link,
// the way out of the live terminal (WCAG 2.1.2) and reduced motion.
// M4 adds the meeting surfaces (list, detail, Full transcript drawer, tag menu, live view, recording bar, degraded
// card) against the meetings harness of meetings.spec.mjs, and the meeting keys: the tag menu listbox, Alt P with and
// without the Focus terminal, and Stop and summarize, which is never a form default.
//
// axe-core is a hub development dependency (hub/package.json), so `npm ci --prefix hub` installs it. This
// suite injects axe-core's own `axe.min.js` into the page, from AXE_CORE_PATH when set and otherwise from
// hub/node_modules; when neither file exists, the axe tests are skipped with that reason.
//
// Not part of `npm --prefix hub test`. Run with:
//   mkdir -p /tmp/hx/e2e && TMPDIR=/tmp/hx/e2e node --test hub/test/e2e/accessibility.spec.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { buildWeb, fakeDeckd, hub, launchBrowser, openDeck, startDeck, until } from './observe.spec.mjs'
import { control, placed, startControl, typedInto } from './control.spec.mjs'
import { startUnblock, unblock } from './unblock.spec.mjs'
import { isolateHost, meetingsUi, startMeetings } from './meetings.spec.mjs'
import { startFakeScribed } from '../fakes/fake-scribed.mjs'
import { meetings5, writeMeetingsTree } from '../helpers/meetings-tree.mjs'

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

// Shims first on PATH, a private XDG_RUNTIME_DIR and no session bus, display or token for Chromium and every child.
isolateHost()

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

// M2 (09-testing.md section 11.2, "end of M2"): the audit on the React build with a live terminal, against the
// control harness of control.spec.mjs (real deckd, fake claude). Every axe finding is printed with its impact;
// serious and critical ones fail.

test('axe (M2): Focus with a live terminal and its Stop dialog, New session, Team run and plan drawer, Settings Appearance and compact Home', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startControl(t, { web: web.dir })
  const vault = await h.wrapped('vault-mcp')
  await h.observed()
  await h.teamLead()
  const page = await openDeck(browser, h, `/s/${vault.id}`)
  await page.waitForSelector('.terminal-view .xterm-rows')
  await page.waitForSelector('.terminal-view .terminal-skeleton', { state: 'detached', timeout: 10_000 }).catch(() => {})
  await audit.run(page, 'focus-live-terminal')
  await page.click('.focus-actions .button--danger')
  await page.waitForSelector('.confirm-dialog')
  await audit.run(page, 'focus-stop-dialog')
  await page.keyboard.press('Escape')
  await page.goto(`${h.base}/new`)
  await page.waitForSelector('#new-session-repo')
  await audit.run(page, 'new-session')
  await page.fill('#new-session-repo', 'rustot')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.launch-banner--hint')
  await audit.run(page, 'new-session-conflict')
  await page.goto(`${h.base}/runs/${control.team.repo}/${control.team.runId}`)
  await page.waitForSelector('#team-crew-T5 .team-crew-steps')
  await audit.run(page, 'team-run')
  await page.click('.team-actions button:text-is("Open plan")')
  await page.waitForSelector('[role="dialog"]')
  await audit.run(page, 'team-plan-drawer')
  await page.goto(`${h.base}/settings/appearance`)
  await page.waitForSelector('#pref-textSize')
  await audit.run(page, 'settings-appearance')
  const compact = await openDeck(browser, h, '/', { init: () => localStorage.setItem('deck.density', 'compact') })
  await compact.waitForSelector('.home-grid--compact')
  await audit.run(compact, 'home-compact')
  audit.done()
})

// The Crew sheet's grid scroller (`.crew-grid-scroll`) scrolls, so it must take focus for a keyboard user to
// scroll it (axe scrollable-region-focusable, serious).
test('axe (M2): the Crew sheet', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startControl(t, { web: web.dir, team: false })
  const page = await openDeck(browser, h, '/settings/crew')
  await page.waitForSelector('.crew-grid tbody th.crew-repo')
  await audit.run(page, 'crew-sheet')
  audit.done()
})

test('keyboard (qa 1.3, WCAG 2.1.2): Tab reaches the terminal, the leave hint shows, Alt K opens the palette from it and Alt Esc leaves it', async t => {
  const h = await startControl(t, { web: web.dir, team: false })
  const vault = await h.wrapped('vault-mcp')
  const page = await openDeck(browser, h, `/s/${vault.id}`)
  await page.waitForSelector('.terminal-view .xterm-rows')
  const inTerminal = () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'))
  await page.focus('.focus-back')
  let tabs = 0
  while (!(await inTerminal()) && tabs < 60) { await page.keyboard.press('Tab')
    tabs++ }
  assert.equal(await inTerminal(), true, `Tab reaches the terminal (${tabs} presses)`)
  assert.equal(await page.textContent('.focus-leave-hint'), 'Alt Esc to leave the terminal', 'the way out is shown while the terminal has focus')
  const typedBefore = typedInto(vault.log)
  await page.keyboard.press('Alt+KeyK')
  await page.waitForSelector('.palette-input')
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('palette-input')), true, 'Alt K moves focus to the palette')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.palette', { state: 'detached' })
  await page.click('.terminal-view .xterm-screen')
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
  await page.keyboard.press('Alt+Escape')
  await page.waitForFunction(() => location.pathname === '/', null, { timeout: 5000 })
  assert.equal(await inTerminal(), false, 'Alt Esc leaves the terminal')
  await page.waitForTimeout(200)
  assert.equal(typedInto(vault.log), typedBefore, 'neither chord reached the PTY')
})

test('keyboard (qa 1.3): the Stop dialog takes focus on Cancel, keeps Tab inside, and Esc returns focus to Stop', async t => {
  const h = await startControl(t, { web: web.dir, team: false })
  const vault = await h.wrapped('vault-mcp')
  const page = await openDeck(browser, h, `/s/${vault.id}`)
  await page.waitForSelector('.terminal-view .xterm-rows')
  await page.click('.focus-actions .button--danger')
  await page.waitForSelector('.confirm-dialog')
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'Cancel has the initial focus')
  assert.deepEqual(await page.$$eval('.confirm-actions button', rows => rows.map(row => row.textContent)), ['Cancel', 'Stop session'], 'Cancel comes first')
  const outside = []
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab')
    if (!(await page.evaluate(() => document.querySelector('.confirm-dialog')?.contains(document.activeElement)))) outside.push(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60)))
  }
  assert.deepEqual(outside, [], 'Tab never leaves the dialog')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.confirm-dialog', { state: 'detached' })
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Stop…', 'focus returns to Stop')
  assert.equal(h.session(vault.id).alive, true, 'Esc stopped nothing')
})

// M3 (09-testing.md section 11.2, "end of M3"): the answering surfaces on the unblock harness of unblock.spec.mjs
// (real deckd, fake claude, the SYNTHETIC 2.1.285 Bash frames of D-95). Every axe finding is printed with its impact
// by the `after` above; serious and critical ones fail. Findings this audit made are recorded with their severity
// (qa-checklist 0.4) next to the test that shows them; S1 and S2 ones are todo tests until their fix tasks land.
// Recorded when this audit was written:
// - T17-F2 (S2, keyboard): focus left the drawer when the answered row left. Fixed by Task 23; the test below
//   that was its todo now runs.
// - T17-F3 (S3, axe `landmark-unique`, moderate): each drawer section was labelled by its count span alone
//   (" · 1"), so two sections with the same count shared a name. Fixed by Task 23: each section is named by its
//   tier title and count, the text of its heading; the answering drawer audit below asserts axe reports no `landmark-unique`.
// - No serious or critical axe finding on the answering drawer, the four PromptBars, Settings Approval rules with the
//   revoke dialog, or the Changes diff.
// - T17-F1 (S2) is functional, not an accessibility finding: unblock.spec.mjs.

/** A Focus page on a PTY session, wide enough that the Focus terminal keeps the fake's frame (see unblock.spec.mjs). */
async function focusOn(h, session, tier) {
  const page = await openDeck(browser, h, `/s/${session.id}`, { viewport: { width: 2560, height: 1440 } })
  await page.waitForSelector(`.prompt-bar--${tier}`)
  await page.waitForSelector('.terminal-view .xterm-rows')
  await page.click('.prompt-bar-summary')
  await page.waitForTimeout(300)
  await page.waitForSelector(`.prompt-bar--${tier}`)
  return page
}

/** The snapshot rewrite that adds the fixture's two rule offers (one `anyFlags`, which no shipped tiers entry has). */
function withOffers(h) {
  const ids = new Map(h.deck.store.all('SELECT id, name FROM repos').map(row => [row.name, row.id]))
  const offers = unblock.ruleOffers.map(({ repo, ...offer }) => ({ ...offer, repoId: ids.get(repo), repoKey: repo }))
  return message => message.t === 'snapshot' ? { ...message, data: { ...message.data, ruleOffers: offers } } : message
}

test('axe (M3): the answering drawer with Safe, Caution, Destructive and question rows and two rule offers, and the PromptBar for each tier', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startUnblock(t, { web: web.dir })
  const [safeSpec, destructiveSpec] = unblock.sessions.pty
  const safe = await h.pty(safeSpec)
  const caution = await h.pty(unblock.promptBar.caution)
  const destructive = await h.pty(destructiveSpec)
  const question = await h.pty(unblock.promptBar.question)
  const asked = await until(() => h.deck.store.get("SELECT * FROM requests WHERE session_id = ? AND kind = 'question' AND state = 'open' AND screen_match = 'on_screen'", question.id), { message: 'the question on screen' })
  question.request = asked
  await h.observedSession()
  const page = await openDeck(browser, h, '/', { rewrite: withOffers(h) })
  await page.keyboard.press('Alt+KeyU')
  await page.waitForSelector('.drawer-section--destructive .answer-confirm input')
  await page.waitForSelector('.drawer-section--question .answer-options button')
  await page.waitForSelector('.drawer-rule-note')
  assert.deepEqual(await page.$$eval('.drawer-section', rows => rows.map(row => row.className.match(/drawer-section--(\w+)/)[1])), ['safe', 'caution', 'question', 'destructive'])
  await audit.run(page, 'drawer-answering')
  assert.deepEqual(screens['drawer-answering'].filter(row => row.id === 'landmark-unique'), [], 'T17-F3: four sections of one row each keep distinct names')
  await page.check('.drawer-section--destructive .answer-confirm input')
  await audit.run(page, 'drawer-answering-confirmed')
  for (const [session, tier] of [[safe, 'safe'], [caution, 'caution'], [destructive, 'destructive'], [question, 'question']]) {
    const focus = await focusOn(h, session, tier)
    await audit.run(focus, `promptbar-${tier}`)
    await focus.close()
  }
  audit.done()
})

test('axe (M3): Settings Approval rules with the revoke dialog open, and the Changes diff', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startUnblock(t, { web: web.dir, rules: true })
  const page = await openDeck(browser, h, '/settings/rules')
  await page.waitForSelector('.rule-row')
  assert.equal(await page.locator('.rule-row').count(), 5, 'rules5: five rules')
  await audit.run(page, 'settings-rules')
  await page.locator('.rule-row button', { hasText: 'Revoke…' }).first().click()
  await page.waitForSelector('.confirm-dialog')
  await audit.run(page, 'settings-rules-revoke')

  // The Changes diff of an edited file. Focus asks for it by absolute path, which the server refuses (finding
  // T17-F1, unblock.spec.mjs); the error state is audited as it stands, and the diff itself is audited from the
  // server's own answer for the repo-relative path.
  const repo = 'turbidassist'
  const dir = path.join(placed(control.scanRoot, h.home), repo)
  const session = { key: 'a11y-diff', repo, sessionId: 'fx-unblock-a11y-diff' }
  const id = await h.observe(session, [{ e: 'SessionStart', ago: 60 }])
  await writeFile(path.join(dir, 'README.md'), `${repo}\nedited by the session\n`)
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'README.md'), old_string: repo, new_string: `${repo}\nedited by the session`, replace_all: false } }
  await h.observe(session, [{ e: 'PreToolUse', ...edit }, { e: 'PostToolUse', ...edit }, { e: 'Stop' }])
  await until(() => (h.session(id).changedFiles ?? []).length === 1, { message: 'the changed file' })
  const diffPage = await openDeck(browser, h, `/s/${id}?tab=changes`)
  await diffPage.waitForSelector('.diff-view:not(.diff-view--loading)')
  await audit.run(diffPage, 'focus-changes-diff-as-served')
  const served = await h.api(`/api/sessions/${id}/diff?path=README.md`)
  assert.equal(served.status, 200)
  await diffPage.route(/\/api\/sessions\/[^/]+\/diff\?/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(served.data) }))
  await diffPage.reload()
  await diffPage.waitForSelector('.diff-line--add')
  await audit.run(diffPage, 'focus-changes-diff')
  audit.done()
})

test('keyboard (M3): the answering drawer traps Tab, opens on the checkbox when its first request is Destructive, and the revoke dialog focuses Cancel', async t => {
  const h = await startUnblock(t, { web: web.dir, rules: true })
  const destructive = await h.pty(unblock.sessions.pty[1])
  const page = await openDeck(browser, h)
  await page.keyboard.press('Alt+KeyU')
  await page.waitForSelector('.drawer .answer-confirm input')
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.drawer-row--destructive .answer-confirm input')), true, 'initial focus is the Destructive checkbox, never Allow')
  // A Safe row joins: the first row is now Safe, so a fresh drawer opens on its Allow once.
  const safe = await h.pty(unblock.sessions.pty[0])
  await page.waitForSelector(`.drawer-row[data-request="${safe.request.id}"] .answer-buttons .button--primary:not([disabled])`)
  const outside = []
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab')
    if (!(await page.evaluate(() => document.querySelector('.drawer')?.contains(document.activeElement)))) outside.push(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60)))
  }
  assert.deepEqual(outside, [], 'Tab never leaves the answering drawer')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.drawer', { state: 'detached' })
  await page.keyboard.press('Alt+KeyU')
  await page.waitForSelector('.drawer')
  assert.equal(await page.evaluate(id => document.activeElement?.closest('.drawer-row')?.dataset.request, safe.request.id), safe.request.id, 'with a Safe row first, focus opens on it')
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Allow once')
  assert.deepEqual(h.inputs(destructive.log), [], 'nothing was answered')

  await page.goto(`${h.base}/settings/rules`)
  await page.waitForSelector('.rule-row')
  await page.locator('.rule-row button', { hasText: 'Revoke…' }).first().click()
  await page.waitForSelector('.confirm-dialog')
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'the revoke dialog opens on Cancel')
  assert.deepEqual(await page.$$eval('.confirm-actions button', rows => rows.map(row => row.textContent)), ['Cancel', 'Revoke rule'])
})

// Finding T17-F2 (S2, qa-checklist 0.4 "broken keyboard path"): when Alt A (or a click) answered the focused row and
// the row left the drawer, focus fell to the page body. The drawer's keys (Up, Down, Alt A, Alt D, Esc) and its
// Tab trap act only while focus is inside it, so the keyboard user was left outside a modal that was still open
// (needs-you-drawer.md section 8: focus trap). Fixed by Task 23: focus moves to the next row, else the previous
// row, else Close.
test('keyboard (M3): after Alt A answers the focused row and it leaves, focus stays in the drawer', async t => {
  const h = await startUnblock(t, { web: web.dir })
  const first = await h.pty(unblock.sessions.pty[0])
  const second = await h.pty({ repo: 'discord-audit', script: 'approve-safe', summary: 'npm run test' })
  const page = await openDeck(browser, h)
  await page.keyboard.press('Alt+KeyU')
  await page.waitForSelector(`.drawer-row[data-request="${second.request.id}"]`)
  const focused = await page.evaluate(() => document.activeElement?.closest('.drawer-row')?.dataset.request)
  await page.keyboard.press('Alt+KeyA')
  await until(() => h.row(focused).state === 'answered', { message: 'the focused row to be answered' })
  await page.waitForSelector(`.drawer-row[data-request="${focused}"]`, { state: 'detached' })
  assert.deepEqual([h.inputs(first.log).length + h.inputs(second.log).length], [1])
  assert.equal(await page.evaluate(() => !!document.querySelector('.drawer')?.contains(document.activeElement)), true, `focus stays in the drawer, not on ${await page.evaluate(() => document.activeElement?.tagName)}`)
})

// The refocus of T17-F2 acts only when focus fell to the page body. A denied row lingers with its follow-up field
// and is no longer an answerable row, so a refocus that ignored where focus is would pull it off that field while
// the user types, and a typed space would then press Close.
test('keyboard (M3): typing in a denied row\'s follow-up field keeps focus there and the drawer open', async t => {
  const h = await startUnblock(t, { web: web.dir })
  const deny = await h.pty({ repo: 'discord-audit', script: 'deny-then-instruct', summary: 'npm run test' })
  const page = await openDeck(browser, h)
  await page.keyboard.press('Alt+KeyU')
  const row = `.drawer-row[data-request="${deny.request.id}"]`
  await page.waitForSelector(`${row} .answer-buttons button:not([disabled])`)
  await page.click(`${row} .answer-buttons button:text-is("Deny")`)
  await page.waitForSelector(`${row} .drawer-followup input`)
  await page.focus(`${row} .drawer-followup input`)
  await page.keyboard.type('use pnpm instead', { delay: 60 })
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.drawer-followup')), true, `focus stays in the follow-up field, not on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60))}`)
  assert.equal(await page.inputValue(`${row} .drawer-followup input`), 'use pnpm instead')
  assert.equal(await page.locator('.drawer').count(), 1, 'the drawer stays open')
})

const running = page =>page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running')
  .map(animation => `${animation.animationName ?? animation.transitionProperty ?? animation.constructor.name} on ${animation.effect?.target?.getAttribute?.('class') ?? '?'}`))

test('motion (qa 1.4): with reduced motion nothing animates on the Crew page, Home or Focus', async t => {
  const h = await startControl(t, { web: web.dir, team: false })
  const vault = await h.wrapped('vault-mcp')
  await h.observed()
  for (const route of ['/settings/crew', '/', `/s/${vault.id}`]) {
    const page = await openDeck(browser, h, route, { reducedMotion: 'reduce' })
    await page.waitForTimeout(1000)
    assert.deepEqual(await running(page), [], `${route}: no running animation 1 s after load`)
  }
})

test('motion (qa 1.4): Settings "Always reduce motion" stops every CSS animation with the OS preference off', async t => {
  const h = await startControl(t, { web: web.dir, team: false })
  await h.wrapped('vault-mcp')
  await h.observed()
  assert.equal((await h.api('/api/prefs', 'PATCH', { motion: 'reduce' })).status, 200)
  for (const route of ['/settings/crew', '/']) {
    const page = await openDeck(browser, h, route, { reducedMotion: 'no-preference' })
    await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'reduce')
    await page.waitForTimeout(1000)
    assert.deepEqual(await running(page), [], `${route}: no running animation 1 s after load`)
  }
})

// qa 1.4 "caret (xterm only when motion is allowed)": xterm adds `.xterm-cursor-blink` to the cursor cell when it
// draws a focused cursor, so each check first waits for that cursor (a focused shape class) before reading the
// class; a read before the draw could not tell a still caret from one not drawn yet. The first page, with motion
// allowed, shows the class does appear when the caret blinks.
test('motion (qa 1.4): the terminal caret does not blink with Settings "Always reduce motion"', async t => {
  const h = await startControl(t, { web: web.dir, team: false })
  const vault = await h.wrapped('vault-mcp')
  const blinking = async page => {
    await page.waitForSelector('.terminal-view .xterm-rows')
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
    await page.waitForSelector('.terminal-view .xterm-rows .xterm-cursor:is(.xterm-cursor-block, .xterm-cursor-bar, .xterm-cursor-underline)', { timeout: 5000 })
    return page.evaluate(() => document.querySelectorAll('.terminal-view .xterm-cursor-blink').length > 0)
  }
  const allowed = await openDeck(browser, h, `/s/${vault.id}`, { reducedMotion: 'no-preference' })
  assert.equal(await blinking(allowed), true, 'with motion allowed the caret blinks')
  const os = await openDeck(browser, h, `/s/${vault.id}`, { reducedMotion: 'reduce' })
  assert.equal(await blinking(os), false, 'the OS preference stops the blink')
  assert.equal((await h.api('/api/prefs', 'PATCH', { motion: 'reduce' })).status, 200)
  const page = await openDeck(browser, h, `/s/${vault.id}`, { reducedMotion: 'no-preference' })
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'reduce')
  assert.equal(await blinking(page), false, 'the Settings preference stops the blink')
})

// M4 (09-testing.md section 11.2, "end of M4"): the meeting surfaces. Every axe finding is printed with its impact by
// the `after` above; serious and critical ones fail. Findings this audit made are recorded with their severity
// (qa-checklist 0.4) next to the test that shows them; S1 and S2 ones are todo tests until their fix tasks land.
// Recorded when this audit was written (axe-core 4.13.0, Chromium headless, 1920x1080):
// - M4-T17-F3 (S3, axe `landmark-main-is-top-level`, `landmark-no-duplicate-main` and `landmark-unique`, all
//   moderate): the Meetings screen renders its detail pane as a second `main` (`.meetings-detail-pane`,
//   hub/web/src/screens/meetings/Meetings.jsx) inside the shell's `main#main`, on the list, the detail, the Full
//   transcript drawer, the tag menu and the degraded card states.
// - M4-T17-F4 (S3, axe `region`, moderate): with the recording bar shown, Home reports the skip link
//   (`.sr-only-focusable`) as content outside every landmark. Fixed by Task 19: while the bar shows, the skip link
//   renders as the first child of the bar's labelled `region`, so it stays the first focusable element and sits
//   inside a landmark. The `region` assertion below fails if the bar loses its role.
// - No serious or critical axe finding on any M4 surface audited below. The live view had no axe finding at all.
// - M4-T17-F1 (S2, layout) and M4-T17-F2 (S2, security) are not accessibility findings: meetings.spec.mjs and
//   security.spec.mjs.
test('axe (M4): the Meetings list, the detail, the Full transcript drawer, the open tag menu, the live view, the recording bar and the degraded card', { skip: skipAxe }, async t => {
  const audit = auditor()
  const h = await startMeetings(t, { web: web.dir, variants: ['awaitingNames'] })
  const page = await openDeck(browser, h, '/meetings')
  await page.waitForSelector('.meeting-detail-title')
  await audit.run(page, 'meetings-list-detail')
  await page.click('button:text-is("Full transcript")')
  await page.waitForSelector('.meeting-transcript .transcript-line')
  await audit.run(page, 'meetings-transcript-drawer')
  await page.keyboard.press('Escape')
  await page.goto(`${h.base}/meetings/${h.tree.ids.awaitingNames}`)
  await page.waitForSelector('.meeting-banner--hint')
  await audit.run(page, 'meetings-detail-awaiting-names')
  await page.click('.meetings-record')
  await page.waitForSelector('[role="listbox"]')
  await audit.run(page, 'meetings-tag-menu')
  const recorder = await h.record('pessoal')
  await page.goto(`${h.base}/meetings/live`)
  await page.waitForSelector('.live-log')
  await h.push(meetingsUi.live, recorder.meetingId)
  await page.waitForFunction(n => document.querySelectorAll('.live-log .transcript-line').length === n, meetingsUi.live.length, { timeout: 5000 })
  await page.click('.live-log .transcript-line >> nth=1')
  await page.waitForSelector('.live-pin')
  await page.fill('.live-ask-input', meetingsUi.ask.question)
  await page.press('.live-ask-input', 'Enter')
  await page.waitForSelector('.live-ask-answer')
  await audit.run(page, 'meetings-live-view')
  await page.goto(`${h.base}/`)
  await page.waitForSelector('.rec-bar--recording')
  await audit.run(page, 'recording-bar-home')
  assert.deepEqual(screens['recording-bar-home'].filter(row => row.id === 'region'), [], 'M4-T17-F4: with the recording bar shown, axe finds no content outside a landmark')
  const down = await startMeetings(t, { web: web.dir, scribed: false })
  const downPage = await openDeck(browser, down, '/meetings')
  await downPage.waitForSelector('.degraded-card')
  await audit.run(downPage, 'meetings-degraded-card')
  audit.done()
})

test('keyboard (M4): the tag menu is a listbox driven by arrows and Enter', async t => {
  const h = await startMeetings(t, { web: web.dir })
  const page = await openDeck(browser, h, '/meetings')
  await page.focus('.meetings-record')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[role="listbox"]')
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-tag'))
  if ((await focused()) === null) await page.keyboard.press('Tab')
  assert.equal(await focused(), 'pessoal', 'the default tag takes focus first')
  await page.keyboard.press('ArrowDown')
  assert.equal(await focused(), 'client-a')
  await page.keyboard.press('ArrowDown')
  assert.equal(await focused(), 'client-b')
  await page.keyboard.press('ArrowUp')
  assert.equal(await focused(), 'client-a')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => location.pathname === '/meetings/live', null, { timeout: 10_000 })
  assert.deepEqual(h.fake.received.filter(row => row.parsed?.cmd === 'start').map(row => row.raw), ['{"cmd":"start","tag":"client-a"}'])
})

test('keyboard (M4): Alt P with the Focus terminal focused reaches the PTY and pins nothing, and Alt P elsewhere pins', async t => {
  let fake
  const h = await startControl(t, {
    web: web.dir, team: false,
    // The meetings5 tree in the control HOME and the fake scribed on its runtime directory, before the server starts.
    prepare: async ({ home }) => {
      await writeMeetingsTree(home, meetings5)
      fake = await startFakeScribed({ dir: path.join(path.dirname(home), 'r') })
    }
  })
  t.after(() => fake?.stop())
  const started = await h.api('/api/meetings/start', 'POST', { tag: 'pessoal' })
  assert.equal(started.status, 202, JSON.stringify(started.data))
  const meetingId = started.data.recorder.meetingId
  const pins = async () => (await h.api(`/api/meetings/${meetingId}`)).data.pins.length
  const vault = await h.wrapped('vault-mcp')
  const page = await openDeck(browser, h, `/s/${vault.id}`)
  await page.waitForSelector('.terminal-view .xterm-rows')
  await page.waitForSelector('.rec-bar--recording')
  await page.click('.terminal-view .xterm-screen')
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
  const typedBefore = typedInto(vault.log)
  await page.keyboard.press('Alt+KeyP')
  await until(() => typedInto(vault.log).length > typedBefore.length, { timeout: 5000, message: 'the PTY to receive Alt P' })
  assert.equal(typedInto(vault.log).slice(typedBefore.length), '\u001bp', 'the PTY receives ESC p')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await pins(), 0, 'no pin from the terminal')
  await page.keyboard.press('Alt+Escape')
  await page.waitForFunction(() => !document.activeElement?.classList.contains('xterm-helper-textarea'))
  await page.keyboard.press('Alt+KeyP')
  await until(async () => (await pins()) === 1, { timeout: 5000, message: 'the pin from outside the terminal' })
})

test('keyboard (M4): Stop and summarize is never a form default: Enter in the ask composer asks and stops nothing', async t => {
  const h = await startMeetings(t, { web: web.dir })
  await h.record('pessoal')
  const page = await openDeck(browser, h, '/meetings/live')
  await page.waitForSelector('.rec-bar--recording')
  const stop = await page.$eval('button.button--danger-confirm', node => ({ text: node.textContent, type: node.getAttribute('type'), form: node.closest('form') !== null, focused: node === document.activeElement }))
  assert.deepEqual(stop, { text: 'Stop and summarize', type: 'button', form: false, focused: false })
  await page.fill('.live-ask-input', meetingsUi.ask.question)
  await page.press('.live-ask-input', 'Enter')
  await page.waitForSelector('.live-ask-answer')
  const commands = h.fake.received.map(row => row.parsed?.cmd)
  assert.ok(commands.includes('ask'), 'Enter asked')
  assert.equal(commands.includes('stop'), false, 'Enter stopped nothing')
  assert.equal((await h.recorder()).state, 'recording')
})
