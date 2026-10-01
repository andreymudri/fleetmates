// M1 cleanup, web (plan task 18): the findings carried out of the M1 run (docs/deck/m1-exit.md section 5)
// for First run, Settings and the shell's loading page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import { createDeckStore, initialState } from '../../web/src/state/deck-store.js'
import { doctor } from '../../server/setup/doctor.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))

async function load(name) {
  const { module } = await runnerImport(path.join(hub, 'web/src', name), { configFile: false, logLevel: 'silent', root: hub })
  return module
}

const first = await load('screens/first-run/FirstRun.jsx')
const settings = await load('screens/settings/Settings.jsx')
const { App } = await load('shell/App.jsx')

// Expand pure function components (no hooks) and collect host elements of the given types.
function elements(node, types, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, types, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function') return elements(node.type(node.props), types, out)
  if (types.includes(node.type)) out.push(node)
  elements(node.props?.children, types, out)
  return out
}
const textOf = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}

const claudeCheck = (state, detail) => ({ id: 'claude', state, blocking: false, detail, error: null })

test('first run shows a missing Claude Code as missing, even though the doctor detail names the tested version', async () => {
  const { rowView } = first
  const dir = await mkdtemp(path.join(tmpdir(), 'm1-cleanup-'))
  try {
    const paths = setupPaths({ HOME: path.join(dir, 'home'), XDG_RUNTIME_DIR: path.join(dir, 'r') })
    const missing = (await doctor(paths, 'deck-hook', { run: () => ({ status: 127, stdout: '', stderr: 'not found' }) })).find(row => row.id === 'claude')
    assert.match(missing.detail, /2\.1\.282/, 'the doctor detail for a missing claude names the tested version')
    const view = rowView(missing)
    assert.equal(view.title, 'Claude Code was not found')
    assert.equal(view.tone, 'warn')
    assert.doesNotMatch(view.title, /newer/)

    const newer = (await doctor(paths, 'deck-hook', { run: file => file === 'claude' ? { status: 0, stdout: '2.2.0 (Claude Code)\n', stderr: '' } : { status: 3, stdout: '', stderr: '' } })).find(row => row.id === 'claude')
    assert.equal(rowView(newer).title, 'Claude Code 2.2.0 is newer than this deck was tested with')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  assert.equal(rowView(claudeCheck('failed', 'Claude Code unavailable; tested 2.1.282')).title, 'Claude Code was not found')
  assert.equal(rowView(claudeCheck('ok', 'Claude Code 2.1.282; tested 2.1.282')).title, 'Claude Code 2.1.282 compatible')
})

test('command preferences accept quoted arguments, refuse unbalanced quotes and NUL, and show argv so it parses back', () => {
  const { parsePref, prefText } = settings
  const argv = { key: 'vaultCommand', argv: true }
  assert.deepEqual(parsePref(argv, 'node \'/home/you/my vault/index.mjs\' --flag'), ['node', '/home/you/my vault/index.mjs', '--flag'])
  assert.deepEqual(parsePref(argv, 'node "/home/you/my vault/index.mjs"'), ['node', '/home/you/my vault/index.mjs'])
  assert.deepEqual(parsePref(argv, 'a\'b c\'"d e" \'\''), ['ab cd e', ''], 'adjacent quoted parts join and an empty quoted argument is kept')
  assert.deepEqual(parsePref(argv, '"it\'s" \'say "hi"\''), ['it\'s', 'say "hi"'])
  assert.deepEqual(parsePref(argv, ' a  b\tc '), ['a', 'b', 'c'])
  assert.deepEqual(parsePref(argv, 'echo $HOME `id` ; rm'), ['echo', '$HOME', '`id`', ';', 'rm'], 'no shell interpretation: the result is still argv')
  assert.equal(parsePref(argv, 'node \'/home/you/vault'), undefined, 'an unbalanced single quote is refused')
  assert.equal(parsePref(argv, 'node "/home/you/vault'), undefined, 'an unbalanced double quote is refused')
  assert.equal(parsePref(argv, 'node \'a\0b\''), undefined, 'NUL is still refused')
  for (const value of [['node', '/home/you/my vault/index.mjs'], ['say', 'it\'s "x"'], ['a', ''], ['npx', '-y', '@scope/pkg']]) {
    assert.deepEqual(parsePref(argv, prefText(value)), value, `${JSON.stringify(value)} survives a round trip through its field text`)
  }
  assert.equal(prefText(['npx', '-y']), 'npx -y')
  assert.equal(prefText(['node', '/home/you/my vault/x.mjs']), 'node \'/home/you/my vault/x.mjs\'')
})

test('a stored value with hidden characters is kept unless the owner changes the field, and the field says it holds them', () => {
  const { ConnectionsSection } = settings
  const prefs = { scanRoot: '~/dev', vaultPath: '/home/you/vault\u200b ', claudeCommand: 'clau​de', scribedCommand: 'scribed', vaultCommand: ['node', '/home/you/v‮mcp.mjs'], staleMinutes: 20 }
  const saved = []
  const tree = ConnectionsSection({ prefs, onSave: (key, value) => saved.push([key, value]), onRescan() {}, onStart() {}, onChecklist() {} })
  const forms = elements(tree, ['form'])
  const form = name => forms.find(node => elements(node, ['input'])[0].props.name === name)
  const shownValue = name => elements(form(name), ['input'])[0].props.defaultValue
  const submit = (name, value) => form(name).props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value }) } } })

  assert.equal(shownValue('claudeCommand'), 'clau<U+200B>de')
  assert.equal(shownValue('vaultCommand'), 'node /home/you/v<U+202E>mcp.mjs')
  submit('claudeCommand', shownValue('claudeCommand'))
  submit('vaultCommand', shownValue('vaultCommand'))
  assert.equal(shownValue('vaultPath'), '/home/you/vault<U+200B> ')
  submit('vaultPath', shownValue('vaultPath'))
  assert.deepEqual(saved, [], 'saving the displayed text unchanged writes nothing back')
  submit('claudeCommand', 'claude')
  assert.deepEqual(saved, [['claudeCommand', 'claude']], 'an edit is saved')

  const hint = /The stored value contains hidden characters/
  assert.match(textOf(form('claudeCommand')), hint)
  assert.match(textOf(form('vaultCommand')), hint)
  assert.doesNotMatch(textOf(form('scribedCommand')), hint)
  assert.doesNotMatch(textOf(form('scanRoot')), hint)
})

test('the loading page has a level-one heading', () => {
  const html = renderToStaticMarkup(createElement(App, { store: createDeckStore(initialState()), path: '/', navigate: () => {}, onRetry: () => {} }))
  assert.match(html, /class="skeleton-grid"/)
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1)
  assert.match(html, /<h1 class="sr-only">Sessions<\/h1>/)
  const settingsHtml = renderToStaticMarkup(createElement(App, { store: createDeckStore(initialState()), path: '/settings/connections', navigate: () => {}, onRetry: () => {} }))
  assert.match(settingsHtml, /<h1 class="sr-only">Settings<\/h1>/)
})
