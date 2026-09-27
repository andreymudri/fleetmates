// Every captured screen frame, rendered through deckd's headless screen model
// at the capture size, must parse to its hand-written expectation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ScreenModel } from '../../deckd/screen-model.mjs'
import { parseScreen } from '../../server/screen/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, '..', 'fixtures')
const screensRoot = path.join(fixturesDir, 'screens')

for (const version of readdirSync(screensRoot)) {
  const dir = path.join(screensRoot, version)
  const manifest = JSON.parse(readFileSync(path.join(fixturesDir, 'hooks', version, 'MANIFEST.json'), 'utf8'))
  const { cols, rows } = manifest.size
  const files = readdirSync(dir)
  const frames = files.filter((f) => f.endsWith('.ansi')).map((f) => f.slice(0, -'.ansi'.length)).sort()

  test(`screens ${version}: every .ansi frame has an .expect.json`, () => {
    assert.ok(frames.length > 0, `${version} has no .ansi frames`)
    const missing = frames.filter((name) => !files.includes(`${name}.expect.json`))
    assert.deepEqual(missing, [], `${version} frames without an .expect.json`)
  })

  for (const name of frames) {
    if (!files.includes(`${name}.expect.json`)) continue
    test(`screens ${version}/${name}: parseScreen matches the expectation`, async () => {
      const model = new ScreenModel({ cols, rows })
      try {
        model.write(readFileSync(path.join(dir, `${name}.ansi`)))
        await model.flush()
        const expected = JSON.parse(readFileSync(path.join(dir, `${name}.expect.json`), 'utf8'))
        assert.deepEqual(parseScreen(model.lines(), model.cursor()), expected)
      } finally {
        model.dispose()
      }
    })
  }
}
