import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')

test('the 0.3.0 CHANGELOG entry says deckd changed', () => {
  const entry = changelog.slice(changelog.indexOf('## v0.3.0'), changelog.indexOf('## v0.2.0'))
  assert.match(entry, /deckd changed: yes/)
})
