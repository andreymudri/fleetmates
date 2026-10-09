import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { commandSpawn, resolveCommand } from '../../platform/index.mjs'
import { findChromium } from '../helpers/chromium.mjs'

// The phase gate runs this file through its hub-test check; root npm test does not run hub tests.

const hub = fileURLToPath(new URL('../..', import.meta.url))
const root = path.dirname(hub)

const json = async (file) => JSON.parse(await readFile(file, 'utf8'))

/**
 * Run npm with `args`: `process.execPath` with the npm-cli.js installed next to it (Windows layout, then the POSIX
 * `lib/` layout), else `npm` through resolveCommand and commandSpawn, since `npm` is `npm.cmd` on Windows and a
 * spawn without a shell cannot run that.
 */
function npm(args, options) {
  const dir = path.dirname(process.execPath)
  const cli = [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(file => existsSync(file))
  if (cli) return execFileSync(process.execPath, [cli, ...args], options)
  const spawn = commandSpawn(resolveCommand('npm'), args)
  return execFileSync(spawn.file, spawn.args, { ...options, ...spawn.options })
}

test('M1 build mounts a visible React heading in Chromium', async () => {
  const pkg = await json(path.join(hub, 'package.json'))
  const lock = await json(path.join(hub, 'package-lock.json'))
  const rootPkg = await json(path.join(root, 'package.json'))

  assert.equal(pkg.private, undefined)
  assert.equal(pkg.type, 'module')
  // Node 24.2 to 24.15 node:sqlite truncates a bound string at its first NUL; 24.16.0 is the first fixed release.
  assert.equal(pkg.engines.node, '>=24.16.0')
  assert.equal(lock.packages[''].engines.node, pkg.engines.node)
  assert.equal(typeof pkg.scripts.build, 'string')
  for (const name of ['react', 'react-dom', 'vite', 'markdown-it']) {
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
    npm(['run', 'build', '--', '--outDir', out], { cwd: hub, stdio: 'pipe' })
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
    const testing = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    const executablePath = findChromium() ?? (existsSync(testing) ? testing : null)
    assert.ok(executablePath, 'Chromium or Chrome is required for the build smoke test')
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForSelector('#root main h1', { timeout: 5000 })
    const result = await page.evaluate(() => {
      const heading = document.querySelector('#root main h1')
      return {
        heading: heading.textContent,
        react: Object.keys(heading).some((key) => key.startsWith('__reactFiber$')),
      }
    })
    assert.deepEqual(errors, [])
    assert.deepEqual(result, { heading: 'Fleetmates Deck', react: true })
    const visible = await page.screenshot({ animations: 'disabled' })
    await page.evaluate(() => { document.querySelector('#root main h1').style.visibility = 'hidden' })
    const hidden = await page.screenshot({ animations: 'disabled' })
    assert.equal(visible.equals(hidden), false, 'the heading must paint visible pixels')
  } finally {
    if (browser) await browser.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(out, { recursive: true, force: true })
  }
})

test('deck CI declares pinned Node, build, and tests on Linux, macOS and Windows', async () => {
  const version = (await readFile(path.join(hub, '.node-version'), 'utf8')).trim()
  const workflow = await readFile(path.join(root, '.github/workflows/deck.yml'), 'utf8')
  assert.match(version, /^24\.\d+\.\d+$/)
  assert.match(workflow, /^on:\n  push:\n    branches: \[master\]\n  pull_request:\n\njobs:/m)
  const hubJob = workflow.split(/^  hub:\s*$/m)[1]?.split(/^  [\w-]+:\s*$/m)[0]
  assert.ok(hubJob)
  assert.match(hubJob, /^      matrix:\n        os: \[ubuntu-latest, macos-latest, windows-latest\]\n    runs-on: \$\{\{ matrix\.os \}\}$/m)
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
    '      - name: Prepare canonical temporary directory',
    "        run: node -e 'const fs = require(\"node:fs\"); fs.mkdirSync(process.env.TMPDIR, {recursive:true}); fs.appendFileSync(process.env.GITHUB_ENV, `TMPDIR=${fs.realpathSync(process.env.TMPDIR)}\\n`)'",
    '      - run: npm ci --prefix hub',
    '      - run: npm --prefix hub run build',
    '      - name: Check platform regressions before the full suite',
    "        run: node --test --test-name-pattern='null-device timestamps|JSON body type|oversized streamed|confirmed read stays|confirming read starts|renamed Node init' hub/test/unit/tiers.test.mjs hub/test/integration/security.test.mjs hub/test/unit/http-body-limit.test.mjs hub/test/unit/setup.test.mjs",
    '      - run: npm --prefix hub test',
  ].join('\n'))
  assert.doesNotMatch(hubJob, /^\s+(?:-\s+)?if:/m)
  assert.doesNotMatch(hubJob, /^\s+(?:-\s+)?continue-on-error:/m)
  assert.doesNotMatch(hubJob, /^    defaults:/m)
})
