// Focus with the live terminal (docs/deck/screens/focus.md, M2 part): the pure FocusView rendered with a
// fake terminal client, and the action, panel and deep-link helpers the Focus route wires around it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build, runnerImport } from 'vite'
import { chromium } from 'playwright-core'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load() {
  const { module } = await runnerImport(path.join(hub, 'web/src/screens/focus/Focus.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const NOW = Date.UTC(2026, 9, 1, 18, 42)
const MIN = 60_000
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))

// Walk a pure tree, expanding function components except the ones with hooks, which are kept as elements.
const KEEP = new Set(['CrewAvatar', 'TerminalView', 'ConfirmDialog'])
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
const find = (tree, test) => {
  const out = []
  walk(tree, node => { if (test(node)) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return KEEP.has(node.type.name) ? '' : textOf(node.type(node.props))
  return textOf(node.props?.children)
}
const button = (tree, label) => find(tree, node => node.type === 'button' && textOf(node).trim() === label)[0]

// A terminal client double: records attaches, never connects.
function fakeClient() {
  const attaches = []
  return { attaches, attach(sessionId, size, handlers) { attaches.push(sessionId)
    return { write: () => true, resize: () => true, detach() {} } } }
}

function state({ sessions, health = [], inputSources = {}, runs = [], requests = [], deckdOutage = false, prefs = {} }) {
  const names = [...new Set(sessions.map(row => row.repoId.split('/').at(-1)))]
  return {
    loaded: true, deckdOutage,
    connection: { state: 'live', attempt: 0, nextAt: null },
    view: { path: '/', overlay: null },
    data: {
      sessions, requests, runs, order: sessions.map(row => row.id), health, prefs, inputSources, tails: {},
      repos: names.map((name, i) => ({ id: `/home/you/dev/${name}`, name, crew: { slot: i, seed: name, hat: 'none' } })),
      counts: null, recap: null, setup: { firstRunCompletedAt: NOW - 1000 }
    }
  }
}

function session(id, name, extra = {}) {
  return {
    id, repoId: `/home/you/dev/${name}`, origin: 'wrapped', ptyId: `pty-${id}`, alive: true, task: 'Port the damage formula', branch: 'combat-tick',
    state: 'running', stateSince: NOW - 10 * MIN, lastActivityAt: NOW - MIN, startedAt: NOW - 60 * MIN, changedFiles: [], cwd: `/home/you/dev/${name}`,
    toolCalls: 4, sessionAliases: [], lastInputFrom: null, lastInputName: null, ...extra
  }
}

const view = (Focus, props) => Focus.FocusView({ now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, ...props })

test('a wrapped alive session renders the live terminal; an observed one has no terminal, Stop or Nudge (AC8)', async () => {
  const Focus = await load()
  const client = fakeClient()
  const live = state({ sessions: [session('s1', 'rustot'), session('s2', 'web', { origin: 'observed', ptyId: null, state: 'stale' })], prefs: { terminalScreenReader: true } })
  const html = render(Focus.FocusView, { state: live, sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client })
  assert.match(html, /<section[^>]*class="terminal-view"[^>]*aria-label="Terminal, rustot · Port the damage formula"/)
  assert.match(html, /<button[^>]*>Stop…<\/button>/)
  const terminal = find(view(Focus, { state: live, sessionId: 's1', client }), node => node.type?.name === 'TerminalView')
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].props.client, client, 'the screen passes its terminal client through')
  assert.equal(terminal[0].props.readOnly, false)
  assert.equal(terminal[0].props.autoFocus, true, 'focus moves into the terminal on open')
  assert.equal(terminal[0].props.screenReaderMode, true, 'from prefs.terminalScreenReader')
  assert.equal(typeof terminal[0].props.confirmLink, 'function', 'links confirm through the deck dialog, not window.confirm')

  const observed = render(Focus.FocusView, { state: live, sessionId: 's2', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client })
  assert.doesNotMatch(observed, /aria-label="Terminal,/, 'no terminal for an observed session')
  assert.doesNotMatch(observed, />(Stop…|Nudge \(send Enter\))</, 'neither Stop nor Nudge')
  assert.match(observed, /Observed session: started as plain claude, read-only here\./)
  assert.doesNotMatch(observed, /Last typed from|Typing in/, 'no input indicator for observed sessions')
  assert.doesNotMatch(observed, />Hide panel</, 'the M1 header of an observed session gains no button')
  assert.match(observed, /Adrift since/, 'the stale line stays')
})

test('the input indicator reads each copy variant from inputSources, then falls back to the session row', async () => {
  const Focus = await load()
  const base = session('s1', 'rustot', { lastInputFrom: 'terminal', lastInputName: 'foot' })
  const indicator = sources => {
    const html = render(Focus.FocusView, { state: state({ sessions: [base], inputSources: sources }), sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client: fakeClient() })
    return /<span class="focus-input"[^>]*>([\s\S]*?)<\/span><\/span>/.exec(html)?.[1].replace(/<[^>]+>/g, '') ?? ''
  }
  const src = (extra) => ({ s1: { sessionId: 's1', state: 'quiet', from: null, name: null, detached: false, ...extra } })
  assert.equal(indicator({}), 'Last typed from: terminal (foot)', 'the session row when no input.source arrived')
  assert.equal(indicator(src({ from: 'terminal', name: 'kitty' })), 'Last typed from: terminal (kitty)')
  assert.equal(indicator(src({ from: 'browser' })), 'Last typed from: browser')
  assert.equal(indicator(src({ state: 'terminal_active', from: 'terminal', name: 'kitty' })), 'Typing in terminal (kitty)')
  assert.equal(indicator(src({ state: 'browser_active', from: 'browser' })), 'Typing in browser')
  assert.equal(indicator(src({ from: 'browser', detached: true })), 'Last typed from: browser · terminal detached')
  const html = render(Focus.FocusView, { state: state({ sessions: [base] }), sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client: fakeClient() })
  assert.match(html, /class="focus-input"[^>]*title="Both the terminal and the browser can type; last keystroke wins"/)
})

test('a collision shows the amber chip and announces it once politely', async () => {
  const Focus = await load()
  const sources = { s1: { sessionId: 's1', state: 'collision', from: 'browser', name: null, detached: false } }
  const html = render(Focus.FocusView, { state: state({ sessions: [session('s1', 'rustot')], inputSources: sources }), sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client: fakeClient(), collision: true })
  assert.match(html, /class="focus-collision"[^>]*>Both typing: last keystroke wins</)
  assert.match(html, /role="status"[^>]*>Both typing: last keystroke wins</)
  const quiet = render(Focus.FocusView, { state: state({ sessions: [session('s1', 'rustot')], inputSources: sources }), sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client: fakeClient(), collision: false })
  assert.doesNotMatch(quiet, /focus-collision/, 'the chip goes after its 3 s')
})

test('Stop opens the dialog with Cancel first, and only confirming posts the stop (AC10)', async () => {
  const Focus = await load()
  const posts = []
  const api = { post: async to => { posts.push(to)
    return {} } }
  const patches = []
  const actions = Focus.focusActions({ api, id: 's/1', set: patch => patches.push(patch), toast: () => {}, repo: 'rustot' })
  actions.openStop()
  assert.deepEqual(patches, [{ confirming: true }])
  assert.deepEqual(posts, [], 'opening the dialog posts nothing')
  actions.cancelStop()
  assert.deepEqual(posts, [])
  await actions.confirmStop()
  assert.deepEqual(posts, ['/api/sessions/s%2F1/stop'])

  const opened = []
  const live = state({ sessions: [session('s1', 'rustot')] })
  const tree = view(Focus, { state: live, sessionId: 's1', client: fakeClient(), onStop: () => opened.push('stop') })
  button(tree, 'Stop…').props.onClick()
  assert.deepEqual(opened, ['stop'])
  const html = render(Focus.FocusView, { state: live, sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'changes', onTab: () => {}, client: fakeClient(), confirming: true })
  assert.match(html, /role="dialog"/)
  assert.match(html, />Stop rustot · Port the damage formula\?</)
  assert.match(html, /SIGTERM, then SIGKILL after 5 s/)
  assert.ok(html.indexOf('>Cancel<') > 0 && html.indexOf('>Cancel<') < html.indexOf('>Stop session<'), 'Cancel comes first')
  assert.match(html, /<button[^>]*data-initial-focus="true"[^>]*>Cancel</)
})

test('a failed stop toasts "Could not stop {repo}: {message}"', async () => {
  const Focus = await load()
  const toasts = []
  const api = { post: async () => { throw Object.assign(new Error('deckd is not connected'), { code: 'deckd_unavailable' }) } }
  const actions = Focus.focusActions({ api, id: 's1', set: () => {}, toast: toast => toasts.push(toast), repo: 'rustot' })
  await actions.confirmStop()
  assert.deepEqual(toasts, [{ tone: 'error', title: 'Could not stop rustot: deckd is not connected' }])
})

test('Nudge, Relaunch and Dismiss call their endpoints', async () => {
  const Focus = await load()
  const posts = []
  const actions = Focus.focusActions({ api: { post: async to => { posts.push(to)
    return {} } }, id: 's1', set: () => {}, toast: () => {}, repo: 'rustot' })
  await actions.nudge()
  await actions.relaunch()
  await actions.dismiss()
  assert.deepEqual(posts, ['/api/sessions/s1/nudge', '/api/sessions/s1/relaunch', '/api/sessions/s1/dismiss'])
  const stale = view(Focus, { state: state({ sessions: [session('s1', 'rustot', { state: 'stale' })] }), sessionId: 's1', client: fakeClient(), onNudge: () => posts.push('nudge') })
  button(stale, 'Nudge (send Enter)').props.onClick()
  assert.equal(posts.at(-1), 'nudge')
  const crashed = renderToStaticMarkup(view(Focus, { state: state({ sessions: [session('s1', 'rustot', { state: 'crashed', alive: false, exitCode: 3 })] }), sessionId: 's1', client: fakeClient() }))
  assert.match(crashed, /<button[^>]*>Relaunch<\/button>/)
  assert.match(crashed, /<button[^>]*>Dismiss<\/button>/)
  assert.doesNotMatch(crashed, />Stop…</, 'no Stop for a crashed session')
})

test('deckd down keeps the terminal, disables its input and disables Stop with the reason text', async () => {
  const Focus = await load()
  const down = state({ sessions: [session('s1', 'rustot')], health: [{ dep: 'deckd', state: 'down', attempt: 2 }], deckdOutage: true })
  const tree = view(Focus, { state: down, sessionId: 's1', client: fakeClient() })
  const stop = button(tree, 'Stop…')
  assert.equal(stop.props.disabled, true)
  const html = renderToStaticMarkup(tree)
  assert.match(html, /deckd is reconnecting/)
  const reason = /id="([^"]+)"[^>]*>deckd is reconnecting</.exec(html)?.[1]
  assert.ok(reason && stop.props['aria-describedby'] === reason, 'Stop names its visible reason')
  const terminal = find(tree, node => node.type?.name === 'TerminalView')[0]
  assert.ok(terminal, 'the terminal stays with its last output')
  assert.equal(terminal.props.readOnly, true, 'input is disabled')
  assert.equal(terminal.props.deckdUp, false)
  const up = view(Focus, { state: state({ sessions: [session('s1', 'rustot')], health: [{ dep: 'deckd', state: 'up' }] }), sessionId: 's1', client: fakeClient() })
  assert.notEqual(button(up, 'Stop…').props.disabled, true)
  assert.equal(find(up, node => node.type?.name === 'TerminalView')[0].props.deckdUp, true)
})

