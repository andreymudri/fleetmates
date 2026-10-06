// Task 13: the Crew sheet (docs/deck/screens/crew-sheet.md) and Settings, Appearance (settings.md 4.3),
// plus the outdated deckd line in Connections (05-api.md 5.5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const src = path.join(hub, 'web/src')

async function load(name) {
  const { module } = await runnerImport(path.join(src, name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const render = (Component, props) => renderToStaticMarkup(createElement(Component, props))

// Walk a tree of pure components, expanding function components; CrewAvatar (a memo object) is left as is.
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}
const find = (tree, predicate) => {
  const out = []
  walk(tree, node => { if (predicate(node)) out.push(node) })
  return out
}
const textOf = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  if (typeof node.type === 'object') return ''
  return textOf(node.props?.children)
}
const button = (tree, text) => find(tree, node => node.type === 'button' && textOf(node) === text)[0]
const radios = (tree, label) => {
  const group = find(tree, node => node.props?.role === 'radiogroup' && node.props['aria-label'] === label)[0]
  assert.ok(group, `radiogroup ${label}`)
  return find(group.props.children, node => node.props?.role === 'radio')
}

function fakeApi(responses = {}) {
  const calls = []
  const handle = (method, url, body) => {
    calls.push(body === undefined ? { method, url } : { method, url, body })
    const answer = responses[`${method} ${url}`]
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(typeof answer === 'function' ? answer(body) : answer)
  }
  return { calls, get: url => handle('GET', url), post: (url, body) => handle('POST', url, body), patch: (url, body) => handle('PATCH', url, body) }
}

function repo(name, slot, crew = {}) {
  const id = `/home/you/dev/${name}`
  return { id, repoId: id, repoKey: name, name, crew: { slot, slotShared: false, seed: name, hat: 'none', ...crew }, archivedAt: null }
}

const crewSheet = await load('screens/crew/CrewSheet.jsx')
const settings = await load('screens/settings/Settings.jsx')

const POSES = ['running', 'needs you', 'idle', 'done', 'crashed']
const REPOS = [repo('fleetmates', 0), repo('rustot', 1), repo('vault-mcp', 2)]

test('the crew grid is a table with one row per repo, each with 5 named images, one per pose (crew AC1)', () => {
  const { CrewSheetView } = crewSheet
  const html = render(CrewSheetView, { repos: REPOS, selected: 'rustot', onSelect() {}, onChange() {} })
  const table = html.match(/<table[^>]*>[\s\S]*?<\/table>/)?.[0]
  assert.ok(table, 'the pose grid is a table')
  for (const pose of POSES) assert.match(table, new RegExp(`<th scope="col"[^>]*>${pose}</th>`))
  const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g).slice(1)
  assert.equal(rows.length, REPOS.length)
  REPOS.forEach((item, index) => {
    assert.match(rows[index], new RegExp(`<th scope="row"[^>]*>(<[^>]+>)*${item.name}`))
    const images = [...rows[index].matchAll(/<svg[^>]*role="img" aria-label="([^"]+)"/g)].map(match => match[1])
    assert.deepEqual(images, POSES.map(pose => `${item.name} crew member, ${pose}`))
  })
  assert.match(html, /One crew member per repo/)
  assert.match(html, /A fleetmates team shares a hat/)
  assert.match(html, /Customize rustot&#x27;s crew member/)
  assert.doesNotMatch(html, /share colors/)
  const archived = render(CrewSheetView, { repos: [...REPOS, { ...repo('old', 3), archivedAt: 1 }], selected: 'rustot', onSelect() {}, onChange() {} })
  assert.doesNotMatch(archived, /old crew member/)
  const empty = render(CrewSheetView, { repos: [], onSelect() {}, onChange() {} })
  assert.match(empty, /No repos yet\. Crew members appear the first time the deck sees a repo\./)
  assert.doesNotMatch(empty, /Customize/)
})

test('the team section uses the first repo with seeds <repo>#T1..T3 and a team cap, and nothing animates', () => {
  const { CrewSheetView } = crewSheet
  const tree = CrewSheetView({ repos: REPOS, selected: 'rustot', onSelect() {}, onChange() {} })
  const team = find(tree, node => node.props?.className === 'crew-team')[0]
  assert.ok(team)
  const avatars = find(team.props.children, node => typeof node.type === 'object' && node.props?.seed)
  assert.deepEqual(avatars.map(node => [node.props.seed, node.props.team]), [['fleetmates', true], ['fleetmates#T1', true], ['fleetmates#T2', true], ['fleetmates#T3', true]])
  const html = render(CrewSheetView, { repos: REPOS, selected: 'rustot', onSelect() {}, onChange() {} })
  assert.doesNotMatch(html, /motion-|<animate/)
})

test('Reroll on rustot asks for seed rustot#2, then rustot#3, and the original shape button resets it (crew AC3)', () => {
  const { CrewSheetView, nextSeed } = crewSheet
  const changes = []
  const tree = CrewSheetView({ repos: REPOS, selected: 'rustot', onSelect() {}, onChange: patch => changes.push(patch) })
  button(tree, 'Reroll').props.onClick()
  assert.deepEqual(changes, [{ seed: 'rustot#2' }])
  assert.equal(button(tree, 'Use the original shape'), undefined)
  assert.equal(nextSeed(repo('rustot', 1, { seed: 'rustot#2' })), 'rustot#3')
  assert.equal(nextSeed(repo('rustot', 1, { seed: null })), 'rustot#2')
  const rerolled = CrewSheetView({ repos: [repo('fleetmates', 0), repo('rustot', 1, { seed: 'rustot#2' })], selected: 'rustot', onSelect() {}, onChange: patch => changes.push(patch) })
  button(rerolled, 'Reroll').props.onClick()
  button(rerolled, 'Use the original shape').props.onClick()
  assert.deepEqual(changes.slice(1), [{ seed: 'rustot#3' }, { seed: 'rustot' }])
  const preview = find(rerolled, node => node.props?.className === 'crew-preview')[0]
  const avatar = find(preview.props.children, node => typeof node.type === 'object')[0]
  assert.equal(avatar.props.seed, 'rustot#2')
  assert.equal(avatar.props.label, 'rustot crew member, done')
})

test('with 8 slots taken the Color group offers the current color and slot 8 only (crew AC4)', () => {
  const { CrewSheetView, colorChoices } = crewSheet
  const eight = Array.from({ length: 8 }, (_, slot) => repo(`r${slot}`, slot))
  assert.deepEqual(colorChoices(eight, eight[3]), [{ slot: 3, current: true }, { slot: 8, current: false }])
  const changes = []
  const tree = CrewSheetView({ repos: eight, selected: 'r3', onSelect() {}, onChange: patch => changes.push(patch) })
  const swatches = radios(tree, 'Color')
  assert.deepEqual(swatches.map(node => [node.props['aria-label'], node.props['aria-checked']]), [['Current color', 'true'], ['Free color slot 8', 'false']])
  swatches[1].props.onClick()
  assert.deepEqual(changes, [{ slot: 8 }])
  // Arrow keys move within the group and select (crew-sheet.md section 6).
  swatches[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  assert.deepEqual(changes, [{ slot: 8 }, { slot: 8 }])
  assert.doesNotMatch(render(CrewSheetView, { repos: eight, selected: 'r3', onSelect() {}, onChange() {} }), /All 9 colors are taken/)
  const nine = [...eight, repo('r8', 8)]
  assert.deepEqual(colorChoices(nine, nine[0]), [{ slot: 0, current: true }])
  assert.match(render(CrewSheetView, { repos: nine, selected: 'r0', onSelect() {}, onChange() {} }), /All 9 colors are taken\. Archive a repo to free one\./)
  // A shared slot does not take a slot away from the free list, and an archived repo frees its own.
  const shared = [...eight.slice(0, 7), { ...repo('r7', 7), crew: { ...repo('r7', 7).crew, slotShared: true } }]
  assert.deepEqual(colorChoices(shared, shared[0]).map(choice => choice.slot), [0, 7, 8])
  const archived = [...eight.slice(0, 7), { ...repo('r7', 7), archivedAt: 1 }]
  assert.deepEqual(colorChoices(archived, archived[0]).map(choice => choice.slot), [0, 7, 8])
})

test('the Hat group offers no hat, cap and bandana, and the repo select switches the target', () => {
  const { CrewSheetView } = crewSheet
  const changes = []
  const selects = []
  const tree = CrewSheetView({ repos: REPOS, selected: 'rustot', onSelect: key => selects.push(key), onChange: patch => changes.push(patch) })
  const hats = radios(tree, 'Hat')
  assert.deepEqual(hats.map(node => [textOf(node), node.props['aria-checked']]), [['No hat', 'true'], ['Cap', 'false'], ['Bandana', 'false']])
  hats[2].props.onClick()
  assert.deepEqual(changes, [{ hat: 'bandana' }])
  const select = find(tree, node => node.type === 'select')[0]
  assert.equal(select.props.value, '1')
  select.props.onChange({ target: { value: '2' } })
  assert.deepEqual(selects, ['vault-mcp'])
})

test('a crew change PATCHes at once, a failure reverts the preview and toasts the error', async () => {
  const { changeCrew } = crewSheet
  const target = repo('rustot', 1)
  const api = fakeApi({ 'PATCH /api/repos/rustot/crew': Object.assign(new Error('slot_taken'), { code: 'slot_taken', status: 409 }) })
  const previews = []
  const toasts = []
  await changeCrew({ api, repo: target, patch: { slot: 4 }, setPreview: crew => previews.push(crew), toast: item => toasts.push(item) })
  assert.deepEqual(api.calls, [{ method: 'PATCH', url: '/api/repos/rustot/crew', body: { slot: 4 } }])
  assert.deepEqual(previews, [{ seed: 'rustot', slot: 4, hat: 'none' }, { seed: 'rustot', slot: 1, hat: 'none' }])
  assert.deepEqual(toasts.map(item => [item.tone, item.text, item.undo]), [['error', 'Could not save the crew change: slot_taken', undefined]])
})

test('a saved change toasts with Undo, and Undo PATCHes the previous seed, slot and hat (crew AC5)', async () => {
  const { changeCrew, UNDO_MS } = crewSheet
  assert.equal(UNDO_MS, 6000)
  const target = repo('rustot', 1, { seed: 'rustot#2', hat: 'cap' })
  const api = fakeApi({ 'PATCH /api/repos/rustot/crew': body => ({ repo: { ...target, crew: { ...target.crew, ...body } } }) })
  const previews = []
  const toasts = []
  await changeCrew({ api, repo: target, patch: { slot: 5 }, setPreview: crew => previews.push(crew), toast: item => toasts.push(item) })
  assert.deepEqual(previews, [{ seed: 'rustot#2', slot: 5, hat: 'cap' }])
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].tone, 'success')
  assert.equal(toasts[0].text, 'rustot\'s crew member updated')
  assert.deepEqual(toasts[0].undo, { seed: 'rustot#2', slot: 1, slotShared: false, hat: 'cap' })
  // A change that leaves the slot alone does not send it back, so a shared slot is never claimed by Undo.
  await changeCrew({ api, repo: target, patch: { hat: 'none' }, setPreview() {}, toast: item => toasts.push(item) })
  assert.deepEqual(toasts[1].undo, { seed: 'rustot#2', hat: 'cap' })
  const { CrewSheetView } = crewSheet
  const undone = []
  const tree = CrewSheetView({ repos: REPOS, selected: 'rustot', toast: toasts[0], onSelect() {}, onChange() {}, onUndo: undo => undone.push(undo), onDismiss() {} })
  button(tree, 'Undo').props.onClick()
  assert.deepEqual(undone, [{ seed: 'rustot#2', slot: 1, slotShared: false, hat: 'cap' }])
})

