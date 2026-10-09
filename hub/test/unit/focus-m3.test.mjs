// Focus M3 (docs/deck/screens/focus.md 4.3, 4.5, 5.3, 6, 8; state-machines 2.5 and 3.4): the PromptBar that
// mirrors the on-screen prompt, its digit keys, and the Changes tab DiffView. Pure FocusView trees and, for the
// key and fetch wiring, the real Focus route in headless Chromium with a recording API double.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { findChromium } from '../helpers/chromium.mjs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, runnerImport } from 'vite'
import { chromium } from 'playwright-core'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load(file = 'web/src/screens/focus/Focus.jsx') {
  const { module } = await runnerImport(path.join(hub, file), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const NOW = Date.UTC(2026, 9, 2, 18, 42)
const MIN = 60_000

// Walk a pure tree, expanding function components except the ones with hooks, which are kept as elements.
const KEEP = new Set(['CrewAvatar', 'TerminalView', 'ConfirmDialog', 'PromptReply'])
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    if (KEEP.has(node.type.name)) visit(node)
    else walk(node.type(node.props), visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}
const find = (tree, match) => {
  const out = []
  walk(tree, node => { if (match(node)) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return KEEP.has(node.type.name) ? '' : textOf(node.type(node.props))
  return textOf(node.props?.children)
}

const fakeClient = () => ({ attach: () => ({ write: () => true, resize: () => true, detach() {} }) })

function state({ sessions, requests = [], health = [] }) {
  return {
    loaded: true, deckdOutage: false, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/', overlay: null },
    data: {
      sessions, requests, runs: [], order: sessions.map(row => row.id), health, prefs: {}, inputSources: {}, tails: {},
      repos: [{ id: '/home/you/dev/rustot', name: 'rustot', crew: { slot: 0, seed: 'rustot', hat: 'none' } }],
      counts: null, recap: null, setup: { firstRunCompletedAt: NOW - 1000 }
    }
  }
}

const session = (extra = {}) => ({
  id: 's1', repoId: '/home/you/dev/rustot', origin: 'wrapped', ptyId: 'pty-s1', alive: true, task: 'Port the damage formula', branch: 'combat-tick',
  state: 'needs_approval', stateSince: NOW - 3 * MIN, lastActivityAt: NOW - MIN, startedAt: NOW - 60 * MIN, changedFiles: [], cwd: '/home/you/dev/rustot',
  toolCalls: 4, sessionAliases: [], lastInputFrom: null, lastInputName: null, ...extra
})

const BASH_OPTIONS = [
  { key: '1', label: 'Yes' },
  { key: '2', label: "Yes, and don't ask again for cargo test commands in /home/you/dev/rustot" },
  { key: '3', label: 'No, and tell Claude what to do differently (esc)' }
]
const request = (extra = {}) => ({
  id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', summary: 'cargo test', state: 'open', createdAt: NOW - 3 * MIN,
  delivery: 'idle', screenMatch: 'on_screen', options: BASH_OPTIONS, allowAlways: false, confirmLabel: null, ...extra
})

const view = (Focus, props) => Focus.FocusView({ now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client: fakeClient(), ...props })
const bar = tree => find(tree, node => node.props?.role === 'group' && /\bprompt-bar\b/.test(node.props.className ?? ''))[0]
const optionButtons = tree => find(bar(tree), node => node.type === 'button' && /\bprompt-option\b/.test(node.props.className ?? ''))
const digits = tree => optionButtons(tree).map(node => textOf(node).trim().split(' ')[0])

test('focus AC5: a Caution request shows options 1 and 3 only, even with allowAlways', async () => {
  const Focus = await load()
  for (const allowAlways of [false, true]) {
    const tree = view(Focus, { state: state({ sessions: [session()], requests: [request({ tier: 'caution', allowAlways })] }), sessionId: 's1' })
    assert.ok(bar(tree), 'the on-screen request gets the PromptBar')
    assert.equal(bar(tree).props['aria-label'], 'cargo test', 'the group is named after the command')
    assert.deepEqual(digits(tree), ['1', '3'], `allowAlways ${allowAlways}`)
    assert.deepEqual(optionButtons(tree).map(node => textOf(node)), ['1 Yes', '3 No, and tell Claude what to do differently (esc)'],
      'the buttons name the option with its printed digit and verbatim label')
  }
  const html = renderToStaticMarkup(view(Focus, { state: state({ sessions: [session()], requests: [request({ tier: 'caution' })] }), sessionId: 's1' }))
  assert.match(html, /Same prompt as the terminal, same keys/)
})

test('a Safe request shows 1 and 3 without allowAlways, and 1, 2 and 3 with it (D-77)', async () => {
  const Focus = await load()
  const at = allowAlways => view(Focus, { state: state({ sessions: [session()], requests: [request({ allowAlways })] }), sessionId: 's1' })
  assert.deepEqual(digits(at(false)), ['1', '3'])
  assert.deepEqual(digits(at(true)), ['1', '2', '3'])
  const always = optionButtons(at(true))[1]
  assert.equal(textOf(always), "2 Yes, and don't ask again for cargo test commands in…", 'a long label is shortened, keeping verb and scope')
  assert.equal(always.props.title, BASH_OPTIONS[1].label, 'the full label stays in title')
  const answered = []
  const tree = Focus.FocusView({ now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client: fakeClient(),
    state: state({ sessions: [session()], requests: [request({ allowAlways: true })] }), sessionId: 's1', onAnswer: (row, body) => answered.push([row.id, body]) })
  for (const node of optionButtons(tree)) node.props.onClick()
  assert.deepEqual(answered, [['r1', { choice: 'allow' }], ['r1', { choice: 'allow_always' }], ['r1', { choice: 'deny' }]])
})

test('the captured Edit prompt labels never show option 2 (allowAlways false for file tools)', async () => {
  // The 2.1.285 Edit frame lands with Task 19; the 2.1.282 frame in the tree prints the same option 2 kind.
  const { prompt } = JSON.parse(await readFile(path.join(hub, 'test/fixtures/screens/2.1.282/permission-edit.expect.json'), 'utf8'))
  assert.match(prompt.options[1].label, /^Yes, and switch to accept edits/)
  const Focus = await load()
  const edit = request({ summary: 'Edit notes.txt', options: prompt.options, allowAlways: false })
  const tree = view(Focus, { state: state({ sessions: [session()], requests: [edit] }), sessionId: 's1' })
  assert.deepEqual(digits(tree), ['1', '3'])
  assert.doesNotMatch(renderToStaticMarkup(tree), /accept edits/)
})

test('a Destructive request shows the checkbox, option 1 as danger-confirm disabled until checked, and 3, without digit hints', async () => {
  const Focus = await load()
  const destructive = request({ tier: 'destructive', summary: 'rm -rf build', allowAlways: true, confirmLabel: 'Delete build and everything in it' })
  const at = confirmed => view(Focus, { state: state({ sessions: [session()], requests: [destructive] }), sessionId: 's1', confirmed })
  const tree = at(false)
  assert.equal(find(bar(tree), node => node.type === 'input' && node.props.type === 'checkbox').length, 1)
  assert.match(renderToStaticMarkup(tree), /Delete build and everything in it/)
  const buttons = optionButtons(tree)
  assert.deepEqual(buttons.map(node => textOf(node)), ['Yes', 'No, and tell Claude what to do differently (esc)'], 'no option 2 and no digit hint')
  assert.equal(find(bar(tree), node => node.type === 'kbd').length, 0)
  assert.match(buttons[0].props.className, /danger-confirm/)
  assert.equal(buttons[0].props.disabled, true)
  assert.equal(optionButtons(at(true))[0].props.disabled, false)
})

test('PromptBar states: deckd down, typing guard, did not land with Try again, and unreadable options', async () => {
  const Focus = await load()
  const html = (requestExtra, props = {}, health = []) => renderToStaticMarkup(view(Focus, {
    state: state({ sessions: [session()], requests: [request(requestExtra)], health }), sessionId: 's1', ...props
  }))
  const down = view(Focus, { state: state({ sessions: [session()], requests: [request()], health: [{ dep: 'deckd', state: 'down' }] }), sessionId: 's1' })
  assert.ok(optionButtons(down).every(node => node.props.disabled === true), 'deckd down disables the options')
  assert.match(renderToStaticMarkup(bar(down)), /deckd is reconnecting/)
  assert.match(html({}, { answer: { requestId: 'r1', busy: { choice: 'allow' }, guard: 'typing' } }), /You are typing in the terminal\. Answer there, or try again in a second\./)
  const lost = html({ delivery: 'did_not_land' }, { answer: { requestId: 'r1', busy: { choice: 'allow' }, guard: null } })
  assert.match(lost, /Your answer did not reach rustot\. The prompt is still open in its terminal\./)
  assert.match(lost, />Try again</)
  const empty = html({ options: [] })
  assert.match(empty, /Answer in the terminal/)
  assert.doesNotMatch(empty, /prompt-option/)
  const queued = renderToStaticMarkup(view(Focus, { state: state({ sessions: [session()], requests: [request({ screenMatch: 'queued' })] }), sessionId: 's1' }))
  assert.doesNotMatch(queued, /prompt-bar/, 'only the on-screen request gets the PromptBar')
})

test('digit keys: 1 allows a Safe request with the terminal unfocused and does nothing on a Destructive one', async () => {
  const { promptKeyBody } = await load('web/src/components/PromptBar.jsx')
  const key = (k, extra = {}) => ({ key: k, target: { tagName: 'DIV' }, ...extra })
  assert.deepEqual(promptKeyBody(key('1'), { request: request(), terminalFocused: false }), { choice: 'allow' })
  assert.deepEqual(promptKeyBody(key('3'), { request: request({ tier: 'caution' }), terminalFocused: false }), { choice: 'deny' })
  assert.equal(promptKeyBody(key('2'), { request: request(), terminalFocused: false }), null, 'option 2 is not shown without allowAlways')
  assert.equal(promptKeyBody(key('1'), { request: request(), terminalFocused: true }), null, 'the terminal has focus')
  assert.equal(promptKeyBody(key('1', { target: { tagName: 'TEXTAREA' } }), { request: request(), terminalFocused: false }), null)
  const destructive = request({ tier: 'destructive', confirmLabel: 'Delete build' })
  for (const k of ['1', '2', '3']) assert.equal(promptKeyBody(key(k), { request: destructive, terminalFocused: false }), null, `digit ${k} on Destructive`)
})

test('a diff with <script> text renders literally, with add and delete classes', async () => {
  const Focus = await load()
  const files = [{ path: 'web/index.html', adds: 1, dels: 1 }]
  const diff = { path: 'web/index.html', status: 'ready', data: {
    path: 'web/index.html', baseline: 'abc', binary: false, truncated: true,
    diff: 'diff --git a/web/index.html b/web/index.html\n--- a/web/index.html\n+++ b/web/index.html\n@@ -1 +1 @@\n-<p>old</p>\n+<script>alert(1)</script>\n'
  } }
  const tree = view(Focus, { state: state({ sessions: [session({ changedFiles: files })] }), sessionId: 's1', diff })
  const html = renderToStaticMarkup(tree)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /<span class="diff-line diff-line--add">\+&lt;script&gt;alert\(1\)&lt;\/script&gt;\n<\/span>/)
  assert.match(html, /<span class="diff-line diff-line--del">-&lt;p&gt;old&lt;\/p&gt;\n<\/span>/)
  assert.match(html, /<span class="diff-line diff-line--meta">--- a\/web\/index\.html\n<\/span>/, 'header lines are not deletions')
  assert.match(html, /web\/index\.html · unified \(panel is narrow\)/)
  assert.match(html, /Diff truncated/)
  const failed = renderToStaticMarkup(view(Focus, { state: state({ sessions: [session({ changedFiles: files })] }), sessionId: 's1',
    diff: { path: 'web/index.html', status: 'error', message: 'git timed out' } }))
  assert.match(failed, /Could not read the diff: git timed out/)
  assert.match(failed, />Retry</)
  const binary = renderToStaticMarkup(view(Focus, { state: state({ sessions: [session({ changedFiles: files })] }), sessionId: 's1',
    diff: { path: 'web/index.html', status: 'ready', data: { binary: true, size: 2_202_010, diff: '', truncated: false } } }))
  assert.match(binary, /Binary file, 2\.1 MB\. Open in editor\./)
  const source = (await readFile(path.join(hub, 'web/src/components/DiffView.jsx'), 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML/)
})

// The real Focus route with a stub terminal client and an API double that records every call in `window.calls`.
// `window.h.request(row)` replaces s1's open request.
const HARNESS = `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Focus } from '@hub/web/src/screens/focus/Focus.jsx'

const h = window.h = {}
const calls = window.calls = []
const client = { attach: () => ({ write: () => true, resize: () => true, detach() {} }) }
const api = {
  get: async to => { calls.push(['GET', to])
    const file = new URL(to, 'http://x').searchParams.get('path')
    return { path: file, baseline: 'abc', binary: false, truncated: false, diff: '@@ -1 +1 @@\\n-old ' + file + '\\n+new ' + file + '\\n' } },
  post: async (to, body) => { calls.push(['POST', to, body])
    return { request: {} } }
}
const files = [{ path: 'src/a.rs', adds: 1, dels: 1 }, { path: 'src/b.rs', adds: 2, dels: 0 }]
const row = { id: 's1', repoId: '/home/you/dev/rustot', origin: 'wrapped', ptyId: 'pty-s1', alive: true, task: 'Port', branch: 'b',
  state: 'needs_approval', stateSince: Date.now(), lastActivityAt: Date.now(), startedAt: Date.now(), changedFiles: files, cwd: '/home/you/dev/rustot',
  toolCalls: 0, sessionAliases: [], lastInputFrom: null, lastInputName: null }
function App() {
  const [request, setRequest] = useState(null)
  h.request = setRequest
  const state = {
    loaded: true, deckdOutage: false, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/', overlay: null },
    data: { sessions: [row], requests: request ? [request] : [], runs: [], order: ['s1'], health: [], prefs: {}, tails: {}, inputSources: {},
      repos: [{ id: '/home/you/dev/rustot', name: 'rustot', crew: { slot: 0, seed: 'rustot', hat: 'none' } }], counts: null, recap: null,
      setup: { firstRunCompletedAt: 1 } }
  }
  return <><span id="mark">{request ? request.id + ':' + request.tier : 'none'}</span><Focus route={{ params: { sessionId: 's1' } }} state={state} navigate={() => {}} api={api}
    search="" client={client} dispatch={() => {}} onOverlay={() => {}} /></>
}
createRoot(document.getElementById('root')).render(<App />)
`

test('the Focus route: digits answer a Safe request only outside the terminal and never a Destructive one; Down fetches the next diff (AC4, AC6, AC12)', async t => {
  const executablePath = findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the Focus browser test')
  const dir = await mkdtemp(path.join(tmpdir(), 'focus3-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div id="root" style="width:1600px;height:900px"></div><script type="module" src="./entry.jsx"></script></body></html>')
  await writeFile(path.join(dir, 'entry.jsx'), HARNESS)
  const out = path.join(dir, 'dist')
  await build({
    root: dir, base: './', configFile: false, logLevel: 'silent',
    resolve: { alias: { '@hub': hub, react: path.join(hub, 'node_modules/react'), 'react-dom': path.join(hub, 'node_modules/react-dom') } },
    build: { outDir: out, emptyOutDir: true }
  })
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://x').pathname
    try {
      const body = await readFile(path.join(out, name === '/' ? 'index.html' : path.normalize(name)))
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }).end(body)
    } catch { res.writeHead(404).end() }
  }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => server.close())
  const browser = await chromium.launch({ executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => document.getElementById('mark')?.textContent === 'none', null, { timeout: 10_000 })
  const posts = () => page.evaluate(() => window.calls.filter(call => call[0] === 'POST'))
  const gets = () => page.evaluate(() => window.calls.filter(call => call[0] === 'GET').map(call => call[1]))
  const setRequest = async row => {
    await page.evaluate(value => window.h.request(value), row)
    await page.waitForFunction(want => document.getElementById('mark')?.textContent === want, `${row.id}:${row.tier}`, { timeout: 5000 })
  }
  const safe = { id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', summary: 'cargo test', state: 'open', createdAt: 1, delivery: 'idle',
    screenMatch: 'on_screen', options: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }], allowAlways: false, confirmLabel: null }

  // AC12: the first file's diff loads on open; Down in the listbox selects the next file and fetches its diff.
  await page.waitForFunction(() => document.querySelector('.diff-line--add')?.textContent.includes('new src/a.rs'), null, { timeout: 5000 })
  assert.deepEqual(await gets(), ['/api/sessions/s1/diff?path=src%2Fa.rs'])
  await page.focus('[role="listbox"]')
  await page.keyboard.press('ArrowDown')
  await page.waitForFunction(() => document.querySelector('.diff-line--add')?.textContent.includes('new src/b.rs'), null, { timeout: 5000 })
  assert.deepEqual(await gets(), ['/api/sessions/s1/diff?path=src%2Fa.rs', '/api/sessions/s1/diff?path=src%2Fb.rs'])
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map(node => node.getAttribute('aria-selected'))), ['false', 'true'])
  assert.match(await page.evaluate(() => document.querySelector('.diff-caption').textContent), /^src\/b\.rs · unified \(panel is narrow\)$/)

  // AC4: with the listbox (not the terminal) focused, 1 allows the Safe request through the answer route.
  await setRequest(safe)
  await page.keyboard.press('1')
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'POST'), null, { timeout: 5000 })
  assert.deepEqual(await posts(), [['POST', '/api/requests/r1/answer', { choice: 'allow' }]])

  // Inside the terminal the digit belongs to Claude Code, not to the bar.
  await page.click('.terminal-view')
  await page.waitForFunction(() => !!document.activeElement?.closest('.terminal-view'), null, { timeout: 5000 })
  await setRequest({ ...safe, id: 'r2' })
  await page.keyboard.press('1')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)))
  assert.equal((await posts()).length, 1, 'no answer while the terminal has focus')

  // AC6: a Destructive request ignores 1 even outside the terminal; the checkbox and option 1 send it.
  await page.focus('[role="listbox"]')
  await page.waitForFunction(() => !document.activeElement?.closest('.terminal-view'), null, { timeout: 5000 })
  await setRequest({ ...safe, id: 'r3', tier: 'destructive', summary: 'rm -rf build', confirmLabel: 'Delete build' })
  for (const digit of ['1', '2', '3']) await page.keyboard.press(digit)
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)))
  assert.equal((await posts()).length, 1, 'digits do nothing on a Destructive request')
  await page.click('.prompt-bar input[type="checkbox"]')
  await page.click('.prompt-option--danger-confirm')
  await page.waitForFunction(() => window.calls.filter(call => call[0] === 'POST').length === 2, null, { timeout: 5000 })
  assert.deepEqual((await posts())[1], ['POST', '/api/requests/r3/answer', { choice: 'allow', confirm: true }])

  // The tick belongs to one request: a new Destructive request arrives unticked with its Allow disabled,
  // and a changed summary on the same request clears a tick too (state-machines 2.5).
  const guard = () => page.evaluate(() => ({
    checked: document.querySelector('.prompt-bar input[type="checkbox"]').checked,
    disabled: document.querySelector('.prompt-option--danger-confirm').disabled
  }))
  await setRequest({ ...safe, id: 'r4', tier: 'destructive', summary: 'git push --force', confirmLabel: 'I checked the 3 commits' })
  assert.deepEqual(await guard(), { checked: false, disabled: true }, 'a new request does not inherit the previous tick')
  await page.click('.prompt-bar input[type="checkbox"]')
  assert.deepEqual(await guard(), { checked: true, disabled: false })
  await page.evaluate(row => window.h.request(row), { ...safe, id: 'r4', tier: 'destructive', summary: 'git push --force origin main', confirmLabel: 'I checked the 3 commits' })
  await page.waitForFunction(() => document.querySelector('.prompt-bar')?.textContent.includes('origin main'), null, { timeout: 5000 })
  assert.deepEqual(await guard(), { checked: false, disabled: true }, 'a changed summary clears the tick')
  assert.equal((await posts()).length, 2, 'nothing was sent for r4')
  assert.deepEqual(errors, [])
})
