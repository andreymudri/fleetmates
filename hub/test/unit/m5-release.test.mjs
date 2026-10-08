import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')

/** The version in the first `## vX.Y.Z` heading of the changelog, or null. */
function newestChangelogVersion(text) {
  const match = /^## v(\d+\.\d+\.\d+)\b/m.exec(text)
  return match ? match[1] : null
}

test('the M5 package version is 0.5.0, equals the newest CHANGELOG heading and is publishable', () => {
  assert.equal(pkg.version, '0.5.0')
  assert.equal(newestChangelogVersion(changelog), pkg.version)
  assert.equal(pkg.private, undefined)
})

test('GET /api/version reports the newest CHANGELOG version with build m5', async t => {
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'm5r-'))
  const token = 'd'.repeat(43)
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  await mkdir(state, { recursive: true, mode: 0o700 })
  await writeFile(path.join(state, 'token'), token, { mode: 0o600 })
  const deck = await startDeckServer({ env, port: 0, staticDir: dir, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '2.1.285', stderr: '' }) })
  t.after(async () => { await deck.close()
    await rm(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${deck.address().port}`
  const res = await fetch(`${base}/api/version`, { headers: { Authorization: `Bearer ${token}`, Origin: base } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { apiVersion: 1, deckVersion: newestChangelogVersion(changelog), build: 'm5' })
})