test('Undo of a move away from a shared slot PATCHes the previous slot with slotShared true', async () => {
  const { changeCrew } = crewSheet
  const target = repo('rustot', 3, { slotShared: true })
  const api = fakeApi({ 'PATCH /api/repos/rustot/crew': body => ({ repo: { ...target, crew: { ...target.crew, ...body } } }) })
  const toasts = []
  await changeCrew({ api, repo: target, patch: { slot: 5 }, setPreview() {}, toast: item => toasts.push(item) })
  assert.deepEqual(toasts[0].undo, { seed: 'rustot', slot: 3, slotShared: true, hat: 'none' })
  const moved = { ...target, crew: { ...target.crew, slot: 5, slotShared: false } }
  await changeCrew({ api, repo: moved, patch: toasts[0].undo, setPreview() {}, toast: item => toasts.push(item) })
  assert.deepEqual(api.calls.map(call => call.body), [{ slot: 5 }, { seed: 'rustot', slot: 3, slotShared: true, hat: 'none' }])
})

test('the shared colors notice shows when any repo shares a slot', () => {
  const { CrewSheetView } = crewSheet
  const many = Array.from({ length: 10 }, (_, slot) => repo(`r${slot}`, slot % 9, { slotShared: slot === 9 }))
  assert.match(render(CrewSheetView, { repos: many, selected: 'r0', onSelect() {}, onChange() {} }), /10 repos share colors because there are more than 9\. Pick which ones share below\./)
})