test('an ended PTY session renders a read-only terminal filled from its scrollback', async () => {
  const Focus = await load()
  const ended = state({ sessions: [session('s1', 'rustot', { state: 'ended', alive: false })] })
  const terminal = find(view(Focus, { state: ended, sessionId: 's1', client: fakeClient(), scrollback: 'the last lines' }), node => node.type?.name === 'TerminalView')[0]
  assert.equal(terminal.props.readOnly, true)
  assert.equal(terminal.props.client, null, 'no live attach')
  assert.equal(terminal.props.initialText, 'the last lines')
  const gets = []
  await Focus.loadScrollback({ get: async to => { gets.push(to)
    return { text: 'x', source: 'stored', truncated: false } } }, 's1')
  assert.deepEqual(gets, ['/api/sessions/s1/scrollback?lines=1000'])
})

test('a starting session older than 30 s shows the hooks hint', async () => {
  const Focus = await load()
  const at = age => renderToStaticMarkup(view(Focus, { state: state({ sessions: [session('s1', 'rustot', { state: 'starting', stateSince: NOW - age })] }), sessionId: 's1', client: fakeClient() }))
  assert.doesNotMatch(at(29_000), /No signal from hooks yet/)
  assert.match(at(31_000), /No signal from hooks yet\. Is fleetmates deck init done\?/)
})

