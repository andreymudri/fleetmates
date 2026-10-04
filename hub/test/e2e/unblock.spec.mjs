// M3 Unblock end to end (docs/deck/12-milestones.md section 5 exit criteria 1, 2 and 3, 09-testing.md section 11):
// the built app served by the real deck server, a real deckd started in this process with an explicit login
// environment (so no login shell runs), the real deck-hook registered in a temporary HOME and fake claude
// (hub/test/fake-claude/fake-claude.mjs) as `claude`, driven in headless Chromium through playwright-core. The
// harness is the control harness of control.spec.mjs; the fixture is hub/test/fixtures/ui/unblock.json.
//
// Bash frames are the SYNTHETIC 2.1.285 frames of Task 10 (D-95): no captured Bash frame shows a Safe command or a
// "don't ask again" option.
//
// Not part of `npm --prefix hub test`. Run from hub/ with:
//   mkdir -p /tmp/hx && TMPDIR=/tmp/hx node --test --test-concurrency=1 test/e2e/unblock.spec.mjs
// CHROMIUM_PATH overrides /usr/bin/chromium.
//
// This file also exports the harness accessibility.spec.mjs and security.spec.mjs use. Its tests register only when
// it is the entry file (`import.meta.main`), so importing it runs nothing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { TOKEN, buildWeb, card, hub, launchBrowser, openDeck, until } from './observe.spec.mjs'
import { control, logEntries, placed, startControl } from './control.spec.mjs'

/** The parsed `hub/test/fixtures/ui/unblock.json`. */
export const unblock = JSON.parse(await readFile(new URL('../fixtures/ui/unblock.json', import.meta.url), 'utf8'))

/**
 * The settings file of a fixture repo under the deck's temporary HOME.
 * @param {{ home: string }} h
 * @param {string} repo
 * @returns {string}
 */
export const settingsFile = (h, repo) => path.join(placed(control.scanRoot, h.home), repo, '.claude', 'settings.local.json')

/**
 * Write `rules5`: each repo's `.claude/settings.local.json` holding its allow rules.
 * @param {string} home
 */
async function writeRules5(home) {
  for (const [repo, allow] of Object.entries(unblock.rules5)) {
    const dir = path.join(placed(control.scanRoot, home), repo, '.claude')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'settings.local.json'), JSON.stringify({ permissions: { allow } }, null, 2) + '\n')
  }
}

/**
 * Spawn a wrapped fake claude in a fixture repo through deckd, as `fm claude` does, and wait for its session row and
 * for the fake to be ready. The PTY is 120 x 40, as in hub/test/integration/answer-api.test.mjs: at the 100 x 30 of
 * the control harness's `wrapped`, the server left the synthetic Bash prompt's request `unknown`, never `on_screen`.
 * @param {object} h the control harness
 * @param {string} repo
 * @param {string | object} script a fixture script name or inline script
 */
async function spawnWide(h, repo, script) {
  const n = (h.spawned = (h.spawned ?? 0) + 1)
  const file = path.join(h.dir, `unblock-${n}.json`)
  const log = path.join(h.dir, `unblock-${n}.log`)
  const value = typeof script === 'string' ? JSON.parse(await readFile(path.join(hub, 'test/fixtures/scripts', `${script}.json`), 'utf8')) : script
  await writeFile(file, JSON.stringify(value))
  const cwd = path.join(placed(control.scanRoot, h.home), repo)
  const { ptyId } = await h.terminal.request('spawn', { cwd, argv: ['claude'], cols: 120, rows: 40, origin: 'wrapped',
    env: { ...h.loginEnv, FAKE_CLAUDE_SCRIPT: file, FAKE_CLAUDE_LOG: log } })
  const row = await until(() => h.sessionOfPty(ptyId), { message: `the session row of ${repo}` })
  await until(() => logEntries(log).some(entry => entry.ready), { message: `the fake claude in ${repo} to be ready` })
  return { ...row, ptyId, log, cwd }
}

