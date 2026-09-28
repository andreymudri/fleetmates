import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The phase gate runs this file through its hub-test check; root npm test does not run hub tests.

const hub = fileURLToPath(new URL('../..', import.meta.url))
const root = path.dirname(hub)

const json = async (file) => JSON.parse(await readFile(file, 'utf8'))

test('M1 build emits an entry script that mounts a heading', async () => {
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
    await writeFile(path.join(out, 'package.json'), '{"type":"module"}')
    const html = await readFile(path.join(out, 'index.html'), 'utf8')
    assert.match(html, /<div id="root"><\/div>/)
    const script = html.match(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*><\/script>/)
    assert.ok(script)
    assert.match(script[1], /^\.\/assets\/[^/]+\.js$/)
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
      assert.equal(dom.window.document.querySelector('script[src]')?.type, 'module')
      for (const link of dom.window.document.querySelectorAll('link[rel="stylesheet"]')) {
        assert.match(link.getAttribute('href'), /^\.\/assets\/[^/]+\.css$/)
        const style = dom.window.document.createElement('style')
        style.textContent = await readFile(path.join(out, link.getAttribute('href').slice(2)), 'utf8')
        dom.window.document.head.append(style)
      }
      for (const link of dom.window.document.querySelectorAll('link[rel="modulepreload"]')) link.remove()
      const globals = new Map()
      for (const name of ['window', 'document', 'navigator', 'MutationObserver']) {
        globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
        Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
      }
      try {
        await import(pathToFileURL(path.join(out, script[1].slice(2))).href)
      } finally {
        for (const [name, descriptor] of globals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor)
          else delete globalThis[name]
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.deepEqual(errors, [])
      const heading = dom.window.document.querySelector('main h1')
      assert.equal(heading?.textContent, 'Fleetmates Deck')
      for (let element = heading; element; element = element.parentElement) {
        const style = dom.window.getComputedStyle(element)
        assert.notEqual(style.display, 'none')
        assert.notEqual(style.visibility, 'hidden')
        assert.notEqual(style.opacity, '0')
      }
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
  assert.match(workflow, /^on:\n  push:\n    branches: \[master\]\n  pull_request:\n\njobs:/m)
  assert.doesNotMatch(workflow, /windows-latest/)
  const hubJob = workflow.split(/^  hub:\s*$/m)[1]?.split(/^  [\w-]+:\s*$/m)[0]
  assert.ok(hubJob)
  assert.match(hubJob, /^        os: \[ubuntu-latest, macos-latest\]$/m)
  assert.match(hubJob, /^    runs-on: \$\{\{ matrix\.os \}\}$/m)
  assert.match(hubJob, /^      TMPDIR: \/tmp\/hx$/m)
  const steps = hubJob.match(/^    steps:\n[\s\S]*$/m)?.[0].trimEnd()
  assert.equal(steps, [
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version-file: hub/.node-version',
    '          cache: npm',
    '          cache-dependency-path: hub/package-lock.json',
    '      - run: mkdir -p /tmp/hx',
    '      - run: npm ci --prefix hub',
    '      - run: npm --prefix hub run build',
    '      - run: npm --prefix hub test',
  ].join('\n'))
  assert.doesNotMatch(hubJob, /^\s+(?:-\s+)?if:/m)
  assert.doesNotMatch(hubJob, /^\s+(?:-\s+)?continue-on-error:/m)
})
