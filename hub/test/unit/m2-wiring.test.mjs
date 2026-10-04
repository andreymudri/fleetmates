import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import { initialState } from '../../web/src/state/deck-store.js'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const src = path.join(hub, 'web/src')

async function load(name) {
  const { module } = await runnerImport(path.join(src, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const fakeApi = () => ({ get: async () => ({}), post: async () => ({}), patch: async () => ({}) })
const loaded = (health = []) => {
  const state = initialState()
  return { ...state, loaded: true, connection: { state: 'live', attempt: 0, nextAt: null }, data: { ...state.data, health } }
}

// Function-component elements in a screen's returned tree, by name, without rendering them (screens hold hooks).
function components(tree, names) {
  const found = []
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && names.includes(node.type.name)) found.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return found
}

const props = state => ({
  route: { name: 'x', params: { sessionId: 's1', repoKey: 'rustot', runId: 'r1', section: 'crew' } },
  state, t: undefined, navigate: () => {}, search: ''
})

test('deckScreens registers new, team and crew and hands the same terminals and dispatch to Home and Focus', async () => {
  const { deckScreens } = await load('screens/failures/Failures.jsx')
  const api = fakeApi()
  const terminals = { attach: () => ({}) }
  const dispatch = () => {}
  const screens = deckScreens({ api, feed: { subscribe: () => () => {} }, terminals, dispatch })
  assert.deepEqual(Object.keys(screens).sort(), ['crew', 'focus', 'home', 'meeting', 'meetingLive', 'meetings', 'new', 'settings', 'team', 'welcome'])
  const live = props(loaded())
  const [home] = components(screens.home(live), ['Home'])
  const [focus] = components(screens.focus(live), ['Focus'])
  assert.equal(home.props.terminals, terminals, 'Home gets the terminal client')
  assert.equal(focus.props.client, terminals, 'Focus gets the same terminal client')
  assert.equal(home.props.dispatch, dispatch, 'Home gets the store dispatch')
  assert.equal(focus.props.dispatch, dispatch, 'Focus gets the same store dispatch')

  const [launch] = components(screens.new(live), ['NewSession'])
  assert.equal(launch.props.api, api)
  assert.equal(launch.props.screens, screens, 'NewSession gets the screens map itself')
  assert.equal(typeof launch.props.screens.home, 'function', 'so it can render Home beneath the dialog')

  const team = components(screens.team(live), ['TeamRun', 'ObserveOverlays'])
  assert.deepEqual(team.map(node => node.type.name), ['TeamRun'], 'TeamRun renders its own observe overlays')
  assert.equal(team[0].props.api, api)
  assert.equal(team[0].props.route, live.route)
  const crew = components(screens.crew(live), ['CrewSheet', 'ObserveOverlays'])
  assert.deepEqual(crew.map(node => node.type.name), ['CrewSheet', 'ObserveOverlays'], 'the crew route renders the observe overlays, as settings does')
  assert.equal(crew[0].props.api, api)
  assert.equal(crew[1].props.state, live.state, 'so Alt K and Alt U on /settings/crew show the palette and the drawer')
})

// The end index of the element whose open tag starts at `start`, counting nested <div> tags (React emits no self-closing divs).
function divEnd(html, start) {
  let depth = 0
  for (const match of html.slice(start).matchAll(/<div[\s>]|<\/div>/g)) {
    depth += match[0] === '</div>' ? -1 : 1
    if (depth === 0) return start + match.index + match[0].length
  }
  return -1
}

test('on /new the palette opened by Alt K renders once, outside the inert background', async () => {
  const { deckScreens } = await load('screens/failures/Failures.jsx')
  const screens = deckScreens({ api: fakeApi(), terminals: null, dispatch: () => {} })
  const base = loaded()
  const state = { ...base, view: { ...base.view, path: '/new', overlay: 'palette' } }
  const html = renderToStaticMarkup(createElement(screens.new, { ...props(state), route: { name: 'new', params: {} } }))
  const start = html.indexOf('<div class="launch-background"')
  assert.ok(start >= 0, 'the screen it was opened from renders beneath the dialog')
  const end = divEnd(html, start)
  assert.ok(end > start)
  const palettes = [...html.matchAll(/role="dialog"[^>]*aria-label="Search, ask or run"/g)]
  assert.equal(palettes.length, 1, 'one palette')
  assert.ok(palettes[0].index > end, 'the palette sits outside the inert, aria-hidden background')
})

test('the M2 screens keep the M1 failure notices where M1 shows them', async () => {
  const { deckScreens } = await load('screens/failures/Failures.jsx')
  const screens = deckScreens({ api: fakeApi(), terminals: null, dispatch: () => {} })
  const down = props(loaded([{ dep: 'deckd', state: 'down', reason: 'socket refused' }]))
  const notices = name => components(screens[name](down), ['FailureNotices'])
  for (const name of ['home', 'focus', 'settings', 'team', 'crew']) assert.equal(notices(name).length, 1, `${name} shows the notices`)
  assert.equal(notices('home')[0].props.history, true, 'Home keeps the completed history')
  for (const name of ['focus', 'settings', 'team', 'crew']) assert.equal(notices(name)[0].props.history, false, `${name} has no history list`)
  assert.equal(notices('welcome').length, 0, 'First run stays full-bleed')
  assert.equal(notices('new').length, 0, 'New session shows deckd down in its own form; the screen beneath it carries the notices')
})

// Class names used by rules that declare something (a minifier drops empty rules). Statement at-rules such as
// terminal.css's `@import '@xterm/xterm/css/xterm.css';` are dropped first so their paths do not read as selectors.
const classesOf = css => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => body.trim()).flatMap(([, selector]) => [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1])))

test('the production build carries the six M2 stylesheets and xterm.css', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'm2-wiring-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const out = path.join(dir, 'web')
  execFileSync('npm', ['run', 'build', '--', '--outDir', out], { cwd: hub, stdio: 'pipe' })
  const assets = await readdir(path.join(out, 'assets'))
  const built = classesOf((await Promise.all(assets.filter(name => name.endsWith('.css')).map(name => readFile(path.join(out, 'assets', name), 'utf8')))).join('\n'))
  const sheets = {}
  for (const name of ['tokens', 'shell', 'components', 'observe', 'setup', 'terminal', 'focus', 'launch', 'compact', 'team', 'crew']) {
    sheets[name] = classesOf(await readFile(path.join(src, 'styles', `${name}.css`), 'utf8'))
  }
  sheets.xterm = classesOf(await readFile(path.join(hub, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8'))
  for (const name of ['terminal', 'focus', 'launch', 'compact', 'team', 'crew', 'xterm']) {
    const own = [...sheets[name]].filter(cls => Object.entries(sheets).every(([other, set]) => other === name || !set.has(cls)))
    assert.ok(own.length > 0, `${name} defines a class no other sheet does`)
    assert.deepEqual(own.filter(cls => !built.has(cls)), [], `the built CSS carries ${name}`)
  }
})
