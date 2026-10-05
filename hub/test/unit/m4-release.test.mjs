import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')

test('the 0.4.0 CHANGELOG entry says deckd did not change and names migration 0005-meetings', () => {
  const entry = changelog.slice(changelog.indexOf('## v0.4.0'), changelog.indexOf('## v0.3.0'))
  assert.match(entry, /deckd changed: no/)
  assert.match(entry, /Database migration: yes \(`0005-meetings`/)
})