/**
 * Start an unblock deck: the control deck (real deckd, server, deck-hook, fake claude, the control repos), with the
 * rule threshold at the fixture's value, `rules5` written when `rules` is set, and helpers for PTY sessions and
 * their requests.
 * @param {{ after?: Function }} t
 * @param {{ web: string, rules?: boolean, team?: boolean, threshold?: number | null, prepare?: Function, repos?: string[] }} options
 */
export async function startUnblock(t, { rules = false, team = false, threshold = unblock.threshold, prepare, ...options }) {
  const h = await startControl(t, { ...options, team, prepare: async context => {
    if (rules) await writeRules5(context.home)
    await prepare?.(context)
  } })
  assert.equal((await h.api('/api/prefs', 'PATCH', { ruleSuggestAfter: threshold })).status, 200)
  // The answer scripts and the synthetic frames are 2.1.285's; `wrapped` spawns with this same login environment.
  h.loginEnv.FAKE_CLAUDE_VERSION = unblock.claudeCodeVersion
  Object.assign(h, {
    /** A `requests` row by id. */
    row: id => h.deck.store.get('SELECT * FROM requests WHERE id = ?', id),
    /**
     * The open request of a session whose summary is `summary`; with `onScreen` (the default) once the server
     * matched it to the prompt on the PTY screen.
     */
    request(sessionId, summary, { onScreen = true } = {}) {
      return until(() => {
        const found = h.deck.store.get("SELECT * FROM requests WHERE session_id = ? AND summary = ? AND state = 'open' ORDER BY created_at DESC", sessionId, summary)
        return found && (!onScreen || found.screen_match === 'on_screen') ? found : null
      }, { message: `request ${summary}${onScreen ? ' on screen' : ''}` })
    },
    /**
     * Spawn a fixture PTY session (`{ repo, script, summary? }`) and, when it names a summary, wait for its request
     * on screen. Returns the session row, its log and the request.
     */
    async pty(spec) {
      const session = await spawnWide(h, spec.repo, spec.script)
      const request = spec.summary ? await h.request(session.id, spec.summary) : null
      return { ...session, request }
    },
    /** The fixture's observed session, fed through the hooks socket; returns its session id. */
    observedSession: () => h.observe(unblock.sessions.observed),
    /** Every fake claude input of a session log, one entry per chunk. */
    inputs: log => logEntries(log).filter(entry => typeof entry.input === 'string').map(entry => entry.input)
  })
  return h
}

/**
 * Record every non-GET `/api/*` request a page sends, as `METHOD path` with its JSON body.
 * @param {import('playwright-core').Page} page
 * @returns {{ method: string, path: string, body: any }[]}
 */
export function writesOf(page) {
  const writes = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'GET' || !url.pathname.startsWith('/api/')) return
    let body = null
    try { body = request.postDataJSON() } catch {}
    writes.push({ method: request.method(), path: url.pathname + url.search, body })
  })
  return writes
}

