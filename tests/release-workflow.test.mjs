import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8')

test('release runs on a version tag and nowhere else', async () => {
  const yml = await read('.github/workflows/release.yml')
  assert.match(yml, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n/m)
  assert.doesNotMatch(yml, /pull_request|branches:/)
})

test('publish needs the full test matrix, the same one test.yml runs', async () => {
  const [release, tests] = await Promise.all([read('.github/workflows/release.yml'), read('.github/workflows/test.yml')])
  const matrix = (text) => text.match(/os: \[([^\]]+)\]/)?.[1]
  assert.equal(matrix(release), matrix(tests))
  assert.match(release, /publish:\n(?: {4}.*\n)*? {4}needs: test\n/)
})

test('publish authenticates by OIDC with no token secret', async () => {
  const yml = await read('.github/workflows/release.yml')
  assert.match(yml, /id-token: write/)
  assert.doesNotMatch(yml, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./)
  assert.match(yml, /npm publish --provenance --access public/)
})

test('publish refuses a tag that does not match package.json, and an npm too old for trusted publishing', async () => {
  const yml = await read('.github/workflows/release.yml')
  assert.match(yml, /"\$\{GITHUB_REF_NAME\}" != "v\$\{version\}"/)
  assert.match(yml, /11\.5\.1/)
})

test('a version already on npm is reported and skipped, not failed', async () => {
  const yml = await read('.github/workflows/release.yml')
  assert.match(yml, /npm view "fleetmates@\$\{VERSION\}" version/)
  assert.match(yml, /is already on npm — nothing to publish/)
})

test('after publish, the directory branch is refreshed from the tag by tools/directory-branch.mjs', async () => {
  const yml = await read('.github/workflows/release.yml')
  const job = yml.slice(yml.indexOf('\n  directory:\n'))
  assert.match(job, /^\n {2}directory:\n(?: {4}.*\n|\s*\n)*? {4}needs: publish\n/)
  assert.match(job, /contents: write/)
  assert.match(job, /node tools\/directory-branch\.mjs --ref HEAD/)
  assert.match(job, /git push origin "\$\{sha\}:refs\/heads\/directory"/)
  // Only the directory job may write to the repository.
  assert.equal(yml.match(/contents: write/g).length, 1)
})
