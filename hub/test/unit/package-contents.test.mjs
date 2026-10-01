import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fleetmatesScriptsDir } from '../../server/adapters/fleetmates.mjs'

// The deck package ships without the fleetmates repository root, so the server's fleetmates adapter
// must find the root modules it imports (names, liveness, git and what they import) inside the
// package. `prepack` vendors them into vendor/fleetmates/ with bin/vendor-fleetmates.mjs.

const hub = fileURLToPath(new URL('../..', import.meta.url))
const repo = path.dirname(hub)
const vendorScript = path.join(hub, 'bin', 'vendor-fleetmates.mjs')
const CLOSURE = ['git.mjs', 'liveness.mjs', 'names.mjs', 'reviews.mjs']

test('the vendor script copies the whole import closure of the adapter modules, and each copy imports', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'deck-vendor-'))
  try {
    execFileSync(process.execPath, [vendorScript, '--out', out], { stdio: 'pipe' })
    assert.deepEqual((await readdir(out)).sort(), CLOSURE)
    for (const file of CLOSURE) await import(pathToFileURL(path.join(out, file)).href)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('the vendor script refuses an import that leaves scripts/ and a bare package import', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'deck-vendor-'))
  try {
    // Both targets exist on disk, so only the scope rule can refuse them.
    const cases = [
      ['escape', "import x from '../outside.mjs'\n", /leaves/],
      ['bare', "import x from 'names.mjs'\n", /not a node: builtin/],
    ]
    for (const [name, source, reason] of cases) {
      const from = path.join(base, name, 'scripts')
      await mkdir(from, { recursive: true })
      await writeFile(path.join(base, name, 'outside.mjs'), 'export default 1\n')
      for (const file of ['names.mjs', 'liveness.mjs', 'git.mjs']) await writeFile(path.join(from, file), 'export default 1\n')
      await writeFile(path.join(from, 'git.mjs'), source)
      const result = spawnSync(process.execPath, [vendorScript, '--from', from, '--out', path.join(base, name, 'out')], { encoding: 'utf8' })
      assert.notEqual(result.status, 0, `${name} must be refused`)
      assert.match(result.stderr, reason)
      assert.equal(existsSync(path.join(base, name, 'out')), false, `${name} must write nothing`)
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('inside a fleetmates checkout the adapter reads the root modules, never a vendored copy', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'deck-vendor-'))
  try {
    const adapters = path.join(base, 'hub', 'server', 'adapters')
    const vendored = path.join(base, 'hub', 'vendor', 'fleetmates')
    await mkdir(adapters, { recursive: true })
    await mkdir(vendored, { recursive: true })
    await writeFile(path.join(vendored, 'names.mjs'), '')
    await mkdir(path.join(base, 'scripts'))
    await writeFile(path.join(base, 'scripts', 'names.mjs'), '')
    await writeFile(path.join(base, 'package.json'), '{"name":"fleetmates"}')
    assert.equal(fleetmatesScriptsDir(adapters), path.join(base, 'scripts'))
    await writeFile(path.join(base, 'package.json'), '{"name":"something-else"}')
    assert.equal(fleetmatesScriptsDir(adapters), vendored)
    await rm(vendored, { recursive: true })
    assert.throws(() => fleetmatesScriptsDir(adapters), /fleetmates modules not found/)
    // This repository, as the real adapter sees it.
    assert.equal(fleetmatesScriptsDir(), path.join(repo, 'scripts'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a packed and extracted package imports server/main.mjs and deckd/main.mjs', async () => {
  // Stage hub/ beside a link to the real scripts/ so prepack runs as it would in the repo, without
  // writing web/dist or vendor/ into the working tree. node_modules is linked, not installed.
  const base = await mkdtemp(path.join(tmpdir(), 'deck-pack-'))
  try {
    const staged = path.join(base, 'repo', 'hub')
    await mkdir(staged, { recursive: true })
    await symlink(path.join(repo, 'scripts'), path.join(base, 'repo', 'scripts'))
    for (const entry of await readdir(hub)) {
      if (['node_modules', 'test', 'vendor', 'docs'].includes(entry) || entry === 'dist') continue
      await cp(path.join(hub, entry), path.join(staged, entry), { recursive: true, filter: (src) => !src.includes(`${path.sep}web${path.sep}dist`) })
    }
    await symlink(path.join(hub, 'node_modules'), path.join(staged, 'node_modules'))
    const packed = path.join(base, 'pack')
    await mkdir(packed)
    execFileSync('npm', ['pack', '--pack-destination', packed], { cwd: staged, stdio: 'pipe' })
    assert.equal(existsSync(path.join(staged, 'vendor')), false, 'postpack removes the vendored copy')
    const [tarball] = await readdir(packed)
    const extracted = path.join(base, 'installed')
    await mkdir(extracted)
    execFileSync('tar', ['-xzf', path.join(packed, tarball), '-C', extracted])
    const pkg = path.join(extracted, 'package')
    assert.deepEqual((await readdir(path.join(pkg, 'vendor', 'fleetmates'))).sort(), CLOSURE)
    await symlink(path.join(hub, 'node_modules'), path.join(pkg, 'node_modules'))
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "await import('./server/main.mjs'); await import('./deckd/main.mjs'); const { fleetmatesScriptsDir } = await import('./server/adapters/fleetmates.mjs'); console.log(fleetmatesScriptsDir())"],
    { cwd: pkg, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), path.join(pkg, 'vendor', 'fleetmates'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
