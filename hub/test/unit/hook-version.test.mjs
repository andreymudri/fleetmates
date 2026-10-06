// Task 23 (13-operations 9.4): deck-hook stamps the hub package version in every envelope, the server compares
// it with its own, and Settings, Connections tells the owner when hooks come from an older deck release.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runnerImport } from 'vite'
import { compareVersions, hookVersionOutdated } from '../../server/ingest/validate.mjs'
import { makeEnvelope } from '../../hook/deck-hook.mjs'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const version = JSON.parse(fs.readFileSync(path.join(hub, 'package.json'), 'utf8')).version
const hook = { session_id: 's', transcript_path: '/home/you/t.jsonl', cwd: '/home/you/dev/x', hook_event_name: 'Stop', stop_hook_active: false }

test('compareVersions orders semver versions and refuses malformed ones', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1, 'numeric, not lexical')
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0'), -1, 'a prerelease sorts before its release')
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.10'), -1)
  assert.equal(compareVersions('0.2.0+build.5', '0.2.0'), 0, 'build metadata is ignored')
  for (const bad of [null, undefined, '', '0.2', 'v0.2.0', '0.2.0.1', '01.2.0', 'latest', 2, {}]) assert.equal(compareVersions(bad, '0.2.0'), null, String(bad))
})

test('hookVersionOutdated: older, missing and malformed stamps are outdated; equal and newer are not', () => {
  assert.equal(hookVersionOutdated('0.1.0', '0.2.0'), true, 'older')
  assert.equal(hookVersionOutdated('0.2.0', '0.2.0'), false, 'equal')
  assert.equal(hookVersionOutdated('0.3.0', '0.2.0'), false, 'newer')
  assert.equal(hookVersionOutdated(undefined, '0.2.0'), true, 'missing')
  assert.equal(hookVersionOutdated(null, '0.2.0'), true, 'null')
  assert.equal(hookVersionOutdated('0.2', '0.2.0'), true, 'malformed')
  assert.equal(hookVersionOutdated(20, '0.2.0'), true, 'not a string')
})

test('the hook stamps the version from the package.json beside it', async () => {
  assert.equal(makeEnvelope(hook, { hookTs: 1, ptyId: null }).deckHookVersion, version)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkv-'))
  try {
    for (const name of ['with', 'without']) fs.mkdirSync(path.join(dir, name, 'hook'), { recursive: true })
    fs.copyFileSync(path.join(hub, 'hook/deck-hook.mjs'), path.join(dir, 'with/hook/deck-hook.mjs'))
    fs.copyFileSync(path.join(hub, 'hook/deck-hook.mjs'), path.join(dir, 'without/hook/deck-hook.mjs'))
    fs.writeFileSync(path.join(dir, 'with/package.json'), JSON.stringify({ version: '9.8.7' }))
    const withPackage = await import(pathToFileURL(path.join(dir, 'with/hook/deck-hook.mjs')).href)
    assert.equal(withPackage.makeEnvelope(hook, { hookTs: 1, ptyId: null }).deckHookVersion, '9.8.7')
    const withoutPackage = await import(pathToFileURL(path.join(dir, 'without/hook/deck-hook.mjs')).href)
    assert.equal(withoutPackage.makeEnvelope(hook, { hookTs: 1, ptyId: null }).deckHookVersion, null, 'no package.json stamps null, which the server counts as older')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Connections shows the older hooks line only for a hooks row with reason hooks_outdated', async () => {
  const { module: settings } = await runnerImport(path.join(hub, 'web/src/screens/settings/Settings.jsx'), { configFile: false, logLevel: 'silent', root: hub })
  const { ConnectionsSection } = settings
  const render = props => renderToStaticMarkup(createElement(ConnectionsSection, props))
  const line = /Hooks are from an older deck release\. Run fleetmates-deck init\./
  const base = { prefs: { scanRoot: '~/dev' }, onSave() {}, onRescan() {}, onStart() {}, onChecklist() {} }
  assert.match(render({ ...base, health: [{ dep: 'hooks', state: 'warn', reason: 'hooks_outdated' }] }), line)
  assert.doesNotMatch(render({ ...base, health: [{ dep: 'hooks', state: 'ok', reason: null }] }), line)
  assert.doesNotMatch(render({ ...base, health: [{ dep: 'hooks', state: 'down', reason: 'hooks_missing' }] }), line)
  assert.doesNotMatch(render({ ...base, health: [{ dep: 'deckd', state: 'warn', reason: 'hooks_outdated' }] }), line)
})