test('repo names in the crew sheet are shown with visible tokens', () => {
  const { CrewSheetView } = crewSheet
  const html = render(CrewSheetView, { repos: [repo('ev‮il', 0)], selected: 'ev‮il', onSelect() {}, onChange() {} })
  assert.doesNotMatch(html, /‮/u)
  assert.match(html, /ev&lt;U\+202E&gt;il/)
})

test('the crew page renders inside the Settings shell with Crew as the current section', () => {
  const { SettingsView } = settings
  for (const section of ['appearance', 'crew']) {
    const html = render(SettingsView, { section, prefs: {}, navigate() {}, children: 'BODY' })
    assert.match(html, /BODY/, section)
    assert.doesNotMatch(html, /later milestone/, section)
  }
  const { CrewSheet } = crewSheet
  const state = { loaded: true, data: { repos: REPOS, prefs: {} } }
  const html = render(CrewSheet, { route: { name: 'crew', params: {} }, search: '?repo=vault-mcp', state, navigate() {}, api: fakeApi() })
  assert.match(html, /<a class="settings-nav-link" href="\/settings\/crew" aria-current="page">/)
  assert.match(html, /Customize vault-mcp&#x27;s crew member/)
})

test('Appearance PATCHes textSize and motion, writes deck.density, and shows the environment language read-only', () => {
  const { AppearanceSection } = settings
  const changes = []
  const stored = new Map()
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }
  const routes = []
  const props = {
    prefs: { textSize: 14, motion: 'system', terminalScreenReader: false, lang: 'en' }, sources: { lang: 'env' }, repos: REPOS, storage,
    navigate: to => routes.push(to), onChange: (key, value) => changes.push([key, value])
  }
  const tree = AppearanceSection(props)
  const size = find(tree, node => node.type === 'select' && node.props.id === 'pref-textSize')[0]
  assert.equal(size.props.value, '14')
  assert.deepEqual(find(size.props.children, node => node.type === 'option').map(node => [node.props.value, textOf(node)]),
    [['13', '13px'], ['14', '14px (default)'], ['15', '15px'], ['16', '16px']])
  size.props.onChange({ target: { value: '16' } })
  const motion = radios(tree, 'Motion')
  assert.deepEqual(motion.map(node => [textOf(node), node.props['aria-checked']]), [['Follow the system setting', 'true'], ['Always reduce motion', 'false']])
  motion[1].props.onClick()
  const reader = find(tree, node => node.type === 'input' && node.props.id === 'pref-terminalScreenReader')[0]
  assert.equal(reader.props.checked, false)
  reader.props.onChange({ target: { checked: true } })
  assert.deepEqual(changes, [['textSize', 16], ['motion', 'reduce'], ['terminalScreenReader', true]])
  const density = radios(tree, 'Density')
  assert.deepEqual(density.map(node => [textOf(node), node.props['aria-checked']]), [['Comfortable', 'true'], ['Compact', 'false']])
  density[1].props.onClick()
  assert.equal(stored.get('deck.density'), 'compact')
  assert.equal(AppearanceSection(props) && radios(AppearanceSection(props), 'Density')[1].props['aria-checked'], 'true')
  const html = render(AppearanceSection, props)
  assert.match(html, /English \(set by DECK_LANG\)/)
  assert.match(html, /Slower\. Lets screen readers read terminal output\./)
  const language = find(tree, node => node.props?.className === 'setting-row setting-language')[0]
  assert.ok(language)
  assert.equal(find(language.props.children, node => ['select', 'input', 'button'].includes(node.type)).length, 0)
  assert.doesNotMatch(html, /share 9 colors/)
})

