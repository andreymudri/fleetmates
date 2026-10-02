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

test('the package version equals the newest CHANGELOG heading', () => {
  assert.equal(newestChangelogVersion(changelog), pkg.version)
})

test('the package lock root entries carry the package version', async () => {
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'))
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
})

test('GET /api/version reports the newest CHANGELOG version with build m2', async t => {
  const { startDeckServer } = await import('../../server/main.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'm2r-'))
  const token = 'b'.repeat(43)
  const env = { HOME: dir, XDG_RUNTIME_DIR: path.join(dir, 'r') }
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const state = path.join(dir, '.local/state/fleetmates/deck')
  await mkdir(state, { recursive: true, mode: 0o700 })
  await writeFile(path.join(state, 'token'), token, { mode: 0o600 })
  const deck = await startDeckServer({ env, port: 0, staticDir: dir, notifications: false,
    connectDeckd: async () => { throw Error('fake offline') },
    runCommand: () => ({ status: 0, stdout: '2.1.282', stderr: '' }) })
  t.after(async () => { await deck.close()
    await rm(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${deck.address().port}`
  const res = await fetch(`${base}/api/version`, { headers: { Authorization: `Bearer ${token}`, Origin: base } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { apiVersion: 1, deckVersion: newestChangelogVersion(changelog), build: 'm2' })
})