/** The answer requests among recorded writes. */
export const answersIn = writes => writes.filter(write => write.path.startsWith('/api/requests/'))

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
  const deck = (t, options = {}) => startUnblock(t, { web: web.dir, ...options })
  const [safeSpec, destructiveSpec] = unblock.sessions.pty

  const cautionSpec = unblock.promptBar.caution
  const drawerRow = id => `.drawer-row[data-request="${id}"]`
  const focusedRow = page => page.evaluate(() => document.activeElement?.closest('.drawer-row')?.dataset.request ?? null)
  // Leave the Focus terminal without leaving the page: a click on the bar's (unfocusable) summary blurs it.
  const blurTerminal = async page => {
    await page.click('.prompt-bar-summary')
    await page.waitForFunction(() => !document.activeElement?.classList.contains('xterm-helper-textarea'), null, { timeout: 5000 })
  }
  /**
   * Open Focus on a PTY session at 2560 x 1440 and wait for its PromptBar of `tier`, then blur the terminal. The
   * Focus terminal resizes the PTY to its own size and the fake does not redraw; at the default 1920 x 1080 the
   * PTY became 116 x 36 and the server moved the synthetic Bash prompt's request from `on_screen` to `queued`.
   */
  const openFocus = async (h, session, tier) => {
    const page = await openDeck(browser, h, `/s/${session.id}`, { viewport: { width: 2560, height: 1440 } })
    await page.waitForSelector(`.prompt-bar--${tier}`)
    await page.waitForSelector('.terminal-view .xterm-rows')
    await blurTerminal(page)
    await page.waitForTimeout(300)
    assert.equal(h.row(session.request.id).screen_match, 'on_screen', 'the resized PTY keeps the prompt on screen')
    await page.waitForSelector(`.prompt-bar--${tier}`)
    return page
  }

  spec('Exit criterion 1 (drawer): Enter and Alt A on a Destructive row send nothing; its checkbox ticks only by click or Space; Alt Shift A leaves the Destructive and Caution rows', async t => {
    const h = await deck(t)
    const safe = await h.pty(safeSpec)
    const caution = await h.pty(cautionSpec)
    const destructive = await h.pty(destructiveSpec)
    assert.deepEqual([safe.request.tier, caution.request.tier, destructive.request.tier], ['safe', 'caution', 'destructive'])
    const page = await openDeck(browser, h)
    const writes = writesOf(page)
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector(drawerRow(destructive.request.id))
    // Down moves row by row; on the Destructive row focus lands on its checkbox.
    while (await focusedRow(page) !== destructive.request.id) await page.keyboard.press('ArrowDown')
    const box = `${drawerRow(destructive.request.id)} .answer-confirm input`
    const allow = `${drawerRow(destructive.request.id)} .answer-buttons .button--danger`
    assert.equal(await page.evaluate(selector => document.activeElement === document.querySelector(selector), box), true, 'the checkbox has focus')
    for (const key of ['Enter', 'Alt+KeyA', 'Enter']) await page.keyboard.press(key)
    assert.equal(await page.isChecked(box), false, 'Enter and Alt A leave the checkbox unticked')
    assert.equal(await page.isDisabled(allow), true, 'Allow once stays disabled')
    await page.keyboard.press('Space')
    assert.equal(await page.isChecked(box), true, 'Space ticks it')
    assert.equal(await page.isDisabled(allow), false)
    await page.click(box)
    assert.equal(await page.isChecked(box), false, 'a click unticks it')
    await page.click(box)
    assert.equal(await page.isChecked(box), true, 'a click ticks it')
    await page.keyboard.press('Space')
    assert.equal(await page.isChecked(box), false)
    await page.keyboard.press('Alt+KeyA')
    await page.waitForTimeout(300)
    assert.deepEqual(answersIn(writes), [], 'no answer request from Enter or Alt A on the Destructive row')

    await page.keyboard.press('Alt+Shift+KeyA')
    await until(() => answersIn(writes).length === 1, { message: 'the Safe batch' })
    assert.deepEqual(answersIn(writes), [{ method: 'POST', path: '/api/requests/answer-batch', body: { ids: [safe.request.id], choice: 'allow' } }], 'the batch holds the Safe row only')
    await until(() => h.row(safe.request.id).state === 'answered', { message: 'the Safe request to be answered' })
    assert.deepEqual(h.inputs(safe.log), ['1'])
    await page.waitForTimeout(300)
    assert.deepEqual([h.inputs(caution.log), h.inputs(destructive.log)], [[], []], 'nothing reached the Caution and Destructive prompts')
    assert.deepEqual([h.row(caution.request.id).state, h.row(destructive.request.id).state], ['open', 'open'])
    assert.deepEqual(page.errors, [])
  })

  spec('Exit criterion 1 (Home, palette, PromptBar): a Destructive card has no Allow; palette Enter opens the drawer on it; PromptBar digit 1 sends nothing', async t => {
    const h = await deck(t)
    const destructive = await h.pty(destructiveSpec)
    const page = await openDeck(browser, h)
    const writes = writesOf(page)
    const cardBox = card(page, destructive.id)
    await cardBox.locator('.request-answer').waitFor({ timeout: 5000 })
    const buttons = await cardBox.locator('.request-answer button').allTextContents()
    assert.deepEqual(buttons, ['Review in Needs you'], 'the card offers only Review in Needs you')
    assert.equal(await cardBox.locator('button', { hasText: 'Allow' }).count(), 0, 'no Allow on a Destructive card')

    await page.keyboard.press('Alt+KeyK')
    await page.waitForSelector('.palette-input')
    await page.fill('.palette-input', 'rm -rf build')
    await page.keyboard.press('Enter')
    await page.waitForSelector(drawerRow(destructive.request.id))
    await page.waitForSelector('.palette', { state: 'detached' })
    assert.equal(await focusedRow(page), destructive.request.id, 'the drawer opens on the Destructive request')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.drawer', { state: 'detached' })

    const focus = await openFocus(h, destructive, 'destructive')
    const focusWrites = writesOf(focus)
    assert.equal(await focus.locator('.prompt-bar .prompt-digit').count(), 0, 'a Destructive bar shows no digit hints')
    for (const key of ['Digit1', 'Enter', 'Digit2']) await focus.keyboard.press(key)
    await focus.waitForTimeout(500)
    assert.deepEqual(answersIn([...writes, ...focusWrites]), [], 'no answer request from the card, the palette or the PromptBar digits')
    assert.deepEqual(h.inputs(destructive.log), [], 'nothing reached the Destructive prompt')
    assert.equal(h.row(destructive.request.id).state, 'open')
    assert.deepEqual(page.errors, [])
  })

  const answered = async (h, request, choice, key, log) => {
    await until(() => h.row(request.id).state === 'answered', { message: `${request.summary} to be answered with ${choice}` })
    assert.deepEqual(JSON.parse(h.row(request.id).answer), { via: 'browser', choice })
    assert.deepEqual(h.inputs(log), [key], `the fake received ${key} only`)
  }

  spec('Exit criterion 2 (PromptBar): digits 1, 2 and 3 land with approve-safe, approve-always and deny-then-instruct', async t => {
    const h = await deck(t)
    const cases = [['approve-safe', '1', 'allow', ['1', '2']], ['approve-always', '2', 'allow_always', ['1', '2', '3']], ['deny-then-instruct', '3', 'deny', ['1', '2', '3']]]
    for (const [script, key, choice, digits] of cases) {
      const session = await h.pty({ repo: 'vault-mcp', script, summary: 'npm run test' })
      assert.equal(session.request.tier, 'safe')
      const page = await openFocus(h, session, 'safe')
      // Safe shows 1 and its No option, plus 2 only where the prompt offers "don't ask again" (D-95, the synthetic frame).
      assert.deepEqual(await page.$$eval('.prompt-bar .prompt-digit', rows => rows.map(row => row.textContent)), digits, `${script}: the bar mirrors the prompt's options`)
      const writes = writesOf(page)
      await page.keyboard.press(`Digit${key}`)
      await answered(h, session.request, choice, key, session.log)
      assert.deepEqual(answersIn(writes).map(write => [write.path, write.body]), [[`/api/requests/${session.request.id}/answer`, { choice }]])
      assert.deepEqual(page.errors, [])
      await page.close()
    }
  })

  spec('Exit criterion 2 (drawer): Allow once lands 1 on approve-safe; Deny lands 3 on deny-then-instruct and its follow-up reaches the session', async t => {
    const h = await deck(t)
    const safe = await h.pty({ repo: 'vault-mcp', script: 'approve-safe', summary: 'npm run test' })
    const deny = await h.pty({ repo: 'discord-audit', script: 'deny-then-instruct', summary: 'npm run test' })
    const page = await openDeck(browser, h)
    const writes = writesOf(page)
    await page.keyboard.press('Alt+KeyU')
    await page.click(`${drawerRow(safe.request.id)} .answer-buttons .button--primary`)
    await answered(h, safe.request, 'allow', '1', safe.log)
    await page.click(`${drawerRow(deny.request.id)} .answer-buttons button:text-is("Deny")`)
    await answered(h, deny.request, 'deny', '3', deny.log)
    // The denied row stays with "Tell Claude what to do instead" (state-machines 2.5).
    const followup = `${drawerRow(deny.request.id)} .drawer-followup`
    await page.waitForSelector(followup)
    assert.equal(await page.textContent(`${followup} .drawer-followup-label`), 'Tell Claude what to do instead')
    await page.fill(`${followup} input`, 'use pnpm instead')
    await page.click(`${followup} button[type="submit"]`)
    await until(() => logEntries(deny.log).some(entry => entry.expectInput), { message: 'the follow-up paste' })
    assert.equal(logEntries(deny.log).find(entry => entry.expectInput).expectInput, '\x1b[200~use pnpm instead\x1b[201~\r')
    assert.deepEqual(answersIn(writes).map(write => write.path), [`/api/requests/${safe.request.id}/answer`, `/api/requests/${deny.request.id}/answer`, `/api/requests/${deny.request.id}/followup`])
    assert.deepEqual(page.errors, [])
  })

  spec('Exit criterion 2 (did-not-land, answered-in-terminal): an unproved answer shows the error after 3 s; a terminal answer refuses the browser one and the row says so', async t => {
    const h = await deck(t)
    const lost = await h.pty(cautionSpec)
    const page = await openDeck(browser, h)
    await page.keyboard.press('Alt+KeyU')
    const sent = Date.now()
    await page.click(`${drawerRow(lost.request.id)} .answer-buttons .button--primary`)
    const error = `${drawerRow(lost.request.id)} .answer-line--error`
    await page.waitForSelector(error, { timeout: 10_000 })
    const took = Date.now() - sent
    assert.equal(await page.textContent(error), `Your answer did not reach ${cautionSpec.repo}. The prompt is still open in its terminal.`)
    assert.ok(took >= 2900, `the error shows after the 3 s proof window (${took} ms)`)
    assert.equal(h.row(lost.request.id).delivery, 'did_not_land')
    assert.equal(h.row(lost.request.id).state, 'open', 'the deck does not retry on its own')
    assert.deepEqual(h.inputs(lost.log), ['1'])

    const terminal = await h.pty({ repo: 'vault-mcp', script: 'answered-in-terminal', summary: 'npm run test' })
    await page.waitForSelector(drawerRow(terminal.request.id))
    await h.terminal.request('write', { ptyId: terminal.ptyId, data: Buffer.from('1').toString('base64'), source: { kind: 'terminal', name: 'control-harness' } })
    await page.waitForSelector(`${drawerRow(terminal.request.id)} .drawer-note`)
    assert.equal(await page.textContent(`${drawerRow(terminal.request.id)} .drawer-note`), 'Answered in the terminal')
    const refused = await page.evaluate(async ({ id, token }) => {
      const response = await fetch(`/api/requests/${id}/answer`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: 'allow' }) })
      return { status: response.status, code: (await response.json()).error?.code }
    }, { id: terminal.request.id, token: TOKEN })
    assert.deepEqual(refused, { status: 409, code: 'request_closed' })
    assert.deepEqual(JSON.parse(h.row(terminal.request.id).answer), { via: 'terminal', choice: 'allow' })
    assert.deepEqual(h.inputs(terminal.log), ['1'], 'only the terminal key reached the session')
    assert.deepEqual(page.errors, [])
  })

  spec('Exit criterion 3: three Safe approvals offer "Make it a rule?"; accepting writes the rule and keeps every other key, Undo removes it as an undo, and a hand-added rule shows "added by hand"', async t => {
    const repo = 'vault-mcp'
    const pattern = 'Bash(npm run test)'
    const h = await deck(t, { prepare: async ({ home }) => {
      const file = path.join(placed(control.scanRoot, home), repo, '.claude', 'settings.local.json')
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, unblock.settingsLocal)
    } })
    const file = settingsFile(h, repo)
    assert.equal((await h.api('/api/prefs')).data.prefs.ruleSuggestAfter, 3, 'the threshold is 3')
    const three = []
    for (let i = 0; i < 3; i++) three.push(await h.pty({ repo, script: 'approve-safe', summary: 'npm run test' }))
    // Reduced motion: a card needing approval pulses otherwise, and a pulsing button never settles for a click.
    const page = await openDeck(browser, h, '/', { reducedMotion: 'reduce' })
    const writes = writesOf(page)
    await page.keyboard.press('Alt+KeyU')
    await page.waitForSelector('.drawer-batch button')
    assert.equal(await page.textContent('.drawer-batch button'), 'Allow all 3 Safe once')
    assert.equal(await page.locator('.drawer-rule').count(), 0, 'no offer before the approvals')
    await page.click('.drawer-batch button')
    for (const session of three) await until(() => h.row(session.request.id).state === 'answered', { message: 'each Safe approval' })
    // The drawer lists offers beside open requests: a fourth request in the repo brings the offer on screen.
    const fourth = await h.pty({ repo, script: 'approve-safe', summary: 'npm run test' })
    await page.waitForSelector('.drawer-rule-accept')
    assert.equal(await page.textContent('.drawer-rule-accept'), `You allowed npm run test in ${repo} 3 times. Make it a rule?`)
    // Close, not Esc: after the batch the answered rows left and focus fell out of the drawer (finding T17-F2).
    await page.click('.drawer-close')
    await page.waitForSelector('.drawer', { state: 'detached' })

    // The fourth request's Home card carries the offer too; accepting it there writes the rule.
    const accept = card(page, fourth.id).locator('.card-rule-accept')
    await accept.waitFor({ timeout: 5000 })
    assert.equal(await accept.textContent(), `Allowed 3 times. Always allow in ${repo}?`)
    await accept.click()
    await page.waitForSelector('.archive-toast')
    assert.equal(await page.textContent('.archive-toast-text'), `Rule added to ${repo}: ${pattern}`)
    const before = JSON.parse(unblock.settingsLocal)
    const written = fs.readFileSync(file, 'utf8')
    const after = JSON.parse(written)
    assert.deepEqual(after.permissions.allow, [pattern], 'the rule is in the allow list')
    assert.deepEqual(Object.keys(after), Object.keys(before), 'top-level keys keep their order')
    assert.deepEqual(Object.keys(after.permissions), Object.keys(before.permissions), 'permissions keys keep their order')
    assert.equal(written.replace(`[\n      "${pattern}"\n    ]`, '[]'), unblock.settingsLocal, 'every other byte is unchanged')

    await page.click('.archive-toast button:text-is("Undo")')
    await until(() => !fs.readFileSync(file, 'utf8').includes(pattern), { message: 'Undo to remove the rule' })
    assert.equal(fs.readFileSync(file, 'utf8'), unblock.settingsLocal, 'Undo restores the file byte for byte')
    const repoId = h.deck.store.get('SELECT repo_id FROM sessions WHERE id = ?', fourth.id).repo_id
    const audit = h.deck.store.all('SELECT action, actor FROM rule_audit WHERE repo_id = ? AND pattern = ? ORDER BY id', repoId, pattern).map(row => ({ ...row }))
    assert.deepEqual(audit, [{ action: 'added', actor: 'suggestion' }, { action: 'undo', actor: 'manual' }], 'the toast Undo is recorded as an undo')
    const ruleWrites = writes.filter(write => write.path.startsWith('/api/rules'))
    assert.deepEqual(ruleWrites.map(write => `${write.method} ${write.path}`), ['POST /api/rules', `DELETE /api/rules/${repo}/${encodeURIComponent(pattern)}?undo=1`])

    // A rule added to the file by hand shows "added by hand" once Settings is opened again.
    const hand = JSON.parse(fs.readFileSync(file, 'utf8'))
    hand.permissions.allow.push(unblock.byHand)
    fs.writeFileSync(file, JSON.stringify(hand, null, 2) + '\n')
    await page.goto(`${h.base}/settings/rules`)
    const row = page.locator('.rule-row', { has: page.locator('.rule-pattern', { hasText: unblock.byHand }) })
    await row.waitFor({ timeout: 5000 })
    assert.equal(await row.locator('.rule-meta').textContent(), 'added by hand')
    assert.deepEqual(page.errors, [])
  })

  /**
   * The team run's lead as a PTY session (the control fixture's lead is observed, so its rows cannot be answered):
   * the `--run` dispatch call that makes it the lead, then a Bash request in the T4 worktree and one in T5, each
   * prompted in turn on the SYNTHETIC bash frame and allowed with 1.
   */
  const leadScript = (team, worktrees) => {
    const clear = { print: '\u001b[2J\u001b[H' }
    const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command, description: command }, cwd })
    const ask = (command, taskId) => [clear, { frame: 'synthetic-permission-bash', vars: { cmd: command, description: command } },
      { expectKey: { 1: 'yes', timeoutMs: 120000 } }, { hook: 'PostToolUse', variant: 'Bash', with: bash(command, worktrees[taskId]) }]
    // deck-hook is registered async, so the fake does not wait for it and fires these hooks within about a
    // millisecond of each other; each deck-hook process stamps its own hookTs (hub/hook/deck-hook.mjs `main`), so
    // stamps that close can come out inverted, and in some runs here they did. A real session spaces these hooks
    // by seconds (the captured 2.1.285 sequence: PreToolUse 2062 ms after UserPromptSubmit, PermissionRequest
    // 53 ms after that), so the pause stands in for that spacing. A late `--run` PreToolUse losing the lead join
    // is Task 24's case (run-join.test.mjs), not this suite's.
    const spaced = hooks => hooks.flatMap(hook => [hook, { sleep: 150 }])
    return { version: unblock.claudeCodeVersion, sessionId: 'auto', steps: [
      ...spaced([
        { hook: 'SessionStart', with: { source: 'startup' } },
        { hook: 'UserPromptSubmit', with: { prompt: team.lead.prompt } },
        { hook: 'PreToolUse', variant: 'Bash', with: { tool_name: 'Bash', tool_input: { command: team.lead.command } } },
        { hook: 'PreToolUse', variant: 'Bash', with: bash('npm run test', worktrees.T4) },
        { hook: 'PermissionRequest', variant: 'Bash', with: bash('npm run test', worktrees.T4) },
        { hook: 'PreToolUse', variant: 'Bash', with: bash('npm run lint', worktrees.T5) },
        { hook: 'PermissionRequest', variant: 'Bash', with: bash('npm run lint', worktrees.T5) }
      ]),
      ...ask('npm run test', 'T4'), ...ask('npm run lint', 'T5'), clear, { frame: 'idle-input' }, { sleep: 600000 }
    ] }
  }

  spec('Team: "Review 2 requests" opens the drawer on the run\'s rows only, and its keys answer only those rows', async t => {
    const h = await deck(t, { team: true })
    const outside = await h.pty(safeSpec)
    const lead = await spawnWide(h, control.team.repo, leadScript(control.team, h.team.worktrees))
    const t4 = await h.request(lead.id, 'npm run test')
    const t5 = await h.request(lead.id, 'npm run lint', { onScreen: false })
    assert.deepEqual([t4.task_id, t5.task_id], ['T4', 'T5'])
    // The tier of a run row is not what this test pins (in task worktrees T4 has come out Caution and T5 either tier);
    // the outside request is Safe, so an Alt Shift A that ignored the filter would take it.
    t.diagnostic(`run request tiers: T4 ${t4.tier}, T5 ${t5.tier}`)
    assert.equal(outside.request.tier, 'safe')
    const page = await openDeck(browser, h, `/runs/${control.team.repo}/${control.team.runId}`, { reducedMotion: 'reduce' })
    const writes = writesOf(page)
    const review = page.locator('.team-actions .button--amber')
    await review.waitFor({ timeout: 10_000 })
    assert.equal(await review.textContent(), control.team.expect.review)
    await review.click()
    await page.waitForSelector('.drawer .drawer-filter')
    assert.deepEqual((await page.$$eval('.drawer-row', rows => rows.map(row => row.dataset.request))).sort(), [t4.id, t5.id].sort(), 'only the run\'s two rows')
    const first = await page.$eval('.drawer-row', row => row.dataset.request)
    assert.equal(await focusedRow(page), first, 'focus starts on the run\'s first row')
    await page.focus(`${drawerRow(t4.id)} .answer-buttons .button--primary:not([disabled])`)
    await page.keyboard.press('Alt+KeyA')
    await until(() => h.row(t4.id).state === 'answered', { message: 'T4 to be answered' })
    await h.request(lead.id, 'npm run lint')
    // Finding T17-F2 (accessibility.spec.mjs): once the answered row leaves, focus falls to the page body and the
    // drawer's keys stop; focus is put back on the T5 row, as a click would.
    const t5Allow = `${drawerRow(t5.id)} .answer-buttons .button--primary:not([disabled])`
    await page.focus(t5Allow)
    // Allow all Safe covers only the rows the filter shows: T5 when it is Safe, never the Safe request outside the run.
    await page.keyboard.press('Alt+Shift+KeyA')
    await page.waitForTimeout(500)
    if (h.row(t5.id).state === 'open' && !['sending', 'verifying'].includes(h.row(t5.id).delivery)) {
      await page.focus(t5Allow)
      await page.keyboard.press('Alt+KeyA')
    }
    await until(() => h.row(t5.id).state === 'answered', { message: 'T5 to be answered' })
    const answers = answersIn(writes)
    assert.deepEqual([answers[0].path, answers[0].body], [`/api/requests/${t4.id}/answer`, { choice: 'allow' }])
    for (const write of answers.slice(1)) {
      if (write.path === '/api/requests/answer-batch') assert.deepEqual(write.body, { ids: [t5.id], choice: 'allow' }, 'a batch holds the run\'s T5 only')
      else assert.deepEqual([write.path, write.body], [`/api/requests/${t5.id}/answer`, { choice: 'allow' }])
    }
    assert.ok(!JSON.stringify(answers).includes(outside.request.id), 'no answer names the request outside the run')
    assert.deepEqual(h.inputs(lead.log), ['1', '1'])
    await page.waitForTimeout(300)
    assert.deepEqual(h.inputs(outside.log), [], 'nothing reached the session outside the run')
    assert.equal(h.row(outside.request.id).state, 'open')
    assert.deepEqual(page.errors, [])
  })

  // Finding T17-F1 (S2, qa-checklist 0.4 "missing state"): the session's changed files carry the absolute path of the
  // Edit hook (as the captured 2.1.285 hooks do), Focus sends that path to GET /api/sessions/:id/diff, and the
  // server's diff reader refuses an absolute path (hub/server/adapters/git-diff.mjs), so every Changes diff shows
  // "Could not read the diff: validation_failed". The same request with the repo-relative path returns the diff.
  // A todo until the fix task this finding adds to the M3 plan lands; the test runs and reports either way.
  spec('Focus Changes: the diff of a file the session edited, against the baseline of its SessionStart', { todo: 'T17-F1: Focus asks for the diff by absolute path and the server refuses it' }, async t => {
    const h = await deck(t)
    const repo = 'turbidassist'
    const dir = path.join(placed(control.scanRoot, h.home), repo)
    const session = { key: 'diff', repo, sessionId: 'fx-unblock-diff' }
    const id = await h.observe(session, [{ e: 'SessionStart', ago: 60 }, { e: 'UserPromptSubmit', ago: 59, prompt: 'edit the readme' }])
    fs.writeFileSync(path.join(dir, 'README.md'), `${repo}\nedited by the session\n`)
    const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'README.md'), old_string: repo, new_string: `${repo}\nedited by the session`, replace_all: false } }
    await h.observe(session, [{ e: 'PreToolUse', ...edit }, { e: 'PostToolUse', ...edit }, { e: 'Stop' }])
    await until(() => (h.session(id).changedFiles ?? []).length === 1, { message: 'the changed file' })
    const page = await openDeck(browser, h, `/s/${id}?tab=changes`)
    await page.waitForSelector('.diff-view:not(.diff-view--loading)')
    assert.equal(await page.locator('.diff-view--error').count(), 0, `the diff loads: ${await page.locator('.diff-view').textContent()}`)
    const shownPath = await page.textContent('.focus-file-path')
    assert.equal(await page.textContent('.diff-caption'), `${shownPath} · unified (panel is narrow)`)
    assert.deepEqual(await page.$$eval('.diff-line--add', rows => rows.map(row => row.textContent)), ['+edited by the session\n'])
    assert.deepEqual(await page.$$eval('.diff-line--del', rows => rows.map(row => row.textContent)), [])
    assert.ok((await page.$$eval('.diff-line--context', rows => rows.map(row => row.textContent))).includes(` ${repo}\n`), 'the unchanged line is context')
    assert.deepEqual(page.errors, [])
  })
}
