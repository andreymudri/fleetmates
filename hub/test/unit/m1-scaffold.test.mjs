import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

// The phase gate runs this file through its hub-test check; root npm test does not run hub tests.

const hub = fileURLToPath(new URL('../..', import.meta.url))
const root = path.dirname(hub)

const json = async (file) => JSON.parse(await readFile(file, 'utf8'))

test('M1 build mounts a visible React heading in Chromium', async () => {
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
  let browser
  let server
  try {
    execFileSync('npm', ['run', 'build', '--', '--outDir', out], { cwd: hub, stdio: 'pipe' })
    const html = await readFile(path.join(out, 'index.html'), 'utf8')
    assert.match(html, /<div id="root"><\/div>/)
    server = createServer(async (request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
      if (relative.split('/').includes('..')) {
        response.writeHead(404).end()
        return
      }
      try {
        const body = await readFile(path.join(out, relative))
        const type = relative.endsWith('.js') ? 'text/javascript'
          : relative.endsWith('.css') ? 'text/css' : 'text/html'
        response.writeHead(200, { 'Content-Type': type }).end(body)
      } catch {
        response.writeHead(404).end()
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const candidates = [
      process.env.CHROMIUM_PATH,
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ]
    let executablePath
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        await access(candidate)
        executablePath = candidate
        break
      } catch {}
    }
    assert.ok(executablePath, 'Chromium or Chrome is required for the build smoke test')
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForSelector('main h1', { timeout: 5000 })
    const result = await page.evaluate(() => {
      const heading = document.querySelector('main h1')
      const root = document.getElementById('root')
      let visible = true
      for (let element = heading; element; element = element.parentElement) {
        const style = getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') visible = false
      }
      const bounds = heading.getBoundingClientRect()
      visible &&= bounds.width > 0 && bounds.height > 0
        && bounds.right > 0 && bounds.bottom > 0
        && bounds.left < innerWidth && bounds.top < innerHeight
      return {
        heading: heading.textContent,
        visible,
        react: Object.keys(root).some((key) => key.startsWith('__reactContainer$')),
      }
    })
    assert.deepEqual(errors, [])
    assert.deepEqual(result, { heading: 'Fleetmates Deck', visible: true, react: true })
  } finally {
    if (browser) await browser.close()
    if (server) await new Promise((resolve) => server.close(resolve))
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
  assert.match(hubJob, /^      matrix:\n        os: \[ubuntu-latest, macos-latest\]\n    runs-on: \$\{\{ matrix\.os \}\}$/m)
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
  assert.doesNotMatch(hubJob, /^    defaults:/m)
})
