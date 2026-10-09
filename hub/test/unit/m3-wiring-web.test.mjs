// M3 Task 16 step (e): the palette's "Allowed ..." toast reaches the deck store from every screen that renders
// the observe overlays, not only Home, and Settings gets the store's dispatch for its revoke toast. The routes of
// the shell's `screens` map (Failures.jsx `deckScreens`) are mounted in headless Chromium with the palette open
// over a Safe request, the request is allowed from the palette and then closed, and the store must hold the toast.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { findChromium } from '../helpers/chromium.mjs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, runnerImport } from 'vite'
import { chromium } from 'playwright-core'

const hub = fileURLToPath(new URL('../..', import.meta.url))

/** Every element of a React element tree, depth first. */
function elements(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) elements(child, out)
    return out }
  if (!node || typeof node !== 'object' || !node.props) return out
  out.push(node)
  elements(node.props.children, out)
  return out
}

test('the Settings route gets the store dispatch, so the revoke toast reaches the shell', async () => {
  const { module: failures } = await runnerImport(path.join(hub, 'web/src/screens/failures/Failures.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  const { module: settings } = await runnerImport(path.join(hub, 'web/src/screens/settings/Settings.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  const dispatch = () => {}
  const screens = failures.deckScreens({ api: { get: async () => ({}), post: async () => ({}) }, dispatch })
  const state = { loaded: true, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/settings/rules' }, data: { sessions: [], requests: [], repos: [], runs: [], health: [], prefs: {} } }
  const tree = elements(screens.settings({ route: { name: 'settings', params: { section: 'rules' } }, state, navigate: () => {} }))
  const found = tree.find(node => node.type === settings.Settings || node.type?.name === 'Settings')
  assert.ok(found, 'the Settings route renders Settings')
  assert.equal(found.props.dispatch, dispatch)
})

const HARNESS = `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { deckScreens } from '@hub/web/src/screens/failures/Failures.jsx'
import { createDeckStore } from '@hub/web/src/state/deck-store.js'

const store = createDeckStore()
const h = window.h = { posts: [], toasts: () => store.getState().toasts.map(toast => toast.title) }
const now = Date.now()
const repo = { id: '/home/you/dev/rustot', name: 'rustot', crew: { slot: 0, seed: 'rustot', hat: 'none' } }
const session = { id: 's1', repoId: repo.id, origin: 'launched', ptyId: 'pty-1', alive: true, task: 'task s1', branch: 'b', state: 'needs_approval',
  stateSince: now, lastActivityAt: now, startedAt: now, changedFiles: [], cwd: repo.id, toolCalls: 0, sessionAliases: [], archivedAt: null, archivedBy: null,
  role: 'solo', runRef: null }
const request = { id: 'r1', sessionId: 's1', kind: 'permission', tier: 'safe', toolName: 'Bash', summary: 'npm run test', state: 'open', createdAt: now - 60000,
  delivery: 'idle', screenMatch: 'on_screen', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], reasons: [], detail: { command: 'npm run test' } }
const api = {
  async get(to) { return {} },
  async post(to, body) { h.posts.push(to)
    return { request: { ...request, delivery: 'verifying' } } },
  async patch() { return {} },
  async del() { return {} }
}
const screens = deckScreens({ api, dispatch: store.dispatch })
const routes = {
  focus: { name: 'focus', params: { sessionId: 's1' } },
  team: { name: 'team', params: { repoKey: 'rustot', runId: 'run-1' } },
  settings: { name: 'settings', params: { section: 'rules' } },
  new: { name: 'new', params: {} },
  crew: { name: 'crew', params: {} },
  home: { name: 'home', params: {} }
}
const name = new URLSearchParams(location.search).get('screen')
function App() {
  const [requests, setRequests] = useState([request])
  h.close = () => setRequests(list => list.map(row => ({ ...row, state: 'answered', answer: { via: 'browser', choice: 'allow' } })))
  const state = {
    loaded: true, deckdOutage: false, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/', overlay: 'palette' }, toasts: [],
    data: { sessions: [session], requests, runs: [], order: ['s1'], health: [], prefs: {}, tails: {}, inputSources: {}, repos: [repo], ruleOffers: [],
      counts: { needYouSessions: 1, running: 0, toReview: 0, openRequests: 1, requestSessions: 1, oldestRequestAt: now - 60000, perRun: [], archived: 0 },
      recap: null, setup: { firstRunCompletedAt: 1 } }
  }
  return screens[name]({ route: routes[name], state, navigate: () => {}, search: '' })
}
createRoot(document.getElementById('root')).render(<App />)
`

test('the palette Allow toast reaches the store from Home, Focus, Team run, Settings, New session and the Crew sheet', async t => {
  const executablePath = findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the wiring browser test')
  const dir = await mkdtemp(path.join(tmpdir(), 'm3wire-'))
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
  for (const screen of ['home', 'focus', 'team', 'settings', 'new', 'crew']) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/?screen=${screen}`)
    const row = page.getByRole('option', { name: /rustot · Allow npm run test/ })
    await row.waitFor({ timeout: 10_000 })
    await row.click()
    await page.waitForFunction(() => window.h.posts.length === 1, null, { timeout: 5000 })
    assert.deepEqual(await page.evaluate(() => window.h.posts), ['/api/requests/r1/answer'], `${screen}: the palette posts the answer`)
    await page.evaluate(() => window.h.close())
    await page.waitForFunction(() => window.h.toasts().length > 0, null, { timeout: 5000 }).catch(() => {})
    assert.deepEqual(await page.evaluate(() => window.h.toasts()), ['Allowed npm run test in rustot'], `${screen}: the toast reached the store`)
    assert.deepEqual(errors, [], `${screen}: no page error`)
    await page.close()
  }
})