test('Down in the file listbox moves aria-selected; the caption replaces the diff (AC12)', async () => {
  const Focus = await load()
  const files = [{ path: 'src/a.rs', adds: 3, dels: 1 }, { path: 'src/b.rs', adds: 1, dels: 0 }]
  const live = state({ sessions: [session('s1', 'rustot', { changedFiles: files })] })
  const picked = []
  const tree = view(Focus, { state: live, sessionId: 's1', client: fakeClient(), selectedFile: 'src/a.rs', onSelectFile: file => picked.push(file) })
  const listbox = find(tree, node => node.props?.role === 'listbox')[0]
  assert.ok(listbox, 'the changes are a listbox')
  assert.equal(listbox.props['aria-label'], 'Changed files')
  const options = find(tree, node => node.props?.role === 'option')
  assert.deepEqual(options.map(node => node.props['aria-selected']), ['true', 'false'])
  let prevented = false
  listbox.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => { prevented = true } })
  assert.deepEqual(picked, ['src/b.rs'])
  assert.equal(prevented, true)
  listbox.props.onKeyDown({ key: 'ArrowUp', preventDefault() {} })
  assert.deepEqual(picked, ['src/b.rs', 'src/a.rs'])
  const next = view(Focus, { state: live, sessionId: 's1', client: fakeClient(), selectedFile: 'src/b.rs', onSelectFile: () => {} })
  assert.deepEqual(find(next, node => node.props?.role === 'option').map(node => node.props['aria-selected']), ['false', 'true'])
  assert.match(renderToStaticMarkup(tree), /Diffs arrive with approvals\./)
})

