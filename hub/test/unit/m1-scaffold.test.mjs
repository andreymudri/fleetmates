import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hub = fileURLToPath(new URL('../..', import.meta.url))
const root = path.dirname(hub)

const json = async (file) => JSON.parse(await readFile(file, 'utf8'))

test('M1 build stays in hub and mounts visible content', async () => {
  const pkg = await json(path.join(hub, 'package.json'))
  const lock = await json(path.join(hub, 'package-lock.json'))
  const rootPkg = await json(path.join(root, 'package.json'))

  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.engines.node, '>=24.2.0')
  assert.equal(typeof pkg.scripts.build, 'string')
  for (const name of ['react', 'react-dom', 'vite']) {
    const version = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]
    assert.match(version, /^\d+\.\d+\.\d+$/)
    assert.equal(lock.packages[''].dependencies?.[name] ?? lock.packages[''].devDependencies?.[name], version)
  }
  assert.equal(rootPkg.dependencies, undefined)
  assert.equal(rootPkg.devDependencies, undefined)
  const viteConfig = (await import('../../web/vite.config.mjs')).default
  assert.equal(path.relative(hub, path.resolve(viteConfig.root, viteConfig.build.outDir)), path.join('web', 'dist'))

  const out = await mkdtemp(path.join(tmpdir(), 'deck-build-'))
  try {
    execFileSync('npm', ['run', 'build', '--', '--outDir', out], { cwd: hub, stdio: 'pipe' })
    const html = await readFile(path.join(out, 'index.html'), 'utf8')
    assert.match(html, /<div id="root"><\/div>/)
    assert.match(html, /assets\/[^" ]+\.js/)
    const asset = (await readdir(path.join(out, 'assets'))).find((name) => name.endsWith('.js'))
    assert.ok(asset)
    const { JSDOM, VirtualConsole } = await import('jsdom')
    const errors = []
    const virtualConsole = new VirtualConsole()
    virtualConsole.on('jsdomError', (error) => errors.push(error.message))
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1/',
      runScripts: 'outside-only',
      virtualConsole,
    })
    try {
      dom.window.eval(await readFile(path.join(out, 'assets', asset), 'utf8'))
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.deepEqual(errors, [])
      assert.equal(dom.window.document.querySelector('main h1')?.textContent, 'Fleetmates Deck')
    } finally {
      dom.window.close()
    }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('deck CI declares pinned Node, build, and tests on Linux and macOS', async () => {
  const version = (await readFile(path.join(hub, '.node-version'), 'utf8')).trim()
  const workflow = await readFile(path.join(root, '.github/workflows/deck.yml'), 'utf8')
  assert.match(version, /^24\.\d+\.\d+$/)
  assert.match(workflow, /ubuntu-latest/)
  assert.match(workflow, /macos-latest/)
  assert.doesNotMatch(workflow, /windows-latest/)
  assert.ok(workflow.includes(`node-version-file: hub/.node-version`))
  assert.match(workflow, /npm ci --prefix hub/)
  assert.match(workflow, /npm --prefix hub run build/)
  assert.match(workflow, /npm --prefix hub test/)
  assert.match(workflow, /TMPDIR: \/tmp\/hx/)
  assert.doesNotMatch(workflow, /^\s+if:\s*(?:false|0)\s*$/m)
})
