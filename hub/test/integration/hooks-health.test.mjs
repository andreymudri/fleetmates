// The `hooks` health row (owner decision 2026-10-01): computed at server start, rechecked after every repo
// rescan and after POST /api/setup/hooks, and published as health.changed only when its state or reason changes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startDeckServer } from '../../server/main.mjs'
import { setupPaths } from '../../server/setup/paths.mjs'
import { checkHooks, deckHookCommand, transformHooks } from '../../server/setup/hooks.mjs'

const token = 'a'.repeat(43)

/** A private HOME holding the token, a hook script, a scan root and, unless `installed` is false, the deck hooks. */
function home({ installed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkh-'))
  const env = { HOME: dir }
  const paths = setupPaths(env)
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  fs.writeFileSync(paths.token, token, { mode: 0o600 })
  fs.mkdirSync(path.dirname(paths.hook), { recursive: true })
  fs.writeFileSync(paths.hook, '// deck hook stand-in\n', { mode: 0o600 })
  fs.mkdirSync(path.dirname(paths.settings), { recursive: true })
  const command = deckHookCommand(process.execPath, paths.hook)
  fs.writeFileSync(paths.settings, JSON.stringify(installed ? transformHooks({}, command) : {}))
  const scanRoot = path.join(dir, 'repos')
  fs.mkdirSync(scanRoot)
  const staticDir = path.join(dir, 'web')
  fs.mkdirSync(staticDir)
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>Test deck</h1>')
  return { dir, env, paths, command, scanRoot, staticDir }
}

async function harness(t, place = home()) {
  const deck = await startDeckServer({ env: place.env, port: 0, staticDir: place.staticDir, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') }, reconnectMs: 60_000, runPollMs: 3_600_000,
    runCommand: () => ({ status: 0, stdout: '', stderr: '' }) })
  t.after(async () => { await deck.close()
    fs.rmSync(place.dir, { recursive: true, force: true }) })
  const request = async (route, method = 'GET', body) => {
    const origin = `http://127.0.0.1:${deck.address().port}`
    const response = await fetch(origin + route, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } })
    return { status: response.status, data: await response.json() }
  }
  const published = []
  t.after(deck.subscribe(event => published.push(event)))
  const hooksEvents = () => published.filter(event => event.type === 'health.changed' && event.data.dep === 'hooks')
  return { deck, request, hooksEvents, ...place }
}

test('checkHooks reads the settings file and the hook script with the doctor rules', t => {
  const place = home()
  t.after(() => fs.rmSync(place.dir, { recursive: true, force: true }))
  assert.deepEqual(checkHooks(place.paths, place.command), { state: 'ok', reason: null })
  fs.rmSync(place.paths.hook)
  assert.deepEqual(checkHooks(place.paths, place.command), { state: 'down', reason: 'hook_script_missing' })
  fs.mkdirSync(place.paths.hook)
  assert.deepEqual(checkHooks(place.paths, place.command), { state: 'down', reason: 'hook_script_missing' }, 'a directory is not a hook script')
  fs.writeFileSync(place.paths.settings, '{')
  assert.deepEqual(checkHooks(place.paths, place.command), { state: 'down', reason: 'hooks_missing' }, 'unreadable settings count as missing')
})

test('installed hooks read ok in the snapshot, a removed entry is published once on rescan, and an unchanged rescan publishes nothing', async t => {
  const h = await harness(t)
  const row = (await h.deck.snapshot()).data.health.find(entry => entry.dep === 'hooks')
  assert.equal(row.state, 'ok')
  assert.equal(row.reason, null)
  assert.equal(row.nextProbeAt, null)
  assert.equal(row.attempt, 0)
  assert.equal(typeof row.since, 'number')
  assert.equal((await h.request('/api/prefs', 'PATCH', { scanRoot: h.scanRoot })).status, 200)

  fs.writeFileSync(h.paths.settings, JSON.stringify(transformHooks(JSON.parse(fs.readFileSync(h.paths.settings, 'utf8')), h.command, true)))
  assert.equal((await h.request('/api/repos/rescan', 'POST')).status, 202)
  assert.deepEqual(h.hooksEvents().map(event => [event.data.state, event.data.reason]), [['down', 'hooks_missing']])
  assert.ok(h.hooksEvents()[0].seq > 0, 'the change is a persisted event')
  assert.equal((await h.request('/api/repos/rescan', 'POST')).status, 202)
  assert.equal(h.hooksEvents().length, 1, 'a rescan with no change publishes nothing')

  const deps = (await h.request('/api/health')).data.deps
  assert.deepEqual(deps.slice(0, 2).map(entry => entry.dep), ['deckd', 'hooks'], 'the hooks row sits next to deckd')
  assert.equal(deps[1].reason, 'hooks_missing')
})