test('Facts lists every FOC-O3 row, including the review baseline and the earlier conversations count', async () => {
  const Focus = await load()
  const row = session('s1', 'rustot', {
    origin: 'launched', claudeSessionId: 'c-3', sessionAliases: ['c-1', 'c-2'], subagentsActive: 2, transcriptPath: '/home/you/.claude/t.jsonl',
    lastInputFrom: 'terminal', lastInputName: 'kitty', reviewBaseline: '0123456789abcdef0123456789abcdef01234567'
  })
  const html = render(Focus.FocusView, { state: state({ sessions: [row] }), sessionId: 's1', now: NOW, navigate: () => {}, steps: [], tab: 'facts', onTab: () => {}, client: fakeClient() })
  const facts = Object.fromEntries([...html.matchAll(/<dt>([^<]*)<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/g)].map(match => [match[1], match[2].replace(/<[^>]+>/g, '')]))
  assert.deepEqual(Object.keys(facts), ['Started from', 'Started', 'Running for', 'Claude session', 'Branch', 'Working directory', 'Tool calls', 'Subagents working', 'Last input from', 'Transcript', 'Changes measured since'])
  assert.equal(facts['Started from'], 'the deck')
  assert.equal(facts['Claude session'], 'c-3 · 2 earlier conversations')
  assert.equal(facts['Last input from'], 'terminal (kitty)')
  assert.equal(facts['Changes measured since'], '0123456789ab')
  assert.match(html, /title="0123456789abcdef0123456789abcdef01234567"/, 'the full sha on hover')
})

