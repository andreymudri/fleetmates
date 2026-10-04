import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