test('POST /api/setup/hooks refreshes the row', async t => {
  const h = await harness(t, home({ installed: false }))
  assert.equal((await h.request('/api/health')).data.deps.find(entry => entry.dep === 'hooks').reason, 'hooks_missing')
  assert.equal((await h.request('/api/setup/hooks', 'POST')).status, 200)
  assert.deepEqual(h.hooksEvents().map(event => [event.data.state, event.data.reason]), [['ok', null]])
  assert.equal((await h.request('/api/health')).data.deps.find(entry => entry.dep === 'hooks').state, 'ok')
})

// Task 23: the server compares each accepted envelope's deckHookVersion with its own package version.
const deckVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
let nextHookTs = 1_000
/** Feed one valid Stop envelope stamped `stamp` (omitted when undefined) through the ingestor and flush it. */
function feed(deck, stamp) {
  const envelope = { v: 1, hookTs: nextHookTs++, ptyId: null, claudePid: null, pidChain: [], truncated: false,
    hook: { session_id: 'hv-session', transcript_path: '/home/you/t.jsonl', cwd: '/home/you/dev/x', hook_event_name: 'Stop', stop_hook_active: false } }
  if (stamp !== undefined) envelope.deckHookVersion = stamp
  assert.equal(deck.ingest.receive(JSON.stringify(envelope)), true, 'the envelope validates')
  deck.ingest.flush()
}
const hooksRow = async h => (await h.request('/api/health')).data.deps.find(entry => entry.dep === 'hooks')
const hookEvents = h => Number(h.deck.store.get('SELECT COUNT(*) AS n FROM hook_events').n)

test('an envelope stamped 0.1.0 turns the hooks row to warn/hooks_outdated once and is still accepted', async t => {
  const h = await harness(t)
  feed(h.deck, deckVersion)
  assert.equal((await hooksRow(h)).state, 'ok', 'a current stamp leaves the row ok')
  assert.equal(h.hooksEvents().length, 0)
  feed(h.deck, '0.1.0')
  assert.deepEqual([(await hooksRow(h)).state, (await hooksRow(h)).reason], ['warn', 'hooks_outdated'])
  assert.deepEqual(h.hooksEvents().map(event => [event.data.state, event.data.reason]), [['warn', 'hooks_outdated']])
  feed(h.deck, '0.1.0')
  feed(h.deck)
  assert.equal(h.hooksEvents().length, 1, 'published once while it stays outdated, a missing stamp included')
  assert.equal(hookEvents(h), 4, 'outdated envelopes are still accepted')
})

test('a run of current envelopes returns the row to ok', async t => {
  const h = await harness(t)
  feed(h.deck, '0.1.0')
  feed(h.deck, deckVersion)
  feed(h.deck, deckVersion)
  assert.equal((await hooksRow(h)).reason, 'hooks_outdated', 'two current envelopes are not yet a run')
  feed(h.deck, '0.1.0')
  feed(h.deck, deckVersion)
  feed(h.deck, deckVersion)
  assert.equal((await hooksRow(h)).reason, 'hooks_outdated', 'an older envelope restarts the run')
  feed(h.deck, deckVersion)
  assert.deepEqual([(await hooksRow(h)).state, (await hooksRow(h)).reason], ['ok', null])
  assert.deepEqual(h.hooksEvents().map(event => [event.data.state, event.data.reason]), [['warn', 'hooks_outdated'], ['ok', null]])
})

test('POST /api/setup/hooks clears hooks_outdated, and hooks_missing keeps priority over it', async t => {
  const h = await harness(t)
  feed(h.deck, '0.1.0')
  assert.equal((await hooksRow(h)).reason, 'hooks_outdated')
  assert.equal((await h.request('/api/prefs', 'PATCH', { scanRoot: h.scanRoot })).status, 200)
  fs.writeFileSync(h.paths.settings, '{}')
  assert.equal((await h.request('/api/repos/rescan', 'POST')).status, 202)
  assert.deepEqual([(await hooksRow(h)).state, (await hooksRow(h)).reason], ['down', 'hooks_missing'])
  feed(h.deck, '0.1.0')
  assert.equal((await hooksRow(h)).reason, 'hooks_missing', 'an older envelope does not hide missing hooks')
  assert.equal((await h.request('/api/setup/hooks', 'POST')).status, 200)
  assert.deepEqual([(await hooksRow(h)).state, (await hooksRow(h)).reason], ['ok', null])
  assert.deepEqual(h.hooksEvents().map(event => [event.data.state, event.data.reason]), [['warn', 'hooks_outdated'], ['down', 'hooks_missing'], ['ok', null]])
})