test('Appearance names shared colors with a Customize crew link', () => {
  const { AppearanceSection } = settings
  const routes = []
  const many = Array.from({ length: 10 }, (_, slot) => repo(`r${slot}`, slot % 9, { slotShared: slot === 9 }))
  const props = { prefs: {}, sources: {}, repos: many, navigate: to => routes.push(to), onChange() {} }
  assert.match(render(AppearanceSection, props), /10 repos share 9 colors/)
  const link = find(AppearanceSection(props), node => node.type === 'a' && textOf(node) === 'Customize crew')[0]
  assert.equal(link.props.href, '/settings/crew')
  link.props.onClick({ button: 0, defaultPrevented: false, preventDefault() {} })
  assert.deepEqual(routes, ['/settings/crew'])
})

test('Connections shows the outdated deckd line only for reason deckd_outdated', () => {
  const { ConnectionsSection } = settings
  const line = /deckd is older than the deck; restart it when no session is running/
  const base = { prefs: { scanRoot: '~/dev' }, onSave() {}, onRescan() {}, onStart() {}, onChecklist() {} }
  assert.match(render(ConnectionsSection, { ...base, health: [{ dep: 'deckd', state: 'ok', reason: 'deckd_outdated' }] }), line)
  assert.doesNotMatch(render(ConnectionsSection, { ...base, health: [{ dep: 'deckd', state: 'ok', reason: null }] }), line)
  assert.doesNotMatch(render(ConnectionsSection, { ...base, health: [{ dep: 'deckd', state: 'down', reason: 'deckd_incompatible' }] }), line)
  assert.doesNotMatch(render(ConnectionsSection, { ...base, health: [{ dep: 'scribed', state: 'ok', reason: 'deckd_outdated' }] }), line)
})