test('a ?needs=task or ?needs=run route opens the Needs-you drawer with that filter once on mount (D-69)', async () => {
  const Focus = await load()
  const calls = []
  const open = (overlay, detail) => calls.push([overlay, detail])
  Focus.openNeedsFilter('?needs=task:r1:T4', open)
  assert.deepEqual(calls, [['drawer', { filter: { kind: 'task', runId: 'r1', taskId: 'T4' } }]])
  Focus.openNeedsFilter('?needs=run:r1', open)
  assert.deepEqual(calls[1], ['drawer', { filter: { kind: 'run', runId: 'r1' } }])
  Focus.openNeedsFilter('?tab=facts', open)
  Focus.openNeedsFilter('?needs=request:q1', open)
  assert.equal(calls.length, 2, 'only task and run filters open the drawer')
})

test('the session list reads team rows from the run and ends with Launch a ship', async () => {
  const Focus = await load()
  const lead = session('lead', 'fleet', { role: 'lead', runRef: { repoId: '/home/you/dev/fleet', runId: 'r1', taskId: null } })
  const mate = session('mate', 'fleet', { role: 'teammate', state: 'needs_approval', runRef: { repoId: '/home/you/dev/fleet', runId: 'r1', taskId: 'T2' } })
  const runs = [{ repoId: '/home/you/dev/fleet', runId: 'r1', leadSessionId: 'lead', tasks: [{ id: 'T2', state: 'running' }, { id: 'T3', state: 'running' }], teammates: [{ taskId: 'T2', state: 'running' }, { taskId: 'T3', state: 'running' }], gates: {} }]
  const routes = []
  const tree = view(Focus, { state: state({ sessions: [lead, mate, session('s1', 'rustot')], runs }), sessionId: 's1', client: fakeClient(), navigate: to => routes.push(to) })
  const html = renderToStaticMarkup(tree)
  const leadRow = /<a class="focus-list-row"[^>]*href="\/s\/lead"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? ''
  assert.match(leadRow, /1 of 3 need you/)
  const launch = find(tree, node => node.type === 'a' && node.props.href === '/new')[0]
  assert.ok(launch, 'a Launch a ship link')
  assert.match(textOf(launch), /Launch a ship/)
  assert.match(textOf(launch), /Alt N/)
  launch.props.onClick({ button: 0, preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(routes, ['/new'])
  assert.match(html, /<a class="focus-list-row"[^>]*aria-label="rustot, Running"/, 'names stay in aria-label when the list collapses')
})

test('Hide panel toggles with aria-pressed, Alt I is the panel key, and the choice persists in deck.focus.panel', async () => {
  const Focus = await load()
  const toggles = []
  const live = state({ sessions: [session('s1', 'rustot')] })
  const open = view(Focus, { state: live, sessionId: 's1', client: fakeClient(), panelOpen: true, onTogglePanel: () => toggles.push('toggle') })
  const hide = button(open, 'Hide panelAlt I')
  assert.ok(hide, 'Hide panel with its Alt I hint')
  assert.equal(hide.props['aria-pressed'], 'false')
  hide.props.onClick()
  assert.deepEqual(toggles, ['toggle'])
  const closed = view(Focus, { state: live, sessionId: 's1', client: fakeClient(), panelOpen: false })
  assert.equal(button(closed, 'Show panelAlt I').props['aria-pressed'], 'true')
  assert.match(renderToStaticMarkup(closed), /class="focus-screen focus--panel-hidden/)

  assert.equal(Focus.isPanelKey({ code: 'KeyI', altKey: true, shiftKey: false, ctrlKey: false, metaKey: false }), true)
  assert.equal(Focus.isPanelKey({ code: 'KeyI', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false }), false)
  assert.equal(Focus.isPanelKey({ code: 'KeyB', altKey: true, shiftKey: false, ctrlKey: false, metaKey: false }), false)
  const saved = new Map()
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }
  assert.equal(Focus.readPanel(storage), true, 'open by default')
  Focus.writePanel(storage, false)
  assert.equal(saved.get('deck.focus.panel'), 'hidden')
  assert.equal(Focus.readPanel(storage), false)
  assert.equal(Focus.readPanel({ getItem() { throw Error('private mode') } }), true)
})

test('the leave hint shows only while the terminal has focus', async () => {
  const Focus = await load()
  const live = state({ sessions: [session('s1', 'rustot')] })
  const at = terminalFocused => renderToStaticMarkup(view(Focus, { state: live, sessionId: 's1', client: fakeClient(), terminalFocused }))
  assert.match(at(true), /Alt Esc to leave the terminal/)
  assert.doesNotMatch(at(false), /Alt Esc to leave the terminal/)
})

test('focus.css styles the M2 Focus with tokens only and collapses at 1280 px', async () => {
  const css = (await readFile(path.join(hub, 'web/src/styles/focus.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no raw colors outside tokens')
  assert.doesNotMatch(css, /outline\s*:\s*(none|0)/)
  assert.match(css, /@media \(max-width: 1280px\)/)
  assert.match(css, /var\(--layout-rail-collapsed-list\)/)
  assert.match(css, /\.focus-collision/)
  const source = (await readFile(path.join(hub, 'web/src/screens/focus/Focus.jsx'), 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML/)
  assert.doesNotMatch(source, /import\s+['"][^'"]+\.css['"]/)
})

async function findChromium() {
  for (const candidate of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (!candidate) continue
    try { await access(candidate)
      return candidate } catch {}
  }
  return null
}

// A page that mounts the real Focus route with a stub terminal client. `window.h.source(state)` sets s1's
// input-machine state and `window.h.show(id)` switches the route without remounting Focus.
const COLLISION_HARNESS = `import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Focus } from '@hub/web/src/screens/focus/Focus.jsx'

const h = window.h = {}
const client = { attach: () => ({ write: () => true, resize: () => true, detach() {} }) }
const api = { get: async () => ({}), post: async () => ({}) }
const row = id => ({ id, repoId: '/home/you/dev/rustot', origin: 'wrapped', ptyId: 'pty-' + id, alive: true, task: 'Port', branch: 'b',
  state: 'running', stateSince: Date.now(), lastActivityAt: Date.now(), startedAt: Date.now(), changedFiles: [], cwd: '/home/you/dev/rustot',
  toolCalls: 0, sessionAliases: [], lastInputFrom: null, lastInputName: null })
function App() {
  const [id, setId] = useState('s1')
  const [source, setSource] = useState('quiet')
  const [from, setFrom] = useState('browser')
  h.show = setId
  h.source = setSource
  h.from = setFrom
  const state = {
    loaded: true, deckdOutage: false, connection: { state: 'live', attempt: 0, nextAt: null }, view: { path: '/', overlay: null },
    data: { sessions: [row('s1'), row('s2')], requests: [], runs: [], order: ['s1', 's2'], health: [], prefs: {}, tails: {},
      inputSources: { s1: { sessionId: 's1', state: source, from, name: null, detached: false } },
      repos: [{ id: '/home/you/dev/rustot', name: 'rustot', crew: { slot: 0, seed: 'rustot', hat: 'none' } }], counts: null, recap: null,
      setup: { firstRunCompletedAt: 1 } }
  }
  return <><span id="mark">{id + ':' + source + ':' + from}</span><Focus route={{ params: { sessionId: id } }} state={state} navigate={() => {}} api={api}
    search="" client={client} dispatch={() => {}} onOverlay={() => {}} /></>
}
createRoot(document.getElementById('root')).render(<App />)
`

test('the collision chip shows for 3 s from the collision even when the machine settles first, and a session switch clears it', async t => {
  const executablePath = await findChromium()
  assert.ok(executablePath, 'Chromium or Chrome is required for the Focus browser test')
  const dir = await mkdtemp(path.join(tmpdir(), 'focus-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div id="root" style="width:1600px;height:900px"></div><script type="module" src="./entry.jsx"></script></body></html>')
  await writeFile(path.join(dir, 'entry.jsx'), COLLISION_HARNESS)
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
  // A fake clock: timers fire only when the test advances it, so each 3 s boundary below is exact.
  await page.clock.install({ time: NOW })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => document.getElementById('mark')?.textContent === 's1:quiet:browser', null, { timeout: 10_000 })
  // Set the route and the source state, then wait until React committed both.
  const set = async (id, source, from = 'browser') => {
    await page.evaluate(([i, s, f]) => { window.h.show(i)
      window.h.source(s)
      window.h.from(f) }, [id, source, from])
    await page.waitForFunction(want => document.getElementById('mark')?.textContent === want, `${id}:${source}:${from}`, { timeout: 5000 })
  }
  // React commits a timer's state update in a later MessageChannel task (the fake clock does not own those).
  const advance = async ms => {
    await page.clock.runFor(ms)
    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => { const channel = new MessageChannel()
          channel.port1.onmessage = resolve
          channel.port2.postMessage(0) })
      }
    })
  }
  const chip = () => page.evaluate(() => ({
    chip: document.querySelectorAll('.focus-collision').length,
    status: [...document.querySelectorAll('[role="status"][aria-live="polite"]')].map(node => node.textContent).filter(Boolean)
  }))
  const CHIP = 'Both typing: last keystroke wins'

  assert.deepEqual(await chip(), { chip: 0, status: [] })
  await set('s1', 'collision')
  assert.deepEqual(await chip(), { chip: 1, status: [CHIP] }, 'the collision shows the chip and announces it once')
  await advance(300)
  await set('s1', 'browser_active')
  assert.deepEqual(await chip(), { chip: 1, status: [CHIP] }, 'the chip outlives the settle until its 3 s are up')
  await advance(2700)
  assert.deepEqual(await chip(), { chip: 0, status: [] }, 'the chip is gone 3 s after the collision began')
  await advance(5000)
  assert.deepEqual(await chip(), { chip: 0, status: [] })

  await set('s1', 'collision')
  assert.equal((await chip()).chip, 1)
  await advance(500)
  await set('s2', 'collision')
  assert.deepEqual(await chip(), { chip: 0, status: [] }, 'switching to another session mid-collision clears the chip')
  await advance(5000)
  await set('s1', 'quiet')
  assert.deepEqual(await chip(), { chip: 0, status: [] })

  // A second collision restarts the timer: the first one's timeout is cleared, so it cannot hide the chip early.
  await set('s1', 'collision')
  await advance(1000)
  await set('s1', 'browser_active')
  await advance(1000)
  await set('s1', 'collision')
  await advance(1500)
  assert.equal((await chip()).chip, 1, 'the chip is still shown 1.5 s after the second collision')
  await advance(1500)
  assert.equal((await chip()).chip, 0, 'and goes 3 s after it')
  await set('s1', 'quiet')
  await advance(5000)

  // A sustained collision: the input machine re-emits 'collision' with a flipped `from` on every crossing,
  // and each crossing re-arms the 3 s chip.
  await set('s1', 'collision', 'browser')
  await advance(1000)
  await set('s1', 'collision', 'terminal')
  await advance(1000)
  await set('s1', 'collision', 'browser')
  await advance(1000)
  assert.equal((await chip()).chip, 1, 'the chip is still shown 3 s into a sustained collision')
  await set('s1', 'collision', 'terminal')
  await advance(1000)
  assert.equal((await chip()).chip, 1, 'the chip is still shown 4 s into a sustained collision')
  assert.deepEqual(errors, [])
})
