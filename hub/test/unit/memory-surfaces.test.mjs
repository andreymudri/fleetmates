import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
const hub = fileURLToPath(new URL('../..', import.meta.url))
const load = async file => (await runnerImport(path.join(hub, 'web/src', file), { configFile: false, logLevel: 'silent', root: hub })).module
const render = (component, props) => renderToStaticMarkup(createElement(component, props))
test('palette appends Memory, question mode posts the stripped question, and down state removes Ask', async () => {
  const { paletteModel, runRow } = await load('screens/palette/Palette.jsx')
  const state = { data: { sessions: [], requests: [], repos: [{ id: '/home/you/launch', name: 'launch' }], order: [], health: [] }, view: { path: '/' } }
  const memory = { hits: [{ path: '02-wiki/test/retry.md', title: 'Retry' }] }
  const normal = paletteModel(state, { query: 'launch', memory })
  assert.deepEqual(normal.groups.map(group => group.id), ['actions', 'memory'])
  const model = paletteModel(state, { query: '?how do retries work', memory })
  assert.deepEqual(model.rows.map(row => row.kind), ['askVault', 'memoryNote'])
  const posted = [], navigated = []
  await runRow(model.rows[0], { api: { post: async (...args) => { posted.push(args); return { thread: { id: 'thread' } } } }, leave() {}, navigate: path => navigated.push(path) })
  assert.deepEqual(posted, [['/api/ask', { text: 'how do retries work' }]])
  assert.deepEqual(navigated, ['/memory?thread=thread'])
  const down = paletteModel(state, { query: '?retry', memory: { down: true } })
  assert.deepEqual(down.rows.map(row => row.kind), ['memoryDown'])
  assert.match(down.rows[0].title, /not answering/)
})
test('Focus adds the third tab and retains read notes when the vault is down', async () => {
  const { TABS, FocusMemory } = await load('screens/focus/Focus.jsx')
  assert.deepEqual(TABS, ['changes', 'facts', 'memory'])
  const memory = { related: [{ path: '02-wiki/test/retry.md', line: 13, title: 'Retry' }], read: [{ path: '02-wiki/test/read.md' }], learned: [] }
  assert.match(render(FocusMemory, { memory }), /href="\/memory\/note\/02-wiki\/test\/retry.md#L13"/)
  const down = render(FocusMemory, { memory, down: true })
  assert.match(down, /read.md/)
  assert.match(down, /not answering/)
})
test('Home shows current captures and unresolved misses, hides zero recap counts and renders learned chips', async () => {
  const { HomeMemoryView, chartRecap } = await load('screens/home/Home.jsx')
  assert.equal(chartRecap({ chartsAdded: 0 }), null)
  assert.equal(chartRecap({ chartsAdded: null }), null)
  assert.equal(chartRecap({ chartsAdded: 1 }), '1 chart added')
  const html = render(HomeMemoryView, { captures: [{ path: 'x.md', title: 'Title\u202e' }], misses: [{ id: 'm', question: 'Open question' }, { id: 'resolved', question: 'Resolved sentinel', resolvedBy: 'dismissed' }] })
  assert.match(html, /Charts added to your vault/)
  assert.match(html, /U\+202E/)
  assert.match(html, /Open question/)
  assert.doesNotMatch(html, /Resolved sentinel/)
  const { SessionCard } = await load('components/SessionCard.jsx')
  const props = { session: { id: 's', state: 'running', task: 'Task', learnedToday: 1, stateSince: 1, lastActivityAt: 1 }, repo: { name: 'test' }, requests: [], now: 1000 }
  assert.match(render(SessionCard, props), /learned 1 thing/)
  assert.doesNotMatch(render(SessionCard, { ...props, session: { ...props.session, learnedToday: 0 } }), /learned 0/)
})
test('vaultDownText says the vault is not configured instead of not answering', async () => {
  const { vaultDownText } = await load('components/NoteChip.jsx')
  assert.match(vaultDownText({ state: 'down', reason: 'VAULT_PATH is not set' }), /no vault path is set/)
  assert.doesNotMatch(vaultDownText({ state: 'down', reason: 'VAULT_PATH is not set' }), /not answering/)
  assert.match(vaultDownText({ state: 'down', reason: 'initialize failed: timed out' }), /not answering/)
  assert.match(vaultDownText(undefined), /not answering/)
  const { FocusMemory } = await load('screens/focus/Focus.jsx')
  assert.match(render(FocusMemory, { down: true, vault: { state: 'down', reason: 'VAULT_PATH is not set' } }), /no vault path is set/)
  const { paletteModel } = await load('screens/palette/Palette.jsx')
  const state = { data: { sessions: [], requests: [], repos: [], order: [], health: [] }, view: { path: '/' } }
  assert.match(paletteModel(state, { query: '?x', memory: { down: true, vault: { reason: 'VAULT_PATH is not set' } } }).rows[0].title, /no vault path is set/)
  const { AskPanel } = await load('screens/memory/AskPanel.jsx')
  assert.match(render(AskPanel, { down: true, vault: { state: 'down', reason: 'VAULT_PATH is not set' } }), /no vault path is set/)
})
